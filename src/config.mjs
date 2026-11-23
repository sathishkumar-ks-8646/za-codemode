/**
 * Environment parsing, with errors a user can act on.
 *
 * A misconfigured stdio server fails invisibly - the host reports only
 * "server failed to start" - so every problem detectable at boot is reported
 * here, in full, before anything else runs.
 */
import { DOMAINS } from './catalog.mjs';
import { resolveCredentials } from './credentials.mjs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DC_HINTS = [
  ['https://analyticsapi.zoho.com', 'https://accounts.zoho.com', 'US'],
  ['https://analyticsapi.zoho.eu', 'https://accounts.zoho.eu', 'EU'],
  ['https://analyticsapi.zoho.in', 'https://accounts.zoho.in', 'IN'],
  ['https://analyticsapi.zoho.com.au', 'https://accounts.zoho.com.au', 'AU'],
  ['https://analyticsapi.zoho.jp', 'https://accounts.zoho.jp', 'JP'],
  ['https://analyticsapi.zohocloud.ca', 'https://accounts.zohocloud.ca', 'CA'],
  ['https://analyticsapi.zoho.sa', 'https://accounts.zoho.sa', 'SA'],
];

/**
 * Parse a comma-separated domain list from the environment.
 *
 * Remote mode is configured entirely by environment, so it needs the string
 * form; local mode takes the list from the stored profile and only validates.
 */
function parseDomains(raw, problems) {
  if (!raw) return [];
  return validateDomains(
    raw.split(',').map((d) => d.trim()).filter(Boolean), problems);
}

/** Check a domain list against the known set. An empty list means all of them. */
function validateDomains(names, problems) {
  if (!names?.length) return [];
  const unknown = names.filter((n) => !(n in DOMAINS));
  if (unknown.length) {
    problems.push(`Unknown API ${unknown.length === 1 ? 'domain' : 'domains'} `
      + `${unknown.join(', ')}. Valid: ${Object.keys(DOMAINS).join(', ')}.`);
  }
  return names.filter((n) => n in DOMAINS);
}

/**
 * Audit logging settings.
 *
 * Defaults differ by server type because the workloads do. Measured on this
 * server's own records, an API line is ~270 bytes and an execution record
 * ~1.4 KB:
 *
 *   local   one person, tens of programs a day. 5 x 10 MB per stream is
 *           years of history and 100 MB on disk.
 *   remote  a team, and an operator who wants it in a collector. 10 x 10 MB
 *           per stream, plus JSON Lines on stdout by default.
 *
 * Every value is overridable. Secrets are redacted unless an operator turns
 * that off deliberately.
 */
function parseAudit(env, mode, problems) {
  const fileMb = Number(env.ZA_AUDIT_MAX_FILE_MB ?? 10);
  const defaultFiles = mode === 'remote' ? 10 : 5;

  // off  — nothing written
  // api  — stream A only: what this server did to Zoho
  // full — both streams, including the program that ran
  const streams = (env.ZA_AUDIT ?? 'api').toLowerCase();
  if (!['off', 'api', 'full'].includes(streams)) {
    problems.push(`ZA_AUDIT must be "off", "api" or "full", got "${env.ZA_AUDIT}".`);
  }

  if (!Number.isFinite(fileMb) || fileMb <= 0) {
    problems.push(`ZA_AUDIT_MAX_FILE_MB must be a positive number, got "${env.ZA_AUDIT_MAX_FILE_MB}".`);
  }

  const apiMaxFiles = Number(env.ZA_AUDIT_API_FILES ?? env.ZA_AUDIT_MAX_FILES ?? defaultFiles);
  const detailMaxFiles = Number(env.ZA_AUDIT_DETAIL_FILES ?? env.ZA_AUDIT_MAX_FILES ?? defaultFiles);
  for (const [name, value] of [['ZA_AUDIT_API_FILES', apiMaxFiles],
    ['ZA_AUDIT_DETAIL_FILES', detailMaxFiles]]) {
    if (!Number.isInteger(value) || value < 1) {
      problems.push(`${name} must be a whole number of at least 1, got "${value}".`);
    }
  }

  const logSecrets = bool(env.ZA_AUDIT_LOG_SECRETS, false);
  if (logSecrets) {
    problems.push('ZA_AUDIT_LOG_SECRETS is enabled. Access tokens and client secrets '
      + 'will be written to disk in clear text. This is for debugging a single '
      + 'machine, never for a deployment.');
  }

  return {
    streams,
    dir: env.ZA_AUDIT_DIR ?? join(homedir(), '.zoho-analytics-code-mode', 'audit'),
    maxFileBytes: Math.round(fileMb * 1e6),
    apiMaxFiles,
    detailMaxFiles,
    // The program a model wrote is the record that answers "what did it do",
    // so it is on by default — but it can carry business data in a criteria
    // string, which is why the whole stream is opt-in.
    logCode: bool(env.ZA_AUDIT_LOG_CODE, true),
    logArguments: bool(env.ZA_AUDIT_LOG_ARGS, true),
    logSecrets,
    chain: bool(env.ZA_AUDIT_HASH_CHAIN, true),
    // Only honoured by the remote server: stdout is the protocol channel for
    // a stdio one.
    stdout: bool(env.ZA_AUDIT_STDOUT, mode === 'remote'),
  };
}

function bool(value, fallback) {
  if (value === undefined) return fallback;
  return value === 'true' || value === '1' || value === 'yes';
}

/**
 * Config for the local stdio server.
 *
 * Credentials come from the resolver — environment, credential command, or the
 * OS keychain — so the agent's config file need not hold any secret. See
 * credentials.mjs for why an encrypted file is not an option here.
 */
export async function loadConfig(env = process.env) {
  const problems = [];

  const credentials = await resolveCredentials(env);
  problems.push(...credentials.problems);
  const cred = credentials.values ?? {};

  const analyticsUrl = cred.analyticsUrl ?? 'https://analyticsapi.zoho.com';
  const accountsUrl = cred.accountsUrl ?? 'https://accounts.zoho.com';

  // A mismatched pair is the single most common setup mistake: the token is
  // minted in one data centre and spent in another, and the only symptom is a
  // confusing 8535 on the first call.
  const aDc = DC_HINTS.find(([a]) => analyticsUrl.startsWith(a))?.[2];
  const cDc = DC_HINTS.find(([, c]) => accountsUrl.startsWith(c))?.[2];
  if (aDc && cDc && aDc !== cDc) {
    problems.push(
      `ANALYTICS_SERVER_URL looks like the ${aDc} data centre but ACCOUNTS_SERVER_URL `
      + `looks like ${cDc}. Both must name the same one.`);
  }

  if (!cred.orgId) {
    problems.push('No organization ID. Run `npx zoho-analytics-codemode login`, '
      + 'or set ANALYTICS_ORG_ID. Find the ID in the Analytics UI under '
      + 'Settings > Organization.');
  }

  const maxToolCalls = Number(env.ZA_MAX_TOOL_CALLS ?? 200);
  if (!Number.isFinite(maxToolCalls) || maxToolCalls < 1) {
    problems.push(`ZA_MAX_TOOL_CALLS must be a positive number, got "${env.ZA_MAX_TOOL_CALLS}".`);
  }

  return {
    analyticsUrl,
    accountsUrl,
    credentialSource: credentials.source,
    profile: credentials.profile,
    orgId: cred.orgId ?? '',
    clientId: cred.clientId,
    clientSecret: cred.clientSecret,
    refreshToken: cred.refreshToken,
    staticToken: cred.accessToken,
    // Scope comes from the profile unless the environment overrides it.
    allowWrites: cred.allowWrites ?? false,
    domains: validateDomains(cred.domains ?? [], problems),
    maxToolCalls,
    // Pacing, so a loop in generated code does not trip the API frequency
    // limit. Measured need: an 81-workspace sweep trips it unspaced.
    minCallIntervalMs: Number(env.ZA_MIN_CALL_INTERVAL_MS ?? 50),
    // Measured safe rate on a real org: 53/min ran clean, 105/min tripped.
    maxCallsPerMinute: Number(env.ZA_MAX_CALLS_PER_MINUTE ?? 55),
    throttleRetries: Number(env.ZA_THROTTLE_RETRIES ?? 3),
    timeoutMs: Number(env.ZA_EXEC_TIMEOUT_MS ?? 60_000),
    memoryLimitMb: Number(env.ZA_EXEC_MEMORY_MB ?? 256),
    audit: parseAudit(env, 'local', problems),
    problems,
  };
}


/**
 * Config for the remote, multi-user server.
 *
 * Variable names deliberately mirror the self-hosted Zoho Analytics Remote MCP
 * Server, so an operator who has deployed that one can reuse their `.env`.
 */
export function loadRemoteConfig(env = process.env) {
  const problems = [];

  const analyticsUrl = env.ANALYTICS_SERVER_URL;
  if (!analyticsUrl) problems.push('ANALYTICS_SERVER_URL is required, e.g. https://analyticsapi.zoho.com');

  // Not in the reference variable set: derived from the API host so operators
  // only name their data centre once, and overridable when that guess is wrong.
  const accountsUrl = env.ACCOUNTS_SERVER_URL
    ?? (analyticsUrl ? deriveAccountsUrl(analyticsUrl) : undefined);
  if (analyticsUrl && !accountsUrl) {
    problems.push(`Cannot derive the accounts host from ANALYTICS_SERVER_URL=${analyticsUrl}. `
      + 'Set ACCOUNTS_SERVER_URL explicitly.');
  }

  for (const key of ['OIDC_PROVIDER_CLIENT_ID', 'OIDC_PROVIDER_CLIENT_SECRET',
    'MCP_SERVER_PUBLIC_URL', 'SESSION_SECRET_KEY', 'MCP_SERVER_ORG_IDS']) {
    if (!env[key]) problems.push(`${key} is required.`);
  }

  const publicUrl = (env.MCP_SERVER_PUBLIC_URL ?? '').replace(/\/+$/, '');
  if (publicUrl && !/^https?:\/\//.test(publicUrl)) {
    problems.push('MCP_SERVER_PUBLIC_URL must be a fully qualified URL.');
  }
  if (publicUrl.startsWith('http://') && !/^http:\/\/(localhost|127\.0\.0\.1)/.test(publicUrl)) {
    problems.push('MCP_SERVER_PUBLIC_URL must use https outside localhost — OAuth '
      + 'redirects and bearer tokens must not travel in clear text.');
  }

  const sessionSecret = env.SESSION_SECRET_KEY ?? '';
  if (sessionSecret && sessionSecret.length < 32) {
    problems.push('SESSION_SECRET_KEY must be at least 32 characters. Generate one with '
      + '`openssl rand -base64 48`.');
  }

  const orgIds = (env.MCP_SERVER_ORG_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (env.MCP_SERVER_ORG_IDS && !orgIds.length) {
    problems.push('MCP_SERVER_ORG_IDS is set but contains no organization IDs.');
  }

  const storageBackend = env.STORAGE_BACKEND ?? 'memory';
  if (!['memory', 'redis'].includes(storageBackend)) {
    problems.push(`STORAGE_BACKEND must be "memory" or "redis", got "${storageBackend}".`);
  }
  if (storageBackend === 'redis' && !env.REDIS_HOST) {
    problems.push('STORAGE_BACKEND=redis requires REDIS_HOST.');
  }
  if (storageBackend === 'memory' && env.REPLICAS && Number(env.REPLICAS) > 1) {
    problems.push('STORAGE_BACKEND=memory cannot serve more than one replica: a token '
      + 'minted by one instance is unknown to the others. Use redis.');
  }

  return {
    analyticsUrl,
    accountsUrl,
    oidcClientId: env.OIDC_PROVIDER_CLIENT_ID,
    oidcClientSecret: env.OIDC_PROVIDER_CLIENT_SECRET,
    publicUrl,
    // Canonical RFC 8707 resource identifier: the endpoint, not the host.
    resourceUrl: publicUrl ? `${publicUrl}/mcp` : undefined,
    sessionSecret,
    orgIds,
    port: Number(env.PORT ?? 4000),
    // Number of reverse proxies in front of this server. Must be exact: too
    // high and clients can spoof their IP past the rate limiter.
    trustProxyHops: Number(env.TRUST_PROXY_HOPS ?? 1),
    storageBackend,
    redisHost: env.REDIS_HOST,
    redisPort: Number(env.REDIS_PORT ?? 6379),
    redisPassword: env.REDIS_PASSWORD,
    allowWrites: bool(env.ZA_ALLOW_WRITES, false),
    domains: parseDomains(env.ZA_DOMAINS, problems),
    maxToolCalls: Number(env.ZA_MAX_TOOL_CALLS ?? 200),
    // Pacing, so a loop in generated code does not trip the API frequency
    // limit. Measured need: an 81-workspace sweep trips it unspaced.
    minCallIntervalMs: Number(env.ZA_MIN_CALL_INTERVAL_MS ?? 50),
    // Measured safe rate on a real org: 53/min ran clean, 105/min tripped.
    maxCallsPerMinute: Number(env.ZA_MAX_CALLS_PER_MINUTE ?? 55),
    throttleRetries: Number(env.ZA_THROTTLE_RETRIES ?? 3),
    timeoutMs: Number(env.ZA_EXEC_TIMEOUT_MS ?? 60_000),
    memoryLimitMb: Number(env.ZA_EXEC_MEMORY_MB ?? 256),
    maxSessions: Number(env.ZA_MAX_SESSIONS ?? 100),
    sessionIdleMs: Number(env.ZA_SESSION_IDLE_MS ?? 30 * 60_000),
    audit: parseAudit(env, 'remote', problems),
    problems,
  };
}

function deriveAccountsUrl(analyticsUrl) {
  const match = DC_HINTS.find(([api]) => analyticsUrl.startsWith(api));
  return match?.[1];
}
