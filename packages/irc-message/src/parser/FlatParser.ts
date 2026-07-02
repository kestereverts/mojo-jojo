import { TokenType } from "../tokenizer/Token.ts";
import { unescapeTagValue } from "../escape.ts";
import type { Message } from "../types.ts";

/** Mutable working shape for a source, assembled across prefix tokens. */
interface MutableSource {
  name: string;
  user?: string;
  host?: string;
}

/**
 * Parser variant that consumes the flat `[type, start, end]` triple stream
 * produced by {@link JsFastTokenizer} and the WASM backends, instead of an
 * array of `Token` objects. Identical logic to the reference
 * {@link Parser} — decode each content span from `buffer`, unescape tag values,
 * assemble a {@link Message}.
 */
export class FlatParser {
  private readonly decoder = new TextDecoder();

  public parse(buffer: Uint8Array, tokens: Int32Array, count: number): Message {
    // Null-prototype so a tag literally named `__proto__` becomes an own
    // property (a plain object would silently drop it / hand back the prototype).
    const tags: Record<string, string> = Object.create(null);
    const params: string[] = [];
    let source: MutableSource | null = null;
    let command = "";

    let tagKey: string | null = null;
    let tagValue = "";
    let clientPrefix = false;

    // Always clear the pending value — a keyless `=value` (`@=v;a`) must not
    // leak its value onto the following tag.
    const flushTag = (): void => {
      if (tagKey !== null) {
        tags[tagKey] = tagValue;
        tagKey = null;
      }
      tagValue = "";
    };

    const decoder = this.decoder;
    const len = count * 3;
    for (let i = 0; i < len; i += 3) {
      const type = tokens[i]!;
      const start = tokens[i + 1]!;
      const end = tokens[i + 2]!;
      switch (type) {
        case TokenType.TagClientKeyStart:
          clientPrefix = true;
          break;
        case TokenType.TagKey:
          flushTag();
          tagKey =
            (clientPrefix ? "+" : "") +
            decoder.decode(buffer.subarray(start, end));
          clientPrefix = false;
          break;
        case TokenType.TagValue:
          tagValue = unescapeTagValue(decoder.decode(buffer.subarray(start, end)));
          break;
        case TokenType.TagSeparator:
          flushTag();
          // Reset the client-only flag: a `+` with an empty key (`@+;a`) emits
          // no TagKey, so without this the '+' would leak onto the next key.
          clientPrefix = false;
          break;
        case TokenType.PrefixStart:
          flushTag();
          source = { name: "" };
          break;
        case TokenType.PrefixName:
          source!.name = decoder.decode(buffer.subarray(start, end));
          break;
        case TokenType.PrefixUserStart:
          // An explicit '!' with an empty user (`nick!@host`): record the empty
          // user so it round-trips; a following PrefixUser token overwrites it.
          source!.user = "";
          break;
        case TokenType.PrefixUser:
          source!.user = decoder.decode(buffer.subarray(start, end));
          break;
        case TokenType.PrefixHost:
          source!.host = decoder.decode(buffer.subarray(start, end));
          break;
        case TokenType.Separator:
          flushTag();
          break;
        case TokenType.Command:
          flushTag();
          command = decoder.decode(buffer.subarray(start, end));
          break;
        case TokenType.MiddleParameter:
        case TokenType.TrailingParameter:
          params.push(decoder.decode(buffer.subarray(start, end)));
          break;
        // TagsStart, TagValueStart, PrefixHostStart, TrailingParameterStart,
        // EOF carry no content.
        default:
          break;
      }
    }
    flushTag();

    return { tags, source, command, params };
  }
}
