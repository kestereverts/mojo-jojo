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
   * Physically replaces the oldest `replacedEvents.length` events with
   * `event` — a durable, one-way operation (the replaced events are gone,
   * not just hidden). `replacedEvents` must be EXACTLY the current oldest
   * prefix (deep-equal, in order) — implementations verify this before
   * mutating and throw if it has drifted since the caller snapshotted it
   * (e.g. another writer for the same conversation already compacted or
   * appended in between). This makes `compact()` safe to call from a stale
   * snapshot: a drifted call fails loudly rather than silently deleting
   * content a caller never actually summarized (M8 review finding — a
   * plain event-count/index was NOT sufficient: two independently-computed
   * compactions racing on the same conversation could each pass a "valid"
   * count/index that no longer corresponded to what was actually
   * summarized, silently losing whichever rows the second call's index
   * happened to select instead of what its summary text actually covered).
   */
  compact(replacedEvents: readonly ContextEvent[], event: CompactionEvent): void;
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
      const excess = this.#events.length - this.#limit;
      // Protect a leading compaction summary from eviction — it represents
      // everything already folded in; evicting IT (always index 0, see
      // `compact()`) before raw tail events would destroy compressed
      // history before uncompressed history, backwards from what a hard
      // backstop should protect first (review finding). Trim starts one
      // index later when a summary is present.
      const spliceStart = this.#events[0]?.kind === "compaction" ? 1 : 0;
      this.#events.splice(spliceStart, excess);
    }
  }

  events(): readonly ContextEvent[] {
    return this.#events;
  }

  compact(replacedEvents: readonly ContextEvent[], event: CompactionEvent): void {
    if (replacedEvents.length === 0 || replacedEvents.length > this.#events.length) {
      throw new RangeError(`compact: replacedEvents length ${replacedEvents.length} out of range for ${this.#events.length} events`);
    }
    const current = this.#events.slice(0, replacedEvents.length);
    if (JSON.stringify(current) !== JSON.stringify(replacedEvents)) {
      throw new RangeError("compact: the log has changed since these events were snapshotted — refusing to compact a stale prefix");
    }
    this.#events = [event, ...this.#events.slice(replacedEvents.length)];
  }
}
