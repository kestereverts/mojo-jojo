import { describe, expect, test } from "bun:test";
import { assembleInstructions, type PromptSection } from "./sections.ts";

describe("assembleInstructions", () => {
  test("renders each section as a '## Title' heading with its body, in order", () => {
    const sections: PromptSection[] = [
      { id: "a", title: "First", body: "first body" },
      { id: "b", title: "Second", body: "second body" },
    ];
    const result = assembleInstructions(sections);
    expect(result).toBe("## First\n\nfirst body\n\n---\n\n## Second\n\nsecond body");
  });

  test("a single section has no separator", () => {
    const result = assembleInstructions([{ id: "a", title: "Only", body: "body" }]);
    expect(result).toBe("## Only\n\nbody");
  });

  test("an empty section list assembles to an empty string", () => {
    expect(assembleInstructions([])).toBe("");
  });
});
