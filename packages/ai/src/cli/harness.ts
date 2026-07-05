import type { LanguageModel, ToolSet } from "ai";
import type { PromptSection } from "../prompt/sections.ts";
import type { ContextEvent, Speaker, TurnContext } from "../context/events.ts";
import { InMemoryContextLog, type ContextLog } from "../context/log.ts";
import { recordDurableTranscripts, runExchange, type ExchangeResult } from "../exchange.ts";
import { toReplyLines } from "../reply.ts";
import { buildToolSet, defaultToolDefinitions, type ToolRegistryResult } from "../tools/index.ts";
import { buildDefaultInstructions } from "../prompt/instructions.ts";
import { resolveSpeaker, type Friend } from "../identity/speakers.ts";
import type { SpeakerFacts } from "../identity/middleware.ts";

// Computed once, lazily, and reused — the same registry every default-config
// harness call folds into instructions/tools/durable names.
let cachedDefaultRegistry: ToolRegistryResult | undefined;
function defaultRegistry(): ToolRegistryResult {
  cachedDefaultRegistry ??= buildToolSet(defaultToolDefinitions());
  return cachedDefaultRegistry;
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
}

const DEFAULTS = { maxSteps: 8, replyLines: 3, historyLimit: 200, conversation: "debug" } as const;

export class DebugHarness {
  readonly log: ContextLog;
  readonly #config: HarnessConfig;
  readonly #now: () => Date;

  constructor(config: HarnessConfig) {
    this.#config = config;
    this.#now = config.now ?? (() => new Date());
    this.log = config.log ?? new InMemoryContextLog(config.historyLimit ?? DEFAULTS.historyLimit);
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

    // See the `tools` field doc: an explicit `toolGuidance`/`durableToolNames`
    // pairs with an explicit `tools` override; otherwise both fall back to the
    // real default registry ONLY when `tools` itself was also left at default.
    const usingDefaultTools = this.#config.tools === undefined;
    const tools = this.#config.tools ?? defaultRegistry().tools;
    const toolGuidance = this.#config.toolGuidance ?? (usingDefaultTools ? defaultRegistry().guidance : []);
    const durableToolNames =
      this.#config.durableToolNames ?? (usingDefaultTools ? defaultRegistry().durableNames : new Set<string>());

    let result: ExchangeResult;
    try {
      result = await runExchange(this.log, turn, {
        model: this.#config.model,
        instructions: this.#config.instructions ?? buildDefaultInstructions(this.#config.friends, toolGuidance),
        tools,
        maxSteps: this.#config.maxSteps ?? DEFAULTS.maxSteps,
      });
    } catch (cause) {
      return {
        reply: "",
        replyLines: [],
        turn,
        error: toHarnessError(cause),
        history: this.log.events(),
        speaker,
      };
    }

    recordDurableTranscripts(this.log, result, durableToolNames, this.#now);

    const lines = toReplyLines(result.text, replyLines);
    if (lines.length > 0) {
      this.log.append({ kind: "bot-reply", at: this.#now().toISOString(), text: lines.join("\n") });
    }

    return { reply: lines.join("\n"), replyLines: lines, turn, result, history: this.log.events(), speaker };
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
