import { CropBox, NO_CROP } from '../types';

// Automatic margin detection ("trim margins"), modelled on Okular's Trim
// Margins: each page is rendered small, the bounding box of its non-background
// pixels is measured, and the surrounding margin becomes the page's crop.
//
// Two hardening passes are added on top of Okular's plain bounding box, because
// scanned submissions routinely defeat it: single dust specks in the margin
// would otherwise pin the box to the full page.
//   1. A speck must have an ink neighbour to count (1-pass erosion).
//   2. A row/column must carry a minimum number of ink pixels to be "content".
//
// This file is deliberately free of pdf.js imports: it takes the two structural
// interfaces below, so the measuring logic can be reasoned about (and reused)
// without pinning a pdfjs-dist version that react-pdf owns transitively.

/** Long-edge resolution pages are sampled at. Enough for ~0.3% crop precision. */
const SAMPLE_WIDTH = 320;

/** The slice of pdf.js's PDFPageProxy that measurement needs. */
interface TrimPage {
  getViewport(params: { scale: number }): { width: number; height: number };
  render(params: {
    canvasContext: CanvasRenderingContext2D;
    viewport: { width: number; height: number };
  }): { promise: Promise<void> };
  cleanup(): void;
}

/** The slice of pdf.js's PDFDocumentProxy that measurement needs. */
export interface TrimDocument {
  getPage(pageNumber: number): Promise<TrimPage>;
}

export interface AutoTrimOptions {
  /** Luminance distance (0-255) from the page background that counts as ink. */
  threshold?: number;
  /** Margin kept around the detected content, as a fraction of the page size. */
  padding?: number;
  /** Hard cap on what may be trimmed from any single side. */
  maxCrop?: number;
}

const DEFAULT_OPTIONS: Required<AutoTrimOptions> = {
  threshold: 26,
  padding: 0.008,
  maxCrop: 0.45,
};

/** Content smaller than this fraction of the page means the detection is not
 *  trustworthy (blank page, a lone page number, a full-page scan artefact). */
const MIN_CONTENT_FRACTION = 0.15;

// Shape of a marginal stamp — a single line of rotated text set outside the
// text block, of which arXiv's ID banner on page 1 is the case that matters
// here. All four must hold before a band is discarded (see `skipMarginBand`).
//
// The bounds are fitted to the 219 stamped first pages in this library, measured
// from their text layers (`thickness` p50 0.029 / max 0.037, `reach` max 0.075,
// `gap` min 0.008 / p05 0.028, `aspect` min 18). Each sits clear of the observed
// worst case, with the widest allowance on thickness because a rendered stamp is
// a block or two fatter than its glyph boxes once antialiased.
/** At most this fraction of the page thick. */
const BAND_MAX_THICKNESS = 0.06;
/** Ends within this much of the page edge — it has to be *in* the margin. */
const BAND_MAX_REACH = 0.15;
/** Separated from the body by at least this much blank page. */
const BAND_MIN_GAP = 0.006;
/** Far taller than it is wide. */
const BAND_MIN_ASPECT = 8;

interface SampledPage {
  /** Darkest luminance within each sample block. */
  min: Uint8Array;
  /** Brightest luminance within each sample block. */
  max: Uint8Array;
  width: number;
  height: number;
}

/**
 * Reduce RGBA pixels to a small two-channel (darkest/brightest) luminance grid.
 *
 * Keeping both extremes per block makes the detection polarity-agnostic: dark
 * text on a light page registers through `min`, light text on a dark scan
 * through `max`. Taking extremes rather than an average also stops hairlines
 * from being averaged away into the background.
 */
function samplePage(
  data: Uint8ClampedArray,
  width: number,
  height: number,
): SampledPage {
  const stride = Math.max(1, Math.floor(width / SAMPLE_WIDTH));
  const outW = Math.ceil(width / stride);
  const outH = Math.ceil(height / stride);
  const min = new Uint8Array(outW * outH).fill(255);
  const max = new Uint8Array(outW * outH);

  for (let y = 0; y < height; y++) {
    const oy = (y / stride) | 0;
    const rowBase = y * width * 4;
    const outRow = oy * outW;
    for (let x = 0; x < width; x++) {
      const i = rowBase + x * 4;
      const a = data[i + 3];
      // Composite over white: an un-painted PDF region is transparent, and
      // treating it as rgb(0,0,0) would read as ink covering the whole page.
      let lum = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8;
      if (a !== 255) lum = ((lum * a) + 255 * (255 - a)) / 255 | 0;
      const o = outRow + ((x / stride) | 0);
      if (lum < min[o]) min[o] = lum;
      if (lum > max[o]) max[o] = lum;
    }
  }

  return { min, max, width: outW, height: outH };
}

/** Median luminance of the outermost 2-block ring — the page's background. */
function estimateBackground(page: SampledPage): number {
  const { min, max, width, height } = page;
  const ring: number[] = [];
  const depth = Math.min(2, Math.floor(Math.min(width, height) / 4)) || 1;
  const push = (o: number) => {
    ring.push(min[o]);
    ring.push(max[o]);
  };
  for (let d = 0; d < depth; d++) {
    for (let x = 0; x < width; x++) {
      push(d * width + x);
      push((height - 1 - d) * width + x);
    }
    for (let y = 0; y < height; y++) {
      push(y * width + d);
      push(y * width + (width - 1 - d));
    }
  }
  if (ring.length === 0) return 255;
  ring.sort((a, b) => a - b);
  return ring[ring.length >> 1];
}

/** Vertical extent, in blocks, of the ink inside columns [x0, x1]. */
function bandExtent(
  solid: Uint8Array,
  w: number,
  h: number,
  x0: number,
  x1: number,
): number {
  let first = -1;
  let last = -1;
  for (let y = 0; y < h; y++) {
    const base = y * w;
    for (let x = x0; x <= x1; x++) {
      if (solid[base + x]) {
        if (first === -1) first = y;
        last = y;
        break;
      }
    }
  }
  return first === -1 ? 0 : last - first + 1;
}

/**
 * Look past a marginal stamp to the real edge of the text block.
 *
 * arXiv prints the paper's ID down the left margin of every preprint's first
 * page, in rotated type outside the text block. To a bounding box that is ink
 * like any other, and because the document-wide box is the *smallest* margin
 * found on any page (see `aggregateCrops`), that single page's stamp reopens the
 * left margin for the entire paper — the wide left gutter this exists to remove.
 *
 * The stamp is separable from content by its shape alone, so this needs no page
 * numbers and catches the same thing wherever it appears (line numbers on a
 * review copy, a journal's submission stamp): a line of rotated text is a thin,
 * very tall band, sitting in the margin, with clear page between it and the
 * body. Content that reaches the margin — a wide figure, a full-bleed table — is
 * none of those things, so it still opens the box up as before.
 *
 * `edge` is the outermost inked column on this side and `opposite` the bound on
 * the far side; returns the column the crop should start from.
 */
function skipMarginBand(
  colInk: Uint32Array,
  solid: Uint8Array,
  w: number,
  h: number,
  gate: number,
  edge: number,
  opposite: number,
): number {
  const dir = edge <= opposite ? 1 : -1;

  // Inner end of the outermost contiguous run of inked columns...
  let end = edge;
  while (end !== opposite && colInk[end + dir] >= gate) end += dir;
  if (end === opposite) return edge; // one solid run: that run *is* the body
  // ...then across the blank stretch to where the body starts. Terminates at
  // `opposite` at the latest, which is inked by construction.
  let body = end + dir;
  while (colInk[body] < gate) body += dir;

  const thickness = Math.abs(end - edge) + 1;
  const gap = Math.abs(body - end) - 1;
  const reach = dir === 1 ? end + 1 : w - end;

  const isStamp =
    thickness <= BAND_MAX_THICKNESS * w &&
    reach <= BAND_MAX_REACH * w &&
    gap >= BAND_MIN_GAP * w &&
    bandExtent(solid, w, h, Math.min(edge, end), Math.max(edge, end)) >=
      BAND_MIN_ASPECT * thickness;

  return isStamp ? body : edge;
}

/**
 * Measure the content bounding box of one sampled page and return it as a
 * CropBox of per-side margins. Returns null when the result is not trustworthy
 * (nothing found, or a suspiciously small content area) so the caller can fall
 * back to a document-wide estimate instead of zooming into a page number.
 */
export function detectContentCrop(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  options: AutoTrimOptions = {},
): CropBox | null {
  if (width <= 0 || height <= 0) return null;
  const { threshold, padding, maxCrop } = { ...DEFAULT_OPTIONS, ...options };

  const page = samplePage(data, width, height);
  const w = page.width;
  const h = page.height;
  const bg = estimateBackground(page);

  const ink = new Uint8Array(w * h);
  for (let i = 0; i < ink.length; i++) {
    const dev = Math.max(Math.abs(page.min[i] - bg), Math.abs(page.max[i] - bg));
    ink[i] = dev > threshold ? 1 : 0;
  }

  // Erode: an ink block with no ink neighbour is dust, not content.
  const solid = new Uint8Array(w * h);
  const colInk = new Uint32Array(w);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!ink[i]) continue;
      const connected =
        (x > 0 && ink[i - 1]) ||
        (x < w - 1 && ink[i + 1]) ||
        (y > 0 && ink[i - w]) ||
        (y < h - 1 && ink[i + w]);
      if (!connected) continue;
      solid[i] = 1;
      colInk[x]++;
    }
  }

  const rowGate = Math.max(2, Math.round(w * 0.004));
  const colGate = Math.max(2, Math.round(h * 0.004));

  let left = -1;
  let right = -1;
  for (let x = 0; x < w; x++) {
    if (colInk[x] >= colGate) {
      if (left === -1) left = x;
      right = x;
    }
  }
  if (left === -1) return null;

  left = skipMarginBand(colInk, solid, w, h, colGate, left, right);
  right = skipMarginBand(colInk, solid, w, h, colGate, right, left);

  // Rows are counted across the surviving columns only, so a discarded stamp
  // can't pin the top or bottom either — arXiv's banner routinely overhangs the
  // text block. (If both sides were stamps and nothing is left between them,
  // the span is empty and the page falls through to the trustworthiness check.)
  const rowInk = new Uint32Array(h);
  for (let y = 0; y < h; y++) {
    const base = y * w;
    let n = 0;
    for (let x = left; x <= right; x++) if (solid[base + x]) n++;
    rowInk[y] = n;
  }

  let top = -1;
  let bottom = -1;
  for (let y = 0; y < h; y++) {
    if (rowInk[y] >= rowGate) {
      if (top === -1) top = y;
      bottom = y;
    }
  }
  if (top === -1) return null;

  const contentW = (right - left + 1) / w;
  const contentH = (bottom - top + 1) / h;
  if (contentW < MIN_CONTENT_FRACTION || contentH < MIN_CONTENT_FRACTION) return null;

  // Pad outwards by the requested margin plus one sample block, so sub-block
  // rounding can never shave a glyph.
  const padX = padding + 1 / w;
  const padY = padding + 1 / h;
  const clamp = (v: number) => Math.max(0, Math.min(maxCrop, Math.round(v * 1e4) / 1e4));

  return {
    top: clamp(top / h - padY),
    bottom: clamp((h - 1 - bottom) / h - padY),
    left: clamp(left / w - padX),
    right: clamp((w - 1 - right) / w - padX),
  };
}

/** Reusable off-screen canvas for page sampling — one per document at a time. */
export function createTrimCanvas(): HTMLCanvasElement {
  return document.createElement('canvas');
}

/** Render a PDF page at sampling resolution and measure its content box. */
export async function detectPdfPageCrop(
  pdfDoc: TrimDocument,
  pageNumber: number,
  canvas: HTMLCanvasElement,
  options?: AutoTrimOptions,
): Promise<CropBox | null> {
  const page = await pdfDoc.getPage(pageNumber);
  try {
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({
      scale: Math.min(1, SAMPLE_WIDTH / base.width),
    });
    canvas.width = Math.max(1, Math.floor(viewport.width));
    canvas.height = Math.max(1, Math.floor(viewport.height));
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return detectContentCrop(img.data, img.width, img.height, options);
  } finally {
    // Drop the operator list / font state this measurement primed; otherwise
    // sampling a long paper inflates the document's retained heap. pdf.js skips
    // the cleanup while the viewer has a render of its own in flight on the
    // same page, so this can't disturb what's on screen.
    page.cleanup();
  }
}

/**
 * Collapse measured pages into one document-wide box: the smallest margin any
 * of them has, per side.
 *
 * Two deliberate departures from Scribe's version of this function, both
 * because a paper is not a scanned book:
 *
 * 1. **No per-parity box.** Scribe keeps one box for odd and one for even pages
 *    because a bound book alternates its gutter. arXiv PDFs are single-sided
 *    typeset output with the same margins throughout, so one box is both
 *    correct and simpler: every page renders at exactly the same size, which is
 *    what lets the viewer keep sizing off-screen page placeholders from a
 *    single page height.
 *
 * 2. **A plain minimum, not the minimum of the *typical* pages.** Scribe
 *    discards pages whose margin is under half the median, so one full-bleed
 *    illustration can't open the crop back up for a whole book. On papers that
 *    filter only ever over-trims: the pages it calls atypical are wide figures,
 *    tables and display equations — content, not decoration. Measured over 25
 *    real papers from this library (every page of each), the filter clipped
 *    content on 3 of them (up to 4.7% of the page width) while trimming no more
 *    on average than the plain minimum did (70.0% vs 70.4% of page area kept),
 *    because the pages it discarded were the informative ones. So the minimum
 *    wins outright here, and it comes with a guarantee worth having: no measured
 *    page has its content clipped. The cost is that a genuinely full-bleed page
 *    disables trimming on that side for the document — use `page` mode there.
 *    The single thing deliberately not treated as content is a marginal stamp,
 *    which `skipMarginBand` drops before the page is ever aggregated; without
 *    that, arXiv's first-page ID banner sets the left margin for every paper.
 */
export function aggregateCrops(boxes: CropBox[]): CropBox {
  if (boxes.length === 0) return NO_CROP;
  return {
    top: Math.min(...boxes.map(b => b.top)),
    right: Math.min(...boxes.map(b => b.right)),
    bottom: Math.min(...boxes.map(b => b.bottom)),
    left: Math.min(...boxes.map(b => b.left)),
  };
}
