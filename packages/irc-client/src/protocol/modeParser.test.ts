import { describe, expect, test } from "bun:test";
import { parseModeChanges, classifyMode } from "./modeParser.ts";
import { parseIsupport } from "../isupport/parseIsupport.ts";

const isupport = parseIsupport([
  "PREFIX=(qaohv)~&@%+",
  "CHANMODES=eIbq,k,flj,CFLMPQScgimnprstuz",
]);

describe("classifyMode", () => {
  test("classifies prefix and CHANMODES groups", () => {
    expect(classifyMode("o", isupport)).toBe("prefix");
    expect(classifyMode("v", isupport)).toBe("prefix");
    expect(classifyMode("b", isupport)).toBe("A");
    expect(classifyMode("k", isupport)).toBe("B");
    expect(classifyMode("l", isupport)).toBe("C");
    expect(classifyMode("m", isupport)).toBe("D");
    expect(classifyMode("Z", isupport)).toBe("unknown");
  });
});

describe("parseModeChanges", () => {
  test("consumes params per mode group, honouring +/- transitions", () => {
    // +o (prefix, param), +v (prefix, param), +k (B, param), -l (C, no param)
    const changes = parseModeChanges("+ovk-l", ["alice", "bob", "secret"], isupport);
    expect(changes).toEqual([
      { added: true, mode: "o", param: "alice", kind: "prefix" },
      { added: true, mode: "v", param: "bob", kind: "prefix" },
      { added: true, mode: "k", param: "secret", kind: "B" },
      { added: false, mode: "l", param: null, kind: "C" },
    ]);
  });

  test("type C takes a param on set but not on unset", () => {
    expect(parseModeChanges("+l", ["50"], isupport)).toEqual([
      { added: true, mode: "l", param: "50", kind: "C" },
    ]);
    expect(parseModeChanges("-l", [], isupport)).toEqual([
      { added: false, mode: "l", param: null, kind: "C" },
    ]);
  });

  test("type A list modes always take a param (set and unset)", () => {
    const changes = parseModeChanges("+b-b", ["*!*@bad", "*!*@old"], isupport);
    expect(changes[0]).toEqual({ added: true, mode: "b", param: "*!*@bad", kind: "A" });
    expect(changes[1]).toEqual({ added: false, mode: "b", param: "*!*@old", kind: "A" });
  });

  test("type D modes never take a param", () => {
    const changes = parseModeChanges("+imn", [], isupport);
    expect(changes.map((c) => c.mode)).toEqual(["i", "m", "n"]);
    expect(changes.every((c) => c.param === null)).toBe(true);
  });

  test("a param-needing mode with no available param yields param: null", () => {
    const changes = parseModeChanges("+o", [], isupport);
    expect(changes).toEqual([{ added: true, mode: "o", param: null, kind: "prefix" }]);
  });

  test("unknown modes are treated as paramless", () => {
    const changes = parseModeChanges("+Z", ["leftover"], isupport);
    expect(changes).toEqual([{ added: true, mode: "Z", param: null, kind: "unknown" }]);
  });
});
