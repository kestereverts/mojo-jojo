import type { CompactionEvent, ContextEvent } from "./events.ts";

/**
 * Append-only conversation memory. In-memory and recency-bounded, or SQLite-
 * backed (`SqliteContextLog`, M8) for cross-restart persistence — either way
 * the renderer and the exchange loop touch only this interface.
 */
export interface ContextLog {
  append(event: ContextEvent): void;
  /** Events oldest-first, within the retention window. */
  events(): readonly ContextEvent[];
  /**
   * Physically replaces every event up to and including `events()[throughIndex]`
   * with `event` — a durable, one-way operation (the replaced events are gone,
   * not just hidden). `throughIndex` is an index into the array `events()`
   * would currently return, not a storage-specific id.
   */
  compact(throughIndex: number, event: CompactionEvent): void;
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

  compact(throughIndex: number, event: CompactionEvent): void {
    if (!Number.isInteger(throughIndex) || throughIndex < 0 || throughIndex >= this.#events.length) {
      throw new RangeError(`compact: throughIndex ${throughIndex} out of range for ${this.#events.length} events`);
    }
    this.#events = [event, ...this.#events.slice(throughIndex + 1)];
  }
}
