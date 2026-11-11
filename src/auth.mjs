/**
 * Access-token lifecycle.
 *
 * This is the piece that makes UTCP viable here. UTCP has no token-refresh
 * hook, so a *published* manual is unusable - an end user would re-paste an
 * access token every hour. Our manual is internal: this module holds the
 * refresh token, mints access tokens, and the catalog re-registers whenever
 * one rotates. The user never handles a token and neither does the sandbox.
 */
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

export class TokenSource {
  #config;
  #token = null;
  #expiresAt = 0;
  #inflight = null;

  constructor(config) {
    this.#config = config;
  }

  /** Current access token, refreshing if it is missing or near expiry. */
  async get() {
    const { refreshToken, staticToken } = this.#config;

    if (!refreshToken) {
      if (!staticToken) throw new Error('no credentials configured');
      return staticToken;           // short-lived test mode
    }

    // 120s of headroom: a program that starts at T-30s must not expire mid-run.
    if (this.#token && Date.now() < this.#expiresAt - 120_000) return this.#token;

    // Collapse concurrent refreshes into one request.
    this.#inflight ??= this.#refresh().finally(() => { this.#inflight = null; });
    return this.#inflight;
  }

  async #refresh() {
    const { accountsUrl, clientId, clientSecret, refreshToken } = this.#config;

    const body = new URLSearchParams({
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
    });

    let res;
    try {
      res = await fetch(`${accountsUrl}/oauth/v2/token`, { method: 'POST', body });
    } catch (cause) {
      throw new Error(`cannot reach ${accountsUrl}: ${cause.message}`, { cause });
    }

    const json = await res.json().catch(() => ({}));

    if (!json.access_token) {
      // Zoho reports refresh failures as 200 + {"error": "..."}; surface the
      // two that actually happen, because the raw string is not self-evident.
      const hint = {
        invalid_client: 'ANALYTICS_CLIENT_ID or ANALYTICS_CLIENT_SECRET is wrong, '
          + 'or belongs to a different data centre than ACCOUNTS_SERVER_URL.',
        invalid_code: 'ANALYTICS_REFRESH_TOKEN is wrong, revoked, or was issued '
          + 'by a different OAuth client.',
      }[json.error];
      throw new Error(
        `token refresh failed: ${json.error ?? JSON.stringify(json)}`
        + (hint ? ` — ${hint}` : ''));
    }

    this.#token = json.access_token;
    this.#expiresAt = Date.now() + expiresInSeconds(json) * 1000;
    return this.#token;
  }
}
