import * as vscode from 'vscode';
import { NoteStorage } from '../services/NoteStorage';
import { PLATFORM_COLORS } from '../utils/colors';
import { svgIcon, getNonce } from '../utils/webview';
import {
  Bold, Italic, Underline, Strikethrough, Code, Code2, Link,
  Heading1, Heading2, Heading3,
  List, ListOrdered, ListChecks, Indent, Outdent,
  Quote, Minus, Undo2, Redo2,
  FileDown, FilePlus, SquareArrowOutUpRight,
  Type, Heading, AlignJustify, Layers, LayoutTemplate,
} from 'lucide';

// ─── Panel ───────────────────────────────────────────────────────────────────

export class EditorPanel {
  static current?: EditorPanel;

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  readonly noteId: string;

  private disposed = false;

  // Maps webview-safe image URIs → workspace-relative storage paths.
  // Populated when images are pasted or when a note with images is loaded.
  // Used to convert URIs back to paths before writing markdown to disk.
  private readonly imageUriMap = new Map<string, string>();

  // ── Static factory ──────────────────────────────────────────────────────

  static show(
    context: vscode.ExtensionContext,
    storage: NoteStorage,
    noteId: string,
    onUpdate?: () => void
  ): void {
    if (!storage.getNote(noteId)) return;

    if (EditorPanel.current) {
      if (EditorPanel.current.noteId === noteId) {
        EditorPanel.current.panel.reveal(vscode.ViewColumn.One);
        return;
      }
      EditorPanel.current.panel.dispose();
    }
    new EditorPanel(context, storage, noteId, onUpdate);
  }

  // ── Theme propagation from sidebar preview ───────────────────────────────

  setTheme(vars: Record<string, string> | null): void {
    if (this.disposed) return;
    this.panel.webview.postMessage({ type: 'setTheme', vars });
  }

  // ── Push updated content (e.g. after external file change) ─────────────

  push(): void {
    if (this.disposed) return;
    const note = this.storage.getNote(this.noteId);
    if (!note) return;
    this.panel.webview.postMessage({
      type   : 'setContent',
      content: this.toDisplayContent(note.content),
      title  : note.title,
    });
    this.panel.title = `Editor — ${note.title}`;
  }

  // ── Constructor ─────────────────────────────────────────────────────────

  private constructor(
    context: vscode.ExtensionContext,
    private readonly storage: NoteStorage,
    noteId: string,
    private readonly onUpdate?: () => void
  ) {
    this.noteId = noteId;
    const note  = storage.getNote(noteId)!; // validated by show()

    const editorJsUri = vscode.Uri.joinPath(context.extensionUri, 'media', 'editor.js');

    this.panel = vscode.window.createWebviewPanel(
      'devnotes.editor',
      `✏ ${note.title}`,
      vscode.ViewColumn.One,
      {
        enableScripts          : true,
        retainContextWhenHidden: true,
        localResourceRoots     : [
          vscode.Uri.joinPath(context.extensionUri, 'media'),
          vscode.Uri.joinPath(storage.folderUri, 'assets'),
        ],
      }
    );

    // Convert stored image paths to webview URIs for display
    const displayContent = this.toDisplayContent(note.content);

    this.panel.webview.html = this.buildHtml(
      this.panel.webview.asWebviewUri(editorJsUri),
      this.panel.webview.cspSource,
      displayContent,
      note.title
    );

    this.panel.webview.onDidReceiveMessage(
      async (msg: { type: string; content?: string; title?: string; base64?: string; mimeType?: string; ext?: string }) => {
        if (msg.type === 'save' && msg.content !== undefined) {
          // Convert webview image URIs back to storage-relative paths before saving
          const content = this.toStorageContent(msg.content);
          await this.storage.updateNote(this.noteId, { content });
          this.onUpdate?.();

        } else if (msg.type === 'saveTitle' && msg.title) {
          const trimmed = msg.title.trim();
          if (trimmed) {
            await this.storage.updateNote(this.noteId, { title: trimmed });
            this.panel.title = `✏ ${trimmed}`;
            this.onUpdate?.();
          }

        } else if (msg.type === 'applyTemplate') {
          const templates = this.storage.getTemplates();
          type TplItem = vscode.QuickPickItem & { templateId?: string };
          const items: TplItem[] = templates.map(t => ({
            label      : t.name,
            description: t.content.replace(/#+\s/g, '').replace(/\n/g, ' ').slice(0, 72),
            templateId : t.id,
          }));
          const picked = await vscode.window.showQuickPick(items, {
            placeHolder: 'Choose a template to apply',
          });
          if (!picked?.templateId) return;
          const tpl = templates.find(t => t.id === picked.templateId);
          if (!tpl) return;
          this.panel.webview.postMessage({ type: 'insertTemplate', content: tpl.content });

        } else if (msg.type === 'pasteImage' && msg.base64) {
          await this.handlePasteImage(msg.base64, msg.ext ?? 'png');

        } else if (msg.type === 'exportCurrentNote') {
          vscode.commands.executeCommand('devnotes.exportNote', this.noteId);

        } else if (msg.type === 'saveAsTemplate' && msg.content !== undefined) {
          const name = await vscode.window.showInputBox({
            prompt     : 'Template name',
            placeHolder: 'e.g. My Sprint Note',
          });
          if (!name?.trim()) return;
          await this.storage.addTemplate({ name: name.trim(), content: msg.content });
          vscode.window.showInformationMessage(`Template "${name.trim()}" saved.`);
          this.onUpdate?.();
        }
      },
      null,
      this.disposables
    );

    this.panel.onDidDispose(() => {
      this.disposed = true;
      EditorPanel.current = undefined;
      this.disposables.forEach(d => d.dispose());
    }, null, this.disposables);

    EditorPanel.current = this;
  }

  // ── Image helpers ───────────────────────────────────────────────────────

  /** Writes a pasted image to .devnotes/assets/ and inserts it into the editor. */
  private async handlePasteImage(base64: string, rawExt: string): Promise<void> {
    const ext       = rawExt.replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'png';
    const filename  = `${this.noteId}-${Date.now()}.${ext}`;
    const assetUri  = vscode.Uri.joinPath(this.storage.folderUri, 'assets', filename);

    // Ensure .devnotes/assets/ exists
    try {
      await vscode.workspace.fs.createDirectory(
        vscode.Uri.joinPath(this.storage.folderUri, 'assets')
      );
    } catch { /* already exists */ }

    // Write image bytes decoded from base64
    await vscode.workspace.fs.writeFile(assetUri, Buffer.from(base64, 'base64'));

    // Register the webview URI → storage path mapping
    const webviewUri = this.panel.webview.asWebviewUri(assetUri).toString();
    this.imageUriMap.set(webviewUri, `.devnotes/assets/${filename}`);

    this.panel.webview.postMessage({ type: 'insertImage', src: webviewUri });
  }

  /**
   * Converts stored image paths (.devnotes/assets/...) to webview-safe URIs
   * so the editor can display images. Also populates imageUriMap.
   */
  private toDisplayContent(markdown: string): string {
    return markdown.replace(
      /!\[([^\]]*)\]\(\.devnotes\/assets\/([^)]+)\)/g,
      (_, alt: string, filename: string) => {
        const assetUri   = vscode.Uri.joinPath(this.storage.folderUri, 'assets', filename);
        const webviewUri = this.panel.webview.asWebviewUri(assetUri).toString();
        this.imageUriMap.set(webviewUri, `.devnotes/assets/${filename}`);
        return `![${alt}](${webviewUri})`;
      }
    );
  }

  /**
   * Converts webview image URIs back to storage-relative paths before saving
   * to disk. Uses the imageUriMap built up during paste and load operations.
   */
  private toStorageContent(markdown: string): string {
    let content = markdown;
    for (const [webviewUri, storagePath] of this.imageUriMap) {
      // split/join avoids regex issues with special characters in webview URIs
      content = content.split(webviewUri).join(storagePath);
    }
    return content;
  }

  // ── HTML ────────────────────────────────────────────────────────────────

  private buildHtml(editorJsUri: vscode.Uri, cspSource: string, initialContent: string, initialTitle: string): string {
    const nonce   = getNonce();
    const content = JSON.stringify(initialContent).replace(/<\/script>/gi, '<\\/script>');
    const title   = JSON.stringify(initialTitle).replace(/<\/script>/gi, '<\\/script>');
    const ico = {
      bold:        svgIcon(Bold),
      italic:      svgIcon(Italic),
      underline:   svgIcon(Underline),
      strike:      svgIcon(Strikethrough),
      code:        svgIcon(Code),
      code2:       svgIcon(Code2),
      link:        svgIcon(Link),
      h1:          svgIcon(Heading1),
      h2:          svgIcon(Heading2),
      h3:          svgIcon(Heading3),
      list:        svgIcon(List),
      listOrdered: svgIcon(ListOrdered),
      listChecks:  svgIcon(ListChecks),
      indent:      svgIcon(Indent),
      outdent:     svgIcon(Outdent),
      quote:       svgIcon(Quote),
      minus:       svgIcon(Minus),
      undo:        svgIcon(Undo2),
      redo:        svgIcon(Redo2),
      tplDown:      svgIcon(FileDown),
      tplUp:        svgIcon(FilePlus),
      export:       svgIcon(SquareArrowOutUpRight),
      grpText:      svgIcon(Type),
      grpHeadings:  svgIcon(Heading),
      grpLists:     svgIcon(AlignJustify),
      grpBlocks:    svgIcon(Layers),
      grpTemplates: svgIcon(LayoutTemplate),
    };

    const checkmarkUri = 'data:image/svg+xml,' + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>'
    );

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; script-src 'nonce-${nonce}' ${cspSource}; style-src 'unsafe-inline'; img-src ${cspSource} data:;">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    font-family: var(--vscode-font-family);
    font-size: 14px;
    background: var(--vscode-editor-background);
    color: var(--vscode-editor-foreground);
    height: 100vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  /* ── Note title ── */
  #title-input {
    display: block;
    width: 100%;
    background: transparent;
    border: none;
    border-bottom: 1px solid transparent;
    outline: none;
    font-size: 1.55em;
    font-weight: 700;
    color: var(--vscode-editor-foreground);
    padding: 18px min(10%, 80px) 10px;
    font-family: var(--vscode-font-family);
    flex-shrink: 0;
    transition: border-color .15s;
  }
  #title-input:focus {
    border-bottom-color: var(--vscode-focusBorder, var(--vscode-panel-border));
  }
  #title-input::placeholder {
    color: var(--vscode-input-placeholderForeground);
    font-weight: 400;
  }

  /* ── Toolbar ── */
  #toolbar {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 5px min(10%, 80px);
    border-bottom: 1px solid var(--vscode-panel-border);
    flex-shrink: 0;
    flex-wrap: nowrap;
    overflow: visible;
    position: relative;
    background: var(--vscode-sideBar-background);
  }
  #toolbar button {
    background: none;
    border: none;
    border-radius: 4px;
    padding: 3px 7px;
    cursor: pointer;
    font-size: 12px;
    font-family: var(--vscode-font-family);
    color: var(--vscode-foreground);
    min-width: 26px;
    height: 24px;
    display: flex;
    align-items: center;
    justify-content: center;
    opacity: .72;
    transition: background .1s, opacity .1s;
    flex-shrink: 0;
  }
  #toolbar button:hover:not(:disabled) {
    background: var(--vscode-toolbar-hoverBackground);
    opacity: 1;
  }
  #toolbar button.is-active {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    opacity: 1;
  }
  #toolbar button:disabled { opacity: .28; cursor: default; }
  .tb-sep { width: 1px; height: 16px; background: var(--vscode-panel-border); margin: 0 3px; flex-shrink: 0; }

  /* ── Toolbar groups ── */
  .tb-grp { position: relative; display: flex; align-items: center; gap: 2px; flex-shrink: 0; }
  .tb-grp-toggle { display: none !important; padding: 3px 5px; }
  .tb-grp-content { display: flex; align-items: center; gap: 2px; }

  /* Collapsed: show toggle, move content into a popup */
  .tb-grp.collapsed > .tb-grp-toggle  { display: flex !important; }
  .tb-grp.collapsed > .tb-grp-content { display: none; }
  .tb-grp.collapsed > .tb-grp-content.open {
    display: flex;
    flex-wrap: wrap;
    position: absolute;
    top: calc(100% + 3px);
    left: 0;
    z-index: 200;
    background: var(--vscode-menu-background, var(--vscode-editor-background));
    border: 1px solid var(--vscode-panel-border);
    border-radius: 6px;
    padding: 4px;
    gap: 2px;
    box-shadow: 0 4px 12px rgba(0,0,0,.25);
    min-width: 80px;
  }

  /* ── Editor area ── */
  #editor-mount {
    flex: 1;
    overflow-y: auto;
    padding: 14px min(10%, 80px) 28px;
  }
  .ProseMirror {
    outline: none;
    min-height: 100%;
    line-height: 1.72;
    font-size: 14px;
    max-width: 760px;
    margin: 0 auto;
  }
  .ProseMirror p { margin-bottom: .75em; }
  .ProseMirror h1 { font-size: 1.8em; font-weight: 700; margin: 1.1em 0 .45em; line-height: 1.25; }
  .ProseMirror h2 { font-size: 1.35em; font-weight: 700; margin: 1em 0 .4em; }
  .ProseMirror h3 { font-size: 1.1em; font-weight: 700; margin: .9em 0 .35em; }
  .ProseMirror ul, .ProseMirror ol { padding-left: 1.6em; margin-bottom: .75em; }
  .ProseMirror li { margin: 2px 0; }
  .ProseMirror blockquote {
    border-left: 3px solid rgba(128,128,128,.35);
    margin: .75em 0;
    padding: 2px 10px;
    background: rgba(128,128,128,.06);
    border-radius: 0 3px 3px 0;
  }
  .ProseMirror hr {
    border: none;
    border-top: 1px solid var(--vscode-panel-border);
    margin: 1.2em 0;
  }
  .ProseMirror a {
    color: var(--vscode-textLink-foreground);
    text-decoration: underline;
    cursor: pointer;
  }
  .ProseMirror code {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: .875em;
    background: var(--vscode-textCodeBlock-background, rgba(128,128,128,.15));
    padding: 1px 5px;
    border-radius: 3px;
  }
  .ProseMirror pre {
    background: var(--vscode-textCodeBlock-background, rgba(128,128,128,.15));
    border-radius: 6px;
    padding: 12px 16px;
    margin-bottom: .75em;
    overflow-x: auto;
  }
  .ProseMirror pre code { background: none; padding: 0; font-size: .9em; }
  .ProseMirror ul[data-type="taskList"] { list-style: none; padding-left: 0; }
  .ProseMirror ul[data-type="taskList"] li { display: flex; align-items: flex-start; gap: 8px; }
  .ProseMirror ul[data-type="taskList"] li > label { margin-top: 3px; flex-shrink: 0; }
  .ProseMirror ul[data-type="taskList"] input[type="checkbox"] {
    appearance: none; -webkit-appearance: none;
    width: 13px; height: 13px; flex-shrink: 0;
    background: transparent;
    border: 1.5px solid var(--vscode-editor-foreground);
    border-radius: 2px;
    cursor: pointer;
    transition: background .1s, border-color .1s;
  }
  .ProseMirror ul[data-type="taskList"] input[type="checkbox"]:checked {
    background: var(--vscode-button-background);
    border-color: var(--vscode-button-background);
    background-image: url('${checkmarkUri}');
    background-repeat: no-repeat;
    background-position: center;
  }
  .ProseMirror ul[data-type="taskList"] li[data-checked="true"] > div,
  .ProseMirror ul[data-type="taskList"] li[data-checked="true"] > p {
    text-decoration: line-through;
    opacity: 0.5;
  }

  /* ── Images ── */
  .ProseMirror img {
    max-width: 100%;
    height: auto;
    border-radius: 5px;
    display: block;
    margin: .75em 0;
    cursor: default;
  }
  .ProseMirror img.ProseMirror-selectednode {
    outline: 2px solid var(--vscode-focusBorder, ${PLATFORM_COLORS.vsFocusBorder});
    border-radius: 5px;
  }

  /* ── Status bar ── */
  #save-status {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    padding: 3px 10px;
    border-top: 1px solid var(--vscode-panel-border);
    flex-shrink: 0;
    min-height: 20px;
    background: var(--vscode-sideBar-background);
  }
</style>
</head>
<body>

<input id="title-input" type="text" placeholder="Untitled" spellcheck="false" autocomplete="off">

<div id="toolbar">
  <button data-action="bold"       title="Bold (Ctrl+B)">${ico.bold}</button>
  <button data-action="italic"     title="Italic (Ctrl+I)">${ico.italic}</button>
  <button data-action="underline"  title="Underline (Ctrl+U)">${ico.underline}</button>
  <div class="tb-sep"></div>
  <div class="tb-grp" id="grp-text">
    <button class="tb-grp-toggle" title="More formatting">${ico.grpText}</button>
    <div class="tb-grp-content">
      <button data-action="strike" title="Strikethrough">${ico.strike}</button>
      <button data-action="code"   title="Inline code">${ico.code}</button>
      <button data-action="link"   title="Insert / remove link">${ico.link}</button>
    </div>
  </div>
  <div class="tb-sep"></div>
  <div class="tb-grp" id="grp-headings">
    <button class="tb-grp-toggle" title="Headings">${ico.grpHeadings}</button>
    <div class="tb-grp-content">
      <button data-action="h1" title="Heading 1">${ico.h1}</button>
      <button data-action="h2" title="Heading 2">${ico.h2}</button>
      <button data-action="h3" title="Heading 3">${ico.h3}</button>
    </div>
  </div>
  <div class="tb-sep"></div>
  <div class="tb-grp" id="grp-lists">
    <button class="tb-grp-toggle" title="Lists &amp; indent">${ico.grpLists}</button>
    <div class="tb-grp-content">
      <button data-action="bulletList"  title="Bullet list">${ico.list}</button>
      <button data-action="orderedList" title="Ordered list">${ico.listOrdered}</button>
      <button data-action="taskList"    title="Task list">${ico.listChecks}</button>
      <button data-action="indent"      title="Indent (Tab)">${ico.indent}</button>
      <button data-action="outdent"     title="Outdent (Shift+Tab)">${ico.outdent}</button>
    </div>
  </div>
  <div class="tb-sep"></div>
  <div class="tb-grp" id="grp-blocks">
    <button class="tb-grp-toggle" title="Blocks">${ico.grpBlocks}</button>
    <div class="tb-grp-content">
      <button data-action="blockquote" title="Blockquote">${ico.quote}</button>
      <button data-action="codeBlock"  title="Code block">${ico.code2}</button>
      <button data-action="hr"         title="Horizontal rule">${ico.minus}</button>
    </div>
  </div>
  <div class="tb-sep"></div>
  <button data-action="undo" title="Undo (Ctrl+Z)">${ico.undo}</button>
  <button data-action="redo" title="Redo">${ico.redo}</button>
  <div class="tb-sep"></div>
  <div class="tb-grp" id="grp-templates">
    <button class="tb-grp-toggle" title="Templates">${ico.grpTemplates}</button>
    <div class="tb-grp-content">
      <button data-action="applyTemplate"  title="Apply a template to this note">${ico.tplDown}</button>
      <button data-action="saveAsTemplate" title="Save this note as a custom template">${ico.tplUp}</button>
    </div>
  </div>
  <div class="tb-sep"></div>
  <button data-action="exportCurrentNote" title="Export this note">${ico.export}</button>
</div>

<div id="editor-mount"></div>
<div id="save-status"></div>

<script nonce="${nonce}">var __INITIAL_CONTENT__ = ${content}; var __INITIAL_TITLE__ = ${title};</script>
<script src="${editorJsUri}" nonce="${nonce}"></script>
</body>
</html>`;
  }
}

