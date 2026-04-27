import * as vscode from 'vscode';
import { NoteStorage, Note, Tag } from '../services/NoteStorage';
import { UI_COLORS } from '../utils/colors';
import { getNonce, svgIcon } from '../utils/webview';
import { Star } from 'lucide';
import type { IconNode as LucideNode } from 'lucide';
import * as AllLucide from 'lucide';

const ALL_LUCIDE_NODES: Record<string, LucideNode> = Object.fromEntries(
  Object.entries(AllLucide as Record<string, unknown>).filter(([, v]) => Array.isArray(v))
) as Record<string, LucideNode>;

export class ConflictPanel {
  static current?: ConflictPanel;

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private resolved = false;

  // ── Static factory ──────────────────────────────────────────────────────

  static async show(
    context    : vscode.ExtensionContext,
    storage    : NoteStorage,
    noteId     : string,
    onResolved : () => void,
    themeVars  : Record<string, string> | null = null,
  ): Promise<void> {
    const versions = await storage.getConflictVersions(noteId);
    if (!versions) {
      vscode.window.showInformationMessage('DevNotes: this note no longer has a conflict.');
      return;
    }

    if (ConflictPanel.current) {
      ConflictPanel.current.panel.dispose();
    }

    new ConflictPanel(context, storage, noteId, versions.ours, versions.theirs, versions.incomingRef, versions.oursRef, onResolved);
    if (themeVars) ConflictPanel.current?.setTheme(themeVars);
  }

  // ── Theme propagation from sidebar preview ───────────────────────────────

  setTheme(vars: Record<string, string> | null): void {
    this.panel.webview.postMessage({ type: 'setTheme', vars });
  }

  // ── Constructor ─────────────────────────────────────────────────────────

  private constructor(
    context      : vscode.ExtensionContext,
    private readonly storage    : NoteStorage,
    private readonly noteId     : string,
    ours         : Note,
    theirs       : Note,
    incomingRef  : string,
    oursRef      : string,
    private readonly onResolved : () => void,
  ) {
    this.panel = vscode.window.createWebviewPanel(
      'devnotes.conflict',
      `Conflict Panel — ${ours.title}`,
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true },
    );

    this.panel.webview.html = this.buildHtml(ours, theirs, incomingRef, oursRef, this.storage.getTags());

    this.panel.webview.onDidReceiveMessage(
      async (msg: { type: string; side?: 'ours' | 'theirs' | 'both'; mergedNote?: { title: string; tags: string[]; content: string } }) => {
        if (msg.type === 'resolve' && msg.side) {
          if (this.resolved) return;
          this.resolved = true;
          if (msg.side === 'both' && msg.mergedNote) {
            await this.storage.resolveConflictMerged(this.noteId, msg.mergedNote);
          } else {
            await this.storage.resolveConflict(this.noteId, msg.side);
          }
          this.onResolved();
          this.panel.dispose();
        }
      },
      null,
      this.disposables,
    );

    this.panel.onDidDispose(() => {
      ConflictPanel.current = undefined;
      this.disposables.forEach(d => d.dispose());
    }, null, this.disposables);

    ConflictPanel.current = this;
  }

  // ── HTML ─────────────────────────────────────────────────────────────────

  private buildHtml(ours: Note, theirs: Note, incomingRef: string, oursRef: string, tags: Tag[]): string {
    const nonce      = getNonce();
    const esc = (v: unknown) => JSON.stringify(v).replace(/<\/script>/gi, '<\\/script>');
    const escHtml    = (s: string) => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    const oursJson   = esc(ours);
    const theirsJson = esc(theirs);
    const tagsJson   = esc(tags.map(t => ({
      ...t,
      iconSvg: t.icon && ALL_LUCIDE_NODES[t.icon] ? svgIcon(ALL_LUCIDE_NODES[t.icon], 11) : undefined,
    })));
    const refJson    = esc(incomingRef);
    const oursRefJson = esc(oursRef);
    const starEmptyJson  = esc(svgIcon(Star, 14));
    const starFilledJson = esc(svgIcon(Star, 14, '', 'currentColor'));
    const checkmarkDataUri = `data:image/svg+xml;base64,${Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 10 10"><path d="M1.5 5l2.5 2.5 4.5-4.5" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>'
    ).toString('base64')}`;
    const toolbarIconsJson = esc({
      bold:      svgIcon(AllLucide.Bold          as LucideNode, 14),
      italic:    svgIcon(AllLucide.Italic        as LucideNode, 14),
      underline: svgIcon(AllLucide.Underline     as LucideNode, 14),
      strike:    svgIcon(AllLucide.Strikethrough as LucideNode, 14),
      code:      svgIcon(AllLucide.Code          as LucideNode, 14),
      h1:        svgIcon(AllLucide.Heading1      as LucideNode, 14),
      h2:        svgIcon(AllLucide.Heading2      as LucideNode, 14),
      h3:        svgIcon(AllLucide.Heading3      as LucideNode, 14),
      list:      svgIcon(AllLucide.List          as LucideNode, 14),
      listOrd:   svgIcon(AllLucide.ListOrdered   as LucideNode, 14),
      listChecks:svgIcon(AllLucide.ListChecks    as LucideNode, 14),
      quote:     svgIcon(AllLucide.Quote         as LucideNode, 14),
      minus:     svgIcon(AllLucide.Minus         as LucideNode, 14),
      code2:     svgIcon(AllLucide.Code2         as LucideNode, 14),
      eraser:    svgIcon(AllLucide.Eraser        as LucideNode, 14),
      undo:      svgIcon(AllLucide.Undo2         as LucideNode, 14),
      redo:      svgIcon(AllLucide.Redo2         as LucideNode, 14),
    });

    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --fields-pt:  10px;
    --content-pt: 10px;
    --content-pb: 10px;
  }

  body {
    font-family: var(--vscode-font-family);
    font-size: 13px;
    background: var(--vscode-editor-background);
    color: var(--vscode-editor-foreground);
    height: 100vh;
    display: flex;
    flex-direction: column;
    padding: 16px 20px 14px;
    gap: 12px;
    overflow: hidden;
  }

  /* ── Banner ── */
  .banner {
    display: flex;
    flex-direction: column;
    gap: 3px;
    padding: 13px 17px;
    background: rgba(255,200,50,.07);
    border: 1px solid rgba(255,200,50,.22);
    border-radius: 10px;
    flex-shrink: 0;
  }
  .banner-heading {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .banner-icon {
    width: 16px;
    height: 16px;
    flex-shrink: 0;
    color: rgba(255,180,0,.9);
    stroke: currentColor;
  }
  .banner-title { font-size: 13.5px; font-weight: 700; color: rgba(255,180,0,.9); }
  .banner-sub { font-size: 11.5px; color: var(--vscode-descriptionForeground); line-height: 1.5; }

  /* ── Cards row ── */
  .cards-row {
    display: flex;
    gap: 12px;
    flex: 1;
    min-height: 0;
  }
  .col {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }

  /* ── Card ── */
  .card {
    flex: 1;
    display: flex;
    flex-direction: column;
    background: var(--vscode-editorWidget-background);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 10px;
    overflow: hidden;
    min-height: 0;
    padding-bottom: var(--content-pb);
  }

  /* ── Card header ── */
  .card-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 11px 15px;
    flex-shrink: 0;
  }
  .card-ours   { border-color: rgba(59,130,246,.45); }
  .card-theirs { border-color: rgba(22,163,74,.45); }
  .card-header-ours {
    background: rgba(59,130,246,.12);
    border-bottom: 1.5px solid rgba(59,130,246,.35);
  }
  .card-header-theirs {
    background: rgba(22,163,74,.12);
    border-bottom: 1.5px solid rgba(22,163,74,.35);
  }
  .pill {
    font-size: 11px;
    font-weight: 700;
    padding: 3px 13px;
    border-radius: 20px;
    color: #fff;
    letter-spacing: .01em;
  }
  .pill-ours   { background: #3b82f6; }
  .pill-theirs { background: #16a34a; }
  .card-ref {
    font-size: 11px;
    font-family: var(--vscode-editor-font-family, monospace);
    color: var(--vscode-descriptionForeground);
    opacity: .55;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 55%;
  }

  /* ── Field rows (sidebar style) ── */
  .card-fields {
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: var(--fields-pt) 0 6px;
  }

  .cf-row {
    padding: 0 16px;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px;
    min-height: 20px;
  }
  .cf-title-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    flex-wrap: nowrap;
  }
  .cf-title {
    font-size: 13px;
    font-weight: 700;
    line-height: 1.4;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
    min-width: 0;
  }
  .cf-star {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    opacity: .35;
  }
  .cf-star.cf-star-on {
    color: #f59e0b;
    opacity: 1;
  }
  .cf-star.cf-star-changed {
    color: rgba(163,230,53,.9);
    opacity: 1;
  }

  /* ── Tag pills (sidebar tinted style) ── */
  .tag-pill {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    padding: 2px 7px;
    border-radius: 20px;
    font-size: 11px;
    font-weight: 500;
    border: 1.5px solid transparent;
  }
  .tag-icon {
    display: inline-flex;
    align-items: center;
    flex-shrink: 0;
  }



  /* ── Diff highlights ── */
  .diff-hl-inline {
    background: rgba(163,230,53,.28);
    border-radius: 3px;
    padding: 0 3px;
  }
  /* ── New-tag indicator ── */
  .tag-pill.tag-new {
    outline: 1px solid rgba(163,230,53,.55);
    outline-offset: 2px;
    margin-inline: 3px;
  }
  .diff-hl-block {
    background: rgba(163,230,53,.14);
    border-radius: 5px;
    margin: 2px -6px;
    padding: 2px 6px;
  }

  /* ── Content area ── */
  .card-content-wrap {
    flex: 1;
    position: relative;
    overflow: hidden;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .card-content-wrap::before {
    content: '';
    height: 1px;
    background: rgba(128,128,128,.08);
    margin: 0 16px;
    flex-shrink: 0;
  }
  .card-content {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: var(--content-pt) 16px 0;
  }

  .scroll-hint {
    position: absolute;
    bottom: 5px;
    right: 9px;
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    opacity: .45;
    pointer-events: none;
    transition: opacity .2s;
    user-select: none;
  }
  .scroll-hint.gone { opacity: 0; }

  /* ── Rendered markdown ── */
  .md { font-size: 12.5px; line-height: 1.65; }
  .md p { margin-bottom: .55em; }
  .md p:last-child { margin-bottom: 0; }
  .md strong { font-weight: 700; }
  .md em { font-style: italic; }
  .md del { text-decoration: line-through; opacity: .6; }
  .md u { text-decoration: underline; }
  .md code {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: .88em;
    background: rgba(128,128,128,.15);
    border-radius: 3px;
    padding: 1px 4px;
  }
  .md pre {
    background: rgba(128,128,128,.12);
    border-radius: 5px;
    padding: 9px 12px;
    overflow-x: auto;
    font-size: .88em;
    margin-bottom: .55em;
    font-family: var(--vscode-editor-font-family, monospace);
    white-space: pre;
  }
  .md ul, .md ol { padding-left: 20px; margin-bottom: .55em; }
  .md li { margin-bottom: .2em; }
  .md blockquote {
    border-left: 2px solid var(--vscode-panel-border);
    padding-left: 10px;
    color: var(--vscode-descriptionForeground);
    margin-bottom: .55em;
  }
  .md h1, .md h2, .md h3 { font-weight: 700; margin-bottom: .3em; }
  .md ul.task-list { list-style: none; padding-left: 0; }
  .md ul.task-list li { display: flex; align-items: flex-start; gap: 6px; }
  .md ul.task-list input[type="checkbox"] {
    appearance: none; -webkit-appearance: none;
    width: 13px; height: 13px; flex-shrink: 0; margin-top: 3px;
    background: transparent;
    border: 1.5px solid var(--vscode-editor-foreground);
    border-radius: 2px; cursor: pointer;
    transition: background .1s, border-color .1s;
  }
  .md ul.task-list input[type="checkbox"]:checked {
    background-color: var(--vscode-button-background);
    border-color: var(--vscode-button-background);
    background-image: url('${checkmarkDataUri}');
    background-repeat: no-repeat; background-position: center;
  }
  .md ul.task-list li input[type="checkbox"]:checked ~ span { text-decoration: line-through; opacity: .5; }
  .md hr {
    border: none;
    border-top: 1px solid var(--vscode-panel-border);
    margin: .6em 0;
  }

  /* ── Action buttons ── */
  .action-row {
    display: flex;
    gap: 10px;
    flex-shrink: 0;
  }
  .action-card {
    flex: 1;
    padding: 12px 14px;
    background: rgba(128,128,128,.07);
    border: 1px solid rgba(128,128,128,.25);
    border-radius: 8px;
    cursor: pointer;
    display: flex;
    flex-direction: column;
    gap: 5px;
    text-align: left;
    font-family: var(--vscode-font-family);
    color: var(--vscode-editor-foreground);
    transition: background .12s, border-color .12s;
  }
  .action-head {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .action-card:hover {
    background: rgba(128,128,128,.13);
    border-color: rgba(128,128,128,.45);
  }
  #keep-ours {
    border-color: rgba(59,130,246,.35);
    background: rgba(59,130,246,.06);
  }
  #keep-ours:hover {
    background: rgba(59,130,246,.12);
    border-color: rgba(59,130,246,.55);
  }
  #keep-ours .action-title { color: rgba(59,130,246,.9); }
  #keep-ours .action-icon  { stroke: rgba(59,130,246,.7); }
  #keep-theirs {
    border-color: rgba(22,163,74,.35);
    background: rgba(22,163,74,.06);
  }
  #keep-theirs:hover {
    background: rgba(22,163,74,.12);
    border-color: rgba(22,163,74,.55);
  }
  #keep-theirs .action-title { color: rgba(22,163,74,.9); }
  #keep-theirs .action-icon  { stroke: rgba(22,163,74,.7); }
  .action-icon {
    width: 20px;
    height: 20px;
    flex-shrink: 0;
    fill: none;
    stroke: var(--vscode-descriptionForeground);
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .action-title { font-size: 13px; font-weight: 700; }
  .action-desc  { font-size: 11px; color: var(--vscode-descriptionForeground); line-height: 1.45; }


  /* ── Merge modal ── */
  .modal-backdrop {
    position: fixed; inset: 0; background: rgba(0,0,0,.5);
    display: flex; align-items: center; justify-content: center;
    z-index: 100; opacity: 0; pointer-events: none; transition: opacity .15s;
  }
  .modal-backdrop.open { opacity: 1; pointer-events: auto; }
  .modal {
    background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 10px; width: min(600px, 90vw); height: min(640px, 82vh);
    display: flex; flex-direction: column;
    box-shadow: 0 10px 40px rgba(0,0,0,.4);
    transform: translateY(8px); transition: transform .15s;
  }
  .modal-backdrop.open .modal { transform: translateY(0); }
  .modal-header {
    display: flex; align-items: stretch; justify-content: space-between;
    padding: 13px 16px 13px 18px;
    border-bottom: 1px solid var(--vscode-panel-border); flex-shrink: 0;
  }
  .modal-title { font-size: 13px; font-weight: 700; margin-bottom: 3px; }
  .modal-sub { font-size: 11px; color: var(--vscode-descriptionForeground); line-height: 1.5; }
  .modal-header-right { display: flex; align-items: stretch; }
  .modal-seg {
    display: flex; background: rgba(128,128,128,.1);
    border-radius: 6px; padding: 2px; gap: 1px;
  }
  .modal-seg-btn {
    background: none; border: none; cursor: pointer;
    padding: 0 11px; border-radius: 4px;
    font-size: 11.5px; font-weight: 500;
    color: var(--vscode-descriptionForeground);
    font-family: var(--vscode-font-family);
    display: flex; align-items: center;
    transition: background .1s, color .1s;
  }
  .modal-seg-btn.active {
    background: var(--vscode-editorWidget-background);
    color: var(--vscode-foreground);
    box-shadow: 0 1px 3px rgba(0,0,0,.2);
  }
  .modal-body { flex: 1; overflow: hidden; padding: 14px 16px; min-height: 0; display: flex; flex-direction: column; }
  .modal-footer {
    display: flex; align-items: center; justify-content: flex-end;
    gap: 8px; padding: 12px 18px;
    border-top: 1px solid var(--vscode-panel-border); flex-shrink: 0;
  }
  .btn-cancel {
    background: none; border: 1px solid var(--vscode-panel-border);
    color: var(--vscode-foreground); padding: 6px 16px; border-radius: 6px;
    cursor: pointer; font-size: 12px; font-family: var(--vscode-font-family);
    transition: background .1s;
  }
  .btn-cancel:hover { background: var(--vscode-toolbar-hoverBackground); }
  .btn-confirm-merge {
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    border: none; padding: 6px 18px; border-radius: 6px; cursor: pointer;
    font-size: 12px; font-weight: 600; font-family: var(--vscode-font-family);
    transition: filter .1s;
  }
  .btn-confirm-merge:hover { filter: brightness(1.1); }

  /* ── Merged note card (inside modal) ── */
  .merged-card {
    display: flex; flex-direction: column;
    background: var(--vscode-editorWidget-background);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 10px; overflow: hidden;
    flex: 1; min-height: 0;
  }
  .merged-card-fields {
    flex-shrink: 0; display: flex; flex-direction: column;
    gap: 6px; padding: 10px 0 6px;
  }
  .merged-card-sep {
    height: 1px; background: rgba(128,128,128,.08); margin: 0 16px;
  }
  .merged-card-content {
    flex: 1; min-height: 0; overflow-y: auto;
  }
  .mc-rendered { padding: 10px 16px 10px; min-height: 200px; }
  .mc-rendered[contenteditable="true"] {
    outline: none; cursor: text;
    caret-color: var(--vscode-editor-foreground);
  }
  .mc-rendered:not([contenteditable="true"]) input[type="checkbox"],
  .card-content input[type="checkbox"] { pointer-events: none; }
  /* Contenteditable title */
  .cf-title[contenteditable="true"] {
    outline: none; cursor: text;
  }
  /* Tag editing controls */
  .edit-tag-remove {
    background: none; border: none; cursor: pointer;
    font-size: 12px; opacity: .55; padding: 0 1px;
    line-height: 1; color: inherit; font-family: inherit;
  }
  .edit-tag-remove:hover { opacity: 1; }
  .edit-tag-add {
    background: none; border: 1px dashed rgba(128,128,128,.4);
    border-radius: 20px; padding: 2px 9px;
    font-size: 11px; cursor: pointer;
    color: var(--vscode-descriptionForeground);
    font-family: var(--vscode-font-family); transition: border-color .1s;
  }
  .edit-tag-add:hover { border-color: rgba(128,128,128,.7); color: var(--vscode-foreground); }
  .tag-dropdown { position: relative; display: inline-block; }
  .tag-dropdown-menu {
    position: absolute; top: calc(100% + 4px); left: 0;
    background: var(--vscode-editorWidget-background);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 6px; padding: 4px; z-index: 400;
    min-width: 150px; box-shadow: 0 4px 12px rgba(0,0,0,.25); display: none;
  }
  .tag-dropdown-menu.open { display: block; }
  .tag-dropdown-item {
    display: flex; align-items: center; gap: 6px;
    padding: 5px 8px; border-radius: 4px; cursor: pointer; font-size: 11px;
  }
  .tag-dropdown-item:hover { background: var(--vscode-list-hoverBackground); }
  .tag-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }

  /* ── Merge modal toolbar ── */
  .mc-toolbar {
    display: none; align-items: center; flex-wrap: wrap;
    gap: 1px; padding: 4px 8px;
    border-top: 1px solid rgba(128,128,128,.1); flex-shrink: 0;
  }
  .mc-toolbar.visible { display: flex; }
  .mc-tb-btn {
    display: flex; align-items: center; justify-content: center;
    background: none; border: none; cursor: pointer;
    color: var(--vscode-foreground);
    min-width: 26px; height: 24px; border-radius: 4px;
    opacity: .65; padding: 0;
    transition: background .1s, opacity .1s;
  }
  .mc-tb-btn:hover { background: var(--vscode-toolbar-hoverBackground); opacity: 1; }
  .mc-tb-btn.is-active { background: rgba(128,128,128,.2); opacity: 1; }
  .mc-tb-sep { width: 1px; height: 16px; background: rgba(128,128,128,.25); margin: 0 3px; flex-shrink: 0; }

</style>
</head>
<body>

<div class="banner">
  <div class="banner-heading">
    <svg class="banner-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/>
      <path d="M12 9v4"/>
      <path d="M12 17h.01"/>
    </svg>
    <span class="banner-title" id="conflict-title"></span>
  </div>
  <div class="banner-sub">A git merge conflict was detected. Review both versions and choose how to proceed.</div>
</div>

<div class="cards-row">
  <div class="col">
    <div class="card card-ours">
      <div class="card-header card-header-ours">
        <span class="pill pill-ours">Your version</span>
        <span class="card-ref">${escHtml(oursRef)}</span>
      </div>
      <div class="card-fields" id="fields-ours"></div>
      <div class="card-content-wrap">
        <div class="card-content md" id="content-ours"></div>
        <div class="scroll-hint gone" id="hint-ours">▾</div>
      </div>
    </div>
  </div>

  <div class="col">
    <div class="card card-theirs">
      <div class="card-header card-header-theirs">
        <span class="pill pill-theirs">Incoming</span>
        <span class="card-ref" id="incoming-ref"></span>
      </div>
      <div class="card-fields" id="fields-theirs"></div>
      <div class="card-content-wrap">
        <div class="card-content md" id="content-theirs"></div>
        <div class="scroll-hint gone" id="hint-theirs">▾</div>
      </div>
    </div>
  </div>
</div>

<div class="action-row">
  <button class="action-card" id="keep-ours">
    <div class="action-head">
      <svg class="action-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
        <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/>
        <circle cx="12" cy="7" r="4"/>
      </svg>
      <div class="action-title">Keep mine</div>
    </div>
    <div class="action-desc" id="mine-desc"></div>
  </button>
  <button class="action-card action-card-merge" id="btn-merge-preview">
    <div class="action-head">
      <svg class="action-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
        <circle cx="18" cy="18" r="3"/>
        <circle cx="6" cy="6" r="3"/>
        <path d="M6 21V9a9 9 0 0 0 9 9"/>
      </svg>
      <div class="action-title">Merge versions</div>
    </div>
    <div class="action-desc">Preview and combine both versions</div>
  </button>
  <button class="action-card" id="keep-theirs">
    <div class="action-head">
      <svg class="action-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
        <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/>
        <circle cx="9" cy="7" r="4"/>
        <path d="M22 21v-2a4 4 0 0 0-3-3.87"/>
        <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
      </svg>
      <div class="action-title">Keep theirs</div>
    </div>
    <div class="action-desc" id="theirs-desc"></div>
  </button>
</div>
<div class="modal-backdrop" id="merge-modal">
  <div class="modal">
    <div class="modal-header">
      <div>
        <div class="modal-title">Merge versions</div>
        <div class="modal-sub">Review and optionally edit the merged result before confirming.</div>
      </div>
      <div class="modal-header-right">
        <div class="modal-seg">
          <button class="modal-seg-btn active" id="tab-preview">Preview</button>
          <button class="modal-seg-btn" id="tab-edit">Edit</button>
        </div>
      </div>
    </div>
    <div class="modal-body" id="modal-body"></div>
    <div class="modal-footer">
      <button class="btn-cancel" id="modal-cancel">Cancel</button>
      <button class="btn-confirm-merge" id="modal-confirm">Confirm merge</button>
    </div>
  </div>
</div>

<script nonce="${nonce}">
(() => {
  const vscode      = acquireVsCodeApi();
  const ours        = ${oursJson};
  const theirs      = ${theirsJson};
  const tags        = ${tagsJson};
  const incomingRef = ${refJson};
  const oursRef     = ${oursRefJson};
  const starEmpty      = ${starEmptyJson};
  const starFilled     = ${starFilledJson};
  const toolbarIcons   = ${toolbarIconsJson};

  document.getElementById('conflict-title').textContent = 'Conflict in "' + ours.title + '"';
  document.getElementById('incoming-ref').textContent   = incomingRef;

  document.getElementById('mine-desc').textContent   = 'Your ' + oursRef + ' version, discard incoming changes';
  const theirsOwner = theirs.owner || incomingRef || 'incoming';
  document.getElementById('theirs-desc').textContent = theirsOwner + '’s version, discard your changes';

  // ── Render fields ────────────────────────────────────────────────────────
  renderFields(document.getElementById('fields-ours'),   ours,   theirs, false);
  renderFields(document.getElementById('fields-theirs'), theirs, ours,   true);

  function hexToRgba(hex, alpha) {
    const r = parseInt(hex.slice(1,3), 16);
    const g = parseInt(hex.slice(3,5), 16);
    const b = parseInt(hex.slice(5,7), 16);
    return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
  }
  function applyPillStyle(el, color) {
    el.style.background  = hexToRgba(color, 0.18);
    el.style.borderColor = color;
    el.style.color       = color;
  }

  function renderFields(container, note, other, isTheirs) {
    // Row 1: title (left) + star icon (right)
    const titleRow = document.createElement('div');
    titleRow.className = 'cf-row cf-title-row';

    const titleEl = document.createElement('span');
    titleEl.className = 'cf-title';
    titleEl.innerHTML = renderTitle(note.title, other.title, isTheirs);
    titleRow.appendChild(titleEl);

    const starEl = document.createElement('span');
    starEl.className = 'cf-star' + (note.starred ? ' cf-star-on' : '');
    starEl.innerHTML = note.starred ? starFilled : starEmpty;
    if (isTheirs && note.starred !== other.starred) starEl.classList.add('cf-star-changed');
    titleRow.appendChild(starEl);

    container.appendChild(titleRow);

    // Row 2: tags
    const tagsRow = document.createElement('div');
    tagsRow.className = 'cf-row';
    tagsRow.appendChild(renderTags(note.tags, other.tags, isTheirs));
    container.appendChild(tagsRow);
  }

  function renderTitle(noteTitle, otherTitle, isTheirs) {
    const e = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    if (!isTheirs || noteTitle === otherTitle) return e(noteTitle);
    let i = 0;
    while (i < otherTitle.length && i < noteTitle.length && noteTitle[i] === otherTitle[i]) i++;
    const common = e(noteTitle.slice(0, i));
    const added  = e(noteTitle.slice(i));
    return added
      ? common + '<span class="diff-hl-inline">' + added + '</span>'
      : common;
  }

  function renderTags(noteTags, otherTags, isTheirs) {
    const wrap = document.createElement('div');
    wrap.style.display  = 'flex';
    wrap.style.flexWrap = 'wrap';
    wrap.style.gap      = '4px';
    const otherSet = new Set(otherTags);
    if (!noteTags || noteTags.length === 0) {
      wrap.style.opacity  = '.45';
      wrap.style.fontSize = '12px';
      wrap.textContent    = '—';
      return wrap;
    }
    noteTags.forEach(tid => {
      const t = tags.find(t => t.id === tid);
      if (!t) return;
      const pill = document.createElement('span');
      pill.className = 'tag-pill' + (isTheirs && !otherSet.has(tid) ? ' tag-new' : '');
      applyPillStyle(pill, t.color);
      if (t.iconSvg) {
        const ico = document.createElement('span');
        ico.className = 'tag-icon';
        ico.innerHTML = t.iconSvg;
        pill.appendChild(ico);
      }
      const lbl = document.createElement('span');
      lbl.textContent = t.label;
      pill.appendChild(lbl);
      wrap.appendChild(pill);
    });
    return wrap;
  }


  // ── Render content ───────────────────────────────────────────────────────
  const oursContentEl   = document.getElementById('content-ours');
  const theirsContentEl = document.getElementById('content-theirs');

  // Ours: clean markdown
  oursContentEl.innerHTML = simpleMarkdown(ours.content || '');

  // Theirs: diff-highlighted markdown
  renderTheirsContent(theirsContentEl, ours.content || '', theirs.content || '');

  function renderTheirsContent(container, oursContent, theirsContent) {
    const oursLines   = oursContent.split('\\n');
    const theirsLines = theirsContent.split('\\n');
    const {bDiff} = diffLines(oursLines, theirsLines);

    // Group consecutive lines by type
    const groups = [];
    let cur = null;
    bDiff.forEach(({text, type}) => {
      if (!cur || cur.type !== type) { cur = {type, lines: [text]}; groups.push(cur); }
      else cur.lines.push(text);
    });

    groups.forEach(group => {
      const html = simpleMarkdown(group.lines.join('\\n'));
      if (group.type === 'ins') {
        const wrap = document.createElement('div');
        wrap.className = 'diff-hl-block';
        wrap.innerHTML = html;
        container.appendChild(wrap);
      } else {
        container.appendChild(document.createRange().createContextualFragment(html));
      }
    });
  }

  // ── LCS line diff ────────────────────────────────────────────────────────
  function diffLines(aLines, bLines) {
    const A = aLines.slice(0, 300), B = bLines.slice(0, 300);
    const M = A.length, N = B.length;
    const dp = Array.from({length: M + 1}, () => new Int32Array(N + 1));
    for (let i = 1; i <= M; i++)
      for (let j = 1; j <= N; j++)
        dp[i][j] = A[i-1] === B[j-1] ? dp[i-1][j-1] + 1 : Math.max(dp[i-1][j], dp[i][j-1]);

    const aDiff = [], bDiff = [];
    let i = M, j = N;
    while (i > 0 || j > 0) {
      if (i > 0 && j > 0 && A[i-1] === B[j-1]) {
        aDiff.unshift({text: A[i-1], type: 'same'});
        bDiff.unshift({text: B[j-1], type: 'same'});
        i--; j--;
      } else if (j > 0 && (i === 0 || dp[i][j-1] >= dp[i-1][j])) {
        bDiff.unshift({text: B[j-1], type: 'ins'});
        j--;
      } else {
        aDiff.unshift({text: A[i-1], type: 'del'});
        i--;
      }
    }
    aLines.slice(300).forEach(t => aDiff.push({text: t, type: 'same'}));
    bLines.slice(300).forEach(t => bDiff.push({text: t, type: 'same'}));
    return {aDiff, bDiff};
  }

  // ── Scroll hints + sync ──────────────────────────────────────────────────
  function setupScrollHint(el, hintEl) {
    const check = () => {
      const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 4;
      const noScroll = el.scrollHeight <= el.clientHeight + 2;
      hintEl.classList.toggle('gone', atBottom || noScroll);
    };
    el.addEventListener('scroll', check);
    setTimeout(check, 80);
  }
  setupScrollHint(oursContentEl,   document.getElementById('hint-ours'));
  setupScrollHint(theirsContentEl, document.getElementById('hint-theirs'));

  let syncing = false;
  function bindSync(src, dst) {
    src.addEventListener('scroll', () => {
      if (syncing) return;
      syncing = true;
      const ratio = src.scrollTop / Math.max(1, src.scrollHeight - src.clientHeight);
      dst.scrollTop = ratio * (dst.scrollHeight - dst.clientHeight);
      syncing = false;
    });
  }
  bindSync(oursContentEl, theirsContentEl);
  bindSync(theirsContentEl, oursContentEl);

  // ── Merge modal ──────────────────────────────────────────────────────────
  const modal = document.getElementById('merge-modal');

  // Mutable merged state — persists across Preview ↔ Edit switches
  let mergedTitle   = '';
  let mergedTagIds  = [];
  let mergedContent = '';
  let modalMode     = 'preview';

  function openModal() {
    const oursC   = (ours.content   || '').trim();
    const theirsC = (theirs.content || '').trim();
    mergedTitle   = ours.title;
    mergedTagIds  = [...new Set([...ours.tags, ...theirs.tags])];
    mergedContent = !oursC ? theirsC : !theirsC ? oursC : oursC === theirsC ? oursC : oursC + '\\n\\n---\\n\\n' + theirsC;
    modalMode     = 'preview';
    document.getElementById('tab-preview').classList.add('active');
    document.getElementById('tab-edit').classList.remove('active');
    buildAndFillCard();
    modal.classList.add('open');
  }

  // ── Card refs (set once per openModal, used by applyEditMode) ──
  let _titleEl = null, _tagsRow = null, _tagsWrap = null, _rendered = null, _toolbar = null;

  function buildAndFillCard() {
    const body = document.getElementById('modal-body');
    body.innerHTML = '';

    // Shell
    const el = document.createElement('div');
    el.className = 'merged-card';

    const fields = document.createElement('div');
    fields.className = 'merged-card-fields';
    const titleRow = document.createElement('div');
    titleRow.className = 'cf-row cf-title-row';
    const tagsRow = document.createElement('div');
    tagsRow.className = 'cf-row';
    fields.appendChild(titleRow); fields.appendChild(tagsRow);
    el.appendChild(fields);

    const sep = document.createElement('div');
    sep.className = 'merged-card-sep';
    el.appendChild(sep);

    const contentEl = document.createElement('div');
    contentEl.className = 'merged-card-content';
    el.appendChild(contentEl);

    const toolbar = buildToolbar();
    el.appendChild(toolbar);
    body.appendChild(el);

    // Title (contenteditable toggled by applyEditMode)
    const titleEl = document.createElement('span');
    titleEl.className = 'cf-title'; titleEl.textContent = mergedTitle;
    titleEl.addEventListener('input', () => { mergedTitle = titleEl.textContent || ''; });
    titleRow.appendChild(titleEl);
    const starEl = document.createElement('span');
    starEl.className = 'cf-star' + (ours.starred ? ' cf-star-on' : '');
    starEl.innerHTML = ours.starred ? starFilled : starEmpty;
    titleRow.appendChild(starEl);

    // Tags wrap (rebuilt by rebuildTags, which respects modalMode)
    const tagsWrap = document.createElement('div');
    tagsWrap.style.display = 'flex'; tagsWrap.style.flexWrap = 'wrap';
    tagsWrap.style.gap = '4px'; tagsWrap.style.alignItems = 'center';
    tagsRow.appendChild(tagsWrap);

    // Content: contenteditable rendered div (edit mode) or static (preview)
    const rendered = document.createElement('div');
    rendered.className = 'mc-rendered md';
    rendered.innerHTML = simpleMarkdown(mergedContent);
    rendered.addEventListener('focus', () => {
      if (_toolbar && modalMode === 'edit') { _toolbar.classList.add('visible'); updateToolbarState(_toolbar); }
    });
    rendered.addEventListener('blur', () => {
      mergedContent = htmlToMd(rendered.innerHTML);
      if (_toolbar) _toolbar.classList.remove('visible');
    });
    rendered.addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      const sel = window.getSelection();
      if (!sel || !sel.rangeCount) return;
      let node = sel.getRangeAt(0).startContainer;
      if (node.nodeType === 3) node = node.parentElement;
      const li = node.closest('li');
      const ul = li && li.closest('ul');
      if (!ul || !ul.classList.contains('task-list')) return;
      e.preventDefault();
      const sp = li.querySelector(':scope > span');
      const isEmpty = !sp || sp.textContent.replace(/​/g, '').trim() === '';
      if (isEmpty) {
        const p = document.createElement('p'); p.innerHTML = '<br>';
        ul.insertAdjacentElement('afterend', p);
        li.remove();
        if (!ul.children.length) ul.remove();
        const r = document.createRange();
        r.selectNodeContents(p); r.collapse(true);
        sel.removeAllRanges(); sel.addRange(r);
        return;
      }
      const newLi = document.createElement('li');
      const newCb = document.createElement('input'); newCb.type = 'checkbox';
      const newSp = document.createElement('span'); newSp.textContent = '​';
      newLi.appendChild(newCb); newLi.appendChild(newSp);
      li.insertAdjacentElement('afterend', newLi);
      const r = document.createRange();
      r.selectNodeContents(newSp); r.collapse(false);
      sel.removeAllRanges(); sel.addRange(r);
    });
    rendered.addEventListener('change', e => { if (e.target.type === 'checkbox') mergedContent = htmlToMd(rendered.innerHTML); });
    rendered.addEventListener('keyup',  () => { if (_toolbar) updateToolbarState(_toolbar); });
    rendered.addEventListener('mouseup', () => { if (_toolbar) updateToolbarState(_toolbar); });
    contentEl.appendChild(rendered);

    _titleEl = titleEl; _tagsRow = tagsRow; _tagsWrap = tagsWrap;
    _rendered = rendered; _toolbar = toolbar;

    rebuildTags();
  }

  function rebuildTags() {
    const wrap = _tagsWrap;
    wrap.innerHTML = '';
    if (mergedTagIds.length === 0 && modalMode !== 'edit') {
      wrap.style.opacity = '.45'; wrap.style.fontSize = '12px'; wrap.textContent = '—';
      return;
    }
    wrap.style.opacity = ''; wrap.style.fontSize = '';
    mergedTagIds.forEach(tid => {
      const t = tags.find(t => t.id === tid);
      if (!t) return;
      const pill = document.createElement('span');
      pill.className = 'tag-pill'; applyPillStyle(pill, t.color);
      if (t.iconSvg) { const ico = document.createElement('span'); ico.className = 'tag-icon'; ico.innerHTML = t.iconSvg; pill.appendChild(ico); }
      const lbl = document.createElement('span'); lbl.textContent = t.label; pill.appendChild(lbl);
      if (modalMode === 'edit') {
        const rem = document.createElement('button');
        rem.className = 'edit-tag-remove'; rem.textContent = '×';
        rem.addEventListener('click', () => { mergedTagIds = mergedTagIds.filter(id => id !== tid); rebuildTags(); });
        pill.appendChild(rem);
      }
      wrap.appendChild(pill);
    });
    if (modalMode === 'edit') {
      const available = tags.filter(t => !mergedTagIds.includes(t.id));
      if (available.length > 0) {
        const dropWrap = document.createElement('div');
        dropWrap.className = 'tag-dropdown';
        const addBtn = document.createElement('button');
        addBtn.className = 'edit-tag-add'; addBtn.textContent = '+ Add tag';
        const menu = document.createElement('div'); menu.className = 'tag-dropdown-menu';
        available.forEach(t => {
          const item = document.createElement('div'); item.className = 'tag-dropdown-item';
          const dot = document.createElement('span'); dot.className = 'tag-dot'; dot.style.background = t.color;
          item.appendChild(dot); item.appendChild(document.createTextNode(t.label));
          item.addEventListener('click', () => { mergedTagIds = [...mergedTagIds, t.id]; menu.classList.remove('open'); rebuildTags(); });
          menu.appendChild(item);
        });
        addBtn.addEventListener('click', e => {
          e.stopPropagation();
          menu.classList.toggle('open');
          if (menu.classList.contains('open')) {
            document.addEventListener('click', () => menu.classList.remove('open'), { once: true });
          }
        });
        dropWrap.appendChild(addBtn); dropWrap.appendChild(menu);
        wrap.appendChild(dropWrap);
      }
    }
  }

  function applyEditMode(enabled) {
    if (!_titleEl) return;
    _titleEl.contentEditable = enabled ? 'true' : 'false';
    _rendered.contentEditable = enabled ? 'true' : 'false';
    if (!enabled) { if (_toolbar) _toolbar.classList.remove('visible'); if (document.activeElement === _rendered) _rendered.blur(); }
    rebuildTags();
  }

  // Tab switching — NO re-render, just toggle interactivity
  document.getElementById('tab-preview').addEventListener('click', () => {
    if (modalMode === 'preview') return;
    modalMode = 'preview';
    document.getElementById('tab-preview').classList.add('active');
    document.getElementById('tab-edit').classList.remove('active');
    applyEditMode(false);
  });
  document.getElementById('tab-edit').addEventListener('click', () => {
    if (modalMode === 'edit') return;
    modalMode = 'edit';
    document.getElementById('tab-edit').classList.add('active');
    document.getElementById('tab-preview').classList.remove('active');
    applyEditMode(true);
  });

  // ── Formatting toolbar ───────────────────────────────────────────────────
  function buildToolbar() {
    const bar = document.createElement('div');
    bar.className = 'mc-toolbar';
    function mkBtn(icon, title, action) {
      const b = document.createElement('button');
      b.className = 'mc-tb-btn'; b.title = title;
      b.innerHTML = icon; b.dataset.action = action;
      b.addEventListener('mousedown', e => {
        e.preventDefault();
        if (_rendered) _rendered.focus();
        execFormat(action);
        updateToolbarState(bar);
      });
      return b;
    }
    function sep() { const s = document.createElement('div'); s.className = 'mc-tb-sep'; return s; }
    bar.appendChild(mkBtn(toolbarIcons.bold,       'Bold',            'bold'));
    bar.appendChild(mkBtn(toolbarIcons.italic,     'Italic',          'italic'));
    bar.appendChild(mkBtn(toolbarIcons.underline,  'Underline',       'underline'));
    bar.appendChild(mkBtn(toolbarIcons.strike,     'Strikethrough',   'strikeThrough'));
    bar.appendChild(mkBtn(toolbarIcons.code,       'Inline code',     'code'));
    bar.appendChild(sep());
    bar.appendChild(mkBtn(toolbarIcons.h1,         'Heading 1',       'h1'));
    bar.appendChild(mkBtn(toolbarIcons.h2,         'Heading 2',       'h2'));
    bar.appendChild(mkBtn(toolbarIcons.h3,         'Heading 3',       'h3'));
    bar.appendChild(sep());
    bar.appendChild(mkBtn(toolbarIcons.list,       'Bullet list',     'bulletList'));
    bar.appendChild(mkBtn(toolbarIcons.listOrd,    'Ordered list',    'orderedList'));
    bar.appendChild(mkBtn(toolbarIcons.listChecks, 'Task list',       'taskList'));
    bar.appendChild(sep());
    bar.appendChild(mkBtn(toolbarIcons.code2,      'Code block',      'codeBlock'));
    bar.appendChild(mkBtn(toolbarIcons.quote,      'Blockquote',      'blockquote'));
    bar.appendChild(mkBtn(toolbarIcons.minus,      'Divider',         'hr'));
    bar.appendChild(sep());
    bar.appendChild(mkBtn(toolbarIcons.undo,       'Undo',            'undo'));
    bar.appendChild(mkBtn(toolbarIcons.redo,       'Redo',            'redo'));
    bar.appendChild(sep());
    bar.appendChild(mkBtn(toolbarIcons.eraser,     'Clear formatting','clearFormat'));
    return bar;
  }

  function execFormat(action) {
    switch (action) {
      case 'bold':         document.execCommand('bold');        break;
      case 'italic':       document.execCommand('italic');      break;
      case 'underline':    document.execCommand('underline');   break;
      case 'strikeThrough':document.execCommand('strikeThrough'); break;
      case 'code': {
        const sel = window.getSelection();
        if (sel && sel.rangeCount > 0 && !sel.isCollapsed) {
          const range = sel.getRangeAt(0);
          const code = document.createElement('code');
          code.textContent = range.toString();
          range.deleteContents();
          range.insertNode(code);
          sel.removeAllRanges();
          const r2 = document.createRange();
          r2.selectNodeContents(code); r2.collapse(false);
          sel.addRange(r2);
        }
        break;
      }
      case 'h1': document.execCommand('formatBlock', false, 'h1'); break;
      case 'h2': document.execCommand('formatBlock', false, 'h2'); break;
      case 'h3': document.execCommand('formatBlock', false, 'h3'); break;
      case 'bulletList':   document.execCommand('insertUnorderedList'); break;
      case 'orderedList':  document.execCommand('insertOrderedList');   break;
      case 'taskList': {
        const sel = window.getSelection();
        if (sel && sel.rangeCount) {
          const ul = document.createElement('ul');
          ul.className = 'task-list';
          const li = document.createElement('li');
          const cb = document.createElement('input'); cb.type = 'checkbox';
          const sp = document.createElement('span'); sp.textContent = '​';
          li.appendChild(cb); li.appendChild(sp); ul.appendChild(li);
          const range = sel.getRangeAt(0);
          range.deleteContents(); range.insertNode(ul);
          const r2 = document.createRange();
          r2.selectNodeContents(sp); r2.collapse(false);
          sel.removeAllRanges(); sel.addRange(r2);
        }
        break;
      }
      case 'blockquote':   document.execCommand('formatBlock', false, 'blockquote'); break;
      case 'hr':           document.execCommand('insertHorizontalRule'); break;
      case 'codeBlock':    document.execCommand('insertHTML', false, '<pre><code>​</code></pre><p><br></p>'); break;
      case 'undo':         document.execCommand('undo'); break;
      case 'redo':         document.execCommand('redo'); break;
      case 'clearFormat':  document.execCommand('removeFormat'); document.execCommand('formatBlock', false, 'p'); break;
    }
  }

  function updateToolbarState(bar) {
    let blockTag = '';
    try { blockTag = document.queryCommandValue('formatBlock').toLowerCase(); } catch {}
    const sel = window.getSelection();
    let inTaskList = false, inCheckedTask = false;
    if (sel && sel.rangeCount) {
      let node = sel.getRangeAt(0).startContainer;
      if (node.nodeType === 3) node = node.parentElement;
      const ul = node.closest && node.closest('ul');
      inTaskList = !!(ul && ul.classList.contains('task-list'));
      if (inTaskList) {
        const li = node.closest('li');
        inCheckedTask = !!(li && li.querySelector(':scope > input[type="checkbox"]:checked'));
      }
    }
    bar.querySelectorAll('.mc-tb-btn[data-action]').forEach(btn => {
      const a = btn.dataset.action;
      let active = false;
      try {
        if      (a === 'bold')         active = document.queryCommandState('bold');
        else if (a === 'italic')       active = document.queryCommandState('italic');
        else if (a === 'underline')    active = document.queryCommandState('underline');
        else if (a === 'strikeThrough')active = !inCheckedTask && document.queryCommandState('strikeThrough');
        else if (a === 'h1')           active = blockTag === 'h1';
        else if (a === 'h2')           active = blockTag === 'h2';
        else if (a === 'h3')           active = blockTag === 'h3';
        else if (a === 'blockquote')   active = blockTag === 'blockquote';
        else if (a === 'taskList')     active = inTaskList;
        else if (a === 'bulletList')   active = !inTaskList && document.queryCommandState('insertUnorderedList');
        else if (a === 'orderedList')  active = document.queryCommandState('insertOrderedList');
      } catch {}
      btn.classList.toggle('is-active', active);
    });
  }

  const closeModal = () => modal.classList.remove('open');
  document.getElementById('btn-merge-preview').addEventListener('click', openModal);
  document.getElementById('modal-cancel').addEventListener('click', closeModal);
  modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });
  document.getElementById('modal-confirm').addEventListener('click', () => {
    if (_rendered) mergedContent = htmlToMd(_rendered.innerHTML);
    vscode.postMessage({ type: 'resolve', side: 'both', mergedNote: { title: mergedTitle, tags: mergedTagIds, content: mergedContent } });
  });

// ── Resolution buttons ────────────────────────────────────────────────────
  document.getElementById('keep-ours').addEventListener('click',   () => vscode.postMessage({ type: 'resolve', side: 'ours' }));
  document.getElementById('keep-theirs').addEventListener('click', () => vscode.postMessage({ type: 'resolve', side: 'theirs' }));

  // ── Theme propagation from sidebar preview ────────────────────────────────
  window.addEventListener('message', ({ data }) => {
    if (data?.type !== 'setTheme') return;
    const root = document.documentElement;
    if (data.vars) {
      Object.entries(data.vars).forEach(([k, v]) => root.style.setProperty(k, v));
    } else {
      root.removeAttribute('style');
    }
  });

  // ── HTML → Markdown (reverses simpleMarkdown output for contenteditable save) ──
  function htmlToMd(html) {
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    return domToMd(tmp).replace(/\\n{3,}/g, '\\n\\n').trim();
  }
  function domToMd(node) {
    if (node.nodeType === 3) return node.textContent.replace(/\\n/g, ' ');
    if (node.nodeType !== 1) return '';
    const tag = node.tagName.toLowerCase();
    const kids = () => Array.from(node.childNodes).map(domToMd).join('');
    switch (tag) {
      case 'strong': case 'b': return '**' + kids() + '**';
      case 'em':     case 'i': return '*'  + kids() + '*';
      case 'del':              return '~~' + kids() + '~~';
      case 'u':                return '++' + kids() + '++';
      case 'code':   return node.closest('pre') ? kids() : '\`' + kids() + '\`';
      case 'pre':    return '\`\`\`\\n' + (node.querySelector('code')?.textContent ?? kids()) + '\\n\`\`\`\\n\\n';
      case 'br':     return '\\n';
      case 'hr':     return '\\n---\\n\\n';
      case 'h1':     return '# '   + kids() + '\\n\\n';
      case 'h2':     return '## '  + kids() + '\\n\\n';
      case 'h3':     return '### ' + kids() + '\\n\\n';
      case 'p':      return kids() + '\\n\\n';
      case 'blockquote': return kids().trim().split('\\n').map(l => '> ' + l).join('\\n') + '\\n\\n';
      case 'ul': {
        return Array.from(node.querySelectorAll(':scope > li')).map(li => {
          const cb = li.querySelector(':scope > input[type="checkbox"]');
          if (cb !== null) {
            const text = Array.from(li.childNodes).filter(n => n.nodeName !== 'INPUT').map(domToMd).join('').trim();
            return (cb.checked ? '- [x] ' : '- [ ] ') + text;
          }
          const t = domToMd(li).trim();
          if (t.startsWith('☑')) return '- [x] ' + t.slice(1).trim();
          if (t.startsWith('☐')) return '- [ ] ' + t.slice(1).trim();
          return '- ' + t;
        }).join('\\n') + '\\n\\n';
      }
      case 'ol':
        return Array.from(node.querySelectorAll(':scope > li')).map((li, i) =>
          (i + 1) + '. ' + domToMd(li).trim()
        ).join('\\n') + '\\n\\n';
      case 'li':  return kids();
      case 'div': return kids() + '\\n';
      default:    return kids();
    }
  }

  // ── Markdown renderer ─────────────────────────────────────────────────────
  function simpleMarkdown(md) {
    if (!md) return '';
    const e = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    const inline = raw => e(raw)
      .replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>')
      .replace(/\\*(.+?)\\*/g,        '<em>$1</em>')
      .replace(/\`(.+?)\`/g,          '<code>$1</code>')
      .replace(/~~(.+?)~~/g,          '<del>$1</del>')
      .replace(/\\+\\+(.+?)\\+\\+/g,  '<u>$1</u>');
    const lines = md.split('\\n');
    const out = []; let i = 0;
    while (i < lines.length) {
      if (lines[i].startsWith('\`\`\`')) {
        const code = []; i++;
        while (i < lines.length && !lines[i].startsWith('\`\`\`')) { code.push(e(lines[i])); i++; }
        if (i < lines.length) i++;
        out.push('<pre>' + code.join('\\n') + '</pre>');
      } else if (/^[-*]\\s/.test(lines[i])) {
        const items = [];
        let hasTask = false;
        while (i < lines.length && /^[-*]\\s/.test(lines[i])) {
          const tm = lines[i].match(/^[-*]\\s\\[([ x])\\]\\s(.*)/);
          const cm = !tm && lines[i].match(/^[-*]\\s([☐☑])\\s+(.*)/);
          if (tm) { hasTask = true; const chk = tm[1]==='x'; items.push('<li><input type="checkbox"' + (chk?' checked':'') + '><span>' + inline(tm[2]) + '</span></li>'); }
          else if (cm) { hasTask = true; const chk = cm[1]==='☑'; items.push('<li><input type="checkbox"' + (chk?' checked':'') + '><span>' + inline(cm[2]) + '</span></li>'); }
          else { items.push('<li>' + inline(lines[i].slice(2)) + '</li>'); }
          i++;
        }
        out.push((hasTask ? '<ul class="task-list">' : '<ul>') + items.join('') + '</ul>');
      } else if (/^\\d+\\.\\s/.test(lines[i])) {
        const items = [];
        while (i < lines.length && /^\\d+\\.\\s/.test(lines[i])) {
          items.push('<li>' + inline(lines[i].replace(/^\\d+\\.\\s/, '')) + '</li>'); i++;
        }
        out.push('<ol>' + items.join('') + '</ol>');
      } else if (/^> /.test(lines[i])) {
        const bq = [];
        while (i < lines.length && /^> /.test(lines[i])) { bq.push(inline(lines[i].slice(2))); i++; }
        out.push('<blockquote>' + bq.join('<br>') + '</blockquote>');
      } else if (/^(#{1,3})\\s/.test(lines[i])) {
        const lvl = lines[i].match(/^(#+)/)[1].length;
        out.push('<h' + lvl + '>' + inline(lines[i].replace(/^#+\\s/, '')) + '</h' + lvl + '>'); i++;
      } else if (lines[i].trim() === '---') {
        out.push('<hr>'); i++;
      } else {
        if (!lines[i].trim()) {
          let blanks = 0;
          while (i < lines.length && !lines[i].trim()) { blanks++; i++; }
          if (blanks > 1) out.push('<p><br></p>');
          continue;
        }
        out.push('<p>' + inline(lines[i]) + '</p>'); i++;
      }
    }
    return out.join('');
  }
})();
</script>
</body>
</html>`;
  }
}
