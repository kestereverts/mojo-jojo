import { tool } from "ai";
import { z } from "zod";
import { fetchText } from "./http.ts";
import type { ToolDefinition } from "./define.ts";

function requireAppId(): string {
  const id = process.env.WOLFRAM_ALPHA_APP_ID;
  if (!id) throw new Error("WOLFRAM_ALPHA_APP_ID is not configured");
  return id;
}

/**
 * Computational/factual queries via Wolfram|Alpha's **LLM API**
 * (`/api/v1/llm-api`) — mojo-ai3 used the older Short Answers API, which
 * returns a single plain-text line with no structured pods. The LLM API
 * returns a richer plain-text response (query/interpretation/result and,
 * when relevant, extra sections) purpose-built for feeding to a model,
 * within a `maxchars` budget. A 501 means the query couldn't be interpreted;
 * that response body itself often contains suggested rephrasings, so it's
 * returned as the error message rather than a generic failure.
 */
export function wolframAlphaTool(): ToolDefinition {
  return {
    name: "wolfram_alpha",
    durableTranscript: false,
    tool: tool({
      description: "Computational knowledge: math, unit conversions, scientific/statistical data, date calculations, and similar factual queries.",
      inputSchema: z.object({
        query: z.string().describe('A single atomic query, e.g. "integrate x^2 dx" or "boiling point of ethanol"'),
      }),
      execute: async ({ query }) => {
        const appId = requireAppId();
        const url = `https://www.wolframalpha.com/api/v1/llm-api?appid=${appId}&input=${encodeURIComponent(query)}&maxchars=2000`;
        const res = await fetchText(url);
        if (res.status === 501) {
          throw new Error(`could not interpret "${query}": ${res.text.trim().slice(0, 300)}`);
        }
        if (!res.ok) throw new Error(`Wolfram Alpha API error: HTTP ${res.status}`);
        return { query, result: res.text.trim() };
      },
    }),
    guidance: {
      id: "tool-wolfram-alpha",
      title: "wolfram_alpha",
      body: `Call for math, unit conversions, scientific/statistical data, date calculations, and similar computational queries. Query discipline is critical: each call must cover ONE single atomic quantity — never mix multiple unknowns or conditions in one query. Before making any calls, identify every value you need and plan the full sequence of lookups; execute them in order and combine results yourself. GOOD: "saturation vapor pressure of water at 12C". BAD: "relative humidity at 21C with dew point 12C at 47% humidity" (multiple unknowns — will fail to interpret). If a query fails, do NOT rephrase the same compound query — split it into atomic lookups instead.`,
    },
  };
}
