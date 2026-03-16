import { useState } from 'react';
import { Comment } from '../types';
import * as api from '../services/api';
import Icon from './Icon';

interface Props {
  paperId: number;
  comments: Comment[];
  currentPage: number;
  onPageChange: (page: number) => void;
  onRefresh: () => Promise<void>;
  showNotification: (msg: string) => void;
}

export default function CommentPanel({ paperId, comments, currentPage, onPageChange, onRefresh, showNotification }: Props) {
  const [newComment, setNewComment] = useState('');
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editContent, setEditContent] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function handleAdd() {
    if (!newComment.trim()) return;
    setSubmitting(true);
    try {
      await api.addComment(
        paperId,
        newComment.trim(),
        currentPage
      );
      setNewComment('');
      await onRefresh();
      showNotification('Comment added');
    } catch {
      showNotification('Failed to add comment');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleUpdate(commentId: number) {
    if (!editContent.trim()) return;
    try {
      await api.updateComment(paperId, commentId, editContent.trim());
      setEditingId(null);
      setEditContent('');
      await onRefresh();
      showNotification('Comment updated');
    } catch {
      showNotification('Failed to update comment');
    }
  }

  async function handleDelete(commentId: number) {
    if (!confirm('Delete this comment?')) return;
    try {
      await api.deleteComment(paperId, commentId);
      await onRefresh();
      showNotification('Comment deleted');
    } catch {
      showNotification('Failed to delete comment');
    }
  }

  function startEdit(comment: Comment) {
    setEditingId(comment.id);
    setEditContent(comment.content);
  }

  return (
    <div className="comment-panel">
      <div className="comment-input-section">
        <textarea
          placeholder="Add a comment..."
          value={newComment}
          onChange={e => setNewComment(e.target.value)}
          rows={3}
          onKeyDown={e => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleAdd();
          }}
        />
        <div className="comment-input-controls">
          <label className="comment-page-label">
            Page
            <input
              type="number"
              min="1"
              value={currentPage}
              onChange={e => {
                const num = parseInt(e.target.value, 10);
                if (!isNaN(num) && num > 0) onPageChange(num);
              }}
              className="comment-page-input"
            />
          </label>
          <button
            className="btn btn-primary btn-sm"
            onClick={handleAdd}
            disabled={submitting || !newComment.trim()}
          >
            {submitting ? 'Adding...' : 'Add Comment'}
          </button>
        </div>
      </div>

      <div className="comment-list">
        {comments.length === 0 && (
          <p className="muted">No comments yet. Add one above.</p>
        )}
        {comments.map(comment => (
          <div key={comment.id} className="comment-item">
            {editingId === comment.id ? (
              <div className="comment-edit">
                <textarea
                  value={editContent}
                  onChange={e => setEditContent(e.target.value)}
                  rows={3}
                  autoFocus
                />
                <div className="comment-edit-actions">
                  <button className="btn btn-primary btn-sm" onClick={() => handleUpdate(comment.id)}>
                    Save
                  </button>
                  <button className="btn btn-secondary btn-sm" onClick={() => setEditingId(null)}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <>
                <div className="comment-content">{comment.content}</div>
                <div className="comment-meta">
                  {comment.page_number && (
                    <span className="comment-page">Page {comment.page_number}</span>
                  )}
                  <span className="comment-date">
                    {new Date(comment.created_at).toLocaleString()}
                  </span>
                  <div className="comment-actions">
                    <button className="btn-icon" onClick={() => startEdit(comment)} title="Edit">
                      <Icon name="pencil" />
                    </button>
                    <button className="btn-icon btn-danger-icon" onClick={() => handleDelete(comment.id)} title="Delete">
                      &times;
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
