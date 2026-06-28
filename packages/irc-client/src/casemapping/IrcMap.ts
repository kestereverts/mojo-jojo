import type { CaseMapper } from "./CaseMapper.ts";

// Case-insensitive collections keyed by IRC nick/channel names.
//
// A plain `Map<string, V>` keyed by the raw name would treat `Nick` and `nick`
// as distinct, which is wrong for IRC. {@link IrcMap} keys entries by the
// {@link CaseMapper}-normalized name while *preserving the display case* of the
// most recent key seen, so lookups are case-insensitive but iteration still
// yields the server's preferred spelling.
//
// When the active casemapping changes (a late ISUPPORT `CASEMAPPING`), call
// {@link IrcMap.rekey} to re-fold every entry under the new mapper.

interface Entry<V> {
  /** Display name (original case) of the most recent key for this entity. */
  key: string;
  value: V;
}

/**
 * A `Map`-like collection keyed case-insensitively by IRC name.
 *
 * Iteration order follows the underlying `Map` (insertion order, except that
 * re-`set`ting an existing key keeps its original slot). Keys exposed by
 * {@link keys}/{@link entries}/iteration are display names, not normalized keys.
 */
export class IrcMap<V> implements Iterable<[string, V]> {
  #mapper: CaseMapper;
  readonly #entries = new Map<string, Entry<V>>();

  constructor(mapper: CaseMapper) {
    this.#mapper = mapper;
  }

  get size(): number {
    return this.#entries.size;
  }

  /** The casemapping currently in force for this collection. */
  get mapper(): CaseMapper {
    return this.#mapper;
  }

  get(name: string): V | undefined {
    return this.#entries.get(this.#mapper.normalize(name))?.value;
  }

  has(name: string): boolean {
    return this.#entries.has(this.#mapper.normalize(name));
  }

  /** Insert or replace `name`'s value, updating the stored display case. */
  set(name: string, value: V): this {
    const normalized = this.#mapper.normalize(name);
    const existing = this.#entries.get(normalized);
    if (existing) {
      existing.key = name;
      existing.value = value;
    } else {
      this.#entries.set(normalized, { key: name, value });
    }
    return this;
  }

  delete(name: string): boolean {
    return this.#entries.delete(this.#mapper.normalize(name));
  }

  clear(): void {
    this.#entries.clear();
  }

  /** Display names, in iteration order. */
  *keys(): IterableIterator<string> {
    for (const entry of this.#entries.values()) yield entry.key;
  }

  *values(): IterableIterator<V> {
    for (const entry of this.#entries.values()) yield entry.value;
  }

  *entries(): IterableIterator<[string, V]> {
    for (const entry of this.#entries.values()) yield [entry.key, entry.value];
  }

  [Symbol.iterator](): IterableIterator<[string, V]> {
    return this.entries();
  }

  forEach(callback: (value: V, key: string, map: IrcMap<V>) => void): void {
    for (const entry of this.#entries.values()) callback(entry.value, entry.key, this);
  }

  /**
   * Re-fold every entry under `mapper`. Call when the server's `CASEMAPPING`
   * changes so subsequent case-insensitive lookups stay correct. If two
   * existing display names collide under the new mapping, the later one wins.
   */
  rekey(mapper: CaseMapper): void {
    const entries = [...this.#entries.values()];
    this.#entries.clear();
    this.#mapper = mapper;
    for (const entry of entries) {
      this.#entries.set(mapper.normalize(entry.key), entry);
    }
  }
}

/**
 * A `Set`-like collection of IRC names, compared case-insensitively. Stores the
 * display case of the most recently added spelling.
 */
export class IrcSet implements Iterable<string> {
  readonly #map: IrcMap<true>;

  constructor(mapper: CaseMapper) {
    this.#map = new IrcMap<true>(mapper);
  }

  get size(): number {
    return this.#map.size;
  }

  add(name: string): this {
    this.#map.set(name, true);
    return this;
  }

  has(name: string): boolean {
    return this.#map.has(name);
  }

  delete(name: string): boolean {
    return this.#map.delete(name);
  }

  clear(): void {
    this.#map.clear();
  }

  [Symbol.iterator](): IterableIterator<string> {
    return this.#map.keys();
  }

  rekey(mapper: CaseMapper): void {
    this.#map.rekey(mapper);
  }
}
