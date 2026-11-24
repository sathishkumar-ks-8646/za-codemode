/**
 * Live verification of the data engine against a real organization.
 *
 * Not part of `npm test` — it needs credentials and a reachable Analytics
 * instance. Run it with a Postman environment file:
 *
 *     node tools/live-check.mjs ~/LOCAL_CORP.postman_environment.json
 *
 * It drives the real MCP server over stdio exactly as an agent host does, and
 * reports the bytes each strategy puts into the model's context, because that
 * number is the whole point of the engine and the only one a mock cannot
 * establish.
 */
import { readFileSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const envFile = process.argv[2];
if (!envFile) {
  console.error('usage: node tools/live-check.mjs <postman-environment.json>');
  process.exit(2);
}

const parsed = JSON.parse(readFileSync(envFile, 'utf8'));
const V = Object.fromEntries(parsed.values.map((v) => [v.key, v.value]));
const AUDIT_DIR = mkdtempSync(join(tmpdir(), 'za-live-'));

const client = new Client({ name: 'live-check', version: '1.0' });
await client.connect(new StdioClientTransport({
  command: process.execPath,
  args: [join(HERE, '..', 'src', 'server.mjs')],
  env: {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    ANALYTICS_SERVER_URL: `https://${V['analytics-domain']}`,
    ACCOUNTS_SERVER_URL: `https://${V['accounts-domain']}`,
    ANALYTICS_CLIENT_ID: V['client-id'],
    ANALYTICS_CLIENT_SECRET: V['client-secret'],
    ANALYTICS_REFRESH_TOKEN: V['refresh-token'],
    ANALYTICS_ORG_ID: V['organization-id'],
    // The API audit stream records the byte size of every outbound response,
    // which is the number this check exists to establish: what the pushdown
    // saves is paid for at the API, not only in the model's context.
    ZA_AUDIT: 'api',
    ZA_AUDIT_DIR: AUDIT_DIR,
    // A local Analytics build serves a certificate this Node does not trust.
    NODE_TLS_REJECT_UNAUTHORIZED: process.env.ZA_LIVE_INSECURE === 'true' ? '0' : '1',
  },
  stderr: 'inherit',
}));

const WS = V['workspace-id'];
const VIEW = V['view-id'];
const results = [];

/**
 * What the API has cost so far, read from the audit stream.
 *
 * Calls matter more than bytes: Analytics bills and rate-limits per request,
 * and the response body is never charged by volume. A change that trades
 * 2 KB of metadata for one fewer round trip is a win that a bytes-only
 * measurement would score as a regression.
 */
function apiCost() {
  const path = join(AUDIT_DIR, 'api.jsonl');
  if (!existsSync(path)) return { bytes: 0, calls: 0, ops: [] };
  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
  let bytes = 0;
  const ops = [];
  for (const line of lines) {
    try {
      const row = JSON.parse(line);
      bytes += row.bytes ?? 0;
      ops.push(row.op);
    } catch { /* a partially written line is simply not counted yet */ }
  }
  return { bytes, calls: ops.length, ops };
}

async function step(label, name, args) {
  const started = Date.now();
  const before = apiCost();
  const res = await client.callTool({ name, arguments: args });
  const text = res.content[0].text;
  // The audit writer is asynchronous; give it a moment to land.
  await new Promise((done) => setTimeout(done, 150));
  const after = apiCost();
  const row = {
    label,
    toModel: text.length,
    fromApi: Math.max(0, after.bytes - before.bytes),
    calls: Math.max(0, after.calls - before.calls),
    ops: after.ops.slice(before.calls),
    ms: Date.now() - started,
    failed: res.isError === true,
  };
  results.push(row);
  console.log(`\n── ${label}${row.failed ? '  [refused]' : ''} — ${row.toModel} bytes to the `
    + `model, ${row.calls} API calls, ${row.fromApi} bytes from the API, ${row.ms} ms`);
  console.log(text.length > 600 ? `${text.slice(0, 600)}…` : text);
  return { text, failed: row.failed };
}

// The table's own name, which the SQL path needs. Resolved through the engine
// rather than guessed, which is also the first assertion: an id must map to a
// name without the caller knowing it.
const named = await step('resolve the view id to its table name', 'run_analytics_code', {
  code: `return { table: await data.tableFor('${WS}', '${VIEW}') };`,
});
const viewName = JSON.parse(named.text).result?.table;
console.log(`\nusing view ${VIEW} ("${viewName}") in workspace ${WS}`);

// 1. The pattern this engine replaces: export the table, filter in the model.
await step('BASELINE export the table, filter in code', 'run_analytics_code', {
  code: `const out = await za.exportDataView({
    'ZANALYTICS-ORGID': ORG_ID, 'workspace-id': '${WS}', 'view-id': '${VIEW}',
    CONFIG: JSON.stringify({ responseFormat: 'json' }),
  });
  const all = rows.of(out);
  const west = all.filter((r) => r.Region === 'West');
  return { rows: west, scanned: all.length };`,
});

// 2. criteria pushdown: the same rows, but the server did the filtering.
await step('criteria pushed to the server', 'query_analytics_data', {
  workspaceId: WS, viewId: VIEW, filters: [{ column: 'Region', value: 'West' }],
});

// 3. criteria + projection.
await step('criteria + column projection', 'query_analytics_data', {
  workspaceId: WS, viewId: VIEW,
  filters: [{ column: 'Region', value: 'West' }, { column: 'Sales', op: 'gt', value: 1000 }],
  columns: ['Region', 'Sales'],
});

// 4. the answer itself, aggregated inside Analytics.
await step('aggregate inside Analytics', 'query_analytics_data', {
  workspaceId: WS, viewId: VIEW,
  groupBy: ['Region'], metrics: [{ fn: 'sum', column: 'Sales', as: 'Total' }],
});

// 5. how many rows match, without fetching any.
await step('count only', 'query_analytics_data', {
  workspaceId: WS, viewId: VIEW, mode: 'count',
  filters: [{ column: 'Region', value: 'West' }],
});

// 6. top N, pushed into the SQL.
await step('top 5 by sales', 'query_analytics_data', {
  workspaceId: WS, viewId: VIEW,
  columns: ['Product', 'Sales'], orderBy: [{ column: 'Sales', dir: 'desc' }], limit: 5,
});

// 7. preview, for learning the shape.
await step('preview', 'query_analytics_data', {
  workspaceId: WS, viewId: VIEW, mode: 'preview', limit: 5,
});

// 8. a filter naming a column that does not exist must be refused, not dropped.
await step('REFUSAL unknown column', 'query_analytics_data', {
  workspaceId: WS, viewId: VIEW, filters: [{ column: 'Revenue', value: 1 }],
});

// 9. a value containing an apostrophe must not break the expression.
await step('quoting an apostrophe', 'query_analytics_data', {
  workspaceId: WS, viewId: VIEW,
  filters: [{ column: 'Customer Name', op: 'contains', value: "O'" }],
  columns: ['Customer Name'], limit: 3, mode: 'view',
});

// 10. a write dressed as a read must be refused.
await step('REFUSAL non-SELECT', 'query_analytics_data', {
  workspaceId: WS, sql: `DELETE FROM "${viewName}"`,
});

// 11. the same engine from inside generated code.
await step('data.* from run_analytics_code', 'run_analytics_code', {
  code: `const table = await data.tableFor('${WS}', '${VIEW}');
    const count = await data.count({ workspaceId: '${WS}', table });
    const top = await data.query({
      workspaceId: '${WS}', table,
      groupBy: ['Region'], metrics: [{ fn: 'sum', column: 'Sales', as: 'Total' }],
      orderBy: [{ column: 'Total', dir: 'desc' }], limit: 3,
    });
    return { totalRows: count.rowCount, byRegion: top.rows };`,
});

console.log('\n\n=== cost of the same question, by strategy ===');
const baseline = results.find((r) => r.label.startsWith('BASELINE'));
const pct = (value, of) => (of && value < of ? `-${(100 - (value / of) * 100).toFixed(1)}%` : '');
console.log('  to model  calls   from API      ms   strategy');
for (const r of results) {
  console.log(
    `${String(r.toModel).padStart(10)} ${String(r.calls).padStart(6)} `
    + `${String(r.fromApi).padStart(10)} ${String(r.ms).padStart(7)}   ${r.label}`
    + (baseline && r !== baseline
      ? `  [model ${pct(r.toModel, baseline.toModel) || '+'}]`
      : ''));
}
console.log(`\ntotals: ${results.reduce((n, r) => n + r.calls, 0)} API calls, `
  + `${results.reduce((n, r) => n + r.toModel, 0)} bytes to the model`);
console.log(`audit stream: ${AUDIT_DIR}/api.jsonl`);

await client.close().catch(() => {});
setTimeout(() => process.exit(0), 200).unref();
