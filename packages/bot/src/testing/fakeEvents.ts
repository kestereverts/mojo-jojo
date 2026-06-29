import type { PrivmsgEvent } from "@mojo-jojo/irc-client";

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
}

/** Build a minimal {@link PrivmsgEvent} for matcher/ignore/command tests (fields cast loosely). */
export function fakePrivmsg(opts: FakeSender = {}): PrivmsgEvent {
  const user = {
    nick: opts.nick ?? "nick",
    username: opts.username ?? null,
    host: opts.host ?? null,
    account: opts.account ?? null,
    isSelf: false,
  };
  return {
    type: "privmsg",
    raw: { command: "PRIVMSG", params: [opts.target ?? "#chan", opts.text ?? ""], tags: {}, source: null },
    time: new Date(0),
    tags: {},
    channel: null,
    user,
    member: null,
    target: opts.target ?? "#chan",
    text: opts.text ?? "",
    isPrivate: opts.isPrivate ?? false,
    account: opts.messageAccount ?? null,
  } as unknown as PrivmsgEvent;
}
