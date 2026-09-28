import { Router, Request, Response } from 'express';
import * as db from '../services/database';
import { ArxivAuthorRateLimitError, searchByAuthor } from '../services/arxiv';
import { ArxivPaper } from '../types';

const router = Router();

// GET /api/authors/favorites - List all favorite authors
router.get('/favorites', (_req: Request, res: Response) => {
  try {
    const authors = db.getFavoriteAuthors();
    res.json(authors);
  } catch (error) {
    console.error('Failed to get favorite authors:', error);
    res.status(500).json({ error: 'Failed to get favorite authors' });
  }
});

// POST /api/authors/favorites - Add a favorite author
router.post('/favorites', (req: Request, res: Response) => {
  try {
    const { name } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Author name is required' });
    }

    const trimmed = name.trim();
    const existing = db.getFavoriteAuthorByName(trimmed);
    if (existing) {
      return res.status(409).json({ error: 'Author is already in favorites' });
    }

    const result = db.addFavoriteAuthor(trimmed);
    res.status(201).json({ id: result.lastInsertRowid, name: trimmed });
  } catch (error) {
    console.error('Failed to add favorite author:', error);
    res.status(500).json({ error: 'Failed to add favorite author' });
  }
});

// DELETE /api/authors/favorites/:id - Remove a favorite author
router.delete('/favorites/:id', (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    db.removeFavoriteAuthor(id);
    res.json({ success: true });
  } catch (error) {
    console.error('Failed to remove favorite author:', error);
    res.status(500).json({ error: 'Failed to remove favorite author' });
  }
});

// GET /api/authors/favorites/publications - Get recent publications from all favorite authors
router.get('/favorites/publications', async (_req: Request, res: Response) => {
  let disconnected = false;
  res.on('close', () => { if (!res.writableEnded) disconnected = true; });
  try {
    const authors = db.getFavoriteAuthors() as Array<{ id: number; name: string; added_at: string }>;
    if (authors.length === 0) {
      return res.json({ papers: [], failedAuthors: [], rateLimited: false });
    }

    const allPapers: (ArxivPaper & { matchedAuthor: string })[] = [];
    const seenIds = new Set<string>();
    const failedAuthors: string[] = [];
    let rateLimited = false;

    // The API gate spaces requests; run searches sequentially so a 429 stops
    // further uncached searches via searchByAuthor's shared cooldown.
    for (const author of authors) {
      if (disconnected) return;
      try {
        const result = await searchByAuthor(author.name, 10);
        for (const paper of result.papers) {
          if (!seenIds.has(paper.id)) {
            seenIds.add(paper.id);
            allPapers.push({ ...paper, matchedAuthor: author.name });
          }
        }
      } catch (err) {
        failedAuthors.push(author.name);
        if (err instanceof ArxivAuthorRateLimitError) rateLimited = true;
        else console.error(`Failed to search papers for ${author.name}:`, err);
      }
    }

    // Sort by published date descending
    allPapers.sort((a, b) => new Date(b.published).getTime() - new Date(a.published).getTime());

    if (!disconnected) res.json({ papers: allPapers, failedAuthors, rateLimited });
  } catch (error) {
    console.error('Failed to get favorite author publications:', error);
    res.status(500).json({ error: 'Failed to get publications' });
  }
});

export default router;
