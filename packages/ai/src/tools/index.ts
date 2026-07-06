import type { ToolSet } from "ai";
import type { PromptSection } from "../prompt/sections.ts";
import type { ToolDefinition } from "./define.ts";
import { currencyConvertTool } from "./currency.ts";
import { getPasteTool } from "./get-paste.ts";
import { letterCountTool } from "./letter-count.ts";
import { localTimeTool } from "./local-time.ts";
import { pasteTool } from "./paste.ts";
import { placesSearchTool } from "./places-search.ts";
import { weatherForecastTool } from "./weather.ts";
import { webReaderTool } from "./web-reader.ts";
import { webSearchTool } from "./web-search.ts";
import { wolframAlphaTool } from "./wolfram.ts";

/** One enabled tool's own metadata, kept alongside the folded views below for callers (like `mojo-ai-debug tools`) that need a direct name→guidance link rather than reconstructing it from parallel arrays. */
export interface ToolRegistryEntry {
  readonly name: string;
  readonly guidance?: PromptSection;
  readonly durableTranscript: boolean;
}

export interface ToolRegistryResult {
  readonly tools: ToolSet;
  /** Per-tool guidance, in registry order — folded into the assembled instructions. */
  readonly guidance: readonly PromptSection[];
  /** Names of enabled tools whose successful calls should be persisted as durable transcripts. */
  readonly durableNames: ReadonlySet<string>;
  /** Every enabled tool's own metadata, in registry order. */
  readonly entries: readonly ToolRegistryEntry[];
}

/**
 * Assemble a `ToolSet` (+ its guidance + which calls are memory-worthy) from a
 * definition list, honoring the `disabled` config list. A disabled tool
 * disappears entirely — no entry in `tools`, no guidance, never durable —
 * rather than being present-but-inert.
 */
export function buildToolSet(defs: readonly ToolDefinition[], disabled: readonly string[] = []): ToolRegistryResult {
  const skip = new Set(disabled);
  const tools: Record<string, ToolSet[string]> = {};
  const guidance: PromptSection[] = [];
  const durableNames = new Set<string>();
  const entries: ToolRegistryEntry[] = [];

  for (const def of defs) {
    if (skip.has(def.name)) continue;
    tools[def.name] = def.tool;
    if (def.guidance) guidance.push(def.guidance);
    if (def.durableTranscript) durableNames.add(def.name);
    entries.push({ name: def.name, guidance: def.guidance, durableTranscript: def.durableTranscript });
  }

  return { tools, guidance, durableNames, entries };
}

/**
 * The built-in tools, in a fixed, deterministic order. `research_topic` (a
 * subagent) lands in M6.
 */
export function defaultToolDefinitions(): ToolDefinition[] {
  return [
    letterCountTool(),
    localTimeTool(),
    currencyConvertTool(),
    weatherForecastTool(),
    wolframAlphaTool(),
    webSearchTool(),
    webReaderTool(),
    pasteTool(),
    getPasteTool(),
    placesSearchTool(),
  ];
}
