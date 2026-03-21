# Navigate — INTEROP.md

Cross-app integration spec for Navigate. This documents the endpoints and data shapes that sibling apps (Scribe, Monolith, Granary) may call or reference.

**Base URL:** `http://localhost:3001/api`  
**Port:** 3001 (server), 5173 (Vite dev)

---

## Data Available to Other Apps

### Papers

Navigate is the source of truth for arXiv papers and their metadata.

**Get a saved paper by arXiv ID:**
```
GET /api/papers
```
Returns all saved papers. Filter client-side by `arxiv_id`. Each paper has:
```typescript
interface SavedPaper {
  id: number;
  arxiv_id: string;           // e.g. "2301.12345"
  title: string;
  summary: string;            // Abstract
  authors: string;            // JSON string — parse to string[]
  categories: string;         // JSON string — parse to string[]
  published: string;          // ISO 8601
  updated: string;
  status: 'new' | 'reading' | 'reviewed' | 'exported';
  pdf_path: string | null;
  created_at: string;
}
```

**Get a single paper by internal ID:**
```
GET /api/papers/:id
```

**Search arXiv (not saved papers — live arXiv API):**
```
GET /api/arxiv/search?query=<query>&start=<offset>&max_results=<n>&category=<cat>
```
Returns `ArxivPaper[]` (title, summary, authors, categories, published, arxiv_id, pdf_url).

**Get a single arXiv paper by ID:**
```
GET /api/arxiv/paper/:arxivId
```

### Tags

```
GET /api/tags
```
Returns `{ id: number, name: string, color: string }[]`. Tag names are unique.

**Tags for a specific paper:**
```
GET /api/papers/:id/tags
```

### Worldlines (Research Threads)

```
GET /api/worldlines
```
Returns `{ id: number, name: string, color: string, created_at: string }[]`.

**Papers in a worldline:**
```
GET /api/worldlines/:id/papers
```
Returns papers with `position` ordering.

### Comments (Per-Page Annotations)

```
GET /api/papers/:id/comments
```
Returns `{ id: number, paper_id: number, content: string, page_number: number, created_at: string }[]`.

### BibTeX Export

```
GET /api/export/bibtex?paperIds=1,2,3
```
Returns BibTeX string. Citation key format: `{LastName}{Year}{ArxivId}`.

```
GET /api/export/paperpile?paperIds=1,2,3
```
Returns Paperpile JSON.

### PDF Access

```
GET /api/arxiv/pdf/:arxivId
```
Proxies the PDF from arXiv (avoids CORS). Returns raw PDF bytes.

### Chat Sessions

```
GET /api/chat/sessions?arxiv_id=<id>
GET /api/chat/sessions/:sessionId/messages
```

### Settings

```
GET /api/settings
GET /api/settings/:key
```
Keys include: `claude_api_key`, `similarity_threshold`.

---

## Cross-App Reference Keys

When other apps link to Navigate entities, use these identifiers:

| Entity | Key | Example |
|--------|-----|---------|
| Paper | `arxiv_id` (string) | `"2301.12345"` |
| Paper (internal) | `id` (number) | `42` |
| Worldline | `id` (number) | `7` |
| Tag | `name` (string, unique) | `"mean-field-games"` |

**Recommended:** Use `arxiv_id` as the cross-app paper identifier — it's globally unique, human-readable, and doesn't depend on Navigate's internal auto-increment IDs.

---

## Planned Endpoints for Cross-App Use (Not Yet Implemented)

These don't exist yet but are the natural integration points:

| Consumer | Endpoint | Purpose |
|----------|----------|---------|
| Scribe | `GET /api/papers/:id/export-to-scribe` | Get paper metadata + PDF path formatted for Scribe import |
| Granary | `GET /api/papers/:arxivId/context` | Get title, abstract, authors, comments, worldline names — for populating Granary entry links |
| Monolith | `GET /api/export/bibtex?worldline=<id>` | Export BibTeX for all papers in a worldline (for .bib file sync) |
