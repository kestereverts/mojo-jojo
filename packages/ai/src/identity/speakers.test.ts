import { afterAll, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlink } from "node:fs/promises";
import type { Friend } from "./speakers.ts";
import { loadFriendsFile, resolveSpeaker } from "./speakers.ts";

const alice: Friend = {
  id: "alice",
  name: "Alice Example",
  aliases: ["alice", "alice_", "AliceTG"],
  accounts: ["alice"],
  city: "Amsterdam",
};

describe("resolveSpeaker — trust tiers", () => {
  test("account present -> trust 'account', beating any alias match", () => {
    const speaker = resolveSpeaker({ nick: "alice", account: "alice" }, [alice]);
    expect(speaker.trust).toBe("account");
    expect(speaker.personId).toBe("alice");
  });

  test("author present (relay-unwrapped), no account -> trust 'relay'", () => {
    const speaker = resolveSpeaker({ nick: "Telegram", author: "AliceTG", via: "Telegram" }, [alice]);
    expect(speaker.trust).toBe("relay");
    expect(speaker.personId).toBe("alice");
    expect(speaker.author).toBe("AliceTG");
    expect(speaker.via).toBe("Telegram");
  });

  test("direct IRC, unregistered -> trust 'nick'", () => {
    const speaker = resolveSpeaker({ nick: "alice_" }, [alice]);
    expect(speaker.trust).toBe("nick");
    expect(speaker.personId).toBe("alice");
  });

  test("no friend match -> personId absent, trust still computed", () => {
    const speaker = resolveSpeaker({ nick: "stranger" }, [alice]);
    expect(speaker.personId).toBeUndefined();
    expect(speaker.trust).toBe("nick");
  });

  test("account matching is exact-string (services accounts are case-sensitive per network)", () => {
    const wrongCase = resolveSpeaker({ nick: "x", account: "ALICE" }, [alice]);
    expect(wrongCase.personId).toBeUndefined();
    expect(wrongCase.trust).toBe("account"); // still trust=account: a real (if unmatched) account tag was present
    const exact = resolveSpeaker({ nick: "x", account: "alice" }, [alice]);
    expect(exact.personId).toBe("alice");
  });

  test("'*' (logged-out account tag) normalizes to no account — falls back to nick trust", () => {
    const loggedOut = resolveSpeaker({ nick: "alice", account: "*" }, [alice]);
    expect(loggedOut.account).toBeUndefined();
    expect(loggedOut.trust).toBe("nick");
    expect(loggedOut.personId).toBe("alice"); // still matched by nick alias
  });

  test("alias matching prefers the relay-unwrapped author over the shared relay-bot nick", () => {
    // The relay bot's own nick ("Telegram") must NOT match Alice's aliases,
    // only the unwrapped author name should.
    const notAlice = resolveSpeaker({ nick: "Telegram", author: "someone-else", via: "Telegram" }, [alice]);
    expect(notAlice.personId).toBeUndefined();
    const isAlice = resolveSpeaker({ nick: "Telegram", author: "alicetg", via: "Telegram" }, [alice]);
    expect(isAlice.personId).toBe("alice"); // case-insensitive alias match
  });

  test("empty friends list never matches, still resolves trust", () => {
    const speaker = resolveSpeaker({ nick: "alice", account: "alice" }, []);
    expect(speaker.personId).toBeUndefined();
    expect(speaker.trust).toBe("account");
  });
});

const tmpFiles: string[] = [];
async function tmpFile(body: string): Promise<string> {
  const path = join(tmpdir(), `mojo-ai-friends-${tmpFiles.length}-${Date.now()}.toml`);
  await Bun.write(path, body);
  tmpFiles.push(path);
  return path;
}
afterAll(async () => {
  await Promise.all(tmpFiles.map((p) => unlink(p).catch(() => {})));
});

describe("loadFriendsFile", () => {
  test("missing file -> empty friends + a warning, never throws", async () => {
    const result = await loadFriendsFile("/no/such/friends.toml");
    expect(result.friends).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("not found");
  });

  test("invalid TOML -> empty friends + a warning, never throws", async () => {
    const path = await tmpFile("this is = = not toml [[[");
    const result = await loadFriendsFile(path);
    expect(result.friends).toEqual([]);
    expect(result.warnings[0]).toContain("invalid TOML");
  });

  test("parses valid [[person]] entries with all fields", async () => {
    const path = await tmpFile(`
[[person]]
id = "alice"
name = "Alice Example"
aliases = ["alice", "alice_", "AliceTG"]
accounts = ["alice"]
city = "Amsterdam"
notes = "some facts"
`);
    const result = await loadFriendsFile(path);
    expect(result.warnings).toEqual([]);
    expect(result.friends).toEqual([
      {
        id: "alice",
        name: "Alice Example",
        aliases: ["alice", "alice_", "AliceTG"],
        accounts: ["alice"],
        city: "Amsterdam",
        notes: "some facts",
      },
    ]);
  });

  test("aliases/accounts/city/notes are all optional", async () => {
    const path = await tmpFile('[[person]]\nid = "bob"\nname = "Bob"\n');
    const result = await loadFriendsFile(path);
    expect(result.warnings).toEqual([]);
    expect(result.friends).toEqual([{ id: "bob", name: "Bob", aliases: [], accounts: [] }]);
  });

  test("no [[person]] array at all -> empty friends, no warning (an empty/minimal file is valid)", async () => {
    const path = await tmpFile("# just a comment\n");
    const result = await loadFriendsFile(path);
    expect(result).toEqual({ friends: [], warnings: [] });
  });

  test("a malformed entry is skipped with a warning; other entries still load", async () => {
    const path = await tmpFile(`
[[person]]
id = "alice"
name = "Alice"

[[person]]
name = "missing id"

[[person]]
id = "bob"
name = "Bob"
`);
    const result = await loadFriendsFile(path);
    expect(result.friends.map((f) => f.id)).toEqual(["alice", "bob"]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("person[1]");
  });

  test("a duplicate id is skipped with a warning, keeping the first", async () => {
    const path = await tmpFile(`
[[person]]
id = "alice"
name = "Alice One"

[[person]]
id = "alice"
name = "Alice Two"
`);
    const result = await loadFriendsFile(path);
    expect(result.friends).toHaveLength(1);
    expect(result.friends[0]?.name).toBe("Alice One");
    expect(result.warnings[0]).toContain("duplicate id");
  });

  test("__proto__/constructor/prototype keys are stripped (same trust boundary as loadConfig)", async () => {
    const path = await tmpFile(`
[[person]]
id = "alice"
name = "Alice"
__proto__ = { polluted = true }
`);
    const result = await loadFriendsFile(path);
    expect(result.friends).toHaveLength(1);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  test("a non-array 'person' value is rejected with a clear warning", async () => {
    const path = await tmpFile('person = "not-an-array"\n');
    const result = await loadFriendsFile(path);
    expect(result.friends).toEqual([]);
    expect(result.warnings[0]).toContain("must be an array of tables");
  });
});
