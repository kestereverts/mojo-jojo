import { describe, expect, test } from "bun:test";
import type { IrcClient } from "@mojo-jojo/irc-client";
import { ConsoleLogger } from "../logging/logger.ts";
import { replyTarget, safeNotice, safeSay } from "./reply.ts";
import { fakePrivmsg } from "../testing/fakeEvents.ts";

const log = new ConsoleLogger({ level: "silent" });

describe("replyTarget", () => {
  test("channel for a channel message, sender nick for a PM", () => {
    expect(replyTarget(fakePrivmsg({ memberModes: [], target: "#x" }))).toBe("#x");
    expect(replyTarget(fakePrivmsg({ nick: "bob", isPrivate: true }))).toBe("bob");
  });
});

describe("safeSay / safeNotice", () => {
  test("return true when the client send succeeds", () => {
    const client = { say: () => {}, notice: () => {} } as unknown as IrcClient;
    expect(safeSay(client, "#x", "hi", log)).toBe(true);
    expect(safeNotice(client, "bob", "hi", log)).toBe(true);
  });

  test("swallow a synchronous send-throw and return false", () => {
    const client = {
      say: () => {
        throw new Error("CRLF injection");
      },
      notice: () => {
        throw new Error("too long");
      },
    } as unknown as IrcClient;
    expect(safeSay(client, "#x", "bad", log)).toBe(false);
    expect(safeNotice(client, "bob", "bad", log)).toBe(false);
  });
});
