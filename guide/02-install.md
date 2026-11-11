---
description: How to install Zoho Analytics Code Mode — obtaining OAuth credentials, the complete environment variable reference, and configuration for Claude Desktop, Claude Code, Cursor and VS Code.
---

# Install & configure

Five minutes. You need Node 20 or newer, and a Zoho Analytics account.

## 1. Prerequisites

| ^Requirement | Check |
|---|---|
| Node.js 20+ | `node --version` |
| An MCP-capable agent | Claude Desktop, Claude Code, Cursor, VS Code, Windsurf |
| A Zoho Analytics organization | You need its Organization ID — see [step 2](#step-2-find-your-organization-id) |

:::info Why Node
The sandbox is a V8 isolate provided by a native module, which installs automatically on first run. There is nothing to compile by hand.
:::

## 2. Step 1 — Get your credentials

You need three OAuth values. Create a **Self Client** in the Zoho Developer Console:

1. Go to [api-console.zoho.com](https://api-console.zoho.com) and sign in with the account that owns the data.
2. Choose **Add Client → Self Client → Create**.
3. Copy the **Client ID** and **Client Secret**.
4. Open the **Generate Code** tab, and enter this scope:
   ```text
   ZohoAnalytics.data.all,ZohoAnalytics.metadata.read,ZohoAnalytics.modeling.read
   ```
5. Pick a validity of 10 minutes, provide a description, and click **Create**. Copy the code immediately — it is shown once.
6. Exchange the code for a refresh token:

```bash
curl -X POST "https://accounts.zoho.com/oauth/v2/token" \
  -d "grant_type=authorization_code" \
  -d "client_id=YOUR_CLIENT_ID" \
  -d "client_secret=YOUR_CLIENT_SECRET" \
  -d "code=THE_CODE_YOU_JUST_COPIED"
```

The response contains `refresh_token`. That value does not expire — store it like a password.

:::warn Scopes decide what the agent can reach
The scopes above are read-oriented. If you later enable write operations you will need the matching write scopes, and you should think carefully before granting them. See [Security](04-security.md#enabling-write-operations).
:::

## 3. Step 2 — Find your Organization ID

Every Analytics v2 request names one organization.

- **From the UI:** open Zoho Analytics, go to **Settings → Organization**, and copy the Org ID.
- **From the API:** `GET /restapi/v2/orgs/workspaces` returns it alongside your workspaces.

## 4. Step 3 — Pick your data centre

Both URLs must name the **same** data centre. Mismatching them is the most common setup error, and the only symptom is a confusing authentication failure on the first call — so the server checks this at startup and refuses to run.

| ^Data centre | `ANALYTICS_SERVER_URL` | `ACCOUNTS_SERVER_URL` |
|---|---|---|
| United States | `https://analyticsapi.zoho.com` | `https://accounts.zoho.com` |
| Europe | `https://analyticsapi.zoho.eu` | `https://accounts.zoho.eu` |
| India | `https://analyticsapi.zoho.in` | `https://accounts.zoho.in` |
| Australia | `https://analyticsapi.zoho.com.au` | `https://accounts.zoho.com.au` |
| Japan | `https://analyticsapi.zoho.jp` | `https://accounts.zoho.jp` |
| Canada | `https://analyticsapi.zohocloud.ca` | `https://accounts.zohocloud.ca` |
| Saudi Arabia | `https://analyticsapi.zoho.sa` | `https://accounts.zoho.sa` |

## 5. Step 4 — Add it to your agent

### Claude Desktop

Edit `claude_desktop_config.json`:

- **macOS** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows** `%APPDATA%\Claude\claude_desktop_config.json`
- **Linux** `~/.config/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "zoho-analytics-code-mode": {
      "command": "npx",
      "args": ["-y", "zoho-analytics-code-mode-mcp"],
      "env": {
        "ANALYTICS_CLIENT_ID": "1000.XXXXXXXXXXXX",
        "ANALYTICS_CLIENT_SECRET": "your-client-secret",
        "ANALYTICS_REFRESH_TOKEN": "1000.xxxxxxxxxxxx",
        "ANALYTICS_ORG_ID": "2375824000000000001",
        "ACCOUNTS_SERVER_URL": "https://accounts.zoho.com",
        "ANALYTICS_SERVER_URL": "https://analyticsapi.zoho.com"
      }
    }
  }
}
```

Quit Claude Desktop completely and reopen it. The two tools appear in the tools menu.

### Claude Code

```bash
claude mcp add zoho-analytics-code \
  --env ANALYTICS_CLIENT_ID=1000.XXXXXXXXXXXX \
  --env ANALYTICS_CLIENT_SECRET=your-client-secret \
  --env ANALYTICS_REFRESH_TOKEN=1000.xxxxxxxxxxxx \
  --env ANALYTICS_ORG_ID=2375824000000000001 \
  -- npx -y zoho-analytics-code-mode-mcp
```

### Cursor

Edit `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (per project), using the same `mcpServers` block as Claude Desktop.

### VS Code

Add the same block under `"mcp": { "servers": { … } }` in your user or workspace `settings.json`.

## 6. Step 5 — Check it works

Ask your agent:

> Search the Analytics API for how to list workspaces, then run code to count how many I have.

A healthy run calls `search_analytics_api`, then `run_analytics_code`, and answers with a number. If nothing happens, go to [Troubleshooting](05-troubleshooting.md).

## 7. Choosing what to expose

Two independent switches decide which of the 203 operations the sandbox can reach.

**By API domain** — `ZA_DOMAINS` takes a comma-separated list. Unset means all ten:

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

**By read or write** — `ZA_ALLOW_WRITES` is `false` by default, leaving only the `GET` operations.

```bash
# An analyst's agent: read-only, and only the parts that answer questions.
ZA_DOMAINS=data-operations,views-management,reports-dashboards

# -> 18 operations instead of 203
```

:::good A smaller surface is a better surface
It is not only safer. Fewer operations means `search_analytics_api` has less to confuse itself with, so the model picks the right one more often. Expose what the users of that deployment actually need.
:::

The server prints the breakdown at startup:

```text
[za] ready — 18/203 operations (read-only), org 2375824000000000001, https://analyticsapi.zoho.com
[za] domains — data-operations:8 views-management:8 reports-dashboards:2
[za] knowledge — 17 guides, 385 error codes
```

## 8. Configuration reference

Every variable the server reads.

| ^Variable | Required | Default | Purpose |
|---|---|---|---|
| `ANALYTICS_CLIENT_ID` | yes¹ | — | OAuth client ID |
| `ANALYTICS_CLIENT_SECRET` | yes¹ | — | OAuth client secret |
| `ANALYTICS_REFRESH_TOKEN` | yes¹ | — | Used to mint access tokens automatically |
| `ANALYTICS_ORG_ID` | **yes** | — | Organization every call is scoped to |
| `ANALYTICS_SERVER_URL` | no | `https://analyticsapi.zoho.com` | Your data centre's API host |
| `ACCOUNTS_SERVER_URL` | no | `https://accounts.zoho.com` | Your data centre's accounts host |
| `ANALYTICS_ACCESS_TOKEN` | no | — | A static token, for a short test instead of OAuth¹ |
| `ZA_ALLOW_WRITES` | no | `false` | `true` exposes write operations as well as reads |
| `ZA_DOMAINS` | no | all ten | Comma-separated API domains to expose — see [above](#choosing-what-to-expose) |
| `ZA_MAX_TOOL_CALLS` | no | `200` | API calls allowed in one program |
| `ZA_MAX_CALLS_PER_MINUTE` | no | `55` | Sliding-window rate cap, so a loop cannot trip the API frequency limit |
| `ZA_MIN_CALL_INTERVAL_MS` | no | `50` | Minimum gap between calls, against microbursts |
| `ZA_THROTTLE_RETRIES` | no | `3` | Retries with backoff (6 s, 15 s, 30 s) when the API returns 6045 |
| `ZA_EXEC_TIMEOUT_MS` | no | `60000` | Wall-clock limit for one program |
| `ZA_EXEC_MEMORY_MB` | no | `256` | Memory limit for the sandbox |
| `ZA_MANUAL_PATH` | no | bundled | An alternative operation catalog |
| `ZA_KNOWLEDGE_PATH` | no | bundled | An alternative knowledge bundle |

¹ Supply either the three OAuth values (recommended — tokens refresh automatically) **or** `ANALYTICS_ACCESS_TOKEN`, which expires after an hour and will not be renewed.

:::warn Your credentials sit in a configuration file
`claude_desktop_config.json` is plain text on your machine. Treat it as a secret: do not commit it, and prefer a dedicated Self Client for this tool so you can revoke it independently.
:::
