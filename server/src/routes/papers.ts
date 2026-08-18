import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import * as db from '../services/database';
import { downloadAndStorePdf, deleteLocalPdf, resolveDbPdfPath, storeUploadedPdf } from '../services/pdf';

// Use require to avoid issues with multer type declarations
// eslint-disable-next-line @typescript-eslint/no-var-requires
const multer = require('multer');

const router = Router();
const upload = multer({ limits: { fileSize: 50 * 1024 * 1024 } }); // 50MB

function paramInt(val: string | string[]): number {
  return parseInt(String(val), 10);
}

// GET /api/papers - List all saved papers
router.get('/', (req: Request, res: Response) => {
  try {
    const { tag_id, tier } = req.query as Record<string, string>;
    let tierFilter: number | 'ungraded' | undefined;
    if (tier === 'ungraded') {
      tierFilter = 'ungraded';
    } else if (tier !== undefined && tier !== '') {
      const parsed = parseInt(tier, 10);
      if (parsed >= 0 && parsed <= 4) tierFilter = parsed;
    }
    const papers = db.getPapers({
      tag_id: tag_id ? parseInt(tag_id, 10) : undefined,
      tier: tierFilter,
    });
    res.json(papers);
  } catch (error) {
    console.error('Get papers error:', error);
    res.status(500).json({ error: 'Failed to get papers' });
  }
});

// POST /api/papers - Save a paper from arxiv
router.post('/', (req: Request, res: Response) => {
  try {
    const { arxiv_id, title, summary, authors, published, updated, categories, pdf_url, abs_url, doi, journal_ref } = req.body;

    if (!arxiv_id || !title) {
      return res.status(400).json({ error: 'arxiv_id and title are required' });
    }

    // Check if already saved
    const existing = db.getPaperByArxivId(arxiv_id);
    if (existing) {
      return res.json(existing);
    }

    const result = db.savePaper({
      arxiv_id,
      title,
      summary: summary || '',
      authors: typeof authors === 'string' ? authors : JSON.stringify(authors || []),
      published: published || new Date().toISOString(),
      updated: updated || new Date().toISOString(),
      categories: typeof categories === 'string' ? categories : JSON.stringify(categories || []),
      pdf_url: pdf_url || `https://arxiv.org/pdf/${arxiv_id}`,
      abs_url: abs_url || `https://arxiv.org/abs/${arxiv_id}`,
      doi,
      journal_ref,
    });

    const paper = db.getPaper(result.lastInsertRowid as number) as any;
    res.status(201).json(paper);

    // Fire-and-forget PDF download
    downloadAndStorePdf(arxiv_id)
      .then(pdfPath => {
        if (pdfPath && paper) {
          db.updatePaperPdfPath(paper.id, pdfPath);
        }
      })
      .catch(err => console.error(`Background PDF download failed for ${arxiv_id}:`, err));
  } catch (error) {
    console.error('Save paper error:', error);
    res.status(500).json({ error: 'Failed to save paper' });
  }
});

// POST /api/papers/upload - Upload a PDF as an external reference
router.post('/upload', upload.single('pdf'), async (req: Request, res: Response) => {
  try {
    const file = (req as any).file as { buffer: Buffer; originalname: string } | undefined;
    if (!file) {
      return res.status(400).json({ error: 'PDF file is required' });
    }

    const { title, authors, summary, categories, doi, journal_ref } = req.body;
    if (!title) {
      return res.status(400).json({ error: 'Title is required' });
    }

    const arxivId = `upload-${crypto.randomUUID()}`;
    const pdfPath = await storeUploadedPdf(file.buffer);

    const result = db.savePaper({
      arxiv_id: arxivId,
      title,
      summary: summary || '',
      authors: typeof authors === 'string' ? authors : JSON.stringify(authors || []),
      published: new Date().toISOString(),
      updated: new Date().toISOString(),
      categories: typeof categories === 'string' ? categories : JSON.stringify(categories || []),
      pdf_url: '',
      abs_url: '',
      doi: doi || undefined,
      journal_ref: journal_ref || undefined,
    });

    const paper = db.getPaper(result.lastInsertRowid as number) as any;
    if (paper) {
      db.updatePaperPdfPath(paper.id, pdfPath);
      paper.pdf_path = pdfPath;
    }

    res.status(201).json(paper);
  } catch (error) {
    console.error('Upload paper error:', error);
    res.status(500).json({ error: 'Failed to upload paper' });
  }
});

// GET /api/papers/comments/all - List every comment with parent paper info
// Must be above /:id routes so it isn't captured by the :id param
router.get('/comments/all', (_req: Request, res: Response) => {
  try {
    res.json(db.getAllComments());
  } catch (error) {
    console.error('Get all comments error:', error);
    res.status(500).json({ error: 'Failed to get comments' });
  }
});

// GET /api/papers/archive - The ever-saved ledger: every paper ever saved,
// including ones no longer stored here (handed to Scribe, or cleared out).
// This is what Scout reads, so it is worth being able to inspect directly.
// Must be above /:id routes so it isn't captured by the :id param
router.get('/archive', (req: Request, res: Response) => {
  try {
    const departedOnly = req.query.departed === 'true';
    const rows = departedOnly ? db.getDepartedPapers() : db.getPaperArchive();
    res.json(
      rows.map(row => ({
        ...row,
        authors: JSON.parse(row.authors || '[]'),
        categories: JSON.parse(row.categories || '[]'),
        tags: JSON.parse(row.tags || '[]'),
        worldlines: JSON.parse(row.worldlines || '[]'),
        inLibrary: row.removed_at === null,
      }))
    );
  } catch (error) {
    console.error('Get paper archive error:', error);
    res.status(500).json({ error: 'Failed to get paper archive' });
  }
});

// --- Bulk Operations (must be before /:id routes) ---

// POST /api/papers/bulk/download-pdfs
router.post('/bulk/download-pdfs', async (req: Request, res: Response) => {
  try {
    const { paper_ids } = req.body as { paper_ids: number[] };
    if (!paper_ids || !Array.isArray(paper_ids) || paper_ids.length === 0) {
      return res.status(400).json({ error: 'paper_ids array is required' });
    }

    const papers = db.getPapersByIds(paper_ids) as any[];
    let downloaded = 0;
    let failed = 0;
    const errors: string[] = [];

    for (const paper of papers) {
      if (paper.pdf_path) continue; // already has local PDF
      try {
        const pdfPath = await downloadAndStorePdf(paper.arxiv_id);
        if (pdfPath) {
          db.updatePaperPdfPath(paper.id, pdfPath);
          downloaded++;
        }
      } catch (err: any) {
        failed++;
        errors.push(`${paper.arxiv_id}: ${err.message}`);
      }
      // Rate limit: 1 second delay between ArXiv requests
      if (papers.indexOf(paper) < papers.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    res.json({ success: true, downloaded, failed, errors });
  } catch (error) {
    console.error('Bulk download PDFs error:', error);
    res.status(500).json({ error: 'Failed to bulk download PDFs' });
  }
});

// POST /api/papers/bulk/delete-pdfs
router.post('/bulk/delete-pdfs', (req: Request, res: Response) => {
  try {
    const { paper_ids } = req.body as { paper_ids: number[] };
    if (!paper_ids || !Array.isArray(paper_ids) || paper_ids.length === 0) {
      return res.status(400).json({ error: 'paper_ids array is required' });
    }

    const papers = db.getPapersByIds(paper_ids) as any[];
    let deleted = 0;

    for (const paper of papers) {
      if (paper.pdf_path) {
        deleteLocalPdf(paper.pdf_path);
        db.updatePaperPdfPath(paper.id, null);
        deleted++;
      }
    }

    res.json({ success: true, deleted });
  } catch (error) {
    console.error('Bulk delete PDFs error:', error);
    res.status(500).json({ error: 'Failed to bulk delete PDFs' });
  }
});

// POST /api/papers/bulk/delete
router.post('/bulk/delete', (req: Request, res: Response) => {
  try {
    const { paper_ids } = req.body as { paper_ids: number[] };
    if (!paper_ids || !Array.isArray(paper_ids) || paper_ids.length === 0) {
      return res.status(400).json({ error: 'paper_ids array is required' });
    }

    // Delete local PDFs first
    const papers = db.getPapersByIds(paper_ids) as any[];
    for (const paper of papers) {
      if (paper.pdf_path) {
        deleteLocalPdf(paper.pdf_path);
      }
    }

    const result = db.bulkDeletePapers(paper_ids);
    res.json({ success: true, deleted: result.changes });
  } catch (error) {
    console.error('Bulk delete papers error:', error);
    res.status(500).json({ error: 'Failed to bulk delete papers' });
  }
});

// POST /api/papers/bulk/tier
router.post('/bulk/tier', (req: Request, res: Response) => {
  try {
    const { paper_ids, tier } = req.body as { paper_ids: number[]; tier: number | null };
    if (!paper_ids || !Array.isArray(paper_ids) || paper_ids.length === 0) {
      return res.status(400).json({ error: 'paper_ids array is required' });
    }
    if (tier !== null && (typeof tier !== 'number' || tier < 0 || tier > 4)) {
      return res.status(400).json({ error: 'tier must be null or an integer 0–4' });
    }
    const result = db.bulkUpdateTier(paper_ids, tier);
    res.json({ success: true, updated: result.changes });
  } catch (error) {
    console.error('Bulk update tier error:', error);
    res.status(500).json({ error: 'Failed to bulk update tier' });
  }
});

// POST /api/papers/bulk/add-tag
router.post('/bulk/add-tag', (req: Request, res: Response) => {
  try {
    const { paper_ids, tag_id } = req.body as { paper_ids: number[]; tag_id: number };
    if (!paper_ids || !Array.isArray(paper_ids) || paper_ids.length === 0) {
      return res.status(400).json({ error: 'paper_ids array is required' });
    }
    if (!tag_id) {
      return res.status(400).json({ error: 'tag_id is required' });
    }

    const applied = db.bulkAddPaperTag(paper_ids, tag_id);
    res.json({ success: true, applied });
  } catch (error) {
    console.error('Bulk add tag error:', error);
    res.status(500).json({ error: 'Failed to bulk add tag' });
  }
});

// POST /api/papers/bulk/remove-tag
router.post('/bulk/remove-tag', (req: Request, res: Response) => {
  try {
    const { paper_ids, tag_id } = req.body as { paper_ids: number[]; tag_id: number };
    if (!paper_ids || !Array.isArray(paper_ids) || paper_ids.length === 0) {
      return res.status(400).json({ error: 'paper_ids array is required' });
    }
    if (!tag_id) {
      return res.status(400).json({ error: 'tag_id is required' });
    }

    const result = db.bulkRemovePaperTag(paper_ids, tag_id);
    res.json({ success: true, removed: result.changes });
  } catch (error) {
    console.error('Bulk remove tag error:', error);
    res.status(500).json({ error: 'Failed to bulk remove tag' });
  }
});

// --- Single Paper Operations ---

// GET /api/papers/:id - Get a specific paper
router.get('/:id', (req: Request, res: Response) => {
  try {
    const paper = db.getPaper(paramInt(req.params.id));
    if (!paper) {
      return res.status(404).json({ error: 'Paper not found' });
    }
    res.json(paper);
  } catch (error) {
    console.error('Get paper error:', error);
    res.status(500).json({ error: 'Failed to get paper' });
  }
});

// GET /api/papers/:id/pdf - Serve local PDF file
router.get('/:id/pdf', (req: Request, res: Response) => {
  try {
    const paper = db.getPaper(paramInt(req.params.id)) as any;
    if (!paper) {
      return res.status(404).json({ error: 'Paper not found' });
    }
    if (!paper.pdf_path) {
      return res.status(404).json({ error: 'No local PDF' });
    }

    const absPath = resolveDbPdfPath(paper.pdf_path);
    const fs = require('fs');
    if (!fs.existsSync(absPath)) {
      return res.status(404).json({ error: 'PDF file not found on disk' });
    }

    res.setHeader('Content-Type', 'application/pdf');
    const filename = paper.arxiv_id.startsWith('upload-')
      ? paper.title.replace(/[^a-zA-Z0-9\s-]/g, '').replace(/\s+/g, '_').slice(0, 80) + '.pdf'
      : paper.arxiv_id.replace('/', '_') + '.pdf';
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    res.sendFile(absPath);
  } catch (error) {
    console.error('Serve PDF error:', error);
    res.status(500).json({ error: 'Failed to serve PDF' });
  }
});

// POST /api/papers/:id/pdf - Download PDF for a single paper
router.post('/:id/pdf', async (req: Request, res: Response) => {
  try {
    const paper = db.getPaper(paramInt(req.params.id)) as any;
    if (!paper) {
      return res.status(404).json({ error: 'Paper not found' });
    }
    if (paper.pdf_path) {
      return res.json({ success: true, pdf_path: paper.pdf_path });
    }
    if (paper.arxiv_id.startsWith('upload-')) {
      return res.status(400).json({ error: 'Uploaded papers cannot be re-downloaded' });
    }

    const pdfPath = await downloadAndStorePdf(paper.arxiv_id);
    if (!pdfPath) {
      return res.status(502).json({ error: 'Failed to download PDF from ArXiv' });
    }
    db.updatePaperPdfPath(paper.id, pdfPath);
    res.json({ success: true, pdf_path: pdfPath });
  } catch (error) {
    console.error('Download PDF error:', error);
    res.status(500).json({ error: 'Failed to download PDF' });
  }
});

// DELETE /api/papers/:id/pdf - Delete local PDF, keep paper record
router.delete('/:id/pdf', (req: Request, res: Response) => {
  try {
    const paper = db.getPaper(paramInt(req.params.id)) as any;
    if (!paper) {
      return res.status(404).json({ error: 'Paper not found' });
    }

    if (paper.pdf_path) {
      deleteLocalPdf(paper.pdf_path);
      db.updatePaperPdfPath(paper.id, null);
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Delete PDF error:', error);
    res.status(500).json({ error: 'Failed to delete PDF' });
  }
});

// POST /api/papers/:id/view - Mark a paper as viewed (updates last_viewed_at)
router.post('/:id/view', (req: Request, res: Response) => {
  try {
    const paper = db.getPaper(paramInt(req.params.id));
    if (!paper) {
      return res.status(404).json({ error: 'Paper not found' });
    }
    db.touchPaperLastViewed(paramInt(req.params.id));
    res.json({ success: true });
  } catch (error) {
    console.error('Mark paper viewed error:', error);
    res.status(500).json({ error: 'Failed to mark paper viewed' });
  }
});

// PATCH /api/papers/:id/tier - Update paper tier (0–4, or null to ungrade)
router.patch('/:id/tier', (req: Request, res: Response) => {
  try {
    const { tier } = req.body as { tier: number | null };
    if (tier !== null && (typeof tier !== 'number' || tier < 0 || tier > 4)) {
      return res.status(400).json({ error: 'tier must be null or an integer 0–4' });
    }
    db.updatePaperTier(paramInt(req.params.id), tier);
    res.json({ success: true });
  } catch (error) {
    console.error('Update tier error:', error);
    res.status(500).json({ error: 'Failed to update tier' });
  }
});

// DELETE /api/papers/:id - Delete a paper
router.delete('/:id', (req: Request, res: Response) => {
  try {
    const paper = db.getPaper(paramInt(req.params.id)) as any;
    if (paper?.pdf_path) {
      deleteLocalPdf(paper.pdf_path);
    }
    db.deletePaper(paramInt(req.params.id));
    res.json({ success: true });
  } catch (error) {
    console.error('Delete paper error:', error);
    res.status(500).json({ error: 'Failed to delete paper' });
  }
});

// --- Comments ---

// GET /api/papers/:id/comments
router.get('/:id/comments', (req: Request, res: Response) => {
  try {
    const comments = db.getComments(paramInt(req.params.id));
    res.json(comments);
  } catch (error) {
    console.error('Get comments error:', error);
    res.status(500).json({ error: 'Failed to get comments' });
  }
});

// POST /api/papers/:id/comments
router.post('/:id/comments', (req: Request, res: Response) => {
  try {
    const { content, page_number, selected_text, position_rects } = req.body;
    if (!content) {
      return res.status(400).json({ error: 'Content is required' });
    }
    const result = db.addComment(
      paramInt(req.params.id),
      content,
      page_number,
      selected_text,
      position_rects
    );
    res.status(201).json({ id: result.lastInsertRowid, success: true });
  } catch (error) {
    console.error('Add comment error:', error);
    res.status(500).json({ error: 'Failed to add comment' });
  }
});

// PUT /api/papers/:id/comments/:commentId
router.put('/:id/comments/:commentId', (req: Request, res: Response) => {
  try {
    const { content } = req.body;
    if (!content) {
      return res.status(400).json({ error: 'Content is required' });
    }
    db.updateComment(paramInt(req.params.commentId), content);
    res.json({ success: true });
  } catch (error) {
    console.error('Update comment error:', error);
    res.status(500).json({ error: 'Failed to update comment' });
  }
});

// DELETE /api/papers/:id/comments/:commentId
router.delete('/:id/comments/:commentId', (req: Request, res: Response) => {
  try {
    db.deleteComment(paramInt(req.params.commentId));
    res.json({ success: true });
  } catch (error) {
    console.error('Delete comment error:', error);
    res.status(500).json({ error: 'Failed to delete comment' });
  }
});

// --- Tags ---

// GET /api/papers/:id/tags
router.get('/:id/tags', (req: Request, res: Response) => {
  try {
    const tags = db.getPaperTags(paramInt(req.params.id));
    res.json(tags);
  } catch (error) {
    console.error('Get paper tags error:', error);
    res.status(500).json({ error: 'Failed to get paper tags' });
  }
});

// POST /api/papers/:id/tags
router.post('/:id/tags', (req: Request, res: Response) => {
  try {
    const { tag_id } = req.body;
    if (!tag_id) {
      return res.status(400).json({ error: 'tag_id is required' });
    }
    db.addPaperTag(paramInt(req.params.id), tag_id);
    res.status(201).json({ success: true });
  } catch (error) {
    console.error('Add paper tag error:', error);
    res.status(500).json({ error: 'Failed to add paper tag' });
  }
});

// DELETE /api/papers/:id/tags/:tagId
router.delete('/:id/tags/:tagId', (req: Request, res: Response) => {
  try {
    db.removePaperTag(paramInt(req.params.id), paramInt(req.params.tagId));
    res.json({ success: true });
  } catch (error) {
    console.error('Remove paper tag error:', error);
    res.status(500).json({ error: 'Failed to remove paper tag' });
  }
});

export default router;
