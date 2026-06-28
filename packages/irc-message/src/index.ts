// Intermediate representation
export type { Message, Source, Tags } from "./types.ts";

// High-level pipeline
export { parseMessage } from "./parse.ts";
export type { ParseOptions, SyncBackend } from "./parse.ts";
export { buildMessage } from "./build.ts";

// Backend switching (incl. async WASM backends)
export { createIrcParser } from "./backends.ts";
export type { Backend, IrcParser, CreateIrcParserOptions } from "./backends.ts";

// Tag value escaping (used internally; exposed for advanced callers)
export { escapeTagValue, unescapeTagValue } from "./escape.ts";

// Lower-level building blocks
export { Parser } from "./parser/Parser.ts";
export { FlatParser } from "./parser/FlatParser.ts";
export { Tokenizer, type TokenizerOptions } from "./tokenizer/Tokenizer.ts";
export { JsFastTokenizer } from "./tokenizer/JsFastTokenizer.ts";
export { Token, TokenType } from "./tokenizer/Token.ts";
export type { TokenArray } from "./tokenizer/flat.ts";
export {
  LexerError,
  LimitExceededError,
  UnexpectedCharAssertionError,
} from "./tokenizer/errors.ts";
export {
  WasmTokenizer,
  loadWasmTokenizer,
  type BatchResult,
} from "./tokenizer/wasm/loader.ts";
