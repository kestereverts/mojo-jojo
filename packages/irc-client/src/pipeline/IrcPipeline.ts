import { map, share, type Observable } from "rxjs";
import { parseMessage, type Message, type ParseOptions } from "@mojo-jojo/irc-message";
import type { Transport } from "../transport/Transport.ts";
import { decodeLines } from "./lineDecoder.ts";

/** Options for {@link createMessageStream}. */
export interface IrcPipelineOptions {
  /** Synchronous parser backend passed to irc-message. Defaults to `"js-fast"`. */
  readonly backend?: ParseOptions["backend"];
}

/**
 * Builds the inbound message stream for a transport:
 *
 * ```text
 * transport.bytes$ -> decodeLines() -> parseMessage() -> share()
 * ```
 *
 * The result is hot and multicast (`share`), so each line is decoded and parsed
 * exactly once no matter how many subscribers attach (the state store, per-entity
 * streams, raw-message listeners, …). The stream completes or errors with the
 * transport's `bytes$`.
 *
 * Sharing semantics: `share()` reference-counts and resets when the subscriber
 * count drops to zero, so the single decoding buffer lives only while at least
 * one subscriber is attached — if all unsubscribe mid-line and a new subscriber
 * later attaches, the source is re-subscribed and the buffer starts fresh. From
 * M2 onward the client owns a long-lived subscription for the connection's
 * lifetime, so the buffer persists for as long as the connection is open.
 */
export function createMessageStream(
  transport: Transport,
  options: IrcPipelineOptions = {},
): Observable<Message> {
  const backend = options.backend ?? "js-fast";
  return transport.bytes$.pipe(
    decodeLines(),
    map((line) => parseMessage(line, { backend })),
    share(),
  );
}
