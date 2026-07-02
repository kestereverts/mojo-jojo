import { systemClock, type Clock } from "./cooldown.ts";

const DEFAULT_MAX_KEYS = 4096;

export interface RateLimiterOptions {
  /** Bucket size — the most requests allowed in an instantaneous burst. */
  readonly capacity: number;
  /** Milliseconds to regain one token. */
  readonly refillMs: number;
  readonly clock?: Clock;
  /** Bound on tracked keys (oldest idle bucket evicted past this). */
  readonly maxKeys?: number;
}

interface Bucket {
  tokens: number;
  updated: number;
}

/**
 * Per-key token bucket: a burst of up to `capacity`, refilling one token every
 * `refillMs`. Bounds sustained per-key request rate to `1/refillMs` while still
 * allowing short legitimate bursts. The key table is hard-bounded (idle buckets
 * pruned, then oldest evicted), so distinct attacker keys can't grow it.
 */
export class RateLimiter {
  readonly #buckets = new Map<string, Bucket>();
  readonly #capacity: number;
  readonly #refillMs: number;
  readonly #clock: Clock;
  readonly #maxKeys: number;

  constructor(options: RateLimiterOptions) {
    this.#capacity = Math.max(1, options.capacity);
    // Guard against a zero/negative period (division by zero → NaN refill).
    this.#refillMs = Math.max(1, options.refillMs);
    this.#clock = options.clock ?? systemClock;
    this.#maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS;
  }

  /** Consume one token for `key`. Returns `true` if allowed, `false` if rate-limited. */
  tryConsume(key: string): boolean {
    const now = this.#clock.now();
    let bucket = this.#buckets.get(key);
    if (!bucket) {
      if (this.#buckets.size >= this.#maxKeys) this.#prune(now);
      bucket = { tokens: this.#capacity, updated: now };
      this.#buckets.set(key, bucket);
    } else {
      const refill = Math.floor((now - bucket.updated) / this.#refillMs);
      if (refill > 0) {
        bucket.tokens = Math.min(this.#capacity, bucket.tokens + refill);
        // Advance by the whole periods actually credited, NOT to `now` — dropping
        // the sub-period remainder would slow the sustained rate below 1/refillMs
        // and wrongly limit evenly-paced senders.
        bucket.updated += refill * this.#refillMs;
      }
    }
    if (bucket.tokens <= 0) return false;
    bucket.tokens -= 1;
    return true;
  }

  #prune(now: number): void {
    for (const [key, bucket] of this.#buckets) {
      // Refill is lazy (applied on the next tryConsume), so compare the LOGICAL token
      // count: a fully-refilled idle bucket is indistinguishable from a fresh one — drop it.
      const logical = bucket.tokens + Math.floor((now - bucket.updated) / this.#refillMs);
      if (logical >= this.#capacity) this.#buckets.delete(key);
    }
    if (this.#buckets.size >= this.#maxKeys) {
      const oldest = this.#buckets.keys().next().value;
      if (oldest !== undefined) this.#buckets.delete(oldest);
    }
  }
}
