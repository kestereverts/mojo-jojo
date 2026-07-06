import type { LanguageModel, ToolSet } from "ai";
import { assembleInstructions, type PromptSection } from "../prompt/sections.ts";
import type { ContextEvent, Speaker, TurnContext } from "../context/events.ts";
import { InMemoryContextLog, type ContextLog } from "../context/log.ts";
import { recordDurableTranscripts, recordSubagentBriefings, type ExchangeResult } from "../exchange.ts";
import { toReplyLines } from "../reply.ts";
import { buildToolSet, defaultToolDefinitions, type ToolRegistryResult } from "../tools/index.ts";
import { buildDefaultSections, leakDetectionSections } from "../prompt/instructions.ts";
import { resolveSpeaker, type Friend } from "../identity/speakers.ts";
import type { SpeakerFacts } from "../identity/middleware.ts";
import { resolveEmbeddingModel, type ModelRoles } from "../models.ts";
import { createLeakDetector, type LeakDetector } from "../guards/leak-detector.ts";
import { runGuardedExchange, type GuardConfig, type GuardExplain } from "../guards/pipeline.ts";

/**
 * Unlike the live module (`mojo-ai.ts`), where every guard defaults to
 * enabled, the bare harness defaults every guard OFF. Most harness/test usage
 * is ad-hoc (a mock model, a specific scenario) and has no interest in an
 * extra classifier+embedding round-trip on every exchange; forcing that on
 * by default would break most existing `DebugHarness`-based tests, which
 * don't inject a classifier/embedding mock. The CLI's OWN config-driven path
 * (`cli/index.ts`) passes through the REAL parsed `guards` config (which
 * defaults to all-on, same as the live module) explicitly, so `mojo-ai-debug`
 * run against an actual config file still mirrors live behavior exactly —
 * this default only affects programmatic/test construction.
 */
const NO_GUARDS: GuardConfig = { promptGuard: false, leakDetector: false, grounding: false };

/**
 * `research_topic` (M6) needs its own model role, unlike every other default
 * tool — so the default registry can no longer be a single dependency-free
 * module-level cache the way it was through M5. When the caller doesn't
 * supply `HarnessConfig.models`, every role falls back to the main `model`'s
 * spec string (or a hardcoded default if `model` is a raw `LanguageModel`
 * instance, e.g. a test mock — that fallback only matters if the harness's
 * OWN default registry is used AND `research_topic` is actually invoked
 * during the run, an uncommon combination for tests, which normally pass an
 * explicit `tools` override specifically to stay network-free).
 */
function defaultModelRoles(model: string | LanguageModel): ModelRoles {
  const chat = typeof model === "string" ? model : "openai/gpt-5.4-mini";
  return { chat, classifier: chat, summarizer: chat, research: chat, embedding: "openai/text-embedding-3-small" };
}

/**
 * Headless driver for one conversation. It constructs the *same* dependencies
 * the live `mojo-ai` module builds — a {@link ContextLog}, the persona
 * instructions, the tool set — and drives the *same* {@link runExchange}, with
 * no IRC connection and no `Bot`. So it is not a divergent build path: an
 * exchange here renders and runs through exactly the functions the module uses.
 * The IRC-coupled parts are absent: the module's RxJS turn orchestration
 * (replaced by a direct `await`) and its per-line transport admission (see
 * {@link DebugHarness.chat}).
 */
export interface HarnessConfig {
  /** `"provider/model-id"` spec or an injected `LanguageModel` (mock, for tests). */
  readonly model: string | LanguageModel;
  /**
   * Persona / system prompt (defaults to {@link buildDefaultInstructions} with
   * `friends` and, when `tools` is also left at its default, the real
   * registry's colocated guidance).
   */
  readonly instructions?: string;
  /**
   * Tool set. Omit to get the real default registry (`tools/index.ts`) —
   * which also then supplies its guidance (folded into `instructions`) and
   * durable-transcript names for free. Passing any value here (even `{}`)
   * opts out of that automatic pairing — pass `toolGuidance`/`durableToolNames`
   * alongside it explicitly if the override is itself a (possibly filtered)
   * real registry, e.g. one built via `buildToolSet(defs, disabledNames)` (the
   * CLI does this so a config's `tools.disabled` list is actually honored,
   * not silently overridden by the harness's own all-tools default).
   */
  readonly tools?: ToolSet;
  /** Paired with `tools`; see its doc. Ignored (defaulted from the real registry) when `tools` is omitted. */
  readonly toolGuidance?: readonly PromptSection[];
  /** Paired with `tools`; see its doc. Ignored (defaulted from the real registry) when `tools` is omitted. */
  readonly durableToolNames?: ReadonlySet<string>;
  /** Paired with `tools`; see its doc. Ignored (defaulted from the real registry) when `tools` is omitted. */
  readonly subagentToolNames?: ReadonlySet<string>;
  /**
   * Full model-role mapping, needed only when `tools` is omitted —
   * `research_topic` (part of the default registry) resolves its own model
   * via the `research` role, independent of `model` above. Defaults to every
   * role using `model`'s spec string when omitted (see `defaultModelRoles`).
   */
  readonly models?: ModelRoles;
  readonly maxSteps?: number;
  /** Max delivered lines per reply (mirrors the module's `replyLines`). */
  readonly replyLines?: number;
  /** Per-conversation memory window. */
  readonly historyLimit?: number;
  /** Inject a pre-populated log (e.g. a SQLite-backed one later). */
  readonly log?: ContextLog;
  /** Deterministic clock seam for tests. Defaults to `() => new Date()`. */
  readonly now?: () => Date;
  /** Known people for identity resolution (see `identity/speakers.ts`). Defaults to none. */
  readonly friends?: readonly Friend[];
  /** Which M7 guards run (see `guards/pipeline.ts`). Defaults to all OFF here — see `NO_GUARDS`'s doc comment for why this differs from the live module's all-on default. */
  readonly guards?: GuardConfig;
  /** Test-injection seam for the leak detector (mirrors `tools`) — bypasses building one from real per-section embeddings. Ignored when `guards.leakDetector` is false. */
  readonly leakDetector?: LeakDetector;
}

export interface ChatOptions {
  /**
   * Speaker identity for this line. Without `via`, this is the nick speaking
   * directly (defaults to `"you"`). With `via`, this is the relay-unwrapped
   * AUTHOR name — matching what the live relay middleware produces — and the
   * nick becomes `via` (the relay bot's own nick), simulating a bridged line
   * without needing a raw pattern match (that path is covered by
   * `identity/relay.test.ts`).
   */
  readonly as?: string;
  /** Speaker services account, when simulating a registered user. Ignored when `via` is set (a relay-attributed author has no IRC account). */
  readonly account?: string;
  /** Simulate a message relayed through this bridge bot's nick (e.g. "Telegram"). */
  readonly via?: string;
  /** Conversation label rendered into `TurnContext.conversation`. */
  readonly conversation?: string;
  /** Extra ephemeral guidance for this turn only (appended after the brevity rule). */
  readonly guidance?: readonly string[];
}

/** A captured exchange error, flattened for display (never swallowed). */
export interface HarnessError {
  readonly name: string;
  readonly message: string;
  readonly statusCode?: number;
  readonly url?: string;
}

/** Everything one `chat` produced, for delivery and for inspection. */
export interface ChatOutcome {
  /** The delivered reply (joined lines), or `""` on error / empty output. */
  readonly reply: string;
  readonly replyLines: string[];
  /** The ephemeral turn context that was rendered but not appended to the log. */
  readonly turn: TurnContext;
  /** The full exchange result (absent when the exchange threw). */
  readonly result?: ExchangeResult;
  /** A captured API/exchange error (absent on success). */
  readonly error?: HarnessError;
  /** Durable log after this turn (the projection's source of truth). */
  readonly history: readonly ContextEvent[];
  /** The fully resolved speaker persisted for this turn's incoming line (trust tier + friend match). */
  readonly speaker: Speaker;
  /** True when `guards.promptGuard` blocked this message before any exchange ran (see `result`, which is then absent). */
  readonly blocked: boolean;
  /** Every enabled guard's decision this turn (the `--explain` surface) — empty object when no guards ran. */
  readonly explain: GuardExplain;
}

const DEFAULTS = { maxSteps: 8, replyLines: 3, historyLimit: 200, conversation: "debug" } as const;

export class DebugHarness {
  readonly log: ContextLog;
  readonly #config: HarnessConfig;
  readonly #now: () => Date;
  // Per-instance, not module-level: research_topic's model role can differ
  // per harness (config.models), so the registry can't be a single cache
  // shared across every DebugHarness the way it could before M6.
  #registry?: ToolRegistryResult;
  // Lazy + per-instance for the same reason: built only if guards.leakDetector
  // is actually enabled (most harness usage leaves guards off — see NO_GUARDS).
  #leakDetector?: Promise<LeakDetector>;

  constructor(config: HarnessConfig) {
    this.#config = config;
    this.#now = config.now ?? (() => new Date());
    this.log = config.log ?? new InMemoryContextLog(config.historyLimit ?? DEFAULTS.historyLimit);
  }

  #defaultRegistry(): ToolRegistryResult {
    this.#registry ??= buildToolSet(
      defaultToolDefinitions({ models: this.#config.models ?? defaultModelRoles(this.#config.model) }),
    );
    return this.#registry;
  }

  #defaultLeakDetector(sections: readonly PromptSection[]): Promise<LeakDetector> {
    this.#leakDetector ??= createLeakDetector(
      leakDetectionSections(sections),
      resolveEmbeddingModel((this.#config.models ?? defaultModelRoles(this.#config.model)).embedding),
    );
    return this.#leakDetector;
  }

  /** Append a synthetic event to the log (stage history before a `chat`). */
  inject(event: ContextEvent): void {
    this.log.append(event);
  }

  /**
   * Run one full exchange: record the incoming line, project + run the tool
   * loop, then record the capped reply. This mirrors the module's `deliver`
   * *delivery shaping* (the `toReplyLines` cap) but not IRC *transport
   * admission*: the live path additionally drops individual lines that
   * `safeSay` rejects (CR/LF/NUL, over-512-byte wire line, full outbound queue)
   * and records only the admitted lines. Those failures depend on live
   * transport state and target framing, so headless they cannot be reproduced
   * — the harness records the intended (capped) reply instead.
   */
  async chat(text: string, options: ChatOptions = {}): Promise<ChatOutcome> {
    const replyLines = this.#config.replyLines ?? DEFAULTS.replyLines;

    // Mirrors the live pipeline's final identity step: build the facts a
    // middleware chain would have produced, then resolveSpeaker finalizes
    // trust + a friends-file match — same function, same shape, no divergence.
    const facts: SpeakerFacts = options.via
      ? { nick: options.via, author: options.as ?? "you", via: options.via }
      : { nick: options.as ?? "you", ...(options.account ? { account: options.account } : {}) };
    const speaker = resolveSpeaker(facts, this.#config.friends ?? []);

    this.log.append({
      kind: "chat-message",
      at: this.#now().toISOString(),
      speaker,
      text,
      addressed: true,
    });

    const turn: TurnContext = {
      nowUtc: this.#now().toISOString(),
      conversation: options.conversation ?? DEFAULTS.conversation,
      guidance: [`Reply in at most ${replyLines} short lines.`, ...(options.guidance ?? [])],
    };

    // See the `tools` field doc: an explicit `toolGuidance`/`durableToolNames`/
    // `subagentToolNames` pairs with an explicit `tools` override; otherwise
    // all fall back to the real default registry ONLY when `tools` itself
    // was also left at default.
    const usingDefaultTools = this.#config.tools === undefined;
    const tools = this.#config.tools ?? this.#defaultRegistry().tools;
    const toolGuidance = this.#config.toolGuidance ?? (usingDefaultTools ? this.#defaultRegistry().guidance : []);
    const durableToolNames =
      this.#config.durableToolNames ?? (usingDefaultTools ? this.#defaultRegistry().durableNames : new Set<string>());
    const subagentToolNames =
      this.#config.subagentToolNames ?? (usingDefaultTools ? this.#defaultRegistry().subagentNames : new Set<string>());
    const guards = this.#config.guards ?? NO_GUARDS;
    const sections = buildDefaultSections(this.#config.friends, toolGuidance);
    const instructions = this.#config.instructions ?? assembleInstructions(sections);
    const models = this.#config.models ?? defaultModelRoles(this.#config.model);
    const leakDetector = guards.leakDetector ? (this.#config.leakDetector ?? (await this.#defaultLeakDetector(sections))) : undefined;

    let outcome: Awaited<ReturnType<typeof runGuardedExchange>>;
    try {
      outcome = await runGuardedExchange(
        this.log,
        turn,
        { model: this.#config.model, instructions, tools, maxSteps: this.#config.maxSteps ?? DEFAULTS.maxSteps },
        text,
        guards,
        { classifierModel: models.classifier, leakDetector },
      );
    } catch (cause) {
      return {
        reply: "",
        replyLines: [],
        turn,
        error: toHarnessError(cause),
        history: this.log.events(),
        speaker,
        blocked: false,
        explain: {},
      };
    }

    if (outcome.result) {
      recordDurableTranscripts(this.log, outcome.result, durableToolNames, this.#now);
      recordSubagentBriefings(this.log, outcome.result, subagentToolNames, this.#now);
    }

    const lines = toReplyLines(outcome.reply, replyLines);
    if (lines.length > 0) {
      this.log.append({ kind: "bot-reply", at: this.#now().toISOString(), text: lines.join("\n") });
    }

    return {
      reply: lines.join("\n"),
      replyLines: lines,
      turn,
      result: outcome.result,
      history: this.log.events(),
      speaker,
      blocked: outcome.blocked,
      explain: outcome.explain,
    };
  }
}

const EVENT_KINDS = new Set(["chat-message", "bot-reply", "tool-transcript", "subagent-briefing"]);

/**
 * Validate raw JSON (a single event or an array) into {@link ContextEvent}s for
 * `inject`. Light but honest: unknown `kind`s throw rather than corrupt the log;
 * a missing `at` is stamped with `now()`.
 */
export function parseContextEvents(raw: unknown, now: () => Date = () => new Date()): ContextEvent[] {
  const items = Array.isArray(raw) ? raw : [raw];
  return items.map((item, idx) => {
    if (typeof item !== "object" || item === null) {
      throw new Error(`event[${idx}] is not an object`);
    }
    const base = item as Record<string, unknown>;
    if (typeof base.kind !== "string" || !EVENT_KINDS.has(base.kind)) {
      throw new Error(`event[${idx}] has invalid kind ${JSON.stringify(base.kind)}`);
    }
    return {
      ...base,
      at: typeof base.at === "string" ? base.at : now().toISOString(),
    } as unknown as ContextEvent;
  });
}

/** Flatten an unknown throw into a displayable error, surfacing AI SDK HTTP fields when present. */
function toHarnessError(cause: unknown): HarnessError {
  if (cause instanceof Error) {
    const extra = cause as { statusCode?: number; url?: string };
    return {
      name: cause.name,
      message: cause.message,
      ...(typeof extra.statusCode === "number" ? { statusCode: extra.statusCode } : {}),
      ...(typeof extra.url === "string" ? { url: extra.url } : {}),
    };
  }
  return { name: "UnknownError", message: String(cause) };
}
