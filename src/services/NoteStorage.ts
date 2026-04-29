import * as vscode from 'vscode';
import { parseFrontmatter, serializeFrontmatter } from '../utils/Frontmatter';
import { NOTE_COLORS } from '../utils/colors';
export { NOTE_COLORS };

// ─── Data model ──────────────────────────────────────────────────────────────

export interface CodeLink {
  file: string;   // workspace-relative path, e.g. "src/utils.ts"
  line: number;   // 1-based line number
}

export interface GitHubLink {
  url: string;
  repo: string;        // "owner/repo"
  number: number;
  type: 'issue' | 'pr';
  status: string;      // "open" | "closed" | "merged"
  title?: string;
}

export interface Template {
  id: string;
  name: string;
  tags?: string[];   // tag IDs — pre-selects tags when applied
  content: string;   // markdown body
}

export interface Note {
  id: string;
  title: string;
  content: string;       // stored as markdown
  tags: string[];        // array of Tag ids
  starred: boolean;
  shared?: boolean;      // when true, note file is un-ignored in .devnotes/.gitignore
  codeLink?: CodeLink;   // optional link to a specific file:line in the workspace
  branch?: string;       // optional git branch scope — undefined means visible on all branches
  remindAt?: number;     // Unix timestamp (ms) for when a reminder should fire; undefined = no reminder
  owner?: string;        // git user name (or email) of whoever created this note
  archived?: boolean;       // when true, note is hidden from the main list
  linkedNoteIds?: string[]; // IDs of other notes linked to this one
  github?: GitHubLink;      // linked GitHub issue or PR
  conflicted?: boolean;  // true when the file on disk contains unresolved git conflict markers
  createdAt: number;
  updatedAt: number;
}

export interface Tag {
  id: string;
  label: string;
  color: string;         // hex color for the tag pill
  icon?: string | null;  // lucide icon name; null = explicitly cleared
}

// ─── Constants ───────────────────────────────────────────────────────────────


export const DEFAULT_TAGS: Tag[] = [
  { id: 'idea',      label: 'Idea',      color: NOTE_COLORS.yellow,   icon: 'Lightbulb'    },
  { id: 'todo',      label: 'Todo',      color: NOTE_COLORS.blue,     icon: 'ListTodo'     },
  { id: 'bug',       label: 'Bug',       color: NOTE_COLORS.red,      icon: 'Bug'          },
  { id: 'meeting',   label: 'Meeting',   color: NOTE_COLORS.lavender, icon: 'Presentation' },
  { id: 'reference', label: 'Reference', color: NOTE_COLORS.green,    icon: 'BookMarked'   },
];

export const BUILTIN_TEMPLATES: Template[] = [
  {
    id: 'tpl-bug',
    name: 'Bug Report',
    tags: ['bug'],
    content: '## Steps to Reproduce\n1. \n\n## Expected Behavior\n\n## Actual Behavior\n\n## Environment\n- OS: \n- Version: ',
  },
  {
    id: 'tpl-adr',
    name: 'ADR',
    tags: ['reference'],
    content: '## Context\n\n## Decision\n\n## Consequences\n',
  },
  {
    id: 'tpl-meeting',
    name: 'Meeting Notes',
    tags: ['meeting'],
    content: '## Attendees\n- \n\n## Decisions\n- \n\n## Action Items\n- [ ] ',
  },
  {
    id: 'tpl-standup',
    name: 'Standup',
    tags: ['todo'],
    content: '## Done\n- \n\n## Doing\n- \n\n## Blocked\n- ',
  },
  {
    id: 'tpl-feature',
    name: 'Feature Spec',
    tags: ['idea'],
    content: '## Goal\n\n## Acceptance Criteria\n- [ ] \n\n## Notes\n\n## Open Questions\n- ',
  },
  {
    id: 'tpl-review',
    name: 'Code Review',
    tags: ['reference'],
    content: '## What to Check\n- [ ] \n\n## Findings\n\n## Decision\n',
  },
];

export interface ConflictVersions {
  ours       : Note;
  theirs     : Note;
  incomingRef: string; // branch name or commit hash from the >>>>>>> line
  oursRef    : string; // current branch name or short commit hash
}

// ─── Conflict helpers (module-level) ─────────────────────────────────────────

/** Returns true if the raw string contains git conflict markers. */
function hasConflict(raw: string): boolean {
  return raw.includes('<<<<<<<') && raw.includes('=======') && raw.includes('>>>>>>>');
}

/**
 * Removes all conflict blocks from a raw file string, keeping either the
 * "ours" (HEAD) side or the "theirs" (incoming) side of each block.
 */
function resolveConflictRaw(raw: string, side: 'ours' | 'theirs'): string {
  return raw.replace(
    /^<<<<<<< .+\n([\s\S]*?)^=======\n([\s\S]*?)^>>>>>>> .+$\n?/gm,
    (_, ours: string, theirs: string) => side === 'ours' ? ours : theirs
  );
}

// Legacy Memento keys — used only during one-time migration
const LEGACY_NOTES_KEY = 'devnotes.v2.notes';
const LEGACY_TAGS_KEY  = 'devnotes.v2.tags';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

const enc = new TextEncoder();
const dec = new TextDecoder();

// ─── Storage ─────────────────────────────────────────────────────────────────

/**
 * Persists notes as individual Markdown files with YAML frontmatter inside a
 * .devnotes/ folder at the workspace root.
 *
 * File layout
 * ───────────
 *   .devnotes/
 *     .gitignore  – ignores everything except .gitignore and tags.json
 *     tags.json   – custom Tag definitions (committed; shared with team)
 *     <id>.md     – one file per note (personal by default; opt-in sharing
 *                   via the `shared` field which un-ignores the file)
 *
 * Concurrency model
 * ─────────────────
 *   • getNotes() / getTags() are synchronous reads from an in-memory cache.
 *   • Writes to individual note files are serialised per note ID via writeQueues.
 *   • Writes to .gitignore are serialised via a dedicated queue so
 *     read-modify-write operations never race.
 *   • Self-triggered watcher events (our own writes) are suppressed via
 *     selfWrites (notes) and tagsWriteInflight (tags.json).
 *
 * External change detection
 * ─────────────────────────
 *   File watchers on *.md and tags.json update the cache and call
 *   onExternalChange() when files are modified outside the extension
 *   (e.g. after a git pull that brings in a teammate's shared notes).
 */
export class NoteStorage {
  private notes:        Note[]     = [];
  private tags:         Tag[]      = [];
  private templates:    Template[] = []; // custom templates only; BUILTIN_TEMPLATES always prepended
  private customColors:        string[]   = [];
  private savedIcons:          string[]   = [];
  private deletedDefaultIds:   string[]   = [];
  private hiddenDefaultColors: string[]   = [];
  private hiddenDefaultIcons:  string[]   = [];

  /** Called when the cache is updated due to external file changes (e.g. git pull). */
  onExternalChange?: () => void;

  // Per-note write queue — prevents concurrent writes to the same note file
  private readonly writeQueues = new Map<string, Promise<void>>();
  // IDs of notes currently being written by us — suppresses self-triggered watcher events
  private readonly selfWrites  = new Set<string>();

  // Serialised queue for .gitignore (read-modify-write operations must not race)
  private gitignoreWriteQueue: Promise<void> = Promise.resolve();

  // Counter for in-flight tags.json writes — suppresses self-triggered watcher events
  private tagsWriteInflight = 0;

  // Counter for in-flight templates.json writes
  private templatesWriteInflight = 0;

  private readonly folder: vscode.Uri;
  private readonly workspaceRoot: vscode.Uri;

  constructor(
    workspaceRoot: vscode.Uri,
    private readonly legacyWorkspaceState: vscode.Memento,
    private readonly legacyGlobalState:   vscode.Memento,
  ) {
    this.workspaceRoot = workspaceRoot;
    this.folder = vscode.Uri.joinPath(workspaceRoot, '.devnotes');
  }

  /**
   * Must be awaited once before any other method is called.
   * Returns a Disposable for the file watcher — add it to context.subscriptions.
   */
  async init(): Promise<vscode.Disposable> {
    await this.ensureFolder();
    await this.migrate();
    this.notes     = await this.readAllNotes();
    this.tags      = await this.readTags();
    this.templates = await this.readTemplates();
    return this.setupWatcher();
  }

  // ── Sync reads (from cache) ───────────────────────────────────────────────

  getNotes(): Note[] { return this.notes; }

  /** The URI of the .devnotes/ folder — used by EditorPanel for asset management. */
  get folderUri(): vscode.Uri { return this.folder; }

  getNote(id: string): Note | undefined {
    return this.notes.find(n => n.id === id);
  }

  getTags(): Tag[] { return this.tags; }
  getCustomColors():        string[] { return this.customColors; }
  getSavedIcons():          string[] { return [...this.savedIcons]; }
  getHiddenDefaultColors(): string[] { return [...this.hiddenDefaultColors]; }
  getHiddenDefaultIcons():  string[] { return [...this.hiddenDefaultIcons]; }

  async hideDefaultColor(hex: string): Promise<void> {
    if (!this.hiddenDefaultColors.includes(hex)) {
      this.hiddenDefaultColors = [...this.hiddenDefaultColors, hex];
      await this.writeTags();
    }
  }

  async hideDefaultIcon(name: string): Promise<void> {
    if (!this.hiddenDefaultIcons.includes(name)) {
      this.hiddenDefaultIcons = [...this.hiddenDefaultIcons, name];
      await this.writeTags();
    }
  }

  async addSavedIcon(name: string): Promise<void> {
    if (this.savedIcons.includes(name)) return;
    this.savedIcons = [...this.savedIcons, name];
    await this.writeTags();
  }

  async removeSavedIcon(name: string): Promise<void> {
    this.savedIcons = this.savedIcons.filter(n => n !== name);
    await this.writeTags();
  }

  private saveCustomColor(hex: string): void {
    const palette = Object.values(NOTE_COLORS);
    if (hex === 'default' || palette.includes(hex)) return;
    if (!this.customColors.includes(hex)) {
      this.customColors = [...this.customColors, hex].slice(0, 6);
    }
  }

  async removeCustomColor(hex: string): Promise<void> {
    this.customColors = this.customColors.filter(c => c !== hex);
    await this.writeTags();
  }

  /** Returns built-in templates followed by any custom ones. */
  getTemplates(): Template[] { return [...BUILTIN_TEMPLATES, ...this.templates]; }

  // ── Notes ─────────────────────────────────────────────────────────────────

  async createNote(partial: { title: string; tags?: string[]; codeLink?: CodeLink; content?: string; branch?: string; owner?: string }): Promise<Note> {
    const note: Note = {
      id       : generateId(),
      title    : partial.title,
      content  : partial.content ?? '',
      tags     : partial.tags  ?? [],
      starred  : false,
      codeLink : partial.codeLink,
      branch   : partial.branch,
      owner    : partial.owner,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.notes.push(note);
    await this.writeNote(note);
    return note;
  }

  async updateNote(id: string, changes: Partial<Omit<Note, 'id' | 'createdAt'>>): Promise<void> {
    const idx = this.notes.findIndex(n => n.id === id);
    if (idx === -1) return;
    // Never overwrite a conflicted file — the raw conflict markers must stay on disk
    // until the user resolves them through the conflict panel.
    if (this.notes[idx].conflicted) return;
    this.notes[idx] = { ...this.notes[idx], ...changes, updatedAt: Date.now() };
    await this.writeNote(this.notes[idx]);
    if ('shared' in changes) {
      await this.updateGitignore(id, changes.shared ?? false);
    } else if (this.notes[idx].shared && 'content' in changes) {
      await this.updateGitignore(id, true);
    }
  }

  async deleteNote(id: string): Promise<void> {
    try {
      await vscode.workspace.fs.delete(this.noteUri(id));
    } catch { /* already gone */ }
    this.notes = this.notes.filter(n => n.id !== id);
    await this.updateGitignore(id, false);
  }

  // ── Tags ──────────────────────────────────────────────────────────────────

  async addTag(label: string, color: string, icon?: string): Promise<Tag> {
    const tag: Tag = { id: generateId(), label, color, ...(icon ? { icon } : {}) };
    this.tags = [...this.tags, tag];
    this.saveCustomColor(color);
    await this.writeTags();
    return tag;
  }

  async updateTag(id: string, changes: Partial<Pick<Tag, 'label' | 'color' | 'icon'>>): Promise<void> {
    const idx = this.tags.findIndex(t => t.id === id);
    if (idx === -1) return;
    this.tags[idx] = { ...this.tags[idx], ...changes };
    if (this.tags[idx].icon == null) { delete this.tags[idx].icon; }
    if (changes.color) this.saveCustomColor(changes.color);
    await this.writeTags();
  }

  async reorderTags(ids: string[]): Promise<void> {
    const rank = new Map(ids.map((id, i) => [id, i]));
    this.tags.sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity));
    await this.writeTags();
  }

  async deleteTag(id: string): Promise<void> {
    const isDefault = DEFAULT_TAGS.some(t => t.id === id);

    this.tags = this.tags.filter(t => t.id !== id);
    if (isDefault && !this.deletedDefaultIds.includes(id)) {
      this.deletedDefaultIds.push(id);
    }
    await this.writeTags();

    // Scrub tag from affected notes, bumping updatedAt so git history reflects the change
    const affected = this.notes.filter(n => n.tags.includes(id));
    if (affected.length > 0) {
      const now = Date.now();
      this.notes = this.notes.map(n =>
        n.tags.includes(id)
          ? { ...n, tags: n.tags.filter(t => t !== id), updatedAt: now }
          : n
      );
      await Promise.all(
        affected.map(n => this.writeNote(this.notes.find(m => m.id === n.id)!))
      );
    }
  }

  // ── Templates ─────────────────────────────────────────────────────────────

  async addTemplate(partial: { name: string; tags?: string[]; content: string }): Promise<Template> {
    const template: Template = { id: generateId(), ...partial };
    this.templates = [...this.templates, template];
    await this.writeTemplates();
    return template;
  }

  async updateTemplate(id: string, changes: Partial<Pick<Template, 'name' | 'tags' | 'content'>>): Promise<void> {
    const idx = this.templates.findIndex(t => t.id === id);
    if (idx === -1) return;
    this.templates[idx] = { ...this.templates[idx], ...changes };
    await this.writeTemplates();
  }

  async deleteTemplate(id: string): Promise<void> {
    this.templates = this.templates.filter(t => t.id !== id);
    await this.writeTemplates();
  }

  // ── Conflict resolution ───────────────────────────────────────────────────

  /** Returns the VS Code URI for a note file — used to open it in the editor. */
  getNoteFileUri(id: string): vscode.Uri {
    return this.noteUri(id);
  }

  /**
   * Reads the raw conflicted file and returns both parsed versions.
   * Returns null if the file is not found or is no longer conflicted.
   */
  async getConflictVersions(id: string): Promise<ConflictVersions | null> {
    try {
      const raw = dec.decode(await vscode.workspace.fs.readFile(this.noteUri(id)));
      if (!hasConflict(raw)) return null;

      const refMatch  = raw.match(/>>>>>>> (.+)/);
      const incoming  = refMatch ? refMatch[1].trim() : 'incoming';

      const oursNote   = this.parseNoteFile(resolveConflictRaw(raw, 'ours'),   `${id}.md`);
      const theirsNote = this.parseNoteFile(resolveConflictRaw(raw, 'theirs'), `${id}.md`);
      if (!oursNote || !theirsNote) return null;

      // Read current branch from VS Code's built-in git extension
      let oursRef = 'HEAD';
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const gitExt = vscode.extensions.getExtension<any>('vscode.git');
        if (gitExt?.isActive) {
          const repo = gitExt.exports.getAPI(1).getRepository(this.workspaceRoot);
          const head = repo?.state?.HEAD;
          oursRef = head?.name ?? (head?.commit ? String(head.commit).slice(0, 7) : 'HEAD');
        }
      } catch { /* fall back to 'HEAD' */ }

      return { ours: oursNote, theirs: theirsNote, incomingRef: incoming, oursRef };
    } catch {
      return null;
    }
  }

  /**
   * Resolves a conflicted note file.
   *
   * 'ours'   — keeps the HEAD version entirely.
   * 'theirs' — keeps the incoming version entirely.
   * 'both'   — merges: tags are unioned; content is concatenated with a
   *             divider; all other single-value fields come from 'ours'.
   */
  async resolveConflict(id: string, side: 'ours' | 'theirs' | 'both'): Promise<void> {
    const prev  = this.writeQueues.get(id) ?? Promise.resolve();
    const next  = prev.then(() =>
      side === 'both'
        ? this.doMergeConflict(id)
        : this.doResolveConflict(id, side)
    );
    const entry = next.catch(() => {}).finally(() => {
      if (this.writeQueues.get(id) === entry) this.writeQueues.delete(id);
    });
    this.writeQueues.set(id, entry);
    return next;
  }

  private async doResolveConflict(id: string, side: 'ours' | 'theirs'): Promise<void> {
    const uri = this.noteUri(id);
    const raw = dec.decode(await vscode.workspace.fs.readFile(uri));
    if (!hasConflict(raw)) return;

    const resolved = resolveConflictRaw(raw, side);
    this.selfWrites.add(id);
    try {
      await vscode.workspace.fs.writeFile(uri, enc.encode(resolved));
      const note = this.parseNoteFile(resolved, `${id}.md`);
      if (!note) return;
      const idx = this.notes.findIndex(n => n.id === id);
      if (idx === -1) this.notes.push(note);
      else            this.notes[idx] = note;
    } finally {
      setTimeout(() => this.selfWrites.delete(id), 500);
    }
  }

  private async doMergeConflict(id: string): Promise<void> {
    const uri = this.noteUri(id);
    const raw = dec.decode(await vscode.workspace.fs.readFile(uri));
    if (!hasConflict(raw)) return;

    const oursNote   = this.parseNoteFile(resolveConflictRaw(raw, 'ours'),   `${id}.md`);
    const theirsNote = this.parseNoteFile(resolveConflictRaw(raw, 'theirs'), `${id}.md`);
    if (!oursNote || !theirsNote) return;

    // Union tags, deduplicated
    const mergedTags = [...new Set([...oursNote.tags, ...theirsNote.tags])];

    // Concatenate content with a divider — only if both sides have content
    const oursContent   = oursNote.content.trim();
    const theirsContent = theirsNote.content.trim();
    let mergedContent: string;
    if (!oursContent) {
      mergedContent = theirsContent;
    } else if (!theirsContent) {
      mergedContent = oursContent;
    } else {
      mergedContent = `${oursContent}\n\n---\n\n${theirsContent}`;
    }

    // Single-value fields (title, branch, etc.) come from ours
    const merged: Note = {
      ...oursNote,
      tags      : mergedTags,
      content   : mergedContent,
      conflicted: undefined,
      updatedAt : Date.now(),
    };

    // Write via the normal note serialisation path (doWriteNote manages selfWrites)
    await this.doWriteNote(merged);
    const idx = this.notes.findIndex(n => n.id === id);
    if (idx === -1) this.notes.push(merged);
    else            this.notes[idx] = merged;
  }

  async resolveConflictMerged(id: string, mergedData: { title: string; tags: string[]; content: string }): Promise<void> {
    const prev  = this.writeQueues.get(id) ?? Promise.resolve();
    const next  = prev.then(() => this.doMergeConflictCustom(id, mergedData));
    const entry = next.catch(() => {}).finally(() => {
      if (this.writeQueues.get(id) === entry) this.writeQueues.delete(id);
    });
    this.writeQueues.set(id, entry);
    return next;
  }

  private async doMergeConflictCustom(id: string, mergedData: { title: string; tags: string[]; content: string }): Promise<void> {
    const uri = this.noteUri(id);
    const raw = dec.decode(await vscode.workspace.fs.readFile(uri));
    if (!hasConflict(raw)) return;

    const oursNote = this.parseNoteFile(resolveConflictRaw(raw, 'ours'), `${id}.md`);
    if (!oursNote) return;

    const merged: Note = {
      ...oursNote,
      title     : mergedData.title,
      tags      : mergedData.tags,
      content   : mergedData.content,
      conflicted: undefined,
      updatedAt : Date.now(),
    };

    await this.doWriteNote(merged);
    const idx = this.notes.findIndex(n => n.id === id);
    if (idx === -1) this.notes.push(merged);
    else            this.notes[idx] = merged;
  }

  // ── Private: folder setup ─────────────────────────────────────────────────

  private async ensureFolder(): Promise<void> {
    try {
      await vscode.workspace.fs.createDirectory(this.folder);
    } catch { /* already exists */ }

    const gitignorePath = vscode.Uri.joinPath(this.folder, '.gitignore');
    try {
      await vscode.workspace.fs.stat(gitignorePath);
    } catch {
      // Ignore everything by default — the folder stays invisible to git until
      // the user explicitly marks a note as shared. Nothing surfaces without consent.
      await vscode.workspace.fs.writeFile(gitignorePath, enc.encode('*\n'));
    }
  }

  // ── Private: file I/O ─────────────────────────────────────────────────────

  private noteUri(id: string): vscode.Uri {
    return vscode.Uri.joinPath(this.folder, `${id}.md`);
  }

  private async readAllNotes(): Promise<Note[]> {
    try {
      const entries = await vscode.workspace.fs.readDirectory(this.folder);
      const results = await Promise.all(
        entries
          .filter(([name]) => name.endsWith('.md'))
          .map(async ([name]) => {
            try {
              const raw = await vscode.workspace.fs.readFile(
                vscode.Uri.joinPath(this.folder, name)
              );
              return this.parseNoteFile(dec.decode(raw), name);
            } catch (err) {
              console.warn(`[DevNotes] Could not read note file "${name}":`, err);
              return null;
            }
          })
      );
      return results.filter((n): n is Note => n !== null);
    } catch {
      return [];
    }
  }

  private parseNoteFile(raw: string, fileName = '<unknown>'): Note | null {
    // Conflict markers break the frontmatter parser — resolve to 'ours' first
    // so the note remains usable, then flag it for the UI to surface.
    const isConflicted = hasConflict(raw);
    const effective    = isConflicted ? resolveConflictRaw(raw, 'ours') : raw;

    try {
      const { meta, body } = parseFrontmatter(effective);
      const id = String(meta.id ?? '');
      if (!id) {
        console.warn(`[DevNotes] Skipping "${fileName}": missing id in frontmatter`);
        return null;
      }
      return {
        id,
        title    : String(meta.title    ?? 'Untitled'),
        content  : body,
        tags     : meta.tags ? String(meta.tags).split(',').filter(Boolean) : [],
        starred  : meta.starred  === true,
        shared   : meta.shared   === true || undefined,
        codeLink : (typeof meta.codeLink_file === 'string' && meta.codeLink_file && meta.codeLink_line !== undefined)
          ? { file: meta.codeLink_file, line: Number(meta.codeLink_line) }
          : undefined,
        branch     : typeof meta.branch === 'string' && meta.branch ? meta.branch : undefined,
        owner      : typeof meta.owner  === 'string' && meta.owner  ? meta.owner  : undefined,
        remindAt   : meta.remindAt ? Number(meta.remindAt) : undefined,
        archived      : meta.archived === true || undefined,
        linkedNoteIds : (typeof meta.linked_notes === 'string' && meta.linked_notes)
          ? meta.linked_notes.split(',').filter(Boolean)
          : undefined,
        github     : (meta.github_url && meta.github_number)
          ? {
              url    : String(meta.github_url),
              repo   : String(meta.github_repo   ?? ''),
              number : Number(meta.github_number),
              type   : (meta.github_type === 'pr' ? 'pr' : 'issue') as 'issue' | 'pr',
              status : String(meta.github_status  ?? 'open'),
              title  : meta.github_title ? String(meta.github_title) : undefined,
            }
          : undefined,
        conflicted : isConflicted || undefined,
        createdAt  : Number(meta.createdAt ?? Date.now()),
        updatedAt  : Number(meta.updatedAt ?? Date.now()),
      };
    } catch (err) {
      console.warn(`[DevNotes] Failed to parse "${fileName}":`, err);
      return null;
    }
  }

  // ── Write queue — serialises concurrent writes to the same file ───────────

  private writeNote(note: Note): Promise<void> {
    const prev = this.writeQueues.get(note.id) ?? Promise.resolve();
    const next = prev.then(() => this.doWriteNote(note));
    // Non-rejecting entry so future writes are never blocked by an error.
    // Cleans itself up once settled and no newer write has replaced it.
    const entry = next.catch(() => {}).finally(() => {
      if (this.writeQueues.get(note.id) === entry) this.writeQueues.delete(note.id);
    });
    this.writeQueues.set(note.id, entry);
    return next;
  }

  private async doWriteNote(note: Note): Promise<void> {
    this.selfWrites.add(note.id);
    try {
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
      if (note.linkedNoteIds?.length) meta.linked_notes = note.linkedNoteIds.join(',');
      if (note.github) {
        meta.github_url    = note.github.url;
        meta.github_repo   = note.github.repo;
        meta.github_number = note.github.number;
        meta.github_type   = note.github.type;
        meta.github_status = note.github.status;
        if (note.github.title) meta.github_title = note.github.title;
      }
      if (note.codeLink) {
        meta.codeLink_file = note.codeLink.file;
        meta.codeLink_line = note.codeLink.line;
      }
      await vscode.workspace.fs.writeFile(
        this.noteUri(note.id),
        enc.encode(serializeFrontmatter(meta, note.content))
      );
    } finally {
      // Clear after a short delay — watcher events arrive asynchronously
      setTimeout(() => this.selfWrites.delete(note.id), 500);
    }
  }

  private async readTags(): Promise<Tag[]> {
    try {
      const raw    = await vscode.workspace.fs.readFile(
        vscode.Uri.joinPath(this.folder, 'tags.json')
      );
      const parsed = JSON.parse(dec.decode(raw));
      const custom: Tag[] = Array.isArray(parsed) ? parsed : (parsed.tags ?? []);
      const order:  string[] | undefined = Array.isArray(parsed) ? undefined : parsed.order;
      this.customColors        = Array.isArray(parsed) ? [] : (parsed.customColors        ?? []);
      this.savedIcons          = Array.isArray(parsed) ? [] : (parsed.savedIcons          ?? []);
      this.deletedDefaultIds   = Array.isArray(parsed) ? [] : (parsed.deletedDefaultIds   ?? []);
      this.hiddenDefaultColors = Array.isArray(parsed) ? [] : (parsed.hiddenDefaultColors ?? []);
      this.hiddenDefaultIcons  = Array.isArray(parsed) ? [] : (parsed.hiddenDefaultIcons  ?? []);
      const customIds = new Set(custom.map(t => t.id));
      const deleted   = new Set(this.deletedDefaultIds);
      const merged = [
        ...DEFAULT_TAGS.filter(t => !customIds.has(t.id) && !deleted.has(t.id)),
        ...custom,
      ];
      if (order?.length) {
        const rank = new Map(order.map((id, i) => [id, i]));
        merged.sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity));
      }
      return merged;
    } catch {
      return [...DEFAULT_TAGS];
    }
  }

  private async writeTags(): Promise<void> {
    this.tagsWriteInflight++;
    try {
      const defaultIds = new Set(DEFAULT_TAGS.map(t => t.id));
      const defaultMap = new Map(DEFAULT_TAGS.map(t => [t.id, t]));
      const custom = this.tags.filter(t => {
        if (!defaultIds.has(t.id)) return true;
        const def = defaultMap.get(t.id)!;
        return t.color !== def.color || t.label !== def.label || t.icon !== def.icon;
      });
      await vscode.workspace.fs.writeFile(
        vscode.Uri.joinPath(this.folder, 'tags.json'),
        enc.encode(JSON.stringify({ tags: custom, order: this.tags.map(t => t.id), customColors: this.customColors, savedIcons: this.savedIcons, deletedDefaultIds: this.deletedDefaultIds, hiddenDefaultColors: this.hiddenDefaultColors, hiddenDefaultIcons: this.hiddenDefaultIcons }, null, 2))
      );
    } finally {
      setTimeout(() => this.tagsWriteInflight--, 500);
    }
  }

  private async readTemplates(): Promise<Template[]> {
    try {
      const raw = await vscode.workspace.fs.readFile(
        vscode.Uri.joinPath(this.folder, 'templates.json')
      );
      return JSON.parse(dec.decode(raw)) as Template[];
    } catch {
      return [];
    }
  }

  private async writeTemplates(): Promise<void> {
    this.templatesWriteInflight++;
    try {
      await vscode.workspace.fs.writeFile(
        vscode.Uri.joinPath(this.folder, 'templates.json'),
        enc.encode(JSON.stringify(this.templates, null, 2))
      );
    } finally {
      setTimeout(() => this.templatesWriteInflight--, 500);
    }
  }

  // Serialised via gitignoreWriteQueue — each read-modify-write sees the previous result
  private updateGitignore(id: string, shared: boolean): Promise<void> {
    this.gitignoreWriteQueue = this.gitignoreWriteQueue
      .then(() => this.doUpdateGitignore(id, shared))
      .catch((err) => { console.error('[DevNotes] .gitignore update failed:', err); });
    return this.gitignoreWriteQueue;
  }

  private noteImageFilenames(content: string): string[] {
    const filenames: string[] = [];
    const regex = /!\[[^\]]*\]\(\.devnotes\/assets\/([^)]+)\)/g;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(content)) !== null) filenames.push(m[1]);
    return filenames;
  }

  private async doUpdateGitignore(id: string, shared: boolean): Promise<void> {
    const gitignorePath = vscode.Uri.joinPath(this.folder, '.gitignore');
    let content: string;
    try {
      content = dec.decode(await vscode.workspace.fs.readFile(gitignorePath));
    } catch {
      return;
    }

    const noteEntry      = `!${id}.md`;
    const gitignoreEntry = '!.gitignore';
    const tagsEntry      = '!tags.json';

    // Normalise line endings (CRLF → LF) and strip blank lines to keep the
    // file tidy after repeated edits.
    let lines = content
      .split(/\r?\n/)
      .filter(l => l.trim() !== '' || l === '*') // preserve the wildcard line
      .filter(l => l.trim() !== noteEntry);       // remove stale note entry

    if (shared) {
      // Un-ignore .gitignore and tags.json the first time any note is shared
      // so teammates can pull both the sharing rules and custom tag definitions.
      if (!lines.some(l => l.trim() === gitignoreEntry)) {
        lines.push(gitignoreEntry);
      }
      if (!lines.some(l => l.trim() === tagsEntry)) {
        lines.push(tagsEntry);
      }
      lines.push(noteEntry);

      // Un-ignore every image asset referenced by this note.
      const note = this.notes.find(n => n.id === id);
      if (note) {
        for (const img of this.noteImageFilenames(note.content)) {
          const assetEntry = `!assets/${img}`;
          if (!lines.some(l => l.trim() === assetEntry)) lines.push(assetEntry);
        }
      }
    } else {
      // Remove asset entries that are no longer referenced by any shared note.
      // The note being un-shared (or deleted) is already absent from this.notes
      // at delete time, and present-but-shared=false at un-share time — either
      // way it won't contribute images to the retained set below.
      const retainedAssets = new Set<string>();
      for (const note of this.notes) {
        if (note.id !== id && note.shared) {
          for (const img of this.noteImageFilenames(note.content)) {
            retainedAssets.add(img);
          }
        }
      }
      lines = lines.filter(l => {
        const m = l.trim().match(/^!assets\/(.+)$/);
        return !m || retainedAssets.has(m[1]);
      });
    }

    await vscode.workspace.fs.writeFile(gitignorePath, enc.encode(lines.join('\n') + '\n'));
  }

  // ── Private: file watcher ─────────────────────────────────────────────────

  private setupWatcher(): vscode.Disposable {
    // ── Notes watcher (.devnotes/*.md) ──────────────────────────────────
    const notesWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(this.folder, '*.md')
    );

    const reload = async (uri: vscode.Uri): Promise<void> => {
      const fileName = uri.path.split('/').pop() ?? '';
      const id = fileName.endsWith('.md') ? fileName.slice(0, -3) : '';
      if (!id) return;
      if (this.selfWrites.has(id)) { this.selfWrites.delete(id); return; }
      try {
        const raw  = dec.decode(await vscode.workspace.fs.readFile(uri));
        const note = this.parseNoteFile(raw, fileName);
        if (!note) return;
        const idx = this.notes.findIndex(n => n.id === note.id);
        if (idx === -1) this.notes.push(note);
        else this.notes[idx] = note;
        this.onExternalChange?.();
      } catch { /* file removed between event and read — ignore */ }
    };

    const evict = (uri: vscode.Uri): void => {
      const fileName = uri.path.split('/').pop() ?? '';
      const id = fileName.endsWith('.md') ? fileName.slice(0, -3) : '';
      if (!id) return;
      if (this.selfWrites.has(id)) { this.selfWrites.delete(id); return; }
      const before = this.notes.length;
      this.notes = this.notes.filter(n => n.id !== id);
      if (this.notes.length !== before) this.onExternalChange?.();
    };

    notesWatcher.onDidCreate(reload);
    notesWatcher.onDidChange(reload);
    notesWatcher.onDidDelete(evict);

    // ── Tags watcher (.devnotes/tags.json) ──────────────────────────────
    const tagsWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(this.folder, 'tags.json')
    );

    const reloadTags = async (): Promise<void> => {
      if (this.tagsWriteInflight > 0) return;
      this.tags = await this.readTags();
      this.onExternalChange?.();
    };

    tagsWatcher.onDidChange(reloadTags);
    tagsWatcher.onDidCreate(reloadTags);

    // ── Templates watcher (.devnotes/templates.json) ─────────────────────
    const templatesWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(this.folder, 'templates.json')
    );

    const reloadTemplates = async (): Promise<void> => {
      if (this.templatesWriteInflight > 0) return;
      this.templates = await this.readTemplates();
      this.onExternalChange?.();
    };

    templatesWatcher.onDidChange(reloadTemplates);
    templatesWatcher.onDidCreate(reloadTemplates);

    return vscode.Disposable.from(notesWatcher, tagsWatcher, templatesWatcher);
  }

  // ── Private: one-time migration from Memento ──────────────────────────────

  private async migrate(): Promise<void> {
    // ── Notes (workspace-scoped → .md files) ────────────────────────────
    const legacyNotes = this.legacyWorkspaceState.get<any[]>(LEGACY_NOTES_KEY, []);
    if (legacyNotes.length > 0) {
      for (const raw of legacyNotes) {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { canvas, ...note } = raw;
        await this.writeNote(note as Note);
      }
      await this.legacyWorkspaceState.update(LEGACY_NOTES_KEY, undefined);
    }

    // ── Tags (global → tags.json, only if file doesn't exist yet) ───────
    const tagsPath = vscode.Uri.joinPath(this.folder, 'tags.json');
    let tagsFileExists = false;
    try {
      await vscode.workspace.fs.stat(tagsPath);
      tagsFileExists = true;
    } catch { /* file doesn't exist */ }

    if (!tagsFileExists) {
      const legacyTags = this.legacyGlobalState.get<Tag[]>(LEGACY_TAGS_KEY, []);
      if (legacyTags.length > 0) {
        await vscode.workspace.fs.writeFile(
          tagsPath,
          enc.encode(JSON.stringify(legacyTags, null, 2))
        );
      }
      // Note: legacyGlobalState is NOT cleared — other workspaces need it for their own migration
    }
  }
}
