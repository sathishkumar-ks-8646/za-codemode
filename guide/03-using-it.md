---
description: How to get good results from Zoho Analytics Code Mode — worked examples, what makes a good prompt, and how the four tools work together.
---

# Using it

You do not call the tools yourself. You ask your agent a question, and it decides to use them. This chapter is about asking well.

## 1. The normal flow

Every task follows the same shape, and your agent does it on its own:

1. **`find_analytics_objects`** — whenever you name a table, view or workspace, it resolves that name to a real ID first.
2. **`search_analytics_api`** — it describes the operation it needs and gets back signatures.
3. **`get_analytics_guide`** — *optional*, when it needs to know how something behaves.
4. **`run_analytics_code`** — it writes a program and gets back the result.

## 2. Finding your data

This is the step people expect to be the fragile one, so it is worth seeing.

**You name something that does not quite exist.** You say *"analyse my profit table"*; the table is called `Sales_Profit_by_Country`. The name is resolved by fuzzy match, and because `Profit Margin Trend` also matches, both come back and your agent asks which you meant rather than picking one.

**You name nothing at all.** You say *"do sales analysis on my data"*. Your agent lists your workspaces, ranks views matching "sales", and analyses what it finds — reporting which workspaces it looked in:

```json
{ "analysed": [
    { "workspace": "Sales Data", "view": "Sales Q3", "rows": 5, "column": "Sales", "total": 50900 },
    { "workspace": "Marketing",  "view": "Sales Funnel", "rows": 3, "column": "Sales", "total": 11100 } ],
  "searched": "4/4" }
```

**You name something exactly.** You say *"use the variable sum"* and the variable is `sum_of_cost`. It resolves — a prefix match is good enough.

**Nothing matches, so it stops.** This is the important one. If you name a variable, column, table or folder and nothing matches it, the operation **halts**. It does not fall back to whatever else is in the workspace:

```text
STOPPED: no variable matching "headcount". Do not substitute another variable.
Available variables: sum_of_cost, region_filter, fiscal_year_start.
Report this to the user and ask which they meant.
```

**Two things match, so it also stops.** If the workspace has both `sum_of_cost` and `sum_of_revenue`, *"the sum variable"* is ambiguous and you are asked which — rather than one being chosen for you.

:::danger Substitution is the failure this prevents
Analysing `sum_of_revenue` when you asked for `sum_of_cost` produces a confident, plausible, wrong number — the hardest kind of error to notice. So a name that cannot be resolved stops the run, and that is enforced by the server, not left to the model's judgement: a program that catches the refusal and carries on anyway still fails.
:::

:::good Ask for the names back
For anything that matters, say "tell me which views you used". The resolver always knows, and a wrong table is the one error a sandbox cannot protect you from.
:::

:::info Searching every workspace costs a call each
View search looks in the workspaces whose names best match first, up to fifteen by default, and tells you how many of your total it covered. Because calls are rate limited, a full sweep of a large organization takes real time — about 90 seconds for 81 workspaces.

If a sweep runs out of time it says so rather than reporting that your data does not exist:

```text
STOPPED: could not finish searching for "widget forecast". Covered 25 of 81
workspaces before the time budget ran out, so absence cannot be confirmed.
Ask the user which workspace it is in, then search that one directly.
```

Naming the workspace — *"the profit table in ZIA Agent"* — makes it exact, fast and cheap.
:::

If your agent skips step 1 and writes code from memory, the call will usually fail with *"not a function"*, and the error tells it to search first. That self-correction normally works; if it loops, say **"search the API first"** explicitly.

## 3. Reading results without getting a wrong number

Two things about Analytics responses will silently produce a wrong answer if a program gets them wrong. Both were found running against a real organization, and the sandbox provides `rows` to handle both.

**Export returns a flat array.** The rows are in `data` directly, *not* `data.rows`:

```javascript
const list = rows.of(out);        // right — handles every response shape
const list = out.data.rows ?? []; // wrong — undefined, so "no data"
```

**Values come back formatted.** `"$1,682.39"`, `"45%"`, `"14 February, 2022"` — all strings. `Number("$1,682.39")` is `NaN`:

```javascript
rows.num('$1,682.39')                       // 1682.39
rows.sum(list, 'Sales')                     // { total, counted, skipped }
rows.groupSum(list, 'Region', 'Sales')      // { West: {...}, East: {...} }
```

`sum` and `groupSum` skip blanks and tell you how many they skipped, so an empty column is visible rather than silently counted as zero.

:::danger This is the failure mode to care about
On a real table of 755 rows, the correct code returns **$1,299,947 across three regions**. The same program written the obvious way returns **`{ rowCount: 0, naiveSum: 0 }`** — not an error, just a confident report that you have no sales data. Nothing in the API signatures warns you.
:::

## 4. Worked example — a total across workspaces

> **You:** What were our East-region sales from July onwards, across every workspace?

The agent searches, then writes something like:

```javascript
const CRITERIA = `"Sales"."Region"='East' and "Sales"."Date">='2026-07-01'`;
const ws = await za.getOrgWorkspaces({ 'ZANALYTICS-ORGID': ORG_ID });
const totals = {};

for (const w of ws.data.workspaces) {
  const views = await za.getViews({
    'ZANALYTICS-ORGID': ORG_ID, 'workspace-id': w.workspaceId, CONFIG: '{}',
  });
  for (const v of views.data.views.filter((v) => v.viewName.includes('Sales'))) {
    const out = await za.exportDataView({
      'ZANALYTICS-ORGID': ORG_ID, 'workspace-id': w.workspaceId, 'view-id': v.viewId,
      CONFIG: JSON.stringify({ responseFormat: 'json', criteria: CRITERIA }),
    });
    const list = rows.of(out);          // flat array, not out.data.rows
    if (list.length) {
      totals[w.workspaceName] =
        (totals[w.workspaceName] ?? 0) + rows.sum(list, 'Sales').total;
    }
  }
}

return { totals, grandTotal: Object.values(totals).reduce((a, b) => a + b, 0) };
```

One tool call. The response is a handful of numbers; no row ever reaches the model.

## 5. Worked example — an export that has to be polled

Large exports are asynchronous: start a job, poll until it finishes, then download. That is three operations and an unknown number of polls — painful one call per turn, trivial in a loop.

```javascript
const job = await za.createExportJobViewId({
  'ZANALYTICS-ORGID': ORG_ID, 'workspace-id': wsId, 'view-id': viewId,
  CONFIG: JSON.stringify({ responseFormat: 'json' }),
});

let status;
do {
  status = await za.getExportJobDetails({
    'ZANALYTICS-ORGID': ORG_ID, 'workspace-id': wsId, 'job-id': job.data.jobId,
  });
} while (status.data.jobStatus !== 'JOB COMPLETED');

const out = await za.downloadExportedData({
  'ZANALYTICS-ORGID': ORG_ID, 'workspace-id': wsId, 'job-id': job.data.jobId,
});

return { rowCount: rows.of(out).length };
```

## 6. What makes a good request

| ^Ask like this | Rather than |
|---|---|
| "Total sales by region for Q3, across all workspaces" | "Show me the sales table" |
| "How many views has each workspace got?" | "List everything" |
| "Export East-region rows since July and give me the sum" | "Export the Sales view" and then adding it up yourself |

The pattern: **ask for the answer, not the data.** This tool is at its best when the model can filter and aggregate in the sandbox. Asking it to dump rows works, but forfeits most of the benefit and fills your context.

:::good Say the filter out loud
Criteria are applied server-side by Analytics. "Since July" and "East region only" become part of the `CONFIG`, so fewer rows move at every stage.
:::

## 7. When to send it to the documentation

The guide tool is there for the things signatures cannot express. Useful nudges:

| ^Say this | It will read |
|---|---|
| "Check the criteria syntax first" | `filter-criteria-syntax` |
| "Read the async export playbook" | `export-data-asynchronously` |
| "Look up error 8080" | the error catalog entry |
| "How should I resolve these IDs?" | `bootstrap-identifiers`, `identifiers` |

Most of the time you will not need to: the search results already point at the relevant playbook, and failures carry their own explanation.

## 8. Things worth telling your agent

- **"Find the table first"** — if it is guessing at a view name instead of resolving it.
- **"Which variable did you use?"** — for anything where the wrong one would look right.
- **"Search the API first"** — if it is guessing at operation names.
- **"Return a summary, not the rows"** — if it dumps data into the conversation.
- **"Use the bulk export job"** — for anything large; a single blocking export can time out.
- **"Only workspace X"** — scoping saves API units and time.

## 9. What comes back

`run_analytics_code` returns three things:

```json
{
  "result":   { "totals": { "Sales Data": 64200 }, "grandTotal": 74100 },
  "logs":     ["skipped Regions: no matching rows"],
  "apiCalls": 7
}
```

`result` is whatever the program returned, `logs` are its `console.log` lines, and `apiCalls` is how many Analytics operations it used — handy for keeping an eye on API-unit consumption.

## 10. Limits you will meet

| ^Limit | Default | What happens | Change it with |
|---|---|---|---|
| API calls per program | 200 | Program stops with a budget error | `ZA_MAX_TOOL_CALLS` |
| Program runtime | 60 s | Timed out; use an async export job | `ZA_EXEC_TIMEOUT_MS` |
| Sandbox memory | 256 MB | Out of memory; aggregate in chunks | `ZA_EXEC_MEMORY_MB` |
| Write operations | hidden | `not a function` | `ZA_ALLOW_WRITES` — read [Security](04-security.md) first |
| API call rate | 55 per minute | loops are paced; no 6045 | `ZA_MAX_CALLS_PER_MINUTE` |
| API domains | all ten | `not a function` | `ZA_DOMAINS` — see [Choosing what to expose](02-install.md#choosing-what-to-expose) |

## 11. A caution about numbers

Your agent's model writes the code, and this tool runs it. A more capable model writes better code; a weaker one makes mistakes that look like confident answers.

:::warn Spot-check figures that matter
If a number is going into a report or a decision, ask the agent to show the code it ran, and sanity-check the filter and the date range. The sandbox guarantees the code is *safe*, not that it is *correct*.
:::
