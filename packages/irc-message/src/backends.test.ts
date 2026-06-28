import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { createIrcParser, type Backend } from "./backends.ts";
import { parseMessage } from "./parse.ts";
import { SAMPLES } from "../bench/corpus.ts";

const wasmDir = new URL("./tokenizer/wasm/", import.meta.url).pathname;
const WASM_FILE: Record<string, string> = {
  "wasm-wat": "tokenizer.wat.wasm",
  "wasm-rust": "tokenizer.rust.wasm",
  "wasm-rust-simd": "tokenizer.rust-simd.wasm",
};

const ALL: Backend[] = [
  "reference",
  "js-fast",
  "wasm-wat",
  "wasm-rust",
  "wasm-rust-simd",
];
const available = ALL.filter(
  (b) => !b.startsWith("wasm") || existsSync(`${wasmDir}${WASM_FILE[b]}`),
);

describe("createIrcParser: every backend yields identical messages", () => {
  for (const backend of available) {
    test(backend, async () => {
      const parser = await createIrcParser({ backend });
      for (const { line } of SAMPLES) {
        expect(parser.parseMessage(line)).toEqual(
          parseMessage(line, { backend: "reference" }),
        );
      }
    });
  }
});

test("parseMessage default (js-fast) matches the reference backend", () => {
  for (const { line } of SAMPLES) {
    expect(parseMessage(line)).toEqual(
      parseMessage(line, { backend: "reference" }),
    );
  }
});

test("parseMessage honors tokenizer limit options", () => {
  expect(() =>
    parseMessage("CMD a b c d", { backend: "js-fast", paramCountLimit: 2 }),
  ).toThrow(/paramCountLimit/);
  expect(() =>
    parseMessage("CMD a b c d", { backend: "reference", paramCountLimit: 2 }),
  ).toThrow(/paramCountLimit/);
});
