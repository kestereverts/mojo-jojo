import type { Observable, Subscription } from "rxjs";
import { filter, take } from "rxjs/operators";

// The EventEmitter-style facade (`on`/`once`/`off`) plus a typed `stream(type)`
// helper, layered over *any* source observable of a discriminated-union event
// type. It owns the listener bookkeeping so the classic `off(type, handler)` and
// a bulk teardown both work, while `on` also returns a modern unsubscribe fn.
//
// This is shared plumbing: every {@link ReactiveEntity} drives it from its own
// Subject, and the top-level `IrcClient` drives it from a merged
// protocol-plus-lifecycle stream. Keeping it in one place means the on/once/off
// semantics are implemented (and tested) exactly once.

/** A function that, when called, removes the listener it was returned for. */
export type Unsubscribe = () => void;

/** Shared no-op unsubscribe for listeners that were never tracked. */
const NOOP: Unsubscribe = () => {};

interface Listener {
  readonly type: string;
  readonly handler: (event: never) => void;
  readonly sub: Subscription;
}

export class EventFacade<E extends { type: string }> {
  readonly #source: Observable<E>;
  readonly #listeners: Listener[] = [];

  constructor(source: Observable<E>) {
    this.#source = source;
  }

  /**
   * Subscribe to one event `type`. Returns an unsubscribe function; the handler
   * is also removable via {@link off}.
   */
  on<T extends E["type"]>(type: T, handler: (event: Extract<E, { type: T }>) => void): Unsubscribe {
    const sub = this.stream(type).subscribe(handler);
    // If the source had already completed/errored (e.g. `client.on(...)` after
    // `quit()`, or a synchronous/replaying source), the subscription is already
    // closed: there is nothing left to deliver or unsubscribe, so don't retain a
    // listener that would never be removed.
    if (sub.closed) return NOOP;
    const listener: Listener = { type, handler: handler as (event: never) => void, sub };
    this.#listeners.push(listener);
    return () => this.#remove(listener);
  }

  /** Like {@link on} but auto-unsubscribes after the first matching event. */
  once<T extends E["type"]>(
    type: T,
    handler: (event: Extract<E, { type: T }>) => void,
  ): Unsubscribe {
    let listener: Listener | undefined;
    let fired = false;
    const sub = this.stream(type)
      .pipe(take(1))
      .subscribe((event) => {
        fired = true;
        if (listener) this.#remove(listener);
        handler(event);
      });
    // A synchronous/replaying source can fire (and `take(1)` then complete)
    // before this line runs, leaving `listener` undefined inside the callback —
    // so the `#remove` there is skipped. Detect that (or an already-completed
    // source) via `fired`/`sub.closed` and skip tracking entirely; otherwise the
    // listener could never be removed.
    if (fired || sub.closed) return NOOP;
    listener = { type, handler: handler as (event: never) => void, sub };
    this.#listeners.push(listener);
    return () => {
      if (listener) this.#remove(listener);
    };
  }

  /** Remove a handler previously registered with {@link on}/{@link once}. */
  off<T extends E["type"]>(type: T, handler: (event: Extract<E, { type: T }>) => void): void {
    for (const listener of [...this.#listeners]) {
      if (listener.type === type && listener.handler === handler) this.#remove(listener);
    }
  }

  /** A derived stream filtered to a single event `type`. */
  stream<T extends E["type"]>(type: T): Observable<Extract<E, { type: T }>> {
    return this.#source.pipe(
      filter((event): event is Extract<E, { type: T }> => event.type === type),
    );
  }

  /** Unsubscribe every tracked listener (bulk teardown on dispose/quit). */
  disposeListeners(): void {
    for (const listener of [...this.#listeners]) listener.sub.unsubscribe();
    this.#listeners.length = 0;
  }

  #remove(listener: Listener): void {
    const index = this.#listeners.indexOf(listener);
    if (index === -1) return;
    this.#listeners.splice(index, 1);
    listener.sub.unsubscribe();
  }
}
