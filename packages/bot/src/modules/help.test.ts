import { describe, test } from "bun:test";
import { bootBot } from "../testing/botHarness.ts";
import { helpModule } from "./help.ts";
import { pingModule } from "./ping.ts";

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

  test("the 'commands' alias resolves", async () => {
    const h = await bootBot({ modules: { help: {} }, factories: { help: helpModule } });
    h.send(":mojo!u@h JOIN #chan");
    h.send(":alice!a@h PRIVMSG #chan :!commands");
    await h.awaitWritten((l) => l.includes("Commands:") && l.includes("help"));
    await h.stop();
  });
});
