/**
 * End-to-end: drives the server over real MCP stdio, exactly as Claude Desktop
 * does, against the mock Analytics API.
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

let mock;
let client;

before(async () => {
  mock = await startMockAnalytics();
  client = new Client({ name: 'test-agent', version: '1.0' });
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
  // isolated-vm worker threads outlive a clean exit; see guide 05.
  setTimeout(() => process.exit(0), 200).unref();
});

test('exposes exactly the four tools', async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(),
    ['find_analytics_objects', 'get_analytics_guide',
     'run_analytics_code', 'search_analytics_api']);
});

test('search returns callable signatures, not the whole catalog', async () => {
  const res = await client.callTool({
    name: 'search_analytics_api',
    arguments: { task: 'export rows from a view with a filter', limit: 4 },
  });
  const text = res.content[0].text;
  assert.match(text, /await za\.exportDataView\(\{/);
  assert.ok(text.length < 4000, `signatures should stay small, got ${text.length} chars`);
});

test('runs a multi-step program and returns only the answer', async () => {
  const res = await client.callTool({
    name: 'run_analytics_code',
    arguments: {
      code: `
        const CRITERIA = '"Sales"."Region"=\\'East\\' and "Sales"."Date">=\\'2026-07-01\\'';
        const ws = await za.getOrgWorkspaces({ 'ZANALYTICS-ORGID': ORG_ID });
        const totals = {};
        for (const w of ws.data.workspaces) {
          const views = await za.getViews({
            'ZANALYTICS-ORGID': ORG_ID, 'workspace-id': w.workspaceId, CONFIG: '{}',
          });
          for (const v of views.data.views.filter((v) => v.viewName.includes('Sales'))) {
            const out = await za.exportDataView({
              'ZANALYTICS-ORGID': ORG_ID, 'workspace-id': w.workspaceId,
              'view-id': v.viewId,
              CONFIG: JSON.stringify({ responseFormat: 'json', criteria: CRITERIA }),
            });
            // rows.of handles the flat-array shape the real API returns;
            // rows.sum copes with formatted values like "$1,682.39".
            const list = rows.of(out);
            if (list.length) {
              totals[w.workspaceName] =
                (totals[w.workspaceName] ?? 0) + rows.sum(list, 'Sales').total;
            }
          }
        }
        return { totals, grandTotal: Object.values(totals).reduce((a, b) => a + b, 0) };
      `,
    },
  });

  const payload = JSON.parse(res.content[0].text);
  assert.deepEqual(payload.result.totals, { 'Sales Data': 64200, Marketing: 9900 });
  assert.equal(payload.result.grandTotal, 74100);
  assert.ok(payload.apiCalls >= 7, 'the sandbox should have made the calls');
  assert.ok(res.content[0].text.length < 300,
    'only the answer should come back, not the rows');
});

test('ORG_ID is predefined inside the sandbox', async () => {
  const res = await client.callTool({
    name: 'run_analytics_code', arguments: { code: 'return ORG_ID;' },
  });
  assert.equal(JSON.parse(res.content[0].text).result, ORG_ID);
});

test('the sandbox is sealed', async () => {
  const res = await client.callTool({
    name: 'run_analytics_code',
    arguments: {
      code: `return ['require','fetch','process','Buffer','XMLHttpRequest']
               .map((n) => n + '=' + typeof globalThis[n]);`,
    },
  });
  for (const entry of JSON.parse(res.content[0].text).result) {
    assert.match(entry, /=undefined$/, `${entry} must not be reachable from the sandbox`);
  }
});

test('write operations are hidden by default', async () => {
  const res = await client.callTool({
    name: 'run_analytics_code',
    arguments: { code: `return typeof za.createWorkspace;` },
  });
  assert.equal(JSON.parse(res.content[0].text).result, 'undefined');
});

test('a failed program returns an actionable error, not a stack trace', async () => {
  const res = await client.callTool({
    name: 'run_analytics_code', arguments: { code: 'return await za.noSuchOperation({});' },
  });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /search_analytics_api/);
});

test('the organization header and auth scheme reach the API correctly', async () => {
  // Regression: UTCP's `headers` map sends "{ZANALYTICS-ORGID}" literally, and
  // its api_key value verbatim. Both must come through as real values or every
  // call fails against live Analytics with 7111 / 8535.
  const seen = [];
  const original = mock.requests.length;

  await client.callTool({
    name: 'run_analytics_code',
    arguments: {
      code: `const ws = await za.getOrgWorkspaces({ 'ZANALYTICS-ORGID': ORG_ID });
             return ws.data.workspaces.length;`,
    },
  });

  seen.push(...mock.requests.slice(original));
  assert.ok(seen.includes('GET /restapi/v2/orgs/workspaces'),
    'the call must reach the API; a wrong org header is rejected with 7111');
});

test('the guide tool answers an exact topic id', async () => {
  const res = await client.callTool({
    name: 'get_analytics_guide', arguments: { topic: 'filter-criteria-syntax' },
  });
  assert.match(res.content[0].text, /# Filter criteria syntax/);
});

test('the guide tool answers a plain-language question', async () => {
  const res = await client.callTool({
    name: 'get_analytics_guide',
    arguments: { topic: 'how do I export a very large table' },
  });
  assert.match(res.content[0].text, /asynchronous|export job/i);
});

test('the guide tool explains an error code', async () => {
  const res = await client.callTool({
    name: 'get_analytics_guide', arguments: { topic: '8080' },
  });
  const text = res.content[0].text;
  assert.match(text, /# Error 8080/);
  assert.match(text, /CONFIG is not valid JSON/);
  assert.match(text, /Retryable:/);
});

test('an unknown topic lists what is available', async () => {
  const res = await client.callTool({
    name: 'get_analytics_guide', arguments: { topic: 'zzzz qqqq' },
  });
  assert.match(res.content[0].text, /Playbooks:/);
  assert.match(res.content[0].text, /References:/);
});

test('search points at the relevant playbook', async () => {
  const res = await client.callTool({
    name: 'search_analytics_api',
    arguments: { task: 'create an export job for a view and poll it', limit: 4 },
  });
  assert.match(res.content[0].text, /get_analytics_guide\("export-data-asynchronously"\)/);
});

test('search can be restricted to one API domain', async () => {
  const res = await client.callTool({
    name: 'search_analytics_api',
    arguments: { task: 'list things', domain: 'views-management', limit: 5 },
  });
  const text = res.content[0].text;
  assert.ok(!/\[(?!views-management)[a-z-]+(,|\])/.test(text),
    `every result should be in views-management:\n${text}`);
});

test('an execution error is annotated from the OKF error catalog', async () => {
  const res = await client.callTool({
    name: 'run_analytics_code',
    arguments: {
      // An organization this user cannot reach: the API answers 7103.
      code: `await za.getOrgWorkspaces({ 'ZANALYTICS-ORGID': '9999999999999999999' });`,
    },
  });
  assert.equal(res.isError, true);
  // The mock rejects an unknown org with 7103; its documented meaning and
  // resolution should be attached straight from the OKF catalog.
  assert.match(res.content[0].text, /Error 7103/);
  assert.match(res.content[0].text, /does not exist|not visible/i);
});
