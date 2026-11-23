---
description: How Zoho Analytics Code Mode reads data — server-side criteria, SQL pushdown, the query_analytics_data tool and the data.* helpers, with measured before-and-after costs.
---

# Reading data

Asking for the West region's total sales used to cost 128 KB of exported rows and 35 KB of model context. It now costs 1.1 KB and 573 bytes. This chapter is how, and when it does not.

## 1. The failure this fixes

Give a model one export operation and a question, and it writes the obvious thing:

```javascript
const out = await za.exportDataView({
  'ZANALYTICS-ORGID': ORG_ID, 'workspace-id': WS, 'view-id': VIEW,
  CONFIG: JSON.stringify({ responseFormat: 'json' }),
});
const west = rows.of(out).filter((r) => r.Region === 'West');   // ← the problem
```

The answer is right. Everything about getting it is wrong:

- **The API exported every row.** Export units are billed per 1000 rows of output — 3 units per 1000 for CSV, JSON, XML and XLS. Filtering afterwards does not refund them.
- **The rows crossed into the sandbox, then into the model.** A 755-row table is 128 KB; a million-row table is around 170 MB and will not finish inside the execution timeout.
- **The filter is in the wrong language.** `r.Region === 'West'` is a JavaScript string comparison over values the API returns pre-formatted (`"$1,682.39"`), which is also how `Number()` silently becomes `NaN`.

Zoho Analytics has two places to put the filter instead, and both are server-side.

## 2. The two levers

+++tabs pushdown

+++tab criteria

`criteria` is a `WHERE`-clause expression in `CONFIG`, honoured by the synchronous view export and by both export jobs. Column names in double quotes, string literals in single quotes:

```json
{ "responseFormat": "json",
  "criteria": "\"Region\"='West' and \"Sales\">1000",
  "selectedColumns": ["Region", "Sales"] }
```

Measured live, this works on **every view type**. On a chart, pivot or summary view it filters the underlying rows *before* the view's own aggregation, so a summary view with one criteria answers in a single row.

What it cannot do: limit the row count, group, or compute an aggregate. The synchronous export has no limit attribute at all.

+++tab SQL

`sqlQuery` in the bulk export job takes a full `SELECT`, so `WHERE`, `GROUP BY`, `ORDER BY`, `LIMIT` and the aggregate functions all run inside Analytics:

```sql
SELECT "Region", sum("Sales") AS "Total"
FROM "Table" WHERE "Date" >= '01-Jan-2026'
GROUP BY "Region" ORDER BY "Total" DESC LIMIT 10
```

This is the path that turns a million rows into three. It costs two extra round trips — create the job, poll it, download — which pays for itself the moment it removes rows.

Only `SELECT` is accepted; anything else is refused with `7402` before a job exists.

+++

## 3. `query_analytics_data`

The fifth tool. It answers a data question without the agent writing any code, by taking the question in parts and deciding which lever to pull.

```text
> query_analytics_data({
    workspaceId: "35130000013380001",
    viewId:      "35130000013380003",
    groupBy:     ["Region"],
    metrics:     [{ fn: "sum", column: "Sales", as: "Total" }]
  })

{ "rows": [ { "Region": "East",    "Total": "598893.32" },
            { "Region": "West",    "Total": "392075.70" },
            { "Region": "Central", "Total": "308978.04" } ],
  "rowCount": 3,
  "sql": "SELECT \"Region\", sum(\"Sales\") AS \"Total\" FROM \"Table\" GROUP BY \"Region\"",
  "path": "sql",
  "pushedDown": "SQL run inside Analytics: SELECT \"Region\", sum(\"Sales\")…",
  "apiCalls": 4 }
```

| ^Field | What it does |
|---|---|
| `workspaceId` | Required. Resolve it with `find_analytics_objects`. |
| `viewId` | The view, table, report or dashboard to read. |
| `table` | Table name, for the SQL path, when you already know it — saves the id-to-name lookup. |
| `filters` | `[{ column, op, value }]`. Row selection, applied by the server. |
| `columns` | Only these columns are exported. |
| `groupBy` + `metrics` | Aggregate inside Analytics. `[{ fn: "sum", column: "Sales" }]`. |
| `orderBy`, `limit`, `offset` | Pushed into the SQL. |
| `mode` | `auto` (default), `view`, `sql`, `count`, `preview`. |
| `sql` | A `SELECT` you wrote yourself, when the structured fields cannot express it. |
| `format` | `json` or `csv`. |

### Operators

`eq` (default), `ne`, `gt`, `gte`, `lt`, `lte`, `in`, `notIn`, `like`, `contains`, `startsWith`, `endsWith`, `between`, `isNull`, `notNull`.

:::good Quoting is not your problem
Values go in as values. `O'Brien` becomes `'O''Brien'`, a column called `Order Date` becomes `"Order Date"`, and a number stays unquoted so `>` compares numbers rather than text. Every criteria bug seen in generated code was a quoting bug, so there is exactly one implementation of it and nothing else is allowed to build the expression.
:::

### `pushedDown`

Every answer says what the server did. Without it the model cannot tell a small answer from a small table, so it never learns to push the next filter down either. It also admits when something **was not** pushed down — a `limit` on the view path, for instance, which the synchronous export cannot apply.

## 4. `data.*` inside `run_analytics_code`

The same engine, for the questions the tool cannot express. It is predefined in the sandbox beside `find` and `rows`.

| ^Call | What it does |
|---|---|
| `data.rows({ workspaceId, viewId, filters, columns, limit })` | View export with `criteria` and `selectedColumns`. One API call. |
| `data.query({ workspaceId, table, columns, metrics, groupBy, filters, orderBy, limit })` | The SQL export job: create, poll, download. |
| `data.count({ workspaceId, table, filters })` | `SELECT count(*)` — how many match, fetching none. |
| `data.aggregate({ workspaceId, table, by, measure })` | `data.query` with the aggregate spelled out. |
| `data.preview({ workspaceId, viewId, limit })` | A bounded look at the shape, with the limit pushed down where possible. |
| `data.export({ workspaceId, viewId, filters, columns })` | Asynchronous view export, for what the synchronous one refuses. |
| `data.awaitJob(workspaceId, jobId)` | Poll a job to completion and download it. |
| `data.columns(workspaceId, viewId)` | The view's columns, cached. |
| `data.view(workspaceId, viewId)` | Name, type and owning workspace. |
| `data.tableFor(workspaceId, viewId)` | The table name SQL needs. |
| `data.criteria(filters)` / `data.sql(spec)` | The builders on their own. |

```javascript
// "Which three regions sold most, and how many rows is that over?"
const table  = await data.tableFor(WS, VIEW);
const total  = await data.count({ workspaceId: WS, table });
const top    = await data.query({
  workspaceId: WS, table,
  groupBy: ['Region'],
  metrics: [{ fn: 'sum', column: 'Sales', as: 'Total' }],
  orderBy: [{ column: 'Total', dir: 'desc' }], limit: 3,
});
return { totalRows: total.rowCount, byRegion: top.rows };
```

199 bytes back to the model, 1.7 KB out of the API, for a question over 755 rows.

## 5. Which path, and why

`mode: "auto"` picks from the shape of the request:

| ^The request has | Path | Calls |
|---|---|---|
| filters and/or columns only | view export | 1 (+1 to check the columns) |
| `groupBy`, `metrics`, `orderBy`, `distinct`, or `sql` | SQL export job | 3 |
| `limit` with a `table` | SQL export job | 3 |
| `mode: "count"` | SQL export job | 3 |

Then the program checks one thing the router cannot know before it calls: **whether SQL can name this view at all.**

| ^View type | Nameable in a `SELECT` | How it is read |
|---|---|---|
| Table | yes | either path |
| Query Table | yes | either path |
| Chart, Pivot, Summary, Tabular | **no** — `7409` | view export with `criteria`; the view does its own aggregation |
| Dashboard | **no** | asynchronous view export |

A chart asked for a `groupBy` is therefore routed to the view export, with `sqlNotPossible` saying why — rather than returning `7409`, "the table does not exist in this workspace", which reads as a missing object instead of the wrong route.

## 6. What it refuses

:::warn A filter is never quietly dropped
A `criteria` naming a column the view does not have fails with `7330` after a wasted round trip, and the error names the column but not the alternatives. So the columns are checked first, and a mismatch **stops**:

```text
STOPPED: the filter names "Revenue", which is not a column of this view.
Columns: Date, Region, Product Category, Product, Customer Name, Sales, Cost.
Fix the filter — do not drop it and filter in code.
```

The same reasoning as the name resolver in [chapter 01](01-what-it-is.md): answering about the wrong column is worse than not answering.
:::

Three more refusals, for the same reason:

- **Not a `SELECT`.** Refused by the tool before it is sent, and by the server with `7402` if it ever got there. This tool reads.
- **A view from another workspace.** Reading view X under workspace Y is how one tenant gets answered with another tenant's numbers, so the pair is verified and mismatches stop.
- **An unknown operator.** Named, with the list of real ones — not treated as `eq`.

## 7. Result caps

Pushdown is what makes answers small. The cap is the backstop for when it was not used.

| ^Variable | Default | What it bounds |
|---|---|---|
| `ZA_MAX_RESULT_ROWS` | 500 | Rows in a tool result |
| `ZA_MAX_RESULT_BYTES` | 120000 | Serialized size of a tool result |
| `ZA_JOB_POLL_INTERVAL_MS` | 1000 | Gap between two status reads of the same job |

A truncated result is **loud**: it carries `truncated: true`, `rowsOmitted`, and a sentence saying what to ask for instead. A silently shortened list is a wrong answer, because the model would reason over 200 of 50,000 rows believing it had them all.

A result above 100 rows is additionally flagged in `pushedDown` — the export was narrowed, the context was not, and if the question was a total then `groupBy` + `metrics` answers it in three rows.

## 8. Measured

Against a live organization: one 755-row, seven-column sales table, same question each time (*"what did the West sell?"*), both costs recorded — bytes the API produced, and bytes that reached the model.

| ^Strategy | From the API | To the model |
|---|---|---|
| Export the table, filter in code | 128116 | 35141 |
| `criteria` pushed to the server | 38199 | 35485 |
| `criteria` + `columns` | 6764 | 4002 |
| `groupBy` + `sum` inside Analytics | ++1183++ | ++573++ |
| `mode: "count"` | 1067 | 368 |
| Top 5 by sales | 1288 | 663 |
| `mode: "preview"`, 5 rows | 1914 | 1340 |

Two readings worth having:

**Criteria alone barely helps the model.** It cut the export by 70% and the context by nothing, because 207 matching rows is still 35 KB. Filtering is not the same as answering — if the question is a total, ask for the total.

**Preview was the worst offender before this.** Five rows of a 755-row table through the view export moved all 128 KB and threw 750 rows away. It now pushes a `LIMIT` down wherever SQL can name the view: 1.9 KB.

## 9. Three things the API does that the documentation does not say

All three were established by probing a live instance, and all three change what the code has to do.

:::danger `tableCriteriaList` is silently ignored
The SQL export job documents a `tableCriteriaList`, one filter per table the statement touches, and `7836` for a filter naming a table the statement does not reference. Measured: sending exactly that returns **HTTP 200 and unfiltered rows**.

So row selection for the SQL path goes in the `WHERE` clause, which does work. `tableCriteriaList` is passed through only if a caller insists, and the caveat travels with the result.
:::

**The sandbox has no timers.** `setTimeout` is not defined in the isolate, so a polling loop cannot sleep — reaching for one is a `ReferenceError` deep inside an export, which reads as "the export broke". It does not need to: the tool bridge blocks the isolate until the host-side call settles, so the pacing is done in the server process, spacing consecutive status reads of one job by `ZA_JOB_POLL_INTERVAL_MS`.

**The download has no envelope.** Job progress is `jobCode`, a *string* (`"1002"` running, `"1004"` done), beside a human `jobStatus`; the downloaded file is `{"data": [...]}` with no `status` wrapper. Aggregate values come back as raw numeric strings (`"392075.70000000024"`) while raw column values stay formatted (`"$1,682.39"`) — `rows.num` handles both, and nothing else should.

## 10. When to still write code

The engine covers reads. Use `run_analytics_code` for:

- **Several questions in one turn** — the engine is one request per call, a program is one call for all of them.
- **Work across many workspaces** — a sweep, with `find.views` to locate the data first.
- **Anything that is not a read** — imports, schedules, sharing, metadata changes.
- **Post-processing the engine cannot express** — pivoting, joining results from two workspaces, formatting for a report. Fetch the aggregates with `data.*`, then combine them in the sandbox.
