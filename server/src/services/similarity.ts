// Embedding-based, precision-first matching of browse papers to worldlines.
// Pipeline per browse paper (see worldline-similarity-overhaul.md):
//   nearest-member score -> per-thread cohesion gate -> exclusivity margin
//   -> required corroboration (shared author or distinctive terms).
// If the embedding model is unavailable, similarity is skipped (no flags)
// rather than scored by a weaker method.

import { pipeline, AutoTokenizer } from '@huggingface/transformers';
import * as ort from 'onnxruntime-node';
import path from 'path';
import fs from 'fs';
import { pipeline as streamPipeline } from 'stream/promises';
import { Readable } from 'stream';
import * as db from './database';
import { DATA_DIR } from './paths';
import {
  worldlineCohesion,
  matchWorldlines,
  applyExclusivityMargin,
  corroborate,
  documentFrequencies,
  tokenize,
  normalizeAuthor,
  WorldlineScoreInput,
} from './similarity-core';

// --- Embedding backend ---
// Primary: SPECTER2 "proximity" — citation-trained scientific paper embeddings,
// run via onnxruntime-node on CPU (no Python, no GPU). Falls back to the
// all-MiniLM transformers.js pipeline if SPECTER2 can't be loaded. The active
// backend's `version` tags cached embeddings, so a backend switch never mixes
// incompatible vectors (768-d vs 384-d) in the paper_embeddings cache.

interface EmbeddingBackend {
  version: string;
  embed: (texts: string[]) => Promise<number[][]>;
}

// SPECTER2-proximity ONNX (adamlabadorf/specter2-proximity-onnx): the proximity
// adapter is baked into the graph; inputs are input_ids + attention_mask and the
// output is a pooled 768-d "embeddings" tensor we L2-normalize ourselves.
const SPECTER2_DIR = path.join(DATA_DIR, 'model-cache', 'specter2-proximity');
const SPECTER2_URL = 'https://huggingface.co/adamlabadorf/specter2-proximity-onnx/resolve/main';
const SPECTER2_FILES = ['specter2_proximity.onnx', 'specter2_proximity.onnx.data'];
// The matching specter2 tokenizer (transformers.js layout, ships tokenizer.json).
const SPECTER2_TOKENIZER = 'benchoi93/specter2-base-onnx-web';

let ortSession: ort.InferenceSession | null = null;
let specter2Tokenizer: any = null;

// onnxruntime-node defaults to one intra-op thread per CPU core, which pegs every
// core (and spins the fan) when a batch of browse papers is embedded. Cap it to a
// small, configurable pool so inference stays a quiet background task. Override
// with SIMILARITY_NUM_THREADS; 0/unset -> 2.
const SIMILARITY_NUM_THREADS =
  Math.max(1, parseInt(process.env.SIMILARITY_NUM_THREADS || '', 10) || 2);

async function ensureSpecter2File(name: string): Promise<string> {
  const dest = path.join(SPECTER2_DIR, name);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return dest;
  fs.mkdirSync(SPECTER2_DIR, { recursive: true });
  console.log(`[similarity] downloading ${name} ...`);
  const res = await fetch(`${SPECTER2_URL}/${name}`);
  if (!res.ok || !res.body) throw new Error(`Download failed for ${name}: HTTP ${res.status}`);
  const tmp = `${dest}.part`;
  await streamPipeline(Readable.fromWeb(res.body as any), fs.createWriteStream(tmp));
  fs.renameSync(tmp, dest);
  return dest;
}

async function initSpecter2(): Promise<void> {
  // The .onnx graph references its external .data file by name, resolved
  // relative to the model path — both must sit in the same directory.
  const modelPath = await ensureSpecter2File(SPECTER2_FILES[0]);
  await ensureSpecter2File(SPECTER2_FILES[1]);
  const [session, tokenizer] = await Promise.all([
    ort.InferenceSession.create(modelPath, {
      intraOpNumThreads: SIMILARITY_NUM_THREADS,
      interOpNumThreads: 1,
      executionMode: 'sequential',
    }),
    AutoTokenizer.from_pretrained(SPECTER2_TOKENIZER),
  ]);
  ortSession = session;
  specter2Tokenizer = tokenizer;
}

async function embedSpecter2(texts: string[]): Promise<number[][]> {
  if (!ortSession || !specter2Tokenizer) throw new Error('SPECTER2 not initialized');
  const enc = await specter2Tokenizer(texts, { padding: true, truncation: true, max_length: 512 });
  const out = await ortSession.run({
    input_ids: new ort.Tensor('int64', enc.input_ids.data, enc.input_ids.dims),
    attention_mask: new ort.Tensor('int64', enc.attention_mask.data, enc.attention_mask.dims),
  });
  const tensor = out['embeddings'] ?? out[ortSession.outputNames[0]];
  const [n, dim] = tensor.dims as number[];
  const data = tensor.data as Float32Array;
  const result: number[][] = [];
  for (let i = 0; i < n; i++) {
    const v = Array.from(data.subarray(i * dim, (i + 1) * dim));
    let norm = 0;
    for (const x of v) norm += x * x;
    norm = Math.sqrt(norm) || 1;
    result.push(v.map(x => x / norm));
  }
  return result;
}

// all-MiniLM fallback (transformers.js, mean-pooled + normalized).
const MINILM_MODEL = 'Xenova/all-MiniLM-L6-v2';
let miniLmPipeline: Awaited<ReturnType<typeof pipeline>> | null = null;

async function embedMiniLm(texts: string[]): Promise<number[][]> {
  if (!miniLmPipeline) miniLmPipeline = await pipeline('feature-extraction', MINILM_MODEL);
  const output = await miniLmPipeline(texts, { pooling: 'mean', normalize: true });
  return (output as any).tolist() as number[][];
}

let backendInit: Promise<EmbeddingBackend> | null = null;

// Resolve (once, memoized) the embedding backend: SPECTER2 if it loads, else
// all-MiniLM. The chosen `version` is the cache key for every embedding.
function getBackend(): Promise<EmbeddingBackend> {
  if (!backendInit) {
    backendInit = (async () => {
      try {
        await initSpecter2();
        console.log('[similarity] embedding backend: SPECTER2-proximity (onnxruntime-node, CPU)');
        return { version: 'specter2-proximity-v1', embed: embedSpecter2 };
      } catch (err) {
        console.error('[similarity] SPECTER2 unavailable; falling back to all-MiniLM:', err);
        return { version: 'all-MiniLM-L6-v2', embed: embedMiniLm };
      }
    })();
  }
  return backendInit;
}

// Embed raw "title + abstract" strings with the active backend. Exposed for the
// model verification script (scripts/verify-specter2.ts).
export async function embedTexts(texts: string[]): Promise<{ version: string; embeddings: number[][] }> {
  const { version, embed } = await getBackend();
  return { version, embeddings: await embed(texts) };
}

async function getOrComputeEmbeddings(
  papers: { arxiv_id: string; title: string; summary: string }[]
): Promise<number[][]> {
  if (papers.length === 0) return [];

  const { version, embed } = await getBackend();
  const arxivIds = papers.map(p => p.arxiv_id);
  const cached = db.getEmbeddings(arxivIds, version);
  const cachedMap = new Map(cached.map(c => [c.arxiv_id, JSON.parse(c.embedding) as number[]]));

  const missing = papers.filter(p => !cachedMap.has(p.arxiv_id));

  if (missing.length > 0) {
    const texts = missing.map(p => p.title + ' ' + p.summary);
    const newEmbeddings = await embed(texts);
    for (let i = 0; i < missing.length; i++) {
      cachedMap.set(missing[i].arxiv_id, newEmbeddings[i]);
      db.saveEmbedding(missing[i].arxiv_id, JSON.stringify(newEmbeddings[i]), version);
    }
  }

  return arxivIds.map(id => cachedMap.get(id)!);
}

// Vector math, the nearest-member / cohesion / matching logic, the exclusivity
// margin, and the text/author corroboration all live in similarity-core.ts
// (pure, model-independent, unit-verifiable). TF-IDF is no longer a fallback
// scorer; its tokenizer is reused there only to source distinctive terms.

// --- Exported interfaces ---

export interface WorldlineProfile {
  worldlineId: number;
  worldlineName: string;
  worldlineColor: string;
  papers: { arxiv_id: string; title: string; summary: string; authors?: string[] }[];
}

export interface SimilarityMatch {
  worldlineId: number;
  worldlineName: string;
  worldlineColor: string;
  score: number;
  // Diagnostics for the flag log / UI tooltip (Phase 3).
  runnerUpScore?: number | null;
  corroborationKind?: 'author' | 'terms';
}

export interface PaperSimilarityResult {
  paperId: string;
  matches: SimilarityMatch[];
}

export interface SimilarityOptions {
  // Bar used when a thread's own cohesion is undefined (fewer than 2 members).
  fallbackThreshold: number;
  // Percentile of members' nearest-sibling cosines used as the cohesion bar.
  // Default 0.75; higher = stricter per-thread bar. (Was 0.5/median, but with
  // SPECTER2's high, clustered similarities the median admits same-subtopic
  // papers; 0.75 reflects the thread's tighter internal links.)
  cohesionPercentile?: number;
  // Self-margin: the winning thread's nearest-member score must exceed its own
  // cohesion bar by at least this much — "more tightly bound to the thread than
  // the thread is to itself." Default 0.02. This is the gate that actually bites
  // in the common single-candidate case (a paper near exactly one thread), which
  // the runner-up margin below cannot catch.
  selfMargin?: number;
  // Exclusivity margin delta: when a paper clears more than one thread, the
  // winner must beat the runner-up by at least this much. Default 0.02.
  margin?: number;
  // Minimum shared distinctive terms for term-based corroboration. Default 3.
  k?: number;
  // Max corpus document-frequency fraction for a term to count as distinctive.
  // Default 0.15 (tighter than before, so generic subtopic vocabulary can't
  // stand in as corroboration).
  distinctiveDfMax?: number;
}

// --- Main exported function ---

interface ScoredWorldline extends WorldlineScoreInput {
  profile: WorldlineProfile;
  threadTerms: Set<string>;
  threadAuthors: Set<string>;
}

export async function computeWorldlineSimilarity(
  browsePapers: { id: string; title: string; summary: string; authors?: string[] }[],
  worldlineProfiles: WorldlineProfile[],
  options: SimilarityOptions
): Promise<PaperSimilarityResult[]> {
  if (browsePapers.length === 0 || worldlineProfiles.length === 0) return [];

  const percentile = options.cohesionPercentile ?? 0.75;
  const fallbackThreshold = options.fallbackThreshold;
  const selfMargin = options.selfMargin ?? 0.02;
  const margin = options.margin ?? 0.02;
  const k = options.k ?? 3;
  const distinctiveDfMax = options.distinctiveDfMax ?? 0.15;

  // No weaker fallback scorer: if embeddings can't be produced, the catch below
  // returns [] (flag nothing) rather than scoring by a worse method.
  try {
    // Precompute, once per request, each thread's member embeddings, its
    // self-cohesion bar, and its term/author sets for corroboration. Cohesion
    // is recomputed from cached member embeddings every request (cheap, O(n^2)
    // with small n); the route's result cache is already invalidated on
    // membership change. Threads with <2 members fall back to fallbackThreshold.
    const scored: ScoredWorldline[] = [];
    const memberDocs = new Map<string, Set<string>>(); // arxiv_id -> term set (deduped for the corpus)
    for (const profile of worldlineProfiles) {
      const memberEmbs = await getOrComputeEmbeddings(profile.papers);
      if (memberEmbs.length === 0) continue;
      const cohesion = worldlineCohesion(memberEmbs, percentile);
      // Effective gate = the thread's own cohesion bar plus the self-margin, so
      // a paper must be *more* tightly bound to the thread than the thread is to
      // itself. (<2-member threads have no cohesion → fallback bar, no margin.)
      const cohesionBar = Number.isNaN(cohesion) ? fallbackThreshold : cohesion + selfMargin;
      const threadTerms = new Set<string>();
      const threadAuthors = new Set<string>();
      for (const p of profile.papers) {
        const terms = new Set(tokenize(`${p.title} ${p.title} ${p.summary}`));
        memberDocs.set(p.arxiv_id, terms);
        for (const t of terms) threadTerms.add(t);
        for (const a of p.authors ?? []) threadAuthors.add(normalizeAuthor(a));
      }
      scored.push({ memberEmbs, cohesionBar, threadTerms, threadAuthors, profile });
    }
    if (scored.length === 0) return [];

    // Browse paper embeddings (cached in paper_embeddings keyed by arxiv_id —
    // the same paper recurs across categories/days) and term sets.
    const browseEmbeddings = await getOrComputeEmbeddings(
      browsePapers.map(p => ({ arxiv_id: p.id, title: p.title, summary: p.summary }))
    );
    const browseTerms = browsePapers.map(p => new Set(tokenize(`${p.title} ${p.title} ${p.summary}`)));

    // Corpus document frequencies over deduped thread members + browse papers,
    // used to decide which shared terms are distinctive enough to corroborate.
    const { df, n: corpusSize } = documentFrequencies([...memberDocs.values(), ...browseTerms]);

    const results: PaperSimilarityResult[] = [];
    for (let i = 0; i < browsePapers.length; i++) {
      // nearest-member + cohesion -> exclusivity margin -> corroboration.
      const ranked = matchWorldlines(browseEmbeddings[i], scored);
      const winner = applyExclusivityMargin(ranked, margin);
      if (!winner) continue;

      const w = scored[winner.index];
      const corr = corroborate(
        {
          paperTerms: browseTerms[i],
          paperAuthors: (browsePapers[i].authors ?? []).map(normalizeAuthor),
          threadTerms: w.threadTerms,
          threadAuthors: w.threadAuthors,
          df,
          corpusSize,
        },
        { k, distinctiveDfMax }
      );
      if (!corr.ok) continue;

      const runnerUpScore = ranked.length > 1 ? Math.round(ranked[1].score * 1000) / 1000 : null;
      results.push({
        paperId: browsePapers[i].id,
        matches: [
          {
            worldlineId: w.profile.worldlineId,
            worldlineName: w.profile.worldlineName,
            worldlineColor: w.profile.worldlineColor,
            score: Math.round(winner.score * 1000) / 1000,
            runnerUpScore,
            corroborationKind: corr.kind === 'author' ? 'author' : 'terms',
          },
        ],
      });
    }

    return results;
  } catch (error) {
    console.error('Worldline similarity failed:', error);
    return [];
  }
}
