import { describe, expect, test } from "bun:test";
import { buildMessage, isValidTagKey } from "./build.ts";
import type { Message } from "./types.ts";

/** Build a Message from partial fields over sensible empty defaults. */
const msg = (m: Partial<Message>): Message => ({
  tags: {},
  source: null,
  command: "PING",
  params: [],
  ...m,
});

describe("buildMessage", () => {
  test("serializes a bare command", () => {
    expect(buildMessage(msg({ command: "PING" }))).toBe("PING");
  });

  test("serializes middle parameters", () => {
    expect(buildMessage(msg({ command: "JOIN", params: ["#a", "#b"] }))).toBe(
      "JOIN #a #b",
    );
  });

  describe("trailing parameter sigil", () => {
    test("added when the last param contains a space", () => {
      expect(
        buildMessage(msg({ command: "PRIVMSG", params: ["#c", "hi there"] })),
      ).toBe("PRIVMSG #c :hi there");
    });

    test("added when the last param is empty", () => {
      expect(buildMessage(msg({ command: "PRIVMSG", params: ["#c", ""] }))).toBe(
        "PRIVMSG #c :",
      );
    });

    test("added when the last param starts with ':'", () => {
      expect(
        buildMessage(msg({ command: "PRIVMSG", params: ["#c", ":-)"] })),
      ).toBe("PRIVMSG #c ::-)");
    });

    test("omitted when the last param needs none", () => {
      expect(
        buildMessage(msg({ command: "PRIVMSG", params: ["#c", "hi"] })),
      ).toBe("PRIVMSG #c hi");
    });
  });

  describe("source", () => {
    test("name, user and host", () => {
      expect(
        buildMessage(
          msg({
            source: { name: "nick", user: "u", host: "h" },
            command: "PRIVMSG",
            params: ["#c", "yo"],
          }),
        ),
      ).toBe(":nick!u@h PRIVMSG #c yo");
    });

    test("name only", () => {
      expect(
        buildMessage(
          msg({
            source: { name: "irc.example.com" },
            command: "001",
            params: ["nick", "Welcome to IRC"],
          }),
        ),
      ).toBe(":irc.example.com 001 nick :Welcome to IRC");
    });
  });

  test("serializes and escapes tags (bare key for empty value)", () => {
    expect(
      buildMessage(msg({ tags: { id: "1 2;3", novalue: "" }, command: "PING" })),
    ).toBe("@id=1\\s2\\:3;novalue PING");
  });

  // A middle param that is empty / contains a space / begins with ':' cannot be
  // represented as a middle param — serializing it verbatim would inject or
  // swallow params on the wire, so buildMessage rejects it (C1).
  describe("rejects structurally-invalid params (C1)", () => {
    test("non-final param containing a space", () => {
      expect(() =>
        buildMessage(msg({ command: "CMD", params: ["a b", "c"] })),
      ).toThrow(/non-final param/);
    });

    test("empty non-final param", () => {
      expect(() =>
        buildMessage(msg({ command: "CMD", params: ["", "c"] })),
      ).toThrow(/non-final param/);
    });

    test("non-final param starting with ':'", () => {
      expect(() =>
        buildMessage(msg({ command: "CMD", params: [":x", "c"] })),
      ).toThrow(/non-final param/);
    });

    test("param containing CR/LF/NUL", () => {
      expect(() =>
        buildMessage(msg({ command: "CMD", params: ["#c", "a\r\nQUIT"] })),
      ).toThrow(/CR, LF, or NUL/);
    });
  });

  // Only tag values are escaped on the wire; a key outside the tag-key grammar
  // would corrupt the tag-list framing, so buildMessage rejects it (C2).
  describe("rejects invalid tag keys (C2)", () => {
    test("key containing ';'", () => {
      expect(() =>
        buildMessage(msg({ tags: { "a;b": "1" }, command: "PING" })),
      ).toThrow(/invalid tag key/);
    });

    test("key containing a space", () => {
      expect(() =>
        buildMessage(msg({ tags: { "a b": "1" }, command: "PING" })),
      ).toThrow(/invalid tag key/);
    });

    test("key containing '='", () => {
      expect(() =>
        buildMessage(msg({ tags: { "a=b": "1" }, command: "PING" })),
      ).toThrow(/invalid tag key/);
    });

    test("accepts a well-formed client/vendor key", () => {
      expect(
        buildMessage(msg({ tags: { "+example.com/foo": "1" }, command: "PING" })),
      ).toBe("@+example.com/foo=1 PING");
    });
  });

  test("rejects an empty or space-bearing command", () => {
    expect(() => buildMessage(msg({ command: "" }))).toThrow(/invalid command/);
    expect(() => buildMessage(msg({ command: "A B" }))).toThrow(/invalid command/);
  });

  // An empty prefix user (`nick!@host`) round-trips: source.user === "" and the
  // builder re-emits the '!' (C8).
  test("round-trips an empty prefix user", () => {
    expect(
      buildMessage(
        msg({ source: { name: "nick", user: "", host: "host" }, command: "CMD" }),
      ),
    ).toBe(":nick!@host CMD");
  });
});

describe("isValidTagKey", () => {
  test("accepts plain, vendor, and client keys", () => {
    expect(isValidTagKey("time")).toBe(true);
    expect(isValidTagKey("example.com/foo")).toBe(true);
    expect(isValidTagKey("+example.com/foo")).toBe(true);
    expect(isValidTagKey("draft-01")).toBe(true);
  });

  test("rejects framing-breaking keys", () => {
    expect(isValidTagKey("a;b")).toBe(false);
    expect(isValidTagKey("a=b")).toBe(false);
    expect(isValidTagKey("a b")).toBe(false);
    expect(isValidTagKey("")).toBe(false);
  });
});
