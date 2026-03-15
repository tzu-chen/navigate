# Paperpile Navigate

A full-stack research reference management system for browsing, organizing, and analyzing academic papers from ArXiv. Features AI-powered paper analysis via Claude, PDF viewing with inline comments, and BibTeX/Paperpile export.

> **Note:** This project was originally a client-side-only React app with all data in localStorage. It has since been migrated to a full-stack architecture with an Express backend and SQLite database. All persistent data (papers, chat history, settings, etc.) now lives server-side, with only visual preferences (color scheme, font size) remaining in localStorage.

## Features

- **ArXiv Paper Browsing** — Search and filter papers by category or keyword directly from the ArXiv database
- **Personal Library** — Save papers and track their status (new, reading, reviewed, exported)
- **PDF Viewer** — Read papers inline with page-level commenting and annotation
- **Tagging System** — Organize papers with custom color-coded tags
- **Favorite Authors** — Follow researchers and get automatic feeds of their publications
- **AI Chat** — Analyze and discuss papers with Claude, with persistent server-side chat history and markdown-rendered responses
- **Worldlines** — Group related papers into thematic research threads with D3 network visualization and TF-IDF similarity scoring
- **BibTeX / Paperpile Export** — Generate BibTeX entries and Paperpile JSON, with tags as keywords and comments as notes
- **Batch Import** — Bulk import papers from ArXiv with worldline and tag assignment
- **Color Themes** — 8 built-in color schemes (dark and light variants)
- **Mobile Responsive** — iPhone-friendly responsive design

## Tech Stack

| Layer    | Technology                          |
| -------- | ----------------------------------- |
| Frontend | React 18, TypeScript, Vite          |
| Backend  | Express, TypeScript, better-sqlite3 |
| AI       | Claude API (Anthropic)              |
| Database | SQLite                              |

## Prerequisites

- [Node.js](https://nodejs.org/) (v18 or later recommended)
- npm (included with Node.js)
- A [Claude API key](https://console.anthropic.com/) (for the AI chat feature)

## Installation

1. **Clone the repository:**

   ```bash
   git clone https://github.com/tzu-chen/paperpile-navigate.git
   cd paperpile-navigate
   ```

2. **Install all dependencies** (root, server, and client):

   ```bash
   npm run install:all
   ```

   This runs `npm install` in the root directory, `server/`, and `client/` in sequence.

## Running the Application

### Development

Start both the frontend dev server and the backend simultaneously:

```bash
npm run dev
```

- Frontend: `http://localhost:5173`
- Backend: `http://localhost:3001`

The Vite dev server automatically proxies `/api` requests to the backend.

You can also run them independently:

```bash
npm run dev:server   # backend only
npm run dev:client   # frontend only
```

### Production

Build the project and start the production server:

```bash
npm run build
npm start
```

The Express server serves both the API and the built frontend from `client/dist/`.

## Configuration

- **Claude API Key** — Enter your key in the in-app Settings modal. It is stored in browser `localStorage` and sent with chat requests.
- **Port** — The backend defaults to port `3001`. Override it with the `PORT` environment variable.
- **Color Scheme** — Select a theme from the Settings modal. The preference is stored in `localStorage`.

## Project Structure

```
paperpile-navigate/
├── client/                 # React frontend (Vite)
│   ├── src/
│   │   ├── components/     # 17 UI components (PaperBrowser, Library, ChatPanel, etc.)
│   │   ├── services/       # API client (all backend calls via request<T>() helper)
│   │   ├── styles/         # Global CSS with CSS custom properties for theming
│   │   ├── App.tsx         # Root component with 6 view modes
│   │   ├── types.ts        # Shared TypeScript interfaces
│   │   └── colorSchemes.ts # 8 theme definitions
│   └── vite.config.ts      # Vite config with /api proxy to port 3001
├── server/                 # Express backend
│   ├── src/
│   │   ├── routes/         # 8 RESTful route modules (arxiv, papers, tags, chat, authors, export, worldlines, settings)
│   │   ├── services/       # Business logic (database, ArXiv API, chat, PDF, export, similarity)
│   │   └── index.ts        # Server entry point
│   ├── data/               # Runtime data (gitignored)
│   │   ├── papers.db       # SQLite database (10 tables)
│   │   └── pdfs/           # Downloaded PDF files
│   └── tsconfig.json
└── package.json            # Root scripts (concurrently for dev, install:all)
```

### Client–Server Split

All persistent data is stored server-side in SQLite. The client communicates with the server exclusively through REST API calls under `/api`. Only visual rendering preferences (color scheme, font size) are stored in localStorage to allow immediate theme application before the API loads.

| Data | Storage | Key / Endpoint |
|------|---------|----------------|
| Papers, comments, tags, authors, worldlines | Server (SQLite) | `/api/papers`, `/api/tags`, etc. |
| Chat sessions and messages | Server (SQLite) | `/api/chat` |
| Claude API key, similarity threshold | Server (SQLite `settings` table) | `/api/settings` |
| Color scheme, font size | Client (localStorage) | `paperpile-navigate-visual-prefs` |

## License

This project is licensed under the [MIT License](LICENSE).
