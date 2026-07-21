# Contributing to DevNotes+

Thanks for your interest in contributing! This guide covers everything you need to get the project running locally and submit changes.

## Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [VS Code](https://code.visualstudio.com/) 1.85+

## Getting Started

```bash
git clone https://github.com/Hiba-Chaabnia/DevNotes-Plus.git
cd DevNotes-Plus
npm install
npm run compile
```

Press `F5` in VS Code to open an Extension Development Host with DevNotes+ loaded.

## Project Structure

```
src/
  extension.ts          # Extension entry point — activates all controllers and views
  controllers/          # GutterController, ReminderController, StatusBarController
  services/             # GitDetector, McpRegistration, NoteStorage
  views/                # SidebarView, EditorPanel, ActivityFeedView, ConflictPanel
  webview/              # Browser-side bundles (editor.ts, sidebar-editor.ts)
  utils/                # Shared helpers (icons, etc.)
mcp-server/             # Standalone MCP server (bundled separately)
media/                  # Extension icons and built webview assets
out/                    # Compiled extension host output (gitignored)
```

## Naming Convention

"DevNotes+" is reserved for marketplace-facing fields (`displayName`, the activity bar `title`) and docs. Use "DevNotes" everywhere else — command titles/categories, view names, and in-app messages — to avoid duplicated branding in the UI (e.g. an activity bar tooltip reading "DevNotes+: DevNotes").

## Development Workflow

To watch for TypeScript changes in the extension host:

```bash
npm run watch
```

The webview bundles are **not** rebuilt by `watch`. After editing files under `src/webview/`, run:

```bash
npm run build:webview
```

To rebuild everything (extension host + webviews + MCP server):

```bash
npm run compile
```

## Submitting Changes

1. Fork the repository and create a branch from `main`.
2. Make your changes and verify them in the Extension Development Host (`F5`).
3. Open a pull request against `main` with a clear description of what changed and why.

For non-trivial changes, open an issue first so we can align on the approach before you invest time in the implementation.

## Reporting Bugs

Please [file an issue](https://github.com/Hiba-Chaabnia/DevNotes-Plus/issues) and include:

- VS Code version
- DevNotes+ version
- Steps to reproduce
- Expected vs. actual behaviour

## Feature Requests

[Open an issue](https://github.com/Hiba-Chaabnia/DevNotes-Plus/issues) describing the use case and what you'd like to see. Screenshots or mockups are welcome.
