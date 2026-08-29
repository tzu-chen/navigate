import { useState, useEffect, useCallback, useRef } from 'react';
import { SavedPaper, ArxivPaper, Comment, CommentPositionRect, Tag } from '../types';
import * as api from '../services/api';
import PDFViewer from './PDFViewer';
import CommentPanel from './CommentPanel';
import ChatPanel from './ChatPanel';
import WorldlineSidebarPanel from './WorldlineSidebarPanel';
import WalkthroughPane from './WalkthroughPane';
import WorldlineNavOverlay from './WorldlineNavOverlay';
import FloatingCommentBox from './FloatingCommentBox';
import LaTeX from './LaTeX';
import Icon from './Icon';
import { useKeyboardShortcut } from '../hooks/useKeyboardShortcut';

function isSavedPaper(paper: SavedPaper | ArxivPaper): paper is SavedPaper {
  return 'arxiv_id' in paper;
}

interface Props {
  paper: SavedPaper | ArxivPaper;
  isInLibrary: boolean;
  onSavePaper?: () => Promise<void>;
  onDeletePaper?: () => Promise<void>;
  showNotification: (msg: string) => void;
  favoriteAuthorNames: Set<string>;
  onFavoriteAuthor: (name: string) => void;
  onSearchAuthor: (name: string) => void;
  onOpenPaper: (paper: SavedPaper) => void;
  browsePapers?: ArxivPaper[];
  browsePageOffset?: number;
  browseTotalResults?: number;
  onBrowseNavigate?: (paper: ArxivPaper) => void;
  onImmersiveModeChange?: (immersive: boolean) => void;
  initialPage?: number;
}

type SidebarSection = 'comments' | 'chat' | 'worldline';
/**
 * The viewer's left slot. Not a new top-level ViewMode: the whole sidebar —
 * chat, comments, worldline — stays live and useful beside a walkthrough, and
 * "chat about the paper while the mechanism is on screen" is the best thing
 * this feature can offer.
 *
 * `split` shows both at once, which is the mode that makes a walkthrough
 * genuinely useful — the point of an explainer is checking it against the paper.
 *
 * **Both panes stay mounted in every mode**, hidden with CSS rather than
 * unmounted. Remounting would re-fetch and re-parse the PDF, lose its scroll
 * position, and reload the walkthrough's iframe from scratch (MathJax and all),
 * which is exactly the cost you notice when flipping back and forth. PDFViewer
 * carries a ResizeObserver and its `fitToWidth` already ignores a zero-width
 * container, so hiding and re-showing refits it correctly.
 */
type PaneMode = 'pdf' | 'split' | 'walkthrough';

const PANE_MODES: {
  mode: PaneMode;
  icon: 'pane-pdf' | 'pane-split' | 'pane-walkthrough';
  label: string;
  title: string;
}[] = [
  { mode: 'pdf', icon: 'pane-pdf', label: 'PDF', title: 'PDF only' },
  { mode: 'split', icon: 'pane-split', label: 'Split', title: 'PDF and walkthrough side by side' },
  { mode: 'walkthrough', icon: 'pane-walkthrough', label: 'Walkthrough', title: 'Walkthrough only' },
];

export default function PaperViewer({ paper, isInLibrary, onSavePaper, onDeletePaper, showNotification, favoriteAuthorNames, onFavoriteAuthor, onSearchAuthor, onOpenPaper, browsePapers, browsePageOffset = 0, browseTotalResults = 0, onBrowseNavigate, onImmersiveModeChange, initialPage }: Props) {
  const [comments, setComments] = useState<Comment[]>([]);
  const [paperTags, setPaperTags] = useState<Tag[]>([]);
  const [currentTier, setCurrentTier] = useState<number | null>(
    isSavedPaper(paper) ? paper.tier : null,
  );
  const [collapsedSections, setCollapsedSections] = useState<Set<SidebarSection>>(new Set());
  const [currentPage, setCurrentPage] = useState(initialPage ?? 1);
  const [jumpToPage, setJumpToPage] = useState<number | undefined>(initialPage);
  const [sidebarVisible, setSidebarVisible] = useState(false);
  const [immersiveMode, setImmersiveMode] = useState(true);
  const [saving, setSaving] = useState(false);
  const [sendingToScribe, setSendingToScribe] = useState(false);
  const [pdfSelection, setPdfSelection] = useState<{ text: string; pageNumber: number; rects: CommentPositionRect[] } | null>(null);
  const [floatingCommentAnchor, setFloatingCommentAnchor] = useState<{ x: number; y: number } | null>(null);
  const [worldlineNavOpen, setWorldlineNavOpen] = useState(false);
  const [paneMode, setPaneMode] = useState<PaneMode>('pdf');

  const handleRequestAddComment = useCallback((anchor: { x: number; y: number }) => {
    setFloatingCommentAnchor(anchor);
  }, []);

  const closeFloatingComment = useCallback(() => {
    setFloatingCommentAnchor(null);
    setPdfSelection(null);
  }, []);

  const saved = isSavedPaper(paper) ? paper : null;
  const arxivId = saved ? saved.arxiv_id : (paper as ArxivPaper).id;
  const absUrl = saved ? saved.abs_url : (paper as ArxivPaper).absUrl;
  const authors = saved ? JSON.parse(saved.authors) as string[] : (paper as ArxivPaper).authors;
  const categories = saved ? JSON.parse(saved.categories) as string[] : (paper as ArxivPaper).categories;

  // Browse navigation
  const browseIndex = browsePapers && browsePapers.length > 0
    ? browsePapers.findIndex(p => p.id === arxivId)
    : -1;
  const canBrowseNav = browseIndex >= 0 && onBrowseNavigate;
  const hasPrev = canBrowseNav && browseIndex > 0;
  const hasNext = canBrowseNav && browseIndex < browsePapers!.length - 1;

  const loadComments = useCallback(async () => {
    const s = isSavedPaper(paper) ? paper : null;
    if (!s) return;
    try {
      const data = await api.getComments(s.id);
      setComments(data);
    } catch (err) {
      console.error('Failed to load comments:', err);
    }
  }, [paper]);

  const handleDeleteComment = useCallback(async (commentId: number) => {
    const s = isSavedPaper(paper) ? paper : null;
    if (!s) return;
    try {
      await api.deleteComment(s.id, commentId);
      await loadComments();
    } catch {
      showNotification('Failed to delete comment');
    }
  }, [paper, loadComments, showNotification]);

  const loadPaperTags = useCallback(async () => {
    const s = isSavedPaper(paper) ? paper : null;
    if (!s) return;
    try {
      const data = await api.getPaperTags(s.id);
      setPaperTags(data);
    } catch (err) {
      console.error('Failed to load tags:', err);
    }
  }, [paper]);

  useEffect(() => {
    loadComments();
    loadPaperTags();
    setPdfSelection(null);
    setFloatingCommentAnchor(null);
    setCurrentTier(isSavedPaper(paper) ? paper.tier : null);
  }, [loadComments, loadPaperTags, paper]);

  // The chosen layout persists across papers — flipping back and forth is the
  // whole point — except for uploads, which can never have a walkthrough and
  // would otherwise strand the reader in a pane with no toggle to leave it.
  const canWalkthrough = !arxivId.startsWith('upload-');
  useEffect(() => {
    if (!canWalkthrough) setPaneMode('pdf');
  }, [canWalkthrough]);
  const effectiveMode: PaneMode = canWalkthrough ? paneMode : 'pdf';

  /**
   * The walkthrough pane mounts only once it has actually been shown, and stays
   * mounted afterwards.
   *
   * Hiding the pane with `display: none` gives its iframe a zero-size box, and
   * a bundle that loads in one typesets its first scene against font metrics
   * measured as 0 — MathJax reads `offsetWidth`/`offsetHeight` — which yields
   * equations with enormous `ex` widths and glyphs sprawling over the page.
   * Since `pdf` is the default mode, mounting eagerly meant every walkthrough
   * was typeset while invisible. The bundle also defends itself now (`wt.js`
   * waits for a real box), but not mounting it into nothing is the cheaper half
   * of the fix, and it keeps the no-reload-on-toggle behaviour intact.
   */
  const [walkthroughMounted, setWalkthroughMounted] = useState(false);
  useEffect(() => {
    if (effectiveMode !== 'pdf') setWalkthroughMounted(true);
  }, [effectiveMode]);

  // A walkthrough scene saying "this is Figure 3" drives the real PDF viewer.
  // `currentPage` is shared across both panes, so flipping back lands there.
  const handleWalkthroughGotoPage = useCallback((page: number) => {
    setJumpToPage(page);
    setCurrentPage(page);
    // Reveal the PDF if it is not already on screen, but never *hide* the
    // walkthrough the reader was just reading — in split mode both stay put.
    setPaneMode(m => (m === 'walkthrough' ? 'split' : m));
  }, []);

  // Notify parent when immersive mode changes
  useEffect(() => {
    onImmersiveModeChange?.(immersiveMode);
  }, [immersiveMode, onImmersiveModeChange]);

  // Escape key exits immersive mode
  useEffect(() => {
    if (!immersiveMode) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setImmersiveMode(false);
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [immersiveMode]);

  // Re-arm page jump + open sidebar whenever parent supplies a new initialPage
  useEffect(() => {
    if (initialPage !== undefined) {
      setJumpToPage(initialPage);
      setSidebarVisible(true);
      setCollapsedSections(prev => {
        if (!prev.has('comments')) return prev;
        const next = new Set(prev);
        next.delete('comments');
        return next;
      });
    }
  }, [initialPage]);

  const toggleSection = useCallback((section: SidebarSection) => {
    setCollapsedSections(prev => {
      const next = new Set(prev);
      if (next.has(section)) next.delete(section);
      else next.add(section);
      return next;
    });
  }, []);

  const togglePanel = useCallback(() => setSidebarVisible(v => !v), []);
  useKeyboardShortcut('pdfPanelToggle', togglePanel);

  const toggleImmersive = useCallback(() => setImmersiveMode(m => !m), []);
  useKeyboardShortcut('pdfImmersiveToggle', toggleImmersive);

  const openWorldlineNav = useCallback(() => {
    if (saved) setWorldlineNavOpen(true);
  }, [saved]);
  useKeyboardShortcut('pdfWorldlineToggle', openWorldlineNav, !!saved && !worldlineNavOpen);

  const handleSavePaper = useCallback(async () => {
    if (isInLibrary || !onSavePaper || saving) return;
    setSaving(true);
    try {
      await onSavePaper();
    } finally {
      setSaving(false);
    }
  }, [isInLibrary, onSavePaper, saving]);
  useKeyboardShortcut('pdfSavePaper', handleSavePaper, !isInLibrary && !!onSavePaper);

  const handleTierChange = useCallback(async (tier: number | null) => {
    if (!saved) return;
    const prev = currentTier;
    setCurrentTier(tier);
    try {
      await api.updatePaperTier(saved.id, tier);
    } catch {
      setCurrentTier(prev);
      showNotification('Failed to update tier');
    }
  }, [saved, currentTier, showNotification]);

  const setTier0 = useCallback(() => { handleTierChange(0); }, [handleTierChange]);
  const setTier1 = useCallback(() => { handleTierChange(1); }, [handleTierChange]);
  const setTier2 = useCallback(() => { handleTierChange(2); }, [handleTierChange]);
  const setTier3 = useCallback(() => { handleTierChange(3); }, [handleTierChange]);
  const setTier4 = useCallback(() => { handleTierChange(4); }, [handleTierChange]);
  useKeyboardShortcut('pdfTierSet0', setTier0, !!saved);
  useKeyboardShortcut('pdfTierSet1', setTier1, !!saved);
  useKeyboardShortcut('pdfTierSet2', setTier2, !!saved);
  useKeyboardShortcut('pdfTierSet3', setTier3, !!saved);
  useKeyboardShortcut('pdfTierSet4', setTier4, !!saved);

  // Swipe left/right to navigate between papers (mobile)
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);
  const viewerBodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!canBrowseNav) return;
    const el = viewerBodyRef.current;
    if (!el) return;

    const onTouchStart = (e: TouchEvent) => {
      touchStartRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    };
    const onTouchEnd = (e: TouchEvent) => {
      if (!touchStartRef.current) return;
      const dx = e.changedTouches[0].clientX - touchStartRef.current.x;
      const dy = e.changedTouches[0].clientY - touchStartRef.current.y;
      touchStartRef.current = null;
      if (Math.abs(dx) < 80 || Math.abs(dy) > Math.abs(dx) * 0.5) return;
      if (dx > 0 && hasPrev) {
        onBrowseNavigate!(browsePapers![browseIndex - 1]);
      } else if (dx < 0 && hasNext) {
        onBrowseNavigate!(browsePapers![browseIndex + 1]);
      }
    };

    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchend', onTouchEnd, { passive: true });
    return () => {
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchend', onTouchEnd);
    };
  }, [canBrowseNav, hasPrev, hasNext, browseIndex, browsePapers, onBrowseNavigate]);

  return (
    <div className={`paper-viewer ${immersiveMode ? 'immersive-mode' : ''}`}>
      <div className="viewer-header">
        <div className="viewer-title-row">
          <h2><LaTeX>{paper.title}</LaTeX></h2>
          <div className="viewer-title-actions">
            {canBrowseNav && (
              <div className="browse-nav">
                <button
                  className="btn btn-secondary btn-sm browse-nav-btn"
                  disabled={!hasPrev}
                  onClick={() => hasPrev && onBrowseNavigate!(browsePapers![browseIndex - 1])}
                  title="Previous paper in browse list"
                >
                  &#8592; Prev
                </button>
                <span className="browse-nav-index">
                  {browsePageOffset + browseIndex + 1}/{browseTotalResults || browsePapers!.length}
                </span>
                <button
                  className="btn btn-secondary btn-sm browse-nav-btn"
                  disabled={!hasNext}
                  onClick={() => hasNext && onBrowseNavigate!(browsePapers![browseIndex + 1])}
                  title="Next paper in browse list"
                >
                  Next &#8594;
                </button>
              </div>
            )}
            {saved && (
              <select
                className={`tier-select tier-select-header tier-select-${currentTier ?? 'ungraded'}`}
                value={currentTier === null ? '' : String(currentTier)}
                onChange={e => {
                  const v = e.target.value;
                  handleTierChange(v === '' ? null : parseInt(v, 10));
                }}
                title={currentTier === null ? 'Ungraded — press 0–4 to grade' : `T${currentTier} — press 0–4 to change`}
              >
                <option value="">—</option>
                <option value="0">T0</option>
                <option value="1">T1</option>
                <option value="2">T2</option>
                <option value="3">T3</option>
                <option value="4">T4</option>
              </select>
            )}
            {canWalkthrough && (
              <div className="pane-toggle" role="group" aria-label="Pane layout">
                {PANE_MODES.map(({ mode, icon, label, title }) => (
                  <button
                    key={mode}
                    className={`pane-toggle-btn ${effectiveMode === mode ? 'is-active' : ''}`}
                    onClick={() => setPaneMode(mode)}
                    title={title}
                    aria-label={label}
                    aria-pressed={effectiveMode === mode}
                  >
                    <Icon name={icon} />
                  </button>
                ))}
              </div>
            )}
            {absUrl && !arxivId.startsWith('upload-') && (
              <a
                href={absUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="btn btn-secondary btn-sm"
              >
                ArXiv Page
              </a>
            )}
            {isInLibrary ? (
              <>
                <button className="btn btn-success btn-sm" disabled>
                  In Library
                </button>
                <button
                  className="btn btn-primary btn-sm"
                  disabled={sendingToScribe}
                  onClick={async () => {
                    if (!saved) return;
                    if (!confirm(`Send "${paper.title}" to Scribe? It will be removed from Navigate.`)) return;
                    setSendingToScribe(true);
                    try {
                      const result = await api.sendToScribe([saved.id]);
                      if (result.sent > 0) {
                        showNotification('Sent to Scribe');
                        if (onDeletePaper) await onDeletePaper();
                      } else {
                        showNotification(result.errors[0] || 'Failed to send to Scribe');
                      }
                    } catch {
                      showNotification('Failed to send to Scribe. Is Scribe running?');
                    } finally {
                      setSendingToScribe(false);
                    }
                  }}
                >
                  {sendingToScribe ? 'Sending...' : 'Send to Scribe'}
                </button>
                {onDeletePaper && (
                  <button
                    className="btn btn-danger btn-sm"
                    onClick={async () => {
                      if (!confirm(`Delete "${paper.title}" from your library?`)) return;
                      await onDeletePaper();
                    }}
                  >
                    Delete
                  </button>
                )}
              </>
            ) : (
              <button
                className="btn btn-primary btn-sm"
                onClick={handleSavePaper}
                disabled={saving}
              >
                {saving ? 'Saving...' : 'Save'}
              </button>
            )}
          </div>
        </div>
        <div className="viewer-meta">
          <span className="paper-authors">
            {authors.map((author, i) => (
              <span key={i}>
                {i > 0 && ', '}
                <button
                  className={`author-name-btn ${favoriteAuthorNames.has(author) ? 'is-favorite' : ''}`}
                  onClick={() => !favoriteAuthorNames.has(author) && onFavoriteAuthor(author)}
                  onContextMenu={(e) => { e.preventDefault(); onSearchAuthor(author); }}
                  title={favoriteAuthorNames.has(author) ? 'Already in favorites' : `Add ${author} to favorites | Right-click to search`}
                >
                  {author}
                </button>
              </span>
            ))}
          </span>
          <span>{new Date(paper.published).toLocaleDateString()}</span>
          {categories.map(c => (
            <span key={c} className={`category-badge cat-${c.includes('.') ? c.split('.')[0] : c}`}>{c}</span>
          ))}
          {paperTags.map(t => (
            <span key={t.id} className="tag-badge" style={{ backgroundColor: t.color }}>
              {t.name}
            </span>
          ))}
        </div>
      </div>

      <div className="viewer-body" ref={viewerBodyRef}>
        <div className={`viewer-pdf viewer-panes pane-mode-${effectiveMode}`}>
          {/* Both panes stay mounted; the mode class decides which are visible.
              Unmounting would re-parse the PDF and reload the walkthrough's
              iframe every time the reader flipped between them. */}
          <div className="viewer-pane viewer-pane-pdf">
            <PDFViewer
              pdfUrl={saved?.pdf_path ? api.getLocalPdfUrl(saved.id) : (arxivId.startsWith('upload-') ? '' : api.getPdfProxyUrl(arxivId))}
              onPageChange={setCurrentPage}
              immersiveMode={immersiveMode}
              onToggleImmersive={() => setImmersiveMode(m => !m)}
              jumpToPage={jumpToPage}
              onJumpApplied={() => setJumpToPage(undefined)}
              onTextSelected={saved ? setPdfSelection : undefined}
              onRequestAddComment={saved ? handleRequestAddComment : undefined}
              comments={comments}
              onDeleteComment={saved ? handleDeleteComment : undefined}
            />
          </div>
          {canWalkthrough && walkthroughMounted && (
            <div className="viewer-pane viewer-pane-walkthrough">
              <WalkthroughPane
                arxivId={arxivId}
                paperTitle={paper.title}
                onGotoPage={handleWalkthroughGotoPage}
                showNotification={showNotification}
              />
            </div>
          )}
          {saved && (
            <div className="panel-zone">
              <button
                className={`floating-toggle ${sidebarVisible ? 'floating-toggle-active' : ''}`}
                onClick={() => setSidebarVisible(v => !v)}
                title={sidebarVisible ? 'Hide panel' : 'Show panel'}
              >
                <Icon name="sidebar-right" />
              </button>
            </div>
          )}
        </div>

        {sidebarVisible && <div className="viewer-sidebar-backdrop active" onClick={() => setSidebarVisible(false)} />}
        {sidebarVisible && saved && <div className="viewer-sidebar">
          <div className={`sidebar-stack-section ${collapsedSections.has('comments') ? 'collapsed' : ''}`}>
            <button
              className="sidebar-section-header"
              onClick={() => toggleSection('comments')}
            >
              <span className="sidebar-section-caret">{collapsedSections.has('comments') ? '▸' : '▾'}</span>
              <span>Comments ({comments.length})</span>
            </button>
            {!collapsedSections.has('comments') && (
              <div className="sidebar-section-body">
                <CommentPanel
                  paperId={saved.id}
                  comments={comments}
                  currentPage={currentPage}
                  onPageChange={setCurrentPage}
                  onRefresh={loadComments}
                  showNotification={showNotification}
                  selection={pdfSelection}
                  onClearSelection={() => setPdfSelection(null)}
                />
              </div>
            )}
          </div>

          <div className={`sidebar-stack-section sidebar-stack-section-grow ${collapsedSections.has('chat') ? 'collapsed' : ''}`}>
            <button
              className="sidebar-section-header"
              onClick={() => toggleSection('chat')}
            >
              <span className="sidebar-section-caret">{collapsedSections.has('chat') ? '▸' : '▾'}</span>
              <span>Chat</span>
            </button>
            {!collapsedSections.has('chat') && (
              <div className="sidebar-section-body sidebar-section-body-chat">
                <ChatPanel
                  paper={saved}
                  showNotification={showNotification}
                />
              </div>
            )}
          </div>

          <div className={`sidebar-stack-section ${collapsedSections.has('worldline') ? 'collapsed' : ''}`}>
            <button
              className="sidebar-section-header"
              onClick={() => toggleSection('worldline')}
            >
              <span className="sidebar-section-caret">{collapsedSections.has('worldline') ? '▸' : '▾'}</span>
              <span>Worldline</span>
            </button>
            {!collapsedSections.has('worldline') && (
              <div className="sidebar-section-body">
                <WorldlineSidebarPanel
                  paper={saved}
                  onOpenPaper={onOpenPaper}
                  showNotification={showNotification}
                />
              </div>
            )}
          </div>
        </div>}
      </div>
      {saved && floatingCommentAnchor && pdfSelection && (
        <FloatingCommentBox
          paperId={saved.id}
          selection={pdfSelection}
          position={floatingCommentAnchor}
          onClose={closeFloatingComment}
          onAdded={loadComments}
          showNotification={showNotification}
        />
      )}
      {saved && worldlineNavOpen && (
        <WorldlineNavOverlay
          paper={saved}
          onOpenPaper={onOpenPaper}
          onClose={() => setWorldlineNavOpen(false)}
          showNotification={showNotification}
        />
      )}
    </div>
  );
}
