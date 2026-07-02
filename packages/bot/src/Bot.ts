import { Subscription, catchError, filter, firstValueFrom, of, take, timeout, type Observable } from "rxjs";
import { IrcClient } from "@mojo-jojo/irc-client";
import type { LifecycleEvent, TransportFactory } from "@mojo-jojo/irc-client";
import type { BotConfig } from "./config/schema.ts";
import { toIrcClientOptions } from "./config/toIrcClientOptions.ts";
import { ConsoleLogger, type Logger } from "./logging/logger.ts";
import {
  BotEventHub,
  type BotEvent,
  type BotEventListener,
  type ModulePhase,
  type Unsubscribe,
} from "./events/botEvents.ts";
import { Cooldowns } from "./abuse/cooldown.ts";
import { IgnoreList } from "./abuse/ignore.ts";
import { CommandRouter } from "./command/CommandRouter.ts";
import { matchOwner } from "./command/permissions.ts";
import { isSecureMatcher } from "./identity/match.ts";
import { RateLimiter } from "./abuse/rateLimiter.ts";
import { ModuleRegistry } from "./module/registry.ts";
import { loadExternalModule } from "./module/loadExternal.ts";
import { ModuleHost, type ModuleHostDeps } from "./module/ModuleHost.ts";
import type { BotApi, Module } from "./module/types.ts";
import { builtinModules } from "./modules/index.ts";
import { asError } from "./util/errors.ts";

/** Injectable dependencies (test seams). */
export interface BotDeps {
  readonly logger?: Logger;
  readonly transport?: TransportFactory;
  readonly registry?: ModuleRegistry;
  /** Install SIGINT/SIGTERM → stop() (default true; pass false in tests). */
  readonly registerSignalHandlers?: boolean;
  /** Post-QUIT flush window in ms, letting the socket flush before stop() resolves (default 250; 0 in tests). */
  readonly quitFlushMs?: number;
}

const DEFAULT_QUIT_FLUSH_MS = 250;
const QUIT_WAIT_MS = 2000;

/**
 * The bot runtime: one {@link IrcClient} plus a set of modules loaded from config.
 *
 * Modules are set up once (before connect) and persist across reconnects, since the
 * client's event streams are reconnect-stable — per-connection work must hang off the
 * `registered` lifecycle event.
 *
 * Scope: a Bot drives exactly ONE network (one {@link IrcClient}). For multiple
 * networks, run multiple Bots (optionally sharing a {@link ModuleRegistry}); do not
 * multiplex one Bot across connections.
 */
export class Bot {
  readonly #config: BotConfig;
  readonly #client: IrcClient;
  readonly #log: Logger;
  readonly #events: BotEventHub;
  readonly #registry: ModuleRegistry;
  readonly #cooldowns = new Cooldowns();
  // Modules get their OWN cooldown table, separate from the router's, so a
  // module's `ctx.cooldown` keys (`<name>:<key>`) can never collide with the
  // router's `cmd:`/`cmdctx:`/`log:` keys, and a module flood can't evict the
  // router's cooldowns (or vice versa).
  readonly #moduleCooldowns = new Cooldowns();
  readonly #ignore: IgnoreList;
  readonly #router: CommandRouter;
  readonly #hosts: ModuleHost[] = [];
  readonly #lifecycleSub = new Subscription();
  readonly #botApi: BotApi;
  readonly #registerSignals: boolean;
  readonly #quitFlushMs: number;
  #removeSignals: (() => void) | null = null;
  #starting: Promise<void> | null = null;
  #stopping: Promise<void> | null = null;
  #torndown = false;

  constructor(config: BotConfig, deps: BotDeps = {}) {
    this.#config = config;
    this.#log = deps.logger ?? new ConsoleLogger({ level: config.bot.logLevel, scope: "bot" });
    this.#events = new BotEventHub((error) => this.#log.error("event listener threw", error));
    this.#client = new IrcClient(
      toIrcClientOptions(config.server, deps.transport ? { transport: deps.transport } : {}),
    );
    this.#registry = deps.registry ?? new ModuleRegistry(builtinModules);
    this.#ignore = new IgnoreList(config.bot.ignore);
    this.#registerSignals = deps.registerSignalHandlers ?? true;
    this.#quitFlushMs = deps.quitFlushMs ?? DEFAULT_QUIT_FLUSH_MS;
    this.#botApi = {
      prefix: config.bot.prefix,
      owners: config.bot.owners,
      requestStop: (reason) => {
        void this.stop(reason);
      },
      listCommands: () => this.#router.list(),
      isOwner: (event) => matchOwner(event, config.bot.owners, this.#client.server?.caseMapper ?? null),
    };
    this.#router = new CommandRouter({
      client: this.#client,
      bot: this.#botApi,
      log: this.#log,
      events: this.#events,
      cooldowns: this.#cooldowns,
      ignore: this.#ignore,
      rateLimiter:
        config.bot.commandRefillMs > 0
          ? new RateLimiter({ capacity: config.bot.commandBurst, refillMs: config.bot.commandRefillMs })
          : null,
      prefix: config.bot.prefix,
      allowPrefixlessInPm: config.bot.allowPrefixlessInPm,
    });
  }

  /** The underlying IRC client (for inspection / direct stream access). */
  get client(): IrcClient {
    return this.#client;
  }

  /** Framework-domain events (module load, command dispatch, lifecycle). */
  get events$(): Observable<BotEvent> {
    return this.#events.events$;
  }

  on<T extends BotEvent["type"]>(type: T, handler: BotEventListener<T>): Unsubscribe {
    return this.#events.on(type, handler);
  }
  once<T extends BotEvent["type"]>(type: T, handler: BotEventListener<T>): Unsubscribe {
    return this.#events.once(type, handler);
  }
  off<T extends BotEvent["type"]>(type: T, handler: BotEventListener<T>): void {
    this.#events.off(type, handler);
  }

  /**
   * Load modules, connect, and register. Resolves once registered; rejects on terminal
   * failure (and self-cleans). **Single-use:** a second call — or any call after
   * {@link stop} — rejects. Construct a new `Bot` to reconnect.
   */
  start(): Promise<void> {
    if (this.#torndown) {
      return Promise.reject(new Error("Bot.start: the bot has already been stopped (single-use)"));
    }
    if (this.#starting) {
      return Promise.reject(new Error("Bot.start: already started (single-use)"));
    }
    this.#starting = this.#doStart();
    return this.#starting;
  }

  /**
   * Dispose modules and quit. Idempotent. Awaits an in-flight {@link start} first (so a
   * stop mid-startup can't race a half-initialized host set) — which means a stop during
   * the initial connect only takes effect once `connect()` settles (bounded by
   * `connectTimeoutMs`), and a module whose `setup()` blocks indefinitely will delay it.
   * Module `setup` must not block.
   */
  stop(reason = "Shutting down"): Promise<void> {
    if (this.#stopping) return this.#stopping;
    this.#stopping = this.#doStop(reason);
    return this.#stopping;
  }

  async #doStart(): Promise<void> {
    try {
      for (const owner of this.#config.bot.owners) {
        if (!isSecureMatcher(owner)) {
          this.#log.warn(
            `owner "${owner}" uses insecure nick matching — an attacker who takes this nick ` +
              `while the owner is offline gains owner access; prefer account: or mask:`,
          );
        }
      }
      this.#lifecycleSub.add(this.#client.lifecycle$.subscribe((event) => this.#logLifecycle(event)));
      this.#router.start();
      await this.#loadModules();
      if (this.#registerSignals) this.#installSignals();
      await this.#client.connect();
      this.#events.emit({ type: "started" });
    } catch (error) {
      // Self-clean a failed startup so the caller doesn't have to.
      await this.#teardown("startup failed");
      throw error;
    }
  }

  async #loadModules(): Promise<void> {
    // External modules first; an import/conformance failure is fail-fast (wiring error).
    // Listing a module in `externalModules` registers AND enables it (its
    // `[modules.<name>]` table, if any, supplies options or an `enabled = false` override).
    const externalNames = new Set<string>();
    // Import independent modules concurrently (each is disk I/O + transpile), then
    // register in the configured order so registration stays deterministic and
    // fail-fast. Promise.all rejects on the first failure, preserving fail-fast.
    const loaded = await Promise.all(
      this.#config.externalModules.map((specifier) =>
        loadExternalModule(specifier, this.#config.configDir),
      ),
    );
    for (const mod of loaded) {
      this.#registry.register(mod.name, () => mod);
      externalNames.add(mod.name);
    }

    // Build the load set: auto-enabled externals + enabled built-in/[modules.*] entries.
    const toLoad = new Map<string, Record<string, unknown>>();
    for (const name of externalNames) {
      const entry = this.#config.modules[name];
      if (entry && !entry.enabled) continue; // explicit `enabled = false` disables it
      toLoad.set(name, entry?.options ?? {});
    }
    for (const [name, entry] of Object.entries(this.#config.modules)) {
      if (!entry.enabled || externalNames.has(name)) continue;
      toLoad.set(name, entry.options);
    }

    for (const [name, options] of toLoad) {
      await this.#loadModule(name, options);
    }
  }

  async #loadModule(name: string, options: Record<string, unknown>): Promise<void> {
    const factory = this.#registry.get(name);
    if (!factory) {
      this.#failModule(
        name,
        "config",
        new Error(`unknown module "${name}" (no built-in or external module registered)`),
      );
      return;
    }
    let module: Module<unknown>;
    let config: unknown;
    try {
      module = factory();
      config = module.parseConfig ? module.parseConfig(options) : {};
    } catch (error) {
      this.#failModule(name, "config", error);
      return;
    }
    const host = new ModuleHost(module, config, this.#hostDeps(name));
    try {
      await host.setup();
    } catch (error) {
      this.#failModule(name, "setup", error);
      return;
    }
    this.#hosts.push(host);
    this.#events.emit({ type: "moduleLoaded", name });
  }

  #hostDeps(name: string): ModuleHostDeps {
    return {
      client: this.#client,
      log: this.#log.child(name),
      bot: this.#botApi,
      cooldowns: this.#moduleCooldowns,
      ignore: this.#ignore,
      caseMapper: () => this.#client.server?.caseMapper ?? null,
      registerCommand: (command, module) => this.#router.add(command, module),
      onDisposeError: (error) =>
        this.#events.emit({ type: "moduleError", name, phase: "dispose", error: asError(error) }),
    };
  }

  #failModule(name: string, phase: ModulePhase, cause: unknown): void {
    const error = asError(cause);
    this.#events.emit({ type: "moduleError", name, phase, error });
    this.#log.error(`module "${name}" failed during ${phase}`, error);
    if (this.#config.bot.failOnModuleError) throw error;
  }

  async #doStop(reason: string): Promise<void> {
    if (this.#starting) {
      // Don't let a stop() mid-startup race a half-initialized host set.
      try {
        await this.#starting;
      } catch {
        // start failed (and self-cleaned); the teardown below is then a no-op.
      }
    }
    await this.#teardown(reason);
  }

  /** Dispose everything exactly once. Shared by stop() and start()'s self-clean path. */
  async #teardown(reason: string): Promise<void> {
    if (this.#torndown) return;
    this.#torndown = true;
    this.#removeSignals?.();
    this.#removeSignals = null;
    for (let i = this.#hosts.length - 1; i >= 0; i--) {
      try {
        await this.#hosts[i]!.dispose();
      } catch (error) {
        this.#log.error("module dispose failed", error);
      }
    }
    this.#router.dispose();
    // The QUIT path could fault (a transport write throwing); the bot-side cleanup
    // below must still run so streams complete and `stopped` fires exactly once.
    try {
      await this.#gracefulQuit(reason);
    } finally {
      this.#lifecycleSub.unsubscribe();
      this.#events.emit({ type: "stopped", reason });
      this.#events.complete();
    }
  }

  /**
   * Send QUIT and let it reach the wire before resolving. `IrcClient.quit` sends
   * QUIT via `sendImmediate` then closes the socket with `socket.end()` — a graceful
   * flush-then-FIN. We observe the local disconnect it emits (capped) and then yield
   * a brief flush window, so a caller that exits the process right after stop() does
   * not drop the QUIT (which would leave the server to ping-timeout us). Skipped when
   * the client was never live (no socket to flush).
   */
  async #gracefulQuit(reason: string): Promise<void> {
    const wasLive = this.#client.state === "registered" || this.#client.state === "connecting";
    // Subscribe before quit() so the synchronous local disconnect it emits is caught.
    // `defaultValue` guards an empty completion; `catchError` guards the timeout.
    const disconnected = wasLive
      ? firstValueFrom(
          this.#client.lifecycle$.pipe(
            filter((event) => event.type === "disconnected" && event.local),
            take(1),
            timeout({ first: QUIT_WAIT_MS }),
            catchError(() => of(null)),
          ),
          { defaultValue: null },
        )
      : null;
    try {
      this.#client.quit(reason);
    } catch (error) {
      this.#log.error("QUIT send failed during teardown", error);
      return;
    }
    if (!disconnected) return;
    await disconnected;
    if (this.#quitFlushMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, this.#quitFlushMs));
    }
  }

  #installSignals(): void {
    const handler = (): void => {
      void this.stop();
    };
    process.on("SIGINT", handler);
    process.on("SIGTERM", handler);
    this.#removeSignals = () => {
      process.off("SIGINT", handler);
      process.off("SIGTERM", handler);
    };
  }

  #logLifecycle(event: LifecycleEvent): void {
    switch (event.type) {
      case "connecting":
        this.#log.info(`connecting (attempt ${event.attempt})`);
        break;
      case "connected":
        this.#log.info("connected");
        break;
      case "registered":
        this.#log.info(`registered as ${event.nick}`);
        break;
      case "reconnecting":
        this.#log.warn(`reconnecting in ${event.delayMs}ms (attempt ${event.attempt})`);
        break;
      case "disconnected":
        if (event.local) this.#log.info("disconnected (local)");
        else this.#log.warn("disconnected", event.error ?? "");
        break;
      case "error":
        this.#log.error("client error", event.error);
        break;
    }
  }
}
