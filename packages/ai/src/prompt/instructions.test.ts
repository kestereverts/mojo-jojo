import { describe, expect, test } from "bun:test";
import { buildDefaultInstructions, buildDefaultSections, leakDetectionSections } from "./instructions.ts";
import { PERSONA_SECTION } from "./persona.ts";
import { ANTI_IMPERSONATION_SECTION, BEHAVIOR_SECTION, EXAMPLES_SECTION, MESSAGE_FORMAT_SECTION, SPECIAL_RESPONSES_SECTION } from "./rules.ts";
import type { Friend } from "../identity/speakers.ts";
import type { PromptSection } from "./sections.ts";

describe("buildDefaultInstructions", () => {
  test("with no friends and no tool guidance, still assembles the static sections", () => {
    const instructions = buildDefaultInstructions();
    expect(instructions).toContain(PERSONA_SECTION.body);
    expect(instructions).toContain(SPECIAL_RESPONSES_SECTION.body);
    expect(instructions).not.toContain("## Known Users");
  });

  test("folds tool guidance in after the message-format section and before known-users/anti-impersonation", () => {
    const guidance: PromptSection = { id: "tool-x", title: "some_tool", body: "Call some_tool when X." };
    const alice: Friend = { id: "alice", name: "Alice", aliases: ["alice"], accounts: [] };
    const instructions = buildDefaultInstructions([alice], [guidance]);

    const toolIdx = instructions.indexOf("Call some_tool when X.");
    const messageFormatIdx = instructions.indexOf("## Message Format");
    const knownUsersIdx = instructions.indexOf("## Known Users");
    const antiImpersonationIdx = instructions.indexOf("## Anti-Impersonation");

    expect(toolIdx).toBeGreaterThan(-1);
    expect(toolIdx).toBeGreaterThan(messageFormatIdx);
    expect(toolIdx).toBeLessThan(knownUsersIdx);
    expect(knownUsersIdx).toBeLessThan(antiImpersonationIdx);
  });

  test("multiple tool guidance sections are folded in registry order", () => {
    const a: PromptSection = { id: "a", title: "tool_a", body: "AAA" };
    const b: PromptSection = { id: "b", title: "tool_b", body: "BBB" };
    const instructions = buildDefaultInstructions([], [a, b]);
    expect(instructions.indexOf("AAA")).toBeLessThan(instructions.indexOf("BBB"));
  });

  test("known-users section is omitted (not just empty) when there are no friends, even with tool guidance present", () => {
    const guidance: PromptSection = { id: "tool-x", title: "some_tool", body: "Call some_tool when X." };
    const instructions = buildDefaultInstructions([], [guidance]);
    expect(instructions).not.toContain("## Known Users");
  });
});

describe("leakDetectionSections", () => {
  test("keeps only genuinely-internal sections — behavior, message-format, anti-impersonation, known-users", () => {
    const alice: Friend = { id: "alice", name: "Alice", aliases: ["alice"], accounts: [] };
    const toolGuidance: PromptSection = { id: "tool-x", title: "some_tool", body: "Call some_tool when X." };
    const sections = buildDefaultSections([alice], [toolGuidance]);
    const checked = leakDetectionSections(sections);
    const ids = checked.map((s) => s.id).sort();
    expect(ids).toEqual(["anti-impersonation", "behavior", "known-users", "message-format"]);
  });

  test("excludes PERSONA — the bot is instructed to share it on a self-intro request (review finding)", () => {
    const checked = leakDetectionSections(buildDefaultSections());
    expect(checked.some((s) => s.id === PERSONA_SECTION.id)).toBe(false);
  });

  test("excludes SPECIAL_RESPONSES and EXAMPLES — canned/example content the bot legitimately reproduces (review finding)", () => {
    const checked = leakDetectionSections(buildDefaultSections());
    expect(checked.some((s) => s.id === SPECIAL_RESPONSES_SECTION.id)).toBe(false);
    expect(checked.some((s) => s.id === EXAMPLES_SECTION.id)).toBe(false);
  });

  test("excludes tool guidance — discoverable/topical, not secret (review finding)", () => {
    const toolGuidance: PromptSection = { id: "tool-weather", title: "weather_forecast", body: "Call when asked about weather." };
    const checked = leakDetectionSections(buildDefaultSections([], [toolGuidance]));
    expect(checked.some((s) => s.id === "tool-weather")).toBe(false);
  });

  test("includes BEHAVIOR/MESSAGE_FORMAT/ANTI_IMPERSONATION — genuine internal operational rules/contracts", () => {
    const checked = leakDetectionSections(buildDefaultSections());
    const ids = checked.map((s) => s.id);
    expect(ids).toContain(BEHAVIOR_SECTION.id);
    expect(ids).toContain(MESSAGE_FORMAT_SECTION.id);
    expect(ids).toContain(ANTI_IMPERSONATION_SECTION.id);
  });

  test("includes known-users when friends are present — real person data is exactly what SHOULD trip a leak check", () => {
    const alice: Friend = { id: "alice", name: "Alice", aliases: ["alice"], accounts: [] };
    const checked = leakDetectionSections(buildDefaultSections([alice]));
    expect(checked.some((s) => s.id === "known-users")).toBe(true);
  });
});
