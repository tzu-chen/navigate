import { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';

import Icon from './Icon';
import { useKeyboardShortcut } from '../hooks/useKeyboardShortcut';
import { useAutoTrim } from '../hooks/useAutoTrim';
import { TrimDocument } from '../utils/autoTrim';
import * as api from '../services/api';
import { Comment, CommentPositionRect, TrimMode } from '../types';

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString();

const documentOptions = {
  cMapUrl: `https://unpkg.com/pdfjs-dist@${pdfjs.version}/cmaps/`,
  cMapPacked: true,
  standardFontDataUrl: `https://unpkg.com/pdfjs-dist@${pdfjs.version}/standard_fonts/`,
  // Cap decoded image size to ~25 megapixels to prevent mobile browser crashes
  // from papers with oversized embedded graphics (e.g. 10000x6000 figures).
  maxImageSize: 25 * 1024 * 1024,
};

interface OutlineItem {
  title: string;
  bold: boolean;
  italic: boolean;
  dest: string | unknown[] | null;
  url: string | null;
  items: OutlineItem[];
}

interface Props {
  pdfUrl: string;
  onPageChange?: (page: number) => void;
  immersiveMode?: boolean;
  onToggleImmersive?: () => void;
  jumpToPage?: number;
  onJumpApplied?: () => void;
  onTextSelected?: (selection: {
    text: string;
    pageNumber: number;
    rects: CommentPositionRect[];
  } | null) => void;
  onRequestAddComment?: (anchor: { x: number; y: number }) => void;
  comments?: Comment[];
  onDeleteComment?: (commentId: number) => void | Promise<void>;
}

// Detect mobile once — used to tune buffer sizes and canvas resolution.
// iPadOS 13+ reports its UA as "Macintosh", and modern iPads in landscape
// exceed 1024px, so neither UA sniffing nor a width threshold catches them
// on their own. Touch-points + Mac platform is the reliable iPad signal.
const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
  (navigator.maxTouchPoints > 1 && /Mac/.test(navigator.platform));

// Baseline canvas resolution — matches the screen's native pixel density so
// rendering is sharp at the default viewport scale. Capped at 2 because going
// higher costs memory quadratically without visible benefit on most screens.
const baseCanvasPixelRatio = Math.min(window.devicePixelRatio || 1, 2);

// Hard ceiling on the effective DPR we'll feed pdf.js, even under heavy pinch
// zoom. Canvas memory grows with DPR², so 3 already costs ~9x the bytes of
// DPR=1; beyond that we'd OOM on mobile and gain little perceptual sharpness.
const MAX_CANVAS_PIXEL_RATIO = 3;

// Above this PDF size, mobile browsers risk OOM-killing the tab during pdf.js
// parsing — long before we can show any error. We prompt the user to open the
// PDF in their OS's native viewer instead.
const MOBILE_PDF_SIZE_LIMIT = 12 * 1024 * 1024;

// Pages kept live on each side of the viewport, as a *page count* — not a
// pixel distance. A distance-based buffer degenerates when page wrappers have
// no height yet (they all stack at the same y and every one falls inside the
// window), which is how opening a paper used to mount a canvas for every page
// in the document at once. A count cannot degenerate that way.
const BUFFER = isMobile ? 1 : 2;

// Trim-view menu, modelled on Okular's View → Trim View: the modes are
// alternatives picked from one menu, and re-picking the active one turns it off.
const TRIM_OPTIONS: { mode: Exclude<TrimMode, 'off'>; label: string; hint: string }[] = [
  { mode: 'uniform', label: 'Trim margins', hint: 'one box for the whole paper' },
  { mode: 'page', label: 'Trim margins (per page)', hint: 'each page to its own content' },
];

// PDF.js's text layer is one <span> per text item, so a Range across multiple
// lines emits many client rects that often stack on the same visual line.
// Group rects whose vertical centers are within half a line height of each
// other into one rect per line (union of their bounding boxes), then clamp
// heights so adjacent lines don't overlap.
function mergeLineRects(rects: CommentPositionRect[]): CommentPositionRect[] {
  if (rects.length === 0) return [];
  const sorted = [...rects].sort((a, b) => a.y - b.y);
  type Group = { top: number; bottom: number; left: number; right: number; page: number };
  const groups: Group[] = [];
  for (const r of sorted) {
    const last = groups[groups.length - 1];
    if (last) {
      const lastCenter = (last.top + last.bottom) / 2;
      const rCenter = r.y + r.h / 2;
      const tolerance = Math.min(r.h, last.bottom - last.top) * 0.5;
      if (Math.abs(rCenter - lastCenter) < tolerance) {
        last.top = Math.min(last.top, r.y);
        last.bottom = Math.max(last.bottom, r.y + r.h);
        last.left = Math.min(last.left, r.x);
        last.right = Math.max(last.right, r.x + r.w);
        continue;
      }
    }
    groups.push({ top: r.y, bottom: r.y + r.h, left: r.x, right: r.x + r.w, page: r.page });
  }
  const merged: CommentPositionRect[] = groups.map(g => ({
    page: g.page,
    x: g.left,
    y: g.top,
    w: g.right - g.left,
    h: g.bottom - g.top,
  }));
  for (let i = 0; i < merged.length - 1; i++) {
    const nextTop = merged[i + 1].y;
    if (merged[i].y + merged[i].h > nextTop) {
      merged[i].h = Math.max(0, nextTop - merged[i].y);
    }
  }
  return merged;
}


export default function PDFViewer({ pdfUrl, onPageChange, immersiveMode, onToggleImmersive, jumpToPage, onJumpApplied, onTextSelected, onRequestAddComment, comments, onDeleteComment }: Props) {
  const [numPages, setNumPages] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [scale, setScale] = useState(1.2);
  const [error, setError] = useState(false);
  const [outline, setOutline] = useState<OutlineItem[]>([]);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [expandedItems, setExpandedItems] = useState<Set<string>>(new Set());
  const [pdfDarkTheme, setPdfDarkTheme] = useState(() => {
    const stored = localStorage.getItem('pdfDarkTheme');
    if (stored !== null) return stored === 'true';
    return document.documentElement.getAttribute('data-theme-type') === 'dark';
  });
  const [pdfThemeOverride, setPdfThemeOverride] = useState(() => {
    return localStorage.getItem('pdfDarkTheme') !== null;
  });
  // Window of pages holding a live <Page> canvas, as an inclusive range.
  // Deliberately a range and not a Set: a range around the observed pages is
  // structurally incapable of covering the whole document, so a bad layout
  // measurement can widen it by a page or two but never by hundreds.
  const [visibleRange, setVisibleRange] = useState<{ start: number; end: number }>({
    start: 1,
    end: 1 + BUFFER * 2,
  });
  const visibleRangeRef = useRef(visibleRange);
  visibleRangeRef.current = visibleRange;
  // Tooltip pinning: a click on any highlight of a comment pins that
  // comment's tooltip open; clicking again unpins. Hover still works.
  const [pinnedCommentId, setPinnedCommentId] = useState<number | null>(null);
  // Mobile-only size guard. 'pending' blocks rendering until the HEAD probe
  // returns; 'large' surfaces a confirmation UI before we hand a multi-hundred-
  // megabyte PDF to pdf.js (which can OOM-kill the tab on iPad Safari).
  const [sizeGate, setSizeGate] = useState<'ok' | 'pending' | 'large'>(
    isMobile ? 'pending' : 'ok',
  );
  const [pdfByteSize, setPdfByteSize] = useState<number | null>(null);
  // Visual-viewport (pinch) zoom level. Pinching scales the canvas pixels
  // visually without re-rasterizing, so we track this and bump the rendered
  // DPR to keep pages sharp at any zoom level.
  const [pinchZoom, setPinchZoom] = useState(1);
  const containerRef = useRef<HTMLDivElement>(null);
  const currentPageRef = useRef(1);
  // Browser-style back/forward history for in-PDF jumps (TOC clicks, internal
  // links). Manual scrolling does not push entries; only "jumps" do. ArrowLeft
  // walks back, ArrowRight walks forward.
  const jumpHistoryRef = useRef<number[]>([]);
  const jumpIndexRef = useRef(-1);
  const [jumpHint, setJumpHint] = useState<number | null>(null);
  const jumpHintTimerRef = useRef<number | null>(null);
  const [pageInputValue, setPageInputValue] = useState('1');
  // Stores the bounding rect of the active text selection in viewport coords.
  // Used to position the "Add comment" popup AND the floating box that opens on click.
  const [selectionPopup, setSelectionPopup] = useState<{ top: number; right: number; bottom: number; left: number } | null>(null);
  const selectionPopupRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pdfDocRef = useRef<any>(null);
  // The same document as pdfDocRef, held in state because the auto-trim hook has
  // to start measuring when it arrives (a ref change wakes nothing).
  const [trimDoc, setTrimDoc] = useState<TrimDocument | null>(null);
  const hasInitialScale = useRef(false);
  const pageWidthRef = useRef(0);
  const lastContainerWidthRef = useRef(0);
  const pageHeightRef = useRef(0);
  // Fraction of the page width that survives trimming. Fit-to-width divides by
  // it, so trimmed pages fill the viewer rather than leaving the reclaimed
  // margin as empty gutter — the point of trimming in the first place.
  const horizFracRef = useRef(1);
  // Automatic margin trimming, modelled on Okular's View → Trim View (and on
  // Scribe's port of it). Persisted globally, so it survives paper switches.
  const [trimMode, setTrimMode] = useState<TrimMode>('off');
  const [trimMenuOpen, setTrimMenuOpen] = useState(false);
  const trimMenuRef = useRef<HTMLDivElement>(null);
  // Set when the reader changes the trim mode, so the next refit knows to put
  // them back on the page they were reading.
  const restoreOnRefitRef = useRef(false);

  const updateCurrentPage = useCallback((page: number) => {
    if (page !== currentPageRef.current) {
      currentPageRef.current = page;
      setCurrentPage(page);
      setPageInputValue(String(page));
      onPageChange?.(page);
    }
  }, [onPageChange]);

  // Reset state when PDF changes. numPages is cleared along with the page
  // dimensions: leaving the previous document's count in place would mount
  // that many wrappers against dimensions of 0 while the new document loads.
  useEffect(() => {
    hasInitialScale.current = false;
    pageWidthRef.current = 0;
    pageHeightRef.current = 0;
    pdfDocRef.current = null;
    setTrimDoc(null);
    horizFracRef.current = 1;
    setNumPages(0);
    setOutline([]);
    setVisibleRange({ start: 1, end: 1 + BUFFER * 2 });
    jumpHistoryRef.current = [];
    jumpIndexRef.current = -1;
    setSizeGate(isMobile ? 'pending' : 'ok');
    setPdfByteSize(null);
  }, [pdfUrl]);

  // On mobile, probe the PDF size with a HEAD request before mounting the
  // <Document>. If it exceeds MOBILE_PDF_SIZE_LIMIT we surface a warning rather
  // than feeding a huge file to pdf.js (which can OOM-kill the iPad Safari tab
  // mid-parse, leaving no chance to show an error). On HEAD failure we fall
  // through and let the user try — the warning is opt-in safety, not a hard gate.
  useEffect(() => {
    if (!isMobile || !pdfUrl) return;
    let cancelled = false;
    fetch(pdfUrl, { method: 'HEAD' })
      .then(r => {
        if (cancelled) return;
        const len = r.headers.get('content-length');
        const bytes = len ? parseInt(len, 10) : 0;
        setPdfByteSize(bytes || null);
        setSizeGate(bytes > MOBILE_PDF_SIZE_LIMIT ? 'large' : 'ok');
      })
      .catch(() => {
        if (cancelled) return;
        setSizeGate('ok');
      });
    return () => {
      cancelled = true;
    };
  }, [pdfUrl]);

  // Scale that makes the *visible* (post-trim) page span fill the container.
  const fitToWidth = useCallback(() => {
    const container = containerRef.current;
    if (!container || pageWidthRef.current <= 0) return;
    // Account for padding/scrollbar in the container
    const containerWidth = container.clientWidth - 20;
    if (containerWidth <= 0) return;
    setScale(containerWidth / (pageWidthRef.current * horizFracRef.current));
  }, []);

  // Re-fit PDF to width on container resize (e.g. orientation change on mobile)
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const resizeObserver = new ResizeObserver(() => {
      if (pageWidthRef.current <= 0) return;
      const currentWidth = container.clientWidth;
      // Only refit when width change is significant (>50px) to filter out scrollbar jitter
      if (Math.abs(currentWidth - lastContainerWidthRef.current) > 50) {
        lastContainerWidthRef.current = currentWidth;
        fitToWidth();
      }
    });

    resizeObserver.observe(container);
    return () => resizeObserver.disconnect();
  }, [fitToWidth]);

  // Track pinch-zoom level via the visual viewport and re-render canvases at
  // a higher DPR when the user zooms in. Debounced so we don't re-rasterize
  // mid-pinch (each Page render is expensive); we only commit when the gesture
  // settles. Only re-renders when the change is meaningful — small changes
  // within ~15% don't justify the cost.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    let timer: number | null = null;
    const handle = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const s = vv.scale || 1;
        setPinchZoom(prev => (Math.abs(s - prev) > 0.15 ? s : prev));
      }, 250);
    };
    vv.addEventListener('resize', handle);
    return () => {
      vv.removeEventListener('resize', handle);
      if (timer !== null) window.clearTimeout(timer);
    };
  }, []);

  // Effective rendering DPR. Multiplied by pinch zoom so canvases stay sharp
  // when the user pinches in; capped to keep memory bounded on long PDFs.
  const effectivePixelRatio = Math.min(
    baseCanvasPixelRatio * pinchZoom,
    MAX_CANVAS_PIXEL_RATIO,
  );

  // Sync PDF dark mode with app theme when no user override
  useEffect(() => {
    if (pdfThemeOverride) return;
    const observer = new MutationObserver(() => {
      const isDark = document.documentElement.getAttribute('data-theme-type') === 'dark';
      setPdfDarkTheme(isDark);
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme-type'] });
    return () => observer.disconnect();
  }, [pdfThemeOverride]);

  // Derive the live-page window from an IntersectionObserver rather than from
  // hand-rolled rect math in a scroll handler. Two properties keep it bounded:
  // the window is a range around the pages the browser reports as intersecting,
  // and an empty report leaves the previous range alone instead of recomputing
  // from a container that is hidden or mid-relayout.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || numPages === 0) return;

    const intersecting = new Set<number>();
    let rafId: number | null = null;
    let pending: IntersectionObserverEntry[] = [];

    const flush = () => {
      rafId = null;
      for (const entry of pending) {
        const pageNum = Number((entry.target as HTMLElement).dataset.pageNumber);
        if (isNaN(pageNum)) continue;
        if (entry.isIntersecting) intersecting.add(pageNum);
        else intersecting.delete(pageNum);
      }
      pending = [];
      if (intersecting.size === 0) return;
      const sorted = Array.from(intersecting).sort((a, b) => a - b);
      const start = Math.max(1, sorted[0] - BUFFER);
      const end = Math.min(numPages, sorted[sorted.length - 1] + BUFFER);
      setVisibleRange(prev => (prev.start === start && prev.end === end ? prev : { start, end }));
    };

    const observer = new IntersectionObserver(
      entries => {
        // Coalesce bursts within a frame so a momentum scroll produces one
        // state commit instead of one per page boundary crossed.
        pending.push(...entries);
        if (rafId === null) rafId = requestAnimationFrame(flush);
      },
      // threshold + rootMargin give hysteresis, so pages don't flap in and out
      // of the window when a fast scroll grazes their edges.
      { root: container, threshold: 0.1, rootMargin: '100px 0px' },
    );

    container.querySelectorAll('.pdf-page-wrapper[data-page-number]').forEach(el => observer.observe(el));

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      observer.disconnect();
    };
    // `scale` is deliberately excluded: IntersectionObserver recalculates by
    // itself when observed elements resize, so rebuilding it on every zoom
    // step would only cost a redundant burst of entries.
  }, [numPages]);

  // Current-page tracking, kept separate from the window above. Two adjacent
  // pages can both remain intersecting while the reading position moves from
  // one to the other — no observer entry fires, but the page number still has
  // to advance. Only wrappers inside the current window are measured, so this
  // is a handful of rect reads per frame rather than one per page.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || numPages === 0) return;

    let rafId: number | null = null;

    const measure = () => {
      rafId = null;
      const containerTop = container.getBoundingClientRect().top;
      const { start, end } = visibleRangeRef.current;
      let current = start;
      for (let p = start; p <= end; p++) {
        const el = container.querySelector(`.pdf-page-wrapper[data-page-number="${p}"]`);
        if (!el) continue;
        if (el.getBoundingClientRect().top <= containerTop + 50) current = p;
      }
      updateCurrentPage(current);
    };

    const onScroll = () => {
      if (rafId === null) rafId = requestAnimationFrame(measure);
    };

    measure();
    container.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      container.removeEventListener('scroll', onScroll);
    };
  }, [numPages, updateCurrentPage]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function onDocumentLoadSuccess(pdf: any) {
    pdfDocRef.current = pdf;
    setTrimDoc(pdf as TrimDocument);
    setError(false);

    // Resolve page-1 dimensions BEFORE publishing numPages. Wrappers size their
    // placeholders from these refs, so publishing the count first would mount
    // every wrapper at zero height for a frame — they would all stack at the
    // same y, all report as intersecting, and the window would open to the
    // whole document. Awaiting here costs one worker round-trip and makes the
    // very first render of the page list correctly sized.
    if (!hasInitialScale.current) {
      hasInitialScale.current = true;
      try {
        const page = await pdf.getPage(1);
        const viewport = page.getViewport({ scale: 1 });
        pageWidthRef.current = viewport.width;
        pageHeightRef.current = viewport.height;
        const container = containerRef.current;
        if (container) {
          lastContainerWidthRef.current = container.clientWidth;
          if (viewport.width > 0) fitToWidth();
        }
      } catch {
        // Keep default scale on error
      }
    }

    // Last-resort dimensions (US Letter). Placeholders must never be zero-height
    // — that is the condition the whole window design depends on ruling out.
    if (pageHeightRef.current <= 0) {
      pageWidthRef.current = 612;
      pageHeightRef.current = 792;
    }

    setNumPages(pdf.numPages);
    setVisibleRange({ start: 1, end: Math.min(pdf.numPages, 1 + BUFFER * 2) });

    pdf.getOutline().then((items: OutlineItem[] | null) => {
      if (items && items.length > 0) {
        setOutline(items);
        // Expand top-level items by default
        const topLevel = new Set(items.map((_: OutlineItem, i: number) => String(i)));
        setExpandedItems(topLevel);
      } else {
        setOutline([]);
      }
    }).catch(() => {
      setOutline([]);
    });
  }

  function onDocumentLoadError() {
    setError(true);
  }

  const scrollToPage = useCallback((page: number, behavior: ScrollBehavior = 'smooth') => {
    const container = containerRef.current;
    if (!container) return;
    const el = container.querySelector(`.pdf-page-wrapper[data-page-number="${page}"]`);
    if (el) {
      el.scrollIntoView({ behavior, block: 'start' });
    }
  }, []);

  const goToPage = useCallback((page: number) => {
    if (isNaN(page)) return;
    const clamped = Math.max(1, Math.min(page, numPages));
    updateCurrentPage(clamped);
    scrollToPage(clamped);
  }, [numPages, updateCurrentPage, scrollToPage]);

  // Restore the persisted trim mode once per mount. It is a global preference,
  // not a per-paper one, so this doesn't re-run when the PDF changes.
  useEffect(() => {
    let cancelled = false;
    api.getTrimMode().then(mode => {
      if (!cancelled) setTrimMode(mode);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const trim = useAutoTrim({
    mode: trimMode,
    pdfDoc: trimDoc ?? undefined,
    numPages,
    currentPage,
  });

  const { cropForPage } = trim;

  // Fit-to-width follows the document-wide box, never a per-page one: in `page`
  // mode the zoom level would otherwise jitter as each page's own measurement
  // landed while scrolling.
  const horizFrac = trimMode === 'off'
    ? 1
    : Math.max(0.2, 1 - trim.uniform.left - trim.uniform.right);

  // Refit when the trim box changes — switching trimming on or off changes how
  // wide a page renders. This deliberately overrides a manual zoom, the same way
  // a container resize already does: the user just asked for a different page
  // width. Layout effect, so the trimmed geometry and the scale that suits it
  // reach the screen in the same paint instead of flashing the intermediate.
  useLayoutEffect(() => {
    if (Math.abs(horizFrac - horizFracRef.current) < 0.002) return;
    horizFracRef.current = horizFrac;
    fitToWidth();
    // Page geometry just moved under the reader, so put them back on the page
    // they were on. Only for a trim change they asked for: in `page` mode the
    // document box also loosens on its own as wider pages get measured, and
    // yanking the view back on each of those would be worse than leaving it.
    if (restoreOnRefitRef.current) {
      restoreOnRefitRef.current = false;
      const page = currentPageRef.current;
      requestAnimationFrame(() => scrollToPage(page, 'auto'));
    }
  }, [horizFrac, fitToWidth, scrollToPage]);

  // Picking the active mode again switches trimming off, the way a checkable
  // menu item behaves. `next` is computed outside the state updater because the
  // persist call is a side effect and StrictMode invokes updaters twice.
  const selectTrimMode = useCallback((mode: TrimMode) => {
    const next: TrimMode = trimMode === mode ? 'off' : mode;
    setTrimMenuOpen(false);
    setTrimMode(next);
    restoreOnRefitRef.current = true;
    api.saveTrimMode(next).catch(() => {});
  }, [trimMode]);

  // Dismiss the trim menu on Escape or a click outside it.
  useEffect(() => {
    if (!trimMenuOpen) return;
    const onMouseDown = (e: MouseEvent) => {
      if (trimMenuRef.current?.contains(e.target as Node)) return;
      setTrimMenuOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setTrimMenuOpen(false);
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [trimMenuOpen]);

  // Capture text selections inside the PDF and forward to the parent. Only emit
  // on non-empty selections — clearing the selection (e.g., focusing the
  // comment textarea) must not wipe the parent's captured snapshot.
  useEffect(() => {
    if (!onTextSelected && !onRequestAddComment) return;
    const container = containerRef.current;
    if (!container) return;

    const captureSelection = () => {
      // Defer one tick so the browser finalizes the selection after mouseup/touchend.
      setTimeout(() => {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
        const text = sel.toString().trim();
        if (!text) return;
        const anchor = sel.anchorNode;
        if (!anchor || !container.contains(anchor)) return;
        const el = anchor.nodeType === Node.TEXT_NODE ? anchor.parentElement : (anchor as Element);
        const pageEl = el?.closest('.pdf-page-wrapper[data-page-number]');
        const pageNum = pageEl ? Number(pageEl.getAttribute('data-page-number')) : NaN;
        if (!pageEl || isNaN(pageNum)) return;

        // Compute normalized rects (x,y,w,h as fractions of the page's rendered size)
        // so underline marks scale with zoom. getClientRects() returns one rect per
        // visual fragment (typically one per line of the selection).
        const range = sel.getRangeAt(0);
        const clientRects = range.getClientRects();
        // Scoped to the wrappers: react-pdf puts a data-page-number on its own
        // page div too, and a trimmed one overhangs its clipping box, so a loose
        // selector would let page N's element claim page N+1's content.
        const pageWrappers = container.querySelectorAll('.pdf-page-wrapper[data-page-number]');
        // Two rects per page: `clip` is what the reader can see (the trimmed
        // box, or the whole page when trimming is off) and decides which page a
        // selection rect belongs to; `page` is the full page and normalizes the
        // coordinates. Attributing by the full rect would misfile selections
        // once trimming is on, because a cropped page's element still overhangs
        // its visible box and can cover its neighbour's content.
        const pageRectCache = new Map<number, { clip: DOMRect; page: DOMRect }>();
        const rects: CommentPositionRect[] = [];
        for (let i = 0; i < clientRects.length; i++) {
          const cr = clientRects[i];
          if (cr.width <= 0 || cr.height <= 0) continue;
          const cx = (cr.left + cr.right) / 2;
          const cy = (cr.top + cr.bottom) / 2;
          let matchedPage: number | null = null;
          let matchedRect: DOMRect | null = null;
          for (const wrapper of pageWrappers) {
            const p = Number(wrapper.getAttribute('data-page-number'));
            let cached = pageRectCache.get(p);
            if (!cached) {
              const pageDiv = wrapper.querySelector('.react-pdf__Page') || wrapper;
              const clipDiv = wrapper.querySelector('.pdf-page-crop') || pageDiv;
              cached = {
                clip: (clipDiv as Element).getBoundingClientRect(),
                page: (pageDiv as Element).getBoundingClientRect(),
              };
              pageRectCache.set(p, cached);
            }
            const clip = cached.clip;
            if (cx >= clip.left && cx <= clip.right && cy >= clip.top && cy <= clip.bottom) {
              matchedPage = p;
              matchedRect = cached.page;
              break;
            }
          }
          if (matchedPage === null || !matchedRect || matchedRect.width === 0 || matchedRect.height === 0) continue;
          rects.push({
            page: matchedPage,
            x: (cr.left - matchedRect.left) / matchedRect.width,
            y: (cr.top - matchedRect.top) / matchedRect.height,
            w: cr.width / matchedRect.width,
            h: cr.height / matchedRect.height,
          });
        }

        onTextSelected?.({ text, pageNumber: pageNum, rects });
        if (onRequestAddComment) {
          const rect = range.getBoundingClientRect();
          if (rect.width > 0 || rect.height > 0) {
            setSelectionPopup({ top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left });
          }
        }
      }, 0);
    };

    container.addEventListener('mouseup', captureSelection);
    container.addEventListener('touchend', captureSelection);
    return () => {
      container.removeEventListener('mouseup', captureSelection);
      container.removeEventListener('touchend', captureSelection);
    };
  }, [onTextSelected, onRequestAddComment]);

  // Dismiss the selection popup on scroll, page-input typing, or clicks outside it.
  useEffect(() => {
    if (!selectionPopup) return;
    const container = containerRef.current;
    const onScroll = () => setSelectionPopup(null);
    const onDocMouseDown = (e: MouseEvent) => {
      if (selectionPopupRef.current?.contains(e.target as Node)) return;
      setSelectionPopup(null);
    };
    container?.addEventListener('scroll', onScroll, { passive: true });
    document.addEventListener('mousedown', onDocMouseDown);
    return () => {
      container?.removeEventListener('scroll', onScroll);
      document.removeEventListener('mousedown', onDocMouseDown);
    };
  }, [selectionPopup]);

  // Apply externally-requested page jumps once the document is loaded.
  // Waits for numPages > 0 so a jump issued before load still lands correctly.
  useEffect(() => {
    if (jumpToPage === undefined || numPages === 0) return;
    goToPage(jumpToPage);
    onJumpApplied?.();
  }, [jumpToPage, numPages, goToPage, onJumpApplied]);

  // Briefly overlay the destination page number — gives a clear visual cue
  // during smooth-scroll jumps where the page change isn't immediate.
  const showJumpHint = useCallback((page: number) => {
    setJumpHint(page);
    if (jumpHintTimerRef.current !== null) {
      window.clearTimeout(jumpHintTimerRef.current);
    }
    jumpHintTimerRef.current = window.setTimeout(() => {
      setJumpHint(null);
      jumpHintTimerRef.current = null;
    }, 900);
  }, []);

  useEffect(() => () => {
    if (jumpHintTimerRef.current !== null) {
      window.clearTimeout(jumpHintTimerRef.current);
    }
  }, []);

  // Record a TOC/link jump: snapshot the page we're leaving (so ArrowLeft can
  // return there), then push the destination. Discards forward history because
  // a new jump branches off the current point.
  const recordJump = useCallback((target: number) => {
    const current = currentPageRef.current;
    const history = jumpHistoryRef.current.slice(0, jumpIndexRef.current + 1);
    if (history.length === 0 || history[history.length - 1] !== current) {
      history.push(current);
    }
    if (history[history.length - 1] !== target) {
      history.push(target);
    }
    jumpHistoryRef.current = history;
    jumpIndexRef.current = history.length - 1;
  }, []);

  const jumpBack = useCallback(() => {
    if (jumpIndexRef.current <= 0) return false;
    jumpIndexRef.current -= 1;
    const target = jumpHistoryRef.current[jumpIndexRef.current];
    showJumpHint(target);
    goToPage(target);
    return true;
  }, [goToPage, showJumpHint]);

  const jumpForward = useCallback(() => {
    if (jumpIndexRef.current >= jumpHistoryRef.current.length - 1) return false;
    jumpIndexRef.current += 1;
    const target = jumpHistoryRef.current[jumpIndexRef.current];
    showJumpHint(target);
    goToPage(target);
    return true;
  }, [goToPage, showJumpHint]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      const target = e.target;
      if (target instanceof HTMLElement) {
        const tag = target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        if (target.isContentEditable) return;
      }
      if (e.key === 'ArrowLeft') {
        if (jumpBack()) e.preventDefault();
      } else if (e.key === 'ArrowRight') {
        if (jumpForward()) e.preventDefault();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [jumpBack, jumpForward]);

  // react-pdf's <Document> captures onItemClick inside a useRef on first render,
  // so any closure passed inline would see numPages=0 and clamp every jump to page 1.
  // Route through a ref to always hit the current goToPage.
  const goToPageRef = useRef(goToPage);
  useEffect(() => {
    goToPageRef.current = goToPage;
  }, [goToPage]);
  const handleItemClick = useCallback(({ pageNumber }: { pageNumber: number }) => {
    recordJump(pageNumber);
    showJumpHint(pageNumber);
    goToPageRef.current(pageNumber);
  }, [recordJump, showJumpHint]);

  const navigateToOutlineDest = useCallback(async (dest: string | unknown[] | null) => {
    if (!dest || !pdfDocRef.current) return;

    try {
      let explicitDest = dest;
      if (typeof dest === 'string') {
        explicitDest = await pdfDocRef.current.getDestination(dest);
      }
      if (Array.isArray(explicitDest)) {
        const ref = explicitDest[0];
        const pageIndex = await pdfDocRef.current.getPageIndex(ref);
        if (typeof pageIndex === 'number' && !isNaN(pageIndex)) {
          recordJump(pageIndex + 1);
          showJumpHint(pageIndex + 1);
          goToPage(pageIndex + 1);
        }
      }
    } catch (err) {
      console.error('Failed to navigate to outline destination:', err);
    }
  }, [goToPage, recordJump, showJumpHint]);

  const toggleExpanded = useCallback((key: string) => {
    setExpandedItems(prev => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  const handlePageInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setPageInputValue(e.target.value);
  };

  const handlePageInputCommit = () => {
    const val = parseInt(pageInputValue, 10);
    if (!isNaN(val) && val >= 1 && val <= numPages) {
      goToPage(val);
    } else {
      setPageInputValue(String(currentPage));
    }
  };

  const handlePageInputKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handlePageInputCommit();
    }
  };

  const zoomIn = () => setScale(s => Math.min(s + 0.2, 3));
  const zoomOut = () => setScale(s => Math.max(s - 0.2, 0.4));

  // Index comments by page as one group per comment per page. Each group
  // owns all of its merged per-line rects plus a single tooltip anchored to
  // the first rect — so hovering different lines of the same comment never
  // moves the tooltip, and we never render duplicate tooltips. PDF.js's text
  // layer emits one rect per text span; mergeLineRects collapses those into
  // one rect per line so highlights don't compound into darker bands.
  const annotationsByPage = useMemo(() => {
    type Group = {
      comment: Comment;
      rects: CommentPositionRect[];
      hasFirst: boolean; // contains the very first rect → leading [ bracket
      hasLast: boolean;  // contains the very last rect → trailing ] bracket
    };
    const map = new Map<number, Group[]>();
    if (!comments) return map;
    for (const c of comments) {
      if (!c.position_rects) continue;
      let parsed: CommentPositionRect[];
      try {
        parsed = JSON.parse(c.position_rects) as CommentPositionRect[];
      } catch {
        continue;
      }
      if (!Array.isArray(parsed) || parsed.length === 0) continue;

      const byPage = new Map<number, CommentPositionRect[]>();
      for (const r of parsed) {
        if (typeof r?.page !== 'number') continue;
        const list = byPage.get(r.page) || [];
        list.push(r);
        byPage.set(r.page, list);
      }

      const pageNums = Array.from(byPage.keys()).sort((a, b) => a - b);
      if (pageNums.length === 0) continue;
      const minPage = pageNums[0];
      const maxPage = pageNums[pageNums.length - 1];

      for (const pageNum of pageNums) {
        const merged = mergeLineRects(byPage.get(pageNum)!);
        if (merged.length === 0) continue;
        const list = map.get(pageNum) || [];
        list.push({
          comment: c,
          rects: merged,
          hasFirst: pageNum === minPage,
          hasLast: pageNum === maxPage,
        });
        map.set(pageNum, list);
      }
    }
    return map;
  }, [comments]);

  const toggleOutline = useCallback(() => setOutlineOpen(o => !o), []);
  useKeyboardShortcut('pdfTocToggle', toggleOutline, outline.length > 0);

  const togglePdfDarkTheme = () => {
    setPdfDarkTheme(prev => {
      const next = !prev;
      localStorage.setItem('pdfDarkTheme', String(next));
      setPdfThemeOverride(true);
      return next;
    });
  };

  const resetPdfThemeToAuto = () => {
    localStorage.removeItem('pdfDarkTheme');
    setPdfThemeOverride(false);
    const isDark = document.documentElement.getAttribute('data-theme-type') === 'dark';
    setPdfDarkTheme(isDark);
  };

  function renderOutlineItems(items: OutlineItem[], level: number = 0, parentKey: string = '') {
    return items.map((item, index) => {
      const key = parentKey ? `${parentKey}-${index}` : String(index);
      const hasChildren = item.items && item.items.length > 0;
      const isExpanded = expandedItems.has(key);

      return (
        <div key={key} className="pdf-outline-item">
          <div
            className="pdf-outline-item-row"
            style={{ paddingLeft: `${8 + level * 16}px` }}
          >
            {hasChildren ? (
              <button
                className="pdf-outline-toggle"
                onClick={() => toggleExpanded(key)}
                aria-label={isExpanded ? 'Collapse' : 'Expand'}
              >
                <span className={`pdf-outline-chevron ${isExpanded ? 'open' : ''}`}>&#9654;</span>
              </button>
            ) : (
              <span className="pdf-outline-toggle-spacer" />
            )}
            <button
              className={`pdf-outline-link ${item.bold ? 'bold' : ''}`}
              onClick={() => navigateToOutlineDest(item.dest)}
              title={item.title}
            >
              {item.title}
            </button>
          </div>
          {hasChildren && isExpanded && (
            <div className="pdf-outline-children">
              {renderOutlineItems(item.items, level + 1, key)}
            </div>
          )}
        </div>
      );
    });
  }

  return (
    <div className={`pdf-viewer ${pdfDarkTheme ? 'pdf-dark-theme' : ''}`}>
      <div className="pdf-toolbar">
        <div className="pdf-toolbar-group">
          <button
            className="pdf-nav-btn"
            onClick={() => goToPage(currentPage - 1)}
            disabled={currentPage <= 1}
            title="Previous page"
          >
            <Icon name="triangle-left" />
          </button>
          <span className="pdf-page-info">
            <input
              type="text"
              className="pdf-page-input"
              value={pageInputValue}
              onChange={handlePageInputChange}
              onBlur={handlePageInputCommit}
              onKeyDown={handlePageInputKeyDown}
            />
            <span className="pdf-page-total">/ {numPages}</span>
          </span>
          <button
            className="pdf-nav-btn"
            onClick={() => goToPage(currentPage + 1)}
            disabled={currentPage >= numPages}
            title="Next page"
          >
            <Icon name="triangle-right" />
          </button>
        </div>

        <div className="pdf-toolbar-group">
          <button className="pdf-nav-btn" onClick={zoomOut} title="Zoom out">
            &#8722;
          </button>
          <span className="pdf-zoom-level">{Math.round(scale * 100)}%</span>
          <button className="pdf-nav-btn" onClick={zoomIn} title="Zoom in">
            &#43;
          </button>
          <div className="pdf-trim-control" ref={trimMenuRef}>
            <button
              className={`pdf-nav-btn ${trimMode !== 'off' ? 'pdf-nav-btn-active' : ''}`}
              onClick={() => setTrimMenuOpen(o => !o)}
              title={
                trimMode === 'uniform' ? 'Trim view (margins trimmed)'
                  : trimMode === 'page' ? 'Trim view (margins trimmed per page)'
                    : 'Trim view — hide page margins'
              }
            >
              <Icon name="crop" />
            </button>
            {trim.measuring && <span className="pdf-trim-status">measuring…</span>}
            {trimMenuOpen && (
              <div className="pdf-trim-menu" role="menu">
                {TRIM_OPTIONS.map(option => (
                  <button
                    key={option.mode}
                    type="button"
                    role="menuitemradio"
                    aria-checked={trimMode === option.mode}
                    className={`pdf-trim-menu-item ${trimMode === option.mode ? 'pdf-trim-menu-item-active' : ''}`}
                    onClick={() => selectTrimMode(option.mode)}
                  >
                    <span className="pdf-trim-menu-check">{trimMode === option.mode ? '✓' : ''}</span>
                    <span>
                      {option.label}
                      <span className="pdf-trim-menu-hint">{option.hint}</span>
                    </span>
                  </button>
                ))}
                {trimMode !== 'off' && (
                  <button
                    type="button"
                    role="menuitem"
                    className="pdf-trim-menu-item"
                    onClick={() => selectTrimMode(trimMode)}
                  >
                    <span className="pdf-trim-menu-check" />
                    <span>No trim</span>
                  </button>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="pdf-toolbar-group">
          <button
            className={`pdf-nav-btn ${pdfDarkTheme ? 'pdf-nav-btn-active' : ''} ${pdfThemeOverride ? 'pdf-theme-override' : ''}`}
            onClick={togglePdfDarkTheme}
            onDoubleClick={resetPdfThemeToAuto}
            title={pdfDarkTheme
              ? `Switch to light mode${pdfThemeOverride ? ' (double-click to reset to auto)' : ''}`
              : `Switch to dark mode${pdfThemeOverride ? ' (double-click to reset to auto)' : ''}`}
          >
            {pdfDarkTheme ? <Icon name="sun" /> : <Icon name="moon" />}
          </button>
          <a
            href={pdfUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="btn btn-secondary btn-sm"
          >
            Open in New Tab
          </a>
        </div>
      </div>

      {error && (
        <div className="pdf-error">
          <p>Failed to load PDF.</p>
          <a
            href={pdfUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="btn btn-primary"
          >
            Open PDF in New Tab
          </a>
        </div>
      )}

      <div className="pdf-content-area">
        {outlineOpen && outline.length > 0 && (
          <div className="pdf-outline-panel">
            <div className="pdf-outline-header">
              <span className="pdf-outline-title">Outline</span>
              <button
                className="pdf-outline-close"
                onClick={() => setOutlineOpen(false)}
                title="Close outline"
              >
                <Icon name="x-mark" />
              </button>
            </div>
            <div className="pdf-outline-list">
              {renderOutlineItems(outline)}
            </div>
          </div>
        )}

        <div className="pdf-pages-wrapper">
          {outline.length > 0 && (
            <div className="toc-zone">
              <button
                className={`floating-toggle ${outlineOpen ? 'floating-toggle-active' : ''}`}
                onClick={() => setOutlineOpen(o => !o)}
                title="Table of contents"
              >
                <Icon name="sidebar-left" />
              </button>
            </div>
          )}
          {onToggleImmersive && (
            <div className="immersive-zone">
              <button
                className={`floating-toggle ${immersiveMode ? 'floating-toggle-active' : ''}`}
                onClick={onToggleImmersive}
                title={immersiveMode ? 'Exit immersive mode (Esc)' : 'Immersive mode — hide all toolbars'}
              >
                {immersiveMode ? <Icon name="close" /> : <Icon name="expand" />}
              </button>
            </div>
          )}
          {jumpHint !== null && (
            <div key={`hint-${jumpHint}-${jumpIndexRef.current}`} className="pdf-jump-hint" aria-hidden="true">
              <span className="pdf-jump-hint-page">{jumpHint}</span>
              <span className="pdf-jump-hint-total">/ {numPages}</span>
            </div>
          )}
          <div className="pdf-pages-container" ref={containerRef}>
          {sizeGate === 'pending' && (
            <div className="pdf-loading">Checking PDF…</div>
          )}
          {sizeGate === 'large' && (
            <div className="pdf-mobile-size-warning">
              <p className="pdf-mobile-size-warning-title">
                This PDF is {pdfByteSize ? `${(pdfByteSize / (1024 * 1024)).toFixed(0)} MB` : 'very large'} and may crash mobile browsers.
              </p>
              <p className="pdf-mobile-size-warning-body">
                Opening it in your device's native PDF viewer is faster and more reliable.
              </p>
              <div className="pdf-mobile-size-warning-actions">
                <a
                  href={pdfUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn btn-primary"
                >
                  Open in new tab
                </a>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setSizeGate('ok')}
                >
                  Load here anyway
                </button>
              </div>
            </div>
          )}
          {sizeGate === 'ok' && (
          <Document
            file={pdfUrl}
            onLoadSuccess={onDocumentLoadSuccess}
            onLoadError={onDocumentLoadError}
            loading={<div className="pdf-loading">Loading PDF...</div>}
            options={documentOptions}
            externalLinkTarget="_blank"
            externalLinkRel="noopener noreferrer"
            onItemClick={handleItemClick}
          >
            {Array.from({ length: numPages }, (_, i) => {
              const pageNum = i + 1;
              const isVisible = pageNum >= visibleRange.start && pageNum <= visibleRange.end;
              const pageAnnotations = annotationsByPage.get(pageNum);
              const pageW = pageWidthRef.current > 0 ? pageWidthRef.current * scale : 0;
              const pageH = pageHeightRef.current > 0 ? pageHeightRef.current * scale : 0;
              // Trimming hides margins by clipping: the page renders whole (so
              // pdf.js, the text layer, and every stored comment rect keep their
              // full-page geometry) inside a smaller box that shows only the
              // content. Placeholders for off-screen pages shrink to match, or
              // scrolling would jump when a page mounted.
              // Guarded on known dimensions: a crop against a zero-sized page
              // would collapse the clipping box and hide the page outright.
              const crop = pageW > 0 && pageH > 0 ? cropForPage(pageNum) : undefined;
              const cropL = crop?.left ?? 0;
              const cropT = crop?.top ?? 0;
              const clipW = crop ? Math.floor(pageW * (1 - cropL - crop.right)) : pageW;
              const clipH = crop ? Math.floor(pageH * (1 - cropT - crop.bottom)) : pageH;
              const pageEl = isVisible ? (
                <Page
                  pageNumber={pageNum}
                  scale={scale}
                  devicePixelRatio={effectivePixelRatio}
                  loading=""
                  error={
                    <div className="pdf-page-error">
                      <p>Page {pageNum} failed to render</p>
                    </div>
                  }
                />
              ) : null;
              return (
                <div
                  key={pageNum}
                  data-page-number={pageNum}
                  className="pdf-page-wrapper"
                  style={!isVisible && pageHeightRef.current > 0
                    ? { height: `${clipH}px`, minHeight: `${clipH}px` }
                    : undefined}
                >
                  {isVisible ? (
                    crop ? (
                      <div className="pdf-page-crop" style={{ width: clipW, height: clipH }}>
                        <div
                          className="pdf-page-crop-inner"
                          style={{ left: -Math.floor(cropL * pageW), top: -Math.floor(cropT * pageH) }}
                        >
                          {pageEl}
                        </div>
                      </div>
                    ) : pageEl
                  ) : null}
                  {isVisible && pageAnnotations && pageAnnotations.length > 0 && pageW > 0 && pageH > 0 && (
                    <div
                      className="pdf-page-comment-overlay"
                      style={{
                        width: pageW,
                        height: pageH,
                        // Stay pinned to the full page's frame, which trimming
                        // has shifted up and (unless the side margins are equal)
                        // sideways. Kept outside the clipping box so a tooltip
                        // on the first line can still overflow above the page.
                        ...(crop ? {
                          marginTop: -Math.floor(cropT * pageH),
                          marginLeft: Math.round((crop.right - cropL) * pageW / 2),
                        } : undefined),
                      }}
                    >
                      {pageAnnotations.map(group => {
                        const isPinned = pinnedCommentId === group.comment.id;
                        const groupClasses = ['pdf-comment-group'];
                        if (isPinned) groupClasses.push('pdf-comment-group--pinned');
                        const firstRect = group.rects[0];
                        const togglePin = (e: React.MouseEvent) => {
                          e.stopPropagation();
                          setPinnedCommentId(prev => prev === group.comment.id ? null : group.comment.id);
                        };
                        return (
                          <div key={group.comment.id} className={groupClasses.join(' ')}>
                            {group.rects.map((r, i) => {
                              const lineH = r.h * pageH;
                              const isFirstRect = group.hasFirst && i === 0;
                              const isLastRect = group.hasLast && i === group.rects.length - 1;
                              const markClasses = ['pdf-comment-mark'];
                              if (isFirstRect) markClasses.push('pdf-comment-mark--first');
                              if (isLastRect) markClasses.push('pdf-comment-mark--last');
                              return (
                                <div
                                  key={i}
                                  className={markClasses.join(' ')}
                                  onClick={togglePin}
                                  style={{
                                    left: `${r.x * 100}%`,
                                    top: `${r.y * 100}%`,
                                    width: `${r.w * 100}%`,
                                    height: `${r.h * 100}%`,
                                    fontSize: `${lineH}px`,
                                  }}
                                >
                                  <div className="pdf-comment-mark-bg" />
                                </div>
                              );
                            })}
                            <div
                              className="pdf-comment-tooltip"
                              style={{
                                left: `${firstRect.x * 100}%`,
                                bottom: `calc(${(1 - firstRect.y) * 100}% + 6px)`,
                              }}
                            >
                              {onDeleteComment && (
                                <button
                                  type="button"
                                  className="pdf-comment-tooltip-delete"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    if (pinnedCommentId === group.comment.id) setPinnedCommentId(null);
                                    onDeleteComment(group.comment.id);
                                  }}
                                  title="Delete comment"
                                >
                                  &times;
                                </button>
                              )}
                              <div className="pdf-comment-tooltip-content">{group.comment.content}</div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </Document>
          )}
        </div>
        </div>
      </div>
      {selectionPopup && onRequestAddComment && (
        <div
          ref={selectionPopupRef}
          className="pdf-selection-popup"
          style={{ left: (selectionPopup.left + selectionPopup.right) / 2, top: selectionPopup.top }}
          onMouseDown={(e) => e.preventDefault()}
        >
          <button
            type="button"
            className="pdf-selection-popup-btn"
            onClick={() => {
              onRequestAddComment({ x: selectionPopup.left, y: selectionPopup.bottom + 8 });
              setSelectionPopup(null);
            }}
          >
            <Icon name="pencil" />
            <span>Add comment</span>
          </button>
        </div>
      )}
    </div>
  );
}
