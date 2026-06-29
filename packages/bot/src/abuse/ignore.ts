import type { CaseMapper, PrivmsgEvent } from "@mojo-jojo/irc-client";
import { matchesAny } from "../identity/match.ts";

/**
 * A bot-level ignore list. Senders matching any pattern (same `account:`/`mask:`/nick
 * forms as owners) are dropped before command dispatch.
 */
export class IgnoreList {
  readonly #patterns: readonly string[];

  constructor(patterns: readonly string[] = []) {
    this.#patterns = patterns;
  }

  get size(): number {
    return this.#patterns.length;
  }

  /** True when `event`'s sender is ignored. `caseMapper` comes from the live server state. */
  has(event: PrivmsgEvent, caseMapper: CaseMapper | null): boolean {
    if (this.#patterns.length === 0) return false;
    return matchesAny(event, this.#patterns, caseMapper);
  }
}
