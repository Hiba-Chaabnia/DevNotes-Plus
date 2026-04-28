import * as vscode from 'vscode';
import { NoteStorage, Note, Tag, GitHubLink, DEFAULT_TAGS } from '../services/NoteStorage';
import { UI_COLORS as C, GH_COLORS as GH, NOTE_COLORS as NC, PLATFORM_COLORS as PC, hexToRgb } from '../utils/colors';
import { svgIcon, getNonce } from '../utils/webview';
import { detectProjectIdentity } from '../services/GitDetector';
import { parsePRUrl, parseGitHubOwnerRepo, githubFetchPR, githubCreateIssue } from '../services/GitHubClient';
import { ALL_LUCIDE_NODES } from '../utils/icons';

function githubSvg(size = 14): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.477 2 2 6.477 2 12c0 4.418 2.865 8.166 6.839 9.489.5.092.682-.217.682-.482 0-.237-.009-.868-.013-1.703-2.782.604-3.369-1.34-3.369-1.34-.454-1.154-1.11-1.462-1.11-1.462-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.578 9.578 0 0 1 12 6.836a9.59 9.59 0 0 1 2.504.337c1.909-1.294 2.747-1.025 2.747-1.025.546 1.377.202 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.578.688.48C19.138 20.163 22 16.418 22 12c0-5.523-4.477-10-10-10z"/></svg>`;
}

// ─── Message types ────────────────────────────────────────────────────────────

type ToExt =
  | { type: 'ready' }
  | { type: 'createNote'; title: string; tags: string[]; templateId?: string; branch?: string; body?: string; codeLink?: { file: string; line: number } }
  | { type: 'requestCodeLink' }
  | { type: 'setBranchScope'; noteId: string; branch: string | null }
  | { type: 'branchFilterChanged'; active: boolean }
  | { type: 'setReminder'; noteId: string }
  | { type: 'exportNotes'; noteIds: string[] }
  | { type: 'openConflict'; noteId: string }
  | { type: 'updateNote'; id: string; changes: Partial<Note> }
  | { type: 'deleteNote'; id: string }
  | { type: 'openEditor'; noteId: string }
  | { type: 'addTag'; label: string; color: string; icon?: string }
  | { type: 'reorderTags'; ids: string[] }
  | { type: 'deleteTag'; id: string }
  | { type: 'updateTag'; id: string; changes: Partial<Pick<Tag, 'label' | 'color'>> & { icon?: string | null } }
  | { type: 'removeCustomColor'; color: string }
  | { type: 'hideDefaultColor'; color: string }
  | { type: 'hideDefaultIcon'; name: string }
  | { type: 'addSavedIcon'; name: string }
  | { type: 'removeSavedIcon'; name: string }
  | { type: 'searchLucideIcons'; query: string }
  | { type: 'jumpToLink'; file: string; line: number }
  | { type: 'linkToEditor'; noteId: string }
  | { type: 'removeCodeLink'; noteId: string }
  | { type: 'openGitHubLink'; url: string }
  | { type: 'openLink'; url: string }
  | { type: 'connectGitHub' }
  | { type: 'disconnectGitHub' }
  | { type: 'archiveNote'; id: string }
  | { type: 'unarchiveNote'; id: string }
  | { type: 'registerMcp' }
  | { type: 'createGitHubIssue'; noteId: string }
  | { type: 'linkGitHubPR';     noteId: string }
  | { type: 'bulkArchive';    noteIds: string[] }
  | { type: 'bulkDelete';     noteIds: string[] }
  | { type: 'bulkTag';        noteIds: string[] }
  | { type: 'duplicateNote';  noteId: string }
  | { type: 'linkNote'; noteId: string }
  | { type: 'unlinkNote'; noteId: string; targetId: string }
  | { type: 'openLinkedNote'; noteId: string }
  | { type: 'switchBranch' }
  | { type: 'openFolder' }
  | { type: 'pasteImage'; noteId: string; base64: string; ext: string }
  | { type: 'bannerDismiss' }

async function readGitHubToken(wsRoot: vscode.Uri): Promise<string | undefined> {
  try {
    const raw = await vscode.workspace.fs.readFile(
      vscode.Uri.joinPath(wsRoot, '.devnotes', '.github-token')
    );
    const token = Buffer.from(raw).toString('utf-8').trim();
    return token || undefined;
  } catch {
    return undefined;
  }
}

// ─── Provider ────────────────────────────────────────────────────────────────

export class SidebarView implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private projectName        = 'DevNotes';
  private currentBranch: string | undefined;
  private currentUser:   string | undefined;
  private availableBranches: string[] = [];
  private _branchFilterActive  = false;
  private _githubConnected     = false;
  private _mcpRegistered       = false;
  private _staleLinkCache = new Map<string, boolean>(); // key: `${noteId}:${file}`
  private _pushTimer: ReturnType<typeof setTimeout> | undefined;

  isBranchFilterActive(): boolean  { return this._branchFilterActive; }
  isGithubConnected(): boolean     { return this._githubConnected; }
  isMcpRegisteredState(): boolean  { return this._mcpRegistered; }

  /** Evict stale-link cache entries. Pass a noteId to evict only that note; omit to clear all. */
  invalidateStaleLinkCache(noteId?: string): void {
    if (noteId === undefined) {
      this._staleLinkCache.clear();
    } else {
      for (const key of this._staleLinkCache.keys()) {
        if (key.startsWith(`${noteId}:`)) this._staleLinkCache.delete(key);
      }
    }
  }

  setMcpRegistered(val: boolean): void {
    this._mcpRegistered = val;
    this.push();
  }

  async connectGitHub(): Promise<void> {
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!wsRoot) {
      vscode.window.showErrorMessage('DevNotes: open a workspace folder first.');
      return;
    }
    try {
      const session     = await vscode.authentication.getSession('github', ['repo'], { createIfNone: true });
      const devnotesUri = vscode.Uri.joinPath(wsRoot, '.devnotes');
      await vscode.workspace.fs.createDirectory(devnotesUri);
      // Ensure .gitignore with wildcard exists before writing the token so it
      // is never accidentally staged even if NoteStorage.init() hasn't run yet.
      const giUri = vscode.Uri.joinPath(devnotesUri, '.gitignore');
      try { await vscode.workspace.fs.stat(giUri); } catch {
        await vscode.workspace.fs.writeFile(giUri, Buffer.from('*\n'));
      }
      await vscode.workspace.fs.writeFile(
        vscode.Uri.joinPath(devnotesUri, '.github-token'),
        Buffer.from(session.accessToken)
      );
      this._githubConnected = true;
      this.push();
      vscode.window.showInformationMessage('GitHub account linked. Notes can now be connected to issues, PRs, and code reviews.');
    } catch {
      vscode.window.showErrorMessage('GitHub sign-in was cancelled or failed.');
    }
  }

  async disconnectGitHub(): Promise<void> {
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!wsRoot) return;
    const confirmed = await vscode.window.showWarningMessage(
      'Disconnect GitHub? Notes will no longer be linked to issues and PRs.',
      { modal: true },
      'Disconnect',
    );
    if (confirmed !== 'Disconnect') return;
    try {
      await vscode.workspace.fs.delete(vscode.Uri.joinPath(wsRoot, '.devnotes', '.github-token'));
    } catch { /* already gone */ }
    this._githubConnected = false;
    this.push();
  }

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly storage: NoteStorage,
    private readonly onOpenEditor: (noteId: string) => void,
    private readonly onNoteLinkChanged: () => void = () => {},
    private readonly onNoteUpdated: (noteId: string) => void = () => {},
  ) {}

  setProjectName(name: string): void {
    this.projectName = name;
    this.push();
  }

  setCurrentBranch(branch: string | undefined): void {
    this.currentBranch = branch;
    this.push();
  }

  setCurrentUser(user: string | undefined): void {
    this.currentUser = user;
    this.push();
  }

  setAvailableBranches(branches: string[]): void {
    this.availableBranches = branches;
    this.push();
  }

  async resolveWebviewView(webviewView: vscode.WebviewView): Promise<void> {
    this.view = webviewView;

    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri;

    // Sync GitHub token state once on view init; connectGitHub/disconnectGitHub keep it current after that
    if (wsRoot) {
      try {
        await vscode.workspace.fs.stat(vscode.Uri.joinPath(wsRoot, '.devnotes', '.github-token'));
        this._githubConnected = true;
      } catch {
        this._githubConnected = false;
      }
    }

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'media'),
        ...(wsRoot ? [vscode.Uri.joinPath(wsRoot, '.devnotes', 'assets')] : []),
      ],
    };

    webviewView.webview.html = this.buildHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((msg: ToExt) => this.handle(msg));

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) this.push();
    });
  }

  push(): void {
    clearTimeout(this._pushTimer);
    this._pushTimer = setTimeout(() => this._flush(), 16);
  }

  private async _flush(): Promise<void> {
    if (!this.view?.visible) return;
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri;

    const notes = await Promise.all(this.storage.getNotes().map(async n => {
      if (!n.codeLink || !wsRoot) return n;
      const cacheKey = `${n.id}:${n.codeLink.file}`;
      if (!this._staleLinkCache.has(cacheKey)) {
        try {
          await vscode.workspace.fs.stat(vscode.Uri.joinPath(wsRoot, n.codeLink.file));
          this._staleLinkCache.set(cacheKey, false);
        } catch {
          this._staleLinkCache.set(cacheKey, true);
        }
      }
      return this._staleLinkCache.get(cacheKey) ? { ...n, codeLinkStale: true } : n;
    }));

    const imageUriMap: Record<string, string> = {};
    if (wsRoot) {
      const imgRegex = /!\[[^\]]*\]\(\.devnotes\/assets\/([^)]+)\)/g;
      for (const note of notes) {
        for (const match of note.content.matchAll(imgRegex)) {
          const filename = match[1];
          const storagePath = `.devnotes/assets/${filename}`;
          if (!imageUriMap[storagePath]) {
            const assetUri = vscode.Uri.joinPath(wsRoot, '.devnotes', 'assets', filename);
            imageUriMap[storagePath] = this.view!.webview.asWebviewUri(assetUri).toString();
          }
        }
      }
    }

    this.view.webview.postMessage({
      type              : 'init',
      notes,
      imageUriMap,
      tags              : this.storage.getTags().map(t => ({
        ...t,
        iconSvg: t.icon && ALL_LUCIDE_NODES[t.icon] ? svgIcon(ALL_LUCIDE_NODES[t.icon], 11) : undefined,
      })),
      templates         : this.storage.getTemplates(),
      defaultTagIds     : DEFAULT_TAGS.map(t => t.id),
      customColors        : this.storage.getCustomColors(),
      hiddenDefaultColors : this.storage.getHiddenDefaultColors(),
      hiddenDefaultIcons  : this.storage.getHiddenDefaultIcons(),
      savedIconSvgs       : this.storage.getSavedIcons()
                            .filter(name => !!ALL_LUCIDE_NODES[name])
                            .map(name => ({ name, svg: svgIcon(ALL_LUCIDE_NODES[name], 15) })),
      projectName       : this.projectName,
      currentBranch     : this.currentBranch     ?? null,
      currentUser       : this.currentUser       ?? null,
      availableBranches : this.availableBranches,
      githubConnected   : this._githubConnected,
      mcpRegistered     : this._mcpRegistered,
      bannerDismissed   : this.context.globalState.get<boolean>('devnotes.bannerDismissed', false),
    });
  }

  // ── Message handler ──────────────────────────────────────────────────────

  private async handle(msg: ToExt): Promise<void> {
    switch (msg.type) {
      case 'ready':
        this.push();
        break;

      case 'createNote': {
        const tpl = msg.templateId
          ? this.storage.getTemplates().find(t => t.id === msg.templateId)
          : undefined;
        await this.storage.createNote({
          title   : msg.title,
          tags    : msg.tags,
          content : msg.body || tpl?.content,
          branch  : msg.branch,
          codeLink: msg.codeLink,
          owner   : this.currentUser,
        });
        this.push();
        break;
      }

      case 'setBranchScope':
        await this.storage.updateNote(msg.noteId, { branch: msg.branch ?? undefined });
        this.push();
        break;

      case 'branchFilterChanged':
        this._branchFilterActive = msg.active;
        break;

      case 'exportNotes':
        vscode.commands.executeCommand('devnotes.exportSelected', msg.noteIds);
        break;

      case 'openConflict':
        vscode.commands.executeCommand('devnotes.openConflict', msg.noteId);
        break;

      case 'setReminder': {
        const note = this.storage.getNote(msg.noteId);
        if (!note) break;

        const now  = new Date();
        const make = (offsetDays: number, hour = 9): Date => {
          const d = new Date(now);
          d.setDate(d.getDate() + offsetDays);
          d.setHours(hour, 0, 0, 0);
          return d;
        };
        const fmt = (d: Date) => d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

        type RItem = vscode.QuickPickItem & { ts: number | null | undefined };
        const items: RItem[] = [];

        if (note.remindAt) {
          items.push({ label: '$(bell-slash) Remove reminder', description: 'Clear the current reminder', ts: null });
          items.push({ kind: vscode.QuickPickItemKind.Separator, label: '', ts: undefined });
        }
        items.push(
          { label: '$(bell) Tomorrow morning',  description: fmt(make(1)),  ts: make(1).getTime()  },
          { label: '$(bell) In 2 days',         description: fmt(make(2)),  ts: make(2).getTime()  },
          { label: '$(bell) Next week',         description: fmt(make(7)),  ts: make(7).getTime()  },
          { label: '$(bell) Next month',        description: fmt(make(30)), ts: make(30).getTime() },
          { label: '$(calendar) Custom date…',  description: 'Enter a specific date', ts: undefined },
        );

        const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Set a reminder for this note' });
        if (!picked) break;

        let remindAt: number | undefined;

        if (picked.ts === null) {
          remindAt = undefined; // remove
        } else if (picked.ts === undefined) {
          // Custom date input
          const input = await vscode.window.showInputBox({
            prompt      : 'Reminder date',
            placeHolder : new Date().toISOString().slice(0, 10),
            validateInput: v => {
              const d = new Date(v);
              return isNaN(d.getTime()) ? 'Use YYYY-MM-DD format' : undefined;
            },
          });
          if (!input) break;
          const d = new Date(input);
          d.setHours(9, 0, 0, 0);
          remindAt = d.getTime();
        } else {
          remindAt = picked.ts;
        }

        await this.storage.updateNote(msg.noteId, { remindAt });
        this.push();
        break;
      }

      case 'updateNote': {
        const prevShared = this.storage.getNote(msg.id)?.shared;
        if ('codeLink' in msg.changes) this.invalidateStaleLinkCache(msg.id);
        await this.storage.updateNote(msg.id, msg.changes);
        this.push();
        this.onNoteUpdated(msg.id);

        if ('shared' in msg.changes) {
          const note = this.storage.getNote(msg.id);
          if (!note) break;
          if (msg.changes.shared && !prevShared) {
            // Determine whether custom tags exist so we know to include tags.json
            const defaultIds = new Set(DEFAULT_TAGS.map(t => t.id));
            const hasCustomTags = this.storage.getTags().some(t => !defaultIds.has(t.id));
            const tagsCmdPart = hasCustomTags ? ' .devnotes/tags.json' : '';
            const action = await vscode.window.showInformationMessage(
              `"${note.title}" is now shared. Commit it to git to make it visible to teammates.`,
              'Copy git commands'
            );
            if (action === 'Copy git commands') {
              await vscode.env.clipboard.writeText(
                `git add .devnotes/.gitignore${tagsCmdPart} ".devnotes/${note.id}.md"\ngit commit -m "share: ${note.title}"`
              );
            }
          } else if (!msg.changes.shared && prevShared) {
            const action = await vscode.window.showInformationMessage(
              `"${note.title}" unshared. Remove it from git tracking and push to update teammates.`,
              'Copy git commands'
            );
            if (action === 'Copy git commands') {
              await vscode.env.clipboard.writeText(
                `git rm --cached ".devnotes/${note.id}.md"\ngit add .devnotes/.gitignore\ngit commit -m "unshare: ${note.title}"`
              );
            }
          }
        }
        break;
      }

      case 'deleteNote': {
        const note = this.storage.getNote(msg.id);
        if (!note) break;
        const ans = await vscode.window.showWarningMessage(
          `Delete "${note.title}"?`, { modal: true }, 'Delete'
        );
        if (ans === 'Delete') {
          await this.storage.deleteNote(msg.id);
          this.push();
        }
        break;
      }

      case 'openEditor':
        this.onOpenEditor(msg.noteId);
        break;

      case 'addTag': {
        await this.storage.addTag(msg.label, msg.color, msg.icon);
        this.push();
        break;
      }

      case 'reorderTags': {
        await this.storage.reorderTags(msg.ids);
        this.push();
        break;
      }

      case 'deleteTag': {
        await this.storage.deleteTag(msg.id);
        this.push();
        break;
      }

      case 'updateTag': {
        await this.storage.updateTag(msg.id, msg.changes);
        this.push();
        break;
      }

      case 'removeCustomColor': {
        await this.storage.removeCustomColor(msg.color);
        this.push();
        break;
      }

      case 'hideDefaultColor': {
        await this.storage.hideDefaultColor(msg.color);
        this.push();
        break;
      }

      case 'hideDefaultIcon': {
        await this.storage.hideDefaultIcon(msg.name);
        this.push();
        break;
      }

      case 'addSavedIcon': {
        await this.storage.addSavedIcon(msg.name);
        this.push();
        break;
      }

      case 'removeSavedIcon': {
        await this.storage.removeSavedIcon(msg.name);
        this.push();
        break;
      }

      case 'searchLucideIcons': {
        const q = msg.query.toLowerCase().trim();
        const icons = q
          ? Object.keys(ALL_LUCIDE_NODES)
              .filter(n => n.toLowerCase().includes(q))
              .slice(0, 30)
              .map(name => ({ name, svg: svgIcon(ALL_LUCIDE_NODES[name], 15) }))
          : [];
        this.view?.webview.postMessage({ type: 'lucideSearchResults', icons });
        break;
      }

      case 'jumpToLink':
        vscode.commands.executeCommand('devnotes.jumpToLink', msg.file, msg.line);
        break;

      case 'linkToEditor': {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
          vscode.window.showInformationMessage('DevNotes: open a file and place your cursor on the line you want to link.');
          break;
        }
        const filePath = vscode.workspace.asRelativePath(editor.document.uri, false);
        if (filePath === editor.document.uri.fsPath) {
          vscode.window.showWarningMessage('DevNotes: file is outside the current workspace.');
          break;
        }
        const line = editor.selection.active.line + 1;
        this.invalidateStaleLinkCache(msg.noteId);
        await this.storage.updateNote(msg.noteId, { codeLink: { file: filePath, line } });
        this.push();
        this.onNoteLinkChanged();
        break;
      }

      case 'removeCodeLink':
        this.invalidateStaleLinkCache(msg.noteId);
        await this.storage.updateNote(msg.noteId, { codeLink: undefined });
        this.push();
        this.onNoteLinkChanged();
        break;

      case 'requestCodeLink': {
        const editor = vscode.window.activeTextEditor;
        if (!editor) { this.view?.webview.postMessage({ type: 'setCodeLink', file: null }); break; }
        const filePath = vscode.workspace.asRelativePath(editor.document.uri, false);
        if (filePath === editor.document.uri.fsPath) { this.view?.webview.postMessage({ type: 'setCodeLink', file: null }); break; }
        const line = editor.selection.active.line + 1;
        this.view?.webview.postMessage({ type: 'setCodeLink', file: filePath, line });
        break;
      }

      case 'archiveNote': {
        await this.storage.updateNote(msg.id, { archived: true, starred: false });
        this.push();
        break;
      }

      case 'unarchiveNote': {
        await this.storage.updateNote(msg.id, { archived: undefined });
        this.push();
        break;
      }

      case 'duplicateNote': {
        const src = this.storage.getNote(msg.noteId);
        if (!src) break;
        await this.storage.createNote({
          title  : `Copy of ${src.title}`,
          content: src.content,
          tags   : [...src.tags],
          branch : src.branch,
          owner  : this.currentUser,
        });
        this.push();
        break;
      }

      case 'openGitHubLink':
      case 'openLink':
        vscode.env.openExternal(vscode.Uri.parse(msg.url));
        break;

      case 'connectGitHub':
        await this.connectGitHub();
        break;

      case 'disconnectGitHub':
        await this.disconnectGitHub();
        break;

      case 'bulkArchive': {
        await Promise.all(msg.noteIds.map(id => this.storage.updateNote(id, { archived: true, starred: false })));
        this.push();
        break;
      }

      case 'bulkDelete': {
        const n = msg.noteIds.length;
        const ans = await vscode.window.showWarningMessage(
          `Delete ${n} note${n !== 1 ? 's' : ''}? This cannot be undone.`,
          { modal: true },
          'Delete'
        );
        if (ans !== 'Delete') break;
        await Promise.all(msg.noteIds.map(id => this.storage.deleteNote(id)));
        this.push();
        break;
      }

      case 'bulkTag': {
        if (this.storage.getTags().length === 0) {
          vscode.window.showInformationMessage('No tags exist yet — create a tag first.');
          break;
        }
        type TItem = vscode.QuickPickItem & { id: string };
        const items: TItem[] = this.storage.getTags().map(t => ({
          id   : t.id,
          label: t.label,
        }));
        const picked = await vscode.window.showQuickPick(items, {
          placeHolder: 'Choose a tag to add to all selected notes…',
        });
        if (!picked) break;
        for (const id of msg.noteIds) {
          const note = this.storage.getNote(id);
          if (!note) continue;
          if (!note.tags.includes(picked.id)) {
            await this.storage.updateNote(id, { tags: [...note.tags, picked.id] });
          }
        }
        this.push();
        break;
      }

      case 'createGitHubIssue': {
        const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
        if (!wsRoot) break;

        const note = this.storage.getNote(msg.noteId);
        if (!note) break;

        const token = await readGitHubToken(wsRoot);
        if (!token) {
          vscode.window.showErrorMessage('DevNotes: connect to GitHub first (click the Octocat button in the sidebar).');
          break;
        }

        // Detect owner/repo from git remote
        const identity = detectProjectIdentity();
        let ownerRepo = identity?.remoteUrl ? parseGitHubOwnerRepo(identity.remoteUrl) : undefined;

        if (!ownerRepo) {
          const input = await vscode.window.showInputBox({
            prompt      : 'GitHub repository (owner/repo)',
            placeHolder : 'e.g. microsoft/vscode',
            validateInput: v => v.includes('/') ? undefined : 'Use owner/repo format',
          });
          if (!input) break;
          const [owner, repo] = input.trim().split('/');
          ownerRepo = { owner, repo };
        }

        const title = await vscode.window.showInputBox({
          prompt: `Create issue in ${ownerRepo.owner}/${ownerRepo.repo}`,
          value : note.title,
        });
        if (!title) break;

        try {
          const issue = await githubCreateIssue(token, ownerRepo.owner, ownerRepo.repo, title, note.content);
          const github: GitHubLink = {
            url   : issue.html_url,
            repo  : `${ownerRepo.owner}/${ownerRepo.repo}`,
            number: issue.number,
            type  : 'issue',
            status: 'open',
            title : issue.title,
          };
          await this.storage.updateNote(msg.noteId, { github });
          this.push();
          const action = await vscode.window.showInformationMessage(
            `Issue #${issue.number} created: "${issue.title}"`,
            'Open in Browser'
          );
          if (action === 'Open in Browser') {
            vscode.env.openExternal(vscode.Uri.parse(issue.html_url));
          }
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          vscode.window.showErrorMessage(`DevNotes: failed to create issue — ${errMsg}`);
        }
        break;
      }

      case 'linkGitHubPR': {
        const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
        if (!wsRoot) break;

        const note = this.storage.getNote(msg.noteId);
        if (!note) break;

        const token = await readGitHubToken(wsRoot);
        if (!token) {
          vscode.window.showErrorMessage('DevNotes: connect to GitHub first (Integrations in the overflow menu).');
          break;
        }

        const input = await vscode.window.showInputBox({
          prompt      : 'Paste GitHub PR URL',
          placeHolder : 'https://github.com/owner/repo/pull/123',
          validateInput: v => parsePRUrl(v) ? undefined : 'Must be a valid GitHub PR URL',
        });
        if (!input) break;

        const pr = parsePRUrl(input)!;
        let prTitle: string | undefined;
        try {
          const data = await githubFetchPR(token, pr.owner, pr.repo, pr.number);
          prTitle = data.title;
        } catch { /* non-fatal — link without title */ }

        const github: GitHubLink = {
          url   : `https://github.com/${pr.owner}/${pr.repo}/pull/${pr.number}`,
          repo  : `${pr.owner}/${pr.repo}`,
          number: pr.number,
          type  : 'pr',
          status: 'open',
          title : prTitle,
        };
        await this.storage.updateNote(msg.noteId, { github });
        this.push();
        const action = await vscode.window.showInformationMessage(
          `PR #${pr.number} linked${prTitle ? `: "${prTitle}"` : ''}.`,
          'Open in Browser'
        );
        if (action === 'Open in Browser') {
          vscode.env.openExternal(vscode.Uri.parse(github.url));
        }
        break;
      }

      case 'linkNote': {
        const note = this.storage.getNote(msg.noteId);
        if (!note) break;
        const candidates = this.storage.getNotes()
          .filter(n => n.id !== msg.noteId && !n.archived && !note.linkedNoteIds?.includes(n.id));
        if (candidates.length === 0) {
          vscode.window.showInformationMessage('No other notes available to link.');
          break;
        }
        type NItem = vscode.QuickPickItem & { id: string };
        const items: NItem[] = candidates.map(n => ({
          id         : n.id,
          label      : n.title,
          description: n.tags.length ? n.tags.join(', ') : undefined,
        }));
        const picked = await vscode.window.showQuickPick(items, {
          placeHolder      : 'Select a note to link to…',
          matchOnDescription: true,
        });
        if (!picked) break;
        // Forward link: A → B
        const existing = note.linkedNoteIds ?? [];
        await this.storage.updateNote(msg.noteId, { linkedNoteIds: [...existing, picked.id] });
        // Back-link: B → A
        const target = this.storage.getNote(picked.id);
        if (target && !target.linkedNoteIds?.includes(msg.noteId)) {
          const targetExisting = target.linkedNoteIds ?? [];
          await this.storage.updateNote(picked.id, { linkedNoteIds: [...targetExisting, msg.noteId] });
        }
        this.push();
        break;
      }

      case 'unlinkNote': {
        const note = this.storage.getNote(msg.noteId);
        if (!note) break;
        // Remove forward link: A → B
        const updated = (note.linkedNoteIds ?? []).filter(id => id !== msg.targetId);
        await this.storage.updateNote(msg.noteId, { linkedNoteIds: updated.length ? updated : undefined });
        // Remove back-link: B → A
        const target = this.storage.getNote(msg.targetId);
        if (target) {
          const targetUpdated = (target.linkedNoteIds ?? []).filter(id => id !== msg.noteId);
          await this.storage.updateNote(msg.targetId, { linkedNoteIds: targetUpdated.length ? targetUpdated : undefined });
        }
        this.push();
        break;
      }

      case 'openLinkedNote':
        this.onOpenEditor(msg.noteId);
        break;

      case 'switchBranch':
        vscode.commands.executeCommand('git.checkout');
        break;

      case 'openFolder':
        vscode.commands.executeCommand('workbench.action.files.openFolder');
        break;

      case 'registerMcp':
        vscode.commands.executeCommand('devnotes.registerMcp');
        break;

      case 'bannerDismiss':
        this.context.globalState.update('devnotes.bannerDismissed', true);
        break;

      case 'pasteImage': {
        const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
        if (!wsRoot) break;
        const ext      = msg.ext.replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'png';
        const filename = `${msg.noteId}-${Date.now()}.${ext}`;
        const assetUri = vscode.Uri.joinPath(wsRoot, '.devnotes', 'assets', filename);
        try {
          await vscode.workspace.fs.createDirectory(
            vscode.Uri.joinPath(wsRoot, '.devnotes', 'assets')
          );
        } catch { /* already exists */ }
        await vscode.workspace.fs.writeFile(assetUri, Buffer.from(msg.base64, 'base64'));
        const storagePath = `.devnotes/assets/${filename}`;
        const webviewUri  = this.view!.webview.asWebviewUri(assetUri).toString();
        this.view!.webview.postMessage({ type: 'imageReady', noteId: msg.noteId, src: webviewUri, storagePath });
        break;
      }

    }
  }

  // ── HTML ─────────────────────────────────────────────────────────────────

  private buildHtml(webview: vscode.Webview): string {
    const nonce             = getNonce();
    const colorsJson        = JSON.stringify(NC);
    const defaultTagIconsJson = JSON.stringify(
      ['Lightbulb', 'ListTodo', 'Bug', 'Presentation', 'BookMarked']
        .filter(n => !!ALL_LUCIDE_NODES[n])
        .map(name => ({ name, svg: svgIcon(ALL_LUCIDE_NODES[name], 15) }))
    );
    const sidebarEditorUri  = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'sidebar-editor.js')
    );
    const gifUri = (name: string) =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', name)).toString();
    const emptyGifs = {
      notes   : gifUri('empty-notes.gif'),
      archived: gifUri('empty-archived.gif'),
      stale   : gifUri('empty-stale.gif'),
      search  : gifUri('empty-search.gif'),
    };

    // SVG strings injected into the webview script (browser side can't import lucide)
    const jsSvg = {
      edit:        JSON.stringify(svgIcon(ALL_LUCIDE_NODES['SquarePen'],            14)),
      remind:      JSON.stringify(svgIcon(ALL_LUCIDE_NODES['Bell'],                 14)),
      dup:         JSON.stringify(svgIcon(ALL_LUCIDE_NODES['Copy'],                 14)),
      link:        JSON.stringify(svgIcon(ALL_LUCIDE_NODES['Link2'],                14)),
      unlink:      JSON.stringify(svgIcon(ALL_LUCIDE_NODES['Unlink2'],              14)),
      archive:     JSON.stringify(svgIcon(ALL_LUCIDE_NODES['Archive'],              14)),
      share:       JSON.stringify(svgIcon(ALL_LUCIDE_NODES['Share2'],               14)),
      export:      JSON.stringify(svgIcon(ALL_LUCIDE_NODES['SquareArrowOutUpRight'],14)),
      trash:       JSON.stringify(svgIcon(ALL_LUCIDE_NODES['Trash2'],               14)),
      overflow:    JSON.stringify(svgIcon(ALL_LUCIDE_NODES['Ellipsis'],             14)),
      star:        JSON.stringify(svgIcon(ALL_LUCIDE_NODES['Star'],                 14)),
      starFilled:  JSON.stringify(svgIcon(ALL_LUCIDE_NODES['Star'],                 14, '', 'currentColor')),
      unlinkSmall: JSON.stringify(svgIcon(ALL_LUCIDE_NODES['X'],                    10)),
      folderGit:   JSON.stringify(svgIcon(ALL_LUCIDE_NODES['FolderGit'],            13, 'flex-shrink:0')),
      folderOpen:  JSON.stringify(svgIcon(ALL_LUCIDE_NODES['FolderOpen'],           13, 'flex-shrink:0')),
      branch:      JSON.stringify(svgIcon(ALL_LUCIDE_NODES['GitBranch'],            11, 'flex-shrink:0')),
      branchSwitch: JSON.stringify(svgIcon(ALL_LUCIDE_NODES['ArrowLeftRight'],      11, 'flex-shrink:0')),
      sortUpdated:   JSON.stringify(svgIcon(ALL_LUCIDE_NODES['ClockArrowDown'],     13)),
      sortStarred:   JSON.stringify(svgIcon(ALL_LUCIDE_NODES['Star'],               13, '', 'currentColor')),
      sortAlpha:     JSON.stringify(svgIcon(ALL_LUCIDE_NODES['ArrowDownAZ'],        13)),
      noteLinkIcon:  JSON.stringify(svgIcon(ALL_LUCIDE_NODES['Files'],              11)),
      codeLinkIcon:  JSON.stringify(svgIcon(ALL_LUCIDE_NODES['FileSymlink'],        11)),
      codeLinkMenu:  JSON.stringify(svgIcon(ALL_LUCIDE_NODES['FileSymlink'],        14)),
      conflictIcon:  JSON.stringify(svgIcon(ALL_LUCIDE_NODES['TriangleAlert'],      11)),
      archiveIcon:   JSON.stringify(svgIcon(ALL_LUCIDE_NODES['Archive'],            11)),
      shareSmall:    JSON.stringify(svgIcon(ALL_LUCIDE_NODES['Share2'],             11)),
      bellSmall:     JSON.stringify(svgIcon(ALL_LUCIDE_NODES['Bell'],               11)),
      branchSmall:   JSON.stringify(svgIcon(ALL_LUCIDE_NODES['GitBranch'],          11)),
      branchMenu:    JSON.stringify(svgIcon(ALL_LUCIDE_NODES['GitBranch'],          14)),
      noteLink:      JSON.stringify(svgIcon(ALL_LUCIDE_NODES['Files'],              14)),
      tagSmall:      JSON.stringify(svgIcon(ALL_LUCIDE_NODES['Tag'],                11)),
      tplSmall:      JSON.stringify(svgIcon(ALL_LUCIDE_NODES['LayoutList'],         11)),
      ghPrOpen:      JSON.stringify(svgIcon(ALL_LUCIDE_NODES['GitPullRequest'],     11)),
      ghPrClosed:    JSON.stringify(svgIcon(ALL_LUCIDE_NODES['GitPullRequestClosed'],11)),
      ghPrMerged:    JSON.stringify(svgIcon(ALL_LUCIDE_NODES['GitMerge'],           11)),
      ghIssueOpen:   JSON.stringify(svgIcon(ALL_LUCIDE_NODES['CircleDot'],          11)),
      ghIssueClosed: JSON.stringify(svgIcon(ALL_LUCIDE_NODES['CircleCheck'],        11)),
      fmtBold:       JSON.stringify(svgIcon(ALL_LUCIDE_NODES['Bold'],               13)),
      fmtItalic:     JSON.stringify(svgIcon(ALL_LUCIDE_NODES['Italic'],             13)),
      fmtUnderline:  JSON.stringify(svgIcon(ALL_LUCIDE_NODES['Underline'],          13)),
      fmtStrike:     JSON.stringify(svgIcon(ALL_LUCIDE_NODES['Strikethrough'],      13)),
      fmtList:       JSON.stringify(svgIcon(ALL_LUCIDE_NODES['List'],               13)),
      fmtListNum:    JSON.stringify(svgIcon(ALL_LUCIDE_NODES['ListOrdered'],        13)),
      fmtChecklist:  JSON.stringify(svgIcon(ALL_LUCIDE_NODES['ListChecks'],         13)),
      fmtCode:       JSON.stringify(svgIcon(ALL_LUCIDE_NODES['Code'],               13)),
      fmtCodeInline: JSON.stringify(svgIcon(ALL_LUCIDE_NODES['Code2'],              13)),
      fmtIndent:     JSON.stringify(svgIcon(ALL_LUCIDE_NODES['Indent'],             13)),
      fmtOutdent:    JSON.stringify(svgIcon(ALL_LUCIDE_NODES['Outdent'],            13)),
      fmtClear:      JSON.stringify(svgIcon(ALL_LUCIDE_NODES['RemoveFormatting'],   13)),
      fmtDone:       JSON.stringify(svgIcon(ALL_LUCIDE_NODES['Check'],              13)),
      chevronDown:   JSON.stringify(svgIcon(ALL_LUCIDE_NODES['ChevronDown'],        12)),
      chevronUp:     JSON.stringify(svgIcon(ALL_LUCIDE_NODES['ChevronUp'],          12)),
      popRename:     JSON.stringify(svgIcon(ALL_LUCIDE_NODES['PenLine'],            10)),
      popIcon:       JSON.stringify(svgIcon(ALL_LUCIDE_NODES['Shapes'],             10)),
      popColor:      JSON.stringify(svgIcon(ALL_LUCIDE_NODES['Palette'],            10)),
      popDelete:     JSON.stringify(svgIcon(ALL_LUCIDE_NODES['Trash2'],             14)),
      popNone:       JSON.stringify(svgIcon(ALL_LUCIDE_NODES['Ban'],                13)),
      newTag:        JSON.stringify(svgIcon(ALL_LUCIDE_NODES['Tag'],                13)),
      ghIssue:       JSON.stringify(svgIcon(ALL_LUCIDE_NODES['CircleDot'],          14)),
      ghPr:          JSON.stringify(svgIcon(ALL_LUCIDE_NODES['GitPullRequest'],     14)),
    };

    const checkmarkUri = 'data:image/svg+xml,' + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>'
    );

    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src 'unsafe-inline'; img-src ${webview.cspSource} data:; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --radius: 10px;
    --gap: 10px;
    --card-text: var(--vscode-foreground);
  }

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

  /* ── Top bar ─────────────────────────────────────────── */
  .topbar {
    padding: 8px 10px 6px;
    border-bottom: 1px solid var(--vscode-panel-border);
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .topbar-row {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .project-pill {
    font-size: 11px;
    font-weight: 600;
    padding: 2px 8px 2px 6px;
    border-radius: 10px;
    border: 1px solid transparent;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    min-width: 0;
    flex-shrink: 1;
    display: flex;
    align-items: center;
    cursor: pointer;
    position: relative;
    overflow: hidden;
    height: 20px;
  }
  .project-pill:hover {
    border-color: currentColor;
    background: var(--vscode-button-secondaryBackground, rgba(255,255,255,.12));
    color: var(--vscode-button-secondaryForeground, var(--vscode-badge-foreground));
  }
  .project-pill:hover .pill-primary { opacity: 0; transform: translateY(-5px); }
  .project-pill:hover .pill-action  { opacity: 1; transform: translateY(0); }

  .pill-primary {
    display: flex;
    align-items: center;
    gap: 4px;
    overflow: hidden;
    min-width: 0;
    transition: opacity .15s, transform .15s;
  }
  .pill-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .pill-action {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    overflow: hidden;
    opacity: 0;
    transform: translateY(5px);
    transition: opacity .15s, transform .15s;
    font-style: italic;
  }
  .pill-action-inner {
    display: flex;
    align-items: center;
    white-space: nowrap;
    flex-shrink: 0;
  }
  .pill-copy { display: flex; align-items: center; gap: 4px; padding-left: 6px; }
  .pill-sep { opacity: .35; padding: 0 5px; }
  .project-pill:hover .pill-action-inner,
  .branch-pill.can-switch:hover .pill-action-inner {
    animation: pill-marquee 2.5s linear .15s infinite;
  }
  @keyframes pill-marquee {
    from { transform: translateX(0); }
    to   { transform: translateX(-33.333%); }
  }

  .new-note-pill {
    display: flex;
    align-items: center;
    gap: 3px;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none;
    border-radius: 10px;
    padding: 2px 9px 2px 6px;
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
    flex-shrink: 0;
    line-height: 1.4;
  }
  .new-note-pill:hover { background: var(--vscode-button-hoverBackground); }

  .icon-btn {
    background: none;
    border: none;
    color: var(--vscode-foreground);
    cursor: pointer;
    padding: 3px;
    border-radius: 4px;
    display: flex;
    align-items: center;
    justify-content: center;
    opacity: .7;
    flex-shrink: 0;
  }
  .icon-btn:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }

  .search-row {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 6px;
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 6px;
    padding: 4px 8px;
  }
  .search-row input {
    flex: 1;
    min-width: 0;
    border: none;
    background: transparent;
    color: var(--vscode-input-foreground);
    outline: none;
    font-size: 12px;
  }
  .search-row input::placeholder { color: var(--vscode-input-placeholderForeground); }

  .search-clear {
    background: none;
    border: none;
    color: var(--vscode-descriptionForeground);
    cursor: pointer;
    padding: 0 2px;
    display: flex;
    align-items: center;
    opacity: .7;
    flex-shrink: 0;
  }
  .search-clear:hover { opacity: 1; }

  mark.match-highlight {
    background: var(--vscode-editor-findMatchHighlightBackground, rgba(255,200,0,.4));
    color: inherit;
    border-radius: 2px;
    padding: 0 1px;
  }

  /* ── Overflow menu (⋯) ──────────────────────────────── */
  .overflow-menu {
    position: fixed;
    z-index: 500;
    background: var(--vscode-editorWidget-background, var(--vscode-sideBar-background));
    border: 1px solid var(--vscode-panel-border);
    border-radius: 8px;
    box-shadow: 0 4px 20px rgba(0,0,0,.28);
    padding: 4px;
    min-width: 176px;
    overflow-y: auto;
    display: none;
    flex-direction: column;
    scrollbar-width: none;
  }
  .overflow-menu::-webkit-scrollbar { display: none; }
  .overflow-menu.open { display: flex; }

  .ovf-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    border: none;
    background: none;
    color: var(--vscode-foreground);
    cursor: pointer;
    border-radius: 5px;
    font-size: 12px;
    font-family: var(--vscode-font-family);
    text-align: left;
    width: 100%;
  }
  .ovf-item:hover { background: var(--vscode-toolbar-hoverBackground); }
  .ovf-icon { flex-shrink: 0; width: 16px; display: flex; align-items: center; justify-content: center; opacity: .75; }
  .ovf-item:hover .ovf-icon { opacity: 1; }
  .ovf-label { flex: 1; }
  .ovf-check { font-size: 11px; opacity: 0; transition: opacity .1s; flex-shrink: 0; color: var(--vscode-button-background); font-weight: 700; }
  .ovf-item.active .ovf-check { opacity: 1; }
  .ovf-item.active .ovf-label { font-weight: 600; }
  .ovf-divider { border: none; border-top: 1px solid var(--vscode-panel-border); margin: 4px 0; }
  .ovf-item.danger       { color: ${C.danger}; }
  .ovf-item.danger:hover { background: none; }
  .ovf-item.confirm      { color: ${C.danger}; font-weight: 600; }

  .overflow-btn.open   { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }
  .overflow-btn.active { opacity: 1; color: var(--vscode-button-background); }

  /* ── Tag filter bar ──────────────────────────────────── */
  .tag-bar {
    display: flex;
    align-items: center;
    gap: 4px;
    flex-wrap: wrap;
    padding: 6px 10px;
    border-bottom: 1px solid var(--vscode-panel-border);
    flex-shrink: 0;
  }


  /* ── Pill tokens ── */
  :root { --pill-font: 11px; --pill-py: 2px; --pill-px: 8px; --pill-border: 1.5px; --pill-radius: 20px; --pill-gap: 4px; }

  .tag-chip {
    font-size: var(--pill-font);
    padding: var(--pill-py) var(--pill-px);
    border-radius: var(--pill-radius);
    border: var(--pill-border) solid transparent;
    cursor: pointer;
    font-weight: 500;
    color: ${C.text};
    transition: opacity .12s;
    white-space: nowrap;
    display: inline-flex;
    align-items: center;
    gap: var(--pill-gap);
  }
  .tag-chip:hover { opacity: .85; }
  .tag-chip.active { border-color: ${C.text}; }
  .tag-chip.all { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .tag-chip.all.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: transparent; }
  .tag-chip.dragging  { opacity: .35; }
  .tag-chip.drag-over { outline: 2px solid currentColor; outline-offset: 2px; }
  .color-swatch.default-swatch {
    display: flex; align-items: center; justify-content: center;
    font-size: 12px; line-height: 1;
    color: var(--vscode-editor-background, ${PC.vsEditorDark});
  }
  .tag-chip.default-color {
    background: color-mix(in srgb, var(--vscode-foreground) 15%, transparent);
    border-color: color-mix(in srgb, var(--vscode-foreground) 45%, transparent);
    color: var(--vscode-foreground);
  }
  .tag-chip.default-color.active {
    background: var(--vscode-foreground);
    border-color: rgba(0,0,0,.2);
    color: var(--vscode-editor-background, ${PC.vsEditorDark});
  }
  .tag-pill.default-color {
    background: color-mix(in srgb, var(--vscode-foreground) 15%, transparent);
    border-color: color-mix(in srgb, var(--vscode-foreground) 45%, transparent);
    color: var(--vscode-foreground);
  }

  .tag-chip-color-pop {
    display: none;
    position: fixed;
    background: var(--vscode-editorWidget-background, ${C.white});
    border: 1px solid var(--vscode-panel-border);
    border-radius: 6px;
    padding: 8px;
    flex-direction: column;
    gap: 4px;
    width: 200px;
    z-index: 200;
    box-shadow: 0 4px 16px rgba(0,0,0,.2);
  }
  .tag-chip-color-pop.open { display: flex; }

  /* Shared 7-column grid for Icon and Color rows — ensures identical columns and gap */
  .tag-chip-color-pop .tag-chip-swatches,
  .tag-chip-color-pop .tag-icon-picker {
    display: grid;
    grid-template-columns: repeat(7, 1fr);
    gap: 3px;
  }
  .tag-chip-color-pop .tag-icon-picker { padding-top: 5px; overflow: visible; }

  .tag-chip-swatches { display: flex; flex-wrap: wrap; gap: 5px; }
  .tag-chip-color-pop .color-swatch {
    width: 100%; height: 24px; border-radius: 6px;
    box-shadow: none;
  }
  .tag-chip-color-pop .color-swatch:hover { transform: none; filter: brightness(1.1); }
  .tag-chip-color-pop .color-swatch.selected {
    border-color: rgba(255,255,255,.9);
    box-shadow: 0 0 0 1.5px var(--vscode-focusBorder);
  }
  /* Icon swatches and their wrappers fill their grid cell */
  .tag-chip-color-pop .tag-icon-picker .custom-swatch-wrap,
  .tag-chip-color-pop .tag-icon-picker .tag-icon-swatch,
  .tag-chip-color-pop .my-icons-results .tag-icon-swatch { width: 100%; }
  /* "+" buttons fill their grid cell like swatches */
  .tag-chip-color-pop .tag-chip-color-custom-btn {
    width: 100%; height: 24px; padding: 0; border-radius: 6px;
    font-size: 14px; display: flex; align-items: center; justify-content: center;
  }
  /* Delete button aligns with grids/inputs — strip ovf-item's own horizontal padding */
  .tag-chip-color-pop .ovf-item { padding-left: 0; padding-right: 0; justify-content: center; }
  /* Inputs match swatch height */
  .tag-chip-color-pop .tag-chip-pop-input { height: 24px; padding-top: 0; padding-bottom: 0; }

  .tag-chip-color-custom-btn {
    font-size: 11px; padding: 2px 6px; border-radius: 20px;
    background: none; border: 1.5px dashed var(--vscode-panel-border);
    color: var(--vscode-descriptionForeground); cursor: pointer; flex-shrink: 0;
  }
  .tag-chip-color-custom-btn:hover { border-color: var(--vscode-foreground); color: var(--vscode-foreground); }
  .tag-chip-color-custom-btn.active { border-style: solid; border-color: var(--vscode-focusBorder); color: var(--vscode-focusBorder); }
  .tag-chip-hex-wrap { display: flex; align-items: center; gap: 6px; }
  .color-picker-wrap { display: none; flex-direction: column; gap: 6px; }
  .color-picker-wrap.open { display: flex; }
  .color-picker-canvas { width: 100%; border-radius: 4px; cursor: crosshair; display: block; }
  .color-picker-hue {
    -webkit-appearance: none; appearance: none;
    width: 100%; height: 10px; border-radius: 5px; outline: none; cursor: pointer; border: none;
    background: linear-gradient(to right,#f00,#ff0,#0f0,#0ff,#00f,#f0f,#f00);
  }
  .color-picker-hue::-webkit-slider-thumb {
    -webkit-appearance: none; appearance: none;
    width: 14px; height: 14px; border-radius: 50%;
    background: ${C.white}; border: 2px solid rgba(0,0,0,.35); cursor: pointer;
    box-shadow: 0 1px 3px rgba(0,0,0,.3);
  }
  .custom-swatch-wrap { position: relative; display: inline-flex; flex-shrink: 0; }
  .custom-swatch-del {
    position: absolute; top: -4px; right: -4px;
    width: 13px; height: 13px; border-radius: 50%;
    background: var(--vscode-errorForeground, ${C.danger}); color: ${C.white};
    font-size: 9px; line-height: 1; border: none; cursor: pointer;
    display: none; align-items: center; justify-content: center; padding: 0; z-index: 1;
  }
  .custom-swatch-wrap:hover .custom-swatch-del { display: flex; }
  .tag-chip-pop-sep { height: 1px; background: var(--vscode-panel-border); margin: 8px -8px; opacity: .6; }
  .tag-chip-pop-danger-sep {
    height: 1px; background: var(--vscode-panel-border); margin: 10px -8px 4px; opacity: .6;
  }
  .tag-icon-picker {
    display: flex; flex-wrap: wrap; gap: 3px;
    max-height: 96px; overflow-y: auto; padding: 1px 0;
    scrollbar-width: none;
  }
  .tag-icon-picker::-webkit-scrollbar { display: none; }
  .tag-icon-swatch {
    width: 24px; height: 24px; box-sizing: border-box;
    display: inline-flex; align-items: center; justify-content: center;
    border-radius: 6px; cursor: pointer; border: 1px solid rgba(255,255,255,.15);
    background: transparent; color: var(--vscode-foreground); opacity: .65;
  }
  .tag-icon-swatch:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }
  .tag-icon-swatch.selected { opacity: 1; border-color: var(--vscode-focusBorder); background: var(--vscode-toolbar-activeBackground); }
  .tag-icon-swatch.none-swatch { opacity: .45; }
  .tag-icon-swatch.none-swatch.selected { border-color: rgba(255,255,255,.15); background: var(--vscode-toolbar-activeBackground); opacity: .65; }
  .tag-icon-swatch.saved { opacity: .3; }
  .tag-icon-swatch.saved:hover { opacity: .6; }
  .tag-chip-hex-dot { width: 24px; height: 24px; border-radius: 6px; flex-shrink: 0; border: 1px solid rgba(0,0,0,.2); }
  .tag-chip-hex-wrap .tag-chip-pop-input { flex: 1; }
  .tag-form-icon-picker {
    display: flex; flex-wrap: wrap; gap: 3px;
    max-height: 120px; overflow-y: auto; padding: 2px 0; scrollbar-width: none;
  }
  .tag-form-icon-picker::-webkit-scrollbar { display: none; }
  .tag-chip-pop-input {
    width: 100%;
    box-sizing: border-box;
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 3px;
    color: var(--vscode-input-foreground);
    font-size: 11px;
    padding: 3px 6px;
    outline: none;
    font-family: monospace;
  }
  .tag-chip-pop-input:focus { border-color: var(--vscode-focusBorder); }

  .my-icons-search-wrap { display: flex; flex-direction: column; gap: 4px; margin-top: 2px; }
  .my-icons-results {
    display: flex; flex-wrap: wrap; gap: 3px;
    max-height: 72px; overflow-y: auto; padding: 1px 0;
    scrollbar-width: none;
  }
  .tag-chip-color-pop .my-icons-results {
    display: grid; grid-template-columns: repeat(7, 1fr);
  }
  .my-icons-results::-webkit-scrollbar { display: none; }
  .my-icons-empty {
    grid-column: 1 / -1;
    font-size: 10px; color: var(--vscode-descriptionForeground);
    padding: 3px 0; opacity: .7;
  }


  .add-tag-btn {
    font-size: var(--pill-font);
    padding: var(--pill-py) var(--pill-px);
    border-radius: var(--pill-radius);
    background: none;
    border: var(--pill-border) dashed var(--vscode-panel-border);
    color: var(--vscode-descriptionForeground);
    cursor: pointer;
    gap: var(--pill-gap);
  }
  .add-tag-btn:hover { border-color: var(--vscode-foreground); color: var(--vscode-foreground); }


  /* ── Card list ───────────────────────────────────────── */
  .card-list {
    flex: 1;
    overflow-y: auto;
    padding: var(--gap);
    display: flex;
    flex-direction: column;
    gap: var(--gap);
  }

  /* ── Card ────────────────────────────────────────────── */
  .card {
    border-radius: var(--radius);
    padding: 10px 12px 8px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    color: var(--card-text);
    position: relative;
    border: 1px solid var(--vscode-panel-border);
    background: transparent;
    transition: background .15s, border-color .15s, box-shadow .15s;
  }
  .card:hover {
    background: var(--vscode-editorWidget-background, var(--vscode-sideBar-background));
    box-shadow: 0 1px 4px rgba(0,0,0,.12);
  }
  .card:focus { outline: 2px solid var(--vscode-focusBorder); outline-offset: 1px; }
  .card.hidden { display: none; }

  /* ── Draft (inline new) card ─────────────────────────── */
  .draft-card { cursor: default; }
  .draft-card .card-title { width: 100%; }
  .draft-card .tag-ghost.active { opacity: 1; border-style: solid; }
  .draft-footer-done {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none; border-radius: 4px; cursor: pointer;
    font-size: 11px; font-weight: 600; padding: 3px 8px;
    font-family: var(--vscode-font-family); flex-shrink: 0;
    transition: background .12s;
  }
  .draft-footer-done:hover { background: var(--vscode-button-hoverBackground); }
  .draft-create-btn {
    width: 100%; padding: 7px 0;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: 1px solid var(--vscode-panel-border); border-top: none;
    border-radius: 0 0 var(--radius) var(--radius);
    cursor: pointer; font-size: 12px; font-weight: 600;
    font-family: var(--vscode-font-family); transition: background .12s;
  }
  .draft-create-btn:hover { background: var(--vscode-button-hoverBackground); }
  .draft-tag-picker {
    position: absolute; left: 0; top: calc(100% + 4px); z-index: 100;
    background: var(--vscode-menu-background, var(--vscode-editor-background));
    border: 1px solid var(--vscode-panel-border);
    border-radius: 6px; padding: 4px; display: flex; flex-wrap: wrap; gap: 4px;
    box-shadow: 0 4px 12px rgba(0,0,0,.2); min-width: 120px;
  }

  /* ── Card rows ───────────────────────────────────────── */
  .card-row-1 {
    display: flex;
    align-items: center;
    gap: 4px;
    min-height: 24px;
    padding: 0;
  }
  .card-row-1 .card-title { color: var(--card-text); }

  .card-overflow-btn {
    background: none;
    border: none;
    cursor: pointer;
    font-size: 15px;
    line-height: 1;
    padding: 0 2px;
    color: var(--card-text);
    opacity: 0;
    transition: opacity .12s;
    flex-shrink: 0;
    border-radius: 4px;
  }
  .card:hover .card-overflow-btn { opacity: .5; }
  .card-overflow-btn:hover { opacity: 1 !important; background: rgba(${hexToRgb(C.neutral)},.15); }

  .star-btn {
    background: none; border: none; cursor: pointer;
    padding: 0; display: flex; align-items: center;
    color: var(--card-text); opacity: .4;
    flex-shrink: 0;
  }
  .star-btn.on { opacity: 1; color: var(--card-text); }
  .star-btn:hover { opacity: .8; }

  .card-title {
    flex: 1;
    font-weight: 700;
    font-size: 13px;
    color: var(--card-text);
    outline: none;
    border: none;
    background: transparent;
    padding: 0;
    min-width: 0;
    cursor: text;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .card-title:focus {
    border-bottom: 1.5px solid var(--vscode-focusBorder);
    white-space: normal;
    overflow: visible;
    text-overflow: clip;
  }

  .card-row-2 {
    position: relative;
    display: flex;
    align-items: center;
    gap: 4px;
    flex-wrap: wrap;
    min-height: 0;
  }
  .card-row-2:empty { display: none; }

  .card-row-3 {
    border-top: 1px solid rgba(${hexToRgb(C.neutral)},.08);
    padding-top: 5px;
  }

  .color-swatch {
    width: 26px; height: 26px;
    border-radius: 50%;
    border: 2px solid transparent;
    cursor: pointer;
    transition: transform .12s;
    box-shadow: 0 1px 4px rgba(0,0,0,.18);
  }
  .color-swatch:hover { transform: scale(1.15); }
  .color-swatch.selected { border-color: ${C.text}; }

  /* Card content */
  .card-content {
    font-size: 12px;
    line-height: 1.55;
    color: var(--card-text);
    opacity: .85;
    cursor: text;
    width: 100%;
  }

  /* Rendered markdown preview */
  .card-preview { user-select: none; cursor: text; }
  .card-preview[data-empty]::before {
    content: attr(data-placeholder);
    color: var(--vscode-input-placeholderForeground, rgba(${hexToRgb(C.neutral)},.45));
    pointer-events: none;
  }
  .card-preview p { margin: 0 0 4px; }
  .card-preview blockquote { margin: 0 0 4px 0; padding: 2px 8px; border-left: 3px solid rgba(${hexToRgb(C.neutral)},.35); background: rgba(${hexToRgb(C.neutral)},.06); border-radius: 0 2px 2px 0; }
  .card-preview hr { border: none; border-top: 1px solid rgba(${hexToRgb(C.neutral)},.25); margin: 4px 0; }
  .card-preview ul, .card-preview ol { padding-left: 1.2em; margin: 0 0 4px; }
  .card-preview li { margin: 1px 0; }
  .card-preview a { color: var(--vscode-button-background); text-decoration: underline; cursor: pointer; }
  .card-preview code {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: .85em;
    background: rgba(0,0,0,.1);
    padding: 0 3px;
    border-radius: 3px;
  }
  .card-preview strong { font-weight: 700; }
  .card-preview em { font-style: italic; }
  .card-preview.clamped {
    max-height: 8em;
    overflow: hidden;
  }

  /* Preview in edit mode */
  .card-preview[contenteditable="true"] {
    user-select: text;
    outline: none;
    max-height: none;
    display: block;
    overflow: visible;
  }

  .show-more {
    cursor: pointer;
    opacity: .5;
    color: var(--card-text);
    display: flex;
    visibility: hidden;
    justify-content: flex-end;
    user-select: none;
  }
  .show-more:hover { opacity: 1; }

  /* Card footer — aliased to row 4 */
  .card-row-4 {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 4px;
    border-top: 1px solid rgba(${hexToRgb(C.neutral)},.08);
    padding-top: 5px;
    margin-top: 1px;
  }

  /* Footer slot — crossfade between primary and secondary */
  .card-foot-slot {
    position: relative;
    display: inline-flex;
    align-items: center;
  }
  .card-foot-slot-left  { justify-content: flex-start; text-align: left; }
  .card-foot-slot-right { justify-content: flex-end;   text-align: right; }
  .card-foot-primary {
    transition: opacity .18s ease, transform .18s ease;
    white-space: nowrap;
  }
  .card-foot-slot .card-foot-secondary {
    position: absolute;
    white-space: nowrap;
    opacity: 0 !important;
    transform: translateY(4px);
    pointer-events: none;
    transition: opacity .18s ease, transform .18s ease;
  }
  .card-foot-slot-left  .card-foot-secondary { left: 0; }
  .card-foot-slot-right .card-foot-secondary { right: 0; }
  .card-foot-slot.card-foot-flipped .card-foot-primary {
    opacity: 0;
    transform: translateY(-4px);
  }
  .card-foot-slot.card-foot-flipped .card-foot-secondary {
    opacity: 1 !important;
    transform: translateY(0);
    pointer-events: auto;
  }

  /* ── Format bar (replaces row 4 while editing) ───────── */
  .card-fmtbar {
    display: none;
    align-items: center;
    gap: 2px;
    border-top: 1px solid rgba(${hexToRgb(C.neutral)},.08);
    padding-top: 5px;
    margin-top: 1px;
    position: relative;
    overflow: visible;
    flex-wrap: nowrap;
  }
  .card-fmt-btn {
    background: none;
    border: none;
    cursor: pointer;
    padding: 2px 4px;
    border-radius: 3px;
    color: var(--card-text);
    opacity: .55;
    display: flex;
    align-items: center;
    transition: opacity .1s, background .1s;
  }
  .card-fmt-btn:hover { opacity: 1; background: rgba(${hexToRgb(C.neutral)},.12); }
  .card-fmt-btn.active { opacity: 1; color: var(--vscode-button-background); }
  .card-fmt-sep { flex: 1; min-width: 4px; }
  .card-fmt-done {
    background: none;
    border: none;
    cursor: pointer;
    padding: 2px 6px;
    border-radius: 3px;
    color: var(--card-text);
    opacity: .5;
    display: flex;
    align-items: center;
    flex-shrink: 0;
    transition: opacity .1s, background .1s;
  }
  .card-fmt-done:hover { opacity: 1; background: rgba(${hexToRgb(C.neutral)},.12); }

  /* Collapsible groups */
  .fmt-grp { display: flex; align-items: center; gap: 2px; }
  .fmt-toggle-wrap { position: relative; display: flex; align-items: center; }
  .fmt-grp-toggle { display: none; gap: 1px; }
  .fmt-dropdown {
    display: none; position: absolute; bottom: calc(100% + 6px); left: 0;
    flex-wrap: wrap; gap: 2px; padding: 4px; z-index: 50; min-width: 80px;
    background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
    border: 1px solid var(--vscode-panel-border);
    border-radius: 5px; box-shadow: 0 2px 8px rgba(0,0,0,.2);
  }
  .fmt-dropdown.open { display: flex; }
  .card-fmtbar.compact-text .fmt-grp-text,
  .card-fmtbar.compact-text .fmt-sep-text { display: none; }
  .card-fmtbar.compact-text .fmt-toggle-text-wrap .fmt-grp-toggle { display: flex; }
  .card-fmtbar.compact-lists .fmt-grp-lists,
  .card-fmtbar.compact-lists .fmt-sep-lists { display: none; }
  .card-fmtbar.compact-lists .fmt-toggle-lists-wrap .fmt-grp-toggle { display: flex; }

  /* Task / checklist items */
  .task-list { list-style: none; padding-left: 4px; margin: 2px 0; }
  .task-item { display: flex; align-items: flex-start; gap: 5px; }
  .task-item input[type="checkbox"] {
    appearance: none; -webkit-appearance: none;
    cursor: pointer; width: 13px; height: 13px; flex-shrink: 0;
    margin-top: 3px;
    background: transparent;
    border: 1.5px solid var(--card-text); border-radius: 2px;
    transition: background .1s, border-color .1s;
  }
  .task-item input[type="checkbox"]:checked {
    background: var(--vscode-button-background);
    border-color: var(--vscode-button-background);
    background-image: url('${checkmarkUri}');
    background-repeat: no-repeat;
    background-position: center;
  }
  .task-item.done > span { opacity: .5; text-decoration: line-through; }

  /* Rich block content inside preview */
  .card-preview h1 { font-size: 1.1923em; font-weight: 700; margin: 3px 0 2px; }
  .card-preview h2 { font-size: 1.1154em; font-weight: 700; margin: 2px 0; }
  .card-preview h3 { font-size: 1.0385em; font-weight: 600; margin: 2px 0; opacity: .8; }

  .card-preview .table-scroll { overflow-x: auto; margin: 2px 0 4px; transform: rotateX(180deg); }
  .card-preview table { border-collapse: collapse; width: 100%; font-size: .9em; white-space: nowrap; transform: rotateX(180deg); }
  .card-preview th, .card-preview td { padding: 2px 7px; border: 1px solid rgba(${hexToRgb(C.neutral)},.22); text-align: left; vertical-align: top; }
  .card-preview th { font-weight: 700; background: rgba(${hexToRgb(C.neutral)},.08); }
  .card-preview pre {
    background: rgba(${hexToRgb(C.neutral)},.1); border-radius: 3px;
    padding: 4px 6px; font-family: monospace; font-size: .85em;
    margin: 2px 0; white-space: pre-wrap;
  }
  .card-preview ol  { list-style: decimal; padding-left: 18px; margin: 2px 0; }
  .card-preview ul:not(.task-list) { list-style: disc; padding-left: 18px; margin: 2px 0; }
  .card-preview .cell-list { margin: 1px 0; padding-left: 14px; white-space: normal; }
  .card-preview .cell-list li { margin: 0; line-height: 1.4; }
  .card-preview .cell-list.task-list { padding-left: 0; list-style: none; }
  .card-preview .cell-list.task-list li { display: flex; align-items: flex-start; gap: 4px; }

  /* Format bar separator between button groups */
  .card-fmt-sep-bar {
    width: 1px; height: 14px; background: rgba(${hexToRgb(C.neutral)},.22);
    margin: 0 2px; flex-shrink: 0;
  }

  .card-tags { display: contents; } /* flattened into row2 */
  .draft-pills { display: contents; }

  .tag-ghost {
    display: inline-flex;
    align-items: center;
    gap: var(--pill-gap);
    font-size: var(--pill-font);
    padding: var(--pill-py) var(--pill-px);
    border-radius: var(--pill-radius);
    border: var(--pill-border) dashed rgba(${hexToRgb(C.neutral)},.35);
    background: none;
    color: var(--card-text);
    opacity: .35;
    cursor: pointer;
    transition: opacity .12s;
  }
  .tag-ghost:hover { opacity: .7; }
  .tag-pill {
    color: ${C.text};
  }
  .chip-remove {
    font-size: 8px;
    flex-shrink: 0;
    padding: 0 1px;
    margin-left: -3px;
    border-radius: 2px;
    line-height: 1;
    max-width: 0;
    overflow: hidden;
    opacity: 0;
    transform: translateY(1px);
    transition: max-width .15s, opacity .1s, margin-left .15s;
  }
  .tag-pill:hover .chip-remove,
  .meta-chip:hover .chip-remove  { max-width: 16px; opacity: .55; margin-left: 0; }
  .chip-remove:hover             { opacity: 1 !important; }
  .tag-icon { display: inline-flex; align-items: center; flex-shrink: 0; }

  .card-date {
    font-size: 10px;
    opacity: .55;
    color: var(--card-text);
    white-space: nowrap;
  }

  /* ── Note card overlay ──────────────────────────────── */
  .note-card-overlay {
    display: none;
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,.38);
    z-index: 200;
    align-items: center;
    justify-content: center;
    padding: 16px 10px;
  }
  .note-card-overlay.open { display: flex; }

  .note-card {
    width: 100%;
    max-height: 65vh;
    border-radius: 12px;
    background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
    border: 1px solid var(--vscode-panel-border);
    box-shadow: 0 8px 32px rgba(0,0,0,.35), 0 2px 8px rgba(0,0,0,.18);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    transform: scale(.92);
    opacity: 0;
    transition: transform .18s cubic-bezier(.34,1.3,.64,1), opacity .15s ease;
  }
  .note-card-overlay.open .note-card {
    transform: scale(1);
    opacity: 1;
  }

  .note-card-header {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    padding: 6px 10px;
    border-bottom: 1px solid var(--vscode-panel-border);
  }

  .note-card-close {
    background: none;
    border: none;
    cursor: pointer;
    color: var(--vscode-descriptionForeground);
    width: 22px;
    height: 22px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    transition: background .12s, color .12s;
    padding: 0;
  }
  .note-card-close:hover { background: var(--vscode-list-hoverBackground); color: var(--vscode-foreground); }

  .note-card-title {
    background: transparent;
    border: none;
    outline: none;
    font-size: 14px;
    font-weight: 700;
    color: var(--vscode-foreground);
    padding: 0 12px 6px;
    width: 100%;
    font-family: var(--vscode-font-family);
  }
  .note-card-title::placeholder { color: var(--vscode-descriptionForeground); opacity: .6; }

  .note-card-body {
    cursor: text;
    overflow-y: auto;
    min-height: 88px;
    flex: 1;
    min-height: 0;
    word-break: break-word;
  }
  .note-card-body .ProseMirror {
    outline: none;
    min-height: 88px;
    padding: 0 12px 10px;
    font-size: 12.5px;
    color: var(--vscode-foreground);
    font-family: var(--vscode-font-family);
    line-height: 1.55;
  }
  .note-card-body .ProseMirror p { margin: 0 0 3px; }
  .note-card-body .ProseMirror ul { padding-left: 18px; margin: 0 0 3px; }
  .note-card-body .ProseMirror li { margin: 0; }
  .note-card-body.is-empty .ProseMirror p:first-child::before {
    content: attr(data-placeholder);
    color: var(--vscode-descriptionForeground);
    opacity: .6;
    pointer-events: none;
    float: left;
    height: 0;
  }

  .note-card-footer {
    background: var(--vscode-sideBar-background);
    border-top: 1px solid var(--vscode-panel-border);
    padding: 7px 10px;
    display: flex;
    flex-direction: column;
    gap: 5px;
  }

  .note-card-fmtbar {
    display: flex;
    gap: 1px;
    align-items: center;
  }

  .fmt-btn {
    background: none;
    border: none;
    cursor: pointer;
    color: var(--vscode-descriptionForeground);
    font-size: 12px;
    width: 24px;
    height: 22px;
    border-radius: 4px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-family: var(--vscode-font-family);
    transition: background .1s, color .1s;
  }
  .fmt-btn:hover { background: var(--vscode-list-hoverBackground); color: var(--vscode-foreground); }
  .fmt-btn.active { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-foreground); }

  .fmt-btn-sep {
    width: 1px;
    height: 14px;
    background: var(--vscode-panel-border);
    margin: 0 3px;
    flex-shrink: 0;
  }

  .note-card-metabar {
    display: flex;
    align-items: center;
    gap: 5px;
    flex-wrap: wrap;
    min-height: 24px;
  }

  .note-card-confirm {
    background: var(--vscode-button-background);
    border: none;
    cursor: pointer;
    color: var(--vscode-button-foreground);
    font-size: 14px;
    font-weight: 700;
    width: 28px;
    height: 28px;
    border-radius: 6px;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    transition: background .12s;
    margin-left: auto;
  }
  .note-card-confirm:hover { background: var(--vscode-button-hoverBackground); }

  .nc-select {
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 5px;
    color: var(--vscode-foreground);
    font-size: 11px;
    padding: 2px 4px;
    cursor: pointer;
    font-family: var(--vscode-font-family);
    outline: none;
    max-width: 105px;
    flex-shrink: 0;
  }
  .nc-select:focus { border-color: var(--vscode-focusBorder); }

  .color-strip {
    display: flex;
    gap: 3px;
    flex-wrap: wrap;
  }
  .color-strip .color-swatch {
    width: 24px; height: 24px; box-sizing: border-box; border-radius: 6px; box-shadow: none;
  }
  .color-strip .color-swatch:hover { transform: none; filter: brightness(1.1); }
  .color-strip .color-swatch.selected {
    border-color: var(--vscode-focusBorder);
    box-shadow: none;
  }

  .new-note-tags {
    display: flex;
    gap: 5px;
    flex-wrap: wrap;
    min-height: 22px;
  }

  .btn {
    padding: 4px 12px;
    border-radius: 6px;
    border: none;
    cursor: pointer;
    font-size: 12px;
    font-family: var(--vscode-font-family);
    font-weight: 600;
  }
  .btn-primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .btn-ghost   { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }

  /* ── Add tag form ────────────────────────────────────── */
  .add-tag-form-title {
    display: flex; align-items: center; gap: 6px;
    font-size: 12px; font-weight: 600;
    color: var(--vscode-foreground); opacity: .85;
  }
  .add-tag-form-title-icon {
    display: inline-flex; align-items: center; opacity: .7;
  }
  .add-tag-form-close {
    margin-left: auto;
    display: inline-flex; align-items: center; justify-content: center;
    width: 18px; height: 18px; padding: 0;
    background: none; border: none; border-radius: 4px;
    color: var(--vscode-foreground); opacity: .5; cursor: pointer;
  }
  .add-tag-form-close:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }
  .add-tag-form-sep {
    height: 1px; background: rgba(255,255,255,.08); margin: 0 -10px;
  }
  .add-tag-form-section-label {
    margin: 4px 0 0; font-size: 10px; font-weight: 600; letter-spacing: .04em;
    text-transform: uppercase; color: var(--vscode-foreground); opacity: .4;
  }
  .add-tag-form-footer {
    display: flex; justify-content: flex-end;
  }
  .add-tag-form-footer .btn-primary:disabled {
    opacity: .35 !important; cursor: not-allowed; pointer-events: none;
  }
  .add-tag-form {
    display: none;
    flex-direction: column;
    gap: 8px;
    padding: 8px 10px;
    border-top: 1px solid var(--vscode-panel-border);
    flex-shrink: 0;
  }
  .add-tag-form.open { display: flex; }
  .tag-label-wrap { position: relative; width: 100%; }
  .add-tag-form input {
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 5px;
    padding: 3px 7px;
    color: var(--vscode-input-foreground);
    outline: none;
    font-size: 12px;
    width: 100%;
    box-sizing: border-box;
  }
  .tag-label-wrap input { padding-right: 48px; }
  .tag-label-counter {
    position: absolute; right: 6px; top: 50%; transform: translateY(-50%);
    font-size: 9px; color: var(--vscode-foreground); opacity: 0;
    pointer-events: none; transition: opacity .15s;
    border: 1px solid currentColor; border-radius: 20px; padding: 1px 4px;
  }
  .tag-label-counter.visible { opacity: .35; }
  .tag-label-counter.near-limit { opacity: 1; color: ${C.danger}; }

  /* ── Selection mode ─────────────────────────────────── */
  .select-mode .card { cursor: pointer; user-select: none; }
  .select-mode .card:hover { box-shadow: 0 4px 14px rgba(0,0,0,.2); }

  .card-check {
    display: none;
    width: 16px; height: 16px;
    border-radius: 4px;
    border: 1.5px solid rgba(${hexToRgb(C.text)},.35);
    background: rgba(255,255,255,.1);
    align-items: center;
    justify-content: center;
    font-size: 10px;
    color: transparent;
    transition: background .1s, border-color .1s;
    flex-shrink: 0;
  }
  .select-mode .card-check { display: flex; }
  .select-mode .card-overflow-btn,
  .select-mode .star-btn { display: none; }
  .card.selected .card-check {
    background: var(--vscode-button-background);
    border-color: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
  }
  .card.selected .card-check::after { content: '✓'; }
  .card.selected { outline: 2px solid var(--vscode-button-background); outline-offset: 1px; }

  /* ── Export bar ──────────────────────────────────────── */
  .export-bar {
    padding: 8px 10px;
    border-top: 1px solid var(--vscode-panel-border);
    flex-shrink: 0;
    background: var(--vscode-sideBar-background);
    display: none;
    align-items: center;
    gap: 6px;
  }
  .export-bar.visible { display: flex; }
  .export-bar .btn {
    font-size: 11px;
    padding: 3px 8px;
    border: 1px solid currentColor;
    border-radius: 6px;
    display: flex;
    align-items: center;
    gap: 4px;
    color: var(--vscode-foreground);
    opacity: .75;
  }
  .export-bar .btn:disabled {
    opacity: .3;
    cursor: not-allowed;
    pointer-events: none;
  }
  .export-count {
    flex: 1;
    font-size: 11px;
    color: var(--vscode-foreground);
    opacity: .75;
    user-select: none;
  }
  .btn-danger {
    color: var(--vscode-errorForeground) !important;
    border-color: var(--vscode-errorForeground) !important;
    opacity: .75;
  }
  .btn-danger:not(:disabled):hover { opacity: 1; }
  .btn-sel-all { opacity: .85; }
  .btn-sel-all.all-selected { opacity: 1; font-weight: 700; }

  /* ── Branch indicator & filter ──────────────────────── */
  .branch-pill {
    font-size: 10px;
    padding: 1px 6px 1px 5px;
    border-radius: 10px;
    border: 1px solid transparent;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    min-width: 0;
    flex-shrink: 1;
    display: none;
    align-items: center;
    position: relative;
    overflow: hidden;
    height: 18px;
  }
  .branch-pill.visible { display: flex; }

  .branch-pill.can-switch { cursor: pointer; }
  .branch-pill.can-switch:hover {
    border-color: currentColor;
    background: var(--vscode-button-secondaryBackground, rgba(255,255,255,.12));
    color: var(--vscode-button-secondaryForeground, var(--vscode-badge-foreground));
  }
  .branch-pill.can-switch:hover .pill-primary { opacity: 0; transform: translateY(-5px); }
  .branch-pill.can-switch:hover .pill-action  { opacity: 1; transform: translateY(0); }
  .branch-pill .pill-copy { padding-left: 5px; }


  .branch-filter-btn.active { color: var(--vscode-button-background) !important; opacity: 1; }
  .archive-view-btn.active  { color: var(--vscode-button-background) !important; opacity: 1; }
  .select-mode-btn.active   { color: var(--vscode-button-background) !important; opacity: 1; }
  .card.is-archived { opacity: .7; filter: grayscale(.25); }


  /* ── Shared chip base ───────────────────────────────────── */
  .tag-pill, .meta-chip {
    font-size: var(--pill-font);
    padding: var(--pill-py) var(--pill-px);
    border-radius: var(--pill-radius);
    border: var(--pill-border) solid transparent;
    font-weight: 500;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: var(--pill-gap);
    line-height: 1;
    white-space: nowrap;
    transition: filter .12s;
    outline: none;
  }
  .tag-pill:hover, .meta-chip:hover { filter: brightness(.9); }

  .archived-badge { background: rgba(${hexToRgb(C.muted)},.18);    border-color: ${C.muted};    color: ${C.muted}; }
  .branch-chip    { background: rgba(${hexToRgb(C.neutral)},.18); border-color: rgba(${hexToRgb(C.neutral)},.5); color: rgba(${hexToRgb(C.neutral)},1); }

  /* Off-branch card — dimmed but still accessible */
  .card.off-branch { opacity: .42; }
  .card.off-branch:hover { opacity: .75; }



  /* Branch scope toggle in new-note form */
  .branch-scope-label {
    display: none;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    color: var(--vscode-foreground);
    opacity: .8;
    cursor: pointer;
    user-select: none;
  }
  .branch-scope-label.visible { display: flex; }
  .branch-scope-label input { cursor: pointer; }
  .branch-scope-label code {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 10px;
    background: rgba(${hexToRgb(C.neutral)},.15);
    padding: 1px 4px;
    border-radius: 3px;
  }

  /* ── Owner badge ────────────────────────────────────── */
  .owner-badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    color: var(--card-text);
    opacity: .7;
    max-width: 100px;
    overflow: hidden;
  }
  .owner-initials {
    width: 16px; height: 16px;
    border-radius: 50%;
    background: var(--vscode-badge-background);
    opacity: .75;
    font-size: 8px;
    font-weight: 700;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    letter-spacing: -.5px;
    color: ${C.text};
  }
  .owner-name {
    font-size: 10px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 56px;
  }
  .mine-filter-btn.active { color: var(--vscode-button-background) !important; opacity: 1; }
  .stale-filter-btn.active { color: var(--vscode-button-background) !important; opacity: 1; }

  /* ── Conflict / shared indicators ───────────────────── */
  .conflict-badge { background: rgba(${hexToRgb(C.danger)},.2);  border-color: ${C.danger};  color: ${C.danger}; }
  .shared-badge   { background: rgba(${hexToRgb(C.shared)},.18); border-color: ${C.shared}; color: ${C.shared}; }

  /* ── Reminder badge ─────────────────────────────────── */
  .reminder-badge         { background: rgba(${hexToRgb(C.remindWarn)},.18); border-color: ${C.remindWarn}; color: ${C.remindWarn}; }
  .reminder-badge.overdue { background: rgba(${hexToRgb(NC.orange)},.25);   border-color: ${NC.orange};    color: ${NC.orange}; }

  /* ── GitHub status badge ────────────────────────────── */
  .github-badge { text-transform: lowercase; }
  .github-badge.gh-open   { background: rgba(${hexToRgb(GH.open)},.18);   border-color: ${GH.open};   color: ${GH.open}; }
  .github-badge.gh-closed { background: rgba(${hexToRgb(C.muted)},.18);   border-color: ${C.muted};   color: ${C.muted}; }
  .github-badge.gh-merged { background: rgba(${hexToRgb(GH.merged)},.18); border-color: ${GH.merged}; color: ${GH.merged}; }


  /* ── Empty state ─────────────────────────────────────── */
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
  .empty-icon { font-size: 2.4em; }
  .empty-gif { width: 80px; height: 80px; object-fit: contain; opacity: .85; }
  .empty p { font-size: 12px; line-height: 1.5; }

  /* ── Code link chip ──────────────────────────────────── */
  .chip-label {
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
    transform: translateY(1px);
  }
  .tag-chip-label,
  .conflict-badge .chip-text,
  .github-badge .chip-text { transform: translateY(1px); }
  .code-link-chip {
    background: rgba(${hexToRgb(NC.blue)},.18);
    border-color: ${NC.blue};
    color: ${NC.blue};
    font-family: var(--vscode-editor-font-family, monospace);
    max-width: 200px;
    flex-shrink: 0;
  }
  .code-link-chip.stale {
    opacity: .5;
    text-decoration: line-through;
    cursor: default;
    pointer-events: none;
  }
  .note-links-row { display: contents; } /* flattened into row2 */
  .note-link-chip {
    background: rgba(${hexToRgb(NC.lavender)},.18);
    border-color: ${NC.lavender};
    color: ${NC.lavender};
    max-width: 160px;
  }

  .sort-btn.active { color: var(--vscode-button-background); opacity: 1; }

  /* ── New-note highlight flash ────────────────────────── */
  @keyframes highlight-new {
    0%   { outline: 3px solid rgba(255,255,255,.85); outline-offset: 0px; }
    100% { outline: 3px solid rgba(255,255,255,0);   outline-offset: 5px; }
  }
  .card.highlight-new { animation: highlight-new 1.2s ease-out forwards; }

  /* ── Keyboard hint in format bar ─────────────────────── */
  .nc-hint {
    margin-left: auto;
    font-size: 10px;
    color: rgba(${hexToRgb(C.text)},.38);
    white-space: nowrap;
    pointer-events: none;
    user-select: none;
  }

  /* ── Setup banner (Option A) ──────────────────────────────── */
  .setup-banner {
    margin: 8px 10px 4px;
    display: flex;
    flex-direction: column;
    gap: 5px;
  }
  .setup-banner-title {
    font-size: 13px;
    font-weight: 600;
    margin-bottom: 2px;
    padding: 0 2px;
  }
  .setup-banner-sub {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    margin-bottom: 6px;
    padding: 0 2px;
  }
  .setup-banner-footer {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    padding-top: 4px;
  }
  .setup-dismiss-btn {
    background: none;
    border: none;
    cursor: pointer;
    font-size: 11px;
    font-family: var(--vscode-font-family);
    color: var(--vscode-descriptionForeground);
    opacity: .65;
    padding: 2px 4px;
    border-radius: 3px;
  }
  .setup-dismiss-btn:hover { opacity: 1; text-decoration: underline; }
  .setup-confirm-bar {
    display: none;
    align-items: center;
    justify-content: flex-end;
    gap: 4px;
    font-size: 11px;
  }
  .setup-confirm-bar.visible { display: flex; }
  .setup-confirm-btn {
    background: none;
    border: none;
    cursor: pointer;
    font-size: 11px;
    font-family: var(--vscode-font-family);
    padding: 2px 4px;
    color: var(--vscode-textLink-foreground);
  }
  .setup-confirm-btn:hover { text-decoration: underline; }
  .setup-confirm-sep { opacity: .4; }
  .setup-card {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 9px 11px;
    border-radius: 7px;
    border: 1px solid var(--vscode-panel-border);
    background: var(--vscode-sideBarSectionHeader-background, rgba(255,255,255,.03));
    cursor: pointer;
    text-align: left;
    font-family: var(--vscode-font-family);
    color: var(--vscode-foreground);
    transition: border-color .15s, background .15s;
    position: relative;
  }
  .setup-card:hover {
    border-color: var(--vscode-focusBorder);
    background: var(--vscode-list-hoverBackground);
  }
  .setup-card.done {
    border-color: rgba(74, 175, 80, .4);
    background: rgba(74, 175, 80, .1);
    color: rgba(74, 175, 80, .8);
    cursor: default;
    pointer-events: none;
  }
  .setup-card.done:hover {
    border-color: rgba(74, 175, 80, .4);
    background: rgba(74, 175, 80, .1);
  }
  .setup-card.done.disconnectable {
    pointer-events: auto;
    cursor: pointer;
  }
  .setup-card.done.disconnectable:hover {
    border-color: rgba(74, 175, 80, .65);
    background: rgba(74, 175, 80, .18);
  }
  .setup-card-icon {
    flex-shrink: 0;
    width: 28px; height: 28px;
    border-radius: 6px;
    background: var(--vscode-button-background);
    display: flex; align-items: center; justify-content: center;
    opacity: .85;
    color: var(--vscode-button-foreground);
  }
  .setup-card.done .setup-card-icon {
    background: rgba(74, 175, 80, .25);
    color: rgba(74, 175, 80, .9);
    opacity: 1;
  }
  .setup-card.done .setup-card-desc {
    color: rgba(74, 175, 80, .6);
  }
  .setup-divider {
    border: none;
    border-top: 1px solid var(--vscode-panel-border);
    margin: 8px 0 0;
  }
  .setup-card-body { flex: 1; min-width: 0; }
  .setup-card-name {
    font-size: 12px;
    font-weight: 600;
    line-height: 1.3;
  }
  .setup-card-desc {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    line-height: 1.4;
    margin-top: 1px;
  }
</style>
</head>
<body>

<!-- ── Top bar ── -->
<div class="topbar">
  <div class="topbar-row">
    <span class="project-pill" id="project-name"><span class="pill-primary">${svgIcon(ALL_LUCIDE_NODES['FolderGit'], 13, 'flex-shrink:0')}<span class="pill-label">Loading…</span></span><span class="pill-action"><span class="pill-action-inner"><span class="pill-copy">${svgIcon(ALL_LUCIDE_NODES['FolderOpen'], 13, 'flex-shrink:0')}<span class="pill-label">Open folder</span><span class="pill-sep">·</span></span><span class="pill-copy">${svgIcon(ALL_LUCIDE_NODES['FolderOpen'], 13, 'flex-shrink:0')}<span class="pill-label">Open folder</span><span class="pill-sep">·</span></span><span class="pill-copy">${svgIcon(ALL_LUCIDE_NODES['FolderOpen'], 13, 'flex-shrink:0')}<span class="pill-label">Open folder</span><span class="pill-sep">·</span></span></span></span></span>
    <span class="branch-pill" id="branch-pill"></span>
    <div style="flex:1"></div>
    <button class="new-note-pill" id="btn-new" title="New Note">
      ${svgIcon(ALL_LUCIDE_NODES['Plus'], 11)}
      New
    </button>
  </div>

  <div class="topbar-row">
    <div class="search-row">
      ${svgIcon(ALL_LUCIDE_NODES['Search'], 12, 'opacity:.5;flex-shrink:0')}
      <input id="search" type="text" placeholder="Search notes…" autocomplete="off">
      <button class="search-clear" id="search-clear" title="Clear search" style="display:none">${svgIcon(ALL_LUCIDE_NODES['X'], 11)}</button>
    </div>
    <button class="icon-btn branch-filter-btn" id="btn-branch-filter" title="Show current branch only" style="display:none">${svgIcon(ALL_LUCIDE_NODES['GitBranch'], 13)}</button>
    <button class="icon-btn sort-btn" id="btn-sort" title="Sort: last updated">${svgIcon(ALL_LUCIDE_NODES['ClockArrowDown'], 13)}</button>
    <button class="icon-btn overflow-btn" id="btn-overflow" title="More options">
      ${svgIcon(ALL_LUCIDE_NODES['Ellipsis'], 14)}
    </button>
  </div>
</div>

<!-- ── Note card overlay ── -->
<div class="note-card-overlay" id="note-card-overlay">
  <div class="note-card" id="note-card">
    <div class="note-card-header">
      <button class="note-card-close" id="btn-cancel-new" title="Cancel">${svgIcon(ALL_LUCIDE_NODES['X'], 12)}</button>
    </div>
    <input class="note-card-title" id="new-title" type="text" placeholder="Note title…" maxlength="120" autocomplete="off">
    <div class="note-card-body is-empty" id="new-body" data-placeholder="Start writing…"></div>
    <div class="note-card-footer">
      <div class="note-card-fmtbar">
        <button class="fmt-btn" data-cmd="bold"       title="Bold (Ctrl+B)"><b>B</b></button>
        <button class="fmt-btn" data-cmd="italic"     title="Italic (Ctrl+I)"><i>I</i></button>
        <button class="fmt-btn" data-cmd="strike"     title="Strikethrough"><s>S</s></button>
        <div class="fmt-btn-sep"></div>
        <button class="fmt-btn" data-cmd="bulletList" title="Bullet list">&#8801;</button>
        <span class="nc-hint">Ctrl+Enter to create</span>
      </div>
      <div class="note-card-metabar">
        <label class="branch-scope-label" id="branch-scope-label">
          <input type="checkbox" id="new-branch-scope">
          <span>&#8903; <code id="branch-scope-name"></code></span>
        </label>
        <div class="new-note-tags" id="new-tags"></div>
        <select class="nc-select" id="new-template-select"></select>
        <button class="note-card-confirm" id="btn-confirm-new" title="Create note">&#10003;</button>
      </div>
    </div>
  </div>
</div>

<!-- ── Tag filter bar ── -->
<div class="tag-bar" id="tag-bar"></div>


<!-- ── Setup banner ── -->
<div class="setup-banner" id="setup-banner" style="display:none">
  <div class="setup-banner-title">Set up integrations</div>
  <div class="setup-banner-sub">Link your tools to get the most out of DevNotes.</div>
  <button class="setup-card" id="setup-github-row">
    <span class="setup-card-icon">${githubSvg(15)}</span>
    <div class="setup-card-body">
      <div class="setup-card-name">Connect GitHub</div>
      <div class="setup-card-desc" id="setup-github-desc">Link notes to issues &amp; PRs.</div>
    </div>
  </button>
  <button class="setup-card" id="setup-mcp-row">
    <span class="setup-card-icon">${svgIcon(ALL_LUCIDE_NODES['Bot'], 15)}</span>
    <div class="setup-card-body">
      <div class="setup-card-name">Register MCP server</div>
      <div class="setup-card-desc">Let Claude Code read and write your notes from the terminal.</div>
    </div>
  </button>
  <div class="setup-banner-footer">
    <button class="setup-dismiss-btn" id="setup-dismiss-btn">Dismiss</button>
    <div class="setup-confirm-bar" id="setup-confirm-bar">
      <button class="setup-confirm-btn" id="setup-hide-now">Hide for now</button>
      <span class="setup-confirm-sep">·</span>
      <button class="setup-confirm-btn" id="setup-never">Never show again</button>
    </div>
  </div>
</div>

<hr class="setup-divider" id="setup-divider" style="display:none">

<!-- ── Card list ── -->
<div class="card-list" id="card-list" role="list" aria-label="Notes"></div>

<!-- ── Card-level overflow menu ── -->
<div class="overflow-menu" id="card-ovf-menu"></div>

<!-- ── Overflow menu (⋯ button) ── -->
<div class="overflow-menu" id="overflow-menu">
  <button class="ovf-item mine-filter-btn" id="btn-mine-filter" style="display:none">
    <span class="ovf-icon">${svgIcon(ALL_LUCIDE_NODES['User'], 14)}</span>
    <span class="ovf-label">Personal notes</span>
    <span class="ovf-check">●</span>
  </button>
  <button class="ovf-item" id="btn-archive-view">
    <span class="ovf-icon">${svgIcon(ALL_LUCIDE_NODES['Archive'], 14)}</span>
    <span class="ovf-label">Archived notes</span>
    <span class="ovf-check">●</span>
  </button>
  <button class="ovf-item stale-filter-btn" id="btn-stale-filter">
    <span class="ovf-icon">${svgIcon(ALL_LUCIDE_NODES['Clock'], 14)}</span>
    <span class="ovf-label">Stale notes</span>
    <span class="ovf-check">●</span>
  </button>
  <button class="ovf-item" id="btn-select">
    <span class="ovf-icon">${svgIcon(ALL_LUCIDE_NODES['LayoutList'], 14)}</span>
    <span class="ovf-label">Selection mode</span>
    <span class="ovf-check">●</span>
  </button>
  <hr class="ovf-divider"/>
  <button class="ovf-item" id="btn-integrations">
    <span class="ovf-icon">${svgIcon(ALL_LUCIDE_NODES['Settings'], 14)}</span>
    <span class="ovf-label">Integrations</span>
  </button>
</div>

<!-- ── Export bar (selection mode) ── -->
<div class="export-bar" id="export-bar">
  <span class="export-count" id="export-count">0 selected</span>
  <button class="btn btn-ghost btn-sel-all" id="btn-sel-all" title="Select all visible notes">All</button>
  <button class="btn btn-ghost" id="btn-archive-sel" title="Archive selected" disabled>${svgIcon(ALL_LUCIDE_NODES['Archive'], 13)}</button>
  <button class="btn btn-ghost" id="btn-tag-sel" title="Assign tag to selected" disabled>${svgIcon(ALL_LUCIDE_NODES['Tag'], 13)}</button>
  <button class="btn btn-ghost" id="btn-export-sel" title="Export selected" disabled>${svgIcon(ALL_LUCIDE_NODES['SquareArrowOutUpRight'], 13)}</button>
  <button class="btn btn-ghost btn-danger" id="btn-delete-sel" title="Delete selected" disabled>${svgIcon(ALL_LUCIDE_NODES['Trash2'], 13)}</button>
  <button class="btn btn-ghost" id="btn-cancel-sel">Cancel</button>
</div>

<!-- ── Add tag form ── -->
<div class="add-tag-form" id="add-tag-form">
  <div class="add-tag-form-title">
    <span class="add-tag-form-title-icon">${svgIcon(ALL_LUCIDE_NODES['Tag'], 13)}</span>New Tag
    <button class="add-tag-form-close" id="btn-cancel-tag" title="Cancel">${svgIcon(ALL_LUCIDE_NODES['X'], 13)}</button>
  </div>
  <div class="add-tag-form-sep"></div>
  <p class="add-tag-form-section-label">Tag Name</p>
  <div class="tag-label-wrap">
    <input id="tag-label" type="text" placeholder="Enter tag name" maxlength="24">
    <span class="tag-label-counter" id="tag-label-counter">0/24</span>
  </div>
  <p class="add-tag-form-section-label">Select Icon</p>
  <div class="tag-form-icon-picker" id="tag-icon-picker"></div>
  <p class="add-tag-form-section-label">Select Color</p>
  <div class="color-strip" id="tag-colors"></div>
  <div class="add-tag-form-footer">
    <button class="btn btn-primary" id="btn-confirm-tag" disabled>Add Tag</button>
  </div>
</div>

<script nonce="${nonce}" src="${sidebarEditorUri}"></script>
<script nonce="${nonce}">
(() => {
  const vscode = acquireVsCodeApi();
  const COLORS          = ${colorsJson};
  const COLOR_KEYS      = Object.keys(COLORS);
  const DEFAULT_TAG_ICONS = ${defaultTagIconsJson};
  const EMPTY_GIFS = ${JSON.stringify(emptyGifs)};

  let notes             = [];
  let tags              = [];
  let imageUriMap       = {};
  let templates         = [];
  let defaultTagIds     = [];
  let customColors        = [];
  let hiddenDefaultColors = [];
  let hiddenDefaultIcons  = [];
  let savedIconSvgs       = [];
  let iconSearchResultsCb  = null;
  let activeTagIds      = [];
  let searchQuery       = '';
  let newTags           = [];
  let newTemplateId     = null;
  let tagColor          = 'default';
  let tagIcon           = null;
  let currentBranch      = null;
  let currentUser        = null;
  let availableBranches  = [];
  let branchFilterActive  = false;
  let mineFilterActive    = false;
  let githubConnected     = false;
  let showArchived           = false;
  let sortMode               = 'updated'; // 'updated' | 'starred' | 'alpha'
  let staleFilterActive      = false;
  let selectMode         = false;
  let selectedIds        = [];
  let knownNoteIds       = null; // null on first load — skip highlight; Set afterwards
  const expandedNoteIds  = new Set(); // persists across renderCards() calls
  let lastSavedNoteId    = null;
  let openColorPop    = null;
  const pendingImageInsertions = new Map(); // noteId → { range, preview }
  let cardTagPickerCommit = null;
  let pendingCodeLinkCallback = null;
  let draftOutsideListener   = null;

  // ── DOM refs ────────────────────────────────────────────────────────────
  const projectName    = document.getElementById('project-name');
  projectName.addEventListener('click', () => vscode.postMessage({ type: 'openFolder' }));
  const cardList       = document.getElementById('card-list');
  cardList.addEventListener('scroll', () => { if (cardOvfMenu?.classList.contains('open')) closeAllPops(); }, { passive: true });
  cardList.addEventListener('click', e => {
    const anchor = e.target.closest('a');
    if (!anchor) return;
    const href = anchor.getAttribute('href');
    if (!href) return;
    e.preventDefault();
    e.stopPropagation();
    vscode.postMessage({ type: 'openLink', url: href });
  });
  const tagBar         = document.getElementById('tag-bar');
  const searchEl       = document.getElementById('search');
  const searchClearEl  = document.getElementById('search-clear');
  const noteCardOverlay = document.getElementById('note-card-overlay');
  const noteCardEl      = document.getElementById('note-card');
  const newTitleEl      = document.getElementById('new-title');
  const newBodyEl       = document.getElementById('new-body');
  const newTagsEl       = document.getElementById('new-tags');
  const newTemplateSelectEl = document.getElementById('new-template-select');
  const btnMineFilter     = document.getElementById('btn-mine-filter');
  const btnStaleFilter    = document.getElementById('btn-stale-filter');
  const btnSelect         = document.getElementById('btn-select');
  btnSelect.classList.add('select-mode-btn');
  const exportBar         = document.getElementById('export-bar');
  const branchPillEl         = document.getElementById('branch-pill');
  const btnSort              = document.getElementById('btn-sort');
  const branchFilterBtn   = document.getElementById('btn-branch-filter');
  const branchScopeLabel  = document.getElementById('branch-scope-label');
  const branchScopeNameEl = document.getElementById('branch-scope-name');
  const addTagForm     = document.getElementById('add-tag-form');
  const tagLabelEl     = document.getElementById('tag-label');
  const tagColorsEl    = document.getElementById('tag-colors');

  // ── Tiptap ──────────────────────────────────────────────────────────────
  window.SidebarEditor?.init(newBodyEl);

  // ── Overflow menu ────────────────────────────────────────────────────────
  const btnOverflow  = document.getElementById('btn-overflow');
  const overflowMenu = document.getElementById('overflow-menu');
  btnOverflow.addEventListener('click', e => {
    e.stopPropagation();
    const rect   = btnOverflow.getBoundingClientRect();
    const isOpen = overflowMenu.classList.contains('open');
    closeAllPops();
    if (!isOpen) {
      overflowMenu.style.top   = (rect.bottom + 4) + 'px';
      overflowMenu.style.right = (window.innerWidth - rect.right) + 'px';
      overflowMenu.classList.add('open');
      btnOverflow.classList.add('open');
    }
  });

  // Clicks inside the overflow propagate to document → closeAllPops closes it.
  // Clicks on each item run their handler first, then the menu closes naturally.

  // ── Branch filter toggle ─────────────────────────────────────────────────
  branchFilterBtn.addEventListener('click', () => {
    branchFilterActive = !branchFilterActive;
    branchFilterBtn.classList.toggle('active', branchFilterActive);
    branchFilterBtn.title = branchFilterActive ? 'Show all branches' : 'Show current branch only';
    vscode.postMessage({ type: 'branchFilterChanged', active: branchFilterActive });
    renderCards();
  });

  // ── Mine filter ──────────────────────────────────────────────────────────
  btnMineFilter.addEventListener('click', () => {
    mineFilterActive = !mineFilterActive;
    btnMineFilter.classList.toggle('active', mineFilterActive);
    btnMineFilter.title = mineFilterActive ? 'Show all notes' : 'Personal notes only';
    syncOverflowActive();
    renderCards();
  });

  // ── Sort mode cycle ──────────────────────────────────────────────────────
  const SORT_MODES = [
    { key: 'updated', icon: ${jsSvg.sortUpdated}, title: 'Sort: last updated' },
    { key: 'starred', icon: ${jsSvg.sortStarred}, title: 'Sort: starred first' },
    { key: 'alpha',   icon: ${jsSvg.sortAlpha},   title: 'Sort: alphabetical' },
  ];
  btnSort.addEventListener('click', () => {
    const idx = SORT_MODES.findIndex(m => m.key === sortMode);
    const next = SORT_MODES[(idx + 1) % SORT_MODES.length];
    sortMode = next.key;
    btnSort.innerHTML = next.icon;
    btnSort.title = next.title;
    btnSort.classList.toggle('active', sortMode !== 'updated');
    renderCards();
  });

  // ── Archive view toggle ──────────────────────────────────────────────────
  const btnArchiveView = document.getElementById('btn-archive-view');
  function syncOverflowActive() {
    btnOverflow.classList.toggle('active', selectMode || showArchived || staleFilterActive || mineFilterActive);
  }

  btnArchiveView.classList.add('archive-view-btn');
  btnArchiveView.addEventListener('click', () => {
    showArchived = !showArchived;
    btnArchiveView.classList.toggle('active', showArchived);
    btnArchiveView.title = showArchived ? 'Back to notes' : 'Show archived notes';
    syncOverflowActive();
    renderCards();
  });

  // ── Stale filter ─────────────────────────────────────────────────────────
  btnStaleFilter.addEventListener('click', () => {
    staleFilterActive = !staleFilterActive;
    btnStaleFilter.classList.toggle('active', staleFilterActive);
    btnStaleFilter.title = staleFilterActive ? 'Show all notes' : 'Show stale notes (14+ days old with overdue reminder, open todos, or broken file link)';
    if (staleFilterActive && showArchived) {
      showArchived = false;
      btnArchiveView.classList.remove('active');
      btnArchiveView.title = 'Show archived notes';
    }
    syncOverflowActive();
    renderCards();
  });

  // ── Setup banner (Option A) ───────────────────────────────────────────────
  const setupBanner    = document.getElementById('setup-banner');
  const setupDivider   = document.getElementById('setup-divider');
  const setupGithubRow = document.getElementById('setup-github-row');
  const setupMcpRow    = document.getElementById('setup-mcp-row');
  const setupConfirmBar = document.getElementById('setup-confirm-bar');
  const setupDismissBtn = document.getElementById('setup-dismiss-btn');

  let lastGhConnected   = false;
  let lastMcpRegistered = false;
  let bannerForcedOpen  = false;

  // ── Integrations (reopens setup banner) ──────────────────────────────────
  document.getElementById('btn-integrations').addEventListener('click', () => {
    bannerForcedOpen = true;
    setupBanner.style.display  = '';
    setupDivider.style.display = '';
    setupDismissBtn.style.display = '';
    setupConfirmBar.classList.remove('visible');
    setupGithubRow.classList.toggle('done', lastGhConnected);
    setupGithubRow.classList.toggle('disconnectable', lastGhConnected);
    setupMcpRow.classList.toggle('done', lastMcpRegistered);
    overflowMenu.classList.remove('open');
  });

  const setupGithubDesc = document.getElementById('setup-github-desc');

  setupGithubRow.addEventListener('click', () => {
    if (setupGithubRow.classList.contains('done'))
      vscode.postMessage({ type: 'disconnectGitHub' });
    else
      vscode.postMessage({ type: 'connectGitHub' });
  });
  setupMcpRow.addEventListener('click', () => {
    if (!setupMcpRow.classList.contains('done'))
      vscode.postMessage({ type: 'registerMcp' });
  });
  setupDismissBtn.addEventListener('click', () => {
    setupDismissBtn.style.display = 'none';
    setupConfirmBar.classList.add('visible');
  });

  document.getElementById('setup-hide-now').addEventListener('click', () => {
    bannerForcedOpen = false;
    setupBanner.style.display  = 'none';
    setupDivider.style.display = 'none';
  });

  document.getElementById('setup-never').addEventListener('click', () => {
    bannerForcedOpen = false;
    setupBanner.style.display  = 'none';
    setupDivider.style.display = 'none';
    vscode.postMessage({ type: 'bannerDismiss' });
  });

  function updateSetupBanner(ghConnected, mcpReg, dismissed) {
    lastGhConnected   = ghConnected;
    lastMcpRegistered = mcpReg;
    const allDone = ghConnected && mcpReg;
    // bannerForcedOpen (set by the Integrations overflow item) overrides both
    // the auto-hide-when-done logic and the permanent dismiss flag so the user
    // can always review their integration status.
    if (!bannerForcedOpen && (dismissed || allDone)) {
      setupBanner.style.display  = 'none';
      setupDivider.style.display = 'none';
      return;
    }
    setupGithubRow.classList.toggle('done', ghConnected);
    setupGithubRow.classList.toggle('disconnectable', ghConnected);
    if (setupGithubDesc) {
      setupGithubDesc.textContent = ghConnected
        ? 'Connected — click to disconnect.'
        : 'Link notes to issues & PRs.';
    }
    setupMcpRow.classList.toggle('done', mcpReg);
  }

  // ── Selection mode ───────────────────────────────────────────────────────
  const exportCountEl  = document.getElementById('export-count');
  const btnSelAll      = document.getElementById('btn-sel-all');
  const btnArchiveSel  = document.getElementById('btn-archive-sel');
  const btnTagSel      = document.getElementById('btn-tag-sel');
  const btnExportSel   = document.getElementById('btn-export-sel');
  const btnDeleteSel   = document.getElementById('btn-delete-sel');
  const btnCancelSel   = document.getElementById('btn-cancel-sel');

  function exitSelectMode() {
    selectMode  = false;
    selectedIds = [];
    btnSelect.classList.remove('active');
    btnSelect.title = 'Select notes';
    cardList.classList.remove('select-mode');
    exportBar.classList.remove('visible');
    btnSelAll.classList.remove('all-selected');
    syncOverflowActive();
    cardList.querySelectorAll('.card.selected').forEach(c => c.classList.remove('selected'));
  }

  function updateExportBar() {
    const n = selectedIds.length;
    exportCountEl.textContent = n + ' selected';
    exportBar.classList.toggle('visible', selectMode);
    const hasSelection = n > 0;
    btnArchiveSel.disabled = !hasSelection;
    btnTagSel.disabled     = !hasSelection;
    btnExportSel.disabled  = !hasSelection;
    btnDeleteSel.disabled  = !hasSelection;
    const visibleCount = cardList.querySelectorAll('.card[tabindex="0"]').length;
    btnSelAll.classList.toggle('all-selected', n > 0 && n === visibleCount);
    btnSelAll.title = (n > 0 && n === visibleCount) ? 'Deselect all' : 'Select all visible notes';
  }

  btnSelect.addEventListener('click', () => {
    if (selectMode) { exitSelectMode(); return; }
    selectMode = true;
    btnSelect.classList.add('active');
    btnSelect.title = 'Exit selection mode';
    cardList.classList.add('select-mode');
    syncOverflowActive();
    updateExportBar();
  });


  // Select / deselect all visible
  btnSelAll.addEventListener('click', () => {
    const allCards = [...cardList.querySelectorAll('.card[tabindex="0"]')];
    const allSelected = allCards.length > 0 && allCards.every(c => selectedIds.includes(c.dataset.id));
    if (allSelected) {
      selectedIds = [];
      allCards.forEach(c => c.classList.remove('selected'));
    } else {
      selectedIds = allCards.map(c => c.dataset.id);
      allCards.forEach(c => c.classList.add('selected'));
    }
    updateExportBar();
  });

  btnArchiveSel.addEventListener('click', () => {
    if (selectedIds.length === 0) return;
    vscode.postMessage({ type: 'bulkArchive', noteIds: [...selectedIds] });
    exitSelectMode();
  });

  btnTagSel.addEventListener('click', () => {
    if (selectedIds.length === 0) return;
    vscode.postMessage({ type: 'bulkTag', noteIds: [...selectedIds] });
    exitSelectMode();
  });

  btnExportSel.addEventListener('click', () => {
    if (selectedIds.length === 0) return;
    vscode.postMessage({ type: 'exportNotes', noteIds: [...selectedIds] });
    exitSelectMode();
  });

  btnDeleteSel.addEventListener('click', () => {
    if (selectedIds.length === 0) return;
    vscode.postMessage({ type: 'bulkDelete', noteIds: [...selectedIds] });
    exitSelectMode();
  });

  btnCancelSel.addEventListener('click', exitSelectMode);

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && selectMode) exitSelectMode();
  });

  // ── Init ────────────────────────────────────────────────────────────────
  vscode.postMessage({ type: 'ready' });

  window.addEventListener('message', ({ data: msg }) => {
    if (msg.type === 'setCodeLink') {
      if (pendingCodeLinkCallback) {
        pendingCodeLinkCallback(msg.file ?? null, msg.line ?? null);
        pendingCodeLinkCallback = null;
      }
      return;
    }
    if (msg.type === 'lucideSearchResults') {
      if (iconSearchResultsCb) iconSearchResultsCb(msg.icons);
      return;
    }
    if (msg.type === 'imageReady') {
      const pending = pendingImageInsertions.get(msg.noteId);
      pendingImageInsertions.delete(msg.noteId);
      if (pending) {
        const imgEl = document.createElement('img');
        imgEl.src = msg.src;
        imgEl.alt = 'image';
        imgEl.setAttribute('data-storage-path', msg.storagePath);
        imgEl.style.cssText = 'max-width:100%;border-radius:4px;margin:4px 0;display:block;';
        const { range, preview: targetPreview } = pending;
        if (range && targetPreview.contentEditable === 'true') {
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
          range.deleteContents();
          range.insertNode(imgEl);
          const after = document.createRange();
          after.setStartAfter(imgEl);
          after.collapse(true);
          sel.removeAllRanges();
          sel.addRange(after);
        } else {
          targetPreview.appendChild(imgEl);
        }
        targetPreview.dispatchEvent(new Event('input'));
      }
      return;
    }
    if (msg.type === 'init') {
      const incomingIds = new Set((msg.notes ?? []).map(n => n.id));
      const addedId     = knownNoteIds !== null
        ? [...incomingIds].find(id => !knownNoteIds.has(id)) ?? null
        : null;
      knownNoteIds = incomingIds;

      notes         = msg.notes         ?? [];
      tags          = msg.tags          ?? [];
      templates     = msg.templates     ?? [];
      defaultTagIds = msg.defaultTagIds ?? [];
      customColors        = msg.customColors        ?? [];
      hiddenDefaultColors = msg.hiddenDefaultColors ?? [];
      hiddenDefaultIcons  = msg.hiddenDefaultIcons  ?? [];
      savedIconSvgs       = msg.savedIconSvgs       ?? [];
      imageUriMap   = msg.imageUriMap   ?? {};
      currentBranch     = msg.currentBranch     ?? null;
      currentUser       = msg.currentUser       ?? null;
      availableBranches = msg.availableBranches ?? [];
      githubConnected   = msg.githubConnected   ?? false;
      if (msg.projectName) projectName.innerHTML = '<span class="pill-primary">' + ${jsSvg.folderGit} + '<span class="pill-label">' + esc(msg.projectName) + '</span></span><span class="pill-action"><span class="pill-action-inner"><span class="pill-copy">' + ${jsSvg.folderOpen} + '<span class="pill-label">Open folder</span><span class="pill-sep">·</span></span><span class="pill-copy">' + ${jsSvg.folderOpen} + '<span class="pill-label">Open folder</span><span class="pill-sep">·</span></span><span class="pill-copy">' + ${jsSvg.folderOpen} + '<span class="pill-label">Open folder</span><span class="pill-sep">·</span></span></span></span>';
      // Show mine-filter button only when another user's note exists in this repo
      const hasOtherOwners = currentUser && notes.some(n => n.owner && n.owner !== currentUser);
      btnMineFilter.style.display = hasOtherOwners ? '' : 'none';
      // Show stale filter only when at least one stale note exists
      const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
      const hasStale = notes.some(n => !n.archived && n.updatedAt <= cutoff &&
        (n.remindAt && n.remindAt < Date.now() || /- \[ \]/.test(n.content ?? '') || n.codeLinkStale));
      btnStaleFilter.style.display = hasStale ? '' : 'none';
      updateSetupBanner(githubConnected, msg.mcpRegistered ?? false, msg.bannerDismissed ?? false);
      // Drop filter state for tags that no longer exist
      activeTagIds = activeTagIds.filter(id => tags.some(t => t.id === id));
      renderBranchIndicator();
      renderTagBar();
      renderCards();
      if (addedId) {
        requestAnimationFrame(() => {
          const newCard = cardList.querySelector('[data-id="' + addedId + '"]');
          if (newCard) {
            newCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            newCard.classList.add('highlight-new');
            setTimeout(() => newCard.classList.remove('highlight-new'), 1200);
          }
        });
      }
      if (lastSavedNoteId) {
        const savedId = lastSavedNoteId;
        lastSavedNoteId = null;
        requestAnimationFrame(() => {
          const savedCard = cardList.querySelector('[data-id="' + savedId + '"]');
          if (savedCard) savedCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        });
      }
      renderNewNoteTags();
      renderCardTemplatePicker();
      buildColorStrip(tagColorsEl, c => { tagColor = c; highlightSwatch(tagColorsEl, c); updateConfirmBtn(); });
      highlightSwatch(tagColorsEl, tagColor);
      if (addTagForm.classList.contains('open')) buildFormIconPicker();
    }

  });

  // ── Search ──────────────────────────────────────────────────────────────
  searchEl.addEventListener('input', () => {
    searchQuery = searchEl.value.toLowerCase();
    searchClearEl.style.display = searchQuery ? 'flex' : 'none';
    renderCards();
  });
  searchClearEl.addEventListener('click', () => {
    searchQuery = '';
    searchEl.value = '';
    searchClearEl.style.display = 'none';
    searchEl.focus();
    renderCards();
  });
  searchEl.addEventListener('keydown', e => {
    if (e.key === 'Escape' && searchQuery) {
      searchQuery = '';
      searchEl.value = '';
      searchClearEl.style.display = 'none';
      renderCards();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      const first = cardList.querySelector('.card[tabindex="0"]');
      if (first) first.focus();
    }
  });

  // ── New note ────────────────────────────────────────────────────────────
  document.getElementById('btn-new').addEventListener('click', openDraftCard);
  noteCardOverlay.addEventListener('click', e => {
    if (e.target === noteCardOverlay) closeNewForm();
  });
  document.getElementById('btn-cancel-new').addEventListener('click', closeNewForm);
  document.getElementById('btn-confirm-new').addEventListener('click', confirmNewNote);
  newTitleEl.addEventListener('keydown', e => {
    if (e.key === 'Enter')  { e.preventDefault(); newBodyEl.focus(); }
    if (e.key === 'Escape') closeNewForm();
  });
  newBodyEl.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeNewForm();
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); confirmNewNote(); }
  });

  document.querySelectorAll('.fmt-btn[data-cmd]').forEach(btn => {
    btn.addEventListener('mousedown', e => {
      e.preventDefault(); // keep Tiptap selection intact
      window.SidebarEditor?.toggleFormat(btn.dataset.cmd);
      updateFmtBar();
    });
  });

  document.addEventListener('selectionchange', () => {
    if (newBodyEl.contains(document.getSelection()?.anchorNode)) updateFmtBar();
  });

  function updateFmtBar() {
    document.querySelectorAll('.fmt-btn[data-cmd]').forEach(btn => {
      btn.classList.toggle('active', window.SidebarEditor?.isActive(btn.dataset.cmd) ?? false);
    });
  }

  // ── Inline draft card ────────────────────────────────────────────────────
  function openDraftCard() {
    closeDraftCard();
    const card = mkEl('div', 'card draft-card');
    card.setAttribute('role', 'listitem');

    // ── Row 1: Title ──
    const row1 = mkEl('div', 'card-row-1');
    const titleInput = mkEl('input', 'card-title');
    titleInput.type         = 'text';
    titleInput.placeholder  = 'Note title…';
    titleInput.maxLength    = 120;
    titleInput.autocomplete = 'off';
    titleInput.setAttribute('aria-label', 'New note title');
    row1.appendChild(titleInput);
    card.appendChild(row1);

    // ── Row 2: Tags + Template ──
    let draftTags = [];
    let draftTemplateId = null;
    let tplPickerEl = null;
    let tplChipBtn = null;
    const row2 = mkEl('div', 'card-row-2');

    const pillsArea = mkEl('div', 'draft-pills');
    row2.appendChild(pillsArea);

    const ghostBtn = mkEl('button', 'tag-ghost');
    ghostBtn.title = 'Add tag';
    row2.appendChild(ghostBtn);

    const tagPickerEl = mkEl('div', 'draft-tag-picker');
    tagPickerEl.style.display = 'none';
    row2.appendChild(tagPickerEl);

    function syncChipStates() {
      tagPickerEl.querySelectorAll('.tag-chip[data-tid]').forEach(chip => {
        const isActive = draftTags.includes(chip.dataset.tid);
        chip.classList.toggle('active', isActive);
        const tag = tags.find(t => t.id === chip.dataset.tid);
        if (tag) applyChipStyle(chip, tag.color, isActive);
      });
    }

    function updateTagPills() {
      pillsArea.innerHTML = '';
      draftTags.forEach(tid => {
        const tag = tags.find(t => t.id === tid);
        if (!tag) return;
        const pill = mkEl('span', 'tag-pill');
        applyPillStyle(pill, tag.color);
        if (tag.iconSvg) { const ico = mkEl('span', 'tag-icon'); ico.innerHTML = tag.iconSvg; pill.appendChild(ico); }
        pill.appendChild(mkEl('span', 'chip-label', tag.label));
        pillsArea.appendChild(pill);
      });
      ghostBtn.innerHTML = draftTags.length === 0 ? ${jsSvg.tagSmall} + 'tag' : ${jsSvg.tagSmall};
    }

    buildTagPicker(tagPickerEl, () => draftTags, (id) => {
      draftTags = draftTags.includes(id) ? draftTags.filter(i => i !== id) : [...draftTags, id];
      syncChipStates();
      updateTagPills();
    });

    if (tags.length > 0) {
      ghostBtn.addEventListener('mousedown', e => {
        e.preventDefault();
        if (tplPickerEl) tplPickerEl.style.display = 'none';
        const isOpen = tagPickerEl.style.display !== 'none';
        tagPickerEl.style.display = isOpen ? 'none' : '';
      });
    } else {
      ghostBtn.disabled = true;
    }

    if (templates.length > 0) {
      tplChipBtn = mkEl('button', 'tag-ghost');
      tplChipBtn.innerHTML = ${jsSvg.tplSmall} + 'template';
      tplChipBtn.title = 'Apply a template';
      row2.appendChild(tplChipBtn);

      tplPickerEl = mkEl('div', 'draft-tag-picker');
      tplPickerEl.style.display = 'none';
      row2.appendChild(tplPickerEl);

      function applyTemplate(tpl) {
        draftTemplateId = tpl ? tpl.id : null;
        tplChipBtn.innerHTML = tpl ? ${jsSvg.tplSmall} + esc(tpl.name) : ${jsSvg.tplSmall} + 'template';
        tplChipBtn.classList.toggle('active', !!tpl);
        if (tpl) {
          if (tpl.content) { preview.innerHTML = simpleMarkdown(tpl.content); }
          preview.toggleAttribute('data-empty', !tpl.content?.trim());
          if (tpl.tags?.length) { draftTags = [...tpl.tags]; syncChipStates(); updateTagPills(); }
        } else {
          preview.innerHTML = '';
          preview.toggleAttribute('data-empty', true);
          draftTags = []; syncChipStates(); updateTagPills();
        }
        tplPickerEl.style.display = 'none';
      }

      const blankItem = mkEl('button', 'tag-chip');
      blankItem.textContent = 'Blank';
      blankItem.style.background = 'var(--vscode-badge-background)';
      blankItem.addEventListener('mousedown', e => { e.preventDefault(); applyTemplate(null); });
      tplPickerEl.appendChild(blankItem);

      templates.forEach(tpl => {
        const item = mkEl('button', 'tag-chip');
        item.textContent = tpl.name;
        item.style.background = 'var(--vscode-badge-background)';
        item.addEventListener('mousedown', e => { e.preventDefault(); applyTemplate(tpl); });
        tplPickerEl.appendChild(item);
      });

      tplChipBtn.addEventListener('mousedown', e => {
        e.preventDefault();
        tagPickerEl.style.display = 'none';
        const isOpen = tplPickerEl.style.display !== 'none';
        tplPickerEl.style.display = isOpen ? 'none' : '';
      });
    }

    // Branch scope chip
    let draftBranchScope = branchFilterActive && !!currentBranch;
    if (currentBranch) {
      const branchChip = mkEl('button', 'tag-ghost');
      branchChip.classList.toggle('active', draftBranchScope);
      branchChip.innerHTML = ${jsSvg.branchSmall} + esc(currentBranch);
      branchChip.title = draftBranchScope ? 'Remove branch scope' : 'Pin to ' + currentBranch;
      branchChip.addEventListener('mousedown', e => {
        e.preventDefault();
        draftBranchScope = !draftBranchScope;
        branchChip.classList.toggle('active', draftBranchScope);
        branchChip.title = draftBranchScope ? 'Remove branch scope' : 'Pin to ' + currentBranch;
      });
      row2.appendChild(branchChip);
    }

    // Link to current file chip
    let draftCodeLink = null;
    const fileLinkChip = mkEl('button', 'tag-ghost');
    fileLinkChip.title = 'Link to current editor file and line';

    function renderFileLinkChip() {
      if (draftCodeLink) {
        const shortName = draftCodeLink.file.split('/').pop() || draftCodeLink.file;
        fileLinkChip.className = 'tag-ghost active';
        fileLinkChip.innerHTML = ${jsSvg.codeLinkIcon} + esc(shortName + ':' + draftCodeLink.line)
          + '<span class="draft-link-remove"> ×</span>';
      } else {
        fileLinkChip.className = 'tag-ghost';
        fileLinkChip.innerHTML = ${jsSvg.codeLinkIcon} + 'link file';
      }
    }
    renderFileLinkChip();

    fileLinkChip.addEventListener('mousedown', e => {
      e.preventDefault();
      if (e.target.closest('.draft-link-remove')) {
        draftCodeLink = null; renderFileLinkChip(); return;
      }
      if (draftCodeLink) return;
      vscode.postMessage({ type: 'requestCodeLink' });
      pendingCodeLinkCallback = (file, line) => {
        if (file) draftCodeLink = { file, line };
        renderFileLinkChip();
      };
    });
    row2.appendChild(fileLinkChip);

    updateTagPills();
    card.appendChild(row2);

    // ── Row 3: Content ──
    const row3 = mkEl('div', 'card-row-3');
    const contentWrap = mkEl('div', 'card-content');
    const preview = mkEl('div', 'card-preview');
    preview.contentEditable = 'true';
    preview.setAttribute('data-placeholder', 'Start writing…');
    preview.setAttribute('aria-label', 'Note content');
    preview.toggleAttribute('data-empty', true);
    preview.addEventListener('input', () => preview.toggleAttribute('data-empty', preview.textContent.trim() === '' && !preview.querySelector('img')));
    contentWrap.appendChild(preview);
    row3.appendChild(contentWrap);
    card.appendChild(row3);

    // ── Row 4: Footer ──
    const footer = mkEl('div', 'card-row-4');
    const leftSlot  = mkEl('span', 'card-foot-slot card-foot-slot-left');
    const rightSlot = mkEl('span', 'card-foot-slot card-foot-slot-right');
    if (currentUser) {
      const circle  = mkEl('span', 'owner-initials', initials(currentUser));
      const nameEl  = mkEl('span', 'owner-name', currentUser.split(/\s+/)[0] || currentUser);
      const badge   = mkEl('span', 'owner-badge');
      badge.title   = currentUser;
      badge.append(circle, nameEl);
      leftSlot.appendChild(badge);
    }
    const nowEl = mkEl('span', 'card-date', 'just now');
    rightSlot.appendChild(nowEl);
    footer.append(leftSlot, rightSlot);
    card.appendChild(footer);

    // ── Format bar (swaps with footer while editing preview) ──
    const fmtBar = buildFormatBar(preview, footer);
    card.appendChild(fmtBar);
    preview.addEventListener('blur', () => { fmtBar.style.display = 'none'; footer.style.display = ''; });

    // ── Commit / discard ──
    function commit() {
      const title = titleInput.value.trim();
      const body  = htmlToMarkdown(preview.innerHTML).trim() || undefined;
      pendingCodeLinkCallback = null;
      closeDraftCard();
      if (title) {
        const branch   = draftBranchScope && currentBranch ? currentBranch : undefined;
        const codeLink = draftCodeLink || undefined;
        vscode.postMessage({ type: 'createNote', title, tags: [...draftTags], templateId: draftTemplateId || undefined, branch, codeLink, body });
      }
    }

    titleInput.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) { e.preventDefault(); preview.focus(); }
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); commit(); }
      if (e.key === 'Escape') closeDraftCard();
    });
    preview.addEventListener('keydown', e => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); commit(); }
      if (e.key === 'Escape') closeDraftCard();
    });

    // Close pickers when clicking elsewhere inside the card
    card.addEventListener('mousedown', e => {
      if (!tagPickerEl.contains(e.target) && e.target !== ghostBtn)
        tagPickerEl.style.display = 'none';
      if (tplPickerEl && !tplPickerEl.contains(e.target) && e.target !== tplChipBtn)
        tplPickerEl.style.display = 'none';
    });

    const wrapper = document.createElement('div');
    wrapper.id = 'draft-card';
    wrapper.appendChild(card);
    cardList.prepend(wrapper);

    // Click outside the draft card → commit (if title filled) or discard
    draftOutsideListener = e => {
      if (!wrapper.contains(e.target)) {
        document.removeEventListener('mousedown', draftOutsideListener);
        draftOutsideListener = null;
        commit();
      }
    };
    // Defer so this mousedown (opening the card) doesn't immediately trigger it
    setTimeout(() => document.addEventListener('mousedown', draftOutsideListener), 0);
    titleInput.focus();
  }

  function closeDraftCard() {
    if (draftOutsideListener) {
      document.removeEventListener('mousedown', draftOutsideListener);
      draftOutsideListener = null;
    }
    document.getElementById('draft-card')?.remove();
  }

  function closeNewForm() {
    noteCardOverlay.classList.remove('open');
    newTitleEl.value = '';
    window.SidebarEditor?.clear();
    newTags       = [];
    newTemplateId = null;
    const scopeCheckbox = document.getElementById('new-branch-scope');
    if (scopeCheckbox) scopeCheckbox.checked = false;
    renderCardTemplatePicker();
    renderNewNoteTags();
  }

  function renderCardTemplatePicker() {
    if (!newTemplateSelectEl) return;
    newTemplateSelectEl.innerHTML = '';
    const blank = document.createElement('option');
    blank.value = '';
    blank.textContent = 'Blank';
    newTemplateSelectEl.appendChild(blank);
    templates.forEach(tpl => {
      const opt = document.createElement('option');
      opt.value = tpl.id;
      opt.textContent = tpl.name;
      newTemplateSelectEl.appendChild(opt);
    });
    newTemplateSelectEl.value = newTemplateId ?? '';
  }

  newTemplateSelectEl.addEventListener('change', () => {
    const id = newTemplateSelectEl.value || null;
    newTemplateId = id;
    if (!id) {
      newTags = [];
    } else {
      const tpl = templates.find(t => t.id === id);
      if (tpl?.tags?.length) newTags = [...tpl.tags];
    }
    renderNewNoteTags();
  });
  function confirmNewNote() {
    const title = newTitleEl.value.trim();
    if (!title) { newTitleEl.focus(); return; }
    const scopeCheckbox = document.getElementById('new-branch-scope');
    const branch = scopeCheckbox?.checked && currentBranch ? currentBranch : undefined;
    const body = window.SidebarEditor?.getMarkdown().trim() || undefined;
    vscode.postMessage({ type: 'createNote', title, tags: [...newTags], templateId: newTemplateId, branch, body });
    closeNewForm();
  }

  function renderNewNoteTags() {
    newTagsEl.innerHTML = '';
    if (tags.length === 0) return;
    tags.forEach(tag => {
      const isActiveNew = newTags.includes(tag.id);
      const chip = mkEl('button', 'tag-chip' + (isActiveNew ? ' active' : ''));
      chip.type = 'button';
      if (tag.iconSvg) { const ico = mkEl('span', 'tag-icon'); ico.innerHTML = tag.iconSvg; chip.appendChild(ico); }
      chip.appendChild(mkEl('span', 'chip-text', tag.label));
      applyChipStyle(chip, tag.color, isActiveNew);
      chip.addEventListener('click', () => {
        newTags = newTags.includes(tag.id)
          ? newTags.filter(id => id !== tag.id)
          : [...newTags, tag.id];
        renderNewNoteTags();
      });
      newTagsEl.appendChild(chip);
    });
  }

  function renderBranchIndicator() {
    if (currentBranch) {
      branchPillEl.innerHTML = '<span class="pill-primary">' + ${jsSvg.branch} + '<span class="pill-label">' + esc(currentBranch) + '</span></span><span class="pill-action"><span class="pill-action-inner"><span class="pill-copy">' + ${jsSvg.branchSwitch} + '<span class="pill-label">Switch branch</span><span class="pill-sep">·</span></span><span class="pill-copy">' + ${jsSvg.branchSwitch} + '<span class="pill-label">Switch branch</span><span class="pill-sep">·</span></span><span class="pill-copy">' + ${jsSvg.branchSwitch} + '<span class="pill-label">Switch branch</span><span class="pill-sep">·</span></span></span></span>';
      branchPillEl.classList.add('visible');
      branchFilterBtn.style.display = availableBranches.length > 1 ? '' : 'none';
      branchScopeLabel.classList.add('visible');
      branchScopeNameEl.textContent = currentBranch;
    } else {
      branchPillEl.classList.remove('visible');
      branchFilterBtn.style.display = 'none';
      branchScopeLabel.classList.remove('visible');
    }
    const otherBranches = availableBranches.filter(b => b !== currentBranch);
    branchPillEl.classList.toggle('can-switch', otherBranches.length > 0);
  }

  branchPillEl.addEventListener('click', () => {
    if (branchPillEl.classList.contains('can-switch')) {
      vscode.postMessage({ type: 'switchBranch' });
    }
  });

  // ── Tag bar ─────────────────────────────────────────────────────────────
  let draggedTagId = null;

  function renderTagBar() {
    const openPop = document.querySelector('.tag-chip-color-pop.open');
    const savedPop = openPop ? {
      tagId:      openPop.dataset.tagId,
      pickerOpen: openPop.dataset.pickerOpen === '1'
    } : null;
    document.querySelectorAll('.tag-chip-color-pop').forEach(p => p.remove());
    tagBar.innerHTML = '';

    const all = mkEl('button', 'tag-chip all' + (activeTagIds.length === 0 ? ' active' : ''), 'All');
    all.addEventListener('click', () => { activeTagIds = []; renderTagBar(); renderCards(); });
    tagBar.appendChild(all);

    tags.forEach(tag => {
      const isDefault = defaultTagIds.includes(tag.id);

      const isActiveFilter = activeTagIds.includes(tag.id);
      const chip = mkEl('button', 'tag-chip' + (isActiveFilter ? ' active' : ''));
      applyChipStyle(chip, tag.color, isActiveFilter);
      if (tag.iconSvg) { const ico = mkEl('span', 'tag-icon'); ico.innerHTML = tag.iconSvg; chip.appendChild(ico); }
      const labelSpan = mkEl('span', 'tag-chip-label', tag.label);
      chip.appendChild(labelSpan);

      // ── Right-click context popup (all tags) ─────────────────────────
      const colorPop = mkEl('div', 'tag-chip-color-pop');
      colorPop.dataset.tagId = tag.id;
      colorPop.addEventListener('click', e => e.stopPropagation());

      // ── 1. Rename ─────────────────────────────────────────────────
      const renameWrap = mkEl('div', 'tag-label-wrap');
      const renameInput = document.createElement('input');
      renameInput.type = 'text';
      renameInput.className = 'tag-chip-pop-input';
      renameInput.value = tag.label;
      renameInput.placeholder = 'Enter tag name';
      renameInput.maxLength = 24;
      const renameCounter = mkEl('span', 'tag-label-counter' + (tag.label.length > 0 ? ' visible' : '') + (tag.label.length >= 20 ? ' near-limit' : ''));
      renameCounter.textContent = tag.label.length + '/24';
      renameInput.addEventListener('click', e => e.stopPropagation());
      renameInput.addEventListener('input', e => {
        const len = renameInput.value.length;
        renameCounter.textContent = len + '/24';
        renameCounter.classList.toggle('visible', len > 0);
        renameCounter.classList.toggle('near-limit', len >= 20);
      });
      renameInput.addEventListener('keydown', e => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          const newLabel = renameInput.value.trim();
          colorPop.classList.remove('open');
          if (newLabel && newLabel !== tag.label) {
            vscode.postMessage({ type: 'updateTag', id: tag.id, changes: { label: newLabel } });
          }
        }
        if (e.key === 'Escape') colorPop.classList.remove('open');
      });
      renameWrap.appendChild(renameInput);
      renameWrap.appendChild(renameCounter);
      colorPop.appendChild(renameWrap);
      colorPop.appendChild(mkEl('div', 'tag-chip-pop-sep'));

      // ── 2. Icon ───────────────────────────────────────────────────
      const iconGrid = mkEl('div', 'tag-icon-picker');
      const noneSw = mkEl('button', 'tag-icon-swatch none-swatch' + (!tag.icon ? ' selected' : ''));
      noneSw.type = 'button'; noneSw.title = 'No icon'; noneSw.innerHTML = ${jsSvg.popNone};
      noneSw.addEventListener('click', e => {
        e.stopPropagation();
        if (tag.icon) vscode.postMessage({ type: 'updateTag', id: tag.id, changes: { icon: null } });
      });
      iconGrid.appendChild(noneSw);
      DEFAULT_TAG_ICONS.filter(e => !hiddenDefaultIcons.includes(e.name)).forEach(entry => {
        const wrap = mkEl('div', 'custom-swatch-wrap');
        const sw = mkEl('button', 'tag-icon-swatch' + (tag.icon === entry.name ? ' selected' : ''));
        sw.type = 'button'; sw.title = entry.name; sw.innerHTML = entry.svg;
        sw.addEventListener('click', e => {
          e.stopPropagation();
          if (tag.icon !== entry.name) vscode.postMessage({ type: 'updateTag', id: tag.id, changes: { icon: entry.name } });
        });
        const swDel = mkEl('button', 'custom-swatch-del');
        swDel.type = 'button'; swDel.title = 'Hide icon'; swDel.textContent = '×';
        swDel.addEventListener('click', e => {
          e.stopPropagation();
          vscode.postMessage({ type: 'hideDefaultIcon', name: entry.name });
        });
        wrap.appendChild(sw); wrap.appendChild(swDel); iconGrid.appendChild(wrap);
      });

      savedIconSvgs.forEach(({ name, svg }) => {
        iconGrid.appendChild(mkSavedIconSwatch(name, svg, tag.icon === name, () => {
          if (tag.icon !== name) vscode.postMessage({ type: 'updateTag', id: tag.id, changes: { icon: name } });
        }));
      });

      const iconAddBtn = mkEl('button', 'tag-chip-color-custom-btn');
      iconAddBtn.type = 'button'; iconAddBtn.title = 'Add icon'; iconAddBtn.textContent = '+';
      iconGrid.appendChild(iconAddBtn);
      colorPop.appendChild(iconGrid);

      // Search panel (hidden until + clicked)
      const iconSearchWrap = mkEl('div', 'my-icons-search-wrap');
      iconSearchWrap.style.display = 'none';
      const iconSearchInput = document.createElement('input');
      iconSearchInput.type = 'text'; iconSearchInput.className = 'tag-chip-pop-input';
      iconSearchInput.placeholder = 'Search Lucide icons…'; iconSearchInput.spellcheck = false;
      iconSearchInput.addEventListener('click', e => e.stopPropagation());
      let iconSearchTimer = null;
      iconSearchInput.addEventListener('input', () => {
        clearTimeout(iconSearchTimer);
        iconSearchTimer = setTimeout(() => {
          vscode.postMessage({ type: 'searchLucideIcons', query: iconSearchInput.value.trim() });
        }, 150);
      });
      iconSearchInput.addEventListener('keydown', e => {
        e.stopPropagation();
        if (e.key === 'Escape') closeIconSearch();
      });
      const iconSearchResults = mkEl('div', 'my-icons-results');
      iconSearchWrap.appendChild(iconSearchInput);
      iconSearchWrap.appendChild(iconSearchResults);
      colorPop.appendChild(iconSearchWrap);

      function closeIconSearch() {
        iconAddBtn.classList.remove('active');
        iconSearchWrap.style.display = 'none';
        iconSearchInput.value = ''; iconSearchResults.innerHTML = '';
        iconSearchResultsCb = null;
      }

      iconAddBtn.addEventListener('click', e => {
        e.stopPropagation();
        const opening = iconSearchWrap.style.display === 'none';
        if (opening) {
          iconAddBtn.classList.add('active');
          iconSearchWrap.style.display = '';
          iconSearchResultsCb = icons => {
            iconSearchResults.innerHTML = '';
            if (icons.length === 0 && iconSearchInput.value.trim()) {
              iconSearchResults.appendChild(mkEl('div', 'my-icons-empty', 'No icons found'));
              return;
            }
            icons.forEach(({ name, svg }) => {
              const alreadySaved = savedIconSvgs.some(s => s.name === name);
              const sw = mkEl('button', 'tag-icon-swatch' + (tag.icon === name ? ' selected' : alreadySaved ? ' saved' : ''));
              sw.type = 'button'; sw.title = alreadySaved ? name + ' (already saved)' : name; sw.innerHTML = svg;
              sw.addEventListener('click', e => {
                e.stopPropagation();
                vscode.postMessage({ type: 'addSavedIcon', name });
                if (tag.icon !== name) vscode.postMessage({ type: 'updateTag', id: tag.id, changes: { icon: name } });
              });
              iconSearchResults.appendChild(sw);
            });
          };
          setTimeout(() => iconSearchInput.focus(), 0);
        } else {
          closeIconSearch();
        }
      });

      colorPop.appendChild(mkEl('div', 'tag-chip-pop-sep'));

      // ── 3. Color ──────────────────────────────────────────────────
      const isCustomColor = !COLOR_KEYS.some(k => COLORS[k] === tag.color);

      // HSV state (shared between canvas picker, hue slider, hex input, and palette clicks)
      let [pickerH, pickerS, pickerV] = (tag.color && /^#[0-9a-fA-F]{6}$/.test(tag.color))
        ? hexToHsv(tag.color) : [0, 0, 80];

      // Hex row (dot + input) — lives inside the custom picker wrap
      const hexDot = mkEl('div', 'tag-chip-hex-dot');
      hexDot.style.background = (tag.color && tag.color[0] === '#') ? tag.color : 'var(--vscode-foreground)';
      const hexInput = document.createElement('input');
      hexInput.type = 'text'; hexInput.className = 'tag-chip-pop-input';
      hexInput.placeholder = '#rrggbb'; hexInput.maxLength = 8;
      hexInput.value = tag.color && tag.color[0] === '#' ? tag.color : '';
      hexInput.addEventListener('click', e => e.stopPropagation());

      // Canvas SV picker
      const pickerCanvas = document.createElement('canvas');
      pickerCanvas.className = 'color-picker-canvas';
      pickerCanvas.width = 176; pickerCanvas.height = 100;

      function drawPickerCanvas() {
        const ctx = pickerCanvas.getContext('2d');
        const w = pickerCanvas.width, h = pickerCanvas.height;
        const gH = ctx.createLinearGradient(0,0,w,0);
        gH.addColorStop(0, '#fff'); gH.addColorStop(1, \`hsl(\${pickerH},100%,50%)\`);
        ctx.fillStyle = gH; ctx.fillRect(0,0,w,h);
        const gV = ctx.createLinearGradient(0,0,0,h);
        gV.addColorStop(0, 'rgba(0,0,0,0)'); gV.addColorStop(1, '#000');
        ctx.fillStyle = gV; ctx.fillRect(0,0,w,h);
        const cx = pickerS/100*w, cy = (1-pickerV/100)*h;
        ctx.beginPath(); ctx.arc(cx,cy,5,0,Math.PI*2);
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
        ctx.beginPath(); ctx.arc(cx,cy,5,0,Math.PI*2);
        ctx.strokeStyle = 'rgba(0,0,0,.5)'; ctx.lineWidth = 1; ctx.stroke();
      }
      pickerCanvas._draw = drawPickerCanvas;

      function applyPickerColor(save) {
        const hex = hsvToHex(pickerH, pickerS, pickerV);
        hexDot.style.background = hex; hexInput.value = hex;
        if (save) vscode.postMessage({ type: 'updateTag', id: tag.id, changes: { color: hex } });
      }

      function canvasPos(e) {
        const r = pickerCanvas.getBoundingClientRect();
        return [
          Math.max(0, Math.min(1, (e.clientX-r.left)/r.width))*100,
          Math.max(0, Math.min(1, 1-(e.clientY-r.top)/r.height))*100
        ];
      }
      let canvasDragging = false;
      pickerCanvas.addEventListener('pointerdown', e => {
        e.stopPropagation(); pickerCanvas.setPointerCapture(e.pointerId);
        canvasDragging = true;
        [pickerS, pickerV] = canvasPos(e); drawPickerCanvas(); applyPickerColor(false);
      });
      pickerCanvas.addEventListener('pointermove', e => {
        if (!canvasDragging) return;
        [pickerS, pickerV] = canvasPos(e); drawPickerCanvas(); applyPickerColor(false);
      });
      pickerCanvas.addEventListener('pointerup', e => {
        if (!canvasDragging) return;
        canvasDragging = false; applyPickerColor(true);
      });

      // Hue slider
      const hueSlider = document.createElement('input');
      hueSlider.type = 'range'; hueSlider.min = '0'; hueSlider.max = '360';
      hueSlider.className = 'color-picker-hue'; hueSlider.value = String(Math.round(pickerH));
      hueSlider.addEventListener('click', e => e.stopPropagation());
      hueSlider.addEventListener('input', e => {
        e.stopPropagation(); pickerH = +hueSlider.value;
        drawPickerCanvas(); applyPickerColor(false);
      });
      hueSlider.addEventListener('change', e => { e.stopPropagation(); applyPickerColor(true); });

      // Hex input wired to canvas state
      hexInput.addEventListener('input', () => {
        let v = hexInput.value;
        if (v && v[0] !== '#') { v = '#' + v; hexInput.value = v; }
        if (/^#[0-9a-fA-F]{6}$/.test(v)) {
          [pickerH, pickerS, pickerV] = hexToHsv(v);
          hueSlider.value = String(Math.round(pickerH));
          hexDot.style.background = v; drawPickerCanvas();
        }
      });
      hexInput.addEventListener('keydown', e => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          let v = hexInput.value.trim();
          if (v && v[0] !== '#') v = '#' + v;
          if (/^#[0-9a-fA-F]{6}$/.test(v)) {
            colorPop.classList.remove('open');
            vscode.postMessage({ type: 'updateTag', id: tag.id, changes: { color: v } });
          } else {
            hexInput.style.outline = '1px solid red';
            setTimeout(() => { hexInput.style.outline = ''; }, 1000);
          }
        }
        if (e.key === 'Escape') colorPop.classList.remove('open');
      });

      // Custom picker wrap (canvas + hue slider + hex row)
      const hexRow = mkEl('div', 'tag-chip-hex-wrap');
      hexRow.style.display = 'flex';
      hexRow.appendChild(hexDot); hexRow.appendChild(hexInput);
      const colorPickerWrap = mkEl('div', 'color-picker-wrap');
      colorPickerWrap.appendChild(pickerCanvas);
      colorPickerWrap.appendChild(hueSlider);
      colorPickerWrap.appendChild(hexRow);

      // Palette swatches + custom "+" button
      const swatchGrid = mkEl('div', 'tag-chip-swatches');
      const colorNoneSw = mkEl('div', 'color-swatch default-swatch' + (tag.color === 'default' ? ' selected' : ''));
      colorNoneSw.dataset.colorHex = 'default';
      colorNoneSw.style.background = 'var(--vscode-foreground)';
      colorNoneSw.title = 'Default';
      colorNoneSw.textContent = '○';
      colorNoneSw.addEventListener('click', e => {
        e.stopPropagation();
        hexDot.style.background = 'var(--vscode-foreground)';
        hexInput.value = '';
        vscode.postMessage({ type: 'updateTag', id: tag.id, changes: { color: 'default' } });
      });
      swatchGrid.appendChild(colorNoneSw);
      COLOR_KEYS.filter(key => !hiddenDefaultColors.includes(COLORS[key])).forEach(key => {
        const wrap = mkEl('div', 'custom-swatch-wrap');
        const sw = mkEl('div', 'color-swatch' + (COLORS[key] === tag.color ? ' selected' : ''));
        sw.style.background = COLORS[key]; sw.dataset.colorHex = COLORS[key]; sw.title = key;
        sw.addEventListener('click', e => {
          e.stopPropagation();
          const hex = COLORS[key];
          [pickerH, pickerS, pickerV] = hexToHsv(hex);
          hueSlider.value = String(Math.round(pickerH));
          hexDot.style.background = hex; hexInput.value = hex;
          if (colorPickerWrap.classList.contains('open')) drawPickerCanvas();
          vscode.postMessage({ type: 'updateTag', id: tag.id, changes: { color: hex } });
        });
        const swDel = mkEl('button', 'custom-swatch-del');
        swDel.type = 'button'; swDel.title = 'Hide color'; swDel.textContent = '×';
        swDel.addEventListener('click', e => {
          e.stopPropagation();
          vscode.postMessage({ type: 'hideDefaultColor', color: COLORS[key] });
        });
        wrap.appendChild(sw); wrap.appendChild(swDel); swatchGrid.appendChild(wrap);
      });
      customColors.forEach(hex => {
        const wrap = mkEl('div', 'custom-swatch-wrap');
        const sw = mkEl('div', 'color-swatch' + (hex === tag.color ? ' selected' : ''));
        sw.style.background = hex; sw.dataset.colorHex = hex; sw.title = hex;
        sw.addEventListener('click', e => {
          e.stopPropagation();
          [pickerH, pickerS, pickerV] = hexToHsv(hex);
          hueSlider.value = String(Math.round(pickerH));
          hexDot.style.background = hex; hexInput.value = hex;
          if (colorPickerWrap.classList.contains('open')) drawPickerCanvas();
          vscode.postMessage({ type: 'updateTag', id: tag.id, changes: { color: hex } });
        });
        wrap.appendChild(sw);
        const swDel = mkEl('button', 'custom-swatch-del');
        swDel.type = 'button'; swDel.title = 'Remove saved color'; swDel.textContent = '×';
        swDel.addEventListener('click', e => {
          e.stopPropagation();
          vscode.postMessage({ type: 'removeCustomColor', color: hex });
        });
        wrap.appendChild(swDel); swatchGrid.appendChild(wrap);
      });
      const customBtn = mkEl('button', 'tag-chip-color-custom-btn');
      customBtn.type = 'button'; customBtn.title = 'Custom color'; customBtn.textContent = '+';
      customBtn.addEventListener('click', e => {
        e.stopPropagation();
        const opening = !colorPickerWrap.classList.contains('open');
        colorPickerWrap.classList.toggle('open', opening);
        customBtn.classList.toggle('active', opening);
        colorPop.dataset.pickerOpen = opening ? '1' : '0';
        if (opening) drawPickerCanvas();
      });
      swatchGrid.appendChild(customBtn);
      colorPop.appendChild(swatchGrid);
      colorPop.appendChild(colorPickerWrap);

      // ── 4. Delete ─────────────────────────────────────────────────
      colorPop.appendChild(mkEl('div', 'tag-chip-pop-danger-sep'));
      const delBtn = document.createElement('button');
      delBtn.className = 'ovf-item danger';
      const delIco = mkEl('span', 'ovf-icon'); delIco.innerHTML = ${jsSvg.popDelete};
      const delLbl = mkEl('span', 'ovf-label', 'Delete tag');
      delBtn.appendChild(delIco);
      delBtn.appendChild(delLbl);
      let delTimer = null;
      delBtn.addEventListener('click', e => {
        e.stopPropagation();
        if (delBtn.classList.contains('confirm')) {
          clearTimeout(delTimer);
          colorPop.classList.remove('open');
          vscode.postMessage({ type: 'deleteTag', id: tag.id });
        } else {
          const count = notes.filter(n => n.tags && n.tags.includes(tag.id)).length;
          const label = count === 0 ? 'Remove? (unused)' : 'Remove from ' + count + ' note' + (count === 1 ? '' : 's') + '?';
          delBtn.classList.replace('danger', 'confirm');
          delLbl.textContent = label;
          delTimer = setTimeout(() => {
            delBtn.classList.replace('confirm', 'danger');
            delLbl.textContent = 'Delete tag';
          }, 3000);
        }
      });
      colorPop.appendChild(delBtn);

      document.body.appendChild(colorPop);

      colorPop._anchor = chip;

      chip.addEventListener('contextmenu', e => {
        e.preventDefault();
        e.stopPropagation();
        const wasOpen = colorPop.classList.contains('open');
        document.querySelectorAll('.tag-chip-color-pop.open').forEach(p => p.classList.remove('open'));
        if (!wasOpen) {
          colorPop.classList.add('open');
          positionColorPop(colorPop);
        }
      });

      let dragMoved = false;
      chip.draggable = true;
      chip.addEventListener('dragstart', e => {
        dragMoved = false;
        draggedTagId = tag.id;
        chip.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
      });
      chip.addEventListener('drag', () => { dragMoved = true; });
      chip.addEventListener('dragend', () => {
        chip.classList.remove('dragging');
        tagBar.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
        draggedTagId = null;
      });
      chip.addEventListener('dragover', e => {
        if (!draggedTagId || draggedTagId === tag.id) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        tagBar.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
        chip.classList.add('drag-over');
      });
      chip.addEventListener('dragleave', () => chip.classList.remove('drag-over'));
      chip.addEventListener('drop', e => {
        e.preventDefault();
        chip.classList.remove('drag-over');
        if (!draggedTagId || draggedTagId === tag.id) return;
        const fromIdx = tags.findIndex(t => t.id === draggedTagId);
        const toIdx   = tags.findIndex(t => t.id === tag.id);
        if (fromIdx === -1 || toIdx === -1) return;
        const reordered = [...tags];
        const [moved] = reordered.splice(fromIdx, 1);
        reordered.splice(toIdx, 0, moved);
        tags = reordered;
        renderTagBar();
        vscode.postMessage({ type: 'reorderTags', ids: reordered.map(t => t.id) });
      });

      chip.addEventListener('click', () => {
        if (dragMoved) { dragMoved = false; return; }
        activeTagIds = activeTagIds.includes(tag.id)
          ? activeTagIds.filter(id => id !== tag.id)
          : [...activeTagIds, tag.id];
        renderTagBar();
        renderCards();
      });
      tagBar.appendChild(chip);
    });

    const addBtn = mkEl('button', 'add-tag-btn', '+ tag');
    addBtn.addEventListener('click', () => {
      tagColor = 'default';
      highlightSwatch(tagColorsEl, tagColor);
      addTagForm.classList.add('open');
      buildFormIconPicker();
      updateConfirmBtn();
      tagLabelEl.focus();
    });
    tagBar.appendChild(addBtn);

    if (savedPop) {
      const newPop = document.querySelector('.tag-chip-color-pop[data-tag-id="' + savedPop.tagId + '"]');
      if (newPop) {
        newPop.classList.add('open');
        positionColorPop(newPop);
        if (savedPop.pickerOpen) {
          const wrap   = newPop.querySelector('.color-picker-wrap');
          const btn    = newPop.querySelector('.tag-chip-color-custom-btn');
          const canvas = newPop.querySelector('.color-picker-canvas');
          if (wrap && btn && canvas) {
            wrap.classList.add('open');
            btn.classList.add('active');
            if (canvas._draw) canvas._draw();
          }
        }
      }
    }
  }

  // ── Add tag ─────────────────────────────────────────────────────────────
  const confirmTagBtn = document.getElementById('btn-confirm-tag');

  function updateConfirmBtn() {
    const ready = tagLabelEl.value.trim().length > 0;
    confirmTagBtn.disabled = !ready;
  }

  document.getElementById('btn-cancel-tag').addEventListener('click', closeTagForm);
  confirmTagBtn.addEventListener('click', confirmTag);
  const tagLabelCounter = document.getElementById('tag-label-counter');
  tagLabelEl.addEventListener('input', () => {
    const len = tagLabelEl.value.length;
    tagLabelCounter.textContent = len + '/24';
    tagLabelCounter.classList.toggle('visible', len > 0);
    tagLabelCounter.classList.toggle('near-limit', len >= 20);
    updateConfirmBtn();
  });
  tagLabelEl.addEventListener('keydown', e => {
    if (e.key === 'Enter')  { e.preventDefault(); confirmTag(); }
    if (e.key === 'Escape') closeTagForm();
  });

  function closeTagForm() {
    addTagForm.classList.remove('open');
    tagLabelEl.value = '';
    tagLabelCounter.textContent = '0/24';
    tagLabelCounter.classList.remove('visible', 'near-limit');
    tagColor = 'default';
    tagIcon = null;
    buildFormIconPicker();
    updateConfirmBtn();
  }
  function confirmTag() {
    const label = tagLabelEl.value.trim();
    if (!label) return;
    vscode.postMessage({ type: 'addTag', label, color: tagColor, ...(tagIcon ? { icon: tagIcon } : {}) });
    closeTagForm();
  }

  const tagIconPickerEl = document.getElementById('tag-icon-picker');

  function buildFormIconPicker() {
    tagIconPickerEl.innerHTML = '';
    const noneSw = mkEl('button', 'tag-icon-swatch none-swatch' + (!tagIcon ? ' selected' : ''));
    noneSw.type = 'button'; noneSw.title = 'No icon'; noneSw.innerHTML = ${jsSvg.popNone};
    noneSw.addEventListener('click', () => { tagIcon = null; buildFormIconPicker(); updateConfirmBtn(); });
    tagIconPickerEl.appendChild(noneSw);
    DEFAULT_TAG_ICONS.filter(e => !hiddenDefaultIcons.includes(e.name)).forEach(entry => {
      const sw = mkEl('button', 'tag-icon-swatch' + (tagIcon === entry.name ? ' selected' : ''));
      sw.type = 'button'; sw.title = entry.name; sw.innerHTML = entry.svg;
      sw.addEventListener('click', () => { tagIcon = entry.name; buildFormIconPicker(); updateConfirmBtn(); });
      tagIconPickerEl.appendChild(sw);
    });
    savedIconSvgs.forEach(({ name, svg }) => {
      const sw = mkEl('button', 'tag-icon-swatch' + (tagIcon === name ? ' selected' : ''));
      sw.type = 'button'; sw.title = name; sw.innerHTML = svg;
      sw.addEventListener('click', () => { tagIcon = name; buildFormIconPicker(); updateConfirmBtn(); });
      tagIconPickerEl.appendChild(sw);
    });
  }

  // ── Cards ────────────────────────────────────────────────────────────────
  function visibleNotes() {
    return notes.filter(n => {
      if (showArchived ? !n.archived : n.archived) return false;
      if (mineFilterActive && currentUser && n.owner && n.owner !== currentUser) return false;
      if (branchFilterActive && currentBranch && n.branch && n.branch !== currentBranch) return false;
if (searchQuery) {
        const tagText = n.tags.map(tid => { const t = tags.find(t => t.id === tid); return t ? t.label : ''; }).join(' ').toLowerCase();
        if (!n.title.toLowerCase().includes(searchQuery) &&
            !n.content.toLowerCase().includes(searchQuery) &&
            !tagText.includes(searchQuery)) return false;
      }
      if (activeTagIds.length > 0 && !activeTagIds.some(id => n.tags.includes(id))) return false;
      if (staleFilterActive) {
        const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
        if (n.updatedAt > cutoff) return false;
        const hasOverdueReminder = n.remindAt && n.remindAt < Date.now();
        const hasOpenTodos       = /- \[ \]/.test(n.content ?? '');
        const hasBrokenLink      = n.codeLinkStale;
        if (!hasOverdueReminder && !hasOpenTodos && !hasBrokenLink) return false;
      }
      return true;
    });
  }

  function renderCards() {
    cardList.innerHTML = '';
    const visible = visibleNotes();
    if (visible.length === 0) {
      const empty = mkEl('div', 'empty');
      const gif = (key) => '<img class="empty-gif" src="' + EMPTY_GIFS[key] + '" alt="">';
      if (showArchived) {
        empty.innerHTML = gif('archived') + '<p>No archived notes.</p>';
      } else if (staleFilterActive) {
        empty.innerHTML = gif('stale') + '<p>No stale notes.<br>Everything looks up to date.</p>';
      } else if (notes.length === 0) {
        empty.innerHTML = gif('notes') + '<p>No notes yet.<br>Click <strong>+</strong> to create one.</p>';
      } else {
        empty.innerHTML = gif('search') + '<p>No notes match<br><strong>' + esc(searchQuery || 'the selected filter') + '</strong>.</p>';
      }
      cardList.appendChild(empty);
      return;
    }
    [...visible]
      .sort((a, b) => {
        if (sortMode === 'starred') {
          const starDiff = (b.starred ? 1 : 0) - (a.starred ? 1 : 0);
          if (starDiff !== 0) return starDiff;
          return b.updatedAt - a.updatedAt;
        }
        if (sortMode === 'alpha') return a.title.localeCompare(b.title);
        return b.updatedAt - a.updatedAt;
      })
      .forEach(note => cardList.appendChild(buildCard(note)));
  }

  // ── Shared format-bar builder (used by buildCard and openDraftCard) ────────
  function buildFormatBar(preview, footer) {
    const fmtBar = mkEl('div', 'card-fmtbar');

    const mkFmtBtn = (label, title, fn, queryCmd) => {
      const btn = mkEl('button', 'card-fmt-btn');
      btn.innerHTML = label; btn.title = title;
      if (queryCmd) btn.dataset.fmtCmd = queryCmd;
      btn.addEventListener('mousedown', e => { e.preventDefault(); fn(); });
      return btn;
    };

    const syncActiveStates = () => {
      if (preview.contentEditable !== 'true') return;
      const anchorEl = () => {
        const sel = window.getSelection();
        if (!sel || !sel.anchorNode) return null;
        return sel.anchorNode.nodeType === 3 ? sel.anchorNode.parentElement : sel.anchorNode;
      };
      fmtBar.querySelectorAll('[data-fmt-cmd]').forEach(btn => {
        const cmd = btn.dataset.fmtCmd;
        let active = false;
        if (cmd === 'x-code') {
          active = !!(anchorEl()?.closest('code'));
        } else if (cmd === 'x-pre') {
          active = !!(anchorEl()?.closest('pre'));
        } else if (cmd === 'x-ul') {
          const ul = anchorEl()?.closest('ul');
          active = !!(ul && !ul.classList.contains('task-list'));
        } else if (cmd === 'x-task') {
          active = !!(anchorEl()?.closest('ul.task-list'));
        } else if (cmd === 'x-strike') {
          // Suppress false positive: CSS applies line-through on checked task items
          // but that is not user-applied strikethrough formatting.
          const el = anchorEl();
          active = !el?.closest('.task-item') && !!el?.closest('s, del, strike');
          if (!active && !el?.closest('.task-item')) {
            try { active = document.queryCommandState('strikeThrough'); } catch {}
          }
        } else {
          try { active = document.queryCommandState(cmd); } catch {}
        }
        btn.classList.toggle('active', active);
      });
      // Mirror active state onto each collapsed group's toggle button
      fmtBar.querySelectorAll('.fmt-toggle-wrap').forEach(wrap => {
        const toggle = wrap.querySelector('.fmt-grp-toggle');
        const hasActive = !!wrap.querySelector('.fmt-dropdown .card-fmt-btn.active');
        if (toggle) toggle.classList.toggle('active', hasActive);
      });
    };

    const clearFn = () => {
      document.execCommand('removeFormat', false, null);
      document.execCommand('formatBlock', false, 'p');
      const sel = window.getSelection();
      if (sel && sel.rangeCount) {
        const range = sel.getRangeAt(0);
        let node = range.commonAncestorContainer;
        if (node.nodeType === 3) node = node.parentElement;
        const list = node.closest('ul, ol');
        if (list) document.execCommand(list.tagName === 'UL' ? 'insertUnorderedList' : 'insertOrderedList', false, null);
      }
    };

    const buildTextBtns = (c) => {
      c.appendChild(mkFmtBtn(${jsSvg.fmtBold},       'Bold',          () => document.execCommand('bold'),         'bold'));
      c.appendChild(mkFmtBtn(${jsSvg.fmtItalic},     'Italic',        () => document.execCommand('italic'),       'italic'));
      c.appendChild(mkFmtBtn(${jsSvg.fmtUnderline},  'Underline',     () => document.execCommand('underline'),   'underline'));
      c.appendChild(mkFmtBtn(${jsSvg.fmtStrike},     'Strikethrough', () => document.execCommand('strikeThrough'), 'x-strike'));
      c.appendChild(mkFmtBtn(${jsSvg.fmtCodeInline}, 'Inline code',   () => {
        const sel = window.getSelection();
        if (!sel || !sel.rangeCount) return;
        const text = sel.toString();
        document.execCommand('insertHTML', false, text
          ? \`<code>\${text}</code>\`
          : '<code>​</code>');
      }, 'x-code'));
    };

    const buildListsBtns = (c) => {
      c.appendChild(mkFmtBtn(${jsSvg.fmtList},      'Bullet list',    () => document.execCommand('insertUnorderedList'), 'x-ul'));
      c.appendChild(mkFmtBtn(${jsSvg.fmtListNum},   'Numbered list',  () => document.execCommand('insertOrderedList'),   'insertOrderedList'));
      c.appendChild(mkFmtBtn(${jsSvg.fmtChecklist}, 'Checklist item', () => document.execCommand('insertHTML', false, '<ul class="task-list"><li class="task-item"><input type="checkbox" class="task-check"> <span>​</span></li></ul>'), 'x-task'));
    };

    const mkToggleWrap = (wrapCls, icon, title, buildFn) => {
      const wrap   = mkEl('div', 'fmt-toggle-wrap ' + wrapCls);
      const toggle = mkEl('button', 'card-fmt-btn fmt-grp-toggle');
      toggle.innerHTML = icon + '<span style="font-size:8px;opacity:.6;margin-left:1px">▾</span>';
      toggle.title = title;
      const drop = mkEl('div', 'fmt-dropdown');
      buildFn(drop);
      toggle.addEventListener('mousedown', e => {
        e.preventDefault();
        const isOpen = drop.classList.contains('open');
        fmtBar.querySelectorAll('.fmt-dropdown.open').forEach(d => d.classList.remove('open'));
        if (!isOpen) drop.classList.add('open');
      });
      drop.addEventListener('mousedown', () => setTimeout(() => drop.classList.remove('open'), 50));
      wrap.append(toggle, drop);
      return wrap;
    };

    // Text group
    const textGrp = mkEl('div', 'fmt-grp fmt-grp-text');
    buildTextBtns(textGrp);
    fmtBar.append(mkToggleWrap('fmt-toggle-text-wrap', ${jsSvg.fmtBold}, 'Text formatting', buildTextBtns), textGrp);
    fmtBar.appendChild(mkEl('span', 'card-fmt-sep-bar fmt-sep-text'));

    // Lists group
    const listsGrp = mkEl('div', 'fmt-grp fmt-grp-lists');
    buildListsBtns(listsGrp);
    fmtBar.append(mkToggleWrap('fmt-toggle-lists-wrap', ${jsSvg.fmtList}, 'Lists & blocks', buildListsBtns), listsGrp);
    fmtBar.appendChild(mkEl('span', 'card-fmt-sep-bar fmt-sep-lists'));

    // Code / clear — always visible
    fmtBar.appendChild(mkFmtBtn(${jsSvg.fmtCode},  'Code block',       () => document.execCommand('formatBlock', false, 'pre'), 'x-pre'));
    fmtBar.appendChild(mkEl('span', 'card-fmt-sep-bar'));
    fmtBar.appendChild(mkFmtBtn(${jsSvg.fmtClear}, 'Clear formatting', clearFn));

    // Close dropdowns when clicking outside
    document.addEventListener('mousedown', e => {
      if (!e.target.closest('.fmt-toggle-wrap')) {
        fmtBar.querySelectorAll('.fmt-dropdown.open').forEach(d => d.classList.remove('open'));
      }
    });

    // Done (always right-aligned, always visible)
    const fmtDone = mkEl('button', 'card-fmt-done');
    fmtDone.innerHTML = ${jsSvg.fmtDone};
    fmtDone.title = 'Done editing';
    fmtDone.addEventListener('mousedown', e => { e.preventDefault(); preview.blur(); });
    fmtBar.append(mkEl('span', 'card-fmt-sep'), fmtDone);

    // Responsive collapse
    const fmtRo = new ResizeObserver(() => {
      fmtBar.querySelectorAll('.fmt-dropdown.open').forEach(d => d.classList.remove('open'));
      fmtBar.classList.remove('compact-lists', 'compact-text');
      fmtBar.style.overflow = 'hidden';
      if (fmtBar.scrollWidth > fmtBar.clientWidth) {
        fmtBar.classList.add('compact-lists');
        if (fmtBar.scrollWidth > fmtBar.clientWidth) {
          fmtBar.classList.add('compact-text');
        }
      }
      fmtBar.style.overflow = '';
    });
    fmtRo.observe(fmtBar);

    preview.addEventListener('focus', () => {
      if (footer) footer.style.display = 'none';
      fmtBar.style.display = 'flex';
      syncActiveStates();
    });

    preview.addEventListener('keyup',   syncActiveStates);
    preview.addEventListener('mouseup', syncActiveStates);
    document.addEventListener('selectionchange', () => {
      if (preview.contentEditable === 'true') syncActiveStates();
    });

    return fmtBar;
  }

  function buildCard(note) {
    const isOffBranch = currentBranch && note.branch && note.branch !== currentBranch;
    const card = mkEl('div', 'card'
      + (note.shared     ? ' is-shared'   : '')
      + (isOffBranch     ? ' off-branch'  : '')
      + (note.conflicted ? ' conflict'    : '')
      + (note.archived   ? ' is-archived' : '')
    );
    card.dataset.id = note.id;
    card.setAttribute('role', 'listitem');
    card.setAttribute('aria-label', note.title
      + (note.conflicted ? ' — conflict' : '')
      + (note.archived   ? ' — archived' : '')
    );

    card.addEventListener('click', e => {
      if (!selectMode) return;
      if (e.target.closest('button, input, textarea')) return;
      const idx = selectedIds.indexOf(note.id);
      if (idx === -1) { selectedIds.push(note.id); card.classList.add('selected'); }
      else            { selectedIds.splice(idx, 1); card.classList.remove('selected'); }
      updateExportBar();
    });

    // ── Row 1: Title + Star ──
    const row1 = mkEl('div', 'card-row-1');

    const title = mkEl('input', 'card-title');
    title.type  = 'text';
    title.value = note.title;
    title.setAttribute('aria-label', 'Note title');
    title.addEventListener('blur', () => {
      if (title.value.trim() !== note.title) {
        vscode.postMessage({ type: 'updateNote', id: note.id, changes: { title: title.value.trim() || note.title } });
      }
    });
    title.addEventListener('keydown', e => { if (e.key === 'Enter') title.blur(); });

    const overflowBtn = mkEl('button', 'card-overflow-btn');
    overflowBtn.innerHTML = ${jsSvg.overflow};
    overflowBtn.title = 'More actions';
    overflowBtn.setAttribute('aria-label', 'More actions');
    overflowBtn.setAttribute('aria-expanded', 'false');
    overflowBtn.setAttribute('aria-haspopup', 'menu');
    overflowBtn.addEventListener('click', e => {
      e.stopPropagation();
      openCardMenu(note, overflowBtn);
    });

    const starBtn = mkEl('button', 'star-btn' + (note.starred ? ' on' : ''));
    starBtn.innerHTML = note.starred ? ${jsSvg.starFilled} : ${jsSvg.star};
    starBtn.title = note.starred ? 'Unstar' : 'Star';
    starBtn.setAttribute('aria-pressed', note.starred ? 'true' : 'false');
    starBtn.setAttribute('aria-label', note.starred ? 'Unstar note' : 'Star note');
    starBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'updateNote', id: note.id, changes: { starred: !note.starred } });
    });

    const checkEl = mkEl('div', 'card-check');
    row1.append(title, overflowBtn, starBtn, checkEl);
    card.append(row1);

    // ── Row 2: Metadata chips ──
    const row2 = mkEl('div', 'card-row-2');

    note.tags.forEach(tid => {
      const tag = tags.find(t => t.id === tid);
      if (!tag) return;
      const pill = mkEl('button', 'tag-pill');
      applyPillStyle(pill, tag.color);
      if (tag.iconSvg) { const ico = mkEl('span', 'tag-icon'); ico.innerHTML = tag.iconSvg; pill.appendChild(ico); }
      pill.appendChild(mkEl('span', 'chip-label', tag.label));
      const removeBtn = mkEl('span', 'chip-remove');
      removeBtn.innerHTML = ${jsSvg.unlinkSmall};
      removeBtn.title = 'Remove tag';
      pill.appendChild(removeBtn);
      pill.title = 'Filter by ' + tag.label;
      pill.addEventListener('click', e => {
        if (e.target === removeBtn || removeBtn.contains(e.target)) {
          e.stopPropagation();
          vscode.postMessage({ type: 'updateNote', id: note.id, changes: { tags: note.tags.filter(t => t !== tid) } });
          return;
        }
        if (!activeTagIds.includes(tid)) {
          activeTagIds = [...activeTagIds, tid];
          renderTagBar();
          renderCards();
        }
      });
      row2.appendChild(pill);
    });

    if (note.linkedNoteIds && note.linkedNoteIds.length > 0) {
      note.linkedNoteIds.forEach(targetId => {
        const target = notes.find(n => n.id === targetId);
        if (!target) return;
        const chip = makeChip('button', 'note-link-chip', ${jsSvg.noteLinkIcon}, target.title, 'chip-label');
        chip.title = target.title;
        const unlinkBtn = mkEl('span', 'chip-remove');
        unlinkBtn.innerHTML = ${jsSvg.unlinkSmall};
        unlinkBtn.title = 'Remove link';
        chip.appendChild(unlinkBtn);
        chip.addEventListener('click', e => {
          if (e.target === unlinkBtn || unlinkBtn.contains(e.target)) {
            e.stopPropagation();
            vscode.postMessage({ type: 'unlinkNote', noteId: note.id, targetId });
          } else {
            vscode.postMessage({ type: 'openLinkedNote', noteId: targetId });
          }
        });
        row2.appendChild(chip);
      });
    }

    if (note.shared) {
      const badge = makeChip('span', 'shared-badge', ${jsSvg.shareSmall}, 'Shared');
      badge.setAttribute('aria-label', 'This note is shared');
      row2.appendChild(badge);
    }

    if (note.conflicted) {
      const badge = makeChip('button', 'conflict-badge', ${jsSvg.conflictIcon}, 'Conflict — click to resolve');
      badge.setAttribute('aria-label', 'Merge conflict — click to open conflict resolution');
      badge.addEventListener('click', e => { e.stopPropagation(); vscode.postMessage({ type: 'openConflict', noteId: note.id }); });
      row2.appendChild(badge);
    }

    if (note.archived) {
      const ab = makeChip('span', 'archived-badge', ${jsSvg.archiveIcon}, 'Archived');
      ab.setAttribute('aria-label', 'This note is archived');
      row2.appendChild(ab);
    }

    if (note.remindAt) {
      const isOverdue = note.remindAt <= Date.now();
      const badge = makeChip('span', 'reminder-badge' + (isOverdue ? ' overdue' : ''), ${jsSvg.bellSmall}, formatReminder(note.remindAt));
      badge.title = isOverdue ? 'Overdue — click bell to reschedule' : new Date(note.remindAt).toLocaleString();
      row2.appendChild(badge);
    }

    if (note.github) {
      const gh     = note.github;
      const status = gh.status ?? 'open';
      const ghIcon = gh.type === 'pr'
        ? (status === 'merged' ? ${jsSvg.ghPrMerged} : status === 'closed' ? ${jsSvg.ghPrClosed} : ${jsSvg.ghPrOpen})
        : (status === 'closed' || status === 'merged' ? ${jsSvg.ghIssueClosed} : ${jsSvg.ghIssueOpen});
      const badge = makeChip('button', \`github-badge gh-\${status}\`, ghIcon, \`\${gh.type === 'pr' ? 'PR' : '#'}\${gh.number} \${status}\`);
      badge.title = gh.title || gh.url;
      badge.addEventListener('click', e => { e.stopPropagation(); vscode.postMessage({ type: 'openGitHubLink', url: gh.url }); });
      row2.appendChild(badge);
    }

    if (note.codeLink) {
      const shortName  = note.codeLink.file.split('/').pop() || note.codeLink.file;
      const staleTitle = note.codeLink.file + ':' + note.codeLink.line + ' — file not found';
      const chip = makeChip('button', 'code-link-chip' + (note.codeLinkStale ? ' stale' : ''), ${jsSvg.codeLinkIcon}, shortName + ':' + note.codeLink.line, 'chip-label');
      chip.title = note.codeLinkStale ? staleTitle : note.codeLink.file + ':' + note.codeLink.line + ' — click to jump';
      chip.setAttribute('aria-label', note.codeLinkStale ? 'Broken link: ' + staleTitle : 'Jump to ' + note.codeLink.file + ' line ' + note.codeLink.line);
      if (!note.codeLinkStale) {
        chip.addEventListener('click', e => { e.stopPropagation(); vscode.postMessage({ type: 'jumpToLink', file: note.codeLink.file, line: note.codeLink.line }); });
        const removeBtn = mkEl('span', 'chip-remove');
        removeBtn.innerHTML = ${jsSvg.unlinkSmall};
        removeBtn.title = 'Remove code link';
        removeBtn.addEventListener('click', e => { e.stopPropagation(); vscode.postMessage({ type: 'removeCodeLink', noteId: note.id }); });
        chip.appendChild(removeBtn);
      }
      row2.appendChild(chip);
    }

    if (note.branch) {
      const chip = makeChip('span', 'branch-chip', ${jsSvg.branchSmall}, note.branch);
      chip.title = 'Branch: ' + note.branch;
      row2.appendChild(chip);
    }

    const hasChips = note.tags.length > 0
      || (note.linkedNoteIds && note.linkedNoteIds.length > 0)
      || note.codeLink || note.github || note.remindAt || note.conflicted || note.archived || note.branch;

    // Tag picker — shared by ghost button (empty card) and overflow "Add tag"
    let pendingTags = [...note.tags];
    let onPendingTagsChanged = null;

    const picker = mkEl('div', 'draft-tag-picker card-tag-picker');
    picker.style.display = 'none';
    picker.addEventListener('click', e => e.stopPropagation());

    buildTagPicker(picker, () => pendingTags, (id) => {
      pendingTags = pendingTags.includes(id) ? pendingTags.filter(i => i !== id) : [...pendingTags, id];
      if (onPendingTagsChanged) onPendingTagsChanged();
    });

    function openTagPicker() {
      pendingTags = [...note.tags];
      picker.querySelectorAll('.tag-chip').forEach(c => {
        c.classList.toggle('active', pendingTags.includes(c.dataset.tid));
      });
      picker.style.display = '';
      cardTagPickerCommit = () => {
        if (pendingTags.slice().sort().join() !== note.tags.slice().sort().join()) {
          vscode.postMessage({ type: 'updateNote', id: note.id, changes: { tags: pendingTags } });
        }
      };
    }

    card._openTagPicker = () => { closeAllPops(); openTagPicker(); };

    if (!hasChips) {
      const pillsArea = mkEl('div', 'draft-pills');
      row2.appendChild(pillsArea);

      const ghost = mkEl('button', 'tag-ghost');
      ghost.title = 'Add tag';

      function updateRow2Pills() {
        pillsArea.innerHTML = '';
        pendingTags.forEach(tid => {
          const tag = tags.find(t => t.id === tid);
          if (!tag) return;
          const pill = mkEl('span', 'tag-pill');
          applyPillStyle(pill, tag.color);
          if (tag.iconSvg) { const ico = mkEl('span', 'tag-icon'); ico.innerHTML = tag.iconSvg; pill.appendChild(ico); }
          pill.appendChild(mkEl('span', 'chip-label', tag.label));
          pillsArea.appendChild(pill);
        });
        ghost.innerHTML = pendingTags.length === 0 ? ${jsSvg.tagSmall} + 'tag' : ${jsSvg.tagSmall};
      }
      updateRow2Pills();
      onPendingTagsChanged = updateRow2Pills;

      ghost.addEventListener('click', e => {
        e.stopPropagation();
        const isOpen = picker.style.display !== 'none';
        closeAllPops();
        if (!isOpen) {
          openTagPicker();
          updateRow2Pills();
        }
      });

      row2.appendChild(ghost);
    }

    row2.appendChild(picker);

    card.appendChild(row2);

    // ── Row 3: Content ──
    const row3 = mkEl('div', 'card-row-3');
    const contentWrap = mkEl('div', 'card-content');

    const preview  = mkEl('div', 'card-preview clamped');
    preview.dataset.placeholder = 'Start writing…';
    preview.innerHTML = searchQuery ? matchSnippet(note.content, searchQuery) : simpleMarkdown(note.content);
    const syncPlaceholder = () => preview.toggleAttribute('data-empty', preview.textContent.trim() === '' && !preview.querySelector('img'));
    syncPlaceholder();
    preview.addEventListener('input', syncPlaceholder);

    const showMore = mkEl('div', 'show-more');
    showMore.innerHTML = ${jsSvg.chevronDown};
    const isLong   = note.content.split('\\n').length > 5 || note.content.length > 300;
    if (isLong) showMore.style.visibility = 'visible';

    let expanded = expandedNoteIds.has(note.id);
    if (expanded) {
      preview.classList.remove('clamped');
      showMore.innerHTML = ${jsSvg.chevronUp};
    }
    showMore.addEventListener('click', () => {
      expanded = !expanded;
      if (expanded) expandedNoteIds.add(note.id);
      else          expandedNoteIds.delete(note.id);
      preview.classList.toggle('clamped', !expanded);
      showMore.innerHTML = expanded ? ${jsSvg.chevronUp} : ${jsSvg.chevronDown};
    });

    // Intercept checkbox mousedown to prevent focus-steal (which triggers blur = "done" effect)
    preview.addEventListener('mousedown', e => {
      if (e.target.type !== 'checkbox') return;
      e.preventDefault(); // block focus change in both view and edit mode
      const newChecked = !e.target.checked;
      e.target.checked = newChecked;
      // Sync the HTML attribute so preview.innerHTML reflects the new state
      if (newChecked) e.target.setAttribute('checked', '');
      else            e.target.removeAttribute('checked');
      const li = e.target.closest('.task-item');
      if (li) li.classList.toggle('done', e.target.checked);
      if (preview.contentEditable !== 'true') {
        const newContent = htmlToMarkdown(preview.innerHTML);
        if (newContent !== note.content) {
          note.content = newContent;
          vscode.postMessage({ type: 'updateNote', id: note.id, changes: { content: newContent } });
        }
      }
    });

    preview.addEventListener('click', e => {
      if (e.target.type === 'checkbox') { e.preventDefault(); return; } // prevent browser re-toggle; handled by mousedown
      if (preview.contentEditable === 'true') return;
      const { clientX: x, clientY: y } = e;
      expanded = true;
      expandedNoteIds.add(note.id);
      preview.classList.remove('clamped');
      showMore.style.visibility = 'hidden';
      preview.contentEditable = 'true';
      requestAnimationFrame(() => {
        // Inject a nbsp placeholder into empty task spans so caretPositionFromPoint
        // has a text node to anchor to, and the cursor is visible.
        // htmlToMarkdown trims it away on blur, so nothing leaks to storage.
        preview.querySelectorAll('.task-item span').forEach(span => {
          if (span.textContent.replace(/ /g, '').trim() === '') {
            span.textContent = ' ';
          }
        });
        // Capture caret position BEFORE focus() — focus on a tall expanded card
        // can trigger a browser scroll that shifts viewport coordinates, making
        // caretPositionFromPoint(x, y) land on the wrong line.
        // DOM node+offset positions are scroll-invariant, so capture first.
        let savedNode = null, savedOffset = 0;
        if (document.caretPositionFromPoint) {
          const pos = document.caretPositionFromPoint(x, y);
          if (pos) { savedNode = pos.offsetNode; savedOffset = pos.offset; }
        } else if (document.caretRangeFromPoint) {
          const range = document.caretRangeFromPoint(x, y);
          if (range) { savedNode = range.startContainer; savedOffset = range.startOffset; }
        }
        preview.focus();
        if (savedNode) window.getSelection().collapse(savedNode, savedOffset);
      });
    });

    preview.addEventListener('blur', () => {
      preview.contentEditable = 'false';
      fmtBar.style.display = 'none';
      footer.style.display = '';
      const newContent = htmlToMarkdown(preview.innerHTML);
      const contentChanged = newContent !== note.content;
      if (contentChanged) {
        note.content = newContent;
        lastSavedNoteId = note.id;
        vscode.postMessage({ type: 'updateNote', id: note.id, changes: { content: newContent } });
      }
      preview.innerHTML = simpleMarkdown(note.content);
      syncPlaceholder();
      if (!expanded) preview.classList.add('clamped');
      const stillLong = note.content.split('\\n').length > 5 || note.content.length > 300;
      if (!contentChanged) {
        // Content unchanged: renderCards() won't be called, so update showMore here.
        // Space was already reserved via visibility:hidden, so no layout shift.
        showMore.style.visibility = stillLong ? 'visible' : 'hidden';
      }
      // If content changed, renderCards() rebuilds the card — leave showMore hidden
      // to avoid a shift in the brief gap before the rebuild arrives.
    });

    preview.addEventListener('keydown', e => {
      if (e.key === 'Escape') { preview.blur(); return; }
      if (e.key === 'Tab') {
        e.preventDefault();
        document.execCommand(e.shiftKey ? 'outdent' : 'indent');
      }
      if (e.key === 'Enter') {
        const sel = window.getSelection();
        if (!sel || !sel.rangeCount) return;
        const anchor = sel.anchorNode;
        const taskItem = (anchor.nodeType === 3 ? anchor.parentElement : anchor)?.closest?.('.task-item');
        if (!taskItem) return;
        e.preventDefault();
        const span = taskItem.querySelector('span');
        const isEmpty = !span || span.textContent.replace(/​/g, '').replace(/ /g, '').trim() === '';
        if (isEmpty) {
          // Exit the list: remove the empty item and insert a paragraph after the list
          const list = taskItem.closest('ul.task-list');
          taskItem.remove();
          if (list && list.children.length === 0) list.remove();
          const p = document.createElement('p');
          p.innerHTML = '<br>';
          (list ?? taskItem).after(p);
          const range = document.createRange();
          range.setStart(p, 0);
          range.collapse(true);
          sel.removeAllRanges();
          sel.addRange(range);
        } else {
          // Insert a new empty task item after the current one
          const newLi = document.createElement('li');
          newLi.className = 'task-item';
          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.className = 'task-check';
          const newSpan = document.createElement('span');
          const placeholder = document.createTextNode(' ');
          newSpan.appendChild(placeholder);
          newLi.append(cb, document.createTextNode(' '), newSpan);
          taskItem.after(newLi);
          requestAnimationFrame(() => {
            const r = document.createRange();
            r.setStart(placeholder, 0);
            r.collapse(true);
            const s = window.getSelection();
            s.removeAllRanges();
            s.addRange(r);
          });
        }
      }
    });

    preview.addEventListener('paste', e => {
      const items = e.clipboardData?.items;
      if (!items) return;
      let imageItem = null;
      for (let i = 0; i < items.length; i++) {
        if (items[i].type.startsWith('image/')) { imageItem = items[i]; break; }
      }
      if (!imageItem) return;
      e.preventDefault();
      e.stopPropagation();
      const file = imageItem.getAsFile();
      if (!file) return;
      const sel = window.getSelection();
      const savedRange = sel?.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
      pendingImageInsertions.set(note.id, { range: savedRange, preview });
      const ext = imageItem.type.split('/')[1]?.split('+')[0] ?? 'png';
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result;
        const base64  = dataUrl.split(',')[1] ?? '';
        vscode.postMessage({ type: 'pasteImage', noteId: note.id, base64, ext });
      };
      reader.readAsDataURL(file);
    });

    contentWrap.append(preview, showMore);
    row3.appendChild(contentWrap);
    card.appendChild(row3);

    // ── Row 4: Footer ──
    const footer = mkEl('div', 'card-row-4');

    // ── Left slot: owner ──
    const leftSlot = mkEl('span', 'card-foot-slot card-foot-slot-left');
    const INVALID_OWNERS = ['undefined', 'null', 'unknown', ''];
    const hasOwner = note.owner && typeof note.owner === 'string'
      && !INVALID_OWNERS.includes(note.owner.trim());

    if (hasOwner) {
      const owner  = note.owner.trim();
      const el     = mkEl('span', 'owner-badge');
      el.title     = owner;
      const circle = mkEl('span', 'owner-initials', initials(owner));
      const nameEl = mkEl('span', 'owner-name', owner.split(/\s+/)[0] || owner);
      el.append(circle, nameEl);
      leftSlot.appendChild(el);
    }
    footer.appendChild(leftSlot);

    // ── Right slot: date ──
    const rightSlot = mkEl('span', 'card-foot-slot card-foot-slot-right');
    const wasEdited = note.updatedAt - note.createdAt > 5000;
    const dateLabel = formatDate(wasEdited ? note.updatedAt : note.createdAt);
    const dateTitle = wasEdited
      ? 'Updated ' + new Date(note.updatedAt).toLocaleString()
      : 'Created '  + new Date(note.createdAt).toLocaleString();
    const dateEl = mkEl('span', 'card-date', dateLabel);
    dateEl.title = dateTitle;
    rightSlot.appendChild(dateEl);
    footer.appendChild(rightSlot);
    card.appendChild(footer);

    // ── Format bar (swaps with footer while editing) ──
    const fmtBar = buildFormatBar(preview, footer);
    card.appendChild(fmtBar);
    preview.addEventListener('focus', () => { showMore.style.visibility = 'hidden'; });

    // ── Keyboard shortcuts ──
    card.tabIndex = 0;
    card.addEventListener('keydown', e => {
      if (e.target !== card) return; // let child inputs handle their own keys
      switch (e.key) {
        case 'Enter':
          e.preventDefault();
          vscode.postMessage({ type: 'openEditor', noteId: note.id });
          break;
        case 's': case 'S':
          e.preventDefault();
          vscode.postMessage({ type: 'updateNote', id: note.id, changes: { starred: !note.starred } });
          break;
        case 'a': case 'A':
          e.preventDefault();
          vscode.postMessage({ type: note.archived ? 'unarchiveNote' : 'archiveNote', id: note.id });
          break;
        case 'r': case 'R':
          e.preventDefault();
          title.focus();
          title.select();
          break;
        case 'Delete':
          e.preventDefault();
          vscode.postMessage({ type: 'deleteNote', id: note.id });
          break;
        case 'ArrowDown': {
          e.preventDefault();
          const cards = [...cardList.querySelectorAll('.card[tabindex="0"]')];
          const idx = cards.indexOf(card);
          if (idx < cards.length - 1) cards[idx + 1].focus();
          break;
        }
        case 'ArrowUp': {
          e.preventDefault();
          const cards = [...cardList.querySelectorAll('.card[tabindex="0"]')];
          const idx = cards.indexOf(card);
          if (idx > 0) cards[idx - 1].focus();
          else searchEl.focus();
          break;
        }
        case 'Escape':
          card.blur();
          break;
      }
    });

    return card;
  }

  // ── Card-level overflow menu ────────────────────────────────────────────
  const cardOvfMenu = document.getElementById('card-ovf-menu');
  let cardOvfTarget = null; // note currently shown in the menu

  function openCardMenu(note, btn) {
    const isOpen = cardOvfMenu.classList.contains('open') && cardOvfTarget?.id === note.id;
    closeAllPops();
    if (isOpen) return; // toggle off

    // ── Populate ──
    cardOvfMenu.innerHTML = '';
    cardOvfTarget = note;

    function item(icon, label, cls, handler) {
      const btn = mkEl('button', 'ovf-item' + (cls ? ' ' + cls : ''));
      btn.innerHTML = \`<span class="ovf-icon">\${icon}</span><span class="ovf-label">\${label}</span>\`;
      btn.addEventListener('click', e => { e.stopPropagation(); handler(btn); });
      cardOvfMenu.appendChild(btn);
      return btn;
    }
    function divider() { cardOvfMenu.appendChild(mkEl('hr', 'ovf-divider')); }

    const SVG = {
      edit:    ${jsSvg.edit},
      remind:  ${jsSvg.remind},
      dup:     ${jsSvg.dup},
      tag:     ${jsSvg.tagSmall},
      link:    ${jsSvg.codeLinkMenu},
      unlink:  ${jsSvg.unlink},
      archive: ${jsSvg.archive},
      share:   ${jsSvg.share},
      export:  ${jsSvg.export},
      trash:   ${jsSvg.trash},
      ghIssue: ${jsSvg.ghIssue},
      ghPr:    ${jsSvg.ghPr},
      branch:    ${jsSvg.branchMenu},
      noteLink:  ${jsSvg.noteLink},
    };

    // ── Group 1: Edit & Create ──
    item(SVG.edit, 'Edit in editor', '',
      () => { vscode.postMessage({ type: 'openEditor', noteId: note.id }); closeAllPops(); });

    item(SVG.dup, 'Duplicate', '',
      () => { vscode.postMessage({ type: 'duplicateNote', noteId: note.id }); closeAllPops(); });

    item(SVG.remind, note.remindAt ? 'Change reminder' : 'Set reminder', '',
      () => { vscode.postMessage({ type: 'setReminder', noteId: note.id }); closeAllPops(); });

    item(SVG.tag, 'Add tag', '', () => {
      const cardEl = document.querySelector('.card[data-id="' + note.id + '"]');
      if (cardEl?._openTagPicker) cardEl._openTagPicker();
    });

    divider();

    // ── Group 2: Link ──
    item(SVG.noteLink, 'Link to another note', '',
      () => { vscode.postMessage({ type: 'linkNote', noteId: note.id }); closeAllPops(); });

    if (note.codeLink) {
      item(SVG.unlink, 'Remove file link', '',
        () => { vscode.postMessage({ type: 'removeCodeLink', noteId: note.id }); closeAllPops(); });
    } else {
      item(SVG.link, 'Link to current file', '',
        () => { vscode.postMessage({ type: 'linkToEditor', noteId: note.id }); closeAllPops(); });
    }

    if (currentBranch) {
      if (note.branch === currentBranch) {
        item(SVG.branch, 'Unpin from current branch', '',
          () => { vscode.postMessage({ type: 'setBranchScope', noteId: note.id, branch: null }); closeAllPops(); });
      } else {
        item(SVG.branch, 'Pin to current branch', '',
          () => { vscode.postMessage({ type: 'setBranchScope', noteId: note.id, branch: currentBranch }); closeAllPops(); });
      }
    }

    if (githubConnected) {
      divider();

      // ── Group 3: GitHub ──
      if (note.github) {
        const ispr = note.github.type === 'pr';
        item(ispr ? SVG.ghPr : SVG.ghIssue, ispr ? 'Open GitHub PR' : 'Open GitHub Issue', '',
          () => { vscode.postMessage({ type: 'openGitHubLink', url: note.github.url }); closeAllPops(); });
      } else {
        item(SVG.ghIssue, 'Create GitHub Issue', '',
          () => { vscode.postMessage({ type: 'createGitHubIssue', noteId: note.id }); closeAllPops(); });
        item(SVG.ghPr, 'Link to PR', '',
          () => { vscode.postMessage({ type: 'linkGitHubPR', noteId: note.id }); closeAllPops(); });
      }
    }

    divider();

    // ── Group 4: Visibility ──
    item(SVG.archive, note.archived ? 'Unarchive' : 'Archive', '',
      () => { vscode.postMessage({ type: note.archived ? 'unarchiveNote' : 'archiveNote', id: note.id }); closeAllPops(); });

    item(SVG.share, note.shared ? 'Unshare' : 'Share', '',
      () => { vscode.postMessage({ type: 'updateNote', id: note.id, changes: { shared: !note.shared } }); closeAllPops(); });

    divider();

    // ── Group 5: Danger ──
    item(SVG.export, 'Export', '',
      () => { vscode.postMessage({ type: 'exportNotes', noteIds: [note.id] }); closeAllPops(); });

    item(SVG.trash, 'Delete', 'danger', deleteBtn => {
      if (!deleteBtn.classList.contains('confirm')) {
        deleteBtn.classList.add('confirm');
        deleteBtn.querySelector('.ovf-label').textContent = 'Confirm delete?';
      } else {
        vscode.postMessage({ type: 'deleteNote', id: note.id });
        closeAllPops();
      }
    });

    // ── Smart position (measure after populate) ──
    cardOvfMenu.classList.add('open');
    cardOvfMenu.style.maxHeight = 'none'; // unconstrain so offsetHeight = natural height
    const rect        = btn.getBoundingClientRect();
    const naturalH    = cardOvfMenu.offsetHeight;
    const menuW       = cardOvfMenu.offsetWidth;
    const vh          = document.documentElement.clientHeight;
    const vw          = document.documentElement.clientWidth;
    const GAP         = 4;
    const spaceBelow  = vh - rect.bottom - GAP;
    const spaceAbove  = rect.top - GAP;

    // Vertical: prefer below; flip above if more room; always clamp to available space
    if (naturalH <= spaceBelow) {
      cardOvfMenu.style.maxHeight = '';
      cardOvfMenu.style.top    = (rect.bottom + GAP) + 'px';
      cardOvfMenu.style.bottom = 'auto';
    } else if (naturalH <= spaceAbove) {
      cardOvfMenu.style.maxHeight = '';
      cardOvfMenu.style.top    = 'auto';
      cardOvfMenu.style.bottom = (vh - rect.top + GAP) + 'px';
    } else if (spaceBelow >= spaceAbove) {
      cardOvfMenu.style.maxHeight = spaceBelow + 'px';
      cardOvfMenu.style.top    = (rect.bottom + GAP) + 'px';
      cardOvfMenu.style.bottom = 'auto';
    } else {
      cardOvfMenu.style.maxHeight = spaceAbove + 'px';
      cardOvfMenu.style.top    = 'auto';
      cardOvfMenu.style.bottom = (vh - rect.top + GAP) + 'px';
    }

    // Horizontal: right-align to button, clamp so it never clips the left edge
    const rightEdge = vw - rect.right;
    if (rect.right - menuW >= GAP) {
      cardOvfMenu.style.right = rightEdge + 'px';
      cardOvfMenu.style.left  = 'auto';
    } else {
      cardOvfMenu.style.left  = Math.max(GAP, rect.left) + 'px';
      cardOvfMenu.style.right = 'auto';
    }

    btn.setAttribute('aria-expanded', 'true');
  }

  // ── Close all popover on outside click ─────────────────────────────────
  document.addEventListener('click', () => {
    closeAllPops();
  });

  function positionColorPop(pop) {
    const anchor = pop._anchor;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    pop.style.top  = (rect.bottom + 4) + 'px';
    pop.style.left = rect.left + 'px';
    const pr = pop.getBoundingClientRect();
    if (pr.right > window.innerWidth - 5) pop.style.left = Math.max(0, rect.right - pr.width - 5) + 'px';
    if (pr.bottom > window.innerHeight) pop.style.top  = Math.max(0, rect.top - pr.height - 4) + 'px';
  }

  new ResizeObserver(() => {
    document.querySelectorAll('.tag-chip-color-pop.open').forEach(positionColorPop);
  }).observe(document.body);

  function closeAllPops() {
    if (cardTagPickerCommit) { cardTagPickerCommit(); cardTagPickerCommit = null; }
    iconSearchResultsCb = null;
    document.querySelectorAll('.card-tag-picker').forEach(p => { p.style.display = 'none'; });
    document.querySelectorAll('.tag-chip-color-pop.open').forEach(el => el.classList.remove('open'));
    openColorPop    = null;
    overflowMenu.classList.remove('open');
    btnOverflow.classList.remove('open');
    syncOverflowActive();
    document.querySelectorAll('[aria-expanded="true"]').forEach(el => el.setAttribute('aria-expanded', 'false'));
    cardOvfMenu.classList.remove('open');
    cardOvfTarget = null;
  }

  // ── Helpers ─────────────────────────────────────────────────────────────
  function esc(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  function buildTagPicker(container, getSelected, onToggle) {
    if (tags.length === 0) {
      container.appendChild(mkEl('span', 'tag-pop-empty', 'No tags yet'));
      return;
    }
    tags.forEach(tag => {
      const chip = mkEl('button', 'tag-chip');
      chip.type = 'button';
      chip.dataset.tid = tag.id;
      if (tag.iconSvg) { const ico = mkEl('span', 'tag-icon'); ico.innerHTML = tag.iconSvg; chip.appendChild(ico); }
      chip.appendChild(mkEl('span', 'chip-text', tag.label));
      const applyStyle = active => {
        chip.classList.toggle('active', active);
        applyChipStyle(chip, tag.color, active);
      };
      applyStyle(getSelected().includes(tag.id));
      chip.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
        onToggle(tag.id, chip);
        applyStyle(getSelected().includes(tag.id));
      });
      container.appendChild(chip);
    });
  }

  function matchSnippet(content, query) {
    if (!content) return '';
    const lower = content.toLowerCase();
    const idx   = lower.indexOf(query);
    if (idx === -1) return simpleMarkdown(content);
    const start  = Math.max(0, idx - 40);
    const end    = Math.min(content.length, idx + query.length + 80);
    const text   = (start > 0 ? '\\u2026' : '') + content.slice(start, end) + (end < content.length ? '\\u2026' : '');
    const li     = text.toLowerCase().indexOf(query);
    return '<p>' + esc(text.slice(0, li)) + '<mark class="match-highlight">' + esc(text.slice(li, li + query.length)) + '</mark>' + esc(text.slice(li + query.length)) + '</p>';
  }

  function hsvToHex(h, s, v) {
    s /= 100; v /= 100;
    const f = n => { const k = (n + h / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
    return '#' + [f(5), f(3), f(1)].map(x => Math.round(x * 255).toString(16).padStart(2, '0')).join('');
  }
  function hexToHsv(hex) {
    const r = parseInt(hex.slice(1,3),16)/255, g = parseInt(hex.slice(3,5),16)/255, b = parseInt(hex.slice(5,7),16)/255;
    const max = Math.max(r,g,b), min = Math.min(r,g,b), d = max - min;
    const h = d === 0 ? 0 : max === r ? ((g-b)/d % 6)*60 : max === g ? ((b-r)/d+2)*60 : ((r-g)/d+4)*60;
    return [((h%360)+360)%360, max===0?0:d/max*100, max*100];
  }

  function mkEl(tag, cls = '', text = '') {
    const el = document.createElement(tag);
    if (cls)  el.className = cls;
    if (text) el.textContent = text;
    return el;
  }

  function makeChip(tag, cls, iconSvg, text, textCls = 'chip-text') {
    const el  = mkEl(tag, 'meta-chip ' + cls);
    const ico = mkEl('span', 'tag-icon'); ico.innerHTML = iconSvg;
    el.append(ico, mkEl('span', textCls, text));
    return el;
  }

  function mkSavedIconSwatch(name, svg, isSelected, onSelect) {
    const wrap = mkEl('div', 'custom-swatch-wrap');
    const sw = mkEl('button', 'tag-icon-swatch' + (isSelected ? ' selected' : ''));
    sw.type = 'button'; sw.title = name; sw.innerHTML = svg;
    sw.addEventListener('click', e => { e.stopPropagation(); onSelect(name); });
    wrap.appendChild(sw);
    const del = mkEl('button', 'custom-swatch-del');
    del.type = 'button'; del.title = 'Remove icon'; del.textContent = '×';
    del.addEventListener('click', e => { e.stopPropagation(); vscode.postMessage({ type: 'removeSavedIcon', name }); });
    wrap.appendChild(del);
    return wrap;
  }

  function buildColorStrip(container, onSelect) {
    container.innerHTML = '';
    const noneSw = mkEl('div', 'color-swatch default-swatch');
    noneSw.dataset.colorHex = 'default';
    noneSw.style.background = 'var(--vscode-foreground)';
    noneSw.title = 'Default';
    noneSw.textContent = '○';
    noneSw.addEventListener('click', () => onSelect('default'));
    container.appendChild(noneSw);
    COLOR_KEYS.filter(key => !hiddenDefaultColors.includes(COLORS[key])).forEach(key => {
      const sw = mkEl('div', 'color-swatch');
      sw.style.background = COLORS[key];
      sw.title = key;
      sw.dataset.colorKey = key;
      sw.dataset.colorHex = COLORS[key];
      sw.addEventListener('click', () => onSelect(COLORS[key]));
      container.appendChild(sw);
    });
    customColors.forEach(hex => {
      const sw = mkEl('div', 'color-swatch');
      sw.style.background = hex;
      sw.title = hex;
      sw.dataset.colorHex = hex;
      sw.addEventListener('click', () => onSelect(hex));
      container.appendChild(sw);
    });
  }

  function highlightSwatch(container, hex) {
    container.querySelectorAll('.color-swatch').forEach(sw => {
      sw.classList.toggle('selected', sw.dataset.colorHex === hex);
    });
  }

  function applyChipStyle(el, color, isActive) {
    if (!color || color === 'default') {
      el.classList.add('default-color');
      el.style.background = el.style.borderColor = el.style.color = '';
    } else {
      el.classList.remove('default-color');
      el.style.background  = isActive ? color : hexToRgba(color, 0.18);
      el.style.borderColor = isActive ? 'rgba(0,0,0,0.25)' : color;
      el.style.color       = isActive ? '${C.text}' : color;
    }
  }

  function applyPillStyle(el, color) {
    if (!color || color === 'default') {
      el.classList.add('default-color');
    } else {
      el.style.background  = hexToRgba(color, 0.18);
      el.style.borderColor = color;
      el.style.color       = color;
    }
  }

  function hexToRgba(hex, alpha) {
    if (!hex || hex[0] !== '#') return hex || 'transparent';
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
  }

  function initials(name) {
    if (typeof name !== 'string' || !name.trim()) return '?';
    const parts = name.trim().split(/\s+/).filter(p => p.length > 0);
    if (parts.length === 0) return '?';
    if (parts.length === 1) return (parts[0][0] || '?').toUpperCase();
    const first = parts[0][0] || '';
    const last  = parts[parts.length - 1][0] || '';
    return (first + last).toUpperCase() || '?';
  }

  function formatReminder(ts) {
    const now = Date.now();
    if (ts <= now) {
      const diff = now - ts;
      const mins = Math.floor(diff / 60000);
      if (mins < 60)  return mins <= 1 ? '1m overdue' : mins + 'm overdue';
      const hrs = Math.floor(diff / 3600000);
      if (hrs < 24)   return hrs + 'h overdue';
      return Math.floor(diff / 86400000) + 'd overdue';
    }
    const d        = new Date(ts);
    const today    = new Date();
    if (d.toDateString() === today.toDateString()) return 'Today';
    const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);
    if (d.toDateString() === tomorrow.toDateString()) return 'Tomorrow';
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  function formatDate(ts) {
    const d   = new Date(ts);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    return sameDay
      ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
      : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  function htmlToMarkdown(html) {
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    function walk(node) {
      if (node.nodeType === 3) return node.textContent.replace(/ /g, ' ');
      if (node.nodeType !== 1) return '';
      const tag = node.tagName.toLowerCase();
      const inner = Array.from(node.childNodes).map(walk).join('');
      switch (tag) {
        case 'strong': case 'b':               { const t = inner.replace(/^\\n+|\\n+$/g, ''); return t ? \`**\${t}**\` : ''; }
        case 'em':     case 'i':               { const t = inner.replace(/^\\n+|\\n+$/g, ''); return t ? \`*\${t}*\` : ''; }
        case 'code':                           { const t = inner.replace(/^\\n+|\\n+$/g, ''); return t ? \`\\\`\${t}\\\`\` : ''; }
        case 'del':    case 's': case 'strike': { const t = inner.replace(/^\\n+|\\n+$/g, ''); return t ? \`~~\${t}~~\` : ''; }
        case 'u':                              { const t = inner.replace(/^\\n+|\\n+$/g, ''); return t ? \`++\${t}++\` : ''; }
        case 'a': {
          const href = node.getAttribute('href') || '';
          return href ? \`[\${inner}](\${href})\` : inner;
        }
        case 'h1':                             return \`# \${inner}\\n\\n\`;
        case 'h2':                             return \`## \${inner}\\n\\n\`;
        case 'h3':                             return \`### \${inner}\\n\\n\`;
        case 'pre':                            return \`\\\`\\\`\\\`\\n\${node.textContent.trim()}\\n\\\`\\\`\\\`\\n\`;
        case 'blockquote':                     return inner.trim().split('\\n').map(l => \`> \${l}\`).join('\\n') + '\\n';
        case 'br':                             return '\\n';
        case 'li': {
          const cb = node.querySelector('input[type="checkbox"]');
          if (cb) {
            const txt = Array.from(node.childNodes)
              .filter(n => !(n.nodeType === 1 && n.tagName.toLowerCase() === 'input'))
              .map(walk).join('').trim();
            return \`- [\${cb.checked ? 'x' : ' '}] \${txt}\\n\`;
          }
          if (node.parentElement?.tagName.toLowerCase() === 'ol') {
            const idx = Array.from(node.parentElement.children).indexOf(node) + 1;
            return \`\${idx}. \${inner.trim()}\\n\`;
          }
          return \`- \${inner.trim()}\\n\`;
        }
        case 'ul':     case 'ol':              return inner;
        case 'table': {
          // Serialise each table row back to markdown pipe syntax.
          // Cells that contain a .cell-list are converted to <br>-separated list items
          // (the format simpleMarkdown expects) rather than newline-separated ones.
          const walkCell = cell => {
            const list = cell.querySelector('.cell-list');
            if (list) {
              const isOl = list.tagName.toLowerCase() === 'ol';
              const lis  = Array.from(list.querySelectorAll('li'));
              const parts = lis.map((li, n) => {
                const cb = li.querySelector('input[type="checkbox"]');
                if (cb) {
                  const span = li.querySelector('span');
                  const txt  = span
                    ? walk(span).trim()
                    : Array.from(li.childNodes).filter(c => !(c.nodeType === 1 && c.tagName.toLowerCase() === 'input')).map(walk).join('').trim();
                  return \`- [\${cb.checked ? 'x' : ' '}] \${txt}\`;
                }
                const t = Array.from(li.childNodes).map(walk).join('').trim();
                return isOl ? \`\${n + 1}. \${t}\` : \`- \${t}\`;
              });
              return parts.join('<br>');
            }
            return Array.from(cell.childNodes).map(walk).join('').trim().replace(/\\n+/g, ' ');
          };
          const walkRow = tr => {
            const cells = Array.from(tr.querySelectorAll('th, td'));
            return \`| \${cells.map(walkCell).join(' | ')} |\`;
          };
          const rows = Array.from(node.querySelectorAll('tr'));
          if (!rows.length) return inner;
          const lines = [];
          rows.forEach((tr, i) => {
            lines.push(walkRow(tr));
            if (i === 0) lines.push(\`| \${Array.from(tr.querySelectorAll('th, td')).map(() => '---').join(' | ')} |\`);
          });
          return lines.join('\\n') + '\\n\\n';
        }
        case 'thead': case 'tbody': case 'tr': case 'th': case 'td': return inner;
        case 'p':      case 'div':             { const t = inner.replace(/\\n+$/, ''); return t.trim() ? t + '\\n\\n' : '\\n\\n'; }
        case 'img': {
          const sp  = node.getAttribute('data-storage-path') || node.getAttribute('src') || '';
          const alt = node.getAttribute('alt') || 'image';
          return \`![\${alt}](\${sp})\\n\`;
        }
        default:                               return inner;
      }
    }
    return Array.from(tmp.childNodes).map(walk).join('').replace(/\\n+$/, '');
  }

    function simpleMarkdown(md) {
    if (!md) return '';
    const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    const inline = raw => {
      const imgMatch = raw.match(/^!\\[([^\\]]*)\\]\\(([^)]+)\\)/);
      if (imgMatch) {
        const storagePath = imgMatch[2];
        const src = imageUriMap[storagePath] || storagePath;
        return '<img src="' + src + '" alt="' + esc(imgMatch[1]) + '" data-storage-path="' + esc(storagePath) + '" style="max-width:100%;border-radius:4px;margin:4px 0;display:block;">';
      }
      let l = esc(raw)
        .replace(/↵/g,                  '<br>')
        .replace(/&lt;br[^&]*&gt;/gi,   '<br>')
        .replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>')
        .replace(/\\*(.+?)\\*/g,        '<em>$1</em>')
        .replace(/\`(.+?)\`/g,          '<code>$1</code>')
        .replace(/~~(.+?)~~/g,          '<del>$1</del>')
        .replace(/\\+\\+(.+?)\\+\\+/g,  '<u>$1</u>')
        .replace(/(?<!!)\\[([^\\]]+)\\]\\(([^)]+)\\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
      if (/^(#{1,3})\\s/.test(raw)) {
        const lvl = raw.match(/^(#+)/)[1].length;
        l = \`<h\${lvl}>\${l.replace(/^#+\\s/, '')}</h\${lvl}>\`;
      }
      return l;
    };
    const lines = md.split('\\n');
    const out = [];
    let i = 0;
    while (i < lines.length) {
      if (lines[i].startsWith('\`\`\`')) {
        const codeLines = [];
        i++;
        while (i < lines.length && !lines[i].startsWith('\`\`\`')) { codeLines.push(esc(lines[i])); i++; }
        if (i < lines.length) i++; // skip closing fence line
        out.push(\`<pre>\${codeLines.join('\\n')}</pre>\`);
        continue;
      }
      if (/^[-*]\\s/.test(lines[i])) {
        const items = [];
        let hasTask = false;
        while (i < lines.length && /^[-*]\\s/.test(lines[i])) {
          const tm = lines[i].match(/^[-*]\\s\\[([ x])\\]\\s(.*)/);
          if (tm) {
            hasTask = true;
            const chk = tm[1] === 'x';
            items.push(\`<li class="task-item\${chk ? ' done' : ''}"><input type="checkbox" class="task-check"\${chk ? ' checked' : ''}> <span>\${inline(tm[2])}</span></li>\`);
          } else {
            items.push(\`<li>\${inline(lines[i].slice(2))}</li>\`);
          }
          i++;
        }
        out.push(hasTask
          ? \`<ul class="task-list">\${items.join('')}</ul>\`
          : \`<ul>\${items.join('')}</ul>\`);
      } else if (/^\\d+\\.\\s/.test(lines[i])) {
        const items = [];
        while (i < lines.length && /^\\d+\\.\\s/.test(lines[i])) {
          items.push(\`<li>\${inline(lines[i].replace(/^\\d+\\.\\s/, ''))}</li>\`);
          i++;
        }
        out.push(\`<ol>\${items.join('')}</ol>\`);
      } else if (/^> /.test(lines[i])) {
        const bqLines = [];
        while (i < lines.length && /^> /.test(lines[i])) {
          bqLines.push(inline(lines[i].slice(2)));
          i++;
        }
        out.push(\`<blockquote>\${bqLines.join('<br>')}</blockquote>\`);
      } else if (/^([-*_] *){3,}$/.test(lines[i].trim())) {
        out.push('<hr>');
        i++;
      } else if (/^\\|/.test(lines[i])) {
        const rows = [];
        while (i < lines.length && /^\\|/.test(lines[i])) {
          if (!/^[\\|\\s\\-:]+$/.test(lines[i])) {
            const cells = lines[i].split('|').slice(1, -1).map(c => c.trim());
            rows.push(cells);
          }
          i++;
        }
        if (rows.length > 0) {
          // Renders a table cell: detects <br>-separated bullet/ordered/checkbox lists.
          // After a tiptap round-trip, markdown-special chars get backslash-escaped
          // (e.g. "- item" → "\- item", "[x]" → "\[x\]"). We strip those escapes
          // before pattern-matching so list detection stays reliable.
          const cellContent = raw => {
            const html = inline(raw);
            const parts = html.split('<br>');
            if (parts.length < 2) return html;
            const norm = p => p.replace(/\\\\(.)/g, '$1');
            const ps = parts.map(norm);
            const allCheck   = ps.every(p => /^[-*] \\[[ x]\\] /.test(p));
            const allBullet  = !allCheck && ps.every(p => /^[-*] \\S/.test(p));
            const allOrdered = !allCheck && !allBullet && ps.every(p => /^\\d+\\. \\S/.test(p));
            if (allCheck) {
              const its = ps.map(p => {
                const ck = /^[-*] \\[x\\] /i.test(p);
                const tx = p.replace(/^[-*] \\[[ x]\\] /i, '');
                return '<li class="task-item' + (ck ? ' done' : '') + '"><input type="checkbox" class="task-check"' + (ck ? ' checked' : '') + ' disabled> <span>' + tx + '</span></li>';
              }).join('');
              return '<ul class="cell-list task-list">' + its + '</ul>';
            }
            if (allBullet) {
              const its = ps.map(p => '<li>' + p.replace(/^[-*] /, '') + '</li>').join('');
              return '<ul class="cell-list">' + its + '</ul>';
            }
            if (allOrdered) {
              const its = ps.map(p => '<li>' + p.replace(/^\\d+\\. /, '') + '</li>').join('');
              return '<ol class="cell-list">' + its + '</ol>';
            }
            return html;
          };
          const head = \`<thead><tr>\${rows[0].map(c => \`<th>\${cellContent(c)}</th>\`).join('')}</tr></thead>\`;
          const body = rows.slice(1).map(r => \`<tr>\${r.map(c => \`<td>\${cellContent(c)}</td>\`).join('')}</tr>\`).join('');
          out.push(\`<div class="table-scroll"><table>\${head}\${body ? \`<tbody>\${body}</tbody>\` : ''}</table></div>\`);
        }
      } else {
        if (!lines[i].trim()) {
          let blanks = 0;
          while (i < lines.length && !lines[i].trim()) { blanks++; i++; }
          const brs = Math.floor(blanks / 2);
          for (let b = 0; b < brs; b++) out.push('<p><br></p>');
          continue;
        }
        const rendered = inline(lines[i]);
        out.push(/^<h[1-6]>/.test(rendered) ? rendered : \`<p>\${rendered}</p>\`);
        i++;
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