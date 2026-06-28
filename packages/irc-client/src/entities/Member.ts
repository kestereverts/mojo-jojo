import type { Channel } from "./Channel.ts";
import type { User } from "./User.ts";
import { prefixToMode } from "../isupport/parseIsupport.ts";

// Conventional status-mode letters. The actual prefix<->mode mapping for parsing
// comes from the server's ISUPPORT PREFIX, but the named predicates below follow
// the near-universal letter convention.
const MODE_OWNER = "q";
const MODE_ADMIN = "a";
const MODE_OP = "o";
const MODE_HALFOP = "h";
const MODE_VOICE = "v";

/**
 * A {@link User}'s membership in one {@link Channel} — the join entity holding
 * channel-scoped status modes (e.g. op `o`, voice `v`). One `User` may have many
 * `Member`s (one per channel); each `Member` references back to both.
 *
 * Modes are mutated only by the StateStore via the `@internal` methods.
 */
export class Member {
  readonly user: User;
  readonly channel: Channel;
  /** Status mode letters held in this channel (e.g. `o`, `v`). */
  readonly #modes = new Set<string>();

  constructor(user: User, channel: Channel) {
    this.user = user;
    this.channel = channel;
  }

  /** Convenience: the member's current nick (delegates to {@link User}). */
  get nick(): string {
    return this.user.nick;
  }

  /** Status mode letters held, e.g. `["o", "v"]` (unordered). */
  get modes(): readonly string[] {
    return [...this.#modes];
  }

  /**
   * Status prefix characters held (e.g. `["@", "+"]`), ordered by rank
   * (highest first) per the server's ISUPPORT PREFIX.
   */
  get prefixes(): readonly string[] {
    const { prefixes } = this.channel.server.isupport;
    return prefixes.filter((p) => this.#modes.has(p.mode)).map((p) => p.prefix);
  }

  /** The highest-ranked prefix char (e.g. `@`), or `null` if the member has none. */
  get highestPrefix(): string | null {
    return this.prefixes[0] ?? null;
  }

  isOwner(): boolean {
    return this.#modes.has(MODE_OWNER);
  }
  isAdmin(): boolean {
    return this.#modes.has(MODE_ADMIN);
  }
  isOp(): boolean {
    return this.#modes.has(MODE_OP);
  }
  isHalfOp(): boolean {
    return this.#modes.has(MODE_HALFOP);
  }
  isVoice(): boolean {
    return this.#modes.has(MODE_VOICE);
  }
  /** True if the member holds any status mode at all. */
  hasStatus(): boolean {
    return this.#modes.size > 0;
  }

  /** @internal Grant a status mode letter. */
  addMode(mode: string): void {
    this.#modes.add(mode);
  }

  /** @internal Revoke a status mode letter. */
  removeMode(mode: string): void {
    this.#modes.delete(mode);
  }

  /**
   * @internal Apply the status prefix characters parsed from a `353` NAMES entry
   * (e.g. `@+`), mapping each to its mode letter via ISUPPORT.
   */
  applyPrefixChars(chars: string): void {
    const { isupport } = this.channel.server;
    for (const char of chars) {
      const mode = prefixToMode(char, isupport);
      if (mode !== undefined) this.#modes.add(mode);
    }
  }
}
