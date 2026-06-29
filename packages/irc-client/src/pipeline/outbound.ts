import {
  asyncScheduler,
  concat,
  concatMap,
  ignoreElements,
  of,
  Subject,
  timer,
  type SchedulerLike,
  type Subscription,
} from "rxjs";
import { buildMessage, type Message } from "@mojo-jojo/irc-message";

/** Options for {@link OutboundQueue}. */
export interface OutboundQueueOptions {
  /** Minimum gap, in milliseconds, between consecutive flood-controlled sends. */
  readonly floodDelayMs: number;
  /**
   * Scheduler driving the inter-message delay. Defaults to `asyncScheduler`;
   * tests inject a `TestScheduler` for deterministic timing.
   */
  readonly scheduler?: SchedulerLike;
  /**
   * Maximum number of messages buffered awaiting flood-controlled delivery.
   * {@link send} throws once this many are pending, so a producer that outpaces
   * the drain rate fails loudly instead of growing memory without bound and
   * delivering ever-staler messages. Defaults to {@link DEFAULT_MAX_QUEUE_DEPTH}.
   */
  readonly maxQueueDepth?: number;
}

/** Default cap on pending flood-queued messages (see {@link OutboundQueueOptions.maxQueueDepth}). */
export const DEFAULT_MAX_QUEUE_DEPTH = 1024;

/** The hard IRC line limit, including the trailing CRLF (RFC 1459/2812 §2.3). */
export const MAX_LINE_BYTES = 512;

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

/**
 * Bytes that must never appear inside a command or its params: CR and LF would
 * split the wire line into extra messages (command injection — a hostile relayed
 * text could smuggle e.g. a `KICK`), and NUL is not a legal message byte.
 */
const FORBIDDEN = /[\r\n\x00]/;
const FORBIDDEN_GLOBAL = /[\r\n\x00]/g;

function byteLength(text: string): number {
  return ENCODER.encode(text).length;
}

/** Truncate `text` to at most `maxBytes` UTF-8 bytes without splitting a codepoint. */
function truncateToBytes(text: string, maxBytes: number): string {
  const bytes = ENCODER.encode(text);
  if (bytes.length <= maxBytes) return text;
  let end = maxBytes;
  // Back up over any trailing UTF-8 continuation bytes (0b10xxxxxx).
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return DECODER.decode(bytes.subarray(0, end));
}

/**
 * The outbound side of a connection: an RxJS-driven, flood-controlled send queue
 * with a priority bypass.
 *
 * `send` enqueues a message onto a `concatMap`/`timer` pipeline that emits the
 * first message immediately and then spaces subsequent ones by at least
 * `floodDelayMs`, so a burst of channel traffic cannot trip server flood limits.
 * `sendImmediate` skips the queue entirely and writes straight to the transport
 * — used for keepalive (`PONG`) and the registration handshake, which must never
 * be throttled behind queued chat.
 *
 * Both paths guarantee **one call → exactly one wire line** within the
 * {@link MAX_LINE_BYTES} limit. `send` (the user-facing actions path) is strict:
 * a message whose serialized form contains CR/LF/NUL, or exceeds the line limit,
 * **throws** synchronously so the caller learns of the bug (and an injected
 * `\n …` can never reach the server). `sendImmediate` (internal priority traffic
 * — `PONG`, registration, `QUIT`) is lenient: it strips those bytes and truncates
 * to the limit, so keepalive and a clean disconnect can never be derailed by bad
 * input.
 *
 * One queue is owned per connection; {@link close} completes the pipeline and is
 * idempotent. After close, both send paths are no-ops.
 */
export class OutboundQueue {
  readonly #queue = new Subject<string>();
  readonly #write: (line: string) => void;
  readonly #subscription: Subscription;
  readonly #maxQueueDepth: number;
  #pending = 0;
  #closed = false;

  constructor(write: (line: string) => void, options: OutboundQueueOptions) {
    this.#write = write;
    this.#maxQueueDepth = options.maxQueueDepth ?? DEFAULT_MAX_QUEUE_DEPTH;
    const scheduler: SchedulerLike = options.scheduler ?? asyncScheduler;
    this.#subscription = this.#queue
      .pipe(
        concatMap((line) =>
          // Emit the line, then hold the queue for floodDelayMs before the next
          // one is pulled (the timer emits nothing — it is a pure spacer).
          concat(of(line), timer(options.floodDelayMs, scheduler).pipe(ignoreElements())),
        ),
      )
      .subscribe((line) => {
        this.#pending--;
        this.#write(line);
      });
  }

  /**
   * Enqueue a message for flood-controlled delivery. No-op after {@link close}.
   *
   * Throws if the serialized message would contain CR/LF/NUL or exceed the
   * {@link MAX_LINE_BYTES} line limit — these indicate a caller bug (e.g. relaying
   * unsanitized text, or an over-long message that should have been split), and
   * sending them would corrupt the protocol stream / inject commands.
   */
  send(message: Message): void {
    if (this.#closed) return;
    const body = buildMessage(message);
    if (FORBIDDEN.test(body)) {
      throw new Error(
        "OutboundQueue: message contains CR, LF, or NUL — refusing to send (would inject extra commands)",
      );
    }
    if (byteLength(body) + 2 > MAX_LINE_BYTES) {
      throw new Error(
        `OutboundQueue: message is ${byteLength(body) + 2} bytes, over the ${MAX_LINE_BYTES}-byte IRC line limit`,
      );
    }
    if (this.#pending >= this.#maxQueueDepth) {
      throw new Error(
        `OutboundQueue: send queue is full (${this.#maxQueueDepth} pending) — the send rate exceeds the flood-control drain rate`,
      );
    }
    this.#pending++;
    this.#queue.next(body + "\r\n");
  }

  /**
   * Write a message immediately, bypassing the flood queue. No-op after
   * {@link close}. Used only for internally-generated priority traffic, so it is
   * lenient: CR/LF/NUL are stripped and the line is truncated to the limit rather
   * than throwing, ensuring keepalive and `QUIT` can never be blocked by bad input.
   */
  sendImmediate(message: Message): void {
    if (this.#closed) return;
    let body = buildMessage(message).replace(FORBIDDEN_GLOBAL, "");
    if (byteLength(body) + 2 > MAX_LINE_BYTES) body = truncateToBytes(body, MAX_LINE_BYTES - 2);
    this.#write(body + "\r\n");
  }

  /** Stop the queue and release its subscription. Idempotent. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#queue.complete();
    this.#subscription.unsubscribe();
  }
}
