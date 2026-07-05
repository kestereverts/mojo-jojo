/**
 * A small TTL cache with insertion-order eviction once `maxEntries` is
 * reached. In-process only (no cross-restart persistence — that's an M8
 * concern, once a module-owned SQLite file exists).
 */
export class TtlCache<V> {
  readonly #store = new Map<string, { value: V; expiresAt: number }>();
  readonly #maxEntries: number;

  constructor(maxEntries = 200) {
    this.#maxEntries = maxEntries;
  }

  get(key: string, now = Date.now()): V | undefined {
    const entry = this.#store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= now) {
      this.#store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: V, ttlMs: number, now = Date.now()): void {
    if (this.#store.size >= this.#maxEntries && !this.#store.has(key)) {
      // Map preserves insertion order; the first key is the oldest.
      const oldest = this.#store.keys().next().value;
      if (oldest !== undefined) this.#store.delete(oldest);
    }
    this.#store.set(key, { value, expiresAt: now + ttlMs });
  }
}
