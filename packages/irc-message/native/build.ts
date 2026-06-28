#!/usr/bin/env bun
// Builds the WASM tokenizer artifacts and writes them (optimized) into
// src/tokenizer/wasm/. The .wasm outputs are committed so consumers need no
// Rust/wabt toolchain; run this only when the sources change.
//
//   bun run native/build.ts
//
// Requires: wat2wasm + wasm-opt (brew install wabt binaryen), and for the Rust
// backends: rustup target add wasm32-unknown-unknown.

import { $ } from "bun";
import { existsSync, statSync } from "node:fs";

const here = import.meta.dir;
const outDir = `${here}/../src/tokenizer/wasm`;
await $`mkdir -p ${outDir}`;

const kib = (p: string) => `${(statSync(p).size / 1024).toFixed(1)} KiB`;

// ---- hand-written WAT ------------------------------------------------------
{
  const src = `${here}/wat/tokenizer.wat`;
  const raw = `${outDir}/tokenizer.wat.raw.wasm`;
  const out = `${outDir}/tokenizer.wat.wasm`;
  await $`wat2wasm ${src} -o ${raw}`;
  await $`wasm-opt -O3 ${raw} -o ${out}`;
  await $`rm ${raw}`;
  console.log(`tokenizer.wat.wasm        ${kib(out)}`);
}

// ---- Rust (scalar + simd128) ----------------------------------------------
const rustDir = `${here}/rust`;
if (existsSync(`${rustDir}/Cargo.toml`)) {
  const triple = "wasm32-unknown-unknown";
  const crateWasm = (profileDir: string) =>
    `${rustDir}/target/${triple}/${profileDir}/irc_tokenizer.wasm`;

  // scalar
  await $`cargo build --release --target ${triple}`.cwd(rustDir);
  await $`wasm-opt -O3 ${crateWasm("release")} -o ${outDir}/tokenizer.rust.wasm`;
  console.log(`tokenizer.rust.wasm       ${kib(`${outDir}/tokenizer.rust.wasm`)}`);

  // simd128 (separate target dir so the scalar artifact isn't clobbered)
  await $`cargo build --release --target ${triple} --target-dir target-simd`
    .cwd(rustDir)
    .env({
      ...process.env,
      RUSTFLAGS: "-C target-feature=+simd128",
    });
  await $`wasm-opt -O3 --enable-simd ${rustDir}/target-simd/${triple}/release/irc_tokenizer.wasm -o ${outDir}/tokenizer.rust-simd.wasm`;
  console.log(
    `tokenizer.rust-simd.wasm  ${kib(`${outDir}/tokenizer.rust-simd.wasm`)}`,
  );
} else {
  console.log("(skipping Rust backends — native/rust/Cargo.toml not present yet)");
}
