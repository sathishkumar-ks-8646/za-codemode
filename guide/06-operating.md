---
description: Operating Zoho Analytics Code Mode — updates, API unit cost, running from source, rebuilding the operation catalog, and the tests.
---

# Operating & updating

## 1. Updates

This is installed from source, so updating is a pull in your clone:

```bash
cd /path/to/za-codemode
git pull
npm install          # in case a dependency moved
```

Restart your agent afterwards — it holds the old process open until it does.

New Analytics operations arrive with a new commit, because the catalog is generated from the published OpenAPI specifications and committed as a build artifact. To take a catalog update without taking code changes, rebuild it yourself — see [§4](#building-the-catalog-from-source).

:::info Pinning a version
`git pull` tracks `main`. To hold a known-good state, check out a tag or a commit instead, and note which one you are on: there is no `--version` flag yet, so the commit is the only answer to "which build is this".
:::

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
git clone https://github.com/sathishkumar-ks-8646/za-codemode.git
cd za-codemode
npm install
npm test
```

| ^Command | What it does |
|---|---|
| `npm start` | Run the server on stdio |
| `npm test` | The whole suite — 101 tests, fully offline |
| `npm run build:manual` | Regenerate the operation catalog from the published OAS repository |
| `npm run build:knowledge` | Regenerate the knowledge bundle from the published OKF repository |
| `npm run build` | Both |
| `npm run verify:knowledge` | Check a local OKF checkout against the bundle |
| `node test/mock-analytics.mjs 8788` | Start the mock API by itself |
| `python3 guide/build.py` | Re-render this guide; `--check` validates without writing |

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
npm run build:manual                                 # from github.com/zoho/analytics-oas
node tools/build-manual.mjs --local <oas-dir>        # offline, from a checkout
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
npm run build:knowledge                             # from the published repository
node tools/build-knowledge.mjs --local  <okf-dir>   # offline, from a checkout
node tools/build-knowledge.mjs --verify <okf-dir>   # has a checkout drifted?
```

Each build records the OKF version and the date that bundle was generated, and the server reports both at startup — so a stale snapshot is visible rather than silently authoritative.

## 6. The test suite

101 tests, no network, no credentials — everything runs against a mock Analytics API and a mock Zoho Accounts.

```text
test/agent.test.mjs        end-to-end over real MCP stdio against the mock
test/resolve.test.mjs      name resolution: fuzzy matching, ambiguity, refusal
test/search.test.mjs       search quality — API and user vocabulary
test/audit.test.mjs        two streams, rotation, redaction, hash chain
test/credentials.test.mjs  env -> credential command -> keychain resolution
test/token-cache.test.mjs  access-token reuse across process restarts
test/orgs.test.mjs         organization allowlist enforcement
test/remote.test.mjs       the full OAuth 2.1 flow (unreleased mode)
test/mock-analytics.mjs    the mock API — enforces org scoping, returns real shapes
test/mock-accounts.mjs     the mock token endpoint
```

`agent.test.mjs` asserts the properties that matter: exactly four tools, signatures stay small, a multi-step program returns only its answer, `ORG_ID` is present, **the sandbox is sealed**, write operations are hidden, the org header and `Bearer` prefix reach the API correctly, and a failed program yields an actionable error.

Two tests to keep green above all others:

- **"the sandbox is sealed"** — asserts that `require`, `fetch`, `process`, `Buffer` and `XMLHttpRequest` are all unreachable from executing code. [Security](04-security.md#what-the-sandbox-cannot-do) is only true while this passes.
- **"catching the refusal does NOT let the program substitute"** — asserts that a program which swallows a failed name resolution still fails the whole execution. Analysing `sum_of_revenue` when the user said `sum_of_cost` is the worst outcome this tool can produce.

:::info The mock mirrors the API, not the documentation
`mock-analytics.mjs` returns the shapes live Analytics actually sends — rows as a flat array in `data`, numbers as formatted strings like `"$1,682.39"` — because an earlier version returned the documented shapes instead and hid two defects that each produced a *plausible wrong number*. If you extend it, copy a real response.
:::

## 7. Known rough edges

Honest notes for anyone maintaining this.

| ^Edge | Detail |
|---|---|
| **Results are not size-capped** | A program is told to `return` only its final answer, and that instruction is the only thing keeping a large result out of your context. Nothing truncates it. Ask for aggregates, and see [Using it](03-using-it.md#what-makes-a-good-request) |
| **Write path is lightly tested** | `ZA_ALLOW_WRITES=true` exposes all 203 operations; only the read-only set is covered by tests. Exercise it against a non-production organization first |
| **Not on npm** | Installed from source while the licence is finalised, so there is no `npx` one-liner and no `--version` flag. The commit is the build identifier |
| The process does not exit cleanly | `isolated-vm` worker threads outlive `process.exit()`. Tests force exit; agents kill the child on quit, so it does not matter in normal use |
| No per-user rate limiting | `ZA_MAX_TOOL_CALLS` is per program, not per user per hour |
| Search is lexical | Synonym expansion plus field-weighted scoring, no embeddings. It handles API vocabulary well and paraphrase adequately |
| The knowledge bundle is a snapshot | Regenerated by `npm run build:knowledge`; it does not follow github.com/zoho/analytics-okf automatically. Its age is reported at startup and warned about past 90 days |
| A transitive dependency is flagged | `@utcp/sdk` pins `zod` 3.x, which carries GHSA-mrhx-c7xc-m3w5. No fix is available upstream; it is in UTCP's input-validation path, and `npm audit` will report it |
| UTCP is a thin dependency | All of it is fenced inside `src/catalog.mjs` precisely so it can be replaced without touching the rest |

## 8. Where things live

```text
za-codemode/
├── src/
│   ├── bin.mjs             entry point: no args -> server, args -> CLI
│   ├── server.mjs          the stdio MCP server
│   ├── tools.mjs           the four tools
│   ├── catalog.mjs         the operation catalog and sandbox — the only UTCP usage
│   ├── sandbox-prelude.mjs `find` (name resolver) and `rows` (result readers)
│   ├── search.mjs          query expansion and ranking
│   ├── knowledge.mjs       the OKF knowledge base: lookup, search, hints
│   ├── auth.mjs            refresh token -> access token
│   ├── credentials.mjs     resolution: env -> credential command -> keychain
│   ├── token-cache.mjs     access-token reuse across process restarts
│   ├── cli.mjs             login / status / logout / audit
│   ├── audit.mjs           two streams, rotation, redaction, hash chain
│   ├── config.mjs          environment parsing and validation
│   ├── quiet.mjs           stdout guard — must be imported first
│   └── remote/             the unreleased multi-user HTTP server
├── tools/
│   ├── build-manual.mjs     OpenAPI specs -> UTCP operation catalog
│   └── build-knowledge.mjs  OKF docs -> shipped knowledge bundle
├── manual/analytics.utcp.json     generated; do not hand-edit
├── knowledge/knowledge.json       generated; do not hand-edit
├── test/                 mocks and the 101 tests
└── guide/                this documentation — .md authored, .html generated
```

:::warn `src/quiet.mjs` must stay the first import of `server.mjs`
An MCP stdio server's stdout *is* the JSON-RPC channel, and the UTCP SDK logs progress with `console.log`. One stray line corrupts the stream, and the agent disconnects with no diagnosable error.
:::
