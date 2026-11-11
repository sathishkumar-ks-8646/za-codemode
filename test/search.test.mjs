/**
 * Search quality. These assertions encode the failures measured against the
 * stock UTCP word-match strategy, so a regression in search.mjs is caught.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OperationSearch, expandQuery, renderSignatures } from '../src/search.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const manual = JSON.parse(
  readFileSync(join(HERE, '..', 'manual', 'analytics.utcp.json'), 'utf8'));

// A catalog stub: offline scoring only, no UTCP and no network.
const catalog = {
  allOperations: () => manual.tools.map((t) => ({
    name: t.name, description: t.description ?? '',
    inputs: t.inputs ?? { properties: {} }, tags: t.tags ?? [],
  })),
  searchRaw: async () => { throw new Error('offline'); },
};

const search = new OperationSearch(catalog);
const names = async (q, n = 8) => (await search.find(q, n)).map((o) => o.name);

test('API vocabulary resolves to the right operation', async () => {
  assert.ok((await names('export rows from a view')).includes('exportDataView'));
  assert.ok((await names('list views in a workspace')).includes('getViews'));
  assert.ok((await names('create an export job for a view')).includes('createExportJobViewId'));
});

test('user vocabulary is rewritten into API vocabulary', async () => {
  // Each of these returned unrelated operations under the stock strategy.
  for (const query of [
    'how much revenue did we make',
    'give me my sales numbers',
    'download the data',
    'total sales figures',
  ]) {
    const hits = await names(query);
    assert.ok(
      hits.some((n) => /export|Data/i.test(n)),
      `"${query}" should surface a data/export operation, got ${hits.slice(0, 3).join(', ')}`);
  }
});

test('synonyms expand but rank below literal terms', () => {
  const terms = expandQuery('revenue export');
  assert.equal(terms.get('export'), 1);
  assert.ok(terms.get('data') < 1, 'synonym weight must be below a literal hit');
});

test('stopwords are discarded', () => {
  const terms = expandQuery('what is the data in my workspace');
  for (const stop of ['what', 'is', 'the', 'in', 'my']) {
    assert.ok(!terms.has(stop), `"${stop}" should not be a search term`);
  }
});

test('an unmatchable query returns nothing rather than noise', async () => {
  assert.equal((await names('zzzz qqqq xxxx')).length, 0);
});

test('signatures render as callable TypeScript', async () => {
  const ops = await search.find('export rows from a view', 1);
  const out = renderSignatures(ops);
  assert.match(out, /await za\.\w+\(\{/);
  assert.match(out, /"ZANALYTICS-ORGID"/);
});
