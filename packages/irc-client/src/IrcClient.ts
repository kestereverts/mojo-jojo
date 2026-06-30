import {
  defer,
  filter,
  merge,
  mergeMap,
  Observable,
  startWith,
  Subject,
  Subscription,
  switchMap,
  take,
  takeUntil,
  tap,
  timer,
} from "rxjs";
import type { Message } from "@mojo-jojo/irc-message";
import { createMessageStream } from "./pipeline/IrcPipeline.ts";
import { OutboundQueue } from "./pipeline/outbound.ts";
import {
  action as actionCommand,
  away as awayCommand,
  capReq,
  command as rawCommand,
  invite as inviteCommand,
  join as joinCommand,
  kick as kickCommand,
  mode as modeCommand,
  names as namesCommand,
  nick as nickCommand,
  notice as noticeCommand,
  part as partCommand,
  ping,
  pong,
  privmsg as privmsgCommand,
  quit as quitCommand,
  topic as topicCommand,
  who as whoCommand,
  whois as whoisCommand,
} from "./protocol/commands.ts";
import { register, type RegistrationOptions } from "./protocol/registration.ts";
import {
  chunkCaps,
  parseCapMessage,
  reconcileCaps,
  type CapabilityStore,
} from "./protocol/capabilities.ts";
import { whoxQuery } from "./protocol/whox.ts";
import { capEvent } from "./events/factory.ts";
import { retryWithBackoff, type BackoffDeps } from "./reconnect.ts";
import { resolveOptions, type IrcClientOptions, type ResolvedOptions } from "./options.ts";
import type { Transport } from "./transport/Transport.ts";
import { EventFacade, type Unsubscribe } from "./entities/EventFacade.ts";
import type { LifecycleEvent } from "./events/lifecycle.ts";
import type { ClientEvent, IrcEvent, JoinEvent } from "./events/types.ts";
import { StateStore } from "./state/StateStore.ts";
import { Dispatcher } from "./state/dispatch.ts";
import type { Server } from "./entities/Server.ts";
import type { Channel } from "./entities/Channel.ts";
import type { User } from "./entities/User.ts";
import type { IrcMap } from "./casemapping/IrcMap.ts";

/** Lifecycle state of an {@link IrcClient}. */
export type ClientState = "idle" | "connecting" | "registered" | "closed";

/** Test-only seams for deterministic reconnect/backoff (omitted in production). */
export interface IrcClientInternals {
  /** Scheduler for backoff timers. */
  readonly scheduler?: BackoffDeps["scheduler"];
  /** RNG for backoff jitter. */
  readonly random?: BackoffDeps["random"];
  /**
   * Invoked when a dispatch handler throws (a client-internal bug). The
   * connection is unaffected — the raw message still flows on `messages$`.
   * Defaults to {@link defaultDispatchErrorHandler} (a `console.error`).
   */
  readonly onDispatchError?: (error: unknown, message: Message) => void;
  /**
   * Invoked when an inbound line fails to parse (malformed or over-length). The
   * line is dropped and the connection continues (a single bad line never tears
   * it down). Defaults to {@link defaultParseErrorHandler} (a `console.error`).
   */
  readonly onParseError?: (error: unknown, line: string) => void;
}

/** Caps on a single {@link IrcClient.sendLabeled} response, so a server that
 * streams a never-closing labeled batch can't grow its buffer without bound. */
const MAX_LABELED_MESSAGES = 4096;
const MAX_LABELED_BATCHES = 64;

/** Default sink for dispatch faults: log them so they aren't silently lost. */
function defaultDispatchErrorHandler(error: unknown, message: Message): void {
  console.error(`[irc-client] dispatch failed for ${message.command}:`, error);
}

/** Default sink for parse faults: log the dropped line rather than swallow it. */
function defaultParseErrorHandler(error: unknown, line: string): void {
  console.error(`[irc-client] dropping unparseable line (${line.length} chars):`, error);
}

/**
 * A single IRC connection: transport + inbound pipeline + registration + an
 * auto-reconnecting, flood-controlled outbound path.
 *
 * M2 surface: {@link connect}/{@link quit} lifecycle, a stable public
 * {@link messages$} inbound stream and {@link lifecycle$} connection stream,
 * automatic `PING`→`PONG`, and exponential-backoff reconnection. M3 adds live
 * state ({@link server}/{@link channels}/{@link users}/{@link channel}/
 * {@link user}) and the entity-resolved {@link events$} firehose. M5 adds the
 * action methods ({@link say}/{@link join}/…) and the unified `.on()` facade:
 * {@link on}/{@link once}/{@link off} and {@link clientEvents$} range over the
 * combined `ClientEvent` surface (protocol events + lifecycle events), mirroring
 * the per-entity facade so one subscription can see `"privmsg"` and `"registered"`.
 *
 * `messages$`, `events$`, and `lifecycle$` are stable across reconnects — they
 * are owned Subjects the per-attempt pipeline feeds into, so subscribers
 * attached once survive transport churn and only complete on {@link quit}. The
 * {@link server} state, by contrast, is rebuilt per connection.
 *
 * Note: rather than extending `ReactiveEntity`, the client *composes* the shared
 * {@link EventFacade} over a `merge` of its two long-lived event subjects. That
 * keeps the established protocol-only {@link events$} getter and the separate
 * {@link lifecycle$} stream intact (a `ReactiveEntity` base would force a single
 * `events$` of the combined union), while still reusing one on/once/off impl.
 */
export class IrcClient {
  readonly #options: ResolvedOptions;
  readonly #internals: IrcClientInternals;

  /** Public, reconnect-stable inbound message stream. */
  readonly #messages = new Subject<Message>();
  /** Public, reconnect-stable entity-resolved event stream (M3). */
  readonly #events = new Subject<IrcEvent>();
  /** Public connection lifecycle stream. */
  readonly #lifecycle = new Subject<LifecycleEvent>();
  /** Unified protocol + lifecycle firehose (M5); the `.on()` facade reads it. */
  readonly #clientEvents: Observable<ClientEvent>;
  /** Shared EventEmitter-style facade over {@link #clientEvents}. */
  readonly #facade: EventFacade<ClientEvent>;
  /** Fires once on {@link quit} to tear down every long-lived subscription. */
  readonly #teardown = new Subject<void>();

  #connectionSub: Subscription | null = null;
  #transport: Transport | null = null;
  #queue: OutboundQueue | null = null;
  #capabilities: CapabilityStore | null = null;
  /** Live connection state, rebuilt per attempt (fresh on each reconnect). */
  #store: StateStore | null = null;
  #nick: string;
  #state: ClientState = "idle";
  #attemptCount = 0;
  /** Set once {@link #shutdown} has torn the client down (idempotency guard). */
  #torndown = false;
  /** Monotonic counter for `labeled-response` correlation tags (M6). */
  #labelCounter = 0;

  constructor(options: IrcClientOptions, internals: IrcClientInternals = {}) {
    this.#options = resolveOptions(options);
    this.#internals = internals;
    this.#nick = this.#options.nick;
    // The two hot subjects are already initialized (field order); merge them into
    // the unified surface the facade ranges over. No share() needed — both are
    // multicast Subjects, so each subscription forwards directly.
    this.#clientEvents = merge(this.#events, this.#lifecycle);
    this.#facade = new EventFacade<ClientEvent>(this.#clientEvents);
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
   * Stable protocol event stream (the firehose) — entity-resolved events plus
   * connection-scoped ones (`cap`/`batch`/`standardReply`). Survives reconnects
   * and completes on {@link quit}. For the combined protocol + lifecycle surface,
   * use {@link clientEvents$} or the {@link on} facade; per-entity streams are on
   * the entities returned by {@link channel}/{@link user}.
   */
  get events$(): Observable<IrcEvent> {
    return this.#events.asObservable();
  }

  /**
   * The unified `ClientEvent` firehose (M5): every protocol {@link events$} event
   * *and* every {@link lifecycle$} event, interleaved by emission order. This is
   * the RxJS-first equivalent of the {@link on} facade; completes on {@link quit}.
   */
  get clientEvents$(): Observable<ClientEvent> {
    return this.#clientEvents;
  }

  /**
   * Subscribe to one event `type` across the unified protocol + lifecycle
   * surface, e.g. `client.on("privmsg", …)` or `client.on("registered", …)`.
   * Returns an unsubscribe function; the handler is also removable via
   * {@link off}. Equivalent to filtering {@link clientEvents$} by `type`.
   */
  on<T extends ClientEvent["type"]>(
    type: T,
    handler: (event: Extract<ClientEvent, { type: T }>) => void,
  ): Unsubscribe {
    return this.#facade.on(type, handler);
  }

  /** Like {@link on} but auto-unsubscribes after the first matching event. */
  once<T extends ClientEvent["type"]>(
    type: T,
    handler: (event: Extract<ClientEvent, { type: T }>) => void,
  ): Unsubscribe {
    return this.#facade.once(type, handler);
  }

  /** Remove a handler previously registered with {@link on}/{@link once}. */
  off<T extends ClientEvent["type"]>(
    type: T,
    handler: (event: Extract<ClientEvent, { type: T }>) => void,
  ): void {
    this.#facade.off(type, handler);
  }

  /** The live server-state aggregate for the current connection, or `null`. */
  get server(): Server | null {
    return this.#store?.server ?? null;
  }

  /** Case-insensitive map of joined channels, or `undefined` before connecting. */
  get channels(): IrcMap<Channel> | undefined {
    return this.#store?.server.channels;
  }

  /** Case-insensitive map of known users, or `undefined` before connecting. */
  get users(): IrcMap<User> | undefined {
    return this.#store?.server.users;
  }

  /** Look up a joined channel by name (case-insensitive). */
  channel(name: string): Channel | undefined {
    return this.#store?.channel(name);
  }

  /**
   * Look up a known user by nick (case-insensitive). Returns a {@link User} only
   * for someone we currently share a channel with (or ourself). A pure-PM partner
   * — who sends us PRIVMSG/NOTICE but shares no channel — is intentionally not
   * retained (it would leak over a long session), so this returns `undefined` for
   * them; observe such messages via {@link events$} / {@link on}("privmsg") where
   * the resolved sender is delivered on the event.
   */
  user(nick: string): User | undefined {
    return this.#store?.user(nick);
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

    // Long-lived cap-notify handler: keep enabled/available caps current as
    // `CAP NEW`/`CAP DEL` (and post-`NEW` `ACK`s) arrive after registration.
    this.#messages
      .pipe(
        filter((message) => message.command === "CAP"),
        takeUntil(this.#teardown),
      )
      .subscribe((message) => this.#handleCapNotify(message));

    // Optional WHO-on-join: backfill members already present on each channel we
    // join (whose `extended-join` we never saw) with one WHO/WHOX per self-join.
    // Reconnect-stable: subscribes once to the long-lived event stream.
    if (this.#options.whoOnJoin) {
      this.#events
        .pipe(
          filter((event): event is JoinEvent => event.type === "join" && event.isSelf),
          takeUntil(this.#teardown),
        )
        .subscribe((event) => {
          // Best-effort: who() goes through the throwing flood queue. A burst of
          // self-JOINs (incl. a hostile server forging `:me JOIN #x`) could fill
          // it; drop the backfill rather than let the throw escape the
          // subscription and crash the process.
          try {
            this.who(event.channel.name);
          } catch {
            // queue full / send rejected — skip this best-effort backfill
          }
        });
    }

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
      let settled = false;
      const registeredSub = this.#lifecycle
        .pipe(
          filter((event) => event.type === "registered"),
          take(1),
          takeUntil(this.#teardown),
        )
        .subscribe(() => {
          if (settled) return;
          settled = true;
          clearTimeout(deadline);
          resolve();
        });

      // Bound the *initial* connect so a bad host / never-registering server can't
      // hang `await connect()` forever under the default infinite-retry policy.
      // Once registered this is cleared; later drops are governed by `reconnect`.
      const deadline: ReturnType<typeof setTimeout> | undefined = Number.isFinite(
        this.#options.connectTimeoutMs,
      )
        ? setTimeout(() => {
            if (settled) return;
            settled = true;
            registeredSub.unsubscribe();
            reject(
              new Error(
                `connect: timed out after ${this.#options.connectTimeoutMs}ms before registration`,
              ),
            );
            this.#shutdown(); // stop the retry loop + complete the public streams
          }, this.#options.connectTimeoutMs)
        : undefined;

      this.#connectionSub = connection$.subscribe({
        error: (err: unknown) => {
          const error = err instanceof Error ? err : new Error(String(err));
          this.#state = "closed";
          this.#emit({ type: "error", error });
          registeredSub.unsubscribe();
          if (!settled) {
            settled = true;
            clearTimeout(deadline);
            reject(error);
          }
          // Terminal failure (reconnect disabled/exhausted): complete the public
          // streams so consumers awaiting completion don't hang.
          this.#shutdown();
        },
        complete: () => {
          // Reached only via a local close (quit) — abnormal drops error instead.
          this.#state = "closed";
          this.#emit({ type: "disconnected", local: true });
          registeredSub.unsubscribe();
          if (!settled) {
            settled = true;
            clearTimeout(deadline);
            reject(new Error("connection closed before registration"));
          }
        },
      });
    });
  }

  /**
   * Send `QUIT`, close the connection, and tear down all subscriptions. Stops
   * reconnection. Idempotent: safe to call repeatedly; the client is single-use.
   */
  quit(reason = "Leaving"): void {
    // Shut down even if the QUIT write throws (e.g. a faulted transport), so the
    // client never reports a live state with the connection actually torn down.
    // The write error still propagates after shutdown completes.
    try {
      this.#queue?.sendImmediate(quitCommand(reason));
    } finally {
      this.#shutdown();
    }
  }

  /**
   * Stop reconnection and complete every long-lived stream/subscription. Shared
   * by {@link quit} and the terminal/timeout failure paths so a client that never
   * (or no longer) connects still completes `messages$`/`events$`/`lifecycle$`
   * rather than leaving consumers awaiting completion forever. Idempotent.
   */
  #shutdown(): void {
    if (this.#torndown) return;
    this.#torndown = true;
    this.#state = "closed";
    // takeUntil completes connection$ (its complete handler emits the local
    // "disconnected" when an attempt was live).
    this.#teardown.next();
    this.#teardown.complete();
    this.#connectionSub?.unsubscribe();
    this.#queue?.close();
    this.#queue = null;
    this.#transport = null;
    // Drop facade listeners first (deterministic for leak tests), then complete
    // the source subjects — which also completes the merged #clientEvents stream.
    this.#facade.disposeListeners();
    this.#messages.complete();
    this.#events.complete();
    this.#lifecycle.complete();
  }

  /**
   * Enqueue a message on the flood-controlled outbound path. A no-op when there
   * is no active connection (before {@link connect} resolves or after
   * {@link quit}); the action helpers below share this behaviour.
   */
  send(message: Message): void {
    this.#queue?.send(message);
  }

  // ---- Actions (M5) ----
  //
  // Ergonomic wrappers over the command builders, all routed through the
  // flood-controlled {@link send}. They mutate nothing locally: state updates
  // come back from the server (echo-message, JOIN, NICK, MODE, …) through the
  // normal inbound pipeline, so the local view never diverges from the server's.

  /** Send a `PRIVMSG` to a channel or user. */
  say(target: string, text: string): void {
    this.send(privmsgCommand(target, text));
  }

  /** Send a `NOTICE` to a channel or user. */
  notice(target: string, text: string): void {
    this.send(noticeCommand(target, text));
  }

  /** Send a CTCP `ACTION` (`/me`) to a channel or user. */
  action(target: string, text: string): void {
    this.send(actionCommand(target, text));
  }

  /** Join a channel, optionally with a key. */
  join(channel: string, key?: string): void {
    this.send(joinCommand(channel, key));
  }

  /** Leave a channel, optionally with a reason. */
  part(channel: string, reason?: string): void {
    this.send(partCommand(channel, reason));
  }

  /** Kick a user from a channel, optionally with a reason. */
  kick(channel: string, nick: string, reason?: string): void {
    this.send(kickCommand(channel, nick, reason));
  }

  /**
   * Request a nick change (`NICK`). Named `setNick` to avoid shadowing the
   * {@link nick} getter; our tracked nick updates when the server confirms it.
   */
  setNick(newNick: string): void {
    this.send(nickCommand(newNick));
  }

  /** Set (or, with no `modes`, query) channel or user modes. */
  mode(target: string, modes?: string, ...params: string[]): void {
    this.send(modeCommand(target, modes, ...params));
  }

  /** Set a channel topic, or query it when `newTopic` is omitted. */
  topic(channel: string, newTopic?: string): void {
    this.send(topicCommand(channel, newTopic));
  }

  /** Invite a user to a channel. */
  invite(nick: string, channel: string): void {
    this.send(inviteCommand(nick, channel));
  }

  /** Request `WHOIS` detail for a nick. */
  whois(target: string): void {
    this.send(whoisCommand(target));
  }

  /**
   * Request a `WHO` listing for a channel or user mask. When the server supports
   * WHOX (ISUPPORT `WHOX`), this sends a WHOX query so the reply also carries each
   * user's services account, real name, host, away status, and channel status —
   * which a plain `WHO`/`352` can't provide. Those land on the resolved
   * {@link User}/{@link Member} as the `354` replies arrive; otherwise a plain
   * `WHO` is sent and `352` enrichment applies.
   */
  who(mask: string): void {
    this.send(this.#store?.server.isupport.whox === true ? whoxQuery(mask) : whoCommand(mask));
  }

  /** Request a channel's `NAMES` listing. */
  names(channel: string): void {
    this.send(namesCommand(channel));
  }

  /** Set our away status with a reason, or clear it when `reason` is omitted. */
  away(reason?: string): void {
    this.send(awayCommand(reason));
  }

  /** Send an arbitrary raw command (with ordered params) through the queue. */
  raw(commandName: string, ...params: string[]): void {
    this.send(rawCommand(commandName, ...params));
  }

  /**
   * Send a command correlated via `labeled-response` and resolve with the
   * server's reply for it: `[]` for an `ACK` (a command that normally produces no
   * output), `[message]` for a single labeled reply, or the inner messages of a
   * labeled `BATCH` (nested batches included). Rejects on timeout (default 30s),
   * or if the connection drops / {@link quit} is called before the reply. The
   * `label` tag is added here — the caller supplies a plain {@link Message}.
   *
   * Requires the `labeled-response` capability; rejects immediately otherwise.
   */
  sendLabeled(message: Message, options: { timeoutMs?: number } = {}): Promise<Message[]> {
    if (!this.enabledCaps.has("labeled-response")) {
      return Promise.reject(
        new Error("sendLabeled: the 'labeled-response' capability is not enabled"),
      );
    }
    if (this.#queue === null) {
      return Promise.reject(new Error("sendLabeled: not connected"));
    }
    const label = `ml${++this.#labelCounter}`;
    const timeoutMs = options.timeoutMs ?? 30000;

    return new Promise<Message[]>((resolve, reject) => {
      const collected: Message[] = [];
      const batchRefs = new Set<string>(); // the labeled batch + any nested ones
      let topRef: string | null = null;
      let settled = false;

      const sub = new Subscription();
      const finish = (run: () => void): void => {
        if (settled) return;
        settled = true;
        sub.unsubscribe();
        run();
      };

      const timer = setTimeout(
        () => finish(() => reject(new Error(`sendLabeled: timed out after ${timeoutMs}ms`))),
        timeoutMs,
      );
      sub.add(() => clearTimeout(timer));

      sub.add(
        this.#lifecycle
          .pipe(
            filter((e) => e.type === "disconnected"),
            take(1),
            takeUntil(this.#teardown),
          )
          .subscribe((e) => {
            finish(() =>
              reject(
                new Error(
                  e.local
                    ? "sendLabeled: connection closed before response"
                    : "sendLabeled: connection dropped before response",
                ),
              ),
            );
          }),
      );

      sub.add(
        this.#messages.pipe(takeUntil(this.#teardown)).subscribe({
          next: (m) => {
            const token = m.params[0];
            if (topRef === null) {
              // Awaiting the one labeled reply: an ACK, a batch open, or a single
              // message. Correlation is by the `label` tag on this outer message.
              if (m.tags["label"] !== label) return;
              if (m.command === "ACK") {
                finish(() => resolve([]));
                return;
              }
              if (m.command === "BATCH" && token !== undefined && token[0] === "+") {
                topRef = token.slice(1);
                batchRefs.add(topRef);
                return;
              }
              finish(() => resolve([m]));
              return;
            }
            // Inside the labeled batch: collect by `batch` tag until it closes.
            if (m.command === "BATCH" && token === `-${topRef}`) {
              finish(() => resolve(collected));
              return;
            }
            const ref = m.tags["batch"];
            if (ref === undefined || !batchRefs.has(ref)) return;
            // Bound collection: a hostile server could stream `@batch=<ref>` lines
            // (and nested batch opens) forever without closing, growing this
            // buffer until the timeout. Settle as a failure past the caps.
            if (collected.length >= MAX_LABELED_MESSAGES || batchRefs.size > MAX_LABELED_BATCHES) {
              finish(() =>
                reject(new Error("sendLabeled: labeled response exceeded the size limit")),
              );
              return;
            }
            collected.push(m);
            // A nested batch: track its ref so its content is collected too.
            if (m.command === "BATCH" && token !== undefined && token[0] === "+") {
              batchRefs.add(token.slice(1));
            }
          },
          error: () =>
            finish(() => reject(new Error("sendLabeled: connection error before response"))),
          complete: () =>
            finish(() => reject(new Error("sendLabeled: connection closed before response"))),
        }),
      );

      // `send` validates and can throw (CR/LF/NUL or over-limit). Route that
      // failure through `finish` so the timer + subscriptions are torn down
      // immediately rather than dangling until the timeout.
      try {
        this.send({ ...message, tags: { ...message.tags, label } });
      } catch (error) {
        finish(() => reject(error instanceof Error ? error : new Error(String(error))));
      }
    });
  }

  /**
   * Request message history via the `chathistory` extension, e.g.
   * `chatHistory("LATEST", "#chan", "*", "50")`. Built on {@link sendLabeled}, so
   * it resolves with the history batch's messages and requires `labeled-response`.
   */
  chatHistory(subcommand: string, ...args: string[]): Promise<Message[]> {
    return this.sendLabeled(rawCommand("CHATHISTORY", subcommand, ...args));
  }

  #emit(event: LifecycleEvent): void {
    this.#lifecycle.next(event);
  }

  /**
   * Apply a post-registration `CAP` message (the `cap-notify` extension). During
   * registration `#capabilities` is still null and `registration.ts` owns the
   * `CAP` exchange, so this no-ops until the connection's caps are established.
   *
   * `NEW` records newly-advertised caps and requests any we want that aren't yet
   * enabled; `DEL` drops caps (also disabling them — closing the stale-`enabledCaps`
   * window for guards like {@link sendLabeled}); `ACK` enables what we requested
   * after a `NEW`. Each change mirrors onto `server.caps` and emits a `CapEvent`.
   */
  #handleCapNotify(message: Message): void {
    const caps = this.#capabilities;
    if (caps === null) return; // registration in progress — not our concern yet
    const parsed = parseCapMessage(message);
    if (parsed === null) return;

    switch (parsed.subcommand) {
      case "NEW": {
        caps.addAvailable(parsed.tokens);
        // Request only the caps announced in THIS NEW that we want and don't yet
        // have — never the whole desired-but-unenabled backlog (which would
        // re-request caps the server already NAKed and could overflow the line
        // limit). Chunk to stay under it, mirroring the registration handshake.
        const want = this.#wantedFromTokens(parsed.tokens);
        for (const chunk of chunkCaps(want)) this.#queue?.sendImmediate(capReq(chunk));
        break;
      }
      case "DEL":
        caps.removeAvailable(parsed.tokens);
        break;
      case "ACK":
        caps.applyAck(parsed.tokens);
        break;
      default:
        return; // LS / LIST / NAK after registration: nothing to apply
    }

    this.#store?.server.setCaps(caps.enabled);
    this.#events.next(
      capEvent(message, {
        subcommand: parsed.subcommand,
        caps: parsed.tokens.map((token) => token.name),
        enabled: caps.enabled,
      }),
    );
  }

  /**
   * From the caps a single `CAP NEW` announced, the subset we want and don't yet
   * have enabled — i.e. what to `CAP REQ` in response. Scoped to this NEW's
   * tokens (not the whole desired set) so we never re-request caps the server
   * already refused. `sasl` is excluded: re-running SASL mid-session is out of
   * scope.
   *
   * Dependencies are then resolved against what's advertised, but only for the
   * caps this NEW announced — so e.g. a `CAP NEW :labeled-response` also pulls in
   * `batch` (its dependency) if advertised, exactly like the registration path,
   * without dragging in the unrelated desired-but-refused backlog. Bounded by the
   * announced set plus its dependencies; the caller chunks the result.
   */
  #wantedFromTokens(tokens: readonly { name: string; disabled: boolean }[]): string[] {
    const caps = this.#capabilities;
    if (caps === null) return [];
    const desired = this.#options.caps;
    const announced: string[] = [];
    for (const token of tokens) {
      if (token.disabled || token.name === "sasl") continue;
      if (caps.isEnabled(token.name)) continue;
      if (desired === "all" || desired.includes(token.name)) announced.push(token.name);
    }
    if (announced.length === 0) return [];
    return reconcileCaps(announced, caps.available, false).filter((cap) => !caps.isEnabled(cap));
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
      // SASL: when credentials are configured, `register` keeps the `sasl` cap in
      // the requested set and runs the AUTHENTICATE exchange before CAP END.
      sasl: options.sasl,
      timeoutMs: options.registrationTimeoutMs,
    };
  }

  /**
   * Active keepalive for one connection attempt. After `pingIntervalMs` of inbound
   * silence it sends a `PING`; if no inbound traffic (the `PONG`, or anything)
   * arrives within `pingTimeoutMs`, the connection is half-open (TCP wedged with
   * no FIN/RST, so `bytes$` never errors) and we fail the attempt so
   * `retryWithBackoff` reconnects. Any inbound message resets the idle countdown.
   * Returns `Subscription.EMPTY` when keepalive is disabled — i.e. when either
   * `pingIntervalMs` or `pingTimeoutMs` is non-finite or `<= 0`. The returned
   * subscription is owned by the attempt's teardown.
   */
  #startKeepalive(
    messages$: Observable<Message>,
    queue: OutboundQueue,
    failAttempt: (error: Error) => void,
  ): Subscription {
    const { pingIntervalMs, pingTimeoutMs } = this.#options;
    // Disabled unless BOTH knobs are finite and positive: a non-positive or
    // `Infinity` pingTimeoutMs would otherwise collapse the response window to a
    // near-instant false drop (e.g. `timer(Infinity)` overflows to ~1ms).
    if (!Number.isFinite(pingIntervalMs) || pingIntervalMs <= 0) return Subscription.EMPTY;
    if (!Number.isFinite(pingTimeoutMs) || pingTimeoutMs <= 0) return Subscription.EMPTY;
    const scheduler = this.#internals.scheduler;
    let pings = 0;
    return messages$
      .pipe(
        startWith(undefined), // begin the idle countdown without waiting for the first message
        switchMap(() =>
          // Reset on every inbound message; after pingIntervalMs of silence, ping…
          timer(pingIntervalMs, scheduler).pipe(
            tap(() => queue.sendImmediate(ping(`ka${++pings}`))),
            // …then open the response window. A message arriving cancels this via
            // the outer switchMap; if it elapses first, the connection is dead.
            mergeMap(() => timer(pingTimeoutMs, scheduler)),
          ),
        ),
      )
      .subscribe({
        // Response window elapsed with no inbound traffic → half-open → reconnect.
        next: () => failAttempt(new Error("keepalive: no response within ping timeout")),
        // A keepalive write throwing (e.g. a transport whose write() fails) must
        // also be treated as an abnormal drop, not escape unhandled.
        error: (err: unknown) =>
          failAttempt(err instanceof Error ? err : new Error(`keepalive write failed: ${String(err)}`)),
      });
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
      // Every attempt (including a reconnect after an abnormal drop) is back in
      // the connecting phase: keep the public `state` honest rather than leaving
      // it on a stale "registered" while there is no usable connection.
      this.#state = "connecting";
      this.#emit({ type: "connecting", attempt });

      const messages$ = createMessageStream(transport, {
        backend: this.#options.backend,
        onParseError: this.#internals.onParseError ?? defaultParseErrorHandler,
      });
      const sub = new Subscription();
      let settled = false;
      let queue: OutboundQueue | null = null;

      // Fresh state per attempt: a reconnect starts from a clean slate (the
      // server resends 005/NAMES/etc. on re-registration). Clear the caps too so
      // `enabledCaps` never reports the *previous* connection's caps during the
      // reconnect window (before the new CAP negotiation completes) — otherwise
      // e.g. `sendLabeled`'s cap guard could pass against stale state.
      const store = new StateStore(this.#options.nick);
      const dispatcher = new Dispatcher(store);
      this.#store = store;
      this.#capabilities = null;

      const failAttempt = (err: unknown): void => {
        if (settled) return;
        settled = true;
        // No longer registered: drop out of "registered" immediately. If a retry
        // follows, the next attempt re-enters "connecting"; if this is terminal,
        // connect()'s error handler sets "closed". Either way `state` isn't stale.
        if (this.#state === "registered") this.#state = "connecting";
        const error = err instanceof Error ? err : new Error(String(err));
        this.#emit({ type: "disconnected", local: false, error });
        subscriber.error(error);
      };
      const completeAttempt = (): void => {
        if (settled) return;
        settled = true;
        subscriber.complete();
      };

      // Pump the per-attempt pipeline into the stable public streams; its
      // completion/error drives this attempt (and thus the retry decision).
      // The dispatcher mutates `store` and emits entity-resolved events; a fault
      // there must never tear down the connection (the raw message still flows
      // on messages$), so dispatch is guarded.
      sub.add(
        messages$.subscribe({
          next: (message) => {
            this.#messages.next(message);
            // Isolate dispatch faults (a client-internal bug must not drop the
            // connection) but surface them; consumer errors on events$ are not
            // swallowed — only the dispatch call is guarded.
            let event: IrcEvent | null = null;
            try {
              event = dispatcher.dispatch(message);
            } catch (error) {
              (this.#internals.onDispatchError ?? defaultDispatchErrorHandler)(error, message);
            }
            if (event !== null) {
              // Keep the public `nick` getter in sync when the server confirms a
              // change to *our* nick (it is otherwise only set at registration).
              if (event.type === "nick" && event.isSelf) this.#nick = event.newNick;
              this.#events.next(event);
            }
          },
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
            maxQueueDepth: this.#options.maxQueueDepth,
          });
          this.#queue = queue;
          this.#emit({ type: "connected", attempt });
          sub.add(this.#startKeepalive(messages$, queue, failAttempt));

          const result = await register(
            { messages$, send: (message) => queue?.sendImmediate(message) },
            this.#registrationOptions(),
          );
          if (settled) return;
          this.#nick = result.nick;
          this.#capabilities = result.capabilities;
          store.server.setCaps(result.capabilities.enabled);
          // A successful SASL login tells us our own services account up-front
          // (before any account-tag/account-notify traffic).
          if (result.account !== null) {
            store.getOrCreateUser(result.nick).setAccount(result.account);
          }
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
        // Complete this attempt's entity streams so subscribers to stale entity
        // refs get completion (not a hang) after a drop/reconnect/quit.
        store.disposeAll();
        // Only clear shared slots if they still belong to this attempt (a newer
        // attempt may already have replaced them).
        if (this.#queue === queue) this.#queue = null;
        if (this.#transport === transport) this.#transport = null;
        // Clear the negotiated caps on teardown too (drop/reconnect/quit), not
        // just at the next attempt's start — otherwise `enabledCaps` reports the
        // dead connection's caps during the backoff gap before the retry fires.
        if (this.#store === store) this.#capabilities = null;
        transport.close();
      };
    });
  }
}
