import type { ContextLog } from "../context/log.ts";
import type { TurnContext } from "../context/events.ts";
import { runExchange, type ExchangeOptions, type ExchangeResult } from "../exchange.ts";
import { checkPromptGuard, promptGuardRefusal, type PromptGuardResult } from "./prompt-guard.ts";
import { checkGrounding, groundingRetryGuidance, stripUngroundedUrls, type GroundingResult } from "./grounding.ts";
import { leakDetectedRefusal, type LeakDetectionResult, type LeakDetector } from "./leak-detector.ts";

export interface GuardConfig {
  readonly promptGuard: boolean;
  readonly leakDetector: boolean;
  readonly grounding: boolean;
}

export interface GuardDeps {
  /** Resolved via the `classifier` model role — spec string or a pre-built model (test injection seam, mirrors `ExchangeOptions.model`). */
  readonly classifierModel: ExchangeOptions["model"];
  /** Pre-built once at setup (its per-section embeddings are computed once) — absent/ignored when `config.leakDetector` is false. */
  readonly leakDetector?: LeakDetector;
  readonly signal?: AbortSignal;
}

/** Every guard's decision for one turn — the CLI's `--explain` surface, and what a caller logs `warn` for on a `failedOpen`. */
export interface GuardExplain {
  readonly promptGuard?: PromptGuardResult;
  readonly grounding?: { readonly retried: boolean; readonly final: GroundingResult };
  readonly leakDetector?: LeakDetectionResult;
}

export interface GuardedExchangeResult {
  /** Absent when `promptGuard` blocked the message before any exchange ran. */
  readonly result?: ExchangeResult;
  /** The reply to actually deliver/record — after any grounding retry/strip and leak-detector substitution. */
  readonly reply: string;
  readonly blocked: boolean;
  readonly explain: GuardExplain;
}

/**
 * Wraps `runExchange` with the M7 guard pipeline — a drop-in replacement at
 * the same call site, still pure with respect to the log (the caller still
 * appends the chat-message before calling this, and the bot-reply / durable-
 * transcript / subagent-briefing recording after, exactly as with a bare
 * `runExchange`). Guards run in a fixed order:
 *
 * 1. **prompt-guard**, sequenced BEFORE the exchange — a blocked message
 *    never reaches `runExchange` at all (mojo-ai3 ran its equivalent check
 *    in parallel, burning a full exchange's tokens on messages that were
 *    going to be blocked anyway).
 * 2. **grounding**, checked after the exchange; on a violation, retries the
 *    exchange ONCE with corrective `turn.guidance` feedback, then strips any
 *    URL still ungrounded after the retry.
 * 3. **leak-detector**, checked last, on the FINAL reply (post-grounding) —
 *    a leak is replaced with a refusal rather than delivered.
 *
 * Per the M7 decision, every guard fails OPEN — a check that itself errors
 * never blocks or alters the reply, it just surfaces `failedOpen` in
 * `explain` for the caller to log at `warn` with a distinct scope. This
 * function does no logging itself, keeping it a pure function of its inputs
 * (the same reason `runExchange` doesn't touch the log directly) — the CLI
 * harness has no live logger at all, so any logging decision has to be the
 * caller's, not baked in here.
 */
export async function runGuardedExchange(
  log: ContextLog,
  turn: TurnContext,
  exchangeOptions: ExchangeOptions,
  message: string,
  config: GuardConfig,
  deps: GuardDeps,
): Promise<GuardedExchangeResult> {
  const explain: { -readonly [K in keyof GuardExplain]?: GuardExplain[K] } = {};

  if (config.promptGuard) {
    const guardResult = await checkPromptGuard(message, { model: deps.classifierModel, signal: deps.signal });
    explain.promptGuard = guardResult;
    if (!guardResult.allowed) {
      return { reply: promptGuardRefusal(), blocked: true, explain };
    }
  }

  let result = await runExchange(log, turn, exchangeOptions);
  let reply = result.text;

  if (config.grounding) {
    // The log at this point reflects only PRIOR turns — this exchange's own
    // tool-transcript is recorded by the OUTER caller only after this whole
    // guard pipeline returns, so `priorEvents` can never double-count (or
    // omit) the current exchange's own paste calls, which `result.steps`
    // already covers.
    const priorEvents = log.events();
    let check = checkGrounding(reply, result.steps, priorEvents);
    let retried = false;
    if (!check.grounded) {
      retried = true;
      const retryTurn: TurnContext = { ...turn, guidance: [...turn.guidance, groundingRetryGuidance(check.ungroundedUrls)] };
      result = await runExchange(log, retryTurn, exchangeOptions);
      reply = result.text;
      check = checkGrounding(reply, result.steps, priorEvents);
      if (!check.grounded) reply = stripUngroundedUrls(reply, check.ungroundedUrls);
    }
    explain.grounding = { retried, final: check };
  }

  if (config.leakDetector && deps.leakDetector) {
    const leakResult = await deps.leakDetector.check(reply);
    explain.leakDetector = leakResult;
    if (leakResult.isLeak) reply = leakDetectedRefusal();
  }

  return { result, reply, blocked: false, explain };
}
