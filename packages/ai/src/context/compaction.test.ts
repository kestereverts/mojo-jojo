import { describe, expect, test } from "bun:test";
import { MockLanguageModelV4 } from "ai/test";
import { maybeCompact } from "./compaction.ts";
import { InMemoryContextLog } from "./log.ts";
import type { ChatMessageEvent, CompactionEvent } from "./events.ts";

const FIXED = () => new Date("2026-01-01T00:00:00.000Z");

function chat(text: string, at = "2026-01-01T00:00:00.000Z"): ChatMessageEvent {
  return { kind: "chat-message", at, speaker: { nick: "a", trust: "nick" }, text, addressed: true };
}

function textModel(text: string) {
  return new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: "text", text }],
      finishReason: { unified: "stop", raw: undefined },
      usage: {
        inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 5, text: 5, reasoning: undefined },
      },
      warnings: [],
    }),
  });
}

function fillLog(count: number): InMemoryContextLog {
  const log = new InMemoryContextLog(10_000);
  for (let i = 0; i < count; i++) log.append(chat(`msg ${i}`, `2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z`));
  return log;
}

describe("maybeCompact — trigger gate", () => {
  test("disabled config never compacts, no model call", async () => {
    let called = false;
    const model = new MockLanguageModelV4({ doGenerate: async () => ((called = true), textModel("x") as never) });
    const log = fillLog(500);
    const result = await maybeCompact(log, { enabled: false, triggerEvents: 10, keepTail: 5 }, { model }, FIXED);
    expect(result).toBe(false);
    expect(called).toBe(false);
    expect(log.events()).toHaveLength(500);
  });

  test("below the trigger threshold, no compaction and no model call", async () => {
    let called = false;
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        called = true;
        return { content: [{ type: "text", text: "x" }], finishReason: { unified: "stop", raw: undefined }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } }, warnings: [] };
      },
    });
    const log = fillLog(10);
    const result = await maybeCompact(log, { enabled: true, triggerEvents: 20, keepTail: 5 }, { model }, FIXED);
    expect(result).toBe(false);
    expect(called).toBe(false);
  });

  test("keepTail >= event count leaves nothing meaningful to compact — skipped, no model call", async () => {
    let called = false;
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        called = true;
        return { content: [{ type: "text", text: "x" }], finishReason: { unified: "stop", raw: undefined }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } }, warnings: [] };
      },
    });
    const log = fillLog(5);
    // triggerEvents=1 so the length check passes, but keepTail=10 > events.length
    const result = await maybeCompact(log, { enabled: true, triggerEvents: 1, keepTail: 10 }, { model }, FIXED);
    expect(result).toBe(false);
    expect(called).toBe(false);
  });
});

describe("maybeCompact — successful compaction", () => {
  test("replaces every event but the newest keepTail with one CompactionEvent", async () => {
    const log = fillLog(10);
    const model = textModel("Alice and Bob talked about various things.");
    const result = await maybeCompact(log, { enabled: true, triggerEvents: 5, keepTail: 3 }, { model }, FIXED);
    expect(result).toBe(true);

    const events = log.events();
    expect(events).toHaveLength(1 + 3); // 1 summary + kept tail
    expect(events[0]).toMatchObject({ kind: "compaction", summary: "Alice and Bob talked about various things.", eventCount: 7 });
    expect((events[1] as ChatMessageEvent).text).toBe("msg 7");
    expect((events[3] as ChatMessageEvent).text).toBe("msg 9");
  });

  test("coversUntil is the timestamp of the last summarized event", async () => {
    const log = fillLog(10);
    const model = textModel("summary");
    await maybeCompact(log, { enabled: true, triggerEvents: 5, keepTail: 3 }, { model }, FIXED);
    const summaryEvent = log.events()[0] as CompactionEvent;
    // events 0..6 summarized (7 events); index 6 is "msg 6" at :06
    expect(summaryEvent.coversUntil).toBe("2026-01-01T00:00:06.000Z");
  });

  test("the model receives the prior compaction event as part of its input when one already exists (merge case)", async () => {
    const log = fillLog(10);
    await maybeCompact(log, { enabled: true, triggerEvents: 5, keepTail: 3 }, { model: textModel("first summary") }, FIXED);
    // Append more events so a second round has something new plus the prior summary.
    for (let i = 10; i < 15; i++) log.append(chat(`msg ${i}`, `2026-01-01T00:00:${i}.000Z`));

    let capturedPrompt = "";
    const model = new MockLanguageModelV4({
      doGenerate: async (opts) => {
        capturedPrompt = JSON.stringify(opts.prompt);
        return { content: [{ type: "text", text: "merged summary" }], finishReason: { unified: "stop", raw: undefined }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } }, warnings: [] };
      },
    });
    await maybeCompact(log, { enabled: true, triggerEvents: 5, keepTail: 3 }, { model }, FIXED);
    expect(capturedPrompt).toContain("first summary");
    expect(capturedPrompt).toContain("\\\"kind\\\":\\\"compaction\\\"");
    expect(log.events()[0]).toMatchObject({ kind: "compaction", summary: "merged summary" });
  });
});

describe("maybeCompact — fails open", () => {
  test("a model error skips this round entirely — log untouched, returns false", async () => {
    const log = fillLog(10);
    const before = log.events();
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new Error("provider exploded");
      },
    });
    const result = await maybeCompact(log, { enabled: true, triggerEvents: 5, keepTail: 3 }, { model }, FIXED);
    expect(result).toBe(false);
    expect(log.events()).toEqual(before);
  });

  test("empty/whitespace-only summary text is treated as a failure — never compacts on nothing", async () => {
    const log = fillLog(10);
    const before = log.events();
    const model = textModel("   ");
    const result = await maybeCompact(log, { enabled: true, triggerEvents: 5, keepTail: 3 }, { model }, FIXED);
    expect(result).toBe(false);
    expect(log.events()).toEqual(before);
  });
});
