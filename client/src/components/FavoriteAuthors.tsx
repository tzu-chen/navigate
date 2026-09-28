import { useState, useEffect } from 'react';
import { ArxivPaper, FavoriteAuthor } from '../types';
import * as api from '../services/api';
import LaTeX from './LaTeX';

interface Props {
  favoriteAuthors: FavoriteAuthor[];
  onAuthorsChanged: () => Promise<void>;
  onSavePaper: (paper: ArxivPaper) => Promise<any>;
  onOpenPaper: (paper: ArxivPaper) => void;
  savedPaperIds: Set<string>;
  showNotification: (msg: string) => void;
}

export default function FavoriteAuthors({
  favoriteAuthors,
  onAuthorsChanged,
  onSavePaper,
  onOpenPaper,
  savedPaperIds,
  showNotification,
}: Props) {
  const [searchQuery, setSearchQuery] = useState('');
  const [publications, setPublications] = useState<(ArxivPaper & { matchedAuthor: string })[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [failedAuthors, setFailedAuthors] = useState<string[]>([]);
  const [rateLimited, setRateLimited] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const [savingIds, setSavingIds] = useState<Set<string>>(new Set());
  const [expandedAbstracts, setExpandedAbstracts] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);

  // Include identities, since replacing one author with another can leave the
  // count unchanged. Ignore an older response after the list changes.
  const authorsKey = favoriteAuthors.map(author => `${author.id}:${author.name}`).join('|');
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    if (favoriteAuthors.length === 0) {
      setPublications([]);
      setFailedAuthors([]);
      setLoadError('');
      setRateLimited(false);
      setLoading(false);
      return;
    }
    setLoading(true);
    setPublications([]);
    setFailedAuthors([]);
    setLoadError('');
    setRateLimited(false);
    api.getFavoriteAuthorPublications(controller.signal)
      .then(result => {
        if (!active) return;
        setPublications(result.papers);
        setFailedAuthors(result.failedAuthors || []);
        setRateLimited(result.rateLimited || false);
      })
      .catch(err => {
        if (!active) return;
        console.error('Failed to load publications:', err);
        setLoadError(err instanceof Error ? err.message : 'Failed to load publications');
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [authorsKey, reloadToken]);

  async function handleAddAuthor() {
    const name = searchQuery.trim();
    if (!name) return;
    setAdding(true);
    try {
      await api.addFavoriteAuthor(name);
      setSearchQuery('');
      showNotification(`Added "${name}" to favorite authors`);
      await onAuthorsChanged();
    } catch (err: any) {
      showNotification(err.message || 'Failed to add author');
    } finally {
      setAdding(false);
    }
  }

  async function handleRemoveAuthor(author: FavoriteAuthor) {
    try {
      await api.removeFavoriteAuthor(author.id);
      showNotification(`Removed "${author.name}" from favorites`);
      await onAuthorsChanged();
    } catch {
      showNotification('Failed to remove author');
    }
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

  function toggleAbstract(id: string) {
    setExpandedAbstracts(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="favorite-authors">
      <div className="favorite-authors-controls">
        <div className="control-row">
          <div className="control-group search-group">
            <label>Add Author to Favorites</label>
            <div className="search-input-wrap">
              <input
                type="text"
                placeholder="Type author name (e.g., Yann LeCun)..."
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleAddAuthor()}
              />
              <button
                className="btn btn-primary"
                onClick={handleAddAuthor}
                disabled={adding || !searchQuery.trim()}
              >
                {adding ? 'Adding...' : 'Add'}
              </button>
            </div>
          </div>
        </div>

        {favoriteAuthors.length > 0 && (
          <div className="favorite-authors-list">
            {favoriteAuthors.map(author => (
              <span key={author.id} className="favorite-author-chip">
                {author.name}
                <button
                  className="favorite-author-remove"
                  onClick={() => handleRemoveAuthor(author)}
                  title="Remove from favorites"
                >
                  &times;
                </button>
              </span>
            ))}
          </div>
        )}
      </div>

      {favoriteAuthors.length === 0 && (
        <div className="empty-state">
          Add your favorite authors to track their latest publications.
        </div>
      )}

      {favoriteAuthors.length > 0 && loading && (
        <div className="loading">Loading publications from favorite authors...</div>
      )}

      {favoriteAuthors.length > 0 && !loading && (loadError || failedAuthors.length > 0) && (
        <div className="empty-state" role="alert">
          {loadError || (rateLimited
            ? `ArXiv is rate limiting author searches. ${failedAuthors.length} author listings could not be loaded; try again later.`
            : `${failedAuthors.length} author listings could not be loaded.`)}
          {!rateLimited && (
            <button className="btn btn-secondary btn-sm" onClick={() => setReloadToken(n => n + 1)}>
              Retry
            </button>
          )}
        </div>
      )}

      {favoriteAuthors.length > 0 && !loading && !loadError && failedAuthors.length === 0 && publications.length === 0 && (
        <div className="empty-state">No recent publications found from your favorite authors.</div>
      )}

      {publications.length > 0 && (
        <div className="paper-list">
          {publications.map(paper => {
            const isSaved = savedPaperIds.has(paper.id);
            const isSaving = savingIds.has(paper.id);
            const isExpanded = expandedAbstracts.has(paper.id);

            return (
              <div key={paper.id} className="paper-card">
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
                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={() => onOpenPaper(paper)}
                    >
                      Open
                    </button>
                  </div>
                </div>

                <div className="paper-meta">
                  <span className="paper-authors">
                    {paper.authors.slice(0, 5).join(', ')}
                    {paper.authors.length > 5 && ` +${paper.authors.length - 5} more`}
                  </span>
                  <span className="matched-author-badge" title="Matched favorite author">
                    via {paper.matchedAuthor}
                  </span>
                  <span className="paper-date">
                    {new Date(paper.published).toLocaleDateString()}
                  </span>
                  <span className="paper-categories">
                    {paper.categories.slice(0, 3).map(c => (
                      <span key={c} className="category-badge">{c}</span>
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
            );
          })}
        </div>
      )}
    </div>
  );
}
