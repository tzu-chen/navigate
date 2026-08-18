import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CropBox, NO_CROP, TrimMode, hasCrop } from '../types';
import {
  TrimDocument,
  aggregateCrops,
  createTrimCanvas,
  detectPdfPageCrop,
} from '../utils/autoTrim';

// `uniform` mode measures *every* page before applying anything, because the
// document-wide box is the smallest margin found (see `aggregateCrops`): a box
// derived from a partial pass would be tighter than the document warrants and
// would clip the pages not yet measured. Applying it in one step also means the
// page geometry moves exactly once, never under the reader mid-scroll.
//
// A paper costs 10–100 measurements at ~20ms of idle time each. The cap only
// exists so that a pathological 2000-page PDF degrades to a spread sample
// instead of grinding; above it, the never-clip guarantee is best-effort.
const MAX_UNIFORM_PAGES = 400;

// `page` mode measures lazily around the reading position instead (like
// Okular's Trim Margins, which measures a page the first time it's laid out),
// so a 300-page thesis doesn't stall on measuring everything up front.
const WINDOW_BEFORE = 1;
const WINDOW_AFTER = 3;
/** Spread sample in `page` mode too — it backs pages not yet measured. */
const PAGE_MODE_SEED = 8;

/** Re-render (and therefore re-layout) at most this often while measuring. */
const FLUSH_MS = 150;

interface Params {
  mode: TrimMode;
  pdfDoc?: TrimDocument;
  numPages: number;
  currentPage: number;
}

export interface AutoTrim {
  /** Trim box for a page under the active mode. */
  cropForPage: (page: number) => CropBox | undefined;
  /** The document-wide box. This *is* the crop in `uniform` mode; in `page`
   *  mode it backs unmeasured pages and drives the fit-to-width scale, where a
   *  per-page width would make the zoom level jitter while scrolling. */
  uniform: CropBox;
  /** A `uniform` sweep is under way and hasn't produced its box yet. (`page`
   *  mode measures continuously as you read and never reports this.) */
  measuring: boolean;
}

function whenIdle(): Promise<void> {
  return new Promise(resolve => {
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(() => resolve(), { timeout: 300 });
    } else {
      setTimeout(resolve, 16);
    }
  });
}

/** `count` page numbers spread evenly across the document. */
function spreadSample(numPages: number, count: number): number[] {
  const n = Math.min(count, numPages);
  const pages: number[] = [];
  for (let i = 0; i < n; i++) {
    pages.push(Math.max(1, Math.round(((i + 0.5) / n) * numPages)));
  }
  return pages;
}

/** The pages `uniform` mode has to measure: all of them, or a spread sample of
 *  a document long enough to make that unreasonable. Pure, so the render pass
 *  can ask how many are needed and tell whether the measurement is complete. */
function uniformPages(numPages: number): number[] {
  if (numPages <= MAX_UNIFORM_PAGES) {
    return Array.from({ length: numPages }, (_, i) => i + 1);
  }
  return Array.from(new Set(spreadSample(numPages, MAX_UNIFORM_PAGES)));
}

export function useAutoTrim({ mode, pdfDoc, numPages, currentPage }: Params): AutoTrim {
  // cacheRef is authoritative and mutated by the measuring loop; `cache` is the
  // snapshot React renders from, swapped in on a throttled flush so a burst of
  // measurements doesn't re-lay-out the page list once per page.
  const cacheRef = useRef(new Map<number, CropBox>());
  const [cache, setCache] = useState<Map<number, CropBox>>(cacheRef.current);
  const [attempts, setAttempts] = useState(0);
  /** Pages already measured — including ones that came back untrustworthy, so
   *  we don't pay for them twice. */
  const attemptedRef = useRef(new Set<number>());
  const pendingRef = useRef<number[]>([]);
  const runningRef = useRef(false);
  const seededRef = useRef(new Set<TrimMode>());
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // Bumped whenever in-flight work must be abandoned (document swap, unmount).
  const genRef = useRef(0);
  const [measuring, setMeasuring] = useState(false);
  // `uniform` publishes its box only once the pass is complete; `page` publishes
  // as it goes, since each page there uses its own box. Read through a ref so
  // the measuring loop doesn't have to be rebuilt when the mode changes.
  const atomicRef = useRef(mode === 'uniform');
  atomicRef.current = mode === 'uniform';

  // Publishes the measured boxes *and* how many pages have been attempted; the
  // second number is what tells the render pass whether a `uniform` sweep has
  // finished, and therefore whether its box is safe to apply.
  const flush = useCallback(() => {
    setCache(new Map(cacheRef.current));
    setAttempts(attemptedRef.current.size);
  }, []);

  // Drop everything when the document changes — boxes are page-content specific.
  useEffect(() => {
    genRef.current++;
    cacheRef.current = new Map();
    attemptedRef.current = new Set();
    pendingRef.current = [];
    seededRef.current = new Set();
    flush();
    return () => {
      // Bumping the *live* generation is the point: it tells whatever loop is
      // mid-measurement to drop its results.
      genRef.current++;
    };
  }, [pdfDoc, flush]);

  const measurePage = useCallback(async (page: number): Promise<CropBox | null> => {
    if (!pdfDoc) return null;
    try {
      if (!canvasRef.current) canvasRef.current = createTrimCanvas();
      return await detectPdfPageCrop(pdfDoc, page, canvasRef.current);
    } catch (err) {
      console.error(`Auto-trim failed to measure page ${page}:`, err);
      return null;
    }
  }, [pdfDoc]);

  const pump = useCallback(() => {
    if (runningRef.current) return;
    runningRef.current = true;
    setMeasuring(true);
    const gen = genRef.current;
    void (async () => {
      let dirty = false;
      let lastFlush = performance.now();
      try {
        while (pendingRef.current.length > 0 && gen === genRef.current) {
          const page = pendingRef.current.shift()!;
          if (attemptedRef.current.has(page)) continue;
          attemptedRef.current.add(page);
          const box = await measurePage(page);
          if (gen !== genRef.current) return;
          if (box) {
            cacheRef.current.set(page, box);
            dirty = true;
          }
          if (dirty && !atomicRef.current && performance.now() - lastFlush >= FLUSH_MS) {
            lastFlush = performance.now();
            dirty = false;
            flush();
          }
          // Measuring competes with the viewer's own page rendering; give the
          // browser the frame back between pages.
          await whenIdle();
        }
      } finally {
        runningRef.current = false;
        // Unconditional: even a pass that measured nothing trustworthy has to
        // publish its attempt count, or `uniformComplete` never resolves.
        if (gen === genRef.current) flush();
        // Restarting covers work queued while this (possibly stale) run was
        // suspended mid-measurement, which would otherwise sit until the next
        // scroll nudged the effect. The restart re-raises the flag itself.
        if (pendingRef.current.length > 0) pumpRef.current();
        else setMeasuring(false);
      }
    })();
  }, [measurePage, flush]);

  const pumpRef = useRef(pump);
  useEffect(() => {
    pumpRef.current = pump;
  }, [pump]);

  useEffect(() => {
    if (mode === 'off' || numPages === 0 || !pdfDoc) return;

    const wanted: number[] = [];
    if (mode === 'page') {
      for (
        let p = Math.max(1, currentPage - WINDOW_BEFORE);
        p <= Math.min(numPages, currentPage + WINDOW_AFTER);
        p++
      ) {
        wanted.push(p);
      }
    }
    if (mode === 'uniform') {
      // Asked for in full every time the effect runs, not seeded once: the pages
      // already done are filtered out below, so this is idempotent, and it
      // resumes by itself if a pass was cut short (trimming switched off part
      // way through, then back on) — an incomplete sweep is never applied.
      wanted.push(...uniformPages(numPages));
    } else if (!seededRef.current.has(mode)) {
      seededRef.current.add(mode);
      wanted.push(...spreadSample(numPages, PAGE_MODE_SEED));
    }

    const queued = new Set(pendingRef.current);
    const fresh = wanted.filter(p => !attemptedRef.current.has(p) && !queued.has(p));
    if (fresh.length === 0) return;
    // Newest window first: it's what the reader is looking at.
    pendingRef.current = [...fresh, ...pendingRef.current];
    pump();
  }, [mode, pdfDoc, numPages, currentPage, pump]);

  // Stop measuring as soon as trimming is switched off. Dropping the queue is
  // enough — the loop exits after the page in flight, and that page's box is
  // worth keeping. The cache survives, so switching back on is instant.
  useEffect(() => {
    if (mode !== 'off') return;
    pendingRef.current = [];
  }, [mode]);

  // A `uniform` box is only trustworthy once every page it covers has been
  // attempted, since the box is the smallest margin seen and a partial sweep
  // would be tighter than the document allows — i.e. it would clip. Until then
  // the document reads untrimmed rather than wrongly trimmed.
  const uniformTarget = useMemo(() => uniformPages(numPages).length, [numPages]);
  const uniformComplete = mode !== 'uniform' || attempts >= uniformTarget;

  const uniform = useMemo(
    () => (uniformComplete ? aggregateCrops(Array.from(cache.values())) : NO_CROP),
    [cache, uniformComplete],
  );

  const cropForPage = useCallback((page: number): CropBox | undefined => {
    if (mode === 'off') return undefined;
    const resolved = (mode === 'page' ? cache.get(page) : undefined) ?? uniform;
    return hasCrop(resolved) ? resolved : undefined;
  }, [mode, cache, uniform]);

  return { cropForPage, uniform, measuring: measuring && !uniformComplete };
}
