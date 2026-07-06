import type { Tool } from "ai";
import type { PromptSection } from "../prompt/sections.ts";

/**
 * One registrable tool: the AI SDK tool itself, optional colocated prompt
 * guidance (folded into the assembled instructions — see
 * `prompt/instructions.ts`), and whether a successful call is worth
 * remembering across turns.
 *
 * `durableTranscript` is the M4 "selective transcripts" decision made
 * concrete: ephemeral lookups (time/weather/currency/letter-count) age out
 * instantly and aren't persisted; `paste`/`get_paste` (M5) set this `true` so
 * those results survive into durable memory as `ToolTranscriptEvent`s.
 *
 * `isSubagent` marks a tool built via `subagents/define.ts`'s
 * `subagentAsTool` — its successful calls are remembered via a DIFFERENT,
 * dedicated mechanism (`SubagentBriefingEvent` + `recordSubagentBriefings` in
 * `exchange.ts`), so it's always `durableTranscript: false` here.
 */
export interface ToolDefinition {
  readonly name: string;
  // `any` is deliberate: each tool's own input/output types are checked where
  // it's defined (via `tool({...})`); the registry holds a heterogeneous list
  // and must erase them to compose into one `ToolSet`.
  readonly tool: Tool<any, any>;
  readonly guidance?: PromptSection;
  readonly durableTranscript: boolean;
  readonly isSubagent?: boolean;
}
