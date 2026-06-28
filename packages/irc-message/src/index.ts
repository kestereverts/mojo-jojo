// Intermediate representation
export type { Message, Source, Tags } from "./types.ts";

// High-level pipeline
export { parseMessage } from "./parse.ts";
export { buildMessage } from "./build.ts";

// Tag value escaping (used internally; exposed for advanced callers)
export { escapeTagValue, unescapeTagValue } from "./escape.ts";

// Lower-level building blocks
export { Parser } from "./parser/Parser.ts";
export { Tokenizer, type TokenizerOptions } from "./tokenizer/Tokenizer.ts";
export { Token, TokenType } from "./tokenizer/Token.ts";
