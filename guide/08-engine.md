---
description: What Zoho Analytics Code Mode is built on — the UTCP code-mode engine, the generated operation catalog, the V8 isolate, and the OKF knowledge base.
---

# How the engine works

This chapter is for the curious and for anyone reviewing the tool. Nothing here is needed to use it.

## 1. The three layers

```text
  ┌─ MCP ──────────────────────────────────────────────┐
  │  what your agent speaks. Four tools.               │
  │  @modelcontextprotocol/sdk                         │
  └────────────────────┬───────────────────────────────┘
                       │
  ┌─ UTCP code mode ───▼───────────────────────────────┐
  │  what runs the model's program and calls the API.  │
  │  @utcp/code-mode  +  @utcp/http  +  isolated-vm    │
  └────────────────────┬───────────────────────────────┘
                       │
  ┌─ Zoho Analytics ───▼───────────────────────────────┐
  │  the REST API v2, unchanged.                       │
  └────────────────────────────────────────────────────┘
```

**MCP is the doorway. UTCP code mode is the engine.** Your agent only ever sees the MCP layer; UTCP is an implementation detail that no user configures and no client needs to understand.

## 2. What UTCP is

[UTCP](https://www.utcp.io) — the Universal Tool Calling Protocol — is a JSON format for describing callable operations, plus client libraries that call them. A UTCP *manual* lists tools; each carries a name, a description, a JSON-Schema input and a **call template** saying how to make the HTTP request.

`manual/analytics.utcp.json` is exactly that: **203 operations**, generated from the OpenAPI specifications published for the v2 API.

```json
{
  "name": "exportDataView",
  "description": "Export Data from a View — Exports the data of a view...",
  "inputs": { "type": "object", "properties": { "...": {} } },
  "tool_call_template": {
    "call_template_type": "http",
    "http_method": "GET",
    "url": "${ZA_BASE_URL}/restapi/v2/workspaces/{workspace-id}/views/{view-id}/data",
    "header_fields": ["ZANALYTICS-ORGID"],
    "auth": { "auth_type": "api_key", "api_key": "Bearer ${ZA_ACCESS_TOKEN}",
              "var_name": "Authorization", "location": "header" }
  }
}
```

:::info This manual is internal and is never published
UTCP has no token-refresh mechanism, which is why handing a manual to end users does not work — they would re-paste an access token every hour. Because ours stays inside the server, the server holds the credentials, mints tokens, and re-registers the manual when one rotates. Neither you nor the sandbox ever sees a token.
:::

## 3. What code mode is

**Code mode** is the pattern of letting a model write *one program* that calls many tools, instead of calling them one at a time. It is becoming standard: Anthropic ships it as programmatic tool calling, AWS as `run_script`, Snowflake as its Cortex code execution tool.

`@utcp/code-mode` is the implementation here. It takes the registered UTCP manual, generates a type-annotated signature per operation, and binds each one as a method on a `za` global inside an [`isolated-vm`](https://github.com/laverdet/isolated-vm) V8 isolate.

When the model's code calls `za.exportDataView(...)`, that is **not** an HTTP request. It is a callback out of the isolate into the server process, which reads that operation's call template, substitutes the variables, and makes the real call. The isolate has no network of its own — see [Security](04-security.md#what-the-sandbox-cannot-do).

:::warn The program is plain JavaScript, not TypeScript
The signatures are type-annotated so a model can see each argument's shape, but there is **no compiler anywhere in the chain** — the code string goes straight into V8. A type annotation, an `interface` or an `as` cast is a syntax error, and V8's message never mentions types. The server detects that case and says so rather than passing the raw error back. Modern JavaScript is fine: `async`/`await`, optional chaining, destructuring, spread.
:::

## 4. Where the accuracy comes from

Signatures tell a model *what it can call*. They do not tell it that criteria strings follow a particular SQL-like grammar, that `CONFIG` must be stringified and URL-encoded, or that a bulk export is three calls and a poll. Those are the things generated code gets wrong.

So the **OKF knowledge base** ships with the server and is exposed as `get_analytics_guide`. Its source of truth is the published bundle at **[github.com/zoho/analytics-okf](https://github.com/zoho/analytics-okf)** — `npm run build:knowledge` reads that repository's root `manifest.json` to resolve the current version, then its `llms.txt` link index, exactly as that repository instructs. It is not built from any local checkout:

| ^Content | Count | What it is for |
|---|---|---|
| Playbooks | 8 | Multi-step recipes: asynchronous export, large import, resolving identifiers, sharing with row filters, scheduling email, managing users, AutoML, multi-tenant embedding |
| References | 9 | Criteria grammar, request conventions, job polling, identifiers, response envelope, export and import enums, HTTP statuses, rate limits |
| Error codes | 385 | Every documented code, with its meaning, resolution and whether it is retryable |

Two things happen automatically:

- **Search points at the playbook.** Ask for export-job operations and the result ends with *"Before writing code, consider reading: `get_analytics_guide("export-data-asynchronously")`"*.
- **Failures are annotated.** Any four-digit code in an error message gets its documented meaning and resolution attached, so the model can correct itself rather than guess.

## 5. The ten API domains

The catalog is tagged by the domain each operation comes from, mirroring `v2.0/oas/<domain>-grouped-api.json`:

| ^Domain | Operations | Covers |
|---|---|---|
| `workspace-management` | 35 | Workspaces, backups, linking, templates, variables |
| `data-modeling-schema` | 33 | Tables, columns, formulas, query tables, lookups |
| `user-groups` | 26 | Users, groups, roles, portals |
| `views-management` | 26 | Views, folders, tags, trash, copy and move |
| `data-operations` | 20 | Rows, imports, exports, bulk jobs, data sync |
| `share-publish` | 20 | Sharing, permissions, embed URLs, public links, slideshows |
| `schedules-alerts` | 16 | Email schedules and data alerts |
| `dsml` | 11 | AutoML analyses, training, predictions |
| `org-management` | 10 | Organizations, subscriptions, security controls |
| `reports-dashboards` | 6 | Charts, pivots, summaries, dashboards |

`ZA_DOMAINS` restricts a deployment to any subset, and `search_analytics_api` takes an optional `domain` argument. See [Choosing what to expose](02-install.md#choosing-what-to-expose).

## 6. Dependencies, and why they are contained

| ^Package | Role |
|---|---|
| `@modelcontextprotocol/sdk` | the MCP server, OAuth 2.1, HTTP transport |
| `@utcp/code-mode` | the sandbox and the tool bridge |
| `@utcp/http` | makes the real API calls from the call templates |
| `@utcp/text` | hands the manual over inline, so nothing is fetched |
| `isolated-vm` | the V8 isolate itself |
| `express` | the HTTP layer, used only by the unreleased multi-user server |

Every `@utcp/*` import lives in a single file, `src/catalog.mjs`. That is deliberate: UTCP is a young project with a small user base, and confining it to one module means it can be replaced without touching anything else. The server uses exactly three of its functions.

:::info Search deliberately does not use UTCP
UTCP's own tool search is plain word matching, and it failed on the way people actually phrase things — *"how much revenue did we make"* returned unrelated operations. `search_analytics_api` uses its own index with synonym expansion and field weighting, folding UTCP's results in only as a ranking bonus. UTCP owns the calling, not the finding.
:::

## 7. What running it against a real organization changed

Four things only a live API could reveal, each now covered by a test:

| ^Found | Why it mattered |
|---|---|
| `expires_in` is **milliseconds** (`3600000`) alongside `expires_in_sec` (`3600`) | Taking it at face value made a one-hour token look valid for 41 days, so it was never refreshed and every call failed with 8535 an hour in |
| An 81-workspace name sweep trips **error 6045** | The limit is a *rate over a window*, not a gap between calls — measured: 53/min ran clean, 105/min tripped after 27 calls, 188/min after 5. A fixed delay was the wrong shape; calls now go through a sliding window capped at 55/min, with 6 s / 15 s / 30 s backoff |
| A rate-limited sweep cannot finish in time | Covering 25 of 81 workspaces and reporting "no such view" is a false negative. An unfinished search now says so instead of claiming absence |
| Export returns rows as a **flat array** in `data` | `data.rows` is `undefined`, which `?? []` turns into a confident "no data" for a table with 755 rows |
| Values are **formatted strings** (`"$1,682.39"`) | `Number()` gives `NaN`, so sums silently come out as 0 |

The last two are the dangerous pair: neither raises an error, both produce a plausible wrong answer. They survived every mock-based test because the mock returned the shape the documentation *claimed*, not the shape the API *sends* — so `test/mock-analytics.mjs` was corrected to match the real responses, which is what makes those tests meaningful.

## 8. Where the catalog comes from

```bash
npm run build:manual      # v2.0/oas/*.json -> manual/analytics.utcp.json
npm run build:knowledge   # github.com/zoho/analytics-okf -> knowledge/knowledge.json
npm run build             # both

node tools/build-knowledge.mjs --local  ../v2.0/okf   # offline, from a checkout
node tools/build-knowledge.mjs --verify ../v2.0/okf   # does a checkout match published?
```

The bundle records where it came from, and the server reports it at startup:

```text
[za] knowledge — 17 guides, 385 error codes (OKF 2.0.0 v2.0, generated 2026-10-27, 14d old)
```

Past 90 days it warns. Documentation that is quietly out of date is worse than documentation that admits it, because every answer it gives still looks authoritative.

Neither output is hand-edited. The manual build applies five corrections that a stock OpenAPI conversion gets wrong for Zoho — see [Operating](06-operating.md#building-the-catalog-from-source) — two of which were found only by testing against an API mock that enforces organization scoping.
