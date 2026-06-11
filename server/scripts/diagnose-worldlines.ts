// Diagnostic for the worldline false-positive complaint. Reads the real DB,
// computes each thread's cohesion from cached SPECTER2 embeddings, and measures
// how often a paper from a DIFFERENT thread would clear a thread's cohesion gate
// (a direct false-positive proxy). Also summarizes the flag log.
//
// Run: npm run diagnose --prefix server   (read-only on the DB)

import * as db from '../src/services/database';
import { worldlineCohesion, nearestMemberScore } from '../src/services/similarity-core';

const MV = 'specter2-proximity-v1';

const worldlines = db.getAllWorldlinesWithPapers().filter(w => w.papers.length > 0);
const embOf = new Map<number, number[][]>(); // worldline id -> member embeddings

for (const wl of worldlines) {
  const ids = wl.papers.map(p => p.arxiv_id);
  const rows = db.getEmbeddings(ids, MV);
  const m = new Map(rows.map(r => [r.arxiv_id, JSON.parse(r.embedding) as number[]]));
  embOf.set(wl.id, ids.map(id => m.get(id)).filter(Boolean) as number[][]);
}

console.log('=== Threads: size, embedded, cohesion (median nearest-sibling) ===');
const cohesion = new Map<number, number>();
for (const wl of worldlines) {
  const embs = embOf.get(wl.id)!;
  const c = worldlineCohesion(embs);
  cohesion.set(wl.id, c);
  console.log(
    `#${wl.id} ${wl.name.padEnd(24)} members=${String(wl.papers.length).padStart(3)} embedded=${String(embs.length).padStart(3)} cohesion=${Number.isNaN(c) ? 'n/a(<2 → fallback 0.82)' : c.toFixed(3)}`
  );
}

console.log('\n=== Cross-thread leakage: of OTHER threads’ papers, what fraction clear this thread’s cohesion gate? ===');
console.log('(high = the cohesion gate alone admits unrelated papers)');
let totalPairs = 0;
let totalClear = 0;
for (const wl of worldlines) {
  const bar = Number.isNaN(cohesion.get(wl.id)!) ? 0.82 : cohesion.get(wl.id)!;
  const myEmbs = embOf.get(wl.id)!;
  if (myEmbs.length === 0) continue;
  let clears = 0;
  let n = 0;
  const scores: number[] = [];
  for (const other of worldlines) {
    if (other.id === wl.id) continue;
    for (const e of embOf.get(other.id)!) {
      const s = nearestMemberScore(e, myEmbs);
      scores.push(s);
      n++;
      if (s >= bar) clears++;
    }
  }
  totalPairs += n;
  totalClear += clears;
  const med = scores.length ? scores.sort((a, b) => a - b)[Math.floor(scores.length / 2)] : NaN;
  console.log(
    `#${wl.id} ${wl.name.padEnd(24)} bar=${bar.toFixed(3)} cross-papers=${String(n).padStart(4)} clear=${String(clears).padStart(4)} (${((100 * clears) / Math.max(1, n)).toFixed(0)}%) medianCrossScore=${Number.isNaN(med) ? 'n/a' : med.toFixed(3)}`
  );
}
console.log(`\nOVERALL cross-thread cohesion-clear rate: ${((100 * totalClear) / Math.max(1, totalPairs)).toFixed(1)}%  (lower is better; this is pre-margin, pre-corroboration)`);

console.log('\n=== Flag log ===');
const stats = db.getFlagStats();
console.log('overall:', stats.overall);
const flags = db.getFlags(2000) as any[];
const byKind: Record<string, number> = {};
for (const f of flags) byKind[f.corroboration_kind] = (byKind[f.corroboration_kind] || 0) + 1;
console.log('total flags:', flags.length, '| by corroboration:', byKind);
const decided = flags.filter(f => f.accepted !== null);
console.log('decided:', decided.length, '| accepted:', decided.filter(f => f.accepted === 1).length, '| rejected:', decided.filter(f => f.accepted === 0).length);
const singleCandidate = flags.filter(f => f.runner_up_score == null).length;
console.log(`single-candidate flags (exclusivity margin is a no-op): ${singleCandidate}/${flags.length}`);

console.log('\n=== Tuning simulation: how many of the 47 logged flags survive stricter settings? ===');
const coh075 = new Map<number, number>();
const coh085 = new Map<number, number>();
for (const wl of worldlines) {
  coh075.set(wl.id, worldlineCohesion(embOf.get(wl.id)!, 0.75));
  coh085.set(wl.id, worldlineCohesion(embOf.get(wl.id)!, 0.85));
}
const barOf = (id: number, m: Map<number, number>) => (Number.isNaN(m.get(id)!) ? 0.82 : m.get(id)!);
const sim = (pred: (f: any) => boolean) => flags.filter(pred).length;
console.log(`  current (median bar, score >= bar):                 ${flags.length}`);
console.log(`  absolute margin: score >= cohesion(0.5) + 0.02:     ${sim(f => f.score >= barOf(f.worldline_id, cohesion) + 0.02)}`);
console.log(`  stricter bar: score >= cohesion(0.85):              ${sim(f => f.score >= barOf(f.worldline_id, coh085))}`);
console.log(`  both: score >= cohesion(0.85) + 0.02:               ${sim(f => f.score >= barOf(f.worldline_id, coh085) + 0.02)}`);
console.log(`  >>> NEW DEFAULTS: score >= cohesion(0.75) + 0.02:   ${sim(f => f.score >= barOf(f.worldline_id, coh075) + 0.02)}  (corroboration k=3/df<=0.15 tightens further, not simulated)`);
console.log(`  require author corroboration (drop term-only):      ${sim(f => f.corroboration_kind === 'author')}`);

console.log('\nsample recent flags (score / runnerUp / margin-gap / kind / worldline):');
for (const f of flags.slice(0, 15)) {
  const gap = f.runner_up_score == null ? 'none' : (f.score - f.runner_up_score).toFixed(3);
  console.log(`  ${f.arxiv_id.padEnd(20)} s=${f.score?.toFixed?.(3)} ru=${f.runner_up_score == null ? 'null' : f.runner_up_score.toFixed(3)} gap=${gap} ${f.corroboration_kind} wl=${f.worldline_id} acc=${f.accepted}`);
}
