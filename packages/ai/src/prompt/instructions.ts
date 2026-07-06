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
import { assembleInstructions, type PromptSection } from "./sections.ts";

/**
 * The fixed section order, given whatever friends are currently known (omit
 * for none — e.g. the debug CLI's default) and whatever tools are enabled
 * (their colocated guidance, in registry order — see `tools/index.ts`'s
 * `buildToolSet`). Exposed separately from {@link buildDefaultInstructions}
 * (which just flattens this into one string) so the leak detector (M7) can
 * embed each section on its own, from the exact same section list that's
 * actually sent as instructions — never a second, divergent reconstruction
 * of "what the sections were."
 */
export function buildDefaultSections(
  friends: readonly Friend[] = [],
  toolGuidance: readonly PromptSection[] = [],
): PromptSection[] {
  const knownUsers = buildKnownUsersSection(friends);
  return [
    PERSONA_SECTION,
    BEHAVIOR_SECTION,
    MESSAGE_FORMAT_SECTION,
    ...toolGuidance,
    ...(knownUsers ? [knownUsers] : []),
    ANTI_IMPERSONATION_SECTION,
    SPECIAL_RESPONSES_SECTION,
    EXAMPLES_SECTION,
  ];
}

/**
 * Assemble the full instructions from the fixed section order. The single
 * place both the live module and `mojo-ai-debug` build instructions from, so
 * they can never silently diverge — the same drift class M1/M2's reviews
 * caught in the config-parsing path.
 */
export function buildDefaultInstructions(
  friends: readonly Friend[] = [],
  toolGuidance: readonly PromptSection[] = [],
): string {
  return assembleInstructions(buildDefaultSections(friends, toolGuidance));
}

/**
 * Sections genuinely worth leak-checking: internal OPERATIONAL rules/
 * contracts and any real known-user data. Deliberately EXCLUDES persona lore,
 * canned special-response triggers, and few-shot examples — the bot is
 * explicitly INSTRUCTED to reproduce that content on request (a self-intro
 * echoes PERSONA, a "tell me a joke"-style trigger echoes SPECIAL_RESPONSES
 * verbatim, an on-topic question can echo an EXAMPLES answer almost
 * word-for-word), and tool guidance ("call when the user asks about
 * weather...") is discoverable/topical, not secret. Checking the leak
 * detector against those sections makes the bot's own designed behavior
 * indistinguishable from an actual leak — a normal self-introduction or
 * canned-response trigger would score as high on PERSONA/SPECIAL_RESPONSES as
 * a real extraction attempt would (M7 review finding, Ophelia). Filtered from
 * the SAME section list `buildDefaultSections` returns (by stable `id`), not
 * a second reconstruction of "which sections exist."
 */
const LEAK_CHECKED_SECTION_IDS: ReadonlySet<string> = new Set([
  "behavior",
  "message-format",
  "anti-impersonation",
  "known-users",
]);

export function leakDetectionSections(sections: readonly PromptSection[]): PromptSection[] {
  return sections.filter((s) => LEAK_CHECKED_SECTION_IDS.has(s.id));
}
