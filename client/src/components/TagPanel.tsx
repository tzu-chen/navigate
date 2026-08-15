import { useState } from 'react';
import { Tag } from '../types';
import * as api from '../services/api';
import { DEFAULT_ENTITY_COLOR } from '../palette';

interface Props {
  paperId: number;
  paperTags: Tag[];
  allTags: Tag[];
  onRefresh: () => Promise<void>;
  showNotification: (msg: string) => void;
}

export default function TagPanel({ paperId, paperTags, allTags, onRefresh, showNotification }: Props) {
  const [newTagName, setNewTagName] = useState('');
  const [newTagColor, setNewTagColor] = useState(DEFAULT_ENTITY_COLOR);

  const paperTagIds = new Set(paperTags.map(t => t.id));
  const availableTags = allTags.filter(t => !paperTagIds.has(t.id));

  async function handleAddTag(tagId: number) {
    try {
      await api.addPaperTag(paperId, tagId);
      await onRefresh();
    } catch {
      showNotification('Failed to add tag');
    }
  }

  async function handleRemoveTag(tagId: number) {
    try {
      await api.removePaperTag(paperId, tagId);
      await onRefresh();
    } catch {
      showNotification('Failed to remove tag');
    }
  }

  async function handleCreateAndAdd() {
    if (!newTagName.trim()) return;
    try {
      const tag = await api.createTag(newTagName.trim(), newTagColor);
      await api.addPaperTag(paperId, tag.id);
      setNewTagName('');
      await onRefresh();
      showNotification(`Tag "${tag.name}" created and added`);
    } catch (err: any) {
      showNotification(err.message || 'Failed to create tag');
    }
  }

  return (
    <div className="tag-panel">
      <div className="tag-section">
        <h4>Paper Tags</h4>
        {paperTags.length === 0 ? (
          <p className="muted">No tags assigned to this paper.</p>
        ) : (
          <div className="tag-chip-list">
            {paperTags.map(tag => (
              <span key={tag.id} className="tag-chip" style={{ backgroundColor: tag.color }}>
                {tag.name}
                <button
                  className="tag-chip-remove"
                  onClick={() => handleRemoveTag(tag.id)}
                  title="Remove tag"
                >
                  &times;
                </button>
              </span>
            ))}
          </div>
        )}
      </div>

      {availableTags.length > 0 && (
        <div className="tag-section">
          <h4>Available Tags</h4>
          <div className="tag-chip-list">
            {availableTags.map(tag => (
              <span
                key={tag.id}
                className="tag-chip tag-chip-add"
                style={{ borderColor: tag.color, color: tag.color }}
                onClick={() => handleAddTag(tag.id)}
                title="Click to add"
              >
                + {tag.name}
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="tag-section">
        <h4>Create New Tag</h4>
        <div className="tag-create-form">
          <input
            type="text"
            placeholder="Tag name"
            value={newTagName}
            onChange={e => setNewTagName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleCreateAndAdd()}
          />
          <input
            type="color"
            value={newTagColor}
            onChange={e => setNewTagColor(e.target.value)}
          />
          <button
            className="btn btn-primary btn-sm"
            onClick={handleCreateAndAdd}
            disabled={!newTagName.trim()}
          >
            Create &amp; Add
          </button>
        </div>
      </div>
    </div>
  );
}
