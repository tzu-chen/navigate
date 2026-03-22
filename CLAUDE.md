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

The Vite dev server proxies `/api` requests to `http://localhost:3001`. No `.env` files are used — the only server environment variable is `PORT` (defaults to 3001). The Claude API key is stored client-side in localStorage.

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
    │   ├── index.ts              # Express entry point, mounts 8 route modules
    │   ├── types.ts              # Mirrors client types + category constants
    │   ├── routes/               # 8 RESTful route handlers
    │   └── services/             # Business logic (DB, ArXiv API, PDF, export, similarity)
    └── data/                     # Runtime data (gitignored)
        ├── papers.db             # SQLite database
        └── pdfs/                 # Downloaded PDF files
```

### Client (`client/src/`)

* **App.tsx** — Root component managing 6 view modes: `browse`, `library`, `authors`, `viewer`, `chatHistory`, `worldline`. Holds global state for papers, tags, and favorite authors. Initializes color scheme and font size from localStorage on mount.
* **components/** — 17 components:
  + `PaperBrowser` — Search/browse with category filters, query, pagination
  + `Library` — Saved papers list with status/tag filters, multi-select bulk operations
  + `PaperViewer` — Main reader: PDFViewer on left, tabbed sidebar (chat, comments, tags, export, info, worldline, import) on right. Supports immersive mode and browse-context navigation.
  + `PDFViewer` — react-pdf integration with page controls, search, annotations
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
* **types.ts** — Shared TypeScript interfaces (`ArxivPaper`, `SavedPaper`, `ChatSession`, `Tag`, `Worldline`, etc.). Note: `authors` and `categories` are JSON strings in `SavedPaper` (parsed in routes). Defines `ARXIV_CATEGORY_GROUPS` constant with 14 groups and 140+ subcategories.
* **colorSchemes.ts** — 8 theme definitions (default-dark, solarized-dark/light, nord-dark/light, dracula-dark/light, one-dark-pro) applied via CSS custom properties.

### Server (`server/src/`)

* **index.ts** — Express entry point. CORS enabled, JSON body parser (10MB limit). Mounts 8 route modules under `/api`. Serves static client build from `client/dist/` in production with SPA fallback. Initializes database and PDF storage on startup.
* **routes/** — RESTful route handlers:
  + `arxiv.ts` — Search, categories, latest/recent papers, single paper fetch, PDF proxy (avoids CORS)
  + `papers.ts` — Full CRUD for saved papers + bulk operations (download-pdfs, delete-pdfs, delete, status, add-tag, remove-tag) + sub-routes for comments and tags
  + `tags.ts` — Tag CRUD (name is UNIQUE)
  + `chat.ts` — Claude AI proxy. Fetches PDF (cached 30min in memory), sends to Anthropic API with paper context and related worldline papers. Model: `claude-sonnet-4-20250514`, max_tokens: 2048. Also handles worldline-level chat (no PDF, titles + abstracts only) and API key verification.
  + `authors.ts` — Favorite authors + batch-fetches recent publications (concurrency limit: 3)
  + `export.ts` — BibTeX and Paperpile JSON generation. Citation key format: `{LastName}{Year}{ArxivId}`. Embeds tags as keywords and comments as notes.
  + `worldlines.ts` — Worldline CRUD, paper assignment with position ordering, SPECTER embedding similarity scoring (see Similarity System below), batch import from ArXiv
  + `settings.ts` — Key-value settings CRUD (API key, similarity threshold, etc.)
* **services/** — Business logic layer:
  + `database.ts` — SQLite with better-sqlite3. WAL mode, foreign keys enabled. 40+ query functions, all parameterized. Schema created/migrated in `initializeDatabase()`.
  + `arxiv.ts` — ArXiv REST API client (`http://export.arxiv.org/api/query`). XML parsing via xml2js. Functions for search, author search, single paper fetch, latest (RSS), and recent (HTML scraping).
  + `chat.ts` — Anthropic API integration with PDF base64 encoding and ephemeral prompt caching (`cache_control: { type: 'ephemeral' }`). Note: the Anthropic SDK is NOT a direct dependency — the server calls the Anthropic REST API via fetch, forwarding the API key from client-side settings.
  + `pdf.ts` — PDF storage management under `server/data/pdfs/`. Download, store, delete, path resolution. ArXiv IDs escaped (`/` → `_`) for filenames.
  + `similarity.ts` — SPECTER-based semantic similarity (see Similarity System below).
  + `paperpile.ts` — BibTeX/Paperpile export formatting with author name parsing.

### Similarity System

**Status: migrating from TF-IDF to SPECTER embeddings.**

The previous implementation in `similarity.ts` used custom TF-IDF cosine similarity (tokenize → remove stop words → compute TF-IDF → cosine similarity, title weighted 2x). This produced too many false positives because bag-of-words methods cannot distinguish semantic relevance from superficial keyword overlap.

**New approach: SPECTER embeddings via `@huggingface/transformers`.**

SPECTER (`allenai/specter`) is a SciBERT-based model trained on citation-linked scientific papers. It produces 768-dim embeddings that capture "this paper is related to that paper" semantics far better than keyword overlap. We use the ONNX variant via `@huggingface/transformers` (formerly `@xenova/transformers`) to keep everything in Node — no Python sidecar needed.

**Key design decisions:**

* **Input format:** SPECTER expects title and abstract concatenated as a single string (`title + ' ' + abstract`). Do not encode them separately.
* **Embedding cache:** Embeddings are stored in the `paper_embeddings` table in SQLite as JSON-serialized float arrays. Embeddings are computed lazily — on first similarity request for a paper that lacks a cached embedding — and then stored. Worldline embeddings are the mean of their constituent paper embeddings, recomputed when papers are added/removed.
* **Similarity scoring:** Cosine similarity on SPECTER embeddings replaces the old TF-IDF cosine similarity. The similarity threshold setting in the `settings` table still applies but the scale is different — SPECTER cosine similarities tend to be higher and more clustered than TF-IDF, so the default threshold needs recalibration (expect useful range ~0.75–0.92 rather than the old ~0.1–0.5).
* **Model loading:** The `@huggingface/transformers` pipeline is initialized once at server startup (or on first use) and cached in memory. First load downloads the ONNX model to a local cache directory. Subsequent loads are instant.
* **Fallback:** If embedding computation fails (e.g., model download issue), log the error and fall back to the old TF-IDF implementation so the app remains functional.

**Schema addition:**

```sql
CREATE TABLE IF NOT EXISTS paper_embeddings (
    arxiv_id TEXT PRIMARY KEY,
    embedding TEXT NOT NULL,  -- JSON-serialized float array (768 dims)
    model_version TEXT NOT NULL DEFAULT 'specter-v1',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_paper_embeddings_model ON paper_embeddings(model_version);
```

The `model_version` column allows invalidating the cache if the model is swapped (e.g., upgrading to SPECTER2 or a different model). When `model_version` changes, stale embeddings should be recomputed.

**Dependencies added:** `@huggingface/transformers` (server-side only).

### Database Schema (`server/data/papers.db`)

SQLite database created at runtime. 11 tables with cascade deletion:

| Table | Key Columns | Constraints |
| --- | --- | --- |
| `papers` | id, arxiv_id, title, summary, authors, published, status, pdf_path | arxiv_id UNIQUE, status CHECK ('new','reading','reviewed','exported') |
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

Indices on: `papers.arxiv_id`, `comments.paper_id`, `paper_tags.paper_id`, `paper_tags.tag_id`, `worldline_papers.worldline_id`, `worldline_papers.paper_id`, `chat_sessions.arxiv_id`, `chat_sessions.worldline_id`, `chat_sessions.session_type`, `paper_embeddings.model_version`.

### Storage Split

**Important:** The project was originally client-side only, storing everything in localStorage. Most data has since been migrated server-side. Do not introduce new localStorage keys for persistent data — use the server-side settings or database instead.

* **Server-side (SQLite)**: Papers, comments, tags, authors, worldlines, chat sessions + messages, settings (Claude API key, similarity threshold), paper embeddings
* **Client-side (localStorage)**: Only visual preferences that affect rendering before API loads — color scheme and card font size (`paperpile-navigate-visual-prefs`)

## Key Dependencies

**Frontend:** React 18.3, Vite 6, TypeScript 5.7, react-pdf 9.1, react-markdown 10.1, better-react-mathjax 2.4, d3 7.9

**Backend:** Express 4.21, TypeScript 5.7, better-sqlite3 11.7, xml2js 0.6, cors 2.8, @huggingface/transformers (SPECTER ONNX inference), tsx 4.19 (dev)

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
