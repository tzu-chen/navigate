import { Router, Request, Response } from 'express';
import fs from 'fs';
import * as db from '../services/database';
import { SavedPaper } from '../types';
import { downloadAndStorePdf, getAbsolutePdfPath, deleteLocalPdf, arxivIdToFilename } from '../services/pdf';

const router = Router();
const SCRIBE_BASE = 'http://localhost:3003/api';

async function ensureNavigateFolder(): Promise<string> {
  const res = await fetch(`${SCRIBE_BASE}/folders`);
  if (!res.ok) throw new Error('Failed to fetch Scribe folders');
  const folders = await res.json() as { id: string; name: string }[];
  const existing = folders.find(f => f.name === 'Navigate');
  if (existing) return existing.id;

  const createRes = await fetch(`${SCRIBE_BASE}/folders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Navigate' }),
  });
  if (!createRes.ok) throw new Error('Failed to create Navigate folder in Scribe');
  const created = await createRes.json() as { id: string };
  return created.id;
}

async function uploadToScribe(pdfBuffer: Buffer, filename: string, subject: string, folderId: string): Promise<void> {
  const formData = new FormData();
  formData.append('file', new Blob([pdfBuffer], { type: 'application/pdf' }), filename);
  formData.append('subject', subject);
  formData.append('folder_id', folderId);

  const res = await fetch(`${SCRIBE_BASE}/attachments`, {
    method: 'POST',
    body: formData,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error?: string }).error || 'Upload to Scribe failed');
  }
}

// POST /api/scribe/send - Send papers to Scribe
router.post('/send', async (req: Request, res: Response) => {
  try {
    const { paper_ids } = req.body as { paper_ids: number[] };
    if (!Array.isArray(paper_ids) || paper_ids.length === 0) {
      return res.status(400).json({ error: 'paper_ids array is required' });
    }

    let folderId: string;
    try {
      folderId = await ensureNavigateFolder();
    } catch (error) {
      return res.status(502).json({ error: 'Cannot connect to Scribe. Is it running?' });
    }

    let sent = 0;
    const errors: string[] = [];

    for (const paperId of paper_ids) {
      try {
        const paper = db.getPaper(paperId) as SavedPaper | undefined;
        if (!paper) {
          errors.push(`Paper ${paperId} not found`);
          continue;
        }

        // Get PDF buffer
        let pdfPath = getAbsolutePdfPath(paper.arxiv_id);
        if (!fs.existsSync(pdfPath)) {
          const relativePath = await downloadAndStorePdf(paper.arxiv_id);
          if (!relativePath) {
            errors.push(`Failed to get PDF for "${paper.title}"`);
            continue;
          }
          pdfPath = getAbsolutePdfPath(paper.arxiv_id);
        }
        const pdfBuffer = fs.readFileSync(pdfPath);
        const filename = arxivIdToFilename(paper.arxiv_id);

        // Upload to Scribe
        await uploadToScribe(pdfBuffer, filename, paper.title, folderId);

        // Delete from Navigate
        if (paper.pdf_path) {
          deleteLocalPdf(paper.pdf_path);
        }
        db.deletePaper(paperId);
        sent++;
      } catch (error) {
        const errPaper = db.getPaper(paperId) as SavedPaper | undefined;
        const label = errPaper ? `"${errPaper.title}"` : `ID ${paperId}`;
        errors.push(`Failed to send ${label}: ${(error as Error).message}`);
      }
    }

    res.json({ sent, failed: errors.length, errors });
  } catch (error) {
    console.error('Send to Scribe error:', error);
    res.status(500).json({ error: 'Failed to send papers to Scribe' });
  }
});

export default router;
