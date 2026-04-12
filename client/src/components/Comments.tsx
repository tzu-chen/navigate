import { useEffect, useMemo, useState } from 'react';
import { CommentWithPaper, SavedPaper } from '../types';
import * as api from '../services/api';
import LaTeX from './LaTeX';

interface Props {
  savedPapers: SavedPaper[];
  onOpenPaper: (paper: SavedPaper, page?: number) => void;
  showNotification: (msg: string) => void;
}

type SortOrder = 'newest' | 'oldest';

function formatAuthors(authorsJson: string): string {
  try {
    const parsed = JSON.parse(authorsJson) as string[];
    if (!parsed.length) return '';
    if (parsed.length === 1) return parsed[0];
    return `${parsed[0]} et al.`;
  } catch {
    return authorsJson;
  }
}

function formatTimestamp(ts: string): string {
  const d = new Date(ts.includes('T') ? ts : ts.replace(' ', 'T') + 'Z');
  if (isNaN(d.getTime())) return ts;
  return d.toLocaleString();
}

export default function Comments({ savedPapers, onOpenPaper, showNotification }: Props) {
  const [comments, setComments] = useState<CommentWithPaper[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [paperFilter, setPaperFilter] = useState<string | null>(null);
  const [sortOrder, setSortOrder] = useState<SortOrder>('newest');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.getAllComments()
      .then(data => {
        if (cancelled) return;
        setComments(data);
        setError(null);
      })
      .catch(err => {
        if (cancelled) return;
        setError(err?.message || 'Failed to load comments');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  const papersWithComments = useMemo(() => {
    const map = new Map<string, { arxiv_id: string; title: string; count: number }>();
    for (const c of comments) {
      const entry = map.get(c.arxiv_id);
      if (entry) {
        entry.count += 1;
      } else {
        map.set(c.arxiv_id, { arxiv_id: c.arxiv_id, title: c.title, count: 1 });
      }
    }
    return Array.from(map.values()).sort((a, b) => a.title.localeCompare(b.title));
  }, [comments]);

  const filtered = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    return comments
      .filter(c => (paperFilter ? c.arxiv_id === paperFilter : true))
      .filter(c => {
        if (!term) return true;
        return (
          c.content.toLowerCase().includes(term) ||
          c.title.toLowerCase().includes(term) ||
          c.authors.toLowerCase().includes(term)
        );
      })
      .sort((a, b) =>
        sortOrder === 'newest'
          ? b.created_at.localeCompare(a.created_at)
          : a.created_at.localeCompare(b.created_at)
      );
  }, [comments, searchTerm, paperFilter, sortOrder]);

  function handleCommentClick(c: CommentWithPaper) {
    const paper = savedPapers.find(p => p.arxiv_id === c.arxiv_id);
    if (!paper) {
      showNotification('Paper not found in library');
      return;
    }
    onOpenPaper(paper, c.page_number ?? undefined);
  }

  return (
    <div className="library">
      <nav className="library-sidebar">
        <div className="sidebar-section">
          <h4 className="sidebar-section-title">Papers</h4>
          <button
            className={`sidebar-item${paperFilter === null ? ' active' : ''}`}
            onClick={() => setPaperFilter(null)}
          >
            All comments ({comments.length})
          </button>
          {papersWithComments.map(p => (
            <button
              key={p.arxiv_id}
              className={`sidebar-item${paperFilter === p.arxiv_id ? ' active' : ''}`}
              onClick={() => setPaperFilter(paperFilter === p.arxiv_id ? null : p.arxiv_id)}
              title={p.title}
            >
              <span className="sidebar-item-label">{p.title}</span>
              <span className="sidebar-item-count">{p.count}</span>
            </button>
          ))}
          {papersWithComments.length === 0 && !loading && (
            <p className="sidebar-empty">No comments yet.</p>
          )}
        </div>
      </nav>

      <div className="library-main">
        <div className="library-controls">
          <div className="control-row">
            <div className="control-group search-group">
              <input
                type="text"
                placeholder="Search comments, papers, authors..."
                value={searchTerm}
                onChange={e => setSearchTerm(e.target.value)}
                className="search-input"
              />
            </div>
            <div className="control-group">
              <select
                value={sortOrder}
                onChange={e => setSortOrder(e.target.value as SortOrder)}
              >
                <option value="newest">Newest first</option>
                <option value="oldest">Oldest first</option>
              </select>
            </div>
          </div>
        </div>

        {loading ? (
          <div className="empty-state">Loading comments...</div>
        ) : error ? (
          <div className="empty-state">{error}</div>
        ) : filtered.length === 0 ? (
          <div className="empty-state">
            {comments.length === 0
              ? 'No comments yet. Open a paper and add a comment to see it here.'
              : 'No comments match your filters.'}
          </div>
        ) : (
          <div className="paper-list">
            {filtered.map(c => (
              <div
                key={c.id}
                className="paper-card library-card comment-card"
                onClick={() => handleCommentClick(c)}
              >
                <div className="paper-card-header">
                  <div className="paper-select-title">
                    <h3 className="paper-title">
                      <LaTeX>{c.title}</LaTeX>
                    </h3>
                  </div>
                </div>
                <div className="paper-meta">
                  <span className="paper-authors">{formatAuthors(c.authors)}</span>
                  {c.page_number != null && (
                    <span className="status-badge" style={{ backgroundColor: '#6366f1' }}>
                      p.{c.page_number}
                    </span>
                  )}
                  <span className="paper-date">{formatTimestamp(c.created_at)}</span>
                </div>
                <p className="comment-card-content" style={{ whiteSpace: 'pre-wrap', margin: '0.5rem 0 0' }}>
                  {c.content}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
