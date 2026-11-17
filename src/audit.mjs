/**
 * Audit logging: two streams, size-bounded, redacted by default.
 *
 * Two streams because they carry different things and deserve different
 * handling:
 *
 *   api.jsonl     one line per outbound Zoho call. What this server did to
 *                 your data — operation, path, status, timing, size. Low
 *                 sensitivity, safe to ship anywhere, keep it longest.
 *   detail.jsonl  one record per MCP tool call: who asked, under what scope,
 *                 the program that ran, what came back. This is the record
 *                 that answers "what did the agent actually do", and it is
 *                 sensitive — a `criteria` string can carry customer names or
 *                 commercial thresholds, so OWASP's "never log commercially
 *                 sensitive information" applies to the file, not to the
 *                 decision to write it. Treat it as you treat the data.
 *
 * Shape follows the usual guidance: JSON Lines, RFC 3339 UTC timestamps, and
 * OWASP's when / where / who / what in every record. Secrets are redacted
 * unless an operator deliberately turns that off.
 *
 * Writing never blocks or fails a request. A full disk, a read-only mount or
 * a permissions problem degrades the log and is reported once — losing an
 * audit line is bad, failing the API call that just succeeded is worse.
 */
import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, rename, stat, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** Token shapes that must never reach a log file, whatever produced them. */
const SECRET_PATTERNS = [
  // Zoho OAuth tokens: 1000.<hex>.<hex>
  [/\b1000\.[0-9a-f]{16,}\.[0-9a-f]{16,}\b/gi, '[redacted:zoho-token]'],
  [/\b1000\.[A-Z0-9]{20,}\b/g, '[redacted:zoho-client-id]'],
  // Authorization headers and grant parameters, however they are spelled.
  [/(Bearer|Zoho-oauthtoken)\s+[\w.\-]+/gi, '$1 [redacted]'],
  [/((?:refresh|access)_token|client_secret|code)=[\w.\-]+/gi, '$1=[redacted]'],
  [/("(?:refreshToken|accessToken|clientSecret|password|sessionSecret)"\s*:\s*)"[^"]*"/gi,
    '$1"[redacted]"'],
];

/** The exact secret values this process knows about, redacted verbatim. */
function literalSecrets(config) {
  return [
    config.clientSecret, config.refreshToken, config.staticToken,
    config.sessionSecret, config.oidcClientSecret,
  ].filter((v) => typeof v === 'string' && v.length >= 8);
}

export function redact(value, { literals = [], enabled = true } = {}) {
  if (!enabled) return value;
  let text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text === undefined) return value;

  for (const secret of literals) {
    text = text.split(secret).join('[redacted]');
  }
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    text = text.replace(pattern, replacement);
  }
  return text;
}

/**
 * One size-bounded JSON Lines file with logrotate-style numbered backups.
 *
 * `name.jsonl` is current; on exceeding the size limit it becomes `name.1.jsonl`,
 * each existing backup shifts up, and anything past the file count is deleted.
 * Total on disk is therefore bounded by maxFileBytes * maxFiles.
 */
class RotatingStream {
  #path;
  #dir;
  #name;
  #maxBytes;
  #maxFiles;
  #bytes = 0;
  #queue = Promise.resolve();
  #broken = null;
  #prevHash = 'genesis';
  #chain;
  #run;

  constructor({ dir, name, maxFileBytes, maxFiles, chain = true, run }) {
    this.#dir = dir;
    this.#name = name;
    this.#path = join(dir, `${name}.jsonl`);
    this.#maxBytes = maxFileBytes;
    this.#maxFiles = maxFiles;
    this.#chain = chain;
    // Several processes legitimately append to one file: a local server is
    // respawned on every agent restart, and two agent hosts can run at once.
    // Each keeps its own chain, identified by this run, so interleaving and
    // restarts are not mistaken for tampering.
    this.#run = run;
  }

  get path() { return this.#path; }
  get broken() { return this.#broken; }

  async init() {
    await mkdir(this.#dir, { recursive: true, mode: 0o700 });
    this.#bytes = existsSync(this.#path) ? (await stat(this.#path)).size : 0;
  }

  /**
   * Append one record. Returns immediately; writes are serialised behind a
   * promise chain so lines cannot interleave, and a failure is swallowed
   * after being reported once.
   */
  write(record) {
    this.#queue = this.#queue.then(() => this.#append(record)).catch(() => {});
    return this.#queue;
  }

  /** Wait for everything queued so far — used by tests and on shutdown. */
  flush() { return this.#queue; }

  async #append(record) {
    if (this.#broken) return;

    try {
      // A hash of the previous line makes an edit or deletion detectable:
      // the chain stops verifying from that point on. It does not stop
      // someone who can rewrite the whole file, which is why a shared
      // deployment should ship these off the host.
      const body = this.#chain
        ? { ...record, run: this.#run, prev: this.#prevHash }
        : record;
      const line = `${JSON.stringify(body)}\n`;

      if (this.#chain) {
        this.#prevHash = createHash('sha256').update(line).digest('hex').slice(0, 16);
      }

      if (this.#bytes > 0 && this.#bytes + line.length > this.#maxBytes) {
        await this.#rotate();
      }

      await appendFile(this.#path, line, { mode: 0o600 });
      this.#bytes += line.length;
    } catch (err) {
      this.#broken = err.message;
      process.stderr.write(
        `[za] audit log unavailable (${err.message}); continuing without it\n`);
    }
  }

  async #rotate() {
    for (let i = this.#maxFiles - 1; i >= 1; i -= 1) {
      const from = join(this.#dir, `${this.#name}.${i}.jsonl`);
      const to = join(this.#dir, `${this.#name}.${i + 1}.jsonl`);
      if (!existsSync(from)) continue;
      if (i + 1 > this.#maxFiles) { await unlink(from); continue; }
      await rename(from, to);
    }
    // Anything that fell past the limit.
    const overflow = join(this.#dir, `${this.#name}.${this.#maxFiles + 1}.jsonl`);
    if (existsSync(overflow)) await unlink(overflow);

    await rename(this.#path, join(this.#dir, `${this.#name}.1.jsonl`));
    this.#bytes = 0;
  }
}

/** A no-op logger, so callers never branch on whether auditing is enabled. */
const NULL_SINK = {
  enabled: false,
  newRequest: () => randomUUID().slice(0, 8),
  apiCall() {}, execution() {}, auth() {},
  flush: async () => {},
  describe: () => 'off',
};

/**
 * Build the audit logger for a configuration.
 *
 * `mode` picks the defaults: a local server serves one person and a modest
 * volume, a remote one serves a team and should also emit to stdout for a
 * collector. Every value remains overridable.
 */
export async function createAudit(config, { mode = 'local' } = {}) {
  const settings = config.audit ?? {};
  if (settings.streams === 'off') return NULL_SINK;

  // One identifier for this process, so each writer's chain is its own.
  const run = randomUUID().slice(0, 8);
  const literals = literalSecrets(config);
  const redactOpts = { literals, enabled: !settings.logSecrets };

  const wantDetail = settings.streams === 'full';
  const streams = {};

  try {
    streams.api = new RotatingStream({
      dir: settings.dir, name: 'api',
      maxFileBytes: settings.maxFileBytes, maxFiles: settings.apiMaxFiles,
      chain: settings.chain, run,
    });
    await streams.api.init();

    if (wantDetail) {
      streams.detail = new RotatingStream({
        dir: settings.dir, name: 'detail',
        maxFileBytes: settings.maxFileBytes, maxFiles: settings.detailMaxFiles,
        chain: settings.chain, run,
      });
      await streams.detail.init();
    }
  } catch (err) {
    process.stderr.write(`[za] audit log could not be opened (${err.message}); `
      + 'continuing without it\n');
    return NULL_SINK;
  }

  // stdout is the MCP protocol channel for a stdio server, so emitting there
  // would corrupt the stream. It is only ever available to the remote server.
  const toStdout = settings.stdout && mode === 'remote';

  const emit = (stream, record) => {
    stream?.write(record);
    if (toStdout) process.stdout.write(`${JSON.stringify(record)}\n`);
  };

  const now = () => new Date().toISOString();

  return {
    enabled: true,

    /** Correlates one tool call with the API calls it causes. */
    newRequest: () => randomUUID().slice(0, 8),

    /** Stream A: one line per outbound Zoho call. */
    apiCall({ requestId, actor, org, operation, method, path, status, ms, bytes }) {
      emit(streams.api, {
        ts: now(), ev: 'api', req: requestId,
        actor, org, op: operation, method,
        path: redact(path, redactOpts),
        status, ms, bytes,
      });
    },

    /** Stream B: one record per MCP tool call. */
    execution({
      requestId, actor, org, client, tool, scope, args, code,
      outcome, ms, apiCalls, error,
    }) {
      if (!streams.detail) return;
      emit(streams.detail, {
        ts: now(), ev: 'execution', req: requestId,
        actor, org, client, tool, scope,
        args: settings.logArguments && args !== undefined
          ? redact(args, redactOpts) : undefined,
        code: settings.logCode && code ? redact(code, redactOpts) : undefined,
        outcome, ms, apiCalls,
        error: error ? redact(String(error).slice(0, 500), redactOpts) : undefined,
      });
    },

    /** Authentication and authorization decisions. OWASP requires these. */
    auth({ event, actor, client, org, outcome, reason, ip }) {
      emit(streams.detail ?? streams.api, {
        ts: now(), ev: 'auth', type: event,
        actor, client, org, outcome,
        reason: reason ? redact(reason, redactOpts) : undefined,
        ip,
      });
    },

    async flush() {
      await Promise.all(Object.values(streams).map((s) => s.flush()));
    },

    describe() {
      const mb = (settings.maxFileBytes / 1e6).toFixed(0);
      const parts = [`api ${settings.apiMaxFiles}x${mb}MB`];
      if (wantDetail) parts.push(`detail ${settings.detailMaxFiles}x${mb}MB`);
      parts.push(settings.logSecrets ? 'SECRETS LOGGED' : 'secrets redacted');
      if (toStdout) parts.push('stdout');
      if (settings.chain) parts.push('hash-chained');
      return `${settings.dir} — ${parts.join(', ')}`;
    },
  };
}

/**
 * Verify a stream's hash chain.
 *
 * Returns the first line whose recorded `prev` does not match the hash of the
 * line before it, which is where an edit or deletion happened.
 */
/**
 * Verify the hash chains in a stream.
 *
 * Chains are per writer, because one file legitimately holds lines from many
 * processes — a local server restarts with the agent, and two agent hosts can
 * write at once. Each run is verified independently, so interleaving and
 * restarts verify cleanly while an edited or deleted line still breaks the
 * run it belongs to.
 */
export function verifyChain(lines) {
  const prevByRun = new Map();
  let checked = 0;

  for (const [index, raw] of lines.entries()) {
    if (!raw.trim()) continue;

    let record;
    try {
      record = JSON.parse(raw);
    } catch {
      return { ok: false, line: index + 1, reason: 'not valid JSON' };
    }

    // A record without a chain was written with chaining off; nothing to check.
    if (record.prev === undefined) { checked += 1; continue; }

    const run = record.run ?? 'default';
    const expected = prevByRun.get(run) ?? 'genesis';
    if (record.prev !== expected) {
      return {
        ok: false, line: index + 1, run,
        reason: 'chain broken — a line was changed or removed',
      };
    }
    prevByRun.set(run, createHash('sha256').update(`${raw}\n`).digest('hex').slice(0, 16));
    checked += 1;
  }

  return { ok: true, lines: checked, runs: prevByRun.size };
}
