/**
 * The tool catalog and the sandbox — and the ONLY file that imports UTCP.
 *
 * Everything UTCP-specific is deliberately fenced in here, behind an interface
 * we own. UTCP is a thin dependency (~5.6k npm downloads/month) with several
 * undocumented behaviours; isolating it means replacing it later touches one
 * file instead of the whole server. The rest of the app knows only about
 * `search()` and `execute()`.
 *
 * Four UTCP behaviours cost real debugging time and are load-bearing here:
 *
 *  1. `allowed_communication_protocols` defaults to the MANUAL's own protocol.
 *     A `text` manual silently drops every `http` tool it contains — and still
 *     returns success:true with errors:[]. It must list 'http' explicitly.
 *  2. Variables are substituted at REGISTRATION time, not call time, so the
 *     access token is baked into the tool templates. Rotating it means
 *     re-registering the manual.
 *  3. Variables are namespaced per manual: ${ZA_BASE_URL} resolves as
 *     `za_ZA_BASE_URL`. Undocumented, and it throws at registration.
 *  4. Substitution scans the WHOLE manual including descriptions, so prose
 *     containing a ${...} placeholder throws. tools/build-manual.mjs defuses
 *     those at generation time.
 */
import { CodeModeUtcpClient } from '@utcp/code-mode';
import { register as registerHttp } from '@utcp/http';
import { register as registerText } from '@utcp/text';
import { readFileSync } from 'node:fs';
import { PRELUDE } from './sandbox-prelude.mjs';

const MANUAL_NAME = 'za';
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Zoho frequency-limit codes. Found live: a name sweep over 81 workspaces
 * trips 6045 (EXCEEDING_USR_PLN_API_FREQ_COUNT).
 *
 * Measured against a real organization, the limit is a RATE OVER A WINDOW,
 * not a gap between calls:
 *
 *     1000 ms apart  (~53/min)   40 calls, no problem
 *      400 ms apart (~105/min)   tripped after 27
 *      150 ms apart (~188/min)   tripped after 5
 *
 * So pacing alone is the wrong shape — a burst inside one window trips it
 * however evenly the burst itself is spread. Hence a sliding window as well.
 * Recovery after a trip is about five seconds.
 */
const THROTTLE_CODES = [6045, 6044, 6046];
const THROTTLE_PATTERN = new RegExp(
  '(' + THROTTLE_CODES.join('|') + ')|EXCEEDING_USR_PLN_API_FREQ|too many requests|\\b429\\b', 'i');

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * The API domains, mirroring v2.0/oas/<domain>-grouped-api.json. A deployment
 * can expose any subset: a team that only reads reports has no business being
 * able to call user management, and a smaller surface measurably improves
 * search precision.
 */
export const DOMAINS = {
  'data-modeling-schema': 'Tables, columns, formulas, query tables, lookups',
  'data-operations': 'Rows, imports, exports, bulk jobs, data sync',
  'dsml': 'AutoML analyses, training and predictions',
  'org-management': 'Organizations, subscriptions, security controls',
  'reports-dashboards': 'Charts, pivots, summaries, dashboards',
  'schedules-alerts': 'Email schedules and data alerts',
  'share-publish': 'Sharing, permissions, embed URLs, public links, slideshows',
  'user-groups': 'Users, groups, roles and portals',
  'views-management': 'Views, folders, tags, trash, copy and move',
  'workspace-management': 'Workspaces, backups, linking, templates, variables',
};

registerHttp();   // the manual's tools call Analytics over HTTPS
registerText();   // the manual itself is handed over inline, never fetched

export class Catalog {
  #config;
  #tokens;
  #client = null;
  #manual;
  #exposed;
  #registeredToken = null;
  #lastCallAt = 0;
  #window = [];

  constructor({ config, tokens, manualPath }) {
    this.#config = config;
    this.#tokens = tokens;
    this.#manual = JSON.parse(readFileSync(manualPath, 'utf8'));

    // Two independent filters decide what the sandbox can reach.
    //
    //  1. Domain — which parts of the API this deployment serves at all.
    //  2. Writes — read-only by default, because a sandbox executing
    //     model-written code must not be able to drop a workspace because the
    //     model misread a prompt.
    const domains = config.domains?.length ? new Set(config.domains) : null;

    this.#exposed = this.#manual.tools.filter((t) => {
      if (domains && !t.tags?.some((tag) => domains.has(tag))) return false;
      if (!config.allowWrites && WRITE_METHODS.has(t.tool_call_template.http_method)) return false;
      return true;
    });
  }

  get totalOperations() { return this.#manual.tools.length; }
  get exposedOperations() { return this.#exposed.length; }

  /** Exposed operation counts per domain, for startup logging and /healthz. */
  get domainBreakdown() {
    const counts = {};
    for (const tool of this.#exposed) {
      for (const tag of tool.tags ?? []) {
        if (tag in DOMAINS) counts[tag] = (counts[tag] ?? 0) + 1;
      }
    }
    return counts;
  }

  async init() {
    this.#client = await CodeModeUtcpClient.create(process.cwd(), { manual_call_templates: [] });
    await this.#ensureRegistered();
  }

  /** (Re-)register the manual whenever the access token has rotated. */
  async #ensureRegistered() {
    const token = await this.#tokens.get();
    if (token === this.#registeredToken) return;

    // Trap 3: namespaced. Set both forms so either resolution order works.
    for (const [key, value] of Object.entries({
      ZA_BASE_URL: this.#config.analyticsUrl,
      ZA_ACCESS_TOKEN: token,
    })) {
      process.env[key] = value;
      process.env[`${MANUAL_NAME}_${key}`] = value;
    }

    const res = await this.#client.registerManual({
      name: MANUAL_NAME,
      call_template_type: 'text',
      allowed_communication_protocols: ['http', 'text'],   // trap 1
      // Only the schema's own keys: UtcpManualSerializer rejects any other
      // top-level key outright, so the provenance block the build records in
      // the manual file must be left out of what gets registered.
      content: JSON.stringify({
        utcp_version: this.#manual.utcp_version,
        manual_version: this.#manual.manual_version,
        tools: this.#exposed,
      }),
    });

    // Trap 1 again: zero tools is reported as success, so check the count.
    const got = res.manual?.tools?.length ?? 0;
    if (got === 0) {
      throw new Error(
        `manual registered 0 of ${this.#exposed.length} operations `
        + `(errors: ${JSON.stringify(res.errors ?? [])})`);
    }

    this.#registeredToken = token;   // trap 2
    return got;
  }

  /**
   * Pace outgoing calls, and wait rather than hammer when the API says it has
   * had enough.
   *
   * Generated code loops, and a loop that fires as fast as the event loop
   * allows will trip the frequency limit on any real organization — which it
   * did, live, on the first exhaustive name sweep. Spacing is cheap insurance;
   * the backoff is deliberately slow because the documented guidance is to
   * wait out the lock period, not to retry tightly.
   */
  async #throttled(fn) {
    const { minCallIntervalMs, maxCallsPerMinute, throttleRetries } = this.#config;

    for (let attempt = 0; ; attempt += 1) {
      // Sliding window: wait until the oldest call in the last minute ages
      // out, so a burst can never exceed the measured safe rate.
      for (;;) {
        const cutoff = Date.now() - 60_000;
        this.#window = this.#window.filter((t) => t > cutoff);
        if (this.#window.length < maxCallsPerMinute) break;
        await sleep(Math.max(250, this.#window[0] - cutoff));
      }

      const gap = minCallIntervalMs - (Date.now() - this.#lastCallAt);
      if (gap > 0) await sleep(gap);

      this.#lastCallAt = Date.now();
      this.#window.push(this.#lastCallAt);

      try {
        return await fn();
      } catch (err) {
        const throttled = THROTTLE_PATTERN.test(String(err?.message ?? err));
        if (!throttled || attempt >= throttleRetries) {
          if (throttled) {
            throw new Error(
              `${err.message}\n\nThe API frequency limit was still in force after `
              + `${attempt + 1} attempts. Narrow the task to one workspace, or lower `
              + 'ZA_MAX_CALLS_PER_MINUTE and try again.');
          }
          throw err;
        }
        // Measured recovery is ~5s, so 6s / 15s / 30s. Also drop the window so
        // the retry does not immediately re-saturate it.
        this.#window = [];
        await sleep([6000, 15_000, 30_000][Math.min(attempt, 2)]);
      }
    }
  }

  /** Raw UTCP search. Ranking and query expansion live in search.mjs. */
  async searchRaw(query, limit) {
    const hits = await this.#client.searchTools(query, limit);
    return hits.map((t) => ({
      // Tool names are namespaced "<manual>.<operationId>" but the sandbox
      // binds the bare operationId onto the `za` global.
      name: t.name.startsWith(`${MANUAL_NAME}.`)
        ? t.name.slice(MANUAL_NAME.length + 1)
        : t.name,
      description: t.description ?? '',
      inputs: t.inputs ?? { properties: {}, required: [] },
      tags: t.tags ?? [],
    }));
  }

  /** Every exposed operation, for offline search strategies. */
  allOperations() {
    return this.#exposed.map((t) => ({
      name: t.name,
      description: t.description ?? '',
      inputs: t.inputs ?? { properties: {}, required: [] },
      tags: t.tags ?? [],
      domain: (t.tags ?? []).find((tag) => tag in DOMAINS) ?? null,
      write: WRITE_METHODS.has(t.tool_call_template.http_method),
    }));
  }

  /**
   * Run model-written code in the isolate.
   *
   * The sandbox has no network, no modules and no filesystem; `za` is the only
   * way out, and every call on it is a bridge callback into this process. The
   * access token stays here — it is never visible to the executing code.
   */
  async execute(code) {
    await this.#ensureRegistered();

    // Per-execution budget: generated code loops, and every call bills API
    // units. Enforced by wrapping the client's own dispatch.
    let calls = 0;
    const original = this.#client.callTool.bind(this.#client);
    const { maxToolCalls, timeoutMs, memoryLimitMb, orgId } = this.#config;

    this.#client.callTool = async (name, args) => {
      if (++calls > maxToolCalls) {
        throw new Error(
          `API call budget exhausted after ${maxToolCalls} calls. Narrow the task, `
          + 'or raise ZA_MAX_TOOL_CALLS.');
      }
      return this.#throttled(() => original(name, args));
    };

    // The org ID is required on nearly every operation; handing it to the
    // sandbox as a constant keeps it out of every generated call site. The
    // prelude adds the `find` resolver, so a program can turn a human's words
    // into IDs instead of hardcoding a name that may not exist.
    const preamble = `const ORG_ID = ${JSON.stringify(orgId)};\n${PRELUDE}\n`;

    try {
      const { result, logs } = await this.#client.callToolChain(
        preamble + code, timeoutMs, memoryLimitMb);

      // code-mode swallows a sandbox exception: it resolves with result null
      // and the message buried in logs. Left alone that reaches the agent as a
      // successful call returning nothing, which is the worst of both. Promote
      // it back to a thrown error so the caller can explain it properly.
      const failure = logs.find((l) => /^\[ERROR\]/.test(l));
      if (failure) {
        throw new Error(failure.replace(/^\[ERROR\]\s*(Code execution failed:\s*)?/, ''));
      }

      // A refused name resolution fails the whole execution, even if the
      // program caught the error and returned something anyway. Enforcing
      // this here rather than in the sandbox is the point: a program that
      // swallows the refusal and substitutes a different variable would
      // otherwise produce a confident, wrong answer.
      const refusals = [];
      const clean = [];
      for (const line of logs) {
        const match = /^__ZA_RESOLUTION_FAILED__ (.*)$/.exec(line);
        if (match) {
          try { refusals.push(JSON.parse(match[1])); } catch { refusals.push({ message: match[1] }); }
        } else {
          clean.push(line);
        }
      }
      if (refusals.length) {
        throw new Error(refusals.map((r) => r.message).join('\n'));
      }

      return { result, logs: clean, calls };
    } finally {
      this.#client.callTool = original;
    }
  }
}

/**
 * Programs the discovery tool runs. Kept here, next to the sandbox, because
 * they are executed through exactly the same path as model-written code —
 * same auth, same budget, same isolate.
 */
export const DISCOVERY = {
  workspaces: (query) =>
    `return { workspaces: await find.workspaces(${JSON.stringify(query ?? null)}, { limit: 25 }) };`,

  views: (query, workspaceId) =>
    `return await find.views(${JSON.stringify(query ?? null)}, `
    + `{ limit: 15${workspaceId ? `, workspaceId: ${JSON.stringify(String(workspaceId))}` : ''} });`,

  columns: (query, workspaceId, viewId) =>
    `return { columns: await find.columns(${JSON.stringify(String(workspaceId))}, `
    + `${JSON.stringify(String(viewId))}, ${JSON.stringify(query ?? null)}) };`,

  resolve: (query) => `return await find.resolve(${JSON.stringify(query)});`,

  metadata: (kind, query, workspaceId) =>
    `return { kind: ${JSON.stringify(kind)}, matches: await find.metadata(`
    + `${JSON.stringify(kind)}, ${JSON.stringify(String(workspaceId))}, `
    + `${JSON.stringify(query ?? null)}, { limit: 25 }) };`,
};
