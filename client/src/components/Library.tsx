import { useState, useEffect, useRef } from 'react';
import { SavedPaper, Tag, Worldline } from '../types';
import * as api from '../services/api';
import LaTeX from './LaTeX';
import ImportPanel from './ImportPanel';
import AssignPopup from './AssignPopup';
import { randomCategorical } from '../palette';

interface Props {
  papers: SavedPaper[];
  tags: Tag[];
  onOpenPaper: (paper: SavedPaper) => void;
  onRefresh: () => Promise<void>;
  showNotification: (msg: string) => void;
  favoriteAuthorNames: Set<string>;
  onFavoriteAuthor: (name: string) => void;
  onSearchAuthor: (name: string) => void;
}

const TIER_LABELS: Record<number, string> = {
  0: 'T0',
  1: 'T1',
  2: 'T2',
  3: 'T3',
  4: 'T4',
};

const TIER_RUBRIC: { tier: string; name: string; body: string }[] = [
  {
    tier: 'T0',
    name: 'Mirror',
    body: "Reshaped the field. If you removed this paper, a chunk of subsequent work doesn't exist or looks very different. Decade+ of citations, named techniques, textbook entry. Polish is irrelevant at this tier — the idea carries it. Expect <1% of saves.",
  },
  {
    tier: 'T1',
    name: 'Exalted',
    body: "Major contribution. Introduced a technique, framework, or result that's now standard in a subfield. Heavily cited, well-written, you'd hand it to someone entering the area. Not civilization-altering, but the subfield genuinely pivoted. Roughly the top ~5%.",
  },
  {
    tier: 'T2',
    name: 'Rare',
    body: 'Solid, important work you actively want to remember. Either (a) a clean novel result, (b) a definitive survey/benchmark, or (c) a paper that changed your thinking even if the field shrugged. Polish matters here — a T2 should be worth re-reading. ~15–20%.',
  },
  {
    tier: 'T3',
    name: 'Magic',
    body: "Competent contribution. Fills in a gap, replicates with a twist, useful negative result, or a well-executed application. You're glad you read it; you probably won't revisit. The bulk of decent papers. ~50%.",
  },
  {
    tier: 'T4',
    name: 'Normal',
    body: 'Minor or narrow. Incremental, niche, or only mattered for one citation you needed. Worth keeping for completeness, not for re-reading. ~25%.',
  },
];

type TierFilter = number | 'ungraded' | null;
type SortMode = 'viewed-desc' | 'viewed-asc' | 'added-desc' | 'added-asc';

const SORT_OPTIONS: { value: SortMode; label: string }[] = [
  { value: 'viewed-desc', label: 'Recently viewed' },
  { value: 'viewed-asc', label: 'Least recently viewed' },
  { value: 'added-desc', label: 'Recently added' },
  { value: 'added-asc', label: 'Least recently added' },
];

export default function Library({ papers, tags, onOpenPaper, onRefresh, showNotification, favoriteAuthorNames, onFavoriteAuthor, onSearchAuthor }: Props) {
  // Which papers have a walkthrough. A small indicator only — there is
  // deliberately no bulk build: an agentic run per paper is exactly how a cost
  // surprise happens.
  const [walkthroughIds, setWalkthroughIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    api.getWalkthroughIndicators()
      .then(rows => {
        if (!cancelled) {
          setWalkthroughIds(new Set(rows.filter(r => r.status === 'ready').map(r => r.arxiv_id)));
        }
      })
      .catch(() => { /* the badge is decoration; its absence is not an error */ });
    return () => { cancelled = true; };
  }, [papers.length]);

  const [filterTag, setFilterTag] = useState<number | null>(null);
  const [filterWorldline, setFilterWorldline] = useState<number | null>(null);
  const [filterTier, setFilterTier] = useState<TierFilter>(null);
  const [showTierRubric, setShowTierRubric] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [sortMode, setSortMode] = useState<SortMode>('viewed-desc');
  const [newTagName, setNewTagName] = useState('');
  const [creatingTag, setCreatingTag] = useState(false);
  const [taggedPaperIds, setTaggedPaperIds] = useState<Set<number> | null>(null);

  // Tag editing state
  const [editingTagId, setEditingTagId] = useState<number | null>(null);
  const [editTagName, setEditTagName] = useState('');
  const [editTagColor, setEditTagColor] = useState('');
  const [tagContextMenu, setTagContextMenu] = useState<{ x: number; y: number; tag: Tag } | null>(null);
  const newTagInputRef = useRef<HTMLInputElement>(null);
  const editTagInputRef = useRef<HTMLInputElement>(null);
  const [worldlinePaperIds, setWorldlinePaperIds] = useState<Set<number> | null>(null);
  const [filterWorldlines, setFilterWorldlines] = useState<Worldline[]>([]);
  const [tagsByPaper, setTagsByPaper] = useState<Record<number, number[]>>({});
  const [worldlinesByPaper, setWorldlinesByPaper] = useState<Record<number, number[]>>({});

  // Import panel state
  const [showImport, setShowImport] = useState(false);

  // Export choice state (revealed after clicking Export with selection)
  const [showExportChoice, setShowExportChoice] = useState(false);

  // Bulk selection state
  const [selectedPaperIds, setSelectedPaperIds] = useState<Set<number>>(new Set());
  const [activePaperId, setActivePaperId] = useState<number | null>(null);
  const [anchorPaperId, setAnchorPaperId] = useState<number | null>(null);
  const paperCardRefs = useRef<Map<number, HTMLDivElement>>(new Map());

  // Mobile actions toggle
  const [showMobileActions, setShowMobileActions] = useState(false);

  // Assign popup (worldline/tag) state
  const [showAssignPopup, setShowAssignPopup] = useState(false);

  useEffect(() => {
    if (filterTag === null) {
      setTaggedPaperIds(null);
      return;
    }
    api.getSavedPapers({ tag_id: filterTag }).then(taggedPapers => {
      setTaggedPaperIds(new Set(taggedPapers.map(p => p.id)));
    }).catch(() => {
      setTaggedPaperIds(null);
    });
  }, [filterTag, papers]);

  // Load worldlines for sidebar
  useEffect(() => {
    api.getWorldlines().then(setFilterWorldlines).catch(() => {});
  }, [papers]);

  // Load paper-tag associations
  useEffect(() => {
    api.getTagAssociations().then(setTagsByPaper).catch(() => {});
  }, [papers, tags]);

  // Load paper-worldline associations (used for the assign popup hints)
  useEffect(() => {
    api.getWorldlineAssociations().then(setWorldlinesByPaper).catch(() => {});
  }, [papers, filterWorldlines]);

  // Fetch paper IDs for selected worldline filter
  useEffect(() => {
    if (filterWorldline === null) {
      setWorldlinePaperIds(null);
      return;
    }
    api.getWorldlinePapers(filterWorldline).then(wlPapers => {
      setWorldlinePaperIds(new Set(wlPapers.map(p => p.id)));
    }).catch(() => {
      setWorldlinePaperIds(null);
    });
  }, [filterWorldline, papers]);

  // Clear selection when filters change
  useEffect(() => {
    setSelectedPaperIds(new Set());
    setActivePaperId(null);
    setAnchorPaperId(null);
  }, [filterTag, filterWorldline, filterTier, searchTerm]);

  const filteredPapers = papers
    .filter(p => {
      if (taggedPaperIds !== null && !taggedPaperIds.has(p.id)) return false;
      if (worldlinePaperIds !== null && !worldlinePaperIds.has(p.id)) return false;
      if (filterTier !== null) {
        if (filterTier === 'ungraded') {
          if (p.tier !== null && p.tier !== undefined) return false;
        } else if (p.tier !== filterTier) {
          return false;
        }
      }
      if (searchTerm) {
        const term = searchTerm.toLowerCase();
        const matchTitle = p.title.toLowerCase().includes(term);
        const matchAuthors = p.authors.toLowerCase().includes(term);
        if (!matchTitle && !matchAuthors) return false;
      }
      return true;
    })
    .slice()
    .sort((a, b) => {
      const desc = sortMode.endsWith('-desc');
      // Empty string for missing last_viewed_at sorts before any ISO timestamp
      // — i.e. treated as infinitely in the past.
      const av = (sortMode.startsWith('viewed') ? a.last_viewed_at : a.added_at) || '';
      const bv = (sortMode.startsWith('viewed') ? b.last_viewed_at : b.added_at) || '';
      return desc ? bv.localeCompare(av) : av.localeCompare(bv);
    });

  // Selection helpers
  function clearSelection() {
    setSelectedPaperIds(new Set());
    setActivePaperId(null);
    setAnchorPaperId(null);
  }

  function rangeBetween(fromId: number, toId: number): Set<number> {
    const fromIdx = filteredPapers.findIndex(p => p.id === fromId);
    const toIdx = filteredPapers.findIndex(p => p.id === toId);
    if (fromIdx === -1 || toIdx === -1) return new Set([toId]);
    const [lo, hi] = fromIdx < toIdx ? [fromIdx, toIdx] : [toIdx, fromIdx];
    const range = new Set<number>();
    for (let i = lo; i <= hi; i++) range.add(filteredPapers[i].id);
    return range;
  }

  function scrollPaperIntoView(paperId: number) {
    const el = paperCardRefs.current.get(paperId);
    if (el) el.scrollIntoView({ block: 'nearest' });
  }

  // Single click selects, double click opens
  function handleCardClick(paper: SavedPaper, e: React.MouseEvent) {
    const target = e.target as HTMLElement;
    if (target.closest('select') || target.closest('option') || target.closest('.author-name-btn')) return;

    if (e.shiftKey && anchorPaperId !== null) {
      setSelectedPaperIds(rangeBetween(anchorPaperId, paper.id));
      setActivePaperId(paper.id);
    } else if (e.ctrlKey || e.metaKey) {
      setSelectedPaperIds(prev => {
        const next = new Set(prev);
        if (next.has(paper.id)) next.delete(paper.id);
        else next.add(paper.id);
        return next;
      });
      setActivePaperId(paper.id);
      setAnchorPaperId(paper.id);
    } else {
      setSelectedPaperIds(new Set([paper.id]));
      setActivePaperId(paper.id);
      setAnchorPaperId(paper.id);
    }
  }

  function handleCardDoubleClick(paper: SavedPaper, e: React.MouseEvent) {
    const target = e.target as HTMLElement;
    if (target.closest('select') || target.closest('option') || target.closest('.author-name-btn')) return;
    onOpenPaper(paper);
  }

  // Keyboard navigation: up/down to move, shift to extend, enter to open
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (target) {
        if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;
      }
      if (filteredPapers.length === 0) return;

      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        let newActiveId: number;
        if (activePaperId === null) {
          newActiveId = filteredPapers[0].id;
        } else {
          const currentIdx = filteredPapers.findIndex(p => p.id === activePaperId);
          if (currentIdx === -1) {
            newActiveId = filteredPapers[0].id;
          } else {
            const delta = e.key === 'ArrowDown' ? 1 : -1;
            const nextIdx = Math.max(0, Math.min(filteredPapers.length - 1, currentIdx + delta));
            newActiveId = filteredPapers[nextIdx].id;
          }
        }

        if (e.shiftKey && anchorPaperId !== null) {
          setSelectedPaperIds(rangeBetween(anchorPaperId, newActiveId));
          setActivePaperId(newActiveId);
        } else {
          setSelectedPaperIds(new Set([newActiveId]));
          setActivePaperId(newActiveId);
          setAnchorPaperId(newActiveId);
        }
        scrollPaperIntoView(newActiveId);
      } else if (e.key === 'Enter') {
        if (selectedPaperIds.size === 1) {
          const id = Array.from(selectedPaperIds)[0];
          const paper = papers.find(p => p.id === id);
          if (paper) {
            e.preventDefault();
            onOpenPaper(paper);
          }
        }
      } else if (e.key === 'Escape') {
        if (selectedPaperIds.size > 0) clearSelection();
      } else if ((e.key === 'd' || e.key === 'D') && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (selectedPaperIds.size === 0) return;
        e.preventDefault();
        handleDeleteSelected();
      } else if ((e.key === 'a' || e.key === 'A') && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (selectedPaperIds.size === 0) return;
        e.preventDefault();
        setShowAssignPopup(true);
      }
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [filteredPapers, activePaperId, anchorPaperId, selectedPaperIds, papers, onOpenPaper]);

  async function handleDeleteSelected() {
    const count = selectedPaperIds.size;
    if (count === 0) return;
    const msg = count === 1
      ? 'Delete 1 paper? This cannot be undone.'
      : `Delete ${count} papers? This cannot be undone.`;
    if (!confirm(msg)) return;
    try {
      const ids = Array.from(selectedPaperIds);
      const result = await api.bulkDeletePapers(ids);
      clearSelection();
      showNotification(`Deleted ${result.deleted} paper(s)`);
      await onRefresh();
    } catch (err: any) {
      showNotification(err?.message || 'Failed to delete papers');
    }
  }

  async function handleToggleCache(paper: SavedPaper) {
    if (paper.arxiv_id.startsWith('upload-')) return;
    try {
      if (paper.pdf_path) {
        await api.deleteLocalPdf(paper.id);
      } else {
        await api.downloadLocalPdf(paper.id);
      }
      await onRefresh();
    } catch (err: any) {
      showNotification(err?.message || (paper.pdf_path ? 'Failed to uncache PDF' : 'Failed to cache PDF'));
    }
  }

  async function handleTierChange(paper: SavedPaper, tier: number | null) {
    try {
      await api.updatePaperTier(paper.id, tier);
      await onRefresh();
    } catch {
      showNotification('Failed to update tier');
    }
  }

  useEffect(() => {
    if (creatingTag && newTagInputRef.current) {
      newTagInputRef.current.focus();
    }
  }, [creatingTag]);

  useEffect(() => {
    if (editingTagId && editTagInputRef.current) {
      editTagInputRef.current.focus();
      editTagInputRef.current.select();
    }
  }, [editingTagId]);

  // Close tag context menu on click outside
  useEffect(() => {
    if (!tagContextMenu) return;
    const handler = () => setTagContextMenu(null);
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, [tagContextMenu]);

  async function handleCreateTag() {
    const trimmed = newTagName.trim();
    if (!trimmed) {
      setCreatingTag(false);
      setNewTagName('');
      return;
    }
    try {
      await api.createTag(trimmed, randomCategorical());
      setNewTagName('');
      setCreatingTag(false);
      showNotification(`Tag "${trimmed}" created`);
      await onRefresh();
    } catch (err: any) {
      showNotification(err.message || 'Failed to create tag');
    }
  }

  async function handleShuffleTagColors() {
    if (tags.length === 0) return;
    try {
      await Promise.all(tags.map(t => api.updateTag(t.id, t.name, randomCategorical())));
      showNotification('Tag colors shuffled');
      await onRefresh();
    } catch {
      showNotification('Failed to shuffle tag colors');
    }
  }

  async function handleSidebarTagClick(tag: Tag) {
    if (selectedPaperIds.size > 0) {
      // Apply tag to selected papers instead of filtering
      try {
        const result = await api.bulkAddTag(Array.from(selectedPaperIds), tag.id);
        showNotification(`Applied "${tag.name}" to ${result.applied} paper(s)`);
        await onRefresh();
      } catch {
        showNotification('Failed to apply tag');
      }
      return;
    }
    setFilterTag(filterTag === tag.id ? null : tag.id);
  }

  async function handleRemovePaperTag(paperId: number, tagId: number) {
    try {
      await api.removePaperTag(paperId, tagId);
      setTagsByPaper(prev => {
        const current = prev[paperId] || [];
        return { ...prev, [paperId]: current.filter(id => id !== tagId) };
      });
    } catch {
      showNotification('Failed to remove tag');
    }
  }

  async function handleDeleteTag(tag: Tag) {
    if (!confirm(`Delete tag "${tag.name}"?`)) return;
    try {
      await api.deleteTag(tag.id);
      showNotification(`Tag "${tag.name}" deleted`);
      if (filterTag === tag.id) setFilterTag(null);
      await onRefresh();
    } catch {
      showNotification('Failed to delete tag');
    }
  }

  function startEditTag(tag: Tag) {
    setEditingTagId(tag.id);
    setEditTagName(tag.name);
    setEditTagColor(tag.color);
  }

  async function commitEditTag() {
    if (!editingTagId) return;
    const trimmed = editTagName.trim();
    const tag = tags.find(t => t.id === editingTagId);
    if (trimmed && tag && (trimmed !== tag.name || editTagColor !== tag.color)) {
      try {
        await api.updateTag(editingTagId, trimmed, editTagColor);
        await onRefresh();
      } catch (err: any) {
        showNotification(err.message || 'Failed to update tag');
      }
    }
    setEditingTagId(null);
    setEditTagName('');
    setEditTagColor('');
  }

  function cancelEditTag() {
    setEditingTagId(null);
    setEditTagName('');
    setEditTagColor('');
  }

  function handleExportSelectedBibtex() {
    if (selectedPaperIds.size === 0) return;
    const ids = Array.from(selectedPaperIds);
    window.open(api.getBibtexUrl(undefined, true, ids), '_blank');
    setShowExportChoice(false);
  }

  function handleExportSelectedPdfs() {
    if (selectedPaperIds.size === 0) return;
    const ids = Array.from(selectedPaperIds);
    window.open(api.getPdfZipUrl(ids), '_blank');
    setShowExportChoice(false);
  }

  function handleExportClick() {
    if (selectedPaperIds.size === 0) {
      showNotification('Select papers to export first');
      return;
    }
    setShowExportChoice(prev => !prev);
  }

  // Hide the export choice if selection becomes empty or select mode is exited
  useEffect(() => {
    if (selectedPaperIds.size === 0) setShowExportChoice(false);
  }, [selectedPaperIds]);

  return (
    <div className="library">
      {/* Sidebar */}
      <nav className="library-sidebar">
        {filterWorldlines.length > 0 && (
          <div className="sidebar-section">
            <h4 className="sidebar-section-title">Worldlines</h4>
            <button
              className={`sidebar-item${filterWorldline === null ? ' active' : ''}`}
              onClick={() => setFilterWorldline(null)}
            >
              All
            </button>
            {filterWorldlines.map(wl => (
              <button
                key={wl.id}
                className={`sidebar-item${filterWorldline === wl.id ? ' active' : ''}`}
                onClick={() => setFilterWorldline(filterWorldline === wl.id ? null : wl.id)}
              >
                <span className="sidebar-item-dot" style={{ backgroundColor: wl.color }} />
                {wl.name}
              </button>
            ))}
          </div>
        )}

        <div className="sidebar-section">
          <h4 className="sidebar-section-title sidebar-section-title-row">
            <span>Tiers</span>
            <button
              type="button"
              className="sidebar-help-btn"
              onClick={() => setShowTierRubric(true)}
              title="Tiering rubric"
              aria-label="Show tiering rubric"
            >
              ?
            </button>
          </h4>
          <button
            className={`sidebar-item${filterTier === null ? ' active' : ''}`}
            onClick={() => setFilterTier(null)}
          >
            All
          </button>
          {[0, 1, 2, 3, 4].map(t => (
            <button
              key={t}
              className={`sidebar-item sidebar-item-tier sidebar-item-tier-${t}${filterTier === t ? ' active' : ''}`}
              onClick={() => setFilterTier(filterTier === t ? null : t)}
              title={t === 0 ? 'Groundbreaking' : t === 4 ? 'Skim' : `Tier ${t}`}
            >
              <span className={`tier-dot tier-dot-${t}`}>{TIER_LABELS[t]}</span>
            </button>
          ))}
          <button
            className={`sidebar-item${filterTier === 'ungraded' ? ' active' : ''}`}
            onClick={() => setFilterTier(filterTier === 'ungraded' ? null : 'ungraded')}
            title="Ungraded"
          >
            <span className="tier-dot tier-dot-ungraded">—</span>
          </button>
        </div>

        <div className="sidebar-section">
          <h4 className="sidebar-section-title sidebar-section-title-row">
            <span>Tags</span>
            {tags.length > 0 && (
              <button
                type="button"
                className="sidebar-help-btn"
                onClick={handleShuffleTagColors}
                title="Shuffle all tag colors"
                aria-label="Shuffle all tag colors"
              >
                ⤭
              </button>
            )}
          </h4>
          {tags.length > 0 && (
            <button
              className={`sidebar-item${filterTag === null ? ' active' : ''}`}
              onClick={() => setFilterTag(null)}
              title={selectedPaperIds.size > 0 ? 'Selection mode — pick a tag below to apply' : 'Show all'}
            >
              All
            </button>
          )}
          {tags.map(tag => (
            <div key={tag.id}>
              {editingTagId === tag.id ? (
                <div className="sidebar-tag-edit">
                  <input
                    ref={editTagInputRef}
                    className="sidebar-rename-input"
                    value={editTagName}
                    onChange={e => setEditTagName(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') commitEditTag();
                      if (e.key === 'Escape') cancelEditTag();
                    }}
                    onBlur={commitEditTag}
                  />
                  <input
                    type="color"
                    className="sidebar-color-input"
                    value={editTagColor}
                    onChange={e => setEditTagColor(e.target.value)}
                  />
                </div>
              ) : (
                <button
                  className={`sidebar-item${filterTag === tag.id ? ' active' : ''}`}
                  onClick={() => handleSidebarTagClick(tag)}
                  onContextMenu={e => {
                    e.preventDefault();
                    setTagContextMenu({ x: e.clientX, y: e.clientY, tag });
                  }}
                  title={selectedPaperIds.size > 0 ? `Apply "${tag.name}" to ${selectedPaperIds.size} selected paper(s)` : `Filter by ${tag.name}`}
                >
                  <span className="sidebar-item-dot" style={{ backgroundColor: tag.color }} />
                  {tag.name}
                </button>
              )}
            </div>
          ))}
          {creatingTag ? (
            <div className="sidebar-tag-edit">
              <input
                ref={newTagInputRef}
                className="sidebar-rename-input"
                value={newTagName}
                placeholder="Tag name"
                onChange={e => setNewTagName(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') handleCreateTag();
                  if (e.key === 'Escape') {
                    setCreatingTag(false);
                    setNewTagName('');
                  }
                }}
                onBlur={handleCreateTag}
              />
            </div>
          ) : (
            <button
              className="sidebar-new-btn"
              onClick={() => setCreatingTag(true)}
            >
              + New Tag
            </button>
          )}
        </div>

        {filterWorldlines.length === 0 && tags.length === 0 && !creatingTag && (
          <div className="sidebar-section">
            <p className="sidebar-empty">No worldlines yet.</p>
          </div>
        )}
      </nav>

      {/* Main content */}
      <div className="library-main">
        <div className="library-controls">
          <div className="control-row">
            <div className="control-group search-group">
              <select
                className="sort-select"
                value={sortMode}
                onChange={e => setSortMode(e.target.value as SortMode)}
                aria-label="Sort order"
                title="Sort order"
              >
                {SORT_OPTIONS.map(opt => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
              <input
                type="text"
                placeholder="Filter papers by title or author..."
                value={searchTerm}
                onChange={e => setSearchTerm(e.target.value)}
                className="search-input"
              />
            </div>

            <div className="control-group mobile-actions-toggle">
              <button
                className="btn btn-secondary btn-sm"
                onClick={() => setShowMobileActions(!showMobileActions)}
              >
                {showMobileActions ? 'Hide Actions' : 'Actions\u2026'}
              </button>
            </div>

            <div className={`library-action-buttons ${showMobileActions ? 'expanded' : ''}`}>
              <div className="control-group">
                <button
                  className={`btn btn-sm ${showImport ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => setShowImport(!showImport)}
                >
                  Import
                </button>
              </div>

              <div className="control-group export-group">
                <button
                  className={`btn btn-sm ${showExportChoice ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={handleExportClick}
                  title={selectedPaperIds.size === 0 ? 'Select papers first' : `Export ${selectedPaperIds.size} selected`}
                >
                  Export{selectedPaperIds.size > 0 ? ` (${selectedPaperIds.size})` : ''}
                </button>
                {showExportChoice && selectedPaperIds.size > 0 && (
                  <>
                    <button
                      className="btn btn-primary btn-sm"
                      onClick={handleExportSelectedBibtex}
                    >
                      BibTeX
                    </button>
                    <button
                      className="btn btn-primary btn-sm"
                      onClick={handleExportSelectedPdfs}
                    >
                      PDFs
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>

        {showImport && (
          <ImportPanel
            tags={tags}
            showNotification={showNotification}
            onImportComplete={onRefresh}
          />
        )}

        {filteredPapers.length === 0 ? (
          <div className="empty-state">
            {papers.length === 0
              ? 'Your library is empty. Browse ArXiv or upload a PDF to add papers.'
              : 'No papers match your filters.'}
          </div>
        ) : (
          <div className="paper-list">
            {filteredPapers.map(paper => {
              const authors = JSON.parse(paper.authors) as string[];

              const tierValue = paper.tier ?? null;
              const tierClass = tierValue !== null ? ` tier-${tierValue}` : ' tier-ungraded';

              const isUploaded = paper.arxiv_id.startsWith('upload-');
              const cacheLetter = isUploaded ? 'U' : paper.pdf_path ? 'C' : 'A';
              const cacheTitle = isUploaded
                ? 'Uploaded PDF'
                : paper.pdf_path
                  ? 'Cached locally — click to uncache'
                  : 'ArXiv (not cached) — click to cache';
              const isActive = activePaperId === paper.id;
              return (
                <div
                  key={paper.id}
                  ref={el => {
                    if (el) paperCardRefs.current.set(paper.id, el);
                    else paperCardRefs.current.delete(paper.id);
                  }}
                  className={`paper-card library-card${tierClass}${selectedPaperIds.has(paper.id) ? ' selected' : ''}${isActive ? ' active' : ''}`}
                  onClick={e => handleCardClick(paper, e)}
                  onDoubleClick={e => handleCardDoubleClick(paper, e)}
                >
                  <div className="paper-tier-marker" onClick={e => e.stopPropagation()} onDoubleClick={e => e.stopPropagation()}>
                    <select
                      className={`tier-select tier-select-${tierValue ?? 'ungraded'}`}
                      value={tierValue === null ? '' : String(tierValue)}
                      onChange={e => {
                        const v = e.target.value;
                        handleTierChange(paper, v === '' ? null : parseInt(v, 10));
                      }}
                      title={tierValue === null ? 'Ungraded — click to grade' : `${TIER_LABELS[tierValue]} — click to change`}
                    >
                      <option value="">—</option>
                      <option value="0">T0</option>
                      <option value="1">T1</option>
                      <option value="2">T2</option>
                      <option value="3">T3</option>
                      <option value="4">T4</option>
                    </select>
                  </div>
                  {isUploaded ? (
                    <span
                      className="paper-cache-indicator paper-cache-indicator-u"
                      title={cacheTitle}
                      onClick={e => e.stopPropagation()}
                      onDoubleClick={e => e.stopPropagation()}
                    >
                      {cacheLetter}
                    </span>
                  ) : (
                    <button
                      type="button"
                      className={`paper-cache-indicator paper-cache-indicator-${cacheLetter.toLowerCase()}`}
                      title={cacheTitle}
                      onClick={e => { e.stopPropagation(); handleToggleCache(paper); }}
                      onDoubleClick={e => e.stopPropagation()}
                    >
                      {cacheLetter}
                    </button>
                  )}
                  <div className="paper-card-body">
                  <div className="paper-card-header">
                    <div className="paper-select-title">
                      <h3 className="paper-title">
                        <LaTeX>{paper.title}</LaTeX>
                        {walkthroughIds.has(paper.arxiv_id) && (
                          <span
                            className="walkthrough-badge"
                            title="An interactive walkthrough has been built for this paper"
                          >
                            ◈
                          </span>
                        )}
                      </h3>
                    </div>
                  </div>

                  <div className="paper-meta">
                    <span className="paper-authors">
                      {authors.slice(0, 3).map((author, i) => (
                        <span key={i}>
                          {i > 0 && ', '}
                          <button
                            className={`author-name-btn ${favoriteAuthorNames.has(author) ? 'is-favorite' : ''}`}
                            onClick={(e) => { e.stopPropagation(); if (!favoriteAuthorNames.has(author)) onFavoriteAuthor(author); }}
                            onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onSearchAuthor(author); }}
                            title={favoriteAuthorNames.has(author) ? 'Already in favorites' : `Add ${author} to favorites | Right-click to search`}
                          >
                            {author}
                          </button>
                        </span>
                      ))}
                      {authors.length > 3 && ` +${authors.length - 3} more`}
                    </span>
                    {(tagsByPaper[paper.id]?.length ?? 0) > 0 && (
                      <span className="paper-tag-chips">
                        {tagsByPaper[paper.id]
                          .map(id => tags.find(t => t.id === id))
                          .filter((t): t is Tag => !!t)
                          .map(tag => (
                            <span
                              key={tag.id}
                              className="paper-tag-chip"
                              style={{ backgroundColor: tag.color }}
                              onClick={e => e.stopPropagation()}
                              onDoubleClick={e => e.stopPropagation()}
                            >
                              {tag.name}
                              <button
                                type="button"
                                className="paper-tag-chip-remove"
                                title={`Remove "${tag.name}"`}
                                aria-label={`Remove ${tag.name}`}
                                onClick={e => { e.stopPropagation(); handleRemovePaperTag(paper.id, tag.id); }}
                                onDoubleClick={e => e.stopPropagation()}
                              >
                                ×
                              </button>
                            </span>
                          ))}
                      </span>
                    )}
                    <span className="paper-dates">
                      <span title="Last viewed">
                        {paper.last_viewed_at ? new Date(paper.last_viewed_at).toLocaleDateString() : '—'}
                      </span>
                      <span className="paper-dates-sep" aria-hidden="true" />
                      <span title="Added">
                        {new Date(paper.added_at).toLocaleDateString()}
                      </span>
                    </span>
                  </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Tier rubric modal */}
      {showTierRubric && (
        <div
          className="settings-overlay"
          onClick={() => setShowTierRubric(false)}
        >
          <div
            className="rubric-modal"
            onClick={e => e.stopPropagation()}
            role="dialog"
            aria-label="Tiering rubric"
          >
            <div className="rubric-modal-header">
              <h2>Tiering rubric</h2>
              <button
                type="button"
                className="btn-icon"
                onClick={() => setShowTierRubric(false)}
                aria-label="Close"
              >
                ×
              </button>
            </div>
            <div className="rubric-modal-body">
              {TIER_RUBRIC.map(entry => (
                <div key={entry.tier} className={`rubric-row rubric-row-${entry.tier.toLowerCase()}`}>
                  <div className="rubric-row-head">
                    <span className={`tier-dot tier-dot-${entry.tier.slice(1)}`}>{entry.tier}</span>
                    <span className="rubric-row-name">{entry.name}</span>
                  </div>
                  <p className="rubric-row-body">{entry.body}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Assign worldline/tag popup (triggered by A key) */}
      {showAssignPopup && selectedPaperIds.size > 0 && (
        <AssignPopup
          selectedPaperIds={selectedPaperIds}
          worldlines={filterWorldlines}
          tags={tags}
          tagsByPaper={tagsByPaper}
          worldlinesByPaper={worldlinesByPaper}
          onClose={() => setShowAssignPopup(false)}
          onApplied={onRefresh}
          showNotification={showNotification}
        />
      )}

      {/* Tag context menu */}
      {tagContextMenu && (
        <div
          className="tag-context-menu"
          style={{ left: tagContextMenu.x, top: tagContextMenu.y }}
          onClick={e => e.stopPropagation()}
        >
          <button
            className="tag-context-menu-item"
            onClick={() => { startEditTag(tagContextMenu.tag); setTagContextMenu(null); }}
          >
            Rename / Recolor
          </button>
          <button
            className="tag-context-menu-item danger"
            onClick={() => { handleDeleteTag(tagContextMenu.tag); setTagContextMenu(null); }}
          >
            Delete
          </button>
        </div>
      )}
    </div>
  );
}
