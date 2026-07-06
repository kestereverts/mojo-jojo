import { z } from "zod";
import { defineSubagent, subagentAsTool, type RunSubagentDeps } from "./define.ts";
import { webSearchTool } from "../tools/web-search.ts";
import { webReaderTool } from "../tools/web-reader.ts";
import type { ToolDefinition } from "../tools/define.ts";

const MAX_FINDINGS = 5;
const MAX_SOURCES = 6;

export const ResearchBriefingSchema = z.object({
  summary: z.string().describe("A compact, information-dense briefing note — usually 3-6 sentences. Include what changed, why it matters, and any uncertainty."),
  findings: z
    .array(z.object({ claim: z.string(), sourceUrls: z.array(z.string()) }))
    .max(MAX_FINDINGS)
    .describe("Key factual claims, each attributed to the source URL(s) that support it."),
  sources: z
    .array(z.object({ title: z.string(), url: z.string() }))
    .max(MAX_SOURCES)
    .describe("Sources actually read (not just search results seen)."),
  confidence: z.enum(["high", "medium", "low"]),
  incomplete: z.boolean().describe("True if evidence was weak, a budget limit was hit, or sources conflicted."),
});
export type ResearchBriefing = z.infer<typeof ResearchBriefingSchema>;

const ResearchInputSchema = z.object({
  topic: z.string().describe("The topic or question to research on the web."),
  objective: z
    .string()
    .optional()
    .describe("What kind of answer to bring back, e.g. recent news, a comparison, a factual summary."),
});
export type ResearchInput = z.infer<typeof ResearchInputSchema>;

function researchInstructions(input: ResearchInput): string {
  const nowUtc = new Date().toISOString();
  return `You are a specialist web research subagent working for another assistant. Investigate the given topic using your tools and return a structured briefing.

The current UTC date and time is ${nowUtc}. Use this as authoritative when deciding what is current, recent, today, this week, or outdated.

Topic: ${input.topic}
${input.objective ? `Objective: ${input.objective}` : ""}

Rules:
- Use web_search when you need candidate sources.
- Do not rely on search snippets alone. After searching, read at least one relevant result with web_reader before concluding.
- Rank source quality: prefer official announcements, vendor docs, company newsroom posts, regulator/government pages, standards bodies, and original papers first. Use reputable secondary reporting to corroborate broad/current/news topics. Avoid aggregators, reposts, and low-signal SEO pages when a stronger source is available.
- For broad/current/news topics, try to read and cite 2 distinct relevant sources when reasonably available. For a narrow factual lookup or a clear primary source, 1 strong source is acceptable.
- Treat tool outputs as ground truth. Refine your search if the first results are weak, outdated, or irrelevant.
- Stop when you have enough evidence; do not keep browsing unnecessarily.
- Prefer 1-2 strong sources over many weak ones.
- If evidence is weak, a budget limit is hit, or sources conflict, set incomplete=true and lower confidence accordingly.
- findings: max ${MAX_FINDINGS}. sources: max ${MAX_SOURCES} — only sources you actually read, not every search result seen.`;
}

export function researchSubagent() {
  return defineSubagent({
    name: "research_topic",
    description:
      "Delegate open-ended web research to a specialist subagent. Use by default when asked to research, look up, find out, " +
      "or summarize recent/current information from multiple web sources. Returns a structured briefing with summary, findings, and sources.",
    instructions: researchInstructions,
    tools: { web_search: webSearchTool().tool, web_reader: webReaderTool().tool },
    modelRole: "research",
    inputSchema: ResearchInputSchema,
    outputSchema: ResearchBriefingSchema,
    budget: { maxSteps: 8, timeoutMs: 60_000 },
    guidance: {
      id: "tool-research-topic",
      title: "research_topic",
      body: `Call by default when the user asks you to research, look up, find out, or summarize recent/current information from multiple sources. Keep using web_reader directly for one specific URL; use web_search/web_reader directly only as a fallback when delegated research is unnecessary, incomplete, or fails.`,
    },
  });
}

/** Convenience: `research_topic` as a `ToolDefinition`, ready for `defaultToolDefinitions()`. */
export function researchTopicTool(deps: RunSubagentDeps): ToolDefinition {
  return subagentAsTool(researchSubagent(), deps);
}
