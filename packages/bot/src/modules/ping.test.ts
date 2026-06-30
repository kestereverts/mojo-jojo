import { describe, expect, test } from "bun:test";
import { bootBot } from "../testing/botHarness.ts";
import { pingModule } from "./ping.ts";

describe("pingModule", () => {
  test("!ping replies pong", async () => {
    const h = await bootBot({ modules: { ping: {} }, factories: { ping: pingModule } });
    h.send(":mojo!u@h JOIN #chan");
    h.send(":alice!a@h PRIVMSG #chan :!ping");
    await h.awaitWritten((l) => l.startsWith("PRIVMSG #chan") && l.includes("pong"));
    expect(h.events.some((e) => e.type === "commandInvoked" && e.command === "ping")).toBe(true);
    await h.stop();
  });
});
