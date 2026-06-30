import type { IrcClient, PrivmsgEvent } from "@mojo-jojo/irc-client";
import type { Logger } from "../logging/logger.ts";

/** Where a reply to `event` should go: the channel, or the sender's nick in a PM. */
export function replyTarget(event: PrivmsgEvent): string {
  return event.isPrivate ? event.user.nick : (event.channel?.name ?? event.target);
}

/**
 * `client.say` wrapped so the synchronous send-throws (CR/LF/NUL injection,
 * over-512-byte line, full queue) never escape a handler. Returns `false` if the
 * send threw — which means "did not enqueue", NOT "delivered"; a send while
 * disconnected is a silent no-op that returns `true`.
 */
export function safeSay(client: IrcClient, target: string, text: string, log: Logger): boolean {
  try {
    client.say(target, text);
    return true;
  } catch (error) {
    log.warn(`PRIVMSG to ${target} dropped`, error);
    return false;
  }
}

/** {@link safeSay} for `client.notice`. */
export function safeNotice(client: IrcClient, target: string, text: string, log: Logger): boolean {
  try {
    client.notice(target, text);
    return true;
  } catch (error) {
    log.warn(`NOTICE to ${target} dropped`, error);
    return false;
  }
}
