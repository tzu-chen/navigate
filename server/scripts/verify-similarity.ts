// Verification harness for the worldline-similarity overhaul.
//
// Runs unit-level checks against the pure decision core (similarity-core.ts),
// which needs no embedding model and no database. Each phase appends its checks
// here so `npm run verify:similarity` verifies everything implemented so far.
//
// Run:  npm run verify:similarity --prefix server
// Exits non-zero if any check fails.

import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  cosineSimilarity,
  nearestMemberScore,
  quantile,
  worldlineCohesion,
  matchWorldlines,
  applyExclusivityMargin,
  corroborate,
  documentFrequencies,
  tokenize,
  normalizeAuthor,
  WorldlineScoreInput,
} from '../src/services/similarity-core';

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

function approx(actual: number, expected: number, msg: string, eps = 1e-9) {
  ok(Math.abs(actual - expected) < eps, `${msg} (got ${actual}, want ${expected})`);
}

// 2D unit vector at the given angle in degrees. The cosine between two such
// vectors is exactly cos(angle difference), so every expectation below is
// hand-derivable from trig — an independent check, not a re-run of the code.
function vec(deg: number): number[] {
  const r = (deg * Math.PI) / 180;
  return [Math.cos(r), Math.sin(r)];
}
const cosDeg = (d: number) => Math.cos((d * Math.PI) / 180);

console.log('Phase 1 — nearest-member scoring + per-thread cohesion\n');

// --- cosineSimilarity ---
approx(cosineSimilarity([1, 0], [1, 0]), 1, 'cosine of identical vectors is 1');
approx(cosineSimilarity([1, 0], [0, 1]), 0, 'cosine of orthogonal vectors is 0');
approx(cosineSimilarity([1, 0], [-1, 0]), -1, 'cosine of opposite vectors is -1');
ok(cosineSimilarity([0, 0], [1, 0]) === 0, 'cosine with a zero vector is 0 (no NaN)');
approx(cosineSimilarity([1, 0], vec(60)), 0.5, 'cosine at 60° is 0.5');

// --- nearestMemberScore ---
approx(
  nearestMemberScore(vec(30), [vec(0), vec(25), vec(80)]),
  cosDeg(5),
  'nearest-member picks the closest member (25° vs a 30° paper → cos5°)'
);
ok(nearestMemberScore(vec(0), []) === 0, 'nearest-member of an empty thread is 0');

// --- quantile / median ---
approx(quantile([3, 1, 2], 0.5), 2, 'median of {1,2,3} is 2');
approx(quantile([1, 2, 3, 4], 0.5), 2.5, 'median of {1,2,3,4} is 2.5');
approx(quantile([10, 20, 30, 40], 0.75), 32.5, '75th percentile interpolates to 32.5');
approx(quantile([7], 0.5), 7, 'quantile of a single value is that value');
ok(Number.isNaN(quantile([], 0.5)), 'quantile of empty set is NaN');

// --- worldlineCohesion (median nearest-sibling cosine) ---
ok(Number.isNaN(worldlineCohesion([vec(0)])), 'cohesion of a 1-member thread is NaN');
// Members at 0°,10°,80°: nearest-sibling cosines are cos10°, cos10°, cos70°;
// median = cos10°.
approx(
  worldlineCohesion([vec(0), vec(10), vec(80)]),
  cosDeg(10),
  'cohesion (median nearest-sibling) of {0°,10°,80°} is cos10°'
);
// Same set, but the min (0th pct) is the loner's cos70°, the max is cos10°.
approx(worldlineCohesion([vec(0), vec(10), vec(80)], 0), cosDeg(70), 'cohesion at p=0 is the min nearest-sibling (cos70°)');
approx(worldlineCohesion([vec(0), vec(10), vec(80)], 1), cosDeg(10), 'cohesion at p=1 is the max nearest-sibling (cos10°)');

// --- matchWorldlines: per-thread self-calibration ---
// Thread A is tight (0°,5° → cohesion cos5°≈0.996); Thread B is loose
// (0°,60° → cohesion cos60°=0.5). A 30° browse paper is a mediocre fit for A
// (nearest = cos25°≈0.906 < bar) but clears loose B's bar.
const threadA: WorldlineScoreInput = { memberEmbs: [vec(0), vec(5)], cohesionBar: cosDeg(5) };
const threadB: WorldlineScoreInput = { memberEmbs: [vec(0), vec(60)], cohesionBar: cosDeg(60) };
const m1 = matchWorldlines(vec(30), [threadA, threadB]);
ok(m1.length === 1 && m1[0].index === 1, 'tight thread rejects a mediocre match; loose thread accepts it');
approx(m1[0].score, cosDeg(30), 'accepted match scores the nearest-member cosine (cos30°)', 1e-9);

// A paper genuinely close to a member of the tight thread clears its high bar.
const m2 = matchWorldlines(vec(2), [threadA, threadB]);
ok(m2.length === 2, 'a 2° paper clears BOTH the tight and loose bars');
ok(m2[0].score >= m2[1].score, 'matches are sorted by score descending');
ok(m2[0].index === 0, 'the tight thread (nearer member) ranks first for the 2° paper');

// Empty threads are skipped, not crashed on.
const m3 = matchWorldlines(vec(0), [{ memberEmbs: [], cohesionBar: 0.5 }]);
ok(m3.length === 0, 'threads with no members are skipped');

// --- nearest-member vs centroid: the core rationale ---
// Thread spans 0° and 90°; its centroid points at 45°. A paper at 2° is nearly
// identical to member-0 but the centroid dilutes that to cos43°. Nearest-member
// surfaces the real proximity a centroid would hide.
const spread = [vec(0), vec(90)];
const centroid = [0.5 * (1 + 0), 0.5 * (0 + 1)]; // mean of the two unit vecs
const nm = nearestMemberScore(vec(2), spread);
const cc = cosineSimilarity(vec(2), centroid);
approx(nm, cosDeg(2), 'nearest-member of a 2° paper to {0°,90°} is cos2°');
approx(cc, cosDeg(43), 'centroid cosine of the same paper is only cos43°');
ok(nm > cc + 0.25, 'nearest-member >> centroid for a paper close to one member');

console.log('\nPhase 2 — exclusivity margin + corroboration\n');

// --- applyExclusivityMargin ---
ok(applyExclusivityMargin([], 0.02) === null, 'no candidates → no winner');
const single = applyExclusivityMargin([{ index: 3, score: 0.9 }], 0.02);
ok(single !== null && single.index === 3, 'a single candidate wins automatically');
const clear = applyExclusivityMargin([{ index: 0, score: 0.95 }, { index: 1, score: 0.9 }], 0.02);
ok(clear !== null && clear.index === 0, 'top wins when it beats runner-up by > δ');
ok(applyExclusivityMargin([{ index: 0, score: 0.95 }, { index: 1, score: 0.94 }], 0.02) === null,
  'no winner when the field is ambiguous (gap < δ)');
const tie = applyExclusivityMargin([{ index: 0, score: 0.92 }, { index: 1, score: 0.9 }], 0.02);
ok(tie !== null && tie.index === 0, 'gap exactly equal to δ passes (>=)');

// --- tokenize ---
ok(JSON.stringify(tokenize('The Neural Network!')) === JSON.stringify(['neural', 'network']),
  'tokenize lowercases, strips punctuation, drops the stop word "the"');
ok(tokenize('We present a new method').length === 0,
  'tokenize drops generic-ML/academic stop words (present, new, method)');
ok(tokenize('ab cd ef').length === 0, 'tokenize drops tokens of length <= 2');

// --- normalizeAuthor ---
ok(normalizeAuthor('  John   Smith ') === 'john smith', 'normalizeAuthor lowercases and collapses whitespace');

// --- documentFrequencies ---
const dfRes = documentFrequencies([new Set(['a', 'b']), new Set(['b', 'c']), new Set(['b'])]);
ok(dfRes.n === 3, 'document count is correct');
ok(dfRes.df.get('b') === 3 && dfRes.df.get('a') === 1 && dfRes.df.get('c') === 1, 'per-term document frequencies are correct');

// --- corroborate ---
// Corpus of 10 docs: "wavelet" is rare (0.1), "spectral" 0.2, "diffusion" 0.3,
// "transformer" generic (0.8). With distinctiveDfMax=0.25 only wavelet/spectral
// count as distinctive.
const df = new Map<string, number>([
  ['wavelet', 1],
  ['spectral', 2],
  ['diffusion', 3],
  ['transformer', 8],
]);
const CS = 10;
const opts = { k: 2, distinctiveDfMax: 0.25 };

const cAuthor = corroborate(
  { paperTerms: new Set(), paperAuthors: ['jane doe'], threadTerms: new Set(), threadAuthors: new Set(['jane doe', 'bob']), df, corpusSize: CS },
  opts
);
ok(cAuthor.ok && cAuthor.kind === 'author' && cAuthor.sharedAuthor === 'jane doe', 'a shared author corroborates (kind=author)');

const cTerms = corroborate(
  { paperTerms: new Set(['wavelet', 'spectral', 'transformer']), paperAuthors: [], threadTerms: new Set(['wavelet', 'spectral', 'foo']), threadAuthors: new Set(), df, corpusSize: CS },
  opts
);
ok(cTerms.ok && cTerms.kind === 'terms', '>= k shared distinctive terms corroborate (kind=terms)');
ok(cTerms.distinctiveTerms.sort().join(',') === 'spectral,wavelet', 'only the distinctive shared terms are reported');

const cGeneric = corroborate(
  { paperTerms: new Set(['wavelet', 'transformer', 'diffusion']), paperAuthors: [], threadTerms: new Set(['wavelet', 'transformer', 'diffusion']), threadAuthors: new Set(), df, corpusSize: CS },
  opts
);
ok(!cGeneric.ok && cGeneric.kind === 'none', 'one distinctive + generic overlap is NOT enough at k=2');
ok(cGeneric.distinctiveTerms.join(',') === 'wavelet', 'generic high-DF terms are excluded from distinctiveness');

const cK1 = corroborate(
  { paperTerms: new Set(['wavelet', 'transformer']), paperAuthors: [], threadTerms: new Set(['wavelet', 'transformer']), threadAuthors: new Set(), df, corpusSize: CS },
  { k: 1, distinctiveDfMax: 0.25 }
);
ok(cK1.ok && cK1.kind === 'terms', 'k=1 accepts a single distinctive shared term');

const cAuthorWins = corroborate(
  { paperTerms: new Set(['wavelet', 'spectral']), paperAuthors: ['amy lin'], threadTerms: new Set(['wavelet', 'spectral']), threadAuthors: new Set(['amy lin']), df, corpusSize: CS },
  opts
);
ok(cAuthorWins.kind === 'author', 'author overlap is reported even when terms would also qualify');

// Phase 3 touches the DB layer, so it runs against an isolated temporary
// database (SUITE_DATA_ROOT pointed at a temp dir, then a dynamic import of the
// database module). This never touches real data.
(async () => {
  console.log('\nPhase 3 — flag logging + accept/reject capture\n');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-verify-'));
  process.env.SUITE_DATA_ROOT = tmp;
  const db = await import('../src/services/database');
  db.initializeDatabase();

  // Empty table must aggregate to zeros, not NULLs (SQLite SUM-of-no-rows trap).
  const empty = db.getFlagStats();
  ok(empty.overall.total === 0 && empty.overall.accepted === 0 && empty.overall.rejected === 0 && empty.overall.pending === 0,
    'flag stats on an empty table are all zeros (not null)');
  ok(empty.overall.acceptance_rate === null, 'acceptance rate is null when nothing is decided');

  const wlA = Number(db.createWorldline('thread-a', '#111').lastInsertRowid);
  const wlB = Number(db.createWorldline('thread-b', '#222').lastInsertRowid);

  // Log flags. The second insert duplicates (2401.0001, wlA) and must be ignored.
  db.logFlag({ arxiv_id: '2401.0001', worldline_id: wlA, score: 0.95, runner_up_score: 0.8, margin: 0.02, corroboration_kind: 'terms', category: 'cs.AI' });
  db.logFlag({ arxiv_id: '2401.0001', worldline_id: wlA, score: 0.91, runner_up_score: 0.7, margin: 0.02, corroboration_kind: 'author', category: 'cs.AI' });
  db.logFlag({ arxiv_id: '2401.0002', worldline_id: wlA, score: 0.93, runner_up_score: null, margin: 0.02, corroboration_kind: 'author', category: 'cs.AI' });
  db.logFlag({ arxiv_id: '2401.0003', worldline_id: wlB, score: 0.9, runner_up_score: 0.85, margin: 0.02, corroboration_kind: 'terms', category: 'math.PR' });

  const flags = db.getFlags() as any[];
  ok(flags.length === 3, `dedup: 3 distinct flags logged (got ${flags.length})`);
  const f1 = flags.find(f => f.arxiv_id === '2401.0001' && f.worldline_id === wlA);
  ok(!!f1 && f1.score === 0.95 && f1.corroboration_kind === 'terms', 'first-flag snapshot is preserved on duplicate insert');
  ok(!!f1 && f1.accepted === null, 'a new flag is pending (accepted = NULL)');

  // accept-on-assign, dismiss-on-reject, and their precedence rules.
  db.markFlagAccepted('2401.0001', wlA);    // assign
  db.markFlagDismissed('2401.0002', wlA);   // dismiss a pending flag
  db.markFlagDismissed('2401.0001', wlA);   // dismiss must NOT override an accept
  db.markFlagDismissed('2401.0003', wlB);   // dismiss first...
  db.markFlagAccepted('2401.0003', wlB);    // ...then assign — accept wins

  const after = db.getFlags() as any[];
  const g = (a: string) => after.find(f => f.arxiv_id === a);
  ok(g('2401.0001').accepted === 1, 'assign records accepted = 1');
  ok(g('2401.0002').accepted === 0, 'dismiss records accepted = 0 on a pending flag');
  ok(g('2401.0001').accepted === 1, 'dismiss does not override an accept');
  ok(g('2401.0003').accepted === 1, 'accept wins over a prior dismiss');

  const stats = db.getFlagStats();
  ok(stats.overall.total === 3, `stats total = 3 (got ${stats.overall.total})`);
  ok(stats.overall.accepted === 2 && stats.overall.rejected === 1 && stats.overall.pending === 0, 'overall accepted/rejected/pending counts');
  approx(stats.overall.acceptance_rate ?? -1, 2 / 3, 'overall acceptance rate = accepted/(accepted+rejected) = 2/3');
  const cAI = stats.byCategory.find(c => c.category === 'cs.AI');
  ok(!!cAI && cAI.total === 2 && cAI.accepted === 1 && cAI.rejected === 1, 'per-category cs.AI counts (1 accept, 1 reject)');
  const cPR = stats.byCategory.find(c => c.category === 'math.PR');
  ok(!!cPR && cPR.accepted === 1 && cPR.acceptance_rate === 1, 'per-category math.PR acceptance rate = 1');

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
