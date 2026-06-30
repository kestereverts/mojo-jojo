import type { ReconnectOptions, SaslOptions } from "@mojo-jojo/irc-client";

/** TLS options expressible from TOML (a subset of `Bun.TLSOptions`). */
export interface TlsOptionsConfig {
  readonly rejectUnauthorized?: boolean;
}

/** `tls = true | false`, or a `[server.tls]` table. */
export type TlsConfig = boolean | TlsOptionsConfig;

/** Logging verbosity. */
export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

/** `[server]` block — maps onto {@link IrcClientOptions}. */
export interface ServerConfig {
  readonly host: string;
  readonly nick: string;
  readonly port?: number;
  readonly tls?: TlsConfig;
  readonly username?: string;
  readonly realName?: string;
  readonly altNicks?: readonly string[];
  /** Server password. Supported in-file but discouraged — prefer the `IRC_PASSWORD` env (which overrides this). */
  readonly password?: string;
  /** SASL credentials. The PLAIN password is discouraged in-file — prefer `IRC_SASL_USER`/`IRC_SASL_PASS` (env overrides). */
  readonly sasl?: SaslOptions;
  /** `"default"` (omit, use the client's curated default caps), `"all"`, or an explicit list. */
  readonly caps?: "default" | "all" | readonly string[];
  readonly whoOnJoin?: boolean;
  readonly reconnect?: ReconnectOptions;
}

/** `[bot]` block — framework-level settings. */
export interface BotSettings {
  readonly prefix: string;
  /** Owner matchers: `account:<name>`, `mask:<nick!user@host>`, or a bare nick. */
  readonly owners: readonly string[];
  /** Ignore matchers (same forms as owners); matched senders are dropped before dispatch. */
  readonly ignore: readonly string[];
  readonly allowPrefixlessInPm: boolean;
  /** When `true`, a module that fails to load aborts startup; otherwise it is skipped + warned. */
  readonly failOnModuleError: boolean;
  readonly logLevel: LogLevel;
  /** Per-sender command rate limit: max instantaneous burst of commands. */
  readonly commandBurst: number;
  /** Per-sender command rate limit: milliseconds to regain one command token (0 disables). */
  readonly commandRefillMs: number;
}

/** One `[modules.<name>]` entry: an enabled flag plus the module's opaque option slice. */
export interface ModuleEntryConfig {
  readonly enabled: boolean;
  readonly options: Record<string, unknown>;
}

/** Fully-validated bot configuration. */
export interface BotConfig {
  readonly server: ServerConfig;
  readonly bot: BotSettings;
  readonly modules: Readonly<Record<string, ModuleEntryConfig>>;
  /**
   * RAW external module specifiers exactly as written in config (relative paths or
   * package specifiers). These must NOT be `import()`ed directly — a relative path
   * would resolve against the importing module, not the config file. Pass each through
   * `resolveExternalSpecifier(spec, configDir)` first (done by the module loader in M2).
   */
  readonly externalModules: readonly string[];
  /** Absolute directory of the loaded config file — the base for resolving relative module paths. */
  readonly configDir: string;
}
