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

/** Per-side margins to hide, as fractions of the rendered page's own size. */
export interface CropBox {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export const NO_CROP: CropBox = { top: 0, right: 0, bottom: 0, left: 0 };

/** How pages are trimmed.
 *  - `off`     — pages render whole
 *  - `uniform` — one automatically measured box for the whole document
 *  - `page`    — each page trimmed to its own measured content box */
export type TrimMode = 'off' | 'uniform' | 'page';

export function hasCrop(crop: CropBox): boolean {
  return crop.top > 0 || crop.right > 0 || crop.bottom > 0 || crop.left > 0;
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
  /** Frozen at the session's first message; see ChatContextMode. */
  contextMode?: ChatContextMode;
  backend?: ChatBackend;
  model?: string;
}

export type ChatBackend = 'cli' | 'api';

/**
 * What the model was actually given for this conversation, resolved once at
 * session creation and then frozen — switching mid-session would invalidate the
 * CLI session and its 1-hour prompt cache.
 *
 *  tex      — the paper's flattened LaTeX source. Half the tokens of the PDF and
 *             the better half: macros, \label'led equations, real structure.
 *  pdf      — no usable source (a PDF-only arXiv submission, or an upload).
 *  abstract — neither could be fetched. Surfaced rather than hidden.
 */
export type ChatContextMode = 'tex' | 'pdf' | 'abstract';

export interface ChatTurnMeta {
  backend: ChatBackend;
  model: string;
  contextMode: ChatContextMode;
  /** False on the turn that primes the session (the expensive one). */
  primed: boolean;
  warnings: string[];
}

export interface ChatTurnResult extends ChatTurnMeta {
  message: string;
  usage: ChatMessageUsage;
  /** True when a lost model session had to be primed again mid-conversation. */
  reprimed: boolean;
}

export interface ChatBackendStatus {
  backend: ChatBackend;
  model: string;
  effort: string;
  contextMode: string;
  cli: { present: boolean; version?: string; path: string; error?: string };
  auth: { loggedIn: boolean; method?: string; subscription?: string; error?: string };
  apiKeyPresent: boolean;
  cwd: string;
  /** Can this machine answer a message right now? */
  ready: boolean;
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

// --- Walkthroughs (generated interactive explainers) -------------------------

export type WalkthroughStatus = 'pending' | 'building' | 'ready' | 'failed' | 'unfit';
export type WalkthroughFitness = 'strong' | 'partial' | 'none';
export type WalkthroughVisualKind =
  | 'none' | 'plot2d' | 'field' | 'graph' | 'geometry' | 'process' | 'custom';

export interface WalkthroughScene {
  title: string;
  narration: string;
  /** Equation/theorem labels from the paper's own structure map. */
  equations: string[];
  visual: { kind: WalkthroughVisualKind; spec: string };
  sourceRefs: { section: string; page?: number }[];
}

export interface WalkthroughOutline {
  fitness: { verdict: WalkthroughFitness; reason: string };
  thesis: string;
  scenes: WalkthroughScene[];
}

export interface Walkthrough {
  id: number;
  arxivId: string;
  status: WalkthroughStatus;
  fitness: WalkthroughFitness | null;
  outline: WalkthroughOutline | null;
  /** The arXiv version the source was taken from, e.g. 'v7'. */
  sourceVersion: string | null;
  contractVersion: string | null;
  hasBundle: boolean;
  /** Distillation losses, degraded source, WebGL caveats. */
  warnings: string[];
  model: string | null;
  /** 'cli' billed the local Claude Code plan; 'api' billed the API account. */
  backend: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
    outline_cost: number;
    build_cost: number;
    estimated_cost: number;
  };
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WalkthroughPaperState {
  arxivId: string;
  /** The newest ready build, or the newest row when nothing has been built. */
  current: Walkthrough | null;
  all: Walkthrough[];
  contractVersion: string;
  model: string;
  maxScenes: number;
  backend: 'cli' | 'api';
  budgetUsd: number;
  effort: string;
}

/** One progress event from a running build, as delivered over SSE. */
export type WalkthroughBuildEvent =
  | { type: 'stage'; stage: string; detail?: string }
  | { type: 'delta'; text: string }
  | { type: 'tool'; name: string; detail?: string }
  /** A tool's outcome. `ok: false` is how a permission refusal becomes visible. */
  | { type: 'tool_result'; ok: boolean; detail?: string }
  | { type: 'tokens'; output_tokens: number }
  | { type: 'error'; message: string }
  | { type: 'status'; status: 'queued' | 'running' | 'done' | 'error'; detail?: string };
