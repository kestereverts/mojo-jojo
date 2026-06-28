import type { CaseMapper } from "../casemapping/CaseMapper.ts";
import { IrcMap } from "../casemapping/IrcMap.ts";
import type { Member } from "./Member.ts";

/**
 * The members of one channel, keyed case-insensitively by nick. The type-safe
 * primary API is {@link get}/{@link has}/iteration; the ergonomic
 * `users["nick"]` Proxy sugar (per the design's decision #4) is layered on in
 * M5. Mutated only by the StateStore via the `@internal` methods.
 */
export class MemberList implements Iterable<Member> {
  readonly #members: IrcMap<Member>;

  constructor(mapper: CaseMapper) {
    this.#members = new IrcMap<Member>(mapper);
  }

  get size(): number {
    return this.#members.size;
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

  /** @internal Re-fold all member keys under a new casemapping. */
  rekey(mapper: CaseMapper): void {
    this.#members.rekey(mapper);
  }
}
