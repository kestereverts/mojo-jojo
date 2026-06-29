import { describe, expect, test } from "bun:test";
import { ModuleRegistry } from "./registry.ts";
import type { ModuleFactory } from "./types.ts";

const factory =
  (name: string): ModuleFactory =>
  () => ({ name, setup() {} });

describe("ModuleRegistry", () => {
  test("seeds built-ins and exposes has/get/names", () => {
    const r = new ModuleRegistry({ a: factory("a") });
    expect(r.has("a")).toBe(true);
    expect(r.get("a")).toBeDefined();
    expect(r.has("b")).toBe(false);
    expect(r.get("b")).toBeUndefined();
    expect(r.names()).toEqual(["a"]);
  });

  test("register() adds a factory", () => {
    const r = new ModuleRegistry();
    r.register("x", factory("x"));
    expect(r.has("x")).toBe(true);
  });

  test("register() fails fast on a duplicate name", () => {
    const r = new ModuleRegistry({ x: factory("x") });
    expect(() => r.register("x", factory("x"))).toThrow(/duplicate module name "x"/);
  });
});
