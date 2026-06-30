import type { CaseMapper, Member, PrivmsgEvent } from "@mojo-jojo/irc-client";
import { matchesAny } from "../identity/match.ts";
import type { CommandContext, Permission } from "./types.ts";

type StatusLevel = "voice" | "halfop" | "op" | "admin" | "owner";

// Conventional IRC status hierarchy (owner > admin > op > halfop > voice), evaluated
// through Member's own q/a/o/h/v predicates with rank implication. Using the
// predicates rather than raw ISUPPORT prefix order means a HIGHER status still
// satisfies a LOWER gate even when the server doesn't advertise the intermediate one
// (e.g. an op satisfies `halfop` on a network without +h) — the common case that a
// pure prefix-order derivation gets wrong. Exotic non-standard prefix orderings are
// not special-cased.
const LEVEL_RANK: Record<StatusLevel, number> = { voice: 1, halfop: 2, op: 3, admin: 4, owner: 5 };

/** Does `event`'s sender match any owner matcher? (account:/mask:/nick — see identity/match.) */
export function matchOwner(
  event: PrivmsgEvent,
  owners: readonly string[],
  caseMapper: CaseMapper | null,
): boolean {
  return matchesAny(event, owners, caseMapper);
}

/** Highest conventional status rank held by `member` (0 = none). */
function memberRank(member: Member): number {
  if (member.isOwner()) return 5;
  if (member.isAdmin()) return 4;
  if (member.isOp()) return 3;
  if (member.isHalfOp()) return 2;
  if (member.isVoice()) return 1;
  return 0;
}

/**
 * Decide whether `ctx` may run a command requiring `permission`.
 *
 * `owner` overrides everything (and is the only gate satisfiable in a PM, where
 * `event.member` is null). Channel-status gates require a membership and imply
 * higher ranks. A predicate is consulted directly.
 */
export function checkPermission(permission: Permission, ctx: CommandContext): boolean {
  if (permission === "anyone") return true;
  if (typeof permission === "function") return permission(ctx);

  const { event, bot, client } = ctx;
  if (matchOwner(event, bot.owners, client.server?.caseMapper ?? null)) return true;
  if (permission === "owner") return false;

  const member = event.member;
  if (member === null) return false; // channel-status gate in a PM
  return memberRank(member) >= LEVEL_RANK[permission];
}
