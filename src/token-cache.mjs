/**
 * Access-token cache, so a token survives process restarts.
 *
 * Modelled on the za-cli TokenCache
 * (source/cli/source/com/zoho/analytics/cli/config/TokenCache.java), with the
 * same correctness rules — a version envelope, binding to the credential that
 * minted the token, an expiry skew, and "any problem is a cache miss, never an
 * error". The storage differs deliberately: the CLI encrypts a file under
 * `<config-dir>/cache/<profile>.token.enc` because it carries its own
 * passphrase machinery, whereas this server already keeps the profile in the
 * OS keychain, so the token goes in beside it. Same intent — encrypted at rest
 * — using the mechanism each tool already has rather than adding a new secret
 * in a file.
 *
 * Why a cache at all. An access token lasts an hour, and this server lives for
 * a whole agent session, so an in-memory cache covers most of it. It does not
 * cover a restart: quitting and reopening the agent, running `status`, or
 * having two agent hosts configured each mint their own token. Measured, those
 * mints are harmless — Zoho issues a distinct token each time and older ones
 * stay valid — so this buys one fewer round trip at startup, not correctness.
 */
import { KEYCHAIN_SERVICE } from './credentials.mjs';

const CACHE_VERSION = '1.0';
const SUFFIX = '.token';

/**
 * Treat a token as expired this many seconds early, so one handed out now is
 * still valid when the request it was fetched for actually goes out.
 */
const SKEW_SECONDS = 120;

/** Used when the accounts server omits a usable lifetime. */
const DEFAULT_LIFETIME_SECONDS = 3600;

/**
 * Nothing is cached for longer than this however large the reported lifetime.
 * Zoho's token response carries `expires_in` in MILLISECONDS alongside
 * `expires_in_sec` in seconds — taking the former at face value yields 3600000,
 * which would otherwise pin a dead token in the cache for six weeks.
 */
const MAX_LIFETIME_SECONDS = 86_400;

const nowSeconds = () => Math.floor(Date.now() / 1000);

/** Keyring is optional; without it the cache is simply inert. */
async function entryFor(profile) {
  try {
    const { Entry } = await import('@napi-rs/keyring');
    return new Entry(KEYCHAIN_SERVICE, `${profile}${SUFFIX}`);
  } catch {
    return null;
  }
}

/**
 * A still-valid cached token for this credential, or null.
 *
 * Returns null for every failure — missing entry, unreadable payload, unknown
 * version, different credential, too close to expiry. The caller mints a new
 * token, which is always correct, just slower.
 */
export async function loadCachedToken({ profile, clientId, analyticsUrl }) {
  if (!profile || !clientId || !analyticsUrl) return null;

  try {
    const entry = await entryFor(profile);
    if (!entry) return null;

    const raw = entry.getPassword();
    if (!raw) return null;

    const payload = JSON.parse(raw);
    if (payload.version !== CACHE_VERSION) return null;

    // A token minted for different credentials, or against a different data
    // centre, must never be reused: it would fail with 8535 and look like a
    // configuration problem rather than a stale cache.
    if (payload.clientId !== clientId || payload.analyticsUrl !== analyticsUrl) return null;

    const secondsLeft = (payload.expiresAt ?? 0) - nowSeconds();
    if (secondsLeft <= SKEW_SECONDS) return null;
    if (!payload.accessToken) return null;

    return { accessToken: payload.accessToken, secondsLeft };
  } catch {
    return null;
  }
}

/**
 * Store an access token for a profile, replacing whatever was there.
 *
 * Must not throw: a cache that cannot be written costs one extra token
 * exchange next time, which is strictly better than failing the call that just
 * succeeded in obtaining it.
 */
export async function saveCachedToken({
  profile, clientId, analyticsUrl, accessToken, expiresInSeconds,
}) {
  if (!profile || !clientId || !analyticsUrl || !accessToken) return false;

  const lifetime = Math.min(
    expiresInSeconds > 0 ? expiresInSeconds : DEFAULT_LIFETIME_SECONDS,
    MAX_LIFETIME_SECONDS,
  );

  try {
    const entry = await entryFor(profile);
    if (!entry) return false;
    entry.setPassword(JSON.stringify({
      version: CACHE_VERSION,
      clientId,
      analyticsUrl,
      accessToken,
      expiresAt: nowSeconds() + lifetime,
    }));
    return true;
  } catch {
    return false;
  }
}

/** Forget a profile's cached token. Called by `logout`. */
export async function clearCachedToken(profile) {
  try {
    const entry = await entryFor(profile);
    return entry ? entry.deletePassword() : false;
  } catch {
    return false;
  }
}
