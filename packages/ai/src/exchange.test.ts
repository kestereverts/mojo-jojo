import { describe, expect, test } from "bun:test";
import { tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";
import { InMemoryContextLog } from "./context/log.ts";
import type { TurnContext } from "./context/events.ts";
import { recordDurableTranscripts, recordSubagentBriefings, runExchange } from "./exchange.ts";

const TURN: TurnContext = { nowUtc: "2026-01-01T00:00:00.000Z", conversation: "#t", guidance: [] };

// The provider-level generate result type, derived from the mock's own option
// (avoids importing @ai-sdk/provider, which isn't a direct dep).
type MockOptions = NonNullable<ConstructorParameters<typeof MockLanguageModelV4>[0]>;
type GenResult = Extract<MockOptions["doGenerate"], readonly unknown[]>[number];

const usage = {
  inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 2, text: 2, reasoning: undefined },
};

/** doGenerate result emitting a single tool call (provider `input` is a JSON string). */
function toolCallStep(toolName: string, input: object): GenResult {
  return {
    content: [{ type: "tool-call", toolCallId: "c1", toolName, input: JSON.stringify(input) }],
    finishReason: { unified: "tool-calls", raw: undefined },
    usage,
    warnings: [],
  };
}

function textStep(text: string): GenResult {
  return {
    content: [{ type: "text", text }],
    finishReason: { unified: "stop", raw: undefined },
    usage,
    warnings: [],
  };
}

function logWith(text: string): InMemoryContextLog {
  const log = new InMemoryContextLog();
  log.append({ kind: "chat-message", at: TURN.nowUtc, speaker: { nick: "a", trust: "nick" }, text, addressed: true });
  return log;
}

describe("runExchange step mapping", () => {
  test("joins a successful tool call to its output by toolCallId", async () => {
    const echo = tool({
      description: "echo",
      inputSchema: z.object({ n: z.number() }),
      execute: async ({ n }) => ({ doubled: n * 2 }),
    });
    const model = new MockLanguageModelV4({
      doGenerate: [toolCallStep("echo", { n: 21 }), textStep("done")],
    });

    const result = await runExchange(logWith("go"), TURN, {
      model,
      instructions: "x",
      tools: { echo },
      maxSteps: 4,
    });

    const call = result.steps[0]?.toolCalls[0];
    expect(call?.toolName).toBe("echo");
    expect(call?.input).toEqual({ n: 21 });
    expect(call?.output).toEqual({ doubled: 42 });
    expect(call?.error).toBeUndefined();
  });

  test("surfaces a failed tool execution as a tool-call error (not lost)", async () => {
    const boom = tool({
      description: "always throws",
      inputSchema: z.object({ reason: z.string() }),
      // Explicit return type: a throw-only body infers `never`, which poisons the
      // tool's schema inference (FlexibleSchema<never>).
      execute: async (): Promise<{ ok: boolean }> => {
        throw new Error("kaboom");
      },
    });
    const model = new MockLanguageModelV4({
      doGenerate: [toolCallStep("boom", { reason: "x" }), textStep("recovered")],
    });

    const result = await runExchange(logWith("go"), TURN, {
      model,
      instructions: "x",
      tools: { boom },
      maxSteps: 4,
    });

    const call = result.steps[0]?.toolCalls[0];
    expect(call?.toolName).toBe("boom");
    expect(call?.output).toBeUndefined();
    expect(call?.error).toBeInstanceOf(Error);
    expect((call?.error as Error).message).toContain("kaboom");
    // The loop still completed to a final answer.
    expect(result.text).toBe("recovered");
  });

  test("returns the exact rendered prompt (single render path)", async () => {
    const model = new MockLanguageModelV4({ doGenerate: [textStep("hi")] });
    const result = await runExchange(logWith("hello"), TURN, { model, instructions: "x", tools: {}, maxSteps: 2 });
    expect(result.prompt.length).toBeGreaterThan(0);
    expect(String(result.prompt.at(-1)?.content)).toContain("conversation: #t");
  });
});

describe("recordDurableTranscripts", () => {
  const NOW = () => new Date("2026-02-02T00:00:00.000Z");

  test("records a successful call to a durable-flagged tool", async () => {
    const echo = tool({
      description: "echo",
      inputSchema: z.object({ n: z.number() }),
      execute: async ({ n }) => ({ doubled: n * 2 }),
    });
    const model = new MockLanguageModelV4({ doGenerate: [toolCallStep("echo", { n: 5 }), textStep("done")] });
    const log = logWith("go");
    const result = await runExchange(log, TURN, { model, instructions: "x", tools: { echo }, maxSteps: 4 });

    recordDurableTranscripts(log, result, new Set(["echo"]), NOW);

    const transcript = log.events().find((e) => e.kind === "tool-transcript");
    expect(transcript).toMatchObject({
      kind: "tool-transcript",
      tool: "echo",
      input: { n: 5 },
      output: { doubled: 10 },
      at: NOW().toISOString(),
    });
  });

  test("does not record a call to a tool not in durableNames", async () => {
    const echo = tool({
      description: "echo",
      inputSchema: z.object({ n: z.number() }),
      execute: async ({ n }) => ({ doubled: n * 2 }),
    });
    const model = new MockLanguageModelV4({ doGenerate: [toolCallStep("echo", { n: 5 }), textStep("done")] });
    const log = logWith("go");
    const result = await runExchange(log, TURN, { model, instructions: "x", tools: { echo }, maxSteps: 4 });

    recordDurableTranscripts(log, result, new Set(["some_other_tool"]), NOW);

    expect(log.events().some((e) => e.kind === "tool-transcript")).toBe(false);
  });

  test("never records a failed call, even if the tool is durable-flagged", async () => {
    const boom = tool({
      description: "always throws",
      inputSchema: z.object({ reason: z.string() }),
      execute: async (): Promise<{ ok: boolean }> => {
        throw new Error("kaboom");
      },
    });
    const model = new MockLanguageModelV4({ doGenerate: [toolCallStep("boom", { reason: "x" }), textStep("recovered")] });
    const log = logWith("go");
    const result = await runExchange(log, TURN, { model, instructions: "x", tools: { boom }, maxSteps: 4 });

    recordDurableTranscripts(log, result, new Set(["boom"]), NOW);

    expect(log.events().some((e) => e.kind === "tool-transcript")).toBe(false);
  });

  test("truncates long string fields (e.g. paste's uploaded file content) rather than storing them in full — a durable transcript replays into every future prompt", async () => {
    const bigContent = "x".repeat(2000);
    const echo = tool({
      description: "echo",
      inputSchema: z.object({ title: z.string(), content: z.string() }),
      execute: async ({ title, content }) => ({ id: ":abc123", url: "https://mojo.v00l.com/:abc123", title, content }),
    });
    const model = new MockLanguageModelV4({
      doGenerate: [toolCallStep("echo", { title: "My Paste", content: bigContent }), textStep("done")],
    });
    const log = logWith("go");
    const result = await runExchange(log, TURN, { model, instructions: "x", tools: { echo }, maxSteps: 4 });

    recordDurableTranscripts(log, result, new Set(["echo"]), NOW);

    const transcript = log.events().find((e) => e.kind === "tool-transcript") as any;
    // Short, useful fields survive intact...
    expect(transcript.input.title).toBe("My Paste");
    expect(transcript.output.id).toBe(":abc123");
    expect(transcript.output.url).toBe("https://mojo.v00l.com/:abc123");
    // ...but the large field is capped, not stored verbatim.
    expect(transcript.input.content.length).toBeLessThan(bigContent.length);
    expect(transcript.input.content).toContain("truncated");
    expect(transcript.output.content).toContain("truncated");
  });

  test("does not truncate a string at or under the cap", async () => {
    const echo = tool({
      description: "echo",
      inputSchema: z.object({ note: z.string() }),
      execute: async ({ note }) => ({ note }),
    });
    const shortNote = "y".repeat(500); // exactly at the cap
    const model = new MockLanguageModelV4({ doGenerate: [toolCallStep("echo", { note: shortNote }), textStep("done")] });
    const log = logWith("go");
    const result = await runExchange(log, TURN, { model, instructions: "x", tools: { echo }, maxSteps: 4 });

    recordDurableTranscripts(log, result, new Set(["echo"]), NOW);

    const transcript = log.events().find((e) => e.kind === "tool-transcript") as any;
    expect(transcript.output.note).toBe(shortNote);
  });
});

describe("recordSubagentBriefings", () => {
  const NOW = () => new Date("2026-02-02T00:00:00.000Z");

  test("records a successful call to a subagent tool as a subagent-briefing event", async () => {
    const research = tool({
      description: "research",
      inputSchema: z.object({ topic: z.string() }),
      execute: async ({ topic }) => ({ summary: `about ${topic}`, confidence: "high" }),
    });
    const model = new MockLanguageModelV4({ doGenerate: [toolCallStep("research_topic", { topic: "bun" }), textStep("done")] });
    const log = logWith("go");
    const result = await runExchange(log, TURN, { model, instructions: "x", tools: { research_topic: research }, maxSteps: 4 });

    recordSubagentBriefings(log, result, new Set(["research_topic"]), NOW);

    const briefing = log.events().find((e) => e.kind === "subagent-briefing");
    expect(briefing).toMatchObject({
      kind: "subagent-briefing",
      agent: "research_topic",
      briefing: { summary: "about bun", confidence: "high" },
      at: NOW().toISOString(),
    });
  });

  test("does not record a call to a tool not in subagentNames", async () => {
    const research = tool({
      description: "research",
      inputSchema: z.object({ topic: z.string() }),
      execute: async ({ topic }) => ({ summary: topic }),
    });
    const model = new MockLanguageModelV4({ doGenerate: [toolCallStep("research_topic", { topic: "bun" }), textStep("done")] });
    const log = logWith("go");
    const result = await runExchange(log, TURN, { model, instructions: "x", tools: { research_topic: research }, maxSteps: 4 });

    recordSubagentBriefings(log, result, new Set(["some_other_agent"]), NOW);

    expect(log.events().some((e) => e.kind === "subagent-briefing")).toBe(false);
  });

  test("never records a failed subagent call, even if the tool is in subagentNames", async () => {
    const research = tool({
      description: "always throws",
      inputSchema: z.object({ topic: z.string() }),
      execute: async (): Promise<{ summary: string }> => {
        throw new Error("subagent exceeded budget");
      },
    });
    const model = new MockLanguageModelV4({ doGenerate: [toolCallStep("research_topic", { topic: "bun" }), textStep("recovered")] });
    const log = logWith("go");
    const result = await runExchange(log, TURN, { model, instructions: "x", tools: { research_topic: research }, maxSteps: 4 });

    recordSubagentBriefings(log, result, new Set(["research_topic"]), NOW);

    expect(log.events().some((e) => e.kind === "subagent-briefing")).toBe(false);
  });

  test("truncates a long string field (a schema bounds finding/source COUNTS, not string sizes) — a briefing replays into every future prompt just like a tool transcript", async () => {
    const longSummary = "z".repeat(2000);
    const research = tool({
      description: "research",
      inputSchema: z.object({ topic: z.string() }),
      execute: async () => ({ summary: longSummary, url: "https://example.com/short-and-fine" }),
    });
    const model = new MockLanguageModelV4({ doGenerate: [toolCallStep("research_topic", { topic: "bun" }), textStep("done")] });
    const log = logWith("go");
    const result = await runExchange(log, TURN, { model, instructions: "x", tools: { research_topic: research }, maxSteps: 4 });

    recordSubagentBriefings(log, result, new Set(["research_topic"]), NOW);

    const briefing = log.events().find((e) => e.kind === "subagent-briefing") as any;
    expect(briefing.briefing.summary.length).toBeLessThan(longSummary.length);
    expect(briefing.briefing.summary).toContain("truncated");
    // Short/structural fields survive intact.
    expect(briefing.briefing.url).toBe("https://example.com/short-and-fine");
  });
});
