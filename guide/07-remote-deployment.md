---
description: Deploying Zoho Analytics Code Mode as a shared, multi-user remote MCP server — Docker, browser sign-in through Zoho, organization access control and Redis-backed sessions.
---

# Remote deployment

Everything so far describes the **local** server: one person, one machine, credentials in their agent's configuration file. This chapter is the other way to run it — **one instance, many users, browser sign-in, no per-user installation.**

:::info Which one do you want?
If you are an individual trying this out, stay with [the local setup](02-install.md). This chapter is for an administrator rolling the tool out to a team.
:::

## 1. What changes

| ^ | Local (stdio) | Remote (HTTP) |
|---|---|---|
| Users per instance | 1 | many |
| Who installs anything | each user | ++nobody++ |
| Credentials | each user's config file | ++held by the server++ |
| Sign-in | paste a refresh token | ++browser, through Zoho++ |
| Access control | none | ++organization allowlist++ |
| Infrastructure | none | a container and a public HTTPS URL |
| OAuth app type | Self Client | ++Server-based Application++ |

The variable names deliberately mirror the [self-hosted Zoho Analytics Remote MCP Server](https://www.zoho.com/analytics/api/v2/zoho-analytics-mcp-server/remote-mcp/self-hosted.html), so if you already run that one, most of your `.env` carries over.

## 2. What the user does

Nothing but paste four lines. No credentials, no install:

```json
{
  "mcpServers": {
    "zoho-analytics-code-mode": {
      "url": "https://analytics-code.example.com/mcp",
      "type": "http"
    }
  }
}
```

On first use their MCP client opens a browser, they sign in to Zoho and consent, and the client is connected. Tokens are held by the server; the user never sees one.

## 3. Step 1 — Register a server-based OAuth application

:::danger Not a Self Client
A Self Client issues single-user personal tokens and cannot perform the redirect-based flow a shared server needs. Choose **Server-based Application**.
:::

1. Go to [api-console.zoho.com](https://api-console.zoho.com) → **Add Client** → **Server-based Applications**.
2. Give it a name and your homepage URL.
3. Set the **Authorized Redirect URI** to exactly:
   ```text
   https://analytics-code.example.com/auth/callback
   ```
   It must match `MCP_SERVER_PUBLIC_URL` + `/auth/callback` character for character, including the scheme and any trailing path.
4. Copy the **Client ID** and **Client Secret**.

## 4. Step 2 — Write the `.env`

```bash
cp .env.example .env
```

| ^Variable | Required | Default | Purpose |
|---|---|---|---|
| `ANALYTICS_SERVER_URL` | **yes** | — | Your data centre's Analytics API host |
| `OIDC_PROVIDER_CLIENT_ID` | **yes** | — | From the server-based OAuth app |
| `OIDC_PROVIDER_CLIENT_SECRET` | **yes** | — | From the same app. Keep it secret |
| `MCP_SERVER_PUBLIC_URL` | **yes** | — | The public HTTPS URL users reach |
| `SESSION_SECRET_KEY` | **yes** | — | Signs sessions. `openssl rand -base64 48` |
| `MCP_SERVER_ORG_IDS` | **yes** | — | Comma-separated Organization IDs allowed to use this server |
| `ACCOUNTS_SERVER_URL` | no | derived | Only if the data centre guess is wrong |
| `PORT` | no | `4000` | Listening port |
| `TRUST_PROXY_HOPS` | no | `1` | Number of reverse proxies in front |
| `STORAGE_BACKEND` | no | `memory` | `memory` or `redis` |
| `REDIS_HOST` / `REDIS_PORT` / `REDIS_PASSWORD` | conditional | — | Required when `STORAGE_BACKEND=redis` |
| `ZA_ALLOW_WRITES` | no | `false` | Exposes write operations **for every user** |
| `ZA_DOMAINS` | no | all ten | API domains this deployment serves |
| `ZA_MAX_SESSIONS` | no | `100` | Cached per-user catalogs (~2.6 MB each) |
| `ZA_SESSION_IDLE_MS` | no | `1800000` | Idle time before a cached catalog is dropped |

The sandbox limits from [Using it](03-using-it.md#limits-you-will-meet) apply here too.

:::warn Get `TRUST_PROXY_HOPS` right
It must equal the number of proxies actually in front of this server. Setting it too high lets a client spoof `X-Forwarded-For` and slip past the rate limiting on the OAuth endpoints.
:::

## 5. Step 3 — Run it

```bash
docker build -t zoho-analytics-code-mode-mcp:remote .

docker run --name zoho-analytics-code-mode \
  --env-file .env \
  -p 4000:4000 \
  zoho-analytics-code-mode-mcp:remote
```

Or with Redis, which you need for more than one replica:

```bash
docker compose up -d
```

Put TLS in front of it. `MCP_SERVER_PUBLIC_URL` must be `https` outside localhost — the server refuses to start otherwise, because OAuth redirects and bearer tokens must not travel in clear text.

Check it:

```bash
curl https://analytics-code.example.com/healthz
# {"status":"ok","operations":76,"writes":false,"sessions":0,"storage":"redis"}
```

## 6. How sign-in works

```text
 1. MCP client POSTs /mcp with no token      -> 401 + WWW-Authenticate
 2. Client reads /.well-known/oauth-protected-resource
 3. Client registers itself                  -> POST /register
 4. Client opens a browser at /authorize     -> we redirect to Zoho
 5. User signs in and consents at Zoho
 6. Zoho redirects to /auth/callback         -> we exchange the code for Zoho
                                                tokens, check the org allowlist,
                                                and mint our own code
 7. We redirect back to the client           -> client exchanges it at /token
 8. Client calls /mcp with its bearer token
```

Standard OAuth 2.1 with PKCE throughout, implemented by the MCP SDK. Two things worth knowing:

- **The user's Zoho tokens never leave the server.** The MCP client receives a token we mint, which maps to a server-side session holding the Zoho credentials. The sandbox never sees either.
- **Access tokens live one hour and refresh silently.** The Zoho token behind a session is renewed in the background, so a long session does not interrupt the user.

## 7. Organization access control

`MCP_SERVER_ORG_IDS` is an allowlist. At sign-in, the server checks the user's own token against each listed organization and keeps the ones that answer. A user who can reach **none** of them is refused before any token is minted, and sees:

> Your Zoho Analytics account does not have access to any organization permitted by this server. Ask the administrator to add your organization to `MCP_SERVER_ORG_IDS`.

:::good Membership is tested, not asserted
There is no "list my organizations" endpoint any more, so the server probes each permitted organization with the user's own credentials. That tests real access rather than trusting a claim — a user cannot reach an organization merely because it appears in the allowlist.
:::

Each signed-in user gets a private operation catalog scoped to their own organization, so `ORG_ID` inside the sandbox is *their* organization, and one user's token can never be used for another's calls.

## 8. Storage backend

| ^ | `memory` (default) | `redis` |
|---|---|---|
| Replicas supported | **one** | many |
| Survives a restart | no — everyone signs in again | yes |
| Extra infrastructure | none | a Redis instance |

Use Redis as soon as you run more than one instance behind a load balancer: an authorization code issued by one replica must be redeemable by another, and a bearer token minted by one must be verifiable by all of them. With `memory`, a user whose request lands on a different replica is silently signed out.

## 9. Capacity

Each signed-in user holds a private catalog of roughly **2.6 MB**, built in about **21 ms**. `ZA_MAX_SESSIONS` caps how many are kept (default 100, so around 260 MB), and idle ones are evicted after `ZA_SESSION_IDLE_MS`. Evicting a catalog does not sign the user out; the next request rebuilds it.

## 10. Operational notes

- `GET /healthz` reports operation count, write mode, live sessions and storage backend. It needs no authentication — put it behind your load balancer, not the public internet, if that bothers you.
- `GET /` serves a short landing page with the client configuration snippet, so you can send users a single URL.
- Logs go to **stderr**, one line per event, prefixed `[za]`.
- `SIGTERM` and `SIGINT` drain cleanly: sessions are dropped, the listener closes, the store disconnects.

:::danger Writes are a server-wide decision
`ZA_ALLOW_WRITES=true` enables create, update and **delete** for every user of the instance, not per user. On a shared server that is a much larger decision than on a laptop. Read [Security](04-security.md#enabling-write-operations) first, and prefer a separate instance pointed at a non-production organization.
:::

## 11. What this does not give you

Stated plainly, because a security review will ask:

- **No audit log.** Programs are not persisted. Each response reports its API call count, and that is all. If you need to know who ran what, you need to add it.
- **No per-user rate limiting of Analytics calls.** `ZA_MAX_TOOL_CALLS` is per program, not per user per hour.
- **No scope reduction per user.** Every user gets the same operation set; what they can actually touch is governed by their own Zoho permissions.
