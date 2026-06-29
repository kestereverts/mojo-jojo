// @mojo-jojo/bot — modular, RxJS-first IRC bot framework.
//
// Public surface grows per milestone. M1 ships the config layer; M2 the module
// system core + Bot runtime; the command framework and built-in modules follow.

// --- Runtime (M2) ---
export { Bot, type BotDeps } from "./Bot.ts";

// --- Module contract (M2) ---
export {
  defineModule,
  isModule,
  type BotApi,
  type Disposer,
  type MaybePromise,
  type Module,
  type ModuleContext,
  type ModuleFactory,
} from "./module/types.ts";
export { ModuleRegistry } from "./module/registry.ts";
export { loadExternalModule } from "./module/loadExternal.ts";
export { ModuleHost, type ModuleHostDeps } from "./module/ModuleHost.ts";
export { MemoryStorage, type ModuleStorage } from "./module/storage.ts";

// --- Bot events (M2) ---
export {
  BotEventHub,
  type BotEvent,
  type BotEventListener,
  type CommandDeniedReason,
  type ModulePhase,
  type Unsubscribe,
} from "./events/botEvents.ts";

// --- Logging (M2) ---
export {
  ConsoleLogger,
  type ConsoleLoggerOptions,
  type Logger,
  type LogSink,
} from "./logging/logger.ts";

// --- Abuse controls (M2) ---
export { Cooldowns, systemClock, type Clock } from "./abuse/cooldown.ts";
export { IgnoreList } from "./abuse/ignore.ts";
export { matchesAny, matchesIdentity } from "./identity/match.ts";

// --- Config layer (M1) ---
export { loadConfig } from "./config/load.ts";
export { applyEnvOverrides, type Env } from "./config/env.ts";
export { ConfigError, Validator, validateConfig } from "./config/validate.ts";
export { toIrcClientOptions } from "./config/toIrcClientOptions.ts";
export { resolveExternalSpecifier } from "./config/resolveExternal.ts";
export type {
  BotConfig,
  BotSettings,
  LogLevel,
  ModuleEntryConfig,
  ServerConfig,
  TlsConfig,
  TlsOptionsConfig,
} from "./config/schema.ts";
