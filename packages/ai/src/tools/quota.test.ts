import { describe, expect, test } from "bun:test";
import { DailyQuota } from "./quota.ts";

describe("DailyQuota", () => {
  test("allows up to the limit, then rejects, all within the same day", () => {
    const q = new DailyQuota(3);
    const day = new Date("2026-01-01T10:00:00.000Z");
    expect(q.tryConsume(day)).toBe(true);
    expect(q.tryConsume(day)).toBe(true);
    expect(q.tryConsume(day)).toBe(true);
    expect(q.tryConsume(day)).toBe(false);
    expect(q.remaining(day)).toBe(0);
  });

  test("resets when the day (UTC) rolls over", () => {
    const q = new DailyQuota(1);
    const day1 = new Date("2026-01-01T23:59:00.000Z");
    const day2 = new Date("2026-01-02T00:01:00.000Z");
    expect(q.tryConsume(day1)).toBe(true);
    expect(q.tryConsume(day1)).toBe(false);
    expect(q.tryConsume(day2)).toBe(true); // fresh day, fresh quota
  });

  test("remaining() reflects unconsumed calls on a fresh day without mutating state", () => {
    const q = new DailyQuota(5);
    const day = new Date("2026-01-01T00:00:00.000Z");
    expect(q.remaining(day)).toBe(5);
    q.tryConsume(day);
    expect(q.remaining(day)).toBe(4);
  });

  test("rejects a non-positive or non-integer limit", () => {
    expect(() => new DailyQuota(0)).toThrow(RangeError);
    expect(() => new DailyQuota(-1)).toThrow(RangeError);
    expect(() => new DailyQuota(1.5)).toThrow(RangeError);
  });
});
