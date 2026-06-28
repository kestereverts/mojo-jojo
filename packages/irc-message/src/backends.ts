import { Tokenizer, type TokenizerOptions } from "./tokenizer/Tokenizer.ts";
import { JsFastTokenizer } from "./tokenizer/JsFastTokenizer.ts";
import { Parser } from "./parser/Parser.ts";
import { FlatParser } from "./parser/FlatParser.ts";
import { loadWasmTokenizer } from "./tokenizer/wasm/loader.ts";
import type { Message } from "./types.ts";

/** Every selectable tokenizer backend. */
export type Backend =
  | "reference"
  | "js-fast"
  | "wasm-wat"
  | "wasm-rust"
  | "wasm-rust-simd";

const WASM_FILES: Partial<Record<Backend, string>> = {
  "wasm-wat": "tokenizer.wat.wasm",
  "wasm-rust": "tokenizer.rust.wasm",
  "wasm-rust-simd": "tokenizer.rust-simd.wasm",
};

/** A ready-to-use parser bound to one backend. */
export interface IrcParser {
  readonly backend: Backend;
  parseMessage(input: string | Uint8Array): Message;
}

export interface CreateIrcParserOptions extends TokenizerOptions {
  backend: Backend;
}

/**
 * Build a parser for any backend, including the WASM ones (which require async
 * instantiation). After the returned object is ready, `parseMessage` is
 * synchronous. All backends produce identical {@link Message}s; they differ
 * only in performance — see BENCHMARKS.md (short summary: `js-fast` is fastest
 * for typical single lines; `wasm-rust-simd` wins on large batched input with
 * long fields).
 */
export async function createIrcParser(
  options: CreateIrcParserOptions,
): Promise<IrcParser> {
  const { backend } = options;
  const encoder = new TextEncoder();
  const bytes = (input: string | Uint8Array): Uint8Array =>
    typeof input === "string" ? encoder.encode(input) : input;

  if (backend === "reference") {
    const tk = new Tokenizer(options);
    const parser = new Parser();
    return {
      backend,
      parseMessage: (input) => {
        const b = bytes(input);
        return parser.parse(b, tk.tokenize(b));
      },
    };
  }

  if (backend === "js-fast") {
    const tk = new JsFastTokenizer(options);
    const parser = new FlatParser();
    return {
      backend,
      parseMessage: (input) => {
        const b = bytes(input);
        const count = tk.tokenizeInto(b);
        return parser.parse(b, tk.tokens, count);
      },
    };
  }

  const file = WASM_FILES[backend];
  if (!file) throw new Error(`unknown backend: ${backend}`);
  const tk = await loadWasmTokenizer(file, options);
  const parser = new FlatParser();
  return {
    backend,
    parseMessage: (input) => {
      const count = tk.tokenizeInto(bytes(input));
      // triples reference offsets into the WASM-memory input view
      return parser.parse(tk.input, tk.tokens, count);
    },
  };
}
