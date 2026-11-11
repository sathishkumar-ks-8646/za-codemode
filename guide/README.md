# code-execution-mcp/guide

The customer-facing setup and usage guide for **Zoho Analytics Code Mode** —
the MCP server that lets an AI agent write and run sandboxed code against the
Analytics v2 API.

This folder is the guide *we publish to users*. Write it for someone outside the
company who has to install the thing and then trust it with their data.

> **Two facts appear on every page and must stay accurate.** Both are single
> constants in `build.py`, read by the strip at the top of every page and by the
> footer — change the constant and re-render, never the pages:
>
> - `TOOL_VERSION` — **1.0.0**, kept in step with `../package.json`.
> - `PACKAGE_NAME` — **zoho-analytics-code-mode-mcp**, the name users type into
>   their agent configuration.

## What is in here

```
guide/
├── README.md                you are here — how the folder works
├── build.py                 renders every *.md into an *.html sibling
├── zoho.svg                 the Zoho lettermark, inlined into every masthead
├── assets/
│   ├── migration.css        the design system
│   └── migration.js         theme toggle, copy buttons, filter, scrollspy
│
├── index.md          index.html             00  Start here
├── 01-what-it-is.md         .html           01  What it is
├── 02-install.md            .html           02  Install & configure
├── 03-using-it.md           .html           03  Using it
├── 04-security.md           .html           04  Security & governance
├── 05-troubleshooting.md    .html           05  Troubleshooting & FAQ
└── 06-operating.md          .html           06  Operating & updating
```

**Markdown is the authored form. HTML is generated.** Edit the `.md` files and
re-run `build.py`; never hand-edit an `.html` file, because the next build
overwrites it. Both trees are independently navigable: the markdown links to
`.md`, and the renderer rewrites those to `.html` on the way out.

Open `index.html` in a browser straight from the filesystem — no server, no
build step for the reader, no webfonts, no network calls.

## Building

```bash
cd code-execution-mcp/guide

python3 build.py            # render every page
python3 build.py --check    # validate only, write nothing
```

`--check` verifies that every page has an `# H1`, that every internal link
points at a file that exists, and that every `#anchor` resolves to a real
heading. It exits non-zero if anything is wrong, so it is safe to run in CI.

No third-party dependencies — standard library only, same as the rest of the
repository's tooling.

## Writing a page

Front matter is optional and carries one key:

```markdown
---
description: One sentence. Becomes the <meta name="description">.
---

# Page title

The first paragraph after the H1 becomes the page lede.
```

The markdown subset the renderer understands:

| Syntax | Renders as |
|---|---|
| `## 3. Section title` | A numbered section with an `id`, and an entry in the right-hand table of contents. |
| `### Title`, `#### Title` | Sub-headings, each with an `id`. |
| `- item`, `1. item` | Lists. One level of nesting. |
| <code>&#124; a &#124; b &#124;</code> | A GFM pipe table. Prefix a header cell with `^` to make that column narrow and non-wrapping. |
| `~~cell~~` in a table | Struck through in the "removed" red. |
| `++cell++` in a table | Bold in the "new" green. |
| ` ```lang ` | A code block with a copy button. |
| `:::kind Title` … `:::` | A callout. `kind` is `danger`, `warn`, `good`, `info` or `sunset`. |
| A line starting with `<` | A raw HTML block, passed through. |

### Callouts carry the safety message

`:::danger` is reserved for the two things that can lose a user their data:
enabling write operations, and leaking the configuration file that holds the
refresh token. Use `:::warn` for everything else that bites.

This guide documents a tool that **executes model-written code against live
customer data**. Every page that touches that capability states the boundary
plainly rather than glossing it — readers arrive at individual chapters from
search engines, not only through `index.html`, so each page has to carry its
own warning.

## Keeping it true

The guide makes specific, checkable claims. When the code changes, these change
with it:

| Claim | Source of truth |
|---|---|
| 203 operations, 76 read-only | `npm run build:manual` output, and `ZA_ALLOW_WRITES` handling in `src/catalog.mjs` |
| Every environment variable | `src/config.mjs` |
| Error-code annotations | `explain()` in `src/server.mjs` |
| The sandbox is sealed | the "the sandbox is sealed" case in `test/agent.test.mjs` |
| Default limits (200 calls, 60 s, 256 MB) | `src/config.mjs` |

The sandbox-seal claim in chapter 04 is the most important one in the guide. It
is asserted by a test; if that test is ever weakened, the chapter is wrong.
