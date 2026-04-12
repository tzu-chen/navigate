import { useState, useRef, useEffect, useCallback } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';

import Icon from './Icon';

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
}

// Detect mobile once — used to tune buffer sizes and canvas resolution
const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
  (navigator.maxTouchPoints > 1 && window.innerWidth < 1024);

// Cap canvas resolution at 2x for crisp text without excess memory use.
const canvasPixelRatio = Math.min(window.devicePixelRatio || 1, 2);


export default function PDFViewer({ pdfUrl, onPageChange, immersiveMode, onToggleImmersive }: Props) {
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
  const [visiblePages, setVisiblePages] = useState<Set<number>>(new Set([1]));
  const containerRef = useRef<HTMLDivElement>(null);
  const currentPageRef = useRef(1);
  const [pageInputValue, setPageInputValue] = useState('1');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pdfDocRef = useRef<any>(null);
  const hasInitialScale = useRef(false);
  const pageWidthRef = useRef(0);
  const lastContainerWidthRef = useRef(0);
  const pageHeightRef = useRef(0);

  const updateCurrentPage = useCallback((page: number) => {
    if (page !== currentPageRef.current) {
      currentPageRef.current = page;
      setCurrentPage(page);
      setPageInputValue(String(page));
      onPageChange?.(page);
    }
  }, [onPageChange]);

  // Reset state when PDF changes
  useEffect(() => {
    hasInitialScale.current = false;
    pageWidthRef.current = 0;
    pageHeightRef.current = 0;
    setVisiblePages(new Set([1]));
  }, [pdfUrl]);

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
        const containerWidth = currentWidth - 20;
        if (containerWidth > 0) {
          setScale(containerWidth / pageWidthRef.current);
        }
      }
    });

    resizeObserver.observe(container);
    return () => resizeObserver.disconnect();
  }, []);

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

  // Track current page via scroll position and update visible pages for virtualization
  useEffect(() => {
    const container = containerRef.current;
    if (!container || numPages === 0) return;

    const BUFFER = isMobile ? 1 : 3; // fewer buffered pages on mobile to save memory

    const updateVisibility = () => {
      const pages = container.querySelectorAll('[data-page-number]');
      if (pages.length === 0) return;

      const containerTop = container.getBoundingClientRect().top;
      const containerBottom = containerTop + container.clientHeight;
      let visiblePage = 1;
      const newVisible = new Set<number>();

      for (const page of pages) {
        const rect = page.getBoundingClientRect();
        if (rect.top <= containerTop + 50) {
          const pageNum = Number(page.getAttribute('data-page-number'));
          if (!isNaN(pageNum)) {
            visiblePage = pageNum;
          }
        }
        // Check if page is in or near the viewport
        const pageNum = Number(page.getAttribute('data-page-number'));
        if (!isNaN(pageNum) && rect.bottom >= containerTop - container.clientHeight * BUFFER && rect.top <= containerBottom + container.clientHeight * BUFFER) {
          newVisible.add(pageNum);
        }
      }

      // Always include a buffer around current page as fallback
      for (let i = Math.max(1, visiblePage - BUFFER); i <= Math.min(numPages, visiblePage + BUFFER); i++) {
        newVisible.add(i);
      }

      updateCurrentPage(visiblePage);
      setVisiblePages(prev => {
        // Avoid unnecessary re-renders by checking if the set actually changed
        if (prev.size === newVisible.size && [...newVisible].every(p => prev.has(p))) return prev;
        return newVisible;
      });
    };

    // Initial visibility calculation
    updateVisibility();

    container.addEventListener('scroll', updateVisibility, { passive: true });
    return () => container.removeEventListener('scroll', updateVisibility);
  }, [numPages, updateCurrentPage]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function onDocumentLoadSuccess(pdf: any) {
    setNumPages(pdf.numPages);
    pdfDocRef.current = pdf;
    setError(false);

    // Calculate fit-to-width scale from the first page
    if (!hasInitialScale.current) {
      hasInitialScale.current = true;
      pdf.getPage(1).then((page: { getViewport: (opts: { scale: number }) => { width: number; height: number } }) => {
        const container = containerRef.current;
        if (!container) return;
        const viewport = page.getViewport({ scale: 1 });
        // Account for padding/scrollbar in the container
        const containerWidth = container.clientWidth - 20;
        pageWidthRef.current = viewport.width;
        pageHeightRef.current = viewport.height;
        lastContainerWidthRef.current = container.clientWidth;
        if (viewport.width > 0 && containerWidth > 0) {
          const fitScale = containerWidth / viewport.width;
          setScale(fitScale);
        }
      }).catch(() => {
        // Keep default scale on error
      });
    }

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

  const scrollToPage = useCallback((page: number) => {
    const container = containerRef.current;
    if (!container) return;
    const el = container.querySelector(`[data-page-number="${page}"]`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, []);

  const goToPage = useCallback((page: number) => {
    if (isNaN(page)) return;
    const clamped = Math.max(1, Math.min(page, numPages));
    updateCurrentPage(clamped);
    scrollToPage(clamped);
  }, [numPages, updateCurrentPage, scrollToPage]);

  // react-pdf's <Document> captures onItemClick inside a useRef on first render,
  // so any closure passed inline would see numPages=0 and clamp every jump to page 1.
  // Route through a ref to always hit the current goToPage.
  const goToPageRef = useRef(goToPage);
  useEffect(() => {
    goToPageRef.current = goToPage;
  }, [goToPage]);
  const handleItemClick = useCallback(({ pageNumber }: { pageNumber: number }) => {
    goToPageRef.current(pageNumber);
  }, []);

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
          goToPage(pageIndex + 1);
        }
      }
    } catch (err) {
      console.error('Failed to navigate to outline destination:', err);
    }
  }, [goToPage]);

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
          {outline.length > 0 && (
            <button
              className={`pdf-nav-btn ${outlineOpen ? 'pdf-nav-btn-active' : ''}`}
              onClick={() => setOutlineOpen(o => !o)}
              title="Toggle outline"
            >
              <Icon name="hamburger" />
            </button>
          )}
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
        {onToggleImmersive && (
          <button
            className={`pdf-fullscreen-btn ${immersiveMode ? 'pdf-nav-btn-active' : ''}`}
            onClick={onToggleImmersive}
            title={immersiveMode ? 'Exit immersive mode (Esc)' : 'Immersive mode — hide all toolbars'}
          >
            {immersiveMode ? <Icon name="close" /> : <Icon name="expand" />}
          </button>
        )}
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

        <div className="pdf-pages-container" ref={containerRef}>
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
            {Array.from({ length: numPages }, (_, i) => (
              <div
                key={i + 1}
                data-page-number={i + 1}
                className="pdf-page-wrapper"
                style={!visiblePages.has(i + 1) && pageHeightRef.current > 0
                  ? { height: `${pageHeightRef.current * scale}px`, minHeight: `${pageHeightRef.current * scale}px` }
                  : undefined}
              >
                {visiblePages.has(i + 1) ? (
                  <Page
                    pageNumber={i + 1}
                    scale={scale}
                    devicePixelRatio={canvasPixelRatio}
                    loading=""
                    error={
                      <div className="pdf-page-error">
                        <p>Page {i + 1} failed to render</p>
                      </div>
                    }
                  />
                ) : null}
              </div>
            ))}
          </Document>
        </div>
      </div>
    </div>
  );
}
