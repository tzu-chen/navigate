import { ArxivPaper, SavedPaper, Comment, CommentWithPaper, Tag, CategoryGroup, FavoriteAuthor, ChatBackend, ChatBackendStatus, ChatMessage, ChatSession, ChatTurnMeta, ChatTurnResult, WorldlineChatSession, Worldline, PaperSimilarityResult, ScoutScanResult, TrimMode, Walkthrough, WalkthroughBuildEvent, WalkthroughGalleryItem, WalkthroughOutline, WalkthroughPaperState } from '../types';
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

// --- Chat --------------------------------------------------------------------
//
// A turn is a server-sent event stream, not a JSON body. Two consequences for
// callers:
//
//  - **The transcript is no longer sent.** The server owns the conversation:
//    it holds the CLI session the model is resuming, and the paper it was
//    primed with. Sending `{ sessionId, message }` is the whole request, and
//    the server persists both messages itself — so a caller does not save the
//    turn afterwards, it just reloads.
//  - `EventSource` cannot POST, so this reads the response body directly.

export interface ChatStreamHandlers {
  /** Fires once, before the first token: which backend, model and context mode. */
  onMeta?: (meta: ChatTurnMeta) => void;
  onDelta: (text: string) => void;
  onDone: (result: ChatTurnResult) => void;
  onError: (message: string) => void;
}

/** Returns an abort function; aborting also kills the model call server-side. */
function streamChat(path: string, body: unknown, handlers: ChatStreamHandlers): () => void {
  const controller = new AbortController();

  (async () => {
    let settled = false;
    try {
      const res = await fetch(`${BASE}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      // A request rejected before the stream opens still answers with JSON.
      if (!res.ok || !res.body) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || 'Request failed');
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffered = '';

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffered += decoder.decode(value, { stream: true });

        let split: number;
        while ((split = buffered.indexOf('\n\n')) !== -1) {
          const frame = buffered.slice(0, split);
          buffered = buffered.slice(split + 2);
          const line = frame.split('\n').find(l => l.startsWith('data:'));
          if (!line) continue;

          let event: any;
          try {
            event = JSON.parse(line.slice(5).trim());
          } catch {
            continue;
          }

          if (event.type === 'meta') handlers.onMeta?.(event as ChatTurnMeta);
          else if (event.type === 'delta') handlers.onDelta(String(event.text ?? ''));
          else if (event.type === 'done') {
            settled = true;
            handlers.onDone(event as ChatTurnResult);
          } else if (event.type === 'error') {
            settled = true;
            handlers.onError(String(event.message ?? 'Failed to get a response.'));
          }
        }
      }

      if (!settled) handlers.onError('The response ended before it finished.');
    } catch (err: any) {
      if (controller.signal.aborted) return;
      handlers.onError(err?.message || 'Failed to get a response from Claude');
    }
  })();

  return () => controller.abort();
}

export function streamChatMessage(
  sessionId: string,
  message: string,
  paperContext: {
    title: string;
    summary: string;
    authors: string[];
    categories: string[];
    arxivId: string;
  },
  handlers: ChatStreamHandlers,
  apiKey?: string
): () => void {
  return streamChat('/chat', { sessionId, message, paperContext, apiKey }, handlers);
}

export function streamWorldlineChatMessage(
  sessionId: string,
  message: string,
  worldlineContext: {
    worldlineId: number;
    worldlineName: string;
    papers: { title: string; authors: string[]; summary: string; arxivId: string }[];
  },
  handlers: ChatStreamHandlers,
  apiKey?: string
): () => void {
  return streamChat('/chat/worldline', { sessionId, message, worldlineContext, apiKey }, handlers);
}

export async function verifyApiKey(apiKey: string): Promise<{ valid: boolean; error?: string }> {
  return request('/chat/verify-key', {
    method: 'POST',
    body: JSON.stringify({ apiKey }),
  });
}

/**
 * Can this machine answer a message at all? On the `cli` backend there is no
 * API key to check, so Settings checks the binary and its credentials instead.
 * Both probes are local and cost nothing.
 */
export async function getChatBackendStatus(): Promise<ChatBackendStatus> {
  return request('/chat/backend-status');
}

/**
 * Chat settings live server-side alongside `scoutBackend` and the walkthrough
 * group, and outside `AppSettings` for the same reason: a self-contained group
 * with its own panel.
 *
 * Changing any of these affects **new sessions only**. An existing session
 * keeps the model, backend and frozen prompt it was created with, because a
 * resume under different ones would miss the cache at best and fail at worst.
 */
export interface ChatSettings {
  backend: ChatBackend;
  model: string;
  effort: 'low' | 'medium' | 'high';
  /** The *preference*; the actual mode still falls back per paper. */
  contextMode: 'tex' | 'pdf';
}

export const DEFAULT_CHAT_SETTINGS: ChatSettings = {
  backend: 'cli',
  model: 'claude-opus-5',
  effort: 'medium',
  contextMode: 'tex',
};

export async function getChatSettings(): Promise<ChatSettings> {
  try {
    const s = await request<Record<string, string>>('/settings');
    const effort = s.chatEffort;
    return {
      backend: s.chatBackend === 'api' ? 'api' : 'cli',
      model: s.chatModel || DEFAULT_CHAT_SETTINGS.model,
      effort: effort === 'low' || effort === 'medium' || effort === 'high' ? effort : 'medium',
      contextMode: s.chatContextMode === 'pdf' ? 'pdf' : 'tex',
    };
  } catch {
    return { ...DEFAULT_CHAT_SETTINGS };
  }
}

export async function saveChatSettings(settings: ChatSettings): Promise<void> {
  await request('/settings', {
    method: 'PUT',
    body: JSON.stringify({
      chatBackend: settings.backend,
      chatModel: settings.model,
      chatEffort: settings.effort,
      chatContextMode: settings.contextMode,
    }),
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
    contextMode: s.context_mode ?? undefined,
    backend: s.backend ?? undefined,
    model: s.model ?? undefined,
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

// `getChatSession` and `saveChatSession` are gone: a turn is written server-side
// as part of the stream, so the client never assembles or uploads a transcript.

export async function deleteChatSession(sessionId: string): Promise<void> {
  await request(`/chat/sessions/${sessionId}`, { method: 'DELETE' });
}

export async function deleteAllChatSessionsForPaper(arxivId: string): Promise<void> {
  await request(`/chat/sessions/paper/${encodeURIComponent(arxivId)}`, { method: 'DELETE' });
}

// --- Walkthroughs ------------------------------------------------------------
//
// Routes are action-first (`/walkthrough/build/<id>`, not `/walkthrough/<id>/build`)
// because arXiv ids contain slashes: `hep-th/9711200` under a trailing path
// segment is ambiguous. The id still goes through encodeURIComponent for the
// query-unsafe characters.

function wtPath(action: string, arxivId: string): string {
  // Slashes are meaningful here — the route matches them with a wildcard — so
  // only the genuinely unsafe characters are escaped.
  return `/walkthrough/${action}/${arxivId.split('/').map(encodeURIComponent).join('/')}`;
}

export async function getWalkthroughsForPaper(arxivId: string): Promise<WalkthroughPaperState> {
  return request(wtPath('paper', arxivId));
}

/** The cheap structured pass with the fitness gate. Idempotent per source + contract. */
export async function outlineWalkthrough(
  arxivId: string,
  force = false
): Promise<Walkthrough & { cached: boolean; contextMode?: string }> {
  return request(wtPath('outline', arxivId), {
    method: 'POST',
    body: JSON.stringify({ force }),
  });
}

/** Edit the outline before paying for a build — the main quality lever. */
export async function saveWalkthroughOutline(
  id: number,
  outline: WalkthroughOutline,
  knownLabels: string[]
): Promise<Walkthrough> {
  return request(`/walkthrough/row/${id}/outline`, {
    method: 'PUT',
    body: JSON.stringify({ outline, knownLabels }),
  });
}

export async function buildWalkthrough(
  arxivId: string,
  walkthroughId: number,
  force = false
): Promise<{ jobId?: string; walkthroughId?: number; reused?: boolean; cached?: boolean; walkthrough?: Walkthrough }> {
  return request(wtPath('build', arxivId), {
    method: 'POST',
    body: JSON.stringify({ walkthroughId, force }),
  });
}

export async function deleteWalkthrough(id: number): Promise<void> {
  await request(`/walkthrough/row/${id}`, { method: 'DELETE' });
}

export function getWalkthroughBundleUrl(id: number): string {
  return `${BASE}/walkthrough/row/${id}/bundle`;
}

/** Every paper that has a walkthrough, one entry each, for the gallery tab. */
export async function getWalkthroughGallery(): Promise<{
  items: WalkthroughGalleryItem[];
  contractVersion: string;
  model: string;
}> {
  return request('/walkthrough/gallery');
}

/** Which papers have a walkthrough, for the Library indicator. */
export async function getWalkthroughIndicators(): Promise<{ arxiv_id: string; status: string }[]> {
  return request('/walkthrough/indicators');
}

export async function getWalkthroughRuns(limit = 50): Promise<{
  model: string;
  contractVersion: string;
  runs: {
    id: number; arxivId: string; status: string; fitness: string | null;
    model: string | null; backend: string | null; sceneCount: number;
    outlineCost: number; buildCost: number; estimatedCost: number;
    error: string | null; createdAt: string;
  }[];
}> {
  return request(`/walkthrough/runs?limit=${limit}`);
}

/**
 * Follow a build over SSE. Returns an abort function.
 *
 * A build is minutes and dollars, so progress is not optional: the caller gets
 * every stage, tool call and text delta as it happens, and a terminal callback
 * carrying the finished row.
 */
export function streamWalkthroughBuild(
  jobId: string,
  handlers: {
    onEvent: (event: WalkthroughBuildEvent) => void;
    onComplete: (result: { status: string; walkthrough: Walkthrough | null }) => void;
    onError: (message: string) => void;
  }
): () => void {
  const source = new EventSource(`${BASE}/walkthrough/job/${jobId}/stream`);

  source.onmessage = e => {
    try {
      handlers.onEvent(JSON.parse(e.data) as WalkthroughBuildEvent);
    } catch {
      /* a malformed frame is not worth tearing the stream down for */
    }
  };
  source.addEventListener('complete', e => {
    try {
      handlers.onComplete(JSON.parse((e as MessageEvent).data));
    } catch {
      handlers.onComplete({ status: 'error', walkthrough: null });
    }
    source.close();
  });
  source.onerror = () => {
    // EventSource retries on its own; only a closed stream is a real failure.
    if (source.readyState === EventSource.CLOSED) {
      handlers.onError('Lost the connection to the build.');
    }
  };

  return () => source.close();
}

/**
 * Walkthrough settings live server-side alongside `scoutBackend`, and outside
 * `AppSettings` for the same reason `pdfTrimMode` does: they are a self-contained
 * group with their own panel, not part of the shape every caller loads.
 */
export interface WalkthroughSettings {
  /** 'cli' bills the Claude Code plan and needs no key; 'api' for headless/keyed deploys. */
  backend: 'cli' | 'api';
  /** Hard per-build cost ceiling, passed to the CLI as --max-budget-usd. */
  budgetUsd: number;
  effort: 'low' | 'medium' | 'high';
  /** Offer a build on Scout findings at or above this score. 0 disables the offer. */
  scoutThreshold: number;
}

export const DEFAULT_WALKTHROUGH_SETTINGS: WalkthroughSettings = {
  backend: 'cli',
  budgetUsd: 1.5,
  effort: 'high',
  scoutThreshold: 0,
};

export async function getWalkthroughSettings(): Promise<WalkthroughSettings> {
  try {
    const s = await request<Record<string, string>>('/settings');
    const budget = parseFloat(s.walkthroughBudgetUsd);
    const threshold = parseInt(s.walkthroughScoutThreshold, 10);
    const effort = s.walkthroughEffort;
    return {
      backend: s.walkthroughBackend === 'api' ? 'api' : 'cli',
      budgetUsd: Number.isFinite(budget) && budget > 0 ? budget : DEFAULT_WALKTHROUGH_SETTINGS.budgetUsd,
      effort: effort === 'low' || effort === 'medium' || effort === 'high' ? effort : 'high',
      scoutThreshold: Number.isFinite(threshold) ? Math.max(0, Math.min(100, threshold)) : 0,
    };
  } catch {
    return { ...DEFAULT_WALKTHROUGH_SETTINGS };
  }
}

export async function saveWalkthroughSettings(settings: WalkthroughSettings): Promise<void> {
  await request('/settings', {
    method: 'PUT',
    body: JSON.stringify({
      walkthroughBackend: settings.backend,
      walkthroughBudgetUsd: String(settings.budgetUsd),
      walkthroughEffort: settings.effort,
      walkthroughScoutThreshold: String(settings.scoutThreshold),
    }),
  });
}
