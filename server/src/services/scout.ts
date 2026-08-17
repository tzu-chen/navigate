import crypto from 'crypto';
import os from 'os';
import { spawn } from 'child_process';
import * as db from './database';
import { SavedPaper } from '../types';

/**
 * Scout — Opus-5 triage of a browse listing against the saved library.
 *
 * Complements the embedding similarity system (`similarity.ts`): that one asks
 * "does this paper belong to an existing worldline?" using cheap local vectors;
 * Scout asks the broader, judgement-shaped question "given everything I've
 * saved and how I rated it, is this paper worth my attention today?" — which
 * needs a model that can read an abstract and reason about relevance.
 *
 * Precision-first, like the rest of the pipeline: a daily spray of false
 * positives is worse than a missed paper, so the prompt sets a high bar and the
 * finding count is capped.
 *
 * Two backends, selected by the `scoutBackend` setting:
 *   'cli' (default) — shells out to `claude -p`, so scans bill against the
 *     local Claude Code subscription instead of metered API credits and no API
 *     key is needed. Requires the `claude` CLI on PATH.
 *   'api' — posts to the Anthropic REST API with the stored `claudeApiKey`,
 *     the same way `chat.ts` does. Use this when there is no CLI (a headless
 *     deploy) or when scans should bill to the API account.
 * Both paths produce the same validated `ScoutFinding[]`.
 */

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';

export type ScoutBackend = 'cli' | 'api';

/** Override when `claude` is not on the server process's PATH. */
const CLI_BIN = process.env.CLAUDE_CLI_PATH || 'claude';
/** A full listing at medium effort is a minutes-long call; fail rather than hang forever. */
const CLI_TIMEOUT_MS = 8 * 60 * 1000;

// Opus 5. Thinking is on by default on this model, and `max_tokens` caps
// thinking + response text together — hence the generous budget below.
export const SCOUT_MODEL = 'claude-opus-5';
const SCOUT_MAX_TOKENS = 16000;
const SCOUT_EFFORT = 'medium';

/** Hard ceiling on abstracts sent in one scan (cost + context bound). */
export const MAX_CANDIDATES = 120;
/** Hard ceiling on returned findings. The bar is precision, not coverage. */
const MAX_FINDINGS = 8;

/** Abstracts are truncated to this many characters before being sent. */
const ABSTRACT_CHARS = 1200;

// Library profile bounds — keep the cached prefix stable-sized.
const MAX_WORLDLINE_TITLES = 12;
const MAX_TOP_TIER_TITLES = 30;
const MAX_RECENT_TITLES = 25;

// Opus 5 list pricing, USD per million tokens.
const PRICE_INPUT = 5;
const PRICE_OUTPUT = 25;
const PRICE_CACHE_WRITE = 6.25; // 1.25x input
const PRICE_CACHE_READ = 0.5; // 0.1x input

export interface ScoutCandidate {
  id: string;
  title: string;
  summary: string;
  authors: string[];
  categories?: string[];
}

export interface ScoutFinding {
  arxivId: string;
  score: number;
  headline: string;
  reason: string;
  connections: string[];
}

export interface ScoutUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  estimated_cost: number;
}

export interface ScoutScan {
  findings: ScoutFinding[];
  usage: ScoutUsage;
  model: string;
  backend: ScoutBackend;
}

// --- Library profile ---------------------------------------------------------

/**
 * The library context handed to the model. Serialized deterministically so its
 * hash is a stable fingerprint of "what the model was told about my library" —
 * that is what tells us whether an earlier scan is still current.
 */
export interface LibraryProfile {
  worldlines: { name: string; titles: string[] }[];
  topTier: { tier: string; title: string }[];
  tags: string[];
  favoriteAuthors: string[];
  recentSaves: string[];
  totalSaved: number;
}

const TIER_NAMES: Record<number, string> = {
  0: 'T0 (field-reshaping)',
  1: 'T1 (major contribution)',
  2: 'T2 (actively want to remember)',
  3: 'T3 (competent)',
  4: 'T4 (minor/narrow)',
};

export function buildLibraryProfile(): LibraryProfile {
  const worldlines = db
    .getAllWorldlinesWithPapers()
    .filter(wl => wl.papers.length > 0)
    .map(wl => ({
      name: wl.name,
      titles: wl.papers.slice(0, MAX_WORLDLINE_TITLES).map(p => p.title),
    }));

  const papers = db.getPapers() as SavedPaper[];

  // Ratings are the strongest available signal for taste: T0/T1 are the papers
  // the user judged genuinely important.
  const topTier = papers
    .filter(p => p.tier !== null && p.tier <= 1)
    .sort((a, b) => (a.tier ?? 9) - (b.tier ?? 9))
    .slice(0, MAX_TOP_TIER_TITLES)
    .map(p => ({ tier: TIER_NAMES[p.tier as number] ?? `T${p.tier}`, title: p.title }));

  // getPapers() is already ordered by added_at DESC.
  const recentSaves = papers.slice(0, MAX_RECENT_TITLES).map(p => p.title);

  return {
    worldlines,
    topTier,
    tags: (db.getTags() as { name: string }[]).map(t => t.name),
    favoriteAuthors: (db.getFavoriteAuthors() as { name: string }[]).map(a => a.name),
    recentSaves,
    totalSaved: papers.length,
  };
}

/** Stable hash of the library context. Changes iff the model's view of the library changes. */
export function fingerprintLibraryProfile(profile: LibraryProfile): string {
  return crypto.createHash('sha256').update(JSON.stringify(profile)).digest('hex').slice(0, 16);
}

function renderLibraryProfile(profile: LibraryProfile): string {
  const sections: string[] = [];

  sections.push(`The library holds ${profile.totalSaved} saved paper(s).`);

  if (profile.worldlines.length > 0) {
    const rendered = profile.worldlines
      .map(wl => `- "${wl.name}":\n${wl.titles.map(t => `    · ${t}`).join('\n')}`)
      .join('\n');
    sections.push(
      `RESEARCH THREADS (worldlines) — ordered sequences of papers the user is actively tracking:\n${rendered}`
    );
  }

  if (profile.topTier.length > 0) {
    const rendered = profile.topTier.map(p => `- [${p.tier}] ${p.title}`).join('\n');
    sections.push(
      `HIGHEST-RATED SAVES — the user's own quality judgements, the strongest signal of taste:\n${rendered}`
    );
  }

  if (profile.tags.length > 0) {
    sections.push(`TAGS the user organizes by: ${profile.tags.join(', ')}`);
  }

  if (profile.favoriteAuthors.length > 0) {
    sections.push(`FOLLOWED AUTHORS: ${profile.favoriteAuthors.join(', ')}`);
  }

  if (profile.recentSaves.length > 0) {
    sections.push(
      `MOST RECENT SAVES — what the user is reading right now:\n${profile.recentSaves.map(t => `- ${t}`).join('\n')}`
    );
  }

  return sections.join('\n\n');
}

function buildSystemPrompt(profile: LibraryProfile): string {
  return `You are a research scout triaging a day's arXiv listing for one working scientist. You know their library: the papers they saved, how they rated them, the research threads they track, and the authors they follow.

<library>
${renderLibraryProfile(profile)}
</library>

Your job: from the candidate preprints in the next message, surface only the ones this specific person would regret missing.

The bar is high and the failure mode is over-flagging. The user browses these categories every day, so "same subfield as something they saved" is not interesting — it describes most of the listing. Flag a paper only when you can name a concrete, specific link to their library:
- it directly advances, contradicts, or supersedes a paper in one of their research threads;
- it is by an author they follow, or by a group whose prior work they rated T0/T1;
- it solves a problem left open by something they saved, or applies their tracked method in a domain they track;
- it is a genuinely major result in an area their highest-rated saves cluster around.

Do not flag a paper for being generally strong, well-cited, or topical. If nothing clears the bar, return an empty list — that is a correct and expected answer on an ordinary day.

Score each finding 0-100 for how strongly it connects to this library: 90+ = drop everything, 75-89 = clearly worth reading, 60-74 = worth a look. Do not report anything below 60. Return at most ${MAX_FINDINGS} findings, best first.

For each finding:
- "arxivId": copy the candidate's arXiv ID exactly as given.
- "headline": at most 12 words on what makes it matter to this person.
- "reason": one to three sentences. Name the specific library paper, thread, author, or rating it connects to — a reason that would read the same for any user is not a reason.
- "connections": the exact names of the worldlines, tags, or authors it connects to, as they appear above. Empty if the link is to a specific paper rather than a named thread.`;
}

function renderCandidates(candidates: ScoutCandidate[]): string {
  const rendered = candidates
    .map((p, i) => {
      const authors =
        p.authors.length > 8
          ? `${p.authors.slice(0, 8).join(', ')} (+${p.authors.length - 8} more)`
          : p.authors.join(', ');
      const abstract =
        p.summary.length > ABSTRACT_CHARS ? `${p.summary.slice(0, ABSTRACT_CHARS)}…` : p.summary;
      const categories = p.categories?.length ? `\nCategories: ${p.categories.join(', ')}` : '';
      return `[${i + 1}] arXiv:${p.id}\nTitle: ${p.title}\nAuthors: ${authors}${categories}\nAbstract: ${abstract}`;
    })
    .join('\n\n');

  return `Here are today's ${candidates.length} candidate preprints. Triage them against the library.\n\n${rendered}`;
}

// --- Model call --------------------------------------------------------------

const FINDINGS_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          arxivId: { type: 'string' },
          score: { type: 'integer' },
          headline: { type: 'string' },
          reason: { type: 'string' },
          connections: { type: 'array', items: { type: 'string' } },
        },
        required: ['arxivId', 'score', 'headline', 'reason', 'connections'],
        additionalProperties: false,
      },
    },
  },
  required: ['findings'],
  additionalProperties: false,
} as const;

function estimateCost(usage: {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}): number {
  return (
    (usage.input_tokens * PRICE_INPUT +
      usage.output_tokens * PRICE_OUTPUT +
      usage.cache_creation_input_tokens * PRICE_CACHE_WRITE +
      usage.cache_read_input_tokens * PRICE_CACHE_READ) /
    1_000_000
  );
}

async function callAnthropic(apiKey: string, body: Record<string, unknown>): Promise<any> {
  const response = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorData = (await response.json().catch(() => null)) as any;
    const message = errorData?.error?.message || `Claude API request failed (${response.status})`;
    const err = new Error(message) as Error & { status?: number };
    err.status = response.status;
    throw err;
  }

  return response.json();
}

/** Pull the JSON object out of the response, tolerating prose or fences around it. */
function parseFindings(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

/**
 * Keep only findings that name a real candidate, one per paper, best first.
 * The model is the judge of relevance, not of which papers exist.
 *
 * Exported for `npm run verify:scout` — this is the trust boundary between
 * model output and data the UI renders, so it is worth checking in isolation.
 */
export function normalizeFindings(raw: unknown, candidates: ScoutCandidate[]): ScoutFinding[] {
  const byId = new Map(candidates.map(c => [c.id, c]));
  const list = (raw as any)?.findings;
  if (!Array.isArray(list)) return [];

  const seen = new Set<string>();
  const findings: ScoutFinding[] = [];

  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    // Version suffixes occasionally survive into the model's echo of the ID.
    const arxivId = String(item.arxivId ?? '').trim().replace(/v\d+$/, '');
    if (!byId.has(arxivId) || seen.has(arxivId)) continue;

    const score = Number(item.score);
    findings.push({
      arxivId,
      score: Number.isFinite(score) ? Math.max(0, Math.min(100, Math.round(score))) : 0,
      headline: String(item.headline ?? '').trim(),
      reason: String(item.reason ?? '').trim(),
      connections: Array.isArray(item.connections)
        ? item.connections.map((c: unknown) => String(c).trim()).filter(Boolean)
        : [],
    });
    seen.add(arxivId);
  }

  return findings.sort((a, b) => b.score - a.score).slice(0, MAX_FINDINGS);
}

// --- CLI backend (`claude -p`) ----------------------------------------------

/**
 * Argument vector for one scan. Exported so `verify:scout` can assert on the
 * flags that matter without spawning anything.
 *
 * - `--system-prompt` *replaces* Claude Code's coding-agent prompt; this is a
 *   text-judgement task, not a coding session.
 * - `--json-schema` is the CLI's structured-output validation, so the envelope
 *   comes back with a parsed `structured_output` object.
 * - `--tools ""` disables every built-in tool: nothing here needs to touch the
 *   filesystem or network, and a scan should not be able to.
 */
export function buildCliArgs(systemPrompt: string): string[] {
  return [
    '-p',
    '--output-format', 'json',
    '--model', SCOUT_MODEL,
    '--effort', SCOUT_EFFORT,
    '--tools', '',
    '--system-prompt', systemPrompt,
    '--json-schema', JSON.stringify(FINDINGS_SCHEMA),
    '--no-session-persistence',
    '--strict-mcp-config',
  ];
}

function runClaudeCli(args: string[], input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // Neutral cwd, deliberately. Claude Code auto-discovers CLAUDE.md by walking
    // up from its working directory — spawning inside this repo silently
    // prepends ~10k tokens of project context to every scan.
    const child = spawn(CLI_BIN, args, { cwd: os.tmpdir(), stdio: ['pipe', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`Scout scan timed out after ${CLI_TIMEOUT_MS / 60000} minutes`));
    }, CLI_TIMEOUT_MS);

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    };

    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });

    child.on('error', (err: NodeJS.ErrnoException) => {
      fail(
        err.code === 'ENOENT'
          ? new Error(
              `Claude Code CLI not found (looked for "${CLI_BIN}"). Install it, set CLAUDE_CLI_PATH, or set the scoutBackend setting to "api".`
            )
          : err
      );
    });

    child.on('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(stderr.trim() || `Claude CLI exited with code ${code}`));
        return;
      }
      resolve(stdout);
    });

    // The CLI can exit before draining stdin; an EPIPE here is not the real error.
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

async function scanViaCli(candidates: ScoutCandidate[], profile: LibraryProfile): Promise<ScoutScan> {
  const stdout = await runClaudeCli(buildCliArgs(buildSystemPrompt(profile)), renderCandidates(candidates));

  let envelope: any;
  try {
    envelope = JSON.parse(stdout);
  } catch {
    throw new Error('Could not parse the Claude CLI response.');
  }

  if (envelope?.is_error || envelope?.subtype !== 'success') {
    const detail = typeof envelope?.result === 'string' ? envelope.result : envelope?.subtype;
    throw new Error(detail ? `Claude CLI error: ${detail}` : 'Claude CLI returned an error.');
  }

  // `--json-schema` hands back the validated object; `result` is the fallback.
  const raw = envelope.structured_output ?? parseFindings(String(envelope.result ?? ''));

  const usage = {
    input_tokens: envelope.usage?.input_tokens ?? 0,
    output_tokens: envelope.usage?.output_tokens ?? 0,
    cache_creation_input_tokens: envelope.usage?.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: envelope.usage?.cache_read_input_tokens ?? 0,
  };

  return {
    findings: normalizeFindings(raw, candidates),
    model: envelope.modelUsage ? Object.keys(envelope.modelUsage)[0] || SCOUT_MODEL : SCOUT_MODEL,
    backend: 'cli',
    usage: {
      ...usage,
      // The CLI prices the call itself. On a subscription this is the
      // list-price equivalent of the work, not money charged to an API account.
      estimated_cost: typeof envelope.total_cost_usd === 'number' ? envelope.total_cost_usd : estimateCost(usage),
    },
  };
}

// --- API backend -------------------------------------------------------------

/**
 * Run one scan against the REST API. The system prompt (instructions + library
 * profile) carries a cache breakpoint, so back-to-back scans of different
 * categories on the same library re-read that prefix instead of paying for it
 * again. (The CLI backend caches the same prefix on its own.)
 */
async function scanViaApi(
  apiKey: string,
  candidates: ScoutCandidate[],
  profile: LibraryProfile
): Promise<ScoutScan> {
  const request: Record<string, unknown> = {
    model: SCOUT_MODEL,
    max_tokens: SCOUT_MAX_TOKENS,
    system: [
      {
        type: 'text',
        text: buildSystemPrompt(profile),
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [{ role: 'user', content: renderCandidates(candidates) }],
    output_config: {
      effort: SCOUT_EFFORT,
      format: { type: 'json_schema', schema: FINDINGS_SCHEMA },
    },
  };

  let data: any;
  try {
    data = await callAnthropic(apiKey, request);
  } catch (err) {
    // Structured outputs are the intended path; if this account or model build
    // rejects the parameter, fall back to prompting for JSON rather than
    // failing the scan. `normalizeFindings` validates either way.
    const status = (err as { status?: number }).status;
    if (status !== 400) throw err;
    const { output_config, ...rest } = request as any;
    data = await callAnthropic(apiKey, {
      ...rest,
      output_config: { effort: SCOUT_EFFORT },
      messages: [
        {
          role: 'user',
          content: `${renderCandidates(candidates)}\n\nRespond with a single JSON object and nothing else: {"findings": [{"arxivId": string, "score": number, "headline": string, "reason": string, "connections": string[]}]}`,
        },
      ],
    });
  }

  if (data?.stop_reason === 'refusal') {
    throw new Error('Claude declined to scan this listing.');
  }

  const text = (data?.content ?? []).find((b: any) => b?.type === 'text')?.text ?? '';
  const findings = normalizeFindings(parseFindings(text), candidates);

  const usage = {
    input_tokens: data?.usage?.input_tokens ?? 0,
    output_tokens: data?.usage?.output_tokens ?? 0,
    cache_creation_input_tokens: data?.usage?.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: data?.usage?.cache_read_input_tokens ?? 0,
  };

  return {
    findings,
    model: data?.model || SCOUT_MODEL,
    backend: 'api',
    usage: { ...usage, estimated_cost: estimateCost(usage) },
  };
}

/** Run one scan on the configured backend. */
export async function runScoutScan(
  backend: ScoutBackend,
  candidates: ScoutCandidate[],
  profile: LibraryProfile,
  apiKey?: string
): Promise<ScoutScan> {
  if (backend === 'cli') return scanViaCli(candidates, profile);
  if (!apiKey) throw new Error('Claude API key is required. Please set it in Settings.');
  return scanViaApi(apiKey, candidates, profile);
}

/**
 * Identity of a scan: the exact set of preprints triaged, in a listing.
 * Two presses of the button with the same listing produce the same key, which
 * is what makes the second press free.
 */
export function scanCacheKey(category: string | null, arxivIds: string[]): string {
  const payload = `v1|${category ?? ''}|${[...arxivIds].sort().join(',')}`;
  return crypto.createHash('sha256').update(payload).digest('hex');
}
