import { describe, expect, test } from "bun:test";
import { MockLanguageModelV4 } from "ai/test";
import { DebugHarness, type ChatOutcome } from "./harness.ts";
import { buildInspection, formatHuman, formatJson } from "./inspect.ts";

function mockModel(text: string) {
  return new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: "text", text }],
      finishReason: { unified: "stop", raw: undefined },
      usage: {
        inputTokens: { total: 12, noCache: 12, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 3, text: 3, reasoning: undefined },
      },
      warnings: [],
    }),
  });
}

async function sampleOutcome(): Promise<ChatOutcome> {
  const h = new DebugHarness({ model: mockModel("the answer"), tools: {} });
  return h.chat("question", { as: "kester", conversation: "#test" });
}

describe("buildInspection", () => {
  test("surfaces every layer for a successful exchange", async () => {
    const i = buildInspection(await sampleOutcome());
    expect(i.reply).toBe("the answer");
    expect(i.finishReason).toBe("stop");
    expect(i.error).toBeNull();
    expect(i.usage).toEqual({ inputTokens: 12, outputTokens: 3, totalTokens: 15 });
    expect(i.timing?.wallMs).toBeGreaterThanOrEqual(0);
    expect(i.steps.length).toBeGreaterThanOrEqual(1);
    expect(i.prompt.length).toBeGreaterThan(0); // the projection that ran
    expect(i.ephemera.conversation).toBe("#test");
    expect(i.history.map((e) => e.kind)).toEqual(["chat-message", "bot-reply"]);
  });

  test("formatJson round-trips to the same inspection", async () => {
    const outcome = await sampleOutcome();
    expect(JSON.parse(formatJson(outcome))).toEqual(JSON.parse(JSON.stringify(buildInspection(outcome))));
  });

  test("represents a captured error", () => {
    const errored: ChatOutcome = {
      reply: "",
      replyLines: [],
      turn: { nowUtc: "2026-01-01T00:00:00.000Z", conversation: "#test", guidance: [] },
      error: { name: "APICallError", message: "rate limited", statusCode: 429 },
      history: [],
    };
    const i = buildInspection(errored);
    expect(i.error).toEqual({ name: "APICallError", message: "rate limited", statusCode: 429 });
    expect(i.usage).toBeNull();
    expect(i.steps).toEqual([]);
    expect(formatHuman(errored)).toContain("APICallError [429]: rate limited");
  });
});

describe("formatHuman", () => {
  test("compact form has reply/usage/timing, verbose adds prompt/ephemera/history", async () => {
    const outcome = await sampleOutcome();
    const compact = formatHuman(outcome);
    expect(compact).toContain("━━ REPLY ━━");
    expect(compact).toContain("━━ USAGE ━━");
    expect(compact).toContain("━━ TIMING ━━");
    expect(compact).not.toContain("━━ PROMPT ━━");

    const verbose = formatHuman(outcome, { verbose: true });
    expect(verbose).toContain("━━ PROMPT ━━");
    expect(verbose).toContain("━━ EPHEMERA ━━");
    expect(verbose).toContain("━━ HISTORY ━━");
  });
});
