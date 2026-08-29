import { Router, Request, Response } from 'express';
import fs from 'fs';
import {
  getRelatedPaperTitlesByArxivId,
  createChatSession,
  getChatSession as dbGetChatSession,
  getChatSessionsByArxivId,
  getChatSessionsByWorldlineId,
  getAllChatSessions,
  deleteChatSession as dbDeleteChatSession,
  deleteChatSessionsByArxivId,
  addChatMessage,
  getChatMessages,
  getChatSessionPriming,
  setChatSessionPriming,
  setChatSessionCliId,
  getLiveCliSessionIds,
  getCliSessionIdsForPaper,
  getSetting,
  getPaperByArxivId,
  getWalkthroughsByArxivId,
} from '../services/database';
import { getLocalPdfPathForArxivId, resolveDbPdfPath, getProxyCachePath } from '../services/pdf';
import { fetchArxivPdf } from '../services/arxiv';
import {
  ChatBackend,
  ChatContextMode,
  DEFAULT_CHAT_BACKEND,
  DEFAULT_CHAT_CONTEXT_MODE,
  DEFAULT_CHAT_EFFORT,
  DEFAULT_CHAT_MODEL,
  PaperChatContext,
  ResolvedContext,
  WorldlineChatContext,
  buildPaperSystemPrompt,
  buildWorldlineSystemPrompt,
  getBackendStatus,
  reapCliSession,
  resolvePaperContext,
  runChatTurn,
  sweepCliSessions,
  withSessionLock,
} from '../services/chat';

const router = Router();

// Simple in-memory cache for fetched PDFs (base64), keyed by arxiv ID.
// Avoids re-downloading the same PDF across messages in a conversation.
const pdfCache = new Map<string, { data: string; fetchedAt: number }>();
const PDF_CACHE_TTL = 30 * 60 * 1000; // 30 minutes

async function fetchPdfBase64(arxivId: string): Promise<string> {
  const cached = pdfCache.get(arxivId);
  if (cached && Date.now() - cached.fetchedAt < PDF_CACHE_TTL) {
    return cached.data;
  }

  // For uploaded papers, look up by arxiv_id to get the pdf_path
  if (arxivId.startsWith('upload-')) {
    const paper = getPaperByArxivId(arxivId) as any;
    if (paper?.pdf_path) {
      const absPath = resolveDbPdfPath(paper.pdf_path);
      if (fs.existsSync(absPath)) {
        const buffer = fs.readFileSync(absPath);
        const base64 = buffer.toString('base64');
        pdfCache.set(arxivId, { data: base64, fetchedAt: Date.now() });
        return base64;
      }
    }
    throw new Error('Uploaded PDF not found on disk');
  }

  // Check for local PDF first
  const localPath = getLocalPdfPathForArxivId(arxivId);
  if (localPath) {
    const buffer = fs.readFileSync(localPath);
    const base64 = buffer.toString('base64');
    pdfCache.set(arxivId, { data: base64, fetchedAt: Date.now() });
    return base64;
  }

  // Fall back to the pdf-proxy cache (populated when the viewer opens the PDF).
  const cachedPath = getProxyCachePath(arxivId);
  if (fs.existsSync(cachedPath)) {
    const buffer = fs.readFileSync(cachedPath);
    const base64 = buffer.toString('base64');
    pdfCache.set(arxivId, { data: base64, fetchedAt: Date.now() });
    return base64;
  }

  const response = await fetchArxivPdf(arxivId);
  if (!response.ok) {
    throw new Error(`Failed to fetch PDF: ${response.status} ${response.statusText}`);
  }

  const buffer = await response.arrayBuffer();
  const base64 = Buffer.from(buffer).toString('base64');

  pdfCache.set(arxivId, { data: base64, fetchedAt: Date.now() });

  // Evict stale entries
  for (const [key, entry] of pdfCache) {
    if (Date.now() - entry.fetchedAt > PDF_CACHE_TTL) {
      pdfCache.delete(key);
    }
  }

  return base64;
}

// --- Settings ----------------------------------------------------------------

function chatBackend(): ChatBackend {
  // Default to the local `claude -p` CLI: messages bill against the Claude Code
  // plan rather than metered credits, the prompt cache is 1-hour rather than
  // 5-minute, and no key has to be stored.
  return getSetting('chatBackend') === 'api' ? 'api' : DEFAULT_CHAT_BACKEND;
}

function chatModel(): string {
  return getSetting('chatModel') || DEFAULT_CHAT_MODEL;
}

function chatEffort(): string {
  const raw = getSetting('chatEffort');
  return raw === 'low' || raw === 'medium' || raw === 'high' ? raw : DEFAULT_CHAT_EFFORT;
}

function chatContextPreference(): 'tex' | 'pdf' {
  return getSetting('chatContextMode') === 'pdf' ? 'pdf' : DEFAULT_CHAT_CONTEXT_MODE;
}

// --- SSE ---------------------------------------------------------------------

/**
 * The response is a stream, not a JSON body: `--include-partial-messages` gives
 * token-by-token deltas, and on Opus with adaptive thinking on, the wait for a
 * whole answer would otherwise be noticeably worse than what it replaced.
 */
function openStream(res: Response): void {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
}

function send(res: Response, event: Record<string, unknown>): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

/** The newest built walkthrough's outline, for the frozen prompt. */
function walkthroughOutlineFor(
  arxivId: string
): { thesis: string; scenes: { title: string; narration: string }[] } | null {
  const row = getWalkthroughsByArxivId(arxivId).find(r => r.status === 'ready' && r.outline);
  if (!row?.outline) return null;
  try {
    const outline = JSON.parse(row.outline) as {
      thesis?: string;
      scenes?: { title?: string; narration?: string }[];
    };
    const scenes = (outline.scenes ?? [])
      .map(s => ({ title: String(s.title ?? ''), narration: String(s.narration ?? '') }))
      .filter(s => s.title || s.narration);
    if (!outline.thesis && scenes.length === 0) return null;
    return { thesis: String(outline.thesis ?? ''), scenes };
  } catch {
    return null;
  }
}

function priorMessages(sessionId: string): { role: 'user' | 'assistant'; content: string }[] {
  return (getChatMessages(sessionId) as any[]).map(m => ({
    role: m.role as 'user' | 'assistant',
    content: m.content as string,
  }));
}

interface StreamRequest {
  sessionId: string;
  message: string;
  apiKey?: string;
}

interface PaperStreamRequest extends StreamRequest {
  paperContext: PaperChatContext;
}

interface WorldlineStreamRequest extends StreamRequest {
  worldlineContext: WorldlineChatContext;
}

/**
 * One turn, shared by the paper and worldline routes.
 *
 * The two differ only in how the session row is created, how the frozen prompt
 * is rendered, and what the context block is — everything downstream (priming
 * vs resuming, streaming, persistence, cost accounting) is the same code, so a
 * prefix-identity bug cannot exist in one path and not the other.
 */
async function streamTurn(
  res: Response,
  opts: {
    sessionId: string;
    message: string;
    apiKey?: string;
    ensureSession: () => void;
    buildSystemPrompt: (mode: ChatContextMode) => string;
    resolveContext: () => Promise<ResolvedContext>;
    /** Modes this conversation can use. Worldline chat has only its own text. */
    fixedMode?: ChatContextMode;
  }
): Promise<void> {
  const { sessionId, message } = opts;

  if (!sessionId || typeof message !== 'string' || !message.trim()) {
    res.status(400).json({ error: 'sessionId and a non-empty message are required' });
    return;
  }

  opts.ensureSession();

  const stored = getChatSessionPriming(sessionId);
  const primed = !!stored?.system_prompt;

  // A session keeps the model and backend it was created under: resuming under
  // a different one would miss the cache at best and fail at worst. New
  // settings apply to new sessions.
  const backend: ChatBackend = primed
    ? (stored!.backend === 'api' ? 'api' : 'cli')
    : chatBackend();
  const model = primed ? stored!.model || chatModel() : chatModel();
  const effort = chatEffort();
  const apiKey = opts.apiKey || getSetting('claudeApiKey');

  if (backend === 'api' && !apiKey) {
    res.status(400).json({ error: 'Claude API key is required. Please set it in Settings.' });
    return;
  }

  const history = priorMessages(sessionId);

  // Resolved at most once per turn, and not at all on a plain CLI resume.
  // Held in a box rather than a `let` so the assignment inside the thunk is
  // visible to the reads after it.
  const state: { resolved: ResolvedContext | null } = { resolved: null };
  const getContext = async (): Promise<ResolvedContext> => {
    if (!state.resolved) {
      state.resolved = opts.fixedMode
        ? { mode: opts.fixedMode, warnings: [] }
        : await opts.resolveContext();
    }
    return state.resolved;
  };

  // The prompt names the context mode, so priming has to resolve the context
  // before the prompt exists. A primed session skips both.
  let systemPrompt: string;
  let contextMode: ChatContextMode;
  if (primed) {
    systemPrompt = stored!.system_prompt as string;
    contextMode = (stored!.context_mode as ChatContextMode) || 'abstract';
  } else {
    const context = await getContext();
    contextMode = context.mode;
    systemPrompt = opts.buildSystemPrompt(context.mode);
  }

  openStream(res);
  send(res, {
    type: 'meta',
    backend,
    model,
    contextMode,
    primed,
    warnings: state.resolved?.warnings ?? [],
  });

  // Client-disconnect detection hangs off the RESPONSE, not the request.
  // `req.on('close')` fires when the request body stream ends — on a POST whose
  // body has already been read, that is immediately, which killed the model call
  // the moment it started. `res` closes when the response finishes or the socket
  // dies, and `writableEnded` separates "we finished" from "they left".
  const abort = { aborted: false };
  res.on('close', () => {
    if (!res.writableEnded) abort.aborted = true;
  });

  try {
    const result = await withSessionLock(sessionId, () =>
      runChatTurn(
        {
          backend,
          model,
          effort,
          systemPrompt,
          getContext,
          cliSessionId: stored?.cli_session_id ?? null,
          history,
          message,
          apiKey,
        },
        text => send(res, { type: 'delta', text }),
        abort
      )
    );

    if (!primed) {
      setChatSessionPriming(sessionId, {
        cli_session_id: result.cliSessionId,
        context_mode: (state.resolved?.mode ?? contextMode) as string,
        system_prompt: systemPrompt,
        backend: result.backend,
        model: result.model,
      });
    } else if (result.cliSessionId && result.cliSessionId !== stored!.cli_session_id) {
      // A resume that fell through to a re-prime lives under a new uuid.
      setChatSessionCliId(sessionId, result.cliSessionId);
    }

    addChatMessage({ session_id: sessionId, role: 'user', content: message });
    addChatMessage({
      session_id: sessionId,
      role: 'assistant',
      content: result.text,
      input_tokens: result.usage.input_tokens,
      output_tokens: result.usage.output_tokens,
      cache_creation_input_tokens: result.usage.cache_creation_input_tokens,
      cache_read_input_tokens: result.usage.cache_read_input_tokens,
      estimated_cost: result.usage.estimated_cost,
      model: result.model,
    });

    send(res, {
      type: 'done',
      message: result.text,
      model: result.model,
      backend: result.backend,
      contextMode: (state.resolved?.mode ?? contextMode) as string,
      reprimed: result.reprimed,
      warnings: result.warnings,
      usage: result.usage,
    });
    res.end();
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Failed to process chat request';
    console.error('Chat error:', error);

    if (!abort.aborted) {
      // The question was asked and the failure is part of the record, exactly as
      // it was before this route streamed.
      addChatMessage({ session_id: sessionId, role: 'user', content: message });
      addChatMessage({
        session_id: sessionId,
        role: 'assistant',
        content: `Error: ${detail}`,
      });
      send(res, { type: 'error', message: detail });
    }
    res.end();
  }
}

// POST /api/chat — one turn about a paper, streamed.
router.post('/', async (req: Request, res: Response) => {
  const { sessionId, message, apiKey, paperContext } = req.body as PaperStreamRequest;

  if (!paperContext?.arxivId) {
    return res.status(400).json({ error: 'paperContext with an arxivId is required' });
  }

  try {
    await streamTurn(res, {
      sessionId,
      message,
      apiKey,
      ensureSession: () => {
        if (dbGetChatSession(sessionId)) return;
        createChatSession({
          id: sessionId,
          arxiv_id: paperContext.arxivId,
          paper_title: paperContext.title,
          session_type: 'paper',
        });
      },
      buildSystemPrompt: mode =>
        buildPaperSystemPrompt({
          paper: paperContext,
          relatedWorldlines: getRelatedPaperTitlesByArxivId(paperContext.arxivId),
          contextMode: mode,
          walkthrough: walkthroughOutlineFor(paperContext.arxivId),
          sourceVersion: null,
        }),
      resolveContext: () =>
        resolvePaperContext(paperContext.arxivId, chatContextPreference(), fetchPdfBase64),
    });
  } catch (error) {
    console.error('Chat error:', error);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to process chat request' });
    else res.end();
  }
});

// POST /api/chat/worldline — one turn about a thread of papers, streamed.
router.post('/worldline', async (req: Request, res: Response) => {
  const { sessionId, message, apiKey, worldlineContext } = req.body as WorldlineStreamRequest;

  if (!worldlineContext?.papers?.length) {
    return res.status(400).json({ error: 'Worldline context with papers is required' });
  }

  try {
    await streamTurn(res, {
      sessionId,
      message,
      apiKey,
      // The thread's papers are in the system prompt, so there is no separate
      // context block to resolve and nothing to fall back through.
      fixedMode: 'abstract',
      ensureSession: () => {
        if (dbGetChatSession(sessionId)) return;
        createChatSession({
          id: sessionId,
          worldline_id: worldlineContext.worldlineId,
          worldline_name: worldlineContext.worldlineName,
          session_type: 'worldline',
        });
      },
      buildSystemPrompt: () => buildWorldlineSystemPrompt({ worldline: worldlineContext }),
      resolveContext: async () => ({ mode: 'abstract', warnings: [] }),
    });
  } catch (error) {
    console.error('Worldline chat error:', error);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to process chat request' });
    else res.end();
  }
});

// GET /api/chat/backend-status — can this machine answer a message at all?
router.get('/backend-status', async (_req: Request, res: Response) => {
  try {
    const status = await getBackendStatus({
      backend: chatBackend(),
      model: chatModel(),
      effort: chatEffort(),
      contextMode: chatContextPreference(),
      apiKeyPresent: !!getSetting('claudeApiKey'),
    });
    res.json(status);
  } catch (error) {
    console.error('Failed to read chat backend status:', error);
    res.status(500).json({ error: 'Failed to read chat backend status' });
  }
});

// --- Chat Session CRUD ---

// GET /api/chat/sessions - Get all paper chat sessions
router.get('/sessions', (_req: Request, res: Response) => {
  try {
    const sessions = getAllChatSessions();
    // Attach messages to each session
    const result = (sessions as any[]).map(s => ({
      ...s,
      messages: (getChatMessages(s.id) as any[]).map(m => ({
        role: m.role,
        content: m.content,
        usage: m.input_tokens != null ? {
          input_tokens: m.input_tokens,
          output_tokens: m.output_tokens,
          cache_creation_input_tokens: m.cache_creation_input_tokens,
          cache_read_input_tokens: m.cache_read_input_tokens,
          estimated_cost: m.estimated_cost,
          model: m.model,
        } : undefined,
      })),
    }));
    res.json(result);
  } catch (error) {
    console.error('Failed to get chat sessions:', error);
    res.status(500).json({ error: 'Failed to get chat sessions' });
  }
});

// GET /api/chat/sessions/paper/:arxivId - Get sessions for a specific paper
router.get('/sessions/paper/:arxivId', (req: Request, res: Response) => {
  try {
    const sessions = getChatSessionsByArxivId(req.params.arxivId as string);
    const result = (sessions as any[]).map(s => ({
      ...s,
      messages: (getChatMessages(s.id) as any[]).map(m => ({
        role: m.role,
        content: m.content,
        usage: m.input_tokens != null ? {
          input_tokens: m.input_tokens,
          output_tokens: m.output_tokens,
          cache_creation_input_tokens: m.cache_creation_input_tokens,
          cache_read_input_tokens: m.cache_read_input_tokens,
          estimated_cost: m.estimated_cost,
          model: m.model,
        } : undefined,
      })),
    }));
    res.json(result);
  } catch (error) {
    console.error('Failed to get paper chat sessions:', error);
    res.status(500).json({ error: 'Failed to get chat sessions' });
  }
});

// GET /api/chat/sessions/worldline/:worldlineId - Get sessions for a specific worldline
router.get('/sessions/worldline/:worldlineId', (req: Request, res: Response) => {
  try {
    const worldlineId = parseInt(req.params.worldlineId as string);
    if (isNaN(worldlineId)) {
      return res.status(400).json({ error: 'Invalid worldline ID' });
    }
    const sessions = getChatSessionsByWorldlineId(worldlineId);
    const result = (sessions as any[]).map(s => ({
      ...s,
      messages: (getChatMessages(s.id) as any[]).map(m => ({
        role: m.role,
        content: m.content,
        usage: m.input_tokens != null ? {
          input_tokens: m.input_tokens,
          output_tokens: m.output_tokens,
          cache_creation_input_tokens: m.cache_creation_input_tokens,
          cache_read_input_tokens: m.cache_read_input_tokens,
          estimated_cost: m.estimated_cost,
          model: m.model,
        } : undefined,
      })),
    }));
    res.json(result);
  } catch (error) {
    console.error('Failed to get worldline chat sessions:', error);
    res.status(500).json({ error: 'Failed to get chat sessions' });
  }
});

// GET /api/chat/sessions/:id - Get a single session with messages
router.get('/sessions/:id', (req: Request, res: Response) => {
  try {
    const session = dbGetChatSession(req.params.id as string);
    if (!session) {
      return res.status(404).json({ error: 'Chat session not found' });
    }
    const messages = (getChatMessages(req.params.id as string) as any[]).map(m => ({
      role: m.role,
      content: m.content,
      usage: m.input_tokens != null ? {
        input_tokens: m.input_tokens,
        output_tokens: m.output_tokens,
        cache_creation_input_tokens: m.cache_creation_input_tokens,
        cache_read_input_tokens: m.cache_read_input_tokens,
        estimated_cost: m.estimated_cost,
        model: m.model,
      } : undefined,
    }));
    res.json({ ...(session as any), messages });
  } catch (error) {
    console.error('Failed to get chat session:', error);
    res.status(500).json({ error: 'Failed to get chat session' });
  }
});

// POST /api/chat/sessions - Create a new chat session
router.post('/sessions', (req: Request, res: Response) => {
  try {
    const { id, arxiv_id, paper_title, worldline_id, worldline_name, session_type } = req.body;
    if (!id || !session_type) {
      return res.status(400).json({ error: 'id and session_type are required' });
    }
    createChatSession({
      id,
      arxiv_id,
      paper_title,
      worldline_id,
      worldline_name,
      session_type,
    });
    const session = dbGetChatSession(id);
    res.status(201).json(session);
  } catch (error) {
    console.error('Failed to create chat session:', error);
    res.status(500).json({ error: 'Failed to create chat session' });
  }
});

// POST /api/chat/sessions/:id/messages - Add a message to a session
router.post('/sessions/:id/messages', (req: Request, res: Response) => {
  try {
    const session = dbGetChatSession(req.params.id as string);
    if (!session) {
      return res.status(404).json({ error: 'Chat session not found' });
    }
    const { role, content, usage } = req.body;
    if (!role || !content) {
      return res.status(400).json({ error: 'role and content are required' });
    }
    addChatMessage({
      session_id: req.params.id as string,
      role,
      content,
      input_tokens: usage?.input_tokens,
      output_tokens: usage?.output_tokens,
      cache_creation_input_tokens: usage?.cache_creation_input_tokens,
      cache_read_input_tokens: usage?.cache_read_input_tokens,
      estimated_cost: usage?.estimated_cost,
      model: usage?.model,
    });
    res.status(201).json({ success: true });
  } catch (error) {
    console.error('Failed to add chat message:', error);
    res.status(500).json({ error: 'Failed to add chat message' });
  }
});

// POST /api/chat/sessions/:id/messages/batch - Add multiple messages to a session at once
router.post('/sessions/:id/messages/batch', (req: Request, res: Response) => {
  try {
    const session = dbGetChatSession(req.params.id as string);
    if (!session) {
      return res.status(404).json({ error: 'Chat session not found' });
    }
    const { messages } = req.body as { messages: { role: string; content: string; usage?: any }[] };
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'messages array is required' });
    }
    for (const msg of messages) {
      addChatMessage({
        session_id: req.params.id as string,
        role: msg.role as 'user' | 'assistant',
        content: msg.content,
        input_tokens: msg.usage?.input_tokens,
        output_tokens: msg.usage?.output_tokens,
        cache_creation_input_tokens: msg.usage?.cache_creation_input_tokens,
        cache_read_input_tokens: msg.usage?.cache_read_input_tokens,
        estimated_cost: msg.usage?.estimated_cost,
        model: msg.usage?.model,
      });
    }
    res.status(201).json({ success: true, count: messages.length });
  } catch (error) {
    console.error('Failed to add chat messages:', error);
    res.status(500).json({ error: 'Failed to add chat messages' });
  }
});

// DELETE /api/chat/sessions/:id - Delete a chat session
router.delete('/sessions/:id', (req: Request, res: Response) => {
  try {
    // The CLI's transcript for this conversation is deleted alongside the row,
    // so the two stores cannot drift into a directory of orphaned sessions.
    const priming = getChatSessionPriming(req.params.id as string);
    dbDeleteChatSession(req.params.id as string);
    if (priming?.cli_session_id) reapCliSession(priming.cli_session_id);
    res.json({ success: true });
  } catch (error) {
    console.error('Failed to delete chat session:', error);
    res.status(500).json({ error: 'Failed to delete chat session' });
  }
});

// DELETE /api/chat/sessions/paper/:arxivId - Delete all sessions for a paper
router.delete('/sessions/paper/:arxivId', (req: Request, res: Response) => {
  try {
    const cliIds = getCliSessionIdsForPaper(req.params.arxivId as string);
    deleteChatSessionsByArxivId(req.params.arxivId as string);
    for (const id of cliIds) reapCliSession(id);
    res.json({ success: true });
  } catch (error) {
    console.error('Failed to delete paper chat sessions:', error);
    res.status(500).json({ error: 'Failed to delete chat sessions' });
  }
});

// POST /api/chat/verify-key - Verify that a Claude API key is valid
router.post('/verify-key', async (req: Request, res: Response) => {
  try {
    const { apiKey } = req.body as { apiKey: string };

    if (!apiKey) {
      return res.status(400).json({ error: 'API key is required', valid: false });
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 10,
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    });

    if (response.ok) {
      res.json({ valid: true });
    } else {
      const errorData = await response.json().catch(() => ({}));
      res.json({ valid: false, error: (errorData as any)?.error?.message || 'Invalid API key' });
    }
  } catch (error) {
    console.error('Key verification error:', error);
    res.status(500).json({ valid: false, error: 'Failed to verify API key' });
  }
});

/**
 * Age sweep over the CLI's own transcript store. Called once at startup: chat
 * session files accumulate under one project slug and nothing else ever cleans
 * them up. Scoped to that slug and to files no live session references.
 */
export function sweepChatSessions(): void {
  try {
    const removed = sweepCliSessions(new Set(getLiveCliSessionIds()));
    if (removed > 0) console.log(`[navigate] chat: swept ${removed} stale CLI session file(s)`);
  } catch (err) {
    console.warn('[navigate] chat: could not sweep CLI session files:', err);
  }
}

export default router;
