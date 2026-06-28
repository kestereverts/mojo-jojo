# Tokenizer benchmarks

Five interchangeable tokenizer backends, all producing an **identical** token
stream (verified by `src/tokenizer/*parity*.test.ts` against the reference
across thousands of fuzzed lines):

| Backend | What |
| --- | --- |
| `reference` | the original tokenizer — one heap `Token` object per token |
| `js-fast` | allocation-free port, writes `[type,start,end]` into a reused `Int32Array` |
| `wasm-wat` | hand-written WebAssembly text (`native/wat/tokenizer.wat`), scalar |
| `wasm-rust` | Rust `no_std` → wasm32 (`native/rust/`), scalar |
| `wasm-rust-simd` | same Rust, built with `+simd128` (v128 delimiter scans) |

## Running

```sh
bun run build:wasm   # assemble/compile the 3 .wasm (needs wabt + wasm32 target + binaryen)
bun run bench        # tokenize.bench.ts (single) + batch.bench.ts (batched)
```

Numbers below: **Apple M5, Bun 1.3.14**. Machine-dependent; rerun locally.

## Single message (lower is better, ns/iter)

| sample (size) | reference | js-fast | wasm-wat | wasm-rust | wasm-rust-simd |
| --- | --- | --- | --- | --- | --- |
| `ping` (4 B) | 15.6 | **14.0** | 106 | 76 | 79 |
| `privmsg` (47 B) | 322 | **36** | 95 | 93 | 95 |
| `tags-heavy` (303 B) | 852 | **108** | 154 | 149 | 158 |
| `max-510` (510 B) | 88 | **20** | 87 | 85 | 93 |

`js-fast` wins every single-message case — up to ~9× over `reference` and
~2.5–5× over the WASM backends. WASM has a fixed ~70–90 ns JS↔WASM call + memcpy
cost per message that dwarfs the actual scan for short IRC lines.

## Batched (one buffer of many CRLF lines; lower is better)

**Realistic traffic — 5 000 short lines, 418 KiB:**

| backend (mode) | time | vs js-fast |
| --- | --- | --- |
| **js-fast** (loop) | **235 µs** | 1.00× |
| wasm-rust (batch) | 406 µs | 0.58× |
| wasm-rust-simd (batch) | 424 µs | 0.55× |
| wasm-rust (loop) | 640 µs | 0.37× |
| wasm-rust-simd (loop) | 871 µs | 0.27× |
| reference (loop) | 3 810 µs | 0.06× |

**Long fields — 2 000 lines with a 280 B middle param, 645 KiB:**

| backend (mode) | time | vs js-fast |
| --- | --- | --- |
| **wasm-rust-simd** (batch) | **252 µs** | 1.08× ✅ |
| js-fast (loop) | 272 µs | 1.00× |
| wasm-rust-simd (loop) | 308 µs | 0.88× |
| wasm-rust (loop) | 377 µs | 0.72× |
| wasm-rust (batch) | 535 µs | 0.51× |
| reference (loop) | 1 030 µs | 0.26× |

## Findings

1. **The big, sure win is `js-fast`.** Dropping one `Token` allocation per token
   for a reused `Int32Array` is 9–17× faster than `reference` with zero WASM.
   It is now the default backend for `parseMessage`.
2. **WASM loses on realistic IRC.** Lines are short (≤512 B); the per-call
   boundary cost outweighs the scan, and Bun/JSC JITs the `js-fast` loop to
   essentially native speed. `js-fast` stays ~3.7× ahead even batched.
3. **Batching amortizes the boundary.** One `tokenize_batch` call over 5 000
   lines is ~1.6× faster than 5 000 per-line WASM calls — but still behind
   `js-fast`.
4. **SIMD only pays on long contiguous fields.** On short fields the v128 setup
   cost makes SIMD *slower* than scalar Rust; on a 280 B field it flips to ~1.2×
   faster, and `wasm-rust-simd` (batch) is the only backend that beats `js-fast`
   — by 1.08×, on bulk long-field input.
5. **The hand-written WAT is competitive with compiled Rust** (scalar), which is
   a fun result: ~2.2 KiB, no compiler, and within a few percent of `wasm-rust`.

## Recommendation

Use the default (`js-fast`) for normal IRC parsing. Reach for
`createIrcParser({ backend: "wasm-rust-simd" })` + `tokenizeBatchInto` only for
bulk offline processing of large buffers with long fields, where it edges ahead.
