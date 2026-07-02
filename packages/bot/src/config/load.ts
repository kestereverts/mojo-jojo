import * as path from "node:path";
import { applyEnvOverrides, type Env } from "./env.ts";
import { ConfigError, validateConfig } from "./validate.ts";
import type { BotConfig } from "./schema.ts";
import { errorMessage } from "../util/errors.ts";

/** `Bun.TOML` is present at runtime but absent from `@types/bun`; access it through this shape. */
interface TomlNamespace {
  parse(input: string): unknown;
}

function parseToml(input: string): unknown {
  return (Bun as unknown as { TOML: TomlNamespace }).TOML.parse(input);
}

/** Keys that would pollute a prototype rather than create an own property. */
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Recursively drop prototype-polluting own-keys from the parsed config, once, at
 * the boundary. Every downstream consumer (validators, module option slices,
 * user-keyed tables) then works with safe objects for free, instead of each one
 * re-deriving the `Object.create(null)` / reserved-key defence by hand.
 */
function stripUnsafeKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripUnsafeKeys);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      if (UNSAFE_KEYS.has(key)) continue;
      out[key] = stripUnsafeKeys(v);
    }
    return out;
  }
  return value;
}

/**
 * Load and validate a bot config from a TOML file.
 *
 * Resolution order for the path: explicit argument → `BOT_CONFIG` env →
 * `./config.toml`. The file is parsed, environment overrides are merged in
 * (env wins for secrets), and the result is validated into a typed
 * {@link BotConfig}. A missing/unreadable file or invalid TOML throws
 * {@link ConfigError} (fail-fast); validation problems throw a single
 * {@link ConfigError} listing every issue.
 */
export async function loadConfig(
  configPath?: string,
  env: Env = process.env,
): Promise<BotConfig> {
  const resolvedPath = path.resolve(configPath ?? env.BOT_CONFIG ?? "./config.toml");

  let text: string;
  try {
    text = await Bun.file(resolvedPath).text();
  } catch {
    throw new ConfigError([`config: cannot read config file "${resolvedPath}"`]);
  }

  let raw: unknown;
  try {
    raw = stripUnsafeKeys(parseToml(text));
  } catch (cause) {
    throw new ConfigError([`config: invalid TOML in "${resolvedPath}": ${errorMessage(cause)}`]);
  }

  const merged = applyEnvOverrides(raw, env);
  return validateConfig(merged, path.dirname(resolvedPath));
}
