import { describe, expect, test } from "bun:test";
import { buildMessage } from "@mojo-jojo/irc-message";
import {
  action,
  away,
  capEnd,
  capLs,
  capReq,
  command,
  invite,
  join,
  kick,
  mode,
  names,
  nick,
  notice,
  part,
  pass,
  ping,
  pong,
  privmsg,
  quit,
  topic,
  user,
  who,
  whois,
} from "./commands.ts";

const line = (m: ReturnType<typeof command>): string => buildMessage(m);

describe("command builders", () => {
  test("command() builds a tagless, sourceless message", () => {
    expect(command("FOO", "a", "b")).toEqual({
      tags: {},
      source: null,
      command: "FOO",
      params: ["a", "b"],
    });
  });

  test("PASS / NICK", () => {
    expect(line(pass("s3cret"))).toBe("PASS s3cret");
    expect(line(nick("mojo"))).toBe("NICK mojo");
  });

  test("USER uses the modern `0 *` form with a trailing real name", () => {
    expect(line(user("mojo", "Mojo Jojo"))).toBe("USER mojo 0 * :Mojo Jojo");
  });

  test("CAP LS requests version 302", () => {
    expect(line(capLs())).toBe("CAP LS 302");
  });

  test("CAP REQ joins caps into a trailing parameter", () => {
    expect(line(capReq(["multi-prefix", "server-time"]))).toBe(
      "CAP REQ :multi-prefix server-time",
    );
  });

  test("CAP END", () => {
    expect(line(capEnd())).toBe("CAP END");
  });

  test("PING / PONG carry the token", () => {
    expect(line(ping("LAG123"))).toBe("PING LAG123");
    expect(line(pong("LAG123"))).toBe("PONG LAG123");
  });

  test("QUIT emits the reason as a trailing parameter", () => {
    expect(line(quit("so long"))).toBe("QUIT :so long");
  });
});

describe("action command builders (M5)", () => {
  test("PRIVMSG / NOTICE put the text in a trailing parameter", () => {
    expect(line(privmsg("#chan", "hi there"))).toBe("PRIVMSG #chan :hi there");
    expect(line(notice("bob", "heads up"))).toBe("NOTICE bob :heads up");
  });

  test("ACTION frames the text as CTCP ACTION", () => {
    expect(line(action("#chan", "waves"))).toBe("PRIVMSG #chan :\x01ACTION waves\x01");
    // The raw params carry the framing (so the dispatcher's parseActionText round-trips).
    expect(action("#chan", "waves").params).toEqual(["#chan", "\x01ACTION waves\x01"]);
  });

  test("JOIN / PART with and without optional args", () => {
    expect(line(join("#chan"))).toBe("JOIN #chan");
    expect(line(join("#chan", "key"))).toBe("JOIN #chan key");
    expect(line(part("#chan"))).toBe("PART #chan");
    // The serializer only frames the trailing param with `:` when it has a space.
    expect(part("#chan", "bye now").params).toEqual(["#chan", "bye now"]);
    expect(line(part("#chan", "bye now"))).toBe("PART #chan :bye now");
  });

  test("KICK with and without a reason", () => {
    expect(line(kick("#chan", "bob"))).toBe("KICK #chan bob");
    expect(line(kick("#chan", "bob", "go away"))).toBe("KICK #chan bob :go away");
  });

  test("MODE queries with no modes, applies modes with params", () => {
    expect(line(mode("#chan"))).toBe("MODE #chan");
    expect(line(mode("#chan", "+o", "bob"))).toBe("MODE #chan +o bob");
    expect(line(mode("#chan", "+k", "secret"))).toBe("MODE #chan +k secret");
  });

  test("TOPIC queries when omitted, sets (and can clear) when given", () => {
    expect(line(topic("#chan"))).toBe("TOPIC #chan");
    expect(line(topic("#chan", "new topic"))).toBe("TOPIC #chan :new topic");
    // An empty string clears the topic (distinct from a query).
    expect(topic("#chan", "").params).toEqual(["#chan", ""]);
  });

  test("INVITE / WHOIS / WHO / NAMES", () => {
    expect(line(invite("bob", "#chan"))).toBe("INVITE bob #chan");
    expect(line(whois("bob"))).toBe("WHOIS bob");
    expect(line(who("#chan"))).toBe("WHO #chan");
    expect(line(names("#chan"))).toBe("NAMES #chan");
  });

  test("AWAY sets with a reason and clears when omitted", () => {
    expect(line(away("be right back"))).toBe("AWAY :be right back");
    expect(line(away())).toBe("AWAY");
  });
});
