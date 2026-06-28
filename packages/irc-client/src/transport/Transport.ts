import type { Observable } from "rxjs";

/**
 * A close/disconnect notification from the underlying transport.
 *
 * `local` distinguishes a deliberate {@link Transport.close} from a remote or
 * error-driven shutdown — the reconnection layer (M2) uses this to decide
 * whether to retry.
 */
export interface TransportClose {
  /** True when the close was requested locally via {@link Transport.close}. */
  readonly local: boolean;
  /** Underlying error when the connection closed abnormally. */
  readonly error?: Error;
}

/**
 * A bidirectional byte transport for a single IRC connection.
 *
 * Implementations bridge a concrete socket (Bun TCP/TLS, a WebSocket, an
 * in-memory mock) into RxJS streams. The transport is deliberately
 * byte-oriented: line framing (CRLF) is the pipeline's concern (see
 * `decodeLines`), not the transport's.
 *
 * Lifecycle contract for `bytes$`:
 * - emits inbound chunks as they arrive;
 * - **completes** when the connection is closed locally via {@link close};
 * - **errors** when the connection drops abnormally (remote close / socket
 *   error), so an upstream `retry` can trigger a reconnect.
 *
 * `closed$` always emits exactly one {@link TransportClose} describing how the
 * connection ended, then completes — regardless of local vs. abnormal close.
 */
export interface Transport {
  /** Inbound bytes from the peer. Hot; completes or errors when the connection closes. */
  readonly bytes$: Observable<Uint8Array>;
  /** Emits once when the connection closes, then completes. */
  readonly closed$: Observable<TransportClose>;
  /** Open the connection. Resolves once connected (after the TLS handshake when applicable). */
  connect(): Promise<void>;
  /** Queue bytes (or a UTF-8 string) for sending to the peer. */
  write(data: Uint8Array | string): void;
  /** Close the connection locally. Idempotent. */
  close(): void;
}

/** Produces a fresh {@link Transport} per connection attempt (used by the reconnect layer). */
export type TransportFactory = () => Transport;

/**
 * Raised on `bytes$` when a transport closes abnormally (remote close or socket
 * error). Part of the abstract transport contract so every implementation —
 * {@link Transport} backends and test doubles alike — signals abnormal closure
 * the same way; the reconnection layer (M2) keys off this type.
 */
export class TransportClosedError extends Error {
  override readonly cause?: Error;
  constructor(message: string, cause?: Error) {
    super(message);
    this.name = "TransportClosedError";
    this.cause = cause;
  }
}
