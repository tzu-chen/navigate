import { useState, useEffect, useCallback } from 'react';
import { ArxivPaper, PaneMode, SavedPaper, Tag, FavoriteAuthor, ViewMode, WalkthroughGalleryItem } from './types';
import * as api from './services/api';
import { getSchemeById, applyColorScheme } from './colorSchemes';
import { useKeyboardShortcut } from './hooks/useKeyboardShortcut';
import PaperBrowser from './components/PaperBrowser';
import Library from './components/Library';
import PaperViewer from './components/PaperViewer';
import FavoriteAuthors from './components/FavoriteAuthors';
import ChatHistory from './components/ChatHistory';
import Comments from './components/Comments';
import WorldlinePanel from './components/WorldlinePanel';
import WalkthroughGallery from './components/WalkthroughGallery';
import SettingsModal from './components/SettingsModal';
import ArxivRefreshTimer from './components/ArxivRefreshTimer';
import ErrorBoundary from './components/ErrorBoundary';
import Icon from './components/Icon';

export default function App() {
  const [viewMode, setViewMode] = useState<ViewMode>('browse');
  const [previousViewMode, setPreviousViewMode] = useState<ViewMode>('library');
  const [savedPapers, setSavedPapers] = useState<SavedPaper[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [favoriteAuthors, setFavoriteAuthors] = useState<FavoriteAuthor[]>([]);
  const [selectedPaper, setSelectedPaper] = useState<SavedPaper | null>(null);
  const [previewPaper, setPreviewPaper] = useState<ArxivPaper | null>(null);
  const [browsePapers, setBrowsePapers] = useState<ArxivPaper[]>([]);
  const [browsePageOffset, setBrowsePageOffset] = useState(0);
  const [browseTotalResults, setBrowseTotalResults] = useState(0);
  const [notification, setNotification] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [immersiveMode, setImmersiveMode] = useState(false);
  const [pendingAuthorSearch, setPendingAuthorSearch] = useState<string | null>(null);
  const [initialPaperPage, setInitialPaperPage] = useState<number | undefined>(undefined);
  // Which viewer pane a paper opens into. Only the walkthrough gallery sets it;
  // everything else lands on the PDF, which is PaperViewer's own default.
  const [initialPaneMode, setInitialPaneMode] = useState<PaneMode | undefined>(undefined);

  const showNotification = useCallback((msg: string) => {
    setNotification(msg);
    setTimeout(() => setNotification(null), 3000);
  }, []);

  const loadLibrary = useCallback(async () => {
    try {
      const [papers, allTags] = await Promise.all([
        api.getSavedPapers(),
        api.getTags(),
      ]);
      setSavedPapers(papers);
      setTags(allTags);
    } catch (err) {
      console.error('Failed to load library:', err);
    }
  }, []);

  const loadFavoriteAuthors = useCallback(async () => {
    try {
      const authors = await api.getFavoriteAuthors();
      setFavoriteAuthors(authors);
    } catch (err) {
      console.error('Failed to load favorite authors:', err);
    }
  }, []);

  useEffect(() => {
    loadLibrary();
    loadFavoriteAuthors();
  }, [loadLibrary, loadFavoriteAuthors]);

  useEffect(() => {
    // Visual prefs are stored locally for instant theme application
    const visualPrefs = api.getVisualPrefsSync();
    const targetSchemeId = visualPrefs.autoSwitch.enabled
      ? api.getSchemeForCurrentTime(visualPrefs.autoSwitch)
      : visualPrefs.colorScheme;
    const scheme = getSchemeById(targetSchemeId);
    if (scheme) {
      applyColorScheme(scheme);
    }
    api.applyCardFontSize(visualPrefs.cardFontSize);

    // Re-check every minute so auto-switch transitions cleanly across the day/night boundary.
    // The interval also auto-recovers if the user toggles auto-switch on without an app reload.
    const interval = setInterval(() => {
      const prefs = api.getVisualPrefsSync();
      if (!prefs.autoSwitch.enabled) return;
      const id = api.getSchemeForCurrentTime(prefs.autoSwitch);
      const next = getSchemeById(id);
      if (next) applyColorScheme(next);
    }, 60_000);
    return () => clearInterval(interval);
  }, []);

  const favoriteAuthorNames = new Set(favoriteAuthors.map(a => a.name));

  const handleFavoriteAuthor = async (name: string) => {
    try {
      await api.addFavoriteAuthor(name);
      showNotification(`Added "${name}" to favorite authors`);
      await loadFavoriteAuthors();
    } catch (err: any) {
      showNotification(err.message || 'Failed to add author');
    }
  };

  const handleSearchAuthor = (name: string) => {
    setPendingAuthorSearch(name);
    setViewMode('browse');
  };

  const handleSavePaper = async (paper: ArxivPaper) => {
    try {
      const saved = await api.savePaper(paper);
      await loadLibrary();
      showNotification(`Saved "${saved.title}" to library`);
      return saved;
    } catch (err) {
      showNotification('Failed to save paper');
      throw err;
    }
  };

  const handleOpenPaper = (paper: SavedPaper, page?: number) => {
    setPreviousViewMode(viewMode);
    setSelectedPaper(paper);
    setInitialPaperPage(page);
    setInitialPaneMode(undefined);
    setBrowsePapers([]);
    setViewMode('viewer');
    api.markPaperViewed(paper.id).then(loadLibrary).catch(() => {});
  };

  const handleOpenArxivPaper = (paper: ArxivPaper) => {
    setPreviousViewMode(viewMode);
    setInitialPaneMode(undefined);
    // Only keep browse papers context when opening from Browse view
    if (viewMode !== 'browse') {
      setBrowsePapers([]);
    }
    const existing = savedPapers.find(p => p.arxiv_id === paper.id);
    if (existing) {
      setSelectedPaper(existing);
      setPreviewPaper(null);
      api.markPaperViewed(existing.id).then(loadLibrary).catch(() => {});
    } else {
      setPreviewPaper(paper);
      setSelectedPaper(null);
    }
    setViewMode('viewer');
  };

  const handleBrowseNavigate = (paper: ArxivPaper) => {
    const existing = savedPapers.find(p => p.arxiv_id === paper.id);
    if (existing) {
      setSelectedPaper(existing);
      setPreviewPaper(null);
    } else {
      setPreviewPaper(paper);
      setSelectedPaper(null);
    }
  };

  const handleSaveFromViewer = async (paper: ArxivPaper) => {
    try {
      const saved = await api.savePaper(paper);
      await loadLibrary();
      setSelectedPaper(saved);
      setPreviewPaper(null);
      showNotification(`Saved "${saved.title}" to library`);
    } catch (err) {
      showNotification('Failed to save paper');
    }
  };

  const handleDeleteFromViewer = async (paper: SavedPaper) => {
    try {
      await api.deletePaper(paper.id);
      showNotification(`Deleted "${paper.title}" from library`);
      setSelectedPaper(null);
      setPreviewPaper(null);
      setViewMode('library');
      await loadLibrary();
    } catch (err) {
      showNotification('Failed to delete paper');
    }
  };

  /**
   * Open a paper straight into its walkthrough.
   *
   * A walkthrough has no foreign key to `papers` on purpose, so the gallery can
   * hold one whose paper has gone to Scribe or been deleted. When that happens
   * there is no SavedPaper to hand the viewer, so the entry's own identity —
   * carried from the ever-saved ledger — is enough to open it as a preview: the
   * walkthrough pane keys off the arXiv id alone, and the PDF comes from the
   * proxy the same way any unsaved paper's does.
   */
  const handleOpenWalkthrough = async (item: WalkthroughGalleryItem) => {
    setPreviousViewMode('walkthroughs');
    setBrowsePapers([]);
    setInitialPaperPage(undefined);
    setInitialPaneMode('walkthrough');

    const existing = savedPapers.find(p => p.arxiv_id === item.arxivId);
    if (existing) {
      setSelectedPaper(existing);
      setPreviewPaper(null);
      setViewMode('viewer');
      api.markPaperViewed(existing.id).then(loadLibrary).catch(() => {});
      return;
    }

    // Show the paper immediately from what the gallery already knows, so the
    // walkthrough opens at once, then fill in the fuller arXiv record if it
    // answers. Rows outlined before the title was stored on them carry only the
    // arXiv id, and this is what puts a real title in the viewer's header.
    const fallback: ArxivPaper = {
      id: item.arxivId,
      title: item.title,
      summary: '',
      authors: item.authors,
      published: item.published ?? item.createdAt,
      updated: item.published ?? item.createdAt,
      categories: item.categories,
      pdfUrl: `https://arxiv.org/pdf/${item.arxivId}`,
      absUrl: `https://arxiv.org/abs/${item.arxivId}`,
    };
    setSelectedPaper(null);
    setPreviewPaper(fallback);
    setViewMode('viewer');
    try {
      const fetched = await api.getArxivPaper(item.arxivId);
      setPreviewPaper(current => (current?.id === item.arxivId ? fetched : current));
    } catch {
      /* offline, or a withdrawn paper — the fallback record is still usable */
    }
  };

  const viewModeLabels: Record<ViewMode, string> = {
    browse: 'Browse',
    library: 'Library',
    authors: 'Authors',
    worldline: 'Worldlines',
    chatHistory: 'Chat History',
    comments: 'Comments',
    walkthroughs: 'Walkthroughs',
    viewer: 'Library',
  };

  const handleBackFromViewer = () => {
    setSelectedPaper(null);
    setPreviewPaper(null);
    setViewMode(previousViewMode);
    if (previousViewMode === 'library') {
      loadLibrary();
    }
  };

  const navigateTo = useCallback((target: ViewMode) => {
    setSelectedPaper(null);
    setPreviewPaper(null);
    setImmersiveMode(false);
    setViewMode(target);
    if (target === 'library') loadLibrary();
  }, [loadLibrary]);

  // Settings modal blocks shortcuts so the user can rebind without firing actions.
  const shortcutsEnabled = !settingsOpen;
  useKeyboardShortcut('goToLibrary', () => navigateTo('library'), shortcutsEnabled);
  useKeyboardShortcut('goToBrowse', () => navigateTo('browse'), shortcutsEnabled);

  return (
    <div className="app">
      {!immersiveMode && <header className="app-header">
        <div className="header-left">
          {viewMode !== 'viewer' && (
            <>
              <nav className="icon-rail">
                <button
                  className={`icon-rail-btn ${viewMode === 'browse' ? 'active' : ''}`}
                  onClick={() => setViewMode('browse')}
                  title="Browse ArXiv"
                >
                  <Icon name="compass" size="18px" />
                </button>
                <button
                  className={`icon-rail-btn ${viewMode === 'library' ? 'active' : ''}`}
                  onClick={() => setViewMode('library')}
                  title={`My Library (${savedPapers.length})`}
                >
                  <Icon name="book" size="18px" />
                </button>
                <button
                  className={`icon-rail-btn ${viewMode === 'authors' ? 'active' : ''}`}
                  onClick={() => setViewMode('authors')}
                  title={`Favorite Authors (${favoriteAuthors.length})`}
                >
                  <Icon name="users" size="18px" />
                </button>
                <button
                  className={`icon-rail-btn ${viewMode === 'worldline' ? 'active' : ''}`}
                  onClick={() => setViewMode('worldline')}
                  title="Worldlines"
                >
                  <Icon name="branch" size="18px" />
                </button>
                <button
                  className={`icon-rail-btn ${viewMode === 'walkthroughs' ? 'active' : ''}`}
                  onClick={() => setViewMode('walkthroughs')}
                  title="Walkthroughs"
                >
                  <Icon name="pane-walkthrough" size="18px" />
                </button>
                <button
                  className={`icon-rail-btn ${viewMode === 'chatHistory' ? 'active' : ''}`}
                  onClick={() => setViewMode('chatHistory')}
                  title="Chat History"
                >
                  <Icon name="chat" size="18px" />
                </button>
                <button
                  className={`icon-rail-btn ${viewMode === 'comments' ? 'active' : ''}`}
                  onClick={() => setViewMode('comments')}
                  title="All Comments"
                >
                  <Icon name="pencil" size="18px" />
                </button>
              </nav>
              <select
                className="nav-dropdown"
                value={viewMode}
                onChange={e => setViewMode(e.target.value as ViewMode)}
              >
                <option value="browse">Browse ArXiv</option>
                <option value="library">My Library ({savedPapers.length})</option>
                <option value="authors">Favorite Authors ({favoriteAuthors.length})</option>
                <option value="worldline">Worldlines</option>
                <option value="walkthroughs">Walkthroughs</option>
                <option value="chatHistory">Chat History</option>
                <option value="comments">Comments</option>
              </select>
            </>
          )}
          {viewMode === 'viewer' && (
            <button className="back-btn" onClick={handleBackFromViewer}>
              <Icon name="arrow-left" size="14px" /> Back to {viewModeLabels[previousViewMode]}
            </button>
          )}
        </div>
        <div className="header-right">
          <ArxivRefreshTimer />
          <button
            className="settings-btn"
            onClick={() => setSettingsOpen(true)}
            title="Settings"
          >
            <Icon name="gear" />
          </button>
        </div>
      </header>}

      {notification && (
        <div className="notification">{notification}</div>
      )}

      <main className="app-main">
        {viewMode === 'browse' && (
          <PaperBrowser
            onSavePaper={handleSavePaper}
            onOpenPaper={handleOpenArxivPaper}
            savedPaperIds={new Set(savedPapers.map(p => p.arxiv_id))}
            favoriteAuthorNames={favoriteAuthorNames}
            onFavoriteAuthor={handleFavoriteAuthor}
            onPapersLoaded={(papers, pageOffset, totalResults) => {
              setBrowsePapers(papers);
              setBrowsePageOffset(pageOffset);
              setBrowseTotalResults(totalResults);
            }}
            pendingAuthorSearch={pendingAuthorSearch}
            onAuthorSearchHandled={() => setPendingAuthorSearch(null)}
          />
        )}
        {viewMode === 'library' && (
          <Library
            papers={savedPapers}
            tags={tags}
            onOpenPaper={handleOpenPaper}
            onRefresh={loadLibrary}
            showNotification={showNotification}
            favoriteAuthorNames={favoriteAuthorNames}
            onFavoriteAuthor={handleFavoriteAuthor}
            onSearchAuthor={handleSearchAuthor}
          />
        )}
        {viewMode === 'authors' && (
          <FavoriteAuthors
            favoriteAuthors={favoriteAuthors}
            onAuthorsChanged={loadFavoriteAuthors}
            onSavePaper={handleSavePaper}
            onOpenPaper={handleOpenArxivPaper}
            savedPaperIds={new Set(savedPapers.map(p => p.arxiv_id))}
            showNotification={showNotification}
          />
        )}
        {viewMode === 'worldline' && (
          <WorldlinePanel
            papers={savedPapers}
            showNotification={showNotification}
            onRefresh={loadLibrary}
            onOpenPaper={handleOpenPaper}
          />
        )}
        {viewMode === 'walkthroughs' && (
          <WalkthroughGallery
            onOpen={handleOpenWalkthrough}
            showNotification={showNotification}
          />
        )}
        {viewMode === 'chatHistory' && (
          <ChatHistory
            savedPapers={savedPapers}
            onOpenPaper={handleOpenPaper}
            showNotification={showNotification}
          />
        )}
        {viewMode === 'comments' && (
          <Comments
            savedPapers={savedPapers}
            onOpenPaper={handleOpenPaper}
            showNotification={showNotification}
          />
        )}
        {viewMode === 'viewer' && (selectedPaper || previewPaper) && (
          <ErrorBoundary
            onError={(err) => {
              console.error('PaperViewer error:', err);
              showNotification('An error occurred while viewing the paper.');
            }}
          >
            <PaperViewer
              paper={(selectedPaper || previewPaper)!}
              isInLibrary={!!selectedPaper}
              onSavePaper={previewPaper ? async () => { await handleSaveFromViewer(previewPaper); } : undefined}
              onDeletePaper={selectedPaper ? async () => { await handleDeleteFromViewer(selectedPaper); } : undefined}
              showNotification={showNotification}
              favoriteAuthorNames={favoriteAuthorNames}
              onFavoriteAuthor={handleFavoriteAuthor}
              onSearchAuthor={handleSearchAuthor}
              onOpenPaper={handleOpenPaper}
              browsePapers={browsePapers}
              browsePageOffset={browsePageOffset}
              browseTotalResults={browseTotalResults}
              onBrowseNavigate={handleBrowseNavigate}
              onImmersiveModeChange={setImmersiveMode}
              initialPage={initialPaperPage}
              initialPaneMode={initialPaneMode}
            />
          </ErrorBoundary>
        )}
      </main>

      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        showNotification={showNotification}
      />
    </div>
  );
}
