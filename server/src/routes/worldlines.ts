import { Router, Request, Response } from 'express';
import * as db from '../services/database';
import { getArxivPaper } from '../services/arxiv';
import { computeWorldlineSimilarity } from '../services/similarity';

const router = Router();

function paramInt(val: string | string[]): number {
  return parseInt(String(val), 10);
}

// --- Similarity Scoring ---

// POST /api/worldlines/similarity — compute similarity between browse papers and worldlines
router.post('/similarity', async (req: Request, res: Response) => {
  try {
    const { papers, threshold } = req.body;
    if (!papers || !Array.isArray(papers)) {
      return res.status(400).json({ error: 'papers array is required' });
    }
    // Default threshold for SPECTER is 0.82; clamp old TF-IDF thresholds
    let t = typeof threshold === 'number' ? threshold : 0.82;
    if (t < 0.60) t = 0.82;

    const worldlineProfiles = db.getAllWorldlinesWithPapers()
      .filter(wl => wl.papers.length > 0)
      .map(wl => ({
        worldlineId: wl.id,
        worldlineName: wl.name,
        worldlineColor: wl.color,
        papers: wl.papers.map(p => ({ arxiv_id: p.arxiv_id, title: p.title, summary: p.summary })),
      }));

    if (worldlineProfiles.length === 0) {
      return res.json({ results: [] });
    }

    const results = await computeWorldlineSimilarity(
      papers.map((p: any) => ({ id: p.id, title: p.title, summary: p.summary })),
      worldlineProfiles,
      t
    );

    res.json({ results });
  } catch (error) {
    console.error('Similarity scoring error:', error);
    res.status(500).json({ error: 'Failed to compute similarity' });
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

    for (const arxivId of uniqueIds) {
      let paper = db.getPaperByArxivId(arxivId) as any;
      if (!paper) {
        try {
          const arxivPaper = await getArxivPaper(arxivId);
          if (!arxivPaper) {
            errors.push(`Not found: ${arxivId}`);
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
        } catch (err) {
          errors.push(`Failed to fetch: ${arxivId}`);
          continue;
        }
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
    db.addWorldlinePaper(paramInt(req.params.id), paper_id, position ?? 0);
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
    res.json({ success: true });
  } catch (error) {
    console.error('Remove worldline paper error:', error);
    res.status(500).json({ error: 'Failed to remove paper from worldline' });
  }
});

export default router;
