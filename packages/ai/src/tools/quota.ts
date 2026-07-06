/**
 * A daily call-count limiter. In-process only for now (resets on restart —
 * mojo-ai3's equivalent had the same limitation; a module-owned SQLite file
 * in M8 will make this durable).
 */
export class DailyQuota {
  #count = 0;
  #day = "";
  readonly #limit: number;

  constructor(limit: number) {
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new RangeError(`quota limit must be a positive integer, got ${limit}`);
    }
    this.#limit = limit;
  }

  /** Attempt to consume one call; `false` means the daily limit is exhausted. */
  tryConsume(now = new Date()): boolean {
    const day = now.toISOString().slice(0, 10);
    if (day !== this.#day) {
      this.#day = day;
      this.#count = 0;
    }
    if (this.#count >= this.#limit) return false;
    this.#count++;
    return true;
  }

  remaining(now = new Date()): number {
    const day = now.toISOString().slice(0, 10);
    return day === this.#day ? this.#limit - this.#count : this.#limit;
  }
}

/**
 * A client-side rate limiter: `capacity` tokens, refilling one at a time
 * every `refillIntervalMs`. Bounds how often *this process* calls a paid/
 * abusable API (e.g. web_search) — independent of, and much tighter than,
 * the provider's own server-side rate limit, which exists to protect their
 * infra, not our budget.
 */
export class TokenBucket {
  #tokens: number;
  // Lazily stamped from the first tryConsume() call's `nowMs`, not at
  // construction — a real-clock construction time would make an
  // explicit-nowMs call (e.g. `tryConsume(0)` in a test) look like it
  // happened long before the bucket existed, permanently starving refills.
  #lastRefillMs: number | undefined;
  readonly #capacity: number;
  readonly #refillIntervalMs: number;

  constructor(capacity: number, refillIntervalMs: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new RangeError(`bucket capacity must be a positive integer, got ${capacity}`);
    }
    if (!(refillIntervalMs > 0)) {
      throw new RangeError(`refillIntervalMs must be positive, got ${refillIntervalMs}`);
    }
    this.#capacity = capacity;
    this.#refillIntervalMs = refillIntervalMs;
    this.#tokens = capacity;
  }

  /** Attempt to consume one token; `false` means the bucket is empty right now. */
  tryConsume(nowMs = Date.now()): boolean {
    this.#lastRefillMs ??= nowMs;
    this.#refill(nowMs);
    if (this.#tokens < 1) return false;
    this.#tokens--;
    return true;
  }

  #refill(nowMs: number): void {
    const elapsed = nowMs - this.#lastRefillMs!;
    if (elapsed <= 0) return;
    const gained = Math.floor(elapsed / this.#refillIntervalMs);
    if (gained <= 0) return;
    this.#tokens = Math.min(this.#capacity, this.#tokens + gained);
    this.#lastRefillMs! += gained * this.#refillIntervalMs;
  }
}
