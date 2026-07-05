import type { PrivmsgEvent } from "@mojo-jojo/irc-client";
import type { Speaker } from "../context/events.ts";

/**
 * A speaker's identity as known so far, mid-pipeline — everything {@link Speaker}
 * carries except `trust`/`personId`, which are only finalized once (by
 * `identity/speakers.ts`'s `resolveSpeaker`) right before a message is
 * persisted. Middleware rewrites these facts (e.g. relay unwrapping adds
 * `author`/`via`); it never decides trust.
 */
export type SpeakerFacts = Omit<Speaker, "trust" | "personId">;

/**
 * One in-flight channel message, from the raw IRC event up to whatever the
 * middleware chain has rewritten so far.
 */
export interface ChatMessage {
  /**
   * The actual PRIVMSG as received. Its sender is the IRC/relay-bot identity
   * — permission and ignore-list checks in `@mojo-jojo/bot` deliberately keep
   * reading this directly, never the rewritten `speaker`, so a relay-unwrapped
   * "author" can never gain command access by impersonating a real nick.
   */
  readonly raw: PrivmsgEvent;
  /** Resolved speaker facts, rewritten by earlier middleware (e.g. relay unwrap). */
  readonly speaker: SpeakerFacts;
  /** Resolved message text, rewritten by earlier middleware (e.g. relay unwrap). */
  readonly text: string;
  /** Channel name, as received (not casemapping-normalized). */
  readonly channel: string;
  /** ISO 8601 UTC timestamp of receipt. */
  readonly at: string;
}

/**
 * A pipeline stage: rewrite a {@link ChatMessage}, or return `null` to drop it
 * (e.g. a future spam filter). Chain order matters — relay unwrapping must run
 * before anything that reads `speaker`/`text` as if they were direct-IRC facts.
 */
export type ChatMiddleware = (msg: ChatMessage) => ChatMessage | null;

/**
 * Run `msg` through `chain` in order, short-circuiting on the first `null`.
 * An empty chain returns `msg` unchanged.
 */
export function runChatMiddleware(msg: ChatMessage, chain: readonly ChatMiddleware[]): ChatMessage | null {
  let current: ChatMessage | null = msg;
  for (const middleware of chain) {
    if (current === null) return null;
    current = middleware(current);
  }
  return current;
}
