import type { Friend } from "../identity/speakers.ts";
import { buildKnownUsersSection } from "./friends.ts";
import { PERSONA_SECTION } from "./persona.ts";
import {
  ANTI_IMPERSONATION_SECTION,
  BEHAVIOR_SECTION,
  EXAMPLES_SECTION,
  MESSAGE_FORMAT_SECTION,
  SPECIAL_RESPONSES_SECTION,
} from "./rules.ts";
import { assembleInstructions } from "./sections.ts";

/**
 * Assemble the full instructions from the fixed section order, given whatever
 * friends are currently known (omit for none — e.g. the debug CLI's default).
 * The single place both the live module and `mojo-ai-debug` build instructions
 * from, so they can never silently diverge — the same drift class M1/M2's
 * reviews caught in the config-parsing path.
 */
export function buildDefaultInstructions(friends: readonly Friend[] = []): string {
  const knownUsers = buildKnownUsersSection(friends);
  return assembleInstructions([
    PERSONA_SECTION,
    BEHAVIOR_SECTION,
    MESSAGE_FORMAT_SECTION,
    // Per-tool guidance sections slot in here once a tool registry exists (M4).
    ...(knownUsers ? [knownUsers] : []),
    ANTI_IMPERSONATION_SECTION,
    SPECIAL_RESPONSES_SECTION,
    EXAMPLES_SECTION,
  ]);
}
