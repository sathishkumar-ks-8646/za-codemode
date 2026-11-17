---
description: Audit logging for Zoho Analytics Code Mode — two streams, how much history each keeps, what is redacted, and every setting an operator can change.
---

# Audit logging

Every call this server makes to Zoho Analytics can be recorded, and so can every program your agent runs. Both are off-by-default in the sense that matters: **secrets are never written** unless you deliberately ask for them.

## 1. Two streams, because they are not alike

| ^Stream | One line per | Sensitivity | Default |
|---|---|---|---|
| `api.jsonl` | outbound call to Zoho | low — operations and IDs, no data | **on** |
| `detail.jsonl` | MCP tool call, including the program that ran | **high** — a filter can carry customer names | off |

```json
{"ts":"2026-11-17T09:14:22.431Z","ev":"api","req":"d002c50b","actor":"keychain:default",
 "org":"55511666","op":"exportDataView","method":"GET","status":200,"ms":412,"bytes":184203}
```

```json
{"ts":"2026-11-17T09:14:22.019Z","ev":"execution","req":"d002c50b","actor":"keychain:default",
 "org":"55511666","tool":"run_analytics_code",
 "scope":{"domains":["data-operations"],"writes":false},
 "code":"const ws = await za.getOrgWorkspaces(...)","outcome":"ok","ms":1840,"apiCalls":7}
```

The two join on `req`, so one execution and every API call it caused read as a single story.

Format is JSON Lines with RFC 3339 UTC timestamps, carrying the *when, where, who and what* that OWASP asks of an audit record. Authentication outcomes — successes and denials both — are recorded too.

## 2. Turning it on

```bash
ZA_AUDIT=api     # outbound calls only  (default)
ZA_AUDIT=full    # add the detail stream
ZA_AUDIT=off     # nothing
```

```bash
npx zoho-analytics-code-mode-mcp audit    # where the files are, and verify them
```

## 3. How much history you get

Defaults differ by server type, because the workloads do. Measured on this server's own records, an API line is about **270 bytes** and an execution record about **1.4 KB**.

| ^ | Local (stdio) | Remote (HTTP) |
|---|---|---|
| File size | 10 MB | 10 MB |
| `api.jsonl` history | 5 files — 50 MB | 10 files — 100 MB |
| `detail.jsonl` history | 5 files — 50 MB | 10 files — 100 MB |
| Also to stdout | no¹ | yes, for a collector |

¹ For a stdio server, stdout *is* the MCP protocol channel — writing there would corrupt it. The setting is ignored rather than honoured.

What that buys, at the measured sizes:

| ^Programs per day | Both streams last |
|---|---|
| 50 | over a year |
| 500 | about 60 days |
| 5,000 | about 6 days |
| 50,000 | under a day |

:::warn Size caps and retention obligations are different questions
A one-person setup has years of history in 100 MB. A busy shared server does not. If you owe someone 90 days or a year of retention, raise the file count, or export — see [§7](#shipping-them-somewhere-else). The cap bounds disk, it does not satisfy a policy.
:::

## 4. Every setting

| ^Variable | Default | What it does |
|---|---|---|
| `ZA_AUDIT` | `api` | `off`, `api`, or `full` |
| `ZA_AUDIT_DIR` | `~/.zoho-analytics-code-mode/audit` | Where files are written, mode `0700` |
| `ZA_AUDIT_MAX_FILE_MB` | `10` | Size of one file before it rotates |
| `ZA_AUDIT_API_FILES` | `5` local, `10` remote | How many `api.jsonl` backups to keep |
| `ZA_AUDIT_DETAIL_FILES` | `5` local, `10` remote | How many `detail.jsonl` backups to keep |
| `ZA_AUDIT_MAX_FILES` | — | Sets both of the above at once |
| `ZA_AUDIT_LOG_SECRETS` | **`false`** | Write tokens and secrets in clear |
| `ZA_AUDIT_LOG_CODE` | `true` | Record the program text in the detail stream |
| `ZA_AUDIT_LOG_ARGS` | `true` | Record tool arguments |
| `ZA_AUDIT_HASH_CHAIN` | `true` | Per-line hashes for tamper detection |
| `ZA_AUDIT_STDOUT` | `false` local, `true` remote | Also emit JSON Lines on stdout |

Total disk is `ZA_AUDIT_MAX_FILE_MB × (ZA_AUDIT_API_FILES + ZA_AUDIT_DETAIL_FILES)`, plus the two files currently being written.

## 5. What is never written

Tokens, client secrets, session keys and refresh tokens are stripped before anything reaches disk — by exact value where this process knows it, and by pattern otherwise, including inside the generated program:

```javascript
// what the model wrote                  // what the log records
const t = '1000.deadbeef….0123';         const t = '[redacted]';
```

:::danger `ZA_AUDIT_LOG_SECRETS=true` means exactly that
Access tokens and client secrets are written in clear text to a file on disk. It exists for debugging one machine, never for a deployment. The server prints a warning at startup when it is on, and the setting is reported by `audit`.
:::

Row data is never logged in either stream. The detail stream records what a program *did*, not what it *returned*.

## 6. Tamper detection

Each line carries a hash of the previous line from the same writer. Editing or deleting a line breaks the chain from that point, and `audit` reports where:

```text
  integrity:
    api      1,284 lines, chain intact
    detail   BROKEN at line 412 — chain broken — a line was changed or removed
```

Chains are **per writer**, because one file legitimately holds lines from several processes: a local server is respawned every time you restart your agent, and two agent hosts can write at once. Each run verifies on its own, so restarts and interleaving are not mistaken for tampering.

:::info What this does and does not prove
It detects edits and deletions by something that cannot rewrite the whole file. It does not stop an administrator who can. On a machine the user controls, local logs are useful for "what did my agent do" — they are **not** a compliance control. For that, get them off the host.
:::

## 7. Shipping them somewhere else

Remote mode writes JSON Lines to stdout by default, so a container collector picks them up with no extra configuration:

```bash
docker logs -f zoho-analytics-code-mode | jq 'select(.ev=="api")'
```

From there the usual routes apply — Fluent Bit, Vector, the Docker logging driver, or a sidecar into your SIEM. Because the format is one JSON object per line with stable field names, nothing needs parsing rules.

For local mode, point `ZA_AUDIT_DIR` at a directory your agent already collects, or tail the files.

## 8. What is still missing

Stated plainly, because a reviewer will ask:

- **No per-user rate limiting of Analytics calls.** `ZA_MAX_TOOL_CALLS` is per program, not per user per hour.
- **No access log for the audit files themselves.** OWASP asks for an audit trail of the audit trail; that belongs to your filesystem auditing, not here.
- **No built-in retention by age.** Rotation is by size. If you need "90 days", size the files for your volume and check with `audit`.
- **Local mode is self-auditing.** See the note in [§6](#tamper-detection).
