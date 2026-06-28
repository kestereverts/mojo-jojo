import { describe, expect, test } from "bun:test";
import { Observable } from "rxjs";
import { TestScheduler } from "rxjs/testing";
import { backoffDelay, retryWithBackoff, type ReconnectPolicy } from "./reconnect.ts";

const policy = (overrides: Partial<ReconnectPolicy> = {}): ReconnectPolicy => ({
  enabled: true,
  initialDelayMs: 100,
  maxDelayMs: 1000,
  factor: 2,
  jitter: false,
  maxRetries: Infinity,
  ...overrides,
});

describe("backoffDelay", () => {
  test("grows geometrically and clamps to maxDelayMs", () => {
    const p = policy();
    expect(backoffDelay(1, p)).toBe(100);
    expect(backoffDelay(2, p)).toBe(200);
    expect(backoffDelay(3, p)).toBe(400);
    expect(backoffDelay(4, p)).toBe(800);
    expect(backoffDelay(5, p)).toBe(1000); // 1600 clamped to 1000
    expect(backoffDelay(99, p)).toBe(1000);
  });

  test("equal jitter keeps the delay in [base/2, base)", () => {
    const p = policy({ jitter: true });
    expect(backoffDelay(2, p, () => 0)).toBe(100); // base 200 -> half = 100
    expect(backoffDelay(2, p, () => 0.5)).toBe(150); // 100 + 0.5*100
    expect(backoffDelay(2, p, () => 0.999)).toBeCloseTo(199.9, 1);
  });
});

/** A source that errors `failures` times before emitting `"ok"` and completing. */
function flakySource(failures: number, onSubscribe: () => void): Observable<string> {
  let attempts = 0;
  return new Observable<string>((subscriber) => {
    onSubscribe();
    attempts += 1;
    if (attempts <= failures) {
      subscriber.error(new Error(`fail ${attempts}`));
      return;
    }
    subscriber.next("ok");
    subscriber.complete();
  });
}

describe("retryWithBackoff", () => {
  test("retries with backoff and eventually succeeds", () => {
    const scheduler = new TestScheduler(() => undefined);
    scheduler.run(({ flush }) => {
      let subscribes = 0;
      const seen: string[] = [];
      flakySource(2, () => (subscribes += 1))
        .pipe(retryWithBackoff(policy({ initialDelayMs: 10 }), { scheduler }))
        .subscribe({ next: (v) => seen.push(v) });
      flush();
      expect(subscribes).toBe(3); // initial + 2 retries
      expect(seen).toEqual(["ok"]);
    });
  });

  test("gives up after maxRetries and propagates the error", () => {
    const scheduler = new TestScheduler(() => undefined);
    scheduler.run(({ flush }) => {
      let subscribes = 0;
      let error: unknown;
      flakySource(99, () => (subscribes += 1))
        .pipe(retryWithBackoff(policy({ initialDelayMs: 10, maxRetries: 2 }), { scheduler }))
        .subscribe({ error: (e: unknown) => (error = e) });
      flush();
      expect(subscribes).toBe(3); // initial + 2 retries, then give up
      expect(error).toBeInstanceOf(Error);
    });
  });

  test("a disabled policy does not retry", () => {
    const scheduler = new TestScheduler(() => undefined);
    scheduler.run(({ flush }) => {
      let subscribes = 0;
      let error: unknown;
      flakySource(99, () => (subscribes += 1))
        .pipe(retryWithBackoff(policy({ enabled: false }), { scheduler }))
        .subscribe({ error: (e: unknown) => (error = e) });
      flush();
      expect(subscribes).toBe(1);
      expect(error).toBeInstanceOf(Error);
    });
  });

  test("onRetry reports the attempt number and delay before each wait", () => {
    const scheduler = new TestScheduler(() => undefined);
    scheduler.run(({ flush }) => {
      const retries: Array<{ attempt: number; delayMs: number }> = [];
      flakySource(2, () => undefined)
        .pipe(
          retryWithBackoff(policy({ initialDelayMs: 10 }), {
            scheduler,
            onRetry: (attempt, delayMs) => retries.push({ attempt, delayMs }),
          }),
        )
        .subscribe({ next: () => undefined });
      flush();
      expect(retries).toEqual([
        { attempt: 1, delayMs: 10 },
        { attempt: 2, delayMs: 20 },
      ]);
    });
  });
});
