/* DevNotes+ — VS Code mock scene runner.

   A "scene" is a short scripted demo of one feature, played inside its own
   copy of the hero mock. Scenes are data: an initial state and a list of
   [timeMs, action, ...args] steps. The runner knows nothing about any
   particular feature, so adding an illustration means writing a scene
   object, not a new stylesheet.

   The state itself lives in CSS classes on the mock root (see
   assets/mock-scenes.css). Steps only toggle those, so transitions and
   easing stay in the stylesheet where they can be seen and tuned.

   Requires assets/vscode-mock.js (for GUTTER_SVG and the codeLines shape)
   and assets/mock-scenes.css. */
(function (global) {
  'use strict';

  var REDUCED = global.matchMedia
    ? global.matchMedia('(prefers-reduced-motion: reduce)')
    : { matches: false };

  var registry = {};

  // ── the mock template ─────────────────────────────────────────────────
  // The authored markup stays in index.html so it is reviewed in one place
  // against the extension source. On that page the hero mock is already in
  // the DOM; anywhere else (the scenes preview harness) it is fetched.
  var templatePromise = null;

  function getTemplate() {
    if (templatePromise) { return templatePromise; }
    var live = document.querySelector('.hero-visual .vsc');
    if (live) {
      templatePromise = Promise.resolve(live);
    } else {
      templatePromise = fetch('index.html')
        .then(function (r) { return r.text(); })
        .then(function (html) {
          var doc = new DOMParser().parseFromString(html, 'text/html');
          var vsc = doc.querySelector('.hero-visual .vsc');
          if (!vsc) { throw new Error('mock-scenes: no .vsc found in index.html'); }
          return vsc;
        });
    }
    return templatePromise;
  }

  // A clone is decoration, never a second copy of the page's ids or of its
  // inline click handlers — those call globals that resolve by id and would
  // reach back into the hero.
  function instantiate(tpl) {
    var node = tpl.cloneNode(true);
    node.classList.add('mock-scene');
    node.removeAttribute('role');
    node.removeAttribute('aria-label');
    node.setAttribute('aria-hidden', 'true');
    node.querySelectorAll('[id]').forEach(function (el) {
      el.dataset.mock = el.id;
      el.removeAttribute('id');
    });
    node.querySelectorAll('[onclick]').forEach(function (el) {
      el.removeAttribute('onclick');
    });
    // Both overlays are authored inside the activity-bar item, which is the
    // only positioned box near them in the hero. A scene drives them across
    // the whole window, so they are reparented to the root.
    ['.vsc-pointer', '.screencast-mouse'].forEach(function (sel) {
      var el = node.querySelector(sel);
      if (el) { node.appendChild(el); }
    });
    // Every card has the overflow button at all times and hides it until the
    // card is hovered — .card-overflow-btn is opacity 0 with
    // .card:hover .card-overflow-btn at .5 (SidebarView.ts:1419). It sits
    // before the star: row1.append(title, overflowBtn, starBtn, checkEl).
    node.querySelectorAll('.sb-card').forEach(function (card) {
      var row = card.querySelector('.sb-card-row1');
      if (!row || card.querySelector('.card-overflow-btn')) { return; }
      var btn = document.createElement('button');
      btn.className = 'card-overflow-btn';
      btn.title = 'More actions';
      btn.innerHTML = MOCK_ICONS.Ellipsis;
      row.insertBefore(btn, row.querySelector('.sb-star'));
    });
    return node;
  }

  // ── element lookup ────────────────────────────────────────────────────
  function context(node) {
    return {
      root: node,
      $: function (sel) { return node.querySelector(sel); },
      $$: function (sel) {
        return Array.prototype.slice.call(node.querySelectorAll(sel));
      },
      m: function (name) { return node.querySelector('[data-mock="' + name + '"]'); },
      timers: [],
    };
  }

  // A step's own follow-ups (a click releasing, an overlay timing out) are
  // tracked on the context so a reset mid-scene cannot leave one pending.
  function later(c, ms, fn) {
    c.timers.push(setTimeout(fn, ms));
  }

  /* The scene's pointer is decoration, so :hover never fires. Anything the
     real UI only reveals on hover — the card's overflow button — is driven
     from here instead, off whatever the pointer was last sent to. */
  function hover(c, target) {
    var card = target && target.closest ? target.closest('.sb-card') : null;
    c.$$('.sb-card').forEach(function (el) {
      el.classList.toggle('is-hover', el === card);
    });
    // The button under the pointer goes to full strength, not the card's
    // half — .card-overflow-btn:hover at SidebarView.ts:1433.
    c.$$('.card-overflow-btn').forEach(function (el) {
      el.classList.toggle('is-hover', el === target);
    });
  }

  /* Smart placement, from SidebarView.ts:4850. Prefer below the button; flip
     above when there is more room there; clamp to whatever is available if it
     fits neither. Measured against the window rather than the viewport, since
     that is what clips a scene. */
  function placeMenu(c, btn, menu) {
    var GAP = 4;
    var k = scaleOf(c.root);
    var b = btn.getBoundingClientRect();
    var r = c.root.getBoundingClientRect();
    menu.style.maxHeight = 'none';
    var h = menu.offsetHeight;
    var below = (r.bottom - b.bottom) / k - GAP;
    var above = (b.top - r.top) / k - GAP;

    if (h <= below) {
      menu.style.maxHeight = '';
      menu.style.top = ((b.bottom - r.top) / k + GAP) + 'px';
      menu.style.bottom = 'auto';
    } else if (h <= above) {
      menu.style.maxHeight = '';
      menu.style.top = 'auto';
      menu.style.bottom = ((r.bottom - b.top) / k + GAP) + 'px';
    } else if (below >= above) {
      // a GAP at the far edge too, so a clamped menu does not sit flush
      // against the window it is clipped by
      menu.style.maxHeight = (below - GAP) + 'px';
      menu.style.top = ((b.bottom - r.top) / k + GAP) + 'px';
      menu.style.bottom = 'auto';
    } else {
      menu.style.maxHeight = (above - GAP) + 'px';
      menu.style.top = 'auto';
      menu.style.bottom = ((r.bottom - b.top) / k + GAP) + 'px';
    }
    menu.style.right = Math.max(8, (r.right - b.right) / k) + 'px';

    // Measure and correct rather than trust the arithmetic: border and
    // scrollbar widths differ per platform, and a menu poking out of the
    // window is the one thing this must never do.
    var over = (menu.getBoundingClientRect().bottom - r.bottom) / k + GAP;
    if (over > 0) {
      menu.style.maxHeight = (menu.offsetHeight - over) + 'px';
    }
  }

  /* The card overflow menu, group for group, from SidebarView.ts:4753-4848.
     Every conditional there is a conditional here. */
  function cardMenuItems(o) {
    var out = [
      ['Edit in editor', 'SquarePen'],
      ['Duplicate', 'Copy'],
      [o.remind ? 'Change reminder' : 'Set reminder', 'Bell'],
      ['Add tag', 'Tag11'],
      '-',
      ['Link to another note', 'Files'],
      o.linked ? ['Remove file link', 'Unlink2'] : ['Link to current file', 'FileSymlink'],
    ];
    if (o.branch) {
      out.push(o.pinned
        ? ['Unpin from current branch', 'GitBranch']
        : ['Pin to current branch', 'GitBranch']);
    }
    if (o.github) {
      out.push('-');
      if (o.linkedGh) {
        out.push(o.linkedGh === 'pr'
          ? ['Open GitHub PR', 'GitPullRequest']
          : ['Open GitHub Issue', 'CircleDot']);
      } else {
        out.push(['Create GitHub Issue', 'CircleDot']);
        out.push(['Link to PR', 'GitPullRequest']);
      }
    }
    out.push('-');
    out.push([o.archived ? 'Unarchive' : 'Archive', 'Archive']);
    out.push([o.shared ? 'Unshare' : 'Share', 'Share2']);
    out.push('-');
    out.push(['Export', 'SquareArrowOutUpRight']);
    out.push(['Delete', 'Trash2', 'danger']);
    return out;
  }

  /* The simple on/off card chips differ only in class, icon and label. */
  function chip(c, n, cls, on, icon, label) {
    var card = c.$$('.sb-card')[n - 1];
    if (!card) { return; }
    var row = card.querySelector('.sb-card-tags');
    var el = card.querySelector('.' + cls);
    if (on === false) { if (el) { el.remove(); } return; }
    if (el) { return; }
    el = document.createElement('span');
    el.className = 'sb-tagpill ' + cls + ' is-arriving';
    el.innerHTML = MOCK_ICONS[icon + '11'] + '<span class="sb-chip-label">' + label + '</span>';
    row.insertBefore(el, row.firstChild);
  }

  function gutterSvg() {
    return typeof GUTTER_SVG !== 'undefined' ? GUTTER_SVG : '';
  }

  /* The stage lays the window out at one width and scales it to whatever box
     it is currently placed over (assets/stage.js). getBoundingClientRect
     therefore returns scaled pixels, while anything written back as a style
     is in the window's own unscaled ones — so every measured offset here is
     divided by this. It is 1 whenever the mock is not being scaled. */
  function scaleOf(node) {
    var w = node.offsetWidth;
    return w ? node.getBoundingClientRect().width / w : 1;
  }

  /* Tag artwork lives in the authored tag bar rather than MOCK_ICONS, which
     only carries what SidebarView.ts passes through svgIcon(). Cloning the
     chip's own glyph keeps a scene's pills identical to the bar above them. */
  /* The code-link glyph, lifted from the authored card so a created pill and
     an authored one cannot drift apart. */
  var CODELINK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" '
    + 'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
    + '<path d="M4 11V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.706.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h7"/>'
    + '<path d="M14 2v5a1 1 0 0 0 1 1h5"/><path d="m10 18 3-3-3-3"/></svg>';

  var TAG_TINT = {
    Idea: 'tint-yellow', Todo: 'tint-blue', Bug: 'tint-red',
    Meeting: 'tint-lav', Reference: 'tint-green',
  };

  function tagSvg(c, label) {
    var found = '';
    c.$$('.sb-tagbar .sb-chip').forEach(function (chip) {
      var l = chip.querySelector('.sb-chip-label');
      if (l && l.textContent.trim() === label) {
        var svg = chip.querySelector('svg');
        if (svg) { found = svg.outerHTML; }
      }
    });
    return found;
  }

  /* Scrolls the tab strip the least amount that brings the active tab fully
     into view, the way VS Code reveals a tab you switch to. Set directly
     rather than via scrollIntoView, which would also scroll the page. */
  function revealTab(strip) {
    if (!strip) { return; }
    var tab = strip.querySelector('.vsc-tab.active');
    if (!tab) { return; }
    var pad = 8;
    var left = tab.offsetLeft - pad;
    var right = tab.offsetLeft + tab.offsetWidth + pad - strip.clientWidth;
    if (strip.scrollLeft > left) { strip.scrollLeft = left; }
    else if (strip.scrollLeft < right) { strip.scrollLeft = right; }
  }

  // ── actions ───────────────────────────────────────────────────────────
  // Each is (context, ...args) and must be idempotent: seek() replays every
  // step up to a time at once, so an action that toggles rather than sets
  // would land in the wrong state when scrubbing.
  var actions = {

    /* panel(false) collapses the sidebar track to zero width. */
    panel: function (c, open) {
      c.root.classList.toggle('s-panel-closed', open === false);
    },

    /* activate('DevNotes+') — by the activity item's title attribute. */
    activate: function (c, title) {
      c.$$('.vsc-act').forEach(function (a) {
        a.classList.toggle('active', a.getAttribute('title') === title);
      });
    },

    /* pointer('[title="DevNotes+"]') moves the cursor to an element's
       centre; pointer(null) takes it off screen. */
    pointer: function (c, sel) {
      var p = c.$('.vsc-pointer');
      var ring = c.$('.screencast-mouse');
      if (!p) { return; }
      if (!sel) { c.root.classList.remove('s-pointer'); hover(c, null); return; }
      var target = typeof sel === 'string' ? c.$(sel) : sel;
      if (!target) { return; }
      var r = target.getBoundingClientRect();
      var b = c.root.getBoundingClientRect();
      var k = scaleOf(c.root);
      var t = 'translate(' + ((r.left - b.left + r.width / 2) / k) + 'px,'
                           + ((r.top - b.top + r.height / 2) / k) + 'px)';
      p.style.transform = t;
      if (ring) { ring.style.transform = t; }
      c.root.classList.add('s-pointer');
      hover(c, target);
    },

    /* click(sel) moves there if needed, then presses. The ring is
       Screencast Mode's mousedown indicator, so it lasts the press. */
    click: function (c, sel) {
      if (sel) { actions.pointer(c, sel); }
      c.root.classList.add('s-press');
      later(c, 130, function () { c.root.classList.remove('s-press'); });
    },

    /* screencast('Add DevNote Here ', 'Ctrl+Alt+Q') — VS Code's keystroke
       overlay. 800ms is its own keyboardOverlayTimeout default. */
    screencast: function (c, title, key, ms) {
      var el = c.$('.screencast-keyboard');
      if (!el) { return; }
      var t = el.querySelector('.title');
      var k = el.querySelector('.key');
      if (t) { t.textContent = title; }
      if (k) { k.textContent = key; }
      el.classList.add('is-on');
      later(c, ms || 800, function () { el.classList.remove('is-on'); });
    },

    /* crumb('devnotes-plus › features › README.md') redraws the breadcrumb as
       the separate segments VS Code draws, so a scene can point at one and
       click it. hot is the 1-based segment to light up, or null for none. */
    crumb: function (c, path, hot) {
      var el = c.$('.vsc-breadcrumb');
      if (!el) { return; }
      var want = (hot === null || hot === undefined) ? -1 : hot - 1;
      el.innerHTML = path.split('›').map(function (seg, i) {
        return (i ? '<span class="bc-sep">›</span>' : '')
          + '<span class="bc-seg' + (i === want ? ' is-hot' : '') + '">'
          + seg.trim() + '</span>';
      }).join('');
    },

    /* crumbpick(2) opens the breadcrumb's folder picker with the nth entry
       focused; crumbpick(0) opens it with none; crumbpick(null) closes it. */
    crumbpick: function (c, n) {
      var want = (n === null || n === undefined) ? -1 : n - 1;
      c.root.classList.toggle('s-crumb', want >= -1 && n !== null && n !== undefined);
      c.$$('.bc-row').forEach(function (row, i) {
        row.classList.toggle('is-focus', i === want);
      });
    },

    /* quickinput(2) shows the nth authored prompt; quickinput(null) closes
       the widget. */
    quickinput: function (c, n) {
      var want = (n === null || n === undefined) ? -1 : n - 1;
      c.$$('.qi-step').forEach(function (step, i) {
        step.classList.toggle('is-on', i === want);
      });
      if (want === -1) {
        var typed = c.$('.qi-typed');
        if (typed) {
          typed.getAnimations().forEach(function (a) { a.cancel(); });
          typed.style.width = '0px';
        }
        // Closing the widget puts the placeholder back, so a replay starts
        // on an empty field rather than one that still looks typed into.
        c.$$('.qi-field').forEach(function (f) { f.classList.remove('is-typed'); });
      }
    },

    /* type('Notes stick to the line') reveals the typed span by animating
       its width to the text's own measured width, so nothing has to guess a
       character count against a font that may not have loaded. */
    type: function (c, text, ms) {
      var el = c.$('.qi-typed');
      if (!el) { return; }
      // The placeholder goes on the first keystroke, as it does in the real
      // input box — it sits under the typed span, not beside it.
      if (el.parentElement) { el.parentElement.classList.add('is-typed'); }
      if (text !== null && text !== undefined) { el.textContent = text; }
      var chars = el.textContent.length || 1;
      el.style.width = 'auto';
      var w = el.scrollWidth;
      el.style.width = '0px';
      el.getAnimations().forEach(function (a) { a.cancel(); });
      el.animate(
        [{ width: '0px' }, { width: w + 'px' }],
        { duration: ms || 600, easing: 'steps(' + chars + ', end)', fill: 'forwards' }
      );
    },

    /* cards(1) shows the first n note cards and hides the rest. A card that
       was hidden and now is not plays the arrival animation. */
    cards: function (c, n) {
      c.$$('.sb-card').forEach(function (card, i) {
        var show = i < n;
        var was = !card.classList.contains('is-hidden');
        card.classList.toggle('is-hidden', !show);
        if (show && !was) {
          card.classList.remove('is-arriving');
          void card.offsetWidth;
          card.classList.add('is-arriving');
        }
      });
    },

    /* empty(true) shows the panel's real "No notes yet" state. */
    empty: function (c, on) {
      c.root.classList.toggle('s-empty', on !== false);
    },

    /* code(lines, currentLine) re-renders the editor from the {n, html,
       note} shape vscode-mock.js uses, so demo code can be pasted across. */
    code: function (c, lines, current) {
      var host = c.m('vsc-code');
      if (!host) { return; }
      host.innerHTML = lines.map(function (l) {
        var noted = l.note ? ' noted' : '';
        var cur = (l.n === current && l.note) ? ' current' : '';
        var hover = l.note
          ? '<span class="vsc-hover"><span class="h-title">' + l.note.title
            + '</span><span class="h-sub">' + l.note.meta + '</span></span>'
          : '';
        return '<div class="vsc-line' + noted + cur + '">'
          + '<span class="vsc-gutter">' + gutterSvg() + '</span>'
          + '<span class="vsc-lineno">' + l.n + '</span>'
          + '<span class="vsc-linecode">' + l.html + '</span>'
          + hover + '</div>';
      }).join('');
    },

    /* card(1, {...}) rewrites a note card, so a scene shows the note its own
       feature is about rather than the hero's. Every key is optional:
         title / body   the card's title and its rendered markdown
         tags           labels from the tag bar, in card order
         link           the code-link pill's file:line, or null to drop it
         date / owner    the footer
         star           the star's filled state
         clamped        whether the body is cut off with a show-more chevron
       Rebuilding the pills rather than editing them keeps tag order honest,
       and skips the badges the github/shared/conflict actions own. */
    card: function (c, n, o) {
      var card = c.$$('.sb-card')[n - 1];
      if (!card || !o) { return; }
      var q = function (sel) { return card.querySelector(sel); };

      if (o.title !== undefined) { q('.sb-card-title').textContent = o.title; }
      if (o.body !== undefined) { q('.sb-card-body').innerHTML = o.body; }
      if (o.date !== undefined) { q('.sb-date').textContent = o.date; }
      if (o.owner !== undefined) {
        q('.sb-initials').textContent = o.owner.slice(0, 2).toUpperCase();
        q('.sb-owner').lastChild.textContent = ' ' + o.owner;
      }
      if (o.star !== undefined) { q('.sb-star').classList.toggle('on', !!o.star); }
      if (o.clamped !== undefined) {
        q('.sb-card-body').classList.toggle('clamped', !!o.clamped);
        var more = q('.sb-showmore');
        if (more) { more.style.display = o.clamped ? '' : 'none'; }
      }

      var row = q('.sb-card-tags');
      if (o.tags) {
        card.querySelectorAll('.sb-card-tags .sb-tagpill').forEach(function (el) {
          if (!el.classList.contains('sb-codelink')) { el.remove(); }
        });
        var link = q('.sb-codelink');
        o.tags.slice().reverse().forEach(function (label) {
          var el = document.createElement('span');
          el.className = 'sb-tagpill ' + (TAG_TINT[label] || 'tint-blue');
          el.innerHTML = tagSvg(c, label)
            + '<span class="sb-chip-label">' + label + '</span>';
          row.insertBefore(el, link || null);
        });
      }
      if (o.link !== undefined) {
        var pill = q('.sb-codelink');
        if (o.link === null) { if (pill) { pill.remove(); } return; }
        // Only the first authored card carries a code link, so a scene that
        // anchors any other one has to be able to create the pill rather than
        // only rename it — otherwise `link` silently means nothing on those
        // cards and whatever cites the anchor contradicts the sidebar.
        if (!pill) {
          pill = document.createElement('span');
          pill.className = 'sb-tagpill sb-codelink';
          pill.innerHTML = CODELINK_SVG + '<span class="sb-chip-label"></span>';
          row.appendChild(pill);
        }
        pill.title = o.link + ' — click to jump';
        pill.querySelector('.sb-chip-label').textContent = o.link;
      }
    },

    /* note(5, true) marks a line as anchored without re-rendering, which is
       what lets the gutter pin animate in rather than appear. */
    note: function (c, n, on) {
      var line = c.$$('.vsc-line')[n - 1];
      if (!line) { return; }
      line.classList.toggle('noted', on !== false);
      if (on !== false) {
        line.classList.remove('is-pinning');
        void line.offsetWidth;
        line.classList.add('is-pinning');
      }
    },

    /* line(5) is the cursor position — the tint and the Ln/Col readout. */
    line: function (c, n) {
      c.$$('.vsc-line').forEach(function (l, i) {
        l.classList.toggle('current', i === n - 1);
      });
      var col = c.m('vsc-lncol');
      if (col) { col.textContent = 'Ln ' + n + ', Col 1'; }
    },

    /* branch('feature/auth') updates the sidebar pill and the status bar. */
    branch: function (c, name) {
      var pill = c.$$('.sb-pill')[1];
      if (pill) {
        pill.setAttribute('title', name);
        var lbl = pill.querySelector('.lbl');
        if (lbl) { lbl.textContent = name; }
      }
      var status = c.$('.vsc-status-branch');
      if (status && status.lastChild) { status.lastChild.textContent = name; }
    },

    /* tag('Todo') filters the card list the way the tag bar does; tag('All')
       or tag(null) clears it. */
    tag: function (c, label) {
      var all = !label || label === 'All';
      c.$$('.sb-chip').forEach(function (chip) {
        var l = chip.querySelector('.sb-chip-label');
        var name = l ? l.textContent.trim() : chip.textContent.trim();
        chip.classList.toggle('is-on', all ? name === 'All' : name === label);
      });
      c.$$('.sb-card').forEach(function (card) {
        if (all) { card.classList.remove('is-filtered'); return; }
        var names = Array.prototype.map.call(
          card.querySelectorAll('.sb-card-tags .sb-tagpill:not(.sb-codelink) .sb-chip-label'),
          function (s) { return s.textContent.trim(); }
        );
        card.classList.toggle('is-filtered', names.indexOf(label) === -1);
      });
    },

    /* status('2 notes here'); status(null) hides the item, which is what
       StatusBarController does at zero notes. */
    status: function (c, text) {
      var el = c.m('vsc-notes-count');
      if (!el) { return; }
      el.classList.toggle('is-off', text === null || text === undefined);
      if (text) { el.innerHTML = '&#9783; ' + text; }
    },

    /* ── card chips ───────────────────────────────────────────────────
       Each mirrors a chip SidebarView.ts builds through makeChip(): a
       .meta-chip with a .tag-icon and a .chip-text. */

    /* github(1, 'pr', 412, 'open') — the badge at SidebarView.ts:4353. The
       label is PR<number> for a pull request and #<number> for an issue,
       followed by the status, lowercased by .github-badge. */
    github: function (c, n, type, number, status, title) {
      var card = c.$$('.sb-card')[n - 1];
      if (!card) { return; }
      var row = card.querySelector('.sb-card-tags');
      var el = card.querySelector('.sb-ghbadge');
      if (status === null) { if (el) { el.remove(); } return; }
      var icon = type === 'pr'
        ? (status === 'merged' ? 'GitMerge' : status === 'closed' ? 'GitPullRequestClosed' : 'GitPullRequest')
        : (status === 'closed' || status === 'merged' ? 'CircleCheck' : 'CircleDot');
      if (!el) {
        el = document.createElement('span');
        el.className = 'sb-tagpill sb-ghbadge';
        row.insertBefore(el, row.firstChild);
        el.classList.add('is-arriving');
      }
      el.className = 'sb-tagpill sb-ghbadge gh-' + status
                   + (el.classList.contains('is-arriving') ? ' is-arriving' : '');
      el.title = title || '';
      el.innerHTML = MOCK_ICONS[icon + '11']
        + '<span class="sb-chip-label">' + (type === 'pr' ? 'PR' : '#') + number
        + ' ' + status + '</span>';
    },

    /* shared(1, true) — the .shared-badge at SidebarView.ts:4322. */
    shared: function (c, n, on) {
      chip(c, n, 'sb-sharedbadge', on, 'Share2', 'Shared');
    },

    /* conflict(1, true) — the .conflict-badge at SidebarView.ts:4328, whose
       label is the whole call to action. */
    conflict: function (c, n, on) {
      chip(c, n, 'sb-conflictbadge', on, 'TriangleAlert', 'Conflict — click to resolve');
    },

    /* cardmenu(1, {...}) opens the card's overflow menu — the real route to
       the editor, GitHub linking and sharing, none of which has a keybinding
       (ctrl+alt+q is the extension's only one).

       The whole menu is built here from SidebarView.ts:4753-4848 rather than
       being listed at the call site, so a scene cannot show a half a menu.
       Options mirror the conditions that file branches on:
         github    GitHub connected — without it the whole group is absent
         linked    the note already has a code link, so the item is "Remove"
         branch    the current branch, or null outside a repo
         pinned    the note is already scoped to that branch
         starred / archived / remind — the labels that flip on state
         focus     the label to draw as focused, for the pointer to land on
       cardmenu(n, null) closes it. */
    cardmenu: function (c, n, opts) {
      var card = c.$$('.sb-card')[n - 1];
      if (!card) { return; }
      var btn = card.querySelector('.card-overflow-btn');
      if (!btn) { return; }
      var menu = c.$('.ovf-menu');
      if (!opts) {
        if (menu) { menu.remove(); }
        btn.classList.remove('open');
        return;
      }
      if (!menu) {
        menu = document.createElement('div');
        menu.className = 'ovf-menu';
        // The real menu is position: fixed and measured against the viewport,
        // so it is never clipped by the scrolling card list. Its stand-in is
        // absolute against the window, measured the same way below.
        c.root.appendChild(menu);
      }
      menu.innerHTML = cardMenuItems(opts).map(function (it) {
        if (it === '-') { return '<hr class="ovf-divider">'; }
        var cls = 'ovf-item'
                + (it[2] === 'danger' ? ' danger' : '')
                + (it[0] === opts.focus ? ' is-focus' : '');
        // "Add tag" is the one item the extension draws at 11px, because it
        // passes jsSvg.tagSmall where its neighbours pass 14px icons.
        return '<button class="' + cls + '">'
             + '<span class="ovf-icon">' + (MOCK_ICONS[it[1]] || '') + '</span>'
             + '<span class="ovf-label">' + it[0] + '</span></button>';
      }).join('');
      btn.classList.add('open');
      placeMenu(c, btn, menu);
    },

    /* ── editor group ─────────────────────────────────────────────────── */

    /* editor('Rate limits') opens the block editor as a second tab, which is
       what EditorPanel does — a webview in the editor group, titled with the
       note. editor(null) goes back to the code tab. */
    editor: function (c, title) {
      var group = c.$('.vsc-editor');
      if (!group) { return; }
      var panel = c.$('.ed-panel');
      if (title === null || title === undefined) {
        c.root.classList.remove('s-editor');
        c.$$('.vsc-tab').forEach(function (t, i) { t.classList.toggle('active', i === 0); });
        return;
      }
      if (!panel) {
        group.insertAdjacentHTML('beforeend', MockSurfaces.buildEditorPanel(title));
        var tabs = c.$('.vsc-tabs');
        tabs.insertAdjacentHTML('beforeend',
          '<div class="vsc-tab ed-tab"><span class="js nb">MD</span> <span class="ed-tab-name"></span> <span class="x">&times;</span></div>');
      }
      c.$('.ed-title').value = title;
      c.$('.ed-tab-name').textContent = title;
      c.$$('.vsc-tab').forEach(function (t) { t.classList.toggle('active', t.classList.contains('ed-tab')); });
      revealTab(c.$('.vsc-tabs'));
      c.root.classList.add('s-editor');
    },

    /* blocks(3) reveals the first n blocks of the demo document. */
    blocks: function (c, n) {
      var doc = c.$('.ed-doc');
      if (!doc) { return; }
      doc.innerHTML = MockSurfaces.ED_BLOCKS.slice(0, n).join('');
      var last = doc.lastElementChild;
      if (last) {
        last.classList.add('is-arriving');
        var mount = c.$('.ed-mount');
        if (mount) { mount.scrollTop = mount.scrollHeight; }
      }
    },

    /* toolbar('grpLists') lights a toolbar button the way :active does. */
    toolbar: function (c, action) {
      c.$$('.tb-btn').forEach(function (b) {
        b.classList.toggle('is-active', b.dataset.tb === action);
      });
    },

    /* ── panel ────────────────────────────────────────────────────────── */

    /* terminal(true) opens VS Code's panel under the editor. */
    terminal: function (c, on) {
      var group = c.$('.vsc-editor');
      if (!group) { return; }
      if (!c.$('.vsc-panel') && on !== false) {
        group.insertAdjacentHTML('beforeend', MockSurfaces.buildTerminal());
      }
      c.root.classList.toggle('s-terminal', on !== false);
    },

    /* term([...]) sets the terminal's visible lines. Each is a string, or
       ['cls', 'text'] to style it. */
    term: function (c, lines) {
      var t = c.$('.term');
      if (!t) { return; }
      t.innerHTML = (lines || []).map(function (l) {
        var cls = Array.isArray(l) ? l[0] : '';
        var txt = Array.isArray(l) ? l[1] : l;
        return '<div class="term-line ' + cls + '">' + txt + '</div>';
      }).join('');
    },

    /* ── source control ───────────────────────────────────────────────── */

    /* scm([['a1b2c3.md', '.devnotes', 'untracked'], ...]) shows VS Code's
       Source Control view in place of the panel. scm(null) hides it. */
    scm: function (c, files, branch) {
      var body = c.$('.vsc-body');
      if (!body) { return; }
      if (!c.$('.scm-view')) {
        c.$('.vsc-sidebar').insertAdjacentHTML('afterend', MockSurfaces.buildScm(branch));
      }
      if (!files) { c.root.classList.remove('s-scm'); return; }
      c.$('.scm-list').innerHTML = files.map(function (f) {
        return MockSurfaces.scmRow(f[0], f[1], f[2]);
      }).join('');
      c.$('.scm-count').textContent = files.length;
      c.root.classList.add('s-scm');
    },

    /* tabs(['README.md','1-anchoring.md'], '1-anchoring.md') rebuilds the editor
       tab strip, so the features section reads as one project with its pages
       open rather than one file being renamed seven times. The block editor's
       own tab (.ed-tab) is appended by the editor action and is left alone. */
    tabs: function (c, names, active) {
      var strip = c.$('.vsc-tabs');
      if (!strip) { return; }
      var ed = c.$('.ed-tab');
      var html = names.map(function (name) {
        var dot = name.lastIndexOf('.');
        var ext = dot < 0 ? '' : name.slice(dot + 1).toUpperCase();
        var on = name === active;
        return '<div class="vsc-tab' + (on && !ed ? ' active' : '') + '">'
          + '<span class="js' + (ext === 'MD' ? ' nb' : '') + '">' + ext + '</span> '
          + name + ' <span class="x">&times;</span></div>';
      }).join('');
      strip.innerHTML = html;
      if (ed) { strip.appendChild(ed); }
      revealTab(strip);
    },

    /* reminder(1, 'Sep 4') pins a date to a card the way a reminder shows in
       the sidebar; reminder(1, null) takes it off. */
    reminder: function (c, n, when) {
      var card = c.$$('.sb-card')[n - 1];
      if (!card) { return; }
      var row = card.querySelector('.sb-card-tags');
      var pill = card.querySelector('.sb-remind');
      if (!when) { if (pill) { pill.remove(); } return; }
      if (!pill) {
        pill = document.createElement('span');
        pill.className = 'sb-tagpill sb-remind tint-yellow';
        row.appendChild(pill);
      }
      pill.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" '
        + 'stroke-width="2" stroke-linecap="round"><circle cx="12" cy="13" r="8"/>'
        + '<path d="M12 9v4l2 2M5 3 2 6M22 6l-3-3"/></svg>'
        + '<span class="sb-chip-label">' + when + '</span>';
    },

    /* file('client.js') renames the open editor everywhere it is shown, so a
       scene's code sample and its note's code link cannot disagree. */
    file: function (c, name, project) {
      var proj = project || 'devnotes-plus';
      var tab = c.$('.vsc-tab.active:not(.ed-tab)') || c.$('.vsc-tab');
      if (tab) {
        // The tab's name is its bare text node — between the language badge
        // and the close glyph. Found rather than indexed, because a rebuilt
        // strip has no leading whitespace node and the authored one does.
        var slot = Array.prototype.filter.call(tab.childNodes, function (n) {
          return n.nodeType === 3 && n.textContent.trim();
        })[0];
        if (slot) { slot.textContent = ' ' + name + ' '; }
      }
      var crumb = c.$('.vsc-breadcrumb');
      if (crumb) { crumb.textContent = proj + ' › ' + name; }
      var title = c.$('.vsc-titlebar-name');
      if (title) {
        title.textContent = name + ' — ' + proj + ' — Visual Studio Code';
      }
    },

    /* text('.sb-codelink .sb-chip-label', 'quickstart.js:9') — a label the
       scene changes but that is not worth an action of its own. */
    text: function (c, sel, str) {
      c.$$(sel).forEach(function (el) { el.textContent = str; });
    },

    /* toggle('.sb-card', 'active', true) — the escape hatch, for a one-off
       a scene needs before it is worth its own action. */
    toggle: function (c, sel, cls, on) {
      c.$$(sel).forEach(function (el) { el.classList.toggle(cls, on !== false); });
    },
  };

  // ── a mounted scene ───────────────────────────────────────────────────
  function Scene(host, def) {
    this.def = def;
    this.host = host;
    this.node = null;
    this.c = null;
    this.playing = false;
    this.timers = [];
  }

  Scene.prototype.mount = function (tpl) {
    this.tpl = tpl;
    this.node = instantiate(tpl);
    this.host.appendChild(this.node);
    this.c = context(this.node);
    this.reset();
    return this;
  };

  Scene.prototype.duration = function () {
    if (this.def.duration) { return this.def.duration; }
    var last = this.def.steps.reduce(function (m, s) { return Math.max(m, s[0]); }, 0);
    return last + 900;
  };

  /* A step is [timeMs, action, ...args]; an initial entry is the same
     without the time. */
  Scene.prototype.run = function (step) {
    var at = typeof step[0] === 'number' ? 1 : 0;
    var fn = actions[step[at]];
    if (!fn) { console.warn('mock-scenes: unknown action', step[at]); return; }
    fn.apply(null, [this.c].concat(step.slice(at + 1)));
  };

  Scene.prototype.clear = function () {
    this.timers.forEach(clearTimeout);
    this.timers = [];
    this.c.timers.forEach(clearTimeout);
    this.c.timers = [];
  };

  /* Back to the scene's declared opening state, with every pending timer
     from a previous run dropped. */
  Scene.prototype.reset = function () {
    this.clear();
    this.playing = false;
    this.blank();
    (this.def.initial || []).forEach(this.run, this);
    return this;
  };

  /* Everything the runner can put on screen, taken back off, before initial
     runs. A scene's initial state is then only what it declares — an author
     cannot leave a widget open across a replay by forgetting to reset it,
     which is a bug that does not announce itself until the second loop. */
  Scene.prototype.blank = function () {
    var c = this.c;
    this.node.classList.remove('s-press');
    actions.quickinput(c, null);
    actions.crumbpick(c, null);
    actions.toolbar(c, null);
    c.$$('.sb-card').forEach(function (card, i) { actions.cardmenu(c, i + 1, null); });
    hover(c, null);
  };

  /* Jump to a point in the timeline with nothing animating in between — the
     preview scrubber, and how reduced motion gets the end state. */
  Scene.prototype.seek = function (ms) {
    this.reset();
    this.def.steps.forEach(function (s) { if (s[0] <= ms) { this.run(s); } }, this);
    this.clear();
    this.resolveTransients(ms);
    return this;
  };

  /* An overlay that hides itself on a timer would stay up through a seek,
     because seek drops every pending timer. Work out from the timeline what
     should still be showing at ms and settle it. */
  Scene.prototype.resolveTransients = function (ms) {
    var press = false;
    var cast = false;
    this.def.steps.forEach(function (s) {
      if (s[0] > ms) { return; }
      if (s[1] === 'click') { press = ms < s[0] + 130; }
      if (s[1] === 'screencast') { cast = ms < s[0] + (s[4] || 800); }
    });
    this.node.classList.toggle('s-press', press);
    var el = this.c.$('.screencast-keyboard');
    if (el) { el.classList.toggle('is-on', cast); }
  };

  Scene.prototype.play = function () {
    if (this.playing) { return this; }
    this.reset();
    this.playing = true;
    var self = this;
    this.def.steps.forEach(function (s) {
      self.timers.push(setTimeout(function () { self.run(s); }, s[0]));
    });
    this.timers.push(setTimeout(function () {
      self.playing = false;
      if (self.def.loop) { self.play(); }
    }, this.duration()));
    return this;
  };

  Scene.prototype.stop = function () {
    this.clear();
    this.playing = false;
    return this;
  };

  /* Plays when it scrolls into view and rewinds when it leaves, so a
     visitor who scrolls back sees the demo from the top rather than a
     finished still. */
  /* Point an already-mounted mock at a different scene. A stage — one window
     that many features are demonstrated in — is this plus whatever decides
     when to call it, so it costs one clone instead of one per scene. */
  Scene.prototype.setDef = function (def) {
    if (this.def === def) { return this; }
    this.stop();
    this.def = def;
    // A fresh clone rather than an unwind. blank() can take the runner's own
    // widgets back off, but not content a scene wrote — a renamed file, a
    // rewritten code link, a card chip. On a shared stage that is every
    // scene's problem, and the only reset that cannot miss one is the
    // template itself. One clone per scene change is cheaper than the class
    // of bug it removes.
    var fresh = instantiate(this.tpl);
    this.host.replaceChild(fresh, this.node);
    this.node = fresh;
    this.c = context(fresh);
    this.reset();
    return this;
  };

  Scene.prototype.observe = function () {
    if (REDUCED.matches) { this.seek(this.duration()); return this; }
    var self = this;
    new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { self.play(); }
        else { self.stop(); self.reset(); }
      });
    }, { threshold: 0.4 }).observe(this.node);
    return this;
  };

  // ── public API ────────────────────────────────────────────────────────
  function register(def) { registry[def.id] = def; return def; }

  /* Mounts every [data-mock-scene="<id>"] host on the page. */
  function mountAll(opts) {
    var hosts = Array.prototype.slice.call(
      document.querySelectorAll('[data-mock-scene]'));
    if (!hosts.length) { return Promise.resolve([]); }
    return getTemplate().then(function (tpl) {
      return hosts.map(function (host) {
        var def = registry[host.dataset.mockScene];
        if (!def) {
          console.warn('mock-scenes: no scene registered as', host.dataset.mockScene);
          return null;
        }
        var scene = new Scene(host, def).mount(tpl);
        if (!opts || opts.observe !== false) { scene.observe(); }
        host.__scene = scene;
        return scene;
      }).filter(Boolean);
    });
  }

  /* Mounts one mock into a host and hands back the Scene driving it, so a
     caller can swap scenes with setDef(). */
  function stage(host, firstId) {
    return getTemplate().then(function (tpl) {
      var def = registry[firstId];
      if (!def) { throw new Error('mock-scenes: no scene registered as ' + firstId); }
      var scene = new Scene(host, def).mount(tpl);
      host.__scene = scene;
      return scene;
    });
  }

  global.MockScenes = {
    register: register,
    mountAll: mountAll,
    stage: stage,
    actions: actions,
    Scene: Scene,
    getTemplate: getTemplate,
    registry: registry,
  };
})(window);
