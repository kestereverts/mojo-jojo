import { Database } from "bun:sqlite";
import type { CompactionEvent, ContextEvent } from "./events.ts";
import type { ContextLog } from "./log.ts";

/**
 * Opens (creating if needed) the module's conversation-memory database and
 * ensures its schema exists — call ONCE at module setup, then construct one
 * {@link SqliteContextLog} per conversation against the SAME `Database`
 * instance (mirrors `mojo-ai.ts`'s existing `logFor(key)` per-conversation
 * cache, just backed by rows instead of an in-memory array). WAL mode trades
 * a little disk space for readers not blocking the writer — this module is
 * effectively single-writer-per-conversation (the live bot's own `exhaustMap`
 * guarantees that), but the CLI's `history`/`compact` commands may open the
 * same file concurrently with a live bot for OPERATIONAL/debugging use.
 * `busy_timeout` makes that supported scenario wait out a brief lock instead
 * of throwing `SQLITE_BUSY` immediately (review finding: without it, a live
 * bot's own `append` could throw on a transient lock from a concurrent CLI
 * write, which — absent from a `catchError` in the outer pipe — would
 * otherwise kill the bot's entire message-processing pipeline).
 */
export function openContextDb(path: string): Database {
  const db = new Database(path, { create: true });
  db.run("PRAGMA journal_mode = WAL;");
  db.run("PRAGMA busy_timeout = 5000;");
  db.run(
    "CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, conversation TEXT NOT NULL, at TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL)",
  );
  db.run("CREATE INDEX IF NOT EXISTS idx_events_conversation ON events (conversation, id)");
  return db;
}

/**
 * SQLite-backed {@link ContextLog} — one instance per conversation, all
 * sharing one `Database` (see {@link openContextDb}). The whole event is
 * stored as JSON in `payload` (never reconstructed from separate columns) —
 * `conversation`/`kind`/`at` are indexed/queryable columns for convenience
 * and future tooling, not a second source of truth that could drift from
 * what's actually replayed.
 */
export class SqliteContextLog implements ContextLog {
  readonly #db: Database;
  readonly #conversation: string;
  readonly #limit: number;

  constructor(db: Database, conversation: string, limit = 200) {
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new RangeError(`log limit must be a positive integer, got ${limit}`);
    }
    this.#db = db;
    this.#conversation = conversation;
    this.#limit = limit;
  }

  append(event: ContextEvent): void {
    this.#db.run("INSERT INTO events (conversation, at, kind, payload) VALUES (?, ?, ?, ?)", [
      this.#conversation,
      event.at,
      event.kind,
      JSON.stringify(event),
    ]);
    // Hard backstop, mirroring InMemoryContextLog's on-append trim — kicks in
    // regardless of whether compaction is enabled/ever succeeds. Excludes a
    // leading compaction summary from eviction: it represents everything
    // already folded in, so deleting IT (always the smallest id) before raw
    // tail events would destroy compressed history before uncompressed
    // history — backwards from what a hard backstop should protect first
    // (review finding).
    const { c } = this.#db
      .query("SELECT COUNT(*) as c FROM events WHERE conversation = ?")
      .get(this.#conversation) as { c: number };
    if (c > this.#limit) {
      this.#db.run(
        `DELETE FROM events WHERE id IN (
           SELECT id FROM events WHERE conversation = ? AND kind != 'compaction' ORDER BY id ASC LIMIT ?
         )`,
        [this.#conversation, c - this.#limit],
      );
    }
  }

  events(): readonly ContextEvent[] {
    const rows = this.#db
      .query("SELECT payload FROM events WHERE conversation = ? ORDER BY id ASC")
      .all(this.#conversation) as { payload: string }[];
    return rows.map((row) => JSON.parse(row.payload) as ContextEvent);
  }

  /**
   * The read (which rows the compaction covers), the drift check, and the
   * write (delete + insert) all run INSIDE the same transaction. Review
   * finding (Cody, reproduced directly): a plain event-count was NOT
   * sufficient to make concurrent compaction rounds for the SAME
   * conversation safe — two independently-computed compactions (e.g. the
   * live bot and an operator's `compact --force`, or two summarizer rounds
   * racing) could each pass a count that looked "valid" against whatever the
   * log currently held, silently deleting rows that didn't actually
   * correspond to what either one's summary text covered. Verifying the
   * EXACT payloads (not just the count) inside the transaction closes this:
   * if the oldest `replacedEvents.length` rows have changed at all since the
   * caller snapshotted them, this throws instead of committing a summary
   * that doesn't match what's actually being replaced — `maybeCompact`'s
   * existing fail-open `catch` turns that into "skip this round," never
   * silent data loss. `busy_timeout` (`openContextDb`) means a genuinely
   * concurrent writer usually waits for this transaction rather than
   * interleaving with it at all.
   */
  compact(replacedEvents: readonly ContextEvent[], event: CompactionEvent): void {
    if (replacedEvents.length === 0) {
      throw new RangeError(`compact: replacedEvents must be non-empty for ${this.#conversation}`);
    }
    const tx = this.#db.transaction(() => {
      const rows = this.#db
        .query("SELECT id, payload FROM events WHERE conversation = ? ORDER BY id ASC LIMIT ?")
        .all(this.#conversation, replacedEvents.length) as { id: number; payload: string }[];
      if (rows.length !== replacedEvents.length) {
        throw new RangeError(`compact: replacedEvents length ${replacedEvents.length} out of range for ${this.#conversation}`);
      }
      const expected = replacedEvents.map((e) => JSON.stringify(e));
      const actual = rows.map((r) => r.payload);
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new RangeError(
          `compact: the log for ${this.#conversation} has changed since these events were snapshotted — refusing to compact a stale prefix`,
        );
      }
      const minId = rows[0]!.id;
      const maxId = rows[rows.length - 1]!.id;
      this.#db.run("DELETE FROM events WHERE conversation = ? AND id <= ?", [this.#conversation, maxId]);
      // Explicitly reuse the deleted range's SMALLEST id (now free) instead of
      // letting AUTOINCREMENT assign a fresh one — a fresh id would always be
      // LARGER than every surviving row, so `ORDER BY id ASC` would sort the
      // new summary LAST instead of where it belongs: before the kept tail.
      this.#db.run("INSERT INTO events (id, conversation, at, kind, payload) VALUES (?, ?, ?, ?, ?)", [
        minId,
        this.#conversation,
        event.at,
        event.kind,
        JSON.stringify(event),
      ]);
    });
    tx();
  }
}
