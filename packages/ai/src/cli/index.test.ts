import { afterAll, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlink } from "node:fs/promises";
import { main } from "./index.ts";

/** Run `main` with stdout/stderr captured (kept quiet) so we can assert on both. */
async function run(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  let out = "";
  let err = "";
  process.stdout.write = ((s: string | Uint8Array) => ((out += s.toString()), true)) as typeof process.stdout.write;
  process.stderr.write = ((s: string | Uint8Array) => ((err += s.toString()), true)) as typeof process.stderr.write;
  try {
    const code = await main(argv);
    return { code, out, err };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

const tmpFiles: string[] = [];
async function tmpConfig(body: string): Promise<string> {
  const path = join(tmpdir(), `mojo-ai-cli-${tmpFiles.length}.toml`);
  await Bun.write(path, body);
  tmpFiles.push(path);
  return path;
}
afterAll(async () => {
  await Promise.all(tmpFiles.map((p) => unlink(p).catch(() => {})));
});

describe("main — usage & validation exit codes (no network)", () => {
  test("help and empty args print usage and exit 0", async () => {
    expect((await run(["--help"])).code).toBe(0);
    expect((await run([])).code).toBe(0);
    expect((await run(["help"])).code).toBe(0);
  });

  test("unknown command / missing message / standalone inject exit 2", async () => {
    expect((await run(["frobnicate"])).code).toBe(2);
    expect((await run(["chat"])).code).toBe(2);
    expect((await run(["inject"])).code).toBe(2);
  });

  test("--max-steps rejects 0, empty string, and non-integers with exit 2", async () => {
    expect((await run(["chat", "hi", "--max-steps", "0"])).code).toBe(2);
    expect((await run(["chat", "hi", "--max-steps", ""])).code).toBe(2);
    expect((await run(["chat", "hi", "--max-steps", "abc"])).code).toBe(2);
  });

  test("--config: missing file, bad TOML, and out-of-range values exit 2", async () => {
    expect((await run(["chat", "hi", "--config", "/no/such/file.toml"])).code).toBe(2);
    const badToml = await tmpConfig("this is = = not toml [[[");
    expect((await run(["chat", "hi", "--config", badToml])).code).toBe(2);
    const badRange = await tmpConfig("[modules.mojo-ai]\nreplyLines = 99\n");
    const r = await run(["chat", "hi", "--config", badRange]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("[1, 10]");
  });

  test("--db (still deferred) prints an honest notice; --via (wired since M3) does not", async () => {
    // Pair with a validation error so no exchange runs.
    const r = await run(["chat", "hi", "--via", "Telegram", "--db", "/tmp/x.db", "--max-steps", "0"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("--db is recognized but not wired until M8");
    expect(r.err).not.toContain("--via");
  });

  test("--config [modules.mojo-ai.models] bad role type surfaces the module's own path in the error", async () => {
    const badModels = await tmpConfig("[modules.mojo-ai.models]\nchat = 42\n");
    const r = await run(["chat", "hi", "--max-steps", "0", "--config", badModels]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("modules.mojo-ai.models.chat");
  });

  test("a non-table modules.mojo-ai entry errors instead of silently defaulting (matches live config load)", async () => {
    const badEntry = await tmpConfig("[modules]\nmojo-ai = 42\n");
    const r = await run(["chat", "hi", "--config", badEntry]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("modules.mojo-ai: expected a table");
  });
});
