/**
 * Name resolution — the gap between what a user says and what their data is
 * called.
 *
 * Without this, a model asked to "analyse my profit table" writes
 * `v.viewName === 'profit'`, matches nothing, and tells the user the table
 * does not exist. Every case below is that failure, or a near miss of it.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockAnalytics } from './mock-analytics.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ORG_ID = '2375824000000000001';
const ZIA_WS = '2375824000000022222';
const PROFIT_VIEW = '2375824000000020007';

let mock; let client;

const call = async (name, args) =>
  JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);

before(async () => {
  mock = await startMockAnalytics();
  client = new Client({ name: 'resolve-test', version: '1.0' });
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

test('"profit" finds Sales_Profit_by_Country rather than failing', async () => {
  const res = await call('find_analytics_objects', { query: 'profit' });
  assert.equal(res.found, true);
  const names = [res.best, ...res.alternatives].map((m) => m.viewName);
  assert.ok(names.includes('Sales_Profit_by_Country'),
    `the real table must be among the candidates, got ${names.join(', ')}`);
});

test('two plausible matches are reported as ambiguous, not guessed', async () => {
  // "Profit Margin Trend" and "Sales_Profit_by_Country" both match "profit".
  // Picking one silently is the failure this guards against.
  const res = await call('find_analytics_objects', { query: 'profit' });
  assert.equal(res.confident, false);
  assert.ok(res.alternatives.length >= 1);
  assert.match(res.ambiguous, /let them choose/);
});

test('an unambiguous name resolves confidently', async () => {
  const res = await call('find_analytics_objects', { query: 'Customer Churn' });
  assert.equal(res.found, true);
  assert.equal(res.confident, true);
  assert.equal(res.best.viewName, 'Customer Churn');
  assert.equal(res.best.score, 100);
});

test('every match says why it matched', async () => {
  const res = await call('find_analytics_objects', { query: 'profit' });
  for (const m of [res.best, ...res.alternatives]) {
    assert.ok(m.matchedOn && m.matchedOn !== 'none', `missing matchedOn on ${m.viewName}`);
    assert.ok(typeof m.score === 'number');
  }
});

test('no query at all lists what exists, so a blind request can proceed', async () => {
  const res = await call('find_analytics_objects', {});
  const names = res.workspaces.map((w) => w.workspaceName);
  assert.ok(names.includes('Sales Data'));
  assert.ok(names.length >= 4);
});

test('a genuine miss reports the search scope, never "your data does not exist"', async () => {
  const res = await call('find_analytics_objects', { query: 'quarterly widget forecast' });
  assert.equal(res.found, false);
  assert.match(res.message, /Nothing matched .* in \d+ of \d+ workspaces/);
  assert.ok(res.workspacesAvailable.length > 0,
    'must tell the user what it did find');
});

test('column search falls back to listing the columns that exist', async () => {
  const res = await call('find_analytics_objects', {
    kind: 'column', query: 'revenue', workspaceId: ZIA_WS, viewId: PROFIT_VIEW,
  });
  const names = res.columns.map((c) => c.columnName);
  assert.ok(names.includes('Total Sales'),
    `"revenue" matches nothing, so show what there is; got ${names.join(', ')}`);
});

test('column search ranks a real match first', async () => {
  const res = await call('find_analytics_objects', {
    kind: 'column', query: 'profit', workspaceId: ZIA_WS, viewId: PROFIT_VIEW,
  });
  assert.equal(res.columns[0].columnName, 'Total Profit');
});

test('asking for columns without a view is refused with a usable message', async () => {
  const res = await client.callTool({
    name: 'find_analytics_objects', arguments: { kind: 'column', query: 'x' },
  });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /workspaceId and viewId/);
});

test('the resolver is available inside run_analytics_code too', async () => {
  const res = await call('run_analytics_code', {
    code: `const r = await find.resolve('churn');
           return { name: r.best.viewName, confident: r.confident };`,
  });
  assert.equal(res.result.name, 'Customer Churn');
  assert.equal(res.result.confident, true);
});

test('resolution is cached: a second lookup costs no extra API calls', async () => {
  const res = await call('run_analytics_code', {
    code: `await find.views('profit');
           await find.views('churn');
           await find.workspaces('sales');
           return 'done';`,
  });
  // 1 workspace list + 1 getViews per workspace, and nothing repeated.
  assert.ok(res.apiCalls <= 6,
    `expected the caches to hold; made ${res.apiCalls} calls`);
});

// ---------------------------------------------------------------------------
// Named things must resolve or stop. Never substitute.
// ---------------------------------------------------------------------------

const ZIA_VARS = ZIA_WS;                       // sum_of_cost, region_filter, fiscal_year_start
const AMBIGUOUS_WS = '2375824000000012345';    // sum_of_cost AND sum_of_revenue

test('"sum" resolves to the real variable sum_of_cost', async () => {
  const res = await call('run_analytics_code', {
    code: `return await find.require('variable', '${ZIA_VARS}', 'sum');`,
  });
  assert.equal(res.result.name, 'sum_of_cost');
  assert.equal(res.result.kind, 'variable');
  assert.ok(res.result.id);
});

test('two variables matching the same word stops rather than picking one', async () => {
  const res = await client.callTool({
    name: 'run_analytics_code',
    arguments: { code: `return await find.require('variable', '${AMBIGUOUS_WS}', 'sum');` },
  });
  assert.equal(res.isError, true);
  const text = res.content[0].text;
  assert.match(text, /ambiguous/);
  assert.match(text, /sum_of_cost/);
  assert.match(text, /sum_of_revenue/);
  assert.match(text, /Do not pick one/);
});

test('a name that does not exist stops and lists what does', async () => {
  const res = await client.callTool({
    name: 'run_analytics_code',
    arguments: { code: `return await find.require('variable', '${ZIA_VARS}', 'headcount');` },
  });
  assert.equal(res.isError, true);
  const text = res.content[0].text;
  assert.match(text, /STOPPED: no variable matching "headcount"/);
  assert.match(text, /Do not substitute/);
  assert.match(text, /sum_of_cost, region_filter, fiscal_year_start/);
});

test('catching the refusal does NOT let the program substitute', async () => {
  // The guarantee has to hold against a program that actively works around
  // it, because a thrown error is only advisory inside the sandbox.
  const res = await client.callTool({
    name: 'run_analytics_code',
    arguments: {
      code: `
        let v;
        try { v = await find.require('variable', '${ZIA_VARS}', 'headcount'); }
        catch (e) { v = (await find.metadata('variable', '${ZIA_VARS}', null))[0]; }
        return { usedInstead: v.name };`,
    },
  });
  assert.equal(res.isError, true, 'the host must fail the execution regardless');
  assert.match(res.content[0].text, /STOPPED: no variable matching "headcount"/);
  assert.doesNotMatch(res.content[0].text, /usedInstead/);
});

test('the other metadata kinds resolve by name', async () => {
  for (const [kind, query, expected] of [
    ['folder', 'finance', 'Finance'],
    ['formula', 'margin', 'Gross Margin'],
  ]) {
    const res = await call('run_analytics_code', {
      code: `return await find.require('${kind}', '${ZIA_VARS}', '${query}');`,
    });
    assert.equal(res.result.name, expected, `${kind} "${query}"`);
  }
});

test('the discovery tool exposes variables too', async () => {
  const res = await call('find_analytics_objects', {
    kind: 'variable', query: 'sum', workspaceId: ZIA_VARS,
  });
  assert.equal(res.kind, 'variable');
  assert.equal(res.matches[0].name, 'sum_of_cost');
});

test('a workspace-scoped kind without a workspaceId is refused clearly', async () => {
  const res = await client.callTool({
    name: 'find_analytics_objects', arguments: { kind: 'variable', query: 'sum' },
  });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /needs a workspaceId/);
});

// ---------------------------------------------------------------------------
// Rate limiting — found live: an 81-workspace sweep trips Zoho's frequency
// limit (6045) when calls are fired back to back.
// ---------------------------------------------------------------------------

test('calls are paced, so a loop cannot fire back to back', async () => {
  const t0 = Date.now();
  const res = await call('run_analytics_code', {
    code: `for (let i = 0; i < 5; i++) {
             await za.getOrgWorkspaces({ 'ZANALYTICS-ORGID': ORG_ID });
           }
           return 'done';`,
  });
  const elapsed = Date.now() - t0;
  assert.equal(res.apiCalls, 5);
  // 5 calls at the default 50 ms minimum gap cannot complete instantly.
  assert.ok(elapsed >= 150, `5 paced calls took only ${elapsed}ms`);
});

test('the sliding window caps the rate, not just the gap', async () => {
  // Measured live: the limit is a rate over a window. 1000 ms apart ran clean
  // at ~53/min; 400 ms apart tripped after 27 calls at ~105/min. A fixed gap
  // alone therefore cannot keep a burst inside the limit.
  const { loadConfig } = await import('../src/config.mjs');
  const cfg = await loadConfig({ ANALYTICS_ORG_ID: '1', ANALYTICS_ACCESS_TOKEN: 't' });
  assert.ok(cfg.maxCallsPerMinute <= 60,
    `default ${cfg.maxCallsPerMinute}/min must stay under the measured safe rate`);
  assert.ok(cfg.minCallIntervalMs > 0);
});

test('a throttled call is retried, then reported honestly', async () => {
  // The mock returns 6045 twice, then succeeds — the backoff must ride it out.
  const res = await call('run_analytics_code', {
    code: `const r = await za.getOrgWorkspaces({ 'ZANALYTICS-ORGID': ORG_ID, __throttle: '2' });
           return r.data.workspaces.length;`,
  });
  assert.ok(res.result >= 1, 'the retry should eventually succeed');
});

test('a persistent throttle fails with advice, never a wrong answer', async () => {
  const res = await client.callTool({
    name: 'run_analytics_code',
    arguments: {
      code: `return await za.getOrgWorkspaces({ 'ZANALYTICS-ORGID': ORG_ID, __throttle: '99' });`,
    },
  });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /frequency limit/i);
  assert.match(res.content[0].text, /narrow the task|wait a minute/i);
});

// ---------------------------------------------------------------------------
// Reading results. Both bugs below were found against a live organization and
// both produce a wrong answer silently, which is why they have tests.
// ---------------------------------------------------------------------------

test('rows.of reads the flat array the real export returns', async () => {
  // The live API puts export rows directly in `data`. Reaching for
  // `data.rows` gives undefined, and `?? []` turns that into a confident
  // "no data" for a table with 755 rows in it.
  const res = await call('run_analytics_code', {
    code: `const out = await za.exportDataView({ 'ZANALYTICS-ORGID': ORG_ID,
             'workspace-id': '2375824000000012345', 'view-id': '2375824000000020001',
             CONFIG: JSON.stringify({ responseFormat: 'json' }) });
           return { viaHelper: rows.of(out).length, viaDotRows: (out.data.rows ?? []).length };`,
  });
  assert.ok(res.result.viaHelper > 0, 'rows.of must find the rows');
  assert.equal(res.result.viaDotRows, 0, 'data.rows is the trap being guarded');
});

test('rows.num parses the formatted values the API actually returns', async () => {
  const res = await call('run_analytics_code', {
    code: `return { currency: rows.num('$1,682.39'), percent: rows.num('45%'),
                    blank: rows.num(''), text: rows.num('n/a'), plain: rows.num(12000) };`,
  });
  assert.equal(res.result.currency, 1682.39);
  assert.equal(res.result.percent, 45);
  assert.equal(res.result.blank, null);
  assert.equal(res.result.text, null);
  assert.equal(res.result.plain, 12000);
});

test('rows.sum skips blanks and says how many it skipped', async () => {
  const res = await call('run_analytics_code', {
    code: `return rows.sum([{ s: '$10.50' }, { s: '' }, { s: '$2.50' }], 's');`,
  });
  assert.deepEqual(res.result, { total: 13, counted: 2, skipped: 1 });
});

test('rows.groupSum aggregates by a column', async () => {
  const res = await call('run_analytics_code', {
    code: `const out = await za.exportDataView({ 'ZANALYTICS-ORGID': ORG_ID,
             'workspace-id': '2375824000000012345', 'view-id': '2375824000000020001',
             CONFIG: JSON.stringify({ responseFormat: 'json' }) });
           return rows.groupSum(rows.of(out), 'Region', 'Sales');`,
  });
  assert.ok(res.result.East.total > 0);
  assert.equal(res.result.East.skipped, 0);
});

test('an unfinished org-wide search refuses to claim absence', async () => {
  // Verified live: covering 25 of 81 workspaces before the budget ran out
  // must not be reported as "no such view". A false negative is as damaging
  // as a substitution — the user is told their data is missing when it is not.
  const res = await client.callTool({
    name: 'run_analytics_code',
    arguments: {
      // budgetMs 0 forces the deadline to bite after the first workspace.
      code: `const sweep = await find.views('zzz-nothing', { exhaustive: true, budgetMs: 0 });
             return { complete: sweep.complete, searched: sweep.searchedWorkspaces,
                      total: sweep.totalWorkspaces };`,
    },
  });
  const out = JSON.parse(res.content[0].text).result;
  assert.equal(out.complete, false, 'a deadline-stopped sweep is not complete');
  assert.ok(out.searched < out.total, `searched ${out.searched} of ${out.total}`);
});

test('a complete org-wide search does report absence definitively', async () => {
  const res = await client.callTool({
    name: 'run_analytics_code',
    arguments: { code: `return await find.require('view', null, 'zzz-definitely-nothing');` },
  });
  assert.equal(res.isError, true);
  const text = res.content[0].text;
  assert.match(text, /STOPPED: no view matching/);
  assert.match(text, /Searched all \d+ of \d+ workspaces/,
    'a definitive absence must state that everything was searched');
});

test('the knowledge bundle records where it came from and how old it is', async () => {
  // The OKF tree is generated outside this repo, so the bundle is a copy of a
  // snapshot. Without provenance a stale copy is indistinguishable from a
  // current one, and nothing would ever say so.
  const { Knowledge } = await import('../src/knowledge.mjs');
  const k = new Knowledge(new URL('../knowledge/knowledge.json', import.meta.url).pathname);
  const p = k.provenance;
  assert.ok(p.okfGeneratedAt, 'must record when the OKF snapshot was generated');
  assert.ok(p.okfVersion, 'must record the OKF version');
  assert.equal(typeof p.ageDays, 'number');
  assert.equal(typeof p.stale, 'boolean');
});

test('the bundle records that it came from the published OKF repository', async () => {
  // The OKF bundle is published at github.com/zoho/analytics-okf and is the
  // source of truth; a local checkout is only correct while it is in sync.
  // Recording provenance is what makes a stale bundle detectable at all.
  const { Knowledge } = await import('../src/knowledge.mjs');
  const k = new Knowledge(new URL('../knowledge/knowledge.json', import.meta.url).pathname);
  const p = k.provenance;
  assert.equal(p.repository, 'https://github.com/zoho/analytics-okf');
  assert.ok(p.okfGeneratedAt, 'must record when the OKF bundle was generated');
  assert.ok(p.okfVersion, 'must record the OKF bundle version');
  assert.equal(typeof p.ageDays, 'number');
  assert.equal(typeof p.stale, 'boolean');
});

test('the manual registers despite carrying a provenance block', async () => {
  // Regression: the build records where the specs came from, but UTCP's
  // manual schema rejects any unrecognised top-level key — adding `source`
  // to the file made registration silently yield 0 tools and the server
  // refuse to start. Provenance must stay in the file and out of the payload.
  const res = await call('run_analytics_code', {
    code: `return Object.keys(za).length;`,
  });
  assert.ok(res.result > 0, 'operations must be bound in the sandbox');
});
