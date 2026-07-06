import { NoObjectGeneratedError, Output, ToolLoopAgent, stepCountIs, type LanguageModel, type Tool, type ToolSet } from "ai";
import type { z } from "zod";
import { resolveModel } from "../models.ts";
import type { ModelRoles } from "../models.ts";
import type { PromptSection } from "../prompt/sections.ts";
import type { ToolDefinition } from "../tools/define.ts";

export interface SubagentBudget {
  /** Tool-loop iteration bound (model call + tool round = one step). */
  readonly maxSteps: number;
  /** Wall-clock bound for the whole subagent run, including the one retry. */
  readonly timeoutMs: number;
}

export interface SubagentDefinition<TInput, TOutput> {
  readonly name: string;
  readonly description: string;
  /** Static instructions, or a function of the parsed input (e.g. to inject the topic/objective directly into the system prompt). */
  readonly instructions: string | ((input: TInput) => string);
  readonly tools: ToolSet;
  /** Which {@link ModelRoles} entry resolves this subagent's model — independent of the main chat model. */
  readonly modelRole: keyof ModelRoles;
  readonly inputSchema: z.ZodType<TInput>;
  readonly outputSchema: z.ZodType<TOutput>;
  readonly budget: SubagentBudget;
  /** Colocated guidance for the parent agent's instructions when exposed via {@link subagentAsTool} — same convention as {@link ToolDefinition}. */
  readonly guidance?: PromptSection;
}

/** Identity function with a name — a subagent definition is fully described by its literal shape; nothing to construct. */
export function defineSubagent<TInput, TOutput>(def: SubagentDefinition<TInput, TOutput>): SubagentDefinition<TInput, TOutput> {
  return def;
}

export interface RunSubagentDeps {
  readonly models: ModelRoles;
  /**
   * Override the resolved model directly, bypassing `modelRole`/spec
   * resolution entirely — the test-injection seam (e.g. a
   * `MockLanguageModelV4`), matching `ExchangeOptions.model`'s
   * `string | LanguageModel` union in `exchange.ts` but expressed here as an
   * override rather than replacing `models: ModelRoles` (which stays pure
   * config strings — every role, not just the one this subagent uses).
   */
  readonly model?: LanguageModel;
  readonly signal?: AbortSignal;
}

async function withDeadline<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Runs a subagent to completion: its own fresh `ToolLoopAgent` (own model
 * role, own tool set, own step budget), producing schema-validated
 * structured output via `Output.object` — never hand-parsed JSON. On a
 * schema-validation failure (`NoObjectGeneratedError` — the model's final
 * response didn't parse/validate), retries ONCE with the failure fed back
 * into the instructions; any other error, or a second failure, propagates to
 * the caller (for `subagentAsTool`, that becomes a normal tool-execution
 * error — the same fail path every other tool already uses, rather than a
 * synthetic "successful but empty" result masquerading as real output).
 */
export async function runSubagent<TInput, TOutput>(
  def: SubagentDefinition<TInput, TOutput>,
  input: TInput,
  deps: RunSubagentDeps,
): Promise<TOutput> {
  const model = deps.model ?? resolveModel(deps.models[def.modelRole]);
  const parsedInput = def.inputSchema.parse(input);
  const baseInstructions = typeof def.instructions === "function" ? def.instructions(parsedInput) : def.instructions;

  async function attempt(extra?: string): Promise<TOutput> {
    const agent = new ToolLoopAgent({
      model,
      instructions: extra ? `${baseInstructions}\n\n${extra}` : baseInstructions,
      tools: def.tools,
      stopWhen: stepCountIs(def.budget.maxSteps),
      output: Output.object({ schema: def.outputSchema }),
    });
    const result = await agent.generate({
      prompt: JSON.stringify(parsedInput),
      abortSignal: deps.signal,
    });
    return result.output;
  }

  try {
    return await withDeadline(attempt(), def.budget.timeoutMs, `${def.name} subagent exceeded ${def.budget.timeoutMs}ms`);
  } catch (cause) {
    if (!NoObjectGeneratedError.isInstance(cause)) throw cause;
    const reason = cause.cause instanceof Error ? cause.cause.message : String(cause.cause ?? cause.message);
    const feedback = `Your previous response did not produce valid structured output matching the required schema (${reason}). Try again and make sure your final response matches the schema exactly.`;
    return await withDeadline(attempt(feedback), def.budget.timeoutMs, `${def.name} subagent exceeded ${def.budget.timeoutMs}ms`);
  }
}

/**
 * Exposes a subagent as a regular tool for the main agent's registry —
 * `research_topic` is just another entry in `defaultToolDefinitions()`
 * alongside the plain-API tools, with no special wiring. The subagent's
 * structured output IS the tool's result (already compact by construction —
 * the output schema itself bounds findings/sources — so there's no separate
 * "toModelOutput" summarization step the way a streaming/UI subagent would
 * need). A `SubagentBriefingEvent` is appended for durable memory via
 * `recordSubagentBriefings` (`exchange.ts`), at the same single call site
 * `recordDurableTranscripts` uses — not from inside this tool's `execute`,
 * which has no access to a specific conversation's `ContextLog` (the
 * registry is built once at bot startup, shared across every conversation).
 */
export function subagentAsTool<TInput, TOutput>(
  def: SubagentDefinition<TInput, TOutput>,
  deps: RunSubagentDeps,
): ToolDefinition {
  return {
    name: def.name,
    durableTranscript: false,
    isSubagent: true,
    // Built directly rather than via the `tool()` helper: TInput/TOutput are
    // generic here, which defeats its overload inference against a literal
    // zod schema. `tool()` is a pure identity function at runtime (confirmed:
    // `function tool(tool2) { return tool2; }`), so this is exactly
    // equivalent — and ToolDefinition.tool is Tool<any, any> anyway (the
    // registry erases every tool's own types to compose into one
    // heterogeneous ToolSet — see tools/define.ts).
    tool: {
      description: def.description,
      inputSchema: def.inputSchema,
      execute: async (input: TInput, { abortSignal }: { abortSignal?: AbortSignal }) =>
        runSubagent(def, input, { ...deps, signal: abortSignal ?? deps.signal }),
    } as unknown as Tool<any, any>,
    ...(def.guidance ? { guidance: def.guidance } : {}),
  };
}
