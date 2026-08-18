# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Development Commands

```
npm run install:all       # Install dependencies for root, server/, and client/
npm run dev               # Start both frontend (Vite) and backend (Express) concurrently
npm run dev:server        # Backend only (Express on port 3001, uses tsx watch for hot reload)
npm run dev:client        # Frontend only (Vite on port 5173)
npm run build             # Build both client and server for production
npm run build:client      # Build frontend only (tsc && vite build)
npm run build:server      # Build backend only (tsc)
npm start                 # Start production server (serves API + built frontend from client/dist/)
```

The Vite dev server proxies `/api` requests to `http://localhost:3001`. No `.env` files are used. Server environment variables: `PORT` (defaults to 3001), `SUITE_DATA_ROOT` (optional, part of the suite data-centralization scheme), `CLAUDE_CLI_PATH` (optional, overrides where Scout looks for the `claude` binary), and `SIMILARITY_NUM_THREADS` (optional, caps the SPECTER2 ONNX intra-op thread pool; defaults to 2 to keep CPU/fan in check). The Claude API key is stored client-side in localStorage.

**`SUITE_DATA_ROOT` (data location).** The data directory is resolved in one place — `server/src/services/paths.ts` (imported by `database.ts` and `pdf.ts`). When `SUITE_DATA_ROOT` is set, data lives at `$SUITE_DATA_ROOT/navigate/` (`papers.db`, `pdfs/`, `pdf-cache/`); when unset, it falls back **byte-for-byte** to the legacy in-repo `server/data/`. Do not duplicate or "fix" this path — add new data under `DATA_DIR` from `paths.ts`.

## Architecture Overview

Full-stack TypeScript app: React 18 + Vite frontend, Express + SQLite backend. Manages academic papers from ArXiv with AI-powered analysis via Claude API.

**Historical note:** This project was originally a client-side-only React app with all data stored in localStorage. It was later migrated to a full-stack architecture with an Express backend and SQLite database. Most state now lives server-side, but a few visual preferences remain in localStorage (see Storage Split below). When working on features, always use the server-side API and database — do not add new localStorage usage for data that should be persistent or shared across sessions.

```
paperpile-navigate/
├── package.json          # Root scripts (concurrently for dev, install:all)
├── client/               # React frontend (Vite)
│   ├── src/
│   │   ├── main.tsx              # Entry point (React StrictMode + MathJax context)
│   │   ├── App.tsx               # Root component, 6 view modes, global state
│   │   ├── types.ts              # Shared interfaces + ARXIV_CATEGORY_GROUPS
│   │   ├── colorSchemes.ts       # 8 theme definitions with CSS custom properties
│   │   ├── styles/main.css       # Global styles, CSS variables, layout
│   │   ├── components/           # 17 React components
│   │   └── services/api.ts       # Centralized HTTP client + localStorage helpers
│   └── vite.config.ts            # Vite config with /api proxy to port 3001
└── server/               # Express backend
    ├── src/
    │   ├── index.ts              # Express entry point, mounts 10 route modules
    │   ├── types.ts              # Mirrors client types + category constants
    │   ├── routes/               # 10 RESTful route handlers
    │   └── services/             # Business logic (DB, ArXiv API, PDF, export, similarity)
    └── data/                     # Runtime data (gitignored)
        ├── papers.db             # SQLite database
        └── pdfs/                 # Downloaded PDF files
```

### Client (`client/src/`)

* **App.tsx** — Root component managing 6 view modes: `browse`, `library`, `authors`, `viewer`, `chatHistory`, `worldline`. Holds global state for papers, tags, and favorite authors. Initializes color scheme and font size from localStorage on mount.
* **components/** — 18 components:
  + `PaperBrowser` — Search/browse with category filters, query, pagination
  + `Library` — Saved papers list with tag/worldline/tier filters, multi-select bulk operations, unified import panel, and selection-driven export
  + `ImportPanel` — Tabbed panel combining ArXiv ID batch import, BibTeX import, and PDF upload
  + `PaperViewer` — Main reader: PDFViewer on left, tabbed sidebar (chat, comments, tags, export, info, worldline, import) on right. Supports immersive mode and browse-context navigation.
  + `PDFViewer` — react-pdf integration with page controls, search, annotations, and the trim-view menu (see Page Trimming below)
  + `ChatPanel` — Conversation UI with markdown rendering and token usage display
  + `ChatHistory` — Lists all chat sessions per paper
  + `CommentPanel` — Per-page annotations with edit/delete
  + `TagPanel` — Add/remove tags on current paper
  + `ExportPanel` — BibTeX and Paperpile JSON export
  + `WorldlinePanel` — Worldline CRUD with D3 network visualization
  + `WorldlineSidebarPanel` — Paper list within a worldline with drag-drop reordering
  + `WorldlineInfoPanel` — Info panel for worldline viewer
  + `FavoriteAuthors` — Author management and publications feed
  + `SettingsModal` — API key, theme, similarity threshold, font size
  + `BatchImportPanel` — Bulk paper import with worldline/tag assignment
  + `ArxivRefreshTimer` — Countdown to next ArXiv announcement
  + `LaTeX` — MathJax wrapper component
* **services/api.ts** — Centralized API client (~630 lines). All backend calls go through a `request<T>()` helper with automatic JSON serialization. Includes functions for chat sessions, settings, and visual preference helpers (localStorage for color scheme and font size only).
* **types.ts** — Shared TypeScript interfaces (`ArxivPaper`, `SavedPaper`, `ChatSession`, `Tag`, `Worldline`, `CropBox`/`TrimMode`, etc.). Note: `authors` and `categories` are JSON strings in `SavedPaper` (parsed in routes). Defines `ARXIV_CATEGORY_GROUPS` constant with 14 groups and 140+ subcategories.
* **utils/autoTrim.ts**, **hooks/useAutoTrim.ts** — margin detection and the measuring loop behind page trimming (see Page Trimming below).
* **colorSchemes.ts** — 8 theme definitions (default-dark, solarized-dark/light, nord-dark/light, dracula-dark/light, one-dark-pro) applied via CSS custom properties.

### Server (`server/src/`)

* **index.ts** — Express entry point. CORS enabled, JSON body parser (10MB limit). Mounts 10 route modules under `/api`. Serves static client build from `client/dist/` in production with SPA fallback. Initializes database and PDF storage on startup.
* **routes/** — RESTful route handlers:
  + `arxiv.ts` — Search, categories, latest/recent papers, single paper fetch, PDF proxy (avoids CORS)
  + `papers.ts` — Full CRUD for saved papers + bulk operations (download-pdfs, delete-pdfs, delete, tier, add-tag, remove-tag) + sub-routes for comments and tags
  + `tags.ts` — Tag CRUD (name is UNIQUE)
  + `chat.ts` — Claude AI proxy. Fetches PDF (cached 30min in memory), sends to Anthropic API with paper context and related worldline papers. Model: `claude-sonnet-4-20250514`, max_tokens: 2048. Also handles worldline-level chat (no PDF, titles + abstracts only) and API key verification.
  + `authors.ts` — Favorite authors + batch-fetches recent publications (concurrency limit: 3)
  + `export.ts` — BibTeX and Paperpile JSON generation. Citation key format: `{LastName}{Year}{ArxivId}`. Embeds tags as keywords and comments as notes. Also streams a ZIP archive of selected local PDFs (`GET /api/export/pdfs?ids=`).
  + `worldlines.ts` — Worldline CRUD, paper assignment with position ordering, embedding similarity scoring + flag log/dismiss/stats (see Similarity System below), batch import from ArXiv
  + `settings.ts` — Key-value settings CRUD (API key, similarity threshold, etc.)
  + `scribe.ts` — Hands selected papers' PDFs off to the Scribe app (`http://localhost:3003`) and deletes them locally
  + `scout.ts` — Opus-5 listing triage: `POST /scan` (idempotent per listing), `GET /runs` (diagnostics). See Scout below.
* **services/** — Business logic layer:
  + `database.ts` — SQLite with better-sqlite3. WAL mode, foreign keys enabled. 40+ query functions, all parameterized. Schema created/migrated in `initializeDatabase()`.
  + `arxiv.ts` — ArXiv REST API client (`http://export.arxiv.org/api/query`). XML parsing via xml2js. Functions for search, author search, single paper fetch, latest (RSS), and recent (HTML scraping).
  + `chat.ts` — Anthropic API integration with PDF base64 encoding and ephemeral prompt caching (`cache_control: { type: 'ephemeral' }`). Note: the Anthropic SDK is NOT a direct dependency — the server calls the Anthropic REST API via fetch, forwarding the API key from client-side settings.
  + `pdf.ts` — PDF storage management under `server/data/pdfs/`. Download, store, delete, path resolution. ArXiv IDs escaped (`/` → `_`) for filenames.
  + `similarity.ts` — embedding backends + similarity orchestration; `similarity-core.ts` holds the pure, unit-testable decision logic (see Similarity System below).
  + `paperpile.ts` — BibTeX/Paperpile export formatting with author name parsing.
  + `scout.ts` — library profile + Opus-5 listing triage over two backends (`claude -p` subprocess, or the REST API). See Scout below.

### Similarity System

**Precision-first embedding matching of browse papers to worldlines.** The goal is to flag only papers that *distinctively* belong to one thread, accepting missed recall over a daily spray of false positives. (History: this replaced an absolute-threshold centroid scorer, which itself replaced a TF-IDF cosine scorer — both over-fired. See `worldline-similarity-overhaul.md` for the full rationale.)

**Two files:**

* `similarity-core.ts` — **pure, model-independent, dependency-free** decision logic (no DB, no model imports), so it is unit-verifiable in isolation: `cosineSimilarity`, `nearestMemberScore`, `worldlineCohesion`, `matchWorldlines`, `applyExclusivityMargin`, and the text/author `corroborate` (+ `tokenize`, `documentFrequencies`, `normalizeAuthor`).
* `similarity.ts` — embedding backends + the orchestration that wires the core into the request flow and the SQLite caches.

**The pipeline, per browse paper, against every worldline:**

1. **Nearest-member score** — `s(p,W) = max over members m of cos(emb_p, emb_m)`. Not a centroid (a centroid of a multi-subtopic thread drifts toward the global mean and over-fires).
2. **Per-thread cohesion gate + self-margin** — keep `W` only if `s(p,W) ≥ cohesion(W) + selfMargin`, where `cohesion(W)` is the `cohesionPercentile`-th (default **0.75**) percentile of each member's nearest-sibling cosine, and `selfMargin` (default **0.02**) requires the paper to be *more tightly bound to the thread than the thread is to itself*. Self-calibrating: tight threads demand tight matches. This replaces the old single global threshold; the `settings` threshold is now only the fallback bar for <2-member threads. **The self-margin is the gate that actually bites** in the common single-candidate case (a paper near exactly one thread), which the runner-up margin below cannot catch — with SPECTER2's high, clustered similarities, a plain median cohesion bar admits a flood of same-subtopic papers.
3. **Exclusivity margin** — when a paper clears more than one thread, keep only the argmax and only if it beats the runner-up by ≥ `margin` (default 0.02). Result: **≤1 match per browse paper.**
4. **Required corroboration** — the embedding match must be backed by one concrete overlap: a shared author with a thread member, **or** ≥ `k` (default **3**) shared *distinctive* terms (corpus document-frequency fraction ≤ `distinctiveDfMax`, default **0.15**; the generic-ML stopword set cannot count).

**Tuning knobs** (request params on `POST /api/worldlines/similarity`): `cohesionPercentile`, `selfMargin`, `margin`, `k`. The defaults are **precision-first/low-recall** by design — your worldlines are subtopics and you browse the same categories, so the embedding cannot separate "in this subtopic" from "belongs to this thread"; the strict gate keeps the flood out at the cost of recall. Tune from the flag log + `npm run diagnose --prefix server` (which prints per-thread cohesion, cross-thread leakage, and a tuning simulation over logged flags) rather than guessing. A genuinely better precision signal (citations) remains future work.

**Opt-in (off by default).** Embedding similarity is **disabled by default** because it runs on CPU and re-embeds each newly-browsed category — left on, it pegs every core and spins the fan. The `similarityEnabled` setting (Settings → Worldline Similarity) gates it; when off, `PaperBrowser` makes no `/similarity` request, so the model is never even loaded. GPU acceleration is **not available** on this box: `onnxruntime-node`'s Linux build ships only CPU/CUDA/TensorRT providers (NVIDIA-only), and the machine's GPU is an AMD 7900XTX (would need a ROCm source build or a Python sidecar). The CPU cost is instead bounded by `SIMILARITY_NUM_THREADS` (default 2) capping the ONNX intra-op pool.

**Embedding backend** (`similarity.ts`): primary is **SPECTER2-proximity** (`adamlabadorf/specter2-proximity-onnx`) — citation-trained scientific paper embeddings whose proximity adapter is baked into the ONNX graph — run via **`onnxruntime-node` on CPU (no Python, no GPU)**. Inputs `input_ids`+`attention_mask`, output a pooled 768-d vector we L2-normalize. The session is created with `intraOpNumThreads: SIMILARITY_NUM_THREADS` / `interOpNumThreads: 1` / `executionMode: 'sequential'`. The tokenizer comes from `benchoi93/specter2-base-onnx-web` via `@huggingface/transformers`. If SPECTER2 fails to load, it falls back to the **all-MiniLM** transformers.js pipeline; if even that fails, similarity returns no flags (never a weaker scorer).

* **Input format:** title and abstract concatenated (`title + ' ' + abstract`).
* **Model cache:** the ONNX files (~441MB) download lazily on first use into `DATA_DIR/model-cache/specter2-proximity/` (so they follow `SUITE_DATA_ROOT`). First use re-embeds existing members under the new version; subsequent loads are instant.
* **Embedding cache + versioning:** vectors live in `paper_embeddings`, keyed by the **active backend's version string** (`specter2-proximity-v1` or `all-MiniLM-L6-v2`). This is critical: tagging by the producing backend means a fallback can never mix 768-d and 384-d vectors in the cache. Browse-paper embeddings are cached too (the same paper recurs across days/categories). Cohesion is recomputed per request from cached member embeddings (cheap); the route's result cache is invalidated on membership change.

**Instrumentation (`flag_log` table):** every flag writes a row `(arxiv_id, worldline_id, score, runner_up_score, margin, corroboration_kind, category, flagged_at, accepted, decided_at)` via `logFlag` (idempotent — `INSERT OR IGNORE` on `UNIQUE(arxiv_id, worldline_id)`). Assigning a paper to a worldline marks the flag **accepted** (`markFlagAccepted`, hooked into `POST /:id/papers` and batch-import); the browse-view × dismisses it (`markFlagDismissed` → `POST /api/worldlines/flag/dismiss`, only-if-pending). `GET /api/worldlines/flag-stats` returns acceptance rate overall and per category (diagnostic, not a cap). Use this accept/reject history to fit `cohesionPercentile`/`δ`/`k`.

**Schema addition:**

```sql
CREATE TABLE IF NOT EXISTS paper_embeddings (
    arxiv_id TEXT PRIMARY KEY,
    embedding TEXT NOT NULL,  -- JSON-serialized float array (768-d SPECTER2 / 384-d MiniLM)
    model_version TEXT NOT NULL DEFAULT 'specter-v1',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_paper_embeddings_model ON paper_embeddings(model_version);
```

To swap models, change the backend's `version` string in `similarity.ts`; the version mismatch makes `getEmbeddings` recompute lazily under the new tag.

**Verification:** `npm run verify:similarity --prefix server` runs the model-independent unit harness over `similarity-core.ts` (Phases 1–3, incl. an isolated temp-DB test of the flag log via `SUITE_DATA_ROOT`). `npm run verify:specter2 --prefix server` is the model gate — it loads the active backend and checks a related paper pair scores clearly above an unrelated one. Both live in `server/scripts/`.

**Dependencies added:** `@huggingface/transformers` (tokenizer + MiniLM fallback) and `onnxruntime-node` (SPECTER2 ONNX inference), server-side only.

### Scout (Opus-5 listing triage)

**On-demand LLM triage of a browse listing against the whole library.** Where the Similarity System asks the narrow, cheap, local question *"does this paper belong to an existing worldline?"*, Scout asks the judgement-shaped one — *"given everything I've saved and how I rated it, is this worth my attention today?"* — which needs a model that can read an abstract. Same precision-first stance: it is capped at **8 findings**, told that "same subfield as something you saved" is not a reason, and told that an empty result is a correct answer on an ordinary day.

**Two files:** `services/scout.ts` (library profile, prompt, model call, output normalization) and `routes/scout.ts` (idempotency, persistence, error mapping).

**Flow.** The browse page's ⚡ **Scan listing** button posts the *currently displayed* papers (the active announcement tab, favorites feed, or search page) to `POST /api/scout/scan`. The server builds a **library profile** — worldlines with member titles, T0/T1-rated saves, tags, followed authors, recent saves, library size — renders it into a cached system prompt, and sends the candidates as the user turn. Findings come back as `{arxivId, score (0–100), headline, reason, connections[]}` and are rendered as a highlighted block on the matching paper card, with a "Show only flagged" filter.

**No redundant runs (the core constraint).** Every run is stored in `scout_runs`, keyed by `sha256(category | sorted candidate arXiv IDs)` — the identity of *the exact listing triaged*. Pressing the button again while arXiv hasn't announced returns the stored verdict with `cached: true` and **no API call** (it doesn't even need an API key). A new announcement changes the ID set, hence the key, hence a fresh run. Concurrent requests for the same key are coalesced in memory, so a double-click can't become two paid calls. `force: true` (the **Rescan** button) overrides and upserts the row.

The run also stores a **library fingerprint** (a hash of the rendered profile). It deliberately does *not* participate in the cache key — saving a paper mid-session should not silently re-bill the listing — but a mismatch surfaces as `libraryChanged: true`, which the status bar shows as "library changed since" next to Rescan.

**Two backends**, selected by the `scoutBackend` setting (server-side, via `PUT /api/settings/scoutBackend`):

* **`cli` (default)** — shells out to `claude -p`. Scans bill against the local **Claude Code subscription** rather than metered API credits, and no API key has to be stored. Requires the `claude` CLI on the server process's PATH (override with the `CLAUDE_CLI_PATH` env var).
* **`api`** — posts to the Anthropic REST API with the stored `claudeApiKey`, the way `chat.ts` does. For a headless deploy with no CLI, or when scans should bill to the API account.

Both produce the same validated `ScoutFinding[]`; the backend used is recorded on the run and returned to the client, because the cost figure means different things on each.

**Model call — `cli`.** `buildCliArgs()` assembles: `-p --output-format json --model claude-opus-5 --effort medium --tools "" --system-prompt <scout prompt> --json-schema <findings schema> --no-session-persistence --strict-mcp-config`. Three of those matter:

* `--system-prompt` **replaces** Claude Code's coding-agent prompt — this is a text-judgement task, not a coding session.
* `--tools ""` disables every built-in tool. Nothing here should touch the filesystem or network.
* `--json-schema` is the CLI's structured-output validation, so the envelope comes back with a parsed `structured_output` object plus real `usage` and a `total_cost_usd` the CLI computes itself.

⚠️ **The subprocess must run from a neutral cwd** (`os.tmpdir()`). Claude Code auto-discovers `CLAUDE.md` by walking up from its working directory, so spawning inside this repo silently prepends ~10k tokens of project context to *every* scan — measured at 10,835 vs 602 cached tokens ($0.11 vs $0.008) for an identical trivial prompt.

**Model call — `api`.** `claude-opus-5` via REST (no SDK). Adaptive thinking is on by default on Opus 5 and `max_tokens` (16000) bounds thinking + output together. `output_config.effort: 'medium'` — Opus 5 is unusually strong at the lower effort levels and this is a bounded judgement task. Output is constrained with `output_config.format`; if that parameter is rejected with a 400 the call retries once asking for JSON in the prompt, since `normalizeFindings` validates either way.

`normalizeFindings` is the trust boundary for both backends: findings naming a paper that wasn't in the candidate set (or a duplicate) are dropped, scores clamped to 0–100, results capped and sorted.

**Cost.** Listings are capped at **120 candidates** (`MAX_CANDIDATES`) and abstracts truncated to 1200 chars; the response reports how many were skipped. On the `api` backend the system prompt carries a `cache_control: ephemeral` breakpoint so back-to-back scans on an unchanged library re-read that prefix; the CLI caches the same prefix on its own (observed 1h ephemeral). Per-run token usage and cost are stored and shown in the status bar — prefixed `≈` on the `cli` backend, where the figure is the **list-price equivalent** of work billed to the plan, not money charged to an API account. `GET /api/scout/runs` lists recent runs for spend/finding history.

**Verification:** `npm run verify:scout --prefix server` covers everything that doesn't need a model call — scan-key identity (order-insensitive, set-sensitive), library fingerprinting, the run store's upsert-on-rescan, model-output normalization, and the CLI argument vector — against an isolated temp DB via `SUITE_DATA_ROOT`.

### Page Trimming (auto-crop)

**Hides a PDF's margins so the text fills the viewer.** Ported from Scribe's Trim View (itself modelled on Okular's `View → Trim View`), and tuned for papers rather than scanned books. Measured over this library, trimming keeps ~70% of the page area, which is ~1.25× wider text at the same window size.

Two client-side files, no server work beyond one setting:

* `client/src/utils/autoTrim.ts` — the detector. Pure and pdf.js-free apart from two structural interfaces (`TrimDocument`/`TrimPage`), so it isn't pinned to the pdfjs-dist version react-pdf owns transitively. A page is rendered at 320px wide onto an off-screen canvas, background luminance is estimated from the border ring, and the ink bounding box is taken with a 1-pass erosion plus a row/column ink gate so margin specks can't defeat it. Pages that measure untrustworthy (blank, a lone page number, <15% content) return `null` and are skipped rather than trusted. Boxes are `CropBox` fractions in viewer space and are in-memory only.
* `client/src/hooks/useAutoTrim.ts` — the measuring loop: a queue pumped between `requestIdleCallback`s (measuring competes with the viewer's own rendering), a per-document cache, and a generation counter so a document swap abandons in-flight results.

**Modes** (`TrimMode`, chosen from the toolbar's ⧉ crop menu; re-picking the active one turns trimming off):

* **`uniform`** — one box for the whole document. It measures **every page** (capped at `MAX_UNIFORM_PAGES` = 400, above which it falls back to a spread sample) and applies **nothing until the sweep completes** — the toolbar shows "measuring…" meanwhile. This is required, not conservative: the box is the *smallest* margin found, so a partial sweep would be tighter than the document allows and would clip. `uniformComplete` is derived from the attempt count, so a sweep interrupted by switching trimming off resumes and is never applied half-done.
* **`page`** — Okular's literal behaviour: each page trimmed to its own box, measured lazily in a window around the reading position (with an 8-page spread as the backing sample). Pages then differ in size. Useful for the occasional scanned submission whose content wanders, and for a paper where one full-bleed page spoils the uniform box.

**Two deliberate departures from Scribe** (both in `aggregateCrops`, with the reasoning in the code):

1. **No per-parity box.** Scribe keeps separate odd/even boxes because a bound book alternates its gutter. arXiv PDFs are single-sided, so one box is correct — and it keeps every page the same size, which is what lets the viewer size off-screen page placeholders from a single page height.
2. **A plain minimum, not the minimum of the *typical* pages.** Scribe discards pages whose margin is under half the median so a full-bleed illustration can't reopen the crop for a whole book. On papers that filter only over-trims, because the pages it calls atypical are wide figures, tables and display equations — content, not decoration. Measured over 25 papers from this library (every page of each): the filter clipped content on 3 of them, up to 4.7% of the page width, while trimming no more on average than the plain minimum (70.0% vs 70.4% of page area kept). The minimum also carries a guarantee worth having — **no measured page has its content clipped** — at the cost that a genuinely full-bleed page disables trimming on that side (use `page` mode there).

**Marginal stamps are not content (`skipMarginBand`).** arXiv prints the paper's ID down the left margin of every preprint's first page, in rotated ~9pt type outside the text block. To a plain bounding box that is ink like any other — and since the document box is the *smallest* margin on any page, that one page reopened the left margin for the whole paper. This was the cause of the wide left gutter trimming used to leave. The stamp is discarded by shape rather than by page number, so the same rule catches line numbers on a review copy or a journal's submission stamp, on either side: the outermost run of inked columns is skipped only when it is **thin** (≤6% of the page), **ends within 15% of the page edge**, is **separated from the body by ≥0.6% blank page**, and is **≥8× taller than it is wide**. Content that reaches the margin (a wide figure, a full-bleed table) fails all of those and still opens the box up as before. The four bounds are fitted to the 219 stamped first pages in this library, measured from their text layers with `pdftotext -bbox` — thickness p50 0.029/max 0.037, reach max 0.075, gap min 0.008/p05 0.028, aspect min 18 — each set clear of the observed worst case, with the most slack on thickness because a rendered stamp is a block or two fatter than its glyph boxes once antialiased. Rows are then counted across the surviving columns only, since the banner routinely overhangs the text block vertically and would otherwise pin the top and bottom too.

**How the crop is applied.** The page renders whole inside a smaller `.pdf-page-crop` box (`overflow: clip`) with a negative offset, so pdf.js's geometry, the text layer, link annotations and every stored comment rect keep their full-page coordinates — nothing about trimming touches persisted data. Consequences handled in `PDFViewer`:

* **Fit-to-width** divides by the surviving width fraction, so trimming actually buys reading size instead of leaving empty gutter. It always uses the document-wide box, even in `page` mode, or the zoom would jitter as per-page measurements landed. The refit runs in a `useLayoutEffect` (same paint, no flash) and re-scrolls to the current page, since the geometry moved under the reader.
* **Off-screen page placeholders** shrink to the trimmed height, or scrolling would jump as pages mounted.
* **Text-selection page attribution** tests the *visible* box, not the page element: a trimmed page's element still overhangs its clip box and would otherwise claim its neighbour's selections.
* **The comment overlay** stays outside the clipping box, offset onto the full page's frame, so a tooltip anchored to the first line can still overflow above the page.

**Persistence.** The mode lives in the `settings` table as `pdfTrimMode` — server-side and **global**, not per paper: arXiv PDFs are homogeneous, so a reader who wants margins gone wants them gone everywhere, and a per-paper box would be re-measured to the same answer each time.

**Not ported:** Scribe's manual crop overlay (drag-the-edges) and its export-with-crop, which needs `pdf-lib`. Navigate hands PDFs to Scribe for that.

**Verification:** `npm run verify:autotrim --prefix server` runs the detector and the aggregation over synthetic pages — no pdf.js, no canvas, no PDFs — covering measurement geometry, polarity independence (dark scans), blank/scrap rejection, dust erosion, marginal-stamp rejection (including each guard that keeps real margin content), and the never-clip property of the document box.

### Database Schema (`server/data/papers.db`)

SQLite database created at runtime. 13 tables with cascade deletion:

| Table | Key Columns | Constraints |
| --- | --- | --- |
| `papers` | id, arxiv_id, title, summary, authors, published, pdf_path, tier | arxiv_id UNIQUE, tier CHECK (NULL OR 0–4) |
| `comments` | id, paper_id, content, page_number | FK→papers CASCADE |
| `tags` | id, name, color | name UNIQUE, color DEFAULT '#6366f1' |
| `paper_tags` | paper_id, tag_id | Composite PK, both FK CASCADE |
| `favorite_authors` | id, name, added_at | name UNIQUE |
| `worldlines` | id, name, color, created_at | — |
| `worldline_papers` | worldline_id, paper_id, position | Composite PK, both FK CASCADE |
| `chat_sessions` | id, arxiv_id, paper_title, worldline_id, session_type, created_at, updated_at | session_type CHECK ('paper','worldline') |
| `chat_messages` | id, session_id, role, content, token_usage, created_at | FK→chat_sessions CASCADE |
| `settings` | key, value | key PRIMARY KEY (UNIQUE) |
| `paper_embeddings` | arxiv_id, embedding, model_version, created_at | arxiv_id PRIMARY KEY |
| `flag_log` | id, arxiv_id, worldline_id, score, runner_up_score, margin, corroboration_kind, category, flagged_at, accepted, decided_at | UNIQUE(arxiv_id, worldline_id), FK→worldlines CASCADE |
| `scout_runs` | id, cache_key, category, scanned_ids, paper_count, library_fingerprint, model, backend, findings, token counts, estimated_cost, created_at | cache_key UNIQUE (upserted on forced rescan) |

Indices on: `papers.arxiv_id`, `comments.paper_id`, `paper_tags.paper_id`, `paper_tags.tag_id`, `worldline_papers.worldline_id`, `worldline_papers.paper_id`, `chat_sessions.arxiv_id`, `chat_sessions.worldline_id`, `chat_sessions.session_type`, `paper_embeddings.model_version`, `flag_log.worldline_id`, `flag_log.category`, `flag_log.accepted`, `scout_runs.created_at`.

### Storage Split

**Important:** The project was originally client-side only, storing everything in localStorage. Most data has since been migrated server-side. Do not introduce new localStorage keys for persistent data — use the server-side settings or database instead.

* **Server-side (SQLite)**: Papers, comments, tags, authors, worldlines, chat sessions + messages, settings (Claude API key, similarity threshold, Scout backend, PDF trim mode), paper embeddings, worldline flag log, Scout runs
* **Client-side (localStorage)**: Only visual preferences that affect rendering before API loads — color scheme and card font size (`paperpile-navigate-visual-prefs`)

## Key Dependencies

**Frontend:** React 18.3, Vite 6, TypeScript 5.7, react-pdf 9.1, react-markdown 10.1, better-react-mathjax 2.4, d3 7.9

**Backend:** Express 4.21, TypeScript 5.7, better-sqlite3 11.7, xml2js 0.6, cors 2.8, @huggingface/transformers (tokenizer + all-MiniLM fallback), onnxruntime-node 1.21 (SPECTER2 ONNX inference), tsx 4.19 (dev)

## Conventions

### Code Style

* **TypeScript strict mode** enabled in both client and server tsconfig
* **Naming**: camelCase for variables/functions, PascalCase for components/interfaces/types, snake_case for database columns and table names, UPPER_CASE for constants
* **Imports**: Named imports from libraries, `* as api` / `* as db` for service modules, relative paths for local files
* **No linter or formatter config** — follow existing code style in each file

### API Patterns

* All routes under `/api` prefix, RESTful verbs (GET/POST/PUT/PATCH/DELETE)
* Parameterized SQL queries exclusively — no string interpolation in queries
* HTTP status codes: 201 (created), 400 (bad input), 404 (not found), 409 (conflict/duplicate), 500 (server error)
* Error responses: `{ error: 'descriptive message' }`
* Route-level try-catch wrapping all handlers

### React Patterns

* Functional components with hooks (useState, useEffect, useCallback, useRef)
* Props drilling from App.tsx (no context/store library)
* `showNotification(message)` callback for user-facing errors
* Async operations in useEffect or event handlers with try-catch

### Data Serialization

* `authors` and `categories` fields are JSON strings in the database and `SavedPaper` type
* Parsed to arrays in route handlers when needed
* Always use `JSON.parse()` / `JSON.stringify()` when reading/writing these fields

### Testing

No test framework is currently configured. Validate changes by running `npm run build` (runs `tsc` for both client and server, catching type errors).

Targeted verification harnesses live in `server/scripts/` and run against isolated temp data (`SUITE_DATA_ROOT`), never real data or the Claude API:

```
npm run verify:similarity --prefix server   # similarity-core decision logic + flag log
npm run verify:specter2   --prefix server   # loads the embedding model (the one gate that needs it)
npm run verify:scout      --prefix server   # Scout scan-key identity, fingerprint, run store, output normalization
npm run verify:autotrim   --prefix server   # margin detection + document-box aggregation (client code, synthetic pages)
```

`verify:autotrim` is the exception to "harnesses live server-side": it exercises `client/src/utils/autoTrim.ts`, which is pure and DOM-free in the parts that matter, and `server/`'s tsconfig only compiles `src/**`, so importing across the boundary from `scripts/` costs the server build nothing.
