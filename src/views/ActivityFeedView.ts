import * as vscode from 'vscode';
import { NoteStorage, Note } from '../services/NoteStorage';
import { ACTIVITY_PALETTE, UI_COLORS } from '../utils/colors';
import { getNonce } from '../utils/webview';

// ─── Entry model ─────────────────────────────────────────────────────────────

const CLAUDE_OWNER = 'Claude Code';

interface ActivityEntry {
  noteId   : string;
  title    : string;
  owner    : string | null;
  isYou    : boolean;     // true when owner matches the detected git user
  isClaude : boolean;     // true when note was created/modified by the MCP server
  action   : 'created' | 'updated';
  timestamp: number;      // updatedAt Unix ms
}

// ─── Provider ────────────────────────────────────────────────────────────────

export class ActivityFeedView implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private currentUser: string | undefined;

  constructor(
    private readonly context    : vscode.ExtensionContext,
    private readonly storage    : NoteStorage,
    private readonly onOpenNote : (noteId: string) => void,
  ) {}

  setCurrentUser(user: string | undefined): void {
    this.currentUser = user;
    this.push();
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this.buildHtml();
    webviewView.webview.onDidReceiveMessage((msg: { type: string; noteId?: string }) => {
      if (msg.type === 'ready')    this.push();
      if (msg.type === 'refresh')  this.push();
      if (msg.type === 'openNote' && msg.noteId) this.onOpenNote(msg.noteId);
    });
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) this.push();
    });
  }

  setTheme(vars: Record<string, string> | null): void {
    if (!this.view) return;
    this.view.webview.postMessage({ type: 'setTheme', vars });
  }

  push(): void {
    const entries = this.generateEntries();
    vscode.commands.executeCommand('setContext', 'devnotes.hasActivity', entries.length > 0);
    if (!this.view?.visible) return;
    this.view.webview.postMessage({ type: 'init', entries, currentUser: this.currentUser ?? null });
  }

  // ── Entry generation ──────────────────────────────────────────────────────

  private generateEntries(): ActivityEntry[] {
    const notes = this.storage.getNotes();

    // Collect shared notes and Claude-authored notes, deduplicated by ID
    const seen = new Set<string>();
    const toEntry = (n: Note): ActivityEntry => ({
      noteId   : n.id,
      title    : n.title,
      owner    : n.owner ?? null,
      isYou    : !!n.owner && n.owner === this.currentUser,
      isClaude : n.owner === CLAUDE_OWNER,
      action   : (n.updatedAt - n.createdAt) < 10_000 ? 'created' : 'updated',
      timestamp: n.updatedAt,
    });

    const entries: ActivityEntry[] = [];
    for (const n of notes) {
      if (!n.shared && n.owner !== CLAUDE_OWNER) continue;
      if (seen.has(n.id)) continue;
      seen.add(n.id);
      entries.push(toEntry(n));
    }

    return entries
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, 40);
  }

  // ── HTML ──────────────────────────────────────────────────────────────────

  private buildHtml(): string {
    const nonce = getNonce();
    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    font-family: var(--vscode-font-family);
    font-size: 13px;
    background: var(--vscode-sideBar-background);
    color: var(--vscode-foreground);
    height: 100vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  /* ── Filter bar ── */
  .filter-bar {
    display: flex;
    gap: 4px;
    padding: 6px 10px;
    flex-shrink: 0;
    border-bottom: 1px solid var(--vscode-panel-border);
    flex-wrap: wrap;
  }
  .filter-btn {
    font-family: var(--vscode-font-family);
    font-size: 11px;
    font-weight: 500;
    padding: 2px 7px;
    border-radius: 20px;
    border: 1.5px solid currentColor;
    background: color-mix(in srgb, var(--vscode-foreground) 8%, transparent);
    color: var(--vscode-descriptionForeground);
    cursor: pointer;
    transition: opacity .12s;
    white-space: nowrap;
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
  .filter-btn:hover { opacity: .75; }
  .filter-btn.active {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border-color: transparent;
  }
  .filter-btn svg { flex-shrink: 0; }

  /* ── Feed list ── */
  .feed {
    flex: 1;
    overflow-y: auto;
    padding: 8px 0;
    scrollbar-width: none;
  }
  .feed::-webkit-scrollbar { display: none; }

  /* ── Entry ── */
  .entry {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 9px 12px;
    transition: background .1s;
    cursor: default;
  }
  .entry:hover { background: var(--vscode-list-hoverBackground); }

  .avatar {
    width: 28px; height: 28px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 10px;
    font-weight: 700;
    color: ${UI_COLORS.white};
    flex-shrink: 0;
    margin-top: 1px;
    letter-spacing: -.3px;
  }

  .entry-body { flex: 1; min-width: 0; }

  .entry-who {
    font-size: 11px;
    font-weight: 600;
    color: var(--vscode-foreground);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    display: flex;
    align-items: center;
    gap: 5px;
  }
  .you-badge {
    font-size: 9px;
    font-weight: 700;
    padding: 1px 5px;
    border-radius: 3px;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    flex-shrink: 0;
  }
  .ai-badge {
    font-size: 9px;
    font-weight: 700;
    padding: 1px 5px;
    border-radius: 3px;
    background: ${UI_COLORS.activityBg};
    color: ${UI_COLORS.white};
    flex-shrink: 0;
    letter-spacing: .02em;
  }
  .avatar-claude {
    background: ${UI_COLORS.activityBg} !important;
  }
  .action-label {
    font-size: 11px;
    font-weight: 400;
    color: var(--vscode-descriptionForeground);
    flex-shrink: 0;
  }

  .entry-title {
    font-size: 12px;
    color: var(--vscode-foreground);
    margin-top: 2px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    cursor: pointer;
    opacity: .9;
  }
  .entry-title:hover {
    opacity: 1;
    text-decoration: underline;
    color: var(--vscode-textLink-foreground);
  }

  .entry-time {
    font-size: 10px;
    color: var(--vscode-descriptionForeground);
    margin-top: 2px;
    opacity: .7;
  }

  /* ── Day group ── */
  .day-group { margin-bottom: 4px; }

  .day-divider {
    font-size: 12px;
    font-weight: 600;
    color: var(--vscode-foreground);
    padding: 10px 12px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: space-between;
    user-select: none;
  }
  .day-divider:hover { background: var(--vscode-list-hoverBackground); }
  .day-separator {
    height: 1px;
    background: var(--vscode-panel-border);
    margin: 4px 12px;
  }
  .day-chevron {
    display: flex;
    align-items: center;
    color: var(--vscode-descriptionForeground);
    flex-shrink: 0;
  }
  .day-group-entries {}
  .day-group.collapsed .day-group-entries { display: none; }

  /* ── Empty state ── */
  .empty {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    color: var(--vscode-descriptionForeground);
    text-align: center;
    padding: 24px;
  }
  .empty-icon { font-size: 2em; }
  .empty p { font-size: 12px; line-height: 1.55; }

  /* ── Footer ── */
  .feed-footer {
    font-size: 10px;
    text-align: center;
    padding: 8px;
    color: var(--vscode-descriptionForeground);
    opacity: .5;
    flex-shrink: 0;
    border-top: 1px solid var(--vscode-panel-border);
  }
</style>
</head>
<body>

<div class="filter-bar" id="filter-bar"></div>
<div class="feed" id="feed"></div>
<div class="feed-footer" id="feed-footer"></div>

<script nonce="${nonce}">
const ACTIVITY_PALETTE = ${JSON.stringify(ACTIVITY_PALETTE)};
(() => {
  const vscode   = acquireVsCodeApi();
  const feedEl   = document.getElementById('feed');
  const footerEl = document.getElementById('feed-footer');
  const filterBar = document.getElementById('filter-bar');

  let allEntries  = [];
  let currentUser = null;
  let activeFilter = 'all';
  // collapsed state persists by day label
  const collapsedDays = new Set();

  vscode.postMessage({ type: 'ready' });

  window.addEventListener('message', ({ data: msg }) => {
    if (msg.type === 'init') {
      allEntries  = msg.entries;
      currentUser = msg.currentUser;
      render();
    }
    if (msg.type === 'setTheme') {
      const root = document.documentElement;
      if (msg.vars) {
        Object.entries(msg.vars).forEach(([k, v]) => root.style.setProperty(k, v));
      } else {
        root.removeAttribute('style');
      }
    }
  });

  // ── Filter bar ──────────────────────────────────────────────────────────

  const FILTER_DEFS = [
    { filter: 'all',       label: 'All',       icon: null },
    { filter: 'you',       label: 'Me',        icon: iconUser() },
    { filter: 'claude',    label: 'Claude',    icon: iconClaude() },
    { filter: 'teammates', label: 'Teammates', icon: iconUsers() },
  ];

  FILTER_DEFS.forEach(({ filter, label, icon }) => {
    const btn = document.createElement('button');
    btn.className = 'filter-btn' + (filter === 'all' ? ' active' : '');
    btn.dataset.filter = filter;
    if (icon) btn.insertAdjacentHTML('beforeend', icon);
    btn.insertAdjacentText('beforeend', label);
    filterBar.appendChild(btn);
  });

  filterBar.addEventListener('click', e => {
    const btn = e.target.closest('.filter-btn');
    if (!btn) return;
    activeFilter = btn.dataset.filter;
    filterBar.querySelectorAll('.filter-btn').forEach(b => b.classList.toggle('active', b === btn));
    render();
  });

  function syncFilterButtons() {
    const hasYou       = allEntries.some(e => e.isYou);
    const hasClaude    = allEntries.some(e => e.isClaude);
    const hasTeammates = allEntries.some(e => !e.isYou && !e.isClaude);
    const activeCategories = [hasYou, hasClaude, hasTeammates].filter(Boolean).length;
    // Hide the entire bar when only one category has activity — filtering adds no value
    filterBar.style.display = activeCategories > 1 ? '' : 'none';
    if (activeCategories <= 1) return;
    filterBar.querySelector('[data-filter="you"]').style.display       = hasYou       ? '' : 'none';
    filterBar.querySelector('[data-filter="claude"]').style.display    = hasClaude    ? '' : 'none';
    filterBar.querySelector('[data-filter="teammates"]').style.display = hasTeammates ? '' : 'none';
    // If active filter is now hidden, reset to 'all'
    if ((!hasYou && activeFilter === 'you') || (!hasClaude && activeFilter === 'claude') || (!hasTeammates && activeFilter === 'teammates')) {
      activeFilter = 'all';
      filterBar.querySelectorAll('.filter-btn').forEach(b => b.classList.toggle('active', b.dataset.filter === 'all'));
    }
  }

  function applyFilter(entries) {
    if (activeFilter === 'all')       return entries;
    if (activeFilter === 'you')       return entries.filter(e => e.isYou);
    if (activeFilter === 'claude')    return entries.filter(e => e.isClaude);
    if (activeFilter === 'teammates') return entries.filter(e => !e.isYou && !e.isClaude);
    return entries;
  }

  // ── Render ──────────────────────────────────────────────────────────────

  function render() {
    syncFilterButtons();
    feedEl.innerHTML = '';
    const entries = applyFilter(allEntries);

    if (entries.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      const msg = activeFilter === 'all'
        ? 'No activity yet.<br>Share notes with teammates or ask Claude Code to create notes to see activity here.'
        : 'No activity for this filter.';
      empty.innerHTML = '<div class="empty-icon">📡</div><p>' + msg + '</p>';
      feedEl.appendChild(empty);
      footerEl.textContent = '';
      return;
    }

    // Group entries by day label
    const groups = [];
    let current = null;
    entries.forEach(entry => {
      const day = dayLabel(entry.timestamp);
      if (!current || current.day !== day) {
        current = { day, entries: [] };
        groups.push(current);
      }
      current.entries.push(entry);
    });

    groups.forEach(({ day, entries: dayEntries }, i) => {
      if (i > 0) {
        const sep = document.createElement('div');
        sep.className = 'day-separator';
        feedEl.appendChild(sep);
      }
      const isCollapsed = collapsedDays.has(day);
      const group = document.createElement('div');
      group.className = 'day-group' + (isCollapsed ? ' collapsed' : '');

      const divider = document.createElement('div');
      divider.className = 'day-divider';
      divider.innerHTML =
        '<span>' + day + '</span>' +
        '<span class="day-chevron">' + chevronIcon(!isCollapsed) + '</span>';
      divider.addEventListener('click', () => {
        const collapsed = group.classList.toggle('collapsed');
        if (collapsed) collapsedDays.add(day);
        else collapsedDays.delete(day);
        divider.querySelector('.day-chevron').innerHTML = chevronIcon(!collapsed);
      });
      group.appendChild(divider);

      const entriesEl = document.createElement('div');
      entriesEl.className = 'day-group-entries';
      dayEntries.forEach(entry => entriesEl.appendChild(buildEntry(entry)));
      group.appendChild(entriesEl);

      feedEl.appendChild(group);
    });

    const sharedCount = entries.filter(e => !e.isClaude).length;
    const claudeCount = entries.filter(e => e.isClaude).length;
    const parts = [];
    if (sharedCount > 0) parts.push(sharedCount + ' shared note' + (sharedCount !== 1 ? 's' : ''));
    if (claudeCount > 0) parts.push(claudeCount + ' from Claude');
    footerEl.textContent = parts.join(' · ');
  }

  // ── Live timestamp ticker ────────────────────────────────────────────────
  // Re-render timestamps every 60 s without a full re-render
  setInterval(() => {
    feedEl.querySelectorAll('[data-ts]').forEach(el => {
      el.textContent = timeAgo(Number(el.dataset.ts));
    });
  }, 60_000);

  // ── Entry builder ────────────────────────────────────────────────────────

  function buildEntry(entry) {
    const el = document.createElement('div');
    el.className = 'entry';

    // Avatar
    const avatar = document.createElement('div');
    avatar.className = entry.isClaude ? 'avatar avatar-claude' : 'avatar';
    if (!entry.isClaude) avatar.style.background = ownerColor(entry.isYou ? (currentUser || 'You') : (entry.owner || 'Unknown'));
    avatar.textContent = entry.isClaude ? 'CC' : initials(entry.isYou ? (currentUser || 'You') : (entry.owner || 'Unknown'));
    el.appendChild(avatar);

    // Body
    const body = document.createElement('div');
    body.className = 'entry-body';

    // Who + action
    const who = document.createElement('div');
    who.className = 'entry-who';

    const nameSpan = document.createElement('span');
    nameSpan.textContent = entry.isClaude ? 'Claude Code' : (entry.isYou ? 'You' : (entry.owner || 'Unknown'));
    who.appendChild(nameSpan);

    if (entry.isClaude) {
      const badge = document.createElement('span');
      badge.className = 'ai-badge';
      badge.textContent = 'AI';
      who.appendChild(badge);
    } else if (entry.isYou) {
      const badge = document.createElement('span');
      badge.className = 'you-badge';
      badge.textContent = 'you';
      who.appendChild(badge);
    }

    const actionSpan = document.createElement('span');
    actionSpan.className = 'action-label';
    actionSpan.textContent = entry.action === 'created' ? 'created' : 'updated';
    who.appendChild(actionSpan);
    body.appendChild(who);

    // Title
    const title = document.createElement('div');
    title.className = 'entry-title';
    title.textContent = entry.title;
    title.title = 'Open note';
    title.addEventListener('click', () => {
      vscode.postMessage({ type: 'openNote', noteId: entry.noteId });
    });
    body.appendChild(title);

    // Timestamp — data-ts enables live updates
    const time = document.createElement('div');
    time.className = 'entry-time';
    time.dataset.ts = String(entry.timestamp);
    time.textContent = timeAgo(entry.timestamp);
    body.appendChild(time);

    el.appendChild(body);
    return el;
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  function iconUser() {
    return '<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg>';
  }

  function iconUsers() {
    return '<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.5"/><path d="M2 20c0-3.5 3.1-6 7-6s7 2.5 7 6"/><circle cx="17" cy="9" r="3"/><path d="M22 20c0-3-2.6-5-5-5"/></svg>';
  }

  function iconClaude() {
    return '<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="currentColor" fill-rule="evenodd"><path d="M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z"/></svg>';
  }

  function chevronIcon(up) {
    const pts = up ? '18 15 12 9 6 15' : '6 9 12 15 18 9';
    return '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="' + pts + '"></polyline></svg>';
  }

  function ownerColor(name) {
    if (!name) return ACTIVITY_PALETTE[0];
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
    return ACTIVITY_PALETTE[h % ACTIVITY_PALETTE.length];
  }

  function initials(name) {
    if (typeof name !== 'string' || !name.trim()) return '?';
    const parts = name.trim().split(/\\s+/).filter(p => p.length > 0);
    if (parts.length === 0) return '?';
    if (parts.length === 1) return (parts[0][0] || '?').toUpperCase();
    return ((parts[0][0] || '') + (parts[parts.length - 1][0] || '')).toUpperCase() || '?';
  }

  function timeAgo(ts) {
    const diff = Date.now() - ts;
    const m = Math.floor(diff / 60000);
    if (m < 1)   return 'just now';
    if (m < 60)  return m + 'm ago';
    const h = Math.floor(m / 60);
    if (h < 24)  return h + 'h ago';
    const d = Math.floor(h / 24);
    if (d === 1) return 'yesterday';
    if (d < 7)   return d + 'd ago';
    return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  function dayLabel(ts) {
    const d   = new Date(ts);
    const now = new Date();
    if (d.toDateString() === now.toDateString()) return 'Today';
    const yest = new Date(now); yest.setDate(now.getDate() - 1);
    if (d.toDateString() === yest.toDateString()) return 'Yesterday';
    return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
  }
})();
</script>
</body>
</html>`;
  }
}

