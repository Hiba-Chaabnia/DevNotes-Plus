# Changelog

All notable changes to DevNotes+ are documented here. This project follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.3] — 2026-09-03

### Added

- **Send feedback** in the sidebar `⋯` overflow menu and as `DevNotes: Send Feedback` in the Command Palette. Pick bug, feature, or question and the matching issue form opens with your DevNotes+, VS Code, and OS versions already filled in. Only versions and platform are included — never workspace paths, repo names, git identity, or note content.
- A **New note** heading on the note creation card, so the panel reads as a titled surface rather than a bare close button.
- A [website and user guide](https://hiba-chaabnia.github.io/DevNotes-Plus/) covering setup, anchoring notes to code, organizing notes, Claude Code MCP, team sharing, and the on-disk file format.

### Fixed

- The bundled MCP server reported its version as `0.0.0` to Claude Code. Its `package.json` was excluded from the packaged extension, so the version lookup always hit its fallback.
- The Marketplace listing pointed at the GitHub README instead of the project website.

### Changed

- The MCP server's version now tracks the extension's, rather than sitting at an unrelated `1.0.0`.

## [0.1.2] — 2026-07-30

### Added

- Demo videos in the README.

### Changed

- Rebranded to DevNotes+.

### Fixed

- Conflict markers in notes were not matched on Windows because of CRLF line endings.

---

Releases before 0.1.2 are not itemized here; see the
[commit history](https://github.com/Hiba-Chaabnia/DevNotes-Plus/commits/main).
