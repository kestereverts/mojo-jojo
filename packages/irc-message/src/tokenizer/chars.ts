// Byte constants and character-class predicates shared by every tokenizer
// backend (reference, JS-fast, and the WASM ports model these exactly). Kept in
// one place so the backends can never drift apart.

export const CHAR_AT = 0x40; // '@'
export const CHAR_SPACE = 0x20; // ' '
export const CHAR_PLUS = 0x2b; // '+'
export const CHAR_EQUALS = 0x3d; // '='
export const CHAR_SEMICOLON = 0x3b; // ';'
export const CHAR_COLON = 0x3a; // ':'
export const CHAR_EXCL = 0x21; // '!'

export const isTagKeyChar = (c: number): boolean =>
  c !== CHAR_EQUALS && c !== CHAR_SPACE && c !== CHAR_SEMICOLON;

export const isTagValueChar = (c: number): boolean =>
  c !== CHAR_SPACE && c !== CHAR_SEMICOLON;

export const isPrefixNameChar = (c: number): boolean =>
  c !== CHAR_SPACE && c !== CHAR_AT && c !== CHAR_EXCL;

export const isPrefixUserChar = (c: number): boolean =>
  c !== CHAR_SPACE && c !== CHAR_AT;
