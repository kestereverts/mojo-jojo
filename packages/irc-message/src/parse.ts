import { Tokenizer, type TokenizerOptions } from "./tokenizer/Tokenizer.ts";
import { JsFastTokenizer } from "./tokenizer/JsFastTokenizer.ts";
import { Parser } from "./parser/Parser.ts";
import { FlatParser } from "./parser/FlatParser.ts";
import type { Message } from "./types.ts";

/** Synchronous tokenizer backends usable from {@link parseMessage}. */
export type SyncBackend = "reference" | "js-fast";

/** Options for {@link parseMessage}: tokenizer limits plus a backend choice. */
export interface ParseOptions extends TokenizerOptions {
  /**
   * Which tokenizer to run. `js-fast` (default) is an allocation-free port of
   * `reference` and the fastest backend for typical IRC lines; `reference` is
   * the original object-emitting tokenizer (the correctness oracle). Both
   * produce identical messages. WASM backends are available via
   * {@link createIrcParser}.
   */
  backend?: SyncBackend;
}

const encoder = new TextEncoder();
const refTokenizer = new Tokenizer();
const refParser = new Parser();
const fastTokenizer = new JsFastTokenizer();
const flatParser = new FlatParser();

function hasLimits(o?: ParseOptions): boolean {
  return (
    !!o &&
    (o.tagDataLimit !== undefined ||
      o.tagCountLimit !== undefined ||
      o.rfc1459DataLimit !== undefined ||
      o.paramCountLimit !== undefined)
  );
}

/**
 * Parse a single raw IRC protocol line into a {@link Message}.
 *
 * Runs the full pipeline: encode (if a string) → tokenize → parse. The input is
 * one message *without* the trailing CRLF — callers split the incoming byte
 * stream on `\r\n` first. A `Uint8Array` is parsed as-is (IRC is byte-oriented);
 * a string is UTF-8 encoded internally.
 *
 * @param input - A single IRC line, e.g. `":nick!u@h PRIVMSG #chan :hello world"`.
 * @param options - Optional tokenizer limits and `backend` choice.
 * @returns The parsed intermediate representation.
 *
 * @see https://modern.ircdocs.horse/#message-format
 */
export function parseMessage(
  input: string | Uint8Array,
  options?: ParseOptions,
): Message {
  const buffer = typeof input === "string" ? encoder.encode(input) : input;

  if (options?.backend === "reference") {
    const tk = hasLimits(options) ? new Tokenizer(options) : refTokenizer;
    return refParser.parse(buffer, tk.tokenize(buffer));
  }

  const tk = hasLimits(options) ? new JsFastTokenizer(options) : fastTokenizer;
  const count = tk.tokenizeInto(buffer);
  return flatParser.parse(buffer, tk.tokens, count);
}
