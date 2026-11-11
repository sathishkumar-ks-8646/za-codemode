/**
 * Session and OAuth state storage.
 *
 * `memory` is the default and is correct for a single instance. `redis` is
 * required as soon as you run more than one replica behind a load balancer:
 * an authorization code issued by one instance must be redeemable by another,
 * and a bearer token minted by one must be verifiable by all of them.
 */
const PREFIX = 'zacode:';
const MAX_TIMEOUT_MS = 2_147_483_647;   // setTimeout's 32-bit ceiling

class MemoryStore {
  #map = new Map();
  #timers = new Map();

  async get(key) {
    const entry = this.#map.get(key);
    if (!entry) return null;
    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      await this.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key, value, ttlSeconds) {
    this.#clearTimer(key);
    this.#map.set(key, {
      value,
      expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : 0,
    });
    // setTimeout's delay is a 32-bit signed int: anything over ~24.8 days
    // overflows and fires immediately, which would evict long-lived refresh
    // tokens the instant they were written. get() already enforces expiry
    // lazily, so the timer is only opportunistic cleanup — skip it when the
    // TTL is too long to represent.
    const delay = ttlSeconds * 1000;
    if (ttlSeconds && delay <= MAX_TIMEOUT_MS) {
      const t = setTimeout(() => this.#map.delete(key), delay);
      t.unref?.();                 // never keep the process alive
      this.#timers.set(key, t);
    }
  }

  async delete(key) {
    this.#clearTimer(key);
    this.#map.delete(key);
  }

  #clearTimer(key) {
    const t = this.#timers.get(key);
    if (t) { clearTimeout(t); this.#timers.delete(key); }
  }

  async close() {
    for (const key of [...this.#timers.keys()]) this.#clearTimer(key);
    this.#map.clear();
  }
}

class RedisStore {
  #client;

  constructor(client) { this.#client = client; }

  async get(key) {
    const raw = await this.#client.get(PREFIX + key);
    return raw ? JSON.parse(raw) : null;
  }

  async set(key, value, ttlSeconds) {
    const payload = JSON.stringify(value);
    if (ttlSeconds) await this.#client.set(PREFIX + key, payload, { EX: ttlSeconds });
    else await this.#client.set(PREFIX + key, payload);
  }

  async delete(key) { await this.#client.del(PREFIX + key); }

  async close() { await this.#client.quit(); }
}

export async function createStore(config) {
  if (config.storageBackend !== 'redis') return new MemoryStore();

  let createClient;
  try {
    ({ createClient } = await import('redis'));
  } catch {
    throw new Error(
      'STORAGE_BACKEND=redis but the `redis` package is not installed. '
      + 'Run `npm install redis`, or use the published Docker image which bundles it.');
  }

  const client = createClient({
    socket: { host: config.redisHost, port: config.redisPort },
    password: config.redisPassword || undefined,
  });
  client.on('error', (err) => console.error(`[redis] ${err.message}`));
  await client.connect();
  return new RedisStore(client);
}
