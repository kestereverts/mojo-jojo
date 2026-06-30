import { describe, expect, test } from "bun:test";
import { config } from "rxjs";
import { BotEventHub, type BotEvent } from "./botEvents.ts";

/**
 * Run `fn` with RxJS's async unhandled-error report swallowed (for deliberate subscriber
 * throws). RxJS reports on a deferred macrotask, so we flush one tick before restoring.
 */
async function withSwallowedRxErrors(fn: () => void): Promise<void> {
  const previous = config.onUnhandledError;
  config.onUnhandledError = () => {};
  try {
    fn();
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    config.onUnhandledError = previous;
  }
}

describe("BotEventHub", () => {
  test("emit reaches events$ subscribers", () => {
    const hub = new BotEventHub();
    const seen: BotEvent[] = [];
    hub.events$.subscribe((e) => seen.push(e));
    hub.emit({ type: "started" });
    expect(seen).toEqual([{ type: "started" }]);
  });

  test("on() filters by type; the returned unsubscribe stops delivery", () => {
    const hub = new BotEventHub();
    const names: string[] = [];
    const off = hub.on("moduleLoaded", (e) => names.push(e.name));
    hub.emit({ type: "moduleLoaded", name: "a" });
    hub.emit({ type: "started" }); // wrong type — ignored
    off();
    hub.emit({ type: "moduleLoaded", name: "b" }); // after unsubscribe
    expect(names).toEqual(["a"]);
  });

  test("once() fires at most once", () => {
    const hub = new BotEventHub();
    let count = 0;
    hub.once("started", () => count++);
    hub.emit({ type: "started" });
    hub.emit({ type: "started" });
    expect(count).toBe(1);
  });

  test("off(type, handler) removes a listener (including a not-yet-fired once)", () => {
    const hub = new BotEventHub();
    let n = 0;
    const h = (): void => {
      n++;
    };
    hub.on("started", h);
    hub.off("started", h);
    hub.emit({ type: "started" });

    let m = 0;
    const h2 = (): void => {
      m++;
    };
    hub.once("started", h2);
    hub.off("started", h2);
    hub.emit({ type: "started" });

    expect([n, m]).toEqual([0, 0]);
  });

  test("the same handler on two types is tracked independently", () => {
    const hub = new BotEventHub();
    let calls = 0;
    const h = (): void => {
      calls++;
    };
    hub.on("started", h);
    hub.on("stopped", h);
    hub.off("started", h);
    hub.emit({ type: "started" }); // removed
    hub.emit({ type: "stopped", reason: "x" }); // still attached
    expect(calls).toBe(1);
  });

  test("complete() ends events$ and detaches façade listeners", () => {
    const hub = new BotEventHub();
    let completed = false;
    let n = 0;
    hub.events$.subscribe({ complete: () => (completed = true) });
    hub.on("started", () => n++);
    hub.complete();
    hub.emit({ type: "started" }); // no-op after completion
    expect(completed).toBe(true);
    expect(n).toBe(0);
  });

  test("isolates a throwing listener, reports it, and still delivers to others", () => {
    const errors: unknown[] = [];
    const hub = new BotEventHub((e) => errors.push(e));
    const seen: string[] = [];
    hub.on("started", () => {
      throw new Error("boom");
    });
    hub.on("started", () => seen.push("ok"));
    expect(() => hub.emit({ type: "started" })).not.toThrow();
    expect(seen).toEqual(["ok"]);
    expect(errors).toHaveLength(1);
  });

  test("emit() never throws and keeps delivering to other subscribers when one throws", async () => {
    await withSwallowedRxErrors(() => {
      const hub = new BotEventHub();
      const seen: string[] = [];
      hub.events$.subscribe(() => {
        throw new Error("subscriber boom");
      });
      hub.events$.subscribe((e) => seen.push(e.type));
      expect(() => hub.emit({ type: "started" })).not.toThrow();
      expect(seen).toEqual(["started"]); // RxJS isolates the throw; the next subscriber still receives it
    });
  });

  test("on() after complete() is an inert no-op", () => {
    const hub = new BotEventHub();
    hub.complete();
    let n = 0;
    const off = hub.on("started", () => n++);
    hub.emit({ type: "started" });
    expect(n).toBe(0);
    expect(() => off()).not.toThrow();
  });
});
