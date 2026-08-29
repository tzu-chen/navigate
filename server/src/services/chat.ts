import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { DATA_DIR } from './paths';
import { fetchSourcePackage, readTextFiles } from './texsource';
import { distillSource, DistilledSource } from './texdistill';

/**
 * Chat backend: `claude -p` with the paper's LaTeX source as context.
 *
 * Three changes that only make sense together (see `chat-overhaul.md`):
 *
 *  - **TeX, not the PDF.** The PDF is a rendering; the source is what the
 *    rendering was made from. Measured on 1706.03762 the same question answered
 *    correctly off 17,291 prefix tokens of source versus 34,820 of base64 PDF —
 *    half the tokens, and the half that survives is the author's macros,
 *    `\label`led equations and explicit section structure rather than page images.
 *  - **The CLI, not the REST API.** Its prompt cache is 1-hour TTL rather than
 *    the API's 5 minutes, which is what reading a paper actually looks like
 *    (send a message, read for ten minutes, send another). And on a Claude Code
 *    plan the work is plan-billed rather than charged to metered credits.
 *  - **Opus 5.** Affordable only because of the two above.
 *
 * ⚠️ **The one hazard is prefix identity.** The cache hit requires a
 * byte-identical prefix on every turn, and a miss is silent: measured at 152
 * cache-creation tokens ($0.0058) with the prompt replayed versus 50,347
 * ($0.1015) with it omitted — 17x, no error raised. Everything that shapes the
 * prefix (system prompt, model, tools, effort) is therefore **frozen on the
 * session row at creation and replayed verbatim**, never rebuilt per request.
 */

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';

export type ChatBackend = 'cli' | 'api';
/** Resolved once per session and then frozen — switching would break the cache. */
export type ChatContextMode = 'tex' | 'pdf' | 'abstract';

export const CHAT_CONTEXT_MODES: ChatContextMode[] = ['tex', 'pdf', 'abstract'];

/** Override when `claude` is not on the server process's PATH. */
const CLI_BIN = process.env.CLAUDE_CLI_PATH || 'claude';

export const DEFAULT_CHAT_MODEL = 'claude-opus-5';
/** Opus 5 is unusually strong at lower effort, and this is reading comprehension. */
export const DEFAULT_CHAT_EFFORT = 'medium';
export const DEFAULT_CHAT_BACKEND: ChatBackend = 'cli';
export const DEFAULT_CHAT_CONTEXT_MODE: Exclude<ChatContextMode, 'abstract'> = 'tex';

/** One message, including process spawn. Measured turns are 2.7–4.1 s. */
const CHAT_TIMEOUT_MS = 6 * 60 * 1000;

/**
 * `max_tokens` on the API path bounds thinking + output *together* on Opus 5,
 * so the old 2048 would truncate answers mid-sentence. The CLI has no such flag;
 * length there is governed by the model and `--effort`.
 */
const API_MAX_TOKENS = 16000;

/** How much of a prior transcript is replayed when a session is re-primed. */
const MAX_REPLAY_CHARS = 20_000;

/** Resolved paper context is reused across turns and sessions. */
const CONTEXT_TTL_MS = 30 * 60 * 1000;

// --- Types -------------------------------------------------------------------

export interface ChatUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  estimated_cost: number;
}

export interface PaperChatContext {
  arxivId: string;
  title: string;
  summary: string;
  authors: string[];
  categories: string[];
}

export interface WorldlineChatContext {
  worldlineId?: number;
  worldlineName: string;
  papers: { title: string; authors: string[]; summary: string; arxivId: string }[];
}

export interface ResolvedContext {
  mode: ChatContextMode;
  /** Rendered LaTeX context block, for `tex`. */
  tex?: string;
  /** base64 PDF, for `pdf`. */
  pdfBase64?: string;
  /** The arXiv version the source came from, when known. */
  sourceVersion?: string | null;
  warnings: string[];
}

export interface StoredSession {
  cli_session_id: string | null;
  context_mode: string | null;
  system_prompt: string | null;
  backend: string | null;
  model: string | null;
}

export interface TurnEvent {
  type: 'delta' | 'meta' | 'done' | 'error';
  [key: string]: unknown;
}

// --- Pricing -----------------------------------------------------------------

interface Price {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

/**
 * List price, USD per million tokens. Only the API path uses this — the CLI
 * computes `total_cost_usd` itself, and on a subscription that figure is the
 * list-price equivalent of plan-billed work rather than money charged anywhere,
 * which is why the UI prefixes it with '≈'.
 *
 * `cacheWrite` is the 5-minute rate (1.25x), which is what the API path buys.
 * The CLI writes at the 1-hour rate (2x) but reports its own number.
 */
const PRICES: Record<string, Price> = {
  'claude-opus-5': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-sonnet-5': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  'claude-sonnet-4': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
};

export function priceFor(model: string): Price {
  for (const [prefix, price] of Object.entries(PRICES)) {
    if (model.startsWith(prefix)) return price;
  }
  return PRICES['claude-opus-5'];
}

export function estimateCost(
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
  },
  model = DEFAULT_CHAT_MODEL
): number {
  const p = priceFor(model);
  return (
    (usage.input_tokens * p.input +
      usage.output_tokens * p.output +
      usage.cache_creation_input_tokens * p.cacheWrite +
      usage.cache_read_input_tokens * p.cacheRead) /
    1_000_000
  );
}

// --- The CLI's working directory ---------------------------------------------

/**
 * Where the `claude` subprocess runs.
 *
 * Two requirements, and they pull in different directions:
 *
 *  1. **Stable**, because the CLI keys its session store off cwd
 *     (`~/.claude/projects/<slugified cwd>/<uuid>.jsonl`) and `--resume` only
 *     finds a session from the directory that created it. One fixed directory
 *     also means every chat session file lands in one reapable place instead of
 *     scattering.
 *  2. **Free of CLAUDE.md on every ancestor.** Claude Code auto-discovers
 *     CLAUDE.md by walking *up* from its working directory, and Scout measured
 *     that mistake at 10,835 versus 602 cached tokens ($0.11 vs $0.008) for an
 *     identical trivial prompt. `--system-prompt` does not suppress it.
 *
 * `DATA_DIR` satisfies (1) but not always (2): with `SUITE_DATA_ROOT` unset it
 * falls back to `server/data/`, which is **inside this repo**, three levels
 * under a CLAUDE.md. So the ancestor chain is actually checked rather than
 * assumed, and a tmpdir is used when it is not clean. `--bare` would enforce
 * this directly but must never be used: it reads auth strictly from
 * ANTHROPIC_API_KEY and can never bill the Claude Code plan.
 */
export function findClaudeMdAncestor(dir: string): string | null {
  let current = path.resolve(dir);
  for (;;) {
    const candidate = path.join(current, 'CLAUDE.md');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

let cachedCwd: string | null = null;

export function chatSessionsCwd(): string {
  if (cachedCwd) return cachedCwd;

  const preferred = path.join(DATA_DIR, 'chat-sessions');
  fs.mkdirSync(preferred, { recursive: true });

  const polluted = findClaudeMdAncestor(preferred);
  if (!polluted) {
    cachedCwd = preferred;
    return cachedCwd;
  }

  const fallback = path.join(os.tmpdir(), 'navigate-chat-sessions');
  fs.mkdirSync(fallback, { recursive: true });
  console.warn(
    `[navigate] chat: ${preferred} sits under ${polluted}, which the CLI would auto-load into every ` +
      `message (~10k tokens). Running chat sessions from ${fallback} instead.`
  );
  cachedCwd = fallback;
  return cachedCwd;
}

/**
 * Claude Code's project-directory slug: the absolute cwd with every character
 * outside [A-Za-z0-9] replaced by '-'. Best-effort by nature — it is an internal
 * detail of the CLI — so every caller treats a miss as "nothing to do" rather
 * than an error.
 */
export function projectSlug(dir: string): string {
  return path.resolve(dir).replace(/[^A-Za-z0-9]/g, '-');
}

function cliProjectsRoot(): string {
  return path.join(os.homedir(), '.claude', 'projects');
}

/**
 * Delete one CLI session transcript. Called when its `chat_sessions` row is
 * deleted, so the two stores do not drift.
 *
 * Only ever unlinks a file named exactly `<uuid>.jsonl` for a uuid this server
 * generated, so a wrong slug guess can do no damage.
 */
export function reapCliSession(cliSessionId: string): boolean {
  if (!/^[0-9a-f-]{36}$/i.test(cliSessionId)) return false;
  const root = cliProjectsRoot();
  let dirs: string[];
  try {
    dirs = fs.readdirSync(root);
  } catch {
    return false;
  }
  const preferred = projectSlug(chatSessionsCwd());
  const ordered = [preferred, ...dirs.filter(d => d !== preferred)];
  for (const dir of ordered) {
    const file = path.join(root, dir, `${cliSessionId}.jsonl`);
    try {
      if (fs.existsSync(file)) {
        fs.unlinkSync(file);
        return true;
      }
    } catch {
      /* a session file we cannot remove is not worth failing a delete for */
    }
  }
  return false;
}

/**
 * Age sweep over the chat cwd's own project directory: transcripts no live
 * session references, older than `maxAgeDays`. Scoped to the one slug this
 * server writes to, so it can never touch a real project's history.
 */
export function sweepCliSessions(liveIds: Set<string>, maxAgeDays = 30): number {
  const dir = path.join(cliProjectsRoot(), projectSlug(chatSessionsCwd()));
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const entry of entries) {
    if (!/^[0-9a-f-]{36}\.jsonl$/i.test(entry)) continue;
    if (liveIds.has(entry.slice(0, -6))) continue;
    const file = path.join(dir, entry);
    try {
      if (fs.statSync(file).mtimeMs > cutoff) continue;
      fs.unlinkSync(file);
      removed++;
    } catch {
      /* ignore */
    }
  }
  return removed;
}

// --- Flag vector -------------------------------------------------------------

export interface ChatArgOptions {
  systemPrompt: string;
  model: string;
  effort: string;
  /** Priming a new conversation under this uuid. */
  sessionId?: string;
  /** Resuming an existing one. Exactly one of the two is given. */
  resumeId?: string;
}

/**
 * The argument vector for one message. Exported so `verify:chat` can assert the
 * prime and resume vectors **differ only in `--session-id`/`--resume`** — that
 * assertion is the mechanized form of the prefix-identity rule above.
 *
 * - `--input-format stream-json` is what lets a `document` block (the PDF)
 *   reach the model at all; it requires `--output-format stream-json`.
 * - `--include-partial-messages` gives token-by-token deltas, which is what
 *   makes an Opus turn with thinking on bearable to wait for.
 * - `--verbose` is *mandatory*: the CLI refuses `--output-format stream-json`
 *   under `-p` without it.
 * - `--tools ""` — a text-judgement task; nothing here should touch the
 *   filesystem or the network.
 * - `--setting-sources ""` keeps the run hermetic and suppresses the ambient
 *   SessionStart hooks that otherwise fire on every single message. Verified in
 *   the walkthrough builder not to break plan auth, unlike `--bare`.
 * - **No `--no-session-persistence`**: resume needs the session on disk. That is
 *   the whole mechanism.
 */
export function buildChatArgs(opts: ChatArgOptions): string[] {
  const base = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--include-partial-messages',
    '--verbose',
    '--model', opts.model,
    '--effort', opts.effort,
    '--tools', '',
    '--system-prompt', opts.systemPrompt,
    '--setting-sources', '',
    '--strict-mcp-config',
  ];
  if (opts.sessionId) return [...base, '--session-id', opts.sessionId];
  if (opts.resumeId) return [...base, '--resume', opts.resumeId];
  throw new Error('buildChatArgs needs exactly one of sessionId or resumeId');
}

// --- Prompt construction (frozen at session creation) ------------------------

export interface PaperPromptInput {
  paper: PaperChatContext;
  /** Worldline siblings, as of session creation. Frozen with the prompt. */
  relatedWorldlines: { worldlineName: string; titles: string[] }[];
  contextMode: ChatContextMode;
  /** The newest ready walkthrough's outline, when one exists. */
  walkthrough?: { thesis: string; scenes: { title: string; narration: string }[] } | null;
  sourceVersion?: string | null;
}

const CONTEXT_NOTES: Record<ChatContextMode, string> = {
  tex: `The complete LaTeX source of the paper is attached to the first message: the author's own macro definitions (hoisted to the top, they are the decoder ring for the notation), the real \\label{...} names, and the true section structure.

LaTeX has no pagination, so you have no page numbers. Cite sections and equation labels instead — "the definition in (3) / \\label{eq:attn}", not "on page 4". Never guess a page number.`,
  pdf: `The full PDF of the paper is attached to the first message. Cite page numbers where they help.`,
  abstract: `Only the paper's title and abstract are available — neither the LaTeX source nor the PDF could be fetched. Answer from the abstract, and say plainly when a question needs the full text you do not have.`,
};

export function buildPaperSystemPrompt(input: PaperPromptInput): string {
  const { paper } = input;
  const sections: string[] = [];

  sections.push(
    'You are a research assistant helping one scientist read a specific academic paper.'
  );

  const isUpload = paper.arxivId.startsWith('upload-');
  sections.push(
    `<paper>
Title: ${paper.title}
Authors: ${paper.authors.join(', ')}${isUpload ? '' : `\nArXiv ID: ${paper.arxivId}`}${
      input.sourceVersion ? ` (source version ${input.sourceVersion})` : ''
    }
Categories: ${paper.categories.join(', ')}
</paper>`
  );

  if (input.contextMode === 'abstract') {
    sections.push(`<abstract>\n${paper.summary}\n</abstract>`);
  }

  sections.push(`<context>\n${CONTEXT_NOTES[input.contextMode]}\n</context>`);

  if (input.relatedWorldlines.length > 0) {
    const rendered = input.relatedWorldlines
      .map(wl => `- "${wl.worldlineName}":\n${wl.titles.map(t => `    · ${t}`).join('\n')}`)
      .join('\n');
    sections.push(
      `<research-threads>
The user tracks this paper inside these threads of related work. They may ask how it connects to them.
${rendered}
</research-threads>`
    );
  }

  if (input.walkthrough) {
    const scenes = input.walkthrough.scenes
      .map((s, i) => `${i + 1}. ${s.title} — ${s.narration.slice(0, 240)}`)
      .join('\n');
    sections.push(
      `<generated-walkthrough>
An interactive walkthrough of this paper was generated earlier, and the user may be reading it beside this conversation. Its framing:

Thesis: ${input.walkthrough.thesis}
${scenes}

That outline is a model's reading of the paper, not the paper itself. Where it and the source disagree, the source wins, and say so.
</generated-walkthrough>`
    );
  }

  sections.push(
    `Answer questions about the paper's mechanism, methodology, results and limitations. Be concise and precise: the user is a working scientist, not an audience to be impressed.

Use the author's own notation rather than inventing your own. When a question turns on a specific equation, quote it and name its label. When the material you were given does not answer the question, say that plainly instead of inferring — a confident guess about a paper is worse than an admission.`
  );

  return sections.join('\n\n');
}

export function buildWorldlineSystemPrompt(input: {
  worldline: WorldlineChatContext;
}): string {
  const papers = input.worldline.papers
    .map(
      (p, i) =>
        `Paper ${i + 1}: "${p.title}"\n  Authors: ${p.authors.join(', ')}\n  ArXiv ID: ${
          p.arxivId
        }\n  Abstract: ${p.summary}`
    )
    .join('\n\n');

  return `You are a research assistant helping one scientist reason about a thread of related papers they have grouped together under the name "${input.worldline.worldlineName}".

<thread>
This thread contains ${input.worldline.papers.length} paper(s), in the order the user placed them:

${papers}
</thread>

You have the titles, authors and abstracts above — not the full texts. Help the user see how these papers connect: what each adds to the ones before it, where they disagree, what trajectory the thread traces, and what is conspicuously missing from it. Be concise and precise, and say plainly when a question needs a full text you were not given.`;
}

// --- Transcript replay -------------------------------------------------------

/**
 * Render a stored transcript for a session being re-primed — a session created
 * before this backend existed, or one whose CLI session file is gone.
 *
 * The alternative (start cold, keep the transcript for display only) means the
 * model visibly forgets everything said before the re-prime, with no
 * explanation the user can see. This costs a few hundred tokens once and rides
 * *after* the paper context block in the same message, so the cached paper
 * prefix is unaffected.
 *
 * Oldest turns are dropped first when the cap bites: the recent exchange is what
 * the next question is most likely to depend on.
 */
export function renderTranscriptReplay(
  messages: { role: 'user' | 'assistant'; content: string }[],
  maxChars = MAX_REPLAY_CHARS
): string {
  if (messages.length === 0) return '';

  const rendered: string[] = [];
  let total = 0;
  let dropped = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const line = `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`;
    if (total + line.length > maxChars && rendered.length > 0) {
      dropped = i + 1;
      break;
    }
    rendered.unshift(line);
    total += line.length;
  }

  const elision = dropped > 0 ? `[${dropped} earlier message(s) omitted]\n\n` : '';
  return `<conversation-so-far>
${elision}${rendered.join('\n\n')}
</conversation-so-far>

The exchange above already happened between you and this user about this paper; it is being replayed because the conversation is resuming in a fresh model session. Continue it — do not greet the user again or re-introduce the paper.`;
}

// --- Context resolution ------------------------------------------------------

/**
 * Render the distilled source as the context block.
 *
 * Everything source-derived lives here rather than in the system prompt: the
 * prompt is replayed verbatim in argv on every single turn, so it stays small,
 * while this block is sent once and then lives in the CLI's session history.
 */
export function renderTexContext(distilled: DistilledSource, version: string | null): string {
  const parts: string[] = [];

  parts.push(
    `Below is the complete LaTeX source of the paper${
      version ? ` (arXiv version ${version})` : ''
    }, flattened from the author's submission. The macro definitions are hoisted to the top of the source: they define the notation.`
  );

  if (distilled.structure.length > 0) {
    parts.push(
      `SECTION STRUCTURE:\n${distilled.structure
        .map(s => `  ${'  '.repeat(s.level)}${s.title}`)
        .join('\n')}`
    );
  }

  if (distilled.labels.length > 0) {
    parts.push(
      `LABELLED EQUATIONS, THEOREMS AND FLOATS (cite these by name):\n${distilled.labels
        .map(l => `  ${l.label}  (${l.env}) — ${l.snippet.slice(0, 120)}`)
        .join('\n')}`
    );
  }

  if (distilled.figures.length > 0) {
    parts.push(
      `FIGURES (captions only — you cannot see the images):\n${distilled.figures
        .map(f => `  [${f.kind}] ${f.label || '(unlabelled)'} — ${f.caption.slice(0, 200)}`)
        .join('\n')}`
    );
  }

  const citations = Object.entries(distilled.citations);
  if (citations.length > 0) {
    parts.push(
      `BIBLIOGRAPHY (\\cite key → work):\n${citations
        .map(([key, title]) => `  ${key} → ${title.slice(0, 160)}`)
        .join('\n')}`
    );
  }

  if (distilled.warnings.length > 0) {
    parts.push(
      `NOTES ON WHAT YOU ARE NOT SEEING:\n${distilled.warnings.map(w => `  - ${w}`).join('\n')}`
    );
  }

  parts.push(`<source>\n${distilled.flattenedTex}\n</source>`);
  return parts.join('\n\n');
}

const contextCache = new Map<string, { at: number; ctx: ResolvedContext }>();

function cached(key: string): ResolvedContext | null {
  const hit = contextCache.get(key);
  if (hit && Date.now() - hit.at < CONTEXT_TTL_MS) return hit.ctx;
  contextCache.delete(key);
  return null;
}

function remember(key: string, ctx: ResolvedContext): ResolvedContext {
  contextCache.set(key, { at: Date.now(), ctx });
  for (const [k, v] of contextCache) {
    if (Date.now() - v.at > CONTEXT_TTL_MS) contextCache.delete(k);
  }
  return ctx;
}

async function tryTex(arxivId: string): Promise<ResolvedContext | null> {
  const pkg = await fetchSourcePackage(arxivId);
  if (!pkg || pkg.files.length === 0) return null;
  const distilled = distillSource(readTextFiles(pkg), { entryNames: pkg.entryNames });
  if (distilled.flattenedTex.trim().length === 0) return null;

  const warnings = [...pkg.warnings];
  if (distilled.truncated) {
    warnings.push('The source exceeded the context budget; some sections were dropped.');
  }
  return {
    mode: 'tex',
    tex: renderTexContext(distilled, pkg.version),
    sourceVersion: pkg.version,
    warnings,
  };
}

/**
 * Resolve the context for a paper, in preference order, freezing the first
 * thing that works. Uploaded papers (`upload-*`) can only ever be `pdf`: there
 * is no arXiv source to fetch.
 */
export async function resolvePaperContext(
  arxivId: string,
  preferred: 'tex' | 'pdf',
  fetchPdfBase64: (arxivId: string) => Promise<string>
): Promise<ResolvedContext> {
  const key = `${arxivId}|${preferred}`;
  const hit = cached(key);
  if (hit) return hit;

  const warnings: string[] = [];
  const isUpload = arxivId.startsWith('upload-');
  const order: ('tex' | 'pdf')[] = isUpload
    ? ['pdf']
    : preferred === 'tex'
      ? ['tex', 'pdf']
      : ['pdf', 'tex'];

  for (const mode of order) {
    try {
      if (mode === 'tex') {
        const ctx = await tryTex(arxivId);
        if (ctx) return remember(key, { ...ctx, warnings: [...warnings, ...ctx.warnings] });
        warnings.push('No usable LaTeX source is available for this paper.');
      } else {
        const pdfBase64 = await fetchPdfBase64(arxivId);
        return remember(key, { mode: 'pdf', pdfBase64, warnings });
      }
    } catch (err) {
      warnings.push(
        `Could not use the ${mode} context: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  return remember(key, { mode: 'abstract', warnings });
}

// --- stream-json input framing ----------------------------------------------

export interface ContentBlock {
  type: string;
  [key: string]: unknown;
}

/**
 * One NDJSON user message for the CLI's stream-json input.
 *
 * ⚠️ **No `cache_control` anywhere.** It passes validation but the CLI already
 * places four breakpoints of its own, and a fifth fails the request outright:
 * `400 A maximum of 4 blocks with cache_control may be provided. Found 5.`
 * The prefix is cached regardless, at a 1-hour TTL.
 */
export function frameUserMessage(blocks: ContentBlock[]): string {
  return `${JSON.stringify({
    type: 'user',
    message: { role: 'user', content: blocks },
  })}\n`;
}

/** The blocks that prime a fresh session: context, optional replay, then the question. */
export function primeBlocks(
  context: ResolvedContext,
  replay: string,
  text: string
): ContentBlock[] {
  const blocks: ContentBlock[] = [];

  if (context.mode === 'pdf' && context.pdfBase64) {
    blocks.push({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: context.pdfBase64 },
    });
  } else if (context.mode === 'tex' && context.tex) {
    blocks.push({ type: 'text', text: context.tex });
  }

  if (replay) blocks.push({ type: 'text', text: replay });
  blocks.push({ type: 'text', text });
  return blocks;
}

// --- Output stream parsing ---------------------------------------------------

export interface RawUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

export type ChatStreamEvent =
  | { type: 'init'; sessionId?: string }
  | { type: 'delta'; text: string }
  | {
      type: 'result';
      text: string;
      usage: RawUsage;
      costUsd?: number;
      isError: boolean;
      subtype?: string;
      sessionId?: string;
    };

/**
 * Interpret one line of the CLI's stream-json output.
 *
 * Thinking deltas are deliberately **not** forwarded: the user asked about a
 * paper, not to watch the model deliberate, and streaming them would bury the
 * answer.
 */
export function interpretChatStreamLine(line: string): ChatStreamEvent[] {
  let event: any;
  try {
    event = JSON.parse(line);
  } catch {
    return [];
  }

  const out: ChatStreamEvent[] = [];

  if (event.type === 'system' && event.subtype === 'init') {
    out.push({ type: 'init', sessionId: event.session_id });
  }

  if (event.type === 'stream_event') {
    const inner = event.event;
    if (inner?.type === 'content_block_delta' && inner.delta?.type === 'text_delta') {
      out.push({ type: 'delta', text: String(inner.delta.text ?? '') });
    }
  }

  if (event.type === 'result') {
    const usage = event.usage ?? {};
    out.push({
      type: 'result',
      text: typeof event.result === 'string' ? event.result : '',
      usage: {
        input_tokens: usage.input_tokens ?? 0,
        output_tokens: usage.output_tokens ?? 0,
        cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
        cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
      },
      costUsd: typeof event.total_cost_usd === 'number' ? event.total_cost_usd : undefined,
      isError: !!event.is_error || (event.subtype && event.subtype !== 'success'),
      subtype: event.subtype,
      sessionId: event.session_id,
      // Deliberately no model. `modelUsage` lists every model the session
      // touched, including the CLI's own background model, in no meaningful
      // order — freezing a value read from it resumed a conversation on the
      // wrong model and missed the cache. The requested model is the answer.
    });
  }

  return out;
}

/** Does this failure mean the session id no longer exists on disk? */
export function isMissingSessionError(message: string): boolean {
  return /no conversation found|session .*not found|could not find session|no session/i.test(
    message
  );
}

// --- Running one turn --------------------------------------------------------

export interface TurnResult {
  text: string;
  usage: ChatUsage;
  model: string;
  backend: ChatBackend;
  /** The uuid the conversation now lives under, for the session row. */
  cliSessionId: string | null;
  /** True when a resume was retried as a fresh priming run. */
  reprimed: boolean;
  warnings: string[];
}

const activeChildren = new Set<ReturnType<typeof spawn>>();
let reaperInstalled = false;

/** A killed server must not leave paid subprocesses running with nobody reading them. */
function installChildReaper(): void {
  if (reaperInstalled) return;
  reaperInstalled = true;
  const reap = () => {
    for (const child of activeChildren) {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }
    activeChildren.clear();
  };
  process.on('exit', reap);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(signal, () => {
      reap();
      process.exit(130);
    });
  }
}

interface CliRun {
  text: string;
  usage: RawUsage;
  costUsd?: number;
  sessionId?: string;
}

function runCli(
  args: string[],
  input: string,
  onDelta: (text: string) => void,
  abort: { aborted: boolean }
): Promise<CliRun> {
  installChildReaper();
  return new Promise((resolve, reject) => {
    const child = spawn(CLI_BIN, args, {
      cwd: chatSessionsCwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    activeChildren.add(child);

    let stderr = '';
    let buffered = '';
    let accumulated = '';
    let result: Extract<ChatStreamEvent, { type: 'result' }> | null = null;
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(abortWatch);
      activeChildren.delete(child);
      fn();
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(() =>
        reject(new Error(`Claude CLI timed out after ${Math.round(CHAT_TIMEOUT_MS / 60000)} minutes`))
      );
    }, CHAT_TIMEOUT_MS);

    // The client closing the SSE connection means nobody is reading the answer;
    // killing the child then stops paying for it.
    const abortWatch = setInterval(() => {
      if (!abort.aborted) return;
      child.kill('SIGKILL');
      finish(() => reject(new Error('The client disconnected before the answer finished.')));
    }, 500);

    const handleLine = (line: string) => {
      for (const event of interpretChatStreamLine(line)) {
        if (event.type === 'delta') {
          accumulated += event.text;
          onDelta(event.text);
        } else if (event.type === 'result') {
          result = event;
        }
      }
    };

    child.stdout.on('data', chunk => {
      buffered += chunk;
      let nl: number;
      while ((nl = buffered.indexOf('\n')) !== -1) {
        const line = buffered.slice(0, nl).trim();
        buffered = buffered.slice(nl + 1);
        if (line) handleLine(line);
      }
    });
    child.stderr.on('data', chunk => { stderr += chunk; });

    child.on('error', (err: NodeJS.ErrnoException) => {
      finish(() =>
        reject(
          err.code === 'ENOENT'
            ? new Error(
                `Claude Code CLI not found (looked for "${CLI_BIN}"). Install it, set CLAUDE_CLI_PATH, or set the chatBackend setting to "api".`
              )
            : err
        )
      );
    });

    child.on('close', code => {
      if (buffered.trim()) handleLine(buffered.trim());
      finish(() => {
        const settledResult = result as Extract<ChatStreamEvent, { type: 'result' }> | null;
        if (settledResult && !settledResult.isError) {
          resolve({
            text: settledResult.text || accumulated,
            usage: settledResult.usage,
            costUsd: settledResult.costUsd,
            sessionId: settledResult.sessionId,
          });
          return;
        }
        const detail =
          (settledResult && (settledResult.text || settledResult.subtype)) ||
          stderr.trim() ||
          `Claude CLI exited with code ${code}`;
        reject(new Error(detail));
      });
    });

    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

/** Serialize turns per session: two `--resume`s of one uuid at once corrupt it. */
const sessionLocks = new Map<string, Promise<unknown>>();

export function withSessionLock<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
  const previous = sessionLocks.get(sessionId) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(work);
  sessionLocks.set(
    sessionId,
    next.catch(() => {})
  );
  next.finally(() => {
    if (sessionLocks.get(sessionId) === next) sessionLocks.delete(sessionId);
  }).catch(() => {});
  return next;
}

export interface TurnInput {
  backend: ChatBackend;
  model: string;
  effort: string;
  systemPrompt: string;
  /**
   * Resolved lazily and never called on a CLI resume — the paper already lives
   * in the model session, and re-reading a 50 MB PDF off disk to send nothing
   * would be pure waste. It *is* called when a resume falls through to a
   * re-prime, which is why it is a thunk rather than an optional value.
   */
  getContext: () => Promise<ResolvedContext>;
  /** Null when the session has never been primed. */
  cliSessionId: string | null;
  /** Prior turns, replayed only when priming. */
  history: { role: 'user' | 'assistant'; content: string }[];
  message: string;
  apiKey?: string;
}

/** Run one message on the CLI backend, priming or resuming as needed. */
async function runTurnViaCli(
  input: TurnInput,
  onDelta: (text: string) => void,
  abort: { aborted: boolean }
): Promise<TurnResult> {
  const warnings: string[] = [];

  const prime = async (): Promise<TurnResult> => {
    const uuid = crypto.randomUUID();
    const context = await input.getContext();
    warnings.push(...context.warnings);
    const blocks = primeBlocks(
      context,
      renderTranscriptReplay(input.history),
      input.message
    );
    const run = await runCli(
      buildChatArgs({
        systemPrompt: input.systemPrompt,
        model: input.model,
        effort: input.effort,
        sessionId: uuid,
      }),
      frameUserMessage(blocks),
      onDelta,
      abort
    );
    return {
      text: run.text,
      usage: toUsage(run, input.model),
      // The model we ASKED for, never the one the envelope reports. The CLI's
      // `modelUsage` enumerates every model the session touched — including the
      // small background model it uses for its own housekeeping — and its key
      // order is not "the" model. Freezing that value made the second turn of a
      // conversation resume as Haiku: the wrong model, and a guaranteed cache
      // miss on top, since --model is part of the prefix.
      model: input.model,
      backend: 'cli',
      cliSessionId: run.sessionId || uuid,
      reprimed: input.cliSessionId !== null,
      warnings,
    };
  };

  if (!input.cliSessionId) return prime();

  try {
    const run = await runCli(
      buildChatArgs({
        systemPrompt: input.systemPrompt,
        model: input.model,
        effort: input.effort,
        resumeId: input.cliSessionId,
      }),
      frameUserMessage([{ type: 'text', text: input.message }]),
      onDelta,
      abort
    );

    // The single most valuable piece of instrumentation in this change: a
    // resume that reads nothing from cache has silently paid to rewrite the
    // entire paper, at roughly 17x. It should be impossible — the prompt is
    // replayed verbatim from the row — so if it happens, say so loudly.
    if (run.usage.cache_read_input_tokens === 0) {
      const note =
        'Cache miss on a resumed session: the whole paper was re-sent to the model. ' +
        'The frozen prompt or the model may have drifted from what created this session.';
      console.warn(`[navigate] chat: ${note}`);
      warnings.push(note);
    }

    return {
      text: run.text,
      usage: toUsage(run, input.model),
      model: input.model,
      backend: 'cli',
      cliSessionId: run.sessionId || input.cliSessionId,
      reprimed: false,
      warnings,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (abort.aborted || !isMissingSessionError(message)) throw err;
    // `~/.claude` cleaned, or the machine changed. Re-prime and carry on: the
    // user sees a slower turn and nothing else.
    warnings.push('The stored model session was gone, so the conversation was primed again.');
    return prime();
  }
}

function toUsage(run: CliRun, model: string): ChatUsage {
  return {
    ...run.usage,
    estimated_cost:
      typeof run.costUsd === 'number' ? run.costUsd : estimateCost(run.usage, model),
  };
}

/**
 * API backend: no session store, so the transcript and the paper are re-sent
 * every turn, with an ephemeral breakpoint on the system prompt. The 5-minute
 * TTL is exactly what the CLI path exists to escape, which is why `cli` is the
 * default; this is for a headless deploy with no CLI, or when messages should
 * bill to an API account.
 */
async function runTurnViaApi(
  input: TurnInput,
  onDelta: (text: string) => void,
  abort: { aborted: boolean }
): Promise<TurnResult> {
  if (!input.apiKey) throw new Error('Claude API key is required. Please set it in Settings.');

  const context = await input.getContext();
  const messages: any[] = [];
  const history = input.history;
  const firstUser = history.findIndex(m => m.role === 'user');

  for (let i = 0; i < history.length; i++) {
    const m = history[i];
    if (i === firstUser) {
      messages.push({
        role: 'user',
        content: primeBlocks(context, '', m.content),
      });
    } else {
      messages.push({ role: m.role, content: m.content });
    }
  }

  if (firstUser === -1) {
    messages.push({ role: 'user', content: primeBlocks(context, '', input.message) });
  } else {
    messages.push({ role: 'user', content: input.message });
  }

  const body = {
    model: input.model,
    max_tokens: API_MAX_TOKENS,
    stream: true,
    system: [
      { type: 'text', text: input.systemPrompt, cache_control: { type: 'ephemeral' } },
    ],
    messages,
    output_config: { effort: input.effort },
  };

  const controller = new AbortController();
  const abortWatch = setInterval(() => {
    if (abort.aborted) controller.abort();
  }, 500);

  try {
    const response = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': input.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok || !response.body) {
      const errorData = (await response.json().catch(() => null)) as any;
      throw new Error(
        errorData?.error?.message || `Claude API request failed (${response.status})`
      );
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffered = '';
    let text = '';
    const usage: RawUsage = {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    };
    let model = input.model;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffered.indexOf('\n')) !== -1) {
        const line = buffered.slice(0, nl).trim();
        buffered = buffered.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        let event: any;
        try {
          event = JSON.parse(line.slice(5).trim());
        } catch {
          continue;
        }
        if (event.type === 'message_start') {
          model = event.message?.model || model;
          const u = event.message?.usage ?? {};
          usage.input_tokens += u.input_tokens ?? 0;
          usage.cache_creation_input_tokens += u.cache_creation_input_tokens ?? 0;
          usage.cache_read_input_tokens += u.cache_read_input_tokens ?? 0;
        } else if (
          event.type === 'content_block_delta' &&
          event.delta?.type === 'text_delta'
        ) {
          text += event.delta.text;
          onDelta(event.delta.text);
        } else if (event.type === 'message_delta') {
          usage.output_tokens += event.usage?.output_tokens ?? 0;
        } else if (event.type === 'error') {
          throw new Error(event.error?.message || 'The Claude API stream reported an error.');
        }
      }
    }

    return {
      text,
      usage: { ...usage, estimated_cost: estimateCost(usage, model) },
      model,
      backend: 'api',
      cliSessionId: null,
      reprimed: false,
      warnings: context.warnings,
    };
  } finally {
    clearInterval(abortWatch);
  }
}

export function runChatTurn(
  input: TurnInput,
  onDelta: (text: string) => void,
  abort: { aborted: boolean }
): Promise<TurnResult> {
  return input.backend === 'cli'
    ? runTurnViaCli(input, onDelta, abort)
    : runTurnViaApi(input, onDelta, abort);
}

// --- Backend status ----------------------------------------------------------

export interface BackendStatus {
  backend: ChatBackend;
  model: string;
  effort: string;
  contextMode: string;
  cli: { present: boolean; version?: string; path: string; error?: string };
  auth: { loggedIn: boolean; method?: string; subscription?: string; error?: string };
  apiKeyPresent: boolean;
  cwd: string;
  ready: boolean;
}

function runQuick(args: string[], timeoutMs = 15000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    const child = spawn(CLI_BIN, args, { cwd: os.tmpdir(), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ code: -1, stdout, stderr: stderr || 'timed out' });
    }, timeoutMs);
    child.stdout.on('data', c => { stdout += c; });
    child.stderr.on('data', c => { stderr += c; });
    child.on('error', (err: Error) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: err.message });
    });
    child.on('close', code => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

/**
 * Whether this machine can actually answer a chat message, checked without
 * spending anything: `--version` for the binary and `auth status` for the
 * credentials, both local. On the `cli` backend the Settings panel checks this
 * instead of an API key, because there is no key to check.
 */
export async function getBackendStatus(opts: {
  backend: ChatBackend;
  model: string;
  effort: string;
  contextMode: string;
  apiKeyPresent: boolean;
}): Promise<BackendStatus> {
  const status: BackendStatus = {
    ...opts,
    cli: { present: false, path: CLI_BIN },
    auth: { loggedIn: false },
    cwd: chatSessionsCwd(),
    ready: false,
  };

  if (opts.backend === 'api') {
    status.ready = opts.apiKeyPresent;
    return status;
  }

  const version = await runQuick(['--version']);
  if (version.code !== 0) {
    status.cli.error = version.stderr.trim() || 'the claude CLI could not be run';
    return status;
  }
  status.cli.present = true;
  status.cli.version = version.stdout.trim().split('\n')[0];

  const auth = await runQuick(['auth', 'status']);
  try {
    const parsed = JSON.parse(auth.stdout);
    status.auth = {
      loggedIn: !!parsed.loggedIn,
      method: parsed.authMethod,
      subscription: parsed.subscriptionType,
    };
  } catch {
    status.auth = {
      loggedIn: auth.code === 0,
      error: auth.code === 0 ? undefined : auth.stderr.trim() || 'could not read auth status',
    };
  }

  status.ready = status.cli.present && status.auth.loggedIn;
  return status;
}
