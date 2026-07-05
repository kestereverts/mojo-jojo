import { describe, expect, test } from "bun:test";
import {
  ANTI_IMPERSONATION_SECTION,
  BEHAVIOR_SECTION,
  EXAMPLES_SECTION,
  MESSAGE_FORMAT_SECTION,
  SPECIAL_RESPONSES_SECTION,
} from "./rules.ts";
import { PERSONA_SECTION } from "./persona.ts";

const STATIC_SECTIONS = [
  PERSONA_SECTION,
  BEHAVIOR_SECTION,
  MESSAGE_FORMAT_SECTION,
  ANTI_IMPERSONATION_SECTION,
  SPECIAL_RESPONSES_SECTION,
  EXAMPLES_SECTION,
];

describe("ported static prompt sections", () => {
  test("every section has a non-empty body and a unique id", () => {
    const ids = new Set<string>();
    for (const section of STATIC_SECTIONS) {
      expect(section.body.length).toBeGreaterThan(0);
      expect(ids.has(section.id)).toBe(false);
      ids.add(section.id);
    }
  });

  test("special responses points at this project's repo, not the old mojo-ai3 one", () => {
    expect(SPECIAL_RESPONSES_SECTION.body).toContain("github.com/kestereverts/mojo-jojo");
    expect(SPECIAL_RESPONSES_SECTION.body).not.toMatch(/github\.com\/kestereverts\/mojo(?!-jojo)/);
  });

  test("the message-format contract documents every Speaker field", () => {
    for (const field of ["nick", "account", "author", "via", "personId", "trust"]) {
      expect(MESSAGE_FORMAT_SECTION.body).toContain(field);
    }
  });

  test("anti-impersonation is generalized (trust tiers), not a hardcoded person", () => {
    expect(ANTI_IMPERSONATION_SECTION.body).not.toContain("IJ");
    expect(ANTI_IMPERSONATION_SECTION.body.toLowerCase()).toContain("trust");
  });

  test("behavior no longer hardcodes an exact character/line cap (that's per-turn guidance now)", () => {
    expect(BEHAVIOR_SECTION.body).not.toContain("200 characters");
  });

  test("no real friend names/aliases/cities from mojo-ai3's excised Known Users table leaked into ported content", () => {
    // Every real person's name/alias/city that appeared ONLY in mojo-ai3's
    // Known Users table (never in the persona/lore/special-responses this
    // milestone actually ports) — if any of these show up here, something
    // leaked. (Found and fixed one during this port: an example sentence
    // used a real friend's actual first name as a generic illustration.)
    const excised = [
      "Xerox",
      "xorex",
      "Jürgen",
      "Jurgen",
      "jbrunink",
      "Jorgen",
      "Jurrege",
      "Westie",
      "typefish",
      "wootcake",
      "Manuel",
      "Bangkok",
      "mave",
      "Eschweiler",
      "timternet",
      "TimUK",
      "Timb",
      "Littlehampton",
      "Revelator",
      "angryce",
      "Evenskjer",
      "milo0010",
      "Almere",
      "Pyrokid",
      "biddierepellent",
      "jtylr",
      "KaraG",
      "Potassium",
      "cammy",
      "bammy",
      "Uckermark",
      "Endomorphism",
      "The Hague",
      "Almelo",
      "TheIJ",
    ];
    const allText = STATIC_SECTIONS.map((s) => s.body).join("\n");
    for (const name of excised) {
      expect(allText).not.toContain(name);
    }
  });
});
