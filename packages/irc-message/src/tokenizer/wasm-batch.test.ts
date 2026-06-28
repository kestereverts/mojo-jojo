import { beforeAll, describe, expect, test } from "bun:test";
import { Tokenizer } from "./Tokenizer.ts";
import { loadWasmTokenizer, type WasmTokenizer } from "./wasm/loader.ts";
import { makeBatch } from "../../bench/corpus.ts";
import { enc, mulberry32, randomLine } from "./_testutil.ts";
import { existsSync } from "node:fs";

const wasmDir = new URL("./wasm/", import.meta.url).pathname;

/** Split a buffer into `[start, contentEnd)` line ranges (strip trailing \r). */
function lineRanges(bytes: Uint8Array): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let i = 0;
  while (i < bytes.length) {
    let le = i;
    while (le < bytes.length && bytes[le] !== 10) le++;
    let end = le;
    if (end > i && bytes[end - 1] === 13) end--;
    ranges.push([i, end]);
    i = le + 1;
  }
  return ranges;
}

/** Reference per-line tokenization with absolute offsets + a line table. */
function referenceBatch(bytes: Uint8Array): { triples: number[]; table: number[] } {
  const ref = new Tokenizer();
  const triples: number[] = [];
  const table: number[] = [];
  for (const [s, e] of lineRanges(bytes)) {
    const first = triples.length / 3;
    const toks = ref.tokenize(bytes, s, e);
    for (const t of toks) triples.push(t.type, t.start, t.end);
    table.push(first, toks.length);
  }
  return { triples, table };
}

for (const file of ["tokenizer.rust.wasm", "tokenizer.rust-simd.wasm"]) {
  describe.if(existsSync(`${wasmDir}${file}`))(`batch: ${file} ≡ reference`, () => {
    let tk: WasmTokenizer;
    beforeAll(async () => {
      tk = await loadWasmTokenizer(file);
    });

    const check = (bytes: Uint8Array) => {
      const r = tk.tokenizeBatchInto(bytes);
      const want = referenceBatch(bytes);
      expect(Array.from(r.tokens)).toEqual(want.triples);
      expect(Array.from(r.lineTable)).toEqual(want.table);
      expect(r.lineCount).toBe(want.table.length / 2);
    };

    test("corpus batch (cycled ×200)", () => check(enc.encode(makeBatch(200))));
    test("trailing newline", () => check(enc.encode("PING\r\nPRIVMSG #c :hi\r\n")));
    test("no trailing newline", () => check(enc.encode("PING\r\nPRIVMSG #c :hi")));
    test("blank lines", () => check(enc.encode("PING\r\n\r\nNOTICE x :y\r\n")));
    test("bare LF separators", () => check(enc.encode("PING\nNOTICE x :y\n")));

    test("differential fuzz (300 batches)", () => {
      const rng = mulberry32(0x0badf00d);
      for (let b = 0; b < 300; b++) {
        const n = 1 + ((rng() * 12) | 0);
        const lines: string[] = [];
        for (let i = 0; i < n; i++) lines.push(randomLine(rng));
        check(enc.encode(lines.join("\r\n")));
      }
    });
  });
}
