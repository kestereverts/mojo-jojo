import type { ModuleFactory } from "./types.ts";

/**
 * Name → {@link ModuleFactory} map. Seeded with the built-in modules; external
 * modules register themselves at load time. Duplicate names fail fast.
 */
export class ModuleRegistry {
  readonly #factories = new Map<string, ModuleFactory>();

  constructor(builtins: Readonly<Record<string, ModuleFactory>> = {}) {
    for (const [name, factory] of Object.entries(builtins)) {
      this.#factories.set(name, factory);
    }
  }

  has(name: string): boolean {
    return this.#factories.has(name);
  }

  get(name: string): ModuleFactory | undefined {
    return this.#factories.get(name);
  }

  /** Register a factory under `name`; throws on a duplicate (fail-fast). */
  register(name: string, factory: ModuleFactory): void {
    if (this.#factories.has(name)) {
      throw new Error(`ModuleRegistry: duplicate module name "${name}"`);
    }
    this.#factories.set(name, factory);
  }

  names(): readonly string[] {
    return [...this.#factories.keys()];
  }
}
