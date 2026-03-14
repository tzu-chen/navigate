import { Router, Request, Response } from 'express';
import * as db from '../services/database';
import { generateBibtex, generateBibtexBundle, generatePaperpileMetadata, parseBibtex } from '../services/paperpile';
import { downloadAndStorePdf } from '../services/pdf';
import { SavedPaper, Comment, Tag } from '../types';

const router = Router();

function paramInt(val: string | string[]): number {
  return parseInt(String(val), 10);
}

// GET /api/export/bibtex/:id - Export single paper as BibTeX
router.get('/bibtex/:id', (req: Request, res: Response) => {
  try {
    const paper = db.getPaper(paramInt(req.params.id)) as SavedPaper | undefined;
    if (!paper) {
      return res.status(404).json({ error: 'Paper not found' });
    }

    const tags = db.getPaperTags(paper.id) as Tag[];
    const comments = db.getComments(paper.id) as Comment[];
    const bibtex = generateBibtex(paper, tags, comments);

    if (req.query.download === 'true') {
      res.setHeader('Content-Type', 'application/x-bibtex');
      res.setHeader('Content-Disposition', `attachment; filename="${paper.arxiv_id.replace('/', '_')}.bib"`);
    } else {
      res.setHeader('Content-Type', 'text/plain');
    }
    res.send(bibtex);
  } catch (error) {
    console.error('BibTeX export error:', error);
    res.status(500).json({ error: 'Failed to export BibTeX' });
  }
});

// GET /api/export/bibtex - Export saved papers as BibTeX (optionally filtered by IDs)
router.get('/bibtex', (req: Request, res: Response) => {
  try {
    let papers: SavedPaper[];
    if (req.query.ids) {
      const ids = String(req.query.ids).split(',').map(id => parseInt(id, 10)).filter(id => !isNaN(id));
      const allPapers = db.getPapers() as SavedPaper[];
      const idSet = new Set(ids);
      papers = allPapers.filter(p => idSet.has(p.id));
    } else {
      papers = db.getPapers() as SavedPaper[];
    }

    const bundle = papers.map(paper => ({
      paper,
      tags: db.getPaperTags(paper.id) as Tag[],
      comments: db.getComments(paper.id) as Comment[],
    }));

    const bibtex = generateBibtexBundle(bundle);

    if (req.query.download === 'true') {
      res.setHeader('Content-Type', 'application/x-bibtex');
      res.setHeader('Content-Disposition', 'attachment; filename="papers.bib"');
    } else {
      res.setHeader('Content-Type', 'text/plain');
    }
    res.send(bibtex);
  } catch (error) {
    console.error('BibTeX bundle export error:', error);
    res.status(500).json({ error: 'Failed to export BibTeX bundle' });
  }
});

// GET /api/export/paperpile/:id - Export paper metadata for Paperpile
router.get('/paperpile/:id', (req: Request, res: Response) => {
  try {
    const paper = db.getPaper(paramInt(req.params.id)) as SavedPaper | undefined;
    if (!paper) {
      return res.status(404).json({ error: 'Paper not found' });
    }

    const tags = db.getPaperTags(paper.id) as Tag[];
    const comments = db.getComments(paper.id) as Comment[];
    const metadata = generatePaperpileMetadata(paper, tags, comments);

    res.json(metadata);
  } catch (error) {
    console.error('Paperpile export error:', error);
    res.status(500).json({ error: 'Failed to export for Paperpile' });
  }
});

// GET /api/export/paperpile - Export all papers for Paperpile
router.get('/paperpile', (req: Request, res: Response) => {
  try {
    const papers = db.getPapers() as SavedPaper[];

    const metadata = papers.map(paper => {
      const tags = db.getPaperTags(paper.id) as Tag[];
      const comments = db.getComments(paper.id) as Comment[];
      return generatePaperpileMetadata(paper, tags, comments);
    });

    if (req.query.download === 'true') {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', 'attachment; filename="paperpile_export.json"');
    }
    res.json(metadata);
  } catch (error) {
    console.error('Paperpile bundle export error:', error);
    res.status(500).json({ error: 'Failed to export for Paperpile' });
  }
});

// POST /api/export/import-bibtex - Import papers from BibTeX
router.post('/import-bibtex', (req: Request, res: Response) => {
  try {
    const { bibtex } = req.body;
    if (!bibtex || typeof bibtex !== 'string') {
      return res.status(400).json({ error: 'bibtex string is required' });
    }

    const entries = parseBibtex(bibtex);
    if (entries.length === 0) {
      return res.status(400).json({ error: 'No valid BibTeX entries found' });
    }

    let papersAdded = 0;
    let papersSkipped = 0;
    let tagsApplied = 0;
    let commentsAdded = 0;
    const errors: string[] = [];

    // Load existing tags for keyword matching
    const existingTags = db.getTags() as Tag[];
    const tagByName = new Map(existingTags.map(t => [t.name.toLowerCase(), t]));

    for (const entry of entries) {
      try {
        // Check if paper already exists
        const existing = db.getPaperByArxivId(entry.arxiv_id) as SavedPaper | undefined;
        let paperId: number;

        if (existing) {
          paperId = existing.id;
          papersSkipped++;
        } else {
          const result = db.savePaper({
            arxiv_id: entry.arxiv_id,
            title: entry.title,
            summary: entry.summary,
            authors: JSON.stringify(entry.authors),
            published: `${entry.year}-01-01T00:00:00Z`,
            updated: `${entry.year}-01-01T00:00:00Z`,
            categories: JSON.stringify(entry.categories),
            pdf_url: `https://arxiv.org/pdf/${entry.arxiv_id}`,
            abs_url: entry.url || `https://arxiv.org/abs/${entry.arxiv_id}`,
            doi: entry.doi,
            journal_ref: entry.journal_ref,
          });
          paperId = result.lastInsertRowid as number;
          papersAdded++;

          // Fire-and-forget PDF download
          downloadAndStorePdf(entry.arxiv_id)
            .then(pdfPath => {
              if (pdfPath) {
                db.updatePaperPdfPath(paperId, pdfPath);
              }
            })
            .catch(err => console.error(`Background PDF download failed for ${entry.arxiv_id}:`, err));
        }

        // Apply tags from keywords
        for (const keyword of entry.keywords) {
          let tag = tagByName.get(keyword.toLowerCase());
          if (!tag) {
            const result = db.createTag(keyword);
            tag = { id: result.lastInsertRowid as number, name: keyword, color: '#6366f1' };
            tagByName.set(keyword.toLowerCase(), tag);
          }
          db.addPaperTag(paperId, tag.id);
          tagsApplied++;
        }

        // Add comments from notes (only for new papers)
        if (!existing) {
          for (const note of entry.notes) {
            db.addComment(paperId, note.content, note.page_number);
            commentsAdded++;
          }
        }
      } catch (err: any) {
        errors.push(`${entry.arxiv_id}: ${err.message || 'Unknown error'}`);
      }
    }

    res.json({
      papers_added: papersAdded,
      papers_skipped: papersSkipped,
      tags_applied: tagsApplied,
      comments_added: commentsAdded,
      total_entries: entries.length,
      errors,
    });
  } catch (error) {
    console.error('BibTeX import error:', error);
    res.status(500).json({ error: 'Failed to import BibTeX' });
  }
});

// POST /api/export/mark-exported/:id - Mark a paper as exported
router.post('/mark-exported/:id', (req: Request, res: Response) => {
  try {
    db.updatePaperStatus(paramInt(req.params.id), 'exported');
    res.json({ success: true });
  } catch (error) {
    console.error('Mark exported error:', error);
    res.status(500).json({ error: 'Failed to mark as exported' });
  }
});

export default router;
