---
description: How Zoho Analytics Code Mode works — the five tools, the sandbox boundary, where your code actually runs, and how it relates to the existing Zoho Analytics MCP Server.
---

# What it is

An MCP server that gives your AI agent five tools: one to find *your data*, one to find *API operations*, one to read how they work, one to read data with the filtering done inside Analytics, and one to run code against all of it.

Under the MCP surface it is **UTCP code mode** — a UTCP manual of 203 operations generated from the published OpenAPI specifications, executed by `@utcp/code-mode` in a V8 isolate. [Chapter 08](08-engine.md) covers that in full; this chapter is about what it does.

## 1. The shape of it

```text
  Your AI agent                    This server                  Zoho Analytics
  (Claude Desktop,  ──MCP/stdio──▶  ┌──────────────────┐
   Cursor, VS Code)                 │  search_api      │
                                    │  find_objs       │
                                    │  get_guide       │
                                    │  query_data      │
                                    │  run_code        │
                                    │        │         │
                                    │        ▼         │
                                    │  ┌────────────┐  │
                                    │  │  SANDBOX   │  │
                                    │  │ (V8 isolate│  │
                                    │  │  no network│  │
                                    │  │  no files) │  │
                                    │  │            │  │
                                    │  │ za.export… ├──┼──▶ HTTPS ──▶ analyticsapi
                                    │  └────────────┘  │              .zoho.com
                                    └──────────────────┘
```

The model's code runs in a **V8 isolate**. It cannot open a socket, read a file or import a module. When it calls `za.exportDataView(...)`, that is not an HTTP request — it is a callback out of the isolate into the server process, which makes the real call with credentials the sandbox never sees.

## 2. The five tools

### `find_analytics_objects`

The first problem is not *which endpoint* — it is *which table*. A user says "my profit table" and the table is called `Sales_Profit_by_Country`. A model left to itself writes `viewName === 'profit'`, matches nothing, and reports that the table does not exist.

So names are resolved before code is written:

```text
> find_analytics_objects("profit")

{ "found": true, "confident": false,
  "best": { "viewName": "Profit Margin Trend", "viewType": "Chart",
            "score": 88, "matchedOn": "name starts with the query" },
  "alternatives": [ { "viewName": "Sales_Profit_by_Country", "viewType": "Table",
                      "score": 75, "matchedOn": "name contains the query" } ],
  "searchedWorkspaces": 4, "totalWorkspaces": 4,
  "ambiguous": "Several views match. Report these to the user and let them choose..." }
```

Three properties matter more than the matching itself:

- **It says why it matched,** so a weak hit is visible as one.
- **It refuses to guess.** Two candidates both containing your word means `confident: false` and both returned — because silently analysing the wrong table is worse than asking.
- **A miss reports the scope.** *"Nothing matched in 4 of 4 workspaces"*, with the workspace list — never a bare "your data does not exist".

It searches **workspaces, views, columns, variables, folders, groups, datasources and aggregate formulas** — everything except workspaces and views is scoped to one workspace, because that is where they live.

And when you name something, it resolves or it **stops**:

```text
> "use the variable sum"        -> sum_of_cost          (prefix match, resolved)
> "use the variable headcount"  -> STOPPED: no variable matching "headcount".
                                   Available: sum_of_cost, region_filter, fiscal_year_start.
> "use the variable sum"        -> STOPPED: ambiguous — sum_of_cost (88),
  (workspace has two)              sum_of_revenue (88). Ask the user which.
```

Substituting a different variable than the one you named produces a confident wrong number, so it is never done. The refusal is enforced by the server: a program that catches it and carries on anyway still fails.

### `search_analytics_api`

There are 203 operations. Describing all of them to a model would cost roughly 145,000 tokens, so the server never does. Instead the agent describes its task and gets back only what matches:

```text
> search_analytics_api("export rows from a view with a filter")

4 matching operations. Call them on the `za` object inside run_analytics_code.
`ORG_ID` is predefined there, so pass it as `'ZANALYTICS-ORGID': ORG_ID`.

// Export Data from a View
await za.exportDataView({
  "ZANALYTICS-ORGID": string;
  "workspace-id": string;
  "view-id": string;
  "CONFIG"?: string;   // Configuration that filters and formats the export...
});
...
```

Under a thousand characters instead of 145,000 tokens.

### `get_analytics_guide`

Signatures say *what* to call. They do not say that criteria strings use a particular SQL-like grammar, that `CONFIG` must be stringified, or that a bulk export is three calls and a poll. That knowledge comes from the Zoho Analytics documentation, and it ships with the server:

| ^Content | Count |
|---|---|
| Multi-step playbooks | 8 |
| Reference topics | 9 |
| Documented error codes | 385 |

```text
> get_analytics_guide("filter-criteria-syntax")   // a reference, by id
> get_analytics_guide("how do I export a large table")   // a question
> get_analytics_guide("8080")   // an error code
```

Two things happen without the agent asking. Search results for export-job operations end with a pointer to the asynchronous-export playbook, and any error code in a failed run is annotated with its documented meaning and resolution.

### `query_analytics_data`

Data questions do not need a program, and they should not need all the rows either. This tool takes the question in parts — a filter, the columns, a grouping, a limit — and has **Zoho Analytics** do the work:

```text
> query_analytics_data({ workspaceId: WS, viewId: VIEW,
                         groupBy: ["Region"],
                         metrics: [{ fn: "sum", column: "Sales", as: "Total" }] })

{ "rows": [ { "Region": "East", "Total": "598893.32" }, ... ],
  "rowCount": 3,
  "sql": "SELECT \"Region\", sum(\"Sales\") AS \"Total\" FROM \"Table\" GROUP BY \"Region\"",
  "pushedDown": "SQL run inside Analytics: ..." }
```

Measured against a 755-row table, the question *"what did the West sell?"* costs 128 KB of exported rows and 35 KB of model context when the rows are filtered in code, and **1.1 KB and 573 bytes** when the filter and the sum are pushed down. Export units are billed per 1000 rows produced, so that is a quota saving as well as a context one.

Quoting is handled, a filter naming a column the view does not have is refused with the real column names rather than dropped, and every answer says what the server actually did. [Chapter 11](11-data-engine.md) is the full reference.

### `run_analytics_code`

The agent writes plain JavaScript and the server runs it:

```javascript
const found = await find.views('Sales');
let total = 0;

for (const v of found.matches) {
  const out = await data.rows({
    workspaceId: v.workspaceId, viewId: v.viewId,
    filters: [{ column: 'Region', value: 'East' }],
    columns: ['Sales'],
  });
  total += rows.sum(out.rows, 'Sales').total;
}

return { total, viewsCovered: found.matches.length };
```

One tool call, and no whole-table export anywhere: `data.rows` filters and projects inside Analytics, so each call brings back the one column that matters for the rows that match. Those rows stay in the sandbox; only `{ total }` reaches the model.

## 4. What the sandbox provides

| ^Available | Not available |
|---|---|
| `za` — every exposed operation as an async method | `require`, `import` |
| `ORG_ID` — your organization ID as a constant | `fetch`, `XMLHttpRequest` |
| `find.*` — name resolution that refuses to guess | `process`, `Buffer` |
| `data.*` — filtering and aggregation pushed to the server | `setTimeout`, `setInterval` |
| `rows.*` — result readers that cope with formatted values | Filesystem, child processes, sockets |
| `console.log` — progress notes, returned alongside the result | |
| The JavaScript standard library | |

`za` is the only way out of the isolate. That is enforced by the isolate itself, not by a policy that could be prompted around.

## 5. Where everything runs

| ^Thing | Runs on | Sees your data | Sees your credentials |
|---|---|---|---|
| Your AI agent's model | its provider's servers | the results your code returns | no |
| This server | **your machine** | yes | yes |
| The sandbox | your machine, inside this server | yes | **no** |
| Zoho Analytics | Zoho's servers | yes | validates them |

Nothing is routed through Zoho's agent infrastructure. API calls go from your machine straight to your data centre's endpoint.

:::info The model does see results
Whatever your code `return`s goes back to the model, and therefore to your AI provider. Returning aggregates instead of raw rows is both cheaper and better for confidentiality.
:::

## 6. How this relates to the Zoho Analytics MCP Server

They are complementary, and many people will want both.

| ^ | [MCP Server](https://www.zoho.com/analytics/api/v2/zoho-analytics-mcp-server.html) | Code Execution (this tool) |
|---|---|---|
| Tools | 26 curated, task-shaped | 5 |
| Operations reachable | 26 | ++203, across 10 domains++ |
| Ships the documentation | no | ++8 playbooks, 385 error codes++ |
| Best at | single lookups — one cheap call | multi-step work: loops, polling, aggregation |
| Executes model-written code | no | ++yes, sandboxed++ |
| Also available hosted | yes, at `mcp.zoho.com` | not yet |

Install both and your agent picks per task: a named tool for *"list my workspaces"*, code for *"total East-region sales across every workspace since July"*. Install only this one and everything is reachable, just with a little more ceremony for simple questions.

## 7. What it does not do

- **It does not reduce API consumption by existing.** The same operations are called, so the same API units are billed — *unless* the request itself gets smaller. Export units are charged per 1000 rows produced, so pushing a filter or an aggregate into the request does cut the bill: measured, the same question went from 128 KB of exported rows to 1.1 KB. That is what [Reading data](11-data-engine.md) is for. Everything else saves model turns and context, not quota.
- **It does not supply an AI model.** Your agent brings that.
- **It does not write to your data by default.** See [Security](04-security.md).
