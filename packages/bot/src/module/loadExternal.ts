import { resolveExternalSpecifier } from "../config/resolveExternal.ts";
import { isModule, type Module } from "./types.ts";
import { errorMessage } from "../util/errors.ts";

interface PickResult {
  module?: Module<unknown>;
  /** A factory we invoked threw — preserved so we can surface the real cause. */
  factoryError?: unknown;
}

/** Resolve one export: invoke it if it's a factory; report a conforming module or a factory error. */
function tryCandidate(value: unknown): PickResult {
  if (typeof value === "function") {
    let product: unknown;
    try {
      product = (value as () => unknown)();
    } catch (factoryError) {
      return { factoryError };
    }
    return isModule(product) ? { module: product } : {};
  }
  return isModule(value) ? { module: value } : {};
}

/** Find a conforming {@link Module} among a namespace's likely export shapes. */
function pickModule(imported: unknown): PickResult {
  let firstFactoryError: unknown;
  const consider = (value: unknown): Module<unknown> | undefined => {
    const result = tryCandidate(value);
    if (result.module) return result.module;
    if (result.factoryError !== undefined && firstFactoryError === undefined) {
      firstFactoryError = result.factoryError;
    }
    return undefined;
  };

  if (imported && typeof imported === "object") {
    const ns = imported as Record<string, unknown>;
    for (const key of ["default", "module", "createModule"]) {
      const module = consider(ns[key]);
      if (module) return { module };
    }
  }
  const module = consider(imported);
  if (module) return { module };
  return { factoryError: firstFactoryError };
}

/**
 * Dynamically import an external module by config specifier.
 *
 * The raw specifier is resolved against `configDir` (a relative path becomes a
 * `file://` URL; a bare package specifier passes through) before `import()`, so
 * relative paths resolve against the config file — not this module. Accepts a
 * `Module` or `ModuleFactory` as the `default`/`module`/`createModule` export (or
 * the namespace itself). Throws on import failure or a non-conforming export.
 *
 * SECURITY: this executes arbitrary code at full process privilege. The config
 * file is a trust boundary equal to the bot's own code.
 */
export async function loadExternalModule(
  specifier: string,
  configDir: string,
): Promise<Module<unknown>> {
  const resolved = resolveExternalSpecifier(specifier, configDir);

  let imported: unknown;
  try {
    imported = await import(resolved);
  } catch (cause) {
    throw new Error(`failed to import external module "${specifier}": ${errorMessage(cause)}`);
  }

  const { module, factoryError } = pickModule(imported);
  if (module) return module;
  if (factoryError !== undefined) {
    throw new Error(`external module "${specifier}" factory threw: ${errorMessage(factoryError)}`);
  }
  throw new Error(
    `external module "${specifier}" does not export a valid Module ` +
      `(need { name: string, setup: function } as default/module/createModule export)`,
  );
}
