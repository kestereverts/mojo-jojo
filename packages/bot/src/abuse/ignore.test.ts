import { describe, expect, test } from "bun:test";
import { CaseMapper } from "@mojo-jojo/irc-client";
import { IgnoreList } from "./ignore.ts";
import { fakePrivmsg } from "../testing/fakeEvents.ts";

const cm = new CaseMapper("rfc1459");

describe("IgnoreList", () => {
  test("matches any configured pattern", () => {
    const list = new IgnoreList(["mask:*!*@spam.host", "account:bad"]);
    expect(list.size).toBe(2);
    expect(list.has(fakePrivmsg({ username: "u", host: "spam.host" }), cm)).toBe(true);
    expect(list.has(fakePrivmsg({ messageAccount: "bad" }), cm)).toBe(true);
    expect(list.has(fakePrivmsg({ username: "u", host: "ok.host" }), cm)).toBe(false);
  });

  test("an empty list never matches (fast path)", () => {
    expect(new IgnoreList([]).has(fakePrivmsg({ nick: "anyone" }), cm)).toBe(false);
    expect(new IgnoreList().has(fakePrivmsg(), cm)).toBe(false);
  });
});
