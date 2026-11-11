/**
 * Delegation to Zoho Accounts.
 *
 * This server is an OAuth authorization server to the MCP client, and an
 * OAuth *client* to Zoho. The user's Zoho tokens never leave this process:
 * the MCP client receives a token we mint, which maps to a stored session
 * holding the Zoho credentials.
 */

/** The scopes the sandbox needs. Writes are requested only when enabled. */
/**
 * Seconds of validity from a Zoho token response.
 *
 * Found live: this deployment returns BOTH `expires_in_sec: 3600` and
 * `expires_in: 3600000` — the latter in milliseconds, not the seconds the
 * OAuth spec says. Taking `expires_in` at face value and multiplying by 1000
 * makes a one-hour token look valid for 41 days, so it is never refreshed and
 * every call starts failing with 8535 an hour in. Prefer the explicit
 * seconds field, and treat an implausibly large `expires_in` as milliseconds.
 */
function expiresInSeconds(json) {
  if (Number.isFinite(json.expires_in_sec)) return json.expires_in_sec;
  const raw = Number(json.expires_in);
  if (!Number.isFinite(raw)) return 3600;
  return raw > 86_400 ? Math.round(raw / 1000) : raw;
}

export function scopesFor({ allowWrites }) {
  const scopes = [
    'ZohoAnalytics.data.read',
    'ZohoAnalytics.metadata.read',
    'ZohoAnalytics.modeling.read',
    'ZohoAnalytics.usermanagement.read',
    'ZohoAnalytics.share.read',
  ];
  if (allowWrites) {
    scopes.push('ZohoAnalytics.data.all', 'ZohoAnalytics.modeling.all',
      'ZohoAnalytics.metadata.all');
  }
  return scopes;
}

export { expiresInSeconds };

export class ZohoOAuth {
  #config;

  constructor(config) { this.#config = config; }

  /** Where the browser is sent to log in and consent. */
  authorizeUrl(state) {
    const { accountsUrl, oidcClientId, publicUrl, allowWrites } = this.#config;
    const url = new URL(`${accountsUrl}/oauth/v2/auth`);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', oidcClientId);
    url.searchParams.set('redirect_uri', `${publicUrl}/auth/callback`);
    url.searchParams.set('scope', scopesFor({ allowWrites }).join(','));
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('prompt', 'consent');       // ensure a refresh_token
    url.searchParams.set('state', state);
    return url.toString();
  }

  /** Exchange Zoho's authorization code for tokens. */
  async exchangeCode(code) {
    const { accountsUrl, oidcClientId, oidcClientSecret, publicUrl } = this.#config;
    return this.#token({
      grant_type: 'authorization_code',
      client_id: oidcClientId,
      client_secret: oidcClientSecret,
      redirect_uri: `${publicUrl}/auth/callback`,
      code,
    });
  }

  /** Mint a fresh access token from a stored refresh token. */
  async refresh(refreshToken) {
    const { oidcClientId, oidcClientSecret } = this.#config;
    return this.#token({
      grant_type: 'refresh_token',
      client_id: oidcClientId,
      client_secret: oidcClientSecret,
      refresh_token: refreshToken,
    });
  }

  async #token(params) {
    const { accountsUrl } = this.#config;
    let res;
    try {
      res = await fetch(`${accountsUrl}/oauth/v2/token`, {
        method: 'POST',
        body: new URLSearchParams(params),
      });
    } catch (cause) {
      throw new Error(`cannot reach ${accountsUrl}: ${cause.message}`, { cause });
    }

    const json = await res.json().catch(() => ({}));
    if (!json.access_token) {
      const hint = {
        invalid_client: 'OIDC_PROVIDER_CLIENT_ID/SECRET is wrong, or belongs to a '
          + 'different data centre than ANALYTICS_SERVER_URL.',
        invalid_code: 'The authorization code was already used or has expired.',
        redirect_uri_mismatch: 'The redirect URI registered in the Zoho Developer '
          + 'Console must be exactly <MCP_SERVER_PUBLIC_URL>/auth/callback.',
      }[json.error];
      throw new Error(`Zoho token exchange failed: ${json.error ?? JSON.stringify(json)}`
        + (hint ? ` — ${hint}` : ''));
    }
    return json;
  }

  /**
   * Which of the permitted organizations this user can actually see.
   *
   * There is no "list my organizations" endpoint any more — it was removed by
   * the mandatory-organization-context change — so membership is established
   * by probing each allowlisted org with the user's own token. An org that
   * answers is one they belong to. This is also exactly the check we want:
   * it tests real access, not a claim in a token.
   */
  async permittedOrgs(accessToken, allowedOrgIds) {
    const { analyticsUrl } = this.#config;

    const checks = allowedOrgIds.map(async (orgId) => {
      try {
        const res = await fetch(`${analyticsUrl}/restapi/v2/orgs/workspaces`, {
          headers: {
            Authorization: `Zoho-oauthtoken ${accessToken}`,
            'ZANALYTICS-ORGID': orgId,
          },
        });
        return res.ok ? orgId : null;
      } catch {
        return null;
      }
    });

    return (await Promise.all(checks)).filter(Boolean);
  }
}
