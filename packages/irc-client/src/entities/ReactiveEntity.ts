import { Observable, Subject, defer, distinctUntilChanged, map, merge, startWith } from "rxjs";
import { DISPOSE, EMIT } from "./internal.ts";
import { EventFacade, type Unsubscribe } from "./EventFacade.ts";

// Shared reactive base for every stateful entity (Channel, User, …).
//
// Each entity owns a private `Subject` of its own event union. The dispatcher
// pushes resolved events into it (via the symbol-keyed {@link EMIT}); the entity
// re-exposes them two ways that are always equivalent:
//
//   - RxJS-first: `events$` and derived named streams (`messages$`, …)
//   - EventEmitter-style: `on(type, cb)` / `once(type, cb)` / `off(type, cb)`
//
// The on/once/off bookkeeping lives in the shared {@link EventFacade} (also used
// by the top-level IrcClient surface), so it is implemented in exactly one place.

export type { Unsubscribe };

export abstract class ReactiveEntity<E extends { type: string }> {
  readonly #subject = new Subject<E>();
  readonly #facade = new EventFacade<E>(this.#subject);

  /** The entity's full event stream (RxJS-first surface). */
  readonly events$: Observable<E> = this.#subject.asObservable();

  /**
   * Subscribe to one event `type`. Returns an unsubscribe function; the handler
   * is also removable via {@link off}.
   */
  on<T extends E["type"]>(type: T, handler: (event: Extract<E, { type: T }>) => void): Unsubscribe {
    return this.#facade.on(type, handler);
  }

  /** Like {@link on} but auto-unsubscribes after the first matching event. */
  once<T extends E["type"]>(
    type: T,
    handler: (event: Extract<E, { type: T }>) => void,
  ): Unsubscribe {
    return this.#facade.once(type, handler);
  }

  /** Remove a handler previously registered with {@link on}/{@link once}. */
  off<T extends E["type"]>(type: T, handler: (event: Extract<E, { type: T }>) => void): void {
    this.#facade.off(type, handler);
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
    this.#facade.disposeListeners();
    this.#subject.complete();
  }

  /** Build a derived named stream filtered to a single event type. */
  protected stream<T extends E["type"]>(type: T): Observable<Extract<E, { type: T }>> {
    return this.#facade.stream(type);
  }

  /**
   * Build a **replay value-stream**: emits the value read by `read()` immediately
   * on subscribe (the current snapshot), then again — deduplicated — after every
   * event of any of `types`. Use for "current value, then updates" scalar state
   * like a channel topic or a nick. `defer` captures the value at *subscribe*
   * time, so a late subscriber gets the up-to-date value, not a stale one. The
   * value is re-read from `read()` after each event, so it reflects the mutation
   * the dispatcher applied before emitting. Completes when the entity is disposed.
   *
   * Only suitable for fields whose every change emits one of `types`; fields also
   * mutated silently (e.g. account/realname enriched by WHO) won't update here —
   * read those via {@link snapshot}-style getters instead. Intended for
   * scalar/primitive values: dedup uses `distinctUntilChanged`'s default
   * (SameValueZero) equality, which is reference-based for objects.
   */
  protected valueStream<V>(read: () => V, ...types: ReadonlyArray<E["type"]>): Observable<V> {
    return defer(() => {
      const sources = types.map((type) => this.stream(type));
      const changes = sources.length === 1 ? sources[0]! : merge(...sources);
      return changes.pipe(
        map(() => read()),
        startWith(read()),
        distinctUntilChanged(),
      );
    });
  }
}
