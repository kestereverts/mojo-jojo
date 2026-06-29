import type { CaseMapper } from "../casemapping/CaseMapper.ts";
import { IrcMap } from "../casemapping/IrcMap.ts";
import type { Member } from "./Member.ts";

/**
 * A case-insensitive index of members by nick, reviving the classic Mojo
 * `channel.users["nick"]` ergonomics (design decision #4). Returned by
 * {@link MemberList.by}; reads fall through to the underlying
 * {@link MemberList.get}, so `list.by["Alice"]` honours the active casemapping
 * and yields `undefined` for absent nicks. Read-only.
 */
export type MembersByNick = { readonly [nick: string]: Member | undefined };

/**
 * The members of one channel, keyed case-insensitively by nick. The type-safe
 * primary API is {@link get}/{@link has}/iteration; the ergonomic
 * `list.by["nick"]` Proxy sugar (per the design's decision #4) is exposed via
 * {@link by}. Mutated only by the StateStore via the `@internal` methods.
 *
 * The Proxy sugar lives behind {@link by} (rather than making the class itself
 * indexable) on purpose: a member whose nick collides with a method name
 * (`get`, `has`, `size`, … all valid IRC nicks) must never shadow or be shadowed
 * by the API, so the lookup surface is kept separate from the method surface.
 */
export class MemberList implements Iterable<Member> {
  readonly #members: IrcMap<Member>;
  #by: MembersByNick | null = null;

  constructor(mapper: CaseMapper) {
    this.#members = new IrcMap<Member>(mapper);
  }

  get size(): number {
    return this.#members.size;
  }

  /**
   * Proxy view giving `list.by["nick"]` / `list.by.nick` index access (and
   * `"nick" in list.by`, `Object.keys(list.by)`). Lazily created and memoized;
   * lookups delegate to {@link get}, so casemapping and live membership apply.
   */
  get by(): MembersByNick {
    if (this.#by === null) {
      const members = this.#members;
      this.#by = new Proxy(Object.create(null) as MembersByNick, {
        get: (_target, prop) => (typeof prop === "string" ? members.get(prop) : undefined),
        has: (_target, prop) => typeof prop === "string" && members.has(prop),
        ownKeys: () => [...members.keys()],
        getOwnPropertyDescriptor: (_target, prop) =>
          typeof prop === "string" && members.has(prop)
            ? { enumerable: true, configurable: true, value: members.get(prop) }
            : undefined,
        // Read-only + always-extensible: reject every mutation/lock. Without the
        // `preventExtensions` guard a caller could freeze the (empty) target,
        // after which `ownKeys` returning virtual member keys violates the Proxy
        // invariant and throws TypeError. Returning false fails the operation.
        set: () => false,
        defineProperty: () => false,
        deleteProperty: () => false,
        preventExtensions: () => false,
      });
    }
    return this.#by;
  }

  get(nick: string): Member | undefined {
    return this.#members.get(nick);
  }

  has(nick: string): boolean {
    return this.#members.has(nick);
  }

  /** Iterate the members (values). */
  [Symbol.iterator](): IterableIterator<Member> {
    return this.#members.values();
  }

  values(): IterableIterator<Member> {
    return this.#members.values();
  }

  /** The current member nicks (display case). */
  nicks(): IterableIterator<string> {
    return this.#members.keys();
  }

  /** @internal Add (or replace) a member, keyed by its current nick. */
  add(member: Member): void {
    this.#members.set(member.nick, member);
  }

  /** @internal Remove a member by nick; returns the removed member, if any. */
  remove(nick: string): Member | undefined {
    const member = this.#members.get(nick);
    if (member) this.#members.delete(nick);
    return member;
  }

  /** @internal Re-key a member after its nick changed. */
  rename(oldNick: string, newNick: string): void {
    const member = this.#members.get(oldNick);
    if (!member) return;
    this.#members.delete(oldNick);
    this.#members.set(newNick, member);
  }

  /**
   * @internal Re-fold all member keys under a new casemapping. A {@link Member}
   * holds no event stream, so a collision needs no disposal — the displaced
   * member is simply dropped. We do, however, keep our own self membership on a
   * collision, so a channel never ends up holding a member that references a
   * soon-disposed non-self user instead of us.
   */
  rekey(mapper: CaseMapper): void {
    this.#members.rekey(mapper, (_incoming, existing) => !existing.user.isSelf);
  }
}
