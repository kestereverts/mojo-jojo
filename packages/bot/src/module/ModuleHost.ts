import { Subject, Subscription } from "rxjs";
import type { CaseMapper, ClientEvent, IrcClient } from "@mojo-jojo/irc-client";
import type { Cooldowns } from "../abuse/cooldown.ts";
import type { IgnoreList } from "../abuse/ignore.ts";
import type { Command } from "../command/types.ts";
import type { Logger } from "../logging/logger.ts";
import { MemoryStorage, type ModuleStorage } from "./storage.ts";
import type { BotApi, Disposer, Module, ModuleContext } from "./types.ts";

/** Shared dependencies the bot passes to each module host. */
export interface ModuleHostDeps {
  readonly client: IrcClient;
  /** Logger already scoped to the module (e.g. `bot:ping`). */
  readonly log: Logger;
  readonly bot: BotApi;
  readonly cooldowns: Cooldowns;
  readonly ignore: IgnoreList;
  /** Live casemapping lookup (`null` before registration / between connections). */
  readonly caseMapper: () => CaseMapper | null;
  /** Register a command on behalf of this module; returns an unregister. */
  readonly registerCommand: (command: Command, module: string) => Disposer;
  /** Storage for this module; defaults to a fresh in-memory store. */
  readonly storage?: ModuleStorage;
}

/**
 * Owns one module's lifecycle: builds its {@link ModuleContext}, runs `setup`, and
 * tears everything down on {@link dispose}. Every subscription registered through
 * the context (`track`/`on`) plus `onCleanup` callbacks and the `setup` return
 * disposer are tracked; a faulting disposer is isolated, never thrown.
 */
export class ModuleHost<C = unknown> {
  readonly module: Module<C>;
  readonly #config: C;
  readonly #deps: ModuleHostDeps;
  readonly #storage: ModuleStorage;

  readonly #destroyed$ = new Subject<void>();
  readonly #subscriptions = new Subscription();
  readonly #cleanups: Disposer[] = [];
  #setupDisposer: Disposer | void = undefined;
  #disposed = false;

  constructor(module: Module<C>, config: C, deps: ModuleHostDeps) {
    this.module = module;
    this.#config = config;
    this.#deps = deps;
    this.#storage = deps.storage ?? new MemoryStorage();
  }

  /**
   * Run the module's `setup`, capturing any returned disposer. If `setup` throws
   * after partially wiring subscriptions/cleanups, the host self-disposes (so no
   * leaked subscription survives a failed module) before re-throwing for the caller.
   */
  async setup(): Promise<void> {
    try {
      this.#setupDisposer = await this.module.setup(this.#buildContext());
    } catch (error) {
      await this.dispose();
      throw error;
    }
  }

  #buildContext(): ModuleContext<C> {
    const client = this.#deps.client;
    const log = this.#deps.log;
    return {
      client,
      log,
      config: this.#config,
      bot: this.#deps.bot,
      events$: client.events$,
      clientEvents$: client.clientEvents$,
      lifecycle$: client.lifecycle$,
      messages$: client.messages$,
      destroyed$: this.#destroyed$.asObservable(),
      command: (command) => {
        const unregister = this.#deps.registerCommand(command, this.module.name);
        this.#subscriptions.add(() => unregister());
      },
      track: (sub) => {
        this.#subscriptions.add(sub);
        return sub;
      },
      on: <T extends ClientEvent["type"]>(
        type: T,
        handler: (event: Extract<ClientEvent, { type: T }>) => void,
      ): void => {
        const sub = client.clientEvents$.subscribe((event) => {
          if (event.type !== type) return;
          try {
            handler(event as Extract<ClientEvent, { type: T }>);
          } catch (error) {
            log.error(`"${type}" handler threw`, error);
          }
        });
        this.#subscriptions.add(sub);
      },
      cooldown: (key, ms) => this.#deps.cooldowns.check(`${this.module.name}:${key}`, ms),
      isIgnored: (event) => this.#deps.ignore.has(event, this.#deps.caseMapper()),
      storage: this.#storage,
      onCleanup: (fn) => {
        this.#cleanups.push(fn);
      },
    };
  }

  /**
   * Tear the module down: complete `destroyed$`, unsubscribe tracked subscriptions,
   * then run the `setup` disposer followed by `onCleanup` callbacks in reverse order.
   * Idempotent; each disposer is individually isolated.
   */
  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#destroyed$.next();
    this.#destroyed$.complete();
    this.#subscriptions.unsubscribe();
    await this.#runDisposer(this.#setupDisposer);
    for (let i = this.#cleanups.length - 1; i >= 0; i--) {
      await this.#runDisposer(this.#cleanups[i]);
    }
  }

  async #runDisposer(disposer: Disposer | void): Promise<void> {
    if (typeof disposer !== "function") return;
    try {
      await disposer();
    } catch (error) {
      this.#deps.log.error("disposer threw", error);
    }
  }
}
