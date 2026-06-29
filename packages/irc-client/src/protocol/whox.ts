import { command } from "./commands.ts";
import type { Message } from "@mojo-jojo/irc-message";

// WHOX (the `%`-field extension to WHO) support. A WHOX reply (`354`
// RPL_WHOSPCRPL) only contains the fields the *client* requested, always in a
// fixed canonical order, prefixed by an opaque "querytype" token. To parse a
// `354` we therefore have to know which fields we asked for — so the client
// always sends one fixed field spec tagged with one reserved token, and the
// dispatcher parses `354`s carrying that token against the known layout.
//
// @see https://ircv3.net/specs/extensions/whox

/**
 * Reserved querytype token tagging the client's own WHOX requests, so its `354`
 * replies can be distinguished from those of another tool sharing the connection
 * (and parsed against our known field layout). Per spec the token is digits only,
 * at most 3 characters.
 */
export const WHOX_TOKEN = "909";

/**
 * The fixed WHOX field selectors the client requests, written in the canonical
 * `354` order: token (`t`), channel (`c`), username (`u`), host (`h`), nick
 * (`n`), flags (`f`), account (`a`), realname (`r`). The `354` reply therefore
 * carries exactly: `<client> <token> <channel> <user> <host> <nick> <flags>
 * <account> :<realname>`.
 */
export const WHOX_FIELDS = "tcuhnfar";

/** `WHO <mask> %tcuhnfar,909` — a WHOX query with our fixed spec + token. */
export function whoxQuery(mask: string): Message {
  return command("WHO", mask, `%${WHOX_FIELDS},${WHOX_TOKEN}`);
}

/** The fields parsed out of one of our WHOX `354` replies. */
export interface WhoxReply {
  /** Channel the entry is for, or `*` / undefined when not channel-scoped. */
  readonly channel: string | undefined;
  /** Username (ident). */
  readonly user: string | undefined;
  /** Hostname. */
  readonly host: string | undefined;
  /** Nickname. */
  readonly nick: string | undefined;
  /** WHO flags (`H`/`G` away marker, `*` oper, status prefixes, …). */
  readonly flags: string | undefined;
  /** Account name, or `0` when the user is logged out. */
  readonly account: string | undefined;
  /** Real name (GECOS). */
  readonly realName: string | undefined;
}

/**
 * Parse a `354` reply against our fixed {@link WHOX_FIELDS} layout. Returns
 * `null` if the reply's token isn't {@link WHOX_TOKEN} — i.e. it was elicited by
 * some other tool's WHOX request and we can't assume its field layout.
 *
 * Layout (after `params[0]`, the client target):
 * `[1]=token [2]=channel [3]=user [4]=host [5]=nick [6]=flags [7]=account [8]=realname`.
 */
export function parseWhoxReply(message: Message): WhoxReply | null {
  const p = message.params;
  if (p[1] !== WHOX_TOKEN) return null;
  return {
    channel: p[2],
    user: p[3],
    host: p[4],
    nick: p[5],
    flags: p[6],
    account: p[7],
    realName: p[8],
  };
}
