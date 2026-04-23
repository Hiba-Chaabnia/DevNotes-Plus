import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { Note } from '../services/NoteStorage';
import { UI_COLORS, EXPORT_COLORS as EX } from '../utils/colors';

// ─── Public entry point ───────────────────────────────────────────────────────

export async function runExport(notes: Note[], devnotesDir?: string): Promise<void> {
  if (notes.length === 0) {
    vscode.window.showInformationMessage('DevNotes: nothing to export.');
    return;
  }

  type FmtItem = vscode.QuickPickItem & { fmt: 'html' | 'clipboard' };
  const items: FmtItem[] = [
    {
      label      : '$(globe) HTML file',
      description: '.html — styled, self-contained, images included',
      fmt        : 'html',
    },
    {
      label      : '$(clippy) Copy to clipboard',
      description: 'Markdown text — paste into Slack, Notion, GitHub…',
      fmt        : 'clipboard',
    },
  ];

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: `Export ${notes.length} note${notes.length > 1 ? 's' : ''} as…`,
  });
  if (!picked) return;

  // ── Clipboard ──────────────────────────────────────────────────────────
  if (picked.fmt === 'clipboard') {
    const hasImages = notes.some(n => /!\[[^\]]*\]\(\.devnotes\/assets\//.test(n.content));
    if (hasImages) {
      const confirm = await vscode.window.showWarningMessage(
        'This note contains images that cannot be included in a clipboard copy. The text will be copied without them.',
        'Copy anyway',
        'Cancel',
      );
      if (confirm !== 'Copy anyway') return;
    }
    await vscode.env.clipboard.writeText(toMarkdown(notes));
    vscode.window.showInformationMessage(
      `Copied ${notes.length} note${notes.length > 1 ? 's' : ''} to clipboard.`
    );
    return;
  }

  // ── Save HTML to file ──────────────────────────────────────────────────
  const imageMap = devnotesDir ? buildImageMap(notes, devnotesDir) : new Map<string, string>();
  const baseName = notes.length === 1
    ? notes[0].title.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 60)
    : 'devnotes-export';

  const uri = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(`${baseName}.html`),
    filters    : { 'HTML Files': ['html'] },
  });
  if (!uri) return;

  await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(toHtml(notes, imageMap)));

  const action = await vscode.window.showInformationMessage(
    `Exported ${notes.length} note${notes.length > 1 ? 's' : ''} to ${path.basename(uri.fsPath)}`,
    'Open file'
  );
  if (action === 'Open file') {
    vscode.commands.executeCommand('vscode.open', uri);
  }
}

// ─── Clipboard Markdown formatter ────────────────────────────────────────────

function toMarkdown(notes: Note[]): string {
  const parts = notes.map(note => {
    const lines: string[] = [`# ${note.title}`, ``];
    const body = note.content.trim().replace(/!\[[^\]]*\]\(\.devnotes\/assets\/[^)]+\)\n?/g, '');
    if (body.trim()) lines.push(body.trim(), ``);
    return lines.join('\n');
  });
  return parts.join('\n---\n\n');
}

// ─── HTML formatter ───────────────────────────────────────────────────────────

function toHtml(notes: Note[], imageMap: Map<string, string>): string {
  const now  = new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
  const body = notes.map(n => noteToHtml(n, imageMap)).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DevNotes Export</title>
<style>
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:${EX.pageBg};color:${UI_COLORS.text};padding:40px 20px;line-height:1.7}
  .container{max-width:780px;margin:0 auto}
  .header{margin-bottom:32px;padding-bottom:20px;border-bottom:2px solid ${EX.border}}
  .header h1{font-size:1.6em;font-weight:800;margin-bottom:6px}
  .header p{font-size:13px;color:${EX.mutedText}}
  .note{background:${UI_COLORS.white};border-radius:12px;padding:28px;margin-bottom:24px;box-shadow:0 1px 4px rgba(0,0,0,.07)}
  .note-title{font-size:1.3em;font-weight:700;margin-bottom:16px}
  .note-body h1,.note-body h2,.note-body h3{font-weight:700;margin:1em 0 .4em;line-height:1.3}
  .note-body h1{font-size:1.4em}.note-body h2{font-size:1.2em}.note-body h3{font-size:1.05em}
  .note-body p{margin-bottom:.7em}
  .note-body ul,.note-body ol{padding-left:1.5em;margin-bottom:.7em}
  .note-body li{margin:2px 0}
  .note-body code{background:${EX.codeBg};padding:1px 5px;border-radius:3px;font-family:monospace;font-size:.875em}
  .note-body pre{background:${EX.codeBg};padding:14px 18px;border-radius:8px;overflow-x:auto;margin-bottom:.7em}
  .note-body pre code{background:none;padding:0}
  .note-body blockquote{border-left:3px solid ${EX.blockquoteBorder};margin:.7em 0;padding-left:1em;color:${EX.mutedText}}
  .note-body input[type=checkbox]{margin-right:6px}
  .footer{text-align:center;font-size:12px;color:${UI_COLORS.muted};margin-top:40px}
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <h1>DevNotes Export</h1>
    <p>${notes.length} note${notes.length > 1 ? 's' : ''} &mdash; ${esc(now)}</p>
  </div>
  ${body}
  <div class="footer">Generated by DevNotes</div>
</div>
</body>
</html>`;
}

function noteToHtml(note: Note, imageMap: Map<string, string>): string {
  return `<div class="note">
  <div class="note-title">${esc(note.title)}</div>
  <div class="note-body">${mdToHtml(note.content, imageMap)}</div>
</div>`;
}

// ─── Markdown → HTML (basic converter for export) ─────────────────────────────

function mdToHtml(md: string, imageMap: Map<string, string> = new Map()): string {
  if (!md.trim()) return '';
  const lines  = md.split('\n');
  let   out    = '';
  let   inList      = false;
  let   inOrderedList = false;
  let   inCode = false;
  let   codeAccum = '';

  const closeList = (): void => {
    if (inList)        { out += '</ul>\n';  inList = false; }
    if (inOrderedList) { out += '</ol>\n';  inOrderedList = false; }
  };

  const inline = (s: string): string =>
    esc(s)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g,     '<em>$1</em>')
      .replace(/`(.+?)`/g,       '<code>$1</code>')
      .replace(/~~(.+?)~~/g,     '<del>$1</del>');

  for (const line of lines) {
    if (line.startsWith('```')) {
      if (inCode) {
        out += `<pre><code>${esc(codeAccum.replace(/\n$/, ''))}</code></pre>\n`;
        codeAccum = ''; inCode = false;
      } else {
        closeList(); inCode = true;
      }
      continue;
    }
    if (inCode) { codeAccum += line + '\n'; continue; }

    const h = line.match(/^(#{1,3})\s+(.*)/);
    if (h) {
      closeList();
      out += `<h${h[1].length}>${inline(h[2])}</h${h[1].length}>\n`;
      continue;
    }

    const task = line.match(/^- \[([ x])\] (.*)/);
    if (task) {
      if (!inList) { out += '<ul style="list-style:none;padding-left:0">\n'; inList = true; }
      out += `<li><input type="checkbox"${task[1] === 'x' ? ' checked' : ''} disabled> ${inline(task[2])}</li>\n`;
      continue;
    }

    const li = line.match(/^[-*] (.*)/);
    if (li) {
      if (inOrderedList) { out += '</ol>\n'; inOrderedList = false; }
      if (!inList) { out += '<ul>\n'; inList = true; }
      out += `<li>${inline(li[1])}</li>\n`;
      continue;
    }

    const oli = line.match(/^\d+\. (.*)/);
    if (oli) {
      if (inList) { out += '</ul>\n'; inList = false; }
      if (!inOrderedList) { out += '<ol>\n'; inOrderedList = true; }
      out += `<li>${inline(oli[1])}</li>\n`;
      continue;
    }

    const img = line.match(/^!\[([^\]]*)\]\(([^)]+)\)/);
    if (img) {
      closeList();
      const alt = esc(img[1]);
      const src = imageMap.get(img[2]) ?? esc(img[2]);
      out += `<img src="${src}" alt="${alt}" style="max-width:100%;border-radius:5px;margin:.7em 0;display:block">\n`;
      continue;
    }

    const bq = line.match(/^> (.*)/);
    if (bq) {
      closeList();
      out += `<blockquote>${inline(bq[1])}</blockquote>\n`;
      continue;
    }

    closeList();
    if (line.trim() === '') { out += '<br>\n'; continue; }
    out += `<p>${inline(line)}</p>\n`;
  }
  closeList();
  if (inCode) {
    out += `<pre><code>${esc(codeAccum.replace(/\n$/, ''))}</code></pre>\n`;
  }
  return out;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Reads every .devnotes/assets/ image referenced by the given notes and
// returns a map of relative path → base64 data URI for HTML embedding.
function buildImageMap(notes: Note[], devnotesDir: string): Map<string, string> {
  const map  = new Map<string, string>();
  const seen = new Set<string>();

  for (const note of notes) {
    const matches = note.content.matchAll(/!\[[^\]]*\]\((\.devnotes\/assets\/([^)]+))\)/g);
    for (const m of matches) {
      const relPath  = m[1];
      const filename = m[2];
      if (seen.has(relPath)) continue;
      seen.add(relPath);
      try {
        const absPath = path.join(devnotesDir, 'assets', filename);
        const data    = fs.readFileSync(absPath);
        const ext     = path.extname(filename).slice(1).toLowerCase() || 'png';
        const mime    = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
        map.set(relPath, `data:${mime};base64,${data.toString('base64')}`);
      } catch { /* image missing or unreadable — leave path as-is */ }
    }
  }

  return map;
}
