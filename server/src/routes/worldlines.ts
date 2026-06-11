import { Router, Request, Response } from 'express';
import * as db from '../services/database';
import { getArxivPapers } from '../services/arxiv';
import { ArxivPaper } from '../types';
import { computeWorldlineSimilarity, PaperSimilarityResult } from '../services/similarity';

const router = Router();

function paramInt(val: string | string[]): number {
  return parseInt(String(val), 10);
}

// --- Similarity Cache ---
// Caches results per category until the next arXiv refresh (20:00 ET, Sun–Thu).
// Invalidated when worldlines are mutated (papers added/removed, worldline created/deleted).

const ANNOUNCEMENT_HOUR = 20; // 20:00 ET
const ANNOUNCEMENT_DAYS = new Set([0, 1, 2, 3, 4]); // Sun=0 through Thu=4

function getNextArxivRefreshTime(): number {
  const now = new Date();
  // Get current time in ET
  const etStr = now.toLocaleString('en-US', { timeZone: 'America/New_York' });
  const et = new Date(etStr);
  const currentDay = et.getDay();
  const currentSeconds = et.getHours() * 3600 + et.getMinutes() * 60 + et.getSeconds();
  const targetSeconds = ANNOUNCEMENT_HOUR * 3600;
  const isBeforeAnnouncement = currentSeconds < targetSeconds;

  let daysUntil: number;
  if (ANNOUNCEMENT_DAYS.has(currentDay) && isBeforeAnnouncement) {
    daysUntil = 0;
  } else {
    let next = (currentDay + 1) % 7;
    daysUntil = 1;
    while (!ANNOUNCEMENT_DAYS.has(next)) {
      next = (next + 1) % 7;
      daysUntil++;
    }
  }

  const remainingSeconds = daysUntil * 86400 + (targetSeconds - currentSeconds);
  return now.getTime() + remainingSeconds * 1000;
}

interface SimilarityCacheEntry {
  results: PaperSimilarityResult[];
  expiresAt: number; // timestamp ms
}

const similarityCache = new Map<string, SimilarityCacheEntry>();

function invalidateSimilarityCache() {
  similarityCache.clear();
}

// --- Similarity Scoring ---

// POST /api/worldlines/similarity — compute similarity between browse papers and worldlines
router.post('/similarity', async (req: Request, res: Response) => {
  try {
    const { papers, threshold, category, cohesionPercentile, selfMargin, margin, k } = req.body;
    if (!papers || !Array.isArray(papers)) {
      return res.status(400).json({ error: 'papers array is required' });
    }
    // Matching is per-thread cohesion-calibrated, narrowed by a self-margin + an
    // exclusivity margin, and gated by required corroboration (similarity-core.ts).
    // `threshold` no longer gates every thread; it is only the fallback bar for
    // threads too small to have a cohesion (<2 members). Clamp stray low/old
    // values to a sane cosine.
    let t = typeof threshold === 'number' ? threshold : 0.82;
    if (t < 0.60) t = 0.82;
    // Tunable knobs (precision-first defaults; see SimilarityOptions). The old
    // 0.5/median percentile + 0.02 margin admitted a flood of same-subtopic
    // papers, so the defaults are stricter.
    const percentile =
      typeof cohesionPercentile === 'number' && cohesionPercentile > 0 && cohesionPercentile < 1
        ? cohesionPercentile
        : 0.75;
    const selfMarginVal = typeof selfMargin === 'number' && selfMargin >= 0 ? selfMargin : 0.02;
    const marginVal = typeof margin === 'number' && margin >= 0 ? margin : 0.02;
    const kVal = Number.isInteger(k) && k >= 1 ? k : 3;

    // Check cache if category is provided
    const cacheKey = category ? `${category}:${t}:${percentile}:${selfMarginVal}:${marginVal}:${kVal}` : null;
    if (cacheKey) {
      const cached = similarityCache.get(cacheKey);
      if (cached && Date.now() < cached.expiresAt) {
        return res.json({ results: cached.results });
      }
    }

    const worldlineProfiles = db.getAllWorldlinesWithPapers()
      .filter(wl => wl.papers.length > 0)
      .map(wl => ({
        worldlineId: wl.id,
        worldlineName: wl.name,
        worldlineColor: wl.color,
        papers: wl.papers.map(p => ({ arxiv_id: p.arxiv_id, title: p.title, summary: p.summary, authors: p.authors })),
      }));

    if (worldlineProfiles.length === 0) {
      return res.json({ results: [] });
    }

    const results = await computeWorldlineSimilarity(
      papers.map((p: any) => ({ id: p.id, title: p.title, summary: p.summary, authors: Array.isArray(p.authors) ? p.authors : [] })),
      worldlineProfiles,
      { fallbackThreshold: t, cohesionPercentile: percentile, selfMargin: selfMarginVal, margin: marginVal, k: kVal }
    );

    // Record each flag for tuning/telemetry. Idempotent per (paper, worldline):
    // re-computation won't duplicate rows or clear accept/reject decisions.
    for (const r of results) {
      for (const m of r.matches) {
        db.logFlag({
          arxiv_id: r.paperId,
          worldline_id: m.worldlineId,
          score: m.score,
          runner_up_score: m.runnerUpScore ?? null,
          margin: marginVal,
          corroboration_kind: m.corroborationKind ?? 'terms',
          category: category ?? null,
        });
      }
    }

    // Cache results until next arXiv refresh
    if (cacheKey) {
      similarityCache.set(cacheKey, {
        results,
        expiresAt: getNextArxivRefreshTime(),
      });
    }

    res.json({ results });
  } catch (error) {
    console.error('Similarity scoring error:', error);
    res.status(500).json({ error: 'Failed to compute similarity' });
  }
});

// POST /api/worldlines/flag/dismiss — reject a flagged (paper, worldline) suggestion
router.post('/flag/dismiss', (req: Request, res: Response) => {
  try {
    const { arxiv_id, worldline_id } = req.body;
    if (!arxiv_id || !worldline_id) {
      return res.status(400).json({ error: 'arxiv_id and worldline_id are required' });
    }
    db.markFlagDismissed(String(arxiv_id), paramInt(worldline_id));
    res.json({ success: true });
  } catch (error) {
    console.error('Dismiss flag error:', error);
    res.status(500).json({ error: 'Failed to dismiss flag' });
  }
});

// GET /api/worldlines/flag-stats — diagnostic acceptance telemetry (overall + per category)
router.get('/flag-stats', (_req: Request, res: Response) => {
  try {
    res.json(db.getFlagStats());
  } catch (error) {
    console.error('Flag stats error:', error);
    res.status(500).json({ error: 'Failed to get flag stats' });
  }
});

// POST /api/worldlines/batch-import — batch import papers, assign to worldline and/or tags
router.post('/batch-import', async (req: Request, res: Response) => {
  try {
    const { arxiv_ids, worldline_name, worldline_color, worldline_id, worldline_ids, new_worldlines, tag_ids } = req.body;

    if (!arxiv_ids || !Array.isArray(arxiv_ids) || arxiv_ids.length === 0) {
      return res.status(400).json({ error: 'arxiv_ids array is required' });
    }

    // Normalize IDs: strip version suffixes (e.g. "2301.00001v1" -> "2301.00001")
    const cleanIds = arxiv_ids
      .map((id: string) => id.trim())
      .filter((id: string) => id.length > 0)
      .map((id: string) => id.replace(/v\d+$/, ''));

    const uniqueIds = [...new Set(cleanIds)] as string[];

    // Step 1: Save all papers to library
    const paperMap = new Map<string, number>(); // arxiv_id -> paper.id
    const savedPapers: any[] = [];
    const errors: string[] = [];

    // Prefetch any papers not already in the DB in a single batched arXiv call
    const missingIds = uniqueIds.filter(id => !db.getPaperByArxivId(id));
    let fetched = new Map<string, ArxivPaper>();
    if (missingIds.length > 0) {
      try {
        fetched = await getArxivPapers(missingIds);
      } catch (err) {
        console.error('Batch ArXiv fetch failed:', err);
        for (const id of missingIds) errors.push(`Failed to fetch: ${id}`);
      }
    }

    for (const arxivId of uniqueIds) {
      let paper = db.getPaperByArxivId(arxivId) as any;
      if (!paper) {
        const arxivPaper = fetched.get(arxivId);
        if (!arxivPaper) {
          if (!errors.some(e => e.endsWith(arxivId))) {
            errors.push(`Not found: ${arxivId}`);
          }
          continue;
        }
        const result = db.savePaper({
          arxiv_id: arxivPaper.id,
          title: arxivPaper.title,
          summary: arxivPaper.summary,
          authors: JSON.stringify(arxivPaper.authors),
          published: arxivPaper.published,
          updated: arxivPaper.updated,
          categories: JSON.stringify(arxivPaper.categories),
          pdf_url: arxivPaper.pdfUrl,
          abs_url: arxivPaper.absUrl,
          doi: arxivPaper.doi,
          journal_ref: arxivPaper.journalRef,
        });
        paper = db.getPaper(result.lastInsertRowid as number);
      }
      paperMap.set(arxivId, paper.id);
      savedPapers.push(paper);
    }

    // Step 2: Optionally create/assign worldlines (supports multiple)
    const targetWorldlineIds: number[] = [];

    // Multiple existing worldline IDs
    if (worldline_ids && Array.isArray(worldline_ids)) {
      targetWorldlineIds.push(...worldline_ids);
    }
    // Legacy single worldline_id
    if (worldline_id && !worldline_ids) {
      targetWorldlineIds.push(worldline_id);
    }
    // Multiple new worldlines to create
    if (new_worldlines && Array.isArray(new_worldlines)) {
      for (const nw of new_worldlines) {
        if (nw.name && nw.name.trim()) {
          const wlResult = db.createWorldline(nw.name.trim(), nw.color || '#6366f1');
          targetWorldlineIds.push(wlResult.lastInsertRowid as number);
        }
      }
    }
    // Legacy single worldline_name
    if (worldline_name && worldline_name.trim() && !new_worldlines) {
      const wlResult = db.createWorldline(worldline_name.trim(), worldline_color || '#6366f1');
      targetWorldlineIds.push(wlResult.lastInsertRowid as number);
    }

    // Add papers sorted by publication date
    const sortedPapers = savedPapers.sort(
      (a, b) => new Date(a.published).getTime() - new Date(b.published).getTime()
    );

    for (const wlId of targetWorldlineIds) {
      const existingPapers = db.getWorldlinePapers(wlId);
      const positionOffset = existingPapers.length;
      for (let i = 0; i < sortedPapers.length; i++) {
        try {
          db.addWorldlinePaper(wlId, sortedPapers[i].id, positionOffset + i);
          db.markFlagAccepted(sortedPapers[i].arxiv_id, wlId);
        } catch {
          // paper may already be in worldline — ignore
        }
      }
    }

    // Step 3: Optionally apply tags to all imported papers
    let tagsApplied = 0;
    if (tag_ids && Array.isArray(tag_ids) && tag_ids.length > 0) {
      for (const paper of savedPapers) {
        for (const tagId of tag_ids) {
          try {
            db.addPaperTag(paper.id, tagId);
            tagsApplied++;
          } catch {
            // tag may already be applied — ignore
          }
        }
      }
    }

    if (targetWorldlineIds.length > 0) {
      invalidateSimilarityCache();
    }

    res.status(201).json({
      success: true,
      papers_added: savedPapers.length,
      worldline_ids: targetWorldlineIds,
      tags_applied: tagsApplied,
      errors,
    });
  } catch (error) {
    console.error('Batch import error:', error);
    res.status(500).json({ error: 'Failed to batch import papers' });
  }
});

// --- Related Papers ---

// GET /api/worldlines/related-papers/:arxivId — get arxiv IDs of papers in the same worldlines
router.get('/related-papers/:arxivId', (req: Request, res: Response) => {
  try {
    const arxivId = String(req.params.arxivId);
    const related = db.getRelatedPaperArxivIdsByArxivId(arxivId);
    res.json(related);
  } catch (error) {
    console.error('Get related papers error:', error);
    res.status(500).json({ error: 'Failed to get related papers' });
  }
});

// --- Worldlines ---

// GET /api/worldlines/associations - Map of paper_id -> worldline_id[]
router.get('/associations', (_req: Request, res: Response) => {
  try {
    const rows = db.getAllWorldlinePaperAssociations();
    const map: Record<number, number[]> = {};
    for (const { paper_id, worldline_id } of rows) {
      if (!map[paper_id]) map[paper_id] = [];
      map[paper_id].push(worldline_id);
    }
    res.json(map);
  } catch (error) {
    console.error('Get worldline associations error:', error);
    res.status(500).json({ error: 'Failed to get worldline associations' });
  }
});

// GET /api/worldlines - List all worldlines
router.get('/', (_req: Request, res: Response) => {
  try {
    const worldlines = db.getWorldlines();
    res.json(worldlines);
  } catch (error) {
    console.error('Get worldlines error:', error);
    res.status(500).json({ error: 'Failed to get worldlines' });
  }
});

// POST /api/worldlines - Create a worldline
router.post('/', (req: Request, res: Response) => {
  try {
    const { name, color } = req.body;
    if (!name) {
      return res.status(400).json({ error: 'name is required' });
    }
    const result = db.createWorldline(name, color || '#6366f1');
    invalidateSimilarityCache();
    res.status(201).json({ id: result.lastInsertRowid, name, color: color || '#6366f1' });
  } catch (error) {
    console.error('Create worldline error:', error);
    res.status(500).json({ error: 'Failed to create worldline' });
  }
});

// PUT /api/worldlines/:id - Update a worldline
router.put('/:id', (req: Request, res: Response) => {
  try {
    const { name, color } = req.body;
    if (!name) {
      return res.status(400).json({ error: 'name is required' });
    }
    db.updateWorldline(paramInt(req.params.id), name, color || '#6366f1');
    res.json({ success: true });
  } catch (error) {
    console.error('Update worldline error:', error);
    res.status(500).json({ error: 'Failed to update worldline' });
  }
});

// DELETE /api/worldlines/:id - Delete a worldline
router.delete('/:id', (req: Request, res: Response) => {
  try {
    db.deleteWorldline(paramInt(req.params.id));
    invalidateSimilarityCache();
    res.json({ success: true });
  } catch (error) {
    console.error('Delete worldline error:', error);
    res.status(500).json({ error: 'Failed to delete worldline' });
  }
});

// GET /api/worldlines/:id/papers - Get papers in a worldline
router.get('/:id/papers', (req: Request, res: Response) => {
  try {
    const papers = db.getWorldlinePapers(paramInt(req.params.id));
    res.json(papers);
  } catch (error) {
    console.error('Get worldline papers error:', error);
    res.status(500).json({ error: 'Failed to get worldline papers' });
  }
});

// POST /api/worldlines/:id/papers - Add a paper to a worldline
router.post('/:id/papers', (req: Request, res: Response) => {
  try {
    const { paper_id, position } = req.body;
    if (!paper_id) {
      return res.status(400).json({ error: 'paper_id is required' });
    }
    const wlId = paramInt(req.params.id);
    db.addWorldlinePaper(wlId, paper_id, position ?? 0);
    // Assigning a paper to a worldline accepts any pending flag for that pair.
    const paper = db.getPaper(paper_id) as { arxiv_id?: string } | undefined;
    if (paper?.arxiv_id) db.markFlagAccepted(paper.arxiv_id, wlId);
    invalidateSimilarityCache();
    res.status(201).json({ success: true });
  } catch (error) {
    console.error('Add worldline paper error:', error);
    res.status(500).json({ error: 'Failed to add paper to worldline' });
  }
});

// DELETE /api/worldlines/:id/papers/:paperId - Remove a paper from a worldline
router.delete('/:id/papers/:paperId', (req: Request, res: Response) => {
  try {
    db.removeWorldlinePaper(paramInt(req.params.id), paramInt(req.params.paperId));
    invalidateSimilarityCache();
    res.json({ success: true });
  } catch (error) {
    console.error('Remove worldline paper error:', error);
    res.status(500).json({ error: 'Failed to remove paper from worldline' });
  }
});

export default router;
