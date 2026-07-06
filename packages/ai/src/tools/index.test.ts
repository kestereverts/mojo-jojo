import { describe, expect, test } from "bun:test";
import { tool } from "ai";
import { z } from "zod";
import { buildToolSet, defaultToolDefinitions } from "./index.ts";
import type { ToolDefinition } from "./define.ts";
import type { ModelRoles } from "../models.ts";

const MODELS: ModelRoles = { chat: "openai/x", classifier: "openai/x", summarizer: "openai/x", research: "openai/x", embedding: "openai/x" };

function fakeDef(
  name: string,
  opts: { guidance?: boolean; durableTranscript?: boolean; isSubagent?: boolean } = {},
): ToolDefinition {
  return {
    name,
    tool: tool({
      description: name,
      inputSchema: z.object({}),
      execute: async () => ({ ok: true }),
    }),
    ...(opts.guidance ? { guidance: { id: `g-${name}`, title: name, body: `guidance for ${name}` } } : {}),
    durableTranscript: opts.durableTranscript ?? false,
    ...(opts.isSubagent ? { isSubagent: true } : {}),
  };
}

describe("buildToolSet", () => {
  test("includes every def by default, collects guidance in order, tracks durable and subagent names", () => {
    const defs = [
      fakeDef("a", { guidance: true }),
      fakeDef("b", { guidance: true, durableTranscript: true }),
      fakeDef("c"), // no guidance
      fakeDef("d", { isSubagent: true }),
    ];
    const result = buildToolSet(defs);
    expect(Object.keys(result.tools)).toEqual(["a", "b", "c", "d"]);
    expect(result.guidance.map((g) => g.id)).toEqual(["g-a", "g-b"]);
    expect(result.durableNames.has("b")).toBe(true);
    expect(result.durableNames.has("a")).toBe(false);
    expect(result.subagentNames.has("d")).toBe(true);
    expect(result.subagentNames.has("a")).toBe(false);
  });

  test("a disabled tool disappears entirely — no entry, no guidance, never durable, never a subagent", () => {
    const defs = [fakeDef("a", { guidance: true, durableTranscript: true, isSubagent: true }), fakeDef("b")];
    const result = buildToolSet(defs, ["a"]);
    expect(Object.keys(result.tools)).toEqual(["b"]);
    expect(result.guidance).toEqual([]);
    expect(result.durableNames.has("a")).toBe(false);
    expect(result.subagentNames.has("a")).toBe(false);
  });

  test("empty definitions and default disabled list produce an empty registry", () => {
    const result = buildToolSet([]);
    expect(result.tools).toEqual({});
    expect(result.guidance).toEqual([]);
    expect(result.durableNames.size).toBe(0);
    expect(result.subagentNames.size).toBe(0);
    expect(result.entries).toEqual([]);
  });

  test("entries expose each enabled tool's own name/guidance/durableTranscript/isSubagent directly — no fragile title-matching needed by callers", () => {
    const defs = [fakeDef("a", { guidance: true }), fakeDef("b", { durableTranscript: true }), fakeDef("c", { isSubagent: true }), fakeDef("skip")];
    const result = buildToolSet(defs, ["skip"]);
    expect(result.entries).toEqual([
      { name: "a", guidance: { id: "g-a", title: "a", body: "guidance for a" }, durableTranscript: false, isSubagent: false },
      { name: "b", guidance: undefined, durableTranscript: true, isSubagent: false },
      { name: "c", guidance: undefined, durableTranscript: false, isSubagent: true },
    ]);
  });
});

describe("defaultToolDefinitions", () => {
  test("returns every built-in tool (incl. research_topic), all with guidance; only paste/get_paste durable, only research_topic a subagent", () => {
    const defs = defaultToolDefinitions({ models: MODELS });
    expect(defs.map((d) => d.name).sort()).toEqual([
      "currency_convert",
      "get_paste",
      "letter_count",
      "local_time",
      "paste",
      "places_search",
      "research_topic",
      "weather_forecast",
      "web_reader",
      "web_search",
      "wolfram_alpha",
    ]);
    for (const def of defs) {
      expect(def.guidance).toBeDefined();
      expect(def.durableTranscript).toBe(["paste", "get_paste"].includes(def.name));
      expect(def.isSubagent ?? false).toBe(def.name === "research_topic");
    }
  });
});
