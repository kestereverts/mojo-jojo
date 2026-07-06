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

/**
 * Who/what a chat line came from, fully resolved before it is persisted (see
 * `identity/`). Mojo lives in a relay channel — users arrive over IRC,
 * Telegram, and Discord bridges — so identity here is deliberately *soft*:
 * there is no single authoritative account, only a trust tier reflecting how
 * strong a signal we had. This is a point-in-time snapshot, frozen at speak
 * time; a later `friends.toml` correction does not rewrite past messages.
 */
export interface Speaker {
  /** The nick that actually sent the PRIVMSG (the relay bot's nick, if `via` is set). */
  readonly nick: string;
  /** IRC services account, when known (message-scoped account-tag; see `resolveAccount`). */
  readonly account?: string;
  /** Relay-unwrapped author name, when this line came through a bridge (see `identity/relay.ts`). */
  readonly author?: string;
  /** The relay bot's configured nick that carried this message, when `author` is set. */
  readonly via?: string;
  /** A `friends.toml` person id, when an alias/account match was found. */
  readonly personId?: string;
  /**
   * How strong the identity signal was: `account` (IRC services, strongest) >
   * `relay` (bridge-attributed author — spoofable at the bridge) > `nick`
   * (direct IRC, unregistered — spoofable by taking the nick). Always set.
   */
  readonly trust: "account" | "relay" | "nick";
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

/**
 * The durable trace of a compaction (M8): `ContextLog.compact()` physically
 * REPLACES a prefix of older events with one of these — the log never grows
 * without bound even if `historyLimit` is never hit, and a compaction's own
 * timestamp/coverage/count are queryable audit trail, not just a summary
 * string. `renderPrompt` renders it as a leading "[Earlier conversation
 * summary]" message — the single render path is preserved; there is no
 * separate "how to replay a compaction" code path.
 */
export interface CompactionEvent {
  readonly kind: "compaction";
  readonly at: string;
  /** ISO timestamp of the newest event this summary covers (inclusive) — audit trail, not consumed by rendering. */
  readonly coversUntil: string;
  readonly summary: string;
  /** How many events this compaction replaced — audit trail, not consumed by rendering. */
  readonly eventCount: number;
}

/** Everything that may enter durable conversation memory. */
export type ContextEvent =
  | ChatMessageEvent
  | BotReplyEvent
  | ToolTranscriptEvent
  | SubagentBriefingEvent
  | CompactionEvent;

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
