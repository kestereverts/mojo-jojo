import { filter, map, share, type Observable } from "rxjs";
import { parseMessage, type Message, type ParseOptions } from "@mojo-jojo/irc-message";
import type { Transport } from "../transport/Transport.ts";
import { decodeLines } from "./lineDecoder.ts";

/** Options for {@link createMessageStream}. */
export interface IrcPipelineOptions {
  /** Synchronous parser backend passed to irc-message. Defaults to `"js-fast"`. */
  readonly backend?: ParseOptions["backend"];
  /**
   * Called when a single inbound line fails to parse (malformed or over-length).
   * The offending line is dropped and the stream continues; without a handler the
   * line is silently skipped. The connection is NOT torn down — only a transport
   * error ends the stream.
   */
  readonly onParseError?: (error: unknown, line: string) => void;
}

/** Sentinel for a line that failed to parse (filtered out before `share`). */
const PARSE_FAILED = Symbol("parse-failed");

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
 * **Parse-fault isolation:** a line that `parseMessage` rejects (malformed, or
 * over the 510-byte limit) is dropped and reported via {@link IrcPipelineOptions.onParseError}
 * — it does NOT error the stream. Otherwise a single bad line from a buggy or
 * hostile server would tear the connection down (and, with reconnect on, loop).
 * Only a genuine transport error ends the stream and triggers reconnect.
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
  const onParseError = options.onParseError;
  return transport.bytes$.pipe(
    decodeLines(),
    map((line): Message | typeof PARSE_FAILED => {
      try {
        return parseMessage(line, { backend });
      } catch (error) {
        onParseError?.(error, line);
        return PARSE_FAILED;
      }
    }),
    filter((message): message is Message => message !== PARSE_FAILED),
    share(),
  );
}
