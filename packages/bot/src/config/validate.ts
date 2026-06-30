import type { ReconnectOptions, SaslOptions } from "@mojo-jojo/irc-client";
import type {
  BotConfig,
  BotSettings,
  LogLevel,
  ModuleEntryConfig,
  ServerConfig,
  TlsConfig,
} from "./schema.ts";

const LOG_LEVELS = ["debug", "info", "warn", "error", "silent"] as const;

/** Object keys that would pollute a prototype rather than create an own property. */
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Thrown when a config fails validation. Carries every issue found (validation
 * collects all problems rather than failing on the first), each prefixed with
 * its dotted path.
 */
export class ConfigError extends Error {
  readonly issues: readonly string[];
  constructor(issues: readonly string[]) {
    super(`Invalid bot config:\n  - ${issues.join("\n  - ")}`);
    this.name = "ConfigError";
    this.issues = issues;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Path-aware, error-collecting validation primitives. Each accessor records an
 * issue (and returns a harmless sentinel/`undefined`) instead of throwing, so a
 * single pass surfaces every problem. Call {@link throwIfAny} when done. Exported
 * so module `parseConfig` implementations validate their option slices the same way.
 */
export class Validator {
  readonly #issues: string[] = [];

  get issues(): readonly string[] {
    return this.#issues;
  }

  fail(path: string, message: string): void {
    this.#issues.push(`${path}: ${message}`);
  }

  throwIfAny(): void {
    if (this.#issues.length > 0) throw new ConfigError([...this.#issues]);
  }

  requireRecord(value: unknown, path: string): Record<string, unknown> {
    if (isRecord(value)) return value;
    this.fail(path, "expected a table");
    return {};
  }

  optRecord(value: unknown, path: string): Record<string, unknown> | undefined {
    if (value === undefined) return undefined;
    if (isRecord(value)) return value;
    this.fail(path, "expected a table");
    return undefined;
  }

  requireString(value: unknown, path: string): string {
    if (typeof value === "string" && value.length > 0) return value;
    this.fail(path, "expected a non-empty string");
    return "";
  }

  optString(value: unknown, path: string): string | undefined {
    if (value === undefined) return undefined;
    if (typeof value === "string") return value;
    this.fail(path, "expected a string");
    return undefined;
  }

  optInteger(value: unknown, path: string): number | undefined {
    if (value === undefined) return undefined;
    if (typeof value === "number" && Number.isInteger(value)) return value;
    this.fail(path, "expected an integer");
    return undefined;
  }

  optNumber(value: unknown, path: string): number | undefined {
    if (value === undefined) return undefined;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    this.fail(path, "expected a number");
    return undefined;
  }

  optBoolean(value: unknown, path: string): boolean | undefined {
    if (value === undefined) return undefined;
    if (typeof value === "boolean") return value;
    this.fail(path, "expected a boolean");
    return undefined;
  }

  /** Non-empty string, **trimmed** (so it normalizes like env-sourced values); empty/whitespace fails. */
  optNonEmptyString(value: unknown, path: string): string | undefined {
    if (value === undefined) return undefined;
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
    this.fail(path, "expected a non-empty string");
    return undefined;
  }

  /** Array of non-empty **trimmed** strings; empty/whitespace elements are flagged by index. */
  optStringArray(value: unknown, path: string): string[] | undefined {
    if (value === undefined) return undefined;
    if (!Array.isArray(value)) {
      this.fail(path, "expected an array of strings");
      return undefined;
    }
    const out: string[] = [];
    let ok = true;
    for (let i = 0; i < value.length; i++) {
      const item = value[i];
      if (typeof item === "string" && item.trim().length > 0) out.push(item.trim());
      else {
        this.fail(`${path}[${i}]`, "expected a non-empty string");
        ok = false;
      }
    }
    return ok ? out : undefined;
  }

  optEnum<T extends string>(value: unknown, path: string, allowed: readonly T[]): T | undefined {
    if (value === undefined) return undefined;
    if (typeof value === "string" && (allowed as readonly string[]).includes(value)) {
      return value as T;
    }
    this.fail(path, `expected one of: ${allowed.join(", ")}`);
    return undefined;
  }

  /** Integer within `[min, max]` (inclusive). */
  optIntegerInRange(value: unknown, path: string, min: number, max: number): number | undefined {
    const n = this.optInteger(value, path);
    if (n === undefined) return undefined;
    if (n < min || n > max) {
      this.fail(path, `expected an integer in [${min}, ${max}]`);
      return undefined;
    }
    return n;
  }

  /** Finite number `>= 0`. */
  optNonNegativeNumber(value: unknown, path: string): number | undefined {
    const n = this.optNumber(value, path);
    if (n === undefined) return undefined;
    if (n < 0) {
      this.fail(path, "expected a non-negative number");
      return undefined;
    }
    return n;
  }

  /** Finite number `>= min`. */
  optNumberAtLeast(value: unknown, path: string, min: number): number | undefined {
    const n = this.optNumber(value, path);
    if (n === undefined) return undefined;
    if (n < min) {
      this.fail(path, `expected a number >= ${min}`);
      return undefined;
    }
    return n;
  }

  /** Integer `>= 0`. */
  optNonNegativeInteger(value: unknown, path: string): number | undefined {
    const n = this.optInteger(value, path);
    if (n === undefined) return undefined;
    if (n < 0) {
      this.fail(path, "expected a non-negative integer");
      return undefined;
    }
    return n;
  }
}

function validateTls(v: Validator, value: unknown, path: string): TlsConfig | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "boolean") return value;
  if (!isRecord(value)) {
    v.fail(path, "expected a boolean or a table");
    return undefined;
  }
  const rejectUnauthorized = v.optBoolean(value.rejectUnauthorized, `${path}.rejectUnauthorized`);
  return rejectUnauthorized === undefined ? {} : { rejectUnauthorized };
}

function validateSasl(v: Validator, value: unknown, path: string): SaslOptions | undefined {
  if (value === undefined) return undefined;
  const rec = v.optRecord(value, path);
  if (!rec) return undefined;
  const mechanism = v.optEnum(rec.mechanism, `${path}.mechanism`, ["PLAIN", "EXTERNAL"] as const);
  if (mechanism === "PLAIN") {
    const username = v.requireString(rec.username, `${path}.username`);
    const password = v.requireString(rec.password, `${path}.password`);
    return { mechanism, username, password };
  }
  if (mechanism === "EXTERNAL") return { mechanism };
  if (rec.mechanism === undefined) v.fail(`${path}.mechanism`, "required (PLAIN or EXTERNAL)");
  return undefined;
}

function validateCaps(v: Validator, value: unknown, path: string): ServerConfig["caps"] {
  if (value === undefined) return undefined;
  if (typeof value === "string") {
    if (value === "default" || value === "all") return value;
    v.fail(path, 'expected "default", "all", or an array of cap names');
    return undefined;
  }
  if (Array.isArray(value)) return v.optStringArray(value, path);
  v.fail(path, 'expected "default", "all", or an array of cap names');
  return undefined;
}

function validateReconnect(v: Validator, value: unknown, path: string): ReconnectOptions | undefined {
  if (value === undefined) return undefined;
  const rec = v.optRecord(value, path);
  if (!rec) return undefined;
  const out: {
    enabled?: boolean;
    initialDelayMs?: number;
    maxDelayMs?: number;
    factor?: number;
    jitter?: boolean;
    maxRetries?: number;
  } = {};
  const enabled = v.optBoolean(rec.enabled, `${path}.enabled`);
  if (enabled !== undefined) out.enabled = enabled;
  const initialDelayMs = v.optNonNegativeNumber(rec.initialDelayMs, `${path}.initialDelayMs`);
  if (initialDelayMs !== undefined) out.initialDelayMs = initialDelayMs;
  const maxDelayMs = v.optNonNegativeNumber(rec.maxDelayMs, `${path}.maxDelayMs`);
  if (maxDelayMs !== undefined) out.maxDelayMs = maxDelayMs;
  const factor = v.optNumberAtLeast(rec.factor, `${path}.factor`, 1);
  if (factor !== undefined) out.factor = factor;
  const jitter = v.optBoolean(rec.jitter, `${path}.jitter`);
  if (jitter !== undefined) out.jitter = jitter;
  const maxRetries = v.optNonNegativeInteger(rec.maxRetries, `${path}.maxRetries`);
  if (maxRetries !== undefined) out.maxRetries = maxRetries;
  return out;
}

function validateModules(
  v: Validator,
  value: unknown,
  path: string,
): Record<string, ModuleEntryConfig> {
  const out: Record<string, ModuleEntryConfig> = {};
  if (value === undefined) return out;
  const rec = v.optRecord(value, path);
  if (!rec) return out;
  for (const [name, entryRaw] of Object.entries(rec)) {
    if (UNSAFE_KEYS.has(name)) {
      v.fail(`${path}.${name}`, "is a reserved key and not allowed");
      continue;
    }
    const entry = v.optRecord(entryRaw, `${path}.${name}`);
    if (!entry) continue;
    const enabled = v.optBoolean(entry.enabled, `${path}.${name}.enabled`) ?? true;
    const { enabled: _enabled, ...options } = entry;
    out[name] = { enabled, options };
  }
  return out;
}

/**
 * Validate a raw (TOML-parsed, env-merged) object into a typed {@link BotConfig},
 * collecting every problem into a single {@link ConfigError}. `configDir` is the
 * absolute directory of the source file, threaded through for later external-module
 * resolution.
 */
export function validateConfig(raw: unknown, configDir: string): BotConfig {
  const v = new Validator();
  const root = v.requireRecord(raw, "config");

  const serverRaw = v.requireRecord(root.server, "server");
  const server: ServerConfig = {
    host: v.requireString(serverRaw.host, "server.host"),
    nick: v.requireString(serverRaw.nick, "server.nick"),
    port: v.optIntegerInRange(serverRaw.port, "server.port", 1, 65535),
    tls: validateTls(v, serverRaw.tls, "server.tls"),
    username: v.optString(serverRaw.username, "server.username"),
    realName: v.optString(serverRaw.realName, "server.realName"),
    altNicks: v.optStringArray(serverRaw.altNicks, "server.altNicks"),
    password: v.optString(serverRaw.password, "server.password"),
    sasl: validateSasl(v, serverRaw.sasl, "server.sasl"),
    caps: validateCaps(v, serverRaw.caps, "server.caps"),
    whoOnJoin: v.optBoolean(serverRaw.whoOnJoin, "server.whoOnJoin"),
    reconnect: validateReconnect(v, serverRaw.reconnect, "server.reconnect"),
  };

  const botRaw = v.optRecord(root.bot, "bot") ?? {};
  const bot: BotSettings = {
    prefix: v.optNonEmptyString(botRaw.prefix, "bot.prefix") ?? "!",
    owners: v.optStringArray(botRaw.owners, "bot.owners") ?? [],
    ignore: v.optStringArray(botRaw.ignore, "bot.ignore") ?? [],
    allowPrefixlessInPm: v.optBoolean(botRaw.allowPrefixlessInPm, "bot.allowPrefixlessInPm") ?? true,
    failOnModuleError: v.optBoolean(botRaw.failOnModuleError, "bot.failOnModuleError") ?? false,
    logLevel: (v.optEnum(botRaw.logLevel, "bot.logLevel", LOG_LEVELS) ?? "info") satisfies LogLevel,
    commandBurst: v.optIntegerInRange(botRaw.commandBurst, "bot.commandBurst", 1, 1000) ?? 5,
    commandRefillMs: v.optNonNegativeNumber(botRaw.commandRefillMs, "bot.commandRefillMs") ?? 1000,
  };

  const modules = validateModules(v, root.modules, "modules");
  const externalModules = v.optStringArray(root.externalModules, "externalModules") ?? [];

  v.throwIfAny();
  return { server, bot, modules, externalModules, configDir };
}
