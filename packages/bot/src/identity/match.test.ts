import { describe, expect, test } from "bun:test";
import { CaseMapper } from "@mojo-jojo/irc-client";
import { isSecureMatcher, matchesAny, matchesIdentity, senderKey } from "./match.ts";
import { fakePrivmsg } from "../testing/fakeEvents.ts";

const cm = new CaseMapper("rfc1459");

describe("matchesIdentity", () => {
  test("account: matches the message tag ONLY — never a cached/stale entity account", () => {
    // Present, matching tag → match.
    expect(matchesIdentity(fakePrivmsg({ messageAccount: "kester" }), "account:kester", cm)).toBe(true);
    // No message tag → NO match, even if the cached entity account would match (security:
    // a stale cache must never authorize a logged-out sender).
    expect(matchesIdentity(fakePrivmsg({ account: "kester" }), "account:kester", cm)).toBe(false);
    expect(matchesIdentity(fakePrivmsg({}), "account:kester", cm)).toBe(false);
    expect(matchesIdentity(fakePrivmsg({ messageAccount: "other" }), "account:kester", cm)).toBe(false);
  });

  test("account: with an empty name never matches (logged-out users have no account)", () => {
    expect(matchesIdentity(fakePrivmsg({ messageAccount: "" }), "account:", cm)).toBe(false);
  });

  test("account: matches case-insensitively (services accounts are case-preserving)", () => {
    expect(matchesIdentity(fakePrivmsg({ messageAccount: "bob" }), "account:Bob", cm)).toBe(true);
  });

  test("account: a logged-out '*' tag never matches, regardless of the cache", () => {
    expect(matchesIdentity(fakePrivmsg({ messageAccount: "*", account: "boss" }), "account:boss", cm)).toBe(false);
  });

  test("nick: is the explicit nick form; isSecureMatcher flags insecure owners", () => {
    expect(matchesIdentity(fakePrivmsg({ nick: "Bob" }), "nick:bob", cm)).toBe(true);
    expect(isSecureMatcher("account:x")).toBe(true);
    expect(isSecureMatcher("mask:*!*@*")).toBe(true);
    expect(isSecureMatcher("nick:bob")).toBe(false);
    expect(isSecureMatcher("bob")).toBe(false);
  });

  test("mask: the nick part folds under the server casemapping", () => {
    const e = fakePrivmsg({ nick: "a[b]", username: "u", host: "h" });
    expect(matchesIdentity(e, "mask:a{b}!*@*", cm)).toBe(true); // rfc1459 folds [ -> {
    expect(matchesIdentity(e, "mask:a{b}!*@*", new CaseMapper("ascii"))).toBe(false); // ascii does not
  });

  test("mask: a NO-bang mask also folds the nick under casemapping (M1)", () => {
    const e = fakePrivmsg({ nick: "evil[]", username: "u", host: "h" });
    // `evil{}` is the same identity as `evil[]` under rfc1459 — a no-bang mask
    // must match it, or an ignore/owner mask could be evaded by switching nicks.
    expect(matchesIdentity(e, "mask:evil{}*", cm)).toBe(true);
    expect(matchesIdentity(e, "mask:evil{}*", new CaseMapper("ascii"))).toBe(false);
  });

  test("account: a divergent message tag wins over a stale cache", () => {
    expect(matchesIdentity(fakePrivmsg({ messageAccount: "alice", account: "bob" }), "account:bob", cm)).toBe(false);
    expect(matchesIdentity(fakePrivmsg({ messageAccount: "alice", account: "bob" }), "account:alice", cm)).toBe(true);
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

describe("senderKey", () => {
  test("prefers the account when authenticated", () => {
    expect(senderKey(fakePrivmsg({ messageAccount: "Boss", username: "u", host: "h" }), cm)).toBe("account:boss");
  });

  test("falls back to user@host — stable across nick changes and host case", () => {
    const a = senderKey(fakePrivmsg({ nick: "alice", username: "id", host: "Host.NET" }), cm);
    const b = senderKey(fakePrivmsg({ nick: "alice2", username: "id", host: "host.net" }), cm);
    expect(a).toBe("host:id@host.net");
    expect(a).toBe(b);
  });

  test("uses the casemapped nick when user/host are unknown", () => {
    expect(senderKey(fakePrivmsg({ nick: "Alice" }), cm)).toBe("nick:alice");
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
