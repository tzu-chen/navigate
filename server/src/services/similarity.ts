// SPECTER-based semantic similarity for matching browse papers to worldlines
// Falls back to TF-IDF cosine similarity if the SPECTER model fails to load

import { pipeline } from '@huggingface/transformers';
import * as db from './database';

const MODEL_NAME = 'Xenova/all-MiniLM-L6-v2';
const MODEL_VERSION = 'all-MiniLM-L6-v2';

// --- SPECTER model management ---

let extractorPipeline: Awaited<ReturnType<typeof pipeline>> | null = null;
let pipelineInitPromise: Promise<Awaited<ReturnType<typeof pipeline>>> | null = null;
let specterAvailable = true;

async function getExtractor() {
  if (extractorPipeline) return extractorPipeline;
  if (pipelineInitPromise) return pipelineInitPromise;
  pipelineInitPromise = pipeline('feature-extraction', MODEL_NAME).then(pipe => {
    extractorPipeline = pipe;
    console.log('SPECTER model loaded successfully');
    return pipe;
  }).catch(err => {
    console.error('Failed to load SPECTER model, falling back to TF-IDF:', err);
    specterAvailable = false;
    pipelineInitPromise = null;
    throw err;
  });
  return pipelineInitPromise;
}

// --- Embedding computation ---

async function computeEmbeddings(texts: string[]): Promise<number[][]> {
  const extractor = await getExtractor();
  const output = await extractor(texts, { pooling: 'mean', normalize: true });
  // The output is a Tensor; cast to access tolist()
  return (output as any).tolist() as number[][];
}

async function getOrComputeEmbeddings(
  papers: { arxiv_id: string; title: string; summary: string }[]
): Promise<number[][]> {
  if (papers.length === 0) return [];

  const arxivIds = papers.map(p => p.arxiv_id);
  const cached = db.getEmbeddings(arxivIds, MODEL_VERSION);
  const cachedMap = new Map(cached.map(c => [c.arxiv_id, JSON.parse(c.embedding) as number[]]));

  const missing = papers.filter(p => !cachedMap.has(p.arxiv_id));

  if (missing.length > 0) {
    const texts = missing.map(p => p.title + ' ' + p.summary);
    const newEmbeddings = await computeEmbeddings(texts);
    for (let i = 0; i < missing.length; i++) {
      cachedMap.set(missing[i].arxiv_id, newEmbeddings[i]);
      db.saveEmbedding(missing[i].arxiv_id, JSON.stringify(newEmbeddings[i]), MODEL_VERSION);
    }
  }

  return arxivIds.map(id => cachedMap.get(id)!);
}

function cosineSimilarityVec(a: number[], b: number[]): number {
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

function meanEmbedding(embeddings: number[][]): number[] {
  if (embeddings.length === 0) return [];
  const dim = embeddings[0].length;
  const mean = new Array(dim).fill(0);
  for (const emb of embeddings) {
    for (let i = 0; i < dim; i++) {
      mean[i] += emb[i];
    }
  }
  const n = embeddings.length;
  for (let i = 0; i < dim; i++) {
    mean[i] /= n;
  }
  return mean;
}

// --- TF-IDF fallback (original implementation) ---

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

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 2 && !STOP_WORDS.has(t));
}

function computeTermFrequency(tokens: string[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const token of tokens) {
    tf.set(token, (tf.get(token) || 0) + 1);
  }
  const len = tokens.length;
  if (len > 0) {
    for (const [term, count] of tf) {
      tf.set(term, count / len);
    }
  }
  return tf;
}

function computeIDF(documents: Map<string, number>[], vocabulary: Set<string>): Map<string, number> {
  const idf = new Map<string, number>();
  const N = documents.length;
  for (const term of vocabulary) {
    let df = 0;
    for (const doc of documents) {
      if (doc.has(term)) df++;
    }
    idf.set(term, Math.log((N + 1) / (df + 1)) + 1);
  }
  return idf;
}

function tfidfCosineSimilarity(
  vec1: Map<string, number>,
  vec2: Map<string, number>,
  idf: Map<string, number>
): number {
  let dotProduct = 0;
  let norm1 = 0;
  let norm2 = 0;
  const terms = new Set([...vec1.keys(), ...vec2.keys()]);
  for (const term of terms) {
    const idfVal = idf.get(term) || 1;
    const v1 = (vec1.get(term) || 0) * idfVal;
    const v2 = (vec2.get(term) || 0) * idfVal;
    dotProduct += v1 * v2;
    norm1 += v1 * v1;
    norm2 += v2 * v2;
  }
  if (norm1 === 0 || norm2 === 0) return 0;
  return dotProduct / (Math.sqrt(norm1) * Math.sqrt(norm2));
}

function computeWorldlineSimilarityTFIDF(
  browsePapers: { id: string; title: string; summary: string }[],
  worldlineProfiles: WorldlineProfile[],
  threshold: number
): PaperSimilarityResult[] {
  if (browsePapers.length === 0 || worldlineProfiles.length === 0) return [];

  const vocabulary = new Set<string>();
  const browseDocTFs: Map<string, number>[] = [];
  const worldlineDocTFs: Map<string, number>[] = [];

  for (const paper of browsePapers) {
    const tokens = tokenize(`${paper.title} ${paper.title} ${paper.summary}`);
    const tf = computeTermFrequency(tokens);
    browseDocTFs.push(tf);
    for (const term of tf.keys()) vocabulary.add(term);
  }

  for (const profile of worldlineProfiles) {
    const combinedText = profile.papers
      .map(p => `${p.title} ${p.title} ${p.summary}`)
      .join(' ');
    const tokens = tokenize(combinedText);
    const tf = computeTermFrequency(tokens);
    worldlineDocTFs.push(tf);
    for (const term of tf.keys()) vocabulary.add(term);
  }

  const allDocs = [...browseDocTFs, ...worldlineDocTFs];
  const idf = computeIDF(allDocs, vocabulary);

  const results: PaperSimilarityResult[] = [];
  for (let i = 0; i < browsePapers.length; i++) {
    const matches: SimilarityMatch[] = [];
    for (let j = 0; j < worldlineProfiles.length; j++) {
      const score = tfidfCosineSimilarity(browseDocTFs[i], worldlineDocTFs[j], idf);
      if (score >= threshold) {
        matches.push({
          worldlineId: worldlineProfiles[j].worldlineId,
          worldlineName: worldlineProfiles[j].worldlineName,
          worldlineColor: worldlineProfiles[j].worldlineColor,
          score: Math.round(score * 1000) / 1000,
        });
      }
    }
    if (matches.length > 0) {
      matches.sort((a, b) => b.score - a.score);
      results.push({ paperId: browsePapers[i].id, matches });
    }
  }

  return results;
}

// --- Exported interfaces ---

export interface WorldlineProfile {
  worldlineId: number;
  worldlineName: string;
  worldlineColor: string;
  papers: { arxiv_id: string; title: string; summary: string }[];
}

export interface SimilarityMatch {
  worldlineId: number;
  worldlineName: string;
  worldlineColor: string;
  score: number;
}

export interface PaperSimilarityResult {
  paperId: string;
  matches: SimilarityMatch[];
}

// --- Main exported function ---

export async function computeWorldlineSimilarity(
  browsePapers: { id: string; title: string; summary: string }[],
  worldlineProfiles: WorldlineProfile[],
  threshold: number
): Promise<PaperSimilarityResult[]> {
  if (browsePapers.length === 0 || worldlineProfiles.length === 0) return [];

  // Fall back to TF-IDF if SPECTER is unavailable
  if (!specterAvailable) {
    return computeWorldlineSimilarityTFIDF(browsePapers, worldlineProfiles, threshold);
  }

  try {
    // Compute worldline mean embeddings from cached paper embeddings
    const worldlineEmbeddings: (number[] | null)[] = [];
    for (const profile of worldlineProfiles) {
      const paperEmbeddings = await getOrComputeEmbeddings(profile.papers);
      worldlineEmbeddings.push(paperEmbeddings.length > 0 ? meanEmbedding(paperEmbeddings) : null);
    }

    // Compute browse paper embeddings on-the-fly (not cached)
    const browseTexts = browsePapers.map(p => p.title + ' ' + p.summary);
    const browseEmbeddings = await computeEmbeddings(browseTexts);

    // Compute similarities
    const results: PaperSimilarityResult[] = [];
    for (let i = 0; i < browsePapers.length; i++) {
      const matches: SimilarityMatch[] = [];
      for (let j = 0; j < worldlineProfiles.length; j++) {
        const wlEmb = worldlineEmbeddings[j];
        if (!wlEmb) continue;
        const score = cosineSimilarityVec(browseEmbeddings[i], wlEmb);
        if (score >= threshold) {
          matches.push({
            worldlineId: worldlineProfiles[j].worldlineId,
            worldlineName: worldlineProfiles[j].worldlineName,
            worldlineColor: worldlineProfiles[j].worldlineColor,
            score: Math.round(score * 1000) / 1000,
          });
        }
      }
      if (matches.length > 0) {
        matches.sort((a, b) => b.score - a.score);
        results.push({ paperId: browsePapers[i].id, matches });
      }
    }

    return results;
  } catch (error) {
    console.error('SPECTER similarity failed, falling back to TF-IDF:', error);
    return computeWorldlineSimilarityTFIDF(browsePapers, worldlineProfiles, threshold);
  }
}
