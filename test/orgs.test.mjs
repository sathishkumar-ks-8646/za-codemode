/**
 * The organization allowlist — the access control the remote server exists to
 * enforce. A user whose Zoho account cannot reach any permitted organization
 * must be refused at sign-in, before any token is minted.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { loadRemoteConfig } from '../src/config.mjs';
import { createStore } from '../src/remote/store.mjs';
import { ZohoOAuth } from '../src/remote/zoho-oauth.mjs';
import { ZohoAnalyticsOAuthProvider } from '../src/remote/provider.mjs';
import { SessionPool } from '../src/remote/sessions.mjs';
import { createApp } from '../src/remote/http.mjs';
import { Knowledge } from '../src/knowledge.mjs';
import { startMockAnalytics } from './mock-analytics.mjs';
import { startMockAccounts } from './mock-accounts.mjs';

const KNOWLEDGE = new URL('../knowledge/knowledge.json', import.meta.url).pathname;

const open = [];
after(async () => {
  for (const close of open.reverse()) await close();
  setTimeout(() => process.exit(0), 200).unref();
});

async function harness({ orgIds }) {
  const analytics = await startMockAnalytics();
  const accounts = await startMockAccounts({ clientId: 'cid', clientSecret: 'sec' });
  open.push(analytics.close, accounts.close);

  const probe = createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));

  const config = loadRemoteConfig({
    ANALYTICS_SERVER_URL: analytics.url,
    ACCOUNTS_SERVER_URL: accounts.url,
    OIDC_PROVIDER_CLIENT_ID: 'cid',
    OIDC_PROVIDER_CLIENT_SECRET: 'sec',
    MCP_SERVER_PUBLIC_URL: `http://127.0.0.1:${port}`,
    SESSION_SECRET_KEY: 'y'.repeat(48),
    MCP_SERVER_ORG_IDS: orgIds,
  });
  assert.deepEqual(config.problems, []);

  const store = await createStore(config);
  const provider = new ZohoAnalyticsOAuthProvider({
    store, zoho: new ZohoOAuth(config), config,
  });
  const sessions = new SessionPool({ config, provider, manualPath: './manual/analytics.utcp.json' });
  const app = createApp({ config, provider, sessions, operationCount: 76,
    knowledge: new Knowledge(KNOWLEDGE) });
  const http = app.listen(port, '127.0.0.1');
  await new Promise((r) => http.once('listening', r));

  open.push(() => { sessions.close(); return new Promise((r) => http.close(r)); });
  open.push(() => store.close());
  return { base: config.publicUrl };
}

/** Walk the browser flow as far as our /auth/callback and return that response. */
async function signInUpTo(base) {
  const reg = JSON.parse(await (await fetch(`${base}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 't', redirect_uris: ['http://127.0.0.1:9999/cb'],
      token_endpoint_auth_method: 'none',
    }),
  })).text());

  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const url = new URL(`${base}/authorize`);
  url.searchParams.set('client_id', reg.client_id);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', 'http://127.0.0.1:9999/cb');
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');

  const toZoho = await fetch(url, { redirect: 'manual' });
  const toCallback = await fetch(toZoho.headers.get('location'), { redirect: 'manual' });
  return fetch(toCallback.headers.get('location'), { redirect: 'manual' });
}

test('a permitted organization signs in', async () => {
  const { base } = await harness({ orgIds: '2375824000000000001' });
  const res = await signInUpTo(base);
  assert.equal(res.status, 302, 'should redirect back to the client with a code');
  assert.ok(new URL(res.headers.get('location')).searchParams.get('code'));
});

test('an organization the user cannot reach is denied, and no token is issued', async () => {
  // The mock Analytics API only answers for orgs it knows; an allowlist naming
  // a different org means this user has access to none of them.
  const { base } = await harness({ orgIds: '9999999999999999999' });
  const res = await signInUpTo(base);

  assert.equal(res.status, 400, 'sign-in must fail');
  const body = await res.text();
  assert.match(body, /does not have access to any organization/);
  assert.match(body, /MCP_SERVER_ORG_IDS/, 'should tell the user what the admin must change');
  assert.ok(!res.headers.get('location'), 'no authorization code may be returned');
});

test('the allowlist accepts several organizations', async () => {
  const { base } = await harness({
    orgIds: ' 9999999999999999999 , 2375824000000000001 ',
  });
  const res = await signInUpTo(base);
  assert.equal(res.status, 302, 'membership of any one permitted org is enough');
});
