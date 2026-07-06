import { afterAll, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlink } from "node:fs/promises";
import { openContextDb, SqliteContextLog } from "./sqlite-log.ts";
import type { BotReplyEvent, ChatMessageEvent, CompactionEvent } from "./events.ts";

function chat(text: string, at = "2026-01-01T00:00:00.000Z"): ChatMessageEvent {
  return { kind: "chat-message", at, speaker: { nick: "a", trust: "nick" }, text, addressed: true };
}

function reply(text: string, at = "2026-01-01T00:00:01.000Z"): BotReplyEvent {
  return { kind: "bot-reply", at, text };
}

const SUMMARY: CompactionEvent = {
  kind: "compaction",
  at: "2026-01-01T00:00:02.000Z",
  coversUntil: "2026-01-01T00:00:00.500Z",
  summary: "they said hi",
  eventCount: 2,
};

const tmpPaths: string[] = [];
function tmpDbPath(): string {
  const path = join(tmpdir(), `mojo-ai-sqlite-log-test-${tmpPaths.length}-${Date.now()}.sqlite`);
  tmpPaths.push(path);
  return path;
}
afterAll(async () => {
  await Promise.all(tmpPaths.flatMap((p) => [p, `${p}-wal`, `${p}-shm`].map((f) => unlink(f).catch(() => {}))));
});

describe("openContextDb", () => {
  test("creates the schema idempotently — opening the same path twice doesn't throw", () => {
    const path = tmpDbPath();
    openContextDb(path).close();
    expect(() => openContextDb(path).close()).not.toThrow();
  });
});

describe("SqliteContextLog — append/events round-trip", () => {
  test("preserves full event shape and append order", () => {
    const db = openContextDb(":memory:");
    const log = new SqliteContextLog(db, "#test");
    log.append(chat("hi"));
    log.append(reply("hello"));
    const events = log.events();
    expect(events).toEqual([chat("hi"), reply("hello")]);
  });

  test("isolates events by conversation on the SAME shared Database", () => {
    const db = openContextDb(":memory:");
    const a = new SqliteContextLog(db, "#a");
    const b = new SqliteContextLog(db, "#b");
    a.append(chat("in a"));
    b.append(chat("in b"));
    expect(a.events()).toEqual([chat("in a")]);
    expect(b.events()).toEqual([chat("in b")]);
  });

  test("the hard limit trims the oldest rows on append, per conversation", () => {
    const db = openContextDb(":memory:");
    const log = new SqliteContextLog(db, "#test", 2);
    log.append(chat("1"));
    log.append(chat("2"));
    log.append(chat("3"));
    const events = log.events();
    expect(events).toHaveLength(2);
    expect((events[0] as ChatMessageEvent).text).toBe("2");
    expect((events[1] as ChatMessageEvent).text).toBe("3");
  });

  test("the hard limit protects a leading compaction summary — it evicts raw tail rows first, not the summary (review finding)", () => {
    const db = openContextDb(":memory:");
    const log = new SqliteContextLog(db, "#test", 3);
    log.append(chat("1"));
    log.append(reply("2"));
    log.compact(1, SUMMARY);
    log.append(chat("3"));
    log.append(chat("4"));
    log.append(chat("5"));

    const events = log.events();
    expect(events).toHaveLength(3);
    expect(events[0]).toEqual(SUMMARY);
    expect((events[1] as ChatMessageEvent).text).toBe("4");
    expect((events[2] as ChatMessageEvent).text).toBe("5");
  });

  test("rejects a non-positive-integer limit", () => {
    const db = openContextDb(":memory:");
    expect(() => new SqliteContextLog(db, "#test", 0)).toThrow(RangeError);
    expect(() => new SqliteContextLog(db, "#test", -1)).toThrow(RangeError);
  });
});

describe("SqliteContextLog — compact", () => {
  test("replaces every event up to and including throughIndex with the compaction event", () => {
    const db = openContextDb(":memory:");
    const log = new SqliteContextLog(db, "#test");
    log.append(chat("1"));
    log.append(reply("2"));
    log.append(chat("3"));
    log.append(reply("4"));

    log.compact(1, SUMMARY);

    const events = log.events();
    expect(events).toHaveLength(3);
    expect(events[0]).toEqual(SUMMARY);
    expect((events[1] as ChatMessageEvent).text).toBe("3");
    expect((events[2] as BotReplyEvent).text).toBe("4");
  });

  test("a subsequent compact() can merge a prior compaction event", () => {
    const db = openContextDb(":memory:");
    const log = new SqliteContextLog(db, "#test");
    log.append(chat("1"));
    log.append(reply("2"));
    log.compact(1, SUMMARY);
    log.append(chat("3"));
    log.append(reply("4"));

    const merged: CompactionEvent = { ...SUMMARY, summary: "merged", eventCount: 4 };
    log.compact(1, merged);

    const events = log.events();
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual(merged);
    expect((events[1] as BotReplyEvent).text).toBe("4");
  });

  test("only touches the conversation it's called on — a different conversation's rows survive untouched", () => {
    const db = openContextDb(":memory:");
    const a = new SqliteContextLog(db, "#a");
    const b = new SqliteContextLog(db, "#b");
    a.append(chat("a1"));
    a.append(reply("a2"));
    b.append(chat("b1"));
    b.append(reply("b2"));

    a.compact(1, SUMMARY);

    expect(a.events()).toEqual([SUMMARY]);
    expect(b.events()).toEqual([chat("b1"), reply("b2")]);
  });

  test("rejects an out-of-range throughIndex", () => {
    const db = openContextDb(":memory:");
    const log = new SqliteContextLog(db, "#test");
    log.append(chat("1"));
    expect(() => log.compact(-1, SUMMARY)).toThrow(RangeError);
    expect(() => log.compact(1, SUMMARY)).toThrow(RangeError); // only index 0 exists
    expect(() => log.compact(0, SUMMARY)).not.toThrow();
  });

  test("rejects compacting an empty conversation", () => {
    const db = openContextDb(":memory:");
    const log = new SqliteContextLog(db, "#test");
    expect(() => log.compact(0, SUMMARY)).toThrow(RangeError);
  });
});

describe("SqliteContextLog — cross-instance persistence (the actual 'restart retains memory' guarantee)", () => {
  test("events written via one Database instance are readable after closing and reopening the SAME file path", async () => {
    const path = tmpDbPath();

    const db1 = openContextDb(path);
    const log1 = new SqliteContextLog(db1, "#persist-test");
    log1.append(chat("before restart"));
    log1.append(reply("still here"));
    db1.close();

    // A fresh Database + SqliteContextLog against the same file — simulates a process restart.
    const db2 = openContextDb(path);
    const log2 = new SqliteContextLog(db2, "#persist-test");
    expect(log2.events()).toEqual([chat("before restart"), reply("still here")]);
    db2.close();
  });
});
