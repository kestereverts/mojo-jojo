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
