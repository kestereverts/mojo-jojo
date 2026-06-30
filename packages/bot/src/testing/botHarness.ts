import type { MockTransport } from "@mojo-jojo/irc-client";
import { Bot } from "../Bot.ts";
import { validateConfig } from "../config/validate.ts";
import { BotEventHub, type BotEvent } from "../events/botEvents.ts";
import { ConsoleLogger } from "../logging/logger.ts";
import { ModuleRegistry } from "../module/registry.ts";
import type { ModuleFactory } from "../module/types.ts";
import { freshMockTransports, waitFor } from "./transports.ts";

export interface BotHarness {
  readonly bot: Bot;
  readonly mocks: MockTransport[];
  readonly events: BotEvent[];
  /** Feed an inbound line to the current connection's mock. */
  send(line: string): void;
  /** Lines written across all connections. */
  written(): string[];
  /** Wait until any written line satisfies `predicate`. */
  awaitWritten(predicate: (line: string) => boolean, timeoutMs?: number): Promise<void>;
  stop(): Promise<void>;
}

export interface BootOptions {
  modules?: Record<string, Record<string, unknown>>;
  bot?: Record<string, unknown>;
  factories?: Record<string, ModuleFactory>;
  nick?: string;
}

/** Boot a Bot on a fresh mock fleet, drive it to registered, and return a test driver. */
export async function bootBot(opts: BootOptions = {}): Promise<BotHarness> {
  const nick = opts.nick ?? "mojo";
  const { factory, mocks } = freshMockTransports();
  const config = validateConfig(
    {
      server: {
        host: "irc.test",
        nick,
        tls: false,
        caps: [],
        reconnect: { initialDelayMs: 1, maxDelayMs: 5, factor: 1, jitter: false, maxRetries: 5 },
      },
      bot: opts.bot,
      modules: opts.modules,
    },
    "/tmp/bot-test",
  );
  const events: BotEvent[] = [];
  const bot = new Bot(config, {
    transport: factory,
    registry: new ModuleRegistry(opts.factories ?? {}),
    registerSignalHandlers: false,
    logger: new ConsoleLogger({ level: "silent" }),
    quitFlushMs: 0,
  });
  bot.events$.subscribe((e) => events.push(e));
  const started = bot.start();
  await waitFor(() => mocks.length >= 1 && mocks[0]!.written.some((l) => l.startsWith("USER")));
  mocks[0]!.receiveLine(`:irc 001 ${nick} :hi`);
  await started;

  const written = (): string[] => mocks.flatMap((m) => m.written);
  return {
    bot,
    mocks,
    events,
    send: (line) => mocks[mocks.length - 1]!.receiveLine(line),
    written,
    awaitWritten: (predicate, timeoutMs) => waitFor(() => written().some(predicate), timeoutMs),
    stop: () => bot.stop(),
  };
}

// Re-export so module tests can build a BotEventHub directly if needed.
export { BotEventHub };
