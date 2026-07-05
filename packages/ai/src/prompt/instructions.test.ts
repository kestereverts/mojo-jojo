import { describe, expect, test } from "bun:test";
import { buildDefaultInstructions } from "./instructions.ts";
import { PERSONA_SECTION } from "./persona.ts";
import { SPECIAL_RESPONSES_SECTION } from "./rules.ts";
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
