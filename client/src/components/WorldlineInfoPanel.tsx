import { useState, useEffect } from 'react';
import { Worldline } from '../types';
import * as api from '../services/api';
import { DEFAULT_ENTITY_COLOR } from '../palette';

interface Props {
  paperId: number;
  showNotification: (msg: string) => void;
}

export default function WorldlineInfoPanel({ paperId, showNotification }: Props) {
  const [allWorldlines, setAllWorldlines] = useState<Worldline[]>([]);
  const [paperWorldlineIds, setPaperWorldlineIds] = useState<Set<number>>(new Set());
  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState(DEFAULT_ENTITY_COLOR);
  const [loading, setLoading] = useState(true);

  async function loadData() {
    try {
      const worldlines = await api.getWorldlines();
      setAllWorldlines(worldlines);

      const memberIds = new Set<number>();
      for (const wl of worldlines) {
        const papers = await api.getWorldlinePapers(wl.id);
        if (papers.some(p => p.id === paperId)) {
          memberIds.add(wl.id);
        }
      }
      setPaperWorldlineIds(memberIds);
    } catch {
      showNotification('Failed to load worldlines');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadData(); }, [paperId]);

  const paperWorldlines = allWorldlines.filter(wl => paperWorldlineIds.has(wl.id));
  const availableWorldlines = allWorldlines.filter(wl => !paperWorldlineIds.has(wl.id));

  async function handleAdd(worldlineId: number) {
    try {
      const papers = await api.getWorldlinePapers(worldlineId);
      await api.addWorldlinePaper(worldlineId, paperId, papers.length);
      await loadData();
    } catch {
      showNotification('Failed to add paper to worldline');
    }
  }

  async function handleRemove(worldlineId: number) {
    try {
      await api.removeWorldlinePaper(worldlineId, paperId);
      await loadData();
    } catch {
      showNotification('Failed to remove paper from worldline');
    }
  }

  async function handleCreateAndAdd() {
    if (!newName.trim()) return;
    try {
      const wl = await api.createWorldline(newName.trim(), newColor);
      await api.addWorldlinePaper(wl.id, paperId, 0);
      setNewName('');
      await loadData();
      showNotification(`Worldline "${wl.name}" created and paper added`);
    } catch (err: any) {
      showNotification(err.message || 'Failed to create worldline');
    }
  }

  if (loading) {
    return <div className="worldline-info-panel"><p className="muted">Loading worldlines…</p></div>;
  }

  return (
    <div className="worldline-info-panel">
      <div className="tag-section">
        <h4>Paper Worldlines</h4>
        {paperWorldlines.length === 0 ? (
          <p className="muted">Not in any worldline.</p>
        ) : (
          <div className="tag-chip-list">
            {paperWorldlines.map(wl => (
              <span key={wl.id} className="tag-chip" style={{ backgroundColor: wl.color }}>
                {wl.name}
                <button
                  className="tag-chip-remove"
                  onClick={() => handleRemove(wl.id)}
                  title="Remove from worldline"
                >
                  &times;
                </button>
              </span>
            ))}
          </div>
        )}
      </div>

      {availableWorldlines.length > 0 && (
        <div className="tag-section">
          <h4>Available Worldlines</h4>
          <div className="tag-chip-list">
            {availableWorldlines.map(wl => (
              <span
                key={wl.id}
                className="tag-chip tag-chip-add"
                style={{ borderColor: wl.color, color: wl.color }}
                onClick={() => handleAdd(wl.id)}
                title="Click to add"
              >
                + {wl.name}
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="tag-section">
        <h4>Create New Worldline</h4>
        <div className="tag-create-form">
          <input
            type="text"
            placeholder="Worldline name"
            value={newName}
            onChange={e => setNewName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleCreateAndAdd()}
          />
          <input
            type="color"
            value={newColor}
            onChange={e => setNewColor(e.target.value)}
          />
          <button
            className="btn btn-primary btn-sm"
            onClick={handleCreateAndAdd}
            disabled={!newName.trim()}
          >
            Create &amp; Add
          </button>
        </div>
      </div>
    </div>
  );
}
