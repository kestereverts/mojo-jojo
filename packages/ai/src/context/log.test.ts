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
});

describe("InMemoryContextLog — compact", () => {
  test("replaces every event up to and including throughIndex with the compaction event", () => {
    const log = new InMemoryContextLog();
    log.append(chatEvent("1"));
    log.append(replyEvent("2"));
    log.append(chatEvent("3"));
    log.append(replyEvent("4"));

    log.compact(1, SUMMARY); // replace events[0..1] ("1","2")

    const events = log.events();
    expect(events).toHaveLength(3);
    expect(events[0]).toEqual(SUMMARY);
    expect((events[1] as ChatMessageEvent).text).toBe("3");
    expect((events[2] as BotReplyEvent).text).toBe("4");
  });

  test("can compact the ENTIRE log (throughIndex = last index), leaving only the summary", () => {
    const log = new InMemoryContextLog();
    log.append(chatEvent("1"));
    log.append(replyEvent("2"));
    log.compact(1, SUMMARY);
    expect(log.events()).toEqual([SUMMARY]);
  });

  test("a subsequent compact() can replace a prefix that includes a PRIOR compaction event (merging summaries)", () => {
    const log = new InMemoryContextLog();
    log.append(chatEvent("1"));
    log.append(replyEvent("2"));
    log.compact(1, SUMMARY);
    log.append(chatEvent("3"));
    log.append(replyEvent("4"));

    const merged: CompactionEvent = { ...SUMMARY, summary: "merged summary", eventCount: 4 };
    log.compact(1, merged); // replace [SUMMARY, "3"] with the merged summary

    const events = log.events();
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual(merged);
    expect((events[1] as BotReplyEvent).text).toBe("4");
  });

  test("rejects an out-of-range throughIndex", () => {
    const log = new InMemoryContextLog();
    log.append(chatEvent("1"));
    expect(() => log.compact(-1, SUMMARY)).toThrow(RangeError);
    expect(() => log.compact(1, SUMMARY)).toThrow(RangeError); // only index 0 exists
    expect(() => log.compact(0, SUMMARY)).not.toThrow();
  });

  test("rejects compacting an empty log", () => {
    const log = new InMemoryContextLog();
    expect(() => log.compact(0, SUMMARY)).toThrow(RangeError);
  });
});
