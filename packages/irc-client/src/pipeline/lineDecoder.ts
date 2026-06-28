import { Observable, type OperatorFunction } from "rxjs";

/**
 * Splits a stream of byte chunks into complete IRC protocol lines.
 *
 * IRC frames messages with CRLF (`\r\n`). This operator:
 * - buffers partial lines across chunk boundaries;
 * - is tolerant of a bare LF (`\n`) and strips a trailing CR;
 * - decodes UTF-8 with a streaming {@link TextDecoder}, so multi-byte sequences
 *   split across chunks are reassembled correctly;
 * - drops empty lines (RFC 2812 §2.3: empty messages are silently ignored);
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

      return source.subscribe({
        next: (chunk) => {
          buffer += decoder.decode(chunk, { stream: true });
          let newlineIndex = buffer.indexOf("\n");
          while (newlineIndex !== -1) {
            let line = buffer.slice(0, newlineIndex);
            if (line.endsWith("\r")) line = line.slice(0, -1);
            buffer = buffer.slice(newlineIndex + 1);
            if (line.length > 0) subscriber.next(line);
            newlineIndex = buffer.indexOf("\n");
          }
        },
        error: (err: unknown) => subscriber.error(err),
        complete: () => subscriber.complete(),
      });
    });
}
