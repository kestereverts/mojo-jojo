import { afterAll, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlink } from "node:fs/promises";
import { cascadeModelOverride, main } from "./index.ts";
import type { ModelRoles } from "../models.ts";
import { openContextDb, SqliteContextLog } from "../context/sqlite-log.ts";
import type { ChatMessageEvent } from "../context/events.ts";

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
  await Promise.all(tmpFiles.flatMap((p) => [p, `${p}-wal`, `${p}-shm`]).map((p) => unlink(p).catch(() => {})));
});

function tmpDbPath(): string {
  const path = join(tmpdir(), `mojo-ai-cli-db-${tmpFiles.length}-${Date.now()}.sqlite`);
  tmpFiles.push(path);
  return path;
}

function chat(text: string, at = "2026-01-01T00:00:00.000Z"): ChatMessageEvent {
  return { kind: "chat-message", at, speaker: { nick: "a", trust: "nick" }, text, addressed: true };
}

/** Seeds a conversation's events directly (bypassing `chat`, which always runs a real exchange) so `history`/`compact` CLI tests stay network-free. */
function seedDb(path: string, conversation: string, count: number): void {
  const db = openContextDb(path);
  const log = new SqliteContextLog(db, conversation, 10_000);
  for (let i = 0; i < count; i++) log.append(chat(`msg ${i}`, `2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z`));
  db.close();
}

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

  test("--model reaches the standalone research command too, not just chat/repl (review finding — it was passing raw cliConfig.models, bypassing the cascade)", async () => {
    // resolveModel throws on an unknown PROVIDER synchronously, before any
    // network call — an unknown-provider spec is a network-free way to prove
    // --model's value genuinely reached research_topic's model resolution.
    const r = await run(["research", "test topic", "--model", "totally-bogus-provider/x"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("unknown model provider");
    expect(r.err).toContain("totally-bogus-provider");
  });
});

describe("main — history command (M8, network-free)", () => {
  test("needs --db", async () => {
    const r = await run(["history"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("history needs --db");
  });

  test("dumps a seeded conversation's durable events, human and JSON", async () => {
    const path = tmpDbPath();
    seedDb(path, "debug", 3);

    const human = await run(["history", "--db", path]);
    expect(human.code).toBe(0);
    expect(human.out).toContain("msg 0");
    expect(human.out).toContain("msg 2");

    const json = await run(["history", "--db", path, "--json"]);
    expect(json.code).toBe(0);
    const events = JSON.parse(json.out);
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({ kind: "chat-message", text: "msg 0" });
  });

  test("respects --conversation — a different conversation key sees no events", async () => {
    const path = tmpDbPath();
    seedDb(path, "debug", 2);
    const r = await run(["history", "--db", path, "--conversation", "#other", "--json"]);
    expect(JSON.parse(r.out)).toEqual([]);
  });

  test("an empty conversation prints a clear message, not a crash or blank output", async () => {
    const path = tmpDbPath();
    seedDb(path, "debug", 0);
    const r = await run(["history", "--db", path]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("no durable events");
  });
});

describe("main — compact command (M8)", () => {
  test("needs --db", async () => {
    const r = await run(["compact"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("compact needs --db");
  });

  test("below the default trigger threshold, reports not-compacted without any model call (network-free)", async () => {
    const path = tmpDbPath();
    seedDb(path, "debug", 5); // well under the default triggerEvents (240)
    const r = await run(["compact", "--db", path, "--json"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({ compacted: false, eventsBefore: 5, eventsAfter: 5 });
  });

  test("--force with too few events to compact (below keepTail) reports not-compacted, exit 1, still no model call", async () => {
    const path = tmpDbPath();
    seedDb(path, "debug", 2); // below the default keepTail (60) even when forced
    const r = await run(["compact", "--db", path, "--force", "--json"]);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out)).toEqual({ compacted: false, eventsBefore: 2, eventsAfter: 2 });
  });

  test("history reflects a compaction that already happened, read back from the same db", async () => {
    const path = tmpDbPath();
    const db = openContextDb(path);
    const log = new SqliteContextLog(db, "debug", 10_000);
    log.append(chat("1"));
    log.append(chat("2"));
    log.compact([chat("1"), chat("2")], { kind: "compaction", at: "t", coversUntil: "t", summary: "already summarized", eventCount: 2 });
    db.close();

    const r = await run(["history", "--db", path, "--json"]);
    const events = JSON.parse(r.out);
    expect(events).toEqual([{ kind: "compaction", at: "t", coversUntil: "t", summary: "already summarized", eventCount: 2 }]);
  });
});
