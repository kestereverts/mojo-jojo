import { describe, expect, test } from "bun:test";
import { RateLimiter } from "./rateLimiter.ts";

describe("RateLimiter", () => {
  test("allows a burst up to capacity, then denies; keys are independent", () => {
    let now = 0;
    const rl = new RateLimiter({ capacity: 3, refillMs: 1000, clock: { now: () => now } });
    expect(rl.tryConsume("a")).toBe(true);
    expect(rl.tryConsume("a")).toBe(true);
    expect(rl.tryConsume("a")).toBe(true);
    expect(rl.tryConsume("a")).toBe(false); // burst exhausted
    expect(rl.tryConsume("b")).toBe(true); // a different sender is unaffected
  });

  test("refills one token per refillMs", () => {
    let now = 0;
    const rl = new RateLimiter({ capacity: 1, refillMs: 1000, clock: { now: () => now } });
    expect(rl.tryConsume("a")).toBe(true);
    expect(rl.tryConsume("a")).toBe(false);
    now = 999;
    expect(rl.tryConsume("a")).toBe(false); // not yet a full token
    now = 1000;
    expect(rl.tryConsume("a")).toBe(true); // refilled
    expect(rl.tryConsume("a")).toBe(false);
  });

  test("does not lose the sub-period remainder on refill (evenly-paced senders admitted)", () => {
    let now = 0;
    const rl = new RateLimiter({ capacity: 1, refillMs: 1000, clock: { now: () => now } });
    expect(rl.tryConsume("a")).toBe(true); // t=0: tokens 1→0, updated=0
    now = 1500;
    expect(rl.tryConsume("a")).toBe(true); // refill 1 → allowed; updated advances to 1000, not 1500
    now = 2000;
    // Two full periods have elapsed since t=0. The dropped 500ms remainder used
    // to deny this; with the remainder kept, floor((2000-1000)/1000)=1 → allowed.
    expect(rl.tryConsume("a")).toBe(true);
  });

  test("bounds the key table by evicting the oldest", () => {
    let now = 0;
    const rl = new RateLimiter({ capacity: 1, refillMs: 1000, clock: { now: () => now }, maxKeys: 2 });
    expect(rl.tryConsume("k1")).toBe(true);
    expect(rl.tryConsume("k2")).toBe(true);
    expect(rl.tryConsume("k3")).toBe(true); // over maxKeys → evicts the oldest bucket
    // k1 was evicted, so it starts fresh again (rather than the table growing unbounded).
    expect(rl.tryConsume("k1")).toBe(true);
  });

  test("reclaims fully-refilled idle keys on prune (logical refill, not stored tokens)", () => {
    let now = 0;
    const rl = new RateLimiter({ capacity: 1, refillMs: 100, clock: { now: () => now }, maxKeys: 2 });
    rl.tryConsume("k1"); // tokens → 0
    rl.tryConsume("k2"); // tokens → 0; table full
    now = 1000; // both k1 and k2 are now logically fully refilled (idle)
    expect(rl.tryConsume("k3")).toBe(true); // prune reclaims the idle keys, k3 admitted
    expect(rl.tryConsume("k1")).toBe(true); // reclaimed → fresh burst available again
  });
});
