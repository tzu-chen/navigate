// Phase 4 model gate: verify the active embedding backend actually captures
// scientific relatedness — a related paper pair must score clearly above an
// unrelated one — and that SPECTER2 (not the fallback) is the backend in use.
//
// Run:  npm run verify:specter2 --prefix server
// First run downloads the SPECTER2 ONNX (~441MB) into DATA_DIR/model-cache.
// Exits non-zero if the check fails.

import { embedTexts } from '../src/services/similarity';

const ta = (t: string, a: string) => t + ' ' + a;
const texts = [
  ta('Attention Is All You Need',
    'The dominant sequence transduction models are based on complex recurrent or convolutional neural networks. We propose the Transformer, a network architecture based solely on attention mechanisms, dispensing with recurrence and convolutions entirely.'),
  ta('BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding',
    'We introduce a new language representation model which pretrains deep bidirectional representations from unlabeled text by jointly conditioning on both left and right context using a transformer encoder.'),
  ta('Genome-wide association study of flowering time in Arabidopsis thaliana',
    'We map quantitative trait loci controlling photoperiod response and vernalization in natural plant accessions, identifying allelic variation at FRIGIDA and FLC affecting flowering onset.'),
];

// Embeddings are L2-normalized, so cosine == dot product.
function cos(a: number[], b: number[]): number {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += a[i] * b[i];
  return d;
}

let failed = 0;
const ok = (c: boolean, m: string) => { if (!c) { failed++; console.error('  ✗ ' + m); } };

(async () => {
  console.log('Phase 4 — SPECTER2 embedding backend\n');
  const { version, embeddings } = await embedTexts(texts);
  console.log(`  backend version: ${version}`);

  ok(version === 'specter2-proximity-v1', 'active backend is SPECTER2-proximity (not the all-MiniLM fallback)');
  ok(embeddings.length === 3 && embeddings[0].length === 768, `embeddings are 3 x 768 (got ${embeddings.length} x ${embeddings[0]?.length})`);

  const relAB = cos(embeddings[0], embeddings[1]);   // Transformer NLP vs BERT NLP
  const unrelAC = cos(embeddings[0], embeddings[2]);  // NLP vs plant genomics
  const unrelBC = cos(embeddings[1], embeddings[2]);
  console.log(`  cos(A,B) related   = ${relAB.toFixed(4)}`);
  console.log(`  cos(A,C) unrelated = ${unrelAC.toFixed(4)}`);
  console.log(`  cos(B,C) unrelated = ${unrelBC.toFixed(4)}`);

  ok(relAB > unrelAC + 0.05, 'related pair scores clearly above unrelated (A,B vs A,C)');
  ok(relAB > unrelBC + 0.05, 'related pair scores clearly above unrelated (A,B vs B,C)');
  ok(relAB > 0.5, 'related pair has a meaningfully high absolute score');

  console.log(failed === 0 ? '\nPASS' : `\nFAIL (${failed})`);
  process.exit(failed > 0 ? 1 : 0);
})();
