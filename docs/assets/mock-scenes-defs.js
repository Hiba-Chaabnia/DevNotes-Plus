/* DevNotes+ — the scenes themselves.

   One object per feature illustration. Steps are [timeMs, action, ...args];
   the action vocabulary is at the top of assets/mock-scenes.js. Times are
   absolute from the start of the scene, not cumulative, so reordering a beat
   never shifts the ones after it.

   Preview them at scenes.html, which gives each one a scrubber. */
(function () {
  'use strict';

  var S = window.MockScenes;

  // ── code samples ──────────────────────────────────────────────────────
  // Same {n, html, note} shape as codeLines in assets/vscode-mock.js.
  var kw = function (s) { return '<span class="c-kw">' + s + '</span>'; };
  var fn = function (s) { return '<span class="c-fn">' + s + '</span>'; };
  var vr = function (s) { return '<span class="c-var">' + s + '</span>'; };
  var st = function (s) { return '<span class="c-str">' + s + '</span>'; };
  var cm = function (s) { return '<span class="c-cm">' + s + '</span>'; };
  var nm = function (s) { return '<span class="c-num">' + s + '</span>'; };

  var ANCHOR_NOTE = {
    title: 'Rate limit is per-token, not per-IP',
    meta: 'Reference · Hiba · Aug 26',
  };

  /* Before: the call sits on line 5. */
  var BEFORE = [
    { n: 1, html: kw('import') + ' { ' + vr('Octokit') + ' } ' + kw('from') + ' ' + st("'octokit'") + ';' },
    { n: 2, html: '' },
    { n: 3, html: kw('export') + ' ' + kw('async') + ' ' + kw('function') + ' ' + fn('fetchIssues') + '(' + vr('repo') + ') {' },
    { n: 4, html: '  ' + kw('const') + ' ' + vr('gh') + ' = ' + kw('new') + ' ' + fn('Octokit') + '();' },
    { n: 5, html: '  ' + kw('return') + ' ' + vr('gh') + '.' + fn('paginate') + '(' + st("'GET /issues'") + ');', note: ANCHOR_NOTE },
    { n: 6, html: '}' },
  ];

  /* After: four lines land above it and the call is on line 9. Nothing about
     the note changed — it is re-found by content, which is the whole point of
     the scene. */
  var AFTER = [
    { n: 1, html: kw('import') + ' { ' + vr('Octokit') + ' } ' + kw('from') + ' ' + st("'octokit'") + ';' },
    { n: 2, html: '' },
    { n: 3, html: kw('export') + ' ' + kw('async') + ' ' + kw('function') + ' ' + fn('fetchIssues') + '(' + vr('repo') + ') {' },
    { n: 4, html: '  ' + kw('const') + ' ' + vr('gh') + ' = ' + kw('new') + ' ' + fn('Octokit') + '();' },
    { n: 5, html: '  ' + cm('// retry the whole page on a secondary limit') },
    { n: 6, html: '  ' + kw('const') + ' ' + vr('retries') + ' = ' + nm('3') + ';' },
    { n: 7, html: '  ' + kw('let') + ' ' + vr('attempt') + ' = ' + nm('0') + ';' },
    { n: 8, html: '' },
    { n: 9, html: '  ' + kw('return') + ' ' + vr('gh') + '.' + fn('paginate') + '(' + st("'GET /issues'") + ');', note: ANCHOR_NOTE },
    { n: 10, html: '}' },
  ];

  var CAPTURE = [
    { n: 1, html: cm('// DevNotes+ quickstart') },
    { n: 2, html: '' },
    { n: 3, html: cm('// Cursor on any line → Ctrl+Alt+Q') },
    { n: 4, html: kw('const') + ' ' + vr('note') + ' = ' + fn('capture') + '({' },
    { n: 5, html: '  file: ' + st("'src/github/client.js'") + ',' },
    { n: 6, html: '  line: ' + nm('60') + ',' },
    { n: 7, html: '});' },
  ];

  var CAPTURED = CAPTURE.map(function (l) {
    return l.n === 5
      ? { n: 5, html: l.html, note: { title: 'Notes stick to the line', meta: 'Reference · Hiba · Aug 26' } }
      : l;
  });


  // ── the features, as the files they are read in ───────────────────────
  // The section's copy lives here rather than beside the window: each feature
  // is a markdown file open in the editor while its demo plays in the sidebar,
  // the gutter and the panel around it. Markdown token colours are Dark+'s.
  var mh = function (s) { return '<span class="m-h">' + s + '</span>'; };
  var mb = function (s) { return '<span class="m-b">' + s + '</span>'; };
  var mc = function (s) { return '<span class="m-code">' + s + '</span>'; };
  var ml = function (s) { return '<span class="m-li">-</span> ' + s; };
  var mp = function (s) { return '<span class="m-p">' + s + '</span>'; };

  /* lines(['# Title', '', 'body'], noteLine, note) — authored as plain text,
     tokenised here, so the copy stays readable in this file. */
  function mdLines(rows, noteAt, note) {
    return rows.map(function (row, i) {
      var n = i + 1;
      var html;
      if (row.indexOf('# ') === 0) { html = mh(row); }
      else if (row.indexOf('- ') === 0) { html = ml(mp(row.slice(2))); }
      else if (row === '') { html = ''; }
      else { html = mp(row); }
      html = html.replace(/&#96;([^&#96;]+)&#96;/g, function (_, s) { return mc(s); });
      return (n === noteAt && note) ? { n: n, html: html, note: note } : { n: n, html: html };
    });
  }

  var MD_NOTE = {
    anchoring: { title: 'Pinned to line 7 of this file', meta: 'Reference · Hiba · Aug 26' },
    branch:    { title: 'Visible on every branch',       meta: 'Reference · Hiba · Aug 27' },
    editor:    { title: 'There is a document behind me',  meta: 'Reference · Hiba · Aug 29' },
    github:    { title: 'Linked to PR 412',              meta: 'Todo · Hiba · Aug 30' },
    sharing:   { title: 'Shared with the team',          meta: 'Reference · Hiba · Aug 30' },
    mcp:       { title: 'Cache the issue list for 60s',  meta: 'Todo · Hiba · Aug 31' },
  };

  var MD = {
    readme: mdLines([
      '# DevNotes+ features',
      '',
      'Seven pages. Each one is a file in this folder, and',
      'each has its own demo running in the window around it.',
      '',
      '- 1-anchoring.md',
      '- 2-branch.md',
      '- 3-organizing.md',
      '- 4-editor.md',
      '- 5-pull-requests.md',
      '- 6-sharing.md',
      '- 7-claude-code.md',
      '',
      'Scroll to turn the page.',
    ], 3, { title: 'Start here', meta: 'Reference · Hiba · Aug 26' }),

    anchoring: mdLines([
      '# Notes that stick to the line',
      '',
      'Write the note where the problem is. DevNotes+ keeps',
      'the line, not the line number.',
      '',
      'Paste fifty lines above it and the note comes with',
      'them. It is re-found by content, every time.',
      '',
      '- Gutter pin on every noted line',
      '- Click a card to jump back to the code',
      '- Survives renames and refactors',
    ], 7, MD_NOTE.anchoring),

    anchoringAfter: mdLines([
      '# Notes that stick to the line',
      '',
      'Write the note where the problem is. DevNotes+ keeps',
      'the line, not the line number.',
      '',
      'Line numbers are the one thing about a file that is',
      'guaranteed to change. Three lines land here and',
      'everything below moves down.',
      '',
      'Paste fifty lines above it and the note comes with',
      'them. It is re-found by content, every time.',
      '',
      '- Gutter pin on every noted line',
      '- Click a card to jump back to the code',
      '- Survives renames and refactors',
    ], 10, MD_NOTE.anchoring),

    organizing: mdLines([
      '# Templates, tags and reminders',
      '',
      'Start from a template. Colour your own tags. Put a date',
      'on anything you need to come back to.',
      '',
      'Filter the list by tag and the rest steps aside.',
      '',
      '- Six built-in templates',
      '- Your own tag names, colours and icons',
      '- A reminder date on any note',
    ], 6, { title: 'Ship notes for Friday', meta: 'Idea \u00b7 Hiba \u00b7 Aug 28' }),

    branch: mdLines([
      '# One branch at a time',
      '',
      'Scope a note to the branch it belongs to. Switch',
      'branches and the list filters itself.',
      '',
      'Nothing is deleted. Switch back and it returns.',
      '',
      '- Branch read straight from the repo',
      '- Global or branch-scoped, per note',
      '- The status bar counts the notes on this file',
    ], 6, MD_NOTE.branch),

    editor: mdLines([
      '# When a note outgrows its card',
      '',
      'Open it as a document: headings, task lists, code',
      'blocks with highlighting, tables and images.',
      '',
      'Markdown in. Markdown on disk. No lock-in.',
      '',
      '- Six templates to start from',
      '- Tick tasks off inside the note',
    ], 6, MD_NOTE.editor),

    github: mdLines([
      '# The pull request it is about',
      '',
      'Paste a PR or issue URL onto a note and the badge',
      'tracks it from then on.',
      '',
      'Open, closed, merged — without going to look.',
      '',
      '- Link a note to a PR or an issue',
      '- Or open the issue straight from the note',
    ], 6, MD_NOTE.github),

    sharing: mdLines([
      '# Private until you say otherwise',
      '',
      'The .devnotes folder is gitignored the moment it is',
      'created. Share one note and that one file is un-ignored.',
      '',
      'It shows up in Source Control, and nowhere else.',
      '',
      '- No account, no server, no telemetry',
      '- Conflicts resolved in the panel',
    ], 6, MD_NOTE.sharing),

    mcp: mdLines([
      '# Claude Code reads your notes',
      '',
      'One command registers the built-in MCP server. Then',
      'ask it what is still open on this branch.',
      '',
      'It answers from the notes, and ticks them off.',
      '',
      '- Fourteen tools over MCP',
      '- No API key, no config file',
    ], 6, MD_NOTE.mcp),
  };

  // The eight pages of the features section, open as eight editor tabs. The
  // one being read is the active tab, so turning the page is a tab changing
  // rather than one file quietly renaming itself.
  var FILES = [
    'README.md', '1-anchoring.md', '2-branch.md', '3-organizing.md', '4-editor.md',
    '5-pull-requests.md', '6-sharing.md', '7-claude-code.md',
  ];

  /* Opening a feature's file: its tab, the breadcrumb, the language, and the
     markdown tokens the arrival animation hangs off. */
  function open(slug, lines, at) {
    return [
      ['toggle', '.vsc-code', 'md', true],
      ['tabs', FILES, slug + '.md'],
      ['file', slug + '.md'],
      ['crumb', 'devnotes-plus \u203A features \u203A ' + slug + '.md', null],
      ['text', '.vsc-statusbar .vsc-status-item:last-child', 'Markdown'],
      ['code', lines, at],
      ['line', at],
    ];
  }

  // ── the cards, per feature ────────────────────────────────────────────
  // Every scene sets its own notes, so the window is never illustrating one
  // feature with another one's content. Bodies are what a developer would
  // plausibly have written at that line.
  var CARD = {
    anchor: {
      title: 'Pinned to line 7 of this file',
      body: 'Not to the number — to the sentence. Paste anything above it and '
          + 'the pin comes along.',
      tags: ['Reference'], link: '1-anchoring.md:7', date: 'Aug 26', star: true,
      clamped: false,
    },
    global: {
      title: 'Visible on every branch',
      body: 'No branch scope, so it follows you wherever you check out.',
      tags: ['Reference'], link: '2-branch.md:6', date: 'Aug 27', star: false,
      clamped: false,
    },
    branchScoped: {
      title: 'Only on this branch',
      body: 'Scoped to main. Check out anything else and it steps out of the way.',
      tags: ['Todo'], date: 'Aug 28', star: false, clamped: false,
    },
    tplIdea: {
      title: 'Ship notes for Friday',
      body: 'Started from the Meeting template. Tagged Idea, due Sep 4.',
      tags: ['Idea'], link: '3-organizing.md:6', date: 'Aug 28', star: false,
      clamped: false,
    },
    tplRef: {
      title: 'Six templates ship in the box',
      body: 'Meeting, decision, bug, spike, review and blank. Start from one '
          + 'and the note opens already written.',
      tags: ['Reference'], date: 'Aug 27', star: false, clamped: false,
    },
    editorNote: {
      title: 'There is a document behind me',
      body: 'Headings, tasks, a code block and a table. Too much for a card.',
      tags: ['Reference'], link: '4-editor.md:6', date: 'Aug 29', star: false,
      clamped: false,
    },
    pr: {
      title: 'Linked to PR 412',
      body: 'Back off on secondary rate limits. The badge follows its state.',
      tags: ['Todo'], link: '5-pull-requests.md:6', date: 'Aug 30', star: false,
      clamped: false,
    },
    share: {
      title: 'Shared with the team',
      body: 'One file un-ignored in .devnotes/, staged like any other change.',
      tags: ['Reference'], link: '6-sharing.md:6', date: 'Aug 30', star: false,
      clamped: false,
    },
    todo: {
      title: 'Cache the issue list for 60s',
      body: 'Same three repos every run — 60s is enough to stop hammering the API.',
      tags: ['Todo'], link: '7-claude-code.md:6', date: 'Aug 31', star: false,
      clamped: false,
    },
    claude: {
      title: 'Restart Claude Code to apply',
      body: 'MCP server registered. Restart, then ask it what is still open.',
      tags: ['Todo'], link: '7-claude-code.md:9', date: 'Aug 31', star: false,
      clamped: false,
    },
  };

  // ── the features folder, opened ───────────────────────────────────────
  // What the features section used to say in a heading above the window. It
  // says it in the window instead: the folder's own README, at rest, with the
  // six files listed. Nothing animates — it is the page being opened.
  S.register({
    id: 'overview',
    duration: 2600,
    initial: [
      ['panel', true],
      ['activate', 'DevNotes+'],
      ['cards', 1],
      ['empty', false],
      ['card', 1, {
        title: 'Start here',
        body: 'Six pages, one demo each. Every note in this sidebar is a note on '
            + 'the file that is open.',
        tags: ['Reference'], link: 'README.md:3', date: 'Aug 26', star: false,
        clamped: false,
      }],
      ['status', '1 note here'],
      ['pointer', null],
    ].concat(open('README', MD.readme, 3)),
    steps: [],
  });

  // ── 0 · the hero intro ────────────────────────────────────────────────
  // What the page opens on: an untouched workbench, the panel opened by hand,
  // then the real Ctrl+Alt+Q capture flow. The page's own copy waits for this
  // to finish, so every beat is timed to be read rather than merely seen.
  S.register({
    id: 'intro',
    duration: 7000,
    initial: [
      ['panel', false],
      ['activate', null],
      ['file', 'quickstart.js'],
      ['code', CAPTURE, 5],
      ['line', 5],
      ['cards', 0],
      ['empty', true],
      ['status', null],
      ['quickinput', null],
      ['pointer', null],
      ['card', 1, {
        title: 'Notes stick to the line',
        body: 'Pinned to line 5. Come back after fifty lines land above it and it '
            + 'is still here — DevNotes+ re-finds it by content, not by number.',
        tags: ['Reference'], link: 'quickstart.js:5', date: 'Aug 26', star: true,
        clamped: false,
      }],
      ['card', 2, CARD.claude],
    ],
    steps: [
      [200,  'pointer', '[title="DevNotes+"]'],
      [900,  'click', '[title="DevNotes+"]'],
      [1040, 'activate', 'DevNotes+'],
      [1060, 'panel', true],
      [1500, 'pointer', null],
      [1900, 'screencast', 'Add DevNote Here ', 'Ctrl+Alt+Q', 1100],
      [2200, 'quickinput', 1],
      [2380, 'type', 'Notes stick to the line', 620],
      [3500, 'quickinput', 2],
      [4500, 'quickinput', 3],
      [5500, 'quickinput', null],
      [5600, 'code', CAPTURED, 5],
      [5600, 'note', 5, true],
      [5600, 'empty', false],
      [5650, 'cards', 1],
      [5800, 'status', '1 note here'],
      [6300, 'cards', 2],
    ],
  });

  // ── 0b · the handoff teaser ───────────────────────────────────────────
  // Plays once, at the end of the hero, while the window is still parked and
  // at full size: the breadcrumb's folder segment is clicked, the picker
  // opens on the workspace, and features/ is chosen. It is what motivates the
  // file the features section then opens on — without it, scrolling out of
  // the hero swaps one JS tab for eight markdown ones with nothing said.
  //
  // The picker jumps straight from the workspace to features/README.md rather
  // than making the reader watch a second level expand. That is the one
  // liberty here; everything else is the real widget.
  S.register({
    id: 'teaser',
    duration: 2400,
    // Where the intro left the hero, so the beat continues it rather than
    // resetting the window under the reader.
    initial: [
      ['panel', true],
      ['activate', 'DevNotes+'],
      // Stated rather than inherited: the strip is content a previous run
      // wrote, and blank() cannot take that back off, so a replay or a scrub
      // would otherwise open on the eight tabs this beat is meant to reveal.
      ['tabs', ['quickstart.js'], 'quickstart.js'],
      ['file', 'quickstart.js'],
      ['code', CAPTURED, 5],
      ['note', 5, true],
      ['line', 5],
      ['empty', false],
      ['cards', 2],
      ['status', '1 note here'],
      ['crumb', 'devnotes-plus › quickstart.js', null],
      ['crumbpick', null],
      ['pointer', null],
      ['card', 1, {
        title: 'Notes stick to the line',
        body: 'Pinned to line 5. Come back after fifty lines land above it and it '
            + 'is still here — DevNotes+ re-finds it by content, not by number.',
        tags: ['Reference'], link: 'quickstart.js:5', date: 'Aug 26', star: true,
        clamped: false,
      }],
      ['card', 2, CARD.claude],
    ],
    steps: [
      [150,  'pointer', '.bc-seg'],
      [500,  'crumb', 'devnotes-plus › quickstart.js', 1],
      [700,  'click', '.bc-seg'],
      [840,  'crumbpick', 0],
      [1050, 'pointer', '.bc-row'],
      [1150, 'crumbpick', 1],
      [1500, 'click', '.bc-row'],
      [1640, 'crumbpick', null],
      [1660, 'pointer', null],
      [1680, 'crumb', 'devnotes-plus › quickstart.js', null],
    ].concat(open('README', MD.readme, 3).map(function (s) { return [1700].concat(s); })),
  });

  // ── 1 · capture ───────────────────────────────────────────────────────
  // Ctrl+Alt+Q, the real three prompts, then the note exists. This is the
  // hero entrance's second half, restated as data.
  S.register({
    id: 'capture',
    loop: true,
    duration: 8200,
    initial: [
      ['panel', true],
      ['activate', 'DevNotes+'],
      ['code', CAPTURE, 5],
      ['line', 5],
      ['cards', 0],
      ['empty', true],
      ['status', null],
      ['quickinput', null],
      ['pointer', null],
    ],
    steps: [
      [600,  'screencast', 'Add DevNote Here ', 'Ctrl+Alt+Q', 1100],
      [900,  'quickinput', 1],
      [1080, 'type', 'Notes stick to the line', 620],
      [2200, 'quickinput', 2],
      [3200, 'quickinput', 3],
      [4200, 'quickinput', null],
      [4300, 'code', CAPTURED, 5],
      [4300, 'note', 5, true],
      [4300, 'empty', false],
      [4350, 'cards', 1],
      [4500, 'status', '1 note here'],
      [5100, 'cards', 2],
      [5300, 'status', '1 note here'],
    ],
  });

  // ── 2 · anchoring ─────────────────────────────────────────────────────
  // Code lands above the anchor and the note goes with it. The card's code
  // link is what proves it moved: 5 becomes 9 with no interaction.
  S.register({
    id: 'anchoring',
    loop: true,
    duration: 7000,
    initial: [
      ['panel', true],
      ['activate', 'DevNotes+'],
      ['cards', 1],
      ['empty', false],
      ['card', 1, CARD.anchor],
    ].concat(open('1-anchoring', MD.anchoring, 7), [
      ['status', '1 note here'],
      ['pointer', null],
    ]),
    steps: [
      [900,  'screencast', 'Paste ', 'Ctrl+V', 900],
      [1200, 'code', MD.anchoringAfter, 10],
      [1200, 'line', 10],
      [1250, 'note', 10, true],
      [1900, 'text', '.sb-codelink .sb-chip-label', '1-anchoring.md:10'],
      [1900, 'card', 1, { title: 'Pinned to line 10 of this file' }],
      [2400, 'pointer', '.sb-codelink'],
      [3100, 'click', '.sb-codelink'],
      [3300, 'toggle', '.sb-card', 'active', true],
      [4200, 'pointer', null],
    ],
  });

  // ── 3 · branch scope ──────────────────────────────────────────────────
  // Switch branch and the panel filters itself; switch back and the note
  // returns. The reversal is the point — nothing was deleted, it was scoped.
  S.register({
    id: 'branch',
    loop: true,
    duration: 8000,
    initial: [
      ['panel', true],
      ['activate', 'DevNotes+'],
      ['cards', 2],
      ['empty', false],
      ['card', 1, CARD.global],
      ['card', 2, CARD.branchScoped],
      ['branch', 'main'],
    ].concat(open('2-branch', MD.branch, 6), [
      ['tag', 'All'],
      ['status', '1 note here'],
      ['pointer', null],
    ]),
    steps: [
      [900,  'pointer', '.vsc-status-branch'],
      [1600, 'click', '.vsc-status-branch'],
      [1800, 'branch', 'feature/rate-limit'],
      [2100, 'cards', 1],
      [4200, 'click', '.vsc-status-branch'],
      [4400, 'branch', 'main'],
      [4700, 'cards', 2],
      [5600, 'pointer', null],
    ],
  });
  // ── 3b · templates, tags and reminders ────────────────────────────────
  // The three things that are about a note's life rather than its anchor. The
  // tag bar filters the list for real, the way SidebarView does, and the
  // reminder lands on the note this page is about.
  S.register({
    id: 'organizing',
    loop: true,
    duration: 9500,
    initial: [
      ['panel', true],
      ['activate', 'DevNotes+'],
      ['cards', 2],
      ['empty', false],
      ['card', 1, CARD.tplIdea],
      ['card', 2, CARD.tplRef],
      ['reminder', 1, null],
      ['tag', 'All'],
      ['status', '1 note here'],
      ['pointer', null],
    ].concat(open('3-organizing', MD.organizing, 6)),
    steps: [
      [900,  'pointer', '.sb-tagbar .sb-chip:nth-child(2)'],
      [1600, 'click', '.sb-tagbar .sb-chip:nth-child(2)'],
      [1750, 'tag', 'Idea'],
      [1800, 'pointer', null],
      [3800, 'tag', 'All'],
      [4700, 'pointer', '.sb-card:first-child'],
      [5400, 'click', '.sb-card:first-child'],
      [5550, 'reminder', 1, 'Sep 4'],
      [5700, 'pointer', null],
    ],
  });

  // ── 4 · PR & issue linking ────────────────────────────────────────────
  // There is no keybinding for this — ctrl+alt+q is the extension's only one.
  // It is reached through the card's overflow menu, which then opens an input
  // box for the PR URL (placeholder at SidebarView.ts:703). githubFetchPR
  // fills in the title and state, so the badge tracks the PR: the scene ends
  // by having it merge underneath.
  S.register({
    id: 'github',
    loop: true,
    duration: 10000,
    initial: [
      ['panel', true],
      ['activate', 'DevNotes+'],
      ['cards', 1],
      ['empty', false],
      ['card', 1, CARD.pr],
      ['status', '1 note here'],
      ['github', 1, 'pr', 412, null],
      ['cardmenu', 1, null],
      ['pointer', null],
    ].concat(open('5-pull-requests', MD.github, 6)),
    steps: [
      [600,  'cardmenu', 1, null],
      [700,  'pointer', '.card-overflow-btn'],
      [1400, 'click', '.card-overflow-btn'],
      [1550, 'cardmenu', 1, { github: true, linked: true, branch: 'main', focus: 'Link to PR' }],
      [2200, 'pointer', '.ovf-item.is-focus'],
      [2900, 'click', '.ovf-item.is-focus'],
      [3100, 'cardmenu', 1, null],
      [3200, 'pointer', null],
      [3300, 'quickinput', 1],
      [3500, 'type', 'https://github.com/your-org/your-project/pull/412', 900],
      [5000, 'quickinput', null],
      [5200, 'github', 1, 'pr', 412, 'open', 'Back off on secondary rate limits'],
      [7400, 'github', 1, 'pr', 412, 'merged', 'Back off on secondary rate limits'],
    ],
  });

  // ── 5 · block editor ──────────────────────────────────────────────────
  // EditorPanel opens as a webview tab in the editor group, titled with the
  // note. The document builds a block at a time so each toolbar group is
  // shown doing something rather than merely being pointed at.
  S.register({
    id: 'editor',
    loop: true,
    duration: 11800,
    initial: [
      ['panel', true],
      ['activate', 'DevNotes+'],
      ['cards', 1],
      ['empty', false],
      ['card', 1, CARD.editorNote],
      ['status', '1 note here'],
      ['editor', null],
      ['blocks', 0],
      ['cardmenu', 1, null],
      ['pointer', null],
    ].concat(open('4-editor', MD.editor, 6)),
    steps: [
      [600,  'cardmenu', 1, null],
      [700,  'pointer', '.card-overflow-btn'],
      [1400, 'click', '.card-overflow-btn'],
      [1550, 'cardmenu', 1, { linked: true, branch: 'main', focus: 'Edit in editor' }],
      [2100, 'pointer', '.ovf-item.is-focus'],
      [2800, 'click', '.ovf-item.is-focus'],
      [2950, 'cardmenu', 1, null],
      [3000, 'editor', 'There is a document behind me'],
      [3050, 'pointer', null],
      [3500, 'blocks', 1],
      [3550, 'toolbar', 'grpHeadings'],
      [4300, 'blocks', 2],
      [4350, 'toolbar', null],
      [5300, 'blocks', 3],
      [5350, 'toolbar', 'grpHeadings'],
      [6200, 'blocks', 4],
      [6250, 'toolbar', 'grpLists'],
      [7400, 'blocks', 5],
      [7450, 'toolbar', 'grpText'],
      [8600, 'blocks', 6],
      [8650, 'toolbar', 'grpTable'],
      [9800, 'toolbar', null],
    ],
  });

  // ── 6 · team sharing over git ─────────────────────────────────────────
  // A note is one file in .devnotes/, ignored by default. Sharing un-ignores
  // it, so the proof is the Source Control view. The two files are exactly
  // what SidebarView.ts:403 tells you to stage, and the name is <id>.md —
  // base36 time plus random, per NoteStorage.generateId — never a slug.
  S.register({
    id: 'sharing',
    loop: true,
    duration: 11000,
    initial: [
      ['panel', true],
      ['activate', 'DevNotes+'],
      ['cards', 1],
      ['empty', false],
      ['card', 1, CARD.share],
      ['status', '1 note here'],
      ['shared', 1, false],
      ['cardmenu', 1, null],
      ['scm', null],
      ['pointer', null],
    ].concat(open('6-sharing', MD.sharing, 6)),
    steps: [
      [600,  'cardmenu', 1, null],
      [700,  'pointer', '.card-overflow-btn'],
      [1400, 'click', '.card-overflow-btn'],
      [1550, 'cardmenu', 1, { linked: true, branch: 'main', focus: 'Share' }],
      [2100, 'pointer', '.ovf-item.is-focus'],
      [2800, 'click', '.ovf-item.is-focus'],
      [2950, 'cardmenu', 1, null],
      [3000, 'shared', 1, true],
      [3900, 'pointer', '[title="Source Control"]'],
      [4600, 'click', '[title="Source Control"]'],
      [4750, 'activate', 'Source Control'],
      [4800, 'scm', [
        ['mfk2j9x8a4b1.md', '.devnotes', 'untracked'],
        ['.gitignore', '.devnotes', 'modified'],
      ], 'main'],
      [5000, 'pointer', null],
      [8000, 'click', '[title="DevNotes+"]'],
      [8150, 'activate', 'DevNotes+'],
      [8200, 'scm', null],
    ],
  });

  // ── 7 · MCP server ────────────────────────────────────────────────────
  // The one feature whose value happens outside the workbench, so this is the
  // one scene that leaves the sidebar: Claude Code in VS Code's panel,
  // reading the notes through the server. get_todos and complete_todo are two
  // of the fourteen tools in mcp-server/src/index.ts.
  var ASK = '&gt; what are my open todos on this branch?';
  var TICK = '&gt; tick off the first one';
  var HEAD = [
    ['dim', '$ claude'],
    ['you', ASK],
    ['tool', '\u23FA devnotes - get_todos (MCP)'],
  ];
  var RESULT = HEAD.concat([
    ['dim', '  \u2514 2 open todos on main'],
    '',
    'Two are still open on this branch:',
    '  1. Cache the issue list for 60s \u2014 7-claude-code.md:6',
    '  2. Restart Claude Code to apply',
  ]);
  S.register({
    id: 'mcp',
    loop: true,
    duration: 11500,
    initial: [
      ['panel', true],
      ['activate', 'DevNotes+'],
      ['cards', 2],
      ['empty', false],
      ['card', 1, CARD.todo],
      ['card', 2, CARD.claude],
      ['status', '2 notes here'],
      ['terminal', false],
      ['term', []],
      ['pointer', null],
    ].concat(open('7-claude-code', MD.mcp, 6)),
    steps: [
      [600,  'terminal', true],
      [800,  'term', [['dim', '$ claude']]],
      [1700, 'term', [['dim', '$ claude'], ['you', ASK]]],
      [2700, 'term', HEAD],
      [3700, 'term', RESULT],
      [6200, 'term', RESULT.concat(['', ['you', TICK]])],
      [7200, 'term', RESULT.concat([
        '', ['you', TICK],
        ['tool', '\u23FA devnotes - complete_todo (MCP)'],
        ['ok', '  \u2514 Done \u2014 the note updated in your sidebar.'],
      ])],
    ],
  });

})();
