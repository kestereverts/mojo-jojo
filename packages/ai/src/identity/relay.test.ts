import { describe, expect, test } from "bun:test";
import { ConfigError, Validator } from "@mojo-jojo/bot";
import type { ChatMessage } from "./middleware.ts";
import { createRelayMiddleware, parseRelays, stripIrcFormatting } from "./relay.ts";

function parse(raw: unknown, path = "modules.mojo-ai.relays") {
  const v = new Validator();
  const relays = parseRelays(v, raw, path);
  v.throwIfAny();
  return relays;
}

function msg(nick: string, text: string): ChatMessage {
  return {
    raw: { user: { nick } } as never,
    speaker: { nick },
    text,
    channel: "#chan",
    at: "2026-01-01T00:00:00.000Z",
  };
}

describe("stripIrcFormatting", () => {
  test("removes bold, reset, italic, underline, reverse, monospace, strikethrough", () => {
    expect(stripIrcFormatting("\x02bold\x0F \x1Ditalic\x0F \x1Funder\x0F \x16rev\x0F \x11mono\x0F \x1Estrike\x0F")).toBe(
      "bold italic under rev mono strike",
    );
  });

  test("removes mIRC color codes with optional fg,bg digits", () => {
    expect(stripIrcFormatting("\x0304red\x03 and \x0312,08fg-bg\x0F plain")).toBe("red and fg-bg plain");
  });

  test("removes IRCv3-draft hex color codes", () => {
    expect(stripIrcFormatting("\x04FF0000red\x0F and \x04FF0000,00FF00fgbg\x0F")).toBe("red and fgbg");
  });

  test("leaves plain text untouched", () => {
    expect(stripIrcFormatting("<alice> hello there")).toBe("<alice> hello there");
  });
});

describe("parseRelays", () => {
  test("parses a valid array of relay tables", () => {
    const relays = parse([
      { nick: "Telegram", pattern: "^(?<author>.+?): (?<text>.*)$" },
      { nick: "Discord", pattern: "^<(?<author>.+?)> (?<text>.*)$" },
    ]);
    expect(relays).toHaveLength(2);
    expect(relays[0]?.nick).toBe("Telegram");
    expect(relays[0]?.pattern.test("alice: hi")).toBe(true);
  });

  test("undefined -> no relays configured, no error", () => {
    expect(parse(undefined)).toEqual([]);
  });

  test("rejects a non-array value", () => {
    expect(() => parse({ nick: "x" })).toThrow(ConfigError);
  });

  test("rejects a pattern missing the author or text named group", () => {
    expect(() => parse([{ nick: "x", pattern: "^(?<text>.*)$" }])).toThrow(/author/);
    expect(() => parse([{ nick: "x", pattern: "^(?<author>.*)$" }])).toThrow(/text/);
  });

  test("rejects an invalid regex, with the index in the error path", () => {
    try {
      parse([{ nick: "ok", pattern: "^(?<author>.*)(?<text>.*)$" }, { nick: "bad", pattern: "(?<author>[(?<text>" }]);
      throw new Error("expected throw");
    } catch (cause) {
      expect(cause).toBeInstanceOf(ConfigError);
      expect((cause as ConfigError).issues.join()).toContain("modules.mojo-ai.relays[1].pattern");
    }
  });

  test("rejects a non-table entry and a missing nick/pattern", () => {
    expect(() => parse(["not-a-table"])).toThrow(ConfigError);
    expect(() => parse([{ pattern: "^(?<author>.+)(?<text>.*)$" }])).toThrow(/nick/);
    expect(() => parse([{ nick: "x" }])).toThrow(/pattern/);
  });
});

describe("createRelayMiddleware", () => {
  const relays = parse([
    { nick: "Telegram", pattern: "^(?<author>.+?): (?<text>.*)$" },
    { nick: "Discord", pattern: "^<(?<author>.+?)> (?<text>.*)$" },
  ]);
  const noMapper = () => null;

  test("no relays configured -> pass-through (fast path, no allocation)", () => {
    const mw = createRelayMiddleware([], noMapper);
    const m = msg("anyone", "hello");
    expect(mw(m)).toBe(m);
  });

  test("unwraps a Telegram-style relay line", () => {
    const mw = createRelayMiddleware(relays, noMapper);
    const result = mw(msg("Telegram", "alice: hello there"));
    expect(result?.speaker.author).toBe("alice");
    expect(result?.speaker.via).toBe("Telegram");
    expect(result?.text).toBe("hello there");
  });

  test("unwraps a Discord-style relay line with mIRC color codes around the author", () => {
    const mw = createRelayMiddleware(relays, noMapper);
    const result = mw(msg("Discord", "<\x0304bob\x0F> hi from discord"));
    expect(result?.speaker.author).toBe("bob");
    expect(result?.speaker.via).toBe("Discord");
    expect(result?.text).toBe("hi from discord");
  });

  test("a non-relay sender passes through unchanged", () => {
    const mw = createRelayMiddleware(relays, noMapper);
    const m = msg("regular-user", "alice: hello there");
    expect(mw(m)).toBe(m);
  });

  test("a relay sender whose line doesn't match the pattern falls through unchanged (safe degrade)", () => {
    const mw = createRelayMiddleware(relays, noMapper);
    const m = msg("Telegram", "*** joined the channel ***");
    expect(mw(m)).toBe(m);
  });

  test("nick matching is casemapping-aware when a mapper is supplied", () => {
    const mw = createRelayMiddleware(relays, () => ({ equals: (a: string, b: string) => a.toLowerCase() === b.toLowerCase() }) as never);
    const result = mw(msg("TELEGRAM", "alice: hi"));
    expect(result?.speaker.via).toBe("Telegram");
  });
});
