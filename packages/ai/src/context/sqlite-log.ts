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
 * single-writer (one bot process) but the CLI's `history`/`compact` commands
 * may open the same file concurrently with a live bot.
 */
export function openContextDb(path: string): Database {
  const db = new Database(path, { create: true });
  db.run("PRAGMA journal_mode = WAL;");
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
    // regardless of whether compaction is enabled/ever succeeds.
    const { c } = this.#db
      .query("SELECT COUNT(*) as c FROM events WHERE conversation = ?")
      .get(this.#conversation) as { c: number };
    if (c > this.#limit) {
      this.#db.run(
        "DELETE FROM events WHERE id IN (SELECT id FROM events WHERE conversation = ? ORDER BY id ASC LIMIT ?)",
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

  compact(throughIndex: number, event: CompactionEvent): void {
    const rows = this.#db
      .query("SELECT id FROM events WHERE conversation = ? ORDER BY id ASC LIMIT ?")
      .all(this.#conversation, throughIndex + 1) as { id: number }[];
    if (!Number.isInteger(throughIndex) || throughIndex < 0 || rows.length !== throughIndex + 1) {
      throw new RangeError(`compact: throughIndex ${throughIndex} out of range for ${this.#conversation}`);
    }
    const minId = rows[0]!.id;
    const maxId = rows[rows.length - 1]!.id;
    const tx = this.#db.transaction(() => {
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
