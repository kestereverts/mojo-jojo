import { describe, expect, test } from "bun:test";
import { IrcClient } from "./IrcClient.ts";
import type { IrcEvent } from "./events/types.ts";

// Live, end-to-end smoke test against a real IRC server. Gated on `IRC_SMOKE=1`
// so it never runs in the default offline suite (it opens a real TCP/TLS socket).
//
//   IRC_SMOKE=1 bun test src/smoke.test.ts
//
// Overridable via env: IRC_SMOKE_HOST, IRC_SMOKE_PORT, IRC_SMOKE_TLS (0=plaintext),
// IRC_SMOKE_TLS_INSECURE=1 (skip cert validation), IRC_SMOKE_CHANNEL. Setting
// IRC_SASL_USER + IRC_SASL_PASS additionally exercises the SASL PLAIN flow and
// asserts the self-user's account is populated from the 900 login.

const SMOKE = process.env.IRC_SMOKE === "1";
const HOST = process.env.IRC_SMOKE_HOST ?? "irc.androidirc.org";
const PORT = Number(process.env.IRC_SMOKE_PORT ?? "6697");
const TLS_ON = process.env.IRC_SMOKE_TLS !== "0";
const TLS_INSECURE = process.env.IRC_SMOKE_TLS_INSECURE === "1";
const CHANNEL = process.env.IRC_SMOKE_CHANNEL ?? "#mojo2";
const SASL_USER = process.env.IRC_SASL_USER;
const SASL_PASS = process.env.IRC_SASL_PASS;

/** Poll `predicate` until it holds or the timeout elapses. */
async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const start = performance.now();
  while (!predicate()) {
    if (performance.now() - start > timeoutMs) {
      throw new Error(`smoke: timed out (${timeoutMs}ms) waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const suite = SMOKE ? describe : describe.skip;

suite("live smoke: irc-client end-to-end (IRC_SMOKE=1)", () => {
  test(
    "connect -> register -> join -> observe state -> message -> quit",
    async () => {
      const nick = `mojo${Math.floor(Math.random() * 90000 + 10000)}`;
      const useSasl = Boolean(SASL_USER && SASL_PASS);
      const tls = TLS_ON ? (TLS_INSECURE ? { rejectUnauthorized: false } : true) : false;

      const client = new IrcClient({
        host: HOST,
        port: PORT,
        tls,
        nick,
        username: "mojo",
        realName: "mojo-jojo smoke",
        reconnect: { enabled: false },
        whoOnJoin: true, // auto-WHO each channel on join (exercised below)
        // Short keepalive so the heartbeat actually fires within the test window.
        pingIntervalMs: 4000,
        pingTimeoutMs: 8000,
        ...(useSasl
          ? { sasl: { mechanism: "PLAIN" as const, username: SASL_USER!, password: SASL_PASS! } }
          : {}),
      });
      const events: IrcEvent[] = [];
      client.events$.subscribe((e) => events.push(e));
      // Capture raw PONGs (keepalive heartbeat) and 354s (WHOX replies).
      let pongs = 0;
      let whoxReplies = 0;
      client.messages$.subscribe((m) => {
        if (m.command === "PONG") pongs += 1;
        if (m.command === "354") whoxReplies += 1;
      });

      try {
        console.log(`[smoke] connecting ${HOST}:${PORT} tls=${TLS_ON} sasl=${useSasl} nick=${nick}`);
        await client.connect();
        expect(client.state).toBe("registered");
        console.log(
          `[smoke] registered as ${client.nick}; network=${client.server?.network ?? "?"}; ` +
            `caps=[${[...client.enabledCaps].join(", ")}]`,
        );

        // ISUPPORT (005) populated the typed view.
        await waitFor(() => (client.server?.isupport.prefixes.length ?? 0) > 0, 15000, "ISUPPORT/005");
        expect(client.server!.isupport.prefixes.length).toBeGreaterThan(0);

        // SASL login (when configured) surfaces our account.
        if (useSasl) {
          expect(client.user(nick)?.account).toBeTruthy();
          console.log(`[smoke] SASL account=${client.user(nick)?.account}`);
        }

        // Join the channel; wait for membership + NAMES to populate (M5 action API).
        client.join(CHANNEL);
        await waitFor(() => (client.channel(CHANNEL)?.members.size ?? 0) >= 1, 20000, "JOIN + NAMES");
        const channel = client.channel(CHANNEL)!;
        expect(channel.members.has(nick)).toBe(true);
        console.log(
          `[smoke] joined ${CHANNEL}; members=${channel.members.size}; topic=${channel.topic ?? "(none)"}`,
        );

        // Send a message; with echo-message, confirm it round-trips back to us.
        const marker = `mojo-jojo M5 smoke ${Date.now()}`;
        client.say(CHANNEL, marker);
        if (client.enabledCaps.has("echo-message")) {
          await waitFor(
            () => events.some((e) => e.type === "privmsg" && e.text === marker && e.user.isSelf),
            15000,
            "echo-message round-trip",
          );
          console.log("[smoke] echo-message round-trip confirmed");
        } else {
          console.log("[smoke] echo-message not enabled; skipped round-trip assertion");
        }

        // Exercise labeled-response (M6) live when available. CHATHISTORY needs a
        // server-side history backend, so this is best-effort: log, don't assert.
        // Use sendLabeled directly for a short timeout (chatHistory defaults to 30s).
        if (client.enabledCaps.has("labeled-response")) {
          try {
            const history = await client.sendLabeled(
              { tags: {}, source: null, command: "CHATHISTORY", params: ["LATEST", CHANNEL, "*", "10"] },
              { timeoutMs: 10000 },
            );
            console.log(`[smoke] labeled chathistory returned ${history.length} message(s)`);
          } catch (err) {
            console.log(`[smoke] labeled chathistory unavailable: ${(err as Error).message}`);
          }
        }

        // WHOX + whoOnJoin: with WHOX advertised, the auto-WHO fired on our JOIN
        // above sends a WHOX query, and the 354 replies enrich members (incl. the
        // services account). Confirm those replies arrived without a manual who().
        if (client.server?.isupport.whox === true) {
          await waitFor(() => whoxReplies > 0, 15000, "auto whoOnJoin WHOX 354 reply");
          console.log(
            `[smoke] whoOnJoin -> ${whoxReplies} WHOX reply(ies); ` +
              `self account=${client.user(nick)?.account ?? "(none)"}`,
          );
        } else {
          console.log("[smoke] server does not advertise WHOX; skipped");
        }

        // Active keepalive: idle past pingIntervalMs and confirm our PING was
        // answered (PONG) and the connection stayed healthy (no false drop).
        await waitFor(() => pongs > 0, 15000, "keepalive PING -> PONG round-trip");
        expect(client.state).toBe("registered");
        console.log(`[smoke] keepalive heartbeat confirmed (${pongs} PONG(s)); still registered`);
      } finally {
        client.quit("mojo-jojo smoke complete");
      }

      await waitFor(() => client.state === "closed", 5000, "clean quit");
      expect(client.state).toBe("closed");
      console.log("[smoke] quit cleanly");
    },
    90000,
  );
});
