// Single-message tokenize throughput across all backends.
//   bun run bench/tokenize.bench.ts
//
// Each backend's realistic hot path is measured: the reference produces a
// Token[]; the others fill a reusable Int32Array (js-fast) or WASM linear
// memory (wasm-*). Build the .wasm first with `bun run build:wasm`.

import { bench, group, run, summary, do_not_optimize } from "mitata";
import { existsSync } from "node:fs";
import { Tokenizer } from "../src/tokenizer/Tokenizer.ts";
import { JsFastTokenizer } from "../src/tokenizer/JsFastTokenizer.ts";
import { loadWasmTokenizer } from "../src/tokenizer/wasm/loader.ts";
import { SAMPLES, maxLengthLine } from "./corpus.ts";

const enc = new TextEncoder();
const wasmDir = new URL("../src/tokenizer/wasm/", import.meta.url).pathname;

interface Backend {
  name: string;
  run: (bytes: Uint8Array) => number;
}

const reference = new Tokenizer();
const jsFast = new JsFastTokenizer();

const backends: Backend[] = [
  { name: "reference", run: (b) => reference.tokenize(b).length },
  { name: "js-fast", run: (b) => jsFast.tokenizeInto(b) },
];

for (const { name, file } of [
  { name: "wasm-wat", file: "tokenizer.wat.wasm" },
  { name: "wasm-rust", file: "tokenizer.rust.wasm" },
  { name: "wasm-rust-simd", file: "tokenizer.rust-simd.wasm" },
]) {
  if (existsSync(`${wasmDir}${file}`)) {
    const tk = await loadWasmTokenizer(file);
    backends.push({ name, run: (b) => tk.tokenizeInto(b) });
  }
}

const samples = [
  ...SAMPLES.map((s) => ({ name: s.name, bytes: enc.encode(s.line) })),
  { name: "max-510", bytes: enc.encode(maxLengthLine()) },
];

for (const sample of samples) {
  group(`tokenize · ${sample.name} (${sample.bytes.length}B)`, () => {
    summary(() => {
      for (const b of backends) {
        bench(b.name, () => {
          do_not_optimize(b.run(sample.bytes));
        });
      }
    });
  });
}

await run();
