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
- Any URL mentioned (write it out in full, verbatim) — especially a paste/portal link the bot created, since once this summary replaces the original event a later reply re-citing that link can only be verified against exactly what you write here

Write it as plain context for whoever continues this conversation next — state the facts/context directly. Do not write meta-commentary like "the conversation covered..." or "in summary...". No markdown, no bullet points — a few dense sentences.`;

/**
 * Bounds the serialized prefix sent to the summarizer. `triggerEvents` can be
 * configured up to 100,000 and durable events can each carry a truncated-but
 * -still-sizeable payload (tool transcripts, subagent briefings) — without a
 * cap, one compaction call could serialize into a multi-MB prompt, blowing
 * past a reasonable context window or cost budget (review finding). A
 * mid-array truncation (keeping the START and END, dropping the middle) is
 * used rather than a hard cutoff, so the newest events approaching
 * `keepTail` — and the oldest, often-most-foundational ones — aren't the
 * part silently dropped.
 */
const MAX_PROMPT_CHARS = 200_000;

function boundedPrompt(events: unknown[]): string {
  const full = JSON.stringify(events);
  if (full.length <= MAX_PROMPT_CHARS) return full;
  const half = Math.floor(MAX_PROMPT_CHARS / 2);
  return `${full.slice(0, half)}\n...[middle truncated — too large to summarize in full]...\n${full.slice(-half)}`;
}

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
 * **Accepted limitation, not fixed here**: merging is pure LLM judgment, with
 * no deterministic retention check. Across MANY compaction rounds over a
 * long-lived conversation, summary-of-a-summary drift is possible — an early
 * fact could progressively degrade or be dropped over enough rounds, and
 * nothing here detects or bounds that. This mechanism solves unbounded
 * *growth*; it does not guarantee unbounded-round *fidelity*. `eventCount` is
 * per-round, not cumulative, so it isn't an audit signal for "how much this
 * summary now stands in for" either.
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
      prompt: boundedPrompt(toSummarize),
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
