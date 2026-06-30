/**
 * Per-module key/value storage seam. v1 ships an in-memory implementation; the
 * interface is fixed now so persistence-needing modules (`seen`/`tell`/`karma`…)
 * don't each invent their own file I/O. Values are treated as data (structured-clone
 * semantics), so a stored value can't be mutated through a retained reference.
 *
 * `undefined` is NOT a storable value — `get` returns `undefined` for both an absent
 * key and a key stored as `undefined`; persistence backends will diverge here, so use
 * `has()` to test presence and avoid storing `undefined`.
 */
export interface ModuleStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  has(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
}

const DEFAULT_MAX_ENTRIES = 10_000;

/**
 * In-memory {@link ModuleStorage}; one instance per module (namespace = isolation).
 * Hard-bounded at `maxEntries` (oldest-inserted evicted) so a module keying by
 * untrusted input (per-nick `seen`/`tell`/…) can't grow it without bound. A module
 * needing more should manage its own capacity.
 */
export class MemoryStorage implements ModuleStorage {
  readonly #map = new Map<string, unknown>();
  readonly #maxEntries: number;

  constructor(maxEntries = DEFAULT_MAX_ENTRIES) {
    this.#maxEntries = Math.max(1, maxEntries);
  }

  // `get`/`set` are `async` so a `structuredClone` throw on a non-cloneable value
  // surfaces as a rejected promise (matching the async contract), not a sync throw.
  async get<T = unknown>(key: string): Promise<T | undefined> {
    const value = this.#map.get(key);
    return value === undefined ? undefined : (structuredClone(value) as T);
  }

  async set(key: string, value: unknown): Promise<void> {
    const cloned = structuredClone(value);
    if (!this.#map.has(key) && this.#map.size >= this.#maxEntries) {
      const oldest = this.#map.keys().next().value;
      if (oldest !== undefined) this.#map.delete(oldest);
    }
    this.#map.set(key, cloned);
  }

  async has(key: string): Promise<boolean> {
    return this.#map.has(key);
  }

  async delete(key: string): Promise<void> {
    this.#map.delete(key);
  }
}
