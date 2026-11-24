/**
 * The data engine — filtering that happens on the server, not in the model.
 *
 * Every case here is a variant of one failure: a program downloads a whole
 * table, filters it in JavaScript, and bills the API units and the context
 * window for all the rows it threw away. The assertions are therefore about
 * what crossed the wire, not only about the answer — a correct total computed
 * from a full download is still the bug.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockAnalytics } from './mock-analytics.mjs';
import { buildProgram, capResult, choosePath, describePushdown, validate }
  from '../src/data-engine.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ORG_ID = '2375824000000000001';
const SALES_WS = '2375824000000012345';
const Q3 = '2375824000000020001';          // Sales Q3: 5 rows, 4 East, 1 West
const PROFIT_VIEW = '2375824000000020007'; // declared columns, no rows
const CHART = '2375824000000020008';       // Chart: SQL cannot name it
const DASHBOARD = '2375824000000020010';   // no row data at all — 8119
const BIG_TABLE = '2375824000000020011';   // 250,000 rows, worth bounding

let mock; let client;

const call = async (name, args) => {
  const res = await client.callTool({ name, arguments: args });
  return { error: res.isError === true, text: res.content[0].text };
};
const json = async (name, args) => {
  const { error, text } = await call(name, args);
  assert.equal(error, false, `tool failed: ${text}`);
  return JSON.parse(text);
};

before(async () => {
  mock = await startMockAnalytics();
  client = new Client({ name: 'data-engine-test', version: '1.0' });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [join(HERE, '..', 'src', 'server.mjs')],
    env: {
      PATH: process.env.PATH,
      ANALYTICS_SERVER_URL: mock.url,
      ANALYTICS_ACCESS_TOKEN: 'test-token',
      ANALYTICS_ORG_ID: ORG_ID,
    },
    stderr: 'pipe',
  }));
});

after(async () => {
  await client?.close().catch(() => {});
  await mock?.close();
  setTimeout(() => process.exit(0), 200).unref();
});

// ---------------------------------------------------------------------------
// Routing and validation — decided before any call is made
// ---------------------------------------------------------------------------

test('a plain filtered read stays on the single-call view export', () => {
  assert.equal(choosePath({ workspaceId: '1', viewId: '2', filters: [{ column: 'R', value: 'E' }] }),
    'view');
  assert.equal(choosePath({ workspaceId: '1', viewId: '2', columns: ['Sales'] }), 'view');
});

test('anything needing real SQL routes to the export job', () => {
  const base = { workspaceId: '1', viewId: '2' };
  assert.equal(choosePath({ ...base, metrics: [{ fn: 'sum', column: 'Sales' }] }), 'sql');
  assert.equal(choosePath({ ...base, groupBy: ['Region'] }), 'sql');
  assert.equal(choosePath({ ...base, orderBy: [{ column: 'Sales', dir: 'desc' }] }), 'sql');
  assert.equal(choosePath({ ...base, distinct: true }), 'sql');
  assert.equal(choosePath({ workspaceId: '1', sql: 'SELECT 1' }), 'sql');
  assert.equal(choosePath({ workspaceId: '1', table: 'Sales Q3', limit: 5 }), 'sql');
});

test('an explicit mode overrides the routing', () => {
  assert.equal(choosePath({ workspaceId: '1', viewId: '2', mode: 'count' }), 'count');
  assert.equal(choosePath({ workspaceId: '1', viewId: '2', mode: 'sql' }), 'sql');
});

test('a write disguised as a query is refused before it is sent', () => {
  const { problems } = validate({ workspaceId: '1', sql: 'DELETE FROM "Table"' });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /only select/i);
});

test('a read with no workspace says where to get one', () => {
  const { problems } = validate({ viewId: '2' });
  assert.match(problems.join(' '), /workspaceId is required.*find_analytics_objects/i);
});

test('plain columns beside an aggregate are refused with the fix', () => {
  const { problems } = validate({
    workspaceId: '1', table: 'T',
    columns: ['Product'], metrics: [{ fn: 'sum', column: 'Sales' }],
  });
  assert.match(problems.join(' '), /Move Product into groupBy/);
});

test('request values reach the program as data, not as code', () => {
  // The protection is that a caller's value is never spliced into the program
  // as source: it goes in as a JSON literal and comes out of JSON.parse
  // unchanged, whatever it contains. Quoting it for the API is then the
  // builder's job, which the injection cases below cover.
  const hostile = "'; return process; //";
  const program = buildProgram({
    workspaceId: '1', viewId: '2',
    filters: [{ column: 'Name', value: hostile }],
  });
  const spec = JSON.parse(/const spec = (\{[\s\S]*?\});/.exec(program)[1]);
  assert.equal(spec.filters[0].value, hostile);
  assert.equal(spec.workspaceId, '1');
  // The program itself must still be syntactically whole.
  assert.doesNotThrow(() => new Function(`async function wrapper(){ ${program} }`));
});

// ---------------------------------------------------------------------------
// The result cap — a shortened list must never read as a complete one
// ---------------------------------------------------------------------------

test('too many rows are cut, counted and explained', () => {
  const rows = Array.from({ length: 1200 }, (_, i) => ({ i }));
  const { value, truncated } = capResult({ rows }, { maxRows: 100, maxBytes: 1e9 });
  assert.equal(truncated, true);
  assert.equal(value.rows.length, 100);
  assert.equal(value.rowsOmitted, 1100);
  assert.match(value.truncation, /Showing 100 of 1200 rows/);
});

test('a bare array of rows is capped too', () => {
  const { value, truncated } = capResult(Array.from({ length: 50 }, (_, i) => i),
    { maxRows: 10, maxBytes: 1e9 });
  assert.equal(truncated, true);
  assert.equal(value.rows.length, 10);
  assert.equal(value.rowsOmitted, 40);
});

test('the byte budget binds on wide rows even when the row count is fine', () => {
  const rows = Array.from({ length: 40 }, () => ({ blob: 'x'.repeat(500) }));
  const { value, text } = capResult({ rows }, { maxRows: 1000, maxBytes: 2000 });
  assert.ok(text.length <= 2600, `expected a trimmed result, got ${text.length} bytes`);
  assert.ok(value.rows.length < 40);
  assert.match(value.truncation, /ZA_MAX_RESULT_BYTES/);
});

test('a small answer passes through untouched', () => {
  const value = { rows: [{ Region: 'East', total: 64200 }] };
  const capped = capResult(value, { maxRows: 500, maxBytes: 120_000 });
  assert.equal(capped.truncated, false);
  assert.deepEqual(capped.value, value);
});

test('an oversized result with nothing to trim is reported, not mangled', () => {
  const { value, oversized, truncated } = capResult({ note: 'x'.repeat(5000) },
    { maxRows: 10, maxBytes: 1000 });
  assert.equal(truncated, false);
  assert.equal(value.note.length, 5000, 'the value must not be silently cut');
  assert.match(oversized, /no row list to trim/);
});

test('pushdown is described so the model can see what the server did', () => {
  assert.match(describePushdown('view', { pushdown: { criteria: '"Region"=\'East\'' } }),
    /criteria applied by the server/);
  assert.match(describePushdown('view', { pushdown: {} }),
    /read the whole view/);
  assert.match(describePushdown('view', { pushdown: { limitAppliedBy: 'client' } }),
    /applied after download/);
});

test('a narrowed-but-still-wide result says so', () => {
  // 207 rows of a seven-column table is 35 KB — the export was narrowed, the
  // context was not, and the model has to be told the difference.
  const wide = {
    pushdown: { criteria: '"Region"=\'West\'' },
    rows: Array.from({ length: 207 }, () => ({ Region: 'West' })),
  };
  assert.match(describePushdown('view', wide), /207 rows reached the model/);
  assert.match(describePushdown('view', wide), /groupBy \+ metrics/);

  const narrow = { pushdown: { criteria: 'x' }, rows: [{ a: 1 }, { a: 2 }] };
  assert.doesNotMatch(describePushdown('view', narrow), /rows reached the model/);
});

// ---------------------------------------------------------------------------
// End to end: what actually crossed the wire
// ---------------------------------------------------------------------------

test('a filter is applied by the server, not by the model', async () => {
  const before = mock.requests.length;
  const res = await json('query_analytics_data', {
    workspaceId: SALES_WS, viewId: Q3,
    filters: [{ column: 'Region', value: 'East' }],
  });
  const sent = mock.requests.slice(before);

  assert.equal(res.rowCount, 4, 'Sales Q3 has 4 East rows of 5');
  assert.equal(res.criteria, '"Region" = \'East\'', 'the expression itself, printed once');
  assert.equal(res.rowsAvailable, undefined,
    'nothing was dropped after download, so there is no second number to report');

  // Exactly one export, and one metadata read to check the filter's columns
  // before spending it. Two exports would mean a download-then-filter.
  const exports = sent.filter((r) => r.endsWith('/data'));
  assert.equal(exports.length, 1, `one export, got ${sent.join(' | ')}`);
});

test('column projection shrinks the payload as well as the row count', async () => {
  const wide = await json('query_analytics_data', {
    workspaceId: SALES_WS, viewId: Q3, filters: [{ column: 'Region', value: 'East' }],
  });
  const narrow = await json('query_analytics_data', {
    workspaceId: SALES_WS, viewId: Q3,
    filters: [{ column: 'Region', value: 'East' }], columns: ['Region', 'Sales'],
  });

  assert.deepEqual(Object.keys(narrow.rows[0]), ['Region', 'Sales']);
  assert.ok(JSON.stringify(narrow.rows).length < JSON.stringify(wide.rows).length / 1.5,
    'projection should roughly halve the payload on this table');
});

test('an aggregate is computed inside Analytics and comes back as a few rows', async () => {
  const res = await json('query_analytics_data', {
    workspaceId: SALES_WS, viewId: Q3,
    groupBy: ['Region'],
    metrics: [{ fn: 'sum', column: 'Sales', as: 'Total' }],
  });

  assert.equal(res.path, 'sql');
  assert.match(res.sql, /sum\("Sales"\).*GROUP BY "Region"/);
  const byRegion = Object.fromEntries(res.rows.map((r) => [r.Region, Number(r.Total)]));
  assert.deepEqual(byRegion, { East: 45800, West: 5100 });
  // The whole point: the answer is smaller than the data it summarises.
  assert.ok(JSON.stringify(res.rows).length < 200,
    `an aggregate should be tiny, got ${JSON.stringify(res.rows).length} bytes`);
});

test('counting matching rows fetches none of them', async () => {
  const res = await json('query_analytics_data', {
    workspaceId: SALES_WS, viewId: Q3, mode: 'count',
    filters: [{ column: 'Region', value: 'East' }],
  });
  assert.equal(res.rowCount, 4);
  assert.match(res.sql, /count\(\*\)/i);
  assert.ok(!('rows' in res) || res.rows === undefined, 'no rows should come back from a count');
});

test('a top-N is pushed into the SQL, not sliced after the download', async () => {
  const res = await json('query_analytics_data', {
    workspaceId: SALES_WS, table: 'Sales Q3',
    columns: ['Product', 'Sales'],
    orderBy: [{ column: 'Sales', dir: 'desc' }],
    limit: 2,
  });
  assert.equal(res.path, 'sql');
  assert.match(res.sql, /LIMIT 2/);
  assert.equal(res.rows.length, 2);
  assert.equal(res.rows[0].Sales, 15500);
});

test('previewing a BIG table pushes the limit into the SQL', async () => {
  const res = await json('query_analytics_data', {
    workspaceId: '2375824000000022222', viewId: BIG_TABLE, mode: 'preview', limit: 2,
  });
  assert.equal(res.viewType, 'Table');
  assert.match(res.sql, /LIMIT 2$/);
  assert.match(res.note, /bounded inside Analytics/);
});

test('previewing a SMALL table costs one call, not four', async () => {
  // Export units are billed per thousand rows produced, so a 5-row table and
  // a 755-row table cost the same block. Spending three extra round trips to
  // shrink an export that is already one block buys nothing.
  const res = await json('query_analytics_data', {
    workspaceId: SALES_WS, viewId: Q3, mode: 'preview', limit: 2,
  });
  assert.equal(res.rows.length, 2);
  assert.equal(res.apiCalls, 2, 'one metadata call plus one export');
});

test('preview of a view SQL cannot name falls back and admits it', async () => {
  // A chart has no table of that name, so the limit can only be applied
  // after the download — which is exactly what the note has to say.
  const res = await json('query_analytics_data', {
    workspaceId: '2375824000000022222', viewId: '2375824000000020008',
    mode: 'preview', limit: 2,
  });
  assert.equal(res.viewType, 'Chart');
  assert.equal(res.rowCount, 0, 'the mock chart has no rows, which is beside the point');
  assert.equal(res.sql, undefined, 'no SELECT could name a Chart, and none is claimed');
  assert.equal(res.path, 'preview');
});

test('a chart asked for an aggregate is routed to the view export, with a reason', async () => {
  const res = await json('query_analytics_data', {
    workspaceId: '2375824000000022222', viewId: '2375824000000020008',
    groupBy: ['Region'], metrics: [{ fn: 'sum', column: 'Sales', as: 'Total' }],
  });
  assert.match(res.sqlNotPossible, /A Chart cannot be named in a SELECT/);
  assert.match(res.sqlNotPossible, /The filter was/);
});

test('a limit on the view path admits it was applied client-side', async () => {
  const res = await json('query_analytics_data', {
    workspaceId: SALES_WS, viewId: Q3, mode: 'view', limit: 2,
  });
  assert.equal(res.rows.length, 2);
  assert.match(res.pushedDown, /applied after download.*push it into SQL/s);
});

// ---------------------------------------------------------------------------
// Refusals: a filter that cannot mean what it says must not be dropped
// ---------------------------------------------------------------------------

test('a filter naming a column the view lacks is refused with the real columns', async () => {
  const { error, text } = await call('query_analytics_data', {
    workspaceId: '2375824000000022222', viewId: PROFIT_VIEW,
    filters: [{ column: 'Revenue', value: 1 }],
  });
  assert.equal(error, true);
  assert.match(text, /not a column/);
  assert.match(text, /Country.*Total Profit.*Total Sales/s, 'list what the view does have');
  assert.match(text, /do not drop it and filter in code/i);
});

test('an unknown operator names the ones that exist', async () => {
  const { error, text } = await call('query_analytics_data', {
    workspaceId: SALES_WS, viewId: Q3,
    filters: [{ column: 'Sales', op: 'approximately', value: 1 }],
  });
  assert.equal(error, true);
  assert.match(text, /Unknown filter operator "approximately"/);
  assert.match(text, /\bbetween\b/);
});

test('a non-SELECT statement is refused by the tool and by the server', async () => {
  const { error, text } = await call('query_analytics_data', {
    workspaceId: SALES_WS, sql: 'DELETE FROM "Sales Q3"',
  });
  assert.equal(error, true);
  assert.match(text, /only select/i);
});

// ---------------------------------------------------------------------------
// The same engine inside run_analytics_code
// ---------------------------------------------------------------------------

test('quoting is handled for values that would otherwise break the expression', async () => {
  const res = await json('run_analytics_code', {
    code: `return {
      apostrophe: data.criteria([{ column: 'Name', value: "O'Brien" }]),
      spaced:     data.criteria([{ column: 'Order Date', op: 'gte', value: '01-Jan-2026' }]),
      list:       data.criteria([{ column: 'Region', op: 'in', value: ['East', 'West'] }]),
      number:     data.criteria([{ column: 'Sales', op: 'gt', value: 1000 }]),
      combined:   data.criteria({ Region: 'East', Sales: { gt: 1000 } }),
      contains:   data.criteria([{ column: 'Product', op: 'contains', value: 'Widg' }]),
      qualified:  data.criteria([{ column: 'Region', table: 'Sales Q3', value: 'East' }]),
    };`,
  });

  assert.equal(res.result.apostrophe, `"Name" = 'O''Brien'`);
  assert.equal(res.result.spaced, `"Order Date" >= '01-Jan-2026'`);
  assert.equal(res.result.list, `"Region" in ('East', 'West')`);
  assert.equal(res.result.number, `"Sales" > 1000`, 'a number must not be quoted');
  assert.equal(res.result.combined, `("Region" = 'East') and ("Sales" > 1000)`);
  assert.equal(res.result.contains, `"Product" like '%Widg%'`);
  assert.equal(res.result.qualified, `"Sales Q3"."Region" = 'East'`);
});

test('the SQL builder quotes identifiers and refuses to emit anything but SELECT', async () => {
  const res = await json('run_analytics_code', {
    code: `return {
      sql: data.sql({
        table: 'Sales Q3',
        groupBy: ['Region'],
        metrics: [{ fn: 'sum', column: 'Sales', as: 'Total' }],
        filters: [{ column: 'Date', op: 'gte', value: '2026-07-01' }],
        orderBy: [{ column: 'Total', dir: 'desc' }],
        limit: 10,
      }),
      injected: data.sql({ table: 'Sales Q3', columns: ['Region'],
        filters: [{ column: 'Region', value: "x' or '1'='1" }] }),
    };`,
  });

  assert.equal(res.result.sql,
    'SELECT "Region", sum("Sales") AS "Total" FROM "Sales Q3" '
    + `WHERE "Date" >= '2026-07-01' GROUP BY "Region" ORDER BY "Total" DESC LIMIT 10`);
  assert.match(res.result.injected, /'x'' or ''1''=''1'/,
    'the quote in the value must be doubled, not left to close the literal');
});

test('data.query returns the aggregate, having polled the job itself', async () => {
  const res = await json('run_analytics_code', {
    code: `const out = await data.query({
      workspaceId: '${SALES_WS}', table: 'Sales Q3',
      groupBy: ['Region'], metrics: [{ fn: 'sum', column: 'Sales', as: 'Total' }],
    });
    return { rows: out.rows, polls: out.polls, sql: out.sql };`,
  });
  assert.equal(res.result.rows.length, 2);
  assert.ok(res.result.polls >= 2, 'the job must actually have been polled');
  assert.match(res.result.sql, /^SELECT/);
});

test('data.count answers without moving any rows', async () => {
  const res = await json('run_analytics_code', {
    code: `return await data.count({ workspaceId: '${SALES_WS}', table: 'Sales Q3',
      filters: [{ column: 'Product', value: 'Widget' }] });`,
  });
  assert.equal(res.result.rowCount, 3);
});

test('a view id is translated to the table name SQL needs', async () => {
  const res = await json('run_analytics_code', {
    code: `return { table: await data.tableFor('${SALES_WS}', '${Q3}') };`,
  });
  assert.equal(res.result.table, 'Sales Q3');
});

test('a view from another workspace stops rather than being read anyway', async () => {
  // Headcount lives in HR Analytics. Reading it under the Sales workspace id
  // is how one tenant gets answered with another tenant's numbers.
  const { error, text } = await call('run_analytics_code', {
    code: `return await data.tableFor('${SALES_WS}', '2375824000000020004');`,
  });
  assert.equal(error, true);
  assert.match(text, /STOPPED: view 2375824000000020004 belongs to workspace 2375824000000067890/);
  assert.match(text, /find\.resolve/);
});

// ---------------------------------------------------------------------------
// Economy — the point of the engine is calls and bytes, so assert on both
// ---------------------------------------------------------------------------

test('one metadata call answers the name, the type, the size and the columns', async () => {
  // Resolving a view used to cost getViewDetails twice: once bare for the
  // name, once with withInvolvedMetaInfo for the columns, because the
  // resolver and the engine cached it separately.
  const res = await json('query_analytics_data', {
    workspaceId: SALES_WS, viewId: Q3,
    filters: [{ column: 'Region', value: 'East' }],
  });
  assert.equal(res.path, 'view');
  assert.equal(res.apiCalls, 2, 'one metadata call plus one export, never two metadata calls');
});

test('a limit is pushed into SQL rather than sliced off a full download', async () => {
  const res = await json('query_analytics_data', { workspaceId: SALES_WS, viewId: Q3, limit: 2 });
  assert.equal(res.path, 'sql');
  assert.match(res.sql, /LIMIT 2/);
  assert.equal(res.rows.length, 2);
  assert.equal(res.pushedDown, undefined, 'nothing was faked after the download');
});

test('a big table is bounded with SQL instead of exported whole', async () => {
  const res = await json('query_analytics_data', {
    workspaceId: '2375824000000022222', viewId: BIG_TABLE,
  });
  assert.equal(res.path, 'sql');
  assert.match(res.routedToSql, /250000 rows/);
  assert.match(res.sql, /LIMIT/);
});

test('a small table is still read in one call, not three', async () => {
  const res = await json('query_analytics_data', { workspaceId: SALES_WS, viewId: Q3 });
  assert.equal(res.path, 'view');
  assert.equal(res.apiCalls, 2);
});

test('an unbounded SELECT is capped at what the result can carry', async () => {
  const res = await json('query_analytics_data', {
    workspaceId: SALES_WS, table: 'Sales Q3',
  });
  assert.match(res.sql, /LIMIT 501/);
  assert.match(res.safetyLimit, /bounded at 501 rows/);
});

// ---------------------------------------------------------------------------
// Views that cannot answer, and the ones that answer differently
// ---------------------------------------------------------------------------

test('a dashboard is refused with what to read instead, not retried twice', async () => {
  const { error, text } = await call('query_analytics_data', {
    workspaceId: '2375824000000022222', viewId: DASHBOARD,
  });
  assert.equal(error, true);
  assert.match(text, /has no row data/);
  assert.match(text, /8119/);
  assert.match(text, /tables or reports it is built from/);
});

test('counting a view SQL cannot name counts the rows it produces', async () => {
  const res = await json('query_analytics_data', {
    workspaceId: '2375824000000022222', viewId: CHART, mode: 'count',
  });
  assert.equal(res.path, 'view', 'it reports the route it actually took');
  assert.match(res.countedBy, /cannot be named in a SELECT/);
  assert.equal(typeof res.rowCount, 'number');
});

// ---------------------------------------------------------------------------
// Formulas — free when absent, which is the normal case
// ---------------------------------------------------------------------------

test('a table with no formulas never pays a call to establish that', async () => {
  const res = await json('query_analytics_data', {
    workspaceId: SALES_WS, viewId: Q3,
    filters: [{ column: 'Region', value: 'East' }],
  });
  assert.equal(res.apiCalls, 2, 'no speculative customformulas/aggregateformulas lookup');
});

test('a name that misses is checked against the formulas before it is refused', async () => {
  const { error, text } = await call('query_analytics_data', {
    workspaceId: '2375824000000022222', viewId: PROFIT_VIEW,
    filters: [{ column: 'Gross Margin', value: 1 }],
  });
  assert.equal(error, true);
  assert.match(text, /is an aggregate formula on this view, not a column/);
  assert.match(text, /data\.metricValue/);
});

test('an aggregate formula is read as a value rather than recomputed', async () => {
  const res = await json('run_analytics_code', {
    code: `return await data.metricValue('2375824000000022222', '33000001');`,
  });
  assert.equal(res.result.value, '0.3184');
  assert.equal(res.apiCalls, 1);
});

// ---------------------------------------------------------------------------
// Windows and formats that used to be dropped in silence
// ---------------------------------------------------------------------------

test('an offset is pushed into SQL, not silently ignored', async () => {
  const res = await json('query_analytics_data', {
    workspaceId: SALES_WS, viewId: Q3, limit: 2, offset: 1,
  });
  assert.equal(res.path, 'sql');
  assert.match(res.sql, /LIMIT 2 OFFSET 1/);
});

test('an offset on the view path says it was applied after download', async () => {
  const res = await json('query_analytics_data', {
    workspaceId: SALES_WS, viewId: Q3, mode: 'view', offset: 2,
  });
  assert.match(res.pushedDown, /offset applied after download/);
});

test('a csv body over budget is cut on a line boundary and says so', () => {
  const body = ['a,b', ...Array.from({ length: 400 }, (_, i) => `${i},${'x'.repeat(40)}`)].join('\n');
  const { value, truncated } = capResult({ format: 'csv', body }, { maxBytes: 2000 });
  assert.equal(truncated, true);
  assert.ok(value.body.length <= 2000);
  assert.equal(value.body.split('\n')[0], 'a,b', 'the header survives');
  assert.ok(value.rowsOmitted > 0);
  assert.match(value.truncation, /ZA_MAX_RESULT_BYTES/);
});

test('8133 "switch to async export" falls back to the export job', async () => {
  // Measured against a live organization through a different client: some
  // views refuse the synchronous export with 8133 and the words "Kindly
  // switch to async export model". Neither the code nor the wording was in
  // the fallback pattern, so the read simply failed.
  const program = buildProgram({ workspaceId: '1', viewId: '2' });
  assert.match(program, /8133/);
  assert.match(program, /switch to async/);
});

test('view metadata is read once per session, not once per question', async () => {
  // A session asks several questions about one table. The shape of that
  // table — name, type, row count, columns — does not change between them,
  // and re-reading it was a whole API call per question.
  // A view no earlier test has touched, so the first read is genuinely cold.
  const FRESH = '2375824000000020003';   // Regions
  const before = mock.requests.length;
  for (let i = 0; i < 3; i += 1) {
    await json('query_analytics_data', { workspaceId: SALES_WS, viewId: FRESH });
  }
  const details = mock.requests.slice(before)
    .filter((r) => /\/restapi\/v2\/views\/\d+$/.test(r));
  assert.equal(details.length, 1, `three questions, one metadata read, got ${details.length}`);
});
