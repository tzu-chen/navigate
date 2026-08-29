import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import zlib from 'zlib';
import { arxivFetch } from './arxiv';
import { DATA_DIR } from './paths';

/**
 * Stage 1 of the walkthrough pipeline: acquire a paper's LaTeX source.
 *
 * The PDF is a *rendering*; the source is what the rendering was made from.
 * Everything a walkthrough builder (or a chat about the paper) needs and a PDF
 * reader has to reconstruct — which symbol means what, which equation is *the*
 * equation, what the author called this object — is present verbatim in the
 * source and costs no inference.
 *
 * Endpoint behaviour, measured 2026-08-28:
 *   - https://arxiv.org/e-print/<id> 301s to /src/<id>. Follow redirects.
 *   - The response is *always* `content-type: application/gzip`. The content
 *     type does not tell you the container; `content-disposition`'s filename
 *     does, and magic bytes confirm it:
 *       arXiv-1706.03762v7.tar.gz     → gzipped tar (the common modern case)
 *       arXiv-hep-th9711200v3.gz      → a bare gzipped single file
 *       …​.pdf                         → a PDF-only submission, no source exists
 *   - The filename also carries the version actually served (v7). A walkthrough
 *     is built against a specific version, so it is recorded.
 *
 * The tar reader here is hand-rolled rather than a dependency. The format is
 * simple, and writing it means the path-safety guarantees on the security
 * checklist (no `..`, no absolute paths, no symlinks or device nodes, per-file
 * and total byte caps) are enforced by code that can be unit-tested directly.
 */

// --- Bounds ------------------------------------------------------------------

/** Cap on the downloaded package. `2312.11805` (Gemini) is a 27 MB tarball. */
export const MAX_SOURCE_BYTES = 50 * 1024 * 1024;
/** Cap on what a package may expand to, so a zip-bomb-shaped tarball can't fill the disk. */
export const MAX_EXTRACTED_BYTES = 200 * 1024 * 1024;
/** Cap on any single extracted file. */
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
/** LRU budget for the whole source cache, evicted by directory atime. */
export const TEX_CACHE_BUDGET_BYTES = 1024 * 1024 * 1024;

export const TEX_CACHE_DIR = path.join(DATA_DIR, 'tex');

/** Text-ish files worth keeping. Everything else in a package is build detritus. */
const TEXT_EXTENSIONS = new Set(['.tex', '.sty', '.cls', '.bbl', '.bib', '.txt', '.ltx', '.clo']);
/** Rasters can be surfaced in a walkthrough directly. Vector figures are usually
 *  PDF/EPS; v1 links those to the PDF page instead of converting, so they are
 *  named in the manifest but not extracted. */
const RASTER_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);

// --- Types -------------------------------------------------------------------

export type PackageKind = 'tar' | 'single-tex' | 'pdf-only';
export type SourceOrigin = 'eprint' | 'latexml' | 'none';
export type SourceFileKind = 'tex' | 'style' | 'bib' | 'raster' | 'text';

export interface SourceFile {
  /** Path relative to the package root, POSIX separators. */
  path: string;
  bytes: number;
  kind: SourceFileKind;
}

export interface SourcePackage {
  arxivId: string;
  /** The version arXiv actually served, e.g. 'v7'. Null when it could not be read. */
  version: string | null;
  kind: PackageKind | null;
  origin: SourceOrigin;
  /** sha256 of the downloaded package — half the build cache key. */
  sha256: string;
  /** Absolute path to the directory holding the extracted files. */
  dir: string;
  files: SourceFile[];
  /** Every regular-file entry name in the archive, including ones not extracted.
   *  Figure resolution needs to know that `figure1` was a .pdf even though the
   *  .pdf itself was skipped. */
  entryNames: string[];
  warnings: string[];
  fetchedAt: string;
}

// --- Package classification (pure) -------------------------------------------

/**
 * Read the served filename out of a `content-disposition` header.
 * Exported for the verify harness: this is the only thing that distinguishes a
 * tarball from a bare gzipped .tex from a PDF-only submission before any bytes
 * are decompressed, and it carries the version number.
 */
export function parseContentDisposition(header: string | null): {
  filename: string | null;
  version: string | null;
} {
  if (!header) return { filename: null, version: null };
  const quoted = header.match(/filename\s*=\s*"([^"]+)"/i);
  const bare = header.match(/filename\s*=\s*([^;]+)/i);
  const filename = (quoted?.[1] ?? bare?.[1] ?? '').trim() || null;
  if (!filename) return { filename: null, version: null };
  // arXiv-1706.03762v7.tar.gz / arXiv-hep-th9711200v3.gz
  const version = filename.match(/(v\d+)\.(?:tar\.gz|gz|pdf)$/i)?.[1] ?? null;
  return { filename, version };
}

/**
 * Identify a container from its leading bytes. Belt and braces against a
 * `content-disposition` that is missing or lies: the content type never tells
 * the truth here, so the bytes are the final authority.
 */
export function sniffContainer(buf: Buffer): 'gzip' | 'tar' | 'pdf' | 'text' {
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) return 'gzip';
  if (buf.length >= 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  // The ustar magic sits at offset 257 of the first header block.
  if (buf.length >= 262 && buf.subarray(257, 262).toString('latin1') === 'ustar') return 'tar';
  return 'text';
}

/** Original filename recorded in a gzip header (FNAME flag), if present. */
export function gzipOriginalName(buf: Buffer): string | null {
  if (buf.length < 10 || buf[0] !== 0x1f || buf[1] !== 0x8b) return null;
  const flags = buf[3];
  if (!(flags & 0x08)) return null; // FNAME not set
  let offset = 10;
  if (flags & 0x04) {
    // FEXTRA: 2-byte length followed by that many bytes
    if (buf.length < offset + 2) return null;
    offset += 2 + buf.readUInt16LE(offset);
  }
  const end = buf.indexOf(0, offset);
  if (end === -1 || end <= offset) return null;
  return buf.subarray(offset, end).toString('latin1');
}

// --- Tar reading (pure) ------------------------------------------------------

export interface TarEntry {
  name: string;
  /** POSIX typeflag: '0'/'\0' regular, '5' dir, '2' symlink, '3'/'4' device… */
  type: string;
  size: number;
  data: Buffer;
}

function readOctal(buf: Buffer, offset: number, length: number): number {
  const raw = buf.subarray(offset, offset + length).toString('latin1').replace(/\0.*$/, '').trim();
  if (!raw) return 0;
  const value = parseInt(raw, 8);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function readString(buf: Buffer, offset: number, length: number): string {
  return buf.subarray(offset, offset + length).toString('utf8').replace(/\0.*$/, '');
}

/**
 * Parse a tar archive into its entries. Handles the GNU long-name ('L') and pax
 * ('x') extensions, which arXiv packages built by older toolchains do use.
 *
 * Pure and buffer-in/entries-out so `verify:walkthrough` can feed it a
 * hand-built malicious archive without touching the filesystem.
 */
export function parseTar(buf: Buffer): TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;
  let pendingLongName: string | null = null;

  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512);

    // Two consecutive zero blocks terminate the archive; one is enough for us.
    if (header.every(b => b === 0)) break;

    const size = readOctal(header, 124, 12);
    const type = header.subarray(156, 157).toString('latin1') || '0';
    const prefix = readString(header, 345, 155);
    const rawName = readString(header, 0, 100);
    const name = pendingLongName ?? (prefix ? `${prefix}/${rawName}` : rawName);
    pendingLongName = null;

    const dataStart = offset + 512;
    const dataEnd = Math.min(dataStart + size, buf.length);
    const data = buf.subarray(dataStart, dataEnd);
    // Entry bodies are padded to a 512-byte boundary.
    offset = dataStart + Math.ceil(size / 512) * 512;

    if (type === 'L') {
      // GNU long name: the body is the name of the *next* entry.
      pendingLongName = data.toString('utf8').replace(/\0.*$/, '');
      continue;
    }
    if (type === 'x' || type === 'g') {
      // pax extended header: "<len> path=<value>\n" records.
      const match = data.toString('utf8').match(/\d+ path=([^\n]*)\n/);
      if (match && type === 'x') pendingLongName = match[1];
      continue;
    }
    if (type === 'K') continue; // long *link* name; we drop links anyway

    entries.push({ name, type, size, data: Buffer.from(data) });
  }

  return entries;
}

/**
 * Whether an archive entry may be written to disk at all.
 *
 * This is a security boundary, not a tidiness filter: a tar entry names its own
 * destination, so an archive can ask to be written outside the extraction root
 * unless something says no. Rejects absolute paths, any `..` traversal, Windows
 * drive letters, and NUL bytes.
 */
export function isSafeEntryPath(name: string): boolean {
  if (!name || name.includes('\0')) return false;
  const normalized = name.replace(/\\/g, '/');
  if (normalized.startsWith('/')) return false;
  if (/^[a-zA-Z]:/.test(normalized)) return false;
  const segments = normalized.split('/');
  if (segments.some(s => s === '..')) return false;
  // A trailing or repeated separator is harmless; an entry that is only dots is not.
  return segments.some(s => s !== '' && s !== '.');
}

/** Classify an entry by extension, or null when it should not be extracted. */
export function classifyFile(name: string): SourceFileKind | null {
  const ext = path.posix.extname(name).toLowerCase();
  if (ext === '.tex' || ext === '.ltx') return 'tex';
  if (ext === '.sty' || ext === '.cls' || ext === '.clo') return 'style';
  if (ext === '.bbl' || ext === '.bib') return 'bib';
  if (RASTER_EXTENSIONS.has(ext)) return 'raster';
  if (TEXT_EXTENSIONS.has(ext)) return 'text';
  // arXiv accepts extensionless TeX files; treat a bare name as TeX and let the
  // distiller's main-file detection sort it out.
  if (ext === '' && !name.endsWith('/')) return 'tex';
  return null;
}

export interface ExtractResult {
  files: SourceFile[];
  entryNames: string[];
  warnings: string[];
}

/**
 * Write the safe, wanted entries of an archive into `destDir`.
 * Symlinks, hard links, device nodes and FIFOs are skipped outright — there is
 * no legitimate reason for an arXiv source package to contain one, and each is
 * a way out of the extraction root.
 */
export function extractEntries(entries: TarEntry[], destDir: string): ExtractResult {
  const files: SourceFile[] = [];
  const entryNames: string[] = [];
  const warnings: string[] = [];
  let totalBytes = 0;

  for (const entry of entries) {
    if (entry.type === '5') continue; // directory
    if (entry.type === '1' || entry.type === '2') {
      warnings.push(`Skipped link entry: ${entry.name}`);
      continue;
    }
    if (entry.type === '3' || entry.type === '4' || entry.type === '6') {
      warnings.push(`Skipped device/FIFO entry: ${entry.name}`);
      continue;
    }
    if (entry.type !== '0' && entry.type !== '\0' && entry.type !== '7') continue;

    if (!isSafeEntryPath(entry.name)) {
      warnings.push(`Rejected unsafe path in source package: ${entry.name}`);
      continue;
    }

    entryNames.push(entry.name);

    const kind = classifyFile(entry.name);
    if (!kind) continue;

    if (entry.data.length > MAX_FILE_BYTES) {
      warnings.push(`Skipped oversize file (${entry.data.length} bytes): ${entry.name}`);
      continue;
    }
    if (totalBytes + entry.data.length > MAX_EXTRACTED_BYTES) {
      warnings.push('Extraction byte cap reached; remaining files skipped.');
      break;
    }

    const target = path.join(destDir, entry.name);
    // Defence in depth: even with isSafeEntryPath, confirm the resolved path is
    // inside the destination before writing a single byte.
    const resolvedDest = path.resolve(destDir);
    if (!path.resolve(target).startsWith(resolvedDest + path.sep)) {
      warnings.push(`Rejected escaping path in source package: ${entry.name}`);
      continue;
    }

    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, entry.data);
    totalBytes += entry.data.length;
    files.push({ path: entry.name.replace(/\\/g, '/'), bytes: entry.data.length, kind });
  }

  return { files, entryNames, warnings };
}

// --- Cache -------------------------------------------------------------------

/** `hep-th/9711200` → `hep-th_9711200`, reusing pdf.ts's escaping. */
export function arxivIdToDirname(arxivId: string): string {
  return arxivId.replace(/\//g, '_');
}

function packageDir(arxivId: string): string {
  return path.join(TEX_CACHE_DIR, arxivIdToDirname(arxivId));
}

function metaPath(arxivId: string): string {
  return path.join(packageDir(arxivId), 'package.json');
}

function sourceDir(arxivId: string): string {
  return path.join(packageDir(arxivId), 'src');
}

function dirSize(dir: string): number {
  let total = 0;
  const walk = (d: string) => {
    let items: fs.Dirent[];
    try {
      items = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      const full = path.join(d, item.name);
      if (item.isDirectory()) walk(full);
      else {
        try {
          total += fs.statSync(full).size;
        } catch {
          /* raced with eviction */
        }
      }
    }
  };
  walk(dir);
  return total;
}

/**
 * Evict least-recently-used package directories once the cache exceeds its byte
 * budget. Mirrors `evictProxyCache` in pdf.ts, but on bytes rather than a file
 * count — one source package can be three orders of magnitude bigger than another.
 */
export function evictTexCache(budget = TEX_CACHE_BUDGET_BYTES): void {
  try {
    if (!fs.existsSync(TEX_CACHE_DIR)) return;
    const entries = fs
      .readdirSync(TEX_CACHE_DIR, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => {
        const dir = path.join(TEX_CACHE_DIR, e.name);
        return { dir, bytes: dirSize(dir), atime: fs.statSync(dir).atimeMs };
      });

    let total = entries.reduce((sum, e) => sum + e.bytes, 0);
    if (total <= budget) return;

    entries.sort((a, b) => a.atime - b.atime);
    for (const entry of entries) {
      if (total <= budget) break;
      fs.rmSync(entry.dir, { recursive: true, force: true });
      total -= entry.bytes;
    }
  } catch (err) {
    console.warn('TeX cache eviction error:', err);
  }
}

export function getCachedPackage(arxivId: string): SourcePackage | null {
  try {
    const raw = fs.readFileSync(metaPath(arxivId), 'utf8');
    const pkg = JSON.parse(raw) as SourcePackage;
    if (!fs.existsSync(pkg.dir)) return null;
    // Touch so LRU eviction sees the read.
    const now = new Date();
    fs.utimesSync(packageDir(arxivId), now, now);
    return pkg;
  } catch {
    return null;
  }
}

/** Read one extracted file's text. Returns null when it is missing. */
export function readSourceFile(pkg: SourcePackage, relPath: string): string | null {
  try {
    const target = path.resolve(pkg.dir, relPath);
    if (!target.startsWith(path.resolve(pkg.dir) + path.sep)) return null;
    return fs.readFileSync(target, 'utf8');
  } catch {
    return null;
  }
}

/** Every extracted text file, keyed by package-relative path. The distiller's input. */
export function readTextFiles(pkg: SourcePackage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const file of pkg.files) {
    if (file.kind === 'raster') continue;
    const text = readSourceFile(pkg, file.path);
    if (text !== null) out[file.path] = text;
  }
  return out;
}

// --- Download ----------------------------------------------------------------

/** Stream a response body, aborting past `limit` rather than buffering it all first. */
async function readCapped(response: Response, limit: number): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!reader) return Buffer.from(await response.arrayBuffer());

  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      throw new Error(
        `Source package exceeds the ${Math.round(limit / (1024 * 1024))} MB download cap.`
      );
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/**
 * Fetch, classify, and extract a paper's source package into the cache.
 *
 * Returns a package with `origin: 'none'` and `kind: 'pdf-only'` when arXiv has
 * no source for this paper — that is a legitimate, expected outcome (PDF-only
 * submissions exist), not an error. Callers fall through to the LaTeXML HTML
 * probe and then to abstract-only.
 */
export async function fetchSourcePackage(
  arxivId: string,
  opts: { force?: boolean } = {}
): Promise<SourcePackage> {
  if (!opts.force) {
    const cached = getCachedPackage(arxivId);
    if (cached) return cached;
  }

  const dir = packageDir(arxivId);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  const response = await arxivFetch(`https://arxiv.org/e-print/${arxivId}`, { gate: 'src' });
  if (!response.ok) {
    throw new Error(`arXiv returned ${response.status} for the source of ${arxivId}`);
  }

  const { filename, version } = parseContentDisposition(
    response.headers.get('content-disposition')
  );
  const raw = await readCapped(response, MAX_SOURCE_BYTES);
  const sha256 = crypto.createHash('sha256').update(raw).digest('hex');

  const warnings: string[] = [];
  const base: Omit<SourcePackage, 'kind' | 'files' | 'entryNames'> = {
    arxivId,
    version,
    origin: 'eprint',
    sha256,
    dir: sourceDir(arxivId),
    warnings,
    fetchedAt: new Date().toISOString(),
  };

  // A PDF-only submission announces itself in the filename, and again in the
  // magic bytes if the filename was absent or unhelpful.
  const filenameSaysPdf = !!filename && /\.pdf$/i.test(filename);
  const container = sniffContainer(raw);
  if (filenameSaysPdf || container === 'pdf') {
    const pkg: SourcePackage = {
      ...base,
      kind: 'pdf-only',
      origin: 'none',
      files: [],
      entryNames: [],
    };
    pkg.warnings.push('arXiv has no LaTeX source for this paper (PDF-only submission).');
    writeMeta(arxivId, pkg);
    return pkg;
  }

  let body = raw;
  let gzipName: string | null = null;
  if (container === 'gzip') {
    gzipName = gzipOriginalName(raw);
    try {
      body = zlib.gunzipSync(raw, { maxOutputLength: MAX_EXTRACTED_BYTES });
    } catch (err) {
      throw new Error(
        `Could not decompress the source package for ${arxivId}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  fs.mkdirSync(sourceDir(arxivId), { recursive: true });

  // The content type is always application/gzip and tells us nothing about what
  // is *inside* the gzip. Sniff again after decompression.
  const inner = sniffContainer(body);

  let result: ExtractResult;
  let kind: PackageKind;

  if (inner === 'pdf') {
    const pkg: SourcePackage = {
      ...base,
      kind: 'pdf-only',
      origin: 'none',
      files: [],
      entryNames: [],
    };
    pkg.warnings.push('arXiv has no LaTeX source for this paper (PDF-only submission).');
    writeMeta(arxivId, pkg);
    return pkg;
  }

  if (inner === 'tar') {
    kind = 'tar';
    result = extractEntries(parseTar(body), sourceDir(arxivId));
  } else {
    // A bare gzipped single file. The gzip header usually preserves the original
    // name (`conffo.tex` for hep-th/9711200); fall back to a synthetic one.
    kind = 'single-tex';
    const name = gzipName && isSafeEntryPath(gzipName) ? path.basename(gzipName) : 'main.tex';
    fs.writeFileSync(path.join(sourceDir(arxivId), name), body);
    result = {
      files: [{ path: name, bytes: body.length, kind: classifyFile(name) ?? 'tex' }],
      entryNames: [name],
      warnings: [],
    };
  }

  warnings.push(...result.warnings);
  if (result.files.length === 0) {
    warnings.push('The source package contained no usable TeX files.');
  }

  const pkg: SourcePackage = {
    ...base,
    kind,
    files: result.files,
    entryNames: result.entryNames,
  };
  writeMeta(arxivId, pkg);
  evictTexCache();
  return pkg;
}

function writeMeta(arxivId: string, pkg: SourcePackage): void {
  fs.mkdirSync(packageDir(arxivId), { recursive: true });
  fs.writeFileSync(metaPath(arxivId), JSON.stringify(pkg, null, 2));
}

// --- LaTeXML HTML fallback ---------------------------------------------------

/**
 * arXiv's LaTeXML rendering, when there is no usable source package.
 *
 * Verified 2026-08-28 to return real LaTeXML output (`ltx_` classes) even for a
 * 2017 paper, so backfill coverage is broad — but it is *not* universal, so it
 * is probed rather than assumed. Note it is larger than the TeX it was made
 * from (188 KB vs 80 KB for 1706.03762) and has already lost the macros.
 */
export async function fetchLatexmlHtml(arxivId: string): Promise<string | null> {
  try {
    const response = await arxivFetch(`https://arxiv.org/html/${arxivId}`, { gate: 'html' });
    if (!response.ok) return null;
    const html = await response.text();
    // arXiv serves a friendly "no HTML for this paper" page with a 200.
    if (!/ltx_document|ltx_title|LaTeXML/i.test(html)) return null;
    return html;
  } catch {
    return null;
  }
}

/** Strip LaTeXML HTML down to readable text. Crude by design — it is the degraded path. */
export function latexmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/(p|div|section|h1|h2|h3|h4|li|tr|table|figure)>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x?[0-9a-f]+;/gi, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
