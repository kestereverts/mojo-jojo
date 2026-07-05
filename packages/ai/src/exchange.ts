import {
  ToolLoopAgent,
  stepCountIs,
  type LanguageModel,
  type LanguageModelUsage,
  type ModelMessage,
  type ToolSet,
} from "ai";
import type { TurnContext } from "./context/events.ts";
import type { ContextLog } from "./context/log.ts";
import { renderPrompt } from "./context/render.ts";
import { resolveModel } from "./models.ts";

export interface ExchangeOptions {
  /**
   * Either a `"provider/model-id"` spec (resolved via {@link resolveModel}) or a
   * pre-built `LanguageModel` instance. The instance form is the injection seam
   * for tests (a mock model) — it never touches the provider registry.
   */
  readonly model: string | LanguageModel;
  /** System prompt / persona. */
  readonly instructions: string;
  readonly tools?: ToolSet;
  /** Tool-loop iteration bound (model call + tool round = one step). */
  readonly maxSteps?: number;
  /** Wall-clock bound for the whole exchange. */
  readonly timeoutMs?: number;
  /** Cancels the exchange (e.g. module disposal, supersession). */
  readonly signal?: AbortSignal;
}

/** One tool invocation within a step, flattened for inspection/recording. */
export interface ExchangeToolCall {
  readonly toolName: string;
  readonly input: unknown;
  /** The tool's result, when execution succeeded. */
  readonly output?: unknown;
  /**
   * The thrown error, when execution failed. In AI SDK v7 a failed tool
   * execution is a `tool-error` content part (not a `toolResults` entry), so a
   * call surfaces exactly one of `output` / `error`.
   */
  readonly error?: unknown;
}

/** A single model-call step of the tool loop. */
export interface ExchangeStep {
  readonly index: number;
  readonly text: string;
  readonly finishReason: string;
  readonly toolCalls: readonly ExchangeToolCall[];
  readonly usage: LanguageModelUsage;
  /** Total wall time for the step (model + client-side tool execution), ms. */
  readonly stepTimeMs: number;
  /** Time spent awaiting the model response, ms. */
  readonly responseTimeMs: number;
}

/**
 * The full outcome of an exchange. `text` is what the live module delivers; the
 * rest is what the debug CLI inspects. Both consumers run through this one
 * function, so inspection is never a divergent build path — `prompt` is exactly
 * the projection that was sent to the model.
 */
export interface ExchangeResult {
  readonly text: string;
  /** The rendered projection (`renderPrompt` output) that was sent this turn. */
  readonly prompt: ModelMessage[];
  readonly steps: readonly ExchangeStep[];
  /** Aggregate token usage across all steps. */
  readonly usage: LanguageModelUsage;
  readonly finishReason: string;
  /** Wall-clock duration of the whole exchange, ms. */
  readonly wallMs: number;
}

/**
 * One full agentic exchange: project the log + turn context into a prompt and
 * run the tool loop until the model produces text. Pure with respect to the
 * log — the caller appends the reply *as actually sent* (post-truncation), so
 * memory always matches what users saw.
 *
 * TODO(next): validators (reject-and-retry on ungrounded replies), subagents,
 * streaming via `agent.stream()`.
 */
export async function runExchange(
  log: ContextLog,
  turn: TurnContext,
  options: ExchangeOptions,
): Promise<ExchangeResult> {
  const agent = new ToolLoopAgent({
    model: typeof options.model === "string" ? resolveModel(options.model) : options.model,
    instructions: options.instructions,
    tools: options.tools ?? {},
    stopWhen: stepCountIs(options.maxSteps ?? 8),
  });

  const prompt = renderPrompt(log.events(), turn);
  const startedAt = performance.now();
  const result = await agent.generate({
    messages: prompt,
    abortSignal: options.signal,
    timeout: options.timeoutMs ?? 60_000,
  });
  const wallMs = performance.now() - startedAt;

  const steps: ExchangeStep[] = result.steps.map((step, index) => {
    const outputByCallId = new Map(step.toolResults.map((r) => [r.toolCallId, r.output]));
    // Failed tool executions are `tool-error` content parts, not `toolResults`.
    const errorByCallId = new Map<string, unknown>();
    for (const part of step.content) {
      if (part.type === "tool-error") errorByCallId.set(part.toolCallId, part.error);
    }
    return {
      index,
      text: step.text,
      finishReason: step.finishReason,
      toolCalls: step.toolCalls.map((call) => ({
        toolName: call.toolName,
        input: call.input,
        output: outputByCallId.get(call.toolCallId),
        error: errorByCallId.get(call.toolCallId),
      })),
      usage: step.usage,
      stepTimeMs: step.performance.stepTimeMs,
      responseTimeMs: step.performance.responseTimeMs,
    };
  });

  return {
    text: result.text.trim(),
    prompt,
    steps,
    usage: result.usage,
    finishReason: result.finishReason,
    wallMs,
  };
}

/**
 * Append a {@link ToolTranscriptEvent} for every successful call to a
 * `durableTranscript`-flagged tool. Called once, identically, by both the
 * live module and the debug harness right after `runExchange` resolves — the
 * same "single call site" discipline as `buildDefaultInstructions`, so live
 * and CLI can never silently disagree on which tool results get remembered.
 * A failed call (`error` set) is never recorded — memory should reflect what
 * actually happened, not a call that didn't produce a usable result.
 */
export function recordDurableTranscripts(
  log: ContextLog,
  result: ExchangeResult,
  durableNames: ReadonlySet<string>,
  now: () => Date = () => new Date(),
): void {
  for (const step of result.steps) {
    for (const call of step.toolCalls) {
      if (call.error !== undefined || !durableNames.has(call.toolName)) continue;
      log.append({ kind: "tool-transcript", at: now().toISOString(), tool: call.toolName, input: call.input, output: call.output });
    }
  }
}
