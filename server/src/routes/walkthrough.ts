import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import * as db from '../services/database';
import { DATA_DIR } from '../services/paths';
import { getArxivPaper } from '../services/arxiv';
import {
  fetchSourcePackage,
  fetchLatexmlHtml,
  latexmlToText,
  readTextFiles,
  SourcePackage,
} from '../services/texsource';
import { distillSource, DistilledSource } from '../services/texdistill';
import {
  CONTRACT_VERSION,
  DEFAULT_BUILD_BUDGET_USD,
  DEFAULT_BUILD_EFFORT,
  MAX_SCENES,
  PaperMeta,
  WALKTHROUGH_MODEL,
  WalkthroughBackend,
  WalkthroughOutline,
  bundleAssetsDir,
  buildScratchDir,
  finalizeBundle,
  normalizeOutline,
  runBuild,
  runOutline,
  walkthroughCacheKey,
} from '../services/walkthrough';
import { findActiveJobFor, getJob, startJob, subscribe } from '../services/walkthrough-jobs';
import { SavedPaper } from '../types';

const router = Router();

/** Express 5 types a wildcard param as `string | string[]`; collapse it. */
function param(req: Request, name: string): string {
  const value = (req.params as Record<string, string | string[]>)[name];
  return Array.isArray(value) ? value.join('/') : String(value ?? '');
}

/**
 * Routes are **action-first** (`/build/:arxivId`, not `/:arxivId/build`, as the
 * plan sketched) because arXiv ids contain slashes: `hep-th/9711200` under a
 * greedy `:arxivId(*)` would swallow any trailing path segment. Putting the
 * verb first makes the wildcard unambiguous and needs no client-side encoding
 * games that a proxy might normalise away.
 */

// --- Vendored assets ---------------------------------------------------------

/**
 * three.js and MathJax are vendored and served locally, never from a CDN:
 * offline-correct, version-pinned by package.json, and the bundle's CSP forbids
 * the alternative anyway.
 */
export const ASSETS: Record<string, { module: string; file: string; type: string }> = {
  'three.module.js': {
    module: 'three',
    file: 'build/three.module.min.js',
    type: 'text/javascript; charset=utf-8',
  },
  'mathjax-tex-svg.js': {
    // **MathJax 3, deliberately, and pinned major.** v4 splits its fonts into
    // chunks it fetches from jsDelivr at typeset time — which the bundle's CSP
    // correctly blocks, whereupon MathJax throws `dynamic file '…' failed to
    // load` and abandons typesetting entirely, leaving raw \(…\) on screen.
    // v3 compiles the whole font into this one file, so SVG output really does
    // need no network. Do not upgrade without re-checking that.
    //
    // **And it must be the `-full` build, for the same reason one level down.**
    // Plain `tex-svg.js` pre-loads only seven TeX packages (base, ams,
    // newcommand, noundefined, require, autoload, configmacros) and leaves the
    // rest to `autoload`, which fetches them at *typeset* time. So the first
    // \boldsymbol in a paper — and ML papers are full of them — sent MathJax to
    // `<paths.mathjax>/input/tex/extensions/boldsymbol.js`, which this route has
    // never served. The request 404s, the loader promise rejects,
    // `typesetPromise` rejects with it, and **every equation in that scene stays
    // raw** — not just the one that used the macro. Measured on 2606.05878
    // (TS-ICL): the whole opening scene rendered as literal TeX.
    //
    // `tex-svg-full.js` pre-loads every extension (`\boldsymbol`, `\cancel`,
    // `\color`, `\bra`/`\ket`, mhchem, physics, …), so autoload resolves from
    // the in-memory registry and never touches the network. It costs 166 KB
    // more (2.28 MB vs 2.11 MB) — nothing against being unable to fail.
    //
    // The *served name* deliberately does not change: it is unversioned and
    // sent `no-cache`, so swapping the file behind it repairs every walkthrough
    // already built, with no bundle migration. That is the whole reason this
    // route must never send `immutable`.
    module: 'mathjax',
    file: 'es5/tex-svg-full.js',
    type: 'text/javascript; charset=utf-8',
  },
};

function resolveAsset(name: string): string | null {
  const asset = ASSETS[name];
  if (!asset) return null;
  // Deep `require.resolve` is blocked by these packages' "exports" maps, so walk
  // to node_modules directly. `src/services` and `dist/services` sit at the same
  // depth under `server/`, the same reasoning paths.ts documents.
  const candidates = [
    path.join(__dirname, '..', '..', 'node_modules', asset.module, asset.file),
    path.join(__dirname, '..', '..', '..', 'node_modules', asset.module, asset.file),
  ];
  return candidates.find(p => fs.existsSync(p)) ?? null;
}

/**
 * Cache policy for the vendored assets.
 *
 * **Not `immutable`.** These URLs carry no version — `/asset/mathjax-tex-svg.js`
 * is a stable path whose *contents* change whenever the pinned dependency does.
 * `immutable` told browsers the file could never change, so swapping MathJax 4
 * for 3 changed nothing for anyone who had already loaded a walkthrough: they
 * kept the old bytes for a year and kept seeing raw \(…\). `immutable` is only
 * ever safe on a content-addressed URL, and these are not.
 *
 * `no-cache` does not mean "do not cache" — it means "revalidate before use".
 * The browser keeps the 2 MB body and `sendFile`'s ETag turns each check into a
 * 304, so the cost is one conditional request against a local server.
 */
export function assetCacheControl(): string {
  return 'no-cache';
}

router.get('/asset/:name', (req: Request, res: Response) => {
  const name = param(req, 'name');
  const asset = ASSETS[name];
  const file = resolveAsset(name);
  if (!asset || !file) {
    return res.status(404).json({ error: 'Unknown walkthrough asset' });
  }
  res.setHeader('Content-Type', asset.type);
  res.setHeader('Cache-Control', assetCacheControl());
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.sendFile(file);
});

// --- Source resolution -------------------------------------------------------

type ContextMode = 'tex' | 'latexml' | 'abstract';

interface SourceContext {
  paper: PaperMeta;
  distilled: DistilledSource;
  sourceSha: string;
  sourceVersion: string | null;
  mode: ContextMode;
  warnings: string[];
  figureFiles: { name: string; absPath: string }[];
}

async function resolvePaperMeta(arxivId: string): Promise<PaperMeta> {
  const saved = db.getPaperByArxivId(arxivId) as SavedPaper | undefined;
  if (saved) {
    let authors: string[] = [];
    try {
      authors = JSON.parse(saved.authors);
    } catch {
      /* malformed author JSON is not worth failing on */
    }
    return { arxivId, title: saved.title, authors, abstract: saved.summary };
  }

  const fetched = await getArxivPaper(arxivId);
  if (!fetched) throw new Error(`No paper found on arXiv for ${arxivId}`);
  return {
    arxivId,
    title: fetched.title,
    authors: fetched.authors,
    abstract: fetched.summary,
  };
}

/** Raster figures the distiller resolved, as absolute paths in the source cache. */
function collectFigureFiles(
  pkg: SourcePackage,
  distilled: DistilledSource
): { name: string; absPath: string }[] {
  const out: { name: string; absPath: string }[] = [];
  const seen = new Set<string>();
  for (const figure of distilled.figures) {
    if (figure.kind !== 'raster' || !figure.resolvedPath) continue;
    const name = path.basename(figure.resolvedPath);
    if (seen.has(name)) continue;
    const absPath = path.join(pkg.dir, figure.resolvedPath);
    if (!fs.existsSync(absPath)) continue;
    seen.add(name);
    out.push({ name, absPath });
  }
  return out;
}

/**
 * The acquire → distill chain with its fallbacks, in order:
 *   tex      — the source package. The good path.
 *   latexml  — arXiv's HTML rendering. Broad coverage but not universal, and it
 *              has already lost the macros, so it must be probed not assumed.
 *   abstract — title and abstract only. A legitimate but shallow walkthrough,
 *              marked as such so the reader knows which they are looking at.
 */
async function resolveSourceContext(
  arxivId: string,
  opts: { force?: boolean } = {}
): Promise<SourceContext> {
  const paper = await resolvePaperMeta(arxivId);
  const warnings: string[] = [];

  // Uploaded PDFs have no arXiv source by construction.
  if (!arxivId.startsWith('upload-')) {
    let pkg: SourcePackage | null = null;
    try {
      pkg = await fetchSourcePackage(arxivId, { force: opts.force });
    } catch (err) {
      warnings.push(
        `Could not fetch the LaTeX source: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    if (pkg && pkg.files.length > 0) {
      const distilled = distillSource(readTextFiles(pkg), { entryNames: pkg.entryNames });
      if (distilled.flattenedTex.trim().length > 0) {
        return {
          paper,
          distilled,
          sourceSha: pkg.sha256,
          sourceVersion: pkg.version,
          mode: 'tex',
          warnings: [...warnings, ...pkg.warnings, ...distilled.warnings],
          figureFiles: collectFigureFiles(pkg, distilled),
        };
      }
      warnings.push('The source package contained no usable text.');
    } else if (pkg) {
      warnings.push(...pkg.warnings);
    }

    const html = await fetchLatexmlHtml(arxivId);
    if (html) {
      const text = latexmlToText(html);
      warnings.push(
        "Built from arXiv's HTML rendering rather than the LaTeX source: the author's macro definitions are not available."
      );
      return {
        paper,
        distilled: synthesizeDistilled(text),
        sourceSha: hashOf(text),
        sourceVersion: null,
        mode: 'latexml',
        warnings,
        figureFiles: [],
      };
    }
  }

  const fallbackText = `\\title{${paper.title}}\n\n\\begin{abstract}\n${paper.abstract}\n\\end{abstract}\n`;
  warnings.push(
    'No LaTeX source or HTML rendering is available for this paper. Built from the title and abstract only — the result is necessarily shallow.'
  );
  return {
    paper,
    distilled: synthesizeDistilled(fallbackText),
    sourceSha: hashOf(fallbackText),
    sourceVersion: null,
    mode: 'abstract',
    warnings,
    figureFiles: [],
  };
}

function synthesizeDistilled(text: string): DistilledSource {
  return {
    mainFile: null,
    mainFileReason: 'synthesized (no source package)',
    flattenedTex: text,
    macros: [],
    structure: [],
    labels: [],
    figures: [],
    citations: {},
    warnings: [],
    truncated: false,
  };
}

function hashOf(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function backendSetting(): WalkthroughBackend {
  // Default to the local `claude -p` CLI: builds bill against the Claude Code
  // plan rather than metered API credits, and no key has to be stored.
  return db.getSetting('walkthroughBackend') === 'api' ? 'api' : 'cli';
}

function budgetSetting(): number {
  const raw = parseFloat(db.getSetting('walkthroughBudgetUsd') ?? '');
  return Number.isFinite(raw) && raw > 0 ? Math.min(raw, 20) : DEFAULT_BUILD_BUDGET_USD;
}

function effortSetting(): string {
  const raw = db.getSetting('walkthroughEffort');
  return raw === 'low' || raw === 'medium' || raw === 'high' ? raw : DEFAULT_BUILD_EFFORT;
}

function parseOutline(row: db.WalkthroughRow): WalkthroughOutline | null {
  if (!row.outline) return null;
  try {
    return JSON.parse(row.outline) as WalkthroughOutline;
  } catch {
    return null;
  }
}

/** `authors`/`categories` are JSON strings in both `papers` and `paper_archive`,
 *  and null when neither table still knows the paper. */
function safeJsonArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function rowToResponse(row: db.WalkthroughRow) {
  return {
    id: row.id,
    arxivId: row.arxiv_id,
    status: row.status,
    fitness: row.fitness,
    outline: parseOutline(row),
    sourceVersion: row.source_version,
    contractVersion: row.contract_version,
    hasBundle: !!row.bundle_path,
    warnings: row.warnings ? (JSON.parse(row.warnings) as string[]) : [],
    model: row.model,
    backend: row.backend,
    usage: {
      input_tokens: row.input_tokens ?? 0,
      output_tokens: row.output_tokens ?? 0,
      cache_creation_input_tokens: row.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: row.cache_read_input_tokens ?? 0,
      outline_cost: row.outline_cost ?? 0,
      build_cost: row.build_cost ?? 0,
      estimated_cost: row.estimated_cost ?? 0,
    },
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// --- P0: the source manifest -------------------------------------------------

// GET /api/walkthrough/source/:arxivId — what arXiv actually has for this paper.
router.get('/source/:arxivId(*)', async (req: Request, res: Response) => {
  try {
    const arxivId = param(req, 'arxivId');
    const force = req.query.force === 'true';
    const pkg = await fetchSourcePackage(arxivId, { force });
    const distilled =
      pkg.files.length > 0
        ? distillSource(readTextFiles(pkg), { entryNames: pkg.entryNames })
        : null;

    res.json({
      arxivId,
      kind: pkg.kind,
      origin: pkg.origin,
      version: pkg.version,
      sha256: pkg.sha256,
      files: pkg.files,
      entryCount: pkg.entryNames.length,
      warnings: pkg.warnings,
      distilled: distilled && {
        mainFile: distilled.mainFile,
        mainFileReason: distilled.mainFileReason,
        chars: distilled.flattenedTex.length,
        approxTokens: Math.round(distilled.flattenedTex.length / 4),
        macros: distilled.macros.length,
        sections: distilled.structure.length,
        labels: distilled.labels.map(l => l.label),
        figures: distilled.figures,
        citations: Object.keys(distilled.citations).length,
        truncated: distilled.truncated,
        warnings: distilled.warnings,
      },
    });
  } catch (error) {
    console.error('Walkthrough source error:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to fetch the paper source',
    });
  }
});

// --- P2: the outline ---------------------------------------------------------

// POST /api/walkthrough/outline/:arxivId — the cheap structured pass with the
// fitness gate. Idempotent: an existing row for the same source + contract is
// returned without a model call unless `force` is set.
router.post('/outline/:arxivId(*)', async (req: Request, res: Response) => {
  try {
    const arxivId = param(req, 'arxivId');
    const force = req.body?.force === true;

    const context = await resolveSourceContext(arxivId, { force });

    // "Have I already outlined this source?" is a question about the source, not
    // about the outline — the outline does not exist yet. It is deliberately NOT
    // asked via the cache key: the row's key must be the *outline-derived* one,
    // or `POST /build` would compute a different key and never find the stored
    // bundle, defeating idempotency and silently paying for every rebuild.
    if (!force) {
      const rows = db
        .getWalkthroughsByArxivId(arxivId)
        .filter(r => r.source_sha === context.sourceSha && r.contract_version === CONTRACT_VERSION);
      if (rows.length > 0) return res.json({ ...rowToResponse(rows[0]), cached: true });
    }

    const backend = backendSetting();
    const apiKey = db.getSetting('claudeApiKey');
    if (backend === 'api' && !apiKey) {
      return res
        .status(400)
        .json({ error: 'Claude API key is required. Please set it in Settings.' });
    }

    const result = await runOutline(backend, context.paper, context.distilled, apiKey);

    // Key on the outline the model actually produced, so a later build of this
    // row recomputes the identical key and hits the cache.
    const cacheKey = walkthroughCacheKey(context.sourceSha, result.outline, CONTRACT_VERSION);

    // A forced re-outline can land on a byte-identical outline; that is the same
    // build, so return the existing row rather than colliding on the unique index.
    const identical = db.getWalkthroughByCacheKey(cacheKey);
    if (identical) {
      return res.json({ ...rowToResponse(identical), cached: true, contextMode: context.mode });
    }

    const id = db.createWalkthrough({
      arxiv_id: arxivId,
      source_version: context.sourceVersion,
      source_sha: context.sourceSha,
      contract_version: CONTRACT_VERSION,
      cache_key: cacheKey,
      // `unfit` is a first-class outcome, not a failure: the build is still
      // offered (prose and equations), it just should not be sold as animated.
      status: result.outline.fitness.verdict === 'none' ? 'unfit' : 'pending',
      fitness: result.outline.fitness.verdict,
      // Recorded on the row because the gallery cannot rely on either paper
      // table knowing it: a walkthrough outlives its paper, and can be outlined
      // straight from a browse listing for a paper that was never saved.
      paper_title: context.paper.title,
      outline: JSON.stringify(result.outline),
      warnings: JSON.stringify([
        ...context.warnings,
        ...(context.mode !== 'tex' ? [`Context mode: ${context.mode}`] : []),
      ]),
      model: result.model,
      backend: result.backend,
      input_tokens: result.usage.input_tokens,
      output_tokens: result.usage.output_tokens,
      cache_creation_input_tokens: result.usage.cache_creation_input_tokens,
      cache_read_input_tokens: result.usage.cache_read_input_tokens,
      outline_cost: result.usage.estimated_cost,
    });

    const row = db.getWalkthrough(id)!;
    res.status(201).json({ ...rowToResponse(row), cached: false, contextMode: context.mode });
  } catch (error) {
    console.error('Walkthrough outline error:', error);
    const status = (error as { status?: number }).status;
    res.status(status && status >= 400 && status < 500 ? status : 500).json({
      error: error instanceof Error ? error.message : 'Failed to outline this paper',
    });
  }
});

/**
 * PUT /api/walkthrough/row/:id/outline — edit the outline before paying for a
 * build. This is the main quality lever in the whole feature, which is why it
 * exists from the start rather than as later polish.
 *
 * Editing a row that has never been built updates it in place; editing one that
 * already produced a bundle forks a new row, because a previous build is
 * sometimes the better one and re-rolling must not destroy it.
 */
router.put('/row/:id/outline', (req: Request, res: Response) => {
  try {
    const id = parseInt(param(req, 'id'), 10);
    const row = db.getWalkthrough(id);
    if (!row) return res.status(404).json({ error: 'Walkthrough not found' });

    const previous = parseOutline(row);
    const knownLabels = new Set<string>();
    for (const scene of previous?.scenes ?? []) for (const label of scene.equations) knownLabels.add(label);
    // An edit may cite any label the original outline cited, plus anything the
    // client explicitly vouches for.
    for (const label of Array.isArray(req.body?.knownLabels) ? req.body.knownLabels : []) {
      knownLabels.add(String(label));
    }

    const outline = normalizeOutline(req.body?.outline, [...knownLabels]);
    if (outline.scenes.length === 0 && outline.fitness.verdict !== 'none') {
      return res.status(400).json({ error: 'An outline needs at least one scene.' });
    }

    const cacheKey = walkthroughCacheKey(row.source_sha ?? '', outline, CONTRACT_VERSION);
    const clash = db.getWalkthroughByCacheKey(cacheKey);
    if (clash && clash.id !== id) {
      // This exact outline has been keyed before; hand back that row rather than
      // creating a duplicate that would collide on the unique index.
      return res.json(rowToResponse(clash));
    }

    if (row.status === 'ready') {
      const forked = db.createWalkthrough({
        arxiv_id: row.arxiv_id,
        source_version: row.source_version,
        source_sha: row.source_sha,
        contract_version: CONTRACT_VERSION,
        cache_key: cacheKey,
        status: 'pending',
        fitness: outline.fitness.verdict,
        paper_title: row.paper_title,
        outline: JSON.stringify(outline),
        warnings: row.warnings,
        model: row.model,
        backend: row.backend,
      });
      return res.status(201).json(rowToResponse(db.getWalkthrough(forked)!));
    }

    db.updateWalkthroughOutline(id, JSON.stringify(outline), cacheKey, outline.fitness.verdict);
    res.json(rowToResponse(db.getWalkthrough(id)!));
  } catch (error) {
    console.error('Walkthrough outline edit error:', error);
    res.status(500).json({ error: 'Failed to save the outline' });
  }
});

// --- P3: the build -----------------------------------------------------------

// POST /api/walkthrough/build/:arxivId → 202 { jobId }
router.post('/build/:arxivId(*)', async (req: Request, res: Response) => {
  try {
    const arxivId = param(req, 'arxivId');
    const force = req.body?.force === true;
    const rowId = Number(req.body?.walkthroughId);

    const row = Number.isInteger(rowId) ? db.getWalkthrough(rowId) : undefined;
    if (!row) {
      return res
        .status(400)
        .json({ error: 'walkthroughId is required — outline the paper before building it.' });
    }
    if (row.arxiv_id !== arxivId) {
      return res.status(400).json({ error: 'That walkthrough belongs to a different paper.' });
    }

    const outline = parseOutline(row);
    if (!outline) return res.status(400).json({ error: 'This walkthrough has no outline yet.' });

    const active = findActiveJobFor(row.id);
    if (active) return res.status(202).json({ jobId: active.id, walkthroughId: row.id, reused: true });

    // Idempotency, Scout's rule: identical source + identical outline +
    // identical contract returns the stored bundle and costs nothing.
    const cacheKey = walkthroughCacheKey(row.source_sha ?? '', outline, CONTRACT_VERSION);
    if (!force) {
      const cached = db.getWalkthroughByCacheKey(cacheKey);
      if (cached && cached.status === 'ready' && cached.bundle_path) {
        return res.json({ cached: true, walkthrough: rowToResponse(cached) });
      }
    }

    const backend = backendSetting();
    const apiKey = db.getSetting('claudeApiKey');
    if (backend === 'api' && !apiKey) {
      return res
        .status(400)
        .json({ error: 'Claude API key is required. Please set it in Settings.' });
    }

    const budgetUsd = budgetSetting();
    const effort = effortSetting();

    db.setWalkthroughStatus(row.id, 'building');

    const job = startJob(arxivId, row.id, async onEvent => {
      try {
        onEvent({ type: 'stage', stage: 'acquiring', detail: 'fetching the LaTeX source' });
        const context = await resolveSourceContext(arxivId);

        const dir = buildScratchDir(arxivId, row.id);
        const result = await runBuild(
          backend,
          dir,
          {
            paper: context.paper,
            distilled: context.distilled,
            outline,
            figureFiles: context.figureFiles,
          },
          { budgetUsd, effort, apiKey },
          onEvent
        );

        const relative = finalizeBundle(dir, arxivId, row.id, result.html);
        db.completeWalkthroughBuild(row.id, {
          bundle_path: relative,
          model: result.model,
          backend: result.backend,
          input_tokens: result.usage.input_tokens,
          output_tokens: result.usage.output_tokens,
          cache_creation_input_tokens: result.usage.cache_creation_input_tokens,
          cache_read_input_tokens: result.usage.cache_read_input_tokens,
          build_cost: result.usage.estimated_cost,
          warnings: JSON.stringify([...context.warnings, ...result.warnings]),
        });
        onEvent({
          type: 'stage',
          stage: 'ready',
          detail: `bundle written (${Math.round(result.html.length / 1024)} KB)`,
        });
      } catch (err) {
        // The outline survives a failed build, so a retry is cheap.
        db.setWalkthroughStatus(
          row.id,
          'failed',
          err instanceof Error ? err.message : String(err)
        );
        throw err;
      }
    });

    res.status(202).json({ jobId: job.id, walkthroughId: row.id, reused: false });
  } catch (error) {
    console.error('Walkthrough build error:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to start the build',
    });
  }
});

// GET /api/walkthrough/job/:jobId — poll fallback for the SSE stream.
router.get('/job/:jobId', (req: Request, res: Response) => {
  const job = getJob(param(req, 'jobId'));
  if (!job) return res.status(404).json({ error: 'Job not found' });
  const row = db.getWalkthrough(job.walkthroughId);
  res.json({
    id: job.id,
    status: job.status,
    error: job.error,
    events: job.events,
    walkthrough: row ? rowToResponse(row) : null,
  });
});

// GET /api/walkthrough/job/:jobId/stream — SSE progress.
router.get('/job/:jobId/stream', (req: Request, res: Response) => {
  const job = getJob(param(req, 'jobId'));
  if (!job) return res.status(404).json({ error: 'Job not found' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const since = parseInt(String(req.query.since ?? '-1'), 10);
  const send = (entry: { seq: number; event: unknown }) => {
    res.write(`id: ${entry.seq}\ndata: ${JSON.stringify(entry.event)}\n\n`);
  };

  const unsubscribe = subscribe(job.id, Number.isFinite(since) ? since : -1, entry => {
    send(entry);
    const event = entry.event as { type?: string; status?: string };
    if (event.type === 'status' && (event.status === 'done' || event.status === 'error')) {
      const row = db.getWalkthrough(job.walkthroughId);
      res.write(
        `event: complete\ndata: ${JSON.stringify({
          status: event.status,
          walkthrough: row ? rowToResponse(row) : null,
        })}\n\n`
      );
      res.end();
    }
  });

  if (!unsubscribe) return res.end();

  // A finished job replays its history and then ends immediately.
  if (job.status === 'done' || job.status === 'error') {
    const row = db.getWalkthrough(job.walkthroughId);
    res.write(
      `event: complete\ndata: ${JSON.stringify({
        status: job.status,
        walkthrough: row ? rowToResponse(row) : null,
      })}\n\n`
    );
    return res.end();
  }

  const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 15000);
  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});

// --- Stage 5: serving the bundle ---------------------------------------------

/**
 * The sandbox, in two layers.
 *
 * The iframe carries `allow-scripts` and deliberately **not**
 * `allow-same-origin`, which puts the bundle in an opaque origin with no access
 * to the app's DOM, storage, cookies or API session. This header is the second
 * layer: `connect-src 'none'` is the one that matters, because it means
 * generated code cannot exfiltrate the paper's content no matter what it tries.
 *
 * The asset origin is spelled out explicitly as well as via `'self'`. A
 * sandboxed document has an opaque origin, and whether `'self'` resolves to
 * anything there is not worth betting the feature on; naming the origin and the
 * exact asset path is unambiguous and still forbids every other host.
 */
function bundleCsp(req: Request): string {
  const origin = `${req.protocol}://${req.get('host')}`;
  const assetSrc = `${origin}/api/walkthrough/asset/`;
  return [
    "default-src 'none'",
    `script-src 'self' 'unsafe-inline' ${assetSrc}`,
    "style-src 'unsafe-inline'",
    `img-src 'self' data: blob: ${origin}`,
    "font-src data:",
    "connect-src 'none'",
    "frame-ancestors 'self'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}

router.get('/row/:id/bundle', (req: Request, res: Response) => {
  const row = db.getWalkthrough(parseInt(param(req, 'id'), 10));
  if (!row || !row.bundle_path) return res.status(404).send('No walkthrough bundle here.');

  const file = path.join(DATA_DIR, row.bundle_path);
  if (!fs.existsSync(file)) return res.status(404).send('The bundle file is missing.');

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Security-Policy', bundleCsp(req));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(file);
});

// Figures the bundle copied for itself, addressed as `assets/<name>` relative
// to the bundle URL.
router.get('/row/:id/assets/:name', (req: Request, res: Response) => {
  const row = db.getWalkthrough(parseInt(param(req, 'id'), 10));
  if (!row) return res.status(404).end();

  const name = path.basename(param(req, 'name'));
  const dir = bundleAssetsDir(row.arxiv_id, row.id);
  const file = path.join(dir, name);
  if (!file.startsWith(path.resolve(dir) + path.sep) && path.dirname(file) !== path.resolve(dir)) {
    return res.status(400).end();
  }
  if (!fs.existsSync(file)) return res.status(404).end();

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self' data:");
  res.sendFile(file);
});

// --- Status, history, deletion ----------------------------------------------

// GET /api/walkthrough/paper/:arxivId — every walkthrough for a paper, newest first.
router.get('/paper/:arxivId(*)', (req: Request, res: Response) => {
  try {
    const arxivId = param(req, 'arxivId');
    const rows = db.getWalkthroughsByArxivId(arxivId);
    const ready = db.getLatestReadyWalkthrough(arxivId);
    res.json({
      arxivId,
      current: ready ? rowToResponse(ready) : rows[0] ? rowToResponse(rows[0]) : null,
      all: rows.map(rowToResponse),
      contractVersion: CONTRACT_VERSION,
      model: WALKTHROUGH_MODEL,
      maxScenes: MAX_SCENES,
      backend: backendSetting(),
      budgetUsd: budgetSetting(),
      effort: effortSetting(),
    });
  } catch (error) {
    console.error('Walkthrough status error:', error);
    res.status(500).json({ error: 'Failed to load walkthroughs for this paper' });
  }
});

// GET /api/walkthrough/indicators — which papers have one (the Library badge).
router.get('/indicators', (_req: Request, res: Response) => {
  try {
    res.json(db.getWalkthroughArxivIds());
  } catch (error) {
    console.error('Walkthrough indicators error:', error);
    res.status(500).json({ error: 'Failed to load walkthrough indicators' });
  }
});

/**
 * GET /api/walkthrough/gallery — one card's worth of data per paper that has a
 * walkthrough.
 *
 * Collapsed to **one entry per paper**, not per row: multiple rows per paper are
 * expected (an outline edit forks a new row and the previous build survives it),
 * and a gallery that showed each of them would be a list of near-duplicates. The
 * entry is the newest `ready` row, falling back to the newest row of any status
 * so a paper mid-outline is still visible; `buildCount` says how many rows sit
 * behind it, reachable from the pane's own history menu.
 *
 * The outline travels in a reduced form — scene titles and visual kinds, not the
 * narration — because that is exactly what the card's generated cover graphic is
 * drawn from, and shipping every narration for every paper would dwarf the rest
 * of the payload.
 */
router.get('/gallery', (_req: Request, res: Response) => {
  try {
    const byPaper = new Map<string, db.WalkthroughGalleryRow[]>();
    for (const row of db.getWalkthroughGallery()) {
      const bucket = byPaper.get(row.arxiv_id);
      if (bucket) bucket.push(row);
      else byPaper.set(row.arxiv_id, [row]);
    }

    const items = Array.from(byPaper.values()).map(rows => {
      // Rows arrive newest-first, so the first `ready` one is the newest ready one.
      const row = rows.find(r => r.status === 'ready' && r.bundle_path) ?? rows[0];
      const outline = parseOutline(row);
      return {
        id: row.id,
        arxivId: row.arxiv_id,
        status: row.status,
        fitness: row.fitness,
        hasBundle: !!row.bundle_path,
        sourceVersion: row.source_version,
        model: row.model,
        backend: row.backend,
        estimatedCost: row.estimated_cost ?? 0,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        buildCount: rows.length,
        readyCount: rows.filter(r => r.status === 'ready' && r.bundle_path).length,
        thesis: outline?.thesis ?? null,
        sceneTitles: (outline?.scenes ?? []).map(s => s.title),
        visualKinds: (outline?.scenes ?? []).map(s => s.visual.kind),
        // Identity. `paperId` null simply means the paper has left the library —
        // the walkthrough outlives it on purpose.
        title: row.resolved_title ?? row.arxiv_id,
        authors: safeJsonArray(row.resolved_authors),
        categories: safeJsonArray(row.resolved_categories),
        published: row.resolved_published,
        paperId: row.paper_id,
        tier: row.paper_tier,
        inLibrary: row.paper_id !== null,
      };
    });

    // Newest walkthrough first — the gallery is a record of what you have built.
    items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    res.json({ items, contractVersion: CONTRACT_VERSION, model: WALKTHROUGH_MODEL });
  } catch (error) {
    console.error('Walkthrough gallery error:', error);
    res.status(500).json({ error: 'Failed to load the walkthrough gallery' });
  }
});

// GET /api/walkthrough/runs — cost and outcome history, mirroring /api/scout/runs.
router.get('/runs', (req: Request, res: Response) => {
  try {
    const limit = Math.min(parseInt(String(req.query.limit ?? '50'), 10) || 50, 200);
    const runs = db.getWalkthroughRuns(limit).map(r => ({
      id: r.id,
      arxivId: r.arxiv_id,
      status: r.status,
      fitness: r.fitness,
      model: r.model,
      backend: r.backend,
      sceneCount: parseOutline(r)?.scenes.length ?? 0,
      outlineCost: r.outline_cost ?? 0,
      buildCost: r.build_cost ?? 0,
      estimatedCost: r.estimated_cost ?? 0,
      error: r.error,
      createdAt: r.created_at,
    }));
    res.json({ model: WALKTHROUGH_MODEL, contractVersion: CONTRACT_VERSION, runs });
  } catch (error) {
    console.error('Walkthrough runs error:', error);
    res.status(500).json({ error: 'Failed to load walkthrough runs' });
  }
});

router.get('/row/:id', (req: Request, res: Response) => {
  const row = db.getWalkthrough(parseInt(param(req, 'id'), 10));
  if (!row) return res.status(404).json({ error: 'Walkthrough not found' });
  res.json(rowToResponse(row));
});

// Deleting a walkthrough is deliberately explicit: it is expensive to make and
// survives the paper being handed to Scribe or removed from the library.
router.delete('/row/:id', (req: Request, res: Response) => {
  try {
    const id = parseInt(param(req, 'id'), 10);
    const row = db.getWalkthrough(id);
    if (!row) return res.status(404).json({ error: 'Walkthrough not found' });

    db.deleteWalkthrough(id);
    if (row.bundle_path) {
      fs.rmSync(path.join(DATA_DIR, row.bundle_path), { force: true });
    }
    fs.rmSync(bundleAssetsDir(row.arxiv_id, id), { recursive: true, force: true });
    fs.rmSync(buildScratchDir(row.arxiv_id, id), { recursive: true, force: true });
    res.json({ success: true });
  } catch (error) {
    console.error('Walkthrough delete error:', error);
    res.status(500).json({ error: 'Failed to delete the walkthrough' });
  }
});

export default router;
