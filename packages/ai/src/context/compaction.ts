import { generateText, type LanguageModel } from "ai";
import { resolveModel } from "../models.ts";
import type { ContextLog } from "./log.ts";
import type { CompactionEvent } from "./events.ts";

export interface CompactionConfig {
  readonly enabled: boolean;
  /** Compaction runs once the log holds more than this many events. */
  readonly triggerEvents: number;
  /** How many of the newest events are left untouched — everything older gets folded into one summary. */
  readonly keepTail: number;
}

export interface CompactionDeps {
  /** Resolved via the `summarizer` model role — spec string or a pre-built model (test injection seam). */
  readonly model: string | LanguageModel;
  readonly signal?: AbortSignal;
}

const COMPACTION_INSTRUCTIONS = `You are compacting an IRC bot's durable conversation memory into a single summary.

You will receive a JSON array of durable conversation events (chat messages, bot replies, tool calls, subagent briefings) in chronological order — possibly with a PRIOR compaction summary as the very first entry (an object with "kind":"compaction" and a "summary" field). Produce ONE new, compact, information-dense prose summary covering everything in the array — if a prior summary is present, MERGE its content into the new one rather than just appending to it; do not lose anything it already captured.

Preserve:
- Named facts and identities mentioned (people, places, specific numbers/dates)
- Decisions made or conclusions reached
- Running jokes, callbacks, or in-jokes that might resurface later
- Any unresolved question or thread left hanging

Write it as plain context for whoever continues this conversation next — state the facts/context directly. Do not write meta-commentary like "the conversation covered..." or "in summary...". No markdown, no bullet points — a few dense sentences.`;

/**
 * Runs the compactor for one conversation's log — unlike `runExchange`/
 * `runGuardedExchange` (deliberately pure with respect to the log), this
 * function's entire job IS to mutate the log via `log.compact()`, per the
 * plan's design. Trigger: `events().length > config.triggerEvents`; the
 * newest `config.keepTail` events are left untouched, everything older is
 * folded (via the `summarizer` role) into one `CompactionEvent` that REPLACES
 * them. A prior compaction (if the oldest surviving event from a previous
 * round is itself a `CompactionEvent`) is merged in, not just prepended —
 * the model sees it as part of the same input and is instructed to fold it
 * in, so the summary never grows without bound across many compaction
 * rounds.
 *
 * Fails open: an LLM failure (or malformed output) skips this round entirely
 * — nothing is compacted, the log is untouched, and `historyLimit`'s hard
 * per-append trim remains the backstop against unbounded growth regardless
 * of whether compaction ever successfully runs.
 *
 * Returns whether a compaction actually happened, for the caller to log/inspect.
 */
export async function maybeCompact(
  log: ContextLog,
  config: CompactionConfig,
  deps: CompactionDeps,
  now: () => Date = () => new Date(),
): Promise<boolean> {
  if (!config.enabled) return false;

  const events = log.events();
  if (events.length <= config.triggerEvents) return false;

  const throughIndex = events.length - config.keepTail - 1;
  if (throughIndex < 0) return false;

  const toSummarize = events.slice(0, throughIndex + 1);

  try {
    const model = typeof deps.model === "string" ? resolveModel(deps.model) : deps.model;
    const { text } = await generateText({
      model,
      system: COMPACTION_INSTRUCTIONS,
      prompt: JSON.stringify(toSummarize),
      abortSignal: deps.signal,
    });
    const summary = text.trim();
    if (summary.length === 0) return false;

    const summaryEvent: CompactionEvent = {
      kind: "compaction",
      at: now().toISOString(),
      coversUntil: toSummarize.at(-1)?.at ?? now().toISOString(),
      summary,
      eventCount: toSummarize.length,
    };
    log.compact(throughIndex, summaryEvent);
    return true;
  } catch {
    return false;
  }
}
