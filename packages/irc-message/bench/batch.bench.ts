// Batch tokenize throughput: many CRLF-separated lines.
//   bun run bench/batch.bench.ts
//
// This is where WASM should win: a single `tokenize_batch` call amortizes the
// JS↔WASM boundary across thousands of lines, and SIMD scans the bulk. The
// "(loop)" variants tokenize line-by-line for contrast (N boundary crossings
// for the WASM ones).

import { bench, group, run, summary, do_not_optimize } from "mitata";
import { existsSync } from "node:fs";
import { Tokenizer } from "../src/tokenizer/Tokenizer.ts";
import { JsFastTokenizer } from "../src/tokenizer/JsFastTokenizer.ts";
import { loadWasmTokenizer, type WasmTokenizer } from "../src/tokenizer/wasm/loader.ts";
import { makeBatch, lineRanges } from "./corpus.ts";

const enc = new TextEncoder();
const wasmDir = new URL("../src/tokenizer/wasm/", import.meta.url).pathname;

const reference = new Tokenizer();
const jsFast = new JsFastTokenizer();

const load = async (file: string): Promise<WasmTokenizer | undefined> =>
  existsSync(`${wasmDir}${file}`) ? loadWasmTokenizer(file) : undefined;

const wat = await load("tokenizer.wat.wasm");
const rust = await load("tokenizer.rust.wasm");
const simd = await load("tokenizer.rust-simd.wasm");

function benchBatch(label: string, batch: Uint8Array): void {
  const ranges = lineRanges(batch);
  const loopWasm = (tk: WasmTokenizer): number => {
    let n = 0;
    for (const [s, e] of ranges) n += tk.tokenizeInto(batch.subarray(s, e));
    return n;
  };

  group(
    `${label} · ${ranges.length} lines (${(batch.length / 1024).toFixed(0)} KiB)`,
    () => {
      summary(() => {
        bench("reference (loop)", () => {
          let n = 0;
          for (const [s, e] of ranges) n += reference.tokenize(batch, s, e).length;
          do_not_optimize(n);
        });
        bench("js-fast (loop)", () => {
          let n = 0;
          for (const [s, e] of ranges) n += jsFast.tokenizeInto(batch, s, e);
          do_not_optimize(n);
        });
        if (wat) bench("wasm-wat (loop)", () => do_not_optimize(loopWasm(wat)));
        if (rust) {
          bench("wasm-rust (loop)", () => do_not_optimize(loopWasm(rust)));
          bench("wasm-rust (batch)", () =>
            do_not_optimize(rust.tokenizeBatchInto(batch).totalTokens),
          );
        }
        if (simd) {
          bench("wasm-rust-simd (loop)", () => do_not_optimize(loopWasm(simd)));
          bench("wasm-rust-simd (batch)", () =>
            do_not_optimize(simd.tokenizeBatchInto(batch).totalTokens),
          );
        }
      });
    },
  );
}

// Realistic IRC traffic: short lines.
benchBatch("batch · realistic", enc.encode(makeBatch(5000)));

// Long contiguous fields (a 280-byte middle param) — SIMD's regime, where the
// v128 16-byte delimiter scan can pay for its setup cost.
const longLine =
  ":nick!user@host PRIVMSG #channel " + "x".repeat(280) + " :trailing text";
const longBatch = enc.encode(
  Array.from({ length: 2000 }, () => longLine).join("\r\n"),
);
benchBatch("batch · long-fields", longBatch);

await run();
