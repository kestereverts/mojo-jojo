/**
 * A daily call-count limiter. In-process only for now (resets on restart —
 * mojo-ai3's equivalent had the same limitation; a module-owned SQLite file
 * in M8 will make this durable). Not used by any M4 tool, but built now
 * since a later batch (places_search, M5) needs it and the shape is settled.
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
