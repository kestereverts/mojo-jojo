import { defineModule, type Module } from "../module/types.ts";

/** A liveness check: `!ping` → `pong`. The smallest command example. */
export function pingModule(): Module {
  return defineModule({
    name: "ping",
    description: "Liveness check.",
    setup(ctx) {
      ctx.command({
        name: "ping",
        description: "Replies with pong.",
        handler: (c) => void c.reply("pong"),
      });
    },
  });
}
