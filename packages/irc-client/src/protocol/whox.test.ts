import { describe, expect, test } from "bun:test";
import { buildMessage, parseMessage } from "@mojo-jojo/irc-message";
import { parseWhoxReply, WHOX_FIELDS, WHOX_TOKEN, whoxQuery } from "./whox.ts";

describe("WHOX", () => {
  test("whoxQuery builds a WHO with the fixed field spec + reserved token", () => {
    expect(buildMessage(whoxQuery("#chan"))).toBe(`WHO #chan %${WHOX_FIELDS},${WHOX_TOKEN}`);
    expect(WHOX_FIELDS).toBe("tcuhnfar");
    expect(WHOX_TOKEN).toMatch(/^\d{1,3}$/); // spec: digits only, <= 3 chars
  });

  test("parseWhoxReply parses our fixed 354 layout", () => {
    const m = parseMessage(
      `:irc 354 me ${WHOX_TOKEN} #chan ident host.name alice H@ acctName :Real Name`,
    );
    expect(parseWhoxReply(m)).toEqual({
      channel: "#chan",
      user: "ident",
      host: "host.name",
      nick: "alice",
      flags: "H@",
      account: "acctName",
      realName: "Real Name",
    });
  });

  test("parseWhoxReply ignores a 354 carrying a different token (unknown layout)", () => {
    const m = parseMessage(":irc 354 me 5 #chan ident host alice H acct :Real");
    expect(parseWhoxReply(m)).toBeNull();
  });
});
