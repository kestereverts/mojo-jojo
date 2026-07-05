import type { Tool } from "ai";
import type { PromptSection } from "../prompt/sections.ts";

/**
 * One registrable tool: the AI SDK tool itself, optional colocated prompt
 * guidance (folded into the assembled instructions — see
 * `prompt/instructions.ts`), and whether a successful call is worth
 * remembering across turns.
 *
 * `durableTranscript` is the M4 "selective transcripts" decision made
 * concrete: ephemeral lookups (time/weather/currency/letter-count — true for
 * every tool in this batch) age out instantly and aren't persisted; a later
 * batch (paste URLs, research briefings) sets this `true` so those results
 * survive into durable memory as `ToolTranscriptEvent`s.
 */
export interface ToolDefinition {
  readonly name: string;
  // `any` is deliberate: each tool's own input/output types are checked where
  // it's defined (via `tool({...})`); the registry holds a heterogeneous list
  // and must erase them to compose into one `ToolSet`.
  readonly tool: Tool<any, any>;
  readonly guidance?: PromptSection;
  readonly durableTranscript: boolean;
}
