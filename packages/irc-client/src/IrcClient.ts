import {
  defer,
  filter,
  Observable,
  Subject,
  Subscription,
  take,
  takeUntil,
} from "rxjs";
import type { Message } from "@mojo-jojo/irc-message";
import { createMessageStream } from "./pipeline/IrcPipeline.ts";
import { OutboundQueue } from "./pipeline/outbound.ts";
import { pong, quit as quitCommand } from "./protocol/commands.ts";
import { register, type RegistrationOptions } from "./protocol/registration.ts";
import type { CapabilityStore } from "./protocol/capabilities.ts";
import { retryWithBackoff, type BackoffDeps } from "./reconnect.ts";
import { resolveOptions, type IrcClientOptions, type ResolvedOptions } from "./options.ts";
import type { Transport } from "./transport/Transport.ts";
import type { LifecycleEvent } from "./events/lifecycle.ts";

/** Lifecycle state of an {@link IrcClient}. */
export type ClientState = "idle" | "connecting" | "registered" | "closed";

/** Test-only seams for deterministic reconnect/backoff (omitted in production). */
export interface IrcClientInternals {
  /** Scheduler for backoff timers. */
  readonly scheduler?: BackoffDeps["scheduler"];
  /** RNG for backoff jitter. */
  readonly random?: BackoffDeps["random"];
}

/**
 * A single IRC connection: transport + inbound pipeline + registration + an
 * auto-reconnecting, flood-controlled outbound path.
 *
 * M2 surface: {@link connect}/{@link quit} lifecycle, a stable public
 * {@link messages$} inbound stream and {@link lifecycle$} connection stream,
 * automatic `PING`→`PONG`, and exponential-backoff reconnection. State entities,
 * the rich event taxonomy, and the `.on()` facade arrive in M3/M5.
 *
 * `messages$` and `lifecycle$` are stable across reconnects — they are owned
 * Subjects the per-attempt pipeline feeds into, so subscribers attached once
 * survive transport churn and only complete on {@link quit}.
 */
export class IrcClient {
  readonly #options: ResolvedOptions;
  readonly #internals: IrcClientInternals;

  /** Public, reconnect-stable inbound message stream. */
  readonly #messages = new Subject<Message>();
  /** Public connection lifecycle stream. */
  readonly #lifecycle = new Subject<LifecycleEvent>();
  /** Fires once on {@link quit} to tear down every long-lived subscription. */
  readonly #teardown = new Subject<void>();

  #connectionSub: Subscription | null = null;
  #transport: Transport | null = null;
  #queue: OutboundQueue | null = null;
  #capabilities: CapabilityStore | null = null;
  #nick: string;
  #state: ClientState = "idle";
  #attemptCount = 0;

  constructor(options: IrcClientOptions, internals: IrcClientInternals = {}) {
    this.#options = resolveOptions(options);
    this.#internals = internals;
    this.#nick = this.#options.nick;
  }

  /** The current/last nickname (updated after `433` fallback and registration). */
  get nick(): string {
    return this.#nick;
  }

  /** Current lifecycle state. */
  get state(): ClientState {
    return this.#state;
  }

  /** Capabilities enabled on the active connection (empty before registration). */
  get enabledCaps(): ReadonlySet<string> {
    return this.#capabilities?.enabled ?? new Set();
  }

  /** Stable inbound message stream; completes on {@link quit}. */
  get messages$(): Observable<Message> {
    return this.#messages.asObservable();
  }

  /** Connection lifecycle stream; completes on {@link quit}. */
  get lifecycle$(): Observable<LifecycleEvent> {
    return this.#lifecycle.asObservable();
  }

  /**
   * Open the connection and register. Resolves once registered (`001`), or
   * rejects if the connection fails terminally before registering (reconnection
   * disabled or exhausted). After it resolves, dropped connections reconnect in
   * the background and surface on {@link lifecycle$}.
   */
  connect(): Promise<void> {
    if (this.#state !== "idle") {
      return Promise.reject(new Error(`connect() called in state "${this.#state}"`));
    }
    this.#state = "connecting";

    // Long-lived PING responder: answers on the *current* connection's queue and
    // survives reconnects (it listens on the stable #messages stream).
    this.#messages
      .pipe(
        filter((message) => message.command === "PING"),
        takeUntil(this.#teardown),
      )
      .subscribe((message) => this.#queue?.sendImmediate(pong(message.params[0] ?? "")));

    const connection$ = defer(() => this.#runAttempt()).pipe(
      retryWithBackoff<void>(this.#options.reconnect, {
        scheduler: this.#internals.scheduler,
        random: this.#internals.random,
        // `attempt` is the upcoming (lifetime) attempt number, so it matches the
        // `connecting` event that follows; the backoff itself uses retryCount.
        onRetry: (_retryCount, delayMs) =>
          this.#emit({ type: "reconnecting", attempt: this.#attemptCount + 1, delayMs }),
      }),
      takeUntil(this.#teardown),
    );

    return new Promise<void>((resolve, reject) => {
      let resolved = false;
      const registeredSub = this.#lifecycle
        .pipe(
          filter((event) => event.type === "registered"),
          take(1),
          takeUntil(this.#teardown),
        )
        .subscribe(() => {
          resolved = true;
          resolve();
        });

      this.#connectionSub = connection$.subscribe({
        error: (err: unknown) => {
          const error = err instanceof Error ? err : new Error(String(err));
          this.#state = "closed";
          this.#emit({ type: "error", error });
          registeredSub.unsubscribe();
          if (!resolved) reject(error);
        },
        complete: () => {
          // Reached only via a local close (quit) — abnormal drops error instead.
          this.#state = "closed";
          this.#emit({ type: "disconnected", local: true });
          registeredSub.unsubscribe();
          if (!resolved) reject(new Error("connection closed before registration"));
        },
      });
    });
  }

  /**
   * Send `QUIT`, close the connection, and tear down all subscriptions. Stops
   * reconnection. Idempotent-ish: safe to call once; the client is single-use.
   */
  quit(reason = "Leaving"): void {
    this.#queue?.sendImmediate(quitCommand(reason));
    this.#state = "closed";
    // Stop reconnect + long-lived subscriptions; takeUntil completes connection$
    // (its complete handler emits the local "disconnected").
    this.#teardown.next();
    this.#teardown.complete();
    this.#connectionSub?.unsubscribe();
    this.#queue?.close();
    this.#queue = null;
    this.#transport = null;
    this.#messages.complete();
    this.#lifecycle.complete();
  }

  /** Enqueue a message on the flood-controlled outbound path. */
  send(message: Message): void {
    this.#queue?.send(message);
  }

  #emit(event: LifecycleEvent): void {
    this.#lifecycle.next(event);
  }

  #registrationOptions(): RegistrationOptions {
    const options = this.#options;
    return {
      nick: options.nick,
      username: options.username,
      realName: options.realName,
      password: options.password,
      desiredCaps: options.caps,
      altNicks: options.altNicks,
      // SASL is requested + performed in M4; M2 never authenticates, so `sasl`
      // is dropped during capability reconciliation.
      saslRequested: false,
      timeoutMs: options.registrationTimeoutMs,
    };
  }

  /**
   * Build one connection attempt as an observable whose lifetime mirrors the
   * transport: it emits exactly once (on successful registration, to reset the
   * backoff), completes on a local close, and errors on an abnormal drop — so
   * the surrounding `retryWithBackoff` reconnects only on the latter.
   */
  #runAttempt(): Observable<void> {
    return new Observable<void>((subscriber) => {
      const attempt = ++this.#attemptCount;
      const transport = this.#options.transportFactory();
      this.#transport = transport;
      this.#emit({ type: "connecting", attempt });

      const messages$ = createMessageStream(transport, { backend: this.#options.backend });
      const sub = new Subscription();
      let settled = false;
      let queue: OutboundQueue | null = null;

      const failAttempt = (err: unknown): void => {
        if (settled) return;
        settled = true;
        const error = err instanceof Error ? err : new Error(String(err));
        this.#emit({ type: "disconnected", local: false, error });
        subscriber.error(error);
      };
      const completeAttempt = (): void => {
        if (settled) return;
        settled = true;
        subscriber.complete();
      };

      // Pump the per-attempt pipeline into the stable public stream; its
      // completion/error drives this attempt (and thus the retry decision).
      sub.add(
        messages$.subscribe({
          next: (message) => this.#messages.next(message),
          error: failAttempt,
          complete: completeAttempt,
        }),
      );

      void (async () => {
        try {
          await transport.connect();
          if (settled) return; // closed while connecting
          queue = new OutboundQueue((line) => transport.write(line), {
            floodDelayMs: this.#options.floodDelayMs,
          });
          this.#queue = queue;
          this.#emit({ type: "connected", attempt });

          const result = await register(
            { messages$, send: (message) => queue?.sendImmediate(message) },
            this.#registrationOptions(),
          );
          if (settled) return;
          this.#nick = result.nick;
          this.#capabilities = result.capabilities;
          this.#state = "registered";
          this.#emit({ type: "registered", nick: result.nick });
          // Signal success to retryWithBackoff (resetOnSuccess) so a later drop
          // backs off from scratch rather than continuing the failure count.
          subscriber.next();
        } catch (err) {
          failAttempt(err);
        }
      })();

      return () => {
        // Cancel the attempt: if connect()/register() is still in flight, this
        // makes the async continuation abort at its `if (settled) return` guards,
        // so a quit() (or retry) during an in-flight connect never registers or
        // writes to a closing socket.
        settled = true;
        sub.unsubscribe();
        queue?.close();
        // Only clear shared slots if they still belong to this attempt (a newer
        // attempt may already have replaced them).
        if (this.#queue === queue) this.#queue = null;
        if (this.#transport === transport) this.#transport = null;
        transport.close();
      };
    });
  }
}
