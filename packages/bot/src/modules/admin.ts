import { isChannelName } from "@mojo-jojo/irc-client";
import { safeSay } from "../command/reply.ts";
import type { CommandContext } from "../command/types.ts";
import { Validator } from "../config/validate.ts";
import { defineModule, type Module } from "../module/types.ts";

interface AdminConfig {
  /** Enable the powerful `!raw` command (off by default). */
  readonly allowRaw: boolean;
}

/** Everything after the first whitespace-delimited token of `argLine` (spacing preserved). */
function restAfterFirst(argLine: string): string {
  return argLine.replace(/^\S+\s*/, "");
}

/** Run a client action, catching the synchronous send-throws (CRLF/over-length/full queue). */
function attempt(action: () => void, c: CommandContext, label: string): void {
  try {
    action();
  } catch (error) {
    c.log.warn(`${label} failed`, error);
    c.reply(`${label} failed (bad argument?)`);
  }
}

/** Parse a raw IRC line: tokens, with everything after ` :` as a single trailing param. */
function parseRawLine(line: string): { command: string; params: string[] } | null {
  const colon = line.indexOf(" :");
  const head = colon >= 0 ? line.slice(0, colon) : line;
  const trailing = colon >= 0 ? line.slice(colon + 2) : undefined;
  const tokens = head.split(/\s+/).filter((t) => t.length > 0);
  const command = tokens.shift();
  // Reject a source-/tag-prefixed token (`:`/`@`): a command word is never one.
  if (!command || command.startsWith(":") || command.startsWith("@")) return null;
  if (trailing !== undefined) tokens.push(trailing);
  return { command, params: tokens };
}

/** Owner-only bot administration. */
export function adminModule(): Module<AdminConfig> {
  return defineModule<AdminConfig>({
    name: "admin",
    description: "Owner-only administration.",
    parseConfig(raw) {
      const v = new Validator();
      const allowRaw = v.optBoolean(raw.allowRaw, "modules.admin.allowRaw") ?? false;
      v.throwIfAny();
      return { allowRaw };
    },
    setup(ctx) {
      const command = ctx.command;

      command({
        name: "join",
        description: "Join a channel.",
        usage: "<#channel> [key]",
        permission: "owner",
        handler: (c) => {
          const channel = c.args[0];
          if (!channel) return void c.reply("Usage: join <#channel> [key]");
          attempt(() => c.client.join(channel, c.args[1]), c, "join");
        },
      });

      command({
        name: "part",
        description: "Leave a channel (defaults to the current one).",
        usage: "[#channel] [reason]",
        permission: "owner",
        handler: (c) => {
          // Treat the first arg as the target only when it's channel-like; otherwise
          // it's part of the reason and we part the current channel.
          const isupport = c.client.server?.isupport;
          const first = c.args[0];
          const targetIsChannel = first !== undefined && isupport !== undefined && isChannelName(first, isupport);
          const channel = targetIsChannel ? first : c.event.channel?.name;
          if (!channel) return void c.reply("Usage: part [#channel] [reason]");
          const reason = (targetIsChannel ? restAfterFirst(c.argLine) : c.argLine) || undefined;
          attempt(() => c.client.part(channel, reason), c, "part");
        },
      });

      command({
        name: "nick",
        description: "Change the bot's nick.",
        usage: "<newnick>",
        permission: "owner",
        handler: (c) => {
          const nick = c.args[0];
          if (!nick) return void c.reply("Usage: nick <newnick>");
          attempt(() => c.client.setNick(nick), c, "nick");
        },
      });

      command({
        name: "say",
        description: "Send a message to a target.",
        usage: "<target> <text...>",
        permission: "owner",
        handler: (c) => {
          const target = c.args[0];
          const text = restAfterFirst(c.argLine);
          if (!target || text.length === 0) return void c.reply("Usage: say <target> <text...>");
          safeSay(c.client, target, text, c.log);
        },
      });

      command({
        name: "action",
        description: "Send a CTCP ACTION (/me) to a target.",
        usage: "<target> <text...>",
        permission: "owner",
        handler: (c) => {
          const target = c.args[0];
          const text = restAfterFirst(c.argLine);
          if (!target || text.length === 0) return void c.reply("Usage: action <target> <text...>");
          attempt(() => c.client.action(target, text), c, "action");
        },
      });

      command({
        name: "quit",
        description: "Shut the bot down.",
        usage: "[reason]",
        permission: "owner",
        handler: (c) => c.bot.requestStop(c.argLine || undefined),
      });

      if (ctx.config.allowRaw) {
        command({
          name: "raw",
          description: "Send a raw IRC line (everything after ` :` is the trailing param).",
          usage: "<command> [params...] [:trailing]",
          permission: "owner",
          handler: (c) => {
            const parsed = parseRawLine(c.argLine);
            if (!parsed) return void c.reply("Usage: raw <command> [params...] [:trailing]");
            attempt(() => c.client.raw(parsed.command, ...parsed.params), c, "raw");
          },
        });
      }
    },
  });
}
