import { describe, expect, test } from "bun:test";
import { buildMessage } from "@mojo-jojo/irc-message";
import {
  capEnd,
  capLs,
  capReq,
  command,
  nick,
  pass,
  ping,
  pong,
  quit,
  user,
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
