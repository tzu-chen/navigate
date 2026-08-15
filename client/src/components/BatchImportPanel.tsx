import { useState, useEffect } from 'react';
import { Tag, Worldline } from '../types';
import * as api from '../services/api';
import { DEFAULT_ENTITY_COLOR } from '../palette';

interface Props {
  tags: Tag[];
  showNotification: (msg: string) => void;
  onImportComplete: () => Promise<void>;
  compact?: boolean;
}

export default function BatchImportPanel({ tags, showNotification, onImportComplete, compact = false }: Props) {
  const [importArxivIds, setImportArxivIds] = useState('');
  const [importSelectedTagIds, setImportSelectedTagIds] = useState<Set<number>>(new Set());
  const [allTags, setAllTags] = useState<Tag[]>(tags);
  const [newTagName, setNewTagName] = useState('');
  const [newTagColor, setNewTagColor] = useState(DEFAULT_ENTITY_COLOR);
  const [selectedWorldlineIds, setSelectedWorldlineIds] = useState<Set<number>>(new Set());
  const [newWorldlines, setNewWorldlines] = useState<Array<{ name: string; color: string }>>([]);
  const [newWlName, setNewWlName] = useState('');
  const [newWlColor, setNewWlColor] = useState(DEFAULT_ENTITY_COLOR);
  const [importLoading, setImportLoading] = useState(false);
  const [importStatus, setImportStatus] = useState<string | null>(null);
  const [worldlines, setWorldlines] = useState<Worldline[]>([]);

  useEffect(() => { setAllTags(tags); }, [tags]);

  useEffect(() => {
    api.getWorldlines().then(setWorldlines).catch(() => {});
  }, []);

  function toggleImportTag(tagId: number) {
    setImportSelectedTagIds(prev => {
      const next = new Set(prev);
      if (next.has(tagId)) next.delete(tagId);
      else next.add(tagId);
      return next;
    });
  }

  function toggleWorldline(wlId: number) {
    setSelectedWorldlineIds(prev => {
      const next = new Set(prev);
      if (next.has(wlId)) next.delete(wlId);
      else next.add(wlId);
      return next;
    });
  }

  async function handleCreateTag() {
    if (!newTagName.trim()) return;
    try {
      const tag = await api.createTag(newTagName.trim(), newTagColor);
      setAllTags(prev => [...prev, tag]);
      setImportSelectedTagIds(prev => new Set([...prev, tag.id]));
      setNewTagName('');
      showNotification(`Tag "${tag.name}" created`);
    } catch (err: any) {
      showNotification(err.message || 'Failed to create tag');
    }
  }

  function addNewWorldline() {
    if (!newWlName.trim()) return;
    setNewWorldlines(prev => [...prev, { name: newWlName.trim(), color: newWlColor }]);
    setNewWlName('');
  }

  function removeNewWorldline(index: number) {
    setNewWorldlines(prev => prev.filter((_, i) => i !== index));
  }

  async function handleBatchImport() {
    const ids = importArxivIds
      .split(/[\n,]+/)
      .map(s => s.trim())
      .filter(s => s.length > 0);
    if (ids.length === 0) {
      showNotification('Enter at least one ArXiv ID');
      return;
    }
    setImportLoading(true);
    setImportStatus(`Importing ${ids.length} papers...`);
    try {
      const options: Parameters<typeof api.batchImport>[1] = {};

      if (selectedWorldlineIds.size > 0) {
        options.worldlineIds = Array.from(selectedWorldlineIds);
      }
      if (newWorldlines.length > 0) {
        options.newWorldlines = newWorldlines;
      }

      if (importSelectedTagIds.size > 0) {
        options.tagIds = Array.from(importSelectedTagIds);
      }

      const result = await api.batchImport(ids, options);
      const parts: string[] = [];
      parts.push(`${result.papers_added} papers added`);
      if (result.tags_applied > 0) parts.push(`${result.tags_applied} tag assignments`);
      if (result.errors.length > 0) parts.push(`${result.errors.length} errors`);
      setImportStatus(`Done: ${parts.join(', ')}`);

      if (result.errors.length > 0) {
        showNotification(`Import finished with errors: ${result.errors.join('; ')}`);
      } else {
        showNotification(`Imported ${result.papers_added} papers`);
      }
      setImportArxivIds('');
      setSelectedWorldlineIds(new Set());
      setNewWorldlines([]);
      setImportSelectedTagIds(new Set());
      // Refresh worldlines list since new ones may have been created
      api.getWorldlines().then(setWorldlines).catch(() => {});
      await onImportComplete();
    } catch (err: any) {
      setImportStatus(null);
      showNotification(err.message || 'Batch import failed');
    } finally {
      setImportLoading(false);
    }
  }

  return (
    <div className={`batch-import-section ${compact ? 'batch-import-compact' : ''}`}>
      {!compact && <h3>Batch Import</h3>}
      <p className="batch-import-hint">
        Paste ArXiv IDs (one per line or comma-separated). Papers will be saved to the library.
      </p>
      <div className={`batch-import-body ${compact ? 'batch-import-body-vertical' : ''}`}>
        <div className="batch-import-left">
          <textarea
            className="batch-import-textarea"
            placeholder={"2301.00001\n2302.12345\n2303.54321"}
            value={importArxivIds}
            onChange={e => setImportArxivIds(e.target.value)}
            rows={compact ? 4 : 5}
            disabled={importLoading}
          />
        </div>
        <div className="batch-import-right">
          <div className="batch-import-group">
            <label className="batch-import-label">Tags</label>

            {importSelectedTagIds.size > 0 && (
              <div className="tag-chip-list">
                {allTags.filter(t => importSelectedTagIds.has(t.id)).map(tag => (
                  <span key={tag.id} className="tag-chip" style={{ backgroundColor: tag.color }}>
                    {tag.name}
                    <button
                      className="tag-chip-remove"
                      onClick={() => toggleImportTag(tag.id)}
                      title="Remove tag"
                      disabled={importLoading}
                    >
                      &times;
                    </button>
                  </span>
                ))}
              </div>
            )}

            {allTags.filter(t => !importSelectedTagIds.has(t.id)).length > 0 && (
              <div className="tag-chip-list">
                {allTags.filter(t => !importSelectedTagIds.has(t.id)).map(tag => (
                  <span
                    key={tag.id}
                    className="tag-chip tag-chip-add"
                    style={{ borderColor: tag.color, color: tag.color }}
                    onClick={() => !importLoading && toggleImportTag(tag.id)}
                    title="Click to add"
                  >
                    + {tag.name}
                  </span>
                ))}
              </div>
            )}

            <div className="tag-create-form">
              <input
                type="text"
                placeholder="Tag name"
                value={newTagName}
                onChange={e => setNewTagName(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleCreateTag()}
                disabled={importLoading}
              />
              <input
                type="color"
                value={newTagColor}
                onChange={e => setNewTagColor(e.target.value)}
                disabled={importLoading}
              />
              <button
                className="btn btn-primary btn-sm"
                onClick={handleCreateTag}
                disabled={!newTagName.trim() || importLoading}
              >
                Add
              </button>
            </div>
          </div>

          <div className="batch-import-group">
            <label className="batch-import-label">Worldlines</label>

            {(selectedWorldlineIds.size > 0 || newWorldlines.length > 0) && (
              <div className="tag-chip-list">
                {worldlines.filter(wl => selectedWorldlineIds.has(wl.id)).map(wl => (
                  <span key={wl.id} className="tag-chip" style={{ backgroundColor: wl.color }}>
                    {wl.name}
                    <button
                      className="tag-chip-remove"
                      onClick={() => toggleWorldline(wl.id)}
                      title="Remove from import"
                      disabled={importLoading}
                    >
                      &times;
                    </button>
                  </span>
                ))}
                {newWorldlines.map((nw, idx) => (
                  <span key={`new-${idx}`} className="tag-chip" style={{ backgroundColor: nw.color }}>
                    {nw.name} <span className="muted-inline">(new)</span>
                    <button
                      className="tag-chip-remove"
                      onClick={() => removeNewWorldline(idx)}
                      title="Remove new worldline"
                      disabled={importLoading}
                    >
                      &times;
                    </button>
                  </span>
                ))}
              </div>
            )}

            {worldlines.filter(wl => !selectedWorldlineIds.has(wl.id)).length > 0 && (
              <div className="tag-chip-list">
                {worldlines.filter(wl => !selectedWorldlineIds.has(wl.id)).map(wl => (
                  <span
                    key={wl.id}
                    className="tag-chip tag-chip-add"
                    style={{ borderColor: wl.color, color: wl.color }}
                    onClick={() => !importLoading && toggleWorldline(wl.id)}
                    title="Click to add"
                  >
                    + {wl.name}
                  </span>
                ))}
              </div>
            )}

            <div className="tag-create-form">
              <input
                type="text"
                placeholder="Worldline name"
                value={newWlName}
                onChange={e => setNewWlName(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && addNewWorldline()}
                disabled={importLoading}
              />
              <input
                type="color"
                value={newWlColor}
                onChange={e => setNewWlColor(e.target.value)}
                disabled={importLoading}
              />
              <button
                className="btn btn-primary btn-sm"
                onClick={addNewWorldline}
                disabled={!newWlName.trim() || importLoading}
              >
                Add
              </button>
            </div>
          </div>

          <button
            className="btn btn-primary batch-import-submit"
            onClick={handleBatchImport}
            disabled={importLoading || !importArxivIds.trim()}
          >
            {importLoading ? 'Importing...' : 'Import Papers'}
          </button>
          {importStatus && (
            <div className="batch-import-status">{importStatus}</div>
          )}
        </div>
      </div>
    </div>
  );
}
