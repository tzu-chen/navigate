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
  getSetting,
  getPaperByArxivId,
} from '../services/database';
import { getLocalPdfPathForArxivId, resolveDbPdfPath } from '../services/pdf';

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

  const pdfUrl = `https://arxiv.org/pdf/${arxivId}`;
  const response = await fetch(pdfUrl);
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

interface ChatRequest {
  messages: { role: 'user' | 'assistant'; content: string }[];
  apiKey: string;
  paperContext: {
    title: string;
    summary: string;
    authors: string[];
    categories: string[];
    arxivId: string;
  };
}

// POST /api/chat - Send a message to Claude with the full PDF document
router.post('/', async (req: Request, res: Response) => {
  try {
    const { messages, apiKey: clientApiKey, paperContext } = req.body as ChatRequest;

    // Use client-provided key, or fall back to server-stored key
    const apiKey = clientApiKey || getSetting('claudeApiKey');
    if (!apiKey) {
      return res.status(400).json({ error: 'Claude API key is required. Please set it in Settings.' });
    }

    if (!messages || messages.length === 0) {
      return res.status(400).json({ error: 'Messages are required' });
    }

    // Fetch the PDF and encode as base64
    let pdfBase64: string | null = null;
    try {
      pdfBase64 = await fetchPdfBase64(paperContext.arxivId);
    } catch (err) {
      console.error('Failed to fetch PDF for chat:', err);
      // Continue without PDF — fall back to metadata-only context
    }

    // Look up related papers from the same worldline(s)
    const relatedPapers = getRelatedPaperTitlesByArxivId(paperContext.arxivId);
    let relatedPapersSection = '';
    if (relatedPapers.length > 0) {
      const worldlineSections = relatedPapers.map(wl =>
        `Worldline "${wl.worldlineName}":\n${wl.titles.map(t => `  - ${t}`).join('\n')}`
      ).join('\n');
      relatedPapersSection = `\n\nRelated papers in the same research thread(s):\n${worldlineSections}\n\nThe user may ask about connections between these papers. Use this context when relevant.`;
    }

    // Build system prompt as content blocks with cache_control
    // so Anthropic caches the system instructions across turns.
    const systemContent = [
      {
        type: 'text' as const,
        text: `You are a research assistant helping analyze an academic paper.

Title: ${paperContext.title}
Authors: ${paperContext.authors.join(', ')}${paperContext.arxivId.startsWith('upload-') ? '' : `\nArXiv ID: ${paperContext.arxivId}`}
Categories: ${paperContext.categories.join(', ')}

${pdfBase64 ? 'The full PDF of the paper is attached to the first message.' : `Abstract:\n${paperContext.summary}\n\n(The PDF could not be loaded. Answer based on the abstract above.)`}${relatedPapersSection}

Help the user understand the paper, answer questions about its methodology, results, and implications. Be concise and precise in your responses.`,
        cache_control: { type: 'ephemeral' as const },
      },
    ];

    // Build the messages array for Claude, attaching the PDF document
    // to the first user message with cache_control so Anthropic caches
    // the (system + PDF) prefix across subsequent turns in a conversation.
    const claudeMessages: any[] = [];
    let pdfAttached = false;

    for (const msg of messages) {
      if (msg.role === 'user' && !pdfAttached && pdfBase64) {
        // First user message: include PDF document (cached) + text
        claudeMessages.push({
          role: 'user',
          content: [
            {
              type: 'document',
              source: {
                type: 'base64',
                media_type: 'application/pdf',
                data: pdfBase64,
              },
              cache_control: { type: 'ephemeral' },
            },
            {
              type: 'text',
              text: msg.content,
            },
          ],
        });
        pdfAttached = true;
      } else {
        claudeMessages.push({
          role: msg.role,
          content: msg.content,
        });
      }
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
        max_tokens: 2048,
        system: systemContent,
        messages: claudeMessages,
      }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: { message: response.statusText } }));
      const errorMessage = (errorData as any)?.error?.message || `API request failed with status ${response.status}`;
      return res.status(response.status).json({ error: errorMessage });
    }

    const data = await response.json() as any;
    const assistantMessage = data.content?.[0]?.text || 'No response generated.';

    res.json({
      message: assistantMessage,
      model: data.model || 'unknown',
      usage: {
        input_tokens: data.usage?.input_tokens || 0,
        output_tokens: data.usage?.output_tokens || 0,
        cache_creation_input_tokens: data.usage?.cache_creation_input_tokens || 0,
        cache_read_input_tokens: data.usage?.cache_read_input_tokens || 0,
      },
    });
  } catch (error) {
    console.error('Chat error:', error);
    res.status(500).json({ error: 'Failed to process chat request' });
  }
});

// POST /api/chat/worldline - Chat about a worldline (no PDF, just titles + abstracts)
interface WorldlineChatRequest {
  messages: { role: 'user' | 'assistant'; content: string }[];
  apiKey: string;
  worldlineContext: {
    worldlineName: string;
    papers: { title: string; authors: string[]; summary: string; arxivId: string }[];
  };
}

router.post('/worldline', async (req: Request, res: Response) => {
  try {
    const { messages, apiKey: clientApiKey, worldlineContext } = req.body as WorldlineChatRequest;

    // Use client-provided key, or fall back to server-stored key
    const apiKey = clientApiKey || getSetting('claudeApiKey');
    if (!apiKey) {
      return res.status(400).json({ error: 'Claude API key is required. Please set it in Settings.' });
    }

    if (!messages || messages.length === 0) {
      return res.status(400).json({ error: 'Messages are required' });
    }

    if (!worldlineContext || !worldlineContext.papers || worldlineContext.papers.length === 0) {
      return res.status(400).json({ error: 'Worldline context with papers is required' });
    }

    // Build paper context section
    const papersSection = worldlineContext.papers.map((p, i) =>
      `Paper ${i + 1}: "${p.title}"\n  Authors: ${p.authors.join(', ')}\n  ArXiv ID: ${p.arxivId}\n  Abstract: ${p.summary}`
    ).join('\n\n');

    const systemContent = [
      {
        type: 'text' as const,
        text: `You are a research assistant helping analyze a collection of related academic papers grouped under the worldline "${worldlineContext.worldlineName}".

This worldline contains ${worldlineContext.papers.length} paper(s):

${papersSection}

Help the user understand the connections between these papers, their collective contributions, how they build on each other, and the overall research trajectory of this worldline. Be concise and precise in your responses.`,
        cache_control: { type: 'ephemeral' as const },
      },
    ];

    const claudeMessages = messages.map(msg => ({
      role: msg.role,
      content: msg.content,
    }));

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2048,
        system: systemContent,
        messages: claudeMessages,
      }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: { message: response.statusText } }));
      const errorMessage = (errorData as any)?.error?.message || `API request failed with status ${response.status}`;
      return res.status(response.status).json({ error: errorMessage });
    }

    const data = await response.json() as any;
    const assistantMessage = data.content?.[0]?.text || 'No response generated.';

    res.json({
      message: assistantMessage,
      model: data.model || 'unknown',
      usage: {
        input_tokens: data.usage?.input_tokens || 0,
        output_tokens: data.usage?.output_tokens || 0,
        cache_creation_input_tokens: data.usage?.cache_creation_input_tokens || 0,
        cache_read_input_tokens: data.usage?.cache_read_input_tokens || 0,
      },
    });
  } catch (error) {
    console.error('Worldline chat error:', error);
    res.status(500).json({ error: 'Failed to process worldline chat request' });
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
    dbDeleteChatSession(req.params.id as string);
    res.json({ success: true });
  } catch (error) {
    console.error('Failed to delete chat session:', error);
    res.status(500).json({ error: 'Failed to delete chat session' });
  }
});

// DELETE /api/chat/sessions/paper/:arxivId - Delete all sessions for a paper
router.delete('/sessions/paper/:arxivId', (req: Request, res: Response) => {
  try {
    deleteChatSessionsByArxivId(req.params.arxivId as string);
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

export default router;
