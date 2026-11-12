/**
 * Access-token caching.
 *
 * Mirrors the rules in za-cli's TokenCache.java: a version envelope, binding
 * to the credential that minted the token, an expiry skew, a lifetime clamp,
 * and "any problem is a cache miss, never an error".
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadCachedToken, saveCachedToken, clearCachedToken,
} from '../src/token-cache.mjs';

const PROFILE = 'test-token-cache';
const KEY = {
  profile: PROFILE,
  clientId: 'client-one',
  analyticsUrl: 'https://analyticsapi.zoho.com',
};

const usable = process.platform !== 'linux' || Boolean(process.env.DBUS_SESSION_BUS_ADDRESS);

after(async () => { await clearCachedToken(PROFILE); });

test('a saved token is returned with its remaining life', async () => {
  if (!usable) return;
  await saveCachedToken({ ...KEY, accessToken: 'tok-a', expiresInSeconds: 3600 });
  const hit = await loadCachedToken(KEY);
  assert.equal(hit.accessToken, 'tok-a');
  assert.ok(hit.secondsLeft > 3400 && hit.secondsLeft <= 3600, `got ${hit?.secondsLeft}`);
});

test('a token minted for a different client is never reused', async () => {
  if (!usable) return;
  await saveCachedToken({ ...KEY, accessToken: 'tok-b', expiresInSeconds: 3600 });
  assert.equal(await loadCachedToken({ ...KEY, clientId: 'client-two' }), null,
    'reusing it would fail with 8535 and look like a config problem');
});

test('a token minted against another data centre is never reused', async () => {
  if (!usable) return;
  await saveCachedToken({ ...KEY, accessToken: 'tok-c', expiresInSeconds: 3600 });
  assert.equal(
    await loadCachedToken({ ...KEY, analyticsUrl: 'https://analyticsapi.zoho.eu' }), null);
});

test('a token inside the expiry skew is treated as expired', async () => {
  if (!usable) return;
  // 60s is under the 120s skew, so it must not be handed out.
  await saveCachedToken({ ...KEY, accessToken: 'tok-d', expiresInSeconds: 60 });
  assert.equal(await loadCachedToken(KEY), null);
});

test('an absurd lifetime is clamped rather than trusted', async () => {
  if (!usable) return;
  // Zoho returns expires_in in MILLISECONDS (3600000) beside expires_in_sec.
  // Trusting it would pin a dead token in the cache for six weeks.
  await saveCachedToken({ ...KEY, accessToken: 'tok-e', expiresInSeconds: 3_600_000 });
  const hit = await loadCachedToken(KEY);
  assert.ok(hit.secondsLeft <= 86_400, `clamped to ${hit?.secondsLeft}s`);
});

test('a missing lifetime falls back to an hour', async () => {
  if (!usable) return;
  await saveCachedToken({ ...KEY, accessToken: 'tok-f', expiresInSeconds: 0 });
  const hit = await loadCachedToken(KEY);
  assert.ok(hit.secondsLeft > 3400 && hit.secondsLeft <= 3600);
});

test('clearing forgets the token', async () => {
  if (!usable) return;
  await saveCachedToken({ ...KEY, accessToken: 'tok-g', expiresInSeconds: 3600 });
  await clearCachedToken(PROFILE);
  assert.equal(await loadCachedToken(KEY), null);
});

test('incomplete arguments are a miss, not a crash', async () => {
  assert.equal(await loadCachedToken({ profile: PROFILE }), null);
  assert.equal(await loadCachedToken({}), null);
  assert.equal(await saveCachedToken({ profile: PROFILE }), false);
});
