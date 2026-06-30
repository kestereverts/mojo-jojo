import { describe, expect, test } from "bun:test";
import { parseCommandLine } from "./parse.ts";

describe("parseCommandLine", () => {
  test("strips prefix, lowercases the name, splits args, preserves argLine spacing", () => {
    expect(parseCommandLine("!", "!Say #x hello   world", { requirePrefix: true })).toEqual({
      name: "say",
      args: ["#x", "hello", "world"],
      argLine: "#x hello   world",
    });
  });

  test("returns null when a prefix is required but absent", () => {
    expect(parseCommandLine("!", "hello", { requirePrefix: true })).toBeNull();
  });

  test("prefixless mode: the prefix is optional", () => {
    expect(parseCommandLine("!", "ping", { requirePrefix: false })?.name).toBe("ping");
    expect(parseCommandLine("!", "!ping", { requirePrefix: false })?.name).toBe("ping");
  });

  test("empty / prefix-only / whitespace yields null", () => {
    expect(parseCommandLine("!", "!", { requirePrefix: true })).toBeNull();
    expect(parseCommandLine("!", "!   ", { requirePrefix: true })).toBeNull();
    expect(parseCommandLine("!", "", { requirePrefix: false })).toBeNull();
    expect(parseCommandLine("!", "   ", { requirePrefix: false })).toBeNull();
  });

  test("no args yields empty args and argLine (trailing whitespace ignored)", () => {
    expect(parseCommandLine("!", "!ping", { requirePrefix: true })).toEqual({ name: "ping", args: [], argLine: "" });
    expect(parseCommandLine("!", "!ping   ", { requirePrefix: true })).toEqual({ name: "ping", args: [], argLine: "" });
  });

  test("multi-character prefixes work", () => {
    expect(parseCommandLine("!!", "!!ping", { requirePrefix: true })?.name).toBe("ping");
    expect(parseCommandLine("!!", "!ping", { requirePrefix: true })).toBeNull();
  });
});
