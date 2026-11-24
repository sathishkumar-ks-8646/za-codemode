---
description: Troubleshooting Zoho Analytics Code Mode — symptoms, Analytics error codes, startup failures, and frequently asked questions.
---

# Troubleshooting & FAQ

## 1. Symptom first

| ^Symptom | Likely cause | Go to |
|---|---|---|
| The tools do not appear in my agent | Config not loaded, or the server exited at startup | [§2](#the-server-will-not-start) |
| "server failed to start", nothing else | Missing or invalid configuration | [§2](#the-server-will-not-start) |
| Everything fails with 8535 | Credentials rejected, or data centre mismatch | [§3](#error-codes) |
| `... is not a function` | The agent guessed an operation name, or it is a write | [§4](#operation-not-found) |
| Error 8080 on every call | `CONFIG` sent as an object instead of a string | [§3](#error-codes) |
| "API call budget exhausted" | The program looped more than 200 times | [§5](#limits-and-timeouts) |
| Programs time out | A blocking export that should be an async job | [§5](#limits-and-timeouts) |
| Answers are wrong but confident | Model quality, or a wrong filter | [§6](#the-answers-look-wrong) |

## 2. The server will not start

A stdio server that exits is reported by most agents as a bare "failed to start". Run it by hand to see the real reason:

```bash
ANALYTICS_CLIENT_ID=... ANALYTICS_CLIENT_SECRET=... \
ANALYTICS_REFRESH_TOKEN=... ANALYTICS_ORG_ID=... \
za-codemode
```

A healthy start prints one line and then waits:

```text
[za] ready — 76/203 operations (read-only), org 2375824000000000001, https://analyticsapi.zoho.com
```

A configuration problem prints exactly what is wrong:

```text
Zoho Analytics Code Mode — cannot start:

  • ANALYTICS_ORG_ID is not set. Every Analytics v2 request must name an
    organization; find the ID in the Analytics UI under Settings > Organization.
```

| ^Exit code | Meaning |
|---|---|
| 78 | Configuration problem — the message lists every one |
| 70 | Startup failed, usually a credential rejection |

### "failed to map segment from shared object"

The clone is on a filesystem mounted `noexec`, so the sandbox's native module cannot be loaded even though it installed correctly. `/tmp` is the usual culprit, and so are some mounted volumes and hardened `/home` setups. Check it:

```bash
findmnt -no TARGET,OPTIONS -T .
```

If the options list `noexec`, move the clone somewhere executable — your home directory on most machines — and run `npm install` again there. Nothing else needs changing.

### "EACCES … symlink" from npm link

Your npm prefix is a root-owned system directory, which is normal for a distribution-packaged Node. Do not reach for `sudo`; point npm at a prefix you own:

```bash
npm config set prefix ~/.local
npm link
```

Make sure `~/.local/bin` is on your `PATH`. Or skip `npm link` entirely and use the `node` plus absolute path form — `za-codemode login` prints the matching agent configuration either way.

:::warn Never print to stdout from a fork of this server
An MCP stdio server's stdout *is* the protocol channel. A single stray `console.log` corrupts it and the agent disconnects with no useful message. `src/quiet.mjs` redirects all console output to stderr and must stay the first import.
:::

## 3. Error codes

| ^Code | Meaning | Fix |
|---|---|---|
| **8535** | Access token rejected | Check the three OAuth values, and that `ACCOUNTS_SERVER_URL` and `ANALYTICS_SERVER_URL` name the **same** data centre |
| **8080** | `CONFIG` is not valid | It must be a `JSON.stringify()`'d string, not an object literal |
| **7103** | Organization, workspace, view or job not found | It does not exist, was deleted, or is not visible to this user. Resolve IDs by name first |
| **7301** | Authenticated, but not permitted | The Analytics user lacks the role or view permission this operation needs |
| **7390** | Workspace is in a different organization | The workspace does not belong to the organization in `ZANALYTICS-ORGID` |
| **8084** | No such organization | `ANALYTICS_ORG_ID` names an organization that does not exist |
| **6045** | API frequency limit exceeded | Too many calls inside one window. Calls are capped at 55/min and retried with backoff; if it persists, narrow the task to one workspace or lower `ZA_MAX_CALLS_PER_MINUTE` |
| **HTTP 401** | Same as 8535 | As above |

The server annotates these automatically from the OKF error catalog — all **385 documented codes**, not just the ones above — so the agent usually corrects itself on the next attempt. Your agent can also look one up directly with `get_analytics_guide("8080")`.

### Data centre mismatch

The single most common setup error: a token minted at `accounts.zoho.com` but spent at `analyticsapi.zoho.eu`. The server detects the mismatch at startup and refuses to run rather than letting you debug 8535 in the dark. Both URLs must be the same row of [the data centre table](09-credentials.md#what-it-asks).

## 4. Operation not found

```text
Execution failed: za.getOwnedWorkspaces is not a function
```

Three possibilities:

1. **The agent guessed.** Operation names come from the OpenAPI specification and are case-sensitive. Tell it to call `search_analytics_api` first.
2. **It is a write operation.** Those are hidden unless `ZA_ALLOW_WRITES=true`. See [Security](04-security.md#enabling-write-operations).
3. **The name genuinely changed.** For example `getOwnedWorkspaces` no longer exists; the current operation is `getOrgWorkspaces`. See the [organization context migration guide](https://www.zoho.com/analytics/api/v2/).

## 5. Limits and timeouts

| ^Message | Meaning | Options |
|---|---|---|
| "API call budget exhausted after 200 calls" | The program looped too far | Narrow the task; filter with `CONFIG` criteria instead of fetching everything; or raise `ZA_MAX_TOOL_CALLS` |
| Timed out | Longer than 60 s | Use `createExportJob*` + `getExportJobDetails` instead of a blocking export; or raise `ZA_EXEC_TIMEOUT_MS` |
| Out of memory | Accumulated too many rows | Aggregate per view instead of collecting everything first; or raise `ZA_EXEC_MEMORY_MB` |

Raising a limit is usually the wrong first move. Each one is normally telling you the program is fetching data it does not need.

## 6. "You have no data" but you definitely do

Almost always one of two things, both of which the `rows` helpers exist to prevent:

- The program read `out.data.rows`. Export returns a **flat array** in `data`; `data.rows` is `undefined`, and `?? []` turns that into an empty result.
- The program summed `Number(row.Sales)` on `"$1,682.39"`, which is `NaN`.

Ask your agent to show the code. If it is not using `rows.of()` and `rows.sum()`, tell it to.

## 7. The answers look wrong

The sandbox guarantees the code is *contained*, not that it is *correct*. When a figure looks off:

1. **Ask to see the code.** "Show me the code you ran." Check the filter, the date range and the column names.
2. **Check the organization.** Everything is scoped to `ANALYTICS_ORG_ID`; data in another organization is invisible.
3. **Check read-only mode.** If the agent tried to create something and silently moved on, it may be working from a partial picture.
4. **Consider the model.** A stronger model writes noticeably better code. This is the most common cause of poor results.

## 8. Frequently asked questions

### Q. Does this replace the Zoho Analytics MCP Server?

No. They complement each other: 26 named tools for single lookups, this for multi-step work. Install both. See [the comparison](01-what-it-is.md#how-this-relates-to-the-zoho-analytics-mcp-server).

### Q. Does it reduce my API unit consumption?

No. The same operations are called, so the same units are billed. What it reduces is model turns and context — in a measured multi-workspace export, 19 model turns became 1.

### Q. Do I need an OpenAI or Anthropic API key?

No. Your agent supplies the model. This server contains no AI.

### Q. Where does my data go?

From Zoho Analytics to your machine, and from there only what the program returns goes to your AI provider. Nothing is routed through Zoho's agent infrastructure.

### Q. Can I run it for my whole team from one place?

Not yet. Today each person installs it and stores their own credential, which also means each person's access is exactly their own Analytics permissions. A shared, multi-user deployment with browser sign-in is built but not released.

### Q. Which operations are available?

All 203 from the v2 OpenAPI specifications; 76 read-only ones are exposed by default. Ask your agent to search — that is what `search_analytics_api` is for.

### Q. Can the model see my credentials?

No. They stay in the host process and are substituted into requests after the sandbox hands over a call.

### Q. Is there an audit log?

Yes. One line per outbound Zoho call is written by default; set `ZA_AUDIT=full` to also record the program each execution ran. Secrets are redacted, files rotate, and each line carries a hash of the previous one so edits are detectable. See [Audit logging](10-audit.md).

### Q. Why does it need Node 22?

The sandbox is a V8 isolate provided by `isolated-vm`, a native module. It ships prebuilt binaries only for Node 22 and Node 24; on anything older there is nothing to install, so npm falls back to compiling it from source — and the source uses a part of V8 that does not exist before Node 22, so the compile fails too.

Node 20 was *claimed* as supported until November 2026, but it never actually worked: the pinned `isolated-vm` has required Node 22 since the first release. The claim was removed rather than the requirement lowered — Node 20 reached end of life on 30 April 2026, and the last `isolated-vm` that runs on it is two major versions behind.

### Q. Can I add my own operations?

Yes — point `ZA_MANUAL_PATH` at your own catalog, or regenerate the bundled one from the OpenAPI specs with `npm run build:manual`. See [Operating](06-operating.md#building-the-catalog-from-source).
