---
description: Operating Zoho Analytics Code Mode — updates, API unit cost, running from source, rebuilding the operation catalog, and the tests.
---

# Operating & updating

## 1. Updates

With `npx -y zoho-analytics-code-mode-mcp`, the latest published version is fetched when your agent starts the server. To pin a version, name it:

```json
"args": ["-y", "zoho-analytics-code-mode-mcp@1.0.0"]
```

New Analytics operations arrive with a new release of this package, because the catalog is generated from the published OpenAPI specifications and bundled at build time.

## 2. What it costs

Two separate budgets, often confused.

| ^Budget | Who bills it | Effect of this tool |
|---|---|---|
| **Analytics API units** | Zoho | **Unchanged.** Same operations, same units |
| **Model tokens** | Your AI provider | **Substantially lower.** Fewer turns, and intermediate data never enters context |

In a measured multi-workspace export the same work took 19 model turns one call at a time versus 1 with a program — and 2,092 bytes of intermediate data became 101. Both paths made the same API calls.

`run_analytics_code` reports `apiCalls` on every execution, so you can see unit consumption directly.

:::info Keeping units down
Filter server-side. A `CONFIG` with `criteria` is applied by Analytics before rows are sent; filtering in the sandbox instead means paying for everything and discarding most of it.
:::

## 3. Running from source

```bash
git clone <this-repository>
cd code-execution-mcp
npm install
npm test
```

| ^Command | What it does |
|---|---|
| `npm start` | Run the server on stdio |
| `npm test` | The whole suite — search quality and end-to-end MCP |
| `npm run build:manual` | Regenerate the operation catalog from `v2.0/oas/` |
| `npm run build:knowledge` | Regenerate the knowledge bundle from `v2.0/okf/` |
| `npm run build` | Both |
| `node test/mock-analytics.mjs 8788` | Start the mock API by itself |

:::warn Install from the public registry
The `@utcp/*` packages are not mirrored on internal registries. `.npmrc` in this folder pins `registry=https://registry.npmjs.org` for exactly that reason.
:::

### Pointing it at the mock

The test suite runs entirely offline against a mock Analytics API. To drive the real server against it by hand:

```bash
node test/mock-analytics.mjs 8788 &

ANALYTICS_SERVER_URL=http://127.0.0.1:8788 \
ANALYTICS_ACCESS_TOKEN=test-token \
ANALYTICS_ORG_ID=2375824000000000001 \
npm start
```

## 4. Building the catalog from source

`manual/analytics.utcp.json` is generated, never hand-edited:

```bash
npm run build:manual          # reads ../v2.0/oas/*-grouped-api.json
```

It emits 203 operations, about 565 KB. Five transformations are applied that a stock OpenAPI conversion gets wrong for Zoho:

| ^Transformation | Why |
|---|---|
| `CONFIG` typed as `string` | The specification types it as an object, but the API wants stringified, URL-encoded JSON |
| Base URL becomes a variable | So one build serves all seven data centres |
| `Authorization` header auth | Zoho accepts `Bearer`; the stock conversion emits an OAuth2 flow Zoho does not use |
| Full descriptions kept | A stock conversion keeps only `summary` and drops the detail the model needs |
| `${...}` in prose defused | One operation documents a `${variableName}` placeholder, which the templating engine would otherwise try to resolve |

## 5. The knowledge bundle

`knowledge/knowledge.json` is generated from the published OKF bundle at [github.com/zoho/analytics-okf](https://github.com/zoho/analytics-okf) — around 12 MB across 600+ files, far too much to ship or to put in front of a model. The build resolves the current version from that repository's root `manifest.json` rather than hard-coding one. `tools/build-knowledge.mjs` selects the parts that change the code a model writes:

| ^Included | Why |
|---|---|
| All 8 workflow playbooks | Multi-step recipes are exactly what code mode is for |
| 9 foundations references | Criteria grammar, CONFIG conventions, job polling, identifiers, enums, limits |
| 385 error codes | The attribute table only; the per-operation "Raised by" tables are what make the source 922 KB |

Deliberately excluded: the permission matrix, OAuth scopes, API-unit tables and glossary. They are reference material for humans, and none of them change the code that gets generated.

```bash
npm run build:knowledge                               # from the published repository
node tools/build-knowledge.mjs --local  ../v2.0/okf   # offline, from a checkout
node tools/build-knowledge.mjs --verify ../v2.0/okf   # has a checkout drifted?
```

Each build records the OKF version and the date that bundle was generated, and the server reports both at startup — so a stale snapshot is visible rather than silently authoritative.

## 6. The test suite

```text
test/search.test.mjs    search quality — API and user vocabulary
test/agent.test.mjs     end-to-end over real MCP stdio against the mock
```

`agent.test.mjs` asserts the properties that matter: exactly two tools, signatures stay small, a multi-step program returns only its answer, `ORG_ID` is present, **the sandbox is sealed**, write operations are hidden, and a failed program yields an actionable error.

The sandbox-seal test is the one to keep green above all others — it asserts that `require`, `fetch`, `process`, `Buffer` and `XMLHttpRequest` are all unreachable from executing code.

## 7. Known rough edges

Honest notes for anyone maintaining this.

| ^Edge | Detail |
|---|---|
| The process does not exit cleanly | `isolated-vm` worker threads outlive `process.exit()`. Tests force exit; agents kill the child on quit, so it does not matter in normal use |
| No audit log | Programs are not persisted. `apiCalls` is reported per execution and that is all |
| Search is lexical | Synonym expansion plus field-weighted scoring, no embeddings. It handles API vocabulary well and paraphrase adequately |
| The knowledge bundle is a snapshot | Regenerated by `npm run build:knowledge`; it does not follow github.com/zoho/analytics-okf automatically. Its age is reported at startup and warned about past 90 days |
| Write path is lightly tested | `ZA_ALLOW_WRITES=true` exposes all 203 operations; only the read-only set is covered by tests |
| UTCP is a thin dependency | All of it is fenced inside `src/catalog.mjs` precisely so it can be replaced without touching the rest |

## 8. Where things live

```text
code-execution-mcp/
├── src/
│   ├── server.mjs       the MCP server and its three tools
│   ├── knowledge.mjs    the OKF knowledge base: lookup, search, hints
│   ├── catalog.mjs      the operation catalog and sandbox — the only UTCP usage
│   ├── search.mjs       query expansion and ranking
│   ├── auth.mjs         refresh token -> access token
│   ├── config.mjs       environment parsing and validation
│   └── quiet.mjs        stdout guard — must be imported first
├── tools/
│   ├── build-manual.mjs     OpenAPI specs -> UTCP operation catalog
│   └── build-knowledge.mjs  OKF docs -> shipped knowledge bundle
├── manual/analytics.utcp.json     generated; do not hand-edit
├── knowledge/knowledge.json       generated; do not hand-edit
├── test/                mock API, search tests, end-to-end tests
└── guide/               this documentation
```
