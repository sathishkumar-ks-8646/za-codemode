# za-codemode

**Zoho Analytics Code Mode** — UTCP code mode behind an MCP front door. Lets an
AI agent write and run sandboxed code against the Zoho Analytics v2 API.

**Not published yet.** Install it from source — `git clone`, `npm install`,
`npm link` — which puts a `za-codemode` command on your `PATH`. See
[`guide/02-install.md`](guide/02-install.md). The npm name is reserved as
`zoho-analytics-codemode` but nothing is published under it while the licence
is being settled; see [`LICENSE.md`](LICENSE.md).

**The guide for users** is [`guide/za-codemode-how-to-use.html`](guide/za-codemode-how-to-use.html)
— every chapter in one self-contained file, which is the copy to host. Rebuild
it with `cd guide && python3 build.py --single`.

A second, multi-user HTTP mode (`src/remote.mjs`) is implemented and tested but
**unreleased and undocumented** — it is left out of the guide deliberately,
because the write path and per-user rate limiting are not ready for a shared
deployment. Do not deploy it. `guide/unpublished/` holds its chapter for when
it is.

```
  AI agent  ──MCP/stdio──▶  this server  ──▶  V8 isolate (model's code)
  (Claude Desktop,                │      ◀── tool bridge ──┘
   Cursor, VS Code)               ▼
                       Zoho Analytics REST API
```

The agent sees **four tools**:

| Tool | What it does |
|---|---|
| `find_analytics_objects` | resolves "my profit table" / "the sum variable" to real IDs |
| `search_analytics_api` | finds operations, returns TypeScript signatures |
| `get_analytics_guide` | OKF playbooks, references and 385 error codes |
| `run_analytics_code` | runs TypeScript in a sealed V8 isolate |

**203 operations** across ten API domains, as a UTCP manual. 76 read-only ones
are exposed by default; `ZA_DOMAINS` narrows further.

## Audit logging

Two streams, because they carry different things: `api.jsonl` is one line per
outbound Zoho call (low sensitivity, on by default), `detail.jsonl` is one
record per tool call including the program that ran (sensitive, opt-in via
`ZA_AUDIT=full`). They join on a request id.

JSON Lines, RFC 3339 timestamps, OWASP's when/where/who/what. **Secrets are
never written** unless `ZA_AUDIT_LOG_SECRETS=true` — redacted by exact value
and by pattern, including inside the generated program. Size-bounded with
logrotate-style backups; the default is 5 files per stream at 10 MB each, and
every value is configurable. Nothing is written to stdout in stdio mode,
because stdout is the protocol channel.

Each line carries a hash of the previous line **from the same writer**, so an
edit or deletion is detectable while agent restarts and concurrent hosts —
which legitimately share one file — still verify.

```bash
za-codemode audit    # paths, sizes, and chain verification
```

## Credentials stay out of the config file

```bash
za-codemode login     # interactive; run it in a terminal
za-codemode status    # which credential and scope are in use
```

`login` asks for the credential, **which of the ten tool groups the profile may
use**, and whether writes are allowed — then stores all of it in the OS
keychain. A profile is a scope, not just a credential, so a sandbox profile can
be read-write while production stays read-only with no environment juggling.
Every answer also has a flag, so a setup script need not be interactive.

Access tokens are cached in the keychain too, beside the profile, so restarting
an agent reuses a valid token rather than minting a new one — the same rules as
za-cli's TokenCache (version envelope, bound to client ID and data centre, 120 s
expiry skew, lifetime clamped at 24 h). Measured live: a warm start skips the
token exchange.

After that an agent's config holds no secrets — just the command to run.
Resolution order is environment variables, then `ZA_CREDENTIAL_COMMAND` (for
1Password / Vault), then the OS keychain by profile; the startup log reports
which answered. macOS Keychain, Windows Credential Manager, Linux Secret
Service, via the optional `@napi-rs/keyring` binding.

An encrypted file is deliberately **not** offered: the server is spawned by the
agent host with no terminal, so it can never prompt for a passphrase, and a key
kept beside the ciphertext protects nothing. See `guide/09-credentials.md`.

**Linux caveat, measured not assumed:** without `DBUS_SESSION_BUS_ADDRESS` a
keychain write appears to succeed, reads back in-process, and is invisible
everywhere else. `keychainAvailable()` therefore checks that prerequisite
rather than probing the library, and `login` refuses rather than storing
nothing.

## Self-contained

This repository depends on no sibling checkout. Both generated artifacts are
built from Zoho's **published** sources:

| Artifact | Built from |
|---|---|
| `manual/analytics.utcp.json` | [github.com/zoho/analytics-oas](https://github.com/zoho/analytics-oas) `v2.0/*-grouped-api.json` |
| `knowledge/knowledge.json` | [github.com/zoho/analytics-okf](https://github.com/zoho/analytics-okf), version resolved from its root `manifest.json` |

```bash
npm run build                                      # both, from the published repos
node tools/build-manual.mjs    --local <oas-dir>   # offline
node tools/build-knowledge.mjs --local <okf-dir>   # offline
node tools/build-knowledge.mjs --verify <okf-dir>  # has a checkout drifted?
```

Both outputs record where they came from, and the server reports the OKF
bundle's age at startup — warning past 90 days, so a stale snapshot is
visible rather than silently authoritative.

## Layout

```
za-codemode/
├── package.json             npm manifest — bin: za-codemode
├── .npmrc                   pins the public registry (@utcp/* is not mirrored)
├── .github/workflows/ci.yml tests on Node 20 + 22; guide links; HTML in step
├── deploy/                  UNRELEASED remote mode only — see its README
│   ├── Dockerfile           builds the HTTP server; isolated-vm, non-root
│   ├── docker-compose.yml   reference deployment with Redis
│   └── .env.example         every remote variable, documented
├── src/
│   ├── server.mjs           LOCAL entrypoint — stdio, single user
│   ├── remote.mjs           REMOTE entrypoint — HTTP, multi-user
│   ├── tools.mjs            the four tools, shared by both entrypoints
│   ├── catalog.mjs          operation catalog + sandbox — the ONLY UTCP usage
│   ├── sandbox-prelude.mjs  `find` (name resolver) + `rows` (result readers)
│   ├── search.mjs           query expansion, field-weighted ranking, signatures
│   ├── knowledge.mjs        OKF lookup, search, hints and provenance
│   ├── auth.mjs             refresh token -> access token, cached
│   ├── credentials.mjs      resolution: env -> credential command -> keychain
│   ├── cli.mjs              login / status / logout / audit
│   ├── token-cache.mjs      access-token reuse across process restarts
│   ├── audit.mjs            two audit streams, rotation, redaction, hash chain
│   ├── bin.mjs              entry point: no args -> server, args -> CLI
│   ├── config.mjs           environment parsing and startup validation
│   ├── quiet.mjs            stdout guard — MUST be the first import
│   └── remote/              UNRELEASED — built and tested, not documented
│       ├── http.mjs         express app: OAuth routes, /mcp, /healthz
│       ├── provider.mjs     OAuth 2.1 authorization server, delegating to Zoho
│       ├── zoho-oauth.mjs   Zoho Accounts client + organization probing
│       ├── sessions.mjs     one operation catalog per signed-in user
│       └── store.mjs        session storage: memory or Redis
├── tools/
│   ├── build-manual.mjs     github.com/zoho/analytics-oas -> UTCP catalog
│   └── build-knowledge.mjs  github.com/zoho/analytics-okf -> knowledge bundle
├── manual/                  generated catalog; never hand-edited
├── knowledge/               generated OKF bundle; never hand-edited
├── test/                    offline mocks, 101 tests
└── guide/                   the published setup & usage guide (md -> html)
    └── unpublished/         written but held back; see its README
```

## Working on it

```bash
npm install                  # public registry, pinned in .npmrc
npm link                     # puts `za-codemode` on PATH, for the CLI
npm test                     # 101 tests, fully offline
npm run build                # rebuild both artifacts from the published repos
npm start                    # stdio server

cd guide && python3 build.py --check    # validate the guide
cd guide && python3 build.py            # re-render it — commit the HTML too
```

CI runs the tests on Node 20 and 22, validates the guide's links and anchors,
and fails if the committed `guide/*.html` is out of step with the `.md`. The
`.html` files are generated *and committed*, so a doc change that touches only
the Markdown leaves the published guide stale — always re-render.

## Four invariants

**`src/quiet.mjs` must stay the first import of `server.mjs`.** An MCP stdio
server's stdout *is* the JSON-RPC channel, and the UTCP SDK logs progress with
`console.log`. One stray line corrupts the stream and the agent disconnects with
no diagnosable error.

**UTCP stays inside `src/catalog.mjs`.** It is a thin dependency (~5.6k npm
downloads/month) with several undocumented behaviours — all four of which are
documented at the top of that file. Keeping every import in one module means
replacing it later touches one file. Nothing else in the codebase should import
`@utcp/*`.

**The resolver must never substitute.** `find.require()` resolves a named
object or halts: no match, or two matches too close to separate, and the run
fails. Crucially this is enforced in `catalog.execute()`, not in the sandbox —
a program that catches the refusal and carries on with a different object
still fails, because the sandbox cannot be trusted to honour its own guard
rail. `test/resolve.test.mjs` pins that case specifically. Analysing
`sum_of_revenue` when the user said `sum_of_cost` is the worst outcome this
tool can produce.

**Call templates are exercised against a mock that enforces org scoping.** The
mock used to answer any request, which hid two bugs that would have broken every
call against live Analytics: UTCP's `headers` map sends `"{ARG}"` literally
(input fields must be listed in `header_fields`), and it sends the `api_key`
value verbatim (the `Bearer ` prefix has to be part of it). `test/mock-analytics.mjs`
now rejects an unknown `ZANALYTICS-ORGID` with 7111, and a regression test
covers both.

## Relationship to the other servers

| | [MCP Server](https://www.zoho.com/analytics/api/v2/zoho-analytics-mcp-server.html) | This |
|---|---|---|
| Tools | 26 curated, task-shaped | 4 |
| Operations reachable | 26 | 203 |
| Best at | single lookups | multi-step: loops, polling, aggregation |
| Runs model-written code | no | yes, sandboxed |

They are complementary and designed to be installed together. This one is
deliberately a **separate artifact**: executing model-written code has its own
risk profile and deserves its own release cadence, its own security review, and
a clean opt-out.

## Verified against a live organization

Run against a real Zoho Analytics org (81 workspaces, a 755-row table). Six
defects surfaced that mock-based tests had not caught — all fixed and pinned:

| Defect | Consequence |
|---|---|
| `expires_in` is **milliseconds** (`3600000`), not seconds | A one-hour token looked valid for 42 days and was never refreshed; every call failed with 8535 an hour in |
| An 81-workspace sweep trips **error 6045** | The limit is a *rate over a window*, not a per-call gap — measured 53/min clean, 105/min tripped after 27 calls. Calls now go through a sliding window (`ZA_MAX_CALLS_PER_MINUTE`, default 55) with 6/15/30 s backoff |
| A rate-limited sweep cannot finish inside the timeout | Covering 25 of 81 workspaces and saying "no such view" is a false negative; an unfinished search now refuses to claim absence |
| Export returns rows as a **flat array** in `data` | `data.rows` is `undefined` → `?? []` → a confident "no data" for a 755-row table |
| Values are **formatted strings** (`"$1,682.39"`) | `Number()` → `NaN` → sums silently come out 0 |
| Org header sent as the literal `{ZANALYTICS-ORGID}`, auth without `Bearer ` | Every call would have failed; UTCP needs `header_fields`, and sends `api_key` verbatim |

The two shape bugs mattered most: neither throws, both produce a plausible
wrong number. They survived every mock test because the mock returned the
shape the docs *claimed* rather than the shape the API *sends* — so
`test/mock-analytics.mjs` was corrected to mirror real responses. The same
analysis now returns **$1,299,947 across three regions** where the previously
documented pattern returned `{ rowCount: 0 }`.

## Status

101 tests pass offline: search quality and domain filtering, name resolution
(fuzzy matching, ambiguity, misses, columns, variables, enforced refusal),
result reading, call pacing, stdio end-to-end, audit streams and hash chaining,
credential resolution, token caching, the knowledge tool, and — for the
unreleased mode — the full OAuth flow and organization allowlist enforcement.

Not yet done:

- **The licence is not settled.** No terms are granted yet, which is why nothing
  is published to npm. See [`LICENSE.md`](LICENSE.md).
- **Results are not size-capped.** A program is instructed to `return` only its
  final answer, and nothing enforces it — a program that returns 10,000 rows
  puts 10,000 rows into the model's context. A token-bounded cap on the tool
  result, truncating to valid JSON and telling the model to narrow, is the
  clearest remaining gap.
- **The write path (`ZA_ALLOW_WRITES=true`) is lightly tested.** Exercise it
  against a non-production organization first.
- **No per-user rate limiting** of Analytics calls; `ZA_MAX_TOOL_CALLS` is per
  program, not per user per hour.
- **The knowledge bundle is a snapshot**, not a live view. Its age is reported
  at startup and warned about past 90 days.
- **`@utcp/sdk` pins `zod` 3.x**, which carries GHSA-mrhx-c7xc-m3w5 with no fix
  available upstream. `npm audit` reports it; it sits in UTCP's input-validation
  path.
- **No `--version`.** Installed from a clone, the commit is the build
  identifier.

See `guide/06-operating.md` for the full list of known rough edges.
