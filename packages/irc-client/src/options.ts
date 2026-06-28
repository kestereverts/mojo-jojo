import type { ParseOptions } from "@mojo-jojo/irc-message";
import type { TransportFactory } from "./transport/Transport.ts";
import { BunSocketTransport } from "./transport/BunSocketTransport.ts";
import type { ReconnectPolicy } from "./reconnect.ts";

/** Synchronous parser backend selector (passed through to irc-message). */
export type Backend = NonNullable<ParseOptions["backend"]>;

/**
 * Curated default capability set — modern caps that are broadly supported and
 * carry no behavioural surprises. `caps: "all"` opts into everything the server
 * advertises instead. `sasl` is included but only actually requested once SASL
 * credentials are configured (M4).
 */
export const DEFAULT_CAPS: readonly string[] = [
  "cap-notify",
  "sasl",
  "message-tags",
  "server-time",
  "echo-message",
  "account-tag",
  "account-notify",
  "extended-join",
  "multi-prefix",
  "userhost-in-names",
];

/** Reconnection options (all optional; merged over {@link DEFAULT_RECONNECT}). */
export interface ReconnectOptions {
  readonly enabled?: boolean;
  readonly initialDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly factor?: number;
  readonly jitter?: boolean;
  readonly maxRetries?: number;
}

/** Default reconnection policy: exponential backoff with jitter, unlimited retries. */
export const DEFAULT_RECONNECT: ReconnectPolicy = {
  enabled: true,
  initialDelayMs: 1000,
  maxDelayMs: 30000,
  factor: 2,
  jitter: true,
  maxRetries: Infinity,
};

/** SASL configuration (the exchange itself lands in M4). */
export type SaslOptions =
  | { readonly mechanism: "PLAIN"; readonly username: string; readonly password: string }
  | { readonly mechanism: "EXTERNAL" };

/** User-facing client options. */
export interface IrcClientOptions {
  /** Server hostname. */
  readonly host: string;
  /** Server port. Defaults to 6697 with TLS, 6667 without. */
  readonly port?: number;
  /** TLS: `true`/options to enable (the default), `false` for plaintext. */
  readonly tls?: boolean | Bun.TLSOptions;
  /** Primary nickname. */
  readonly nick: string;
  /** Username / ident. Defaults to the nick. */
  readonly username?: string;
  /** Real name (GECOS). Defaults to the nick. */
  readonly realName?: string;
  /** Alternate nicks to try, in order, on `433`. */
  readonly altNicks?: readonly string[];
  /** Server password (`PASS`). */
  readonly password?: string;
  /** SASL credentials (M4). */
  readonly sasl?: SaslOptions;
  /** Capabilities to request: an explicit list, or `"all"` for everything advertised. */
  readonly caps?: readonly string[] | "all";
  /** Parser backend (default `"js-fast"`). */
  readonly backend?: Backend;
  /** Reconnection policy overrides. */
  readonly reconnect?: ReconnectOptions;
  /** Minimum gap between flood-controlled sends, in milliseconds (default 500). */
  readonly floodDelayMs?: number;
  /** Registration handshake timeout, in milliseconds (default 30000). */
  readonly registrationTimeoutMs?: number;
  /** Transport factory override — inject a `MockTransport` factory in tests. */
  readonly transport?: TransportFactory;
}

/** Fully-resolved options with every default applied (the client's internal view). */
export interface ResolvedOptions {
  readonly host: string;
  readonly port: number;
  readonly tls: boolean | Bun.TLSOptions;
  readonly nick: string;
  readonly username: string;
  readonly realName: string;
  readonly altNicks: readonly string[];
  readonly password: string | undefined;
  readonly sasl: SaslOptions | undefined;
  readonly caps: readonly string[] | "all";
  readonly backend: Backend;
  readonly reconnect: ReconnectPolicy;
  readonly floodDelayMs: number;
  readonly registrationTimeoutMs: number;
  readonly transportFactory: TransportFactory;
}

/**
 * Validate and normalize {@link IrcClientOptions}, applying every default.
 *
 * Throws on missing/empty `host` or `nick`. When no `transport` factory is
 * given, one producing {@link BunSocketTransport}s from the resolved
 * host/port/tls is synthesized.
 */
export function resolveOptions(options: IrcClientOptions): ResolvedOptions {
  if (!options.host || options.host.trim() === "") {
    throw new Error("IrcClientOptions: `host` is required");
  }
  if (!options.nick || options.nick.trim() === "") {
    throw new Error("IrcClientOptions: `nick` is required");
  }

  const tls = options.tls ?? true;
  const useTls = tls !== false;
  const port = options.port ?? (useTls ? 6697 : 6667);
  const reconnect: ReconnectPolicy = { ...DEFAULT_RECONNECT, ...options.reconnect };

  const transportFactory: TransportFactory =
    options.transport ??
    (() => new BunSocketTransport({ hostname: options.host, port, tls }));

  return {
    host: options.host,
    port,
    tls,
    nick: options.nick,
    username: options.username ?? options.nick,
    realName: options.realName ?? options.nick,
    altNicks: options.altNicks ?? [],
    password: options.password,
    sasl: options.sasl,
    caps: options.caps ?? DEFAULT_CAPS,
    backend: options.backend ?? "js-fast",
    reconnect,
    floodDelayMs: options.floodDelayMs ?? 500,
    registrationTimeoutMs: options.registrationTimeoutMs ?? 30000,
    transportFactory,
  };
}
