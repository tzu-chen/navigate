// Verification harness for the Scout listing-triage service.
//
// Checks everything that does NOT need the Claude API: the scan-identity key
// (the mechanism that stops redundant paid runs), the library fingerprint, the
// run store, and the normalization of model output. Runs against an isolated
// temporary database — it never touches real data and never spends an API call.
//
// Run:  npm run verify:scout --prefix server
// Exits non-zero if any check fails.

import fs from 'fs';
import os from 'os';
import path from 'path';

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

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-verify-'));
  process.env.SUITE_DATA_ROOT = tmp;

  // Imported after SUITE_DATA_ROOT is set: both modules open the DB at load.
  const db = await import('../src/services/database');
  const {
    scanCacheKey,
    normalizeFindings,
    buildLibraryProfile,
    fingerprintLibraryProfile,
    buildCliArgs,
  } = await import('../src/services/scout');
  db.initializeDatabase();

  console.log('Phase 1 — scan identity (the no-redundant-run guarantee)\n');

  const listing = ['2401.0003', '2401.0001', '2401.0002'];
  const key = scanCacheKey('cs.AI', listing);

  ok(key === scanCacheKey('cs.AI', listing), 'the same listing yields the same key');
  ok(
    key === scanCacheKey('cs.AI', ['2401.0001', '2401.0002', '2401.0003']),
    'key is order-insensitive (the listing is a set, not a sequence)'
  );
  ok(
    key !== scanCacheKey('cs.AI', [...listing, '2401.0004']),
    'a newly announced paper changes the key (arXiv updated → rescan)'
  );
  ok(
    key !== scanCacheKey('cs.AI', listing.slice(1)),
    'a removed paper changes the key'
  );
  ok(key !== scanCacheKey('cs.LG', listing), 'category participates in the key');
  ok(key !== scanCacheKey(null, listing), 'an absent category is distinct from a present one');

  console.log('\nPhase 2 — library fingerprint\n');

  const fpEmpty = fingerprintLibraryProfile(buildLibraryProfile());
  ok(fpEmpty === fingerprintLibraryProfile(buildLibraryProfile()), 'fingerprint is stable for an unchanged library');

  db.savePaper({
    arxiv_id: '2301.11111',
    title: 'Spectral methods for graph transformers',
    summary: 'An abstract.',
    authors: JSON.stringify(['A. Author']),
    published: '2023-01-01T00:00:00Z',
    updated: '2023-01-01T00:00:00Z',
    categories: JSON.stringify(['cs.LG']),
    pdf_url: 'https://arxiv.org/pdf/2301.11111',
    abs_url: 'https://arxiv.org/abs/2301.11111',
    doi: undefined,
    journal_ref: undefined,
  });
  const saved = db.getPaperByArxivId('2301.11111') as { id: number };
  const fpAfterSave = fingerprintLibraryProfile(buildLibraryProfile());
  ok(fpAfterSave !== fpEmpty, 'saving a paper changes the fingerprint');

  db.updatePaperTier(saved.id, 0);
  const fpAfterTier = fingerprintLibraryProfile(buildLibraryProfile());
  ok(fpAfterTier !== fpAfterSave, 'rating a paper changes the fingerprint (ratings feed the prompt)');

  const wl = Number(db.createWorldline('spectral-graphs', '#123456').lastInsertRowid);
  db.addWorldlinePaper(wl, saved.id, 0);
  const fpAfterWorldline = fingerprintLibraryProfile(buildLibraryProfile());
  ok(fpAfterWorldline !== fpAfterTier, 'assigning a paper to a worldline changes the fingerprint');

  const profile = buildLibraryProfile();
  ok(profile.worldlines.length === 1 && profile.worldlines[0].name === 'spectral-graphs', 'profile carries the worldline');
  ok(profile.topTier.length === 1, 'profile carries the T0 rating');
  ok(profile.totalSaved === 1, 'profile carries the library size');

  console.log('\nPhase 3 — run store\n');

  ok(db.getScoutRun(key) === undefined, 'an unscanned listing has no stored run');

  db.saveScoutRun({
    cache_key: key,
    category: 'cs.AI',
    scanned_ids: JSON.stringify(listing),
    paper_count: listing.length,
    library_fingerprint: fpAfterWorldline,
    model: 'claude-opus-5',
    backend: 'cli',
    findings: JSON.stringify([{ arxivId: '2401.0001', score: 88, headline: 'h', reason: 'r', connections: [] }]),
    input_tokens: 1000,
    output_tokens: 200,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    estimated_cost: 0.01,
  });

  const stored = db.getScoutRun(key);
  ok(!!stored, 'the run is retrievable by scan key — a repeat press costs nothing');
  ok(JSON.parse(stored!.findings)[0].arxivId === '2401.0001', 'findings round-trip through the store');
  ok(stored!.library_fingerprint === fpAfterWorldline, 'the run records the library it was scanned against');
  ok(stored!.backend === 'cli', 'the run records which backend produced it');

  // A forced rescan replaces the verdict rather than accumulating rows.
  db.saveScoutRun({
    cache_key: key,
    category: 'cs.AI',
    scanned_ids: JSON.stringify(listing),
    paper_count: listing.length,
    library_fingerprint: 'different',
    model: 'claude-opus-5',
    backend: 'api',
    findings: JSON.stringify([]),
    input_tokens: 1,
    output_tokens: 1,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    estimated_cost: 0.001,
  });
  ok(db.getScoutRuns(10).length === 1, 'a forced rescan overwrites the run instead of duplicating it');
  ok(JSON.parse(db.getScoutRun(key)!.findings).length === 0, 'the overwritten run holds the newer verdict');
  ok(db.getScoutRun(key)!.backend === 'api', 'the overwritten run records the newer backend');

  console.log('\nPhase 4 — normalizing model output\n');

  const candidates = [
    { id: '2401.0001', title: 'A', summary: '', authors: [] },
    { id: '2401.0002', title: 'B', summary: '', authors: [] },
  ];

  const normalized = normalizeFindings(
    {
      findings: [
        { arxivId: '2401.0002', score: 70, headline: 'b', reason: 'rb', connections: ['t'] },
        { arxivId: '2401.0001v2', score: 95, headline: 'a', reason: 'ra', connections: [] },
        { arxivId: '2401.0001', score: 60, headline: 'dup', reason: 'r', connections: [] },
        { arxivId: '9999.9999', score: 99, headline: 'ghost', reason: 'r', connections: [] },
        { arxivId: '2401.0002', score: 'nonsense', headline: 'x', reason: 'r', connections: [] },
        null,
      ],
    },
    candidates
  );

  ok(normalized.length === 2, `only real, deduplicated candidates survive (got ${normalized.length})`);
  ok(normalized[0].arxivId === '2401.0001', 'findings are ordered best-first');
  ok(!normalized.some(f => f.arxivId === '9999.9999'), 'a hallucinated arXiv ID is dropped');
  ok(normalized[1].connections.length === 1, 'connections survive normalization');
  ok(normalizeFindings({ findings: 'not-an-array' }, candidates).length === 0, 'a malformed payload yields no findings');
  ok(normalizeFindings(null, candidates).length === 0, 'a null payload yields no findings');

  const clamped = normalizeFindings(
    { findings: [{ arxivId: '2401.0001', score: 5000, headline: 'h', reason: 'r', connections: [] }] },
    candidates
  );
  ok(clamped[0].score === 100, 'scores are clamped to 0-100');

  console.log('\nPhase 5 — claude CLI invocation\n');

  const args = buildCliArgs('SYSTEM');
  const flag = (name: string) => args[args.indexOf(name) + 1];

  ok(args[0] === '-p', 'runs in non-interactive print mode');
  ok(flag('--output-format') === 'json', 'asks for the JSON result envelope');
  ok(flag('--model') === 'claude-opus-5', 'pins the model to Opus 5');
  ok(args.includes('--tools') && flag('--tools') === '', 'disables every built-in tool');
  ok(flag('--system-prompt') === 'SYSTEM', 'replaces the coding-agent system prompt with the scout prompt');
  ok(args.includes('--json-schema'), 'constrains output with a JSON schema');
  ok(JSON.parse(flag('--json-schema')).required.includes('findings'), 'the schema is the findings schema');
  ok(args.includes('--no-session-persistence'), 'does not litter the session history');
  ok(args.includes('--strict-mcp-config'), 'ignores the user\'s MCP servers');
  ok(
    args.indexOf('--tools') < args.indexOf('--system-prompt'),
    'the variadic --tools flag is followed by another flag, so it cannot swallow a value'
  );

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
