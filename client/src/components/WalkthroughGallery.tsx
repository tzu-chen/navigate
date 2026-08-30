import { useEffect, useMemo, useState } from 'react';
import { WalkthroughGalleryItem } from '../types';
import * as api from '../services/api';
import WalkthroughCover, { dominantKind } from './WalkthroughCover';
import LaTeX from './LaTeX';

/**
 * Every walkthrough you have built, as a wall of covers.
 *
 * A walkthrough is expensive and easy to forget about: it lives one pane deep
 * inside one paper, so the only way to find one again was to remember which
 * paper it belonged to. This is the index — and it is deliberately a *gallery*
 * rather than a list, because the thing being indexed is visual.
 *
 * Rows here can outlive their papers (a walkthrough has no foreign key to
 * `papers`, so it survives the paper going to Scribe or being deleted), which
 * is why an entry can be marked "not in library" and still open.
 */

interface Props {
  onOpen: (item: WalkthroughGalleryItem) => void;
  showNotification: (msg: string) => void;
}

type Filter = 'all' | 'built' | 'unbuilt';
type SortOrder = 'newest' | 'oldest' | 'title' | 'scenes' | 'cost';

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'built', label: 'Built' },
  { id: 'unbuilt', label: 'Outline only' },
];

const FITNESS_LABEL: Record<string, string> = {
  strong: 'Strong fit',
  partial: 'Partial fit',
  none: 'Prose',
};

function formatAuthors(authors: string[]): string {
  if (authors.length === 0) return '';
  if (authors.length === 1) return authors[0];
  if (authors.length === 2) return `${authors[0]} & ${authors[1]}`;
  return `${authors[0]} et al.`;
}

function formatDate(ts: string): string {
  const d = new Date(ts.includes('T') ? ts : ts.replace(' ', 'T') + 'Z');
  if (isNaN(d.getTime())) return ts;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** '≈' on the CLI backend: list-price equivalent of plan-billed work, not money charged. */
function costLabel(usd: number, backend: string | null): string {
  return `${backend === 'cli' ? '≈' : ''}$${usd.toFixed(2)}`;
}

export default function WalkthroughGallery({ onOpen, showNotification }: Props) {
  const [items, setItems] = useState<WalkthroughGalleryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [sortOrder, setSortOrder] = useState<SortOrder>('newest');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.getWalkthroughGallery()
      .then(data => {
        if (cancelled) return;
        setItems(data.items);
        setError(null);
      })
      .catch(err => {
        if (cancelled) return;
        setError(err?.message || 'Failed to load walkthroughs');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  const counts = useMemo(() => ({
    all: items.length,
    built: items.filter(i => i.hasBundle && i.status === 'ready').length,
    unbuilt: items.filter(i => !(i.hasBundle && i.status === 'ready')).length,
  }), [items]);

  const totalCost = useMemo(
    () => items.reduce((sum, i) => sum + i.estimatedCost, 0),
    [items]
  );

  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    return items
      .filter(i => {
        const built = i.hasBundle && i.status === 'ready';
        if (filter === 'built') return built;
        if (filter === 'unbuilt') return !built;
        return true;
      })
      .filter(i => {
        if (!term) return true;
        return (
          i.title.toLowerCase().includes(term) ||
          i.arxivId.toLowerCase().includes(term) ||
          i.authors.some(a => a.toLowerCase().includes(term)) ||
          (i.thesis ?? '').toLowerCase().includes(term) ||
          i.sceneTitles.some(s => s.toLowerCase().includes(term))
        );
      })
      .sort((a, b) => {
        switch (sortOrder) {
          case 'oldest': return a.createdAt.localeCompare(b.createdAt);
          case 'title': return a.title.localeCompare(b.title);
          case 'scenes': return b.sceneTitles.length - a.sceneTitles.length;
          case 'cost': return b.estimatedCost - a.estimatedCost;
          default: return b.createdAt.localeCompare(a.createdAt);
        }
      });
  }, [items, search, filter, sortOrder]);

  function handleOpen(item: WalkthroughGalleryItem) {
    if (!item.hasBundle || item.status !== 'ready') {
      showNotification('This one is outlined but not built — opening the outline.');
    }
    onOpen(item);
  }

  return (
    <div className="wtg">
      <div className="wtg-controls">
        <div className="wtg-filters">
          {FILTERS.map(f => (
            <button
              key={f.id}
              className={`wtg-filter ${filter === f.id ? 'is-active' : ''}`}
              onClick={() => setFilter(f.id)}
            >
              {f.label} <span className="wtg-filter-count">{counts[f.id]}</span>
            </button>
          ))}
        </div>
        <input
          type="text"
          className="search-input wtg-search"
          placeholder="Search titles, authors, scenes…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <select value={sortOrder} onChange={e => setSortOrder(e.target.value as SortOrder)}>
          <option value="newest">Newest first</option>
          <option value="oldest">Oldest first</option>
          <option value="title">Title A–Z</option>
          <option value="scenes">Most scenes</option>
          <option value="cost">Most expensive</option>
        </select>
        {items.length > 0 && (
          <span className="wtg-total" title="Total across every walkthrough, at list price">
            {costLabel(totalCost, items[0].backend)} spent
          </span>
        )}
      </div>

      {loading ? (
        <div className="empty-state">Loading walkthroughs…</div>
      ) : error ? (
        <div className="empty-state">{error}</div>
      ) : visible.length === 0 ? (
        <div className="empty-state">
          {items.length === 0
            ? 'No walkthroughs yet. Open a paper, switch the viewer to the walkthrough pane, and outline it.'
            : 'No walkthroughs match these filters.'}
        </div>
      ) : (
        <div className="wtg-grid">
          {visible.map(item => {
            const built = item.hasBundle && item.status === 'ready';
            return (
              <button
                key={item.id}
                className={`wtg-card ${built ? '' : 'is-unbuilt'}`}
                onClick={() => handleOpen(item)}
                title={item.thesis ?? item.title}
              >
                <div className="wtg-card-art">
                  <WalkthroughCover
                    seed={item.arxivId}
                    kinds={item.visualKinds}
                    muted={!built}
                  />
                  <div className="wtg-card-art-overlay">
                    <span className="wtg-kind-tag">
                      {item.visualKinds.length === 0
                        ? 'no outline'
                        : dominantKind(item.visualKinds) === 'none'
                          ? 'prose'
                          : dominantKind(item.visualKinds)}
                    </span>
                    {!built && (
                      <span className={`wtg-status-tag wtg-status-${item.status}`}>
                        {item.status === 'ready' ? 'no bundle' : item.status}
                      </span>
                    )}
                    {item.buildCount > 1 && (
                      <span className="wtg-kind-tag">{item.buildCount} builds</span>
                    )}
                  </div>
                </div>

                <div className="wtg-card-body">
                  <h3 className="wtg-card-title"><LaTeX>{item.title}</LaTeX></h3>
                  <div className="wtg-card-sub">
                    <span className="wtg-card-authors">{formatAuthors(item.authors)}</span>
                    {!item.inLibrary && (
                      <span className="wtg-chip wtg-chip-departed" title="This paper has left the library; the walkthrough outlived it">
                        not in library
                      </span>
                    )}
                  </div>
                  <div className="wtg-card-meta">
                    <span>{item.sceneTitles.length || '—'} scene{item.sceneTitles.length === 1 ? '' : 's'}</span>
                    {item.fitness && (
                      <span className={`wtg-fit wtg-fit-${item.fitness}`}>
                        {FITNESS_LABEL[item.fitness] ?? item.fitness}
                      </span>
                    )}
                    <span className="wtg-card-spacer" />
                    {item.estimatedCost > 0 && (
                      <span className="wtg-card-cost">{costLabel(item.estimatedCost, item.backend)}</span>
                    )}
                    <span>{formatDate(item.createdAt)}</span>
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
