import type { IrcClient, PrivmsgEvent } from "@mojo-jojo/irc-client";
import type { Logger } from "../logging/logger.ts";
import type { BotApi, MaybePromise } from "../module/types.ts";

/**
 * Who may run a command. `owner` overrides every channel-status gate (and is the
 * only one satisfiable in a PM, where there is no membership). Channel-status
 * gates imply higher ranks (an op satisfies `voice`). A predicate gets the full
 * context for custom logic.
 */
export type Permission =
  | "anyone"
  | "voice"
  | "halfop"
  | "op"
  | "admin"
  | "owner"
  | ((ctx: CommandContext) => boolean);

/** What a command handler receives. */
export interface CommandContext {
  readonly client: IrcClient;
  readonly event: PrivmsgEvent;
  /** Whitespace-split arguments after the command word. */
  readonly args: readonly string[];
  /** Raw remainder after the command word (internal spacing preserved). */
  readonly argLine: string;
  readonly bot: BotApi;
  readonly log: Logger;
  /** Reply to the channel (or the sender in a PM) via PRIVMSG. Safe: returns false if dropped, never throws. */
  reply(text: string): boolean;
  /** Reply privately to the sender via NOTICE. Safe. */
  replyPrivate(text: string): boolean;
}

/** A chat command registered through `ctx.command`. */
export interface Command {
  readonly name: string;
  readonly aliases?: readonly string[];
  readonly description: string;
  /** Argument hint shown by `help`, e.g. `"<#channel> [key]"`. */
  readonly usage?: string;
  /** Default `"anyone"`. */
  readonly permission?: Permission;
  /** Per-user cooldown in milliseconds (0/undefined = none). */
  readonly cooldownMs?: number;
  handler(ctx: CommandContext): MaybePromise<void>;
}
