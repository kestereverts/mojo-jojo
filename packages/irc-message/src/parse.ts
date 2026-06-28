import { Tokenizer, type TokenizerOptions } from "./tokenizer/Tokenizer.ts";
import { Parser } from "./parser/Parser.ts";
import type { Message } from "./types.ts";

const encoder = new TextEncoder();
const defaultTokenizer = new Tokenizer();
const parser = new Parser();

/**
 * Parse a single raw IRC protocol line into a {@link Message}.
 *
 * Runs the full pipeline: encode (if a string) → tokenize → parse. The input is
 * one message *without* the trailing CRLF — callers split the incoming byte
 * stream on `\r\n` first. A `Uint8Array` is parsed as-is (IRC is byte-oriented);
 * a string is UTF-8 encoded internally.
 *
 * @param input - A single IRC line, e.g. `":nick!u@h PRIVMSG #chan :hello world"`.
 * @param options - Optional tokenizer limits; omit to use the shared defaults.
 * @returns The parsed intermediate representation.
 *
 * @see https://modern.ircdocs.horse/#message-format
 */
export function parseMessage(
  input: string | Uint8Array,
  options?: TokenizerOptions,
): Message {
  const buffer = typeof input === "string" ? encoder.encode(input) : input;
  const tokenizer =
    options === undefined ? defaultTokenizer : new Tokenizer(options);
  const tokens = tokenizer.tokenize(buffer);
  return parser.parse(buffer, tokens);
}
