/**
 * The OAuth authorization server the MCP client talks to.
 *
 * Implements the SDK's OAuthServerProvider by delegating the human part to
 * Zoho. The sequence, end to end:
 *
 *   1. MCP host hits /mcp with no token         -> 401 + WWW-Authenticate
 *   2. Host discovers this AS, registers itself -> /register
 *   3. Host opens a browser at /authorize       -> we redirect to Zoho
 *   4. User logs in and consents at Zoho
 *   5. Zoho redirects to /auth/callback         -> we exchange for Zoho tokens,
 *                                                  check the org allowlist,
 *                                                  mint OUR authorization code
 *   6. We redirect back to the host's redirect_uri with that code
 *   7. Host exchanges it at /token              -> our bearer token
 *   8. Host calls /mcp with that bearer token
 *
 * The user's Zoho tokens are stored server-side against our token. They are
 * never given to the MCP client and never enter the sandbox.
 */
import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { expiresInSeconds } from './zoho-oauth.mjs';
import { InvalidGrantError, InvalidTokenError, ServerError } from
  '@modelcontextprotocol/sdk/server/auth/errors.js';

const PENDING_TTL = 600;          // 10 min for a human to finish logging in
const CODE_TTL = 60;              // our authorization code, per OAuth 2.1 advice
const TOKEN_TTL = 3600;           // our bearer token
const REFRESH_TTL = 60 * 60 * 24 * 30;

const rand = (bytes = 32) => randomBytes(bytes).toString('base64url');

/** Signed so a stolen store value cannot be replayed as a token elsewhere. */
function sign(value, secret) {
  return createHmac('sha256', secret).update(value).digest('base64url');
}

function safeEqual(a, b) {
  const ba = Buffer.from(a ?? '');
  const bb = Buffer.from(b ?? '');
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** Dynamic client registration, backed by the shared store. */
class ClientsStore {
  #store;
  constructor(store) { this.#store = store; }

  async getClient(clientId) {
    return (await this.#store.get(`client:${clientId}`)) ?? undefined;
  }

  async registerClient(client) {
    await this.#store.set(`client:${client.client_id}`, client);
    return client;
  }
}

export class ZohoAnalyticsOAuthProvider {
  #store;
  #zoho;
  #config;
  #clients;

  constructor({ store, zoho, config }) {
    this.#store = store;
    this.#zoho = zoho;
    this.#config = config;
    this.#clients = new ClientsStore(store);
  }

  get clientsStore() { return this.#clients; }

  /** Step 3: park the MCP client's request and send the browser to Zoho. */
  async authorize(client, params, res) {
    const state = rand(24);
    await this.#store.set(`pending:${state}`, {
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      clientState: params.state ?? null,
      scopes: params.scopes ?? [],
      resource: params.resource?.toString() ?? null,
    }, PENDING_TTL);

    res.redirect(this.#zoho.authorizeUrl(state));
  }

  /**
   * Step 5: Zoho has sent the browser back. Exchange, authorise, and hand the
   * MCP client an authorization code of our own.
   *
   * Returns the URL to redirect the browser to, or throws with a message that
   * is safe to render to a human.
   */
  async handleZohoCallback({ code, state, error }) {
    const pending = state ? await this.#store.get(`pending:${state}`) : null;
    if (!pending) {
      throw new Error('This login link has expired or was already used. '
        + 'Start again from your MCP client.');
    }
    await this.#store.delete(`pending:${state}`);

    const back = (params) => {
      const url = new URL(pending.redirectUri);
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
      if (pending.clientState) url.searchParams.set('state', pending.clientState);
      return url.toString();
    };

    if (error) return back({ error, error_description: 'Authorization was denied at Zoho.' });

    const tokens = await this.#zoho.exchangeCode(code);

    // Access control: the user must belong to at least one permitted org.
    const orgs = await this.#zoho.permittedOrgs(tokens.access_token, this.#config.orgIds);
    if (orgs.length === 0) {
      throw new Error(
        'Your Zoho Analytics account does not have access to any organization '
        + 'permitted by this server. Ask the administrator to add your organization '
        + 'to MCP_SERVER_ORG_IDS.');
    }

    const ourCode = rand();
    await this.#store.set(`code:${ourCode}`, {
      clientId: pending.clientId,
      redirectUri: pending.redirectUri,
      codeChallenge: pending.codeChallenge,
      scopes: pending.scopes,
      resource: pending.resource,
      zoho: {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token ?? null,
        expiresAt: Date.now() + expiresInSeconds(tokens) * 1000,
      },
      orgs,
    }, CODE_TTL);

    return back({ code: ourCode });
  }

  async challengeForAuthorizationCode(client, authorizationCode) {
    const record = await this.#store.get(`code:${authorizationCode}`);
    if (!record || record.clientId !== client.client_id) {
      throw new InvalidGrantError('Authorization code is invalid or expired.');
    }
    return record.codeChallenge;
  }

  /** Step 7: our code becomes our bearer token. */
  async exchangeAuthorizationCode(client, authorizationCode, _verifier, redirectUri) {
    const record = await this.#store.get(`code:${authorizationCode}`);
    if (!record || record.clientId !== client.client_id) {
      throw new InvalidGrantError('Authorization code is invalid or expired.');
    }
    if (redirectUri && redirectUri !== record.redirectUri) {
      throw new InvalidGrantError('redirect_uri does not match the authorization request.');
    }
    await this.#store.delete(`code:${authorizationCode}`);   // single use
    return this.#issue(record);
  }

  async exchangeRefreshToken(client, refreshToken, scopes) {
    const record = await this.#store.get(`refresh:${refreshToken}`);
    if (!record || record.clientId !== client.client_id) {
      throw new InvalidGrantError('Refresh token is invalid or expired.');
    }
    await this.#store.delete(`refresh:${refreshToken}`);     // rotate
    return this.#issue({ ...record, scopes: scopes ?? record.scopes });
  }

  async #issue(record) {
    const accessToken = rand();
    const refreshToken = rand();
    const session = {
      clientId: record.clientId,
      scopes: record.scopes ?? [],
      resource: record.resource ?? null,
      zoho: record.zoho,
      orgs: record.orgs,
      sig: sign(accessToken, this.#config.sessionSecret),
    };

    session.expiresAt = Math.floor(Date.now() / 1000) + TOKEN_TTL;
    await this.#store.set(`token:${accessToken}`, session, TOKEN_TTL);
    await this.#store.set(`refresh:${refreshToken}`, {
      clientId: record.clientId,
      scopes: record.scopes ?? [],
      resource: record.resource ?? null,
      zoho: record.zoho,
      orgs: record.orgs,
    }, REFRESH_TTL);

    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: TOKEN_TTL,
      refresh_token: refreshToken,
      scope: (record.scopes ?? []).join(' '),
    };
  }

  /** Step 8: every /mcp request passes through here. */
  async verifyAccessToken(token) {
    const session = await this.#store.get(`token:${token}`);
    if (!session) throw new InvalidTokenError('Token is invalid or has expired.');
    if (!safeEqual(session.sig, sign(token, this.#config.sessionSecret))) {
      throw new InvalidTokenError('Token signature does not verify.');
    }

    return {
      token,
      clientId: session.clientId,
      scopes: session.scopes,
      // Required: requireBearerAuth refuses a token with no expiry.
      expiresAt: session.expiresAt,
      resource: session.resource ? new URL(session.resource) : undefined,
      extra: { orgs: session.orgs },
    };
  }

  async revokeToken(client, { token }) {
    for (const prefix of ['token', 'refresh']) {
      const record = await this.#store.get(`${prefix}:${token}`);
      if (record && record.clientId === client.client_id) {
        await this.#store.delete(`${prefix}:${token}`);
      }
    }
  }

  /**
   * The Zoho access token behind an MCP bearer token, refreshed if stale.
   * This is what the per-user catalog calls.
   */
  async zohoTokenFor(mcpToken) {
    const session = await this.#store.get(`token:${mcpToken}`);
    if (!session) throw new InvalidTokenError('Session has expired. Reconnect to sign in again.');

    const { zoho } = session;
    if (zoho.accessToken && Date.now() < zoho.expiresAt - 120_000) return zoho.accessToken;

    if (!zoho.refreshToken) {
      throw new ServerError('Zoho session expired and no refresh token is available. '
        + 'Reconnect to sign in again.');
    }

    const fresh = await this.#zoho.refresh(zoho.refreshToken);
    session.zoho = {
      accessToken: fresh.access_token,
      refreshToken: zoho.refreshToken,
      expiresAt: Date.now() + expiresInSeconds(fresh) * 1000,
    };
    await this.#store.set(`token:${mcpToken}`, session, TOKEN_TTL);
    return session.zoho.accessToken;
  }

  async orgsFor(mcpToken) {
    const session = await this.#store.get(`token:${mcpToken}`);
    return session?.orgs ?? [];
  }
}
