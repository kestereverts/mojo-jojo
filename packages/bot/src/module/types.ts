import type { Observable, Unsubscribable } from "rxjs";
import type {
  ClientEvent,
  IrcClient,
  IrcEvent,
  LifecycleEvent,
  Message,
  PrivmsgEvent,
} from "@mojo-jojo/irc-client";
import type { Command } from "../command/types.ts";
import type { Logger } from "../logging/logger.ts";
import type { ModuleStorage } from "./storage.ts";

/** A cleanup callback; may be async. Run on module disposal. */
export type Disposer = () => void | Promise<void>;
export type MaybePromise<T> = T | Promise<T>;

/** Bot-level surface exposed to modules. */
export interface BotApi {
  readonly prefix: string;
  readonly owners: readonly string[];
  /** Request a graceful shutdown (e.g. an `!quit` command). */
  requestStop(reason?: string): void;
  /** All registered commands across modules (for `help`). */
  listCommands(): readonly Command[];
  /** Is this PRIVMSG sender a configured bot owner? */
  isOwner(event: PrivmsgEvent): boolean;
}

/**
 * Everything a module receives in {@link Module.setup}. RxJS-first: subscribe the
 * stream getters (bound for teardown with `takeUntil(ctx.destroyed$)` and/or
 * {@link track}); `on` is a thin callback façade over `clientEvents$`.
 */
export interface ModuleContext<C> {
  readonly client: IrcClient;
  readonly log: Logger;
  readonly config: C;
  readonly bot: BotApi;

  /** Entity-resolved protocol events (`client.events$`). */
  readonly events$: Observable<IrcEvent>;
  /** Protocol + lifecycle events merged (`client.clientEvents$`). */
  readonly clientEvents$: Observable<ClientEvent>;
  /** Connection lifecycle events (`client.lifecycle$`). */
  readonly lifecycle$: Observable<LifecycleEvent>;
  /** Raw parsed messages (`client.messages$`) — the escape hatch for numerics/LIST/WHOIS detail. */
  readonly messages$: Observable<Message>;
  /** Completes when the module is disposed; use with `takeUntil(ctx.destroyed$)`. */
  readonly destroyed$: Observable<void>;

  /** Register a chat command (auto-removed on module disposal). */
  command(command: Command): void;
  /** Track a subscription so it is torn down on disposal; returns it for chaining. */
  track<T extends Unsubscribable>(sub: T): T;
  /** Callback façade over `clientEvents$`, auto-tracked and error-isolated. */
  on<T extends ClientEvent["type"]>(
    type: T,
    handler: (event: Extract<ClientEvent, { type: T }>) => void,
  ): void;

  /** Per-key cooldown (namespaced to this module). `true` = allowed + armed; `false` = cooling. */
  cooldown(key: string, ms: number): boolean;
  /** Is this sender on the bot-level ignore list? */
  isIgnored(event: PrivmsgEvent): boolean;

  /** Namespaced key/value storage (in-memory in v1). */
  readonly storage: ModuleStorage;
  /** Register an arbitrary cleanup callback (run in reverse order on disposal). */
  onCleanup(fn: Disposer): void;
}

/**
 * A bot plugin. Produced by a {@link ModuleFactory} (no shared singleton state across
 * bot instances). `parseConfig` validates + narrows the raw `[modules.<name>]` slice;
 * `setup` wires behaviour and may return a {@link Disposer}.
 */
export interface Module<C = Record<string, never>> {
  /** Stable, non-empty, unique identifier; also the `[modules.<name>]` config key. */
  readonly name: string;
  readonly description?: string;
  parseConfig?(raw: Record<string, unknown>): C;
  setup(ctx: ModuleContext<C>): MaybePromise<Disposer | void>;
}

// `any` (not `unknown`) is deliberate: a factory for a specific config — `() => Module<C>`
// — must be assignable to the stored `ModuleFactory` type, which `unknown` would block.
export type ModuleFactory<C = any> = () => Module<C>;

/** Identity helper that pins the config generic for inference. */
export function defineModule<C>(mod: Module<C>): Module<C> {
  return mod;
}

/** Runtime conformance check for a dynamically-imported module (types are erased). */
export function isModule(value: unknown): value is Module<unknown> {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { name?: unknown; setup?: unknown };
  return (
    typeof candidate.name === "string" &&
    candidate.name.length > 0 &&
    typeof candidate.setup === "function"
  );
}
