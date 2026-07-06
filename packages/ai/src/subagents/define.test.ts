import { describe, expect, test } from "bun:test";
import { MockLanguageModelV4 } from "ai/test";
import { tool } from "ai";
import { z } from "zod";
import { defineSubagent, runSubagent, subagentAsTool } from "./define.ts";
import type { ModelRoles } from "../models.ts";

const usage = {
  inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 2, text: 2, reasoning: undefined },
};

function textResult(text: string) {
  return {
    content: [{ type: "text" as const, text }],
    finishReason: { unified: "stop" as const, raw: undefined },
    usage,
    warnings: [],
  };
}

function toolCallResult(toolName: string, toolCallId: string, input: object) {
  return {
    content: [{ type: "tool-call" as const, toolCallId, toolName, input: JSON.stringify(input) }],
    finishReason: { unified: "tool-calls" as const, raw: undefined },
    usage,
    warnings: [],
  };
}

const OUTPUT_SCHEMA = z.object({ summary: z.string(), count: z.number() });
const INPUT_SCHEMA = z.object({ topic: z.string() });

const MODELS: ModelRoles = { chat: "openai/x", classifier: "openai/x", summarizer: "openai/x", research: "openai/x", embedding: "openai/x" };

function baseDef(overrides: Partial<Parameters<typeof defineSubagent<z.infer<typeof INPUT_SCHEMA>, z.infer<typeof OUTPUT_SCHEMA>>>[0]> = {}) {
  return defineSubagent({
    name: "test_agent",
    description: "test",
    instructions: "test instructions",
    tools: {},
    modelRole: "research",
    inputSchema: INPUT_SCHEMA,
    outputSchema: OUTPUT_SCHEMA,
    budget: { maxSteps: 4, timeoutMs: 5000 },
    ...overrides,
  });
}

describe("runSubagent", () => {
  test("runs the tool loop and returns schema-validated structured output", async () => {
    const echo = tool({
      description: "echo",
      inputSchema: z.object({ n: z.number() }),
      execute: async ({ n }: { n: number }) => ({ doubled: n * 2 }),
    });
    const model = new MockLanguageModelV4({
      doGenerate: [toolCallResult("echo", "c1", { n: 5 }), textResult(JSON.stringify({ summary: "done", count: 10 }))],
    });
    const def = baseDef({ tools: { echo } });

    const output = await runSubagent(def, { topic: "bun" }, { models: MODELS, model });
    expect(output).toEqual({ summary: "done", count: 10 });
  });

  test("retries once, with feedback, after a schema-validation failure — and succeeds if the retry produces valid output", async () => {
    let callCount = 0;
    let secondCallInstructions = "";
    const model = new MockLanguageModelV4({
      doGenerate: async (opts) => {
        callCount++;
        if (callCount === 1) return textResult("not valid json {{{");
        secondCallInstructions = String(opts.prompt?.find?.((m: any) => m.role === "system")?.content ?? "");
        return textResult(JSON.stringify({ summary: "recovered", count: 1 }));
      },
    });
    const def = baseDef();

    const output = await runSubagent(def, { topic: "bun" }, { models: MODELS, model });
    expect(output).toEqual({ summary: "recovered", count: 1 });
    expect(callCount).toBe(2);
    expect(secondCallInstructions).toContain("did not produce valid structured output");
  });

  test("propagates the error when BOTH attempts fail schema validation (no third try)", async () => {
    let callCount = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        callCount++;
        return textResult("still not valid json");
      },
    });
    const def = baseDef();

    expect(runSubagent(def, { topic: "bun" }, { models: MODELS, model })).rejects.toThrow();
    // Give the rejected promise a tick to settle before checking call count.
    await new Promise((r) => setTimeout(r, 10));
    expect(callCount).toBe(2);
  });

  test("a non-schema error (e.g. a tool throwing) propagates immediately, without the schema-failure retry", async () => {
    let callCount = 0;
    const boom = tool({
      description: "always throws",
      inputSchema: z.object({}),
      execute: async (): Promise<{ ok: boolean }> => {
        throw new Error("kaboom");
      },
    });
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        callCount++;
        throw new Error("network exploded");
      },
    });
    const def = baseDef({ tools: { boom } });

    expect(runSubagent(def, { topic: "bun" }, { models: MODELS, model })).rejects.toThrow(/network exploded/);
    await new Promise((r) => setTimeout(r, 10));
    expect(callCount).toBe(1);
  });

  test("a run exceeding its budget's timeoutMs throws", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        await new Promise((r) => setTimeout(r, 500));
        return textResult(JSON.stringify({ summary: "too slow", count: 1 }));
      },
    });
    const def = baseDef({ budget: { maxSteps: 4, timeoutMs: 50 } });

    expect(runSubagent(def, { topic: "bun" }, { models: MODELS, model })).rejects.toThrow(/exceeded 50ms/);
  });

  test("instructions-as-a-function receives the parsed input", async () => {
    let sentSystemPrompt = "";
    const model = new MockLanguageModelV4({
      doGenerate: async (opts) => {
        sentSystemPrompt = String((opts.prompt?.find?.((m: any) => m.role === "system") as any)?.content ?? "");
        return textResult(JSON.stringify({ summary: "ok", count: 1 }));
      },
    });
    const def = baseDef({ instructions: (input) => `Research this: ${input.topic}` });

    await runSubagent(def, { topic: "quantum computing" }, { models: MODELS, model });
    expect(sentSystemPrompt).toContain("quantum computing");
  });
});

describe("subagentAsTool", () => {
  test("wraps a subagent definition into a usable ToolDefinition", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => textResult(JSON.stringify({ summary: "wrapped", count: 1 })),
    });
    const def = baseDef({ guidance: { id: "g", title: "test_agent", body: "Call this for testing." } });
    const toolDef = subagentAsTool(def, { models: MODELS, model });

    expect(toolDef.name).toBe("test_agent");
    expect(toolDef.durableTranscript).toBe(false);
    expect(toolDef.guidance?.body).toBe("Call this for testing.");

    const result = await toolDef.tool.execute!({ topic: "bun" }, { abortSignal: undefined } as never);
    expect(result).toEqual({ summary: "wrapped", count: 1 });
  });
});
