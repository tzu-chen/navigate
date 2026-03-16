import { useState, useEffect, useCallback } from 'react';
import { SavedPaper, Worldline } from '../types';
import * as api from '../services/api';
import LaTeX from './LaTeX';
import Icon from './Icon';

interface Props {
  paper: SavedPaper;
  onOpenPaper: (paper: SavedPaper) => void;
  showNotification: (msg: string) => void;
}

interface WorldlineWithPapers extends Worldline {
  papers: SavedPaper[];
}

export default function WorldlineSidebarPanel({ paper, onOpenPaper, showNotification }: Props) {
  const [worldlinesWithPapers, setWorldlinesWithPapers] = useState<WorldlineWithPapers[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedWl, setExpandedWl] = useState<Set<number>>(new Set());

  const loadWorldlines = useCallback(async () => {
    try {
      setLoading(true);
      const allWorldlines = await api.getWorldlines();

      // Load papers for each worldline, keep only those containing the current paper
      const results: WorldlineWithPapers[] = [];
      for (const wl of allWorldlines) {
        const wlPapers = await api.getWorldlinePapers(wl.id);
        if (wlPapers.some(p => p.id === paper.id)) {
          // Sort by publication date
          wlPapers.sort((a, b) => new Date(a.published).getTime() - new Date(b.published).getTime());
          results.push({ ...wl, papers: wlPapers });
        }
      }

      setWorldlinesWithPapers(results);
      // Expand all worldlines by default
      setExpandedWl(new Set(results.map(w => w.id)));
    } catch (err) {
      console.error('Failed to load worldlines:', err);
      showNotification('Failed to load worldlines');
    } finally {
      setLoading(false);
    }
  }, [paper.id, showNotification]);

  useEffect(() => {
    loadWorldlines();
  }, [loadWorldlines]);

  const toggleExpand = (wlId: number) => {
    setExpandedWl(prev => {
      const next = new Set(prev);
      if (next.has(wlId)) next.delete(wlId);
      else next.add(wlId);
      return next;
    });
  };

  const getFirstAuthor = (p: SavedPaper): string => {
    try {
      const authors = JSON.parse(p.authors) as string[];
      if (authors.length === 0) return 'Unknown';
      const name = authors[0];
      const parts = name.split(' ');
      return parts[parts.length - 1] + (authors.length > 1 ? ' et al.' : '');
    } catch {
      return 'Unknown';
    }
  };

  const getYear = (p: SavedPaper): string => {
    return new Date(p.published).getFullYear().toString();
  };

  if (loading) {
    return (
      <div className="wl-sidebar-panel">
        <div className="wl-sidebar-loading">Loading worldlines...</div>
      </div>
    );
  }

  if (worldlinesWithPapers.length === 0) {
    return (
      <div className="wl-sidebar-panel">
        <div className="wl-sidebar-empty">
          This paper does not belong to any worldline.
        </div>
      </div>
    );
  }

  return (
    <div className="wl-sidebar-panel">
      {worldlinesWithPapers.map(wl => (
        <div key={wl.id} className="wl-sidebar-group">
          <div
            className="wl-sidebar-group-header"
            onClick={() => toggleExpand(wl.id)}
          >
            <span
              className="wl-sidebar-group-dot"
              style={{ background: wl.color }}
            />
            <span className="wl-sidebar-group-name">{wl.name}</span>
            <span className="wl-sidebar-group-count">{wl.papers.length}</span>
            <span className={`wl-collapse-chevron ${expandedWl.has(wl.id) ? 'open' : ''}`}>
              <Icon name="chevron-right" />
            </span>
          </div>
          {expandedWl.has(wl.id) && (
            <div className="wl-sidebar-nodes">
              {wl.papers.map((p, idx) => {
                const isCurrent = p.id === paper.id;
                return (
                  <div key={p.id} className="wl-sidebar-node-wrapper" style={{ '--wl-color': wl.color } as React.CSSProperties}>
                    <div
                      className={`wl-sidebar-node ${isCurrent ? 'current' : ''}`}
                      onDoubleClick={() => {
                        if (!isCurrent) {
                          onOpenPaper(p);
                        }
                      }}
                      title={isCurrent ? 'Current paper' : `Double-click to open "${p.title}"`}
                    >
                      <span
                        className="wl-sidebar-node-dot"
                        style={{
                          background: isCurrent ? wl.color : 'var(--bg-tertiary)',
                          borderColor: wl.color,
                        }}
                      />
                      <div className="wl-sidebar-node-info">
                        <span className={`wl-sidebar-node-title ${isCurrent ? 'current' : ''}`}>
                          <LaTeX>{p.title.length > 60 ? p.title.substring(0, 57) + '...' : p.title}</LaTeX>
                        </span>
                        <span className="wl-sidebar-node-meta">
                          {getFirstAuthor(p)} &middot; {getYear(p)}
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
