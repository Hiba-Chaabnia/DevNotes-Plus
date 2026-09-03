# DevNotes+

[![VS Code Marketplace](https://vsmarketplacebadges.dev/version-short/HibaChaabnia.devnotes-plus.svg?label=VS%20Code%20Marketplace&color=007ACC)](https://marketplace.visualstudio.com/items?itemName=HibaChaabnia.devnotes-plus)
[![VS Code Installs](https://vsmarketplacebadges.dev/installs-short/HibaChaabnia.devnotes-plus.svg?label=VS%20Code%20Installs&color=007ACC)](https://marketplace.visualstudio.com/items?itemName=HibaChaabnia.devnotes-plus)
[![VS Code Rating](https://vsmarketplacebadges.dev/rating-star/HibaChaabnia.devnotes-plus.svg?label=VS%20Code%20Rating&color=007ACC)](https://marketplace.visualstudio.com/items?itemName=HibaChaabnia.devnotes-plus&ssr=false#review-details)
[![Open VSX](https://img.shields.io/open-vsx/v/HibaChaabnia/devnotes-plus?label=Open%20VSX&color=C160EF)](https://open-vsx.org/extension/HibaChaabnia/devnotes-plus)
[![Open VSX Downloads](https://img.shields.io/open-vsx/dt/HibaChaabnia/devnotes-plus?label=Open%20VSX%20downloads&color=C160EF)](https://open-vsx.org/extension/HibaChaabnia/devnotes-plus)

**[Website](https://hiba-chaabnia.github.io/DevNotes-Plus/)** · **[User Guide](https://hiba-chaabnia.github.io/DevNotes-Plus/guide/)** · **[Install from the Marketplace](https://marketplace.visualstudio.com/items?itemName=HibaChaabnia.devnotes-plus)**

***The note panel your editor was missing***

The problem isn't that developers don't document. It's that there's nowhere good to put it. Markdown files in the repo root accumulate and get ignored. Code comments can't hold screenshots. External apps don't know your codebase.

DevNotes+ was built for exactly this gap: *notes are linked to specific files and lines*, *organized by branch*, *stored alongside their images and attachments*, *shared selectively with teammates*, and *never more than a sidebar away*.

And because DevNotes+ is also *an MCP server*, AI assistants like Claude Code can access that context directly—without copy-pasting notes into every conversation.

<video src="https://github.com/user-attachments/assets/0bfa7e76-065f-4e0d-a73a-c919d8e5d9e2" controls></video>

## Quick Start

1. Open a workspace folder in VS Code.
2. Click the **DevNotes icon** in the activity bar.
3. Press `Ctrl+Alt+Q` (`Cmd+Alt+Q` on Mac) to capture your first note — if an editor is focused, the note is automatically linked to that file and line.
4. Click the note body in the sidebar to edit it inline, or click **Open in editor** for the full rich-text editor.

## Features

### Notes

| Feature | Description |
|---|---|
| Sidebar card view | Inline editing with rich markdown preview directly on each card |
| Full rich-text editor | Tables, images, task lists, code blocks, headings, links, and more |
| Quick capture | `Ctrl+Alt+Q` creates a note from anywhere, auto-linked to the current `file:line` |
| Note management | Star, archive, duplicate, and bulk-manage notes |
| Templates | Six built-in templates (Bug Report, ADR, Meeting Notes, Standup, Feature Spec, Code Review) plus custom templates |

### Code Linking

Attach a note to a specific file and line in your workspace:

- A **gutter icon** marks every line that has a linked note
- **Hover** the line to see the note title in the standard hover widget
- The **status bar** shows how many notes are linked to the active file
- **Jump to file** on any card navigates the editor to the linked line
- Code links **update automatically** when files are renamed inside VS Code

### Organisation

- **Tags** — coloured pills with custom hex colours and Lucide icons. The five defaults (Idea, Todo, Bug, Meeting, Reference) are fully customisable. `tags.json` is committed to git so your team shares the same tag set.
- **Branch scoping** — scope a note to the current git branch; it only surfaces in the sidebar when you're on that branch.
- **Reminders** — set a due date on any note. An overdue indicator appears in the status bar and a notification fires when the reminder is due.
- **Search and filter** — filter by tag, branch scope, starred, or archived state.

### Rich-Text Editor

The full editor (opened from any sidebar card) supports:

- Headings (H1–H3), bold, italic, underline, strikethrough, inline code
- Bullet lists, ordered lists, task lists (checkboxes)
- Tables — add and remove rows and columns inline
- Code blocks with monospace formatting
- Images — paste or drag-and-drop; stored in `.devnotes/assets/`
- Clickable hyperlinks that open in the browser
- Blockquotes and horizontal rules

The sidebar also supports **inline editing** — click the body of any card to edit in place without opening the full editor.

### Team Features

<video src="https://github.com/user-attachments/assets/0f662ffa-b615-4e49-83d5-173916546227" controls></video>

All notes are private by default (gitignored). To share a note, toggle **Share this note** from its overflow menu — DevNotes+ adds an exception to `.devnotes/.gitignore` for that file so it flows through git like any other source file.

| Feature | Description |
|---|---|
| Shared notes | Per-note opt-in sharing via `.gitignore` exceptions |
| Conflict resolution | Panel with Keep Mine, Keep Theirs, and Merge Both options when a merge conflict is detected |
| Activity feed | Lists recent changes from all contributors — you, teammates, and Claude Code — with timestamps and attribution |

### GitHub Integration

<video src="https://github.com/user-attachments/assets/f9da3926-c610-4cbd-8108-5f199f59e7e6" controls></video>

Connect a GitHub account from the **Set up integrations** banner in the sidebar, or later from **Integrations** in the `⋯` overflow menu beside the search box (uses VS Code's built-in GitHub auth — no personal access token needed):

- **Link a PR or issue** — paste a GitHub URL to attach it to a note; status (open, merged, closed) is displayed on the card
- **Create an issue** — convert any note into a GitHub issue directly from the overflow menu

### Claude Code / MCP

Register DevNotes+ as an MCP server so Claude Code can interact with your notes from the conversation. Three ways in:

- **Set up integrations** — the banner shown in the sidebar on a fresh install; click **Register MCP server**
- **Integrations** in the `⋯` overflow menu beside the search box — reopens that banner at any time, even after "Never show again"
- **Command Palette** → `DevNotes: Connect to Claude Code (Register MCP Server)`

Then restart Claude Code. Claude can list notes, read content, create and update notes, search, append, and complete todos — all attributed in the Activity feed.

### Export

- **HTML** — exports all notes as a styled, self-contained HTML file with images embedded
- **Markdown** — copy any note as Markdown to paste into Slack, Notion, GitHub, or anywhere else


## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+Alt+Q` / `Cmd+Alt+Q` | Quick capture — create a note linked to the current `file:line` |

All other actions are available from the **sidebar** and the **Command Palette** (`DevNotes:` prefix).


## Storage

Notes are stored in `.devnotes/` at the root of your workspace as plain Markdown files with YAML frontmatter. Images and attachments go in `.devnotes/assets/`. The folder is gitignored by default — only notes you explicitly share are committed.

This means your notes are:
- **Portable** — readable in any Markdown editor, no lock-in
- **Diffable** — shared notes show up in `git diff` and PR reviews like any source file
- **Backed up** — lives wherever your repo lives


## Documentation

The full user guide lives on the [DevNotes+ website](https://hiba-chaabnia.github.io/DevNotes-Plus/):

- [Getting started](https://hiba-chaabnia.github.io/DevNotes-Plus/guide/getting-started.html)
- [Anchoring notes to code](https://hiba-chaabnia.github.io/DevNotes-Plus/guide/anchoring-notes-to-code.html)
- [Organizing notes](https://hiba-chaabnia.github.io/DevNotes-Plus/guide/organizing-notes.html)
- [Claude Code & MCP](https://hiba-chaabnia.github.io/DevNotes-Plus/guide/claude-code-mcp.html)
- [Team sharing](https://hiba-chaabnia.github.io/DevNotes-Plus/guide/team-sharing.html)
- [File format](https://hiba-chaabnia.github.io/DevNotes-Plus/guide/file-format.html)

## Issues, Feature Requests & Contributions

Found a bug, hit an edge case, or have an idea for something DevNotes+ should do? The quickest route is **Send feedback** in the `⋯` overflow menu beside the search box, or `DevNotes: Send Feedback` in the Command Palette — both open the right issue form with your DevNotes+, VS Code, and OS versions already filled in.

You can also [open an issue](https://github.com/Hiba-Chaabnia/DevNotes-Plus/issues) directly. If a similar issue already exists, a 👍 on it helps us prioritize it.

Pull requests are welcome too. Check the [contributing guide](CONTRIBUTING.md) before diving in.