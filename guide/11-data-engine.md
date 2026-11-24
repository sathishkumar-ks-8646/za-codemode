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
  "apiCalls": 3 }
```

212 bytes. The envelope carries the answer, the statement that produced it, and
nothing else: no job id, no poll count, no millisecond timing, and no sentence
restating the SQL that is already printed. Those exist — they go to the audit
stream, which is where something written for an operator belongs.

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

### `sql`, `criteria` and `pushedDown`

What the server applied is shown **once, as the thing itself**: `sql` on the
SQL path, `criteria` on the view path. Both are printed verbatim so a model can
read back exactly what ran rather than trust a description of it.

`pushedDown` is then reserved for what those fields *cannot* show — a window
applied after the download rather than by the server, a result still wide
enough that it should have been an aggregate, a caveat about something the
server ignored. When there is nothing of that kind to say, the field is absent
rather than present and empty.

This matters more than it sounds. Without it a model cannot tell a small answer
from a small table, so it never learns to push the next filter down. With the
statement repeated three times — as `sql`, inside `pushdown.sql`, and again
spelled out in prose — it was simply tax: the same question cost 563 bytes
before this change and 212 after.

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
| `data.meta(workspaceId, viewId)` | Name, type, owning workspace, **row count** and columns — one cached call. |
| `data.columns(workspaceId, viewId)` | Just the columns, from that same call. Each carries `isFormula`, `dataTypeName` and `dateFormat`. |
| `data.view(workspaceId, viewId)` | An alias for `data.meta`. |
| `data.tableFor(workspaceId, viewId)` | The table name SQL needs; asks for the cheap shape, without columns. |
| `data.formulas(workspaceId, viewId)` | The view's formula columns and aggregate formulas. **Only call this when a name has already missed** — most tables have none, and discovering that costs two requests. |
| `data.metricValue(workspaceId, formulaId)` | The live value of an aggregate formula the workspace already defines: one call, one number. A ratio like `sum(Profit)/sum(Sales)` is not expressible through `groupBy` + `metrics` at all, and re-deriving it with SQL is three calls to recompute something Analytics will hand over for one. |
| `data.criteria(filters)` / `data.sql(spec)` | The builders on their own. Use `data.criteria` for `updateRows` and `deleteRows` too — they take the same expression, and it is the same quoting. |

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

`mode: "auto"` decides in two stages, because the decision needs something no
router can know before it calls: how big the thing is.

**From the shape of the request**, before any call:

| ^The request has | Path |
|---|---|
| `groupBy`, `metrics`, `orderBy`, `distinct`, `limit`, `offset` or `sql` | SQL export job |
| `mode: "count"` | SQL export job |
| filters and/or columns only | view export, pending stage two |

**Then from the view itself.** One `getViewDetails` call returns the name, the
type, the column list **and the row count** together, so stage two is free:

| ^What the metadata says | What happens |
|---|---|
| Table over 1000 rows | routed to SQL with a bounding `LIMIT`, and `routedToSql` says why |
| Table under 1000 rows | one view export — see below |
| Chart, Pivot, Summary, Tabular | view export with `criteria`; the view does its own aggregation, and `sqlNotPossible` says the grouping could not be pushed down |
| Dashboard | **refused.** It has no rows to read |

:::good Why a small table is not worth three calls
Export units are billed **per 1000 rows produced** — 3 units per 1000 for JSON.
A 755-row export and a 5-row export therefore cost the same single block, so
spending two extra round trips to shrink an export that is already one block
buys nothing. It also costs three slots of the BULK rate limit, which is 40
requests a minute across the whole organization, instead of one.

Above a thousand rows that reverses completely, which is why the threshold
exists rather than a preference. Previewing five rows of a million-row table
through the view export moves every row and bills 3000 units for five.
:::

A `limit` is now pushed down wherever SQL can name the view. It previously was
not when a `viewId` was given, which excluded the common case and left the
cheapest possible question — "show me ten rows" — exporting the whole table.

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

Four more refusals, for the same reason:

- **Not a `SELECT`.** Refused by the tool before it is sent, and by the server with `7402` if it ever got there. This tool reads.
- **A view from another workspace.** Reading view X under workspace Y is how one tenant gets answered with another tenant's numbers, so the pair is verified and mismatches stop.
- **An unknown operator.** Named, with the list of real ones — not treated as `eq`.
- **A dashboard.** Measured live, it answers `8119` to *both* export paths. Retrying the other one is wasted; the refusal names what to read instead.

Only when a name has already missed is it worth asking whether it is a formula — one extra call, on the path that was going to fail anyway. If it turns out to be an aggregate formula the refusal says so and points at `data.metricValue`, because a formula is not something a `WHERE` clause can name.

## 7. Result caps

Pushdown is what makes answers small. The cap is the backstop for when it was not used.

| ^Variable | Default | What it bounds |
|---|---|---|
| `ZA_MAX_RESULT_ROWS` | 500 | Rows in a tool result |
| `ZA_MAX_RESULT_BYTES` | 120000 | Serialized size of a tool result |
| `ZA_METADATA_CACHE_MS` | 60000 | How long a view's shape may be reused between programs |
| `ZA_JOB_FIRST_POLL_MS` | 700 | Wait before the first status read of a job |
| `ZA_JOB_POLL_INTERVAL_MS` | 1000 | Base gap between status reads; grows as the job proves slow |
| `ZA_JOB_POLL_MAX_MS` | 5000 | Ceiling on that gap |

A truncated result is **loud**: it carries `truncated: true`, `rowsOmitted`, and a sentence saying what to ask for instead. A silently shortened list is a wrong answer, because the model would reason over 200 of 50,000 rows believing it had them all. `format: "csv"` is trimmed too, on a line boundary and keeping the header — it used to pass both caps untouched while the tool description recommended it as "denser for many rows", which is exactly what made it dangerous.

A result above 100 rows is additionally flagged in `pushedDown` — the export was narrowed, the context was not, and if the question was a total then `groupBy` + `metrics` answers it in three rows.

### Two calls this engine no longer makes

**The metadata call, twice.** The resolver and the engine each kept their own cache and each asked `getViewDetails` with a different `CONFIG`, so every query that resolved a name *and* checked a column paid for the view's metadata twice. One call now fills both, and `withInvolvedMetaInfo` makes it answer the name, the type, the row count and the full column list — including `formulaDisplayName`, which is how a formula column announces itself for free.

**The metadata call, every time.** A session asks several questions about one table and the shape does not move between them, so it is remembered for `ZA_METADATA_CACHE_MS`. Any write through this server clears the cache outright, which is cheaper than reasoning about which view a given write touched and wrong far less often.

## 8. Measured

Against a live organization: one 755-row, seven-column sales table, the same
questions before and after this chapter's changes. Three costs, because they do
not move together — bytes the API produced, **API calls**, and bytes that
reached the model.

| ^Strategy | API calls | From the API | To the model |
|---|---|---|---|
| Export the table, filter in code | 1 | 128116 | 35141 |
| `criteria` pushed to the server | 2 | 38199 | 35294 |
| `criteria` + `columns` | 1 | 3658 | 3823 |
| `groupBy` + `sum` inside Analytics | 3 | ++529++ | ++274++ |
| `mode: "count"` | 3 | 413 | 125 |
| Top 5 by sales | 3 | 634 | 374 |
| `mode: "preview"`, 5 rows | 1 | 128116 | 954 |
| A program doing three of these at once | 6 | 942 | 199 |

Across the whole run: **38 API calls before, 24 after**, and every answer at
least a third smaller.

Three readings worth having:

**Criteria alone barely helps the model.** It cut the export by 70% and the
context by nothing, because 207 matching rows is still 35 KB. Filtering is not
the same as answering — if the question is a total, ask for the total.

**Calls and bytes are not the same resource, and calls are the billed one.**
The preview row is the honest example: it moves the whole 755-row table to show
five, which looks indefensible until you notice both routes bill one block of
1000 rows and the single call is faster. Above a thousand rows the same
reasoning sends it the other way.

**Polling was a third of the cost of every SQL read.** A fixed one-second gap
with an immediate first poll spent two calls per job learning nothing, because
the first poll is never ready. Waiting before the first read and backing off
after it turned four calls per SQL read into three.

## 9. Things the API does that the documentation does not say

All of these were established by probing a live instance, and all of them change what the code has to do.

:::danger `tableCriteriaList` is silently ignored
The SQL export job documents a `tableCriteriaList`, one filter per table the statement touches, and `7836` for a filter naming a table the statement does not reference. Measured: sending exactly that returns **HTTP 200 and unfiltered rows**.

So row selection for the SQL path goes in the `WHERE` clause, which does work. `tableCriteriaList` is passed through only if a caller insists, and the caveat travels with the result.
:::

**A dashboard cannot be exported as data at all.** Both the synchronous export and the export job answer `8119`, *"Invalid value 'json'"* — a message about the format, for a view that has no rows in any format. The fallback from one path to the other was therefore dead code for the one view type it was most likely to meet. Some tables also refuse the synchronous export with `8133` and the words *"Kindly switch to async export model"*, which is a real instruction and is now followed.

**The sandbox has no timers.** `setTimeout` is not defined in the isolate, so a polling loop cannot sleep — reaching for one is a `ReferenceError` deep inside an export, which reads as "the export broke". It does not need to: the tool bridge blocks the isolate until the host-side call settles, so the pacing is done in the server process.

**The download has no envelope.** Job progress is `jobCode`, a *string* (`"1002"` running, `"1004"` done), beside a human `jobStatus`; the downloaded file is `{"data": [...]}` with no `status` wrapper. Aggregate values come back as raw numeric strings (`"392075.70000000024"`) while raw column values stay formatted (`"$1,682.39"`) — `rows.num` handles both, and nothing else should.

## 10. When to still write code

The engine covers reads. Use `run_analytics_code` for:

- **Several questions in one turn** — the engine is one request per call, a program is one call for all of them.
- **Work across many workspaces** — a sweep, with `find.views` to locate the data first.
- **Anything that is not a read** — imports, schedules, sharing, metadata changes.
- **Post-processing the engine cannot express** — pivoting, joining results from two workspaces, formatting for a report. Fetch the aggregates with `data.*`, then combine them in the sandbox.
