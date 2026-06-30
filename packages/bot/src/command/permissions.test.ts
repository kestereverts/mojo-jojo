import { describe, expect, test } from "bun:test";
import { CaseMapper, type IrcClient } from "@mojo-jojo/irc-client";
import { ConsoleLogger } from "../logging/logger.ts";
import { checkPermission, matchOwner } from "./permissions.ts";
import type { CommandContext, Permission } from "./types.ts";
import type { BotApi } from "../module/types.ts";
import { fakePrivmsg, type FakeSender } from "../testing/fakeEvents.ts";

const log = new ConsoleLogger({ level: "silent" });

function ctx(opts: { sender?: FakeSender; owners?: string[] } = {}): CommandContext {
  const client = { server: { caseMapper: new CaseMapper("rfc1459") } } as unknown as IrcClient;
  const bot: BotApi = {
    prefix: "!",
    owners: opts.owners ?? [],
    requestStop() {},
    listCommands: () => [],
    isOwner: () => false,
  };
  return {
    client,
    event: fakePrivmsg(opts.sender ?? {}),
    args: [],
    argLine: "",
    bot,
    log,
    reply: () => true,
    replyPrivate: () => true,
    cooldown: () => true,
    isIgnored: () => false,
  };
}

describe("checkPermission", () => {
  test("anyone always allows", () => {
    expect(checkPermission("anyone", ctx())).toBe(true);
  });

  test("a predicate is consulted directly", () => {
    const allow: Permission = () => true;
    const deny: Permission = () => false;
    expect(checkPermission(allow, ctx())).toBe(true);
    expect(checkPermission(deny, ctx())).toBe(false);
  });

  test("owner matches a configured owner; others are denied", () => {
    expect(checkPermission("owner", ctx({ sender: { messageAccount: "kester" }, owners: ["account:kester"] }))).toBe(true);
    expect(checkPermission("owner", ctx({ sender: { messageAccount: "rando" }, owners: ["account:kester"] }))).toBe(false);
  });

  test("owner overrides channel-status gates, even in a PM", () => {
    expect(
      checkPermission("op", ctx({ sender: { isPrivate: true, messageAccount: "kester" }, owners: ["account:kester"] })),
    ).toBe(true);
  });

  test("channel-status gates imply higher ranks", () => {
    expect(checkPermission("op", ctx({ sender: { memberModes: ["o"] } }))).toBe(true);
    expect(checkPermission("voice", ctx({ sender: { memberModes: ["o"] } }))).toBe(true); // op implies voice
    expect(checkPermission("op", ctx({ sender: { memberModes: ["v"] } }))).toBe(false);
    expect(checkPermission("halfop", ctx({ sender: { memberModes: ["a"] } }))).toBe(true); // admin > halfop
    expect(checkPermission("voice", ctx({ sender: { memberModes: [] } }))).toBe(false);
  });

  test("channel-status gates deny in a PM (no membership)", () => {
    expect(checkPermission("op", ctx({ sender: { isPrivate: true } }))).toBe(false);
  });
});

describe("matchOwner", () => {
  test("delegates to identity matching", () => {
    const cm = new CaseMapper("rfc1459");
    expect(matchOwner(fakePrivmsg({ messageAccount: "kester" }), ["account:kester"], cm)).toBe(true);
    expect(matchOwner(fakePrivmsg({ nick: "x" }), ["account:kester"], cm)).toBe(false);
  });
});
