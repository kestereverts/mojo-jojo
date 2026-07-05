import { describe, expect, test } from "bun:test";
import { TtlCache } from "./cache.ts";

describe("TtlCache", () => {
  test("returns the stored value before it expires, undefined after", () => {
    const c = new TtlCache<string>();
    c.set("a", "hello", 1000, 0);
    expect(c.get("a", 500)).toBe("hello");
    expect(c.get("a", 999)).toBe("hello");
    expect(c.get("a", 1000)).toBeUndefined(); // expiresAt is exclusive
  });

  test("an unknown key is undefined", () => {
    const c = new TtlCache<string>();
    expect(c.get("missing")).toBeUndefined();
  });

  test("evicts the oldest entry once maxEntries is reached", () => {
    const c = new TtlCache<number>(2);
    c.set("a", 1, 10_000, 0);
    c.set("b", 2, 10_000, 0);
    c.set("c", 3, 10_000, 0); // evicts "a"
    expect(c.get("a", 0)).toBeUndefined();
    expect(c.get("b", 0)).toBe(2);
    expect(c.get("c", 0)).toBe(3);
  });

  test("re-setting an existing key does not evict another entry", () => {
    const c = new TtlCache<number>(2);
    c.set("a", 1, 10_000, 0);
    c.set("b", 2, 10_000, 0);
    c.set("a", 99, 10_000, 0); // update, not a new entry
    expect(c.get("a", 0)).toBe(99);
    expect(c.get("b", 0)).toBe(2);
  });
});
