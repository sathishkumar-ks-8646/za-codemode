#!/usr/bin/env python3
"""Render the Code Execution guide: one `.html` sibling for every authored `.md`.

The markdown files in this directory are the **authored form**. They are
readable on their own, they diff cleanly, and they are what you edit. This
script renders each one into an `.html` sibling that carries the shared
chrome: masthead, the deprecation strip, section navigation, the in-page
table of contents, the pager and the footer.

    python3 build.py            # render every page
    python3 build.py --check    # validate and report, write nothing

No third-party dependencies. No network calls. The markdown subset understood
here is exactly the subset these documents use:

    # H1                      page title (also the <title> and .page-head)
    ## N. Title               numbered section, gets an id and a TOC entry
    ### / #### Title          sub-headings, get ids
    - item / 1. item          lists (one level of nesting)
    | a | b |                 GFM pipe tables
    ```lang … ```             fenced code
    :::kind Title … :::       callout block; kind = danger warn good info sunset
    +++tabs [group] … +++     horizontal tab set, panes split on `+++tab Label`
    <div …> … </div>          a raw HTML block passes through untouched
    **bold** *em* `code` [t](u)

Links written as `page.md#anchor` are rewritten to `page.html#anchor`, so the
markdown tree and the HTML tree are each independently navigable.
"""

from __future__ import annotations

import argparse
import html as htmllib
import re
import sys
import zipfile
from datetime import date
from pathlib import Path

HERE = Path(__file__).resolve().parent

# --------------------------------------------------------------------------
# The guide: order is navigation order.
# --------------------------------------------------------------------------

PAGES = [
    # stem,                nav number, short nav label,        top-nav label
    ("index",              "00", "Start here",                 "Start here"),
    ("01-what-it-is",      "01", "What it is",                 "What it is"),
    ("02-install",         "02", "Install & configure",        "Install"),
    ("03-using-it",        "03", "Using it",                   "Using it"),
    ("04-security",        "04", "Security & governance",      "Security"),
    ("05-troubleshooting", "05", "Troubleshooting & FAQ",      "Troubleshooting"),
    ("06-operating",       "06", "Operating & updating",       "Operating"),
    # 07 was Remote deployment. Remote mode is implemented but unreleased, so
    # the chapter lives in unpublished/ — see unpublished/README.md. The gap in
    # the numbering is deliberate: it keeps the chapter's filename, and every
    # link to it in git history, valid for when it is published.
    ("08-engine",          "08", "How the engine works",      "Engine"),
    ("09-credentials",     "09", "Credentials & secrets",     "Credentials"),
    ("10-audit",           "10", "Audit logging",             "Audit"),
    ("11-data-engine",     "11", "Reading data",              "Reading data"),
]

TOOL_VERSION = "1.0.0"

# How many tools the agent sees. Asserted by the "exposes exactly the five
# tools" case in ../test/agent.test.mjs, and stated on the landing page, so it
# is a constant here rather than a number typed into the HTML.
TOOL_COUNT = 5

# The SDK release that carries this migration: the cross-organization methods are
# removed and the two moved methods land on OrgAPI / WorkspaceAPI from here on.
# Below it, the old methods still exist and still work until REMOVAL_DEADLINE.
# Like the deadline, this appears on every page and is read from this one constant.
PACKAGE_NAME = "zoho-analytics-codemode"

# Everything under agent/ is offered for download on the Agent skills page and
# bundled into one archive. Order is the order the page lists them in.
AGENT_DIR = HERE / "agent"   # optional; absent here
SKILLS_ZIP = HERE / "assets" / "zoho-analytics-v2-agent-skills.zip"

# Language hint per suffix, for the embedded source view.
ASSET_LANG = {".md": "markdown", ".json": "json", ".py": "python"}

# The one-file build: every chapter, the stylesheet and the script inlined into
# a single document that works from any static URL with nothing beside it.
SINGLE_FILE = "za-codemode-how-to-use.html"

# Linked from every page's sidebar. An absolute URL because the guide is served
# from GitHub Pages, where the Markdown sources are not deployed beside it.
REPO_URL = "https://github.com/sathishkumar-ks-8646/za-codemode"

# --------------------------------------------------------------------------
# Inline markdown
# --------------------------------------------------------------------------

def _esc(text: str) -> str:
    return htmllib.escape(text, quote=False)


def _rewrite_link(href: str) -> str:
    """page.md -> page.html, leaving external and anchor-only links alone."""
    if href.startswith(("http://", "https://", "#", "mailto:")):
        return href
    return re.sub(r"\.md(?=$|#)", ".html", href)


# inline HTML that may appear mid-sentence or inside a table cell
INLINE_HTML = re.compile(
    r"</?(?:span|br|kbd|abbr|small|sup|sub|em|strong|b|i)(?:\s[^>]*)?/?>",
    re.I,
)


def inline(text: str) -> str:
    """Render the inline subset.

    Code spans and a small allowlist of inline HTML tags are stashed before
    escaping, so `<span class="tag">` survives but a stray `<` still becomes
    `&lt;`.
    """
    spans: list[str] = []

    def stash(fragment: str) -> str:
        spans.append(fragment)
        return "\x00%d\x00" % (len(spans) - 1)

    text = re.sub(r"`([^`]+)`", lambda m: stash("<code>" + _esc(m.group(1)) + "</code>"), text)
    text = INLINE_HTML.sub(lambda m: stash(m.group(0)), text)
    text = _esc(text)
    text = re.sub(
        r"\[([^\]]+)\]\(([^)]+)\)",
        lambda m: '<a href="%s">%s</a>' % (_esc(_rewrite_link(m.group(2))), m.group(1)),
        text,
    )
    text = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", text)
    text = re.sub(r"(?<![\w*])\*([^*\n]+)\*(?![\w*])", r"<em>\1</em>", text)
    text = re.sub(r"\x00(\d+)\x00", lambda m: spans[int(m.group(1))], text)
    return text


def slugify(text: str) -> str:
    text = re.sub(r"`|\*\*|\*", "", text).strip().lower()
    text = re.sub(r"[^a-z0-9 _-]", "", text)
    return re.sub(r"[\s_]+", "-", text).strip("-")


# --------------------------------------------------------------------------
# Block markdown
# --------------------------------------------------------------------------

CALLOUT_TITLES = {
    "danger": "Breaking change",
    "warn": "Action required",
    "good": "The new way",
    "info": "For reference",
    "sunset": None,          # sunset renders its own fixed furniture
}


class Renderer:
    # Shared across every instance, including the nested ones a callout or a
    # tab pane creates, so ids stay unique within a page.
    _tabset = 0

    # Asset panels need ids unique across the whole page, including the nested
    # renderers used for their descriptions, so the counter is class-level.
    _asset_n = 0

    def __init__(self, stem: str):
        self.stem = stem
        self.toc: list[tuple[str, str]] = []   # (id, title) for `## N.` sections
        self.title = ""
        self.lede = ""
        self.out: list[str] = []
        self._open_section = False

    # -- helpers ----------------------------------------------------------
    def close_section(self) -> None:
        if self._open_section:
            self.out.append("</section>")
            self._open_section = False

    # -- the main pass ----------------------------------------------------
    def render(self, lines: list[str]) -> str:
        i = 0
        n = len(lines)
        while i < n:
            line = lines[i]
            stripped = line.strip()

            # blank ---------------------------------------------------------
            if not stripped:
                i += 1
                continue

            # fenced code ---------------------------------------------------
            if stripped.startswith("```"):
                lang = stripped[3:].strip()
                body: list[str] = []
                i += 1
                while i < n and not lines[i].strip().startswith("```"):
                    body.append(lines[i])
                    i += 1
                i += 1
                cls = ' class="lang-%s"' % _esc(lang) if lang else ""
                self.out.append(
                    "<pre><code%s>%s</code></pre>" % (cls, _esc("\n".join(body)))
                )
                continue

            # tabs ----------------------------------------------------------
            #
            #   +++tabs os          <- optional group name; sets with the same
            #   +++tab macOS           name switch together and remember the
            #   …any markdown…         choice, so "macOS" picked once holds
            #   +++tab Linux           for the whole page.
            #   …
            #   +++
            #
            # A distinct fence rather than another `:::` so a tab pane can
            # contain callouts, which `:::` cannot nest inside itself.
            if stripped.startswith("+++tabs"):
                group = stripped[len("+++tabs"):].strip()
                body = []
                i += 1
                while i < n and lines[i].strip() != "+++":
                    body.append(lines[i])
                    i += 1
                i += 1
                self.out.append(self.tabs(group, body))
                continue

            # callout -------------------------------------------------------
            if stripped.startswith(":::"):
                header = stripped[3:].strip()
                kind, _, label = header.partition(" ")
                kind = kind or "info"
                body = []
                i += 1
                while i < n and lines[i].strip() != ":::":
                    body.append(lines[i])
                    i += 1
                i += 1
                self.out.append(self.callout(kind, label.strip(), body))
                continue

            # raw HTML block ------------------------------------------------
            if stripped.startswith("<") and not stripped.startswith("<http"):
                block = []
                while i < n and lines[i].strip() != "":
                    block.append(lines[i])
                    i += 1
                raw = "\n".join(block)
                raw = re.sub(
                    r'href="([^"]+)"',
                    lambda m: 'href="%s"' % _rewrite_link(m.group(1)),
                    raw,
                )
                self.out.append(raw)
                continue

            # headings ------------------------------------------------------
            m = re.match(r"^(#{1,4})\s+(.*)$", stripped)
            if m:
                level = len(m.group(1))
                text = m.group(2).strip()
                if level == 1:
                    self.title = re.sub(r"`", "", text)
                    i += 1
                    # an immediately following paragraph becomes the lede
                    while i < n and not lines[i].strip():
                        i += 1
                    if i < n and not re.match(r"^[#:<|`-]", lines[i].strip()):
                        lede, i = self.gather_paragraph(lines, i)
                        self.lede = inline(lede)
                    continue
                if level == 2:
                    self.close_section()
                    num_m = re.match(r"^(\d+)\.\s+(.*)$", text)
                    if num_m:
                        num, title = num_m.group(1).zfill(2), num_m.group(2)
                    else:
                        num, title = "", text
                    sid = slugify(title)
                    self.toc.append((sid, title))
                    numspan = '<span class="num">%s</span>' % num if num else ""
                    self.out.append('<section id="%s">' % sid)
                    self.out.append("<h2>%s%s</h2>" % (numspan, inline(title)))
                    self._open_section = True
                    i += 1
                    continue
                tag = "h%d" % level
                self.out.append(
                    '<%s id="%s">%s</%s>' % (tag, slugify(text), inline(text), tag)
                )
                i += 1
                continue

            # table ---------------------------------------------------------
            if stripped.startswith("|"):
                rows = []
                while i < n and lines[i].strip().startswith("|"):
                    rows.append(lines[i].strip())
                    i += 1
                self.out.append(self.table(rows))
                continue

            # list ----------------------------------------------------------
            if re.match(r"^[-*]\s+", stripped) or re.match(r"^\d+\.\s+", stripped):
                block, i = self.gather_list(lines, i)
                self.out.append(block)
                continue

            # horizontal rule -----------------------------------------------
            if re.match(r"^-{3,}$", stripped):
                self.out.append("<hr>")
                i += 1
                continue

            # paragraph -----------------------------------------------------
            para, i = self.gather_paragraph(lines, i)
            self.out.append("<p>%s</p>" % inline(para))

        self.close_section()
        return "\n".join(self.out)

    # -- block builders ---------------------------------------------------
    @staticmethod
    def gather_paragraph(lines: list[str], i: int) -> tuple[str, int]:
        buf = []
        n = len(lines)
        while i < n and lines[i].strip() and not re.match(
            r"^(#{1,4}\s|[-*]\s|\d+\.\s|\||```|:::|\+\+\+|<|-{3,}$)", lines[i].strip()
        ):
            buf.append(lines[i].strip())
            i += 1
        return " ".join(buf), i

    def gather_list(self, lines: list[str], i: int) -> tuple[str, int]:
        n = len(lines)
        ordered = bool(re.match(r"^\d+\.\s+", lines[i].strip()))
        items: list[list[str]] = []
        while i < n:
            raw = lines[i]
            stripped = raw.strip()
            if not stripped:
                if i + 1 < n and re.match(r"^\s+\S", lines[i + 1]):
                    i += 1
                    continue
                break
            m = re.match(r"^([-*]|\d+\.)\s+(.*)$", stripped)
            indent = len(raw) - len(raw.lstrip())
            if m and indent == 0:
                items.append([m.group(2)])
            elif items:
                items[-1].append(stripped)
            else:
                break
            i += 1

        tag = "ol" if ordered else "ul"
        parts = ["<%s>" % tag]
        for item in items:
            nested = [x for x in item[1:] if re.match(r"^[-*]\s+", x)]
            plain = [x for x in item[1:] if not re.match(r"^[-*]\s+", x)]
            body = inline(" ".join([item[0]] + plain))
            if nested:
                body += "<ul>" + "".join(
                    "<li>%s</li>" % inline(re.sub(r"^[-*]\s+", "", x)) for x in nested
                ) + "</ul>"
            parts.append("<li>%s</li>" % body)
        parts.append("</%s>" % tag)
        return "".join(parts), i

    @staticmethod
    def table(rows: list[str]) -> str:
        def cells(row: str) -> list[str]:
            return [c.strip() for c in row.strip().strip("|").split("|")]

        if len(rows) < 2:
            return ""
        head = cells(rows[0])
        body = [cells(r) for r in rows[2:]]

        # A ^ prefix marks the column narrow. The class has to go on every cell
        # in that column, not just the header: a bare th.col-narrow sets the
        # column to its minimum width while the body cells stay breakable, and
        # an identifier like workspaceIds ends up split across four lines.
        narrow = {i for i, h in enumerate(head) if h.startswith("^")}

        out = ['<div class="table-wrap"><table>', "<thead><tr>"]
        for i, h in enumerate(head):
            cls = ' class="col-narrow"' if i in narrow else ""
            out.append("<th%s>%s</th>" % (cls, inline(h.lstrip("^"))))
        out.append("</tr></thead><tbody>")
        for row in body:
            out.append("<tr>")
            for i, cell in enumerate(row):
                classes = []
                if cell.startswith("~~") and cell.endswith("~~"):
                    classes, cell = ["is-old"], cell[2:-2]
                elif cell.startswith("++") and cell.endswith("++"):
                    classes, cell = ["is-new"], cell[2:-2]
                if i in narrow:
                    classes.append("col-narrow")
                cls = ' class="%s"' % " ".join(classes) if classes else ""
                out.append("<td%s>%s</td>" % (cls, inline(cell)))
            out.append("</tr>")
        out.append("</tbody></table></div>")
        return "".join(out)

    def callout(self, kind: str, label: str, body: list[str]) -> str:
        if kind == "asset":
            return self.asset(label.strip(), body)
        sub = Renderer(self.stem)
        inner = sub.render(body)
        if kind == "sunset":
            return (
                '<div class="sunset"><span class="sunset__icon">Deprecated</span>'
                "<div>%s</div></div>" % inner
            )
        title = label or CALLOUT_TITLES.get(kind) or ""
        head = '<div class="note__title">%s</div>' % inline(title) if title else ""
        return '<div class="note note--%s">%s%s</div>' % (_esc(kind), head, inner)

    # -- tabs ---------------------------------------------------------------
    def tabs(self, group: str, body: list[str]) -> str:
        """A horizontal tab set: labels in a row, one pane shown at a time.

        Panes are split on `+++tab <Label>` and each is rendered as ordinary
        markdown, so code, tables and callouts all work inside one.

        Every pane is emitted visible. `migration.js` sets `data-enhanced` and
        only then does the CSS hide the inactive ones, so with JavaScript off
        the reader still sees every platform rather than a single mystery pane.
        A `## ` heading inside a pane would open a stray <section>; put the
        tab set under a heading instead.
        """
        panes: list[tuple[str, list[str]]] = []
        for raw in body:
            m = re.match(r"^\+\+\+tab\s+(.*)$", raw.strip())
            if m:
                panes.append((m.group(1).strip(), []))
            elif panes:
                panes[-1][1].append(raw)

        if not panes:
            return ""

        Renderer._tabset += 1
        base = "tabs-%s-%d" % (self.stem, Renderer._tabset)

        buttons, panels = [], []
        for idx, (label, pane) in enumerate(panes):
            tab_id, panel_id = "%s-t%d" % (base, idx), "%s-p%d" % (base, idx)
            first = idx == 0
            buttons.append(
                '<button class="tabs__tab" role="tab" type="button" id="%s"'
                ' aria-controls="%s" aria-selected="%s" tabindex="%s"'
                ' data-tab-label="%s">%s</button>'
                % (tab_id, panel_id, "true" if first else "false",
                   "0" if first else "-1", _esc(label), inline(label))
            )
            # The in-pane label is for the scripting-off case: the tab column
            # cannot line up with stacked panes, so each pane names itself.
            # The enhanced stylesheet hides it again.
            panels.append(
                '<div class="tabs__panel" role="tabpanel" id="%s"'
                ' aria-labelledby="%s"%s>'
                '<p class="tabs__panel-label">%s</p>%s</div>'
                % (panel_id, tab_id, ' data-active="true"' if first else "",
                   inline(label), Renderer(self.stem).render(pane))
            )

        return (
            '<div class="tabs"%s>'
            '<div class="tabs__list" role="tablist" aria-orientation="horizontal">'
            "%s</div><div class=\"tabs__panels\">%s</div></div>"
        ) % (
            ' data-tab-group="%s"' % _esc(group) if group else "",
            "".join(buttons),
            "".join(panels),
        )

    # -- downloadable asset ------------------------------------------------
    def asset(self, rel: str, body: list[str]) -> str:
        """Render one downloadable file: description, copy, download, source.

        The file is read and inlined at build time. There is no server and no
        fetch(), so the text has to be in the page for Copy and Download to
        work when the guide is opened straight from the filesystem.
        """
        path = HERE / rel
        if not path.exists():
            raise SystemExit("asset not found: %s" % rel)

        text = path.read_text(encoding="utf-8")
        size = len(text.encode("utf-8"))
        kib = "%.1f KB" % (size / 1024) if size >= 1024 else "%d bytes" % size
        lines = text.count("\n") + (0 if text.endswith("\n") else 1)
        lang = ASSET_LANG.get(path.suffix, "")

        Renderer._asset_n += 1
        uid = "asset-%d" % Renderer._asset_n

        name = path.name
        if name == "SKILL.md":
            kind = "Skill"
            # the skill's own directory is what identifies it, not SKILL.md
            display = path.parent.name
        elif name in ("AGENTS.md", "README.md"):
            kind = "Instructions" if name == "AGENTS.md" else "Readme"
            display = name
        elif path.suffix == ".json":
            kind = "Data"
            display = name
        elif path.suffix == ".py":
            kind = "Script"
            display = name
        else:
            kind = "Reference"
            display = name

        sub = Renderer(self.stem)
        desc = sub.render(body)
        cls = ' class="lang-%s"' % _esc(lang) if lang else ""

        return (
            '<div class="asset">'
            '<div class="asset__head">'
            '<span class="asset__kind">%s</span>'
            '<span class="asset__name">%s</span>'
            '<span class="asset__meta">%s &middot; %d lines</span>'
            "</div>"
            '<div class="asset__desc">%s</div>'
            '<div class="asset__path">%s</div>'
            '<div class="asset__actions">'
            '<button type="button" class="asset__btn" data-asset-copy="%s">Copy</button>'
            '<button type="button" class="asset__btn" data-asset-download="%s" '
            'data-filename="%s">Download</button>'
            '<button type="button" class="asset__btn asset__btn--ghost" '
            'data-asset-view="%s" aria-expanded="false" aria-controls="%s">'
            "View source</button>"
            "</div>"
            '<pre class="asset__code" id="%s" hidden><code%s>%s</code></pre>'
            "</div>"
        ) % (
            _esc(kind), _esc(display), kib, lines,
            desc,
            _esc(rel),
            uid, uid, _esc(name), uid, uid,
            uid, cls, _esc(text),
        )


# --------------------------------------------------------------------------
# Page shell
# --------------------------------------------------------------------------

SPINE = "".join("<i></i>" for _ in range(4))


def zoho_mark() -> str:
    """Inline `zoho.svg` so it inherits the surrounding text colour.

    The file ships with a hardcoded black fill, which would disappear in the
    dark theme. Inlining it and swapping that fill for `currentColor` lets one
    asset serve both themes with no duplicate and no CSS filter hack. It is
    inlined rather than referenced with <img> for the same reason: an external
    image cannot inherit `color`.
    """
    src = HERE / "zoho.svg"
    if not src.exists():
        return ""
    svg = src.read_text(encoding="utf-8").strip()
    svg = re.sub(r"<\?xml[^>]*\?>\s*", "", svg)
    svg = re.sub(r'\sid="[^"]*"', "", svg, count=1)
    svg = re.sub(r'fill="#0{3,6}"', 'fill="currentColor"', svg, flags=re.I)
    svg = svg.replace(
        "<svg ", '<svg class="zoho-mark" role="img" aria-label="Zoho" focusable="false" ', 1
    )
    return svg


def shell(stem: str, r: Renderer, body: str, meta: dict) -> str:
    idx = [p[0] for p in PAGES].index(stem)
    num, nav_label = PAGES[idx][1], PAGES[idx][2]

    topnav = "\n".join(
        '      <a href="%s.html"%s>%s</a>'
        % (s, ' aria-current="page"' if s == stem else "", htmllib.escape(top))
        for s, _, _, top in PAGES
    )

    sidenav = "\n".join(
        '    <a href="%s.html"%s><span class="n">%s</span><span>%s</span></a>'
        % (s, ' aria-current="page"' if s == stem else "", n, htmllib.escape(label))
        for s, n, label, _ in PAGES
    )

    toc = ""
    if r.toc:
        links = "\n".join(
            '    <a href="#%s">%s</a>' % (sid, htmllib.escape(re.sub(r"`", "", t)))
            for sid, t in r.toc
        )
        toc = (
            '<aside class="toc" aria-label="On this page">\n'
            "  <nav>\n    <h2>On this page</h2>\n%s\n  </nav>\n</aside>" % links
        )

    prev_link = next_link = ""
    if idx > 0:
        p = PAGES[idx - 1]
        prev_link = ('<a href="%s.html"><span class="pager__side">Previous</span>'
                     "&larr; %s</a>" % (p[0], htmllib.escape(p[2])))
    if idx < len(PAGES) - 1:
        p = PAGES[idx + 1]
        next_link = ('<a href="%s.html" style="margin-left:auto;text-align:right">'
                     '<span class="pager__side">Next</span>%s &rarr;</a>'
                     % (p[0], htmllib.escape(p[2])))

    page_head = ""
    if stem != "index":
        page_head = """<header class="page-head">
  <div class="spine">{spine}</div>
  <p class="eyebrow">Code Mode &middot; <b>Chapter {num}</b></p>
  <h1>{title}</h1>
  {lede}
</header>""".format(
            spine=SPINE, num=num, title=htmllib.escape(r.title),
            lede='<p class="lede">%s</p>' % r.lede if r.lede else "",
        )

    layout_cls = "layout" if r.toc else "layout layout--wide"

    return """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>{title} &mdash; Zoho Analytics Code Mode for AI agents</title>
<meta name="description" content="{desc}">
<link rel="stylesheet" href="assets/migration.css">
<script src="assets/migration.js" defer></script>
</head>
<body>
<a class="skip-link" href="#main">Skip to content</a>

<header class="masthead">
  <div class="masthead__inner">
    <a class="wordmark" href="index.html">
      {mark}
      Analytics Code Mode<span>&nbsp;/ UTCP for AI agents</span>
    </a>
    <span class="chip">Zoho Analytics API v2</span>
    <nav class="topnav" aria-label="Guide chapters">
{topnav}
    </nav>
    <button class="icon-btn nav-toggle" id="nav-toggle" type="button"
            aria-expanded="false" aria-controls="sidebar"
            aria-label="Show chapter navigation">&#9776;</button>
    <button class="icon-btn" id="theme-toggle" type="button"
            aria-label="Switch colour theme">&#9680;</button>
  </div>
</header>

<div class="deadline-bar">
  <div class="deadline-bar__inner">
    <span class="chip chip--sdk">v{deadline}</span>
    <p>Installed from source &mdash; the package is <strong>not on npm yet</strong>.
    <a href="02-install.html">Setup in ten minutes &rarr;</a></p>
    <span class="chip chip--deadline">Read-only</span>
    <p>Write operations are <strong>disabled by default</strong>. Enable them
    deliberately. <a href="04-security.html">Security model &rarr;</a></p>
  </div>
</div>

{hero}
<div class="{layout_cls}">
  <aside class="sidebar" id="sidebar">
    <nav class="sidenav" aria-label="Chapters">
    <h2>Guide</h2>
{sidenav}
    <h2>Source</h2>
    <a href="{repo}/blob/main/guide/{stem}.md"><span class="n">md</span><span>This page as Markdown</span></a>
    <a href="{repo}"><span class="n">&#8212;</span><span>Repository</span></a>
    <a href="za-codemode-how-to-use.html"><span class="n">1</span><span>Whole guide, one page</span></a>
    </nav>
  </aside>

  <main class="doc" id="main">
{page_head}
{body}
    <nav class="pager" aria-label="Chapter">
      {prev}
      {next}
    </nav>
  </main>

{toc}
</div>

<footer class="footer">
  <div class="spine">{spine}</div>
  <div class="footer__inner">
    <div>
      <h2>Guide</h2>
{footer_nav}
    </div>
    <div>
      <h2>Reference</h2>
      <a href="02-install.html#configuration-reference">Configuration reference</a>
      <a href="05-troubleshooting.html#error-codes">Error codes</a>
      <a href="04-security.html#what-the-sandbox-cannot-do">Sandbox boundary</a>
      <a href="09-credentials.html">Credentials &amp; profiles</a>
    </div>
    <div class="footer__meta">
      <h2>About</h2>
      <p>Setup and usage guide for Zoho Analytics Code Mode, the MCP server
      that lets AI agents run sandboxed code against the Analytics v2 API,
      powered by the UTCP code-mode engine.</p>
      <p>Rendered from the Markdown in this folder by <code>build.py</code>.
      Generated {today}.</p>
      <p><strong>{sdk_version} v{deadline}. Read-only by default.</strong></p>
    </div>
  </div>
</footer>
</body>
</html>
""".format(
        title=htmllib.escape(r.title),
        desc=htmllib.escape(meta.get("description", r.title)),
        spine=SPINE,
        mark=zoho_mark(),
        topnav=topnav,
        sidenav=sidenav,
        stem=stem,
        repo=REPO_URL,
        page_head=page_head,
        body=body,
        prev=prev_link,
        next=next_link,
        toc=toc,
        layout_cls=layout_cls,
        hero=meta.get("hero", ""),
        deadline=TOOL_VERSION,
        sdk_version=PACKAGE_NAME,
        footer_nav="\n".join(
            '      <a href="%s.html">%s &nbsp;%s</a>' % (s, n, htmllib.escape(label))
            for s, n, label, _ in PAGES
        ),
        today=date.today().isoformat(),
    )


# --------------------------------------------------------------------------
# Driver
# --------------------------------------------------------------------------

def split_front_matter(text: str) -> tuple[dict, str]:
    meta: dict = {}
    if text.startswith("---\n"):
        end = text.find("\n---\n", 4)
        if end != -1:
            for line in text[4:end].splitlines():
                if ":" in line:
                    k, _, v = line.partition(":")
                    meta[k.strip()] = v.strip()
            text = text[end + 5:]
    return meta, text


def hero_for_index() -> str:
    return """<section class="hero">
  <div class="hero__inner">
    <div class="spine" aria-hidden="true">{spine}</div>
    <h1>Let your AI agent write code against Zoho&nbsp;Analytics.</h1>
    <p class="hero__lede">
      Instead of calling one endpoint per turn, your agent writes a single
      program &mdash; loops, filters, joins and all &mdash; and runs it in a
      sealed V8 isolate next to the API. The operation catalog is a UTCP
      manual generated from the published OpenAPI specifications, and the
      product documentation ships with it.
    </p>
    <div class="hero__actions">
      <a class="btn btn--primary" href="02-install.html">Install it</a>
      <a class="btn" href="01-what-it-is.html">How it works</a>
    </div>
    <dl class="hero__facts">
      <div class="fact fact--new"><dt>Tools your agent sees</dt><dd>{tools}</dd></div>
      <div class="fact"><dt>Operations reachable</dt><dd>203</dd></div>
      <div class="fact fact--new"><dt>API domains</dt><dd>10</dd></div>
      <div class="fact"><dt>Documented error codes</dt><dd>385</dd></div>
      <div class="fact fact--warn"><dt>Setup time</dt><dd>5 min</dd></div>
    </dl>
  </div>
</section>""".format(spine=SPINE, tools=TOOL_COUNT)


def bundle_skills() -> tuple[int, int]:
    """Zip agent/ so the page can offer the whole set as one download.

    Deterministic: files sorted, timestamps fixed, so rebuilding an unchanged
    tree produces a byte-identical archive and does not churn in git.
    """
    if not AGENT_DIR.is_dir():
        return (0, 0)

    files = sorted(
        p for p in AGENT_DIR.rglob("*")
        if p.is_file() and "__pycache__" not in p.parts
    )
    SKILLS_ZIP.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(SKILLS_ZIP, "w", zipfile.ZIP_DEFLATED) as zf:
        for path in files:
            info = zipfile.ZipInfo(
                str(path.relative_to(AGENT_DIR.parent)), date_time=(1980, 1, 1, 0, 0, 0)
            )
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            zf.writestr(info, path.read_bytes())
    return len(files), SKILLS_ZIP.stat().st_size


def namespace_ids(html: str, stem: str) -> str:
    """Prefix every id and intra-document reference with the chapter stem.

    Ten chapters in one document means ten chances of an id collision — both
    `02-install` and `09-credentials` have a "which scopes" heading's worth of
    overlap. Prefixing makes every anchor unique and turns cross-chapter links
    into in-page jumps.

    Order matters: same-page `#anchor` links are rewritten first, so the
    `#stem--anchor` hrefs the cross-chapter rules then produce are already
    final and never prefixed twice.
    """
    for attr in ("id", "aria-controls", "aria-labelledby"):
        html = re.sub(
            r'%s="([^"]+)"' % attr,
            lambda m, a=attr: '%s="%s--%s"' % (a, stem, m.group(1)),
            html,
        )
    html = re.sub(r'href="#([^"]+)"', r'href="#%s--\1"' % stem, html)
    # page.html#anchor -> #page--anchor, page.html -> #page
    html = re.sub(r'href="([\w.-]+)\.html#([^"]+)"', r'href="#\1--\2"', html)
    html = re.sub(r'href="([\w.-]+)\.html"', r'href="#\1"', html)
    return html


def single_file(parts: list[tuple[str, str, str, str, str, str]]) -> str:
    """Build the one-file edition from the already-rendered chapter bodies.

    `parts` is (stem, num, nav label, title, lede, body) in navigation order.
    """
    css = (HERE / "assets" / "migration.css").read_text(encoding="utf-8")
    js = (HERE / "assets" / "migration.js").read_text(encoding="utf-8")
    mark = (HERE / "zoho.svg").read_text(encoding="utf-8").strip()

    contents = "\n".join(
        '<li><a href="#%s"><span class="num">%s</span>%s</a></li>'
        % (stem, num, htmllib.escape(label))
        for stem, num, label, _, _, _ in parts
    )

    chapters = []
    for stem, num, _, title, lede, body in parts:
        chapters.append(
            '<article class="chapter" id="%s">\n'
            '<header class="page-head">\n'
            '  <div class="spine">%s</div>\n'
            '  <p class="eyebrow">Code Mode &middot; <b>Chapter %s</b></p>\n'
            '  <h1>%s</h1>\n%s</header>\n%s\n</article>'
            % (stem, SPINE, num, htmllib.escape(title),
               '  <p class="lede">%s</p>\n' % lede if lede else "",
               namespace_ids(body, stem))
        )

    doc = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Zoho Analytics Code Mode &mdash; complete guide</title>
<meta name="description" content="Install, configure and use Zoho Analytics Code Mode: an MCP server that lets AI agents write and run sandboxed code against the Analytics v2 API. The complete guide in one page.">
<style>
{css}
/* ---- one-file edition ---- */
.chapter + .chapter {{ margin-top: 3.5rem; border-top: 1px solid var(--rule-2); padding-top: 2.5rem; }}
.chapter .page-head {{ padding-top: 1rem; }}
.contents {{ border: 1px solid var(--rule); background: var(--paper-2); padding: 1.1rem 1.25rem; }}
.contents h2 {{ font-size: var(--t--1); letter-spacing: 0.11em; text-transform: uppercase;
  color: var(--ink-3); margin-bottom: 0.6rem; }}
.contents ol {{ list-style: none; padding: 0; columns: 2; column-gap: 2rem; }}
@media (max-width: 760px) {{ .contents ol {{ columns: 1; }} }}
.contents li {{ break-inside: avoid; margin: 0.18rem 0; }}
.contents a {{ text-decoration: none; display: flex; gap: 0.6rem; padding: 0.15rem 0; }}
.contents a:hover {{ color: var(--accent-text); }}
.contents .num {{ color: var(--ink-3); font-variant-numeric: tabular-nums; }}
</style>
<script>
{js}
</script>
</head>
<body>
<a class="skip-link" href="#main">Skip to content</a>

<header class="masthead">
  <div class="masthead__inner">
    <a class="wordmark" href="#top">
      {mark}
      Analytics Code Mode<span>&nbsp;/ UTCP for AI agents</span>
    </a>
    <span class="chip">Zoho Analytics API v2</span>
    <button class="icon-btn" id="theme-toggle" type="button"
            aria-label="Switch colour theme">&#9680;</button>
  </div>
</header>

<div class="deadline-bar">
  <div class="deadline-bar__inner">
    <span class="chip chip--sdk">v{version}</span>
    <p>Installed from source &mdash; the package is <strong>not on npm yet</strong>.
    <a href="#02-install">Setup in ten minutes &rarr;</a></p>
    <span class="chip chip--deadline">Read-only</span>
    <p>Write operations are <strong>disabled by default</strong>. Enable them
    deliberately. <a href="#04-security">Security model &rarr;</a></p>
  </div>
</div>

<div class="layout layout--wide" id="top">
  <main class="doc" id="main">
    <nav class="contents" aria-label="Contents">
      <h2>The whole guide, one page</h2>
      <ol>
{contents}
      </ol>
    </nav>

{chapters}
  </main>
</div>

<footer class="footer">
  <div class="footer__inner">
    <div>
      <p>Setup and usage guide for Zoho Analytics Code Mode, the MCP server
      that lets AI agents run sandboxed code against the Analytics v2 API,
      powered by the UTCP code-mode engine.</p>
      <p>One-file edition, generated {today} from the Markdown in
      <a href="https://github.com/sathishkumar-ks-8646/za-codemode">github.com/sathishkumar-ks-8646/za-codemode</a>.</p>
      <p><strong>{package} v{version}. Read-only by default.</strong></p>
    </div>
  </div>
</footer>
</body>
</html>
""".format(
        css=css, js=js, mark=mark, contents=contents,
        chapters="\n\n".join(chapters),
        today=date.today().isoformat(),
        version=TOOL_VERSION, package=PACKAGE_NAME,
    )

    # This file gets published on its own, where a broken anchor is nobody's
    # 404 — the page just silently fails to jump. Namespacing is regex work on
    # generated HTML, so verify the result rather than trusting it.
    ids = set(re.findall(r'id="([^"]+)"', doc))
    dead = sorted({a for a in re.findall(r'href="#([^"]+)"', doc) if a not in ids})
    stray = sorted(set(re.findall(r'href="([\w.-]+\.html[^"]*)"', doc)))
    if dead or stray:
        raise SystemExit(
            "%s is broken:\n%s%s" % (
                SINGLE_FILE,
                "".join("  dead anchor #%s\n" % a for a in dead),
                "".join("  link leaves the file: %s\n" % s for s in stray),
            )
        )
    return doc


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--check", action="store_true", help="validate, write nothing")
    ap.add_argument("--single", action="store_true",
                    help="also write %s — every chapter, CSS and JS in one file"
                         % SINGLE_FILE)
    args = ap.parse_args()

    stems = [p[0] for p in PAGES]
    problems: list[str] = []
    written = 0
    anchors: dict[str, set[str]] = {}
    links: list[tuple[str, str]] = []

    rendered: dict[str, str] = {}
    # (stem, num, nav label, title, lede, body) for the one-file edition
    parts: list[tuple[str, str, str, str, str, str]] = []
    labels = {p[0]: (p[1], p[2]) for p in PAGES}

    for stem in stems:
        src = HERE / (stem + ".md")
        if not src.exists():
            problems.append("missing source: %s.md" % stem)
            continue
        meta, text = split_front_matter(src.read_text(encoding="utf-8"))
        r = Renderer(stem)
        body = r.render(text.splitlines())
        if not r.title:
            problems.append("%s.md has no `# Title`" % stem)
        if stem == "index":
            meta["hero"] = hero_for_index()
        rendered[stem] = shell(stem, r, body, meta)
        num, label = labels[stem]
        parts.append((stem, num, label, r.title, r.lede, body))

        # ids the shell supplies, plus every id in the rendered body
        anchors[stem + ".html"] = {"main", "sidebar"} | {sid for sid, _ in r.toc} | set(
            re.findall(r'id="([^"]+)"', body)
        )
        for href in re.findall(r'href="([^"]+)"', rendered[stem]):
            links.append((stem, href))

    # The one-file edition is a legitimate link target from every sidebar, but
    # it has no .md source, so the page loop never registers it.
    anchors[SINGLE_FILE] = {stem for stem in stems}

    # internal link check
    for stem, href in links:
        if href.startswith(("http", "mailto:", "assets/")):
            continue
        page, _, frag = href.partition("#")
        page = page or (stem + ".html")
        if page.endswith(".md"):
            if not (HERE / page).exists():
                problems.append("%s -> missing file %s" % (stem, page))
            continue
        if page not in anchors and page.endswith(".html"):
            problems.append("%s -> unknown page %s" % (stem, page))
        elif frag and page in anchors and frag not in anchors[page]:
            problems.append("%s -> dead anchor %s#%s" % (stem, page, frag))

    bundled = None
    if not args.check:
        for stem, out in rendered.items():
            (HERE / (stem + ".html")).write_text(out, encoding="utf-8")
            written += 1
        bundled = bundle_skills()
        if args.single:
            out = single_file(parts)
            (HERE / SINGLE_FILE).write_text(out, encoding="utf-8")
            print("\n  %-26s written  (%.0f KB, self-contained)"
                  % (SINGLE_FILE, len(out.encode("utf-8")) / 1024))

    verb = "checked" if args.check else "written"
    for stem in stems:
        if stem in rendered:
            print("  %-26s %s" % (stem + ".html", verb))
    print()
    if problems:
        print("PROBLEMS (%d):" % len(problems))
        for p in problems:
            print("  - " + p)
        return 1
    print("Links     : every internal link and anchor resolves.")
    if bundled and bundled[0]:
        print("Skills    : %d files bundled into %s (%.1f KB)."
              % (bundled[0], SKILLS_ZIP.relative_to(HERE), bundled[1] / 1024))
    print("Pages     : %d markdown sources, %d html siblings."
          % (len(rendered), len(rendered) if not args.check else written))
    return 0


if __name__ == "__main__":
    sys.exit(main())
