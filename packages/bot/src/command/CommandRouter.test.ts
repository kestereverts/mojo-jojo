import { describe, expect, test } from "bun:test";
import { Subject } from "rxjs";
import { CaseMapper, type ClientEvent, type IrcClient } from "@mojo-jojo/irc-client";
import { CommandRouter, type CommandRouterDeps } from "./CommandRouter.ts";
import type { Command } from "./types.ts";
import { Cooldowns, type Clock } from "../abuse/cooldown.ts";
import { RateLimiter } from "../abuse/rateLimiter.ts";
import { IgnoreList } from "../abuse/ignore.ts";
import { BotEventHub, type BotEvent } from "../events/botEvents.ts";
import { ConsoleLogger } from "../logging/logger.ts";
import type { BotApi } from "../module/types.ts";
import { fakePrivmsg, type FakeSender } from "../testing/fakeEvents.ts";

const tick = (ms = 5): Promise<void> => new Promise((r) => setTimeout(r, ms));

function harness(over: Partial<CommandRouterDeps> = {}) {
  const events$ = new Subject<ClientEvent>();
  const says: Array<[string, string]> = [];
  const client = {
    events$,
    say: (t: string, x: string) => says.push([t, x]),
    notice: () => {},
    server: { caseMapper: new CaseMapper("rfc1459") },
  } as unknown as IrcClient;
  const hub = new BotEventHub();
  const seen: BotEvent[] = [];
  hub.events$.subscribe((e) => seen.push(e));
  const bot: BotApi = { prefix: "!", owners: [], requestStop() {}, listCommands: () => [], isOwner: () => false };
  const deps: CommandRouterDeps = {
    client,
    bot,
    log: new ConsoleLogger({ level: "silent" }),
    events: hub,
    cooldowns: new Cooldowns(),
    ignore: new IgnoreList(),
    rateLimiter: null,
    prefix: "!",
    allowPrefixlessInPm: true,
    ...over,
  };
  const router = new CommandRouter(deps);
  router.start();
  const emit = (s: FakeSender): void => events$.next(fakePrivmsg(s) as unknown as ClientEvent);
  const denials = (): string[] =>
    seen.filter((e) => e.type === "commandDenied").map((e) => (e.type === "commandDenied" ? e.reason : ""));
  return { router, emit, says, seen, denials, deps };
}

const ping: Command = { name: "ping", description: "pong", handler: (ctx) => void ctx.reply("pong") };

describe("CommandRouter abuse controls", () => {
  test("per-sender rate limit denies past the burst (all commands)", async () => {
    const rl = new RateLimiter({ capacity: 1, refillMs: 10_000, clock: { now: () => 0 } });
    const h = harness({ rateLimiter: rl });
    h.router.add(ping, "test");
    h.emit({ text: "!ping" });
    await tick();
    h.emit({ text: "!ping" });
    await tick();
    expect(h.says).toEqual([["#chan", "pong"]]); // only the first ran
    expect(h.denials()).toContain("ratelimited");
  });

  test("a handler timeout aborts the context signal", async () => {
    let aborted = false;
    const slow: Command = {
      name: "slow",
      description: "never settles",
      handler: (c) =>
        new Promise<void>(() => {
          c.signal.addEventListener("abort", () => {
            aborted = true;
          });
        }),
    };
    const h = harness({ handlerTimeoutMs: 10 });
    h.router.add(slow, "test");
    h.emit({ text: "!slow" });
    await tick(40);
    expect(aborted).toBe(true);
    expect(h.seen.some((e) => e.type === "commandError" && e.command === "slow")).toBe(true);
  });
});

describe("CommandRouter", () => {
  test("dispatches a known command and replies", async () => {
    const h = harness();
    h.router.add(ping, "test");
    h.emit({ text: "!ping" });
    await tick();
    expect(h.says).toEqual([["#chan", "pong"]]);
    expect(h.seen.some((e) => e.type === "commandInvoked" && e.command === "ping")).toBe(true);
  });

  test("ignores our own echo-message", async () => {
    const h = harness();
    h.router.add(ping, "test");
    h.emit({ text: "!ping", self: true });
    await tick();
    expect(h.says).toEqual([]);
  });

  test("ignores non-commands and unknown commands silently", async () => {
    const h = harness();
    h.router.add(ping, "test");
    h.emit({ text: "hello there" });
    h.emit({ text: "!unknown" });
    await tick();
    expect(h.says).toEqual([]);
    expect(h.seen).toEqual([]);
  });

  test("resolves aliases", async () => {
    const h = harness();
    h.router.add({ ...ping, aliases: ["p"] }, "test");
    h.emit({ text: "!p" });
    await tick();
    expect(h.says).toEqual([["#chan", "pong"]]);
  });

  test("requires the prefix in channels but not in PMs", async () => {
    const h = harness();
    h.router.add(ping, "test");
    h.emit({ text: "ping" }); // channel, no prefix -> ignored
    await tick();
    expect(h.says).toEqual([]);
    h.emit({ text: "ping", isPrivate: true, nick: "bob", target: "mojo" }); // PM, prefixless allowed
    await tick();
    expect(h.says).toEqual([["bob", "pong"]]); // reply goes to the sender, not our nick
  });

  test("denies on failed permission without running the handler", async () => {
    const h = harness();
    h.router.add({ ...ping, permission: "op" }, "test");
    h.emit({ text: "!ping", memberModes: ["v"] }); // voice < op
    await tick();
    expect(h.says).toEqual([]);
    expect(h.denials()).toEqual(["permission"]);
  });

  test("enforces a per-user cooldown", async () => {
    let now = 0;
    const clock: Clock = { now: () => now };
    const h = harness({ cooldowns: new Cooldowns(clock) });
    h.router.add({ ...ping, cooldownMs: 1000 }, "test");
    h.emit({ text: "!ping", nick: "bob" });
    await tick();
    h.emit({ text: "!ping", nick: "bob" }); // still cooling
    await tick();
    expect(h.says).toEqual([["#chan", "pong"]]);
    expect(h.denials()).toEqual(["cooldown"]);
    now = 1000; // cooldown elapsed
    h.emit({ text: "!ping", nick: "bob" });
    await tick();
    expect(h.says).toHaveLength(2);
  });

  test("drops commands from ignored senders", async () => {
    const h = harness({ ignore: new IgnoreList(["mask:*!*@spam.host"]) });
    h.router.add(ping, "test");
    h.emit({ text: "!ping", username: "u", host: "spam.host" });
    await tick();
    expect(h.says).toEqual([]);
    expect(h.denials()).toEqual(["ignored"]);
  });

  test("exposes cooldown and isIgnored on the command context", async () => {
    const h = harness({ ignore: new IgnoreList(["mask:*!*@bad.host"]) });
    const seen: { first?: boolean; second?: boolean; ignored?: boolean } = {};
    h.router.add(
      {
        name: "cd",
        description: "x",
        handler: (ctx) => {
          seen.first = ctx.cooldown("k", 1000);
          seen.second = ctx.cooldown("k", 1000);
          seen.ignored = ctx.isIgnored(ctx.event);
        },
      },
      "test",
    );
    h.emit({ text: "!cd", username: "u", host: "ok.host" });
    await tick();
    expect(seen).toEqual({ first: true, second: false, ignored: false });
  });

  test("isolates a throwing handler as commandError", async () => {
    const h = harness();
    h.router.add({ name: "boom", description: "x", handler: () => { throw new Error("kaboom"); } }, "test");
    h.emit({ text: "!boom" });
    await tick();
    expect(h.seen.some((e) => e.type === "commandError" && e.command === "boom")).toBe(true);
  });

  test("a hung handler hits the timeout and surfaces commandError", async () => {
    const h = harness({ handlerTimeoutMs: 10 });
    h.router.add({ name: "hang", description: "x", handler: () => new Promise<void>(() => {}) }, "test");
    h.emit({ text: "!hang" });
    await tick(30);
    expect(h.seen.some((e) => e.type === "commandError" && e.command === "hang")).toBe(true);
  });

  test("logged-out senders (account '*') do not share a cooldown", async () => {
    const h = harness({ cooldowns: new Cooldowns({ now: () => 0 }) });
    h.router.add({ ...ping, cooldownMs: 1000 }, "test");
    h.emit({ text: "!ping", nick: "alice", messageAccount: "*" });
    await tick();
    h.emit({ text: "!ping", nick: "bob", messageAccount: "*" });
    await tick();
    expect(h.says).toHaveLength(2); // '*' is normalized to absent -> keyed by nick
  });

  test("overload admission precedes cooldown commit (dropped command keeps the overloaded reason)", async () => {
    const h = harness({ concurrency: 1 });
    h.router.add(
      { name: "c", description: "x", cooldownMs: 60_000, handler: () => new Promise<void>(() => {}) },
      "test",
    );
    h.emit({ text: "!c", nick: "bob" }); // admitted, hangs (slot taken, cooldown armed)
    h.emit({ text: "!c", nick: "bob" }); // saturated -> overloaded BEFORE the cooldown check
    await tick();
    expect(h.denials()).toEqual(["overloaded"]);
  });

  test("drops commands when the concurrency bound is saturated", async () => {
    const h = harness({ concurrency: 1 });
    h.router.add({ name: "hang", description: "x", handler: () => new Promise<void>(() => {}) }, "test");
    h.emit({ text: "!hang" }); // admitted, occupies the only slot
    h.emit({ text: "!hang" }); // saturated -> dropped
    await tick();
    expect(h.denials()).toEqual(["overloaded"]);
  });

  test("a throwing permission predicate surfaces commandError (not a silent fault)", async () => {
    const h = harness();
    h.router.add(
      {
        name: "boom",
        description: "x",
        permission: () => {
          throw new Error("perm boom");
        },
        handler: () => {},
      },
      "test",
    );
    h.emit({ text: "!boom" });
    await tick();
    expect(h.seen.some((e) => e.type === "commandError" && e.command === "boom")).toBe(true);
  });

  test("add() rejects invalid names and within-command duplicate aliases", () => {
    const h = harness();
    expect(() => h.router.add({ name: "a b", description: "x", handler: () => {} }, "m")).toThrow(/invalid command name/);
    expect(() =>
      h.router.add({ name: "ping", aliases: ["ping"], description: "x", handler: () => {} }, "m"),
    ).toThrow(/more than once/);
  });

  test("add() rejects a duplicate name and the disposer unregisters", () => {
    const h = harness();
    const off = h.router.add(ping, "test");
    expect(() => h.router.add(ping, "other")).toThrow(/duplicate command name "ping"/);
    expect(h.router.list()).toHaveLength(1);
    off();
    expect(h.router.list()).toHaveLength(0);
    expect(() => h.router.add(ping, "again")).not.toThrow(); // name freed
  });
});
