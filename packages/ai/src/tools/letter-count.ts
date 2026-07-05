import { tool } from "ai";
import { z } from "zod";
import type { ToolDefinition } from "./define.ts";

/**
 * Unicode-aware letter counting via `Intl.Segmenter` graphemes + the `\p{L}`
 * Unicode property — mojo-ai3's version only recognized `a-z` ASCII, silently
 * dropping accented and non-Latin letters.
 */
export function letterCountTool(): ToolDefinition {
  return {
    name: "letter_count",
    durableTranscript: false,
    tool: tool({
      description: "Count letter frequency in a word or piece of text (Unicode-aware, case-insensitive).",
      inputSchema: z.object({
        text: z.string().describe("The word or text to analyze"),
      }),
      execute: ({ text }) => {
        const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
        const frequencies: Record<string, number> = {};
        let textLength = 0;
        let letterCount = 0;
        for (const { segment } of segmenter.segment(text)) {
          textLength++;
          if (!/\p{L}/u.test(segment)) continue;
          // NFC-normalize before lowercasing: a precomposed "é" (one code
          // point) and a decomposed "e"+combining-acute (two) are the same
          // letter to a user, but would otherwise key the frequency map
          // separately.
          const key = segment.normalize("NFC").toLowerCase();
          frequencies[key] = (frequencies[key] ?? 0) + 1;
          letterCount++;
        }
        return { text, textLength, letterCount, uniqueLetters: Object.keys(frequencies).length, frequencies };
      },
    }),
    guidance: {
      id: "tool-letter-count",
      title: "letter_count",
      body: `Call when the user asks how many times a letter appears in a word or text (e.g. "how many r's in strawberry", "count letters in mississippi"). NEVER guess letter counts yourself — always use this tool.`,
    },
  };
}
