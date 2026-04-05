import { useState, useEffect, useCallback, useRef } from 'react';
import { SavedPaper, Tag, Worldline } from '../types';
import * as api from '../services/api';
import LaTeX from './LaTeX';
import BatchImportPanel from './BatchImportPanel';

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

const STATUS_LABELS: Record<string, string> = {
  new: 'New',
  reading: 'Reading',
  reviewed: 'Reviewed',
  exported: 'Exported',
};

const STATUS_COLORS: Record<string, string> = {
  new: '#6366f1',
  reading: '#f59e0b',
  reviewed: '#10b981',
  exported: '#8b5cf6',
};

export default function Library({ papers, tags, onOpenPaper, onRefresh, showNotification, favoriteAuthorNames, onFavoriteAuthor, onSearchAuthor }: Props) {
  const [filterStatus, setFilterStatus] = useState<string>('');
  const [filterTag, setFilterTag] = useState<number | null>(null);
  const [filterWorldline, setFilterWorldline] = useState<number | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [newTagName, setNewTagName] = useState('');
  const [newTagColor, setNewTagColor] = useState('#6366f1');
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

  // Batch import state
  const [showBatchImport, setShowBatchImport] = useState(false);

  // BibTeX import state
  const [showBibtexImport, setShowBibtexImport] = useState(false);
  const [bibtexText, setBibtexText] = useState('');
  const [bibtexImporting, setBibtexImporting] = useState(false);

  // PDF upload state
  const [showPdfUpload, setShowPdfUpload] = useState(false);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadTitle, setUploadTitle] = useState('');
  const [uploadAuthors, setUploadAuthors] = useState('');
  const [uploadSummary, setUploadSummary] = useState('');
  const [uploading, setUploading] = useState(false);

  // Bulk selection state
  const [selectedPaperIds, setSelectedPaperIds] = useState<Set<number>>(new Set());
  const [bulkLoading, setBulkLoading] = useState(false);
  const [bulkAction, setBulkAction] = useState<string | null>(null);
  const [selectMode, setSelectMode] = useState(false);

  // Mobile actions toggle
  const [showMobileActions, setShowMobileActions] = useState(false);

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

  // Clear selection and exit select mode when filters change
  useEffect(() => {
    setSelectedPaperIds(new Set());
    setSelectMode(false);
  }, [filterStatus, filterTag, filterWorldline, searchTerm]);

  const filteredPapers = papers.filter(p => {
    if (taggedPaperIds !== null && !taggedPaperIds.has(p.id)) return false;
    if (worldlinePaperIds !== null && !worldlinePaperIds.has(p.id)) return false;
    if (filterStatus && p.status !== filterStatus) return false;
    if (searchTerm) {
      const term = searchTerm.toLowerCase();
      const matchTitle = p.title.toLowerCase().includes(term);
      const matchAuthors = p.authors.toLowerCase().includes(term);
      if (!matchTitle && !matchAuthors) return false;
    }
    return true;
  });

  // Selection helpers
  function toggleSelection(paperId: number) {
    setSelectedPaperIds(prev => {
      const next = new Set(prev);
      if (next.has(paperId)) next.delete(paperId);
      else next.add(paperId);
      return next;
    });
  }

  function selectAll() {
    setSelectedPaperIds(new Set(filteredPapers.map(p => p.id)));
  }

  function selectNone() {
    setSelectedPaperIds(new Set());
  }

  const toggleSelectMode = useCallback(() => {
    setSelectMode(prev => {
      if (prev) setSelectedPaperIds(new Set());
      return !prev;
    });
  }, []);

  function exitSelectMode() {
    setSelectMode(false);
    setSelectedPaperIds(new Set());
  }

  // Card click handler
  function handleCardClick(paper: SavedPaper, e: React.MouseEvent) {
    const target = e.target as HTMLElement;
    if (target.closest('select') || target.closest('option') || target.closest('.author-name-btn')) return;
    if (selectMode) {
      toggleSelection(paper.id);
    } else {
      onOpenPaper(paper);
    }
  }

  async function handleStatusChange(paper: SavedPaper, status: string) {
    try {
      await api.updatePaperStatus(paper.id, status);
      await onRefresh();
    } catch {
      showNotification('Failed to update status');
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
      await api.createTag(trimmed, newTagColor);
      setNewTagName('');
      setNewTagColor('#6366f1');
      setCreatingTag(false);
      showNotification(`Tag "${trimmed}" created`);
      await onRefresh();
    } catch (err: any) {
      showNotification(err.message || 'Failed to create tag');
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

  function handleExportAll() {
    const ids = filteredPapers.map(p => p.id);
    window.open(api.getBibtexUrl(undefined, true, ids), '_blank');
  }

  // Bulk operation handlers
  async function handleBulkDownloadPdfs() {
    setBulkLoading(true);
    setBulkAction('Downloading PDFs');
    try {
      const result = await api.bulkDownloadPdfs(Array.from(selectedPaperIds));
      showNotification(`Downloaded ${result.downloaded} PDFs${result.failed > 0 ? `, ${result.failed} failed` : ''}`);
      exitSelectMode();
      await onRefresh();
    } catch {
      showNotification('Failed to download PDFs');
    } finally {
      setBulkLoading(false);
      setBulkAction(null);
    }
  }

  async function handleBulkDeletePdfs() {
    if (!confirm(`Delete local PDFs for ${selectedPaperIds.size} paper(s)?`)) return;
    setBulkLoading(true);
    setBulkAction('Deleting PDFs');
    try {
      const result = await api.bulkDeletePdfs(Array.from(selectedPaperIds));
      showNotification(`Deleted ${result.deleted} local PDF(s)`);
      exitSelectMode();
      await onRefresh();
    } catch {
      showNotification('Failed to delete PDFs');
    } finally {
      setBulkLoading(false);
      setBulkAction(null);
    }
  }

  async function handleBulkSendToScribe() {
    if (!confirm(`Send ${selectedPaperIds.size} paper(s) to Scribe? Papers will be removed from Navigate.`)) return;
    setBulkLoading(true);
    setBulkAction('Sending to Scribe');
    try {
      const result = await api.sendToScribe(Array.from(selectedPaperIds));
      const msg = `Sent ${result.sent} paper(s) to Scribe${result.failed > 0 ? `, ${result.failed} failed` : ''}`;
      showNotification(msg);
      if (result.errors.length > 0) console.warn('Send to Scribe errors:', result.errors);
      exitSelectMode();
      await onRefresh();
    } catch {
      showNotification('Failed to send papers to Scribe. Is Scribe running?');
    } finally {
      setBulkLoading(false);
      setBulkAction(null);
    }
  }

  async function handleBulkDelete() {
    if (!confirm(`Delete ${selectedPaperIds.size} paper(s) from your library? This cannot be undone.`)) return;
    setBulkLoading(true);
    setBulkAction('Deleting papers');
    try {
      const result = await api.bulkDeletePapers(Array.from(selectedPaperIds));
      showNotification(`Deleted ${result.deleted} paper(s)`);
      exitSelectMode();
      await onRefresh();
    } catch {
      showNotification('Failed to delete papers');
    } finally {
      setBulkLoading(false);
      setBulkAction(null);
    }
  }

  async function handleBulkStatusChange(status: string) {
    setBulkLoading(true);
    setBulkAction('Updating status');
    try {
      const result = await api.bulkUpdateStatus(Array.from(selectedPaperIds), status);
      showNotification(`Updated status for ${result.updated} paper(s)`);
      exitSelectMode();
      await onRefresh();
    } catch {
      showNotification('Failed to update status');
    } finally {
      setBulkLoading(false);
      setBulkAction(null);
    }
  }

  async function handleBulkAddTag(tagId: number) {
    setBulkLoading(true);
    setBulkAction('Adding tag');
    try {
      const result = await api.bulkAddTag(Array.from(selectedPaperIds), tagId);
      showNotification(`Added tag to ${result.applied} paper(s)`);
      exitSelectMode();
      await onRefresh();
    } catch {
      showNotification('Failed to add tag');
    } finally {
      setBulkLoading(false);
      setBulkAction(null);
    }
  }

  async function handleBulkRemoveTag(tagId: number) {
    setBulkLoading(true);
    setBulkAction('Removing tag');
    try {
      const result = await api.bulkRemoveTag(Array.from(selectedPaperIds), tagId);
      showNotification(`Removed tag from ${result.removed} paper(s)`);
      exitSelectMode();
      await onRefresh();
    } catch {
      showNotification('Failed to remove tag');
    } finally {
      setBulkLoading(false);
      setBulkAction(null);
    }
  }

  async function handleBibtexImport() {
    if (!bibtexText.trim()) {
      showNotification('Paste or load a BibTeX file first');
      return;
    }
    setBibtexImporting(true);
    try {
      const result = await api.importBibtex(bibtexText);
      const parts: string[] = [];
      parts.push(`${result.papers_added} added`);
      if (result.papers_skipped > 0) parts.push(`${result.papers_skipped} already in library`);
      if (result.tags_applied > 0) parts.push(`${result.tags_applied} tag assignments`);
      if (result.comments_added > 0) parts.push(`${result.comments_added} comments restored`);
      if (result.errors.length > 0) parts.push(`${result.errors.length} errors`);
      showNotification(`BibTeX import: ${parts.join(', ')}`);
      if (result.errors.length > 0) {
        console.warn('BibTeX import errors:', result.errors);
      }
      setBibtexText('');
      setShowBibtexImport(false);
      await onRefresh();
    } catch (err: any) {
      showNotification(err.message || 'BibTeX import failed');
    } finally {
      setBibtexImporting(false);
    }
  }

  function handleBibtexFileLoad(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setBibtexText(reader.result as string);
    };
    reader.readAsText(file);
    e.target.value = '';
  }

  async function handlePdfUpload() {
    if (!uploadFile || !uploadTitle.trim()) {
      showNotification('PDF file and title are required');
      return;
    }
    const authors = uploadAuthors.split(',').map(a => a.trim()).filter(a => a.length > 0);
    if (authors.length === 0) {
      showNotification('At least one author is required');
      return;
    }
    setUploading(true);
    try {
      await api.uploadPaper(uploadFile, {
        title: uploadTitle.trim(),
        authors,
        summary: uploadSummary.trim() || undefined,
      });
      showNotification('Paper uploaded successfully');
      setUploadFile(null);
      setUploadTitle('');
      setUploadAuthors('');
      setUploadSummary('');
      setShowPdfUpload(false);
      await onRefresh();
    } catch (err: any) {
      showNotification(err.message || 'Failed to upload paper');
    } finally {
      setUploading(false);
    }
  }

  const hasActiveFilters = filterStatus !== '' || filterTag !== null || filterWorldline !== null || searchTerm !== '';


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
          <h4 className="sidebar-section-title">Tags</h4>
          {tags.length > 0 && (
            <button
              className={`sidebar-item${filterTag === null ? ' active' : ''}`}
              onClick={() => setFilterTag(null)}
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
                  onClick={() => setFilterTag(filterTag === tag.id ? null : tag.id)}
                  onContextMenu={e => {
                    e.preventDefault();
                    setTagContextMenu({ x: e.clientX, y: e.clientY, tag });
                  }}
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
              <input
                type="color"
                className="sidebar-color-input"
                value={newTagColor}
                onChange={e => setNewTagColor(e.target.value)}
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
              <input
                type="text"
                placeholder="Filter papers by title or author..."
                value={searchTerm}
                onChange={e => setSearchTerm(e.target.value)}
                className="search-input"
              />
            </div>

            <div className="control-group">
              <select
                value={filterStatus}
                onChange={e => setFilterStatus(e.target.value)}
              >
                <option value="">All Statuses</option>
                {Object.entries(STATUS_LABELS).map(([key, label]) => (
                  <option key={key} value={key}>{label}</option>
                ))}
              </select>
            </div>

            <div className="control-group">
              <button
                className={`btn btn-sm ${selectMode ? 'btn-primary' : 'btn-secondary'}`}
                onClick={toggleSelectMode}
              >
                {selectMode ? `Done (${selectedPaperIds.size})` : 'Select'}
              </button>
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
                  className={`btn btn-sm ${showBatchImport ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => setShowBatchImport(!showBatchImport)}
                >
                  Batch Import
                </button>
              </div>

              <div className="control-group">
                <button
                  className={`btn btn-sm ${showBibtexImport ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => setShowBibtexImport(!showBibtexImport)}
                >
                  Import BibTeX
                </button>
              </div>

              <div className="control-group">
                <button
                  className={`btn btn-sm ${showPdfUpload ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => setShowPdfUpload(!showPdfUpload)}
                >
                  Upload PDF
                </button>
              </div>

              <div className="control-group">
                <button className="btn btn-primary btn-sm" onClick={handleExportAll}>
                  {hasActiveFilters ? `Export ${filteredPapers.length} (BibTeX)` : 'Export All (BibTeX)'}
                </button>
              </div>
            </div>
          </div>
        </div>

        {showBatchImport && (
          <BatchImportPanel
            tags={tags}
            showNotification={showNotification}
            onImportComplete={onRefresh}
          />
        )}

        {showBibtexImport && (
          <div className="batch-import-section">
            <h3>Import BibTeX</h3>
            <p className="batch-import-hint">
              Paste BibTeX entries below or load a .bib file. Papers with ArXiv eprint fields will be imported into your library with their tags and comments preserved.
            </p>
            <div className="batch-import-body">
              <div className="batch-import-left" style={{ flex: 1 }}>
                <textarea
                  className="batch-import-textarea"
                  placeholder={"@article{key,\n  author = {Author Name},\n  title = {Paper Title},\n  eprint = {2301.00001},\n  ...\n}"}
                  value={bibtexText}
                  onChange={e => setBibtexText(e.target.value)}
                  rows={8}
                  disabled={bibtexImporting}
                />
              </div>
              <div className="batch-import-right">
                <label className="btn btn-secondary btn-sm" style={{ cursor: 'pointer', display: 'inline-block' }}>
                  Load .bib File
                  <input
                    type="file"
                    accept=".bib,.bibtex,text/plain"
                    onChange={handleBibtexFileLoad}
                    style={{ display: 'none' }}
                    disabled={bibtexImporting}
                  />
                </label>
                <button
                  className="btn btn-primary batch-import-submit"
                  onClick={handleBibtexImport}
                  disabled={bibtexImporting || !bibtexText.trim()}
                >
                  {bibtexImporting ? 'Importing...' : 'Import'}
                </button>
              </div>
            </div>
          </div>
        )}

        {showPdfUpload && (
          <div className="batch-import-section">
            <h3>Upload PDF</h3>
            <p className="batch-import-hint">
              Upload a PDF file as an external reference. It will be added to your library and can be tagged, commented on, added to worldlines, and chatted about.
            </p>
            <div className="batch-import-body" style={{ flexDirection: 'column', gap: '0.5rem' }}>
              <label className="btn btn-secondary btn-sm" style={{ cursor: 'pointer', display: 'inline-block', alignSelf: 'flex-start' }}>
                {uploadFile ? uploadFile.name : 'Choose PDF File'}
                <input
                  type="file"
                  accept=".pdf,application/pdf"
                  onChange={e => setUploadFile(e.target.files?.[0] || null)}
                  style={{ display: 'none' }}
                  disabled={uploading}
                />
              </label>
              <input
                type="text"
                placeholder="Title (required)"
                value={uploadTitle}
                onChange={e => setUploadTitle(e.target.value)}
                disabled={uploading}
                style={{ width: '100%' }}
              />
              <input
                type="text"
                placeholder="Authors (comma-separated, required)"
                value={uploadAuthors}
                onChange={e => setUploadAuthors(e.target.value)}
                disabled={uploading}
                style={{ width: '100%' }}
              />
              <textarea
                placeholder="Abstract / summary (optional)"
                value={uploadSummary}
                onChange={e => setUploadSummary(e.target.value)}
                rows={3}
                disabled={uploading}
                style={{ width: '100%' }}
              />
              <button
                className="btn btn-primary btn-sm"
                onClick={handlePdfUpload}
                disabled={uploading || !uploadFile || !uploadTitle.trim() || !uploadAuthors.trim()}
                style={{ alignSelf: 'flex-start' }}
              >
                {uploading ? 'Uploading...' : 'Upload'}
              </button>
            </div>
          </div>
        )}

        {/* Bulk operations toolbar */}
        {selectMode && selectedPaperIds.size > 0 && (
          <div className="bulk-toolbar">
            <span className="bulk-count">{selectedPaperIds.size} selected</span>
            <button className="btn btn-secondary btn-sm" onClick={selectAll} disabled={bulkLoading}>
              Select All ({filteredPapers.length})
            </button>
            <button className="btn btn-secondary btn-sm" onClick={selectNone} disabled={bulkLoading}>
              Deselect All
            </button>
            <span className="bulk-separator" />
            <button className="btn btn-primary btn-sm" onClick={handleBulkDownloadPdfs} disabled={bulkLoading}>
              Download PDFs
            </button>
            <button className="btn btn-secondary btn-sm" onClick={handleBulkDeletePdfs} disabled={bulkLoading}>
              Delete PDFs
            </button>
            <select
              onChange={e => { if (e.target.value) handleBulkStatusChange(e.target.value); e.target.value = ''; }}
              defaultValue=""
              disabled={bulkLoading}
            >
              <option value="">Set Status...</option>
              {Object.entries(STATUS_LABELS).map(([key, label]) => (
                <option key={key} value={key}>{label}</option>
              ))}
            </select>
            <select
              onChange={e => { if (e.target.value) handleBulkAddTag(parseInt(e.target.value, 10)); e.target.value = ''; }}
              defaultValue=""
              disabled={bulkLoading}
            >
              <option value="">Add Tag...</option>
              {tags.map(tag => (
                <option key={tag.id} value={tag.id}>{tag.name}</option>
              ))}
            </select>
            <select
              onChange={e => { if (e.target.value) handleBulkRemoveTag(parseInt(e.target.value, 10)); e.target.value = ''; }}
              defaultValue=""
              disabled={bulkLoading}
            >
              <option value="">Remove Tag...</option>
              {tags.map(tag => (
                <option key={tag.id} value={tag.id}>{tag.name}</option>
              ))}
            </select>
            <button className="btn btn-primary btn-sm" onClick={handleBulkSendToScribe} disabled={bulkLoading}>
              Send to Scribe
            </button>
            <button className="btn btn-danger btn-sm" onClick={handleBulkDelete} disabled={bulkLoading}>
              Delete Papers
            </button>
            {bulkLoading && <span className="bulk-status">{bulkAction}...</span>}
          </div>
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
              const categories = JSON.parse(paper.categories) as string[];

              return (
                <div
                  key={paper.id}
                  className={`paper-card library-card${selectedPaperIds.has(paper.id) ? ' selected' : ''}`}
                  onClick={e => handleCardClick(paper, e)}
                >
                  <div className="paper-card-header">
                    <div className="paper-select-title">
                      {selectMode && (
                        <input
                          type="checkbox"
                          checked={selectedPaperIds.has(paper.id)}
                          onChange={() => toggleSelection(paper.id)}
                          className="paper-checkbox"
                          onClick={e => e.stopPropagation()}
                        />
                      )}
                      <h3 className="paper-title">
                        <LaTeX>{paper.title}</LaTeX>
                      </h3>
                    </div>
                    <div className="paper-actions">
                      <select
                        value={paper.status}
                        onChange={e => handleStatusChange(paper, e.target.value)}
                        className="status-select"
                        style={{ borderColor: STATUS_COLORS[paper.status] }}
                        onClick={e => e.stopPropagation()}
                      >
                        {Object.entries(STATUS_LABELS).map(([key, label]) => (
                          <option key={key} value={key}>{label}</option>
                        ))}
                      </select>
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
                    <span className="paper-date">
                      Added {new Date(paper.added_at).toLocaleDateString()}
                    </span>
                    <span className="paper-categories">
                      {paper.arxiv_id.startsWith('upload-') ? (
                        <span className="category-badge" style={{ backgroundColor: '#8b5cf6' }}>Uploaded</span>
                      ) : categories.slice(0, 3).map(c => (
                        <span key={c} className={`category-badge cat-${c.includes('.') ? c.split('.')[0] : c}`}>{c}</span>
                      ))}
                    </span>
                    <span
                      className="status-badge"
                      style={{ backgroundColor: STATUS_COLORS[paper.status] }}
                    >
                      {STATUS_LABELS[paper.status]}
                    </span>
                    <span className={`pdf-badge ${paper.pdf_path ? 'pdf-badge-local' : 'pdf-badge-none'}`}>
                      {paper.pdf_path ? 'PDF' : 'No PDF'}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

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
