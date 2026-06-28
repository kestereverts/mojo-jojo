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
}

/** Serialize a message to a complete wire line (CRLF included). */
function serialize(message: Message): string {
  return buildMessage(message) + "\r\n";
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
 * One queue is owned per connection; {@link close} completes the pipeline and is
 * idempotent. After close, both send paths are no-ops.
 */
export class OutboundQueue {
  readonly #queue = new Subject<Message>();
  readonly #write: (line: string) => void;
  readonly #subscription: Subscription;
  #closed = false;

  constructor(write: (line: string) => void, options: OutboundQueueOptions) {
    this.#write = write;
    const scheduler: SchedulerLike = options.scheduler ?? asyncScheduler;
    this.#subscription = this.#queue
      .pipe(
        concatMap((message) =>
          // Emit the message, then hold the queue for floodDelayMs before the
          // next one is pulled (the timer emits nothing — it is a pure spacer).
          concat(of(message), timer(options.floodDelayMs, scheduler).pipe(ignoreElements())),
        ),
      )
      .subscribe((message) => this.#write(serialize(message)));
  }

  /** Enqueue a message for flood-controlled delivery. No-op after {@link close}. */
  send(message: Message): void {
    if (this.#closed) return;
    this.#queue.next(message);
  }

  /** Write a message immediately, bypassing the flood queue. No-op after {@link close}. */
  sendImmediate(message: Message): void {
    if (this.#closed) return;
    this.#write(serialize(message));
  }

  /** Stop the queue and release its subscription. Idempotent. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#queue.complete();
    this.#subscription.unsubscribe();
  }
}
