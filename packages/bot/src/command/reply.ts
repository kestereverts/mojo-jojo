import type { IrcClient, PrivmsgEvent } from "@mojo-jojo/irc-client";
import type { Logger } from "../logging/logger.ts";

/** Where a reply to `event` should go: the channel, or the sender's nick in a PM. */
export function replyTarget(event: PrivmsgEvent): string {
  return event.isPrivate ? event.user.nick : (event.channel?.name ?? event.target);
}

/**
 * Run a client action (`say`/`notice`/`join`/`part`/`action`/`raw`/…), catching
 * the synchronous send-throws every one of them can raise (CR/LF/NUL injection,
 * over-512-byte line, full outbound queue). Returns `false` if the action threw
 * — meaning "did not enqueue", NOT "delivered"; an action while disconnected is a
 * silent no-op that returns `true`. This is the single guard every reply/action
 * path funnels through, so a throw can never escape and kill a handler's stream.
 */
export function safeClientCall(action: () => void, log: Logger, label: string): boolean {
  try {
    action();
    return true;
  } catch (error) {
    log.warn(`${label} dropped`, error);
    return false;
  }
}

/** `client.say` wrapped via {@link safeClientCall}. */
export function safeSay(client: IrcClient, target: string, text: string, log: Logger): boolean {
  return safeClientCall(() => client.say(target, text), log, `PRIVMSG to ${target}`);
}

/** `client.notice` wrapped via {@link safeClientCall}. */
export function safeNotice(client: IrcClient, target: string, text: string, log: Logger): boolean {
  return safeClientCall(() => client.notice(target, text), log, `NOTICE to ${target}`);
}
