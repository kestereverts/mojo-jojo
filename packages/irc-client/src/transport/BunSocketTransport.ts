import { Subject, type Observable } from "rxjs";
import { TransportClosedError, type Transport, type TransportClose } from "./Transport.ts";

/**
 * The subset of `Bun.connect` that {@link BunSocketTransport} needs. Injectable
 * via {@link BunSocketTransportOptions.connector} so the socket-callback → stream
 * mapping can be unit-tested without opening a real socket.
 */
export type SocketConnector = (options: Bun.TCPSocketConnectOptions) => Promise<Bun.Socket>;

/** Connection parameters for {@link BunSocketTransport}. */
export interface BunSocketTransportOptions {
  /** Server hostname to connect to. */
  readonly hostname: string;
  /** Server port to connect to. */
  readonly port: number;
  /**
   * TLS configuration: `true` for default TLS, a `Bun.TLSOptions` object for
   * custom TLS, or omitted/`false` for a plaintext connection.
   */
  readonly tls?: boolean | Bun.TLSOptions;
  /** Connector to use (defaults to `Bun.connect`); primarily a test seam. */
  readonly connector?: SocketConnector;
}

/**
 * A {@link Transport} backed by a Bun TCP/TLS socket (`Bun.connect`).
 *
 * Bun's socket callbacks are bridged into RxJS Subjects. Inbound `data` is
 * forwarded verbatim as bytes; the pipeline performs line framing. Per the
 * {@link Transport} contract, `bytes$` **completes** only on a local
 * {@link close}; any other end (remote close/FIN, socket error, connect error)
 * **errors** `bytes$` with a {@link TransportClosedError} so an upstream `retry`
 * can reconnect. The instance is single-use: construct a new one per attempt.
 */
export class BunSocketTransport implements Transport {
  readonly #options: BunSocketTransportOptions;
  readonly #connector: SocketConnector;
  readonly #bytes = new Subject<Uint8Array>();
  readonly #closed = new Subject<TransportClose>();
  #socket: Bun.Socket | null = null;
  #closing = false;
  #settled = false;

  readonly bytes$: Observable<Uint8Array> = this.#bytes.asObservable();
  readonly closed$: Observable<TransportClose> = this.#closed.asObservable();

  constructor(options: BunSocketTransportOptions) {
    this.#options = options;
    this.#connector = options.connector ?? ((opts) => Bun.connect(opts));
  }

  async connect(): Promise<void> {
    if (this.#socket) throw new Error("BunSocketTransport: already connected");
    const { hostname, port, tls } = this.#options;
    const useTls = tls !== undefined && tls !== false;

    // Bun silently drops writes issued before the TLS handshake completes, so for
    // a TLS connection we must not report ready (resolve connect()) until the
    // `handshake` callback fires — otherwise the very first registration burst is
    // written into the void and the server times us out. Plaintext is writable as
    // soon as the connector resolves, so it keeps the prior behaviour (no gate).
    let markReady: (error?: Error) => void = () => {};
    const ready: Promise<void> = useTls
      ? new Promise<void>((resolve, reject) => {
          markReady = (error) => (error ? reject(error) : resolve());
        })
      : Promise.resolve();
    ready.catch(() => {}); // pre-empt an unhandled rejection if connect() throws first

    let socket: Bun.Socket;
    try {
      socket = await this.#connector({
        hostname,
        port,
        tls: tls ?? false,
        socket: {
          data: (_socket, data) => {
            this.#bytes.next(data);
          },
          // TLS only: the connection is writable once the handshake succeeds.
          handshake: (_socket, success, verifyError) => {
            if (success) {
              markReady();
            } else {
              const error =
                verifyError instanceof Error ? verifyError : new Error("TLS handshake failed");
              this.#settle({ local: false, error });
              markReady(error);
            }
          },
          // A remote close/FIN we did not initiate is abnormal: carry any error
          // arg and let #settle decide (local => complete, otherwise => error).
          close: (_socket, error) => {
            this.#settle(error ? { local: this.#closing, error } : { local: this.#closing });
            markReady(error ?? new Error("connection closed before it was ready"));
          },
          end: () => {
            this.#settle({ local: this.#closing });
            markReady(new Error("connection ended before it was ready"));
          },
          error: (_socket, error) => {
            this.#settle({ local: false, error });
            markReady(error);
          },
          connectError: (_socket, error) => {
            this.#settle({ local: false, error });
            markReady(error);
          },
        },
      });
    } catch (error) {
      // The connect attempt failed (e.g. DNS/refused). `connectError` usually
      // fires first and settles us; #settle's guard makes this idempotent. If a
      // connector rejects *without* firing connectError, settle here so the
      // streams never dangle. Re-throw so the caller's connect() still rejects.
      const err = error instanceof Error ? error : new Error(String(error));
      this.#settle({ local: false, error: err });
      markReady(err);
      throw error;
    }
    this.#socket = socket;
    // close() may have been called while the connect promise was in flight;
    // honour it now so we never leak a live socket past teardown.
    if (this.#closing) socket.end();
    // Block until the socket can actually send. For plaintext this is already
    // resolved; for TLS it waits for the handshake (or rejects if it fails).
    await ready;
  }

  write(data: Uint8Array | string): void {
    const socket = this.#socket;
    if (!socket) throw new Error("BunSocketTransport: write before connect");
    socket.write(data);
  }

  close(): void {
    this.#closing = true;
    this.#socket?.end();
  }

  #settle(close: TransportClose): void {
    if (this.#settled) return;
    this.#settled = true;
    this.#closed.next(close);
    this.#closed.complete();
    if (close.local) {
      this.#bytes.complete();
    } else {
      this.#bytes.error(new TransportClosedError("transport closed", close.error));
    }
  }
}
