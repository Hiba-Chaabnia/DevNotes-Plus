#!/usr/bin/env node
/**
 * DevNotes MCP Server
 *
 * Exposes DevNotes as tools, resources, and prompts for Claude Code.
 * Notes are read directly from the .devnotes/ folder in the workspace,
 * using the same frontmatter format as the VS Code extension.
 *
 * Registration — click the bot icon button in the DevNotes sidebar, or run:
 *
 *   claude mcp add --scope user devnotes node /path/to/mcp-server/dist/index.js
 *
 * The server auto-detects the workspace by walking up from the CWD.
 * Override with: DEVNOTES_WORKSPACE=/path/to/project or --workspace flag.
 */

import { Server }              from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import * as fs   from 'fs';
import * as path from 'path';

import {
  Note,
  readAllNotes,
  readNote,
  writeNote,
  deleteNote,
  readTags,
  findNote,
  extractTodos,
  generateId,
  getCurrentBranch,
  getNoteHistory,
  resolveWorkspace,
} from './notes.js';

import {
  parseGitHubUrl,
  fetchIssue,
  fetchComments,
  deriveStatus,
  setDevnotesDir,
} from './github.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Parse an ISO date string (YYYY-MM-DD) into a 9:00 AM Unix timestamp in ms. */
function parseRemindAt(dateStr: string): number {
  const d = new Date(dateStr);
  d.setHours(9, 0, 0, 0);
  return d.getTime();
}

// ─── Workspace setup ──────────────────────────────────────────────────────────

const WORKSPACE    = resolveWorkspace();
const DEVNOTES_DIR = path.join(WORKSPACE, '.devnotes');
setDevnotesDir(DEVNOTES_DIR);

// ─── Server ───────────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'devnotes', version: '1.0.0' },
  {
    capabilities: {
      tools    : {},
      resources: {},
      prompts  : {},
    },
  }
);

// ═══════════════════════════════════════════════════════════════════════════════
// TOOLS
// ═══════════════════════════════════════════════════════════════════════════════

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name       : 'create_note',
      description: 'Create a new DevNote in the current workspace. Use when asked to capture, document, or save any information. Tags can be: bug, todo, idea, meeting, reference (or any custom tag id).',
      inputSchema: {
        type      : 'object',
        properties: {
          title          : { type: 'string',  description: 'Note title (required)' },
          content        : { type: 'string',  description: 'Note body in Markdown' },
          tags           : { type: 'array', items: { type: 'string' }, description: 'Tag IDs to apply (e.g. ["bug", "todo"])' },
          codeLink_file  : { type: 'string',  description: 'Workspace-relative file path to link this note to (e.g. "src/auth.ts")' },
          codeLink_line  : { type: 'number',  description: '1-based line number for the code link' },
          branch         : { type: 'string',  description: 'Scope this note to a specific git branch. Omit for all-branch visibility.' },
          remindAt       : { type: 'string',  description: 'ISO 8601 date string for a reminder (e.g. "2026-04-20"). Fires at 9:00 AM on that date.' },
        },
        required: ['title'],
      },
    },
    {
      name       : 'get_note',
      description: 'Retrieve a single DevNote by ID or title (fuzzy match). Use before appending or analyzing a note. Returns the full content including all metadata.',
      inputSchema: {
        type      : 'object',
        properties: {
          query: { type: 'string', description: 'Note ID or title (partial title match is supported)' },
        },
        required: ['query'],
      },
    },
    {
      name       : 'list_notes',
      description: 'List DevNotes with optional filters. Use to find notes, get an overview of what has been captured, or check if a note already exists before creating a new one.',
      inputSchema: {
        type      : 'object',
        properties: {
          tag      : { type: 'string',  description: 'Filter by tag ID (e.g. "bug")' },
          search   : { type: 'string',  description: 'Filter by text in title or content' },
          branch   : { type: 'string',  description: 'Filter by branch scope. Use "current" to auto-detect the active branch.' },
          starred  : { type: 'boolean', description: 'If true, return only starred notes' },
          archived : { type: 'boolean', description: 'If true, return only archived notes. Defaults to false (archived notes are excluded by default).' },
        },
      },
    },
    {
      name       : 'append_to_note',
      description: 'Append content to an existing note. Use to add a solution, follow-up, or new section without replacing the existing content. The append includes a timestamp.',
      inputSchema: {
        type      : 'object',
        properties: {
          query  : { type: 'string', description: 'Note ID or title to append to' },
          content: { type: 'string', description: 'Markdown content to append' },
          heading: { type: 'string', description: 'Optional heading for the appended section (e.g. "Solution", "Update")' },
        },
        required: ['query', 'content'],
      },
    },
    {
      name       : 'update_note',
      description: 'Update a note\'s metadata: title, tags, starred status, or shared status. Does not affect the note body — use append_to_note for content changes.',
      inputSchema: {
        type      : 'object',
        properties: {
          query  : { type: 'string',  description: 'Note ID or title' },
          title  : { type: 'string',  description: 'New title' },
          tags   : { type: 'array', items: { type: 'string' }, description: 'Replace tag list' },
          starred  : { type: 'boolean', description: 'Set starred status' },
          archived : { type: 'boolean', description: 'Set archived status. Archived notes are hidden from the main list but not deleted.' },
          shared   : { type: 'boolean', description: 'Set shared status (makes note visible to teammates via git)' },
          owner    : { type: 'string',  description: 'Assign ownership (e.g. a teammate\'s name)' },
          remindAt : { type: 'string',  description: 'ISO 8601 date string for a reminder (e.g. "2026-04-20"). Set to empty string to clear.' },
        },
        required: ['query'],
      },
    },
    {
      name       : 'get_todos',
      description: 'Extract all unchecked todo items (- [ ] lines) from every note. Returns a unified list grouped by note. Use to get a full picture of open tasks or help the developer prioritize.',
      inputSchema: {
        type      : 'object',
        properties: {
          tag: { type: 'string', description: 'Optionally restrict to notes with a specific tag' },
        },
      },
    },
    {
      name       : 'get_stale_notes',
      description: 'Find notes that haven\'t been updated in N days AND still contain unresolved items (open todos or bug tag). Use to surface neglected work or help with a weekly review.',
      inputSchema: {
        type      : 'object',
        properties: {
          days: { type: 'number', description: 'Staleness threshold in days (default: 14)' },
        },
      },
    },
    {
      name       : 'note_history',
      description: 'Show the git commit history for a specific note file. Useful for shared notes — shows who changed it and when. Requires the workspace to be a git repository.',
      inputSchema: {
        type      : 'object',
        properties: {
          query: { type: 'string', description: 'Note ID or title' },
        },
        required: ['query'],
      },
    },
    {
      name       : 'log_session',
      description: 'Append a timestamped entry to the persistent session log note. Call this automatically at the end of every work session — or whenever the user says goodbye, wraps up, or asks to stop — to record what was accomplished, what\'s in progress, and what\'s blocked.',
      inputSchema: {
        type      : 'object',
        properties: {
          done      : { type: 'string', description: 'What was completed in this session' },
          in_progress: { type: 'string', description: 'What is still in progress' },
          blocked   : { type: 'string', description: 'Any blockers or open questions' },
          notes     : { type: 'string', description: 'Any additional context worth preserving' },
        },
        required: ['done'],
      },
    },
    {
      name       : 'complete_todo',
      description: 'Mark one or more todo items as done (- [ ] → - [x]) inside a note. Matches by substring — all unchecked items whose text contains the given string are completed.',
      inputSchema: {
        type      : 'object',
        properties: {
          query: { type: 'string', description: 'Note ID or title' },
          item : { type: 'string', description: 'Substring of the todo text to match (case-insensitive)' },
        },
        required: ['query', 'item'],
      },
    },
    {
      name       : 'delete_note',
      description: 'Permanently delete a note from the workspace. Use only when explicitly asked to remove or delete a note. This action cannot be undone.',
      inputSchema: {
        type      : 'object',
        properties: {
          query  : { type: 'string',  description: 'Note ID or title' },
          confirm: { type: 'boolean', description: 'Must be true to proceed (safety guard)' },
        },
        required: ['query', 'confirm'],
      },
    },
    {
      name       : 'link_github',
      description: 'Link a DevNote to a GitHub issue or pull request. Fetches the title and current status (open/closed/merged) from the GitHub API and stores them in the note frontmatter. Requires DEVNOTES_GITHUB_TOKEN env var for private repos.',
      inputSchema: {
        type      : 'object',
        properties: {
          query     : { type: 'string', description: 'Note ID or title to link' },
          github_url: { type: 'string', description: 'Full GitHub issue or PR URL, e.g. https://github.com/owner/repo/issues/42' },
        },
        required: ['query', 'github_url'],
      },
    },
    {
      name       : 'get_github_context',
      description: 'Fetch full context from GitHub for a note that is linked to an issue or PR: title, description, labels, assignees, and the last 20 comments. Use to get the full picture of a linked issue without leaving DevNotes.',
      inputSchema: {
        type      : 'object',
        properties: {
          query: { type: 'string', description: 'Note ID or title' },
        },
        required: ['query'],
      },
    },
    {
      name       : 'search_notes',
      description: 'Full-text search across all notes with ranked results and match snippets. Returns results ordered by relevance — title matches rank above content matches, and notes with more matches rank higher. Use when you need to find a note by topic, keyword, or phrase rather than exact title.',
      inputSchema: {
        type      : 'object',
        properties: {
          query           : { type: 'string',  description: 'Search query — space-separated terms are ANDed (all must be present)' },
          limit           : { type: 'number',  description: 'Maximum number of results to return (default: 10)' },
          include_archived: { type: 'boolean', description: 'Include archived notes in results (default: false)' },
        },
        required: ['query'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  try {
    switch (name) {

      // ── create_note ─────────────────────────────────────────────────────────
      case 'create_note': {
        const { title, content = '', tags = [], color = 'yellow', codeLink_file, codeLink_line, branch, remindAt: remindAtStr } = args as {
          title: string; content?: string; tags?: string[]; color?: string;
          codeLink_file?: string; codeLink_line?: number; branch?: string; remindAt?: string;
        };

        const remindAt = remindAtStr ? parseRemindAt(remindAtStr) : undefined;

        const note: Note = {
          id       : generateId(),
          title,
          content,
          color,
          tags,
          starred  : false,
          owner    : 'Claude Code',
          branch,
          remindAt,
          codeLink : codeLink_file ? { file: codeLink_file, line: codeLink_line ?? 1 } : undefined,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };

        writeNote(DEVNOTES_DIR, note);

        const tagList = tags.length ? ` [${tags.join(', ')}]` : '';
        return { content: [{ type: 'text', text: `Note created: "${title}"${tagList}\nID: ${note.id}` }] };
      }

      // ── get_note ────────────────────────────────────────────────────────────
      case 'get_note': {
        const { query } = args as { query: string };
        const notes = readAllNotes(DEVNOTES_DIR);
        const note  = findNote(notes, query);

        if (!note) {
          return { content: [{ type: 'text', text: `No note found matching "${query}".` }], isError: true };
        }

        const tags = readTags(DEVNOTES_DIR);
        const tagLabels = note.tags
          .map(id => tags.find(t => t.id === id)?.label ?? id)
          .join(', ');

        const lines: string[] = [
          `# ${note.title}`,
          `**ID:** ${note.id}`,
          tagLabels ? `**Tags:** ${tagLabels}` : '',
          note.starred ? '**Starred:** yes' : '',
          note.branch  ? `**Branch:** ${note.branch}` : '',
          note.owner   ? `**Owner:** ${note.owner}` : '',
          note.codeLink ? `**Linked to:** ${note.codeLink.file}:${note.codeLink.line}` : '',
          note.archived ? '**Archived:** yes' : '',
          note.shared  ? '**Shared:** yes (visible in git)' : '',
          note.github  ? `**GitHub:** ${note.github.type === 'pr' ? 'PR' : 'Issue'} #${note.github.number} (${note.github.status ?? 'unknown'}) — ${note.github.url}` : '',
          `**Created:** ${new Date(note.createdAt).toLocaleDateString()}`,
          `**Updated:** ${new Date(note.updatedAt).toLocaleDateString()}`,
          '',
          '---',
          '',
          note.content || '*(empty)*',
        ];

        return { content: [{ type: 'text', text: lines.filter(l => l !== '').join('\n') }] };
      }

      // ── list_notes ──────────────────────────────────────────────────────────
      case 'list_notes': {
        const { tag, search, branch, starred, archived } = args as {
          tag?: string; search?: string; branch?: string; starred?: boolean; archived?: boolean;
        };

        let notes = readAllNotes(DEVNOTES_DIR);

        // Resolve "current" branch alias
        const branchFilter = branch === 'current' ? getCurrentBranch(WORKSPACE) : branch;

        // Exclude archived notes by default; show only archived when explicitly requested
        notes = archived ? notes.filter(n => n.archived) : notes.filter(n => !n.archived);

        if (tag)          notes = notes.filter(n => n.tags.includes(tag));
        if (branchFilter) notes = notes.filter(n => n.branch === branchFilter || !n.branch);
        if (starred)      notes = notes.filter(n => n.starred);
        if (search) {
          const lower = search.toLowerCase();
          notes = notes.filter(n =>
            n.title.toLowerCase().includes(lower) ||
            n.content.toLowerCase().includes(lower)
          );
        }

        // Sort: starred first, then by updatedAt desc
        notes.sort((a, b) => {
          if (a.starred !== b.starred) return a.starred ? -1 : 1;
          return b.updatedAt - a.updatedAt;
        });

        if (notes.length === 0) {
          return { content: [{ type: 'text', text: 'No notes found matching the given filters.' }] };
        }

        const lines = notes.map(n => {
          const tagStr    = n.tags.length ? ` [${n.tags.join(', ')}]` : '';
          const starStr   = n.starred ? ' ★' : '';
          const branchStr = n.branch  ? ` (${n.branch})` : '';
          const date      = new Date(n.updatedAt).toLocaleDateString();
          const preview   = n.content.trim().split('\n')[0]?.slice(0, 60) ?? '';
          return `• **${n.title}**${starStr}${tagStr}${branchStr} — ${date}\n  ID: ${n.id}${preview ? `\n  ${preview}` : ''}`;
        });

        return { content: [{ type: 'text', text: `Found ${notes.length} note(s):\n\n${lines.join('\n\n')}` }] };
      }

      // ── append_to_note ──────────────────────────────────────────────────────
      case 'append_to_note': {
        const { query, content, heading } = args as { query: string; content: string; heading?: string };

        const notes = readAllNotes(DEVNOTES_DIR);
        const note  = findNote(notes, query);
        if (!note) {
          return { content: [{ type: 'text', text: `No note found matching "${query}".` }], isError: true };
        }

        const timestamp = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        const headingLine = heading
          ? `\n\n## ${heading} *(${timestamp})*\n\n`
          : `\n\n---\n*${timestamp}*\n\n`;

        note.content  = (note.content.trimEnd()) + headingLine + content;
        note.updatedAt = Date.now();
        writeNote(DEVNOTES_DIR, note);

        return { content: [{ type: 'text', text: `Appended to "${note.title}" (ID: ${note.id}).` }] };
      }

      // ── update_note ─────────────────────────────────────────────────────────
      case 'update_note': {
        const { query, title, tags, starred, archived, shared, owner, remindAt: remindAtStr } = args as {
          query: string; title?: string; tags?: string[];
          starred?: boolean; archived?: boolean; shared?: boolean; owner?: string; remindAt?: string;
        };

        const notes = readAllNotes(DEVNOTES_DIR);
        const note  = findNote(notes, query);
        if (!note) {
          return { content: [{ type: 'text', text: `No note found matching "${query}".` }], isError: true };
        }

        if (title      !== undefined) note.title    = title;
        if (tags       !== undefined) note.tags      = tags;
        if (starred    !== undefined) note.starred   = starred;
        if (archived   !== undefined) note.archived  = archived || undefined;
        if (shared     !== undefined) note.shared    = shared;
        if (owner      !== undefined) note.owner     = owner || undefined;
        if (remindAtStr !== undefined) {
          note.remindAt = remindAtStr === '' ? undefined : parseRemindAt(remindAtStr);
        }
        note.updatedAt = Date.now();

        writeNote(DEVNOTES_DIR, note);
        return { content: [{ type: 'text', text: `Updated note "${note.title}" (ID: ${note.id}).` }] };
      }

      // ── get_todos ───────────────────────────────────────────────────────────
      case 'get_todos': {
        const { tag } = args as { tag?: string };

        let notes = readAllNotes(DEVNOTES_DIR).filter(n => !n.archived);
        if (tag) notes = notes.filter(n => n.tags.includes(tag));

        const sections: string[] = [];
        let total = 0;

        for (const note of notes) {
          const todos = extractTodos(note.content);
          if (todos.length === 0) continue;
          total += todos.length;
          sections.push(`**${note.title}** (${note.id})\n${todos.map(t => `  - [ ] ${t}`).join('\n')}`);
        }

        if (total === 0) {
          return { content: [{ type: 'text', text: 'No open todos found across any notes.' }] };
        }

        return {
          content: [{ type: 'text', text: `${total} open todo(s) across ${sections.length} note(s):\n\n${sections.join('\n\n')}` }],
        };
      }

      // ── get_stale_notes ─────────────────────────────────────────────────────
      case 'get_stale_notes': {
        const { days = 14 } = args as { days?: number };
        const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

        const stale = readAllNotes(DEVNOTES_DIR).filter(n => !n.archived).filter(n => {
          if (n.updatedAt > cutoff) return false;
          const hasBugTag    = n.tags.includes('bug');
          const hasOpenTodos = extractTodos(n.content).length > 0;
          return hasBugTag || hasOpenTodos;
        });

        if (stale.length === 0) {
          return { content: [{ type: 'text', text: `No stale notes found (threshold: ${days} days).` }] };
        }

        const lines = stale.map(n => {
          const age   = Math.floor((Date.now() - n.updatedAt) / (24 * 60 * 60 * 1000));
          const todos = extractTodos(n.content).length;
          const flags = [
            n.tags.includes('bug') ? 'bug' : null,
            todos > 0 ? `${todos} open todo(s)` : null,
          ].filter(Boolean).join(', ');
          return `• **${n.title}** — last updated ${age} days ago (${flags})\n  ID: ${n.id}`;
        });

        return {
          content: [{ type: 'text', text: `${stale.length} stale note(s) (older than ${days} days with unresolved items):\n\n${lines.join('\n\n')}` }],
        };
      }

      // ── note_history ─────────────────────────────────────────────────────────
      case 'note_history': {
        const { query } = args as { query: string };

        const notes = readAllNotes(DEVNOTES_DIR);
        const note  = findNote(notes, query);
        if (!note) {
          return { content: [{ type: 'text', text: `No note found matching "${query}".` }], isError: true };
        }

        const history = getNoteHistory(WORKSPACE, DEVNOTES_DIR, note.id);
        if (!history) {
          return { content: [{ type: 'text', text: `No git history found for "${note.title}". Is this workspace a git repository? Is the note file tracked by git (committed at least once)?` }] };
        }

        return {
          content: [{ type: 'text', text: `Git history for "${note.title}":\n\n${history}` }],
        };
      }

      // ── log_session ─────────────────────────────────────────────────────────
      case 'log_session': {
        const { done, in_progress, blocked, notes: extraNotes } = args as {
          done: string; in_progress?: string; blocked?: string; notes?: string;
        };

        const SESSION_LOG_ID = 'session-log';
        let logNote = readNote(DEVNOTES_DIR, SESSION_LOG_ID);

        if (!logNote) {
          logNote = {
            id       : SESSION_LOG_ID,
            title    : 'Session Log',
            content  : '# Session Log\n\n*A running diary of Claude Code work sessions.*\n',
            color    : 'blue',
            tags     : ['reference'],
            starred  : false,
            owner    : 'Claude Code',
            createdAt: Date.now(),
            updatedAt: Date.now(),
          };
        }

        const now = new Date();
        const dateStr = now.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
        const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

        const lines = [
          `\n\n## ${dateStr} ${timeStr}`,
          '',
          `**Done:** ${done}`,
          in_progress ? `**In progress:** ${in_progress}` : '',
          blocked     ? `**Blocked:** ${blocked}` : '',
          extraNotes  ? `**Notes:** ${extraNotes}` : '',
        ].filter(l => l !== '');

        logNote.content  += lines.join('\n');
        logNote.updatedAt = Date.now();
        writeNote(DEVNOTES_DIR, logNote);

        return { content: [{ type: 'text', text: `Session logged (${dateStr}).` }] };
      }

      // ── complete_todo ────────────────────────────────────────────────────────
      case 'complete_todo': {
        const { query, item } = args as { query: string; item: string };

        const notes = readAllNotes(DEVNOTES_DIR);
        const note  = findNote(notes, query);
        if (!note) {
          return { content: [{ type: 'text', text: `No note found matching "${query}".` }], isError: true };
        }

        const lower   = item.toLowerCase();
        let completed = 0;
        note.content  = note.content.replace(/^([ \t]*- \[ \] )(.+)$/gm, (match, prefix, text) => {
          if (text.toLowerCase().includes(lower)) {
            completed++;
            return `${prefix.replace('[ ]', '[x]')}${text}`;
          }
          return match;
        });

        if (completed === 0) {
          return { content: [{ type: 'text', text: `No open todo matching "${item}" found in "${note.title}".` }], isError: true };
        }

        note.updatedAt = Date.now();
        writeNote(DEVNOTES_DIR, note);

        return {
          content: [{ type: 'text', text: `Marked ${completed} todo(s) as done in "${note.title}".` }],
        };
      }

      // ── delete_note ──────────────────────────────────────────────────────────
      case 'delete_note': {
        const { query, confirm } = args as { query: string; confirm?: boolean };

        if (!confirm) {
          return { content: [{ type: 'text', text: 'Set confirm: true to delete a note. This cannot be undone.' }], isError: true };
        }

        const notes = readAllNotes(DEVNOTES_DIR);
        const note  = findNote(notes, query);
        if (!note) {
          return { content: [{ type: 'text', text: `No note found matching "${query}".` }], isError: true };
        }

        deleteNote(DEVNOTES_DIR, note.id);
        return { content: [{ type: 'text', text: `Deleted note "${note.title}" (ID: ${note.id}).` }] };
      }

      // ── link_github ──────────────────────────────────────────────────────────
      case 'link_github': {
        const { query, github_url } = args as { query: string; github_url: string };

        const parsed = parseGitHubUrl(github_url);
        if (!parsed) {
          return { content: [{ type: 'text', text: `Could not parse GitHub URL: "${github_url}". Expected format: https://github.com/owner/repo/issues/123 or .../pull/123` }], isError: true };
        }

        const notes = readAllNotes(DEVNOTES_DIR);
        const note  = findNote(notes, query);
        if (!note) {
          return { content: [{ type: 'text', text: `No note found matching "${query}".` }], isError: true };
        }

        let issueTitle = '';
        let status: 'open' | 'closed' | 'merged' = 'open';
        try {
          const issue = await fetchIssue(parsed.repo, parsed.number);
          issueTitle  = issue.title;
          status      = deriveStatus(issue);
        } catch (e) {
          // Continue without API data — still store the link
          const msg = e instanceof Error ? e.message : String(e);
          if (msg.includes('401') || msg.includes('403')) {
            return { content: [{ type: 'text', text: `GitHub auth failed. Set DEVNOTES_GITHUB_TOKEN to a Personal Access Token with repo read access.` }], isError: true };
          }
          if (msg.includes('404')) {
            return { content: [{ type: 'text', text: `GitHub issue/PR not found: ${github_url}. Check the URL and your token's permissions.` }], isError: true };
          }
        }

        note.github = {
          url            : github_url,
          repo           : parsed.repo,
          number         : parsed.number,
          type           : parsed.type,
          status,
          title          : issueTitle || undefined,
          statusCheckedAt: Date.now(),
        };
        note.updatedAt = Date.now();
        writeNote(DEVNOTES_DIR, note);

        const typeLabel = parsed.type === 'pr' ? 'PR' : 'Issue';
        const titleLine = issueTitle ? ` — "${issueTitle}"` : '';
        return {
          content: [{ type: 'text', text: `Linked note "${note.title}" to GitHub ${typeLabel} #${parsed.number}${titleLine} (${status}).` }],
        };
      }

      // ── get_github_context ───────────────────────────────────────────────────
      case 'get_github_context': {
        const { query } = args as { query: string };

        const notes = readAllNotes(DEVNOTES_DIR);
        const note  = findNote(notes, query);
        if (!note) {
          return { content: [{ type: 'text', text: `No note found matching "${query}".` }], isError: true };
        }
        if (!note.github) {
          return { content: [{ type: 'text', text: `Note "${note.title}" has no GitHub link. Use link_github first.` }], isError: true };
        }

        const { repo, number, type, url } = note.github;
        const typeLabel = type === 'pr' ? 'PR' : 'Issue';

        let issue;
        try {
          issue = await fetchIssue(repo, number);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return { content: [{ type: 'text', text: `Failed to fetch GitHub ${typeLabel}: ${msg}` }], isError: true };
        }

        // Refresh status on the note
        const freshStatus = deriveStatus(issue);
        if (note.github.status !== freshStatus || note.github.title !== issue.title) {
          note.github.status          = freshStatus;
          note.github.title           = issue.title;
          note.github.statusCheckedAt = Date.now();
          writeNote(DEVNOTES_DIR, note);
        }

        let comments: { user: { login: string }; body: string; created_at: string }[] = [];
        try {
          comments = await fetchComments(repo, number);
        } catch { /* non-fatal */ }

        const labels    = issue.labels.map(l => l.name).join(', ') || 'none';
        const assignees = issue.assignees.map(a => a.login).join(', ') || 'unassigned';

        const lines: string[] = [
          `# GitHub ${typeLabel} #${number}: ${issue.title}`,
          `**URL:** ${url}`,
          `**Status:** ${freshStatus}`,
          `**Labels:** ${labels}`,
          `**Assignees:** ${assignees}`,
          `**Opened by:** ${issue.user.login} on ${new Date(issue.created_at).toLocaleDateString()}`,
          `**Last updated:** ${new Date(issue.updated_at).toLocaleDateString()}`,
          '',
          '## Description',
          '',
          issue.body?.trim() || '*(no description)*',
        ];

        if (comments.length > 0) {
          lines.push('', `## Comments (${comments.length})`);
          for (const c of comments) {
            lines.push(
              '',
              `**${c.user.login}** on ${new Date(c.created_at).toLocaleDateString()}:`,
              c.body.trim()
            );
          }
        }

        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      // ── search_notes ─────────────────────────────────────────────────────────
      case 'search_notes': {
        const { query, limit = 10, include_archived = false } = args as {
          query: string; limit?: number; include_archived?: boolean;
        };

        const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
        if (terms.length === 0) {
          return { content: [{ type: 'text', text: 'Provide at least one search term.' }], isError: true };
        }

        let notes = readAllNotes(DEVNOTES_DIR);
        if (!include_archived) notes = notes.filter(n => !n.archived);

        // Score each note
        interface ScoredNote { note: Note; score: number; snippets: string[] }
        const results: ScoredNote[] = [];

        for (const note of notes) {
          const titleLower   = note.title.toLowerCase();
          const contentLower = note.content.toLowerCase();
          const tagsLower    = note.tags.join(' ').toLowerCase();
          const ghTitle      = (note.github?.title ?? '').toLowerCase();
          const codePath     = (note.codeLink?.file ?? '').toLowerCase();

          // All terms must appear somewhere in the note
          const allMatch = terms.every(t =>
            titleLower.includes(t)   ||
            contentLower.includes(t) ||
            tagsLower.includes(t)    ||
            ghTitle.includes(t)      ||
            codePath.includes(t)
          );
          if (!allMatch) continue;

          let score = 0;
          const snippets: string[] = [];

          for (const term of terms) {
            // Title match — highest weight
            if (titleLower.includes(term)) score += 10;
            // Tag match
            if (tagsLower.includes(term))  score += 4;
            // GitHub title match
            if (ghTitle.includes(term))    score += 3;
            // Code path match
            if (codePath.includes(term))   score += 2;
            // Content matches — count occurrences, cap at 5 per term
            let idx = 0;
            let hits = 0;
            while ((idx = contentLower.indexOf(term, idx)) !== -1 && hits < 5) {
              score += 1;
              hits++;
              // Build a snippet: 40 chars before and after the match
              const start   = Math.max(0, idx - 40);
              const end     = Math.min(note.content.length, idx + term.length + 40);
              const prefix  = start > 0 ? '…' : '';
              const suffix  = end < note.content.length ? '…' : '';
              const raw     = note.content.slice(start, end).replace(/\n/g, ' ');
              // Mark the match with asterisks
              const matchStart = idx - start;
              const matchEnd   = matchStart + term.length;
              const snippet    = prefix +
                raw.slice(0, matchStart) +
                `**${raw.slice(matchStart, matchEnd)}**` +
                raw.slice(matchEnd) +
                suffix;
              if (hits === 1) snippets.push(snippet); // one snippet per term is enough
              idx += term.length;
            }
          }

          results.push({ note, score, snippets });
        }

        if (results.length === 0) {
          return { content: [{ type: 'text', text: `No notes found matching "${query}".` }] };
        }

        // Sort by score descending
        results.sort((a, b) => b.score - a.score);
        const top = results.slice(0, limit);

        const lines = top.map(({ note, score, snippets }) => {
          const tags     = note.tags.length ? ` [${note.tags.join(', ')}]` : '';
          const starred  = note.starred ? ' ★' : '';
          const archived = note.archived ? ' (archived)' : '';
          const date     = new Date(note.updatedAt).toLocaleDateString();
          const header   = `• **${note.title}**${starred}${tags}${archived} — ${date} (score: ${score})\n  ID: ${note.id}`;
          const snipText = snippets.length ? '\n  ' + snippets.slice(0, 2).join('\n  ') : '';
          return header + snipText;
        });

        const total = results.length;
        const shown = top.length;
        const footer = total > shown ? `\n\n*(${total - shown} more result(s) not shown — narrow your query or increase limit)*` : '';

        return {
          content: [{ type: 'text', text: `Found ${total} matching note(s)${shown < total ? `, showing top ${shown}` : ''}:\n\n${lines.join('\n\n')}${footer}` }],
        };
      }

      default:
        return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
    }
  } catch (err) {
    return {
      content : [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
      isError : true,
    };
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// RESOURCES
// ═══════════════════════════════════════════════════════════════════════════════

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    {
      uri        : 'devnotes://todos',
      name       : 'Open Todos',
      description: 'All unchecked - [ ] items across every note. Auto-included as context.',
      mimeType   : 'text/plain',
    },
    {
      uri        : 'devnotes://recent',
      name       : 'Recent Notes',
      description: 'Notes created or updated in the last 72 hours.',
      mimeType   : 'text/plain',
    },
    {
      uri        : 'devnotes://session-log',
      name       : 'Session Log',
      description: 'The last 5 session log entries — what was worked on in previous Claude Code sessions.',
      mimeType   : 'text/plain',
    },
    {
      uri        : 'devnotes://branch',
      name       : 'Current Branch Notes',
      description: 'All notes scoped to the current git branch.',
      mimeType   : 'text/plain',
    },
  ],
}));

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const { uri } = request.params;

  switch (uri) {

    // ── devnotes://todos ─────────────────────────────────────────────────────
    case 'devnotes://todos': {
      const notes = readAllNotes(DEVNOTES_DIR);
      const sections: string[] = [];

      for (const note of notes) {
        const todos = extractTodos(note.content);
        if (todos.length > 0) {
          sections.push(`${note.title}:\n${todos.map(t => `  - [ ] ${t}`).join('\n')}`);
        }
      }

      const text = sections.length
        ? `OPEN TODOS (${sections.length} note(s)):\n\n${sections.join('\n\n')}`
        : 'No open todos.';

      return { contents: [{ uri, mimeType: 'text/plain', text }] };
    }

    // ── devnotes://recent ────────────────────────────────────────────────────
    case 'devnotes://recent': {
      const cutoff = Date.now() - 72 * 60 * 60 * 1000;
      const recent = readAllNotes(DEVNOTES_DIR)
        .filter(n => !n.archived && n.updatedAt > cutoff)
        .sort((a, b) => b.updatedAt - a.updatedAt);

      const text = recent.length
        ? `RECENT NOTES (last 72h):\n\n${recent.map(n => {
            const preview = n.content.trim().split('\n')[0]?.slice(0, 80) ?? '';
            return `• ${n.title} [${n.tags.join(', ')}] — ${new Date(n.updatedAt).toLocaleDateString()}\n  ${preview}`;
          }).join('\n\n')}`
        : 'No notes updated in the last 72 hours.';

      return { contents: [{ uri, mimeType: 'text/plain', text }] };
    }

    // ── devnotes://session-log ───────────────────────────────────────────────
    case 'devnotes://session-log': {
      const SESSION_LOG_ID = 'session-log';
      const logNote = readNote(DEVNOTES_DIR, SESSION_LOG_ID);

      if (!logNote || !logNote.content.trim()) {
        return { contents: [{ uri, mimeType: 'text/plain', text: 'No session log entries yet.' }] };
      }

      // Return only the last 5 entries (sections starting with ##)
      const sections = logNote.content.split(/(?=\n## )/).filter(s => s.trim());
      const recent   = sections.slice(-5).join('\n');

      return { contents: [{ uri, mimeType: 'text/plain', text: `RECENT SESSIONS:\n${recent}` }] };
    }

    // ── devnotes://branch ────────────────────────────────────────────────────
    case 'devnotes://branch': {
      const branch = getCurrentBranch(WORKSPACE);
      if (!branch) {
        return { contents: [{ uri, mimeType: 'text/plain', text: 'Could not detect current branch (not a git repository?).' }] };
      }

      const notes = readAllNotes(DEVNOTES_DIR).filter(n => !n.archived && n.branch === branch);

      const text = notes.length
        ? `NOTES FOR BRANCH "${branch}" (${notes.length}):\n\n${notes.map(n => {
            const preview = n.content.trim().split('\n')[0]?.slice(0, 80) ?? '';
            return `• ${n.title} [${n.tags.join(', ')}]\n  ${preview}`;
          }).join('\n\n')}`
        : `No notes scoped to branch "${branch}".`;

      return { contents: [{ uri, mimeType: 'text/plain', text }] };
    }

    default:
      return { contents: [{ uri, mimeType: 'text/plain', text: `Unknown resource: ${uri}` }] };
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// PROMPTS
// ═══════════════════════════════════════════════════════════════════════════════

server.setRequestHandler(ListPromptsRequestSchema, async () => ({
  prompts: [
    {
      name       : 'solve',
      description: 'Analyse a note and its linked code, then save the fix back as a Solution section.',
      arguments  : [
        { name: 'note', description: 'Note ID or title (fuzzy match)', required: true },
      ],
    },
    {
      name       : 'standup',
      description: 'Generate a standup update (Done / Doing / Blocked) from notes updated in the last 24 hours.',
      arguments  : [],
    },
  ],
}));

server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  const { name, arguments: promptArgs = {} } = request.params;

  switch (name) {

    // ── solve ────────────────────────────────────────────────────────────────
    case 'solve': {
      const query = String(promptArgs['note'] ?? '');
      if (!query) {
        return {
          messages: [{ role: 'user', content: { type: 'text', text: 'Please provide a note ID or title.' } }],
        };
      }

      const notes = readAllNotes(DEVNOTES_DIR);
      const note  = findNote(notes, query);

      if (!note) {
        return {
          messages: [{ role: 'user', content: { type: 'text', text: `No note found matching "${query}".` } }],
        };
      }

      // Build context: note content + linked source file (if any)
      const parts: string[] = [
        `## Note: "${note.title}"`,
        `Tags: ${note.tags.join(', ') || 'none'}`,
        `Created: ${new Date(note.createdAt).toLocaleDateString()}`,
        '',
        note.content || '*(empty note)*',
      ];

      if (note.codeLink) {
        const absPath = path.join(WORKSPACE, note.codeLink.file);
        if (fs.existsSync(absPath)) {
          const fileContent = fs.readFileSync(absPath, 'utf-8');
          const lines = fileContent.split('\n');
          // Include up to 60 lines around the linked line for context
          const start = Math.max(0, note.codeLink.line - 30);
          const end   = Math.min(lines.length, note.codeLink.line + 30);
          const snippet = lines
            .slice(start, end)
            .map((l, i) => `${start + i + 1}${start + i + 1 === note.codeLink!.line ? ' →' : '  '} ${l}`)
            .join('\n');

          parts.push(
            '',
            `## Linked source file: ${note.codeLink.file} (around line ${note.codeLink.line})`,
            '',
            '```',
            snippet,
            '```'
          );
        }
      }

      const text = [
        parts.join('\n'),
        '',
        '---',
        '',
        'Please analyse the above note and linked code, then:',
        '1. Identify the root cause of the issue.',
        '2. Suggest a concrete fix with code if applicable.',
        '3. Note any edge cases or follow-up steps.',
        '',
        'After your analysis, use the `append_to_note` tool to save a "## Solution" section to the note.',
      ].join('\n');

      return {
        description: `Solve: ${note.title}`,
        messages   : [{ role: 'user', content: { type: 'text', text } }],
      };
    }

    // ── standup ──────────────────────────────────────────────────────────────
    case 'standup': {
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      const recent = readAllNotes(DEVNOTES_DIR)
        .filter(n => n.updatedAt > cutoff || n.createdAt > cutoff)
        .sort((a, b) => b.updatedAt - a.updatedAt);

      if (recent.length === 0) {
        return {
          messages: [{ role: 'user', content: { type: 'text', text: 'No notes were updated in the last 24 hours. Nothing to generate a standup from.' } }],
        };
      }

      const noteSummaries = recent.map(n => {
        const todos   = extractTodos(n.content);
        const preview = n.content.trim().split('\n').slice(0, 3).join(' ').slice(0, 120);
        return [
          `**${n.title}** [${n.tags.join(', ') || 'no tags'}]`,
          `  Preview: ${preview || '(no content)'}`,
          todos.length ? `  Open todos: ${todos.join(' | ')}` : '',
        ].filter(Boolean).join('\n');
      }).join('\n\n');

      const text = [
        'Based on these notes from the last 24 hours, write a standup update in Done / Doing / Blocked format.',
        'Be concise — 2-3 bullet points per section maximum.',
        '',
        '## Notes from today:',
        '',
        noteSummaries,
      ].join('\n');

      return {
        description: 'Generate standup from recent notes',
        messages   : [{ role: 'user', content: { type: 'text', text } }],
      };
    }

    default:
      return {
        messages: [{ role: 'user', content: { type: 'text', text: `Unknown prompt: ${name}` } }],
      };
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[devnotes-mcp] Server started. Workspace: ${WORKSPACE}`);
}

main().catch(err => {
  console.error('[devnotes-mcp] Fatal error:', err);
  process.exit(1);
});
