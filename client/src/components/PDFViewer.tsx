import { useState, useRef, useEffect, useCallback } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';

import Icon from './Icon';

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString();

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

export default function PDFViewer({ pdfUrl, onPageChange, immersiveMode, onToggleImmersive }: Props) {
  const [numPages, setNumPages] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [scale, setScale] = useState(1.2);
  const [error, setError] = useState(false);
  const [outline, setOutline] = useState<OutlineItem[]>([]);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [expandedItems, setExpandedItems] = useState<Set<string>>(new Set());
  const [pdfDarkTheme, setPdfDarkTheme] = useState(() => {
    return localStorage.getItem('pdfDarkTheme') === 'true';
  });
  const containerRef = useRef<HTMLDivElement>(null);
  const currentPageRef = useRef(1);
  const [pageInputValue, setPageInputValue] = useState('1');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pdfDocRef = useRef<any>(null);
  const hasInitialScale = useRef(false);

  const updateCurrentPage = useCallback((page: number) => {
    if (page !== currentPageRef.current) {
      currentPageRef.current = page;
      setCurrentPage(page);
      setPageInputValue(String(page));
      onPageChange?.(page);
    }
  }, [onPageChange]);

  // Reset initial scale flag when PDF changes
  useEffect(() => {
    hasInitialScale.current = false;
  }, [pdfUrl]);

  // Track current page via scroll position
  useEffect(() => {
    const container = containerRef.current;
    if (!container || numPages === 0) return;

    const handleScroll = () => {
      const pages = container.querySelectorAll('[data-page-number]');
      if (pages.length === 0) return;

      const containerTop = container.getBoundingClientRect().top;
      let visiblePage = 1;

      for (const page of pages) {
        const rect = page.getBoundingClientRect();
        if (rect.top <= containerTop + 50) {
          visiblePage = Number(page.getAttribute('data-page-number'));
        }
      }

      updateCurrentPage(visiblePage);
    };

    container.addEventListener('scroll', handleScroll, { passive: true });
    return () => container.removeEventListener('scroll', handleScroll);
  }, [numPages, updateCurrentPage]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function onDocumentLoadSuccess(pdf: any) {
    setNumPages(pdf.numPages);
    pdfDocRef.current = pdf;
    setError(false);

    // Calculate fit-to-width scale from the first page
    if (!hasInitialScale.current) {
      hasInitialScale.current = true;
      pdf.getPage(1).then((page: { getViewport: (opts: { scale: number }) => { width: number } }) => {
        const container = containerRef.current;
        if (!container) return;
        const viewport = page.getViewport({ scale: 1 });
        // Account for padding/scrollbar in the container
        const containerWidth = container.clientWidth - 20;
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
    const clamped = Math.max(1, Math.min(page, numPages));
    updateCurrentPage(clamped);
    scrollToPage(clamped);
  }, [numPages, updateCurrentPage, scrollToPage]);

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
        goToPage(pageIndex + 1);
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
      return next;
    });
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
            className={`pdf-nav-btn ${pdfDarkTheme ? 'pdf-nav-btn-active' : ''}`}
            onClick={togglePdfDarkTheme}
            title={pdfDarkTheme ? 'Switch to light mode' : 'Switch to dark mode'}
          >
            {pdfDarkTheme ? <Icon name="sun" /> : <Icon name="moon" />}
          </button>
          {onToggleImmersive && (
            <button
              className={`pdf-nav-btn ${immersiveMode ? 'pdf-nav-btn-active' : ''}`}
              onClick={onToggleImmersive}
              title={immersiveMode ? 'Exit immersive mode (Esc)' : 'Immersive mode — hide all toolbars'}
            >
              {immersiveMode ? <Icon name="close" /> : <Icon name="expand" />}
            </button>
          )}
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

        <div className="pdf-pages-container" ref={containerRef}>
          <Document
            file={pdfUrl}
            onLoadSuccess={onDocumentLoadSuccess}
            onLoadError={onDocumentLoadError}
            loading={<div className="pdf-loading">Loading PDF...</div>}
          >
            {Array.from({ length: numPages }, (_, i) => (
              <div
                key={i + 1}
                data-page-number={i + 1}
                className="pdf-page-wrapper"
              >
                <Page
                  pageNumber={i + 1}
                  scale={scale}
                  loading=""
                />
              </div>
            ))}
          </Document>
        </div>
      </div>
    </div>
  );
}
