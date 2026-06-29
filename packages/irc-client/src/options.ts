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
  // P2/P3 dynamics (M6): keep the live view current without re-querying.
  "away-notify",
  "chghost",
  "setname",
  "batch",
  "labeled-response",
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
  /**
   * When `true`, automatically issue a {@link IrcClient.who} for each channel we
   * join, so members already present (whose `extended-join` we never saw) are
   * backfilled — accounts/realname/host/away (and, with WHOX, more). Default
   * `false`; one extra WHO per self-join, flood-queued. Best-effort: if the
   * outbound queue is full (e.g. a burst of joins) the backfill WHO is dropped
   * rather than throwing.
   */
  readonly whoOnJoin?: boolean;
  /** Parser backend (default `"js-fast"`). */
  readonly backend?: Backend;
  /** Reconnection policy overrides. */
  readonly reconnect?: ReconnectOptions;
  /** Minimum gap between flood-controlled sends, in milliseconds (default 500). */
  readonly floodDelayMs?: number;
  /** Max messages buffered in the flood queue before `send` throws (default 1024). */
  readonly maxQueueDepth?: number;
  /**
   * Active keepalive: after this many milliseconds with no inbound traffic, send
   * a `PING` to detect a half-open connection (TCP wedged with no FIN/RST, so
   * `bytes$` never errors and reconnect would never fire). Default 60000. Set to
   * `0` or `Infinity` to disable (rely only on server PINGs / transport errors).
   */
  readonly pingIntervalMs?: number;
  /**
   * How long to wait for any inbound traffic after a keepalive `PING` before
   * declaring the connection dead and forcing a reconnect. Default 30000.
   */
  readonly pingTimeoutMs?: number;
  /** Registration handshake timeout, in milliseconds (default 30000). */
  readonly registrationTimeoutMs?: number;
  /**
   * Overall deadline for the initial {@link IrcClient.connect}, in milliseconds
   * (default 60000). If registration hasn't succeeded within it — across any
   * initial reconnect attempts — `connect()` rejects and the client shuts down,
   * so `await connect()` can't hang forever on an unreachable/never-registering
   * server under the default infinite-retry policy. Use `Infinity` to opt out.
   * Only bounds the *initial* connect; once registered, reconnection is governed
   * by {@link reconnect}.
   */
  readonly connectTimeoutMs?: number;
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
  readonly whoOnJoin: boolean;
  readonly backend: Backend;
  readonly reconnect: ReconnectPolicy;
  readonly floodDelayMs: number;
  readonly maxQueueDepth: number;
  readonly pingIntervalMs: number;
  readonly pingTimeoutMs: number;
  readonly registrationTimeoutMs: number;
  readonly connectTimeoutMs: number;
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
    whoOnJoin: options.whoOnJoin ?? false,
    backend: options.backend ?? "js-fast",
    reconnect,
    floodDelayMs: options.floodDelayMs ?? 500,
    maxQueueDepth: options.maxQueueDepth ?? 1024,
    pingIntervalMs: options.pingIntervalMs ?? 60000,
    pingTimeoutMs: options.pingTimeoutMs ?? 30000,
    registrationTimeoutMs: options.registrationTimeoutMs ?? 30000,
    connectTimeoutMs: options.connectTimeoutMs ?? 60000,
    transportFactory,
  };
}
