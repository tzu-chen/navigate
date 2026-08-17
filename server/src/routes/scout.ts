import { Router, Request, Response } from 'express';
import * as db from '../services/database';
import {
  buildLibraryProfile,
  fingerprintLibraryProfile,
  runScoutScan,
  scanCacheKey,
  MAX_CANDIDATES,
  SCOUT_MODEL,
  ScoutBackend,
  ScoutCandidate,
  ScoutFinding,
} from '../services/scout';

const router = Router();

interface ScanRequest {
  papers: ScoutCandidate[];
  category?: string;
  force?: boolean;
}

interface ScanResponse {
  findings: ScoutFinding[];
  cached: boolean;
  /** The library changed since this (cached) scan ran, so a rescan may differ. */
  libraryChanged: boolean;
  scannedCount: number;
  /** Candidates dropped because the listing exceeded MAX_CANDIDATES. */
  truncated: number;
  model: string;
  /** Which backend produced the verdict — 'cli' bills the Claude Code plan, 'api' the API account. */
  backend: ScoutBackend;
  scannedAt: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
    estimated_cost: number;
  };
}

// Coalesce concurrent scans of the same listing (double-click, two open tabs)
// so a single button press can never become two paid API calls.
const inFlight = new Map<string, Promise<ScanResponse>>();

function normalizeCandidates(raw: unknown): ScoutCandidate[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: ScoutCandidate[] = [];
  for (const p of raw as any[]) {
    const id = String(p?.id ?? '').trim();
    const title = String(p?.title ?? '').trim();
    if (!id || !title || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      title,
      summary: String(p?.summary ?? '').trim(),
      authors: Array.isArray(p?.authors) ? p.authors.map((a: unknown) => String(a)) : [],
      categories: Array.isArray(p?.categories) ? p.categories.map((c: unknown) => String(c)) : [],
    });
  }
  return out;
}

function rowToResponse(row: db.ScoutRunRow, fingerprint: string, truncated: number): ScanResponse {
  return {
    findings: JSON.parse(row.findings) as ScoutFinding[],
    cached: true,
    libraryChanged: row.library_fingerprint !== fingerprint,
    scannedCount: row.paper_count,
    truncated,
    model: row.model,
    backend: row.backend === 'cli' ? 'cli' : 'api',
    // SQLite stores `datetime('now')` as naive UTC; hand the client an ISO string.
    scannedAt: new Date(`${row.created_at.replace(' ', 'T')}Z`).toISOString(),
    usage: {
      input_tokens: row.input_tokens ?? 0,
      output_tokens: row.output_tokens ?? 0,
      cache_creation_input_tokens: row.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: row.cache_read_input_tokens ?? 0,
      estimated_cost: row.estimated_cost ?? 0,
    },
  };
}

// POST /api/scout/scan — triage a browse listing against the saved library.
//
// Idempotent by design: the cache key is the exact set of preprints scanned, so
// pressing the button again while arXiv hasn't published a new listing returns
// the stored verdict without calling the model. `force: true` overrides.
router.post('/scan', async (req: Request, res: Response) => {
  try {
    const { papers, category, force } = req.body as ScanRequest;

    const allCandidates = normalizeCandidates(papers);
    if (allCandidates.length === 0) {
      return res.status(400).json({ error: 'papers array is required' });
    }

    const candidates = allCandidates.slice(0, MAX_CANDIDATES);
    const truncated = allCandidates.length - candidates.length;
    const categoryKey = category ? String(category) : null;
    // Key on what was actually sent, so a truncated listing re-keys consistently.
    const cacheKey = scanCacheKey(categoryKey, candidates.map(c => c.id));

    const profile = buildLibraryProfile();
    const fingerprint = fingerprintLibraryProfile(profile);

    if (!force) {
      const existing = db.getScoutRun(cacheKey);
      if (existing) {
        return res.json(rowToResponse(existing, fingerprint, truncated));
      }
      const pending = inFlight.get(cacheKey);
      if (pending) {
        return res.json(await pending);
      }
    }

    // Default to the local `claude -p` CLI: scans bill against the Claude Code
    // plan rather than metered API credits, and no key has to be stored.
    const backend: ScoutBackend = db.getSetting('scoutBackend') === 'api' ? 'api' : 'cli';
    const apiKey = db.getSetting('claudeApiKey');
    if (backend === 'api' && !apiKey) {
      return res.status(400).json({ error: 'Claude API key is required. Please set it in Settings.' });
    }

    const work = (async (): Promise<ScanResponse> => {
      const scan = await runScoutScan(backend, candidates, profile, apiKey);
      db.saveScoutRun({
        cache_key: cacheKey,
        category: categoryKey,
        scanned_ids: JSON.stringify(candidates.map(c => c.id)),
        paper_count: candidates.length,
        library_fingerprint: fingerprint,
        model: scan.model,
        backend: scan.backend,
        findings: JSON.stringify(scan.findings),
        input_tokens: scan.usage.input_tokens,
        output_tokens: scan.usage.output_tokens,
        cache_creation_input_tokens: scan.usage.cache_creation_input_tokens,
        cache_read_input_tokens: scan.usage.cache_read_input_tokens,
        estimated_cost: scan.usage.estimated_cost,
      });
      return {
        findings: scan.findings,
        cached: false,
        libraryChanged: false,
        scannedCount: candidates.length,
        truncated,
        model: scan.model,
        backend: scan.backend,
        scannedAt: new Date().toISOString(),
        usage: scan.usage,
      };
    })();

    inFlight.set(cacheKey, work);
    try {
      res.json(await work);
    } finally {
      inFlight.delete(cacheKey);
    }
  } catch (error) {
    console.error('Scout scan error:', error);
    const status = (error as { status?: number }).status;
    const message = error instanceof Error ? error.message : 'Failed to scan preprints';
    // Surface upstream 4xx (bad key, rate limit) verbatim; everything else is ours.
    res.status(status && status >= 400 && status < 500 ? status : 500).json({ error: message });
  }
});

// GET /api/scout/runs — recent scans (diagnostics: spend, hit rate, findings history)
router.get('/runs', (req: Request, res: Response) => {
  try {
    const limit = Math.min(parseInt(String(req.query.limit ?? '50'), 10) || 50, 200);
    const runs = db.getScoutRuns(limit).map(r => ({
      id: r.id,
      category: r.category,
      paperCount: r.paper_count,
      model: r.model,
      backend: r.backend,
      findings: JSON.parse(r.findings) as ScoutFinding[],
      estimatedCost: r.estimated_cost ?? 0,
      createdAt: r.created_at,
    }));
    res.json({ model: SCOUT_MODEL, runs });
  } catch (error) {
    console.error('Scout runs error:', error);
    res.status(500).json({ error: 'Failed to get scout runs' });
  }
});

export default router;
