---
description: Setting up credentials for Zoho Analytics Code Mode — the login command, where to run it, what it asks, choosing which tool groups a profile may use, and how credentials are stored on macOS, Windows and Linux.
---

# Credentials & profiles

Credentials live in your operating system's keychain, not in a file. You put them there once with `login`, and your agent's configuration refers to them by profile name.

## 1. Run this, in a terminal

```bash
za-codemode login
```

**In a terminal** matters. This is an interactive command — it asks you questions and you type the answers. Your AI agent cannot run it for you, because the server your agent spawns has no terminal attached and so can never prompt for anything. That is the whole reason credentials are set up separately, once, by hand.

| ^Where | What |
|---|---|
| **macOS** | Terminal, iTerm |
| **Windows** | PowerShell, Windows Terminal, Command Prompt |
| **Linux** | Any terminal emulator in your desktop session — see [§6](#linux-the-session-bus) |

## 2. What it asks

Six things. Secret answers are not echoed as you type.

```text
$ za-codemode login

Zoho Analytics Code Mode — store credentials

Profile: default
Stored in this machine's Keychain, never in a file.

Data centre:
  1. United States
  2. Europe
  3. India
  4. Australia
  5. Japan
  6. Canada
  7. Saudi Arabia
  8. Other — enter the URLs yourself
Choose [1]: 2
  -> https://analyticsapi.zoho.eu

From a Self Client at https://api-console.zoho.com :
  Client ID: 1000.ABCDEFGHIJKLMNOP
  Client Secret:
  Organization ID: 2375824000000000001

  Paste a refresh token if you have one, or leave blank to
  exchange a Generate Code grant for one.
  Refresh Token (blank to exchange):
```

Then the part that is specific to this tool:

```text
Which groups of tools may this profile use?

   1. data-modeling-schema   Tables, columns, formulas, query tables, lookups
   2. data-operations        Rows, imports, exports, bulk jobs, data sync
   3. dsml                   AutoML analyses, training and predictions
   4. org-management         Organizations, subscriptions, security controls
   5. reports-dashboards     Charts, pivots, summaries, dashboards
   6. schedules-alerts       Email schedules and data alerts
   7. share-publish          Sharing, permissions, embed URLs, public links, slideshows
   8. user-groups            Users, groups, roles and portals
   9. views-management       Views, folders, tags, trash, copy and move
  10. workspace-management   Workspaces, backups, linking, templates, variables

  Enter numbers separated by commas (for example 2,9,5),
  or press Enter for all of them.

  Groups [all]: 2,9,5
  -> data-operations, views-management, reports-dashboards

May this profile CHANGE data — create, update and delete?
  Read-only is strongly recommended. A sandbox executes code written
  by a language model; read-only means a misread prompt cannot destroy
  a workspace.

  Allow writes? [y/N]: n
  -> read-only

Verifying... the credential works.

Stored under "zoho-analytics-codemode" / "default" in the Keychain.
  tool groups   data-operations, views-management, reports-dashboards
  data access   read-only
```

:::good It checks before it stores
The credential is exchanged against Zoho once, for real, before anything is written. A wrong secret or the wrong data centre fails here — in a terminal, with Zoho's own error message — instead of three days later as "server failed to start" inside your agent.
:::

## 3. Choosing tool groups

A profile is a **scope**, not just a credential. The 203 operations are grouped into ten domains, and a profile reaches only the groups you pick.

Pick the smallest set that answers your questions. An agent for reading reports has no business being able to administer users, and there is a practical benefit too: a smaller surface means `search_analytics_api` has less to confuse itself with, so the model picks the right operation more often.

| ^If you want to… | Choose |
|---|---|
| Read and analyse data | `data-operations`, `views-management`, `reports-dashboards` |
| Build tables and formulas | add `data-modeling-schema` |
| Manage sharing and embeds | add `share-publish` |
| Administer users | add `user-groups` |
| Everything | press Enter |

The server reports the result at startup, so you can always see what a profile can reach:

```text
[za] ready — 18/203 operations (read-only), org 2375824000000000001
[za] credentials — keychain:default
[za] domains — data-operations:8 reports-dashboards:2 views-management:8
```

:::danger Writes are a separate decision
Answering yes to writes exposes create, update and **delete** across every group you picked. The sandbox stops code escaping; it does not stop the model being wrong. Keep read-only unless you specifically need otherwise, and prefer a non-production organization while you learn what your agent does. See [Security](04-security.md#two-ways-to-narrow-the-surface).
:::

## 4. Then tell your agent

`login` prints the exact block to paste. It contains no secrets:

```json
{
  "mcpServers": {
    "zoho-analytics-code-mode": {
      "command": "za-codemode"
    }
  }
}
```

Config file locations, and the form to use if you skipped `npm link`, are in [Install & configure](02-install.md#step-4-connect-your-agent).

## 5. Several profiles

One organization read-only, another sandbox read-write, a third for schema work:

```bash
za-codemode login --profile eu-reporting
za-codemode login --profile sandbox
```

Name the profile in each server entry — still the only thing in `env`:

```json
{
  "mcpServers": {
    "analytics-reporting": {
      "command": "za-codemode",
      "env": { "ZA_PROFILE": "eu-reporting" }
    },
    "analytics-sandbox": {
      "command": "za-codemode",
      "env": { "ZA_PROFILE": "sandbox" }
    }
  }
}
```

```bash
za-codemode status --profile sandbox   # what is stored
za-codemode logout --profile sandbox   # remove it
```

## 6. Scripting it

Every answer has a flag, so a setup script need not be interactive. Anything you do not supply is still asked for, and secrets can be piped on stdin.

```bash
za-codemode login \
  --profile ci \
  --analytics-url https://analyticsapi.zoho.eu \
  --accounts-url  https://accounts.zoho.eu \
  --domains data-operations,views-management \
  --read-only \
  --refresh-token "$ZOHO_REFRESH_TOKEN"
```

| ^Flag | Replaces |
|---|---|
| `--profile <name>` | the profile, default `default` |
| `--analytics-url <u>` / `--accounts-url <u>` | the data centre question |
| `--refresh-token <t>` | the refresh token prompt |
| `--domains <a,b,c>` | the tool group question |
| `--read-only` / `--allow-writes` | the writes question |

## 7. Where it is stored, per platform

Each operating system has an encrypted store that unlocks with your login session. That is the one store a background process can read without prompting — which is exactly what a spawned MCP server needs.

| ^Platform | Store | Inspect it with |
|---|---|---|
| **macOS** | Keychain | Keychain Access → search `zoho-analytics-codemode` |
| **Windows** | Credential Manager | `rundll32 keymgr.dll,KRShowKeyMgr`, or `cmdkey /list` |
| **Linux** | Secret Service (gnome-keyring / KWallet) | Seahorse ("Passwords and Keys"), or `secret-tool search service zoho-analytics-codemode` |

The entry's service is `zoho-analytics-codemode` — matching `KEYCHAIN_SERVICE` in `src/credentials.mjs`, not the shorter command name — and its account is the profile name.

## 8. Linux: the session bus

:::warn On Linux the keychain needs `DBUS_SESSION_BUS_ADDRESS`
The Secret Service lives on the session bus. Without that variable, a write **appears to succeed and is then invisible** — measured, not theoretical. `login` therefore refuses to run rather than storing nothing:

```text
Cannot store credentials: no usable OS keychain.

  DBUS_SESSION_BUS_ADDRESS is not set. The Linux Secret Service lives on the
  session bus, and without it writes silently go nowhere.
```
:::

A terminal inside your desktop session has the variable and works normally. These do not:

| ^Situation | What to do instead |
|---|---|
| Over SSH, or a bare `systemd` unit | `ANALYTICS_*` environment variables, or `ZA_CREDENTIAL_COMMAND` |
| Docker, Kubernetes | `ANALYTICS_*` environment variables, from your orchestrator's secret store |
| WSL with no keyring | `sudo apt install gnome-keyring`, or environment variables |
| Headless server | `ZA_CREDENTIAL_COMMAND` pointing at your secret manager |

macOS and Windows have no equivalent dependency.

## 9. Other sources

The server takes the first source that answers, and reports which one did.

| ^Order | Source | For |
|---|---|---|
| 1 | `ANALYTICS_*` environment variables | containers, CI, the Docker image |
| 2 | `ZA_CREDENTIAL_COMMAND` | 1Password, Vault, Zoho Vault, any script |
| 3 | OS keychain, by profile | normal desktop use |

Environment beats the keychain deliberately: a container has no keychain, and an operator who sets a variable means it. `ZA_DOMAINS` and `ZA_ALLOW_WRITES` likewise override a profile's stored scope, so a profile can be narrowed for one session without being rewritten.

### A secret manager

`ZA_CREDENTIAL_COMMAND` is any command that prints a JSON object on stdout:

```json
"env": {
  "ZA_CREDENTIAL_COMMAND": "op read op://Engineering/zoho-analytics/credentials"
}
```

```bash
ZA_CREDENTIAL_COMMAND='vault kv get -format=json -field=data secret/zoho-analytics'
ZA_CREDENTIAL_COMMAND='/usr/local/bin/zoho-creds.sh'
```

Either spelling of the keys works:

```json
{ "clientId": "...", "clientSecret": "...", "refreshToken": "...",
  "orgId": "...", "analyticsUrl": "...", "accountsUrl": "...",
  "domains": ["data-operations"], "allowWrites": false }
```

```json
{ "ANALYTICS_CLIENT_ID": "...", "ANALYTICS_CLIENT_SECRET": "...",
  "ANALYTICS_REFRESH_TOKEN": "...", "ANALYTICS_ORG_ID": "..." }
```

## 10. Access tokens

You never handle these. The refresh token you stored is long-lived; the access
token actually used on each call lasts **one hour** and the server manages it.

| ^ | |
|---|---|
| Minted from | your stored refresh token |
| Lifetime | one hour, read from the response rather than assumed |
| Cached in | the OS keychain, beside the profile, as `<profile>.token` |
| Reused by | later runs of the same profile, until it nears expiry |
| Refreshed | automatically, two minutes before it expires |

Caching matters because a token would otherwise be minted afresh every time the
process starts — and that happens more than you might think: restarting your
agent, running `status`, or having two agent hosts configured. Measured on a
real organization, a warm start reuses the cached token and skips the exchange
entirely.

A cached token is only reused when it was minted by the **same client ID**
against the **same data centre**, and has more than two minutes left. Change
either and the cache is simply ignored rather than producing a confusing 8535.
`logout` removes it along with the credential.

This mirrors what the Zoho Analytics CLI does — the same version envelope,
credential binding, expiry skew and lifetime clamp — storing it in the keychain
rather than an encrypted file, because the keychain is already there.

## 11. Why not an encrypted file

It is the obvious suggestion, and it cannot work here. The MCP server is **spawned by your agent with no terminal**, so it can never prompt for a passphrase. That leaves two possibilities, and neither improves on the keychain:

- **The key sits next to the ciphertext.** Anyone who can read one can read the other — encryption in name only.
- **The key sits in the OS keychain.** Then the keychain is already doing the work and the file is an extra moving part protecting nothing further.

Hence the keychain itself.

## 12. What this protects, and what it does not

**Protects against:** a config file read by another process or person, a screenshot, an accidental commit, a synced backup, a copied dotfiles archive.

**Does not protect against:**

- **Malware running as you.** It can ask the keychain for the same entry your agent does. No user-session keystore defends against code already running as that user.
- **Results leaving the sandbox.** Credentials never enter it, but whatever a program returns reaches your AI provider. See [Security](04-security.md#what-reaches-your-ai-provider).
- **A leaked access token.** It is a bearer credential for up to an hour. It is kept in the keychain, not a file, but anything that can read the keychain can read it.
- **A leaked refresh token.** Zoho refresh tokens do not expire. If one escapes, revoke it in the [Developer Console](https://api-console.zoho.com) — `logout` removes only the local copy.

## 13. Troubleshooting

| ^Symptom | Cause | Fix |
|---|---|---|
| `No usable OS keychain` on Linux | No session bus | [§8](#linux-the-session-bus) |
| `login` stored it but `status` says `none` | Different profile | Pass the same `--profile` to both |
| `status` says `environment` when you expected the keychain | A stale `ANALYTICS_*` variable is shadowing it | `unset` it, or remove it from the agent config |
| Verification fails at login | Wrong data centre, or a reused grant code | Grant codes are single-use and expire in minutes |
| Fewer tools than expected | The profile's groups | `status` shows them; `login` again to change them |
| Works in a terminal, not in the agent | The agent's environment differs | Check the `[za] credentials —` line in the server log |
