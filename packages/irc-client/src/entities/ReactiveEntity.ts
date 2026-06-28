import { Observable, Subject, type Subscription } from "rxjs";
import { filter, take } from "rxjs/operators";
import { DISPOSE, EMIT } from "./internal.ts";

// Shared reactive base for every stateful entity (Server, Channel, User).
//
// Each entity owns a private `Subject` of its own event union. The dispatcher
// pushes resolved events into it (via the `@internal` {@link dispatch}); the
// entity re-exposes them two ways that are always equivalent:
//
//   - RxJS-first: `events$` and derived named streams (`messages$`, …)
//   - EventEmitter-style: `on(type, cb)` / `once(type, cb)` / `off(type, cb)`
//
// `on` returns an unsubscribe function (modern ergonomics) *and* registers the
// handler so the classic `off(type, handler)` also works. M5 finalizes the
// per-entity derived streams and the unified facade; the base lands here in M3.

interface Listener {
  readonly type: string;
  readonly handler: (event: never) => void;
  readonly sub: Subscription;
}

/** A function that, when called, removes the listener it was returned for. */
export type Unsubscribe = () => void;

export abstract class ReactiveEntity<E extends { type: string }> {
  readonly #subject = new Subject<E>();
  readonly #listeners: Listener[] = [];

  /** The entity's full event stream (RxJS-first surface). */
  readonly events$: Observable<E> = this.#subject.asObservable();

  /**
   * Subscribe to one event `type`. Returns an unsubscribe function; the handler
   * is also removable via {@link off}.
   */
  on<T extends E["type"]>(type: T, handler: (event: Extract<E, { type: T }>) => void): Unsubscribe {
    const sub = this.#subject
      .pipe(filter((event): event is Extract<E, { type: T }> => event.type === type))
      .subscribe(handler);
    const listener: Listener = { type, handler: handler as (event: never) => void, sub };
    this.#listeners.push(listener);
    return () => this.#remove(listener);
  }

  /** Like {@link on} but auto-unsubscribes after the first matching event. */
  once<T extends E["type"]>(
    type: T,
    handler: (event: Extract<E, { type: T }>) => void,
  ): Unsubscribe {
    // `listener` is assigned before any event can fire (Subject doesn't replay),
    // but declare it up-front and guard to avoid any temporal-dead-zone risk.
    let listener: Listener | undefined;
    const sub = this.#subject
      .pipe(
        filter((event): event is Extract<E, { type: T }> => event.type === type),
        take(1),
      )
      .subscribe((event) => {
        if (listener) this.#remove(listener);
        handler(event);
      });
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

  /**
   * Push an event into this entity's stream. Symbol-keyed so only the
   * dispatcher/StateStore (which import {@link EMIT}) can call it — consumers
   * holding an entity reference cannot forge events.
   */
  [EMIT](event: E): void {
    this.#subject.next(event);
  }

  /**
   * Complete the entity's stream (e.g. on PART/QUIT/reconnect) so consumer
   * subscriptions auto-clean. Symbol-keyed; only the StateStore calls it.
   */
  [DISPOSE](): void {
    for (const listener of [...this.#listeners]) listener.sub.unsubscribe();
    this.#listeners.length = 0;
    this.#subject.complete();
  }

  /** Build a derived named stream filtered to a single event type. */
  protected stream<T extends E["type"]>(type: T): Observable<Extract<E, { type: T }>> {
    return this.#subject.pipe(
      filter((event): event is Extract<E, { type: T }> => event.type === type),
    );
  }

  #remove(listener: Listener): void {
    const index = this.#listeners.indexOf(listener);
    if (index === -1) return;
    this.#listeners.splice(index, 1);
    listener.sub.unsubscribe();
  }
}
