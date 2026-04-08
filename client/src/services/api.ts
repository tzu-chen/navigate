import { ArxivPaper, SavedPaper, Comment, Tag, CategoryGroup, FavoriteAuthor, ChatMessage, ChatSession, WorldlineChatSession, Worldline, PaperSimilarityResult } from '../types';

const BASE = '/api';

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${url}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'Request failed');
  }
  return res.json();
}

// ArXiv
export async function getCategories(): Promise<CategoryGroup[]> {
  return request('/arxiv/categories');
}

export async function searchArxiv(params: {
  category?: string;
  query?: string;
  start?: number;
  maxResults?: number;
  sortBy?: string;
}): Promise<{ papers: ArxivPaper[]; totalResults: number }> {
  const qs = new URLSearchParams();
  if (params.category) qs.set('category', params.category);
  if (params.query) qs.set('query', params.query);
  if (params.start !== undefined) qs.set('start', String(params.start));
  if (params.maxResults) qs.set('maxResults', String(params.maxResults));
  if (params.sortBy) qs.set('sortBy', params.sortBy);
  return request(`/arxiv/search?${qs}`);
}

export async function getLatestArxiv(category: string): Promise<{ papers: ArxivPaper[]; totalResults: number }> {
  return request(`/arxiv/latest?category=${encodeURIComponent(category)}`);
}

export async function getRecentArxiv(category: string): Promise<{ papers: ArxivPaper[]; totalResults: number }> {
  return request(`/arxiv/recent?category=${encodeURIComponent(category)}`);
}

export async function getArxivPaper(id: string): Promise<ArxivPaper> {
  return request(`/arxiv/paper/${encodeURIComponent(id)}`);
}

export function getPdfProxyUrl(arxivId: string): string {
  return `${BASE}/arxiv/pdf-proxy/${arxivId}`;
}

// Papers (Library)
export async function getSavedPapers(filters?: {
  status?: string;
  tag_id?: number;
}): Promise<SavedPaper[]> {
  const qs = new URLSearchParams();
  if (filters?.status) qs.set('status', filters.status);
  if (filters?.tag_id) qs.set('tag_id', String(filters.tag_id));
  const query = qs.toString();
  return request(`/papers${query ? `?${query}` : ''}`);
}

export async function savePaper(paper: ArxivPaper): Promise<SavedPaper> {
  return request('/papers', {
    method: 'POST',
    body: JSON.stringify({
      arxiv_id: paper.id,
      title: paper.title,
      summary: paper.summary,
      authors: paper.authors,
      published: paper.published,
      updated: paper.updated,
      categories: paper.categories,
      pdf_url: paper.pdfUrl,
      abs_url: paper.absUrl,
      doi: paper.doi,
      journal_ref: paper.journalRef,
    }),
  });
}

export async function uploadPaper(
  file: File,
  metadata: { title: string; authors: string[]; summary?: string; categories?: string[]; doi?: string; journalRef?: string }
): Promise<SavedPaper> {
  const formData = new FormData();
  formData.append('pdf', file);
  formData.append('title', metadata.title);
  formData.append('authors', JSON.stringify(metadata.authors));
  if (metadata.summary) formData.append('summary', metadata.summary);
  if (metadata.categories?.length) formData.append('categories', JSON.stringify(metadata.categories));
  if (metadata.doi) formData.append('doi', metadata.doi);
  if (metadata.journalRef) formData.append('journal_ref', metadata.journalRef);

  const res = await fetch(`${BASE}/papers/upload`, {
    method: 'POST',
    body: formData,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'Upload failed');
  }
  return res.json();
}

export async function updatePaperStatus(id: number, status: string): Promise<void> {
  await request(`/papers/${id}/status`, {
    method: 'PATCH',
    body: JSON.stringify({ status }),
  });
}

export async function deletePaper(id: number): Promise<void> {
  await request(`/papers/${id}`, { method: 'DELETE' });
}

// PDF Management
export function getLocalPdfUrl(paperId: number): string {
  return `${BASE}/papers/${paperId}/pdf`;
}

export async function deleteLocalPdf(paperId: number): Promise<void> {
  await request(`/papers/${paperId}/pdf`, { method: 'DELETE' });
}

// Bulk Operations
export async function bulkDownloadPdfs(paperIds: number[]): Promise<{
  success: boolean;
  downloaded: number;
  failed: number;
  errors: string[];
}> {
  return request('/papers/bulk/download-pdfs', {
    method: 'POST',
    body: JSON.stringify({ paper_ids: paperIds }),
  });
}

export async function bulkDeletePdfs(paperIds: number[]): Promise<{
  success: boolean;
  deleted: number;
}> {
  return request('/papers/bulk/delete-pdfs', {
    method: 'POST',
    body: JSON.stringify({ paper_ids: paperIds }),
  });
}

// Scribe integration
export async function sendToScribe(paperIds: number[]): Promise<{
  sent: number;
  failed: number;
  errors: string[];
}> {
  return request('/scribe/send', {
    method: 'POST',
    body: JSON.stringify({ paper_ids: paperIds }),
  });
}

export async function bulkDeletePapers(paperIds: number[]): Promise<{
  success: boolean;
  deleted: number;
}> {
  return request('/papers/bulk/delete', {
    method: 'POST',
    body: JSON.stringify({ paper_ids: paperIds }),
  });
}

export async function bulkUpdateStatus(paperIds: number[], status: string): Promise<{
  success: boolean;
  updated: number;
}> {
  return request('/papers/bulk/status', {
    method: 'POST',
    body: JSON.stringify({ paper_ids: paperIds, status }),
  });
}

export async function bulkAddTag(paperIds: number[], tagId: number): Promise<{
  success: boolean;
  applied: number;
}> {
  return request('/papers/bulk/add-tag', {
    method: 'POST',
    body: JSON.stringify({ paper_ids: paperIds, tag_id: tagId }),
  });
}

export async function bulkRemoveTag(paperIds: number[], tagId: number): Promise<{
  success: boolean;
  removed: number;
}> {
  return request('/papers/bulk/remove-tag', {
    method: 'POST',
    body: JSON.stringify({ paper_ids: paperIds, tag_id: tagId }),
  });
}

// Comments
export async function getComments(paperId: number): Promise<Comment[]> {
  return request(`/papers/${paperId}/comments`);
}

export async function addComment(
  paperId: number,
  content: string,
  pageNumber?: number
): Promise<{ id: number }> {
  return request(`/papers/${paperId}/comments`, {
    method: 'POST',
    body: JSON.stringify({ content, page_number: pageNumber }),
  });
}

export async function updateComment(
  paperId: number,
  commentId: number,
  content: string
): Promise<void> {
  await request(`/papers/${paperId}/comments/${commentId}`, {
    method: 'PUT',
    body: JSON.stringify({ content }),
  });
}

export async function deleteComment(
  paperId: number,
  commentId: number
): Promise<void> {
  await request(`/papers/${paperId}/comments/${commentId}`, {
    method: 'DELETE',
  });
}

// Tags
export async function getTags(): Promise<Tag[]> {
  return request('/tags');
}

export async function createTag(name: string, color: string): Promise<Tag> {
  return request('/tags', {
    method: 'POST',
    body: JSON.stringify({ name, color }),
  });
}

export async function updateTag(id: number, name: string, color: string): Promise<void> {
  await request(`/tags/${id}`, {
    method: 'PUT',
    body: JSON.stringify({ name, color }),
  });
}

export async function deleteTag(id: number): Promise<void> {
  await request(`/tags/${id}`, { method: 'DELETE' });
}

export async function addPaperTag(
  paperId: number,
  tagId: number
): Promise<void> {
  await request(`/papers/${paperId}/tags`, {
    method: 'POST',
    body: JSON.stringify({ tag_id: tagId }),
  });
}

export async function removePaperTag(
  paperId: number,
  tagId: number
): Promise<void> {
  await request(`/papers/${paperId}/tags/${tagId}`, {
    method: 'DELETE',
  });
}

export async function getPaperTags(paperId: number): Promise<Tag[]> {
  return request(`/papers/${paperId}/tags`);
}

// Export
export function getBibtexUrl(paperId?: number, download = true, paperIds?: number[]): string {
  if (paperId) {
    return `${BASE}/export/bibtex/${paperId}?download=${download}`;
  }
  const params = new URLSearchParams({ download: String(download) });
  if (paperIds && paperIds.length > 0) {
    params.set('ids', paperIds.join(','));
  }
  return `${BASE}/export/bibtex?${params}`;
}

export async function getBibtexText(paperId: number): Promise<string> {
  const res = await fetch(`${BASE}/export/bibtex/${paperId}`);
  return res.text();
}

export async function markExported(paperId: number): Promise<void> {
  await request(`/export/mark-exported/${paperId}`, { method: 'POST' });
}

export async function importBibtex(bibtex: string): Promise<{
  papers_added: number;
  papers_skipped: number;
  tags_applied: number;
  comments_added: number;
  total_entries: number;
  errors: string[];
}> {
  return request('/export/import-bibtex', {
    method: 'POST',
    body: JSON.stringify({ bibtex }),
  });
}

// Favorite Authors
export async function getFavoriteAuthors(): Promise<FavoriteAuthor[]> {
  return request('/authors/favorites');
}

export async function addFavoriteAuthor(name: string): Promise<FavoriteAuthor> {
  return request('/authors/favorites', {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
}

export async function removeFavoriteAuthor(id: number): Promise<void> {
  await request(`/authors/favorites/${id}`, { method: 'DELETE' });
}

export async function getFavoriteAuthorPublications(): Promise<{ papers: (ArxivPaper & { matchedAuthor: string })[] }> {
  return request('/authors/favorites/publications');
}

// Chat
export interface ChatResponse {
  message: string;
  model?: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

export async function sendChatMessage(
  messages: ChatMessage[],
  apiKey: string,
  paperContext: {
    title: string;
    summary: string;
    authors: string[];
    categories: string[];
    arxivId: string;
  }
): Promise<ChatResponse> {
  return request('/chat', {
    method: 'POST',
    body: JSON.stringify({ messages, apiKey, paperContext }),
  });
}

export async function verifyApiKey(apiKey: string): Promise<{ valid: boolean; error?: string }> {
  return request('/chat/verify-key', {
    method: 'POST',
    body: JSON.stringify({ apiKey }),
  });
}

// Worldline Chat
export async function sendWorldlineChatMessage(
  messages: ChatMessage[],
  apiKey: string,
  worldlineContext: {
    worldlineName: string;
    papers: { title: string; authors: string[]; summary: string; arxivId: string }[];
  }
): Promise<ChatResponse> {
  return request('/chat/worldline', {
    method: 'POST',
    body: JSON.stringify({ messages, apiKey, worldlineContext }),
  });
}

// Worldline Chat History (server-side)
export async function getWorldlineChatSessions(worldlineId: number): Promise<WorldlineChatSession[]> {
  const sessions = await request<any[]>(`/chat/sessions/worldline/${worldlineId}`);
  return sessions.map(s => ({
    id: s.id,
    worldlineId: s.worldline_id,
    worldlineName: s.worldline_name,
    messages: s.messages,
    createdAt: s.created_at,
    updatedAt: s.updated_at,
  }));
}

export async function getWorldlineChatSession(sessionId: string): Promise<WorldlineChatSession | undefined> {
  try {
    const s = await request<any>(`/chat/sessions/${sessionId}`);
    return {
      id: s.id,
      worldlineId: s.worldline_id,
      worldlineName: s.worldline_name,
      messages: s.messages,
      createdAt: s.created_at,
      updatedAt: s.updated_at,
    };
  } catch {
    return undefined;
  }
}

export async function saveWorldlineChatSession(session: WorldlineChatSession): Promise<void> {
  // Check if session exists; if not, create it
  const existing = await getWorldlineChatSession(session.id);
  if (!existing) {
    await request('/chat/sessions', {
      method: 'POST',
      body: JSON.stringify({
        id: session.id,
        worldline_id: session.worldlineId,
        worldline_name: session.worldlineName,
        session_type: 'worldline',
      }),
    });
  }
  // Add new messages (server stores them incrementally)
  const existingCount = existing?.messages?.length ?? 0;
  const newMessages = session.messages.slice(existingCount);
  if (newMessages.length > 0) {
    await request(`/chat/sessions/${session.id}/messages/batch`, {
      method: 'POST',
      body: JSON.stringify({ messages: newMessages }),
    });
  }
}

export async function deleteWorldlineChatSession(sessionId: string): Promise<void> {
  await request(`/chat/sessions/${sessionId}`, { method: 'DELETE' });
}

// Worldlines
export async function getWorldlines(): Promise<Worldline[]> {
  return request('/worldlines');
}

export async function createWorldline(name: string, color: string): Promise<Worldline> {
  return request('/worldlines', {
    method: 'POST',
    body: JSON.stringify({ name, color }),
  });
}

export async function updateWorldline(id: number, name: string, color: string): Promise<void> {
  await request(`/worldlines/${id}`, {
    method: 'PUT',
    body: JSON.stringify({ name, color }),
  });
}

export async function deleteWorldline(id: number): Promise<void> {
  await request(`/worldlines/${id}`, { method: 'DELETE' });
}

export async function getWorldlinePapers(worldlineId: number): Promise<SavedPaper[]> {
  return request(`/worldlines/${worldlineId}/papers`);
}

export async function addWorldlinePaper(worldlineId: number, paperId: number, position: number): Promise<void> {
  await request(`/worldlines/${worldlineId}/papers`, {
    method: 'POST',
    body: JSON.stringify({ paper_id: paperId, position }),
  });
}

export async function removeWorldlinePaper(worldlineId: number, paperId: number): Promise<void> {
  await request(`/worldlines/${worldlineId}/papers/${paperId}`, { method: 'DELETE' });
}

// Batch Import
export async function batchImport(
  arxivIds: string[],
  options?: {
    worldlineIds?: number[];
    newWorldlines?: Array<{ name: string; color: string }>;
    tagIds?: number[];
  }
): Promise<{
  success: boolean;
  papers_added: number;
  worldline_ids: number[];
  tags_applied: number;
  errors: string[];
}> {
  const body: Record<string, unknown> = { arxiv_ids: arxivIds };
  if (options?.worldlineIds && options.worldlineIds.length > 0) {
    body.worldline_ids = options.worldlineIds;
  }
  if (options?.newWorldlines && options.newWorldlines.length > 0) {
    body.new_worldlines = options.newWorldlines;
  }
  if (options?.tagIds && options.tagIds.length > 0) {
    body.tag_ids = options.tagIds;
  }
  return request('/worldlines/batch-import', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

// Related Papers (same worldline)
export async function getRelatedPaperArxivIds(arxivId: string): Promise<{ arxivId: string; title: string }[]> {
  return request(`/worldlines/related-papers/${encodeURIComponent(arxivId)}`);
}

// Worldline Similarity
export async function checkWorldlineSimilarity(
  papers: { id: string; title: string; summary: string }[],
  threshold: number,
  category?: string
): Promise<PaperSimilarityResult[]> {
  const data = await request<{ results: PaperSimilarityResult[] }>('/worldlines/similarity', {
    method: 'POST',
    body: JSON.stringify({ papers, threshold, category }),
  });
  return data.results;
}

// Settings
// Server-side: claudeApiKey, similarityThreshold
// Client-side (localStorage): colorScheme, cardFontSize (visual preferences)
const VISUAL_PREFS_KEY = 'navigate-visual-prefs';

export interface AppSettings {
  claudeApiKey: string;
  colorScheme: string;
  similarityThreshold: number;
  cardFontSize: number;
}

const DEFAULT_SETTINGS: AppSettings = {
  claudeApiKey: '',
  colorScheme: 'default-dark',
  similarityThreshold: 0.82,
  cardFontSize: 1,
};

interface VisualPrefs {
  colorScheme: string;
  cardFontSize: number;
}

function getVisualPrefs(): VisualPrefs {
  try {
    const stored = localStorage.getItem(VISUAL_PREFS_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      // Migrate old string values to numeric
      if (typeof parsed.cardFontSize === 'string') {
        const migration: Record<string, number> = { small: 0.85, medium: 1, large: 1.2 };
        parsed.cardFontSize = migration[parsed.cardFontSize] ?? 1;
      }
      return { colorScheme: 'default-dark', cardFontSize: 1, ...parsed };
    }
  } catch {}
  return { colorScheme: 'default-dark', cardFontSize: 1 };
}

function saveVisualPrefs(prefs: VisualPrefs): void {
  localStorage.setItem(VISUAL_PREFS_KEY, JSON.stringify(prefs));
}

export async function getSettings(): Promise<AppSettings> {
  const visualPrefs = getVisualPrefs();
  try {
    const serverSettings = await request<Record<string, string>>('/settings');
    return {
      claudeApiKey: serverSettings.claudeApiKey || '',
      similarityThreshold: serverSettings.similarityThreshold
        ? parseFloat(serverSettings.similarityThreshold)
        : DEFAULT_SETTINGS.similarityThreshold,
      colorScheme: visualPrefs.colorScheme,
      cardFontSize: visualPrefs.cardFontSize,
    };
  } catch {
    return { ...DEFAULT_SETTINGS, ...visualPrefs };
  }
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  // Save visual prefs to localStorage
  saveVisualPrefs({ colorScheme: settings.colorScheme, cardFontSize: settings.cardFontSize });
  // Save data settings to server
  await request('/settings', {
    method: 'PUT',
    body: JSON.stringify({
      claudeApiKey: settings.claudeApiKey,
      similarityThreshold: String(settings.similarityThreshold),
    }),
  });
}

// Synchronous getter for visual prefs only (used during initial render)
export function getVisualPrefsSync(): VisualPrefs {
  return getVisualPrefs();
}

export function applyCardFontSize(size: number): void {
  document.documentElement.style.setProperty('--card-font-scale', String(size));
}

// Chat History (server-side)
function mapServerChatSession(s: any): ChatSession {
  return {
    id: s.id,
    arxivId: s.arxiv_id,
    paperTitle: s.paper_title,
    messages: s.messages,
    createdAt: s.created_at,
    updatedAt: s.updated_at,
  };
}

export async function getAllChatSessions(): Promise<ChatSession[]> {
  const sessions = await request<any[]>('/chat/sessions');
  return sessions.map(mapServerChatSession);
}

export async function getChatSessionsForPaper(arxivId: string): Promise<ChatSession[]> {
  const sessions = await request<any[]>(`/chat/sessions/paper/${encodeURIComponent(arxivId)}`);
  return sessions.map(mapServerChatSession);
}

export async function getChatSession(sessionId: string): Promise<ChatSession | undefined> {
  try {
    const s = await request<any>(`/chat/sessions/${sessionId}`);
    return mapServerChatSession(s);
  } catch {
    return undefined;
  }
}

export async function saveChatSession(session: ChatSession): Promise<void> {
  // Check if session exists; if not, create it
  const existing = await getChatSession(session.id);
  if (!existing) {
    await request('/chat/sessions', {
      method: 'POST',
      body: JSON.stringify({
        id: session.id,
        arxiv_id: session.arxivId,
        paper_title: session.paperTitle,
        session_type: 'paper',
      }),
    });
  }
  // Add new messages incrementally
  const existingCount = existing?.messages?.length ?? 0;
  const newMessages = session.messages.slice(existingCount);
  if (newMessages.length > 0) {
    await request(`/chat/sessions/${session.id}/messages/batch`, {
      method: 'POST',
      body: JSON.stringify({ messages: newMessages }),
    });
  }
}

export async function deleteChatSession(sessionId: string): Promise<void> {
  await request(`/chat/sessions/${sessionId}`, { method: 'DELETE' });
}

export async function deleteAllChatSessionsForPaper(arxivId: string): Promise<void> {
  await request(`/chat/sessions/paper/${encodeURIComponent(arxivId)}`, { method: 'DELETE' });
}
