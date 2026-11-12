---
description: How to keep Zoho Analytics credentials out of your MCP client's configuration file — the OS keychain on macOS, Windows and Linux, credential helpers for 1Password and Vault, and environment variables for containers.
---

# Credentials

Your agent's configuration file is plain text. It gets pasted into chat threads, captured in screenshots, synced to cloud drives and occasionally committed. A Zoho refresh token does not expire — so one sitting in `claude_desktop_config.json` is a standing credential in a file nobody treats as a secret.

This chapter is about not doing that.

:::good The short version
```bash
npx zoho-analytics-code-mode-mcp login
```
Answer four questions in a terminal. Your credentials go into your operating system's keychain, and your agent's config ends up containing **no secrets at all**.
:::

## 1. What you end up with

```json
{
  "mcpServers": {
    "zoho-analytics-code-mode": {
      "command": "npx",
      "args": ["-y", "zoho-analytics-code-mode-mcp"]
    }
  }
}
```

That is the whole thing. No client ID, no secret, no refresh token. Compare it with what it replaces:

| ^ | Before | After |
|---|---|---|
| Secrets in the config file | ~~client ID, secret, refresh token~~ | ++none++ |
| Protected at rest | ~~no — plain text~~ | ++yes — OS keystore++ |
| Safe to paste in a chat | ~~no~~ | ++yes++ |
| Safe to commit | ~~no~~ | ++yes++ |

## 2. Where it is stored, per platform

Each operating system already has an encrypted store that unlocks with your login session. That is the one store a background process can read without prompting, which is exactly what a spawned MCP server needs.

| ^Platform | Store | Inspect it with |
|---|---|---|
| **macOS** | Keychain | Keychain Access → search `zoho-analytics-code-mode-mcp` |
| **Windows** | Credential Manager | `rundll32 keymgr.dll,KRShowKeyMgr`, or `cmdkey /list` |
| **Linux** | Secret Service (gnome-keyring / KWallet) | Seahorse ("Passwords and Keys"), or `secret-tool search service zoho-analytics-code-mode-mcp` |

The entry is stored under service `zoho-analytics-code-mode-mcp` and an account equal to the **profile name** — `default` unless you chose otherwise.

## 3. Logging in

```bash
npx zoho-analytics-code-mode-mcp login
```

It asks for your data centre, Client ID, Client Secret and Organization ID, with the secret fields not echoed. Then either paste a refresh token, or leave it blank and paste a **Generate Code** grant — it will do the token exchange for you, so there is no `curl` step.

Before storing anything it exchanges the credential once against Zoho to prove it works:

```text
Verifying... the credential works.

Stored under "zoho-analytics-code-mode-mcp" / "default" in the Keychain.
```

A typo therefore fails here, in a terminal, with Zoho's own error — rather than three days later as "server failed to start" inside your agent.

```bash
npx zoho-analytics-code-mode-mcp status    # which credential is in use
npx zoho-analytics-code-mode-mcp logout    # remove it
```

## 4. Several organizations

Profiles keep them apart:

```bash
npx zoho-analytics-code-mode-mcp login --profile eu-prod
npx zoho-analytics-code-mode-mcp login --profile sandbox
```

Then name the profile in each server entry — still the only thing in `env`:

```json
{
  "mcpServers": {
    "analytics-eu":      { "command": "npx", "args": ["-y", "zoho-analytics-code-mode-mcp"],
                           "env": { "ZA_PROFILE": "eu-prod" } },
    "analytics-sandbox": { "command": "npx", "args": ["-y", "zoho-analytics-code-mode-mcp"],
                           "env": { "ZA_PROFILE": "sandbox" } }
  }
}
```

## 5. Where credentials come from, in order

The first source that answers wins, and `status` always reports which one did.

| ^Order | Source | For |
|---|---|---|
| 1 | `ANALYTICS_*` environment variables | containers, CI, the Docker image |
| 2 | `ZA_CREDENTIAL_COMMAND` | 1Password, Vault, Zoho Vault, anything scriptable |
| 3 | OS keychain, by profile | normal desktop use |

Explicit environment beats everything deliberately: a container has no keychain, and an operator who sets a variable means it.

### Using a secret manager

Point `ZA_CREDENTIAL_COMMAND` at anything that prints a JSON object on stdout:

```json
"env": {
  "ZA_CREDENTIAL_COMMAND": "op read op://Engineering/zoho-analytics/credentials"
}
```

```bash
# vault
ZA_CREDENTIAL_COMMAND='vault kv get -format=json -field=data secret/zoho-analytics'

# any script
ZA_CREDENTIAL_COMMAND='/usr/local/bin/zoho-creds.sh'
```

Either spelling of the keys is accepted:

```json
{ "clientId": "...", "clientSecret": "...", "refreshToken": "...",
  "orgId": "...", "analyticsUrl": "...", "accountsUrl": "..." }
```

```json
{ "ANALYTICS_CLIENT_ID": "...", "ANALYTICS_CLIENT_SECRET": "...",
  "ANALYTICS_REFRESH_TOKEN": "...", "ANALYTICS_ORG_ID": "..." }
```

## 6. Linux: the one real caveat

:::warn The Secret Service lives on the session bus
On Linux the keychain is reachable only when `DBUS_SESSION_BUS_ADDRESS` is set. Without it, **a write appears to succeed and is then invisible** — measured, not theoretical. `login` therefore refuses to run rather than storing nothing:

```text
Cannot store credentials: no usable OS keychain.

  DBUS_SESSION_BUS_ADDRESS is not set. The Linux Secret Service lives on the
  session bus, and without it writes silently go nowhere.
```
:::

An agent launched from your desktop session inherits the variable and works normally. These do not:

| ^Situation | What to do |
|---|---|
| Over SSH, or a bare `systemd` unit | Use `ANALYTICS_*` environment variables, or `ZA_CREDENTIAL_COMMAND` |
| Docker, Kubernetes | Environment variables — see [Remote deployment](07-remote-deployment.md) |
| WSL without a keyring | `sudo apt install gnome-keyring`, or use environment variables |
| Headless server | `ZA_CREDENTIAL_COMMAND` pointing at your secret manager |

macOS and Windows have no equivalent dependency: both keystores are tied to the login session directly.

## 7. Why not an encrypted file

It is the obvious suggestion and it does not work here. The MCP server is **spawned by your agent with no terminal**, so it can never prompt for a passphrase. That leaves two options, and neither is better than the keychain:

- **Key stored next to the ciphertext** — anyone who can read one can read the other. Encryption in name only.
- **Key stored in the OS keychain** — then the keychain is already doing the work, and the encrypted file is an extra moving part protecting nothing further.

Which is why the keychain is the mechanism, not a file.

## 8. What this does and does not protect against

**Does:** a config file read by another process or person, a screenshot, an accidental commit, a synced backup, a stolen dotfiles archive.

**Does not:**

- **Malware running as you.** It can ask the keychain for the same entry your agent does. No user-session keystore defends against code already running as that user.
- **An agent that exfiltrates results.** Credentials stay out of the sandbox, but whatever a program returns reaches your AI provider. See [Security](04-security.md#what-reaches-your-ai-provider).
- **A leaked refresh token.** Zoho refresh tokens do not expire. If one escapes, revoke it in the [Developer Console](https://api-console.zoho.com) — `logout` only removes the local copy.

## 9. Troubleshooting

| ^Symptom | Cause | Fix |
|---|---|---|
| `No usable OS keychain` on Linux | No session bus | See [§6](#linux-the-one-real-caveat) |
| `login` stored it but `status` says `none` | Different profile | Pass the same `--profile` to both |
| `status` says `environment` when you expected the keychain | A stale `ANALYTICS_*` variable is shadowing it | `unset` it, or remove it from the agent config |
| Verification fails at login | Wrong data centre, or a reused grant code | Grant codes are single-use and expire in minutes |
| Works in a terminal, not in the agent | The agent's environment differs | `status` from the same context, and check `[za] credentials —` in the server log |

The server reports its credential source at startup, so there is never any doubt:

```text
[za] ready — 76/203 operations (read-only), org 55511666, https://analyticsapi.zoho.com
[za] credentials — keychain:default
```
