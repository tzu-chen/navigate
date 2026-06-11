// Pure, model-independent similarity math + decision logic.
//
// Lives in its own file (no DB, no @huggingface/transformers imports) so the
// worldline-matching rules can be unit-verified without loading the embedding
// model or opening SQLite. similarity.ts wires these into the real pipeline.

// --- Vector math ---

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// --- Scoring primitives ---

// Score = cosine to the single nearest member of a thread. "Very close to a
// specific existing paper in the thread" — the precision-bearing statement a
// centroid cannot make. Returns 0 for an empty thread.
export function nearestMemberScore(paperEmb: number[], memberEmbs: number[][]): number {
  let best = -Infinity;
  for (const m of memberEmbs) {
    const s = cosineSimilarity(paperEmb, m);
    if (s > best) best = s;
  }
  return best === -Infinity ? 0 : best;
}

// Linear-interpolation quantile (p in [0,1]). quantile(xs, 0.5) is the median.
export function quantile(values: number[], p: number): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const idx = p * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const frac = idx - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}

// A thread's internal cohesion: the (by default median) of each member's
// nearest-sibling cosine. "How close the thread is to itself." Used as a
// self-calibrated bar in place of one global threshold — tight threads demand
// tight matches, loose threads set their own looser-but-honest bar.
// Returns NaN when there are fewer than 2 members (no sibling exists); callers
// substitute a fallback bar in that case.
export function worldlineCohesion(memberEmbs: number[][], percentile = 0.5): number {
  const n = memberEmbs.length;
  if (n < 2) return NaN;
  const nearest: number[] = [];
  for (let i = 0; i < n; i++) {
    let best = -Infinity;
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const s = cosineSimilarity(memberEmbs[i], memberEmbs[j]);
      if (s > best) best = s;
    }
    nearest.push(best);
  }
  return quantile(nearest, percentile);
}

// --- Decision core ---

export interface WorldlineScoreInput {
  memberEmbs: number[][];
  cohesionBar: number; // resolved bar: the thread's cohesion, or a fallback
}

export interface WorldlineScoreResult {
  index: number; // index back into the input array
  score: number; // nearest-member cosine
}

// Phase 1 decision: for each thread, score by nearest member and keep it only
// if the score clears that thread's own cohesion bar. Results are sorted by
// score descending. (Phase 2 layers the exclusivity margin + corroboration on
// top of this candidate set.)
export function matchWorldlines(
  paperEmb: number[],
  worldlines: WorldlineScoreInput[]
): WorldlineScoreResult[] {
  const results: WorldlineScoreResult[] = [];
  for (let i = 0; i < worldlines.length; i++) {
    const w = worldlines[i];
    if (w.memberEmbs.length === 0) continue;
    const score = nearestMemberScore(paperEmb, w.memberEmbs);
    if (score >= w.cohesionBar) results.push({ index: i, score });
  }
  results.sort((a, b) => b.score - a.score);
  return results;
}

// --- Phase 2: exclusivity margin ---

// Among the cohesion-clearing candidates (already sorted desc), keep the top
// one only if it beats the runner-up by at least `margin`. A single candidate
// passes automatically (nothing to be confused with). "Sort of close to several
// threads" — the dominant false-positive pattern — is rejected here. Returns
// the lone winner, or null if the field is ambiguous / empty.
export function applyExclusivityMargin(
  ranked: WorldlineScoreResult[],
  margin: number
): WorldlineScoreResult | null {
  if (ranked.length === 0) return null;
  if (ranked.length === 1) return ranked[0];
  return ranked[0].score - ranked[1].score >= margin ? ranked[0] : null;
}

// --- Phase 2: corroboration (text + author overlap) ---

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been',
  'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
  'could', 'should', 'may', 'might', 'shall', 'can', 'it', 'its',
  'this', 'that', 'these', 'those', 'we', 'our', 'they', 'their',
  'them', 'us', 'he', 'she', 'his', 'her', 'which', 'who', 'whom',
  'what', 'when', 'where', 'why', 'how', 'if', 'then', 'than',
  'so', 'no', 'not', 'only', 'very', 'also', 'just', 'about',
  'such', 'each', 'all', 'both', 'more', 'most', 'other', 'some',
  'any', 'into', 'over', 'after', 'before', 'between', 'through',
  'during', 'above', 'below', 'up', 'down', 'out', 'off', 'as',
  'new', 'use', 'used', 'using', 'based', 'show', 'shows', 'shown',
  'paper', 'propose', 'proposed', 'method', 'methods', 'approach',
  'results', 'result', 'work', 'study', 'present', 'data',
]);

// Lowercase, strip punctuation, drop stop words and very short tokens. The
// stop-word set deliberately includes generic-ML/academic register words so
// they cannot stand in as "distinctive" corroboration.
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 2 && !STOP_WORDS.has(t));
}

// Normalize an author name for conservative exact-set matching. Precision-first:
// "J. Smith" vs "John Smith" won't match, and that missed corroboration is
// acceptable (the term path can still fire).
export function normalizeAuthor(name: string): string {
  return name.toLowerCase().replace(/\s+/g, ' ').trim();
}

// Document frequency of each term across a corpus of per-document term sets.
export function documentFrequencies(docs: Set<string>[]): { df: Map<string, number>; n: number } {
  const df = new Map<string, number>();
  for (const doc of docs) {
    for (const term of doc) df.set(term, (df.get(term) || 0) + 1);
  }
  return { df, n: docs.length };
}

export interface CorroborationInput {
  paperTerms: Set<string>;
  paperAuthors: string[]; // already normalized
  threadTerms: Set<string>;
  threadAuthors: Set<string>; // already normalized
  df: Map<string, number>; // corpus document frequencies
  corpusSize: number;
}

export interface CorroborationResult {
  ok: boolean;
  kind: 'author' | 'terms' | 'none';
  sharedAuthor?: string;
  distinctiveTerms: string[];
}

// A term is "distinctive" if it is rare in the corpus — present in at most
// `distinctiveDfMax` fraction of documents. Category-generic vocabulary (common
// across the day's browse set) is dense and gets excluded; specific technical
// terms are sparse and count.
function isDistinctive(term: string, df: Map<string, number>, corpusSize: number, distinctiveDfMax: number): boolean {
  if (corpusSize <= 0) return false;
  const f = df.get(term) ?? 0;
  return f / corpusSize <= distinctiveDfMax;
}

// The embedding match must be backed by at least one concrete, category-agnostic
// overlap: a shared author with a thread member, OR >= k shared distinctive
// terms. Two independent signals that fail on different papers => higher
// precision. Author overlap is checked first (cheap, strong).
export function corroborate(
  input: CorroborationInput,
  opts: { k: number; distinctiveDfMax: number }
): CorroborationResult {
  for (const a of input.paperAuthors) {
    if (input.threadAuthors.has(a)) {
      return { ok: true, kind: 'author', sharedAuthor: a, distinctiveTerms: [] };
    }
  }
  const distinctive: string[] = [];
  for (const t of input.paperTerms) {
    if (input.threadTerms.has(t) && isDistinctive(t, input.df, input.corpusSize, opts.distinctiveDfMax)) {
      distinctive.push(t);
    }
  }
  if (distinctive.length >= opts.k) {
    return { ok: true, kind: 'terms', distinctiveTerms: distinctive };
  }
  return { ok: false, kind: 'none', distinctiveTerms: distinctive };
}
