/**
 * Where credentials come from, and how they are protected at rest.
 *
 * The problem with putting them in an MCP client's config file is that
 * claude_desktop_config.json, .cursor/mcp.json and VS Code settings.json are
 * plain text, world-readable on most setups, routinely pasted into chats and
 * screenshots, and sometimes committed. A refresh token there is a standing
 * credential in a file nobody treats as a secret.
 *
 * An encrypted file is not the answer: this process is spawned by the agent
 * host with no terminal, so it can never prompt for a passphrase, and a key
 * stored beside the ciphertext protects nothing. The only key store that
 * works for a non-interactive process is the one the operating system already
 * unlocks with the user's login session.
 *
 * So, in order:
 *
 *   1. ANALYTICS_* environment variables — explicit wins, and containers and
 *      CI have no keychain. This is how the Docker image is configured.
 *   2. ZA_CREDENTIAL_COMMAND — run a command, read JSON from its stdout. The
 *      escape hatch for 1Password, Vault, Zoho Vault, or anything else.
 *   3. The OS keychain — macOS Keychain, Windows Credential Manager, Linux
 *      Secret Service. Written by `login`, referenced only by profile name.
 *
 * Whichever answered is reported, so nobody has to guess which credential a
 * running server is using.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export const KEYCHAIN_SERVICE = 'zoho-analytics-code-mode-mcp';
export { SCOPE_FIELDS };

/** The fields a complete credential set carries. */
const FIELDS = ['clientId', 'clientSecret', 'refreshToken', 'orgId',
  'analyticsUrl', 'accountsUrl'];

/**
 * A profile also carries its own tool scope — which API domains it may reach
 * and whether writes are permitted. Keeping that with the credential rather
 * than in the agent's config means a "sandbox" profile can be read-write
 * while "production" stays read-only, without anyone having to remember which
 * environment variables to set where.
 */
const SCOPE_FIELDS = ['domains', 'allowWrites'];

/**
 * The keyring binding is an optional dependency: there is no backend on a
 * headless Linux box or in a slim container, and those setups use environment
 * variables instead. Loading it lazily keeps the server startable either way.
 */
let keyringModule;
async function keyring() {
  if (keyringModule === undefined) {
    try {
      keyringModule = await import('@napi-rs/keyring');
    } catch {
      keyringModule = null;
    }
  }
  if (!keyringModule) {
    throw new Error(
      'No OS keychain available. On Linux this needs a Secret Service '
      + '(gnome-keyring or KWallet) on the session bus; headless hosts and '
      + 'containers should use environment variables or ZA_CREDENTIAL_COMMAND '
      + 'instead.');
  }
  return keyringModule;
}

/**
 * Why this does more than probe the library.
 *
 * Measured on Linux: with DBUS_SESSION_BUS_ADDRESS unset, a write "succeeds"
 * and reads back within the same process, but the entry is invisible to
 * everything else and gone next time — keyring-rs falls back to a store that
 * is not the Secret Service. A probe therefore reports a healthy keychain
 * while `login` quietly saves nothing durable, which is the worst possible
 * outcome for a credential command.
 *
 * So on Linux the session bus address is treated as a hard prerequisite,
 * because that is what the Secret Service actually needs. macOS and Windows
 * have a keystore tied to the login session with no such dependency.
 */
export async function keychainAvailable(env = process.env) {
  try {
    await keyring();
  } catch {
    return false;
  }

  if (process.platform === 'linux' && !env.DBUS_SESSION_BUS_ADDRESS) {
    return false;
  }

  try {
    const { Entry } = await keyring();
    new Entry(KEYCHAIN_SERVICE, '__probe__').getPassword();
    return true;
  } catch {
    return false;
  }
}

/** Why the keychain is unusable here, phrased for whoever has to fix it. */
export function keychainUnavailableReason(env = process.env) {
  if (process.platform === 'linux' && !env.DBUS_SESSION_BUS_ADDRESS) {
    return 'DBUS_SESSION_BUS_ADDRESS is not set. The Linux Secret Service lives '
      + 'on the session bus, and without it writes silently go nowhere. A process '
      + 'started outside your desktop session — over SSH, or from a bare systemd '
      + 'unit — will not have it.';
  }
  return 'No OS keychain backend answered. On Linux this needs gnome-keyring or '
    + 'KWallet running on the session bus.';
}

export async function saveToKeychain(profile, values) {
  const { Entry } = await keyring();
  new Entry(KEYCHAIN_SERVICE, profile).setPassword(JSON.stringify(values));
}

export async function readFromKeychain(profile) {
  const { Entry } = await keyring();
  const raw = new Entry(KEYCHAIN_SERVICE, profile).getPassword();
  return raw ? JSON.parse(raw) : null;
}

export async function deleteFromKeychain(profile) {
  const { Entry } = await keyring();
  return new Entry(KEYCHAIN_SERVICE, profile).deletePassword();
}

/** Run a credential helper and read a JSON credential set from its stdout. */
async function fromCommand(command) {
  const { stdout } = await run(process.platform === 'win32' ? 'cmd' : 'sh',
    process.platform === 'win32' ? ['/c', command] : ['-c', command],
    { timeout: 30_000, maxBuffer: 1 << 20 });

  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(
      'ZA_CREDENTIAL_COMMAND must print a JSON object on stdout with the keys '
      + FIELDS.join(', ') + `. Got: ${stdout.slice(0, 80)}`);
  }
  // Accept the environment-variable spelling too, so a helper can emit either.
  return {
    clientId: parsed.clientId ?? parsed.ANALYTICS_CLIENT_ID,
    clientSecret: parsed.clientSecret ?? parsed.ANALYTICS_CLIENT_SECRET,
    refreshToken: parsed.refreshToken ?? parsed.ANALYTICS_REFRESH_TOKEN,
    orgId: parsed.orgId ?? parsed.ANALYTICS_ORG_ID,
    analyticsUrl: parsed.analyticsUrl ?? parsed.ANALYTICS_SERVER_URL,
    accountsUrl: parsed.accountsUrl ?? parsed.ACCOUNTS_SERVER_URL,
  };
}

function scopeFromEnv(env) {
  const scope = {};
  if (env.ZA_DOMAINS !== undefined) {
    scope.domains = env.ZA_DOMAINS.split(',').map((d) => d.trim()).filter(Boolean);
  }
  if (env.ZA_ALLOW_WRITES !== undefined) {
    scope.allowWrites = ['true', '1', 'yes'].includes(env.ZA_ALLOW_WRITES);
  }
  return scope;
}

function fromEnv(env) {
  return {
    clientId: env.ANALYTICS_CLIENT_ID,
    clientSecret: env.ANALYTICS_CLIENT_SECRET,
    refreshToken: env.ANALYTICS_REFRESH_TOKEN,
    orgId: env.ANALYTICS_ORG_ID,
    analyticsUrl: env.ANALYTICS_SERVER_URL,
    accountsUrl: env.ACCOUNTS_SERVER_URL,
    accessToken: env.ANALYTICS_ACCESS_TOKEN,
    ...scopeFromEnv(env),
  };
}

const complete = (v) => Boolean(v?.clientId && v?.clientSecret && v?.refreshToken)
  || Boolean(v?.accessToken);

/**
 * Resolve credentials, reporting which source answered.
 *
 * Returns { source, values, problems }. `values` uses the internal field
 * names; config.mjs maps them onto its own shape.
 */
export async function resolveCredentials(env = process.env) {
  const profile = env.ZA_PROFILE || 'default';

  // 1. Explicit environment. Containers, CI, and the Docker image.
  const envValues = fromEnv(env);
  if (complete(envValues)) {
    return { source: 'environment', profile, values: envValues, problems: [] };
  }

  // 2. A credential helper.
  if (env.ZA_CREDENTIAL_COMMAND) {
    try {
      const values = await fromCommand(env.ZA_CREDENTIAL_COMMAND);
      if (complete(values)) {
        return { source: `command:${env.ZA_CREDENTIAL_COMMAND}`, profile, values,
          problems: [] };
      }
      return { source: 'command', profile, values, problems: [
        'ZA_CREDENTIAL_COMMAND ran but did not return clientId, clientSecret '
        + 'and refreshToken.'] };
    } catch (err) {
      return { source: 'command', profile, values: {}, problems: [
        `ZA_CREDENTIAL_COMMAND failed: ${err.message}`] };
    }
  }

  // 3. The OS keychain.
  //
  // Distinguish "the keychain has no entry for this profile" from "there is
  // no reachable keychain at all": they need completely different fixes, and
  // reporting the second as the first sends people hunting for a credential
  // they already stored. On Linux the usual cause is a missing
  // DBUS_SESSION_BUS_ADDRESS — the Secret Service lives on the session bus,
  // so a server launched outside the desktop session cannot see it.
  if (!(await keychainAvailable(env))) {
    return {
      source: 'none',
      profile,
      values: {},
      problems: [
        `No usable OS keychain: ${keychainUnavailableReason(env)} `
        + 'Use ANALYTICS_* environment variables or ZA_CREDENTIAL_COMMAND instead.',
      ],
    };
  }

  try {
    const stored = await readFromKeychain(profile);
    if (stored && complete(stored)) {
      // Environment still overrides individual non-secret fields, so one
      // stored credential can serve several organizations.
      // The stored profile supplies the defaults; the environment may still
      // override any single field, so one credential can serve several
      // organizations or be temporarily narrowed without being rewritten.
      return {
        source: `keychain:${profile}`,
        profile,
        values: {
          ...stored,
          orgId: env.ANALYTICS_ORG_ID ?? stored.orgId,
          analyticsUrl: env.ANALYTICS_SERVER_URL ?? stored.analyticsUrl,
          accountsUrl: env.ACCOUNTS_SERVER_URL ?? stored.accountsUrl,
          ...scopeFromEnv(env),
        },
        problems: [],
      };
    }
  } catch (err) {
    return { source: 'keychain', profile, values: {}, problems: [err.message] };
  }

  return {
    source: 'none',
    profile,
    values: {},
    problems: [
      `No credentials found for profile "${profile}". Run:\n`
      + '      npx zoho-analytics-code-mode-mcp login\n'
      + '    to store them in your operating system\'s keychain, or set '
      + 'ANALYTICS_CLIENT_ID / ANALYTICS_CLIENT_SECRET / ANALYTICS_REFRESH_TOKEN.',
    ],
  };
}
