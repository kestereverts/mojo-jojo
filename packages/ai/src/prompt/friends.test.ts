import { describe, expect, test } from "bun:test";
import type { Friend } from "../identity/speakers.ts";
import { buildKnownUsersSection } from "./friends.ts";

const alice: Friend = { id: "alice", name: "Alice Example", aliases: ["alice", "alice_"], accounts: ["alice"] };

describe("buildKnownUsersSection", () => {
  test("returns null for an empty friends list — no section, not an empty one", () => {
    expect(buildKnownUsersSection([])).toBeNull();
  });

  test("renders aliases, name, city, and notes when present", () => {
    const withFacts: Friend = { ...alice, city: "Amsterdam", notes: "Prefers being called Al." };
    const section = buildKnownUsersSection([withFacts]);
    expect(section?.id).toBe("known-users");
    expect(section?.body).toContain("You know alice, alice_ as Alice Example.");
    expect(section?.body).toContain("Lives in Amsterdam.");
    expect(section?.body).toContain("Prefers being called Al.");
  });

  test("omits city/notes lines when absent, without stray formatting", () => {
    const section = buildKnownUsersSection([alice]);
    expect(section?.body).toContain("You know alice, alice_ as Alice Example.");
    expect(section?.body).not.toContain("Lives in");
    expect(section?.body).not.toContain("undefined");
  });

  test("falls back to the name when a friend has no aliases", () => {
    const noAliases: Friend = { id: "bob", name: "Bob", aliases: [], accounts: [] };
    const section = buildKnownUsersSection([noAliases]);
    expect(section?.body).toContain("You know Bob as Bob.");
  });

  test("renders multiple friends, one line each", () => {
    const bob: Friend = { id: "bob", name: "Bob", aliases: ["bob"], accounts: [] };
    const section = buildKnownUsersSection([alice, bob]);
    expect(section?.body).toContain("Alice Example");
    expect(section?.body).toContain("as Bob.");
  });
});
