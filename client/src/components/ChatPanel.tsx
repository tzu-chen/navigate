import { useState, useRef, useEffect, useCallback } from 'react';
import Markdown from 'react-markdown';
import { ChatBackendStatus, ChatMessage, ChatSession, ChatTurnMeta, SavedPaper } from '../types';
import * as api from '../services/api';

interface Props {
  paper: SavedPaper;
  showNotification: (msg: string) => void;
}

interface RelatedPaperSessions {
  arxivId: string;
  title: string;
  sessions: ChatSession[];
}

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/** Why this machine cannot answer a message, in the terms of the chosen backend. */
export function backendReadyMessage(status: ChatBackendStatus): string {
  if (status.backend === 'api') {
    return 'Claude API key not configured. Add it in Settings, or switch chat to the CLI backend.';
  }
  if (!status.cli.present) {
    return `The Claude Code CLI was not found (looked for "${status.cli.path}"). Install it, set CLAUDE_CLI_PATH, or switch chat to the API backend in Settings.`;
  }
  if (!status.auth.loggedIn) {
    return 'The Claude Code CLI is installed but not logged in. Run `claude auth login`, or switch chat to the API backend in Settings.';
  }
  return 'Chat is not ready.';
}

const CONTEXT_LABELS: Record<string, { label: string; title: string }> = {
  tex: {
    label: 'TeX source',
    title:
      "Reading the paper's LaTeX source: the author's macros, real equation labels and true section structure. Answers cite sections and labels, not page numbers — LaTeX has no pagination.",
  },
  pdf: {
    label: 'PDF',
    title:
      'Reading the PDF. No LaTeX source was available for this paper (a PDF-only submission, or an upload).',
  },
  abstract: {
    label: 'abstract only',
    title:
      'Neither the LaTeX source nor the PDF could be fetched, so the model has the title and abstract only. Answers will be shallow.',
  },
};

export default function ChatPanel({ paper, showNotification }: Props) {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [relatedPaperSessions, setRelatedPaperSessions] = useState<RelatedPaperSessions[]>([]);
  const [showRelatedSessions, setShowRelatedSessions] = useState(false);
  const [viewingRelatedSession, setViewingRelatedSession] = useState<{ session: ChatSession; paperTitle: string } | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [showSessionList, setShowSessionList] = useState(false);
  const [backendStatus, setBackendStatus] = useState<ChatBackendStatus | null>(null);
  /** The answer as it arrives, before the turn commits. */
  const [streamingText, setStreamingText] = useState('');
  const [turnMeta, setTurnMeta] = useState<ChatTurnMeta | null>(null);
  const abortRef = useRef<(() => void) | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const authors = JSON.parse(paper.authors) as string[];
  const categories = JSON.parse(paper.categories) as string[];

  const loadSessions = useCallback(async () => {
    const paperSessions = await api.getChatSessionsForPaper(paper.arxiv_id);
    setSessions(paperSessions);
    return paperSessions;
  }, [paper.arxiv_id]);

  // Load related paper sessions from papers in the same worldline
  const loadRelatedSessions = useCallback(async () => {
    try {
      const relatedPapers = await api.getRelatedPaperArxivIds(paper.arxiv_id);
      const results: RelatedPaperSessions[] = [];
      for (const rp of relatedPapers) {
        const rpSessions = await api.getChatSessionsForPaper(rp.arxivId);
        if (rpSessions.length > 0) {
          results.push({ arxivId: rp.arxivId, title: rp.title, sessions: rpSessions });
        }
      }
      setRelatedPaperSessions(results);
    } catch {
      // Silently fail — related sessions are supplementary
    }
  }, [paper.arxiv_id]);

  // Load sessions on mount; resume the most recent one if it exists
  useEffect(() => {
    (async () => {
      const paperSessions = await loadSessions();
      if (paperSessions.length > 0) {
        setActiveSessionId(paperSessions[0].id);
        setMessages(paperSessions[0].messages);
      }
      loadRelatedSessions();
      // On the `cli` backend there is no API key to check — what matters is
      // whether the binary is there and logged in. Both probes are local.
      api.getChatBackendStatus().then(setBackendStatus).catch(() => setBackendStatus(null));
    })();
  }, [loadSessions, loadRelatedSessions]);

  // A conversation left mid-answer should not keep a model call running.
  useEffect(() => () => abortRef.current?.(), []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingText]);

  /**
   * One turn.
   *
   * The transcript is no longer sent: the server holds the model session this
   * conversation is resuming and the paper it was primed with, so the request
   * is `{ sessionId, message }` and the server persists both messages itself.
   * Sending the transcript back would at best be ignored and at worst re-prime
   * a cached conversation at ~17x the price.
   */
  const handleSend = async () => {
    const trimmed = input.trim();
    if (!trimmed || loading) return;

    if (backendStatus && !backendStatus.ready) {
      showNotification(backendReadyMessage(backendStatus));
      return;
    }

    let currentSessionId = activeSessionId;
    if (!currentSessionId) {
      currentSessionId = generateId();
      setActiveSessionId(currentSessionId);
    }

    const userMessage: ChatMessage = { role: 'user', content: trimmed };
    const updatedMessages = [...messages, userMessage];
    setMessages(updatedMessages);
    setInput('');
    setLoading(true);
    setStreamingText('');
    setTurnMeta(null);

    await new Promise<void>(resolve => {
      abortRef.current = api.streamChatMessage(
        currentSessionId!,
        trimmed,
        {
          title: paper.title,
          summary: paper.summary,
          authors,
          categories,
          arxivId: paper.arxiv_id,
        },
        {
          onMeta: meta => setTurnMeta(meta),
          onDelta: text => setStreamingText(prev => prev + text),
          onDone: result => {
            setTurnMeta(result);
            setMessages([
              ...updatedMessages,
              { role: 'assistant', content: result.message, usage: result.usage },
            ]);
            setStreamingText('');
            for (const warning of result.warnings ?? []) showNotification(warning);
            resolve();
          },
          onError: message => {
            showNotification(message);
            setMessages([
              ...updatedMessages,
              { role: 'assistant', content: `Error: ${message}` },
            ]);
            setStreamingText('');
            resolve();
          },
        }
      );
    });

    abortRef.current = null;
    setLoading(false);
    loadSessions();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleNewChat = () => {
    const newId = generateId();
    setActiveSessionId(newId);
    setMessages([]);
    setShowSessionList(false);
    setViewingRelatedSession(null);
  };

  const handleSwitchSession = (session: ChatSession) => {
    setActiveSessionId(session.id);
    setMessages(session.messages);
    setShowSessionList(false);
    setViewingRelatedSession(null);
  };

  const handleViewRelatedSession = (session: ChatSession, paperTitle: string) => {
    setViewingRelatedSession({ session, paperTitle });
    setMessages(session.messages);
    setActiveSessionId(null);
    setShowSessionList(false);
  };

  const handleBackFromRelated = async () => {
    setViewingRelatedSession(null);
    // Restore to current paper's most recent session
    const paperSessions = await loadSessions();
    if (paperSessions.length > 0) {
      setActiveSessionId(paperSessions[0].id);
      setMessages(paperSessions[0].messages);
    } else {
      setMessages([]);
    }
  };

  const totalRelatedSessionCount = relatedPaperSessions.reduce((sum, rp) => sum + rp.sessions.length, 0);

  const handleDeleteSession = async (sessionId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    await api.deleteChatSession(sessionId);
    const updated = await loadSessions();
    if (sessionId === activeSessionId) {
      if (updated.length > 0) {
        setActiveSessionId(updated[0].id);
        setMessages(updated[0].messages);
      } else {
        setActiveSessionId(null);
        setMessages([]);
      }
    }
  };

  /**
   * What this conversation was actually given, from the session row (frozen at
   * its first message) or from the turn in flight. Shown rather than hidden:
   * a paper answered from its abstract alone reads very differently from one
   * answered from its source, and the reader should know which they have.
   */
  const activeSession = sessions.find(s => s.id === activeSessionId);
  const contextMode = turnMeta?.contextMode ?? activeSession?.contextMode;
  const contextInfo = contextMode ? CONTEXT_LABELS[contextMode] : null;
  const usingCli = (turnMeta?.backend ?? activeSession?.backend ?? backendStatus?.backend) === 'cli';

  const firstUserMsg = (s: ChatSession) => {
    const first = s.messages.find(m => m.role === 'user');
    return first ? first.content.slice(0, 60) + (first.content.length > 60 ? '...' : '') : 'Empty session';
  };

  return (
    <div className="chat-panel">
      {backendStatus && !backendStatus.ready && (
        <div className="chat-no-key">
          <p>{backendReadyMessage(backendStatus)}</p>
        </div>
      )}

      {/* Session toolbar */}
      <div className="chat-session-bar">
        <button
          className="btn btn-secondary btn-sm"
          onClick={() => setShowSessionList(!showSessionList)}
          title="Past conversations for this paper"
        >
          History ({sessions.length})
        </button>
        {totalRelatedSessionCount > 0 && (
          <button
            className="btn btn-secondary btn-sm"
            onClick={() => { setShowRelatedSessions(!showRelatedSessions); setShowSessionList(false); }}
            title="Chat sessions from papers in the same worldline"
          >
            Related ({totalRelatedSessionCount})
          </button>
        )}
        <button className="btn btn-primary btn-sm" onClick={handleNewChat}>
          + New Chat
        </button>
        {contextInfo && (
          <span className={`chat-context-badge chat-context-${contextMode}`} title={contextInfo.title}>
            {contextInfo.label}
          </span>
        )}
      </div>

      {showSessionList && sessions.length > 0 && (
        <div className="chat-session-list">
          {sessions.map(s => (
            <div
              key={s.id}
              className={`chat-session-item ${s.id === activeSessionId ? 'active' : ''}`}
              onClick={() => handleSwitchSession(s)}
            >
              <div className="chat-session-item-text">
                <span className="chat-session-preview">{firstUserMsg(s)}</span>
                <span className="chat-session-date">
                  {new Date(s.updatedAt).toLocaleDateString()} &middot; {s.messages.length} msgs
                </span>
              </div>
              <button
                className="chat-session-delete"
                onClick={e => handleDeleteSession(s.id, e)}
                title="Delete this session"
              >
                &times;
              </button>
            </div>
          ))}
        </div>
      )}

      {showRelatedSessions && relatedPaperSessions.length > 0 && (
        <div className="chat-session-list chat-related-session-list">
          {relatedPaperSessions.map(rp => (
            <div key={rp.arxivId} className="chat-related-paper-group">
              <div className="chat-related-paper-title" title={rp.title}>
                {rp.title.length > 60 ? rp.title.slice(0, 60) + '...' : rp.title}
              </div>
              {rp.sessions.map(s => (
                <div
                  key={s.id}
                  className={`chat-session-item ${viewingRelatedSession?.session.id === s.id ? 'active' : ''}`}
                  onClick={() => handleViewRelatedSession(s, rp.title)}
                >
                  <div className="chat-session-item-text">
                    <span className="chat-session-preview">{firstUserMsg(s)}</span>
                    <span className="chat-session-date">
                      {new Date(s.updatedAt).toLocaleDateString()} &middot; {s.messages.length} msgs
                    </span>
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      {viewingRelatedSession && (
        <div className="chat-related-banner">
          <span>Viewing chat from: <strong>{viewingRelatedSession.paperTitle.length > 50 ? viewingRelatedSession.paperTitle.slice(0, 50) + '...' : viewingRelatedSession.paperTitle}</strong></span>
          <button className="btn btn-secondary btn-sm" onClick={handleBackFromRelated}>
            Back
          </button>
        </div>
      )}

      <div className="chat-messages">
        {messages.length === 0 && !streamingText && (
          <div className="chat-welcome">
            <p>Ask Claude about this paper. Examples:</p>
            <ul>
              <li>"Summarize the key contributions"</li>
              <li>"Explain the methodology"</li>
              <li>"What are the limitations?"</li>
              <li>"How does this compare to related work?"</li>
            </ul>
          </div>
        )}

        {messages.map((msg, i) => (
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
            {msg.role === 'assistant' && msg.usage && (
              <div className="chat-message-usage">
                {msg.usage.model && <span>{msg.usage.model}</span>}
                <span>{msg.usage.input_tokens.toLocaleString()} in / {msg.usage.output_tokens.toLocaleString()} out</span>
                {msg.usage.cache_read_input_tokens ? (
                  <span title="Tokens read from the model's 1-hour prompt cache instead of being re-sent — the paper itself, on every turn after the first.">
                    {msg.usage.cache_read_input_tokens.toLocaleString()} cached
                  </span>
                ) : null}
                {msg.usage.estimated_cost !== undefined && (
                  <span
                    title={
                      usingCli
                        ? 'List-price equivalent of work billed to the Claude Code plan, not money charged to an API account.'
                        : 'Estimated API cost at list price.'
                    }
                  >
                    {usingCli ? '≈' : ''}${msg.usage.estimated_cost < 0.01
                      ? msg.usage.estimated_cost.toFixed(4)
                      : msg.usage.estimated_cost.toFixed(3)}
                  </span>
                )}
              </div>
            )}
          </div>
        ))}

        {loading && (
          <div className="chat-message chat-message-assistant">
            <div className="chat-message-label">Claude</div>
            {streamingText ? (
              <div className="chat-message-content markdown-body chat-streaming">
                <Markdown>{streamingText}</Markdown>
              </div>
            ) : (
              <div className="chat-message-content chat-typing">
                {turnMeta && !turnMeta.primed
                  ? 'Reading the paper...'
                  : 'Thinking...'}
              </div>
            )}
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      <div className="chat-input-area">
        <div className="chat-input-row">
          <textarea
            className="chat-input"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              viewingRelatedSession
                ? 'Viewing related paper chat (read-only)'
                : backendStatus && !backendStatus.ready
                  ? 'Chat backend is not ready — see Settings'
                  : 'Ask about this paper...'
            }
            rows={2}
            disabled={(backendStatus ? !backendStatus.ready : false) || loading || !!viewingRelatedSession}
          />
          <button
            className="btn btn-primary chat-send-btn"
            onClick={handleSend}
            disabled={
              !input.trim() ||
              loading ||
              (backendStatus ? !backendStatus.ready : false) ||
              !!viewingRelatedSession
            }
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
