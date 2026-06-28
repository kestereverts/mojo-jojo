import { beforeAll, describe, expect, test } from "bun:test";
import { JsFastTokenizer } from "./JsFastTokenizer.ts";
import { loadWasmTokenizer, type WasmTokenizer } from "./wasm/loader.ts";
import { FlatParser } from "../parser/FlatParser.ts";
import { Parser } from "../parser/Parser.ts";
import { Tokenizer } from "./Tokenizer.ts";
import { SAMPLES, maxLengthLine } from "../../bench/corpus.ts";
import { enc, referenceTriples, mulberry32, randomLine } from "./_testutil.ts";
import { existsSync } from "node:fs";

// The committed .wasm artifacts. A backend is skipped (not failed) if its
// artifact hasn't been built yet, so the suite is green on a fresh checkout
// until `bun run build:wasm` runs.
const WASM_BACKENDS = [
  { name: "wasm-wat", file: "tokenizer.wat.wasm" },
  { name: "wasm-rust", file: "tokenizer.rust.wasm" },
  { name: "wasm-rust-simd", file: "tokenizer.rust-simd.wasm" },
] as const;

const wasmDir = new URL("./wasm/", import.meta.url).pathname;

for (const { name, file } of WASM_BACKENDS) {
  const built = existsSync(`${wasmDir}${file}`);

  describe.if(built)(`${name} ≡ reference`, () => {
    let tk: WasmTokenizer;
    const flatParser = new FlatParser();
    const refParser = new Parser();
    const refTk = new Tokenizer();

    beforeAll(async () => {
      tk = await loadWasmTokenizer(file);
    });

    const wasmTriples = (line: string): number[] => {
      const n = tk.tokenizeInto(enc.encode(line));
      return Array.from(tk.tokens.subarray(0, n * 3));
    };
    const parseWasm = (line: string) => {
      const n = tk.tokenizeInto(enc.encode(line));
      return flatParser.parse(tk.input, tk.tokens, n);
    };
    const parseRef = (line: string) => {
      const bytes = enc.encode(line);
      return refParser.parse(bytes, refTk.tokenize(bytes));
    };

    for (const { name: sName, line } of SAMPLES) {
      test(`triples: ${sName}`, () => {
        expect(wasmTriples(line)).toEqual(referenceTriples(line));
      });
    }

    test("triples: max-length line", () => {
      const line = maxLengthLine();
      expect(wasmTriples(line)).toEqual(referenceTriples(line));
    });

    test("triples: empty input", () => {
      expect(wasmTriples("")).toEqual(referenceTriples(""));
    });

    test("triples: differential fuzz (5000 random lines)", () => {
      const rng = mulberry32(0x9e3779b9);
      for (let i = 0; i < 5000; i++) {
        const line = randomLine(rng);
        const got = wasmTriples(line);
        const want = referenceTriples(line);
        if (got.length !== want.length || got.some((v, k) => v !== want[k])) {
          throw new Error(
            `mismatch on ${JSON.stringify(line)}\n  want ${want}\n  got  ${got}`,
          );
        }
      }
    });

    test("parsed Message: differential fuzz (3000 random lines)", () => {
      const rng = mulberry32(0xc0ffee);
      for (let i = 0; i < 3000; i++) {
        const line = randomLine(rng);
        expect(parseWasm(line)).toEqual(parseRef(line));
      }
    });
  });
}

// At least the hand-written WAT must be present, else the WASM race is untested.
test("wasm-wat artifact is built", () => {
  expect(existsSync(`${wasmDir}tokenizer.wat.wasm`)).toBe(true);
});

// A JsFast vs WASM agreement check exercises the shared FlatParser path too.
describe.if(existsSync(`${wasmDir}tokenizer.wat.wasm`))(
  "wasm-wat ≡ JsFastTokenizer (triples)",
  () => {
    let tk: WasmTokenizer;
    const js = new JsFastTokenizer();
    beforeAll(async () => {
      tk = await loadWasmTokenizer("tokenizer.wat.wasm");
    });
    test("fuzz (2000 lines)", () => {
      const rng = mulberry32(0x1357);
      for (let i = 0; i < 2000; i++) {
        const line = randomLine(rng);
        const bytes = enc.encode(line);
        const n1 = tk.tokenizeInto(bytes);
        const a = Array.from(tk.tokens.subarray(0, n1 * 3));
        const n2 = js.tokenizeInto(bytes);
        const b = Array.from(js.tokens.subarray(0, n2 * 3));
        expect(a).toEqual(b);
      }
    });
  },
);
