import { describe, expect, test } from "bun:test";
import { Cooldowns, type Clock } from "./cooldown.ts";

function fakeClock(): Clock & { set(t: number): void } {
  let t = 0;
  return { now: () => t, set: (v) => (t = v) };
}

describe("Cooldowns", () => {
  test("arms on first check, blocks until expiry, then allows again", () => {
    const clock = fakeClock();
    const cd = new Cooldowns(clock);
    expect(cd.check("a", 100)).toBe(true); // armed until t=100
    expect(cd.check("a", 100)).toBe(false); // still cooling
    clock.set(99);
    expect(cd.check("a", 100)).toBe(false);
    clock.set(100);
    expect(cd.check("a", 100)).toBe(true); // expired (now >= until)
  });

  test("keys are independent", () => {
    const cd = new Cooldowns(fakeClock());
    expect(cd.check("a", 100)).toBe(true);
    expect(cd.check("b", 100)).toBe(true);
  });

  test("clear() resets a key or everything", () => {
    const cd = new Cooldowns(fakeClock());
    cd.check("a", 1000);
    cd.clear("a");
    expect(cd.check("a", 1000)).toBe(true);
    cd.clear();
    expect(cd.check("a", 1000)).toBe(true);
  });

  test("prunes expired entries when the table hits its bound", () => {
    const clock = fakeClock();
    const cd = new Cooldowns(clock, 2); // tiny cap to force pruning
    cd.check("a", 10);
    cd.check("b", 10);
    clock.set(20); // both expired
    // Adding a third with the cap reached triggers a prune of the two expired keys.
    expect(cd.check("c", 10)).toBe(true);
    // a/b were expired anyway, so they remain allowable.
    expect(cd.check("a", 10)).toBe(true);
  });

  test("enforces a hard bound by evicting the oldest when all entries are active", () => {
    const cd = new Cooldowns(fakeClock(), 2); // frozen clock — nothing expires
    expect(cd.check("a", 1000)).toBe(true);
    expect(cd.check("b", 1000)).toBe(true);
    expect(cd.check("c", 1000)).toBe(true); // cap reached, all active -> evict oldest (a)
    expect(cd.check("a", 1000)).toBe(true); // a was evicted, so it is allowed again
    expect(cd.check("c", 1000)).toBe(false); // c is still cooling (not evicted)
  });

  test("re-checking an existing cooling key does not count against the bound", () => {
    const cd = new Cooldowns(fakeClock(), 1);
    expect(cd.check("a", 1000)).toBe(true);
    expect(cd.check("a", 1000)).toBe(false); // still cooling, no eviction churn
    expect(cd.check("a", 1000)).toBe(false);
  });
});
