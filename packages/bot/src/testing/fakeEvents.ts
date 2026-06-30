import type { Member, PrivmsgEvent } from "@mojo-jojo/irc-client";

export interface FakeSender {
  nick?: string;
  username?: string | null;
  host?: string | null;
  /** Cached entity account (`user.account`). */
  account?: string | null;
  /** Message-scoped account-tag (`event.account`). */
  messageAccount?: string | null;
  text?: string;
  target?: string;
  isPrivate?: boolean;
  /** Mark the sender as ourselves (`user.isSelf`) — for echo-message tests. */
  self?: boolean;
  /** Sender's channel-status mode letters (q/a/o/h/v); sets `event.member` + `channel`. */
  memberModes?: readonly string[];
}

/** A fake {@link Member} exposing only `modes` + the status predicates used by permissions. */
function fakeMember(modes: readonly string[]): Member {
  const has = (mode: string): boolean => modes.includes(mode);
  return {
    modes,
    isOwner: () => has("q"),
    isAdmin: () => has("a"),
    isOp: () => has("o"),
    isHalfOp: () => has("h"),
    isVoice: () => has("v"),
  } as unknown as Member;
}

/** Build a minimal {@link PrivmsgEvent} for matcher/ignore/command tests (fields cast loosely). */
export function fakePrivmsg(opts: FakeSender = {}): PrivmsgEvent {
  const user = {
    nick: opts.nick ?? "nick",
    username: opts.username ?? null,
    host: opts.host ?? null,
    account: opts.account ?? null,
    isSelf: opts.self ?? false,
  };
  const target = opts.target ?? "#chan";
  const member = opts.memberModes !== undefined ? fakeMember(opts.memberModes) : null;
  return {
    type: "privmsg",
    raw: { command: "PRIVMSG", params: [target, opts.text ?? ""], tags: {}, source: null },
    time: new Date(0),
    tags: {},
    channel: member ? { name: target } : null,
    user,
    member,
    target,
    text: opts.text ?? "",
    isPrivate: opts.isPrivate ?? false,
    account: opts.messageAccount ?? null,
  } as unknown as PrivmsgEvent;
}
