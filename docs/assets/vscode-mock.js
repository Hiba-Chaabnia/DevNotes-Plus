/* DevNotes+ — hero VS Code workbench mock.
   Standalone script: edit this file to change the demo code, the note
   anchors, or the click behaviour. Styling lives in assets/vscode-mock.css;
   markup lives in index.html (search "VS Code workbench mock").

   selectNote() is called from inline onclick handlers in index.html, so it
   must stay a global. Loaded with defer, so the DOM is ready on execution. */

// ── Hero VS Code mock ───────────────────────────────────────────────────
// The two annotated lines correspond to the two notes in the sidebar; the
// gutter icon reuses media/gutter-note.svg (fill #fff0af, stroke #ffe07d).
const GUTTER_SVG = `<svg viewBox="0 0 2134 2134" fill="none" aria-hidden="true"><g stroke="#ffe07d" stroke-width="150" stroke-linecap="round" stroke-linejoin="round"><path d="M1473 1281c-326 0-591 281-591 628l-729 2c-46 0-84-38-84-85V307c0-47 38-85 84-85h1519c46 0 84 38 84 85l-2 489s0 188-1 152c-3-109-142-230-281-230-155 0-281 126-281 281s126 281 281 281Z" fill="#fff0af"/><ellipse cx="1473" cy="999" rx="281" ry="281"/><path d="M2064 1910l-169-184m0 0l-30-33 30-33m0 0l169-184"/><path d="M1334 1908l291-1"/></g></svg>`;

const codeLines = [
  { n: 1,  html: `<span class="c-cm">// DevNotes+ quickstart</span>` },
  { n: 2,  html: `` },
  { n: 3,  html: `<span class="c-cm">// 1 · Cursor on any line → Ctrl+Alt+Q</span>` },
  { n: 4,  html: `<span class="c-kw">const</span> <span class="c-var">note</span> = <span class="c-fn">capture</span>({` },
  { n: 5,  html: `  file: <span class="c-str">'src/github/client.js'</span>,`,
    note: { title: 'Start here — notes stick to the line', meta: 'Reference · Hiba · Aug 26' } },
  { n: 6,  html: `  line: <span class="c-num">60</span>,` },
  { n: 7,  html: `});` },
  { n: 8,  html: `` },
  { n: 9,  html: `<span class="c-cm">// 2 · It stays put as the code moves</span>` },
  { n: 10, html: `<span class="c-var">note</span>.<span class="c-fn">survives</span>(<span class="c-var">edits</span>, <span class="c-var">renames</span>, <span class="c-var">branchSwitches</span>);` },
  { n: 11, html: `` },
  { n: 12, html: `<span class="c-cm">// 3 · Claude Code reads and writes them over MCP</span>` },
  { n: 13, html: `<span class="c-var">claude</span>.<span class="c-fn">ask</span>(<span class="c-str">'what are my open todos?'</span>);` },
  { n: 14, html: `<span class="c-cm">//   → also: search, append, tick off, link a PR, log a session</span>` },
];

function renderCode(currentLine) {
  const host = document.getElementById('vsc-code');
  if (!host) return;   // pages that only borrow GUTTER_SVG have no hero mock
  host.innerHTML = codeLines.map(l => {
    const noted   = l.note ? ' noted' : '';
    const current = (l.n === currentLine && l.note) ? ' current' : '';
    const hover   = l.note
      ? `<span class="vsc-hover"><span class="h-title">${l.note.title}</span><span class="h-sub">${l.note.meta}</span></span>`
      : '';
    return `<div class="vsc-line${noted}${current}"${l.note ? ` onclick="selectNote(${l.n})"` : ''}>
      <span class="vsc-gutter">${GUTTER_SVG}</span>
      <span class="vsc-lineno">${l.n}</span>
      <span class="vsc-linecode">${l.html}</span>
      ${hover}
    </div>`;
  }).join('');
}

// Clicking a note card or an annotated line focuses that pairing, the way
// "Jump to file" does in the real sidebar.
function selectNote(lineNum) {
  renderCode(lineNum);
  markActive('sb-card-1');
  const col = document.getElementById('vsc-lncol');
  if (col) col.textContent = `Ln ${lineNum}, Col 1`;
}

function markActive(cardId) {
  document.querySelectorAll('.sb-card').forEach(c => c.classList.remove('active'));
  const card = document.getElementById(cardId);
  if (card) card.classList.add('active');
}

// An unlinked note has nowhere to jump to, so selecting it only highlights the
// card and reveals the rest of its body.
function selectCard(n) {
  markActive(`sb-card-${n}`);
  setExpanded(n, true);
}

// A long note is shown clamped to 8em with a chevron in the corner, mirroring
// .card-preview.clamped and .show-more. The chevron toggles; clicking the card
// only ever expands, so selecting a note never hides what you were reading.
const CHEVRON_DOWN = `<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M3.14598 5.85423L7.64598 10.3542C7.84098 10.5492 8.15798 10.5492 8.35298 10.3542L12.853 5.85423C13.048 5.65923 13.048 5.34223 12.853 5.14723C12.658 4.95223 12.341 4.95223 12.146 5.14723L7.99998 9.29323L3.85398 5.14723C3.65898 4.95223 3.34198 4.95223 3.14698 5.14723C2.95198 5.34223 2.95098 5.65923 3.14598 5.85423Z"/></svg>`;
const CHEVRON_UP   = `<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M3.14603 9.85423C3.34103 10.0492 3.65803 10.0492 3.85303 9.85423L7.99903 5.70823L12.145 9.85423C12.34 10.0492 12.657 10.0492 12.852 9.85423C13.047 9.65923 13.047 9.34223 12.852 9.14723L8.35203 4.64723C8.15703 4.45223 7.84003 4.45223 7.64503 4.64723L3.14503 9.14723C2.95003 9.34223 2.95103 9.65923 3.14603 9.85423Z"/></svg>`;

function setExpanded(n, expanded) {
  const body = document.getElementById(`sb-body-${n}`);
  const more = document.getElementById(`sb-more-${n}`);
  if (!body || !more) return;
  body.classList.toggle('clamped', !expanded);
  more.innerHTML = expanded ? CHEVRON_UP : CHEVRON_DOWN;
  more.title = expanded ? 'Show less' : 'Show more';
}

function toggleMore(event, n) {
  event.stopPropagation();
  const body = document.getElementById(`sb-body-${n}`);
  setExpanded(n, body.classList.contains('clamped'));
}

renderCode(5);
