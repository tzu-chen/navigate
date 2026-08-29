/**
 * Stage 2 of the walkthrough pipeline: turn an extracted source tree into one
 * flattened, comment-free, macro-hoisted TeX document plus a structure map.
 *
 * This file is **pure and dependency-free** — no DB, no network, no model, not
 * even a Node builtin — for the same reason `similarity-core.ts` is: LaTeX
 * heterogeneity is the fiddliest part of the whole feature, and this is what
 * makes it unit-testable against fixtures rather than against arXiv.
 *
 * The recurring theme is that real papers are not well-behaved LaTeX. Old
 * papers, and physics papers of any age, are routinely plain TeX with no
 * `\documentclass` and no `\begin{document}`; drafts contain contradictory
 * abandoned prose in comments; `\input` trees nest; macro definitions are the
 * decoder ring for every formula and are stated exactly once.
 */

// --- Bounds ------------------------------------------------------------------

/** ~100k tokens. Beyond this the distiller drops sections, worst-value first. */
export const MAX_TEX_CHARS = 400_000;
/** How deep `\input` chains are followed before we call it a cycle we missed. */
export const MAX_INPUT_DEPTH = 12;
/** Cap on the `\cite` key → title map carried alongside the text. */
export const MAX_CITATIONS = 250;

// --- Types -------------------------------------------------------------------

export interface Macro {
  /** The defined name, e.g. `\attn`. Empty when it could not be read. */
  name: string;
  /** The definition exactly as the author wrote it. */
  source: string;
}

export interface StructureNode {
  /** 0 = part/chapter, 1 = section, 2 = subsection, 3 = subsubsection, 4 = paragraph. */
  level: number;
  title: string;
  /** Character offset into `flattenedTex`. */
  offset: number;
}

export interface LabeledItem {
  kind: 'equation' | 'theorem' | 'figure' | 'table' | 'algorithm';
  /** The environment name as written, e.g. `equation`, `align`, `lemma`. */
  env: string;
  label: string;
  offset: number;
  /** A short excerpt, enough for the outline to quote or the UI to preview. */
  snippet: string;
}

export interface FigureRef {
  /** The graphics path as written in `\includegraphics`, or null for TikZ. */
  path: string | null;
  caption: string;
  label: string;
  /** `raster` can be shown directly; `vector` links to the PDF page; `tikz` is source. */
  kind: 'raster' | 'vector' | 'tikz' | 'unknown';
  /** Package-relative path of the extracted file, when one matched. */
  resolvedPath: string | null;
}

export interface DistilledSource {
  mainFile: string | null;
  /** How the main file was chosen — useful when the answer looks wrong. */
  mainFileReason: string;
  flattenedTex: string;
  macros: Macro[];
  structure: StructureNode[];
  labels: LabeledItem[];
  figures: FigureRef[];
  /** `\cite` key → title, from the .bib or .bbl when present. */
  citations: Record<string, string>;
  warnings: string[];
  /** True when the budget forced sections out of the flattened text. */
  truncated: boolean;
}

export interface DistillOptions {
  /** Every regular-file name in the package, including files not extracted
   *  (figure PDFs). Used to classify figures as raster vs vector. */
  entryNames?: string[];
  maxChars?: number;
}

// --- Small path helpers (POSIX, inline to keep this file builtin-free) -------

function dirname(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? '' : p.slice(0, i);
}

function basename(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? p : p.slice(i + 1);
}

function extname(p: string): string {
  const name = basename(p);
  const i = name.lastIndexOf('.');
  return i <= 0 ? '' : name.slice(i).toLowerCase();
}

function joinPath(dir: string, rel: string): string {
  const combined = dir ? `${dir}/${rel}` : rel;
  const out: string[] = [];
  for (const segment of combined.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') out.pop();
    else out.push(segment);
  }
  return out.join('/');
}

// --- Brace matching ----------------------------------------------------------

/**
 * Index just past the `}` matching the `{` at `open`, or -1.
 * Respects `\{` and `\}`, which appear inside captions constantly.
 */
export function matchBrace(text: string, open: number): number {
  if (text[open] !== '{') return -1;
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\') {
      i++; // skip the escaped character
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/** Contents of the group starting at `open`, or null when it is unbalanced. */
function groupContents(text: string, open: number): string | null {
  const end = matchBrace(text, open);
  return end === -1 ? null : text.slice(open + 1, end - 1);
}

/** Skip whitespace forward from `i`. */
function skipSpace(text: string, i: number): number {
  while (i < text.length && /\s/.test(text[i])) i++;
  return i;
}

// --- Comment stripping -------------------------------------------------------

const VERBATIM_ENVS = ['verbatim', 'Verbatim', 'lstlisting', 'minted', 'alltt', 'comment'];

/**
 * Remove TeX comments, respecting `\%` and verbatim environments.
 *
 * Author comments are frequently a *liability* rather than lost context: drafts
 * carry contradictory abandoned prose, reviewer notes, and half-finished
 * alternative phrasings that a model reads as if the author meant them.
 */
export function stripComments(text: string): string {
  let out = '';
  let i = 0;

  while (i < text.length) {
    const ch = text[i];

    if (ch === '\\') {
      // `\verb|…|` takes the next character as its delimiter.
      const verb = /^\\verb\*?(.)/.exec(text.slice(i, i + 8));
      if (verb) {
        const delim = verb[1];
        const close = text.indexOf(delim, i + verb[0].length);
        const end = close === -1 ? text.length : close + 1;
        out += text.slice(i, end);
        i = end;
        continue;
      }

      const begin = /^\\begin\{([A-Za-z*]+)\}/.exec(text.slice(i, i + 40));
      if (begin && VERBATIM_ENVS.includes(begin[1].replace(/\*$/, ''))) {
        const endTag = `\\end{${begin[1]}}`;
        const close = text.indexOf(endTag, i);
        const end = close === -1 ? text.length : close + endTag.length;
        // A `comment` environment is a comment: drop it entirely.
        if (begin[1].replace(/\*$/, '') === 'comment') {
          i = end;
          continue;
        }
        out += text.slice(i, end);
        i = end;
        continue;
      }

      // Any other escape sequence passes through with its escaped character,
      // which is what keeps `\%` from starting a comment.
      out += text[i];
      if (i + 1 < text.length) out += text[i + 1];
      i += 2;
      continue;
    }

    if (ch === '%') {
      // Comment to end of line. The newline is kept: TeX would splice the lines
      // together, but for a reader (human or model) the line break is clearer
      // and never changes meaning in the prose we care about.
      let end = text.indexOf('\n', i);
      if (end === -1) end = text.length;
      i = end;
      continue;
    }

    out += ch;
    i++;
  }

  return out;
}

// --- Main-file detection -----------------------------------------------------

/**
 * Pick the document's root file.
 *
 * The tiers matter in order, and the last one is not laziness: `hep-th/9711200`
 * (Maldacena) is plain TeX with harvmac and contains **neither**
 * `\documentclass` nor `\begin{document}`. Old papers, and physics papers of
 * any age, routinely do not.
 */
export function detectMainFile(files: Record<string, string>): {
  mainFile: string | null;
  reason: string;
} {
  const texFiles = Object.keys(files).filter(f => {
    const ext = extname(f);
    return ext === '.tex' || ext === '.ltx' || ext === '';
  });

  if (texFiles.length === 0) return { mainFile: null, reason: 'no .tex files in package' };
  if (texFiles.length === 1) return { mainFile: texFiles[0], reason: 'only .tex file in package' };

  // A file that is `\input` by another is by definition not the root. This is
  // cheap and removes most of the ambiguity before the heuristics run.
  const included = new Set<string>();
  for (const [name, content] of Object.entries(files)) {
    for (const target of findInputTargets(content)) {
      const resolved = resolveInputPath(target, dirname(name), files);
      if (resolved) included.add(resolved);
    }
  }
  const roots = texFiles.filter(f => !included.has(f));
  const pool = roots.length > 0 ? roots : texFiles;

  const withDocumentclass = pool.filter(f => /\\documentclass/.test(files[f]));
  if (withDocumentclass.length === 1) {
    return { mainFile: withDocumentclass[0], reason: 'contains \\documentclass' };
  }
  if (withDocumentclass.length > 1) {
    const largest = largestBy(withDocumentclass, files);
    return { mainFile: largest, reason: 'largest of several files with \\documentclass' };
  }

  const withBeginDocument = pool.filter(f => /\\begin\{document\}/.test(files[f]));
  if (withBeginDocument.length >= 1) {
    const largest = largestBy(withBeginDocument, files);
    return {
      mainFile: largest,
      reason:
        withBeginDocument.length === 1
          ? 'contains \\begin{document}'
          : 'largest of several files with \\begin{document}',
    };
  }

  // Plain TeX. No class, no document environment — the largest file is the paper.
  return {
    mainFile: largestBy(pool, files),
    reason: 'plain TeX (no \\documentclass or \\begin{document}); largest .tex file',
  };
}

function largestBy(names: string[], files: Record<string, string>): string {
  return names.reduce((a, b) => (files[a].length >= files[b].length ? a : b));
}

// --- \input resolution -------------------------------------------------------

/**
 * A *factory*, not a shared constant. `expand()` below recurses from inside its
 * own `exec` loop, and a module-level /g regex would have its `lastIndex`
 * rewound by the nested call — restarting the outer scan and re-expanding the
 * same file until the string blows up. Every scan gets its own regex object.
 */
function inputPattern(): RegExp {
  return /\\(input|include|subfile)\s*\{([^}]*)\}|\\input\s+([A-Za-z0-9_\-./]+)|\\(?:sub)?import\s*\{([^}]*)\}\s*\{([^}]*)\}/g;
}

/** Every `\input`-like target named in a chunk of TeX, in source order. */
export function findInputTargets(text: string): string[] {
  const targets: string[] = [];
  const re = inputPattern();
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    // Braced \input/\include/\subfile | bare plain-TeX `\input name` | \import{dir}{file}
    const target = match[2] ?? match[3] ?? (match[4] !== undefined ? joinPath(match[4], match[5]) : '');
    if (target && target.trim()) targets.push(target.trim());
  }
  return targets;
}

/**
 * Resolve an `\input` target against the file tree, applying TeX's extension
 * rule (`\input{introduction}` → `introduction.tex`) and trying the including
 * file's directory before the package root.
 */
export function resolveInputPath(
  target: string,
  fromDir: string,
  files: Record<string, string>
): string | null {
  const candidates: string[] = [];
  const bases = [joinPath(fromDir, target), joinPath('', target)];
  for (const base of bases) {
    candidates.push(base, `${base}.tex`, `${base}.ltx`);
  }
  for (const candidate of candidates) {
    if (Object.prototype.hasOwnProperty.call(files, candidate)) return candidate;
  }
  // Last resort: match on basename alone. Packages sometimes `\input` a file
  // that a build script had flattened into the root.
  const wanted = basename(target).replace(/\.(tex|ltx)$/i, '');
  for (const name of Object.keys(files)) {
    if (basename(name).replace(/\.(tex|ltx)$/i, '') === wanted) return name;
  }
  return null;
}

const DEFINITION_LINE =
  /^\s*\\(def|edef|gdef|xdef|newcommand|renewcommand|providecommand|let|newif|newdimen|newbox|newskip|newcount|newtoks|font|catcode|DeclareMathOperator|newenvironment|newtheorem|input|message|immediate|hoffset|voffset|magnification|baselineskip|parskip|parindent|topskip)/;

/**
 * Whether a resolved `\input` target is a macro package rather than prose.
 *
 * A file that is all definitions contributes its *definitions*, not its text:
 * inlining a bundled `harvmac.tex` would drop tens of KB of formatting
 * machinery into the distilled document for no reading value. Its macros are
 * still captured and hoisted.
 */
export function looksLikeMacroFile(text: string): boolean {
  if (/\\section\b|\\begin\{abstract\}|\\subsection\b|\\maketitle/.test(text)) return false;
  const lines = text.split('\n').filter(l => l.trim().length > 0);
  if (lines.length < 20) return false;
  const defLines = lines.filter(l => DEFINITION_LINE.test(l)).length;
  return defLines >= lines.length * 0.4;
}

export interface FlattenResult {
  text: string;
  warnings: string[];
  /** Files that were resolved but deliberately not inlined (macro packages). */
  macroFiles: string[];
}

/**
 * Recursively splice `\input`/`\include` targets into the main file.
 * Missing targets become warnings, never failures — an unresolvable `\input` is
 * usually a system macro package (`\input harvmac`) that arXiv supplies and the
 * submission does not carry.
 */
export function flattenInputs(
  mainFile: string,
  files: Record<string, string>
): FlattenResult {
  const warnings: string[] = [];
  const macroFiles: string[] = [];
  const visiting = new Set<string>();
  const missing = new Set<string>();

  const expand = (name: string, depth: number): string => {
    if (depth > MAX_INPUT_DEPTH) {
      warnings.push(`\\input nesting deeper than ${MAX_INPUT_DEPTH} levels at ${name}; stopped.`);
      return '';
    }
    if (visiting.has(name)) {
      warnings.push(`Cycle in \\input chain at ${name}; stopped.`);
      return '';
    }
    visiting.add(name);

    const source = files[name] ?? '';
    const dir = dirname(name);
    let out = '';
    let last = 0;

    const re = inputPattern();
    let match: RegExpExecArray | null;
    while ((match = re.exec(source)) !== null) {
      const target =
        match[2] ?? match[3] ?? (match[4] !== undefined ? joinPath(match[4], match[5]) : '');
      if (!target || !target.trim()) continue;

      out += source.slice(last, match.index);
      last = match.index + match[0].length;

      const resolved = resolveInputPath(target.trim(), dir, files);
      if (!resolved) {
        if (!missing.has(target)) {
          missing.add(target);
          warnings.push(`Unresolved \\input target: ${target}`);
        }
        continue;
      }
      if (looksLikeMacroFile(files[resolved] ?? '')) {
        if (!macroFiles.includes(resolved)) macroFiles.push(resolved);
        continue;
      }
      out += `\n% <<< ${resolved}\n${expand(resolved, depth + 1)}\n% >>> ${resolved}\n`;
    }

    out += source.slice(last);
    visiting.delete(name);
    return out;
  };

  return { text: expand(mainFile, 0), warnings, macroFiles };
}

// --- Macro capture -----------------------------------------------------------

const MACRO_COMMANDS = [
  'newcommand',
  'renewcommand',
  'providecommand',
  'DeclareMathOperator',
  'newenvironment',
  'renewenvironment',
  'newtheorem',
];

/**
 * Collect every macro definition verbatim.
 *
 * These are hoisted to the top of the distilled text because they are the
 * decoder ring for every formula that follows: a paper defines `\attn` once and
 * then uses it forty times. We deliberately do **not** expand them — the model
 * reads a definition better than a half-correct expander rewrites its uses, and
 * a wrong expansion is silent.
 */
export function captureMacros(text: string): Macro[] {
  const macros: Macro[] = [];
  const seen = new Set<string>();

  const push = (name: string, source: string) => {
    const trimmed = source.trim();
    const key = `${name}::${trimmed}`;
    if (seen.has(key)) return;
    seen.add(key);
    macros.push({ name, source: trimmed });
  };

  // \newcommand{\foo}[2][x]{...}, \newcommand\foo{...}, \DeclareMathOperator*{\foo}{...}
  const declRe = new RegExp(`\\\\(${MACRO_COMMANDS.join('|')})(\\*?)\\s*`, 'g');
  let match: RegExpExecArray | null;
  while ((match = declRe.exec(text)) !== null) {
    const start = match.index;
    let i = declRe.lastIndex;
    let name = '';

    if (text[i] === '{') {
      const contents = groupContents(text, i);
      if (contents === null) continue;
      name = contents.trim();
      i = matchBrace(text, i);
    } else if (text[i] === '\\') {
      const nameMatch = /^\\[A-Za-z@]+/.exec(text.slice(i));
      if (!nameMatch) continue;
      name = nameMatch[0];
      i += nameMatch[0].length;
    } else {
      continue;
    }

    // Optional [n][default] arguments, then one or two mandatory groups.
    i = skipSpace(text, i);
    while (text[i] === '[') {
      const close = text.indexOf(']', i);
      if (close === -1) break;
      i = skipSpace(text, close + 1);
    }
    let groups = 0;
    const wanted = match[1].includes('environment') ? 2 : 1;
    while (groups < wanted && text[i] === '{') {
      const end = matchBrace(text, i);
      if (end === -1) break;
      i = skipSpace(text, end);
      groups++;
    }
    if (groups === 0) continue;
    push(name, text.slice(start, i));
  }

  // Plain TeX: \def\foo#1#2{...}, and the \let / \gdef family.
  const defRe = /\\(def|gdef|edef|xdef)\s*(\\[A-Za-z@]+)([^{]*)\{/g;
  while ((match = defRe.exec(text)) !== null) {
    const open = match.index + match[0].length - 1;
    const end = matchBrace(text, open);
    if (end === -1) continue;
    push(match[2], text.slice(match.index, end));
  }

  const letRe = /\\let\s*(\\[A-Za-z@]+)\s*=?\s*(\\[A-Za-z@]+|.)/g;
  while ((match = letRe.exec(text)) !== null) {
    push(match[1], match[0]);
  }

  return macros;
}

// --- Bibliography ------------------------------------------------------------

/**
 * Drop the bibliography from the body while keeping `\cite{key}` markers.
 *
 * The markers are what let a walkthrough say "this replaces the mechanism in
 * [Bahdanau et al.]" instead of "prior work", so the keys stay and the titles
 * ride along in a separate map.
 */
export function removeBibliography(text: string): string {
  return text
    .replace(/\\begin\{thebibliography\}[\s\S]*?\\end\{thebibliography\}/g, '\n')
    .replace(/\\bibliography\s*\{[^}]*\}/g, '')
    .replace(/\\bibliographystyle\s*\{[^}]*\}/g, '')
    .replace(/\\begin\{references\}[\s\S]*?\\end\{references\}/g, '\n');
}

/**
 * `\cite` key → title.
 *
 * Read from any .bib and .bbl in the package **and** from an inline
 * `\begin{thebibliography}` in the body, which is where the references
 * actually live in a submission that shipped no .bbl — 1706.03762 carries all
 * 40 of its entries that way. `inlineBody` is passed the flattened text from
 * *before* `removeBibliography` ran, so the keys survive the block's removal.
 */
export function extractCitations(
  files: Record<string, string>,
  inlineBody = ''
): Record<string, string> {
  const citations: Record<string, string> = {};

  const clean = (s: string) =>
    s
      .replace(/[{}]/g, '')
      .replace(/\\[A-Za-z]+\s*/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 200);

  const sources: [string, string][] = [
    ...Object.entries(files),
    // Give the inline block a .bbl-shaped name so it takes the \bibitem path.
    ...(inlineBody ? ([['<inline>.bbl', inlineBody]] as [string, string][]) : []),
  ];

  for (const [name, content] of sources) {
    const ext = extname(name);

    if (ext === '.bib') {
      const entryRe = /@\w+\s*\{\s*([^,\s]+)\s*,/g;
      let match: RegExpExecArray | null;
      while ((match = entryRe.exec(content)) !== null) {
        if (Object.keys(citations).length >= MAX_CITATIONS) break;
        const key = match[1];
        const rest = content.slice(match.index, match.index + 4000);
        const title = /title\s*=\s*[{"]([\s\S]*?)[}"]\s*,/i.exec(rest)?.[1];
        if (title) citations[key] = clean(title);
      }
    }

    if (ext === '.bbl') {
      // A .bbl has no title field; the rendered entry is the best available
      // stand-in, so take the head of it.
      const itemRe = /\\bibitem(?:\[[^\]]*\])?\s*\{([^}]+)\}([\s\S]*?)(?=\\bibitem|\\end\{thebibliography\}|$)/g;
      let match: RegExpExecArray | null;
      while ((match = itemRe.exec(content)) !== null) {
        if (Object.keys(citations).length >= MAX_CITATIONS) break;
        const key = match[1].trim();
        if (!citations[key]) citations[key] = clean(match[2]).slice(0, 160);
      }
    }
  }

  return citations;
}

// --- Structure and labels ----------------------------------------------------

const SECTION_LEVELS: Record<string, number> = {
  part: 0,
  chapter: 0,
  section: 1,
  subsection: 2,
  subsubsection: 3,
  paragraph: 4,
  subparagraph: 4,
  // harvmac (plain TeX)
  newsec: 1,
  subsec: 2,
  subsubsec: 3,
};

/**
 * Ordered section map, so the outline can cite §3.2 and the client can deep-link.
 *
 * `\newsec`/`\subsec` are harvmac's, not LaTeX's. They are here because the
 * plain-TeX physics papers that force the main-file fallback chain are the same
 * ones that have no `\section` anywhere — without these, `hep-th/9711200` and
 * its kind distill to a structure map of length zero.
 */
export function extractStructure(text: string): StructureNode[] {
  const nodes: StructureNode[] = [];
  const re =
    /\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph|newsec|subsec|subsubsec)\*?\s*(?:\[[^\]]*\])?\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const open = match.index + match[0].length - 1;
    const contents = groupContents(text, open);
    if (contents === null) continue;
    nodes.push({
      level: SECTION_LEVELS[match[1]] ?? 1,
      title: contents.replace(/\s+/g, ' ').trim(),
      offset: match.index,
    });
  }
  return nodes;
}

const THEOREM_ENVS = [
  'theorem', 'lemma', 'proposition', 'corollary', 'definition',
  'remark', 'claim', 'conjecture', 'assumption', 'proof', 'example',
];
const EQUATION_ENVS = [
  'equation', 'align', 'gather', 'multline', 'eqnarray', 'flalign', 'alignat', 'split',
];

/**
 * Labelled equations, theorem-like environments, figures and tables.
 * The outline references these by label (`eq:attention`), so this list is also
 * the whitelist `normalizeOutline` validates its references against.
 */
export function extractLabels(text: string): LabeledItem[] {
  const items: LabeledItem[] = [];
  const re = /\\begin\{([A-Za-z*]+)\}/g;
  let match: RegExpExecArray | null;

  while ((match = re.exec(text)) !== null) {
    const env = match[1];
    const bare = env.replace(/\*$/, '');
    let kind: LabeledItem['kind'];
    if (EQUATION_ENVS.includes(bare)) kind = 'equation';
    else if (THEOREM_ENVS.includes(bare)) kind = 'theorem';
    else if (bare === 'figure') kind = 'figure';
    else if (bare === 'table' || bare === 'tabular') kind = 'table';
    else if (bare === 'algorithm' || bare === 'algorithmic') kind = 'algorithm';
    else continue;

    const endTag = `\\end{${env}}`;
    const close = text.indexOf(endTag, match.index);
    const body = text.slice(match.index + match[0].length, close === -1 ? text.length : close);
    const label = /\\label\s*\{([^}]+)\}/.exec(body)?.[1]?.trim() ?? '';
    if (!label) continue;

    items.push({
      kind,
      env: bare,
      label,
      offset: match.index,
      snippet: body.replace(/\s+/g, ' ').trim().slice(0, 400),
    });
  }

  return items;
}

/**
 * Figure manifest. Rasters can be surfaced in a walkthrough directly; vector
 * figures are usually PDF (6 of them in 1706.03762) and v1 links those to the
 * corresponding PDF page rather than converting. TikZ figures are source and
 * stay in the text, where they are often *more* informative than the rendering.
 */
export function extractFigures(text: string, entryNames: string[] = []): FigureRef[] {
  const figures: FigureRef[] = [];
  const re = /\\begin\{(figure\*?|wrapfigure)\}/g;
  let match: RegExpExecArray | null;

  const resolveGraphic = (raw: string): { resolved: string | null; ext: string } => {
    const target = raw.trim().replace(/^\{|\}$/g, '');
    const wantedBase = basename(target).replace(/\.[a-z0-9]+$/i, '').toLowerCase();
    let exact: string | null = null;
    let byBase: string | null = null;
    for (const name of entryNames) {
      if (name === target) exact = name;
      const base = basename(name).replace(/\.[a-z0-9]+$/i, '').toLowerCase();
      if (!byBase && base === wantedBase) byBase = name;
    }
    const resolved = exact ?? byBase;
    return { resolved, ext: resolved ? extname(resolved) : extname(target) };
  };

  while ((match = re.exec(text)) !== null) {
    const endTag = `\\end{${match[1]}}`;
    const close = text.indexOf(endTag, match.index);
    const body = text.slice(match.index + match[0].length, close === -1 ? text.length : close);

    const captionOpen = body.search(/\\caption\s*(?:\[[^\]]*\])?\s*\{/);
    let caption = '';
    if (captionOpen !== -1) {
      const braceAt = body.indexOf('{', captionOpen);
      caption = (groupContents(body, braceAt) ?? '').replace(/\s+/g, ' ').trim();
    }
    const label = /\\label\s*\{([^}]+)\}/.exec(body)?.[1]?.trim() ?? '';
    const graphic = /\\includegraphics\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/.exec(body)?.[1] ?? null;

    if (/\\begin\{tikzpicture\}|\\tikz\b|\\begin\{pgfpicture\}/.test(body)) {
      figures.push({ path: null, caption, label, kind: 'tikz', resolvedPath: null });
      continue;
    }
    if (!graphic) {
      figures.push({ path: null, caption, label, kind: 'unknown', resolvedPath: null });
      continue;
    }

    const { resolved, ext } = resolveGraphic(graphic);
    const kind: FigureRef['kind'] = ['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext)
      ? 'raster'
      : ['.pdf', '.eps', '.ps'].includes(ext)
        ? 'vector'
        : 'unknown';
    figures.push({ path: graphic.trim(), caption, label, kind, resolvedPath: resolved });
  }

  return figures;
}

// --- Budget ------------------------------------------------------------------

const APPENDIX_RE = /\\appendix\b/;
const EXPERIMENTAL_TITLE =
  /\b(experiment|evaluation|results?|ablation|implementation detail|training detail|hyperparameter|dataset|benchmark|setup)\b/i;

export interface BudgetResult {
  text: string;
  warnings: string[];
  truncated: boolean;
}

/**
 * Bring the flattened text under budget, dropping the least load-bearing
 * material first: appendices, then proofs, then experimental-detail sections.
 * What was dropped is recorded, because a walkthrough built from a truncated
 * paper is a different object from one built from the whole paper and the
 * reader should be told which they are looking at.
 */
export function applyBudget(text: string, maxChars = MAX_TEX_CHARS): BudgetResult {
  const warnings: string[] = [];
  if (text.length <= maxChars) return { text, warnings, truncated: false };

  let out = text;

  // 1. Appendices.
  const appendixAt = out.search(APPENDIX_RE);
  if (appendixAt !== -1 && appendixAt > maxChars * 0.2) {
    warnings.push('Appendices omitted to fit the context budget.');
    out = out.slice(0, appendixAt);
  }
  if (out.length <= maxChars) return { text: out, warnings, truncated: true };

  // 2. Proofs. The statement of a theorem is what a walkthrough explains; the
  //    proof is what a reader goes to the paper for.
  const before = out.length;
  out = out.replace(/\\begin\{proof\}[\s\S]*?\\end\{proof\}/g, '\n[proof omitted]\n');
  if (out.length < before) warnings.push('Proof bodies omitted to fit the context budget.');
  if (out.length <= maxChars) return { text: out, warnings, truncated: true };

  // 3. Experimental-detail sections, last section first.
  const sections = extractStructure(out).filter(s => s.level <= 2);
  for (let i = sections.length - 1; i >= 0 && out.length > maxChars; i--) {
    if (!EXPERIMENTAL_TITLE.test(sections[i].title)) continue;
    const start = sections[i].offset;
    const next = sections.slice(i + 1).find(s => s.level <= sections[i].level);
    const end = next ? next.offset : out.length;
    if (start >= out.length) continue;
    warnings.push(`Section "${sections[i].title}" omitted to fit the context budget.`);
    out = out.slice(0, start) + `\n[section "${sections[i].title}" omitted]\n` + out.slice(end);
  }
  if (out.length <= maxChars) return { text: out, warnings, truncated: true };

  // 4. Hard cut. Reaching here means the body alone exceeds the budget.
  warnings.push(
    `Source still exceeded ${maxChars} characters after dropping appendices, proofs and experimental sections; truncated.`
  );
  return { text: out.slice(0, maxChars), warnings, truncated: true };
}

// --- Entry point -------------------------------------------------------------

/**
 * Distill an extracted source tree into one flattened document.
 *
 * Order matters: comments go before anything reads the text (abandoned drafts
 * would otherwise reach the macro capture and the structure map), macros are
 * captured from the *whole* tree including files that were not inlined, and the
 * budget is applied before offsets are computed so that every offset in
 * `structure` and `labels` indexes the string that is actually sent.
 */
export function distillSource(
  rawFiles: Record<string, string>,
  options: DistillOptions = {}
): DistilledSource {
  const warnings: string[] = [];

  // Strip comments across every file up front, so main-file detection and
  // `\input` resolution both see the real document and not commented-out ones.
  const files: Record<string, string> = {};
  for (const [name, content] of Object.entries(rawFiles)) {
    const ext = extname(name);
    files[name] = ext === '.bib' || ext === '.bbl' ? content : stripComments(content);
  }

  const { mainFile, reason } = detectMainFile(files);
  if (!mainFile) {
    return {
      mainFile: null,
      mainFileReason: reason,
      flattenedTex: '',
      macros: [],
      structure: [],
      labels: [],
      figures: [],
      citations: {},
      warnings: [...warnings, 'No TeX file could be identified in the source package.'],
      truncated: false,
    };
  }

  const flattened = flattenInputs(mainFile, files);
  warnings.push(...flattened.warnings);

  // Macros come from the flattened body *and* from macro-only files that were
  // deliberately not inlined — those exist precisely to hold definitions.
  const macros = captureMacros(
    [flattened.text, ...flattened.macroFiles.map(f => files[f] ?? '')].join('\n')
  );
  if (flattened.macroFiles.length > 0) {
    warnings.push(
      `Macro-only file(s) contributed definitions but not text: ${flattened.macroFiles.join(', ')}`
    );
  }

  let body = removeBibliography(flattened.text);
  // Collapse the runs of blank lines that comment stripping leaves behind.
  body = body.replace(/\n[ \t]*\n(?:[ \t]*\n)+/g, '\n\n').trim();

  const budgeted = applyBudget(body, options.maxChars ?? MAX_TEX_CHARS);
  warnings.push(...budgeted.warnings);

  const preamble =
    macros.length > 0
      ? `% ===== Macro definitions from the paper's source (the notation's decoder ring) =====\n${macros
          .map(m => m.source)
          .join('\n')}\n% ===== End macro definitions =====\n\n`
      : '';

  const flattenedTex = preamble + budgeted.text;

  return {
    mainFile,
    mainFileReason: reason,
    flattenedTex,
    macros,
    structure: extractStructure(flattenedTex),
    labels: extractLabels(flattenedTex),
    figures: extractFigures(flattenedTex, options.entryNames ?? Object.keys(rawFiles)),
    citations: extractCitations(rawFiles, flattened.text),
    warnings,
    truncated: budgeted.truncated,
  };
}
