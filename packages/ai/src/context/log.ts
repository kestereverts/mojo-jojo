import type { ContextEvent } from "./events.ts";

/**
 * Append-only conversation memory. In-memory and recency-bounded for now;
 * a storage-backed implementation (SQLite via the module's `storage`) can
 * replace this without touching the renderer or the loop.
 */
export interface ContextLog {
  append(event: ContextEvent): void;
  /** Events oldest-first, within the retention window. */
  events(): readonly ContextEvent[];
}

export class InMemoryContextLog implements ContextLog {
  #events: ContextEvent[] = [];
  readonly #limit: number;

  constructor(limit = 200) {
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new RangeError(`log limit must be a positive integer, got ${limit}`);
    }
    this.#limit = limit;
  }

  append(event: ContextEvent): void {
    this.#events.push(event);
    if (this.#events.length > this.#limit) {
      this.#events.splice(0, this.#events.length - this.#limit);
    }
  }

  events(): readonly ContextEvent[] {
    return this.#events;
  }
}
