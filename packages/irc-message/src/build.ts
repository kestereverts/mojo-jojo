import type { Message } from "./types.ts";
import { escapeTagValue } from "./escape.ts";

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
 * @param message - The intermediate representation to serialize.
 * @returns A single IRC line without the trailing CRLF.
 *
 * @see https://modern.ircdocs.horse/#message-format
 */
export function buildMessage(message: Message): string {
  let out = "";

  // Tags: '@key=value;key2;+client/key=value '
  const tagKeys = Object.keys(message.tags);
  if (tagKeys.length > 0) {
    out += "@";
    for (let i = 0; i < tagKeys.length; i++) {
      const key = tagKeys[i]!;
      const value = message.tags[key]!;
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

  out += message.command;

  // Params: space-separated, last one re-emitted as trailing when required.
  const params = message.params;
  for (let i = 0; i < params.length; i++) {
    const param = params[i]!;
    const isLast = i === params.length - 1;
    const trailing =
      isLast && (param === "" || param.includes(" ") || param.startsWith(":"));
    out += trailing ? " :" + param : " " + param;
  }

  return out;
}
