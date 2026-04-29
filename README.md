# DevNotes

▎ Notes that stick where they belong.

The problem isn't that developers don't document. It's that there's nowhere good to put it. Markdown files in the repo root accumulate and get ignored. Code comments can't hold screenshots. External apps don't know your codebase.

DevNotes was built for exactly this gap: notes are linked to specific files and lines, organized by branch, stored alongside their images and attachments, shared selectively with teammates, and never more than a sidebar away.

And because DevNotes is also an MCP server, AI assistants like Claude Code can access that context directly—without copy-pasting notes into every conversation.

---

> **Beta**
>
> DevNotes is in beta and actively looking for feedback from both solo developers and teams before the public release. If you hit a bug, notice unexpected behaviour, or have an idea for improvement, please [open an issue](https://github.com/hibachaabnia/devnotes/issues). Your reports directly shape what ships.
>
> Beta focus areas:
> - **Solo use** — note creation, code linking, reminders, tags, the inline editor
> - **Team use** — shared notes, git conflict resolution, the activity feed, GitHub integration

---

## Features

**Notes**
- Sidebar card view with inline editing and rich markdown preview
- Full rich-text editor with tables, images, task lists, code blocks, and more
- Quick capture from anywhere with `Ctrl+Alt+Q` — auto-links to the current `file:line`
- Duplicate, archive, star, and bulk-manage notes

**Code linking**
- Attach any note to a specific file and line in your workspace
- Gutter icon marks every line that has a linked note
- Hover tooltip shows the note title directly on the linked line
- Status bar shows notes linked to the currently open file
- Code links update automatically when files are renamed inside VS Code

**Organisation**
- Tags with custom colours and Lucide icons (built-in: Idea, Todo, Bug, Meeting, Reference)
- Branch-scoped notes that only surface on the relevant git branch
- Reminders with an overdue indicator in the status bar
- Search and filter by tag, branch, and archived state

**Team**
- Notes are private by default; opt in to sharing per note — DevNotes updates `.gitignore` so shared notes flow through git like any other file
- Git conflict resolution panel with Keep Ours, Keep Theirs, and Merge Both options
- Activity feed showing recent note changes with attribution (you, teammate, or Claude Code)

**Integrations**
- GitHub: connect via OAuth, link notes to issues or pull requests, track open/closed/merged status
- Claude Code: register DevNotes as an MCP server so Claude can read, create, and update notes from the conversation

**Export**
- Export notes as a styled, self-contained HTML file (images embedded)
- Copy notes as Markdown to paste into Slack, Notion, GitHub, and elsewhere

---

## Quick Start

1. Open a workspace folder in VS Code.
2. Click the DevNotes icon in the activity bar.
3. Press `Ctrl+Alt+Q` (`Cmd+Alt+Q` on Mac) to capture your first note. If an editor is focused, the note is automatically linked to that file and line.
4. Use the sidebar to view, filter, and edit your notes.

---

## Core Workflows

### Creating notes

Notes can be created from three places:

- **Quick capture** — `Ctrl+Alt+Q` anywhere. Prompts for a title, optionally a template, and optionally a branch scope. If an editor is active, the note is linked to the current file and line automatically.
- **Sidebar** — the "+" button opens a creation form directly in the sidebar.
- **Command palette** — `DevNotes: Add DevNote Here`.

### The rich-text editor

Click "Open in editor" on any sidebar card to open the full editor. It supports:

- Headings, bold, italic, strikethrough, inline code
- Ordered and unordered lists, task lists (checkboxes)
- Tables (add/remove rows and columns)
- Code blocks
- Images (paste or drag-and-drop; stored in `.devnotes/assets/`)
- Clickable links (open in browser)

The sidebar also supports inline editing: click the body of any card to edit it in place. The editor saves automatically on blur.

### Linking notes to code

When you create a note with `Ctrl+Alt+Q` from inside an editor, DevNotes stores the current `file:line` with the note. You can also add or remove a code link later from the sidebar card's overflow menu.

Once a note has a code link:

- A gutter icon appears on the linked line.
- Hovering the line shows the note title in the standard hover widget.
- The status bar displays the count of notes linked to the active file.
- Clicking "Jump to file" on the card navigates the editor to that line.

### Templates

DevNotes ships with six built-in templates:

| Template | Tags | Contents |
|---|---|---|
| Bug Report | Bug | Steps to reproduce, expected vs actual behaviour, environment |
| ADR | Reference | Context, decision, consequences |
| Meeting Notes | Meeting | Attendees, decisions, action items |
| Standup | Todo | Done, doing, blocked |
| Feature Spec | Idea | Goal, acceptance criteria, open questions |
| Code Review | Reference | What to check, findings, decision |

Custom templates can be added from the sidebar settings panel. Templates pre-select the matching tags when applied.

### Tags

Tags appear as coloured pills on sidebar cards. Each tag has a label, a hex colour, and an optional Lucide icon.

The five default tags — Idea, Todo, Bug, Meeting, Reference — can be renamed, recoloured, reordered, and deleted. Custom tags can be added from the tag manager in the sidebar. The full Lucide icon library is searchable from the icon picker.

`tags.json` is committed to git so custom tags are shared with your team automatically.

---

## Keeping Notes Organised

### Branch scoping

When creating a note, DevNotes detects the current git branch and offers to scope the note to it. A branch-scoped note only appears in the sidebar when you are on that branch — useful for work-in-progress notes tied to a feature branch.

The branch filter toggle in the sidebar header narrows the view to notes for the current branch only.

### Reminders

Set a reminder date and time on any note from the overflow menu. When the reminder is due:

- The status bar shows an overdue indicator.
- A notification fires with an option to open the note.

Reminders are stored in the note's frontmatter and survive workspace restarts.

### Starring and archiving

Star important notes to pin them to the top of the sidebar. Archive notes you no longer need to act on but don't want to delete — archived notes are hidden from the main view and accessible via the archive filter.

Bulk operations (archive, delete, tag) are available in selection mode, toggled from the sidebar header.

---

## Team Features

### Sharing notes

All notes are stored in `.devnotes/` and gitignored by default. To share a note, toggle "Share this note" from its overflow menu. DevNotes adds an exception to `.devnotes/.gitignore` for that specific file — teammates see it the next time they pull.

Shared notes are committed and diffed like any other file. The `.gitignore` and `tags.json` files are also un-ignored the first time any note is shared, so custom tag definitions and sharing rules propagate to the team automatically.

### Conflict resolution

If a shared note receives conflicting edits (for example, two developers edit it on different branches and merge), DevNotes detects the git conflict markers and surfaces a resolution panel with three options:

- **Keep mine** — discards incoming changes.
- **Keep theirs** — discards your changes.
- **Merge both** — unions tags and concatenates content with a divider. A custom merge editor lets you adjust the result before confirming.

A notification fires automatically when a newly conflicted note is detected after a pull.

### Activity feed

The Activity panel (below the Notes panel in the sidebar) lists recent note changes from all contributors — you, teammates, and Claude Code. Each entry shows who made the change, what note was affected, and when. Clicking an entry opens that note in the editor.

The activity feed only appears when there is shared note activity to display.

---

## GitHub Integration

Connect a GitHub account from the sidebar settings panel. DevNotes uses VS Code's built-in GitHub authentication — no personal access token needed.

Once connected:

- **Link a PR** — paste a GitHub pull request URL to attach it to a note. DevNotes fetches the PR title and status (open, merged, closed) and displays them on the sidebar card.
- **Create an issue** — convert a note into a GitHub issue directly from the overflow menu. The note title and content become the issue title and body.
- Linked issue and PR status updates when you refresh the sidebar.

The GitHub token is stored in `.devnotes/.github-token`, which is always gitignored.

---

## Claude Code / MCP

DevNotes can register itself as an MCP server so Claude Code can interact with your notes from the conversation.

**To register:**

1. Open the Command Palette and run `DevNotes: Connect to Claude Code (Register MCP Server)`.
2. Restart Claude Code.

Once registered, Claude Code can list notes, read note content, create new notes, update existing ones, append to notes, complete todos, search, and more — all without leaving the chat.

Changes made by Claude Code are attributed in the Activity feed so you can see what was added or modified.

---

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+Alt+Q` / `Cmd+Alt+Q` | Quick capture — create a note linked to the current file:line |

All other actions are available from the sidebar and the Command Palette (`DevNotes:` prefix).

---

## Building from Source

```bash
git clone https://github.com/hibachaabnia/devnotes.git
cd devnotes
npm install
npm run compile   # TypeScript + webview bundles
```

Press `F5` in VS Code to launch an Extension Development Host with DevNotes loaded.

To watch for TypeScript changes during development:

```bash
npm run watch
```

The webview bundles (`media/editor.js`, `media/sidebar-editor.js`) must be rebuilt manually after changes to files under `src/webview/`:

```bash
npm run build:webview
```

---

## License

AGPL-3.0 — see [LICENSE](LICENSE) for details.
