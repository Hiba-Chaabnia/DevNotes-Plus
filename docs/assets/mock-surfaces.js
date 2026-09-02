/* DevNotes+ — extra mock surfaces.

   The hero mock is the sidebar and a code editor. Three features do not live
   there, so each gets a surface built here and mounted into a clone by the
   scene runner:

     buildEditorPanel()  src/views/EditorPanel.ts — the block editor, which is
                         a webview tab in the editor group, not a panel
     buildTerminal()     VS Code's own panel, for the MCP server: the value of
                         it happens in Claude Code, outside the workbench
     buildScm()          VS Code's own Source Control view, for team sharing:
                         notes are files in .devnotes/, so the proof is a diff

   Strings, icons, class names and colours are the extension's or VS Code's.
   Where a value is VS Code's rather than DevNotes+', it is named in a comment
   so the two are never confused. Icons come from assets/mock-icons.js. */
(function (global) {
  'use strict';

  function ico(name) {
    return (typeof MOCK_ICONS !== 'undefined' && MOCK_ICONS[name]) || '';
  }

  /* ── Block editor ──────────────────────────────────────────────────────
     EditorPanel.buildHtml(): a title input, a toolbar of singles and
     collapsible groups, then the ProseMirror document. The toolbar order is
     that file's, verbatim — bold/italic/underline, then the text, headings,
     lists and table groups, each behind its own toggle. */
  function buildEditorPanel(title) {
    return ''
      + '<div class="ed-panel">'
      +   '<input class="ed-title" value="' + (title || 'Untitled') + '" readonly>'
      +   '<div class="ed-toolbar">'
      +     tb('bold', 'Bold (Ctrl+B)', 'Bold')
      +     tb('italic', 'Italic (Ctrl+I)', 'Italic')
      +     tb('underline', 'Underline (Ctrl+U)', 'Underline')
      +     '<span class="tb-sep"></span>'
      +     tb('grpText', 'More formatting', 'Type')
      +     '<span class="tb-sep"></span>'
      +     tb('grpHeadings', 'Headings', 'Heading')
      +     '<span class="tb-sep"></span>'
      +     tb('grpLists', 'Lists &amp; indent', 'AlignJustify')
      +     '<span class="tb-sep"></span>'
      +     tb('grpTable', 'Table', 'Table')
      +     '<span class="tb-sep"></span>'
      +     tb('grpTemplates', 'Templates', 'LayoutTemplate')
      +     tb('export', 'Export', 'SquareArrowOutUpRight')
      +     '<span class="tb-spacer"></span>'
      +     tb('undo', 'Undo', 'Undo2')
      +     tb('redo', 'Redo', 'Redo2')
      +   '</div>'
      +   '<div class="ed-mount"><div class="ProseMirror ed-doc"></div></div>'
      + '</div>';
  }

  function tb(action, title, icon) {
    return '<button class="tb-btn" data-tb="' + action + '" title="' + title + '">'
         + ico(icon) + '</button>';
  }

  /* The document the block-editor scene types into. Every construct here is
     one the toolbar above can produce: headings, a task list, inline code, a
     fenced block and a table. */
  var ED_BLOCKS = [
    '<h2>Context</h2>',
    '<p>Secondary rate limits are per <code>installation token</code>, not per IP, '
      + 'so spreading calls across runners does not help.</p>',
    '<h2>Decision</h2>',
    '<ul data-type="taskList">'
      + '<li data-checked="true"><input type="checkbox" checked><div>Back off on 403 + <code>Retry-After</code></div></li>'
      + '<li data-checked="false"><input type="checkbox"><div>Cache the issue list for 60s</div></li>'
      + '</ul>',
    '<pre><code>if (res.status === 403 &amp;&amp; res.headers[\'retry-after\']) {\n'
      + '  await sleep(Number(res.headers[\'retry-after\']) * 1000);\n}</code></pre>',
    '<table><tbody>'
      + '<tr><th>Endpoint</th><th>Budget</th></tr>'
      + '<tr><td>GET /issues</td><td>900/hr</td></tr>'
      + '<tr><td>POST /issues</td><td>60/hr</td></tr>'
      + '</tbody></table>',
  ];

  /* ── Terminal panel ────────────────────────────────────────────────────
     VS Code's panel, not a DevNotes+ surface. The tab labels and their order
     are the workbench's; TERMINAL is the active one. */
  function buildTerminal() {
    var tabs = ['Problems', 'Output', 'Debug Console', 'Terminal', 'Ports'];
    return ''
      + '<div class="vsc-panel">'
      +   '<div class="panel-tabs">'
      +     tabs.map(function (t) {
            return '<span class="panel-tab' + (t === 'Terminal' ? ' active' : '') + '">' + t + '</span>';
          }).join('')
      +   '</div>'
      +   '<div class="panel-body"><div class="term"></div></div>'
      + '</div>';
  }

  /* ── Source Control view ───────────────────────────────────────────────
     VS Code's own SCM view. Decoration colours are the workbench's
     gitDecoration.* Dark Modern values, set in mock-scenes.css.

     A note file is <id>.md, where the id is base36 time plus random
     (NoteStorage.generateId) — never a slug of the title. .devnotes/.gitignore
     ignores every note by default, so sharing one shows up as that file being
     modified alongside the note itself becoming untracked-then-added. */
  function buildScm(branch) {
    return ''
      + '<div class="scm-view">'
      +   '<div class="vsc-viewtitle"><span>Source Control</span></div>'
      +   '<div class="scm-input" data-placeholder="Message (Ctrl+Enter to commit on \''
      +     (branch || 'main') + '\')"></div>'
      +   '<button class="scm-commit">Commit</button>'
      +   '<div class="scm-group"><span class="chev">'
      +     '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M3.14598 5.85423L7.64598 10.3542C7.84098 10.5492 8.15798 10.5492 8.35298 10.3542L12.853 5.85423C13.048 5.65923 13.048 5.34223 12.853 5.14723C12.658 4.95223 12.341 4.95223 12.146 5.14723L7.99998 9.29323L3.85398 5.14723C3.65898 4.95223 3.34198 4.95223 3.14698 5.14723C2.95198 5.34223 2.95098 5.65923 3.14598 5.85423Z"/></svg>'
      +     '</span><span>Changes</span><span class="spacer"></span>'
      +     '<span class="scm-count">0</span></div>'
      +   '<div class="scm-list"></div>'
      + '</div>';
  }

  function scmRow(file, dir, status) {
    var letter = { modified: 'M', untracked: 'U', added: 'A', deleted: 'D' }[status] || 'M';
    return '<div class="scm-row s-' + status + '">'
         + '<span class="scm-file">' + file + '</span>'
         + '<span class="scm-dir">' + dir + '</span>'
         + '<span class="scm-status">' + letter + '</span>'
         + '</div>';
  }

  global.MockSurfaces = {
    buildEditorPanel: buildEditorPanel,
    buildTerminal: buildTerminal,
    buildScm: buildScm,
    scmRow: scmRow,
    ED_BLOCKS: ED_BLOCKS,
  };
})(window);
