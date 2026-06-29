// @mojo-jojo/bot — modular, RxJS-first IRC bot framework.
//
// Public surface grows per milestone. M1 ships the config layer; the module
// system, command framework, runtime, and built-in modules follow.

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
