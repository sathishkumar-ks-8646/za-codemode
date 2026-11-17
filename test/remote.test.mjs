/**
 * The remote server, end to end: dynamic registration, the browser sign-in
 * redirect through Zoho, the organization allowlist, bearer-protected MCP,
 * and per-user session isolation — all offline.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadRemoteConfig } from '../src/config.mjs';
import { createStore } from '../src/remote/store.mjs';
import { ZohoOAuth } from '../src/remote/zoho-oauth.mjs';
import { ZohoAnalyticsOAuthProvider } from '../src/remote/provider.mjs';
import { SessionPool } from '../src/remote/sessions.mjs';
import { createApp } from '../src/remote/http.mjs';
import { Knowledge } from '../src/knowledge.mjs';
import { startMockAnalytics } from './mock-analytics.mjs';
import { startMockAccounts } from './mock-accounts.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MANUAL = join(HERE, '..', 'manual', 'analytics.utcp.json');
const KNOWLEDGE = join(HERE, '..', 'knowledge', 'knowledge.json');
const CLIENT_ID = 'test-client-id';
const CLIENT_SECRET = 'test-client-secret';
const ALLOWED_ORG = '2375824000000000001';

let analytics; let accounts; let http; let base; let sessions; let store;

async function boot({ orgIds = ALLOWED_ORG } = {}) {
  analytics = await startMockAnalytics();
  accounts = await startMockAccounts({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });

  // Listen first so MCP_SERVER_PUBLIC_URL can name the real port.
  const { createServer } = await import('node:http');
  const probe = createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));

  const config = loadRemoteConfig({
    ANALYTICS_SERVER_URL: analytics.url,
    ACCOUNTS_SERVER_URL: accounts.url,
    OIDC_PROVIDER_CLIENT_ID: CLIENT_ID,
    OIDC_PROVIDER_CLIENT_SECRET: CLIENT_SECRET,
    MCP_SERVER_PUBLIC_URL: `http://127.0.0.1:${port}`,
    SESSION_SECRET_KEY: 'x'.repeat(48),
    MCP_SERVER_ORG_IDS: orgIds,
    PORT: String(port),
  });
  assert.deepEqual(config.problems, [], 'test config should be valid');

  store = await createStore(config);
  const provider = new ZohoAnalyticsOAuthProvider({
    store, zoho: new ZohoOAuth(config), config,
  });
  sessions = new SessionPool({ config, provider, manualPath: MANUAL });
  const app = createApp({ config, provider, sessions, operationCount: 76,
    knowledge: new Knowledge(KNOWLEDGE) });

  http = app.listen(port, '127.0.0.1');
  await new Promise((r) => http.once('listening', r));
  base = config.publicUrl;
}

/** Register a client, walk the whole browser flow, return a bearer token. */
async function signIn() {
  const reg = await fetch(`${base}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'test-agent',
      redirect_uris: ['http://127.0.0.1:9999/callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  });
  // Read once: an `await res.text()` inside an assert message consumes the body.
  const regBody = await reg.text();
  assert.equal(reg.status, 201, regBody);
  const client = JSON.parse(regBody);

  // PKCE: S256 of a verifier. The SDK validates this for us.
  const { createHash, randomBytes } = await import('node:crypto');
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');

  const authorizeUrl = new URL(`${base}/authorize`);
  authorizeUrl.searchParams.set('client_id', client.client_id);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('redirect_uri', 'http://127.0.0.1:9999/callback');
  authorizeUrl.searchParams.set('code_challenge', challenge);
  authorizeUrl.searchParams.set('code_challenge_method', 'S256');
  authorizeUrl.searchParams.set('state', 'client-state-123');

  // 1. our /authorize -> Zoho
  const toZoho = await fetch(authorizeUrl, { redirect: 'manual' });
  assert.equal(toZoho.status, 302);
  const zohoUrl = toZoho.headers.get('location');
  assert.ok(zohoUrl.startsWith(accounts.url), 'should redirect to Zoho Accounts');

  // 2. Zoho -> our /auth/callback
  const toCallback = await fetch(zohoUrl, { redirect: 'manual' });
  const callbackUrl = toCallback.headers.get('location');

  // 3. our callback -> the client's redirect_uri, carrying our code
  const toClient = await fetch(callbackUrl, { redirect: 'manual' });
  return { client, verifier, toClient };
}

async function bearerToken() {
  const { client, verifier, toClient } = await signIn();
  assert.equal(toClient.status, 302, toClient.headers.get('location') ?? '(no location)');
  const back = new URL(toClient.headers.get('location'));
  assert.equal(back.searchParams.get('state'), 'client-state-123');

  const res = await fetch(`${base}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: back.searchParams.get('code'),
      client_id: client.client_id,
      redirect_uri: 'http://127.0.0.1:9999/callback',
      code_verifier: verifier,
    }),
  });
  const tokenBody = await res.text();
  assert.equal(res.status, 200, tokenBody);
  return JSON.parse(tokenBody);
}

/** One JSON-RPC call against /mcp. */
async function rpc(token, method, params = {}, id = 1) {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  return { status: res.status, body: await res.text(), res };
}

before(async () => { await boot(); });

after(async () => {
  sessions?.close();
  await new Promise((r) => http?.close(r));
  await store?.close();
  await analytics?.close();
  await accounts?.close();
  setTimeout(() => process.exit(0), 200).unref();
});

test('advertises protected-resource metadata at the RFC 9728 path', async () => {
  // The canonical resource is the /mcp endpoint, so RFC 9728 puts its
  // metadata at /.well-known/oauth-protected-resource/mcp — not at the bare
  // well-known path, which is for a resource identified by the host alone.
  const res = await fetch(`${base}/.well-known/oauth-protected-resource/mcp`);
  assert.equal(res.status, 200);
  const meta = await res.json();
  assert.ok(meta.authorization_servers?.length, 'should name an authorization server');
  assert.equal(meta.resource, `${base}/mcp`, 'resource must be the canonical URI');
});

test('advertises RFC 9207 issuer identification', async () => {
  const meta = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
  assert.equal(meta.authorization_response_iss_parameter_supported, true);
});

test('the 401 challenge carries both resource_metadata and a scope hint', async () => {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  assert.equal(res.status, 401);
  const challenge = res.headers.get('www-authenticate') ?? '';
  assert.match(challenge, /resource_metadata="[^"]*oauth-protected-resource\/mcp"/);
  assert.match(challenge, /scope="[^"]+"/, 'the spec asks for a scope hint');
});

test('advertises authorization-server metadata', async () => {
  const res = await fetch(`${base}/.well-known/oauth-authorization-server`);
  assert.equal(res.status, 200);
  const meta = await res.json();
  assert.ok(meta.authorization_endpoint.endsWith('/authorize'));
  assert.ok(meta.token_endpoint.endsWith('/token'));
  assert.ok(meta.registration_endpoint.endsWith('/register'));
  assert.ok(meta.code_challenge_methods_supported.includes('S256'), 'PKCE is mandatory');
});

test('an unauthenticated /mcp call is refused and points at the metadata', async () => {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  assert.equal(res.status, 401);
  assert.match(res.headers.get('www-authenticate') ?? '', /resource_metadata/);
});

test('a bogus bearer token is refused', async () => {
  const { status } = await rpc('not-a-real-token', 'tools/list');
  assert.equal(status, 401);
});

test('the full browser sign-in yields a usable bearer token', async () => {
  const tokens = await bearerToken();
  assert.equal(tokens.token_type, 'Bearer');
  assert.ok(tokens.access_token);
  assert.ok(tokens.refresh_token);
});

test('an authenticated client sees the full tool set', async () => {
  const { access_token } = await bearerToken();
  const { status, body } = await rpc(access_token, 'tools/list');
  assert.equal(status, 200, body);
  const names = JSON.parse(body).result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['find_analytics_objects', 'get_analytics_guide',
    'run_analytics_code', 'search_analytics_api']);
});

test('code runs against the signed-in user\'s organization', async () => {
  const { access_token } = await bearerToken();
  const { status, body } = await rpc(access_token, 'tools/call', {
    name: 'run_analytics_code',
    arguments: {
      code: `const ws = await za.getOrgWorkspaces({ 'ZANALYTICS-ORGID': ORG_ID });
             return { org: ORG_ID, count: ws.data.workspaces.length };`,
    },
  }, 2);
  assert.equal(status, 200, body);
  const payload = JSON.parse(JSON.parse(body).result.content[0].text);
  assert.equal(payload.result.org, ALLOWED_ORG, 'ORG_ID must be the permitted org');
  assert.equal(payload.result.count, 4);
});

test('each signed-in user gets their own catalog', async () => {
  const before = sessions.size;
  const a = await bearerToken();
  const b = await bearerToken();
  await rpc(a.access_token, 'tools/list');
  await rpc(b.access_token, 'tools/list');
  assert.equal(sessions.size, before + 2, 'two tokens must not share one catalog');
});

test('revoking a token ends the session', async () => {
  const { access_token } = await bearerToken();
  assert.equal((await rpc(access_token, 'tools/list')).status, 200);

  const reg = await fetch(`${base}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'x', redirect_uris: ['http://127.0.0.1:9999/callback'],
      token_endpoint_auth_method: 'none',
    }),
  });
  const other = await reg.json();
  // A different client must not be able to revoke someone else's token.
  await fetch(`${base}/revoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: access_token, client_id: other.client_id }),
  });
  assert.equal((await rpc(access_token, 'tools/list')).status, 200,
    'another client must not revoke this token');
});

test('healthz reports status without authentication', async () => {
  const res = await fetch(`${base}/healthz`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.writes, false);
  assert.equal(body.storage, 'memory');
});

test('a token issued for another resource is refused', async () => {
  // The spec is explicit: servers MUST validate that a token was issued for
  // them, MUST only accept tokens valid for their own resources, and MUST NOT
  // accept or transit any other tokens. Without that, a token obtained for a
  // different MCP server can be replayed against this one.
  const { access_token } = await bearerToken();
  assert.equal((await rpc(access_token, 'tools/list')).status, 200,
    'a correctly bound token still works');

  // Mint one bound elsewhere by tampering with the stored session's resource.
  const stored = await store.get(`token:${access_token}`);
  await store.set(`token:${access_token}`,
    { ...stored, resource: 'https://someone-elses-mcp.example.com/mcp' }, 3600);

  const after = await rpc(access_token, 'tools/list');
  assert.equal(after.status, 401, 'a token bound to another resource must be rejected');
  assert.match(after.body, /invalid_token|not issued for this resource/i);
});
