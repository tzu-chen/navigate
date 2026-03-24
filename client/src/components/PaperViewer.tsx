import { useState, useEffect, useCallback, useRef } from 'react';
import { SavedPaper, ArxivPaper, Comment, Tag } from '../types';
import * as api from '../services/api';
import PDFViewer from './PDFViewer';
import CommentPanel from './CommentPanel';
import TagPanel from './TagPanel';
import ExportPanel from './ExportPanel';
import ChatPanel from './ChatPanel';
import WorldlineSidebarPanel from './WorldlineSidebarPanel';
import WorldlineInfoPanel from './WorldlineInfoPanel';
import BatchImportPanel from './BatchImportPanel';
import LaTeX from './LaTeX';
import Icon from './Icon';

function isSavedPaper(paper: SavedPaper | ArxivPaper): paper is SavedPaper {
  return 'arxiv_id' in paper;
}

interface Props {
  paper: SavedPaper | ArxivPaper;
  isInLibrary: boolean;
  onSavePaper?: () => Promise<void>;
  onDeletePaper?: () => Promise<void>;
  allTags: Tag[];
  onTagsChanged: () => Promise<void>;
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
  onLibraryRefresh?: () => Promise<void>;
}

type SidePanel = 'chat' | 'comments' | 'export' | 'info' | 'worldline' | 'import';

export default function PaperViewer({ paper, isInLibrary, onSavePaper, onDeletePaper, allTags, onTagsChanged, showNotification, favoriteAuthorNames, onFavoriteAuthor, onSearchAuthor, onOpenPaper, browsePapers, browsePageOffset = 0, browseTotalResults = 0, onBrowseNavigate, onImmersiveModeChange, onLibraryRefresh }: Props) {
  const [comments, setComments] = useState<Comment[]>([]);
  const [paperTags, setPaperTags] = useState<Tag[]>([]);
  const [activePanel, setActivePanel] = useState<SidePanel>(isSavedPaper(paper) ? 'comments' : 'info');
  const [currentPage, setCurrentPage] = useState(1);
  const [sidebarVisible, setSidebarVisible] = useState(false);
  const [immersiveMode, setImmersiveMode] = useState(false);
  const [saving, setSaving] = useState(false);

  const saved = isSavedPaper(paper) ? paper : null;
  const arxivId = saved ? saved.arxiv_id : (paper as ArxivPaper).id;
  const absUrl = saved ? saved.abs_url : (paper as ArxivPaper).absUrl;
  const authors = saved ? JSON.parse(saved.authors) as string[] : (paper as ArxivPaper).authors;
  const categories = saved ? JSON.parse(saved.categories) as string[] : (paper as ArxivPaper).categories;
  const doi = saved ? saved.doi : (paper as ArxivPaper).doi || null;
  const journalRef = saved ? saved.journal_ref : (paper as ArxivPaper).journalRef || null;

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
  }, [loadComments, loadPaperTags]);

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

  // When paper transitions from unsaved to saved, switch to comments tab
  useEffect(() => {
    if (isSavedPaper(paper)) {
      setActivePanel(prev => prev === 'info' ? 'comments' : prev);
    }
  }, [paper]);

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
                onClick={async () => {
                  if (onSavePaper) {
                    setSaving(true);
                    try {
                      await onSavePaper();
                    } finally {
                      setSaving(false);
                    }
                  }
                }}
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
        <div className="viewer-pdf">
          <PDFViewer
            pdfUrl={saved?.pdf_path ? api.getLocalPdfUrl(saved.id) : (arxivId.startsWith('upload-') ? '' : api.getPdfProxyUrl(arxivId))}
            onPageChange={setCurrentPage}
            immersiveMode={immersiveMode}
            onToggleImmersive={() => setImmersiveMode(m => !m)}
          />
        </div>

        <button
          className="sidebar-toggle"
          onClick={() => setSidebarVisible(v => !v)}
          title={sidebarVisible ? 'Hide panel' : 'Show panel'}
        >
          {sidebarVisible ? <Icon name="chevron-right" /> : <Icon name="chevron-left" />}
        </button>

        {sidebarVisible && <div className="viewer-sidebar-backdrop active" onClick={() => setSidebarVisible(false)} />}
        {sidebarVisible && <div className="viewer-sidebar">
          <div className="sidebar-tabs">
            {saved && <button
              className={`sidebar-tab ${activePanel === 'chat' ? 'active' : ''}`}
              onClick={() => setActivePanel('chat')}
            >
              Chat
            </button>}
            {saved && <button
              className={`sidebar-tab ${activePanel === 'comments' ? 'active' : ''}`}
              onClick={() => setActivePanel('comments')}
            >
              Comments ({comments.length})
            </button>}
            {saved && <button
              className={`sidebar-tab ${activePanel === 'export' ? 'active' : ''}`}
              onClick={() => setActivePanel('export')}
            >
              Export
            </button>}
            <button
              className={`sidebar-tab ${activePanel === 'info' ? 'active' : ''}`}
              onClick={() => setActivePanel('info')}
            >
              Info
            </button>
            {saved && <button
              className={`sidebar-tab ${activePanel === 'worldline' ? 'active' : ''}`}
              onClick={() => setActivePanel('worldline')}
            >
              Worldline
            </button>}
            <button
              className={`sidebar-tab ${activePanel === 'import' ? 'active' : ''}`}
              onClick={() => setActivePanel('import')}
            >
              Import
            </button>
          </div>

          <div className={`sidebar-content ${activePanel === 'chat' ? 'sidebar-content-chat' : ''}`}>
            {activePanel === 'chat' && saved && (
              <ChatPanel
                paper={saved}
                showNotification={showNotification}
              />
            )}
            {activePanel === 'comments' && saved && (
              <CommentPanel
                paperId={saved.id}
                comments={comments}
                currentPage={currentPage}
                onPageChange={setCurrentPage}
                onRefresh={loadComments}
                showNotification={showNotification}
              />
            )}
            {activePanel === 'export' && saved && (
              <ExportPanel
                paper={saved}
                showNotification={showNotification}
              />
            )}
            {activePanel === 'info' && (
              <div className="info-panel">
                {saved && (
                  <div className="info-section">
                    <h4>Tags</h4>
                    <TagPanel
                      paperId={saved.id}
                      paperTags={paperTags}
                      allTags={allTags}
                      onRefresh={async () => { await loadPaperTags(); await onTagsChanged(); }}
                      showNotification={showNotification}
                    />
                  </div>
                )}
                {saved && (
                  <div className="info-section">
                    <h4>Worldlines</h4>
                    <WorldlineInfoPanel
                      paperId={saved.id}
                      showNotification={showNotification}
                    />
                  </div>
                )}
                <div className="info-section">
                  <h4>Abstract</h4>
                  <p><LaTeX>{paper.summary}</LaTeX></p>
                </div>
                <div className="info-section">
                  <h4>Authors</h4>
                  <p className="paper-authors">
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
                  </p>
                </div>
                <div className="info-section">
                  <h4>Categories</h4>
                  <p>{categories.join(', ')}</p>
                </div>
                <div className="info-section">
                  <h4>ArXiv ID</h4>
                  <p>{arxivId}</p>
                </div>
                {doi && (
                  <div className="info-section">
                    <h4>DOI</h4>
                    <p>{doi}</p>
                  </div>
                )}
                {journalRef && (
                  <div className="info-section">
                    <h4>Journal</h4>
                    <p>{journalRef}</p>
                  </div>
                )}
                <div className="info-section">
                  <h4>Published</h4>
                  <p>{new Date(paper.published).toLocaleDateString()}</p>
                </div>
                <div className="info-section">
                  <h4>Last Updated</h4>
                  <p>{new Date(paper.updated).toLocaleDateString()}</p>
                </div>
              </div>
            )}
            {activePanel === 'worldline' && saved && (
              <WorldlineSidebarPanel
                paper={saved}
                onOpenPaper={onOpenPaper}
                showNotification={showNotification}
              />
            )}
            {activePanel === 'import' && (
              <BatchImportPanel
                tags={allTags}
                showNotification={showNotification}
                onImportComplete={onLibraryRefresh || (async () => {})}
                compact
              />
            )}
          </div>
        </div>}
      </div>
    </div>
  );
}
