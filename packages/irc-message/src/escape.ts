/**
 * IRCv3 message-tag value escaping.
 *
 * Tag values on the wire escape five characters so they can't be confused with
 * the tag-list framing. The intermediate representation stores values
 * *unescaped*; the parser calls {@link unescapeTagValue} on the way in and the
 * builder calls {@link escapeTagValue} on the way out.
 *
 * | Raw value char | Escaped form |
 * | -------------- | ------------ |
 * | `;`            | `\:`         |
 * | ` ` (space)    | `\s`         |
 * | `\`            | `\\`         |
 * | CR             | `\r`         |
 * | LF             | `\n`         |
 *
 * @see https://ircv3.net/specs/extensions/message-tags#escaping-values
 */

/**
 * Decode an escaped tag value into its literal form.
 *
 * Unknown escapes (`\x` for any other `x`) drop the backslash and keep the
 * character, and a lone trailing backslash is dropped — both per the spec.
 */
export function unescapeTagValue(value: string): string {
  // Fast path: nothing to unescape.
  if (!value.includes("\\")) {
    return value;
  }

  let result = "";
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;
    if (ch !== "\\") {
      result += ch;
      continue;
    }

    const next = value[i + 1];
    if (next === undefined) {
      // Lone trailing backslash — dropped.
      break;
    }
    switch (next) {
      case ":":
        result += ";";
        break;
      case "s":
        result += " ";
        break;
      case "\\":
        result += "\\";
        break;
      case "r":
        result += "\r";
        break;
      case "n":
        result += "\n";
        break;
      default:
        // Unknown escape — drop the backslash, keep the character.
        result += next;
        break;
    }
    i++; // consumed the character following the backslash
  }
  return result;
}

/**
 * Encode a literal tag value into its escaped wire form.
 */
export function escapeTagValue(value: string): string {
  // Fast path: no character needs escaping.
  if (!/[; \r\n\\]/.test(value)) {
    return value;
  }

  let result = "";
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;
    switch (ch) {
      case ";":
        result += "\\:";
        break;
      case " ":
        result += "\\s";
        break;
      case "\\":
        result += "\\\\";
        break;
      case "\r":
        result += "\\r";
        break;
      case "\n":
        result += "\\n";
        break;
      default:
        result += ch;
        break;
    }
  }
  return result;
}
