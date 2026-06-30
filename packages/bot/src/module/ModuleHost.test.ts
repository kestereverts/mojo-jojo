import { describe, expect, test } from "bun:test";
import { Subject } from "rxjs";
import type { ClientEvent, IrcClient } from "@mojo-jojo/irc-client";
import { ModuleHost, type ModuleHostDeps } from "./ModuleHost.ts";
import { defineModule, type Module } from "./types.ts";
import { Cooldowns } from "../abuse/cooldown.ts";
import { IgnoreList } from "../abuse/ignore.ts";
import { ConsoleLogger } from "../logging/logger.ts";
import { fakePrivmsg } from "../testing/fakeEvents.ts";

function fakeClient(): { client: IrcClient; clientEvents: Subject<ClientEvent> } {
  const clientEvents = new Subject<ClientEvent>();
  const client = {
    events$: new Subject(),
    clientEvents$: clientEvents,
    lifecycle$: new Subject(),
    messages$: new Subject(),
  } as unknown as IrcClient;
  return { client, clientEvents };
}

function makeDeps(client: IrcClient, over: Partial<ModuleHostDeps> = {}): ModuleHostDeps {
  return {
    client,
    log: new ConsoleLogger({ level: "silent" }),
    bot: { prefix: "!", owners: [], requestStop: () => {}, listCommands: () => [], isOwner: () => false },
    cooldowns: new Cooldowns(),
    ignore: new IgnoreList(),
    caseMapper: () => null,
    registerCommand: () => () => {},
    ...over,
  };
}

function makeHost<C>(module: Module<C>, config: C, client: IrcClient, over?: Partial<ModuleHostDeps>): ModuleHost<C> {
  return new ModuleHost(module, config, makeDeps(client, over));
}

const REGISTERED = (nick: string): ClientEvent => ({ type: "registered", nick }) as ClientEvent;

describe("ModuleHost", () => {
  test("track()ed subscriptions are torn down on dispose", async () => {
    const { client, clientEvents } = fakeClient();
    const seen: number[] = [];
    const mod = defineModule({
      name: "m",
      setup(ctx) {
        ctx.track(ctx.clientEvents$.subscribe(() => seen.push(1)));
      },
    });
    const host = makeHost(mod, {}, client);
    await host.setup();
    clientEvents.next(REGISTERED("a"));
    expect(seen).toHaveLength(1);
    await host.dispose();
    clientEvents.next(REGISTERED("b"));
    expect(seen).toHaveLength(1);
  });

  test("destroyed$ completes on dispose", async () => {
    const { client } = fakeClient();
    let completed = false;
    const mod = defineModule({
      name: "m",
      setup(ctx) {
        ctx.destroyed$.subscribe({ complete: () => (completed = true) });
      },
    });
    const host = makeHost(mod, {}, client);
    await host.setup();
    expect(completed).toBe(false);
    await host.dispose();
    expect(completed).toBe(true);
  });

  test("on() isolates a throwing handler and still delivers to others", async () => {
    const { client, clientEvents } = fakeClient();
    const seen: string[] = [];
    const mod = defineModule({
      name: "m",
      setup(ctx) {
        ctx.on("registered", () => {
          throw new Error("boom");
        });
        ctx.on("registered", (e) => seen.push(e.nick));
      },
    });
    const host = makeHost(mod, {}, client);
    await host.setup();
    expect(() => clientEvents.next(REGISTERED("z"))).not.toThrow();
    expect(seen).toEqual(["z"]);
    await host.dispose();
  });

  test("runs the setup disposer first, then onCleanup in reverse order", async () => {
    const { client } = fakeClient();
    const order: string[] = [];
    const mod = defineModule({
      name: "m",
      setup(ctx) {
        ctx.onCleanup(() => void order.push("cleanup1"));
        ctx.onCleanup(() => void order.push("cleanup2"));
        return () => void order.push("setupDisposer");
      },
    });
    const host = makeHost(mod, {}, client);
    await host.setup();
    await host.dispose();
    expect(order).toEqual(["setupDisposer", "cleanup2", "cleanup1"]);
  });

  test("a throwing tracked-subscription teardown still runs the setup disposer and onCleanup", async () => {
    const { client } = fakeClient();
    const order: string[] = [];
    const mod = defineModule({
      name: "m",
      setup(ctx) {
        ctx.track({
          unsubscribe() {
            throw new Error("teardown boom");
          },
        });
        ctx.onCleanup(() => {
          order.push("cleanup");
        });
        return () => {
          order.push("setupDisposer");
        };
      },
    });
    const host = makeHost(mod, {}, client);
    await host.setup();
    await host.dispose(); // must not throw despite the faulting subscription teardown
    expect(order).toEqual(["setupDisposer", "cleanup"]);
  });

  test("dispose is idempotent and isolates a throwing disposer", async () => {
    const { client } = fakeClient();
    let runs = 0;
    const mod = defineModule({
      name: "m",
      setup() {
        return () => {
          runs++;
          throw new Error("dispose boom");
        };
      },
    });
    const host = makeHost(mod, {}, client);
    await host.setup();
    await host.dispose();
    await host.dispose();
    expect(runs).toBe(1);
  });

  test("cooldown is namespaced per module; isIgnored consults the ignore list", async () => {
    const { client } = fakeClient();
    const cooldowns = new Cooldowns();
    const ignore = new IgnoreList(["account:bad"]);
    let first: boolean | undefined;
    let second: boolean | undefined;
    let ignored: boolean | undefined;
    const mod = defineModule({
      name: "mod-a",
      setup(ctx) {
        first = ctx.cooldown("k", 1000);
        second = ctx.cooldown("k", 1000);
        ignored = ctx.isIgnored(fakePrivmsg({ messageAccount: "bad" }));
      },
    });
    await makeHost(mod, {}, client, { cooldowns, ignore }).setup();
    expect([first, second, ignored]).toEqual([true, false, true]);
    // Namespaced: mod-a armed "mod-a:k"; a different module's "k" is independent.
    expect(cooldowns.check("mod-a:k", 1000)).toBe(false);
    expect(cooldowns.check("mod-b:k", 1000)).toBe(true);
  });

  test("setup() rejects when the module's setup throws", async () => {
    const { client } = fakeClient();
    const mod = defineModule({
      name: "m",
      setup() {
        throw new Error("setup boom");
      },
    });
    let caught: Error | undefined;
    await makeHost(mod, {}, client)
      .setup()
      .catch((e: unknown) => {
        caught = e as Error;
      });
    expect(caught?.message).toBe("setup boom");
  });

  test("a setup that throws after wiring still disposes (no leaked subscriptions/cleanups)", async () => {
    const { client, clientEvents } = fakeClient();
    let handlerCalls = 0;
    let cleaned = false;
    const mod = defineModule({
      name: "m",
      setup(ctx) {
        ctx.track(ctx.clientEvents$.subscribe(() => handlerCalls++));
        ctx.on("registered", () => handlerCalls++);
        ctx.onCleanup(() => {
          cleaned = true;
        });
        throw new Error("setup boom");
      },
    });
    let caught: Error | undefined;
    await makeHost(mod, {}, client)
      .setup()
      .catch((e: unknown) => (caught = e as Error));
    expect(caught?.message).toBe("setup boom");
    expect(cleaned).toBe(true); // onCleanup ran during self-dispose
    clientEvents.next(REGISTERED("x"));
    expect(handlerCalls).toBe(0); // tracked/on subscriptions were torn down
  });
});
