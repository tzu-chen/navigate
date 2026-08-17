export interface ArxivPaper {
  id: string;
  title: string;
  summary: string;
  authors: string[];
  published: string;
  updated: string;
  categories: string[];
  pdfUrl: string;
  absUrl: string;
  doi?: string;
  journalRef?: string;
  announceType?: 'new' | 'cross' | 'replace' | 'replace-cross';
  listingDate?: string;
}

export interface SavedPaper {
  id: number;
  arxiv_id: string;
  title: string;
  summary: string;
  authors: string;
  published: string;
  updated: string;
  categories: string;
  pdf_url: string;
  abs_url: string;
  doi: string | null;
  journal_ref: string | null;
  added_at: string;
  pdf_path: string | null;
  tier: number | null;
  last_viewed_at: string | null;
}

export interface Comment {
  id: number;
  paper_id: number;
  content: string;
  page_number: number | null;
  selected_text: string | null;
  position_rects: string | null;
  created_at: string;
  updated_at: string;
}

export interface CommentPositionRect {
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CommentWithPaper extends Comment {
  arxiv_id: string;
  title: string;
  authors: string;
}

export interface Tag {
  id: number;
  name: string;
  color: string;
}

export interface FavoriteAuthor {
  id: number;
  name: string;
  added_at: string;
}

export interface CategoryGroup {
  label: string;
  categories: Record<string, string>;
}

export interface ChatMessageUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  estimated_cost?: number;
  model?: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  usage?: ChatMessageUsage;
}

export interface ChatSession {
  id: string;
  arxivId: string;
  paperTitle: string;
  messages: ChatMessage[];
  createdAt: string;
  updatedAt: string;
}

export interface Worldline {
  id: number;
  name: string;
  color: string;
  created_at: string;
}

export interface WorldlineSimilarityMatch {
  worldlineId: number;
  worldlineName: string;
  worldlineColor: string;
  score: number;
  runnerUpScore?: number | null;
  corroborationKind?: 'author' | 'terms';
}

export interface PaperSimilarityResult {
  paperId: string;
  matches: WorldlineSimilarityMatch[];
}

/** One preprint the Scout (Opus 5) judged worth surfacing, with its rationale. */
export interface ScoutFinding {
  arxivId: string;
  score: number;
  headline: string;
  reason: string;
  connections: string[];
}

export interface ScoutScanResult {
  findings: ScoutFinding[];
  /** True when this verdict came from a stored run rather than a fresh model call. */
  cached: boolean;
  /** The library changed since a cached scan ran, so a rescan may differ. */
  libraryChanged: boolean;
  scannedCount: number;
  truncated: number;
  model: string;
  /** 'cli' billed the local Claude Code plan; 'api' billed the API account. */
  backend: 'cli' | 'api';
  scannedAt: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
    estimated_cost: number;
  };
}

export interface WorldlineChatSession {
  id: string;
  worldlineId: number;
  worldlineName: string;
  messages: ChatMessage[];
  createdAt: string;
  updatedAt: string;
}

export type ViewMode = 'browse' | 'library' | 'authors' | 'viewer' | 'chatHistory' | 'worldline' | 'comments';
