import React, { useState, useEffect, useRef } from 'react';
import { ArxivPaper, CategoryGroup, PaperSimilarityResult, WorldlineSimilarityMatch } from '../types';
import * as api from '../services/api';
import LaTeX from './LaTeX';

interface Props {
  onSavePaper: (paper: ArxivPaper) => Promise<any>;
  onOpenPaper: (paper: ArxivPaper) => void;
  savedPaperIds: Set<string>;
  favoriteAuthorNames: Set<string>;
  onFavoriteAuthor: (name: string) => void;
  onPapersLoaded?: (papers: ArxivPaper[], pageOffset: number, totalResults: number) => void;
  pendingAuthorSearch?: string | null;
  onAuthorSearchHandled?: () => void;
}

const SORT_OPTIONS = [
  { value: 'submittedDate', label: 'Newest First' },
  { value: 'lastUpdatedDate', label: 'Recently Updated' },
  { value: 'relevance', label: 'Relevance' },
];

export default function PaperBrowser({ onSavePaper, onOpenPaper, savedPaperIds, favoriteAuthorNames, onFavoriteAuthor, onPapersLoaded, pendingAuthorSearch, onAuthorSearchHandled }: Props) {
  const [categoryGroups, setCategoryGroups] = useState<CategoryGroup[]>([]);
  const [selectedCategory, setSelectedCategory] = useState(
    () => localStorage.getItem('navigate-category') || 'cs.AI'
  );
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState('submittedDate');
  const [papers, setPapers] = useState<ArxivPaper[]>([]);
  const [totalResults, setTotalResults] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const [savingIds, setSavingIds] = useState<Set<string>>(new Set());
  const [expandedAbstracts, setExpandedAbstracts] = useState<Set<string>>(new Set());
  const [similarityMap, setSimilarityMap] = useState<Map<string, WorldlineSimilarityMatch[]>>(new Map());
  const [scanningWorldlines, setScanningWorldlines] = useState(false);
  const similarityAbortRef = useRef<AbortController | null>(null);
  // Flag accept/reject UI state, keyed `${paperId}:${worldlineId}`.
  const [assigningFlags, setAssigningFlags] = useState<Set<string>>(new Set());
  const [assignedFlags, setAssignedFlags] = useState<Set<string>>(new Set());
  const [activeTab, setActiveTab] = useState<'new' | 'cross' | 'replace'>('new');
  const [showMobileSearch, setShowMobileSearch] = useState(false);
  const [arxivIdInput, setArxivIdInput] = useState('');
  const [arxivIdError, setArxivIdError] = useState('');
  const [arxivIdLoading, setArxivIdLoading] = useState(false);
  const [favoriteCategories, setFavoriteCategories] = useState<string[]>([]);
  const [favoritesMode, setFavoritesMode] = useState(false);
  const [favoritesMatchedCats, setFavoritesMatchedCats] = useState<Map<string, string[]>>(new Map());
  const [favoritesFetchedAt, setFavoritesFetchedAt] = useState<string | null>(null);

  const PAGE_SIZE = 20;

  // Whether we're showing the latest announcement (RSS) vs paginated search
  const isLatestMode = !favoritesMode && sortBy === 'submittedDate' && !searchQuery;
  const isRecentlyUpdatedMode = !favoritesMode && sortBy === 'lastUpdatedDate' && !searchQuery;
  const usesListingsPage = isLatestMode || isRecentlyUpdatedMode || favoritesMode;

  useEffect(() => {
    api.getCategories().then(setCategoryGroups).catch(console.error);
    api.getSettings().then(s => setFavoriteCategories(s.favoriteCategories)).catch(() => {});
  }, []);

  useEffect(() => {
    if (favoritesMode) return;
    if (isLatestMode) {
      fetchLatest();
    } else if (isRecentlyUpdatedMode) {
      fetchRecent();
    } else {
      performSearch(0);
    }
  }, [selectedCategory, sortBy, favoritesMode]);

  // Compute worldline similarity when papers change
  useEffect(() => {
    if (papers.length === 0) {
      setSimilarityMap(new Map());
      return;
    }

    // Cancel any in-progress request
    if (similarityAbortRef.current) {
      similarityAbortRef.current.abort();
    }
    const controller = new AbortController();
    similarityAbortRef.current = controller;

    setScanningWorldlines(true);
    api.getSettings().then(settings => {
      // Opt-in only: when disabled, make no request so the CPU-heavy embedding
      // model is never invoked (or even loaded) while browsing.
      if (!settings.similarityEnabled) return [];
      return api.checkWorldlineSimilarity(
        papers.map(p => ({ id: p.id, title: p.title, summary: p.summary, authors: p.authors })),
        settings.similarityThreshold,
        selectedCategory
      );
    }).then(results => {
      if (controller.signal.aborted) return;
      const map = new Map<string, WorldlineSimilarityMatch[]>();
      for (const r of results) {
        map.set(r.paperId, r.matches);
      }
      setSimilarityMap(map);
    }).catch(err => {
      if (controller.signal.aborted) return;
      console.error('Similarity check failed:', err);
    }).finally(() => {
      if (!controller.signal.aborted) {
        setScanningWorldlines(false);
      }
    });

    return () => controller.abort();
  }, [papers]);

  useEffect(() => {
    onPapersLoaded?.(papers, page * PAGE_SIZE, totalResults);
  }, [papers, page, totalResults, onPapersLoaded]);

  // Handle author search triggered from other views (Library, PaperViewer)
  useEffect(() => {
    if (pendingAuthorSearch) {
      const query = `au:"${pendingAuthorSearch}"`;
      setSearchQuery(query);
      performSearch(0, query);
      onAuthorSearchHandled?.();
    }
  }, [pendingAuthorSearch]);

  async function fetchLatest() {
    setLoading(true);
    setActiveTab('new');
    try {
      const result = await api.getLatestArxiv(selectedCategory || 'cs.AI');
      setPapers(result.papers);
      setTotalResults(result.totalResults);
      setPage(0);
    } catch (err) {
      console.error('Failed to fetch latest:', err);
    } finally {
      setLoading(false);
    }
  }

  async function fetchFavorites() {
    setLoading(true);
    setActiveTab('new');
    try {
      const result = await api.getFavoriteCategoriesFeed();
      setPapers(result.papers);
      setTotalResults(result.totalResults);
      setPage(0);
      const matched = new Map<string, string[]>();
      for (const p of result.papers) {
        matched.set(p.id, p.matchedCategories);
      }
      setFavoritesMatchedCats(matched);
      setFavoritesFetchedAt(result.fetchedAt || null);
    } catch (err) {
      console.error('Failed to fetch favorites feed:', err);
    } finally {
      setLoading(false);
    }
  }

  function enterFavoritesMode() {
    if (favoriteCategories.length === 0) return;
    setSearchQuery('');
    setFavoritesMode(true);
    fetchFavorites();
  }

  function exitFavoritesMode() {
    setFavoritesMode(false);
    setFavoritesMatchedCats(new Map());
    setFavoritesFetchedAt(null);
  }

  async function fetchRecent() {
    setLoading(true);
    try {
      const result = await api.getRecentArxiv(selectedCategory || 'cs.AI');
      setPapers(result.papers);
      setTotalResults(result.totalResults);
      setPage(0);
    } catch (err) {
      console.error('Failed to fetch recent:', err);
    } finally {
      setLoading(false);
    }
  }

  async function performSearch(startPage: number, queryOverride?: string) {
    setLoading(true);
    const q = queryOverride !== undefined ? queryOverride : searchQuery;
    try {
      const result = await api.searchArxiv({
        category: selectedCategory || undefined,
        query: q || undefined,
        start: startPage * PAGE_SIZE,
        maxResults: PAGE_SIZE,
        sortBy,
      });
      setPapers(result.papers);
      setTotalResults(result.totalResults);
      setPage(startPage);
    } catch (err) {
      console.error('Search failed:', err);
    } finally {
      setLoading(false);
    }
  }

  function handleAuthorRightClick(e: React.MouseEvent, authorName: string) {
    e.preventDefault();
    const query = `au:"${authorName}"`;
    setSearchQuery(query);
    performSearch(0, query);
  }

  async function handleSave(paper: ArxivPaper) {
    setSavingIds(prev => new Set(prev).add(paper.id));
    try {
      await onSavePaper(paper);
    } finally {
      setSavingIds(prev => {
        const next = new Set(prev);
        next.delete(paper.id);
        return next;
      });
    }
  }

  // Accept a worldline suggestion: save the paper (if needed) and assign it to
  // the suggested worldline. The server records the flag as accepted.
  async function handleAssignToWorldline(paper: ArxivPaper, match: WorldlineSimilarityMatch) {
    const key = `${paper.id}:${match.worldlineId}`;
    if (assigningFlags.has(key) || assignedFlags.has(key)) return;
    setAssigningFlags(prev => new Set(prev).add(key));
    try {
      const saved = await onSavePaper(paper); // syncs library state, returns SavedPaper
      await api.addWorldlinePaper(match.worldlineId, saved.id, 0);
      setAssignedFlags(prev => new Set(prev).add(key));
    } catch (err) {
      console.error('Assign to worldline failed:', err);
    } finally {
      setAssigningFlags(prev => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  }

  // Reject a worldline suggestion: record it server-side and drop the badge.
  async function handleDismissFlag(paper: ArxivPaper, match: WorldlineSimilarityMatch) {
    try {
      await api.dismissWorldlineFlag(paper.id, match.worldlineId);
    } catch (err) {
      console.error('Dismiss flag failed:', err);
    }
    setSimilarityMap(prev => {
      const next = new Map(prev);
      const remaining = (next.get(paper.id) || []).filter(m => m.worldlineId !== match.worldlineId);
      if (remaining.length > 0) next.set(paper.id, remaining);
      else next.delete(paper.id);
      return next;
    });
  }

  function toggleAbstract(id: string) {
    setExpandedAbstracts(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleArxivIdSubmit() {
    const raw = arxivIdInput.trim();
    if (!raw) return;
    // Strip common URL prefixes
    let id = raw
      .replace(/^https?:\/\/(www\.)?arxiv\.org\/(abs|pdf|html)\//i, '')
      .replace(/\.pdf$/i, '');
    setArxivIdError('');
    setArxivIdLoading(true);
    try {
      const paper = await api.getArxivPaper(id);
      setArxivIdInput('');
      onOpenPaper(paper);
    } catch {
      setArxivIdError('Paper not found');
    } finally {
      setArxivIdLoading(false);
    }
  }

  const totalPages = Math.ceil(totalResults / PAGE_SIZE);

  // Filter papers by announcement type tab when in latest mode
  const newPapers = papers.filter(p => !p.announceType || p.announceType === 'new');
  const crossPapers = papers.filter(p => p.announceType === 'cross');
  const replacePapers = papers.filter(p => p.announceType === 'replace' || p.announceType === 'replace-cross');
  // Recently updated: new submissions only, exclude crosslist papers
  const recentNonCrossPapers = papers.filter(p => p.announceType !== 'cross');

  const displayedPapers = isRecentlyUpdatedMode
    ? recentNonCrossPapers
    : isLatestMode
      ? (activeTab === 'new' ? newPapers : activeTab === 'cross' ? crossPapers : replacePapers)
      : papers;

  return (
    <div className="paper-browser">
      <div className="arxiv-id-bar">
        <div className="mobile-search-toggle">
          <button
            className="btn btn-secondary btn-sm mobile-search-toggle-btn"
            onClick={() => setShowMobileSearch(!showMobileSearch)}
          >
            {selectedCategory}{searchQuery ? ` \u00b7 "${searchQuery}"` : ''} {showMobileSearch ? '\u25B2' : '\u25BC'}
          </button>
        </div>
        <label>ArXiv ID</label>
        <div className="search-input-wrap">
          <input
            type="text"
            placeholder="e.g. 2401.12345"
            value={arxivIdInput}
            onChange={e => { setArxivIdInput(e.target.value); setArxivIdError(''); }}
            onKeyDown={e => { if (e.key === 'Enter') handleArxivIdSubmit(); }}
            disabled={arxivIdLoading}
          />
          <button onClick={handleArxivIdSubmit} className="btn btn-primary" disabled={arxivIdLoading}>
            {arxivIdLoading ? 'Loading...' : 'Go'}
          </button>
        </div>
        {arxivIdError && <span className="arxiv-id-error">{arxivIdError}</span>}
      </div>
      <div className="browser-controls">
        <div className={`browser-control-row-wrap ${showMobileSearch ? 'expanded' : ''}`}>
          <div className="control-row">
            <div className="control-group">
              <label>Category</label>
              <select
                value={selectedCategory}
                onChange={e => {
                  const val = e.target.value;
                  setSelectedCategory(val);
                  localStorage.setItem('navigate-category', val);
                  if (favoritesMode) exitFavoritesMode();
                }}
              >
                {categoryGroups.map(group => (
                  <optgroup key={group.label} label={group.label}>
                    {Object.entries(group.categories).map(([key, name]) => (
                      <option key={key} value={key}>
                        {key} - {name}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </div>

            <div className="control-group search-group">
              <label>Search</label>
              <div className="search-input-wrap">
                <input
                  type="text"
                  placeholder="Search within category..."
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') {
                      if (favoritesMode) exitFavoritesMode();
                      if (!searchQuery && sortBy === 'submittedDate') fetchLatest();
                      else if (!searchQuery && sortBy === 'lastUpdatedDate') fetchRecent();
                      else performSearch(0);
                    }
                  }}
                />
                <button onClick={() => {
                  if (favoritesMode) exitFavoritesMode();
                  if (!searchQuery && sortBy === 'submittedDate') fetchLatest();
                  else if (!searchQuery && sortBy === 'lastUpdatedDate') fetchRecent();
                  else performSearch(0);
                }} className="btn btn-primary">
                  Search
                </button>
              </div>
            </div>

            <div className="control-group">
              <label>Sort By</label>
              <select value={sortBy} onChange={e => {
                setSortBy(e.target.value);
                if (favoritesMode) exitFavoritesMode();
              }}>
                {SORT_OPTIONS.map(opt => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="control-group">
              <label>Favorites</label>
              <button
                type="button"
                className={`btn btn-sm ${favoritesMode ? 'btn-primary' : 'btn-secondary'}`}
                onClick={() => favoritesMode ? exitFavoritesMode() : enterFavoritesMode()}
                disabled={favoriteCategories.length === 0}
                title={favoriteCategories.length === 0
                  ? 'Pick favorite categories in Settings to enable'
                  : favoritesMode
                    ? 'Exit favorites view'
                    : `Show new papers from ${favoriteCategories.join(', ')}`}
              >
                {favoritesMode ? '★ Favorites (on)' : '★ Favorites'}
              </button>
            </div>
          </div>
        </div>
      </div>

      {favoritesMode && (
        <div className="favorites-status-bar">
          <span className="favorites-status-text">
            Showing latest from{' '}
            {favoriteCategories.map((c, i) => (
              <span key={c}>
                {i > 0 && ', '}
                <span className={`category-badge cat-${c.includes('.') ? c.split('.')[0] : c}`}>{c}</span>
              </span>
            ))}
          </span>
          {favoritesFetchedAt && (
            <span className="favorites-status-time" title={favoritesFetchedAt}>
              Fetched {new Date(favoritesFetchedAt).toLocaleTimeString()}
            </span>
          )}
          <button
            className="btn btn-secondary btn-sm"
            onClick={fetchFavorites}
            disabled={loading}
            title="Refresh — uses cached results if recently fetched"
          >
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
          <button className="btn btn-secondary btn-sm" onClick={exitFavoritesMode}>
            Exit
          </button>
        </div>
      )}

      {isLatestMode && !loading && (
        <div className="announcement-tabs">
          <button
            className={`announcement-tab ${activeTab === 'new' ? 'active' : ''}`}
            onClick={() => setActiveTab('new')}
          >
            New <span className="announcement-tab-count">{newPapers.length}</span>
          </button>
          <button
            className={`announcement-tab ${activeTab === 'cross' ? 'active' : ''}`}
            onClick={() => setActiveTab('cross')}
          >
            Cross-listed <span className="announcement-tab-count">{crossPapers.length}</span>
          </button>
          <button
            className={`announcement-tab ${activeTab === 'replace' ? 'active' : ''}`}
            onClick={() => setActiveTab('replace')}
          >
            Replacements <span className="announcement-tab-count">{replacePapers.length}</span>
          </button>
        </div>
      )}

      {loading && <div className="loading">Searching ArXiv...</div>}

      {!loading && scanningWorldlines && (
        <div className="worldline-scanning-bar">
          Scanning worldline similarity...
        </div>
      )}

      {!loading && displayedPapers.length === 0 && (
        <div className="empty-state">
          {favoritesMode
            ? 'No new papers in your favorite categories right now.'
            : isRecentlyUpdatedMode
              ? 'No recent papers found for this category.'
              : isLatestMode && papers.length > 0
                ? `No ${activeTab === 'new' ? 'new' : activeTab === 'cross' ? 'cross-listed' : 'replacement'} papers in this announcement.`
                : 'No papers found. Try a different category or search term.'}
        </div>
      )}

      <div className="paper-list">
        {displayedPapers.map((paper, index) => {
          const isSaved = savedPaperIds.has(paper.id);
          const isSaving = savingIds.has(paper.id);
          const isExpanded = expandedAbstracts.has(paper.id);
          const worldlineMatches = similarityMap.get(paper.id);

          // Show date separator when listing date changes between papers
          const prevPaper = index > 0 ? displayedPapers[index - 1] : null;
          const showDateSeparator = isRecentlyUpdatedMode && paper.listingDate && (
            !prevPaper || !prevPaper.listingDate ||
            new Date(paper.listingDate).toDateString() !== new Date(prevPaper.listingDate).toDateString()
          );

          return (
            <React.Fragment key={paper.id}>
              {showDateSeparator && (
                <div className="date-separator">
                  <span className="date-separator-text">
                    {new Date(paper.listingDate!).toLocaleDateString('en-US', {
                      weekday: 'long',
                      year: 'numeric',
                      month: 'long',
                      day: 'numeric',
                    })}
                  </span>
                </div>
              )}
              <div className="paper-card-row">
              <span className="paper-number">{index + 1}</span>
              <div className={`paper-card ${worldlineMatches ? 'has-worldline-match' : ''}`}>
              <div className="paper-card-header">
                <h3 className="paper-title" onClick={() => onOpenPaper(paper)}>
                  <LaTeX>{paper.title}</LaTeX>
                </h3>
                <div className="paper-actions">
                  {isSaved ? (
                    <button className="btn btn-success btn-sm" disabled>
                      In Library
                    </button>
                  ) : (
                    <button
                      className="btn btn-primary btn-sm"
                      onClick={() => handleSave(paper)}
                      disabled={isSaving}
                    >
                      {isSaving ? 'Saving...' : 'Save'}
                    </button>
                  )}
                </div>
              </div>

              {worldlineMatches && worldlineMatches.length > 0 && (
                <div className="worldline-matches">
                  {worldlineMatches.map(match => {
                    const flagKey = `${paper.id}:${match.worldlineId}`;
                    const isAssigning = assigningFlags.has(flagKey);
                    const isAssigned = assignedFlags.has(flagKey);
                    const why = match.corroborationKind === 'author'
                      ? 'shared author'
                      : match.corroborationKind === 'terms'
                        ? 'shared distinctive terms'
                        : '';
                    return (
                      <span key={match.worldlineId} className="worldline-match-badge-group">
                        <button
                          type="button"
                          className="worldline-match-badge worldline-match-assign"
                          style={{ borderColor: match.worldlineColor, color: match.worldlineColor }}
                          title={isAssigned
                            ? `Assigned to ${match.worldlineName}`
                            : `Assign to ${match.worldlineName} (score ${match.score.toFixed(3)}${why ? `, ${why}` : ''})`}
                          onClick={() => handleAssignToWorldline(paper, match)}
                          disabled={isAssigning || isAssigned}
                        >
                          <span className="worldline-match-dot" style={{ background: match.worldlineColor }} />
                          {match.worldlineName}
                          <span className="worldline-match-score">
                            {isAssigned ? '✓' : isAssigning ? '…' : `${(match.score * 100).toFixed(0)}%`}
                          </span>
                        </button>
                        {!isAssigned && (
                          <button
                            type="button"
                            className="worldline-match-dismiss"
                            title="Dismiss this suggestion"
                            onClick={() => handleDismissFlag(paper, match)}
                            disabled={isAssigning}
                          >
                            ×
                          </button>
                        )}
                      </span>
                    );
                  })}
                </div>
              )}

              <div className="paper-meta">
                <span className="paper-authors">
                  {paper.authors.slice(0, 5).map((author, i) => (
                    <span key={i}>
                      {i > 0 && ', '}
                      <button
                        className={`author-name-btn ${favoriteAuthorNames.has(author) ? 'is-favorite' : ''}`}
                        onClick={() => !favoriteAuthorNames.has(author) && onFavoriteAuthor(author)}
                        onContextMenu={(e) => handleAuthorRightClick(e, author)}
                        title={favoriteAuthorNames.has(author) ? 'Already in favorites' : `Add ${author} to favorites | Right-click to search`}
                      >
                        {author}
                      </button>
                    </span>
                  ))}
                  {paper.authors.length > 5 && ` +${paper.authors.length - 5} more`}
                </span>
                <span className="paper-date">
                  {new Date(paper.published).toLocaleDateString()}
                </span>
                <span className="paper-categories">
                  {paper.categories.slice(0, 3).map(c => (
                    <span key={c} className={`category-badge cat-${c.includes('.') ? c.split('.')[0] : c}`}>{c}</span>
                  ))}
                </span>
              </div>

              <p className={`paper-abstract ${isExpanded ? 'expanded' : ''}`}>
                <LaTeX>{paper.summary}</LaTeX>
              </p>
              {paper.summary.length > 300 && (
                <button
                  className="btn-link"
                  onClick={() => toggleAbstract(paper.id)}
                >
                  {isExpanded ? 'Show less' : 'Show more'}
                </button>
              )}

              <div className="paper-id">arXiv: {paper.id}</div>
            </div>
            </div>
            </React.Fragment>
          );
        })}
      </div>

      {!usesListingsPage && totalPages > 1 && (
        <div className="pagination">
          <button
            className="btn btn-secondary"
            disabled={page === 0}
            onClick={() => performSearch(page - 1)}
          >
            Previous
          </button>
          <span className="page-info">
            Page {page + 1} of {totalPages} ({totalResults} results)
          </span>
          <button
            className="btn btn-secondary"
            disabled={page >= totalPages - 1}
            onClick={() => performSearch(page + 1)}
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}
