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

/** Prompt without echoing, so a secret never lands in the scrollback. */
async function secretPrompt(label) {
  stdout.write(label);

  if (!stdin.isTTY) {
    // Piped input: read one line. There is no echo to suppress.
    const rl = createInterface({ input: stdin });
    for await (const line of rl) { rl.close(); stdout.write('\n'); return line.trim(); }
    return '';
  }

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

  const rl = createInterface({ input: stdin, output: stdout });
  try {
    console.log('Data centre:');
    DATA_CENTRES.forEach(([name], i) => console.log(`  ${i + 1}. ${name}`));
    const pick = Number((await rl.question('Choose [1]: ')) || '1');
    const index = Number.isInteger(pick) && pick >= 1 && pick <= DATA_CENTRES.length
      ? pick - 1 : 0;
    const [, analyticsUrl, accountsUrl] = DATA_CENTRES[index];
    console.log(`  -> ${analyticsUrl}\n`);

    console.log('From a Self Client at https://api-console.zoho.com :');
    const clientId = (await rl.question('  Client ID: ')).trim();
    rl.pause();
    const clientSecret = await secretPrompt('  Client Secret: ');
    rl.resume();
    const orgId = (await rl.question('  Organization ID: ')).trim();
    rl.pause();

    // A refresh token if they already have one; otherwise exchange a grant
    // code here, so nobody has to hand-roll a curl call to get started.
    let refreshToken = flag(args, '--refresh-token');
    if (!refreshToken) {
      console.log('\n  Paste a refresh token if you have one, or leave blank to');
      console.log('  exchange a Generate Code grant for one.');
      refreshToken = await secretPrompt('  Refresh Token (blank to exchange): ');
    }

    if (!refreshToken) {
      const code = await secretPrompt('  Generate Code grant: ');
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
    });

    console.log(`\nStored under "${KEYCHAIN_SERVICE}" / "${profile}" in the `
      + `${keychainName()}.`);
    console.log('\nAdd this to your MCP client. Note that it contains no secrets:\n');
    console.log(JSON.stringify({
      mcpServers: {
        'zoho-analytics-code-mode': {
          command: 'npx',
          args: ['-y', 'zoho-analytics-code-mode-mcp'],
          ...(profile === 'default' ? {} : { env: { ZA_PROFILE: profile } }),
        },
      },
    }, null, 2));
    console.log();
    return 0;
  } finally {
    rl.close();
  }
}

async function logout(args) {
  const profile = flag(args, '--profile') || 'default';
  try {
    const removed = await deleteFromKeychain(profile);
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

  if (resolved.problems.length) {
    console.log('\n  problems:');
    for (const p of resolved.problems) console.log(`    - ${p}`);
  }
  console.log();
  return resolved.problems.length ? 1 : 0;
}

function help() {
  console.log(`
Zoho Analytics Code Mode — MCP server for AI agents

  zoho-analytics-code-mode-mcp                 start the MCP server (stdio)
  zoho-analytics-code-mode-mcp login           store credentials in the OS keychain
  zoho-analytics-code-mode-mcp status          show which credential is in use
  zoho-analytics-code-mode-mcp logout          remove stored credentials

Options
  --profile <name>      keep several organizations side by side (default "default")
  --refresh-token <t>   supply a refresh token instead of being prompted

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
    case 'help': case '--help': case '-h': return help();
    default:
      console.error(`Unknown command "${command}". Try: login, status, logout, help`);
      return 1;
  }
}
