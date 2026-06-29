import { describe, expect, test } from "bun:test";
import { loadExternalModule } from "./loadExternal.ts";

const DIR = import.meta.dir;

/** Await a promise expected to reject, asserting the message matches `re`. */
async function rejectsWith(p: Promise<unknown>, re: RegExp): Promise<void> {
  try {
    await p;
  } catch (err) {
    expect(err instanceof Error ? err.message : String(err)).toMatch(re);
    return;
  }
  throw new Error("expected promise to reject");
}

describe("loadExternalModule", () => {
  test("loads a default-exported module", async () => {
    const mod = await loadExternalModule("./fixtures/validModule.ts", DIR);
    expect(mod.name).toBe("valid-ext");
    expect(typeof mod.setup).toBe("function");
  });

  test("loads a default-exported factory (invokes it)", async () => {
    const mod = await loadExternalModule("./fixtures/factoryModule.ts", DIR);
    expect(mod.name).toBe("factory-ext");
  });

  test("loads a named `module` export", async () => {
    const mod = await loadExternalModule("./fixtures/namedModule.ts", DIR);
    expect(mod.name).toBe("named-ext");
  });

  test("rejects a non-conforming export", async () => {
    await rejectsWith(loadExternalModule("./fixtures/notAModule.ts", DIR), /does not export a valid Module/);
  });

  test("rejects an unresolvable specifier", async () => {
    await rejectsWith(loadExternalModule("./fixtures/missing.ts", DIR), /failed to import/);
  });

  test("surfaces a factory's own error rather than a generic conformance message", async () => {
    await rejectsWith(loadExternalModule("./fixtures/throwingFactory.ts", DIR), /factory threw: factory kaboom/);
  });
});
