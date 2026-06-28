import { describe, expect, test } from "bun:test";
import { parseMessage } from "./parse.ts";
import { buildMessage } from "./build.ts";

// Lines whose IR is normalization-stable, so build(parse(line)) === line.
const stable = [
  "PING",
  "JOIN #chan",
  "PRIVMSG #chan :hello world",
  "PRIVMSG #chan :",
  ":nick!user@host PRIVMSG #chan :hey there",
  ":irc.example.com 001 nick :Welcome to IRC",
  "@id=123;+ex.com/foo=a\\sb;novalue :nick!user@host PRIVMSG #chan :hello world",
];

describe("build ∘ parse is identity for normalization-stable lines", () => {
  for (const line of stable) {
    test(JSON.stringify(line), () => {
      expect(buildMessage(parseMessage(line))).toBe(line);
    });
  }
});

describe("known normalization (intentionally not byte-identical)", () => {
  test("an unnecessary trailing ':' is dropped", () => {
    expect(buildMessage(parseMessage("PRIVMSG #c :foo"))).toBe("PRIVMSG #c foo");
  });

  test("an empty tag value collapses to a bare key", () => {
    expect(buildMessage(parseMessage("@k= PING"))).toBe("@k PING");
  });
});
