---
description: How to install Zoho Analytics Code Mode — obtaining OAuth credentials, the complete environment variable reference, and configuration for Claude Desktop, Claude Code, Cursor and VS Code.
---

# Install & configure

Ten minutes. You need Node 20 or newer, git, and a Zoho Analytics account.

## 1. Prerequisites

| ^Requirement | Check |
|---|---|
| Node.js 20+ | `node --version` |
| git | `git --version` |
| An MCP-capable agent | Claude Desktop, Claude Code, Cursor, VS Code, Windsurf |
| A terminal | `login` is interactive; your agent cannot run it for you |
| A Zoho Analytics organization | You need its Organization ID — see [step 2](#step-2-create-a-self-client) |

:::info Why Node
The sandbox is a V8 isolate provided by `isolated-vm`, a native module. Prebuilt binaries cover macOS on Apple silicon, Linux on x64 and arm64, and Windows on x64, so `npm install` needs no toolchain on any of those. Elsewhere — an Intel Mac, for instance — it compiles on install and needs Python 3, `make` and a C++ compiler first.
:::

## 2. Step 1 — Get the code

This is not on npm yet, so install it from source:

```bash
git clone https://github.com/sathishkumar-ks-8646/za-codemode.git
cd za-codemode
npm install
npm link
```

`npm link` puts a `za-codemode` command on your `PATH`, which is what the rest of this guide and your agent's configuration both call. Confirm it:

```bash
za-codemode help
```

:::info If npm link is not available to you
It writes into your global npm prefix, which some managed machines do not allow. Skip it and use the full path instead — everywhere this guide says `za-codemode`, write `node /path/to/za-codemode/src/bin.mjs`:

```bash
node /path/to/za-codemode/src/bin.mjs login
```

The agent configuration in [step 4](#step-4-add-it-to-your-agent) shows the matching form.
:::

Keep the clone. The server runs from it — deleting the directory breaks the command.

## 3. Step 2 — Create a Self Client

You need three OAuth values from Zoho. Create a **Self Client** in the Developer Console:

1. Go to [api-console.zoho.com](https://api-console.zoho.com) and sign in with the account that owns the data.
2. Choose **Add Client → Self Client → Create**.
3. Copy the **Client ID** and **Client Secret**.
4. Open the **Generate Code** tab and enter the scopes you need — see [below](#which-scopes).
5. Pick a validity of 10 minutes, give it a description, and click **Create**. Copy the code immediately — it is shown once.

You also need your **Organization ID**: in Zoho Analytics, go to **Settings → Organization**.

## 4. Which scopes

:::info The authoritative list is Zoho's
Scopes are an Analytics API concept, not something this tool defines, and the set grows. Read [Authentication](https://www.zoho.com/analytics/api/v2/authentication.html) in the API documentation and choose from there. What follows is orientation, not a substitute.
:::

A scope is `ZohoAnalytics.<family>.<operation>`, where `<operation>` is one of `read`, `create`, `update`, `delete` or `all`. Supply them to **Generate Code** as a comma-separated list:

```text
ZohoAnalytics.metadata.read,ZohoAnalytics.data.read,ZohoAnalytics.modeling.read
```

The families:

| ^Family | Covers |
|---|---|
| `metadata` | Organizations, workspaces, views, folders, trash, dependents |
| `data` | Row data: import, export, add, update and delete rows, sync and refetch |
| `modeling` | Schema objects: tables, columns, lookups, query tables, formulas, variables |
| `share` | Sharing, publishing, private and public URLs, slideshows, groups, workspace users |
| `embed` | Embed URLs, for Embedded Analytics (OEM) customers |
| `usermanagement` | Organization users, roles, subscription and resource usage |
| `fullaccess` | Everything above — `ZohoAnalytics.fullaccess.all` |

Three sets that match how this tool is actually used:

| ^You want to… | Grant |
|---|---|
| Read and analyse, nothing more | `ZohoAnalytics.metadata.read`, `ZohoAnalytics.data.read`, `ZohoAnalytics.modeling.read` |
| Also build tables, reports and formulas | add `ZohoAnalytics.modeling.all`, `ZohoAnalytics.data.all` |
| Not think about it | `ZohoAnalytics.fullaccess.all` |

:::danger `fullaccess.all` is the wrong default for this tool
It is the simplest answer and the wrong one here. This server executes code written by a language model, and **the OAuth grant — not `ZA_ALLOW_WRITES` — is the real boundary**: the flag is a setting on your own machine, while the grant is enforced by Zoho. A read-only grant means a misread prompt *cannot* delete a workspace, whatever the model writes or the configuration says.

Grant it only when you have a reason, and prefer a Self Client created for this tool alone so it can be revoked without affecting anything else. See [Security](04-security.md#enabling-write-operations).
:::

:::warn A missing scope surfaces late
An access token without the scope an operation needs fails with error **8535**, at the moment your agent makes the call — not at setup. Ask your agent `get_analytics_guide("8535")` if you see it. If you widen what the server may reach with `ZA_DOMAINS` or `ZA_ALLOW_WRITES`, check the grant still covers it.
:::

## 5. Step 3 — Store them

Run this **in a terminal** — not through your agent. It is interactive, and the server your agent spawns has no terminal to prompt from:

```bash
za-codemode login
```

It asks for your data centre, the Client ID and Secret, your Organization ID, and a refresh token — or paste the Generate Code grant from [step 2](#step-2-create-a-self-client) and it will do the exchange for you.

It then asks **which groups of tools this profile may use** and whether writes are allowed. Pick the smallest set that answers your questions; read-only is the default and the recommendation.

Finally it verifies the credential against Zoho before storing anything, so a typo fails here rather than inside your agent days later:

```text
Verifying... the credential works.

Stored under "zoho-analytics-codemode" / "default" in the Keychain.
  tool groups   data-operations, views-management, reports-dashboards
  data access   read-only
```

Credentials go into your operating system's keychain — macOS Keychain, Windows Credential Manager, Linux Secret Service. [Credentials & profiles](09-credentials.md) covers the whole command, scripting it, multiple profiles, and the one Linux caveat.

## 6. Step 4 — Add it to your agent

`login` prints this block. Note that it holds no credentials:

```json
{
  "mcpServers": {
    "zoho-analytics-code-mode": {
      "command": "za-codemode"
    }
  }
}
```

If you skipped `npm link`, name the entry point directly instead — an absolute path, because your agent does not start in your clone:

```json
{
  "mcpServers": {
    "zoho-analytics-code-mode": {
      "command": "node",
      "args": ["/path/to/za-codemode/src/bin.mjs"]
    }
  }
}
```

### Claude Desktop

Edit `claude_desktop_config.json`:

- **macOS** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows** `%APPDATA%\Claude\claude_desktop_config.json`
- **Linux** `~/.config/Claude/claude_desktop_config.json`

Quit Claude Desktop completely and reopen it. The tools appear in the tools menu.

:::warn Claude Desktop does not read your shell PATH
On macOS it is launched by the window server, not your shell, so a `za-codemode` installed by `npm link` is often invisible to it even though it works in your terminal. If the server fails to start there, use the `node` + absolute path form above.
:::

### Claude Code

```bash
claude mcp add zoho-analytics-code-mode -- za-codemode
```

### Cursor

Edit `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (per project), using the same `mcpServers` block.

### VS Code

Add the same block under `"mcp": { "servers": { … } }` in your user or workspace `settings.json`.

### Using a profile

If you created a named profile, that is the only thing `env` needs:

```json
"env": { "ZA_PROFILE": "eu-reporting" }
```

## 7. Step 5 — Check it works

Ask your agent:

> Search the Analytics API for how to list workspaces, then run code to count how many I have.

A healthy run calls `search_analytics_api`, then `run_analytics_code`, and answers with a number. If nothing happens, go to [Troubleshooting](05-troubleshooting.md).

## 8. Choosing what to expose

`login` asks this, and stores the answer with the profile. Two independent choices decide which of the 203 operations the sandbox can reach.

**Which tool groups** — the ten API domains. Press Enter at the prompt for all of them:

| ^Domain | Ops | Covers |
|---|---|---|
| `workspace-management` | 35 | Workspaces, backups, linking, templates, variables |
| `data-modeling-schema` | 33 | Tables, columns, formulas, query tables, lookups |
| `user-groups` | 26 | Users, groups, roles, portals |
| `views-management` | 26 | Views, folders, tags, trash, copy and move |
| `data-operations` | 20 | Rows, imports, exports, bulk jobs, data sync |
| `share-publish` | 20 | Sharing, permissions, embed URLs, public links, slideshows |
| `schedules-alerts` | 16 | Email schedules and data alerts |
| `dsml` | 11 | AutoML analyses, training, predictions |
| `org-management` | 10 | Organizations, subscriptions, security controls |
| `reports-dashboards` | 6 | Charts, pivots, summaries, dashboards |

**Read or write** — read-only by default, leaving only the `GET` operations.

```text
  Groups [all]: 2,9,5
  -> data-operations, views-management, reports-dashboards
  Allow writes? [y/N]: n
  -> read-only

  18 operations instead of 203
```

To change them later, run `login` again for that profile. To override them for one session without rewriting the profile, set `ZA_DOMAINS` or `ZA_ALLOW_WRITES`.

:::good A smaller surface is a better surface
It is not only safer. Fewer operations means `search_analytics_api` has less to confuse itself with, so the model picks the right one more often. Expose what the users of that deployment actually need.
:::

The server prints the breakdown at startup:

```text
[za] ready — 18/203 operations (read-only), org 2375824000000000001, https://analyticsapi.zoho.com
[za] credentials — keychain:default
[za] domains — data-operations:8 reports-dashboards:2 views-management:8
[za] knowledge — 17 guides, 385 error codes (OKF 2.0.0, generated 2026-10-27, 15d old)
```

## 9. Configuration reference

Most people need none of these — `login` covers the credentials and the tool
scope. They exist for containers, CI, and for overriding a stored profile.

:::info Environment beats the keychain
If an `ANALYTICS_*` variable is set, it wins. That is deliberate — a container
has no keychain — but it also means a stale variable can silently shadow a
stored profile. `za-codemode status` reports which source actually answered.
:::

Every variable the server reads.

| ^Variable | Required | Default | Purpose |
|---|---|---|---|
| `ZA_PROFILE` | no | `default` | Which stored credential and scope to use |
| `ZA_CREDENTIAL_COMMAND` | no | — | A command printing credentials as JSON, for 1Password / Vault |
| `ANALYTICS_CLIENT_ID` | no¹ | — | OAuth client ID |
| `ANALYTICS_CLIENT_SECRET` | no¹ | — | OAuth client secret |
| `ANALYTICS_REFRESH_TOKEN` | no¹ | — | Used to mint access tokens automatically |
| `ANALYTICS_ORG_ID` | no¹ | — | Organization every call is scoped to |
| `ANALYTICS_SERVER_URL` | no | `https://analyticsapi.zoho.com` | Your data centre's API host |
| `ACCOUNTS_SERVER_URL` | no | `https://accounts.zoho.com` | Your data centre's accounts host |
| `ANALYTICS_ACCESS_TOKEN` | no | — | A static token, for a short test instead of OAuth¹ |
| `ZA_ALLOW_WRITES` | no | from the profile | Overrides the profile's write permission |
| `ZA_DOMAINS` | no | from the profile | Overrides the profile's tool groups — see [above](#choosing-what-to-expose) |
| `ZA_MAX_TOOL_CALLS` | no | `200` | API calls allowed in one program |
| `ZA_MAX_CALLS_PER_MINUTE` | no | `55` | Sliding-window rate cap, so a loop cannot trip the API frequency limit |
| `ZA_MIN_CALL_INTERVAL_MS` | no | `50` | Minimum gap between calls, against microbursts |
| `ZA_THROTTLE_RETRIES` | no | `3` | Retries with backoff (6 s, 15 s, 30 s) when the API returns 6045 |
| `ZA_EXEC_TIMEOUT_MS` | no | `60000` | Wall-clock limit for one program |
| `ZA_EXEC_MEMORY_MB` | no | `256` | Memory limit for the sandbox |
| `ZA_MANUAL_PATH` | no | bundled | An alternative operation catalog |
| `ZA_KNOWLEDGE_PATH` | no | bundled | An alternative knowledge bundle |

¹ Not required if you used `login`. Otherwise supply the three OAuth values, or `ANALYTICS_ACCESS_TOKEN` for a short test — that one expires after an hour and is not renewed.

:::warn Only if you set credentials by environment
A config file is plain text on your machine, and a Zoho refresh token does not expire. If you put credentials in one, treat the file as a secret: do not commit it, and use a dedicated Self Client so it can be revoked on its own. `login` avoids the question entirely.
:::
