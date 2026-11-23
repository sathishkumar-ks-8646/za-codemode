---
description: Zoho Analytics Code Mode is an MCP server that lets an AI agent write and run sandboxed code against the Analytics v2 API. Install it with one block in your agent's configuration.
---

# Start here

Your AI agent can already talk to Zoho Analytics one call at a time. This tool lets it write **one program instead** — with loops, filters and arithmetic — and run it in a sealed sandbox right next to the API.

It is built on the **UTCP code-mode engine**: the operation catalog is a UTCP manual generated from the published OpenAPI specifications, and the program runs in a V8 isolate with those operations bridged in. Your agent speaks MCP and never sees any of that — see [How the engine works](08-engine.md).

:::good Five minutes, nothing to host
Add one block to your agent's configuration file. There is no server to deploy, no port to open, and no AI model to supply — your agent brings its own. Jump to [Install & configure](02-install.md).
:::

## 1. Is this for you?

:::good Yes, if…
…you use an MCP-capable agent — Claude Desktop, Claude Code, Cursor, VS Code, Windsurf — and you want it to answer questions that span **more than one call**: totals across workspaces, exports that must be polled to completion, or anything needing a loop.
:::

:::info Probably not, if…
…you only need single lookups like "list my workspaces". The [Zoho Analytics MCP Server](https://www.zoho.com/analytics/api/v2/zoho-analytics-mcp-server.html) already does that with named tools, and a named tool is cheaper and clearer for one-shot work. The two are designed to sit side by side — see [How this relates to the MCP Server](01-what-it-is.md#how-this-relates-to-the-zoho-analytics-mcp-server).
:::

## 2. The idea in sixty seconds

Ask an agent *"what were East-region sales since July, across every workspace?"* and a conventional tool-calling setup has to make a round trip per step:

| ^Approach | What happens | Model turns |
|---|---|---|
| ~~One tool call per turn~~ | list workspaces → list views → start export → poll → poll → poll → download → repeat per view, then add the numbers up in the model's head | ~~19~~ |
| ++One program++ | the model writes a loop that does all of it in the sandbox and returns four numbers | ++1++ |

Both make the same API calls. The difference is that the intermediate data — every row, every `JOB IN PROGRESS` poll — never reaches the model.

## 3. What your agent sees

Four tools, no matter how large the API is:

| ^Tool | What it does |
|---|---|
| `find_analytics_objects` | Turn "my profit table" into a real workspace and view ID |
| `search_analytics_api` | Describe a task, get back the exact call signatures for the matching operations |
| `get_analytics_guide` | Read how something actually works — criteria grammar, job polling, what an error code means |
| `run_analytics_code` | Run TypeScript against those operations in a sandbox, get back the result |

Behind them sit **203 operations** across ten API domains, generated from the published OpenAPI specifications, plus the **OKF knowledge base**: 8 multi-step playbooks, 9 references and 385 documented error codes.

## 4. Install it

Two steps. First, in a terminal:

```bash
npx zoho-analytics-codemode login
```

It asks for your Zoho credentials, which groups of tools this profile may use, and whether writes are allowed — then stores the lot in your operating system's keychain.

Second, paste the block it prints into your agent's configuration. It holds no secrets:

```json
{
  "mcpServers": {
    "zoho-analytics-code-mode": {
      "command": "npx",
      "args": ["-y", "zoho-analytics-codemode"]
    }
  }
}
```

Restart your agent and ask it something. The full walkthrough is in [Install & configure](02-install.md); credentials in detail are in [Credentials & profiles](09-credentials.md).


:::info Rolling this out to a team?
Deploy it once and let everyone sign in through their browser — no per-user credentials and no installation. See [Remote deployment](07-remote-deployment.md).
:::

## 5. Read the guide in order

| ^Chapter | What it covers |
|---|---|
| [01 What it is](01-what-it-is.md) | How the sandbox works, where your code runs, and how this relates to the MCP Server |
| [02 Install & configure](02-install.md) | Credentials, every environment variable, and per-host setup |
| [03 Using it](03-using-it.md) | What good prompts look like, worked examples, and what to expect |
| [04 Security & governance](04-security.md) | The sandbox boundary, read-only mode, budgets, and what to tell your security team |
| [05 Troubleshooting & FAQ](05-troubleshooting.md) | Symptoms, error codes, and answers |
| [06 Operating & updating](06-operating.md) | Updates, API-unit cost, and running it from source |
| [07 Remote deployment](07-remote-deployment.md) | Running one shared instance for a team, with browser sign-in |
| [08 How the engine works](08-engine.md) | UTCP, code mode, the isolate and the knowledge base |
| [09 Credentials & profiles](09-credentials.md) | The login command, tool-group scoping, and where secrets are stored |
| [10 Audit logging](10-audit.md) | Two streams, how much history, and what is never written |

## 6. The three things to know before you start

1. **It does not reduce API units.** The same calls are made, so the same units are billed. What it saves is model turns and context.
2. **Write operations are off by default,** and you can narrow further. 76 read-only operations are exposed out of 203, and `ZA_DOMAINS` restricts that to the API domains you actually need. See [Choosing what to expose](02-install.md#choosing-what-to-expose).
3. **Your agent's model writes the code.** A more capable model writes better code. If results are poor, that is the first thing to check.
4. **It will not guess which table you meant.** When two views both match your words, it returns both and asks. See [Finding your data](03-using-it.md#finding-your-data).

## 7. Conventions used in this guide

| ^Convention | Meaning |
|---|---|
| `za.operationName()` | A call your agent's generated code makes inside the sandbox |
| `ANALYTICS_*` | An environment variable you set in your agent's configuration |
| ++green++ | The recommended choice |
| ~~red~~ | A thing to avoid |
