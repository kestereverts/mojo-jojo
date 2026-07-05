import type { LanguageModel, ToolSet } from "ai";
import type { ContextEvent, TurnContext } from "../context/events.ts";
import { InMemoryContextLog, type ContextLog } from "../context/log.ts";
import { runExchange, type ExchangeResult } from "../exchange.ts";
import { toReplyLines } from "../reply.ts";
import { defaultTools } from "../tools.ts";
import { DEFAULT_INSTRUCTIONS } from "../persona.ts";

/**
 * Headless driver for one conversation. It constructs the *same* dependencies
 * the live `mojo-ai` module builds — a {@link ContextLog}, the persona
 * instructions, the tool set — and drives the *same* {@link runExchange}, with
 * no IRC connection and no `Bot`. So it is not a divergent build path: an
 * exchange here renders and runs through exactly the functions the module uses.
 * Only the module's RxJS turn orchestration (which is the IRC-coupled part) is
 * absent, replaced by a direct `await`.
 */
export interface HarnessConfig {
  /** `"provider/model-id"` spec or an injected `LanguageModel` (mock, for tests). */
  readonly model: string | LanguageModel;
  /** Persona / system prompt (defaults to the shipped {@link DEFAULT_INSTRUCTIONS}). */
  readonly instructions?: string;
  /** Tool set (defaults to {@link defaultTools}). */
  readonly tools?: ToolSet;
  readonly maxSteps?: number;
  /** Max delivered lines per reply (mirrors the module's `replyLines`). */
  readonly replyLines?: number;
  /** Per-conversation memory window. */
  readonly historyLimit?: number;
  /** Inject a pre-populated log (e.g. a SQLite-backed one later). */
  readonly log?: ContextLog;
  /** Deterministic clock seam for tests. Defaults to `() => new Date()`. */
  readonly now?: () => Date;
}

export interface ChatOptions {
  /** Speaker nick for this line (defaults to `"you"`). */
  readonly as?: string;
  /** Speaker services account, when simulating a registered user. */
  readonly account?: string;
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
   * loop, then record the delivered reply — the same sequence the module's
   * `deliver` performs, minus the IRC send.
   */
  async chat(text: string, options: ChatOptions = {}): Promise<ChatOutcome> {
    const replyLines = this.#config.replyLines ?? DEFAULTS.replyLines;
    const nick = options.as ?? "you";

    this.log.append({
      kind: "chat-message",
      at: this.#now().toISOString(),
      speaker: { nick, ...(options.account ? { account: options.account } : {}) },
      text,
      addressed: true,
    });

    const turn: TurnContext = {
      nowUtc: this.#now().toISOString(),
      conversation: options.conversation ?? DEFAULTS.conversation,
      guidance: [`Reply in at most ${replyLines} short lines.`, ...(options.guidance ?? [])],
    };

    let result: ExchangeResult;
    try {
      result = await runExchange(this.log, turn, {
        model: this.#config.model,
        instructions: this.#config.instructions ?? DEFAULT_INSTRUCTIONS,
        tools: this.#config.tools ?? defaultTools(),
        maxSteps: this.#config.maxSteps ?? DEFAULTS.maxSteps,
      });
    } catch (cause) {
      return { reply: "", replyLines: [], turn, error: toHarnessError(cause), history: this.log.events() };
    }

    const lines = toReplyLines(result.text, replyLines);
    if (lines.length > 0) {
      this.log.append({ kind: "bot-reply", at: this.#now().toISOString(), text: lines.join("\n") });
    }

    return { reply: lines.join("\n"), replyLines: lines, turn, result, history: this.log.events() };
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
