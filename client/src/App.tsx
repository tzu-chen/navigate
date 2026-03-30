import { useState, useEffect, useCallback } from 'react';
import { ArxivPaper, SavedPaper, Tag, FavoriteAuthor, ViewMode } from './types';
import * as api from './services/api';
import { getSchemeById, applyColorScheme } from './colorSchemes';
import PaperBrowser from './components/PaperBrowser';
import Library from './components/Library';
import PaperViewer from './components/PaperViewer';
import FavoriteAuthors from './components/FavoriteAuthors';
import ChatHistory from './components/ChatHistory';
import WorldlinePanel from './components/WorldlinePanel';
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
    const scheme = getSchemeById(visualPrefs.colorScheme);
    if (scheme) {
      applyColorScheme(scheme);
    }
    api.applyCardFontSize(visualPrefs.cardFontSize);
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

  const handleOpenPaper = (paper: SavedPaper) => {
    setPreviousViewMode(viewMode);
    setSelectedPaper(paper);
    setBrowsePapers([]);
    setViewMode('viewer');
  };

  const handleOpenArxivPaper = (paper: ArxivPaper) => {
    setPreviousViewMode(viewMode);
    // Only keep browse papers context when opening from Browse view
    if (viewMode !== 'browse') {
      setBrowsePapers([]);
    }
    const existing = savedPapers.find(p => p.arxiv_id === paper.id);
    if (existing) {
      setSelectedPaper(existing);
      setPreviewPaper(null);
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

  const viewModeLabels: Record<ViewMode, string> = {
    browse: 'Browse',
    library: 'Library',
    authors: 'Authors',
    worldline: 'Worldlines',
    chatHistory: 'Chat History',
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
                  className={`icon-rail-btn ${viewMode === 'chatHistory' ? 'active' : ''}`}
                  onClick={() => setViewMode('chatHistory')}
                  title="Chat History"
                >
                  <Icon name="chat" size="18px" />
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
                <option value="chatHistory">Chat History</option>
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
        {viewMode === 'chatHistory' && (
          <ChatHistory
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
              allTags={tags}
              onTagsChanged={loadLibrary}
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
              onLibraryRefresh={loadLibrary}
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
