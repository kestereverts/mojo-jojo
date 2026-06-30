import { describe, expect, test } from "bun:test";
import { bootBot } from "../testing/botHarness.ts";
import { waitFor } from "../testing/transports.ts";
import { adminModule } from "./admin.ts";

const OWNER = { owners: ["mask:boss!*@*"] };

describe("adminModule", () => {
  test("owner can !join; a non-owner is denied", async () => {
    const h = await bootBot({ modules: { admin: {} }, bot: OWNER, factories: { admin: adminModule } });
    h.send(":mojo!u@h JOIN #home");

    h.send(":rando!r@h PRIVMSG #home :!join #secret"); // not an owner
    await new Promise((r) => setTimeout(r, 20));
    expect(h.written().some((l) => l.startsWith("JOIN #secret"))).toBe(false);
    expect(
      h.events.some((e) => e.type === "commandDenied" && e.command === "join" && e.reason === "permission"),
    ).toBe(true);

    h.send(":boss!b@h PRIVMSG #home :!join #secret key1"); // owner by mask
    await h.awaitWritten((l) => l.startsWith("JOIN #secret"));
    await h.stop();
  });

  test("!say relays to a target, preserving spacing", async () => {
    const h = await bootBot({ modules: { admin: {} }, bot: OWNER, factories: { admin: adminModule } });
    h.send(":mojo!u@h JOIN #home");
    h.send(":boss!b@h PRIVMSG #home :!say #out hello   world");
    await h.awaitWritten((l) => l === "PRIVMSG #out :hello   world\r\n");
    await h.stop();
  });

  test("!part with no channel arg parts the current channel, using the args as the reason", async () => {
    const h = await bootBot({ modules: { admin: {} }, bot: OWNER, factories: { admin: adminModule } });
    h.send(":mojo!u@h JOIN #home");
    h.send(":boss!b@h PRIVMSG #home :!part see ya");
    await h.awaitWritten((l) => l === "PART #home :see ya\r\n");
    await h.stop();
  });

  test("!part with an explicit channel parts that channel", async () => {
    const h = await bootBot({ modules: { admin: {} }, bot: OWNER, factories: { admin: adminModule } });
    h.send(":mojo!u@h JOIN #home");
    h.send(":boss!b@h PRIVMSG #home :!part #other be right back");
    await h.awaitWritten((l) => l === "PART #other :be right back\r\n");
    await h.stop();
  });

  test("!raw is unavailable unless allowRaw is set", async () => {
    const h = await bootBot({ modules: { admin: {} }, bot: OWNER, factories: { admin: adminModule } });
    h.send(":mojo!u@h JOIN #home");
    h.send(":boss!b@h PRIVMSG #home :!raw PRIVMSG #x :nope");
    await new Promise((r) => setTimeout(r, 20));
    expect(h.written().some((l) => l.startsWith("PRIVMSG #x"))).toBe(false);
    await h.stop();
  });

  test("!raw sends a raw line (with trailing param) when enabled", async () => {
    const h = await bootBot({ modules: { admin: { allowRaw: true } }, bot: OWNER, factories: { admin: adminModule } });
    h.send(":mojo!u@h JOIN #home");
    h.send(":boss!b@h PRIVMSG #home :!raw PRIVMSG #x :hello world");
    await h.awaitWritten((l) => l === "PRIVMSG #x :hello world\r\n");
    await h.stop();
  });

  test("owner !quit stops the bot", async () => {
    const h = await bootBot({ modules: { admin: {} }, bot: OWNER, factories: { admin: adminModule } });
    h.send(":mojo!u@h JOIN #home");
    h.send(":boss!b@h PRIVMSG #home :!quit bye");
    await waitFor(() => h.events.some((e) => e.type === "stopped"), 1000);
  });
});
