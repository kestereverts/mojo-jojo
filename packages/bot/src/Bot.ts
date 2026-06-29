import { Subscription, type Observable } from "rxjs";
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
import { ModuleRegistry } from "./module/registry.ts";
import { loadExternalModule } from "./module/loadExternal.ts";
import { ModuleHost, type ModuleHostDeps } from "./module/ModuleHost.ts";
import type { BotApi, Module } from "./module/types.ts";
import { builtinModules } from "./modules/index.ts";

/** Injectable dependencies (test seams). */
export interface BotDeps {
  readonly logger?: Logger;
  readonly transport?: TransportFactory;
  readonly registry?: ModuleRegistry;
  /** Install SIGINT/SIGTERM → stop() (default true; pass false in tests). */
  readonly registerSignalHandlers?: boolean;
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/**
 * The bot runtime: one {@link IrcClient} plus a set of modules loaded from config.
 *
 * Modules are set up once (before connect) and persist across reconnects, since the
 * client's event streams are reconnect-stable — per-connection work must hang off the
 * `registered` lifecycle event. M2 ships load/connect/teardown + the {@link BotEvent}
 * surface; the command framework and graceful-shutdown polish land in M3/M4.
 */
export class Bot {
  readonly #config: BotConfig;
  readonly #client: IrcClient;
  readonly #log: Logger;
  readonly #events: BotEventHub;
  readonly #registry: ModuleRegistry;
  readonly #cooldowns = new Cooldowns();
  readonly #ignore: IgnoreList;
  readonly #hosts: ModuleHost[] = [];
  readonly #lifecycleSub = new Subscription();
  readonly #botApi: BotApi;
  readonly #registerSignals: boolean;
  #removeSignals: (() => void) | null = null;
  #starting: Promise<void> | null = null;
  #stopping: Promise<void> | null = null;

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
    this.#botApi = {
      prefix: config.bot.prefix,
      owners: config.bot.owners,
      requestStop: (reason) => {
        void this.stop(reason);
      },
    };
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

  /** Load modules, connect, and register. Resolves once registered; rejects on terminal failure. */
  start(): Promise<void> {
    if (this.#starting) return this.#starting;
    this.#starting = this.#doStart();
    return this.#starting;
  }

  /** Dispose modules and quit. Idempotent; awaits an in-flight {@link start}. */
  stop(reason = "Shutting down"): Promise<void> {
    if (this.#stopping) return this.#stopping;
    this.#stopping = this.#doStop(reason);
    return this.#stopping;
  }

  async #doStart(): Promise<void> {
    this.#lifecycleSub.add(this.#client.lifecycle$.subscribe((event) => this.#logLifecycle(event)));
    await this.#loadModules();
    if (this.#registerSignals) this.#installSignals();
    await this.#client.connect();
    this.#events.emit({ type: "started" });
  }

  async #loadModules(): Promise<void> {
    // External modules first; an import/conformance failure is fail-fast (wiring error).
    // Listing a module in `externalModules` registers AND enables it (its
    // `[modules.<name>]` table, if any, supplies options or an `enabled = false` override).
    const externalNames = new Set<string>();
    for (const specifier of this.#config.externalModules) {
      const mod = await loadExternalModule(specifier, this.#config.configDir);
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
      cooldowns: this.#cooldowns,
      ignore: this.#ignore,
      caseMapper: () => this.#client.server?.caseMapper ?? null,
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
      // Don't let a SIGINT mid-startup leave a half-initialized host set.
      try {
        await this.#starting;
      } catch {
        // start failed; continue with teardown regardless.
      }
    }
    this.#removeSignals?.();
    this.#removeSignals = null;
    for (let i = this.#hosts.length - 1; i >= 0; i--) {
      try {
        await this.#hosts[i]!.dispose();
      } catch (error) {
        this.#log.error("module dispose failed", error);
      }
    }
    this.#lifecycleSub.unsubscribe();
    this.#client.quit(reason);
    this.#events.emit({ type: "stopped", reason });
    this.#events.complete();
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
