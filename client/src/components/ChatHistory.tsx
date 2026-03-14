import { useState, useEffect } from 'react';
import Markdown from 'react-markdown';
import { ChatSession, SavedPaper } from '../types';
import * as api from '../services/api';
import LaTeX from './LaTeX';

interface Props {
  savedPapers: SavedPaper[];
  onOpenPaper: (paper: SavedPaper) => void;
  showNotification: (msg: string) => void;
}

export default function ChatHistory({ savedPapers, onOpenPaper, showNotification }: Props) {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  const loadSessions = async () => {
    const all = await api.getAllChatSessions();
    setSessions(all);
  };

  useEffect(() => {
    loadSessions();
  }, []);

  const handleDelete = async (sessionId: string) => {
    await api.deleteChatSession(sessionId);
    await loadSessions();
    if (expandedId === sessionId) setExpandedId(null);
    showNotification('Chat session deleted');
  };

  const handleDeleteAllForPaper = async (arxivId: string) => {
    await api.deleteAllChatSessionsForPaper(arxivId);
    await loadSessions();
    setExpandedId(null);
    showNotification('All chat sessions for this paper deleted');
  };

  const handleOpenPaper = (arxivId: string) => {
    const paper = savedPapers.find(p => p.arxiv_id === arxivId);
    if (paper) {
      onOpenPaper(paper);
    } else {
      showNotification('Paper not found in library');
    }
  };

  const filtered = sessions.filter(s => {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    if (s.paperTitle.toLowerCase().includes(q)) return true;
    return s.messages.some(m => m.content.toLowerCase().includes(q));
  });

  // Group by paper
  const grouped = new Map<string, { title: string; sessions: ChatSession[] }>();
  for (const s of filtered) {
    if (!grouped.has(s.arxivId)) {
      grouped.set(s.arxivId, { title: s.paperTitle, sessions: [] });
    }
    grouped.get(s.arxivId)!.sessions.push(s);
  }

  const firstUserMsg = (s: ChatSession) => {
    const first = s.messages.find(m => m.role === 'user');
    return first ? first.content.slice(0, 80) + (first.content.length > 80 ? '...' : '') : 'Empty session';
  };

  return (
    <div className="chat-history">
      <div className="chat-history-header">
        <h2>Chat History</h2>
        <p className="text-muted">
          {sessions.length} conversation{sessions.length !== 1 ? 's' : ''} across {grouped.size} paper{grouped.size !== 1 ? 's' : ''}
        </p>
      </div>

      <div className="chat-history-search">
        <input
          type="text"
          placeholder="Search conversations..."
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          className="search-input"
        />
      </div>

      {filtered.length === 0 && (
        <div className="chat-history-empty">
          {sessions.length === 0
            ? 'No chat sessions yet. Open a paper and use the Chat tab to start a conversation with Claude.'
            : 'No conversations match your search.'}
        </div>
      )}

      <div className="chat-history-groups">
        {Array.from(grouped.entries()).map(([arxivId, group]) => (
          <div key={arxivId} className="chat-history-group">
            <div className="chat-history-group-header">
              <div className="chat-history-group-title">
                <h3><LaTeX>{group.title}</LaTeX></h3>
                <span className="text-muted">{arxivId} &middot; {group.sessions.length} session{group.sessions.length !== 1 ? 's' : ''}</span>
              </div>
              <div className="chat-history-group-actions">
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={() => handleOpenPaper(arxivId)}
                >
                  Open Paper
                </button>
                <button
                  className="btn btn-danger btn-sm"
                  onClick={() => handleDeleteAllForPaper(arxivId)}
                >
                  Delete All
                </button>
              </div>
            </div>

            <div className="chat-history-sessions">
              {group.sessions.map(session => (
                <div key={session.id} className="chat-history-session">
                  <div
                    className="chat-history-session-header"
                    onClick={() => setExpandedId(expandedId === session.id ? null : session.id)}
                  >
                    <div className="chat-history-session-info">
                      <span className="chat-history-session-preview">
                        {expandedId === session.id ? '▼' : '▶'} {firstUserMsg(session)}
                      </span>
                      <span className="chat-history-session-meta">
                        {new Date(session.updatedAt).toLocaleDateString()}{' '}
                        {new Date(session.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        {' '}&middot; {session.messages.length} messages
                      </span>
                    </div>
                    <button
                      className="chat-session-delete"
                      onClick={e => { e.stopPropagation(); handleDelete(session.id); }}
                      title="Delete this session"
                    >
                      &times;
                    </button>
                  </div>

                  {expandedId === session.id && (
                    <div className="chat-history-session-messages">
                      {session.messages.map((msg, i) => (
                        <div key={i} className={`chat-message chat-message-${msg.role}`}>
                          <div className="chat-message-label">
                            {msg.role === 'user' ? 'You' : 'Claude'}
                          </div>
                          <div className={`chat-message-content ${msg.role === 'assistant' ? 'markdown-body' : ''}`}>
                            {msg.role === 'assistant' ? (
                              <Markdown>{msg.content}</Markdown>
                            ) : (
                              msg.content
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
