import { TokenType, type Token } from "../tokenizer/Token.ts";
import { unescapeTagValue } from "../escape.ts";
import type { Message } from "../types.ts";

/** Mutable working shape for a source, assembled across prefix tokens. */
interface MutableSource {
  name: string;
  user?: string;
  host?: string;
}

/**
 * Second pass of the parse pipeline: turns the tokenizer's flat token stream
 * into a {@link Message}.
 *
 * Each content token is a byte-offset span into the same `buffer` the tokens
 * were produced from; the parser decodes those spans (slicing bytes *then*
 * decoding, since byte offsets are not character offsets in UTF-8) and
 * unescapes tag values. Marker tokens (`*Start`) only set context and
 * separators are skipped.
 *
 * A single instance reuses one `TextDecoder` across calls and is safe to reuse
 * sequentially.
 */
export class Parser {
  private readonly decoder = new TextDecoder();

  public parse(buffer: Uint8Array, tokens: readonly Token[]): Message {
    // Null-prototype so a tag literally named `__proto__` becomes an own
    // property (a plain object would silently drop it / hand back the prototype).
    const tags: Record<string, string> = Object.create(null);
    const params: string[] = [];
    let source: MutableSource | null = null;
    let command = "";

    // Pending tag being assembled between separators.
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

    const decode = (token: Token): string =>
      this.decoder.decode(buffer.subarray(token.start, token.end));

    for (const token of tokens) {
      switch (token.type) {
        case TokenType.TagClientKeyStart:
          clientPrefix = true;
          break;
        case TokenType.TagKey:
          flushTag();
          // Client-only tags keep their leading '+' in the key.
          tagKey = (clientPrefix ? "+" : "") + decode(token);
          clientPrefix = false;
          break;
        case TokenType.TagValue:
          tagValue = unescapeTagValue(decode(token));
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
          source!.name = decode(token);
          break;
        case TokenType.PrefixUserStart:
          // An explicit '!' with an empty user (`nick!@host`): record the empty
          // user so it round-trips; a following PrefixUser token overwrites it.
          source!.user = "";
          break;
        case TokenType.PrefixUser:
          source!.user = decode(token);
          break;
        case TokenType.PrefixHost:
          source!.host = decode(token);
          break;
        case TokenType.Separator:
          // A space delimiter; also flushes the final tag of the tag section.
          flushTag();
          break;
        case TokenType.Command:
          flushTag();
          command = decode(token);
          break;
        case TokenType.MiddleParameter:
        case TokenType.TrailingParameter:
          // Params are literal decoded spans — never unescaped.
          params.push(decode(token));
          break;
        // TagsStart, TagValueStart, PrefixHostStart, TrailingParameterStart,
        // EOF carry no content — nothing to do.
        default:
          break;
      }
    }
    // Defensive: flush a tag still pending at end of stream.
    flushTag();

    return { tags, source, command, params };
  }
}
