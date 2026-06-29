import type { ModuleFactory } from "../module/types.ts";

/**
 * Built-in modules, keyed by name. The bot seeds its {@link ModuleRegistry} with
 * these. Populated with `ping`/`help`/`admin`/`ctcp`/`autojoin` in M5.
 */
export const builtinModules: Readonly<Record<string, ModuleFactory>> = {};
