import Database, { Database as DatabaseType } from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DATA_DIR = path.join(__dirname, '..', '..', 'data');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const db: DatabaseType = new Database(path.join(DATA_DIR, 'papers.db'));

// Enable WAL mode for better concurrent access
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

export function initializeDatabase(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS papers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      arxiv_id TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      authors TEXT NOT NULL,
      published TEXT NOT NULL,
      updated TEXT NOT NULL,
      categories TEXT NOT NULL,
      pdf_url TEXT NOT NULL,
      abs_url TEXT NOT NULL,
      doi TEXT,
      journal_ref TEXT,
      added_at TEXT DEFAULT (datetime('now')),
      status TEXT DEFAULT 'new' CHECK(status IN ('new', 'reading', 'reviewed', 'exported'))
    );

    CREATE TABLE IF NOT EXISTS comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      paper_id INTEGER NOT NULL,
      content TEXT NOT NULL,
      page_number INTEGER,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (paper_id) REFERENCES papers(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      color TEXT NOT NULL DEFAULT '#6366f1'
    );

    CREATE TABLE IF NOT EXISTS paper_tags (
      paper_id INTEGER NOT NULL,
      tag_id INTEGER NOT NULL,
      PRIMARY KEY (paper_id, tag_id),
      FOREIGN KEY (paper_id) REFERENCES papers(id) ON DELETE CASCADE,
      FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS favorite_authors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      added_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS worldlines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT '#6366f1',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS worldline_papers (
      worldline_id INTEGER NOT NULL,
      paper_id INTEGER NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (worldline_id, paper_id),
      FOREIGN KEY (worldline_id) REFERENCES worldlines(id) ON DELETE CASCADE,
      FOREIGN KEY (paper_id) REFERENCES papers(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_papers_arxiv_id ON papers(arxiv_id);
    CREATE INDEX IF NOT EXISTS idx_comments_paper_id ON comments(paper_id);
    CREATE INDEX IF NOT EXISTS idx_paper_tags_paper_id ON paper_tags(paper_id);
    CREATE INDEX IF NOT EXISTS idx_paper_tags_tag_id ON paper_tags(tag_id);
    CREATE INDEX IF NOT EXISTS idx_worldline_papers_worldline ON worldline_papers(worldline_id);
    CREATE INDEX IF NOT EXISTS idx_worldline_papers_paper ON worldline_papers(paper_id);

    CREATE TABLE IF NOT EXISTS chat_sessions (
      id TEXT PRIMARY KEY,
      arxiv_id TEXT,
      paper_title TEXT,
      worldline_id INTEGER,
      worldline_name TEXT,
      session_type TEXT NOT NULL DEFAULT 'paper' CHECK(session_type IN ('paper', 'worldline')),
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (worldline_id) REFERENCES worldlines(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
      content TEXT NOT NULL,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cache_creation_input_tokens INTEGER,
      cache_read_input_tokens INTEGER,
      estimated_cost REAL,
      model TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_chat_sessions_arxiv_id ON chat_sessions(arxiv_id);
    CREATE INDEX IF NOT EXISTS idx_chat_sessions_worldline_id ON chat_sessions(worldline_id);
    CREATE INDEX IF NOT EXISTS idx_chat_sessions_type ON chat_sessions(session_type);
    CREATE INDEX IF NOT EXISTS idx_chat_messages_session_id ON chat_messages(session_id);
  `);

  // Migration: add pdf_path column if it doesn't exist
  const columns = db.prepare("PRAGMA table_info('papers')").all() as { name: string }[];
  if (!columns.some(c => c.name === 'pdf_path')) {
    db.exec("ALTER TABLE papers ADD COLUMN pdf_path TEXT");
  }
}

// Paper operations
export function savePaper(paper: {
  arxiv_id: string;
  title: string;
  summary: string;
  authors: string;
  published: string;
  updated: string;
  categories: string;
  pdf_url: string;
  abs_url: string;
  doi?: string;
  journal_ref?: string;
}) {
  const stmt = db.prepare(`
    INSERT INTO papers (arxiv_id, title, summary, authors, published, updated, categories, pdf_url, abs_url, doi, journal_ref)
    VALUES (@arxiv_id, @title, @summary, @authors, @published, @updated, @categories, @pdf_url, @abs_url, @doi, @journal_ref)
    ON CONFLICT(arxiv_id) DO UPDATE SET
      title = excluded.title,
      summary = excluded.summary,
      authors = excluded.authors,
      updated = excluded.updated,
      categories = excluded.categories
  `);
  return stmt.run(paper);
}

export function getPapers(options?: { status?: string; tag_id?: number }) {
  if (options?.tag_id) {
    return db.prepare(`
      SELECT p.* FROM papers p
      JOIN paper_tags pt ON p.id = pt.paper_id
      WHERE pt.tag_id = ?
      ORDER BY p.added_at DESC
    `).all(options.tag_id);
  }
  if (options?.status) {
    return db.prepare('SELECT * FROM papers WHERE status = ? ORDER BY added_at DESC').all(options.status);
  }
  return db.prepare('SELECT * FROM papers ORDER BY added_at DESC').all();
}

export function getPaper(id: number) {
  return db.prepare('SELECT * FROM papers WHERE id = ?').get(id);
}

export function getPaperByArxivId(arxivId: string) {
  return db.prepare('SELECT * FROM papers WHERE arxiv_id = ?').get(arxivId);
}

export function updatePaperStatus(id: number, status: string) {
  return db.prepare('UPDATE papers SET status = ? WHERE id = ?').run(status, id);
}

export function deletePaper(id: number) {
  return db.prepare('DELETE FROM papers WHERE id = ?').run(id);
}

// Comment operations
export function addComment(paperId: number, content: string, pageNumber?: number) {
  return db.prepare(
    'INSERT INTO comments (paper_id, content, page_number) VALUES (?, ?, ?)'
  ).run(paperId, content, pageNumber ?? null);
}

export function getComments(paperId: number) {
  return db.prepare(
    'SELECT * FROM comments WHERE paper_id = ? ORDER BY created_at DESC'
  ).all(paperId);
}

export function updateComment(id: number, content: string) {
  return db.prepare(
    'UPDATE comments SET content = ?, updated_at = datetime(\'now\') WHERE id = ?'
  ).run(content, id);
}

export function deleteComment(id: number) {
  return db.prepare('DELETE FROM comments WHERE id = ?').run(id);
}

// Tag operations
export function createTag(name: string, color: string = '#6366f1') {
  return db.prepare('INSERT INTO tags (name, color) VALUES (?, ?)').run(name, color);
}

export function getTags() {
  return db.prepare('SELECT * FROM tags ORDER BY name').all();
}

export function updateTag(id: number, name: string, color: string) {
  return db.prepare('UPDATE tags SET name = ?, color = ? WHERE id = ?').run(name, color, id);
}

export function deleteTag(id: number) {
  return db.prepare('DELETE FROM tags WHERE id = ?').run(id);
}

export function addPaperTag(paperId: number, tagId: number) {
  return db.prepare(
    'INSERT OR IGNORE INTO paper_tags (paper_id, tag_id) VALUES (?, ?)'
  ).run(paperId, tagId);
}

export function removePaperTag(paperId: number, tagId: number) {
  return db.prepare(
    'DELETE FROM paper_tags WHERE paper_id = ? AND tag_id = ?'
  ).run(paperId, tagId);
}

export function getPaperTags(paperId: number) {
  return db.prepare(`
    SELECT t.* FROM tags t
    JOIN paper_tags pt ON t.id = pt.tag_id
    WHERE pt.paper_id = ?
    ORDER BY t.name
  `).all(paperId);
}

// Favorite author operations
export function addFavoriteAuthor(name: string) {
  return db.prepare('INSERT INTO favorite_authors (name) VALUES (?)').run(name);
}

export function getFavoriteAuthors() {
  return db.prepare('SELECT * FROM favorite_authors ORDER BY added_at DESC').all();
}

export function removeFavoriteAuthor(id: number) {
  return db.prepare('DELETE FROM favorite_authors WHERE id = ?').run(id);
}

export function getFavoriteAuthorByName(name: string) {
  return db.prepare('SELECT * FROM favorite_authors WHERE name = ?').get(name);
}

// Worldline operations
export function createWorldline(name: string, color: string = '#6366f1') {
  return db.prepare('INSERT INTO worldlines (name, color) VALUES (?, ?)').run(name, color);
}

export function getWorldlines() {
  return db.prepare('SELECT * FROM worldlines ORDER BY created_at DESC').all();
}

export function updateWorldline(id: number, name: string, color: string) {
  return db.prepare('UPDATE worldlines SET name = ?, color = ? WHERE id = ?').run(name, color, id);
}

export function deleteWorldline(id: number) {
  return db.prepare('DELETE FROM worldlines WHERE id = ?').run(id);
}

export function getWorldlinePapers(worldlineId: number) {
  return db.prepare(`
    SELECT p.*, wp.position FROM papers p
    JOIN worldline_papers wp ON p.id = wp.paper_id
    WHERE wp.worldline_id = ?
    ORDER BY wp.position ASC
  `).all(worldlineId);
}

export function addWorldlinePaper(worldlineId: number, paperId: number, position: number) {
  return db.prepare(
    'INSERT OR REPLACE INTO worldline_papers (worldline_id, paper_id, position) VALUES (?, ?, ?)'
  ).run(worldlineId, paperId, position);
}

export function removeWorldlinePaper(worldlineId: number, paperId: number) {
  return db.prepare(
    'DELETE FROM worldline_papers WHERE worldline_id = ? AND paper_id = ?'
  ).run(worldlineId, paperId);
}

// Get all worldlines with their papers' titles and summaries (for similarity scoring)
export function getAllWorldlinesWithPapers(): {
  id: number;
  name: string;
  color: string;
  papers: { title: string; summary: string }[];
}[] {
  const worldlines = db.prepare('SELECT id, name, color FROM worldlines ORDER BY id').all() as {
    id: number;
    name: string;
    color: string;
  }[];

  const paperStmt = db.prepare(`
    SELECT p.title, p.summary FROM papers p
    JOIN worldline_papers wp ON p.id = wp.paper_id
    WHERE wp.worldline_id = ?
  `);

  return worldlines.map(wl => ({
    ...wl,
    papers: paperStmt.all(wl.id) as { title: string; summary: string }[],
  }));
}

// Get arxiv_ids of papers that share a worldline with the given paper
export function getRelatedPaperArxivIdsByArxivId(arxivId: string): { arxivId: string; title: string }[] {
  const paper = db.prepare('SELECT id FROM papers WHERE arxiv_id = ?').get(arxivId) as { id: number } | undefined;
  if (!paper) return [];

  const rows = db.prepare(`
    SELECT DISTINCT p.arxiv_id, p.title FROM papers p
    JOIN worldline_papers wp ON p.id = wp.paper_id
    WHERE wp.worldline_id IN (
      SELECT wp2.worldline_id FROM worldline_papers wp2
      JOIN papers p2 ON p2.id = wp2.paper_id
      WHERE p2.arxiv_id = ?
    ) AND p.arxiv_id != ?
    ORDER BY p.published ASC
  `).all(arxivId, arxivId) as { arxiv_id: string; title: string }[];

  return rows.map(r => ({ arxivId: r.arxiv_id, title: r.title }));
}

// Get titles of papers that share a worldline with the given paper (by arxiv_id)
export function getRelatedPaperTitlesByArxivId(arxivId: string): { worldlineName: string; titles: string[] }[] {
  const paper = db.prepare('SELECT id FROM papers WHERE arxiv_id = ?').get(arxivId) as { id: number } | undefined;
  if (!paper) return [];

  const worldlines = db.prepare(`
    SELECT w.id, w.name FROM worldlines w
    JOIN worldline_papers wp ON w.id = wp.worldline_id
    WHERE wp.paper_id = ?
  `).all(paper.id) as { id: number; name: string }[];

  if (worldlines.length === 0) return [];

  const titlesStmt = db.prepare(`
    SELECT p.title FROM papers p
    JOIN worldline_papers wp ON p.id = wp.paper_id
    WHERE wp.worldline_id = ? AND p.id != ?
    ORDER BY wp.position ASC
  `);

  return worldlines
    .map(wl => ({
      worldlineName: wl.name,
      titles: (titlesStmt.all(wl.id, paper.id) as { title: string }[]).map(r => r.title),
    }))
    .filter(wl => wl.titles.length > 0);
}

// PDF path operations
export function updatePaperPdfPath(id: number, pdfPath: string | null) {
  return db.prepare('UPDATE papers SET pdf_path = ? WHERE id = ?').run(pdfPath, id);
}

// Bulk operations
export function getPapersByIds(paperIds: number[]) {
  if (paperIds.length === 0) return [];
  const placeholders = paperIds.map(() => '?').join(',');
  return db.prepare(`SELECT * FROM papers WHERE id IN (${placeholders})`).all(...paperIds);
}

export function bulkUpdateStatus(paperIds: number[], status: string) {
  if (paperIds.length === 0) return { changes: 0 };
  const placeholders = paperIds.map(() => '?').join(',');
  return db.prepare(`UPDATE papers SET status = ? WHERE id IN (${placeholders})`).run(status, ...paperIds);
}

export function bulkDeletePapers(paperIds: number[]) {
  if (paperIds.length === 0) return { changes: 0 };
  const placeholders = paperIds.map(() => '?').join(',');
  return db.prepare(`DELETE FROM papers WHERE id IN (${placeholders})`).run(...paperIds);
}

export function bulkAddPaperTag(paperIds: number[], tagId: number) {
  const stmt = db.prepare('INSERT OR IGNORE INTO paper_tags (paper_id, tag_id) VALUES (?, ?)');
  const insertMany = db.transaction((ids: number[]) => {
    let count = 0;
    for (const id of ids) {
      const result = stmt.run(id, tagId);
      count += result.changes;
    }
    return count;
  });
  return insertMany(paperIds);
}

export function bulkRemovePaperTag(paperIds: number[], tagId: number) {
  if (paperIds.length === 0) return { changes: 0 };
  const placeholders = paperIds.map(() => '?').join(',');
  return db.prepare(`DELETE FROM paper_tags WHERE tag_id = ? AND paper_id IN (${placeholders})`).run(tagId, ...paperIds);
}

// Chat session operations
export function createChatSession(session: {
  id: string;
  arxiv_id?: string;
  paper_title?: string;
  worldline_id?: number;
  worldline_name?: string;
  session_type: 'paper' | 'worldline';
  created_at?: string;
  updated_at?: string;
}) {
  return db.prepare(`
    INSERT INTO chat_sessions (id, arxiv_id, paper_title, worldline_id, worldline_name, session_type, created_at, updated_at)
    VALUES (@id, @arxiv_id, @paper_title, @worldline_id, @worldline_name, @session_type, @created_at, @updated_at)
  `).run({
    id: session.id,
    arxiv_id: session.arxiv_id ?? null,
    paper_title: session.paper_title ?? null,
    worldline_id: session.worldline_id ?? null,
    worldline_name: session.worldline_name ?? null,
    session_type: session.session_type,
    created_at: session.created_at ?? new Date().toISOString(),
    updated_at: session.updated_at ?? new Date().toISOString(),
  });
}

export function getChatSession(id: string) {
  return db.prepare('SELECT * FROM chat_sessions WHERE id = ?').get(id);
}

export function getChatSessionsByArxivId(arxivId: string) {
  return db.prepare(
    'SELECT * FROM chat_sessions WHERE arxiv_id = ? AND session_type = ? ORDER BY updated_at DESC'
  ).all(arxivId, 'paper');
}

export function getChatSessionsByWorldlineId(worldlineId: number) {
  return db.prepare(
    'SELECT * FROM chat_sessions WHERE worldline_id = ? AND session_type = ? ORDER BY updated_at DESC'
  ).all(worldlineId, 'worldline');
}

export function getAllChatSessions() {
  return db.prepare(
    'SELECT * FROM chat_sessions WHERE session_type = ? ORDER BY updated_at DESC'
  ).all('paper');
}

export function updateChatSessionTimestamp(id: string) {
  return db.prepare(
    "UPDATE chat_sessions SET updated_at = datetime('now') WHERE id = ?"
  ).run(id);
}

export function deleteChatSession(id: string) {
  return db.prepare('DELETE FROM chat_sessions WHERE id = ?').run(id);
}

export function deleteChatSessionsByArxivId(arxivId: string) {
  return db.prepare('DELETE FROM chat_sessions WHERE arxiv_id = ? AND session_type = ?').run(arxivId, 'paper');
}

// Chat message operations
export function addChatMessage(message: {
  session_id: string;
  role: 'user' | 'assistant';
  content: string;
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  estimated_cost?: number;
  model?: string;
}) {
  const result = db.prepare(`
    INSERT INTO chat_messages (session_id, role, content, input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, estimated_cost, model)
    VALUES (@session_id, @role, @content, @input_tokens, @output_tokens, @cache_creation_input_tokens, @cache_read_input_tokens, @estimated_cost, @model)
  `).run({
    session_id: message.session_id,
    role: message.role,
    content: message.content,
    input_tokens: message.input_tokens ?? null,
    output_tokens: message.output_tokens ?? null,
    cache_creation_input_tokens: message.cache_creation_input_tokens ?? null,
    cache_read_input_tokens: message.cache_read_input_tokens ?? null,
    estimated_cost: message.estimated_cost ?? null,
    model: message.model ?? null,
  });
  // Update session timestamp
  db.prepare("UPDATE chat_sessions SET updated_at = datetime('now') WHERE id = ?").run(message.session_id);
  return result;
}

export function getChatMessages(sessionId: string) {
  return db.prepare(
    'SELECT * FROM chat_messages WHERE session_id = ? ORDER BY id ASC'
  ).all(sessionId);
}

// Settings operations
export function getSetting(key: string): string | undefined {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value;
}

export function setSetting(key: string, value: string) {
  return db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value);
}

export function getAllSettings(): Record<string, string> {
  const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.key] = row.value;
  }
  return result;
}

export function deleteSetting(key: string) {
  return db.prepare('DELETE FROM settings WHERE key = ?').run(key);
}

export default db;
