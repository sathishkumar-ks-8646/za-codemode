---
description: How to install Zoho Analytics Code Mode — what you need before you start, creating the OAuth credential, installing on macOS, Linux or Windows, and connecting Claude Code, Claude Desktop, Cursor or VS Code.
---

# Install & configure

Two halves. First you get two things from Zoho — an **Organization ID** and an **OAuth credential**. Then you install the tool and point your agent at it. Budget ten minutes; the Zoho half is most of it.

:::info What you are setting up
A server that runs on your own machine, spawned by your agent. Nothing is hosted, no port is opened, and no AI model is supplied — your agent brings its own.
:::

## 1. What you need

| ^Requirement | Check or get it |
|---|---|
| A Zoho Analytics organization | You will need its ID — [step 1](#step-1-get-your-zoho-credentials) |
| An MCP-capable agent | Claude Code, Claude Desktop, Cursor, VS Code, Windsurf |
| Node.js 22 or newer | `node --version` — the sandbox ships no binary for anything older |
| git | `git --version` |
| A terminal | `login` asks questions; your agent cannot answer them for you |

:::info If Node or git are missing
+++tabs os
+++tab macOS
```bash
brew install node git
```
Or download the Node installer from [nodejs.org](https://nodejs.org). git also arrives with the Xcode command line tools: `xcode-select --install`.
+++tab Linux
```bash
# Debian, Ubuntu
sudo apt install nodejs npm git

# Fedora, RHEL
sudo dnf install nodejs git
```
If your distribution packages a Node older than 20, use [nodesource](https://github.com/nodesource/distributions) or [nvm](https://github.com/nvm-sh/nvm) instead.
+++tab Windows
```powershell
winget install OpenJS.NodeJS.LTS Git.Git
```
Or download both installers: [nodejs.org](https://nodejs.org) and [git-scm.com](https://git-scm.com). Reopen your terminal afterwards so `PATH` picks them up.
+++
:::

## 2. Step 1 — Get your Zoho credentials

Two values, both from Zoho, both needed before the tool is any use.

### Your Organization ID

In Zoho Analytics, go to **Settings → Organization**. Copy the ID — a long number like `2375824000000000001`. Every call this tool makes is scoped to it.

### An OAuth credential

A **Self Client** is the right kind here: it is for a program acting as you, with no browser sign-in.

1. Go to [api-console.zoho.com](https://api-console.zoho.com) and sign in with the account that owns the data.
2. Choose **Add Client → Self Client → Create**.
3. Copy the **Client ID** and **Client Secret**.
4. Open the **Generate Code** tab and enter the scopes you need — see [below](#which-scopes).
5. Set a validity of 10 minutes, give it a description, and click **Create**.

Copy the generated code immediately: it is shown once and it expires in minutes. You will paste it in [step 3](#step-3-store-your-credentials), which exchanges it for a refresh token.

:::warn Use a Self Client made for this tool alone
Then revoking it stops this tool and nothing else. Reusing a credential that other integrations share means you cannot withdraw access from one without breaking the rest.
:::

## 3. Which scopes

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

Grant it only when you have a reason. See [Security](04-security.md#enabling-write-operations).
:::

:::warn A missing scope surfaces late
An access token without the scope an operation needs fails with error **8535**, at the moment your agent makes the call — not at setup. Ask your agent `get_analytics_guide("8535")` if you see it. If you widen what the server may reach with `ZA_DOMAINS` or `ZA_ALLOW_WRITES`, check the grant still covers it.
:::

## 4. Step 2 — Install the tool

Not on npm yet, so it installs from a clone. Three commands anywhere you keep source:

+++tabs os
+++tab macOS
```bash
git clone https://github.com/sathishkumar-ks-8646/za-codemode.git
cd za-codemode
npm install
npm link
```

`npm link` puts a `za-codemode` command on your `PATH`. Check it:

```bash
za-codemode help
```

On Apple silicon the sandbox's native module installs from a prebuilt binary, so there is nothing to compile. On an Intel Mac there is no prebuilt binary: install the Xcode command line tools first with `xcode-select --install`.
+++tab Linux
```bash
git clone https://github.com/sathishkumar-ks-8646/za-codemode.git
cd za-codemode
npm install
npm link
```

`npm link` puts a `za-codemode` command on your `PATH`. Check it:

```bash
za-codemode help
```

Prebuilt binaries cover x64 and arm64, so nothing compiles. If `npm link` fails on permissions, set a user-owned prefix rather than using `sudo`:

```bash
npm config set prefix ~/.local
```
+++tab Windows
```powershell
git clone https://github.com/sathishkumar-ks-8646/za-codemode.git
cd za-codemode
npm install
npm link
```

`npm link` puts a `za-codemode` command on your `PATH`. Check it:

```powershell
za-codemode help
```

Prebuilt binaries cover x64, so nothing compiles. Use PowerShell rather than Command Prompt — the multi-line commands later in this guide assume it.
+++

:::info If npm link is not available to you
It writes into your global npm prefix, which some managed machines do not allow. Skip it: everywhere this guide says `za-codemode`, write `node /path/to/za-codemode/src/bin.mjs` instead.

```bash
node /path/to/za-codemode/src/bin.mjs login
```

[Step 4](#step-4-connect-your-agent) shows the matching agent configuration.
:::

Keep the clone. The server runs from it, so deleting the directory breaks the command.

## 5. Step 3 — Store your credentials

Run this **in a terminal**, not through your agent. It asks questions, and the server your agent spawns has no terminal to answer them from:

```bash
za-codemode login
```

It asks for your data centre, the Client ID and Secret, the Organization ID, and a refresh token — or paste the Generate Code grant from [step 1](#step-1-get-your-zoho-credentials) and it will do the exchange for you.

Then it asks **which groups of tools this profile may use** and whether writes are allowed. Pick the smallest set that answers your questions; read-only is the default and the recommendation. See [Choosing what to expose](#choosing-what-to-expose).

Finally it verifies the credential against Zoho before storing anything, so a typo fails here rather than inside your agent days later:

```text
Verifying... the credential works.

Stored under "zoho-analytics-codemode" / "default" in the Keychain.
  tool groups   data-operations, views-management, reports-dashboards
  data access   read-only
```

Credentials go into your operating system's keychain:

| ^Platform | Store |
|---|---|
| macOS | Keychain |
| Windows | Credential Manager |
| Linux | Secret Service — gnome-keyring or KWallet |

[Credentials & profiles](09-credentials.md) covers the whole command, scripting it, several profiles, and the one Linux caveat.

## 6. Step 4 — Connect your agent

`login` prints the block to paste. It holds no secrets — just the command to run:

+++tabs agent
+++tab Claude Code
One command, nothing to edit:

```bash
claude mcp add zoho-analytics-code-mode -- za-codemode
```

Check it registered:

```bash
claude mcp list
```
+++tab Claude Desktop
Edit `claude_desktop_config.json`:

| ^Platform | Path |
|---|---|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| Linux | `~/.config/Claude/claude_desktop_config.json` |

```json
{
  "mcpServers": {
    "zoho-analytics-code-mode": {
      "command": "za-codemode"
    }
  }
}
```

Quit Claude Desktop **completely** and reopen it — closing the window is not enough. The tools then appear in the tools menu.

:::warn Claude Desktop does not read your shell PATH
On macOS it is launched by the window server, not your shell, so a `za-codemode` installed by `npm link` is often invisible to it even though it works in your terminal. If the server fails to start, use the absolute-path form:

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
:::
+++tab Cursor
Edit `~/.cursor/mcp.json` for every project, or `.cursor/mcp.json` inside one:

```json
{
  "mcpServers": {
    "zoho-analytics-code-mode": {
      "command": "za-codemode"
    }
  }
}
```
+++tab VS Code
Add this to your user or workspace `settings.json` — note the `servers` key, which differs from the others:

```json
{
  "mcp": {
    "servers": {
      "zoho-analytics-code-mode": {
        "command": "za-codemode"
      }
    }
  }
}
```
+++tab Windsurf
Edit `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "zoho-analytics-code-mode": {
      "command": "za-codemode"
    }
  }
}
```
+++

### Using a named profile

If you created one, that is the only thing `env` needs:

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
| `ZA_MAX_RESULT_ROWS` | no | `500` | Rows a tool result may carry before it is truncated — see [Reading data](11-data-engine.md#result-caps) |
| `ZA_MAX_RESULT_BYTES` | no | `120000` | Serialized size a tool result may reach |
| `ZA_JOB_POLL_INTERVAL_MS` | no | `1000` | Gap between two status reads of the same export job |
| `ZA_MANUAL_PATH` | no | bundled | An alternative operation catalog |
| `ZA_KNOWLEDGE_PATH` | no | bundled | An alternative knowledge bundle |

¹ Not required if you used `login`. Otherwise supply the three OAuth values, or `ANALYTICS_ACCESS_TOKEN` for a short test — that one expires after an hour and is not renewed.

:::warn Only if you set credentials by environment
A config file is plain text on your machine, and a Zoho refresh token does not expire. If you put credentials in one, treat the file as a secret: do not commit it, and use a dedicated Self Client so it can be revoked on its own. `login` avoids the question entirely.
:::
