// Flat token representation shared by the fast (non-reference) backends.
//
// Instead of one heap-allocated `Token` object per token, a tokenizer writes
// interleaved `[type, start, end]` triples into a single `Int32Array`. This is
// the common currency the JS-fast and all WASM backends speak, so the parser
// and the cross-backend parity tests treat them identically.

/** A tokenized result: `count` triples packed into `tokens`. */
export interface TokenArray {
  /** Interleaved `[type, start, end] * count`. May be longer than `count * 3`. */
  readonly tokens: Int32Array;
  /** Number of tokens (each is 3 int32 slots). */
  readonly count: number;
}

/**
 * Worst-case triple capacity (in int32 slots) for an input of `byteLen` bytes.
 *
 * Token count is bounded by roughly the byte length (most tokens consume at
 * least one byte; a few marker/terminal tokens can briefly emit two per byte),
 * so `byteLen * 2 + 16` tokens is a safe upper bound. ×3 for the slots.
 */
export function tripleCapacity(byteLen: number): number {
  return (byteLen * 2 + 16) * 3;
}
