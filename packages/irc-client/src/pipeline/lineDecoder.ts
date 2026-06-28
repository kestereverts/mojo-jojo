import { Observable, type OperatorFunction } from "rxjs";

/**
 * Upper bound on a single un-terminated line held in the decode buffer. A real
 * IRC line — even a tag-heavy IRCv3 one (~8 KB) — is far smaller; this cap exists
 * only so a server that streams bytes without ever sending a newline can't grow
 * the buffer without limit (OOM / DoS). On overflow the runaway buffer is
 * discarded and framing resynchronizes at the next newline.
 */
const MAX_LINE_CHARS = 65536;

/**
 * Splits a stream of byte chunks into complete IRC protocol lines.
 *
 * IRC frames messages with CRLF (`\r\n`). This operator:
 * - buffers partial lines across chunk boundaries;
 * - is tolerant of a bare LF (`\n`) and strips a trailing CR;
 * - decodes UTF-8 with a streaming {@link TextDecoder}, so multi-byte sequences
 *   split across chunks are reassembled correctly;
 * - drops empty lines (RFC 2812 §2.3: empty messages are silently ignored);
 * - bounds the partial-line buffer at {@link MAX_LINE_CHARS}: a newline-less
 *   stream past that is treated as garbage — the buffer is dropped and framing
 *   resyncs at the next newline, so the connection survives without OOM;
 * - discards any unterminated trailing data on completion (a partial line left
 *   by a dropped connection is never forwarded as a truncated message).
 *
 * The buffer lives in the subscription closure. Place this *before* any
 * multicast (`share`) so there is exactly one decoding buffer per connection.
 */
export function decodeLines(): OperatorFunction<Uint8Array, string> {
  return (source) =>
    new Observable<string>((subscriber) => {
      const decoder = new TextDecoder("utf-8", { fatal: false });
      let buffer = "";
      // When a line overflows the cap we drop it and skip bytes until the next
      // newline lets us realign on a fresh line.
      let resyncing = false;

      return source.subscribe({
        next: (chunk) => {
          buffer += decoder.decode(chunk, { stream: true });
          let newlineIndex = buffer.indexOf("\n");
          while (newlineIndex !== -1) {
            let line = buffer.slice(0, newlineIndex);
            buffer = buffer.slice(newlineIndex + 1);
            if (resyncing) {
              // This newline ends the discarded overflow; resume normal framing.
              resyncing = false;
            } else {
              if (line.endsWith("\r")) line = line.slice(0, -1);
              if (line.length > 0) subscriber.next(line);
            }
            newlineIndex = buffer.indexOf("\n");
          }
          // No newline in sight and the buffer is over the cap: discard it and
          // resync at the next newline rather than growing without bound.
          if (buffer.length > MAX_LINE_CHARS) {
            buffer = "";
            resyncing = true;
          }
        },
        error: (err: unknown) => subscriber.error(err),
        complete: () => subscriber.complete(),
      });
    });
}
