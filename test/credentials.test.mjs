/**
 * Credential resolution.
 *
 * The point of all this is that an MCP client's config file — plain text,
 * routinely pasted into chats, sometimes committed — should not have to hold
 * a standing refresh token.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveCredentials, keychainAvailable, keychainUnavailableReason,
} from '../src/credentials.mjs';

const ENV_CREDS = {
  ANALYTICS_CLIENT_ID: 'cid', ANALYTICS_CLIENT_SECRET: 'secret',
  ANALYTICS_REFRESH_TOKEN: 'rt', ANALYTICS_ORG_ID: '55511666',
};

test('environment variables win, so containers and CI keep working', async () => {
  const r = await resolveCredentials(ENV_CREDS);
  assert.equal(r.source, 'environment');
  assert.equal(r.values.clientId, 'cid');
  assert.deepEqual(r.problems, []);
});

test('a static access token alone is accepted for a short test', async () => {
  const r = await resolveCredentials({ ANALYTICS_ACCESS_TOKEN: 't', ANALYTICS_ORG_ID: '1' });
  assert.equal(r.source, 'environment');
  assert.equal(r.values.accessToken, 't');
});

test('a credential command is run and its JSON used', async () => {
  const payload = JSON.stringify({
    clientId: 'from-helper', clientSecret: 's', refreshToken: 'r', orgId: '9',
    analyticsUrl: 'https://analyticsapi.zoho.eu',
  });
  const r = await resolveCredentials({
    ZA_CREDENTIAL_COMMAND: `printf '%s' '${payload}'`,
  });
  assert.match(r.source, /^command:/);
  assert.equal(r.values.clientId, 'from-helper');
  assert.equal(r.values.analyticsUrl, 'https://analyticsapi.zoho.eu');
});

test('a credential command may emit the env-var spelling instead', async () => {
  const payload = JSON.stringify({
    ANALYTICS_CLIENT_ID: 'x', ANALYTICS_CLIENT_SECRET: 'y',
    ANALYTICS_REFRESH_TOKEN: 'z', ANALYTICS_ORG_ID: '7',
  });
  const r = await resolveCredentials({ ZA_CREDENTIAL_COMMAND: `printf '%s' '${payload}'` });
  assert.equal(r.values.clientId, 'x');
  assert.equal(r.values.orgId, '7');
});

test('a credential command that fails is reported, not swallowed', async () => {
  const r = await resolveCredentials({ ZA_CREDENTIAL_COMMAND: 'exit 3' });
  assert.equal(r.values.clientId, undefined);
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0], /ZA_CREDENTIAL_COMMAND failed/);
});

test('a credential command printing non-JSON says what it should print', async () => {
  const r = await resolveCredentials({ ZA_CREDENTIAL_COMMAND: 'echo not-json' });
  assert.match(r.problems[0], /must print a JSON object/);
});

test('with nothing configured, the message says how to fix it', async () => {
  const r = await resolveCredentials({ ZA_PROFILE: 'no-such-profile-xyz' });
  assert.equal(r.source, 'none');
  assert.match(r.problems[0], /login|keychain|ANALYTICS_CLIENT_ID/);
});

test('on Linux the session bus is a hard prerequisite, not a soft one', async () => {
  // Measured: without DBUS_SESSION_BUS_ADDRESS a write appears to succeed and
  // reads back in-process, but the entry is invisible everywhere else. Probing
  // the library therefore cannot be trusted; the prerequisite must be checked.
  if (process.platform !== 'linux') return;

  assert.equal(await keychainAvailable({}), false,
    'no session bus means no usable keychain');
  assert.match(keychainUnavailableReason({}), /DBUS_SESSION_BUS_ADDRESS/);
  assert.match(keychainUnavailableReason({}), /silently go nowhere/);
});

test('an unusable keychain is reported as such, not as "no credentials"', async () => {
  if (process.platform !== 'linux') return;
  const r = await resolveCredentials({ ZA_PROFILE: 'anything' });
  // With no bus address in the passed env, the reason must name the real cause.
  assert.match(r.problems[0], /keychain|DBUS_SESSION_BUS_ADDRESS/);
});

// ---------------------------------------------------------------------------
// A profile is a scope as well as a credential.
// ---------------------------------------------------------------------------

test('a profile carries its own tool groups and write permission', async () => {
  if (process.platform === 'linux' && !process.env.DBUS_SESSION_BUS_ADDRESS) return;
  const { saveToKeychain, readFromKeychain, deleteFromKeychain } =
    await import('../src/credentials.mjs');

  const profile = 'test-scope-profile';
  await saveToKeychain(profile, {
    clientId: 'c', clientSecret: 's', refreshToken: 'r', orgId: '1',
    analyticsUrl: 'https://analyticsapi.zoho.com',
    accountsUrl: 'https://accounts.zoho.com',
    domains: ['data-operations', 'views-management'], allowWrites: false,
  });

  try {
    const stored = await readFromKeychain(profile);
    assert.deepEqual(stored.domains, ['data-operations', 'views-management']);
    assert.equal(stored.allowWrites, false);

    // A spawned server inherits the session bus; the resolver checks the env
    // it is given, so the test must supply it too.
    const r = await resolveCredentials({
      ZA_PROFILE: profile,
      DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS,
    });
    assert.equal(r.source, `keychain:${profile}`);
    assert.deepEqual(r.values.domains, ['data-operations', 'views-management']);
  } finally {
    await deleteFromKeychain(profile);
  }
});

test('the environment can still narrow a profile without rewriting it', async () => {
  if (process.platform === 'linux' && !process.env.DBUS_SESSION_BUS_ADDRESS) return;
  const { saveToKeychain, deleteFromKeychain } = await import('../src/credentials.mjs');

  const profile = 'test-override-profile';
  await saveToKeychain(profile, {
    clientId: 'c', clientSecret: 's', refreshToken: 'r', orgId: '1',
    domains: [], allowWrites: true,
  });

  try {
    const r = await resolveCredentials({
      ZA_PROFILE: profile, ZA_DOMAINS: 'dsml', ZA_ALLOW_WRITES: 'false',
      DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS,
    });
    assert.deepEqual(r.values.domains, ['dsml'], 'ZA_DOMAINS must override the profile');
    assert.equal(r.values.allowWrites, false, 'ZA_ALLOW_WRITES must override the profile');
  } finally {
    await deleteFromKeychain(profile);
  }
});

test('the scope reaches the server config', async () => {
  const { loadConfig } = await import('../src/config.mjs');
  const cfg = await loadConfig({
    ...ENV_CREDS, ZA_DOMAINS: 'data-operations,dsml', ZA_ALLOW_WRITES: 'true',
  });
  assert.deepEqual(cfg.domains, ['data-operations', 'dsml']);
  assert.equal(cfg.allowWrites, true);
  assert.deepEqual(cfg.problems, []);
});

test('an unknown tool group is rejected with the valid list', async () => {
  const { loadConfig } = await import('../src/config.mjs');
  const cfg = await loadConfig({ ...ENV_CREDS, ZA_DOMAINS: 'data-operations,nonsense' });
  assert.equal(cfg.problems.length, 1);
  assert.match(cfg.problems[0], /Unknown API domain nonsense/);
  assert.match(cfg.problems[0], /views-management/);
});
