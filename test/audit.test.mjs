/**
 * Audit logging.
 *
 * Two streams, size-bounded, redacted by default. The properties that matter
 * are that secrets never reach disk, that the budget is actually enforced,
 * and that the two streams join.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAudit, redact, verifyChain } from '../src/audit.mjs';

const dirs = [];
function freshDir() {
  const dir = join(tmpdir(), `za-audit-${Math.random().toString(36).slice(2)}`);
  dirs.push(dir);
  return dir;
}
after(() => { for (const d of dirs) if (existsSync(d)) rmSync(d, { recursive: true }); });

const baseConfig = (dir, overrides = {}) => ({
  clientSecret: 'super-secret-value-123456',
  refreshToken: '1000.aaaabbbbccccdddd1111.2222333344445555',
  orgId: '55511666',
  audit: {
    streams: 'full', dir, maxFileBytes: 1_000_000,
    apiMaxFiles: 3, detailMaxFiles: 3,
    logCode: true, logArguments: true, logSecrets: false,
    chain: true, stdout: false,
    ...overrides,
  },
});

const readLines = (dir, name) =>
  readFileSync(join(dir, `${name}.jsonl`), 'utf8').trim().split('\n');

test('both streams are written and join on the request id', async () => {
  const dir = freshDir();
  const audit = await createAudit(baseConfig(dir));
  const req = audit.newRequest();

  audit.apiCall({ requestId: req, actor: 'local', org: '1', operation: 'getViews',
    method: 'GET', path: '/restapi/v2/workspaces/1/views', status: 200, ms: 12, bytes: 400 });
  audit.execution({ requestId: req, actor: 'local', org: '1', tool: 'run_analytics_code',
    code: 'return 1;', outcome: 'ok', ms: 30, apiCalls: 1 });
  await audit.flush();

  const api = JSON.parse(readLines(dir, 'api')[0]);
  const detail = JSON.parse(readLines(dir, 'detail')[0]);
  assert.equal(api.ev, 'api');
  assert.equal(detail.ev, 'execution');
  assert.equal(api.req, detail.req, 'the two streams must join on req');
});

test('every record carries when, where, who and what', async () => {
  const dir = freshDir();
  const audit = await createAudit(baseConfig(dir));
  audit.apiCall({ requestId: 'r1', actor: 'keychain:default', org: '55511666',
    operation: 'exportDataView', method: 'GET', path: '/x', status: 200, ms: 5, bytes: 10 });
  await audit.flush();

  const r = JSON.parse(readLines(dir, 'api')[0]);
  assert.match(r.ts, /^\d{4}-\d{2}-\d{2}T.*Z$/, 'RFC 3339 UTC');
  assert.ok(r.actor, 'who');
  assert.ok(r.op && r.ev, 'what');
  assert.ok(r.org, 'where');
});

test('secrets never reach disk, even inside the generated program', async () => {
  const dir = freshDir();
  const config = baseConfig(dir);
  const audit = await createAudit(config);

  audit.execution({
    requestId: 'r', actor: 'local', org: '1', tool: 'run_analytics_code',
    code: `const s = '${config.clientSecret}';\n`
      + `const t = '${config.refreshToken}';\n`
      + "fetch(x, { headers: { Authorization: 'Bearer 1000.abc123def456abc789.0011223344556677' } });",
    outcome: 'ok', ms: 1, apiCalls: 0,
  });
  await audit.flush();

  const raw = readFileSync(join(dir, 'detail.jsonl'), 'utf8');
  assert.ok(!raw.includes(config.clientSecret), 'client secret must not be logged');
  assert.ok(!raw.includes(config.refreshToken), 'refresh token must not be logged');
  assert.ok(!raw.includes('1000.abc123def456abc789'), 'bearer token must not be logged');
  assert.match(raw, /redacted/);
});

test('logging secrets is possible but never the default', async () => {
  const dir = freshDir();
  const config = baseConfig(dir, { logSecrets: true });
  const audit = await createAudit(config);
  audit.execution({ requestId: 'r', actor: 'l', org: '1', tool: 't',
    code: `x='${config.clientSecret}'`, outcome: 'ok', ms: 1, apiCalls: 0 });
  await audit.flush();
  assert.ok(readFileSync(join(dir, 'detail.jsonl'), 'utf8').includes(config.clientSecret),
    'an operator who opts in gets the raw value');
});

test('"api" keeps the detail stream off entirely', async () => {
  const dir = freshDir();
  const audit = await createAudit(baseConfig(dir, { streams: 'api' }));
  audit.apiCall({ requestId: 'r', actor: 'l', org: '1', operation: 'o',
    method: 'GET', path: '/p', status: 200, ms: 1, bytes: 1 });
  audit.execution({ requestId: 'r', actor: 'l', org: '1', tool: 't',
    code: 'secret business logic', outcome: 'ok', ms: 1, apiCalls: 1 });
  await audit.flush();

  assert.ok(existsSync(join(dir, 'api.jsonl')));
  assert.ok(!existsSync(join(dir, 'detail.jsonl')),
    'the sensitive stream must not be created when it was not asked for');
});

test('"off" writes nothing at all', async () => {
  const dir = freshDir();
  const audit = await createAudit(baseConfig(dir, { streams: 'off' }));
  assert.equal(audit.enabled, false);
  audit.apiCall({ requestId: 'r', actor: 'l', org: '1', operation: 'o',
    method: 'GET', path: '/p', status: 200, ms: 1, bytes: 1 });
  await audit.flush();
  assert.ok(!existsSync(dir));
});

test('the size budget is enforced by rotation', async () => {
  const dir = freshDir();
  // ~300 byte files, 3 of them: tiny, so rotation happens in a few writes.
  const audit = await createAudit(baseConfig(dir, { maxFileBytes: 300, apiMaxFiles: 3 }));
  for (let i = 0; i < 40; i += 1) {
    audit.apiCall({ requestId: `r${i}`, actor: 'local', org: '55511666',
      operation: 'exportDataView', method: 'GET',
      path: `/restapi/v2/workspaces/353000000133800${i}/views/1/data`,
      status: 200, ms: i, bytes: 1000 });
  }
  await audit.flush();

  const files = readdirSync(dir).filter((f) => f.startsWith('api'));
  assert.ok(files.length <= 4, `at most current + 3 backups, got ${files.join(', ')}`);
  assert.ok(files.includes('api.1.jsonl'), 'rotation must actually have happened');
  assert.ok(!files.includes('api.4.jsonl'), 'files past the limit must be deleted');
});

test('the hash chain detects an edited line', async () => {
  const dir = freshDir();
  const audit = await createAudit(baseConfig(dir));
  for (let i = 0; i < 5; i += 1) {
    audit.apiCall({ requestId: `r${i}`, actor: 'l', org: '1', operation: 'o',
      method: 'GET', path: '/p', status: 200, ms: i, bytes: 1 });
  }
  await audit.flush();

  const lines = readLines(dir, 'api');
  assert.equal(verifyChain(lines).ok, true, 'an untouched file verifies');

  // Someone quietly changes a status code.
  const tampered = [...lines];
  tampered[2] = tampered[2].replace('"status":200', '"status":403');
  const result = verifyChain(tampered);
  assert.equal(result.ok, false);
  assert.equal(result.line, 4, 'the break is detected at the line after the edit');
});

test('a deleted line is detected too', async () => {
  const dir = freshDir();
  const audit = await createAudit(baseConfig(dir));
  for (let i = 0; i < 4; i += 1) {
    audit.apiCall({ requestId: `r${i}`, actor: 'l', org: '1', operation: 'o',
      method: 'GET', path: '/p', status: 200, ms: i, bytes: 1 });
  }
  await audit.flush();

  const lines = readLines(dir, 'api');
  lines.splice(1, 1);
  assert.equal(verifyChain(lines).ok, false, 'removing a line must break the chain');
});

test('an unusable directory degrades the log, never the request', async () => {
  // A regular file where the directory should be: mkdir fails with ENOTDIR.
  // Losing an audit line is bad; failing the API call that just succeeded
  // would be worse, so the sink must fall back silently.
  const blocker = join(freshDir());
  const { mkdir, writeFile } = await import('node:fs/promises');
  await mkdir(blocker, { recursive: true });
  const asFile = join(blocker, 'not-a-dir');
  await writeFile(asFile, 'x');

  const audit = await createAudit(baseConfig(join(asFile, 'audit')));
  assert.equal(audit.enabled, false, 'falls back to a no-op sink');
  audit.apiCall({ requestId: 'r', actor: 'l', org: '1', operation: 'o',
    method: 'GET', path: '/p', status: 200, ms: 1, bytes: 1 });
  await audit.flush();   // must not throw
});

test('redact handles the token shapes Zoho actually emits', () => {
  const opts = { literals: ['my-literal-secret'], enabled: true };
  assert.ok(!redact('1000.aaaabbbbccccdddd1111.2222333344445555', opts).includes('aaaa'));
  assert.ok(!redact('Authorization: Zoho-oauthtoken 1000.xyz', opts).includes('1000.xyz'));
  assert.ok(!redact('refresh_token=1000.abc&x=1', opts).includes('1000.abc'));
  assert.ok(!redact('x my-literal-secret y', opts).includes('my-literal-secret'));
  assert.equal(redact('nothing sensitive', opts), 'nothing sensitive');
});

test('restarts and concurrent writers do not look like tampering', async () => {
  // One file legitimately holds lines from many processes: a local server is
  // respawned on every agent restart, and two agent hosts can run at once.
  // A chain that cried wolf on that would train people to ignore it.
  const dir = freshDir();
  for (let pass = 0; pass < 3; pass += 1) {
    const audit = await createAudit(baseConfig(dir, { streams: 'api' }));
    for (let i = 0; i < 3; i += 1) {
      audit.apiCall({ requestId: `p${pass}-${i}`, actor: 'l', org: '1',
        operation: 'getViews', method: 'GET', path: '/p', status: 200, ms: i, bytes: 1 });
    }
    await audit.flush();
  }

  const lines = readLines(dir, 'api');
  const result = verifyChain(lines);
  assert.equal(result.ok, true, 'three separate runs must verify');
  assert.equal(result.lines, 9);
  assert.equal(result.runs, 3, 'each process keeps its own chain');

  // An edit inside one run is still caught.
  const tampered = [...lines];
  tampered[4] = tampered[4].replace('"status":200', '"status":500');
  assert.equal(verifyChain(tampered).ok, false);
});
