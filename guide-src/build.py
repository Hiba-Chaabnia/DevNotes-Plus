#!/usr/bin/env python3
"""Generates the DevNotes+ user guide into docs/guide/.

Run from the repo root:  python guide-src/build.py

Each page in PAGES maps to a content fragment in guide-src/pages/<slug>.html holding
only the inner markup — the shared chrome (head, nav, sidebar, footer, JSON-LD)
is added here so that adding a page or renaming a section touches one file
instead of eight. Output is plain static HTML; GitHub Pages does no build.

Editing docs/guide/*.html directly will be overwritten on the next run.
"""

import io
import os
import re
import sys
from datetime import date

BASE = 'https://hiba-chaabnia.github.io/DevNotes-Plus/'
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'guide-src', 'pages')
OUT = os.path.join(ROOT, 'docs', 'guide')

MARKETPLACE = 'https://marketplace.visualstudio.com/items?itemName=HibaChaabnia.devnotes-plus'
OPENVSX = 'https://open-vsx.org/extension/HibaChaabnia/devnotes-plus'
REPO = 'https://github.com/Hiba-Chaabnia/DevNotes-Plus'

# slug, nav label, <title>, meta description
PAGES = [
    ('index', 'Overview',
     'User Guide',
     'How to use DevNotes+, the VS Code extension for developer notes anchored to files, lines, and git branches. Setup, code linking, Claude Code MCP, team sharing, and the on-disk file format.'),

    ('getting-started', 'Getting started',
     'Getting Started with DevNotes+',
     'Install DevNotes+ from the VS Code Marketplace or Open VSX, open the sidebar, and capture your first note linked to a file and line with Ctrl+Alt+Q.'),

    ('anchoring-notes-to-code', 'Anchoring notes to code',
     'Anchor a Note to a File and Line in VS Code',
     'Attach a note to a specific file and line with DevNotes+: gutter icons, hover previews, the status bar counter, jump-to-file, and what happens when the code moves.'),

    ('organizing-notes', 'Organizing notes',
     'Organizing Notes with Tags, Branches and Reminders',
     'Tag notes with custom colours and icons, scope them to a git branch, set reminders, star and archive, and start from one of six built-in templates.'),

    ('claude-code-mcp', 'Claude Code & MCP',
     'Connect DevNotes+ to Claude Code (MCP Server)',
     'Register DevNotes+ as an MCP server so Claude Code can read, search, create and update your project notes directly — with every change attributed in the activity feed.'),

    ('team-sharing', 'Sharing with your team',
     'Share Code Notes with Your Team over Git',
     'DevNotes+ notes are private by default. Share individual notes through git with a per-note opt-in, keep one tag set across the team, and resolve merge conflicts in notes.'),

    ('file-format', 'File format & storage',
     'The .devnotes File Format',
     'DevNotes+ stores every note as a Markdown file with YAML frontmatter in .devnotes/. Full field reference, folder layout, and how to read or edit notes without the extension.'),
]

LABELS = {slug: label for slug, label, _t, _d in PAGES}
TITLES = {slug: title for slug, _l, title, _d in PAGES}

ICON_GH = ('<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 .3a12 12 0 0 0-3.8 23.4c.6.1.8-.3.8-.6v-2c-3.3.7-4-1.6-4-1.6-.6-1.4-1.4-1.8-1.4-1.8-1.1-.7.1-.7.1-.7 1.2.1 1.9 1.2 1.9 1.2 1.1 1.9 2.9 1.3 3.6 1 .1-.8.4-1.3.8-1.6-2.7-.3-5.5-1.3-5.5-5.9 0-1.3.5-2.4 1.2-3.2-.1-.3-.5-1.5.1-3.2 0 0 1-.3 3.3 1.2a11.5 11.5 0 0 1 6 0C17.6 4.9 18.6 5.2 18.6 5.2c.7 1.7.3 2.9.1 3.2.8.8 1.2 1.9 1.2 3.2 0 4.6-2.8 5.6-5.5 5.9.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6A12 12 0 0 0 12 .3"/></svg>')
ICON_DL = ('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" '
           'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
           '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>'
           '<polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>')

TEMPLATE = """<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{title} — DevNotes+</title>
  <meta name="description" content="{description}">
  <link rel="canonical" href="{canonical}">
  <meta name="author" content="Hiba Chaabnia">
  <meta name="theme-color" content="#0F172A">

  <link rel="icon" type="image/png" href="../assets/icon.png">
  <link rel="apple-touch-icon" href="../assets/icon.png">

  <meta property="og:site_name" content="DevNotes+">
  <meta property="og:title" content="{title} — DevNotes+">
  <meta property="og:description" content="{description}">
  <meta property="og:type" content="article">
  <meta property="og:url" content="{canonical}">
  <meta property="og:image" content="{base}assets/icon.png">
  <meta property="og:image:alt" content="The DevNotes+ icon">
  <meta property="og:locale" content="en_US">

  <meta name="twitter:card" content="summary">
  <meta name="twitter:title" content="{title} — DevNotes+">
  <meta name="twitter:description" content="{description}">
  <meta name="twitter:image" content="{base}assets/icon.png">

  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="../assets/guide.css">

  <script type="application/ld+json">
  {{
    "@context": "https://schema.org",
    "@graph": [
      {{
        "@type": "TechArticle",
        "headline": "{title}",
        "description": "{description}",
        "url": "{canonical}",
        "inLanguage": "en",
        "dateModified": "{today}",
        "author": {{ "@type": "Person", "name": "Hiba Chaabnia" }},
        "publisher": {{ "@type": "Person", "name": "Hiba Chaabnia" }},
        "about": {{
          "@type": "SoftwareApplication",
          "name": "DevNotes+",
          "applicationCategory": "DeveloperApplication",
          "operatingSystem": "Windows, macOS, Linux"
        }},
        "isPartOf": {{
          "@type": "WebSite",
          "name": "DevNotes+",
          "url": "{base}"
        }}
      }},
      {{
        "@type": "BreadcrumbList",
        "itemListElement": [
          {{ "@type": "ListItem", "position": 1, "name": "DevNotes+", "item": "{base}" }},
          {{ "@type": "ListItem", "position": 2, "name": "Guide", "item": "{base}guide/" }}{crumb3}
        ]
      }}
    ]
  }}
  </script>
</head>
<body>

<header class="navbar">
  <div class="container nav-container">
    <a class="nav-logo" href="../">
      <img class="logo-badge" src="../assets/icon.png" alt="">
      DevNotes+
    </a>
    <nav class="nav-links">
      <a class="nav-link" href="../#features">Features</a>
      <a class="nav-link current" href="./">Guide</a>
      <a class="nav-link" href="../#feedback">Feedback</a>
    </nav>
    <div class="nav-actions">
      <a class="btn btn-ghost" href="{repo}">{icon_gh}<span>View on GitHub</span></a>
      <a class="btn btn-primary" href="{marketplace}">{icon_dl}<span>Install for VS Code</span></a>
    </div>
  </div>
</header>

<main class="container guide-shell">
  <aside class="guide-sidebar">
    <p class="sb-heading">User guide</p>
    <ol>
{sidebar}
    </ol>
  </aside>

  <article class="guide-body">
    <p class="breadcrumb"><a href="../">DevNotes+</a><span>/</span><a href="./">Guide</a>{crumb_html}</p>
    <h1>{h1}</h1>
    <p class="guide-lede">{lede}</p>
{content}
{nextnav}
  </article>
</main>

<footer>
  <div class="container">
    <div class="footer-inner">
      <div class="footer-brand">
        <img class="logo-badge" src="../assets/icon.png" alt="">
        DevNotes+
      </div>
      <nav class="footer-links">
        <a href="../">Home</a>
        <a href="./">Guide</a>
        <a href="{marketplace}">VS Code Marketplace</a>
        <a href="{openvsx}">Open VSX</a>
        <a href="{repo}">GitHub</a>
        <a href="{repo}/issues">Report an issue</a>
      </nav>
    </div>
    <p class="footer-legal">
      DevNotes+ is free and open source under the AGPL-3.0 licence. Built by Hiba Chaabnia.
    </p>
  </div>
</footer>

</body>
</html>
"""


def read_fragment(slug):
    path = os.path.join(SRC, slug + '.html')
    raw = io.open(path, encoding='utf-8').read()

    # Fragments open with an H1 line and a lede line, then the body.
    m = re.match(r'\s*<h1>(.*?)</h1>\s*<lede>(.*?)</lede>\s*(.*)$', raw, re.S)
    if not m:
        sys.exit('%s: expected <h1>…</h1> then <lede>…</lede> at the top' % path)
    return m.group(1).strip(), m.group(2).strip(), m.group(3).strip()


def sidebar_for(current):
    out = []
    for slug, label, _t, _d in PAGES:
        href = './' if slug == 'index' else slug + '.html'
        cur = ' aria-current="page"' if slug == current else ''
        out.append('      <li><a href="%s"%s>%s</a></li>' % (href, cur, label))
    return '\n'.join(out)


def next_nav_for(slug):
    order = [p[0] for p in PAGES]
    i = order.index(slug)
    prev_slug = order[i - 1] if i > 0 else None
    next_slug = order[i + 1] if i < len(order) - 1 else None
    if not prev_slug and not next_slug:
        return ''

    def link(s, direction):
        href = './' if s == 'index' else s + '.html'
        return ('      <a href="%s"><span class="dir">%s</span>'
                '<span class="t">%s</span></a>' % (href, direction, LABELS[s]))

    parts = []
    if prev_slug:
        parts.append(link(prev_slug, 'Previous'))
    if next_slug:
        parts.append(link(next_slug, 'Next'))
    return '    <nav class="next-nav">\n' + '\n'.join(parts) + '\n    </nav>'


def build():
    if not os.path.isdir(OUT):
        os.makedirs(OUT)
    today = date.today().isoformat()
    written = []

    for slug, _label, title, description in PAGES:
        h1, lede, content = read_fragment(slug)
        is_home = slug == 'index'
        canonical = BASE + 'guide/' + ('' if is_home else slug + '.html')

        if is_home:
            crumb3 = ''
            crumb_html = ''
        else:
            crumb3 = (',\n          { "@type": "ListItem", "position": 3, '
                      '"name": "%s", "item": "%s" }' % (title, canonical))
            crumb_html = '<span>/</span>' + h1

        page = TEMPLATE.format(
            title=title,
            description=description,
            canonical=canonical,
            base=BASE,
            today=today,
            crumb3=crumb3,
            crumb_html=crumb_html,
            h1=h1,
            lede=lede,
            content=content,
            sidebar=sidebar_for(slug),
            nextnav=next_nav_for(slug),
            repo=REPO,
            marketplace=MARKETPLACE,
            openvsx=OPENVSX,
            icon_gh=ICON_GH,
            icon_dl=ICON_DL,
        )

        dest = os.path.join(OUT, slug + '.html')
        io.open(dest, 'w', encoding='utf-8', newline='\n').write(page)
        written.append((slug, len(page)))

    return written, today


def write_sitemap(today):
    """Rewrites docs/sitemap.xml so guide pages are always listed."""
    urls = [(BASE, '1.0')]
    for slug, _l, _t, _d in PAGES:
        loc = BASE + 'guide/' + ('' if slug == 'index' else slug + '.html')
        urls.append((loc, '0.8' if slug == 'index' else '0.7'))

    body = '\n'.join(
        '  <url>\n'
        '    <loc>%s</loc>\n'
        '    <lastmod>%s</lastmod>\n'
        '    <changefreq>monthly</changefreq>\n'
        '    <priority>%s</priority>\n'
        '  </url>' % (loc, today, pri)
        for loc, pri in urls
    )
    xml = ('<?xml version="1.0" encoding="UTF-8"?>\n'
           '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
           + body + '\n</urlset>\n')
    io.open(os.path.join(ROOT, 'docs', 'sitemap.xml'), 'w',
            encoding='utf-8', newline='\n').write(xml)
    return len(urls)


if __name__ == '__main__':
    pages, today = build()
    count = write_sitemap(today)
    print('built %d guide pages into docs/guide/' % len(pages))
    for slug, size in pages:
        print('  %-28s %6d bytes' % (slug + '.html', size))
    print('sitemap.xml rewritten with %d urls' % count)
