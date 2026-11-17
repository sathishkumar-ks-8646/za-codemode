/**
 * One operation catalog per signed-in user.
 *
 * Each user has their own Zoho access token, and UTCP bakes the token into
 * the call templates when a manual is registered — so a shared catalog cannot
 * serve several users. Measured cost of a private one: ~21 ms and ~2.6 MB, so
 * a bounded pool is affordable. Idle sessions are evicted; the pool is capped
 * so a burst of logins cannot exhaust memory.
 */
import { Catalog } from '../catalog.mjs';
import { OperationSearch } from '../search.mjs';

export class SessionPool {
  #config;
  #provider;
  #manualPath;
  #sessions = new Map();          // mcpToken -> { catalog, search, lastUsed, orgId }
  #audit;
  #sweeper;

  constructor({ config, provider, manualPath, audit }) {
    this.#config = config;
    this.#provider = provider;
    this.#manualPath = manualPath;
    this.#audit = audit ?? null;

    this.#sweeper = setInterval(() => this.#sweep(), 60_000);
    this.#sweeper.unref?.();
  }

  get size() { return this.#sessions.size; }

  /** The catalog and search for this bearer token, creating them on demand. */
  async for(mcpToken) {
    const existing = this.#sessions.get(mcpToken);
    if (existing) {
      existing.lastUsed = Date.now();
      return existing;
    }

    if (this.#sessions.size >= this.#config.maxSessions) {
      this.#evictOldest();
    }

    const orgs = await this.#provider.orgsFor(mcpToken);
    if (!orgs.length) {
      throw new Error('No permitted organization for this session. Reconnect to sign in again.');
    }

    // Per-user config: the organization this user is scoped to.
    const config = { ...this.#config, orgId: orgs[0] };

    const catalog = new Catalog({
      config,
      // The catalog asks for a token on every execution; we answer with this
      // user's Zoho token, refreshing it behind the scenes.
      tokens: { get: () => this.#provider.zohoTokenFor(mcpToken) },
      manualPath: this.#manualPath,
      audit: this.#audit,
    });
    await catalog.init();

    const session = {
      catalog,
      search: new OperationSearch(catalog),
      orgs,
      orgId: orgs[0],
      lastUsed: Date.now(),
    };
    this.#sessions.set(mcpToken, session);
    return session;
  }

  drop(mcpToken) { this.#sessions.delete(mcpToken); }

  #evictOldest() {
    let oldestKey = null;
    let oldest = Infinity;
    for (const [key, s] of this.#sessions) {
      if (s.lastUsed < oldest) { oldest = s.lastUsed; oldestKey = key; }
    }
    if (oldestKey) this.#sessions.delete(oldestKey);
  }

  #sweep() {
    const cutoff = Date.now() - this.#config.sessionIdleMs;
    for (const [key, s] of this.#sessions) {
      if (s.lastUsed < cutoff) this.#sessions.delete(key);
    }
  }

  close() { clearInterval(this.#sweeper); this.#sessions.clear(); }
}
