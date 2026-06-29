/**
 * Per-module key/value storage seam. v1 ships an in-memory implementation; the
 * interface is fixed now so persistence-needing modules (`seen`/`tell`/`karma`…)
 * don't each invent their own file I/O. Values are treated as data (structured-clone
 * semantics), so a stored value can't be mutated through a retained reference.
 */
export interface ModuleStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  has(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
}

/** In-memory {@link ModuleStorage}; one instance per module (namespace = isolation). */
export class MemoryStorage implements ModuleStorage {
  readonly #map = new Map<string, unknown>();

  // `get`/`set` are `async` so a `structuredClone` throw on a non-cloneable value
  // surfaces as a rejected promise (matching the async contract), not a sync throw.
  async get<T = unknown>(key: string): Promise<T | undefined> {
    const value = this.#map.get(key);
    return value === undefined ? undefined : (structuredClone(value) as T);
  }

  async set(key: string, value: unknown): Promise<void> {
    this.#map.set(key, structuredClone(value));
  }

  async has(key: string): Promise<boolean> {
    return this.#map.has(key);
  }

  async delete(key: string): Promise<void> {
    this.#map.delete(key);
  }
}
