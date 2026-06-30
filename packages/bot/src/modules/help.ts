import { defineModule, type Module } from "../module/types.ts";
import type { Command } from "../command/types.ts";

const MAX_LINE = 400; // keep well under the 512-byte IRC line limit

/** Pack command names into `"Commands: a, b, c"` lines under the IRC line limit. */
function listLines(names: readonly string[]): string[] {
  const lines: string[] = [];
  let current = "";
  for (const name of names) {
    const next = current ? `${current}, ${name}` : name;
    if (`Commands: ${next}`.length > MAX_LINE && current) {
      lines.push(`Commands: ${current}`);
      current = name;
    } else {
      current = next;
    }
  }
  if (current) lines.push(`Commands: ${current}`);
  return lines;
}

function describe(prefix: string, command: Command): string {
  const usage = command.usage ? ` ${command.usage}` : "";
  const aliases = command.aliases?.length ? ` [aliases: ${command.aliases.join(", ")}]` : "";
  return `${prefix}${command.name}${usage} — ${command.description}${aliases}`;
}

/** `!help` lists commands; `!help <cmd>` shows one command's usage. */
export function helpModule(): Module {
  return defineModule({
    name: "help",
    description: "Lists commands and shows usage.",
    setup(ctx) {
      ctx.command({
        name: "help",
        description: "List commands, or show usage for one.",
        usage: "[command]",
        aliases: ["commands"],
        handler: (c) => {
          const commands = c.bot.listCommands();
          const query = c.args[0]?.toLowerCase();
          if (query) {
            const match = commands.find(
              (cmd) => cmd.name === query || (cmd.aliases ?? []).map((a) => a.toLowerCase()).includes(query),
            );
            c.reply(match ? describe(c.bot.prefix, match) : `No such command: ${query}`);
            return;
          }
          const names = commands.map((cmd) => cmd.name).sort();
          if (names.length === 0) {
            c.reply("No commands are available.");
            return;
          }
          for (const line of listLines(names)) c.reply(line);
        },
      });
    },
  });
}
