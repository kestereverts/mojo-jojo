import { Subject, type Observable, type Subscription } from "rxjs";
import type { PrivmsgEvent } from "@mojo-jojo/irc-client";

/** Phase of a module lifecycle failure. */
export type ModulePhase = "config" | "setup" | "dispose";
/**
 * Why a command was not run. `overloaded` = the concurrency bound was saturated;
 * `ratelimited` = the sender exceeded the per-user command rate.
 */
export type CommandDeniedReason = "permission" | "cooldown" | "ignored" | "overloaded" | "ratelimited";

/** Framework-domain events (distinct from IRC protocol traffic). */
export type BotEvent =
  | { readonly type: "started" }
  | { readonly type: "stopped"; readonly reason?: string }
  | { readonly type: "moduleLoaded"; readonly name: string }
  | { readonly type: "moduleError"; readonly name: string; readonly phase: ModulePhase; readonly error: Error }
  | { readonly type: "commandInvoked"; readonly command: string; readonly event: PrivmsgEvent }
  | { readonly type: "commandDenied"; readonly command: string; readonly reason: CommandDeniedReason; readonly event: PrivmsgEvent }
  | { readonly type: "commandError"; readonly command: string; readonly event: PrivmsgEvent; readonly error: Error };

export type Unsubscribe = () => void;
export type BotEventListener<T extends BotEvent["type"]> = (event: Extract<BotEvent, { type: T }>) => void;

interface Entry {
  readonly type: BotEvent["type"];
  // The caller's original handler (so `off(type, handler)` works even after `once` wrapping).
  readonly handler: (event: never) => void;
  readonly sub: Subscription;
}

/**
 * Subject-backed hub for {@link BotEvent}s. The primary surface is the RxJS
 * {@link events$} stream; {@link on}/{@link once}/{@link off} are a thin
 * EventEmitter-style façade layered over it (internals stay all-RxJS).
 */
const NOOP: Unsubscribe = () => {};

export class BotEventHub {
  readonly #subject = new Subject<BotEvent>();
  readonly #entries: Entry[] = [];
  readonly #onListenerError: (error: unknown) => void;

  constructor(
    onListenerError: (error: unknown) => void = (error) =>
      console.error("[bot] event listener threw:", error),
  ) {
    this.#onListenerError = onListenerError;
  }

  readonly events$: Observable<BotEvent> = this.#subject.asObservable();

  emit(event: BotEvent): void {
    // emit() runs inside the command pipeline's hot path, so it must never throw.
    // Guard the SYNCHRONOUS case (a raw Subscriber instance whose next throws), which
    // would otherwise escape and tear down the router's subscription. Plain-callback
    // subscribers are wrapped by RxJS in a SafeSubscriber that already isolates their
    // throws (reporting them via RxJS's unhandled-error path), so those never reach
    // here; `on`/`once` is the guarded, bot-logged consumption path.
    try {
      this.#subject.next(event);
    } catch (error) {
      this.#onListenerError(error);
    }
  }

  on<T extends BotEvent["type"]>(type: T, handler: BotEventListener<T>): Unsubscribe {
    const sub = this.#subject.subscribe((event) => {
      if (event.type !== type) return;
      try {
        handler(event as Extract<BotEvent, { type: T }>);
      } catch (error) {
        this.#onListenerError(error);
      }
    });
    if (sub.closed) return NOOP; // already completed (post-stop): no-op, don't retain
    const entry: Entry = { type, handler: handler as (event: never) => void, sub };
    this.#entries.push(entry);
    return () => this.#remove(entry);
  }

  once<T extends BotEvent["type"]>(type: T, handler: BotEventListener<T>): Unsubscribe {
    let fired = false;
    let entry: Entry | undefined;
    const sub = this.#subject.subscribe((event) => {
      if (event.type !== type || fired) return;
      fired = true;
      if (entry) this.#remove(entry);
      try {
        handler(event as Extract<BotEvent, { type: T }>);
      } catch (error) {
        this.#onListenerError(error);
      }
    });
    if (sub.closed) return NOOP;
    entry = { type, handler: handler as (event: never) => void, sub };
    this.#entries.push(entry);
    return () => this.#remove(entry!);
  }

  off<T extends BotEvent["type"]>(type: T, handler: BotEventListener<T>): void {
    // Remove EVERY matching registration (not just the first), matching the
    // client-side EventFacade.off so the two façades behave identically when the
    // same handler was registered more than once.
    for (const entry of [...this.#entries]) {
      if (entry.type === type && entry.handler === (handler as (event: never) => void)) {
        this.#remove(entry);
      }
    }
  }

  /** Complete the stream (and detach every façade listener). Called on bot shutdown. */
  complete(): void {
    for (const entry of this.#entries.splice(0)) entry.sub.unsubscribe();
    this.#subject.complete();
  }

  #remove(entry: Entry): void {
    const index = this.#entries.indexOf(entry);
    if (index >= 0) {
      this.#entries.splice(index, 1);
      entry.sub.unsubscribe();
    }
  }
}
