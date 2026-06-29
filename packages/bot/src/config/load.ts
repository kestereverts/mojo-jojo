import * as path from "node:path";
import { applyEnvOverrides, type Env } from "./env.ts";
import { ConfigError, validateConfig } from "./validate.ts";
import type { BotConfig } from "./schema.ts";

/** `Bun.TOML` is present at runtime but absent from `@types/bun`; access it through this shape. */
interface TomlNamespace {
  parse(input: string): unknown;
}

function parseToml(input: string): unknown {
  return (Bun as unknown as { TOML: TomlNamespace }).TOML.parse(input);
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
    raw = parseToml(text);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new ConfigError([`config: invalid TOML in "${resolvedPath}": ${detail}`]);
  }

  const merged = applyEnvOverrides(raw, env);
  return validateConfig(merged, path.dirname(resolvedPath));
}
