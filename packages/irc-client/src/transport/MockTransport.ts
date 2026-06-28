import { Subject, type Observable } from "rxjs";
import { TransportClosedError, type Transport, type TransportClose } from "./Transport.ts";

/**
 * An in-memory {@link Transport} for tests.
 *
 * Drive inbound traffic with {@link receive} / {@link receiveLine} /
 * {@link receiveBytes}, and inspect what the client sent via {@link written}.
 * Use {@link close} for a clean local shutdown or {@link fail} to simulate an
 * abnormal drop (which errors `bytes$`).
 */
export class MockTransport implements Transport {
  readonly #bytes = new Subject<Uint8Array>();
  readonly #closed = new Subject<TransportClose>();
  readonly #encoder = new TextEncoder();
  readonly #decoder = new TextDecoder();
  #settled = false;

  /** Every payload passed to {@link write}, decoded to a UTF-8 string. */
  readonly written: string[] = [];
  /** Every payload passed to {@link write}, as raw bytes. */
  readonly writtenBytes: Uint8Array[] = [];

  readonly bytes$: Observable<Uint8Array> = this.#bytes.asObservable();
  readonly closed$: Observable<TransportClose> = this.#closed.asObservable();

  connect(): Promise<void> {
    // No-op: the mock is "connected" immediately.
    return Promise.resolve();
  }

  write(data: Uint8Array | string): void {
    const bytes = typeof data === "string" ? this.#encoder.encode(data) : data;
    this.writtenBytes.push(bytes);
    this.written.push(this.#decoder.decode(bytes));
  }

  close(): void {
    this.#settle({ local: true });
  }

  // ---- test helpers ----

  /** Push raw bytes into `bytes$`, simulating data arriving from the server. */
  receiveBytes(bytes: Uint8Array): void {
    this.#bytes.next(bytes);
  }

  /** UTF-8 encode `data` and push it into `bytes$` (no framing added). */
  receive(data: string): void {
    this.#bytes.next(this.#encoder.encode(data));
  }

  /** UTF-8 encode `line`, append CRLF, and push it into `bytes$`. */
  receiveLine(line: string): void {
    this.receive(line + "\r\n");
  }

  /** Simulate an abnormal close: error `bytes$` (so an upstream `retry` would fire). */
  fail(error: Error): void {
    this.#settle({ local: false, error });
  }

  #settle(close: TransportClose): void {
    if (this.#settled) return;
    this.#settled = true;
    this.#closed.next(close);
    this.#closed.complete();
    // Mirror BunSocketTransport exactly: complete only on a local close,
    // otherwise error bytes$ with a TransportClosedError (test fidelity for M2).
    if (close.local) {
      this.#bytes.complete();
    } else {
      this.#bytes.error(new TransportClosedError("transport closed", close.error));
    }
  }
}
