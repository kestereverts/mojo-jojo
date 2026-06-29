import { describe, expect, test } from "bun:test";
import { CaseMapper } from "@mojo-jojo/irc-client";
import { matchesAny, matchesIdentity } from "./match.ts";
import { fakePrivmsg } from "../testing/fakeEvents.ts";

const cm = new CaseMapper("rfc1459");

describe("matchesIdentity", () => {
  test("account: matches the message tag (preferred) or the entity account", () => {
    expect(matchesIdentity(fakePrivmsg({ messageAccount: "kester" }), "account:kester", cm)).toBe(true);
    expect(matchesIdentity(fakePrivmsg({ account: "kester" }), "account:kester", cm)).toBe(true);
    expect(matchesIdentity(fakePrivmsg({}), "account:kester", cm)).toBe(false);
    expect(matchesIdentity(fakePrivmsg({ messageAccount: "other" }), "account:kester", cm)).toBe(false);
  });

  test("account: with an empty name never matches (logged-out users have no account)", () => {
    expect(matchesIdentity(fakePrivmsg({ messageAccount: "" }), "account:", cm)).toBe(false);
  });

  test("mask: glob-matches nick!user@host, case-insensitively", () => {
    const e = fakePrivmsg({ nick: "Alice", username: "ali", host: "host.example.com" });
    expect(matchesIdentity(e, "mask:*!*@host.example.com", cm)).toBe(true);
    expect(matchesIdentity(e, "mask:alice!*@*", cm)).toBe(true);
    expect(matchesIdentity(e, "mask:Ali?e!*@*", cm)).toBe(true); // ? = one char
    expect(matchesIdentity(e, "mask:bob!*@*", cm)).toBe(false);
    expect(matchesIdentity(e, "mask:*!*@*.evil.net", cm)).toBe(false);
  });

  test("mask: fails closed when username/host is unknown (no wildcard match)", () => {
    expect(matchesIdentity(fakePrivmsg({ nick: "x", username: null, host: "h" }), "mask:*!*@*", cm)).toBe(false);
    expect(matchesIdentity(fakePrivmsg({ nick: "x", username: "u", host: null }), "mask:*!*@*", cm)).toBe(false);
  });

  test("bare nick matches case-insensitively under the casemapping", () => {
    expect(matchesIdentity(fakePrivmsg({ nick: "Alice" }), "alice", cm)).toBe(true);
    expect(matchesIdentity(fakePrivmsg({ nick: "a[b]" }), "a{b}", cm)).toBe(true); // rfc1459 folds []->{}
    expect(matchesIdentity(fakePrivmsg({ nick: "Bob" }), "alice", cm)).toBe(false);
  });

  test("bare nick falls back to ASCII comparison when caseMapper is null", () => {
    expect(matchesIdentity(fakePrivmsg({ nick: "Alice" }), "ALICE", null)).toBe(true);
    expect(matchesIdentity(fakePrivmsg({ nick: "a[b]" }), "a{b}", null)).toBe(false); // ASCII never folds []
  });
});

describe("matchesAny", () => {
  test("true if any pattern matches; empty list is always false", () => {
    const e = fakePrivmsg({ messageAccount: "kester" });
    expect(matchesAny(e, ["account:other", "account:kester"], cm)).toBe(true);
    expect(matchesAny(e, ["account:other"], cm)).toBe(false);
    expect(matchesAny(e, [], cm)).toBe(false);
  });
});
