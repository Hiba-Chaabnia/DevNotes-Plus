/**
 * notes.ts — note I/O layer for the DevNotes MCP server.
 *
 * Replicates the frontmatter format used by the VS Code extension
 * (NoteStorage.ts + Frontmatter.ts) without any VS Code dependencies,
 * so the MCP server can read and write notes as plain files.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CodeLink {
  file: string;
  line: number;
}

export interface GitHubLink {
  url: string;
  repo: string;    // "owner/repo"
  number: number;
  type: 'issue' | 'pr';
  status?: 'open' | 'closed' | 'merged';
  title?: string;
  statusCheckedAt?: number;
}

export interface Note {
  id: string;
  title: string;
  content: string;
  tags: string[];
  starred: boolean;
  shared?: boolean;
  codeLink?: CodeLink;
  github?: GitHubLink;
  branch?: string;
  remindAt?: number;
  owner?: string;
  archived?: boolean;
  conflicted?: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface Tag {
  id: string;
  label: string;
  color: string;
  icon?: string;
}

export const DEFAULT_TAGS: Tag[] = [
  { id: 'idea',      label: 'Idea',      color: '#FFDE5A', icon: 'Lightbulb'    },
  { id: 'todo',      label: 'Todo',      color: '#43B4FB', icon: 'ListTodo'     },
  { id: 'bug',       label: 'Bug',       color: '#FF524D', icon: 'Bug'          },
  { id: 'meeting',   label: 'Meeting',   color: '#DB95FD', icon: 'Presentation' },
  { id: 'reference', label: 'Reference', color: '#31B54C', icon: 'BookMarked'   },
];

// ─── Frontmatter (mirrors Frontmatter.ts exactly) ────────────────────────────

function parseFrontmatter(raw: string): { meta: Record<string, unknown>; body: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: raw };

  const meta: Record<string, unknown> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const val = line.slice(colon + 1).trim();
    if (!key) continue;
    if (val === 'true')  { meta[key] = true;  continue; }
    if (val === 'false') { meta[key] = false; continue; }
    if (val === '')      { meta[key] = '';    continue; }
    meta[key] = /^-?(0|[1-9]\d*)$/.test(val) ? Number(val) : val;
  }

  return { meta, body: match[2] };
}

function serializeFrontmatter(meta: Record<string, unknown>, body: string): string {
  const lines = Object.entries(meta).map(([key, val]) => {
    const safe = typeof val === 'string' ? val.replace(/\r?\n/g, ' ') : val;
    return `${key}: ${safe}`;
  });
  return `---\n${lines.join('\n')}\n---\n${body}`;
}

// ─── Parse a raw .md file into a Note ────────────────────────────────────────

function parseNoteFile(raw: string, fileName: string): Note | null {
  const isConflicted =
    raw.includes('<<<<<<<') &&
    raw.includes('=======') &&
    raw.includes('>>>>>>>');

  // Strip conflict markers, keeping the HEAD (ours) side so the note stays readable
  const effective = isConflicted
    ? raw.replace(
        /^<<<<<<< .+\n([\s\S]*?)^=======\n[\s\S]*?^>>>>>>> .+$\n?/gm,
        (_, ours: string) => ours
      )
    : raw;

  try {
    const { meta, body } = parseFrontmatter(effective);
    const id = String(meta.id ?? '');
    if (!id) return null;

    return {
      id,
      title    : String(meta.title  ?? 'Untitled'),
      content  : body,
      tags     : meta.tags ? String(meta.tags).split(',').filter(Boolean) : [],
      starred  : meta.starred === true,
      shared   : meta.shared  === true || undefined,
      codeLink : (typeof meta.codeLink_file === 'string' && meta.codeLink_file && meta.codeLink_line !== undefined)
        ? { file: meta.codeLink_file, line: Number(meta.codeLink_line) }
        : undefined,
      branch   : typeof meta.branch === 'string' && meta.branch ? meta.branch : undefined,
      owner    : typeof meta.owner  === 'string' && meta.owner  ? meta.owner  : undefined,
      remindAt : meta.remindAt ? Number(meta.remindAt) : undefined,
      archived : meta.archived === true || undefined,
      github   : (typeof meta.github_url === 'string' && meta.github_url)
        ? {
            url             : meta.github_url as string,
            repo            : meta.github_repo as string,
            number          : Number(meta.github_number),
            type            : meta.github_type as 'issue' | 'pr',
            status          : meta.github_status as GitHubLink['status'] | undefined,
            title           : typeof meta.github_title === 'string' ? meta.github_title : undefined,
            statusCheckedAt : meta.github_status_checked_at ? Number(meta.github_status_checked_at) : undefined,
          }
        : undefined,
      conflicted: isConflicted || undefined,
      createdAt: Number(meta.createdAt ?? Date.now()),
      updatedAt: Number(meta.updatedAt ?? Date.now()),
    };
  } catch {
    console.error(`[devnotes-mcp] Failed to parse "${fileName}"`);
    return null;
  }
}

// ─── In-memory TTL cache ──────────────────────────────────────────────────────

const CACHE_TTL_MS = 500;
const _cache = new Map<string, { notes: Note[]; expiresAt: number }>();

// ─── Public I/O ──────────────────────────────────────────────────────────────

export function readAllNotes(devnotesDir: string): Note[] {
  const cached = _cache.get(devnotesDir);
  if (cached && Date.now() < cached.expiresAt) return cached.notes;

  if (!fs.existsSync(devnotesDir)) return [];
  const notes: Note[] = [];
  for (const entry of fs.readdirSync(devnotesDir)) {
    if (!entry.endsWith('.md')) continue;
    try {
      const raw = fs.readFileSync(path.join(devnotesDir, entry), 'utf-8');
      const note = parseNoteFile(raw, entry);
      if (note) notes.push(note);
    } catch { /* skip unreadable files */ }
  }

  _cache.set(devnotesDir, { notes, expiresAt: Date.now() + CACHE_TTL_MS });
  return notes;
}

function invalidateCache(devnotesDir: string): void {
  _cache.delete(devnotesDir);
}

export function readNote(devnotesDir: string, id: string): Note | null {
  const filePath = path.join(devnotesDir, `${id}.md`);
  if (!fs.existsSync(filePath)) return null;
  try {
    return parseNoteFile(fs.readFileSync(filePath, 'utf-8'), `${id}.md`);
  } catch {
    return null;
  }
}

export function writeNote(devnotesDir: string, note: Note): void {
  fs.mkdirSync(devnotesDir, { recursive: true });

  const meta: Record<string, unknown> = {
    id       : note.id,
    title    : note.title,
    tags     : note.tags.join(','),
    starred  : note.starred,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
  };
  if (note.shared)    meta.shared    = true;
  if (note.branch)    meta.branch    = note.branch;
  if (note.owner)     meta.owner     = note.owner;
  if (note.remindAt)  meta.remindAt  = note.remindAt;
  if (note.archived)  meta.archived  = true;
  if (note.codeLink) {
    meta.codeLink_file = note.codeLink.file;
    meta.codeLink_line = note.codeLink.line;
  }
  if (note.github) {
    meta.github_url    = note.github.url;
    meta.github_repo   = note.github.repo;
    meta.github_number = note.github.number;
    meta.github_type   = note.github.type;
    if (note.github.status)          meta.github_status           = note.github.status;
    if (note.github.title)           meta.github_title            = note.github.title;
    if (note.github.statusCheckedAt) meta.github_status_checked_at = note.github.statusCheckedAt;
  }

  fs.writeFileSync(
    path.join(devnotesDir, `${note.id}.md`),
    serializeFrontmatter(meta, note.content),
    'utf-8'
  );
  invalidateCache(devnotesDir);
  updateGitignore(devnotesDir, note.id, note.shared === true);
}

export function deleteNote(devnotesDir: string, id: string): boolean {
  const filePath = path.join(devnotesDir, `${id}.md`);
  if (!fs.existsSync(filePath)) return false;
  fs.unlinkSync(filePath);
  invalidateCache(devnotesDir);
  return true;
}

function updateGitignore(devnotesDir: string, id: string, shared: boolean): void {
  const gitignorePath = path.join(devnotesDir, '.gitignore');
  if (!fs.existsSync(gitignorePath)) return;
  try {
    const content  = fs.readFileSync(gitignorePath, 'utf-8');
    const noteEntry = `!${id}.md`;
    const lines = content
      .split(/\r?\n/)
      .filter(l => l.trim() !== '' || l === '*')
      .filter(l => l.trim() !== noteEntry);

    if (shared) {
      if (!lines.includes('!.gitignore')) lines.push('!.gitignore');
      if (!lines.includes('!tags.json'))  lines.push('!tags.json');
      lines.push(noteEntry);
    }
    fs.writeFileSync(gitignorePath, lines.join('\n') + '\n', 'utf-8');
  } catch { /* best-effort */ }
}

export function readTags(devnotesDir: string): Tag[] {
  const tagsPath = path.join(devnotesDir, 'tags.json');
  if (!fs.existsSync(tagsPath)) return [...DEFAULT_TAGS];
  try {
    const parsed = JSON.parse(fs.readFileSync(tagsPath, 'utf-8'));
    // Support both the legacy plain-array format and the current object format
    const custom: Tag[] = Array.isArray(parsed) ? parsed : (parsed.tags ?? []);
    const order: string[] | undefined = Array.isArray(parsed) ? undefined : parsed.order;
    const deletedIds: string[] = Array.isArray(parsed) ? [] : (parsed.deletedDefaultIds ?? []);
    const deletedSet = new Set(deletedIds);
    const customIds  = new Set(custom.map((t: Tag) => t.id));
    const merged = [
      ...DEFAULT_TAGS.filter(t => !customIds.has(t.id) && !deletedSet.has(t.id)),
      ...custom,
    ];
    if (order) {
      const rank = new Map(order.map((id, i) => [id, i]));
      merged.sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity));
    }
    return merged;
  } catch {
    return [...DEFAULT_TAGS];
  }
}

export function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ─── Search helpers ───────────────────────────────────────────────────────────

/** Find a note by exact ID, exact title, or fuzzy title (contains). */
export function findNote(notes: Note[], query: string): Note | null {
  const lower = query.toLowerCase();
  return (
    notes.find(n => n.id === query) ??
    notes.find(n => n.title.toLowerCase() === lower) ??
    notes.find(n => n.title.toLowerCase().includes(lower)) ??
    null
  );
}

/** Extract every unchecked `- [ ] …` line from a note body. */
export function extractTodos(content: string): string[] {
  const matches = content.match(/^[ \t]*- \[ \] .+/gm);
  return matches ? matches.map(l => l.replace(/^[ \t]*- \[ \] /, '').trim()) : [];
}

// ─── Git helpers ──────────────────────────────────────────────────────────────

export function getCurrentBranch(workspaceRoot: string): string | null {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: workspaceRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).toString().trim();
  } catch {
    return null;
  }
}

export function getNoteHistory(workspaceRoot: string, devnotesDir: string, noteId: string): string {
  const relPath = path.relative(workspaceRoot, path.join(devnotesDir, `${noteId}.md`)).replace(/\\/g, '/');
  try {
    return execSync(
      `git log --follow --pretty=format:"%h %ad %an: %s" --date=short -- "${relPath}"`,
      { cwd: workspaceRoot, stdio: ['pipe', 'pipe', 'pipe'] }
    ).toString().trim();
  } catch {
    return '';
  }
}

// ─── Workspace detection ──────────────────────────────────────────────────────

/**
 * Resolves the workspace root by checking (in order):
 *   1. DEVNOTES_WORKSPACE environment variable
 *   2. --workspace <path> CLI argument
 *   3. Walk up from CWD looking for an existing .devnotes/ folder
 *   4. Fall back to CWD
 */
export function resolveWorkspace(): string {
  if (process.env.DEVNOTES_WORKSPACE) {
    return path.resolve(process.env.DEVNOTES_WORKSPACE);
  }

  const wsIdx = process.argv.indexOf('--workspace');
  if (wsIdx !== -1 && process.argv[wsIdx + 1]) {
    return path.resolve(process.argv[wsIdx + 1]);
  }

  // Walk up from CWD
  let dir = process.cwd();
  while (true) {
    if (fs.existsSync(path.join(dir, '.devnotes'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return process.cwd();
}
