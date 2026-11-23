---
description: The security model of Zoho Analytics Code Mode — the sandbox boundary, read-only defaults, credential handling, execution budgets, and what to tell your security team.
---

# Security & governance

This tool executes code written by a language model against your data. That deserves a straight account of what is and is not contained.

## 1. The short version

| ^Question | Answer |
|---|---|
| Does model-written code run on my machine? | **Yes**, inside a V8 isolate |
| Can it reach the network directly? | **No** — only through the Analytics operations |
| Can it read my files? | **No** — no filesystem access of any kind |
| Can it see my OAuth credentials? | **No** — they stay in the host process |
| Can it change my data? | **Not by default** — writes are disabled |
| Can it exceed my API quota? | Bounded by a per-program call budget |
| Does my data reach my AI provider? | **Only what the program returns** |

## 2. What the sandbox cannot do

The isolate is a separate V8 heap with no host bindings except the operation bridge. These are absent, not merely discouraged:

```javascript
typeof require          // "undefined"
typeof import           // "undefined"
typeof fetch            // "undefined"
typeof process          // "undefined"
typeof Buffer           // "undefined"
typeof XMLHttpRequest   // "undefined"
```

There is no filesystem, no child process, no socket, and no environment. The only reachable capability is `za`, carrying exactly the operations the server chose to expose.

:::good This is enforcement, not instruction
The boundary is the isolate itself. It is not a system-prompt rule the model could be argued out of, and it does not weaken if the model is jailbroken — a jailbroken model simply has the same 76 read-only operations.
:::

## 3. Two ways to narrow the surface

Of 203 operations, **76 are exposed by default** — every `GET`. The other 127 create, update or delete, and they are not present in the sandbox at all. A program that tries one gets `not a function`.

`ZA_DOMAINS` narrows it further, to any subset of the ten API domains. A deployment for analysts need not expose user management at all:

```bash
ZA_DOMAINS=data-operations,views-management,reports-dashboards   # 18 operations
```

Both filters are applied when the catalog is built, so an excluded operation does not exist inside the sandbox — this is not a check the model could talk its way past.

| ^Mode | Operations | Can it modify data? |
|---|---|---|
| Default | 76 | no |
| `ZA_ALLOW_WRITES=true` | 203 | ++yes — including delete++ |

### Enabling write operations

:::danger Think before you enable writes
With `ZA_ALLOW_WRITES=true`, a program can create, update and **delete** workspaces, views, rows and users. The sandbox stops code from escaping; it does not stop the model from being wrong. A misread prompt plus a loop can destroy a lot of data quickly, and there is no undo.
:::

If you need writes, reduce the blast radius first:

1. **Use a dedicated Self Client** with only the scopes you actually need, so the OAuth grant — not the flag — is the real boundary. Avoid `ZohoAnalytics.fullaccess.all`; see [Which scopes](02-install.md#which-scopes).
2. **Point it at a non-production organization** while you learn what your agent does.
3. **Use an Analytics user with limited permissions.** The API can only do what that user can do.
4. **Keep the call budget low** (`ZA_MAX_TOOL_CALLS=25`) so a runaway loop stops early.

## 4. Where credentials live

Your client ID, secret and refresh token go into your operating system's keychain — macOS Keychain, Windows Credential Manager, Linux Secret Service — put there once by `za-codemode login`. Your agent's configuration holds no secret, only the command to run. The server reads the credential at startup, exchanges the refresh token for an access token, and keeps that token in memory. See [Credentials & profiles](09-credentials.md).

**The access token is never passed into the sandbox.** It is substituted into the request templates in the host process, after the sandbox has handed over the call. Code in the isolate cannot read it, log it, or return it.

:::warn If you set credentials by environment instead
`ANALYTICS_*` variables and `ZA_CREDENTIAL_COMMAND` are supported for containers and CI, and they take precedence over the keychain. A refresh token in a config file or a shell profile is plain text that does not expire: do not commit it, do not paste it into a chat, and use a Self Client created specifically for this tool so it can be revoked without affecting anything else.
:::

## 5. What reaches your AI provider

| ^Reaches the model | Stays local |
|---|---|
| Operation names and signatures it searched for | The full 203-operation catalog |
| The code it wrote | Your credentials |
| Whatever the program `return`s | Every row the program fetched but did not return |
| `console.log` output | — |

This is worth being deliberate about. A program that returns `{ total: 74100 }` discloses one number. A program that returns 10,000 rows discloses 10,000 rows. Prompting for summaries is a confidentiality control as well as a cost control — see [Using it](03-using-it.md#what-makes-a-good-request).

## 6. Execution limits

| ^Limit | Default | Why it exists |
|---|---|---|
| API calls per program | 200 | A loop over thousands of views would otherwise burn API units unchecked |
| Wall clock | 60 s | Stops a runaway program holding the agent open |
| Memory | 256 MB | Caps a program that accumulates rows without bound |

Each is a hard stop that ends the program with an explanatory error.

## 7. For your security review

Points a reviewer usually wants:

- **Execution is local.** The server runs on the user's machine under their account. No Zoho-hosted component is involved, and no data is routed through Zoho's agent infrastructure.
- **Network egress from the sandbox is zero.** The isolate has no networking primitives. All API traffic originates in the host process.
- **Authorisation is the user's own.** The tool can only reach what the configured OAuth grant and Analytics user permit. It adds no privilege.
- **The credential boundary holds under a compromised model.** The worst a malicious or manipulated program can do is call exposed operations — which is the same set the user could call themselves.
- **There is an audit log.** Outbound API calls are recorded by default; the detail stream, which includes the program that ran, is opt-in. Secrets are never written unless deliberately enabled. See [Audit logging](10-audit.md).
- **Revocation is the Self Client's.** There is no central console to disable: access ends when the Self Client's grant is revoked in the Zoho Developer Console, or when the Analytics user's permissions change. Issue one Self Client per installation so that stays a per-user decision.

## 8. What this does not protect against

Stated plainly:

- **A wrong answer.** The sandbox guarantees safety, not correctness. A model can still filter on the wrong column or misread a date range. The one case that *is* guarded is substitution: a named variable, view, column or folder that cannot be resolved halts the run rather than being swapped for something else, and that is enforced outside the sandbox.
- **Data disclosure through results.** Anything returned goes to your AI provider.
- **A compromised machine.** The keychain unlocks with your login session, so anything running as you can read the refresh token. An attacker who does has your API access until the Self Client is revoked.
- **Prompt injection via data.** If your data contains text crafted to influence a model, that text can reach the model through results. Returning aggregates rather than raw text columns reduces the exposure.
