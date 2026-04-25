import * as vscode from 'vscode';
import { NoteStorage } from '../services/NoteStorage';

/**
 * Manages gutter decorations and hover tooltips for code-linked DevNotes.
 *
 * Gutter icon: a sticky-note SVG appears on every line that has a note linked
 * to it. VS Code has no API for tooltips on gutter icons themselves — hovering
 * the icon area is outside the text surface and never fires hover providers.
 *
 * Hover tooltip: registered via vscode.languages.registerHoverProvider so that
 * hovering anywhere on a linked line shows the note title in the standard hover
 * widget. This is the correct VS Code API for line-level hover information.
 */
export class GutterController implements vscode.Disposable {
  private readonly decorationType: vscode.TextEditorDecorationType;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly storage: NoteStorage,
  ) {
    this.decorationType = vscode.window.createTextEditorDecorationType({
      gutterIconPath: vscode.Uri.joinPath(context.extensionUri, 'media', 'gutter-note.svg'),
      gutterIconSize: 'contain',
      overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.warningForeground'),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    });

    // Hover provider — fires when hovering line text in any file-scheme document.
    // Shows note titles for every note linked to that exact line.
    this.disposables.push(
      vscode.languages.registerHoverProvider(
        { scheme: 'file' },
        { provideHover: (doc, pos) => this.provideHover(doc, pos) },
      )
    );

    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(() => this.refresh()),
      vscode.window.onDidChangeVisibleTextEditors(() => this.refresh()),
    );

    this.refresh();
  }

  /** Re-compute gutter decorations for all visible editors. */
  refresh(): void {
    const notes = this.storage.getNotes();
    for (const editor of vscode.window.visibleTextEditors) {
      const relPath = vscode.workspace.asRelativePath(editor.document.uri, false);
      if (relPath === editor.document.uri.fsPath) {
        editor.setDecorations(this.decorationType, []);
        continue;
      }

      const linked = notes.filter(n => n.codeLink?.file === relPath);
      const ranges: vscode.Range[] = linked.map(note => {
        const lineIndex = Math.min(note.codeLink!.line - 1, editor.document.lineCount - 1);
        const pos = new vscode.Position(lineIndex, 0);
        return new vscode.Range(pos, pos);
      });
      editor.setDecorations(this.decorationType, ranges);
    }
  }

  /** Hover provider — shows note titles when hovering a linked line's text. */
  private provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.Hover | null {
    const relPath = vscode.workspace.asRelativePath(document.uri, false);
    if (relPath === document.uri.fsPath) return null;

    const linked = this.storage.getNotes().filter(
      n => n.codeLink?.file === relPath && n.codeLink.line - 1 === position.line
    );
    if (linked.length === 0) return null;

    const md = new vscode.MarkdownString();
    // isTrusted is required for command: URIs to be rendered as clickable links
    md.isTrusted = true;
    md.appendMarkdown('**DevNotes**\n\n');
    linked.forEach(n => {
      const args = encodeURIComponent(JSON.stringify([n.id]));
      // Escape ] so a title like "foo [bar]" doesn't break the markdown link syntax
      const safeTitle = n.title.replace(/\]/g, '\\]');
      md.appendMarkdown(`[${safeTitle}](command:devnotes.focusNote?${args})\n\n`);
    });
    return new vscode.Hover(md);
  }

  dispose(): void {
    this.decorationType.dispose();
    this.disposables.forEach(d => d.dispose());
  }
}
