/**
 * The event-sourced context model.
 *
 * Durable conversation memory is an append-only log of typed events — never
 * provider-format messages. The prompt sent to the model is a *projection* of
 * this log (see `render.ts`), computed fresh for every model call. Anything
 * that must reach the model this turn but must NOT become memory (runtime
 * facts, steering guidance) travels separately as {@link TurnContext} and is
 * merged in at render time only. One render path replaces mojo-ai3's three
 * divergent build/persist/replay paths.
 */

/** Who/what a chat line came from, as resolved by the IRC layer (authoritative). */
export interface Speaker {
  readonly nick: string;
  /** Services account, when known. Identity claims in message text are not trusted. */
  readonly account?: string;
}

/** A user-visible chat line from the channel or PM. */
export interface ChatMessageEvent {
  readonly kind: "chat-message";
  readonly at: string; // ISO 8601 UTC
  readonly speaker: Speaker;
  readonly text: string;
  /** Was the bot addressed (and thus did this line start an exchange)? */
  readonly addressed: boolean;
}

/** The bot's own reply as actually sent (post-guards, post-truncation). */
export interface BotReplyEvent {
  readonly kind: "bot-reply";
  readonly at: string;
  readonly text: string;
}

/**
 * A completed tool call worth remembering across turns. Stored in our own
 * shape and re-rendered to whatever the current provider wants — this replaces
 * mojo-ai3's provider-format `replayContents` blob.
 */
export interface ToolTranscriptEvent {
  readonly kind: "tool-transcript";
  readonly at: string;
  readonly tool: string;
  readonly input: unknown;
  readonly output: unknown;
}

/**
 * A subagent's structured briefing (typed result, not JSON-in-a-string).
 * Placeholder until the first subagent lands.
 */
export interface SubagentBriefingEvent {
  readonly kind: "subagent-briefing";
  readonly at: string;
  readonly agent: string;
  readonly briefing: unknown;
}

/** Everything that may enter durable conversation memory. */
export type ContextEvent =
  | ChatMessageEvent
  | BotReplyEvent
  | ToolTranscriptEvent
  | SubagentBriefingEvent;

/**
 * Ephemeral, turn-scoped context: rendered into the live prompt, never
 * appended to the log. The structural split (log vs. turn) IS the
 * ephemeral/durable distinction — no tags to keep in sync.
 */
export interface TurnContext {
  /** Authoritative current time, injected fresh every turn. ISO 8601 UTC. */
  readonly nowUtc: string;
  /** Where the exchange is happening (channel name or the PM peer's nick). */
  readonly conversation: string;
  /** Extra steering for this turn only (brevity rules, step plans, validator feedback). */
  readonly guidance: readonly string[];
}
