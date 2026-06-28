import { describe, expect, test } from "bun:test";
import { parseMessage } from "./parse.ts";

describe("parseMessage", () => {
  test("parses a bare command", () => {
    expect(parseMessage("PING")).toEqual({
      tags: {},
      source: null,
      command: "PING",
      params: [],
    });
  });

  test("parses middle parameters", () => {
    expect(parseMessage("JOIN #chan #chan2")).toEqual({
      tags: {},
      source: null,
      command: "JOIN",
      params: ["#chan", "#chan2"],
    });
  });

  test("parses a trailing parameter containing spaces", () => {
    expect(parseMessage("PRIVMSG #chan :hello world")).toEqual({
      tags: {},
      source: null,
      command: "PRIVMSG",
      params: ["#chan", "hello world"],
    });
  });

  test("parses an empty trailing parameter", () => {
    expect(parseMessage("PRIVMSG #chan :")).toEqual({
      tags: {},
      source: null,
      command: "PRIVMSG",
      params: ["#chan", ""],
    });
  });

  describe("source", () => {
    test("server name only", () => {
      expect(parseMessage(":irc.example.com 001 nick :hi").source).toEqual({
        name: "irc.example.com",
      });
    });

    test("nick!user@host", () => {
      expect(parseMessage(":nick!user@host PRIVMSG #c :hi").source).toEqual({
        name: "nick",
        user: "user",
        host: "host",
      });
    });

    test("nick@host without a user", () => {
      expect(parseMessage(":nick@host PRIVMSG #c :hi").source).toEqual({
        name: "nick",
        host: "host",
      });
    });
  });

  describe("tags", () => {
    test("key=value and value-less keys", () => {
      expect(parseMessage("@id=123;novalue PING").tags).toEqual({
        id: "123",
        novalue: "",
      });
    });

    test("an empty value normalizes to ''", () => {
      expect(parseMessage("@key= PING").tags).toEqual({ key: "" });
    });

    test("a client-only tag keeps its leading +", () => {
      expect(parseMessage("@+example.com/foo=bar PING").tags).toEqual({
        "+example.com/foo": "bar",
      });
    });

    test("unescapes the reserved characters", () => {
      // wire: \: -> ;   \s -> space   \\ -> \   \r -> CR   \n -> LF
      expect(parseMessage("@k=a\\:b\\sc\\\\d\\r\\n PING").tags).toEqual({
        k: "a;b c\\d\r\n",
      });
    });

    test("duplicate keys resolve last-wins", () => {
      expect(parseMessage("@k=1;k=2 PING").tags).toEqual({ k: "2" });
    });
  });

  test("parses the full sample line", () => {
    const msg = parseMessage(
      "@id=123;+ex.com/foo=a\\sb;novalue :nick!user@host PRIVMSG #chan :hello world",
    );
    expect(msg).toEqual({
      tags: { id: "123", "+ex.com/foo": "a b", novalue: "" },
      source: { name: "nick", user: "user", host: "host" },
      command: "PRIVMSG",
      params: ["#chan", "hello world"],
    });
  });

  test("accepts a Uint8Array and decodes UTF-8 byte spans", () => {
    const bytes = new TextEncoder().encode("PRIVMSG #café :héllo wörld");
    expect(parseMessage(bytes)).toEqual({
      tags: {},
      source: null,
      command: "PRIVMSG",
      params: ["#café", "héllo wörld"],
    });
  });
});
