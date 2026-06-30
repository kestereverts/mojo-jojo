import { describe, expect, test } from "bun:test";
import { MemoryStorage } from "./storage.ts";

describe("MemoryStorage", () => {
  test("get/set/has/delete round-trip", async () => {
    const s = new MemoryStorage();
    expect(await s.get("k")).toBeUndefined();
    expect(await s.has("k")).toBe(false);
    await s.set("k", { a: 1 });
    expect(await s.has("k")).toBe(true);
    expect(await s.get<{ a: number }>("k")).toEqual({ a: 1 });
    await s.delete("k");
    expect(await s.has("k")).toBe(false);
    expect(await s.get("k")).toBeUndefined();
  });

  test("is hard-bounded — evicts the oldest entry past maxEntries", async () => {
    const s = new MemoryStorage(2);
    await s.set("a", 1);
    await s.set("b", 2);
    await s.set("c", 3); // over the bound → "a" (oldest) evicted
    expect(await s.has("a")).toBe(false);
    expect(await s.has("b")).toBe(true);
    expect(await s.has("c")).toBe(true);
    // Updating an existing key is not an insertion — it must not evict.
    await s.set("b", 22);
    expect(await s.has("c")).toBe(true);
    expect(await s.get<number>("b")).toBe(22);
  });

  test("stores by value, not by reference (no aliasing through retained refs)", async () => {
    const s = new MemoryStorage();
    const obj = { count: 1, nested: { v: 1 } };
    await s.set("k", obj);
    obj.count = 99;
    obj.nested.v = 99;
    expect(await s.get<typeof obj>("k")).toEqual({ count: 1, nested: { v: 1 } });

    const got = await s.get<{ count: number }>("k");
    got!.count = 42;
    expect((await s.get<{ count: number }>("k"))!.count).toBe(1);
  });

  test("set rejects (does not throw synchronously) on a non-cloneable value", async () => {
    const s = new MemoryStorage();
    let rejected = false;
    await s.set("fn", () => {}).catch(() => {
      rejected = true;
    });
    expect(rejected).toBe(true);
    expect(await s.has("fn")).toBe(false);
  });
});
