/**
 * Intermediate representation of an IRC protocol message.
 *
 * This is the shared contract between the parser (raw line -> `Message`) and
 * the builder (`Message` -> raw line). The shape follows the IRCv3 message
 * grammar, which is a superset of RFC 1459 / RFC 2812:
 *
 *     ['@' tags SPACE] [':' source SPACE] command [params] CRLF
 *
 * @see https://modern.ircdocs.horse/#message-format
 * @see https://ircv3.net/specs/extensions/message-tags
 */
export interface Message {
  /**
   * IRCv3 message tags (the `@key=value;key2` segment), keyed by tag name.
   *
   * A value-less tag (`@foo`) is represented with an empty-string value.
   * Empty when the message carries no tags.
   */
  readonly tags: Tags;

  /**
   * The message source / prefix (the `:nick!user@host` segment), or `null`
   * when the message has no prefix.
   */
  readonly source: Source | null;

  /**
   * The IRC command: either a textual command (e.g. `PRIVMSG`, `NICK`) or a
   * three-digit numeric reply (e.g. `001`, `433`). Kept as a raw string so
   * numerics retain their leading zeros.
   */
  readonly command: string;

  /**
   * Ordered command parameters. The trailing parameter (the `:last arg` that
   * may contain spaces) is the final element with no special marking — the
   * builder re-emits the `:` sigil only when the last param is empty, contains
   * a space, or begins with `:`. A trailing param that doesn't need the sigil
   * therefore round-trips without it.
   */
  readonly params: readonly string[];
}

/**
 * IRCv3 message tags, keyed by tag name.
 *
 * Tag values are stored in their *unescaped* form; escaping of the reserved
 * characters (`;`, space, `\`, CR, LF) is the parser's job on the way in and the
 * builder's on the way out.
 *
 * Normalization notes (the IR is normalized, not byte-faithful):
 * - **Value-less and empty-value tags both map to `""`** — `@foo` and `@foo=`
 *   are indistinguishable here, and the builder re-emits the bare `@foo` form.
 * - **Client-only tags keep their leading `+` in the key** (e.g.
 *   `+example.com/foo`), so they round-trip without a separate field.
 * - **Duplicate keys resolve last-wins**, per object semantics.
 * - **Insertion order is the emit order.** Switch to a `Map` only if strict tag
 *   ordering across all key shapes ever matters.
 *
 * @see https://ircv3.net/specs/extensions/message-tags#escaping-values
 */
export type Tags = Readonly<Record<string, string>>;

/**
 * A parsed message source / prefix.
 *
 * A prefix is either a bare server name or a user reference of the form
 * `nick!user@host`, where `user` and `host` are optional:
 *
 *     servername
 *     nick
 *     nick@host
 *     nick!user@host
 */
export interface Source {
  /** Nickname or server name (the portion before any `!` or `@`). */
  readonly name: string;
  /** Username, present when the prefix contained a `!user` segment. */
  readonly user?: string;
  /** Hostname, present when the prefix contained an `@host` segment. */
  readonly host?: string;
}
