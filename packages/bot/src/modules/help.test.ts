import { describe, expect, test } from "bun:test";
import { bootBot } from "../testing/botHarness.ts";
import { defineModule, type Module } from "../module/types.ts";
import { adminModule } from "./admin.ts";
import { helpModule } from "./help.ts";
import { pingModule } from "./ping.ts";

/** A module whose command has a permission predicate that always throws. */
function throwingPermModule(): Module {
  return defineModule({
    name: "boom",
    description: "test",
    setup(ctx) {
      ctx.command({
        name: "boom",
        description: "throws in its permission check",
        permission: () => {
          throw new Error("predicate boom");
        },
        handler: () => {},
      });
    },
  });
}

describe("helpModule", () => {
  test("!help lists commands; !help <cmd> shows usage", async () => {
    const h = await bootBot({
      modules: { help: {}, ping: {} },
      factories: { help: helpModule, ping: pingModule },
    });
    h.send(":mojo!u@h JOIN #chan");
    h.send(":alice!a@h PRIVMSG #chan :!help");
    await h.awaitWritten((l) => l.includes("Commands:") && l.includes("ping") && l.includes("help"));
    h.send(":alice!a@h PRIVMSG #chan :!help ping");
    await h.awaitWritten((l) => l.includes("!ping") && l.includes("Replies with pong"));
    await h.stop();
  });

  test("!help <unknown> reports no such command", async () => {
    const h = await bootBot({ modules: { help: {} }, factories: { help: helpModule } });
    h.send(":mojo!u@h JOIN #chan");
    h.send(":alice!a@h PRIVMSG #chan :!help nope");
    await h.awaitWritten((l) => l.includes("No such command: nope"));
    await h.stop();
  });

  test("hides owner-only commands from a non-owner (and won't confirm them)", async () => {
    const h = await bootBot({
      modules: { help: {}, admin: {} },
      bot: { owners: ["mask:boss!*@*"] },
      factories: { help: helpModule, admin: adminModule },
    });
    h.send(":mojo!u@h JOIN #chan");
    h.send(":rando!r@h PRIVMSG #chan :!help");
    await h.awaitWritten((l) => l.includes("Commands:"));
    const listing = h.written().find((l) => l.includes("Commands:"))!;
    expect(listing.includes("help")).toBe(true);
    expect(listing.includes("join")).toBe(false); // owner-only command hidden

    h.send(":rando!r@h PRIVMSG #chan :!help join");
    await h.awaitWritten((l) => l.includes("No such command: join"));
    await h.stop();
  });

  test("a throwing permission predicate excludes only its command, not all of !help (B5)", async () => {
    const h = await bootBot({
      modules: { help: {}, ping: {}, boom: {} },
      factories: { help: helpModule, ping: pingModule, boom: throwingPermModule },
    });
    h.send(":mojo!u@h JOIN #chan");
    h.send(":alice!a@h PRIVMSG #chan :!help");
    // help still renders, listing the well-behaved commands; "boom" is dropped.
    await h.awaitWritten((l) => l.includes("Commands:") && l.includes("ping") && l.includes("help"));
    const listing = h.written().find((l) => l.includes("Commands:"))!;
    expect(listing.includes("boom")).toBe(false);
    await h.stop();
  });

  test("the 'commands' alias resolves", async () => {
    const h = await bootBot({ modules: { help: {} }, factories: { help: helpModule } });
    h.send(":mojo!u@h JOIN #chan");
    h.send(":alice!a@h PRIVMSG #chan :!commands");
    await h.awaitWritten((l) => l.includes("Commands:") && l.includes("help"));
    await h.stop();
  });
});
