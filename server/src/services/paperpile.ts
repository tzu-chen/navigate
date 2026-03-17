import { SavedPaper, Comment, Tag } from '../types';

/**
 * Generate a BibTeX entry for a paper.
 * This can be imported directly into Paperpile via their BibTeX import feature.
 */
export function generateBibtex(paper: SavedPaper, tags: Tag[], comments: Comment[]): string {
  const authors = JSON.parse(paper.authors) as string[];
  const categories = JSON.parse(paper.categories) as string[];
  const year = new Date(paper.published).getFullYear();

  // Generate citation key: first author's last name + year
  const isUpload = paper.arxiv_id.startsWith('upload-');
  const firstAuthorLastName = authors[0]
    ?.split(' ')
    .pop()
    ?.replace(/[^a-zA-Z]/g, '')
    ?.toLowerCase() || 'unknown';
  const titleWord = paper.title.split(/\s+/)[0]?.replace(/[^a-zA-Z]/g, '').toLowerCase() || '';
  const citeKey = isUpload
    ? `${firstAuthorLastName}${year}${titleWord}`
    : `${firstAuthorLastName}${year}${paper.arxiv_id.replace(/[^a-zA-Z0-9]/g, '')}`;

  const bibtexAuthors = authors.join(' and ');

  const tagStr = tags.map(t => t.name).join(', ');
  const commentStr = comments
    .map(c => {
      const pageRef = c.page_number ? ` [p.${c.page_number}]` : '';
      return `${c.content}${pageRef}`;
    })
    .join('; ');

  const fields: string[] = [
    `  author = {${bibtexAuthors}}`,
    `  title = {${paper.title}}`,
    `  year = {${year}}`,
  ];

  if (!isUpload) {
    fields.push(`  eprint = {${paper.arxiv_id}}`);
    fields.push(`  archiveprefix = {arXiv}`);
    fields.push(`  primaryclass = {${categories[0] || ''}}`);
  }

  fields.push(`  abstract = {${paper.summary}}`);

  if (paper.abs_url) {
    fields.push(`  url = {${paper.abs_url}}`);
  }

  if (paper.doi) {
    fields.push(`  doi = {${paper.doi}}`);
  }
  if (paper.journal_ref) {
    fields.push(`  journal = {${paper.journal_ref}}`);
  }
  if (tagStr) {
    fields.push(`  keywords = {${tagStr}}`);
  }
  if (commentStr) {
    fields.push(`  note = {${commentStr}}`);
  }

  return `@article{${citeKey},\n${fields.join(',\n')}\n}`;
}

/**
 * Generate BibTeX for multiple papers.
 */
export function generateBibtexBundle(
  papers: Array<{ paper: SavedPaper; tags: Tag[]; comments: Comment[] }>
): string {
  return papers.map(p => generateBibtex(p.paper, p.tags, p.comments)).join('\n\n');
}

/**
 * Generate a Paperpile-compatible JSON metadata object.
 * Paperpile supports importing structured metadata via their API or browser extension.
 */
export function generatePaperpileMetadata(
  paper: SavedPaper,
  tags: Tag[],
  comments: Comment[]
) {
  const authors = JSON.parse(paper.authors) as string[];
  const categories = JSON.parse(paper.categories) as string[];

  return {
    title: paper.title,
    authors: authors.map(name => {
      const parts = name.trim().split(' ');
      const lastName = parts.pop() || '';
      const firstName = parts.join(' ');
      return { first: firstName, last: lastName };
    }),
    year: new Date(paper.published).getFullYear(),
    abstract: paper.summary,
    source: paper.arxiv_id.startsWith('upload-') ? 'upload' : 'arXiv',
    identifiers: {
      arxiv: paper.arxiv_id.startsWith('upload-') ? undefined : paper.arxiv_id,
      doi: paper.doi || undefined,
    },
    urls: {
      pdf: paper.pdf_url || undefined,
      abstract: paper.abs_url || undefined,
    },
    labels: tags.map(t => t.name),
    folders: categories,
    notes: comments.map(c => ({
      text: c.content,
      page: c.page_number,
      created: c.created_at,
    })),
    journal: paper.journal_ref || (paper.arxiv_id.startsWith('upload-') ? undefined : `arXiv:${paper.arxiv_id}`),
  };
}

export interface ParsedBibtexEntry {
  arxiv_id: string;
  title: string;
  authors: string[];
  year: number;
  summary: string;
  categories: string[];
  url: string;
  doi?: string;
  journal_ref?: string;
  keywords: string[];
  notes: Array<{ content: string; page_number?: number }>;
}

/**
 * Parse a BibTeX string into structured entries.
 * Designed to round-trip with generateBibtex output.
 */
export function parseBibtex(bibtex: string): ParsedBibtexEntry[] {
  const entries: ParsedBibtexEntry[] = [];

  // Match each @type{key, ... } entry, handling nested braces
  const entryStarts = [...bibtex.matchAll(/@\w+\s*\{/g)];
  for (const match of entryStarts) {
    const startIdx = match.index!;
    let depth = 0;
    let endIdx = startIdx;
    for (let i = startIdx; i < bibtex.length; i++) {
      if (bibtex[i] === '{') depth++;
      else if (bibtex[i] === '}') {
        depth--;
        if (depth === 0) { endIdx = i; break; }
      }
    }
    const entryStr = bibtex.slice(startIdx, endIdx + 1);
    const fields = parseBibtexFields(entryStr);

    const arxivId = fields['eprint'] || '';
    if (!arxivId) continue;

    const authors = (fields['author'] || '')
      .split(/\s+and\s+/)
      .map(a => a.trim())
      .filter(a => a.length > 0);

    const year = parseInt(fields['year'] || '0', 10);
    const primaryClass = fields['primaryclass'] || '';

    // Parse keywords (tags)
    const keywords = (fields['keywords'] || '')
      .split(',')
      .map(k => k.trim())
      .filter(k => k.length > 0);

    // Parse notes (comments) - format: "content [p.N]; content2 [p.M]"
    const notes: Array<{ content: string; page_number?: number }> = [];
    const noteStr = fields['note'] || '';
    if (noteStr) {
      const noteParts = noteStr.split(';').map(s => s.trim()).filter(s => s.length > 0);
      for (const part of noteParts) {
        const pageMatch = part.match(/^(.*?)\s*\[p\.(\d+)\]\s*$/);
        if (pageMatch) {
          notes.push({ content: pageMatch[1].trim(), page_number: parseInt(pageMatch[2], 10) });
        } else {
          notes.push({ content: part });
        }
      }
    }

    entries.push({
      arxiv_id: arxivId,
      title: fields['title'] || '',
      authors,
      year,
      summary: fields['abstract'] || '',
      categories: primaryClass ? [primaryClass] : [],
      url: fields['url'] || `https://arxiv.org/abs/${arxivId}`,
      doi: fields['doi'],
      journal_ref: fields['journal'],
      keywords,
      notes,
    });
  }

  return entries;
}

function parseBibtexFields(entry: string): Record<string, string> {
  const fields: Record<string, string> = {};
  // Remove the @type{key, header
  const headerEnd = entry.indexOf(',');
  if (headerEnd === -1) return fields;
  const body = entry.slice(headerEnd + 1, entry.length - 1);

  // Parse field = {value} pairs, handling nested braces
  const fieldRegex = /(\w+)\s*=\s*\{/g;
  let fieldMatch;
  while ((fieldMatch = fieldRegex.exec(body)) !== null) {
    const fieldName = fieldMatch[1].toLowerCase();
    const valueStart = fieldMatch.index + fieldMatch[0].length;
    let depth = 1;
    let valueEnd = valueStart;
    for (let i = valueStart; i < body.length; i++) {
      if (body[i] === '{') depth++;
      else if (body[i] === '}') {
        depth--;
        if (depth === 0) { valueEnd = i; break; }
      }
    }
    fields[fieldName] = body.slice(valueStart, valueEnd);
  }
  return fields;
}
