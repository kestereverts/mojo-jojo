import { describe, expect, test } from "bun:test";
import { buildMessage } from "./build.ts";
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
});
