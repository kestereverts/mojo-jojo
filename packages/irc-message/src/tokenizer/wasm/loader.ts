import { tripleCapacity } from "../flat.ts";
import { LimitExceededError, UnexpectedCharAssertionError } from "../errors.ts";
import type { TokenizerOptions } from "../Tokenizer.ts";

/** The ABI every backend module (WAT, Rust) exports. */
interface TokenizeExports {
  memory: WebAssembly.Memory;
  tokenize(
    inPtr: number,
    inLen: number,
    outPtr: number,
    outCap: number,
    tagDataLimit: number,
    tagCountLimit: number,
    rfc1459DataLimit: number,
    paramCountLimit: number,
  ): number;
  /**
   * Free-memory base. Present on the Rust modules (whose low memory holds the
   * shadow stack + static data); absent on the WAT module, where 0 is safe.
   */
  heap_base?(): number;
  /** One-call tokenization of a CRLF-separated batch (Rust backends only). */
  tokenize_batch?(
    inPtr: number,
    inLen: number,
    outPtr: number,
    outCap: number,
    lineTablePtr: number,
    lineTableCap: number,
    tagDataLimit: number,
    tagCountLimit: number,
    rfc1459DataLimit: number,
    paramCountLimit: number,
  ): number;
}

/** Result of {@link WasmTokenizer.tokenizeBatchInto}. */
export interface BatchResult {
  /** Number of lines tokenized. */
  readonly lineCount: number;
  /** Total tokens across all lines. */
  readonly totalTokens: number;
  /** All triples, absolute offsets, lines concatenated (view into WASM mem). */
  readonly tokens: Int32Array;
  /** `[firstTokenIndex, tokenCount]` per line (view into WASM mem). */
  readonly lineTable: Int32Array;
}

/**
 * Wraps a WASM tokenizer module behind the same surface as
 * {@link JsFastTokenizer}: {@link tokenizeInto} fills linear memory and exposes
 * the triples ({@link tokens}) and the input bytes ({@link input}) as views the
 * {@link FlatParser} reads directly — no copy out of WASM memory.
 *
 * Errors returned by the module (negative status) are re-thrown as the shared
 * {@link LimitExceededError} / {@link UnexpectedCharAssertionError}, so a WASM
 * limit hit behaves exactly like the reference tokenizer.
 */
export class WasmTokenizer {
  public tagDataLimit = 8191;
  public tagCountLimit = 1000;
  public rfc1459DataLimit = 510;
  public paramCountLimit = 200;

  public count = 0;
  private readonly ex: TokenizeExports;
  private readonly mem: WebAssembly.Memory;
  /** Offset of the first byte we may use (above the module's reserved region). */
  private readonly base: number;
  private _tokens = new Int32Array(0);
  private _input = new Uint8Array(0);

  private constructor(ex: TokenizeExports, options: TokenizerOptions) {
    this.ex = ex;
    this.mem = ex.memory;
    this.base =
      typeof ex.heap_base === "function" ? (ex.heap_base() + 15) & ~15 : 0;
    if (typeof options.tagDataLimit === "number")
      this.tagDataLimit = options.tagDataLimit >>> 0;
    if (typeof options.tagCountLimit === "number")
      this.tagCountLimit = options.tagCountLimit >>> 0;
    if (typeof options.rfc1459DataLimit === "number")
      this.rfc1459DataLimit = options.rfc1459DataLimit >>> 0;
    if (typeof options.paramCountLimit === "number")
      this.paramCountLimit = options.paramCountLimit >>> 0;
  }

  public static async fromBytes(
    bytes: ArrayBuffer | Uint8Array,
    options: TokenizerOptions = {},
  ): Promise<WasmTokenizer> {
    const { instance } = await WebAssembly.instantiate(bytes, {});
    return new WasmTokenizer(
      instance.exports as unknown as TokenizeExports,
      options,
    );
  }

  /** Triples from the most recent tokenize (view into WASM memory). */
  public get tokens(): Int32Array {
    return this._tokens;
  }

  /** Input bytes of the most recent tokenize (view into WASM memory). */
  public get input(): Uint8Array {
    return this._input;
  }

  public tokenizeInto(buffer: Uint8Array): number {
    const inLen = buffer.length;
    const inOff = this.base;
    const outOff = (this.base + inLen + 3) & ~3; // 4-byte align for the Int32 view
    const outCap = tripleCapacity(inLen); // i32 slots
    const need = outOff + outCap * 4;

    if (this.mem.buffer.byteLength < need) {
      const deficit = need - this.mem.buffer.byteLength;
      this.mem.grow(Math.ceil(deficit / 65536));
    }

    const buf = this.mem.buffer;
    new Uint8Array(buf, inOff, inLen).set(buffer);

    const ret = this.ex.tokenize(
      inOff,
      inLen,
      outOff,
      outCap,
      this.tagDataLimit,
      this.tagCountLimit,
      this.rfc1459DataLimit,
      this.paramCountLimit,
    );

    if (ret < 0) {
      const err = new Int32Array(buf, outOff, 2);
      throw this.decodeError(ret, err[0]!, err[1]!);
    }

    this.count = ret;
    this._tokens = new Int32Array(buf, outOff, ret * 3);
    this._input = new Uint8Array(buf, inOff, inLen);
    return ret;
  }

  /** Tokenize and return an owned copy of the triples. */
  public tokenize(buffer: Uint8Array): { tokens: Int32Array; count: number } {
    const count = this.tokenizeInto(buffer);
    return { tokens: this._tokens.slice(), count };
  }

  /** Whether this backend supports {@link tokenizeBatchInto}. */
  public get supportsBatch(): boolean {
    return typeof this.ex.tokenize_batch === "function";
  }

  /**
   * Tokenize a CRLF-separated batch in a single WASM call — the path where the
   * boundary cost is amortized across many lines. Views into WASM memory are
   * returned; consume before the next call.
   */
  public tokenizeBatchInto(buffer: Uint8Array): BatchResult {
    const batch = this.ex.tokenize_batch;
    if (typeof batch !== "function") {
      throw new Error("this backend does not support batch tokenization");
    }
    const inLen = buffer.length;
    const inOff = this.base;
    const outOff = (this.base + inLen + 3) & ~3;
    const outCap = (inLen * 3 + 64) * 3; // i32 slots, generous upper bound
    let lineUB = 1;
    for (let i = 0; i < inLen; i++) if (buffer[i] === 10) lineUB++;
    const tableOff = (outOff + outCap * 4 + 3) & ~3;
    const need = tableOff + lineUB * 8;

    if (this.mem.buffer.byteLength < need) {
      const deficit = need - this.mem.buffer.byteLength;
      this.mem.grow(Math.ceil(deficit / 65536));
    }

    const buf = this.mem.buffer;
    new Uint8Array(buf, inOff, inLen).set(buffer);

    const ret = batch(
      inOff,
      inLen,
      outOff,
      outCap,
      tableOff,
      lineUB,
      this.tagDataLimit,
      this.tagCountLimit,
      this.rfc1459DataLimit,
      this.paramCountLimit,
    );
    if (ret < 0) {
      const err = new Int32Array(buf, outOff, 2);
      throw this.decodeError(ret, err[0]!, err[1]!);
    }

    const lineCount = ret;
    const lineTable = new Int32Array(buf, tableOff, lineCount * 2);
    const totalTokens =
      lineCount === 0
        ? 0
        : lineTable[(lineCount - 1) * 2]! + lineTable[(lineCount - 1) * 2 + 1]!;
    this._input = new Uint8Array(buf, inOff, inLen);
    return {
      lineCount,
      totalTokens,
      tokens: new Int32Array(buf, outOff, totalTokens * 3),
      lineTable,
    };
  }

  private decodeError(code: number, pos: number, char: number): Error {
    switch (code) {
      case -1:
        return new LimitExceededError("tagDataLimit", this.tagDataLimit, pos);
      case -2:
        return new LimitExceededError("tagCountLimit", this.tagCountLimit, pos);
      case -3:
        return new LimitExceededError(
          "rfc1459DataLimit",
          this.rfc1459DataLimit,
          pos,
        );
      case -4:
        return new LimitExceededError(
          "paramCountLimit",
          this.paramCountLimit,
          pos,
        );
      case -5:
        return new UnexpectedCharAssertionError(pos, char);
      default:
        return new Error(`tokenizer returned unknown status ${code}`);
    }
  }
}

/** Load a `.wasm` file (relative to this module) into a {@link WasmTokenizer}. */
export async function loadWasmTokenizer(
  fileName: string,
  options: TokenizerOptions = {},
): Promise<WasmTokenizer> {
  const url = new URL(`./${fileName}`, import.meta.url);
  const bytes = await Bun.file(url).arrayBuffer();
  return WasmTokenizer.fromBytes(bytes, options);
}
