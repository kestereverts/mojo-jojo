import { describe, expect, test } from "bun:test";
import { takeUntil } from "rxjs";
import { Bot } from "./Bot.ts";
import { ConsoleLogger } from "./logging/logger.ts";
import { validateConfig } from "./config/validate.ts";
import type { BotConfig } from "./config/schema.ts";
import { ModuleRegistry } from "./module/registry.ts";
import { defineModule } from "./module/types.ts";
import type { BotEvent } from "./events/botEvents.ts";
import { freshMockTransports, waitFor } from "./testing/transports.ts";

const silent = (): ConsoleLogger => new ConsoleLogger({ level: "silent" });

type ModuleErrorEvent = Extract<BotEvent, { type: "moduleError" }>;
const isModuleError = (e: BotEvent): e is ModuleErrorEvent => e.type === "moduleError";

interface ConfigOverrides {
  modules?: Record<string, Record<string, unknown>>;
  bot?: Record<string, unknown>;
  externalModules?: string[];
}

function makeConfig(over: ConfigOverrides = {}, configDir = "/tmp/bot-test"): BotConfig {
  return validateConfig(
    {
      server: {
        host: "irc.test",
        nick: "mojo",
        tls: false,
        caps: [],
        reconnect: { initialDelayMs: 1, maxDelayMs: 5, factor: 1, jitter: false, maxRetries: 5 },
      },
      bot: over.bot,
      modules: over.modules,
      externalModules: over.externalModules,
    },
    configDir,
  );
}

/** Start a bot on a fresh mock fleet and drive it to a registered state. */
async function startBot(
  config: BotConfig,
  registry?: ModuleRegistry,
): Promise<{ bot: Bot; mocks: ReturnType<typeof freshMockTransports>["mocks"]; events: BotEvent[] }> {
  const { factory, mocks } = freshMockTransports();
  const events: BotEvent[] = [];
  const bot = new Bot(config, { transport: factory, registry, registerSignalHandlers: false, logger: silent() });
  bot.events$.subscribe((e) => events.push(e));
  const started = bot.start();
  await waitFor(() => mocks.length >= 1 && mocks[0]!.written.some((l) => l.startsWith("USER")));
  mocks[0]!.receiveLine(":irc 001 mojo :hi");
  await started;
  return { bot, mocks, events };
}

describe("Bot", () => {
  test("modules persist across reconnect; registered re-fires; per-connection entity streams complete", async () => {
    const { factory, mocks } = freshMockTransports();
    let setupCount = 0;
    const registeredHits: string[] = [];
    const probe = defineModule({
      name: "probe",
      setup(ctx) {
        setupCount++;
        ctx.lifecycle$.pipe(takeUntil(ctx.destroyed$)).subscribe((e) => {
          if (e.type === "registered") registeredHits.push(e.nick);
        });
      },
    });
    const bot = new Bot(makeConfig({ modules: { probe: {} } }), {
      transport: factory,
      registry: new ModuleRegistry({ probe: () => probe }),
      registerSignalHandlers: false,
      logger: silent(),
    });

    const started = bot.start();
    await waitFor(() => mocks.length === 1 && mocks[0]!.written.some((l) => l.startsWith("USER")));
    mocks[0]!.receiveLine(":irc 001 mojo :hi");
    await started;
    expect(registeredHits).toEqual(["mojo"]);

    // Create a channel on connection 1 and watch its per-connection stream.
    mocks[0]!.receiveLine(":mojo!u@h JOIN #chan");
    await waitFor(() => bot.client.channel("#chan") !== undefined);
    const channel = bot.client.channel("#chan")!;
    const server1 = bot.client.server;
    let channelCompleted = false;
    channel.messages$.subscribe({ complete: () => (channelCompleted = true) });

    // Abnormal drop -> reconnect with a brand-new transport.
    mocks[0]!.fail(new Error("reset"));
    await waitFor(() => channelCompleted, 2000); // stale entity stream completed
    await waitFor(() => mocks.length === 2 && mocks[1]!.written.some((l) => l.startsWith("USER")), 2000);
    mocks[1]!.receiveLine(":irc 001 mojo :hi again");
    await waitFor(() => registeredHits.length === 2, 2000);

    expect(setupCount).toBe(1); // set up once, survived the reconnect
    expect(registeredHits).toEqual(["mojo", "mojo"]);
    expect(bot.client.server).not.toBe(server1); // per-connection state rebuilt
    await bot.stop();
  });

  test("loads enabled modules and emits moduleLoaded before started", async () => {
    let setUp = false;
    const m = defineModule({
      name: "m",
      setup() {
        setUp = true;
      },
    });
    const { bot, events } = await startBot(makeConfig({ modules: { m: {} } }), new ModuleRegistry({ m: () => m }));
    expect(setUp).toBe(true);
    const loadedIdx = events.findIndex((e) => e.type === "moduleLoaded");
    const startedIdx = events.findIndex((e) => e.type === "started");
    expect(loadedIdx).toBeGreaterThanOrEqual(0);
    expect(loadedIdx).toBeLessThan(startedIdx);
    await bot.stop();
  });

  test("does not set up a disabled module", async () => {
    let setUp = false;
    const m = defineModule({
      name: "m",
      setup() {
        setUp = true;
      },
    });
    const { bot, events } = await startBot(makeConfig({ modules: { m: { enabled: false } } }), new ModuleRegistry({ m: () => m }));
    expect(setUp).toBe(false);
    expect(events.some((e) => e.type === "moduleLoaded")).toBe(false);
    await bot.stop();
  });

  test("isolates an unknown module (moduleError, config phase) but still starts", async () => {
    const { bot, events } = await startBot(makeConfig({ modules: { ghost: {} } }));
    const errors = events.filter(isModuleError);
    expect(errors.map((e) => e.name)).toContain("ghost");
    expect(errors[0]?.phase).toBe("config");
    expect(events.some((e) => e.type === "started")).toBe(true);
    await bot.stop();
  });

  test("isolates a module whose setup throws", async () => {
    const bad = defineModule({
      name: "bad",
      setup() {
        throw new Error("kaboom");
      },
    });
    const { bot, events } = await startBot(makeConfig({ modules: { bad: {} } }), new ModuleRegistry({ bad: () => bad }));
    expect(events.filter(isModuleError).map((e) => e.phase)).toContain("setup");
    expect(events.some((e) => e.type === "started")).toBe(true);
    await bot.stop();
  });

  test("failOnModuleError aborts start()", async () => {
    const { factory } = freshMockTransports();
    const bot = new Bot(makeConfig({ modules: { ghost: {} }, bot: { failOnModuleError: true } }), {
      transport: factory,
      registerSignalHandlers: false,
      logger: silent(),
    });
    let caught: Error | undefined;
    await bot.start().catch((e: unknown) => {
      caught = e as Error;
    });
    expect(caught?.message).toMatch(/unknown module "ghost"/);
    await bot.stop();
  });

  test("auto-loads an external module from externalModules", async () => {
    const config = makeConfig({ externalModules: ["./module/fixtures/validModule.ts"] }, import.meta.dir);
    const { bot, events } = await startBot(config);
    expect(events.some((e) => e.type === "moduleLoaded" && e.name === "valid-ext")).toBe(true);
    await bot.stop();
  });

  test("stop() disposes modules, quits, and emits stopped", async () => {
    let disposed = false;
    const m = defineModule({
      name: "m",
      setup() {
        return () => {
          disposed = true;
        };
      },
    });
    const { bot, mocks, events } = await startBot(makeConfig({ modules: { m: {} } }), new ModuleRegistry({ m: () => m }));
    await bot.stop("bye");
    expect(disposed).toBe(true);
    expect(mocks[0]!.written.some((l) => l.startsWith("QUIT"))).toBe(true);
    expect(events.some((e) => e.type === "stopped")).toBe(true);
  });
});
