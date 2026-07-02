import { EMPTY, type Observable, Subject, catchError, defer, filter, finalize, mergeMap, takeUntil } from "rxjs";
import type { IrcClient, PrivmsgEvent } from "@mojo-jojo/irc-client";
import type { Cooldowns } from "../abuse/cooldown.ts";
import type { IgnoreList } from "../abuse/ignore.ts";
import type { RateLimiter } from "../abuse/rateLimiter.ts";
import type { BotEventHub } from "../events/botEvents.ts";
import type { Logger } from "../logging/logger.ts";
import type { BotApi, Disposer, MaybePromise } from "../module/types.ts";
import { senderKey } from "../identity/match.ts";
import { checkPermission } from "./permissions.ts";
import { parseCommandLine } from "./parse.ts";
import { replyTarget, safeNotice, safeSay } from "./reply.ts";
import type { Command, CommandContext } from "./types.ts";
import { asError } from "../util/errors.ts";

const DEFAULT_CONCURRENCY = 8;
const DEFAULT_HANDLER_TIMEOUT_MS = 30_000;
const LOG_THROTTLE_MS = 5_000; // cap warn-spam from a flood hitting the same drop path

export interface CommandRouterDeps {
  readonly client: IrcClient;
  readonly bot: BotApi;
  readonly log: Logger;
  readonly events: BotEventHub;
  readonly cooldowns: Cooldowns;
  readonly ignore: IgnoreList;
  /** Per-sender command rate limit applied to ALL commands; `null` disables it. */
  readonly rateLimiter: RateLimiter | null;
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

interface Prepared {
  readonly command: Command;
  readonly ctx: CommandContext;
  readonly module: string;
  readonly controller: AbortController;
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
      // Safety net: nothing in the pipeline should error (per-handler errors are caught
      // in #admit, and emit() is isolated), but never let the dispatch subscription die
      // silently if something unexpected does.
      .subscribe({ error: (error) => this.#deps.log.error("command pipeline errored", error) });
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
    return () => {
      for (const name of names) {
        if (this.#byName.get(name) === entry) this.#byName.delete(name);
      }
    };
  }

  /** All registered commands (distinct, no alias duplicates) — derived from the name map. */
  list(): readonly Command[] {
    return [...new Set([...this.#byName.values()].map((e) => e.command))];
  }

  dispose(): void {
    this.#destroyed$.next();
    this.#destroyed$.complete();
    this.#byName.clear();
  }

  /**
   * Cheap, synchronous resolution + gating (parse → lookup → ignore → permission).
   * Emits the relevant `commandDenied`/`commandError` and returns a runnable command
   * + context, or `null`. Runs OUTSIDE the concurrency bound so non-commands and
   * denials never consume a handler slot. The cooldown commit happens later in
   * `#admit` (after overload admission), so a dropped command keeps its cooldown.
   */
  #prepare(event: PrivmsgEvent): Prepared | null {
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

    const controller = new AbortController();
    const ctx = this.#context(event, command, module, parsed.args, parsed.argLine, controller.signal);

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

    return { command, ctx, module, controller };
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
      // Throttle the warn so a sustained flood can't amplify into a log-output DoS.
      if (this.#deps.cooldowns.check("log:overloaded", LOG_THROTTLE_MS)) {
        this.#deps.log.warn(`dropping commands: ${this.#maxConcurrency} handlers already in flight`);
      }
      return EMPTY;
    }

    // Resolve the sender identity key once (account/hostmask fold is non-trivial)
    // and reuse it for both the rate limiter and the cooldown.
    const userKey = this.#userKey(event);

    // Per-sender command rate limit, applied to ALL commands (independent of cooldownMs),
    // so one user can't keep the bot at its max output rate network-wide.
    if (this.#deps.rateLimiter && !this.#deps.rateLimiter.tryConsume(userKey)) {
      this.#deps.events.emit({ type: "commandDenied", command: command.name, reason: "ratelimited", event });
      return EMPTY;
    }

    if (command.cooldownMs && command.cooldownMs > 0) {
      const key = `cmd:${command.name}:${userKey}`;
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

  async #run(prepared: Prepared, event: PrivmsgEvent): Promise<void> {
    const { command, ctx, module, controller } = prepared;
    this.#deps.events.emit({ type: "commandInvoked", command: command.name, event });
    try {
      await this.#runWithTimeout(command.handler(ctx), controller);
    } catch (error) {
      this.#deps.events.emit({ type: "commandError", command: command.name, event, error: asError(error) });
      this.#deps.log.child(module).error(`command "${command.name}" failed`, error);
    }
  }

  #context(
    event: PrivmsgEvent,
    command: Command,
    module: string,
    args: readonly string[],
    argLine: string,
    signal: AbortSignal,
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
      signal,
      reply: (text) => safeSay(client, target, text, log),
      replyPrivate: (text) => safeNotice(client, event.user.nick, text, log),
      cooldown: (key, ms) => this.#deps.cooldowns.check(`cmdctx:${command.name}:${key}`, ms),
      isIgnored: (e) => this.#deps.ignore.has(e, this.#deps.client.server?.caseMapper ?? null),
    };
  }

  /** Stable per-user key for cooldowns: account, else hostmask, else casemapped nick. */
  #userKey(event: PrivmsgEvent): string {
    return senderKey(event, this.#deps.client.server?.caseMapper ?? null);
  }

  /**
   * Await a handler with a timeout that frees the concurrency slot and ABORTS the
   * context signal (so a cooperative handler can cancel its own in-flight work). It
   * still cannot forcibly stop non-cooperative or synchronous work.
   */
  #runWithTimeout(result: MaybePromise<void>, controller: AbortController): Promise<void> {
    const ms = this.#deps.handlerTimeoutMs ?? DEFAULT_HANDLER_TIMEOUT_MS;
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        controller.abort();
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
