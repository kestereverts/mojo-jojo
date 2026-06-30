import { describe, expect, test } from "bun:test";
import { IrcClient, type IrcEvent } from "@mojo-jojo/irc-client";
import { Bot } from "./Bot.ts";
import { validateConfig } from "./config/validate.ts";

// Live, end-to-end smoke test against a real IRC server. Gated on `BOT_SMOKE=1`
// so it never runs in the default offline suite (it opens real TCP/TLS sockets).
//
//   BOT_SMOKE=1 bun test src/bot.smoke.test.ts
//
// A real Bot (ping + autojoin) joins the channel; a SECOND client acts as a user,
// says `!ping`, and we confirm the bot's `pong` arrives (the bot ignores its own
// echo, so a self-message wouldn't exercise the command path). Overridable via the
// same env as the irc-client smoke: IRC_SMOKE_HOST/PORT/TLS/TLS_INSECURE/CHANNEL.

const SMOKE = process.env.BOT_SMOKE === "1";
const HOST = process.env.IRC_SMOKE_HOST ?? "irc.androidirc.org";
const PORT = Number(process.env.IRC_SMOKE_PORT ?? "6697");
if (SMOKE && !Number.isInteger(PORT)) {
  throw new Error(`bot-smoke: IRC_SMOKE_PORT must be an integer, got "${process.env.IRC_SMOKE_PORT}"`);
}
const TLS_ON = process.env.IRC_SMOKE_TLS !== "0";
const TLS_INSECURE = process.env.IRC_SMOKE_TLS_INSECURE === "1";
const CHANNEL = process.env.IRC_SMOKE_CHANNEL ?? "#mojo2";

async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const start = performance.now();
  while (!predicate()) {
    if (performance.now() - start > timeoutMs) {
      throw new Error(`bot-smoke: timed out (${timeoutMs}ms) waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const suite = SMOKE ? describe : describe.skip;

suite("live smoke: bot end-to-end (BOT_SMOKE=1)", () => {
  test(
    "autojoins a channel and answers !ping from another user",
    async () => {
      const tls = TLS_ON ? (TLS_INSECURE ? { rejectUnauthorized: false } : true) : false;
      const suffix = Math.floor(Math.random() * 90000 + 10000);
      const botNick = `mojobot${suffix}`;
      const userNick = `mojousr${suffix}`;

      const config = validateConfig(
        {
          server: {
            host: HOST,
            port: PORT,
            tls,
            nick: botNick,
            username: "mojobot",
            realName: "mojo-jojo smoke bot",
            reconnect: { enabled: false },
          },
          bot: { prefix: "!" },
          modules: { ping: {}, autojoin: { channels: [CHANNEL] } },
        },
        "/tmp",
      );
      const bot = new Bot(config, { registerSignalHandlers: false, quitFlushMs: 150 });

      const user = new IrcClient({
        host: HOST,
        port: PORT,
        tls,
        nick: userNick,
        username: "mojousr",
        realName: "mojo-jojo smoke user",
        reconnect: { enabled: false },
      });
      const userEvents: IrcEvent[] = [];
      user.events$.subscribe((e) => userEvents.push(e));

      try {
        console.log(`[bot-smoke] starting bot ${botNick} on ${HOST}:${PORT} tls=${TLS_ON} -> ${CHANNEL}`);
        await bot.start();
        expect(bot.client.state).toBe("registered");
        await waitFor(() => (bot.client.channel(CHANNEL)?.members.size ?? 0) >= 1, 20000, "bot autojoin");
        console.log(`[bot-smoke] bot joined ${CHANNEL} (${bot.client.channel(CHANNEL)?.members.size} member(s))`);

        await user.connect();
        user.join(CHANNEL);
        await waitFor(() => user.channel(CHANNEL)?.members.has(botNick) ?? false, 20000, "user sees the bot");
        console.log(`[bot-smoke] user ${userNick} joined and sees the bot`);

        user.say(CHANNEL, "!ping");
        await waitFor(
          () => userEvents.some((e) => e.type === "privmsg" && e.text === "pong" && e.user.nick === botNick),
          15000,
          "bot pong reply",
        );
        console.log("[bot-smoke] received pong from the bot — command path live");
      } finally {
        // Clean up both connections independently — quit() can throw on a faulted
        // socket, and bot.stop() must still run.
        try {
          user.quit("mojo-jojo smoke user done");
        } catch {
          /* ignore a cleanup-time quit fault */
        }
        await bot.stop("mojo-jojo smoke complete");
      }

      await waitFor(() => bot.client.state === "closed", 5000, "bot clean stop");
      expect(bot.client.state).toBe("closed");
      console.log("[bot-smoke] stopped cleanly");
    },
    90000,
  );
});
