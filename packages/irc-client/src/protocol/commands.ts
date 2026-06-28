import type { Message } from "@mojo-jojo/irc-message";

// Builders for the outbound (client -> server) protocol messages M2 needs.
//
// Each returns a normalized {@link Message} (no tags, no source — the client is
// the source) that the outbound queue serializes via `buildMessage`. Keeping
// construction here means the wire shape of each command lives in exactly one
// place and is unit-testable without a live connection.

/** Build a bare client command with ordered params and no tags/source. */
export function command(name: string, ...params: string[]): Message {
  return { tags: {}, source: null, command: name, params };
}

/** `PASS :<password>` — server password, sent first when configured. */
export function pass(password: string): Message {
  return command("PASS", password);
}

/** `NICK <nick>`. */
export function nick(name: string): Message {
  return command("NICK", name);
}

/**
 * `USER <username> 0 * :<realname>` — the modern (RFC 2812) form, with the
 * mode bitmask replaced by `0` and the unused field by `*`.
 */
export function user(username: string, realName: string): Message {
  return command("USER", username, "0", "*", realName);
}

/** `CAP LS 302` — request the IRCv3 capability list with value/multiline support. */
export function capLs(): Message {
  return command("CAP", "LS", "302");
}

/** `CAP REQ :<cap> <cap> …` — request a set of capabilities (always trailing). */
export function capReq(caps: readonly string[]): Message {
  return command("CAP", "REQ", caps.join(" "));
}

/** `CAP END` — conclude capability negotiation and let registration complete. */
export function capEnd(): Message {
  return command("CAP", "END");
}

/**
 * `AUTHENTICATE <payload>` — one line of the SASL exchange. `payload` is a
 * mechanism name (`PLAIN`), a base64 chunk of the response, or `+` (empty
 * response / continuation marker). Base64 carries no spaces, so it serializes as
 * a single middle param.
 */
export function authenticate(payload: string): Message {
  return command("AUTHENTICATE", payload);
}

/** `PONG :<token>` — reply to a server `PING` (priority/keepalive path). */
export function pong(token: string): Message {
  return command("PONG", token);
}

/** `PING :<token>` — client-initiated keepalive. */
export function ping(token: string): Message {
  return command("PING", token);
}

/** `QUIT :<reason>` — graceful disconnect. */
export function quit(reason: string): Message {
  return command("QUIT", reason);
}

// ---- Client actions (M5) ----
//
// One builder per user-facing action. Optional params are omitted from the wire
// form when not supplied (so e.g. `topic("#x")` queries, while `topic("#x", "")`
// clears). The serializer decides trailing-param framing; these only shape params.

/** Byte that frames a CTCP payload (e.g. `ACTION`). */
const CTCP = "\x01";

/** `PRIVMSG <target> :<text>` — a message to a channel or user. */
export function privmsg(target: string, text: string): Message {
  return command("PRIVMSG", target, text);
}

/** `NOTICE <target> :<text>` — a notice (no automated replies expected). */
export function notice(target: string, text: string): Message {
  return command("NOTICE", target, text);
}

/** CTCP `ACTION` (`/me`): `PRIVMSG <target> :\x01ACTION <text>\x01`. */
export function action(target: string, text: string): Message {
  return command("PRIVMSG", target, `${CTCP}ACTION ${text}${CTCP}`);
}

/** `JOIN <channel>`, or `JOIN <channel> <key>` for a keyed channel. */
export function join(channel: string, key?: string): Message {
  return key === undefined ? command("JOIN", channel) : command("JOIN", channel, key);
}

/** `PART <channel>`, optionally with a `:<reason>`. */
export function part(channel: string, reason?: string): Message {
  return reason === undefined ? command("PART", channel) : command("PART", channel, reason);
}

/** `KICK <channel> <nick>`, optionally with a `:<reason>`. */
export function kick(channel: string, nick: string, reason?: string): Message {
  return reason === undefined
    ? command("KICK", channel, nick)
    : command("KICK", channel, nick, reason);
}

/**
 * `MODE <target> [<modes> [params...]]`. With no `modes` it queries the target's
 * current modes; otherwise it applies `modes` with any positional params.
 */
export function mode(target: string, modes?: string, ...params: string[]): Message {
  return modes === undefined ? command("MODE", target) : command("MODE", target, modes, ...params);
}

/**
 * `TOPIC <channel>` to query, or `TOPIC <channel> :<topic>` to set it. Passing an
 * empty string clears the topic (a distinct action from querying).
 */
export function topic(channel: string, newTopic?: string): Message {
  return newTopic === undefined ? command("TOPIC", channel) : command("TOPIC", channel, newTopic);
}

/** `INVITE <nick> <channel>`. */
export function invite(nick: string, channel: string): Message {
  return command("INVITE", nick, channel);
}

/** `WHOIS <target>` — request detailed info about a nick. */
export function whois(target: string): Message {
  return command("WHOIS", target);
}

/** `WHO <mask>` — request a listing for a channel or user mask. */
export function who(mask: string): Message {
  return command("WHO", mask);
}

/** `NAMES <channel>` — request a channel's member list. */
export function names(channel: string): Message {
  return command("NAMES", channel);
}

/** `AWAY :<reason>` to set away status, or bare `AWAY` to clear it. */
export function away(reason?: string): Message {
  return reason === undefined ? command("AWAY") : command("AWAY", reason);
}
