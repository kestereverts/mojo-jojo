import { afterEach, describe, expect, test } from "bun:test";
import { MockLanguageModelV4 } from "ai/test";
import { ResearchBriefingSchema, researchSubagent, researchTopicTool } from "./research.ts";
import { runSubagent } from "./define.ts";
import type { ModelRoles } from "../models.ts";

const usage = {
  inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 2, text: 2, reasoning: undefined },
};

const MODELS: ModelRoles = { chat: "openai/x", classifier: "openai/x", summarizer: "openai/x", research: "openai/x", embedding: "openai/x" };

const originalFetch = globalThis.fetch;
const originalBraveKey = process.env.BRAVE_SEARCH_API_KEY;
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalBraveKey === undefined) delete process.env.BRAVE_SEARCH_API_KEY;
  else process.env.BRAVE_SEARCH_API_KEY = originalBraveKey;
});

const VALID_BRIEFING = {
  summary: "Bun is a fast all-in-one JavaScript runtime, bundler, and package manager.",
  findings: [{ claim: "Bun bundles a runtime, bundler, and test runner", sourceUrls: ["https://bun.sh/"] }],
  sources: [{ title: "Bun — A fast all-in-one JavaScript runtime", url: "https://bun.sh/" }],
  confidence: "high" as const,
  incomplete: false,
};

describe("ResearchBriefingSchema", () => {
  test("accepts a well-formed briefing", () => {
    expect(ResearchBriefingSchema.parse(VALID_BRIEFING)).toEqual(VALID_BRIEFING);
  });

  test("rejects a briefing missing required fields", () => {
    expect(() => ResearchBriefingSchema.parse({ summary: "x" })).toThrow();
  });

  test("rejects more findings/sources than the documented max", () => {
    const tooMany = { ...VALID_BRIEFING, findings: Array(6).fill(VALID_BRIEFING.findings[0]) };
    expect(() => ResearchBriefingSchema.parse(tooMany)).toThrow();
  });
});

describe("researchTopicTool", () => {
  test("produces a usable ToolDefinition with guidance and no durable transcript", () => {
    const toolDef = researchTopicTool({ models: MODELS });
    expect(toolDef.name).toBe("research_topic");
    expect(toolDef.durableTranscript).toBe(false);
    expect(toolDef.guidance?.title).toBe("research_topic");
  });
});

describe("research subagent — full mocked run (real web_search/web_reader tools, mocked fetch + model)", () => {
  test("searches, reads a source, and produces a schema-valid briefing", async () => {
    process.env.BRAVE_SEARCH_API_KEY = "test-key";
    globalThis.fetch = (async (url: string) => {
      if (url.includes("api.search.brave.com")) {
        return new Response(
          JSON.stringify({
            web: { results: [{ title: "Bun — A fast all-in-one JavaScript runtime", url: "https://bun.sh/", description: "Bundle, install, and run." }] },
          }),
          { status: 200 },
        );
      }
      // web_reader's fetch, guarded by resolvePublicHttpUrl — bun.sh resolves
      // for real (this test hits real DNS for that hostname, same tradeoff
      // web-reader.test.ts already accepts), so only the HTTP body is mocked.
      const res = new Response("<html><head><title>Bun</title></head><body><article><p>Bun is a fast all-in-one JavaScript runtime.</p></article></body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
      Object.defineProperty(res, "url", { value: "https://bun.sh/" });
      return res;
    }) as unknown as typeof fetch;

    let callCount = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        callCount++;
        if (callCount === 1) {
          return {
            content: [{ type: "tool-call", toolCallId: "c1", toolName: "web_search", input: JSON.stringify({ query: "bun javascript runtime" }) }],
            finishReason: { unified: "tool-calls", raw: undefined },
            usage,
            warnings: [],
          };
        }
        if (callCount === 2) {
          return {
            content: [{ type: "tool-call", toolCallId: "c2", toolName: "web_reader", input: JSON.stringify({ url: "https://bun.sh/" }) }],
            finishReason: { unified: "tool-calls", raw: undefined },
            usage,
            warnings: [],
          };
        }
        return {
          content: [{ type: "text", text: JSON.stringify(VALID_BRIEFING) }],
          finishReason: { unified: "stop", raw: undefined },
          usage,
          warnings: [],
        };
      },
    });

    const output = await runSubagent(researchSubagent(), { topic: "bun javascript runtime" }, { models: MODELS, model });
    expect(output).toEqual(VALID_BRIEFING);
    expect(callCount).toBe(3);
  });
});
