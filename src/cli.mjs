/**
 * The credential CLI: login, logout, status.
 *
 * Run in a real terminal, where a TTY exists and a prompt is possible — which
 * is exactly what the spawned MCP server can never do. Secrets go into the OS
 * keychain, and the agent's config file ends up holding nothing but a profile
 * name.
 */
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import {
  KEYCHAIN_SERVICE, keychainAvailable, keychainUnavailableReason, saveToKeychain,
  deleteFromKeychain, resolveCredentials,
} from './credentials.mjs';
import { DOMAINS } from './catalog.mjs';
import { clearCachedToken } from './token-cache.mjs';
import { verifyChain } from './audit.mjs';
import { loadConfig } from './config.mjs';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const CTRL_C = '\u0003';
const BACKSPACE = /^[\u0008\u007f]$/;

const DATA_CENTRES = [
  ['United States', 'https://analyticsapi.zoho.com', 'https://accounts.zoho.com'],
  ['Europe', 'https://analyticsapi.zoho.eu', 'https://accounts.zoho.eu'],
  ['India', 'https://analyticsapi.zoho.in', 'https://accounts.zoho.in'],
  ['Australia', 'https://analyticsapi.zoho.com.au', 'https://accounts.zoho.com.au'],
  ['Japan', 'https://analyticsapi.zoho.jp', 'https://accounts.zoho.jp'],
  ['Canada', 'https://analyticsapi.zohocloud.ca', 'https://accounts.zohocloud.ca'],
  ['Saudi Arabia', 'https://analyticsapi.zoho.sa', 'https://accounts.zoho.sa'],
];

const mask = (s) =>
  (s && s.length > 12 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s ? '…' : '(unset)');

const keychainName = () =>
  ({ darwin: 'Keychain', win32: 'Credential Manager' }[process.platform]
    ?? 'Secret Service');

const flag = (args, name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1];
};

const has = (args, name) => args.includes(name);

const DOMAIN_IDS = Object.keys(DOMAINS);

/**
 * Ask which API domains this profile may reach.
 *
 * A profile is not only a credential: it is also a scope. Most people want an
 * agent that can read reports, not one that can also administer users — and
 * narrowing the surface measurably improves which operation the model picks,
 * because search has less to confuse itself with.
 */
async function chooseDomains(prompt) {
  console.log('\nWhich groups of tools may this profile use?\n');
  DOMAIN_IDS.forEach((id, i) => {
    console.log(`  ${String(i + 1).padStart(2)}. ${id.padEnd(22)} ${DOMAINS[id]}`);
  });
  console.log('\n  Enter numbers separated by commas (for example 2,9,5),');
  console.log('  or press Enter for all of them.');

  const answer = await prompt.ask('\n  Groups [all]: ');
  if (!answer || answer.toLowerCase() === 'all') {
    console.log('  -> all 10 groups');
    return [];
  }

  const picked = [...new Set(answer.split(/[,\s]+/).filter(Boolean).map(Number))]
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= DOMAIN_IDS.length)
    .map((n) => DOMAIN_IDS[n - 1]);

  if (!picked.length) {
    console.log('  Nothing recognised in that answer — defaulting to all 10 groups.');
    return [];
  }
  console.log(`  -> ${picked.join(', ')}`);
  return picked;
}

/** Ask whether this profile may change data. Default no, deliberately. */
async function chooseWrites(prompt) {
  console.log('\nMay this profile CHANGE data — create, update and delete?');
  console.log('  Read-only is strongly recommended. A sandbox executes code written');
  console.log('  by a language model; read-only means a misread prompt cannot destroy');
  console.log('  a workspace.');
  const answer = (await prompt.ask('\n  Allow writes? [y/N]: ')).toLowerCase();
  const allow = answer === 'y' || answer === 'yes';
  console.log(allow ? '  -> READ-WRITE (be careful)' : '  -> read-only');
  return allow;
}

/**
 * Asking questions, whether a human or a script is answering.
 *
 * Two modes, because readline cannot serve both. On a terminal it prompts and
 * suppresses the echo for secrets. For piped input it reads stdin to the end
 * up front and serves answers from that list — sequential `question()` calls
 * against a pipe lose lines, because readline emits them all before the next
 * call has registered, and the script then hangs forever on a closed stream.
 */
class Prompter {
  #rl = null;
  #lines = null;

  async open() {
    if (stdin.isTTY) {
      this.#rl = createInterface({ input: stdin, output: stdout });
    } else {
      let data = '';
      for await (const chunk of stdin) data += chunk;
      this.#lines = data.split(/\r?\n/);
    }
  }

  close() { this.#rl?.close(); }

  /** A visible question. */
  async ask(label) {
    if (this.#rl) return (await this.#rl.question(label)).trim();
    const value = (this.#lines.shift() ?? '').trim();
    stdout.write(`${label}${value}\n`);
    return value;
  }

  /** A question whose answer must not reach the scrollback. */
  async secret(label) {
    if (!this.#rl) {
      const value = (this.#lines.shift() ?? '').trim();
      stdout.write(`${label}${value ? '(from stdin)' : ''}\n`);
      return value;
    }

    stdout.write(label);
    stdin.setRawMode(true);
    stdin.resume();
    let value = '';
    try {
      for await (const chunk of stdin) {
        const text = chunk.toString('utf8');
        if (text === CTRL_C) { stdout.write('\n'); process.exit(130); }
        if (/[\r\n]/.test(text)) break;
        if (BACKSPACE.test(text)) { value = value.slice(0, -1); continue; }
        value += text.replace(/[\r\n]/g, '');
      }
    } finally {
      stdin.setRawMode(false);
      stdin.pause();
    }
    stdout.write('\n');
    return value.trim();
  }
}

/** Exchange a credential at the token endpoint; returns the parsed body. */
async function token(accountsUrl, params) {
  const res = await fetch(`${accountsUrl}/oauth/v2/token`, {
    method: 'POST', body: new URLSearchParams(params),
  });
  return res.json().catch(() => ({}));
}

async function login(args) {
  const profile = flag(args, '--profile') || 'default';

  if (!(await keychainAvailable())) {
    console.error('\nCannot store credentials: no usable OS keychain.\n');
    console.error(`  ${keychainUnavailableReason()}\n`);
    console.error('  Use ANALYTICS_* environment variables or ZA_CREDENTIAL_COMMAND');
    console.error('  instead. See guide/09-credentials.html\n');
    return 1;
  }

  console.log('\nZoho Analytics Code Mode — store credentials\n');
  console.log(`Profile: ${profile}`);
  console.log(`Stored in this machine's ${keychainName()}, never in a file.\n`);

  const prompt = new Prompter();
  await prompt.open();
  try {
    // Flags win, so a scripted setup need not answer this at all. The last
    // option exists for internal and dedicated deployments, whose hosts are
    // none of the seven public data centres.
    let analyticsUrl = flag(args, '--analytics-url');
    let accountsUrl = flag(args, '--accounts-url');

    if (!analyticsUrl) {
      console.log('Data centre:');
      DATA_CENTRES.forEach(([name], i) => console.log(`  ${i + 1}. ${name}`));
      console.log(`  ${DATA_CENTRES.length + 1}. Other — enter the URLs yourself`);

      const pick = Number((await prompt.ask(`Choose [1]: `)) || '1');
      if (pick === DATA_CENTRES.length + 1) {
        analyticsUrl = (await prompt.ask('  Analytics API URL: ')).replace(/\/+$/, '');
        accountsUrl = (await prompt.ask('  Accounts URL: ')).replace(/\/+$/, '');
        if (!/^https?:\/\//.test(analyticsUrl) || !/^https?:\/\//.test(accountsUrl)) {
          console.error('\n  Both must be full URLs, for example '
            + 'https://analyticsapi.example.com\n');
          return 1;
        }
      } else {
        const index = Number.isInteger(pick) && pick >= 1 && pick <= DATA_CENTRES.length
          ? pick - 1 : 0;
        [, analyticsUrl, accountsUrl] = DATA_CENTRES[index];
      }
    }
    accountsUrl = accountsUrl ?? 'https://accounts.zoho.com';
    console.log(`  -> ${analyticsUrl}\n`);

    console.log('From a Self Client at https://api-console.zoho.com :');
    const clientId = await prompt.ask('  Client ID: ');
    const clientSecret = await prompt.secret('  Client Secret: ');
    const orgId = await prompt.ask('  Organization ID: ');

    // A refresh token if they already have one; otherwise exchange a grant
    // code here, so nobody has to hand-roll a curl call to get started.
    let refreshToken = flag(args, '--refresh-token');
    if (!refreshToken) {
      console.log('\n  Paste a refresh token if you have one, or leave blank to');
      console.log('  exchange a Generate Code grant for one.');
      refreshToken = await prompt.secret('  Refresh Token (blank to exchange): ');
    }

    if (!refreshToken) {
      const code = await prompt.secret('  Generate Code grant: ');
      if (!code) { console.error('\nNothing to exchange. Aborted.\n'); return 1; }
      stdout.write('  exchanging... ');
      const json = await token(accountsUrl, {
        grant_type: 'authorization_code', client_id: clientId,
        client_secret: clientSecret, code,
      });
      if (!json.refresh_token) {
        console.error('failed.\n');
        console.error(`  Zoho said: ${json.error ?? JSON.stringify(json).slice(0, 120)}`);
        console.error('  A grant code is single-use and expires in minutes — generate a');
        console.error('  fresh one, and check the data centre matches.\n');
        return 1;
      }
      refreshToken = json.refresh_token;
      console.log('done.');
    }

    if (!clientId || !clientSecret || !refreshToken || !orgId) {
      console.error('\nClient ID, Client Secret, Refresh Token and Organization ID are '
        + 'all required. Nothing was stored.\n');
      return 1;
    }

    const domains = flag(args, '--domains') !== null
      ? flag(args, '--domains').split(',').map((d) => d.trim()).filter(Boolean)
      : await chooseDomains(prompt);
    const allowWrites = has(args, '--allow-writes')
      ? true
      : (has(args, '--read-only') ? false : await chooseWrites(prompt));

    const unknown = domains.filter((d) => !DOMAIN_IDS.includes(d));
    if (unknown.length) {
      console.error(`\nUnknown tool group(s): ${unknown.join(', ')}.`);
      console.error(`Valid groups: ${DOMAIN_IDS.join(', ')}\n`);
      return 1;
    }

    // Prove it works before storing, so a typo surfaces now rather than as an
    // opaque "server failed to start" inside the agent days later.
    stdout.write('\nVerifying... ');
    const verified = await token(accountsUrl, {
      grant_type: 'refresh_token', client_id: clientId,
      client_secret: clientSecret, refresh_token: refreshToken,
    });
    if (!verified.access_token) {
      console.error('failed.\n');
      console.error(`  Zoho said: ${verified.error ?? JSON.stringify(verified).slice(0, 120)}`);
      console.error('  Nothing was stored.\n');
      return 1;
    }
    console.log('the credential works.');

    await saveToKeychain(profile, {
      clientId, clientSecret, refreshToken, orgId, analyticsUrl, accountsUrl,
      domains, allowWrites,
    });

    console.log(`\nStored under "${KEYCHAIN_SERVICE}" / "${profile}" in the `
      + `${keychainName()}.`);
    console.log(`  tool groups   ${domains.length ? domains.join(', ') : 'all 10'}`);
    console.log(`  data access   ${allowWrites ? 'read and write' : 'read-only'}`);
    console.log('\nAdd this to your MCP client. Note that it contains no secrets:\n');
    console.log(JSON.stringify({
      mcpServers: {
        'zoho-analytics-code-mode': {
          command: 'npx',
          args: ['-y', 'zoho-analytics-codemode'],
          ...(profile === 'default' ? {} : { env: { ZA_PROFILE: profile } }),
        },
      },
    }, null, 2));
    console.log();
    return 0;
  } finally {
    prompt.close();
  }
}

async function logout(args) {
  const profile = flag(args, '--profile') || 'default';
  try {
    const removed = await deleteFromKeychain(profile);
    await clearCachedToken(profile);     // the cached access token goes too
    console.log(removed
      ? `Removed profile "${profile}" from the ${keychainName()}.`
      : `No stored credentials for profile "${profile}".`);
    return 0;
  } catch (err) {
    console.error(err.message);
    return 1;
  }
}

async function status(args) {
  const profile = flag(args, '--profile') || process.env.ZA_PROFILE || 'default';
  const resolved = await resolveCredentials({ ...process.env, ZA_PROFILE: profile });
  const v = resolved.values ?? {};

  console.log('\nZoho Analytics Code Mode — credential status\n');
  console.log(`  platform        ${process.platform} (${keychainName()})`);
  console.log(`  keychain        ${(await keychainAvailable()) ? 'available' : 'NOT available'}`);
  console.log(`  profile         ${profile}`);
  console.log(`  resolved from   ${resolved.source}`);
  console.log(`  client id       ${mask(v.clientId)}`);
  console.log(`  client secret   ${mask(v.clientSecret)}`);
  console.log(`  refresh token   ${mask(v.refreshToken)}`);
  console.log(`  organization    ${v.orgId ?? '(unset)'}`);
  console.log(`  analytics url   ${v.analyticsUrl ?? '(default)'}`);
  console.log(`  tool groups     ${v.domains?.length ? v.domains.join(', ') : 'all 10'}`);
  console.log(`  data access     ${v.allowWrites ? 'read and write' : 'read-only'}`);

  if (resolved.problems.length) {
    console.log('\n  problems:');
    for (const p of resolved.problems) console.log(`    - ${p}`);
  }
  console.log();
  return resolved.problems.length ? 1 : 0;
}

/** Where the audit logs are, how big, and whether they verify. */
async function audit(args) {
  const config = await loadConfig({
    ...process.env, ZA_PROFILE: flag(args, '--profile') ?? process.env.ZA_PROFILE,
  });
  const a = config.audit;

  console.log('\nZoho Analytics Code Mode — audit logs\n');
  console.log(`  streams         ${a.streams}`);
  console.log(`  directory       ${a.dir}`);
  console.log(`  file size       ${(a.maxFileBytes / 1e6).toFixed(0)} MB`);
  console.log(`  api history     ${a.apiMaxFiles} files `
    + `(${(a.apiMaxFiles * a.maxFileBytes / 1e6).toFixed(0)} MB)`);
  console.log(`  detail history  ${a.detailMaxFiles} files `
    + `(${(a.detailMaxFiles * a.maxFileBytes / 1e6).toFixed(0)} MB)`);
  console.log(`  secrets         ${a.logSecrets ? 'LOGGED IN CLEAR' : 'redacted'}`);
  console.log(`  program text    ${a.logCode ? 'recorded' : 'omitted'}`);
  console.log(`  hash chain      ${a.chain ? 'on' : 'off'}`);

  if (!existsSync(a.dir)) {
    console.log('\n  Nothing written yet.\n');
    return 0;
  }

  console.log('\n  files:');
  let total = 0;
  for (const file of readdirSync(a.dir).sort()) {
    const size = statSync(join(a.dir, file)).size;
    total += size;
    console.log(`    ${file.padEnd(20)} ${(size / 1024).toFixed(0).padStart(7)} KB`);
  }
  console.log(`    ${'total'.padEnd(20)} ${(total / 1e6).toFixed(1).padStart(7)} MB`);

  if (a.chain) {
    console.log('\n  integrity:');
    for (const name of ['api', 'detail']) {
      const file = join(a.dir, `${name}.jsonl`);
      if (!existsSync(file)) continue;
      const result = verifyChain(readFileSync(file, 'utf8').split('\n'));
      console.log(result.ok
        ? `    ${name.padEnd(8)} ${result.lines} lines, chain intact`
        : `    ${name.padEnd(8)} BROKEN at line ${result.line} — ${result.reason}`);
    }
  }
  console.log();
  return 0;
}

function help() {
  console.log(`
Zoho Analytics Code Mode — MCP server for AI agents

  za-codemode                 start the MCP server (stdio)
  za-codemode login           store credentials in the OS keychain
  za-codemode status          show which credential is in use
  za-codemode logout          remove stored credentials
  za-codemode audit           where the audit logs are, and verify them

Options
  --profile <name>      keep several organizations side by side (default "default")
  --refresh-token <t>   supply a refresh token instead of being prompted
  --domains <a,b,c>     tool groups this profile may use (default: all)
  --analytics-url <u>   API host, for an internal or dedicated deployment
  --accounts-url <u>    accounts host to match it
  --read-only           data access is read-only (the default)
  --allow-writes        permit create, update and delete

Audit logging
  ZA_AUDIT              off | api | full          (default: api)
  ZA_AUDIT_DIR          where to write            (default: ~/.zoho-analytics-code-mode/audit)
  ZA_AUDIT_MAX_FILE_MB  size of one file          (default: 10)
  ZA_AUDIT_API_FILES    api history, in files     (default: 5 local, 10 remote)
  ZA_AUDIT_DETAIL_FILES detail history, in files  (default: 5 local, 10 remote)
  ZA_AUDIT_LOG_SECRETS  log secrets in clear      (default: false)
  ZA_AUDIT_LOG_CODE     record the program        (default: true)
  ZA_AUDIT_HASH_CHAIN   tamper detection          (default: true)

Tool groups
  data-modeling-schema   data-operations        dsml
  org-management         reports-dashboards     schedules-alerts
  share-publish          user-groups            views-management
  workspace-management

Credentials resolve in this order: ANALYTICS_* environment variables, then
ZA_CREDENTIAL_COMMAND, then the OS keychain. "status" reports which answered.
`);
  return 0;
}

export async function runCli(argv) {
  const [command, ...args] = argv;
  switch (command) {
    case 'login': return login(args);
    case 'logout': return logout(args);
    case 'status': return status(args);
    case 'audit': return audit(args);
    case 'help': case '--help': case '-h': return help();
    default:
      console.error(`Unknown command "${command}". Try: login, status, logout, help`);
      return 1;
  }
}
