import { ArxivPaper, SavedPaper, Comment, CommentWithPaper, Tag, CategoryGroup, FavoriteAuthor, ChatMessage, ChatSession, WorldlineChatSession, Worldline, PaperSimilarityResult, ScoutScanResult, TrimMode } from '../types';
import {
  coerceSchemeId,
  DEFAULT_SCHEME_ID,
  DEFAULT_LIGHT_SCHEME_ID,
  DEFAULT_DARK_SCHEME_ID,
} from '../colorSchemes';

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

export async function getFavoriteCategoriesFeed(): Promise<{
  papers: (ArxivPaper & { matchedCategories: string[] })[];
  totalResults: number;
  categories: string[];
  cached: boolean;
  fetchedAt?: string;
  errors?: string[];
}> {
  return request('/arxiv/favorites');
}

export async function getArxivPaper(id: string): Promise<ArxivPaper> {
  return request(`/arxiv/paper/${encodeURIComponent(id)}`);
}

export function getPdfProxyUrl(arxivId: string): string {
  return `${BASE}/arxiv/pdf-proxy/${arxivId}`;
}

// Papers (Library)
export async function getSavedPapers(filters?: {
  tag_id?: number;
  tier?: number | 'ungraded';
}): Promise<SavedPaper[]> {
  const qs = new URLSearchParams();
  if (filters?.tag_id) qs.set('tag_id', String(filters.tag_id));
  if (filters?.tier !== undefined) qs.set('tier', String(filters.tier));
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

export async function updatePaperTier(id: number, tier: number | null): Promise<void> {
  await request(`/papers/${id}/tier`, {
    method: 'PATCH',
    body: JSON.stringify({ tier }),
  });
}

export async function markPaperViewed(id: number): Promise<void> {
  await request(`/papers/${id}/view`, { method: 'POST' });
}

export async function bulkUpdateTier(paperIds: number[], tier: number | null): Promise<{
  success: boolean;
  updated: number;
}> {
  return request('/papers/bulk/tier', {
    method: 'POST',
    body: JSON.stringify({ paper_ids: paperIds, tier }),
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

export async function downloadLocalPdf(paperId: number): Promise<{ success: boolean; pdf_path: string }> {
  return request(`/papers/${paperId}/pdf`, { method: 'POST' });
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

export async function getAllComments(): Promise<CommentWithPaper[]> {
  return request('/papers/comments/all');
}

export async function addComment(
  paperId: number,
  content: string,
  pageNumber?: number | null,
  selectedText?: string | null,
  positionRects?: string | null
): Promise<{ id: number }> {
  return request(`/papers/${paperId}/comments`, {
    method: 'POST',
    body: JSON.stringify({
      content,
      page_number: pageNumber,
      selected_text: selectedText,
      position_rects: positionRects,
    }),
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

export async function getTagAssociations(): Promise<Record<number, number[]>> {
  return request('/tags/associations');
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

export function getPdfZipUrl(paperIds: number[]): string {
  const params = new URLSearchParams({ ids: paperIds.join(',') });
  return `${BASE}/export/pdfs?${params}`;
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

export async function getWorldlineAssociations(): Promise<Record<number, number[]>> {
  return request('/worldlines/associations');
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
  papers: { id: string; title: string; summary: string; authors: string[] }[],
  threshold: number,
  category?: string
): Promise<PaperSimilarityResult[]> {
  const data = await request<{ results: PaperSimilarityResult[] }>('/worldlines/similarity', {
    method: 'POST',
    body: JSON.stringify({ papers, threshold, category }),
  });
  return data.results;
}

// Reject a flagged (paper, worldline) suggestion from the browse view.
export async function dismissWorldlineFlag(arxivId: string, worldlineId: number): Promise<void> {
  await request('/worldlines/flag/dismiss', {
    method: 'POST',
    body: JSON.stringify({ arxiv_id: arxivId, worldline_id: worldlineId }),
  });
}

// Scout (Opus 5 listing triage)
// The server keys each scan on the exact set of preprints sent, so calling this
// again for an unchanged listing returns the stored verdict without an API call.
export async function scanWithScout(
  papers: { id: string; title: string; summary: string; authors: string[]; categories: string[] }[],
  category?: string,
  force = false
): Promise<ScoutScanResult> {
  return request('/scout/scan', {
    method: 'POST',
    body: JSON.stringify({ papers, category, force }),
  });
}

// Settings
// Server-side: claudeApiKey, similarityThreshold, favoriteCategories, pdfTrimMode
// Client-side (localStorage): colorScheme, cardFontSize, autoSwitch (visual preferences)
const VISUAL_PREFS_KEY = 'navigate-visual-prefs';

export interface AutoSwitchSettings {
  enabled: boolean;
  lightSchemeId: string;
  darkSchemeId: string;
  dayStartHour: number;
  nightStartHour: number;
}

export interface AppSettings {
  claudeApiKey: string;
  colorScheme: string;
  similarityEnabled: boolean;
  similarityThreshold: number;
  cardFontSize: number;
  favoriteCategories: string[];
  autoSwitch: AutoSwitchSettings;
}

export const MAX_FAVORITE_CATEGORIES = 5;

const DEFAULT_AUTO_SWITCH: AutoSwitchSettings = {
  enabled: false,
  lightSchemeId: DEFAULT_LIGHT_SCHEME_ID,
  darkSchemeId: DEFAULT_DARK_SCHEME_ID,
  dayStartHour: 7,
  nightStartHour: 19,
};

const DEFAULT_SETTINGS: AppSettings = {
  claudeApiKey: '',
  colorScheme: DEFAULT_SCHEME_ID,
  // Off by default: embedding similarity is CPU-intensive (SPECTER2 on CPU) and
  // precision-first/low-recall. Opt in from Settings → Worldline Similarity.
  similarityEnabled: false,
  similarityThreshold: 0.82,
  cardFontSize: 1,
  favoriteCategories: [],
  autoSwitch: DEFAULT_AUTO_SWITCH,
};

function parseFavoriteCategories(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map(c => c.trim())
    .filter(Boolean)
    .slice(0, MAX_FAVORITE_CATEGORIES);
}

interface VisualPrefs {
  colorScheme: string;
  cardFontSize: number;
  autoSwitch: AutoSwitchSettings;
}

function normalizeAutoSwitch(raw: any): AutoSwitchSettings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_AUTO_SWITCH };
  return {
    enabled: !!raw.enabled,
    lightSchemeId: coerceSchemeId(raw.lightSchemeId, DEFAULT_LIGHT_SCHEME_ID),
    darkSchemeId: coerceSchemeId(raw.darkSchemeId, DEFAULT_DARK_SCHEME_ID),
    dayStartHour: Number.isFinite(raw.dayStartHour) ? raw.dayStartHour : DEFAULT_AUTO_SWITCH.dayStartHour,
    nightStartHour: Number.isFinite(raw.nightStartHour) ? raw.nightStartHour : DEFAULT_AUTO_SWITCH.nightStartHour,
  };
}

function getVisualPrefs(): VisualPrefs {
  try {
    const stored = localStorage.getItem(VISUAL_PREFS_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      if (typeof parsed.cardFontSize === 'string') {
        const migration: Record<string, number> = { small: 0.85, medium: 1, large: 1.2 };
        parsed.cardFontSize = migration[parsed.cardFontSize] ?? 1;
      }
      return {
        colorScheme: coerceSchemeId(parsed.colorScheme, DEFAULT_SCHEME_ID),
        cardFontSize: typeof parsed.cardFontSize === 'number' ? parsed.cardFontSize : 1,
        autoSwitch: normalizeAutoSwitch(parsed.autoSwitch),
      };
    }
  } catch {}
  return { colorScheme: DEFAULT_SCHEME_ID, cardFontSize: 1, autoSwitch: { ...DEFAULT_AUTO_SWITCH } };
}

function saveVisualPrefs(prefs: VisualPrefs): void {
  localStorage.setItem(VISUAL_PREFS_KEY, JSON.stringify(prefs));
}

export function getSchemeForCurrentTime(settings: AutoSwitchSettings, now: Date = new Date()): string {
  const hour = now.getHours();
  const { dayStartHour, nightStartHour } = settings;
  if (dayStartHour <= nightStartHour) {
    return hour >= dayStartHour && hour < nightStartHour ? settings.lightSchemeId : settings.darkSchemeId;
  }
  // Wrap-around (e.g. day=22, night=6) — uncommon but handle gracefully.
  return hour >= dayStartHour || hour < nightStartHour ? settings.lightSchemeId : settings.darkSchemeId;
}

export async function getSettings(): Promise<AppSettings> {
  const visualPrefs = getVisualPrefs();
  try {
    const serverSettings = await request<Record<string, string>>('/settings');
    return {
      claudeApiKey: serverSettings.claudeApiKey || '',
      similarityEnabled: serverSettings.similarityEnabled === 'true',
      similarityThreshold: serverSettings.similarityThreshold
        ? parseFloat(serverSettings.similarityThreshold)
        : DEFAULT_SETTINGS.similarityThreshold,
      favoriteCategories: parseFavoriteCategories(serverSettings.favoriteCategories),
      colorScheme: visualPrefs.colorScheme,
      cardFontSize: visualPrefs.cardFontSize,
      autoSwitch: visualPrefs.autoSwitch,
    };
  } catch {
    return { ...DEFAULT_SETTINGS, ...visualPrefs };
  }
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  saveVisualPrefs({
    colorScheme: settings.colorScheme,
    cardFontSize: settings.cardFontSize,
    autoSwitch: settings.autoSwitch,
  });
  await request('/settings', {
    method: 'PUT',
    body: JSON.stringify({
      claudeApiKey: settings.claudeApiKey,
      similarityEnabled: String(settings.similarityEnabled),
      similarityThreshold: String(settings.similarityThreshold),
      favoriteCategories: settings.favoriteCategories.slice(0, MAX_FAVORITE_CATEGORIES).join(','),
    }),
  });
}

// Synchronous getter for visual prefs only (used during initial render)
export function getVisualPrefsSync(): VisualPrefs {
  return getVisualPrefs();
}

// PDF margin trimming. Stored server-side and globally rather than per paper:
// arXiv PDFs are homogeneous typeset output, so a reader who wants margins gone
// wants them gone in every paper, and a per-paper box would just be re-measured
// to the same answer each time.
export async function getTrimMode(): Promise<TrimMode> {
  try {
    const settings = await request<Record<string, string>>('/settings');
    const mode = settings.pdfTrimMode;
    return mode === 'uniform' || mode === 'page' ? mode : 'off';
  } catch {
    return 'off';
  }
}

export async function saveTrimMode(mode: TrimMode): Promise<void> {
  await request('/settings/pdfTrimMode', {
    method: 'PUT',
    body: JSON.stringify({ value: mode }),
  });
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
