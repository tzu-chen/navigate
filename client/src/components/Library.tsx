import { useState, useEffect } from 'react';
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
  const [showTagManager, setShowTagManager] = useState(false);
  const [taggedPaperIds, setTaggedPaperIds] = useState<Set<number> | null>(null);
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

  // Load worldlines for filter row
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

  // Clear selection when filters change
  useEffect(() => {
    setSelectedPaperIds(new Set());
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

  // Individual paper handlers
  async function handleDelete(paper: SavedPaper) {
    if (!confirm(`Delete "${paper.title}" from your library?`)) return;
    try {
      await api.deletePaper(paper.id);
      showNotification('Paper deleted');
      await onRefresh();
    } catch {
      showNotification('Failed to delete paper');
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

  async function handleCreateTag() {
    if (!newTagName.trim()) return;
    try {
      await api.createTag(newTagName.trim(), newTagColor);
      setNewTagName('');
      showNotification(`Tag "${newTagName}" created`);
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
      setSelectedPaperIds(new Set());
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
      setSelectedPaperIds(new Set());
      await onRefresh();
    } catch {
      showNotification('Failed to delete PDFs');
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
      setSelectedPaperIds(new Set());
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
      setSelectedPaperIds(new Set());
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
      setSelectedPaperIds(new Set());
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
      setSelectedPaperIds(new Set());
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
                className="btn btn-secondary btn-sm"
                onClick={() => setShowTagManager(!showTagManager)}
              >
                Manage Tags
              </button>
            </div>

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

        {tags.length > 0 && (
          <div className="tag-filter-row">
            <button
              className={`tag-filter-btn ${!filterTag ? 'active' : ''}`}
              onClick={() => setFilterTag(null)}
            >
              All
            </button>
            {tags.map(tag => (
              <button
                key={tag.id}
                className={`tag-filter-btn ${filterTag === tag.id ? 'active' : ''}`}
                style={{ borderColor: tag.color, color: filterTag === tag.id ? '#fff' : tag.color, backgroundColor: filterTag === tag.id ? tag.color : 'transparent' }}
                onClick={() => setFilterTag(filterTag === tag.id ? null : tag.id)}
              >
                {tag.name}
              </button>
            ))}
          </div>
        )}

        {filterWorldlines.length > 0 && (
          <div className="tag-filter-row">
            <span className="filter-row-label">Worldline:</span>
            <button
              className={`tag-filter-btn ${!filterWorldline ? 'active' : ''}`}
              onClick={() => setFilterWorldline(null)}
            >
              All
            </button>
            {filterWorldlines.map(wl => (
              <button
                key={wl.id}
                className={`tag-filter-btn ${filterWorldline === wl.id ? 'active' : ''}`}
                style={{ borderColor: wl.color, color: filterWorldline === wl.id ? '#fff' : wl.color, backgroundColor: filterWorldline === wl.id ? wl.color : 'transparent' }}
                onClick={() => setFilterWorldline(filterWorldline === wl.id ? null : wl.id)}
              >
                {wl.name}
              </button>
            ))}
          </div>
        )}
      </div>

      {showTagManager && (
        <div className="tag-manager">
          <h3>Tags</h3>
          <div className="tag-create-row">
            <input
              type="text"
              placeholder="New tag name"
              value={newTagName}
              onChange={e => setNewTagName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleCreateTag()}
            />
            <input
              type="color"
              value={newTagColor}
              onChange={e => setNewTagColor(e.target.value)}
            />
            <button className="btn btn-primary btn-sm" onClick={handleCreateTag}>
              Add Tag
            </button>
          </div>
          <div className="tag-list">
            {tags.map(tag => (
              <div key={tag.id} className="tag-item">
                <span className="tag-badge" style={{ backgroundColor: tag.color }}>
                  {tag.name}
                </span>
                <button
                  className="btn-icon btn-danger-icon"
                  onClick={() => handleDeleteTag(tag)}
                  title="Delete tag"
                >
                  &times;
                </button>
              </div>
            ))}
            {tags.length === 0 && <p className="muted">No tags yet. Create one above.</p>}
          </div>
        </div>
      )}

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
      {selectedPaperIds.size > 0 && (
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
              <div key={paper.id} className={`paper-card library-card${selectedPaperIds.has(paper.id) ? ' selected' : ''}`}>
                <div className="paper-card-header">
                  <div className="paper-select-title">
                    <input
                      type="checkbox"
                      checked={selectedPaperIds.has(paper.id)}
                      onChange={() => toggleSelection(paper.id)}
                      className="paper-checkbox"
                    />
                    <h3 className="paper-title" onClick={() => onOpenPaper(paper)}>
                      <LaTeX>{paper.title}</LaTeX>
                    </h3>
                  </div>
                  <div className="paper-actions">
                    <select
                      value={paper.status}
                      onChange={e => handleStatusChange(paper, e.target.value)}
                      className="status-select"
                      style={{ borderColor: STATUS_COLORS[paper.status] }}
                    >
                      {Object.entries(STATUS_LABELS).map(([key, label]) => (
                        <option key={key} value={key}>{label}</option>
                      ))}
                    </select>
                    <button
                      className="btn btn-primary btn-sm"
                      onClick={() => onOpenPaper(paper)}
                    >
                      View
                    </button>
                    <button
                      className="btn btn-danger btn-sm"
                      onClick={() => handleDelete(paper)}
                    >
                      Delete
                    </button>
                  </div>
                </div>

                <div className="paper-meta">
                  <span className="paper-authors">
                    {authors.slice(0, 3).map((author, i) => (
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
  );
}
