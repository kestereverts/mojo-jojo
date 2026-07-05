import { describe, expect, test } from "bun:test";
import { tool } from "ai";
import { z } from "zod";
import { buildToolSet, defaultToolDefinitions } from "./index.ts";
import type { ToolDefinition } from "./define.ts";

function fakeDef(name: string, opts: { guidance?: boolean; durableTranscript?: boolean } = {}): ToolDefinition {
  return {
    name,
    tool: tool({
      description: name,
      inputSchema: z.object({}),
      execute: async () => ({ ok: true }),
    }),
    ...(opts.guidance ? { guidance: { id: `g-${name}`, title: name, body: `guidance for ${name}` } } : {}),
    durableTranscript: opts.durableTranscript ?? false,
  };
}

describe("buildToolSet", () => {
  test("includes every def by default, collects guidance in order, tracks durable names", () => {
    const defs = [
      fakeDef("a", { guidance: true }),
      fakeDef("b", { guidance: true, durableTranscript: true }),
      fakeDef("c"), // no guidance
    ];
    const result = buildToolSet(defs);
    expect(Object.keys(result.tools)).toEqual(["a", "b", "c"]);
    expect(result.guidance.map((g) => g.id)).toEqual(["g-a", "g-b"]);
    expect(result.durableNames.has("b")).toBe(true);
    expect(result.durableNames.has("a")).toBe(false);
  });

  test("a disabled tool disappears entirely — no entry, no guidance, never durable", () => {
    const defs = [fakeDef("a", { guidance: true, durableTranscript: true }), fakeDef("b")];
    const result = buildToolSet(defs, ["a"]);
    expect(Object.keys(result.tools)).toEqual(["b"]);
    expect(result.guidance).toEqual([]);
    expect(result.durableNames.has("a")).toBe(false);
  });

  test("empty definitions and default disabled list produce an empty registry", () => {
    const result = buildToolSet([]);
    expect(result.tools).toEqual({});
    expect(result.guidance).toEqual([]);
    expect(result.durableNames.size).toBe(0);
    expect(result.entries).toEqual([]);
  });

  test("entries expose each enabled tool's own name/guidance/durableTranscript directly — no fragile title-matching needed by callers", () => {
    const defs = [fakeDef("a", { guidance: true }), fakeDef("b", { durableTranscript: true }), fakeDef("c")];
    const result = buildToolSet(defs, ["c"]);
    expect(result.entries).toEqual([
      { name: "a", guidance: { id: "g-a", title: "a", body: "guidance for a" }, durableTranscript: false },
      { name: "b", guidance: undefined, durableTranscript: true },
    ]);
  });
});

describe("defaultToolDefinitions", () => {
  test("returns exactly M4's five tools, all non-durable, all with guidance", () => {
    const defs = defaultToolDefinitions();
    expect(defs.map((d) => d.name).sort()).toEqual([
      "currency_convert",
      "letter_count",
      "local_time",
      "weather_forecast",
      "wolfram_alpha",
    ]);
    for (const def of defs) {
      expect(def.durableTranscript).toBe(false);
      expect(def.guidance).toBeDefined();
    }
  });
});
