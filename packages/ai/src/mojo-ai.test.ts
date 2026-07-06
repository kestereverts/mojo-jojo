import { describe, expect, test } from "bun:test";
import { ConfigError } from "@mojo-jojo/bot";
import { mojoAiModule } from "./mojo-ai.ts";

function parse(raw: Record<string, unknown>) {
  const module = mojoAiModule();
  if (!module.parseConfig) throw new Error("mojoAiModule() has no parseConfig");
  return module.parseConfig(raw);
}

describe("mojoAiModule().parseConfig — model roles", () => {
  test("defaults: chat/classifier/summarizer/research share one default, embedding is separate", () => {
    const config = parse({});
    expect(config.models).toEqual({
      chat: "openai/gpt-5.4-mini",
      classifier: "openai/gpt-5.4-mini",
      summarizer: "openai/gpt-5.4-mini",
      research: "openai/gpt-5.4-mini",
      embedding: "openai/text-embedding-3-small",
    });
  });

  test("legacy top-level `model` is an alias for models.chat, and other roles fall back to it", () => {
    const config = parse({ model: "google/gemini-3.5-flash" });
    expect(config.models.chat).toBe("google/gemini-3.5-flash");
    expect(config.models.classifier).toBe("google/gemini-3.5-flash");
    expect(config.models.summarizer).toBe("google/gemini-3.5-flash");
    expect(config.models.research).toBe("google/gemini-3.5-flash");
    // embedding does not fall back to chat — it has its own default.
    expect(config.models.embedding).toBe("openai/text-embedding-3-small");
  });

  test("[models] table wins over the legacy `model` key for chat", () => {
    const config = parse({ model: "google/gemini-3.5-flash", models: { chat: "openai/gpt-5.4-mini" } });
    expect(config.models.chat).toBe("openai/gpt-5.4-mini");
  });

  test("each role can be set independently; unset roles still default to the resolved chat", () => {
    const config = parse({
      models: { chat: "openai/gpt-5.4-mini", research: "google/gemini-3.5-flash" },
    });
    expect(config.models.chat).toBe("openai/gpt-5.4-mini");
    expect(config.models.research).toBe("google/gemini-3.5-flash");
    expect(config.models.classifier).toBe("openai/gpt-5.4-mini"); // falls back to chat
    expect(config.models.summarizer).toBe("openai/gpt-5.4-mini");
  });

  test("embedding can be overridden independently of chat", () => {
    const config = parse({ models: { embedding: "openai/text-embedding-3-large" } });
    expect(config.models.embedding).toBe("openai/text-embedding-3-large");
    expect(config.models.chat).toBe("openai/gpt-5.4-mini");
  });

  test("rejects a non-table `models` value", () => {
    expect(() => parse({ models: "not-a-table" })).toThrow(ConfigError);
  });

  test("rejects a non-string role value, collecting the path in the error", () => {
    try {
      parse({ models: { chat: 42 } });
      throw new Error("expected parseConfig to throw");
    } catch (cause) {
      expect(cause).toBeInstanceOf(ConfigError);
      expect((cause as ConfigError).issues.join()).toContain("modules.mojo-ai.models.chat");
    }
  });
});

describe("mojoAiModule().parseConfig — other bounds unaffected by the models change", () => {
  test("still defaults and range-checks historyLimit/maxSteps/replyLines", () => {
    expect(parse({})).toMatchObject({ historyLimit: 200, maxSteps: 8, replyLines: 3 });
    expect(() => parse({ replyLines: 0 })).toThrow(ConfigError);
    expect(() => parse({ maxSteps: 33 })).toThrow(ConfigError);
    const config = parse({ historyLimit: 50, maxSteps: 4, replyLines: 1 });
    expect(config).toMatchObject({ historyLimit: 50, maxSteps: 4, replyLines: 1 });
  });
});

describe("mojoAiModule().parseConfig — [guards] (M7)", () => {
  test("every guard defaults to enabled", () => {
    expect(parse({}).guards).toEqual({ promptGuard: true, leakDetector: true, grounding: true });
  });

  test("each guard can be independently disabled", () => {
    const config = parse({ guards: { promptGuard: false } });
    expect(config.guards).toEqual({ promptGuard: false, leakDetector: true, grounding: true });
  });

  test("all guards can be disabled together", () => {
    const config = parse({ guards: { promptGuard: false, leakDetector: false, grounding: false } });
    expect(config.guards).toEqual({ promptGuard: false, leakDetector: false, grounding: false });
  });

  test("rejects a non-boolean guard value, collecting the path in the error", () => {
    try {
      parse({ guards: { promptGuard: "yes" } });
      throw new Error("expected parseConfig to throw");
    } catch (cause) {
      expect(cause).toBeInstanceOf(ConfigError);
      expect((cause as ConfigError).issues.join()).toContain("modules.mojo-ai.guards.promptGuard");
    }
  });

  test("rejects a non-table `guards` value", () => {
    expect(() => parse({ guards: "not-a-table" })).toThrow(ConfigError);
  });
});

describe("mojoAiModule().parseConfig — dbPath + [compaction] (M8)", () => {
  test("dbPath is absent by default — in-memory only", () => {
    expect(parse({}).dbPath).toBeUndefined();
  });

  test("dbPath is passed through when configured", () => {
    expect(parse({ dbPath: "./data/mojo-ai.sqlite" }).dbPath).toBe("./data/mojo-ai.sqlite");
  });

  test("compaction defaults: enabled, triggerEvents=240, keepTail=60", () => {
    expect(parse({}).compaction).toEqual({ enabled: true, triggerEvents: 240, keepTail: 60 });
  });

  test("each compaction field can be set independently", () => {
    const config = parse({ compaction: { triggerEvents: 100, keepTail: 20 } });
    expect(config.compaction).toEqual({ enabled: true, triggerEvents: 100, keepTail: 20 });
  });

  test("compaction can be disabled entirely", () => {
    expect(parse({ compaction: { enabled: false } }).compaction.enabled).toBe(false);
  });

  test("rejects keepTail >= triggerEvents — nothing would be left to compact", () => {
    try {
      parse({ compaction: { triggerEvents: 50, keepTail: 50 } });
      throw new Error("expected parseConfig to throw");
    } catch (cause) {
      expect(cause).toBeInstanceOf(ConfigError);
      expect((cause as ConfigError).issues.join()).toContain("modules.mojo-ai.compaction.keepTail");
    }
  });

  test("rejects an out-of-range triggerEvents/keepTail", () => {
    expect(() => parse({ compaction: { triggerEvents: 1 } })).toThrow(ConfigError); // below the min of 2
    expect(() => parse({ compaction: { keepTail: 0 } })).toThrow(ConfigError);
  });

  test("rejects a non-table `compaction` value", () => {
    expect(() => parse({ compaction: "not-a-table" })).toThrow(ConfigError);
  });
});
