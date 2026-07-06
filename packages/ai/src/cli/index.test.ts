import { afterAll, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlink } from "node:fs/promises";
import { cascadeModelOverride, main } from "./index.ts";
import type { ModelRoles } from "../models.ts";

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

const MODELS: ModelRoles = {
  chat: "openai/gpt-5.4-mini",
  classifier: "openai/gpt-5.4-mini",
  summarizer: "openai/gpt-5.4-mini",
  research: "openai/gpt-5.4-mini",
  embedding: "openai/text-embedding-3-small",
};

describe("cascadeModelOverride — --model reaching research_topic (review finding)", () => {
  test("with no override, returns the models unchanged", () => {
    expect(cascadeModelOverride(MODELS, undefined)).toEqual(MODELS);
  });

  test("cascades to every role that was defaulted to chat, including research — the actual bug found in review", () => {
    const result = cascadeModelOverride(MODELS, "google/gemini-3.1-flash");
    expect(result.chat).toBe("google/gemini-3.1-flash");
    expect(result.research).toBe("google/gemini-3.1-flash");
    expect(result.classifier).toBe("google/gemini-3.1-flash");
    expect(result.summarizer).toBe("google/gemini-3.1-flash");
  });

  test("does NOT override a role that was explicitly configured differently from chat", () => {
    const models: ModelRoles = { ...MODELS, research: "google/gemini-3.1-pro" };
    const result = cascadeModelOverride(models, "google/gemini-3.1-flash");
    expect(result.chat).toBe("google/gemini-3.1-flash");
    expect(result.research).toBe("google/gemini-3.1-pro"); // untouched — it wasn't defaulted to chat
  });

  test("never touches embedding — it doesn't default to chat and --model never overrides it", () => {
    const result = cascadeModelOverride(MODELS, "google/gemini-3.1-flash");
    expect(result.embedding).toBe("openai/text-embedding-3-small");
  });
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

describe("main — tools command (network-free registry inspection)", () => {
  test("lists every default tool with its guidance, and marks only paste/get_paste [durable], only research_topic [subagent]", async () => {
    const r = await run(["tools"]);
    expect(r.code).toBe(0);
    for (const name of [
      "letter_count",
      "local_time",
      "currency_convert",
      "weather_forecast",
      "wolfram_alpha",
      "web_search",
      "web_reader",
      "paste",
      "get_paste",
      "places_search",
      "research_topic",
    ]) {
      expect(r.out).toContain(name);
    }
    expect(r.out).toContain("paste [durable]");
    expect(r.out).toContain("get_paste [durable]");
    expect(r.out).not.toContain("letter_count [durable]");
    expect(r.out).toContain("research_topic [subagent]");
    expect(r.out).not.toContain("letter_count [subagent]");
  });

  test("--config's tools.disabled actually removes a tool from the listing — the CLI/live parity this milestone exists for", async () => {
    const cfg = await tmpConfig('[modules.mojo-ai.tools]\ndisabled = ["currency_convert"]\n');
    const r = await run(["tools", "--config", cfg]);
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("currency_convert");
    expect(r.out).toContain("letter_count"); // other tools unaffected
  });

  test("--json emits a stable, parseable shape", async () => {
    const r = await run(["tools", "--json"]);
    const parsed = JSON.parse(r.out);
    expect(Array.isArray(parsed.tools)).toBe(true);
    const names = parsed.tools.map((t: { name: string }) => t.name);
    expect(names).toContain("wolfram_alpha");
    const wolfram = parsed.tools.find((t: { name: string }) => t.name === "wolfram_alpha");
    expect(wolfram.durableTranscript).toBe(false);
    expect(wolfram.isSubagent).toBe(false);
    expect(typeof wolfram.guidance).toBe("string");
    const research = parsed.tools.find((t: { name: string }) => t.name === "research_topic");
    expect(research.isSubagent).toBe(true);
    expect(research.durableTranscript).toBe(false);
  });
});

describe("main — research command (network-dependent, real subagent)", () => {
  test("a missing topic exits 2 with usage", async () => {
    const r = await run(["research"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("research needs a topic");
  });
});
