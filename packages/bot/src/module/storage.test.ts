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
