/** A source of the current time in milliseconds (injectable for deterministic tests). */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

const DEFAULT_MAX_ENTRIES = 4096;

/**
 * Per-key cooldown gate. {@link check} returns `true` if the key is allowed right
 * now (arming a fresh cooldown of `ms`), or `false` while it is still cooling.
 * Expired entries are pruned opportunistically so the table stays bounded.
 */
export class Cooldowns {
  readonly #until = new Map<string, number>();
  readonly #clock: Clock;
  readonly #maxEntries: number;

  constructor(clock: Clock = systemClock, maxEntries = DEFAULT_MAX_ENTRIES) {
    this.#clock = clock;
    this.#maxEntries = maxEntries;
  }

  /** `true` (and arm a new `ms` cooldown) if `key` is ready; `false` if still cooling. */
  check(key: string, ms: number): boolean {
    const now = this.#clock.now();
    const until = this.#until.get(key) ?? 0;
    if (now < until) return false;
    if (!this.#until.has(key) && this.#until.size >= this.#maxEntries) {
      this.#pruneExpired(now);
      // Hard bound: if every entry is still active, evict the oldest-inserted one.
      if (this.#until.size >= this.#maxEntries) {
        const oldest = this.#until.keys().next().value;
        if (oldest !== undefined) this.#until.delete(oldest);
      }
    }
    this.#until.set(key, now + ms);
    return true;
  }

  /** Drop a single key's cooldown, or all cooldowns when `key` is omitted. */
  clear(key?: string): void {
    if (key === undefined) this.#until.clear();
    else this.#until.delete(key);
  }

  #pruneExpired(now: number): void {
    for (const [key, until] of this.#until) {
      if (until <= now) this.#until.delete(key);
    }
  }
}
