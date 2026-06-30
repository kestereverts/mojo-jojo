import { EMPTY, type Observable, Subject, catchError, defer, filter, finalize, mergeMap, takeUntil } from "rxjs";
import type { IrcClient, PrivmsgEvent } from "@mojo-jojo/irc-client";
import type { Cooldowns } from "../abuse/cooldown.ts";
import type { IgnoreList } from "../abuse/ignore.ts";
import type { BotEventHub } from "../events/botEvents.ts";
import type { Logger } from "../logging/logger.ts";
import type { BotApi, Disposer, MaybePromise } from "../module/types.ts";
import { senderKey } from "../identity/match.ts";
import { checkPermission } from "./permissions.ts";
import { parseCommandLine } from "./parse.ts";
import { replyTarget, safeNotice, safeSay } from "./reply.ts";
import type { Command, CommandContext } from "./types.ts";

const DEFAULT_CONCURRENCY = 8;
const DEFAULT_HANDLER_TIMEOUT_MS = 30_000;

export interface CommandRouterDeps {
  readonly client: IrcClient;
  readonly bot: BotApi;
  readonly log: Logger;
  readonly events: BotEventHub;
  readonly cooldowns: Cooldowns;
  readonly ignore: IgnoreList;
  readonly prefix: string;
  readonly allowPrefixlessInPm: boolean;
  /** Max concurrent handlers (blast-radius bound, not ordering). Default 8. */
  readonly concurrency?: number;
  /** Per-handler timeout that frees the concurrency slot. Default 30s. */
  readonly handlerTimeoutMs?: number;
}

interface CommandEntry {
  readonly command: Command;
  readonly module: string;
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/**
 * Owns the command table and the bot's single, bounded PRIVMSG pipeline.
 *
 * Handlers must be NON-BLOCKING: long work belongs in a tracked subscription, not
 * the dispatch path. Reply order is not request order regardless (the client's
 * outbound queue is FIFO by enqueue time); the concurrency bound is only a
 * blast-radius limit. A hung handler hits the per-handler timeout, which frees its
 * slot (it cannot abort the handler's work).
 */
export class CommandRouter {
  readonly #deps: CommandRouterDeps;
  readonly #byName = new Map<string, CommandEntry>();
  readonly #commands = new Set<Command>();
  readonly #destroyed$ = new Subject<void>();
  readonly #maxConcurrency: number;
  #inFlight = 0;
  #started = false;

  constructor(deps: CommandRouterDeps) {
    this.#deps = deps;
    this.#maxConcurrency = deps.concurrency ?? DEFAULT_CONCURRENCY;
  }

  /** Subscribe the PRIVMSG pipeline (idempotent). */
  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#deps.client.events$
      .pipe(
        filter((event): event is PrivmsgEvent => event.type === "privmsg"),
        filter((event) => !event.user.isSelf), // ignore our own echo-message
        // Unbounded mergeMap: #admit does the cheap parse/lookup/gating synchronously
        // and returns EMPTY for non-commands/denied/saturated, so nothing buffers.
        // Concurrent HANDLER execution is bounded by the explicit #inFlight admission.
        mergeMap((event) => this.#admit(event)),
        takeUntil(this.#destroyed$),
      )
      .subscribe();
  }

  /** Register a command (and its aliases). Throws on a duplicate name. Returns an unregister. */
  add(command: Command, module: string): Disposer {
    const names = [command.name, ...(command.aliases ?? [])].map((n) => n.toLowerCase());
    const seen = new Set<string>();
    for (const name of names) {
      if (name.length === 0 || /\s/.test(name)) {
        throw new Error(`CommandRouter: invalid command name "${name}" (module "${module}")`);
      }
      if (seen.has(name)) {
        throw new Error(
          `CommandRouter: command "${command.name}" lists "${name}" more than once (module "${module}")`,
        );
      }
      seen.add(name);
      const existing = this.#byName.get(name);
      if (existing) {
        throw new Error(
          `CommandRouter: duplicate command name "${name}" ` +
            `(module "${module}" conflicts with "${existing.module}")`,
        );
      }
    }
    const entry: CommandEntry = { command, module };
    for (const name of names) this.#byName.set(name, entry);
    this.#commands.add(command);
    return () => {
      for (const name of names) {
        if (this.#byName.get(name) === entry) this.#byName.delete(name);
      }
      this.#commands.delete(command);
    };
  }

  /** All registered commands (distinct, no alias duplicates). */
  list(): readonly Command[] {
    return [...this.#commands];
  }

  dispose(): void {
    this.#destroyed$.next();
    this.#destroyed$.complete();
    this.#byName.clear();
    this.#commands.clear();
  }

  /**
   * Cheap, synchronous resolution + gating (parse → lookup → ignore → permission).
   * Emits the relevant `commandDenied`/`commandError` and returns a runnable command
   * + context, or `null`. Runs OUTSIDE the concurrency bound so non-commands and
   * denials never consume a handler slot. The cooldown commit happens later in
   * `#admit` (after overload admission), so a dropped command keeps its cooldown.
   */
  #prepare(event: PrivmsgEvent): { command: Command; ctx: CommandContext; module: string } | null {
    const requirePrefix = !event.isPrivate || !this.#deps.allowPrefixlessInPm;
    const parsed = parseCommandLine(this.#deps.prefix, event.text, { requirePrefix });
    if (!parsed) return null;
    const entry = this.#byName.get(parsed.name);
    if (!entry) return null;
    const { command, module } = entry;
    const { events } = this.#deps;

    if (this.#deps.ignore.has(event, this.#deps.client.server?.caseMapper ?? null)) {
      events.emit({ type: "commandDenied", command: command.name, reason: "ignored", event });
      return null;
    }

    const ctx = this.#context(event, module, parsed.args, parsed.argLine);

    let allowed: boolean;
    try {
      allowed = checkPermission(command.permission ?? "anyone", ctx);
    } catch (error) {
      // A module-supplied permission predicate threw — surface it as a command error.
      events.emit({ type: "commandError", command: command.name, event, error: asError(error) });
      this.#deps.log.child(module).error(`permission check for "${command.name}" threw`, error);
      return null;
    }
    if (!allowed) {
      events.emit({ type: "commandDenied", command: command.name, reason: "permission", event });
      return null;
    }

    return { command, ctx, module };
  }

  /**
   * Admit a prepared command into the bounded handler section, or drop it when
   * saturated. Overload admission is checked BEFORE committing the cooldown, so a
   * dropped command never consumes the user's cooldown.
   */
  #admit(event: PrivmsgEvent): Observable<void> {
    const prepared = this.#prepare(event);
    if (!prepared) return EMPTY;
    const { command } = prepared;

    if (this.#inFlight >= this.#maxConcurrency) {
      this.#deps.events.emit({ type: "commandDenied", command: command.name, reason: "overloaded", event });
      this.#deps.log.warn(`dropped "${command.name}": ${this.#maxConcurrency} handlers already in flight`);
      return EMPTY;
    }

    if (command.cooldownMs && command.cooldownMs > 0) {
      const key = `cmd:${command.name}:${this.#userKey(event)}`;
      if (!this.#deps.cooldowns.check(key, command.cooldownMs)) {
        this.#deps.events.emit({ type: "commandDenied", command: command.name, reason: "cooldown", event });
        return EMPTY;
      }
    }

    this.#inFlight++;
    return defer(() => this.#run(prepared, event)).pipe(
      catchError((error) => {
        this.#deps.log.error("command dispatch faulted", error);
        return EMPTY;
      }),
      finalize(() => {
        this.#inFlight--;
      }),
    );
  }

  async #run(
    prepared: { command: Command; ctx: CommandContext; module: string },
    event: PrivmsgEvent,
  ): Promise<void> {
    const { command, ctx, module } = prepared;
    this.#deps.events.emit({ type: "commandInvoked", command: command.name, event });
    try {
      await this.#runWithTimeout(command.handler(ctx));
    } catch (error) {
      this.#deps.events.emit({ type: "commandError", command: command.name, event, error: asError(error) });
      this.#deps.log.child(module).error(`command "${command.name}" failed`, error);
    }
  }

  #context(
    event: PrivmsgEvent,
    module: string,
    args: readonly string[],
    argLine: string,
  ): CommandContext {
    const { client } = this.#deps;
    const log = this.#deps.log.child(module);
    const target = replyTarget(event);
    return {
      client,
      event,
      args,
      argLine,
      bot: this.#deps.bot,
      log,
      reply: (text) => safeSay(client, target, text, log),
      replyPrivate: (text) => safeNotice(client, event.user.nick, text, log),
    };
  }

  /** Stable per-user key for cooldowns: account, else hostmask, else casemapped nick. */
  #userKey(event: PrivmsgEvent): string {
    return senderKey(event, this.#deps.client.server?.caseMapper ?? null);
  }

  /** Await a handler with a timeout that frees the concurrency slot (cannot abort the work). */
  #runWithTimeout(result: MaybePromise<void>): Promise<void> {
    const ms = this.#deps.handlerTimeoutMs ?? DEFAULT_HANDLER_TIMEOUT_MS;
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`handler timed out after ${ms}ms`));
      }, ms);
      Promise.resolve(result).then(
        () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  }
}
