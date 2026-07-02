import type { Message } from "./types.ts";
import { escapeTagValue } from "./escape.ts";

/** Bytes that would split the wire line or terminate the message early. */
const FORBIDDEN = /[\r\n\0]/;

/**
 * IRCv3 tag-key grammar: an optional client-only `+` prefix, an optional
 * vendor (`example.com/`), then the key body of letters, digits and hyphens.
 * @see https://ircv3.net/specs/extensions/message-tags#format
 */
const TAG_KEY = /^\+?(?:[0-9A-Za-z.-]+\/)?[0-9A-Za-z-]+$/;

/** True when `key` is a syntactically valid IRCv3 tag key. */
export function isValidTagKey(key: string): boolean {
  return TAG_KEY.test(key);
}

/** Options for {@link buildMessage}. */
export interface BuildOptions {
  /**
   * Reject (throw on) a structurally-impossible message — a non-final param that
   * is empty / has a space / begins with `:`, a param or command with CR/LF/NUL,
   * or a malformed tag key. Defaults to `true`.
   *
   * Pass `false` for the *lenient* internal path (`OutboundQueue.sendImmediate`),
   * which serializes verbatim and then strips/truncates the raw line itself —
   * that path must never throw (it carries QUIT/keepalive traffic).
   */
  readonly validate?: boolean;
}

/**
 * Serialize a {@link Message} back into a single raw IRC protocol line.
 *
 * The returned string does *not* include the trailing CRLF — the transport
 * layer appends `\r\n`. Segments are emitted in order: `@tags`, `:source`,
 * command, then params. The final parameter is written as a trailing parameter
 * (prefixed with `:`) when it is empty, contains a space, or begins with `:`.
 *
 * This is a direct serializer, not an inverse tokenizer: the IR is normalized,
 * so a trailing parameter that doesn't strictly need the `:` is emitted without
 * it, and a tag whose value is `""` is emitted as a bare key.
 *
 * `buildMessage` is the single serialization chokepoint, so it is **strict**: a
 * structurally-impossible message (a middle param that is empty, contains a
 * space, or begins with `:` — all of which reparse as a *different* param list;
 * a tag key that would break the tag-list framing; a CR/LF/NUL anywhere) throws
 * rather than silently emitting a line that means something else on the wire.
 *
 * @param message - The intermediate representation to serialize.
 * @param options - See {@link BuildOptions}; `validate` defaults to `true`.
 * @returns A single IRC line without the trailing CRLF.
 * @throws {Error} when `validate` and the message cannot be serialized without altering its meaning.
 *
 * @see https://modern.ircdocs.horse/#message-format
 */
export function buildMessage(message: Message, options: BuildOptions = {}): string {
  const validate = options.validate ?? true;
  let out = "";

  // Tags: '@key=value;key2;+client/key=value '
  const tagKeys = Object.keys(message.tags);
  if (tagKeys.length > 0) {
    out += "@";
    for (let i = 0; i < tagKeys.length; i++) {
      const key = tagKeys[i]!;
      const value = message.tags[key]!;
      // A key containing ';', '=', space, CR/LF/NUL (i.e. anything outside the
      // tag-key grammar) would corrupt the tag-list framing — only values are
      // escaped, so the key must be well-formed as-is.
      if (validate && !isValidTagKey(key)) {
        throw new Error(`buildMessage: invalid tag key ${JSON.stringify(key)}`);
      }
      if (i > 0) {
        out += ";";
      }
      out += value === "" ? key : `${key}=${escapeTagValue(value)}`;
    }
    out += " ";
  }

  // Source: ':name[!user][@host] '
  const source = message.source;
  if (source !== null) {
    out += ":" + source.name;
    if (source.user !== undefined) {
      out += "!" + source.user;
    }
    if (source.host !== undefined) {
      out += "@" + source.host;
    }
    out += " ";
  }

  if (
    validate &&
    (message.command === "" || /\s/.test(message.command) || FORBIDDEN.test(message.command))
  ) {
    throw new Error(`buildMessage: invalid command ${JSON.stringify(message.command)}`);
  }
  out += message.command;

  // Params: space-separated, last one re-emitted as trailing when required.
  // A non-final param that is empty / contains a space / begins with ':' cannot
  // be represented as a middle param — it would inject or swallow params on the
  // wire — so reject it. CR/LF/NUL are illegal in any param.
  const params = message.params;
  for (let i = 0; i < params.length; i++) {
    const param = params[i]!;
    const isLast = i === params.length - 1;
    if (validate && FORBIDDEN.test(param)) {
      throw new Error(`buildMessage: param ${i} contains CR, LF, or NUL`);
    }
    if (validate && !isLast && (param === "" || param.includes(" ") || param.startsWith(":"))) {
      throw new Error(
        `buildMessage: non-final param ${i} (${JSON.stringify(param)}) is empty, ` +
          `contains a space, or begins with ':' — only the trailing param may`,
      );
    }
    const trailing =
      isLast && (param === "" || param.includes(" ") || param.startsWith(":"));
    out += trailing ? " :" + param : " " + param;
  }

  return out;
}
