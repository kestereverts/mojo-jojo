import { describe, expect, test } from "bun:test";
import { tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";
import { InMemoryContextLog } from "./context/log.ts";
import type { TurnContext } from "./context/events.ts";
import { runExchange } from "./exchange.ts";

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
  log.append({ kind: "chat-message", at: TURN.nowUtc, speaker: { nick: "a" }, text, addressed: true });
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
