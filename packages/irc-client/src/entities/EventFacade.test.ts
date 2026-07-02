import { describe, expect, test } from "bun:test";
import { EMPTY, of, Subject } from "rxjs";
import { EventFacade } from "./EventFacade.ts";

interface Ping {
  readonly type: "ping";
  readonly n: number;
}

describe("EventFacade", () => {
  test("on/once/off over a live source behave like an emitter", () => {
    const subject = new Subject<Ping>();
    const facade = new EventFacade<Ping>(subject);

    const seen: number[] = [];
    const unsub = facade.on("ping", (e) => seen.push(e.n));
    subject.next({ type: "ping", n: 1 });
    unsub();
    subject.next({ type: "ping", n: 2 });
    expect(seen).toEqual([1]);

    const onceSeen: number[] = [];
    facade.once("ping", (e) => onceSeen.push(e.n));
    subject.next({ type: "ping", n: 3 });
    subject.next({ type: "ping", n: 4 });
    expect(onceSeen).toEqual([3]);

    const offSeen: number[] = [];
    const handler = (e: Ping): void => void offSeen.push(e.n);
    facade.on("ping", handler);
    facade.off("ping", handler);
    subject.next({ type: "ping", n: 5 });
    expect(offSeen).toEqual([]);
  });

  test("on() over an already-completed source delivers nothing and tracks nothing", () => {
    const facade = new EventFacade<Ping>(EMPTY);
    const seen: number[] = [];
    const unsub = facade.on("ping", (e) => seen.push(e.n));
    expect(seen).toEqual([]);
    // The returned unsubscribe and a bulk dispose must both be safe no-ops.
    expect(() => unsub()).not.toThrow();
    expect(() => facade.disposeListeners()).not.toThrow();
  });

  test("on() over a synchronous source delivers then retains nothing to remove", () => {
    const facade = new EventFacade<Ping>(of({ type: "ping", n: 7 }));
    const seen: number[] = [];
    const unsub = facade.on("ping", (e) => seen.push(e.n));
    expect(seen).toEqual([7]);
    // disposeListeners must not re-affect the (already finished) handler.
    facade.disposeListeners();
    expect(() => unsub()).not.toThrow();
    expect(seen).toEqual([7]);
  });

  test("once() over a synchronous source fires once with no dangling listener", () => {
    const facade = new EventFacade<Ping>(of<Ping[]>({ type: "ping", n: 1 }, { type: "ping", n: 2 }));
    const seen: number[] = [];
    const unsub = facade.once("ping", (e) => seen.push(e.n));
    expect(seen).toEqual([1]); // take(1)
    expect(() => unsub()).not.toThrow();
    expect(() => facade.disposeListeners()).not.toThrow();
  });

  test("a throwing listener is routed to onListenerError, not re-raised (B6)", () => {
    const subject = new Subject<Ping>();
    const errors: unknown[] = [];
    const facade = new EventFacade<Ping>(subject, (e) => errors.push(e));

    facade.on("ping", () => {
      throw new Error("boom-on");
    });
    const seen: number[] = [];
    facade.on("ping", (e) => seen.push(e.n)); // a sibling that must still fire

    // Without the guard the throw becomes an RxJS async uncaughtException.
    expect(() => subject.next({ type: "ping", n: 1 })).not.toThrow();
    expect(seen).toEqual([1]); // sibling still ran despite the sibling throw
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("boom-on");

    // once() is guarded too.
    facade.once("ping", () => {
      throw new Error("boom-once");
    });
    expect(() => subject.next({ type: "ping", n: 2 })).not.toThrow();
    expect((errors.at(-1) as Error).message).toBe("boom-once");
  });
});
