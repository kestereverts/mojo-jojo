import type { SaslOptions } from "@mojo-jojo/irc-client";
import { ConfigError, isRecord } from "./validate.ts";
import type { TlsConfig } from "./schema.ts";

/** Process-environment shape (a subset of `process.env`). */
export type Env = Record<string, string | undefined>;

function parseEnvBool(value: string, name: string): boolean {
  const t = value.trim().toLowerCase();
  if (t === "1" || t === "true") return true;
  if (t === "0" || t === "false") return false;
  // A set-but-empty value is ambiguous — fail loud rather than silently treating
  // it as `false` (e.g. an empty `IRC_TLS=` must not quietly downgrade to plaintext
  // and send credentials in the clear).
  throw new ConfigError([`${name}: expected a boolean (1/true or 0/false), got "${value}"`]);
}

function parseEnvInt(value: string, name: string): number {
  // `Number("")`/`Number("  ")` are 0, so guard blank input explicitly.
  const n = value.trim() === "" ? NaN : Number(value);
  if (!Number.isInteger(n)) {
    throw new ConfigError([`${name}: expected an integer, got "${value}"`]);
  }
  return n;
}

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Resolve the TLS override from `IRC_TLS` / `IRC_TLS_INSECURE`:
 * - `IRC_TLS_INSECURE` truthy ⇒ `{ rejectUnauthorized: false }` (TLS on, no cert check),
 *   unless `IRC_TLS` is explicitly false (plaintext wins).
 * - otherwise the boolean value of `IRC_TLS`, or `undefined` (no override).
 */
function resolveEnvTls(env: Env): TlsConfig | undefined {
  const tlsRaw = env.IRC_TLS;
  const insecureRaw = env.IRC_TLS_INSECURE;
  const base = tlsRaw !== undefined ? parseEnvBool(tlsRaw, "IRC_TLS") : undefined;
  const insecure = insecureRaw !== undefined ? parseEnvBool(insecureRaw, "IRC_TLS_INSECURE") : undefined;
  if (insecure === true) return base === false ? false : { rejectUnauthorized: false };
  return base;
}

function resolveEnvSasl(env: Env): SaslOptions | undefined {
  const username = env.IRC_SASL_USER;
  const password = env.IRC_SASL_PASS;
  if (username === undefined && password === undefined) return undefined;
  if (username === undefined || password === undefined) {
    throw new ConfigError([
      "IRC_SASL_USER/IRC_SASL_PASS: both must be set together for SASL PLAIN",
    ]);
  }
  return { mechanism: "PLAIN", username, password };
}

/**
 * Merge environment-variable overrides over the raw (TOML-parsed) config. Env
 * **wins** for the values it covers — secrets above all. Returns a new object;
 * the input is not mutated. Malformed env values (bad boolean/integer tokens,
 * a half-specified SASL pair) throw {@link ConfigError} immediately.
 */
export function applyEnvOverrides(raw: unknown, env: Env): Record<string, unknown> {
  const root: Record<string, unknown> = isRecord(raw) ? { ...raw } : {};
  const server: Record<string, unknown> = isRecord(root.server) ? { ...root.server } : {};
  const bot: Record<string, unknown> = isRecord(root.bot) ? { ...root.bot } : {};

  if (env.IRC_HOST !== undefined) server.host = env.IRC_HOST;
  if (env.IRC_NICK !== undefined) server.nick = env.IRC_NICK;
  if (env.IRC_PORT !== undefined) server.port = parseEnvInt(env.IRC_PORT, "IRC_PORT");

  const tls = resolveEnvTls(env);
  if (tls !== undefined) server.tls = tls;

  if (env.IRC_PASSWORD !== undefined) server.password = env.IRC_PASSWORD;

  const sasl = resolveEnvSasl(env);
  if (sasl !== undefined) {
    // Env SASL credentials are PLAIN. If the file explicitly configured a
    // different mechanism (e.g. cert-based EXTERNAL), silently replacing it with
    // PLAIN would be a security downgrade — fail loud and make the operator choose.
    const fileMech = isRecord(server.sasl) ? server.sasl.mechanism : undefined;
    if (fileMech !== undefined && fileMech !== "PLAIN") {
      throw new ConfigError([
        `IRC_SASL_USER/IRC_SASL_PASS supply PLAIN credentials, but [server.sasl] sets ` +
          `mechanism = "${String(fileMech)}". Remove the env vars or set mechanism = "PLAIN".`,
      ]);
    }
    server.sasl = sasl;
  }

  if (env.BOT_PREFIX !== undefined) bot.prefix = env.BOT_PREFIX;
  if (env.BOT_OWNERS !== undefined) bot.owners = splitList(env.BOT_OWNERS);

  root.server = server;
  root.bot = bot;
  return root;
}
