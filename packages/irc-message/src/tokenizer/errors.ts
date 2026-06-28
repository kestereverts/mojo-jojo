// Lexer errors shared by every tokenizer backend, so a limit hit in the JS-fast
// or WASM tokenizers throws the exact same error type as the reference.
//
// `lastToken` is typed structurally (`{ type: number }`) rather than as the
// `Token` class: the reference passes a `Token` (which has `.type`), while the
// flat backends have no token objects and pass `undefined`.

export class LexerError extends Error {}

export class LimitExceededError extends LexerError {
  public lastToken: { type: number } | undefined;

  constructor(
    public limitName: string,
    public limitValue: number,
    public pos: number,
    lastToken?: { type: number },
  ) {
    super(
      `Exceeded ${limitName} (${limitValue}) at position ${pos}` +
        (lastToken !== null && lastToken !== undefined
          ? ` while tokenizing ${lastToken.type}`
          : "") +
        ".",
    );
    this.lastToken = lastToken;
  }
}

export class UnexpectedCharAssertionError extends LexerError {
  public lastToken: { type: number } | undefined;

  constructor(
    public pos: number,
    public char: number,
    lastToken?: { type: number },
  ) {
    super(
      `Unexpected character 0x${char.toString(16)} ('${String.fromCharCode(
        char,
      )}') at position ${pos}` +
        (lastToken !== null && lastToken !== undefined
          ? ` while tokenizing ${lastToken.type}`
          : "") +
        ".",
    );
    this.lastToken = lastToken;
  }
}
