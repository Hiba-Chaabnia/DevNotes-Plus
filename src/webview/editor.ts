/**
 * editor.ts — Tiptap rich-text editor for DevNotes
 *
 * Bundled by esbuild → media/editor.js
 * Runs inside a VS Code WebviewPanel — no Node.js APIs available.
 *
 * Message protocol (unchanged from Phase 1 textarea):
 *   Extension → Webview : { type: 'setContent', content: string }   (markdown)
 *   Webview → Extension : { type: 'save',       content: string }   (markdown)
 */

import { Editor, Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import StarterKit from '@tiptap/starter-kit';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import Image from '@tiptap/extension-image';
import Underline from '@tiptap/extension-underline';
import Link from '@tiptap/extension-link';
import { TableKit } from '@tiptap/extension-table';
import { Markdown } from 'tiptap-markdown';

// ── Globals injected by EditorPanel.ts before this script loads ──────────────
declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };
declare const __INITIAL_CONTENT__: string;
declare const __INITIAL_TITLE__: string;

// ── Indent depth limit ───────────────────────────────────────────────────────

const MAX_LIST_DEPTH = 4;

function listDepth(editor: Editor): number {
  const { $from } = editor.state.selection;
  let depth = 0;
  for (let d = $from.depth; d >= 0; d--) {
    const name = $from.node(d).type.name;
    if (name === 'listItem' || name === 'taskItem') depth++;
  }
  return depth;
}

// Runs before StarterKit's Tab handler (priority 1000 > default 100).
// Keeps a zero-width space (​) in every empty paragraph so tiptap-markdown
// serialises it as a real line rather than collapsing it.  When the user
// types into the paragraph the placeholder is stripped automatically.
const BlankParaPreserver = Extension.create({
  name: 'blankParaPreserver',
  // Higher priority so our Backspace/Delete shortcuts fire before StarterKit's.
  priority: 200,

  addKeyboardShortcuts() {
    const isBlankPara = () => {
      const { $from } = this.editor.state.selection;
      return $from.parent.type.name === 'paragraph' && $from.parent.textContent === '​';
    };
    const joinBlankUp = (): boolean => {
      if (!isBlankPara()) return false;
      const { state } = this.editor;
      const { $from }  = state.selection;
      const paraPos    = $from.before($from.depth); // doc position of blank node
      const paraSize   = $from.parent.nodeSize;     // 3 = open + ​ + close

      // joinBackward() requires cursor at offset 0. Move it there first.
      // Selection-only transactions are not recorded in undo history.
      this.editor.commands.setTextSelection($from.start($from.depth));

      if (this.editor.commands.joinBackward()) return true;

      // joinBackward failed — the blank paragraph is the first node.
      // Do NOT call joinForward: it would merge two consecutive blank paragraphs
      // into one (still a blank), causing an apparent "double press" effect.
      // Instead, delete the node directly so it vanishes in a single keystroke.
      if (state.doc.content.size > paraSize) {
        this.editor.view.dispatch(
          this.editor.state.tr.delete(paraPos, paraPos + paraSize)
        );
        return true;
      }
      return true; // only node in document — consume but do nothing
    };
    return {
      Backspace: joinBlankUp,
      Delete:    joinBlankUp,
    };
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('blankParaPreserver'),
        appendTransaction(transactions, _old, newState) {
          // Skip selection-only state changes — no doc content to fix.
          if (!transactions.some(t => t.docChanged)) return null;
          const tr = newState.tr;
          let modified = false;
          newState.doc.forEach((node, pos) => {
            if (node.type.name !== 'paragraph') return;
            const text = node.textContent;
            if (text === '') {
              // Empty paragraph — insert placeholder so the serialiser sees it
              tr.insertText('​', pos + 1);
              modified = true;
            } else if (text !== '​' && text.includes('​')) {
              // Real content mixed with placeholder — delete each ​ character
              // individually (right-to-left) so ProseMirror maps the cursor to
              // the correct position rather than snapping it to the range end.
              const toDelete: number[] = [];
              node.forEach((child, offset) => {
                if (!child.isText) return;
                for (let i = 0; i < child.text!.length; i++) {
                  if (child.text![i] === '​') toDelete.push(pos + 1 + offset + i);
                }
              });
              for (let i = toDelete.length - 1; i >= 0; i--) {
                tr.delete(toDelete[i], toDelete[i] + 1);
                modified = true;
              }
            }
          });
          return modified ? tr : null;
        },
      }),
    ];
  },
});

// Returns true (event consumed) when already at max depth so StarterKit
// cannot sink further.
const IndentLimiter = Extension.create({
  name: 'indentLimiter',
  priority: 1000,
  addKeyboardShortcuts() {
    return {
      Tab: () => {
        if (listDepth(this.editor) >= MAX_LIST_DEPTH) return true;
        return (
          this.editor.commands.sinkListItem('listItem') ||
          this.editor.commands.sinkListItem('taskItem')
        );
      },
    };
  },
});

// ── Underline ↔ markdown bridge ───────────────────────────────────────────────
// Standard markdown has no underline syntax. We store underline as ++text++ in
// note files (compatible with the sidebar card renderer), but tiptap-markdown
// doesn't understand that syntax. These helpers convert between the two forms
// so round-trips through the editor are lossless.

function toEditorMd(md: string): string {
  // Underline: ++text++ → <u>text</u>
  let result = md.replace(/\+\+(.+?)\+\+/g, '<u>$1</u>');

  // tiptap-markdown requires non-empty content after [ ] / [x] to recognise
  // a task item. Pad empty task items with a ZWS so the parser creates a real
  // task node; fromEditorMd strips it back before saving.
  result = result.replace(/^(- \[[ x]\] *)$/gm, '$1​');

  // tiptap-markdown needs \n\n between paragraphs to create separate nodes.
  // Our storage uses \n (from htmlToMarkdown). Insert a blank line between
  // consecutive regular-paragraph lines so Tiptap doesn't merge them.
  const lines = result.split('\n');
  const out: string[] = [];
  let inCode = false;
  const isStructural = (l: string) =>
    l.trim() === '' || /^([-*] |\d+\. |#{1,6} |>|```)/.test(l);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('```')) inCode = !inCode;
    out.push(line);
    if (!inCode && !isStructural(line) && i < lines.length - 1) {
      const next = lines[i + 1];
      if (!isStructural(next)) out.push('');
    }
  }
  return out.join('\n')
    // Convert intentional blank paragraphs to zero-width space placeholders so
    // Tiptap creates real (invisible) empty nodes — one placeholder per blank para.
    .replace(/\n{3,}/g, (match) => {
      const blanks = Math.floor(match.length / 2) - 1;
      return '\n\n' + '​\n\n'.repeat(blanks);
    });
}

function fromEditorMd(md: string): string {
  return md
    // Convert underline spans; skip if content is only whitespace/newlines
    .replace(/<u>([\s\S]*?)<\/u>/g, (_, inner) => {
      const c = inner.trim();
      return c ? `++${c}++` : '';
    })
    // Remove lone formatting markers that appear between paragraph breaks
    // (tiptap-markdown emits these for empty paragraphs with an active mark)
    .replace(/\n\n(\*{4}|\*\*|\*|\+{4}|\+\+)\n\n/g, '\n\n')
    .replace(/^(\*{4}|\*\*|\*|\+{4}|\+\+)$/gm, '')
    // Strip ZWS padding added to empty task items for tiptap-markdown compatibility
    .replace(/^(- \[[ x]\] *)​/gm, '$1')
    // Restore blank paragraph placeholders: removing ​ leaves the surrounding
    // \n\n…\n\n intact (≥3 newlines), which simpleMarkdown renders as a visual gap
    .replace(/^​$/gm, '');
}

// ── Bootstrap ────────────────────────────────────────────────────────────────
(function main() {
  const vscode   = acquireVsCodeApi();
  const statusEl = document.getElementById('save-status') as HTMLElement;
  const mountEl  = document.getElementById('editor-mount') as HTMLElement;
  const toolbarEl = document.getElementById('toolbar') as HTMLElement;
  const titleEl  = document.getElementById('title-input') as HTMLInputElement | null;

  let saveTimer: ReturnType<typeof setTimeout> | null = null;

  // ── Tiptap instance ──────────────────────────────────────────────────────
  // ── Title input ──────────────────────────────────────────────────────────
  if (titleEl) {
    titleEl.value = typeof __INITIAL_TITLE__ !== 'undefined' ? __INITIAL_TITLE__ : '';
    titleEl.addEventListener('blur', () => {
      const t = titleEl!.value.trim();
      if (t) vscode.postMessage({ type: 'saveTitle', title: t });
    });
    titleEl.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter')  { e.preventDefault(); titleEl!.blur(); }
      if (e.key === 'Escape') titleEl!.blur();
    });
  }

  const editor = new Editor({
    element: mountEl,
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
      }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Image.configure({ inline: false, allowBase64: true }),
      Underline,
      Link.configure({ openOnClick: false, autolink: true }),
      TableKit,
      IndentLimiter,
      BlankParaPreserver,
      Markdown.configure({
        html: true,
        linkify: true,
        transformCopiedText: true,
        transformPastedText: true,
      }),
    ],
    content: typeof __INITIAL_CONTENT__ !== 'undefined' ? toEditorMd(__INITIAL_CONTENT__) : '',
    autofocus: true,
    editorProps: {
      attributes: {
        class: 'prose',
        spellcheck: 'true',
      },
      handlePaste(_, event) {
        const items = Array.from(event.clipboardData?.items ?? []);
        const imageItem = items.find(item => item.type.startsWith('image/'));
        if (!imageItem) return false; // let Tiptap handle non-image pastes normally

        event.preventDefault();
        const file = imageItem.getAsFile();
        if (!file) return true;

        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = reader.result as string;
          const base64  = dataUrl.split(',')[1] ?? '';
          const ext     = imageItem.type.split('/')[1]?.split('+')[0] ?? 'png';
          vscode.postMessage({ type: 'pasteImage', base64, mimeType: imageItem.type, ext });
        };
        reader.readAsDataURL(file);
        return true; // we handled it — Tiptap should do nothing further
      },
    },
    onUpdate() {
      statusEl.textContent = 'Unsaved…';
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(save, 1000);
    },
  });

  function save() {
    const storage = editor.storage as unknown as Record<string, { getMarkdown(): string }>;
    const md = fromEditorMd(storage['markdown'].getMarkdown());
    vscode.postMessage({ type: 'save', content: md });
    statusEl.textContent = 'Saved';
  }

  // ── Toolbar active-state sync ────────────────────────────────────────────
  const ACTIVE_CHECKS: Record<string, () => boolean> = {
    bold:        () => editor.isActive('bold'),
    italic:      () => editor.isActive('italic'),
    strike:      () => editor.isActive('strike'),
    code:        () => editor.isActive('code'),
    h1:          () => editor.isActive('heading', { level: 1 }),
    h2:          () => editor.isActive('heading', { level: 2 }),
    h3:          () => editor.isActive('heading', { level: 3 }),
    bulletList:  () => editor.isActive('bulletList'),
    orderedList: () => editor.isActive('orderedList'),
    taskList:    () => editor.isActive('taskList'),
    blockquote:  () => editor.isActive('blockquote'),
    codeBlock:   () => editor.isActive('codeBlock'),
    underline:   () => editor.isActive('underline'),
    link:        () => editor.isActive('link'),
  };

  const canIndent  = () => listDepth(editor) < MAX_LIST_DEPTH && (editor.can().sinkListItem('listItem') || editor.can().sinkListItem('taskItem'));
  const canOutdent = () => editor.can().liftListItem('listItem') || editor.can().liftListItem('taskItem');

  function syncToolbar() {
    toolbarEl.querySelectorAll('[data-action]').forEach(el => {
      const btn = el as HTMLButtonElement;
      const action = btn.dataset.action ?? '';
      if (action in ACTIVE_CHECKS) {
        btn.classList.toggle('is-active', ACTIVE_CHECKS[action]());
      }
      if (action === 'undo')    btn.disabled = !editor.can().undo();
      if (action === 'redo')    btn.disabled = !editor.can().redo();
      if (action === 'indent')  btn.disabled = !canIndent();
      if (action === 'outdent') btn.disabled = !canOutdent();
    });
    // Reflect active state on each group's toggle button
    toolbarEl.querySelectorAll<HTMLElement>('.tb-grp').forEach(grp => {
      const toggle = grp.querySelector<HTMLButtonElement>('.tb-grp-toggle');
      if (toggle) toggle.classList.toggle('is-active', !!grp.querySelector('[data-action].is-active'));
    });
  }

  editor.on('selectionUpdate', syncToolbar);
  editor.on('transaction', syncToolbar);

  // ── Toolbar click handler ────────────────────────────────────────────────
  // Use mousedown + preventDefault so the editor never loses focus
  toolbarEl.addEventListener('mousedown', e => {
    const btn = (e.target as Element).closest('[data-action]') as HTMLButtonElement | null;
    if (!btn || btn.disabled) return;
    e.preventDefault();
    // Close any open group popup after an action
    toolbarEl.querySelectorAll('.tb-grp-content.open').forEach(el => el.classList.remove('open'));

    const ch = editor.chain().focus();
    switch (btn.dataset.action) {
      case 'bold':        ch.toggleBold().run();                break;
      case 'italic':      ch.toggleItalic().run();              break;
      case 'strike':      ch.toggleStrike().run();              break;
      case 'code':        ch.toggleCode().run();                break;
      case 'h1':          ch.toggleHeading({ level: 1 }).run(); break;
      case 'h2':          ch.toggleHeading({ level: 2 }).run(); break;
      case 'h3':          ch.toggleHeading({ level: 3 }).run(); break;
      case 'bulletList':  ch.toggleBulletList().run();          break;
      case 'orderedList': ch.toggleOrderedList().run();         break;
      case 'taskList':    ch.toggleTaskList().run();            break;
      case 'indent':
        if (!editor.chain().focus().sinkListItem('listItem').run())
             editor.chain().focus().sinkListItem('taskItem').run();
        break;
      case 'outdent':
        if (!editor.chain().focus().liftListItem('listItem').run())
             editor.chain().focus().liftListItem('taskItem').run();
        break;
      case 'blockquote':  ch.toggleBlockquote().run();          break;
      case 'codeBlock':   ch.toggleCodeBlock().run();           break;
      case 'hr':          ch.setHorizontalRule().run();         break;
      case 'underline':   ch.toggleUnderline().run();            break;
      case 'link': {
        if (editor.isActive('link')) {
          ch.unsetLink().run();
        } else {
          const url = window.prompt('URL:');
          if (url?.trim()) ch.setLink({ href: url.trim() }).run();
        }
        break;
      }
      case 'undo':        ch.undo().run();                      break;
      case 'redo':        ch.redo().run();                      break;
      case 'exportCurrentNote':
        vscode.postMessage({ type: 'exportCurrentNote' });
        break;
      case 'applyTemplate':
        vscode.postMessage({ type: 'applyTemplate' });
        break;
      case 'saveAsTemplate': {
        const mdStorage = editor.storage as unknown as Record<string, { getMarkdown(): string }>;
        vscode.postMessage({ type: 'saveAsTemplate', content: fromEditorMd(mdStorage['markdown'].getMarkdown()) });
        break;
      }
    }
  });

  // ── Messages from extension ──────────────────────────────────────────────
  window.addEventListener('message', ({ data }) => {
    if (data?.type === 'setContent') {
      // Pass emitUpdate:false so auto-save doesn't fire on programmatic updates
      editor.commands.setContent(toEditorMd(data.content ?? ''), { emitUpdate: false } as never);
      if (titleEl && data.title !== undefined) {
        titleEl.value = data.title;
      }
    }
    if (data?.type === 'insertTemplate') {
      // emitUpdate fires onUpdate → schedules auto-save so the template content persists
      editor.commands.setContent(toEditorMd(data.content ?? ''));
      statusEl.textContent = 'Unsaved…';
    }
    if (data?.type === 'insertImage') {
      editor.chain().focus().setImage({ src: data.src as string, alt: 'image' }).run();
    }
  });

  // ── Responsive toolbar ───────────────────────────────────────────────────────
  (function setupResponsiveToolbar() {
    const groups = Array.from(toolbarEl.querySelectorAll<HTMLElement>('.tb-grp'));

    function closeAll() {
      toolbarEl.querySelectorAll('.tb-grp-content.open').forEach(el => el.classList.remove('open'));
    }

    // Group toggle click → open/close popup
    groups.forEach(grp => {
      const toggle  = grp.querySelector<HTMLButtonElement>('.tb-grp-toggle')!;
      const content = grp.querySelector<HTMLElement>('.tb-grp-content')!;
      toggle.addEventListener('mousedown', e => {
        e.preventDefault();
        e.stopPropagation();
        const wasOpen = content.classList.contains('open');
        closeAll();
        if (!wasOpen) content.classList.add('open');
      });
    });

    // Click outside → close all popups
    document.addEventListener('mousedown', e => {
      if (!(e.target as Element).closest('.tb-grp')) closeAll();
    });

    // Collapse groups right-to-left until the toolbar fits
    function updateLayout() {
      groups.forEach(g => g.classList.remove('collapsed'));
      closeAll();
      toolbarEl.style.overflow = 'hidden';
      for (let i = groups.length - 1; i >= 0; i--) {
        if (toolbarEl.scrollWidth <= toolbarEl.clientWidth) break;
        groups[i].classList.add('collapsed');
      }
      toolbarEl.style.overflow = '';
    }

    new ResizeObserver(updateLayout).observe(toolbarEl);
    updateLayout();
  })();

  // ── Tab / Shift+Tab — stop Tab from reaching VS Code after ProseMirror runs ─
  // ProseMirror (StarterKit) handles Tab → sinkListItem and Shift-Tab →
  // liftListItem via its own keymap. We just stop propagation afterward so
  // VS Code's preload (which listens at document level) never sees the event.
  editor.view.dom.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Tab') e.stopPropagation();
  });

  // ── Flush pending save when the panel is closed ──────────────────────────
  window.addEventListener('pagehide', () => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
      save();
    }
  });
})();
