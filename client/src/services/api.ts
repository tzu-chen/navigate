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

// Worldline Chat History (localStorage)
const WL_CHAT_HISTORY_KEY = 'paperpile-navigate-worldline-chat-history';

function loadAllWorldlineSessions(): WorldlineChatSession[] {
  try {
    const stored = localStorage.getItem(WL_CHAT_HISTORY_KEY);
    if (stored) return JSON.parse(stored);
  } catch {}
  return [];
}

function persistAllWorldlineSessions(sessions: WorldlineChatSession[]): void {
  localStorage.setItem(WL_CHAT_HISTORY_KEY, JSON.stringify(sessions));
}

export function getWorldlineChatSessions(worldlineId: number): WorldlineChatSession[] {
  return loadAllWorldlineSessions()
    .filter(s => s.worldlineId === worldlineId)
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

export function getWorldlineChatSession(sessionId: string): WorldlineChatSession | undefined {
  return loadAllWorldlineSessions().find(s => s.id === sessionId);
}

export function saveWorldlineChatSession(session: WorldlineChatSession): void {
  const sessions = loadAllWorldlineSessions();
  const idx = sessions.findIndex(s => s.id === session.id);
  if (idx >= 0) {
    sessions[idx] = session;
  } else {
    sessions.push(session);
  }
  persistAllWorldlineSessions(sessions);
}

export function deleteWorldlineChatSession(sessionId: string): void {
  const sessions = loadAllWorldlineSessions().filter(s => s.id !== sessionId);
  persistAllWorldlineSessions(sessions);
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
  threshold: number
): Promise<PaperSimilarityResult[]> {
  const data = await request<{ results: PaperSimilarityResult[] }>('/worldlines/similarity', {
    method: 'POST',
    body: JSON.stringify({ papers, threshold }),
  });
  return data.results;
}

// Settings (localStorage)
const SETTINGS_KEY = 'paperpile-navigate-settings';

export interface AppSettings {
  claudeApiKey: string;
  colorScheme: string;
  similarityThreshold: number;
  cardFontSize: 'small' | 'medium' | 'large';
}

const DEFAULT_SETTINGS: AppSettings = {
  claudeApiKey: '',
  colorScheme: 'default-dark',
  similarityThreshold: 0.15,
  cardFontSize: 'medium',
};

export function getSettings(): AppSettings {
  try {
    const stored = localStorage.getItem(SETTINGS_KEY);
    if (stored) return { ...DEFAULT_SETTINGS, ...JSON.parse(stored) };
  } catch {}
  return { ...DEFAULT_SETTINGS };
}

export function saveSettings(settings: AppSettings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

const FONT_SIZE_SCALES: Record<AppSettings['cardFontSize'], string> = {
  small: '0.85',
  medium: '1',
  large: '1.2',
};

export function applyCardFontSize(size: AppSettings['cardFontSize']): void {
  document.documentElement.style.setProperty('--card-font-scale', FONT_SIZE_SCALES[size] || '1');
}

// Chat History (localStorage)
const CHAT_HISTORY_KEY = 'paperpile-navigate-chat-history';

function loadAllSessions(): ChatSession[] {
  try {
    const stored = localStorage.getItem(CHAT_HISTORY_KEY);
    if (stored) return JSON.parse(stored);
  } catch {}
  return [];
}

function persistAllSessions(sessions: ChatSession[]): void {
  localStorage.setItem(CHAT_HISTORY_KEY, JSON.stringify(sessions));
}

export function getAllChatSessions(): ChatSession[] {
  return loadAllSessions().sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );
}

export function getChatSessionsForPaper(arxivId: string): ChatSession[] {
  return loadAllSessions()
    .filter(s => s.arxivId === arxivId)
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

export function getChatSession(sessionId: string): ChatSession | undefined {
  return loadAllSessions().find(s => s.id === sessionId);
}

export function saveChatSession(session: ChatSession): void {
  const sessions = loadAllSessions();
  const idx = sessions.findIndex(s => s.id === session.id);
  if (idx >= 0) {
    sessions[idx] = session;
  } else {
    sessions.push(session);
  }
  persistAllSessions(sessions);
}

export function deleteChatSession(sessionId: string): void {
  const sessions = loadAllSessions().filter(s => s.id !== sessionId);
  persistAllSessions(sessions);
}

export function deleteAllChatSessionsForPaper(arxivId: string): void {
  const sessions = loadAllSessions().filter(s => s.arxivId !== arxivId);
  persistAllSessions(sessions);
}
