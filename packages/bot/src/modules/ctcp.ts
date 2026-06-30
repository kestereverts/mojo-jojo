import { filter, takeUntil } from "rxjs";
import type { PrivmsgEvent } from "@mojo-jojo/irc-client";
import { safeNotice } from "../command/reply.ts";
import { Validator } from "../config/validate.ts";
import { senderKey } from "../identity/match.ts";
import { defineModule, type Module } from "../module/types.ts";

interface CtcpConfig {
  readonly version: string;
}

const CTCP = "\x01";
const PER_SENDER_COOLDOWN_MS = 5000; // one reply per sender per 5s

// Aggregate flood protection is intentionally left to the irc-client's outbound flood
// queue: it paces sends (~floodDelayMs apart) and drops past a bounded depth (safeNotice
// swallows the throw), so even a distributed CTCP flood can't make us flood the server.
// A hard global cooldown here would instead silently drop legitimate concurrent CTCP.

/** Responds to CTCP VERSION/PING/TIME/CLIENTINFO via NOTICE, rate-limited per sender. */
export function ctcpModule(): Module<CtcpConfig> {
  return defineModule<CtcpConfig>({
    name: "ctcp",
    description: "Responds to CTCP VERSION/PING/TIME/CLIENTINFO.",
    parseConfig(raw) {
      const v = new Validator();
      const version = v.optNonEmptyString(raw.version, "modules.ctcp.version") ?? "mojo-jojo";
      v.throwIfAny();
      return { version };
    },
    setup(ctx) {
      ctx.events$
        .pipe(
          filter((event): event is PrivmsgEvent => event.type === "privmsg"),
          takeUntil(ctx.destroyed$),
        )
        .subscribe((event) => {
          if (event.user.isSelf || ctx.isIgnored(event)) return;
          const text = event.text;
          // A non-ACTION CTCP is `\x01TAG args\x01` (ACTION already became an `action` event).
          if (text.length < 2 || !text.startsWith(CTCP) || !text.endsWith(CTCP)) return;
          const [tag, ...rest] = text.slice(1, -1).split(" ");

          let body: string | null = null;
          switch (tag?.toUpperCase()) {
            case "VERSION":
              body = `VERSION ${ctx.config.version}`;
              break;
            case "PING":
              body = `PING ${rest.join(" ")}`.trimEnd();
              break;
            case "TIME":
              body = `TIME ${new Date().toISOString()}`;
              break;
            case "CLIENTINFO":
              body = "CLIENTINFO VERSION PING TIME CLIENTINFO";
              break;
            default:
              return; // unknown CTCP: ignore (don't reply, avoid amplification)
          }

          // Per-sender rate limit (consumed only for real replies), keyed by a stable
          // account / user@host / casemapped-nick identity (resists case and nick-change bypass).
          const key = senderKey(event, ctx.client.server?.caseMapper ?? null);
          if (!ctx.cooldown(`ctcp:${key}`, PER_SENDER_COOLDOWN_MS)) return;
          safeNotice(ctx.client, event.user.nick, `${CTCP}${body}${CTCP}`, ctx.log);
        });
    },
  });
}
