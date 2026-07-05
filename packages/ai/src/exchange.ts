import { ToolLoopAgent, stepCountIs, type ToolSet } from "ai";
import type { TurnContext } from "./context/events.ts";
import type { ContextLog } from "./context/log.ts";
import { renderPrompt } from "./context/render.ts";
import { resolveModel } from "./models.ts";

export interface ExchangeOptions {
  /** `"provider/model-id"` spec (e.g. "google/gemini-3.5-flash"); see {@link resolveModel}. */
  readonly model: string;
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

/**
 * One full agentic exchange: project the log + turn context into a prompt and
 * run the tool loop until the model produces text. Pure with respect to the
 * log — the caller appends the reply *as actually sent* (post-truncation), so
 * memory always matches what users saw.
 *
 * TODO(next): validators (reject-and-retry on ungrounded replies), durable
 * tool transcripts, subagents, streaming via `agent.stream()`.
 */
export async function runExchange(
  log: ContextLog,
  turn: TurnContext,
  options: ExchangeOptions,
): Promise<string> {
  const agent = new ToolLoopAgent({
    model: resolveModel(options.model),
    instructions: options.instructions,
    tools: options.tools ?? {},
    stopWhen: stepCountIs(options.maxSteps ?? 8),
  });

  const result = await agent.generate({
    messages: renderPrompt(log.events(), turn),
    abortSignal: options.signal,
    timeout: options.timeoutMs ?? 60_000,
  });

  return result.text.trim();
}
