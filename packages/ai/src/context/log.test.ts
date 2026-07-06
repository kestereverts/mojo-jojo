import { describe, expect, test } from "bun:test";
import { InMemoryContextLog } from "./log.ts";
import type { BotReplyEvent, ChatMessageEvent, CompactionEvent } from "./events.ts";

function chatEvent(text: string): ChatMessageEvent {
  return { kind: "chat-message", at: "2026-01-01T00:00:00.000Z", speaker: { nick: "a", trust: "nick" }, text, addressed: true };
}

function replyEvent(text: string): BotReplyEvent {
  return { kind: "bot-reply", at: "2026-01-01T00:00:01.000Z", text };
}

const SUMMARY: CompactionEvent = {
  kind: "compaction",
  at: "2026-01-01T00:00:02.000Z",
  coversUntil: "2026-01-01T00:00:00.500Z",
  summary: "they said hi",
  eventCount: 2,
};

describe("InMemoryContextLog — append + limit", () => {
  test("keeps events in append order", () => {
    const log = new InMemoryContextLog();
    log.append(chatEvent("a"));
    log.append(replyEvent("b"));
    expect(log.events().map((e) => e.kind)).toEqual(["chat-message", "bot-reply"]);
  });

  test("trims the oldest events once past the limit", () => {
    const log = new InMemoryContextLog(2);
    log.append(chatEvent("1"));
    log.append(chatEvent("2"));
    log.append(chatEvent("3"));
    expect(log.events()).toHaveLength(2);
    expect((log.events()[0] as ChatMessageEvent).text).toBe("2");
    expect((log.events()[1] as ChatMessageEvent).text).toBe("3");
  });

  test("rejects a non-positive-integer limit", () => {
    expect(() => new InMemoryContextLog(0)).toThrow(RangeError);
    expect(() => new InMemoryContextLog(-1)).toThrow(RangeError);
    expect(() => new InMemoryContextLog(1.5)).toThrow(RangeError);
  });

  test("the hard trim protects a leading compaction summary — it evicts raw tail events first, not the summary (review finding)", () => {
    const log = new InMemoryContextLog(3);
    log.append(chatEvent("1"));
    log.append(replyEvent("2"));
    log.compact([chatEvent("1"), replyEvent("2")], SUMMARY); // events: [SUMMARY]
    log.append(chatEvent("3"));
    log.append(chatEvent("4"));
    log.append(chatEvent("5")); // over the limit of 3 (SUMMARY + 3 tail events = 4)

    const events = log.events();
    expect(events).toHaveLength(3);
    expect(events[0]).toEqual(SUMMARY); // survives — not evicted
    expect((events[1] as ChatMessageEvent).text).toBe("4"); // "3" was evicted, not the summary
    expect((events[2] as ChatMessageEvent).text).toBe("5");
  });

  test("the protection holds across repeated appends past the limit — the summary is never evicted while any tail event remains", () => {
    const log = new InMemoryContextLog(2);
    log.append(chatEvent("1"));
    log.append(replyEvent("2"));
    log.compact([chatEvent("1"), replyEvent("2")], SUMMARY); // events: [SUMMARY]
    log.append(chatEvent("3")); // [SUMMARY, "3"] — at the limit, no trim yet
    log.append(chatEvent("4")); // over the limit — protects SUMMARY, evicts "3"
    log.append(chatEvent("5")); // over the limit again — protects SUMMARY, evicts "4"
    expect(log.events()).toEqual([SUMMARY, chatEvent("5")]);
  });
});

describe("InMemoryContextLog — compact", () => {
  test("replaces the oldest replacedEvents.length events with the compaction event", () => {
    const log = new InMemoryContextLog();
    log.append(chatEvent("1"));
    log.append(replyEvent("2"));
    log.append(chatEvent("3"));
    log.append(replyEvent("4"));

    log.compact([chatEvent("1"), replyEvent("2")], SUMMARY);

    const events = log.events();
    expect(events).toHaveLength(3);
    expect(events[0]).toEqual(SUMMARY);
    expect((events[1] as ChatMessageEvent).text).toBe("3");
    expect((events[2] as BotReplyEvent).text).toBe("4");
  });

  test("can compact the ENTIRE log, leaving only the summary", () => {
    const log = new InMemoryContextLog();
    log.append(chatEvent("1"));
    log.append(replyEvent("2"));
    log.compact([chatEvent("1"), replyEvent("2")], SUMMARY);
    expect(log.events()).toEqual([SUMMARY]);
  });

  test("a subsequent compact() can replace a prefix that includes a PRIOR compaction event (merging summaries)", () => {
    const log = new InMemoryContextLog();
    log.append(chatEvent("1"));
    log.append(replyEvent("2"));
    log.compact([chatEvent("1"), replyEvent("2")], SUMMARY);
    log.append(chatEvent("3"));
    log.append(replyEvent("4"));

    const merged: CompactionEvent = { ...SUMMARY, summary: "merged summary", eventCount: 4 };
    log.compact([SUMMARY, chatEvent("3")], merged);

    const events = log.events();
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual(merged);
    expect((events[1] as BotReplyEvent).text).toBe("4");
  });

  test("rejects an empty or over-length replacedEvents", () => {
    const log = new InMemoryContextLog();
    log.append(chatEvent("1"));
    expect(() => log.compact([], SUMMARY)).toThrow(RangeError);
    expect(() => log.compact([chatEvent("1"), replyEvent("2")], SUMMARY)).toThrow(RangeError); // only 1 event exists
    expect(() => log.compact([chatEvent("1")], SUMMARY)).not.toThrow();
  });

  test("rejects compacting an empty log", () => {
    const log = new InMemoryContextLog();
    expect(() => log.compact([chatEvent("1")], SUMMARY)).toThrow(RangeError);
  });

  test("rejects a STALE snapshot — the actual prefix no longer matches what was passed (review finding: closes a real data-loss race, not just an index bound)", () => {
    const log = new InMemoryContextLog();
    log.append(chatEvent("1"));
    log.append(replyEvent("2"));
    // Someone else already compacted/changed the log between when a caller
    // snapshotted `events()` and when it calls `compact()` — simulate by
    // passing a DIFFERENT (stale) view of what the prefix supposedly was.
    const staleSnapshot = [chatEvent("1"), replyEvent("A DIFFERENT REPLY")];
    expect(() => log.compact(staleSnapshot, SUMMARY)).toThrow(RangeError);
    // The real log is untouched — nothing was silently deleted.
    expect(log.events()).toEqual([chatEvent("1"), replyEvent("2")]);
  });
});
