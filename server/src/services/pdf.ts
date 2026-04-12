import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const PDF_DIR = path.join(DATA_DIR, 'pdfs');

export function initializePdfStorage(): void {
  if (!fs.existsSync(PDF_DIR)) {
    fs.mkdirSync(PDF_DIR, { recursive: true });
  }
}

export function arxivIdToFilename(arxivId: string): string {
  return arxivId.replace(/\//g, '_') + '.pdf';
}

export function getRelativePdfPath(arxivId: string): string {
  return `pdfs/${arxivIdToFilename(arxivId)}`;
}

export function getAbsolutePdfPath(arxivId: string): string {
  return path.join(PDF_DIR, arxivIdToFilename(arxivId));
}

export function resolveDbPdfPath(relativePath: string): string {
  return path.join(DATA_DIR, relativePath);
}

export function localPdfExists(arxivId: string): boolean {
  return fs.existsSync(getAbsolutePdfPath(arxivId));
}

export async function downloadAndStorePdf(arxivId: string): Promise<string | null> {
  initializePdfStorage();

  const absPath = getAbsolutePdfPath(arxivId);
  const relativePath = getRelativePdfPath(arxivId);

  if (fs.existsSync(absPath)) {
    return relativePath;
  }

  const pdfUrl = `https://arxiv.org/pdf/${arxivId}`;
  const response = await fetch(pdfUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch PDF: ${response.status} ${response.statusText}`);
  }

  const buffer = await response.arrayBuffer();
  fs.writeFileSync(absPath, Buffer.from(buffer));

  return relativePath;
}

export function deleteLocalPdf(relativePath: string): boolean {
  const absPath = resolveDbPdfPath(relativePath);
  if (fs.existsSync(absPath)) {
    fs.unlinkSync(absPath);
    return true;
  }
  return false;
}

export function getLocalPdfPathForArxivId(arxivId: string): string | null {
  const absPath = getAbsolutePdfPath(arxivId);
  return fs.existsSync(absPath) ? absPath : null;
}

export async function storeUploadedPdf(buffer: Buffer): Promise<string> {
  initializePdfStorage();
  const uuid = crypto.randomUUID();
  const filename = `upload-${uuid}.pdf`;
  const absPath = path.join(PDF_DIR, filename);
  fs.writeFileSync(absPath, buffer);
  return `pdfs/${filename}`;
}
