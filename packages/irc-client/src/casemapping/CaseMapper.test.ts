import { describe, expect, test } from "bun:test";
import { CaseMapper, toCaseMapping, DEFAULT_CASE_MAPPING } from "./CaseMapper.ts";
import { IrcMap, IrcSet } from "./IrcMap.ts";

describe("CaseMapper", () => {
  test("ascii folds only A-Z", () => {
    const m = new CaseMapper("ascii");
    expect(m.normalize("Nick")).toBe("nick");
    expect(m.normalize("ABC")).toBe("abc");
    // Brackets are left untouched under ascii.
    expect(m.normalize("a[b]c\\d~e")).toBe("a[b]c\\d~e");
  });

  test("rfc1459 folds A-Z plus []\\~ -> {}|^", () => {
    const m = new CaseMapper("rfc1459");
    expect(m.normalize("Nick[]\\~")).toBe("nick{}|^");
    // `^` is already the lowercase form, so it is unchanged.
    expect(m.normalize("^")).toBe("^");
  });

  test("rfc1459-strict folds []\\ but NOT ~", () => {
    const m = new CaseMapper("rfc1459-strict");
    expect(m.normalize("[]\\")).toBe("{}|");
    expect(m.normalize("~")).toBe("~"); // tilde untouched in strict mode
  });

  test("default mapping is rfc1459", () => {
    expect(DEFAULT_CASE_MAPPING).toBe("rfc1459");
    expect(new CaseMapper().mapping).toBe("rfc1459");
    expect(new CaseMapper().normalize("[Foo]")).toBe("{foo}");
  });

  test("equals compares case-insensitively under the mapping", () => {
    const m = new CaseMapper("rfc1459");
    expect(m.equals("Foo[]", "foo{}")).toBe(true);
    expect(m.equals("a", "b")).toBe(false);
  });

  test("toCaseMapping coerces known values and falls back to default", () => {
    expect(toCaseMapping("ascii")).toBe("ascii");
    expect(toCaseMapping("rfc1459-strict")).toBe("rfc1459-strict");
    // The historical ISUPPORT-draft spelling (Solanum/Charybdis/Hybrid) is accepted.
    expect(toCaseMapping("strict-rfc1459")).toBe("rfc1459-strict");
    expect(toCaseMapping("bogus")).toBe(DEFAULT_CASE_MAPPING);
    expect(toCaseMapping(undefined)).toBe(DEFAULT_CASE_MAPPING);
  });
});

describe("IrcMap", () => {
  test("get/set/has/delete are case-insensitive", () => {
    const map = new IrcMap<number>(new CaseMapper("rfc1459"));
    map.set("Alice", 1);
    expect(map.get("alice")).toBe(1);
    expect(map.has("ALICE")).toBe(true);
    expect(map.size).toBe(1);
    expect(map.delete("aLiCe")).toBe(true);
    expect(map.has("alice")).toBe(false);
  });

  test("set updates display case but keeps the same slot", () => {
    const map = new IrcMap<number>(new CaseMapper("ascii"));
    map.set("Bob", 1);
    map.set("BOB", 2);
    expect(map.size).toBe(1);
    expect(map.get("bob")).toBe(2);
    expect([...map.keys()]).toEqual(["BOB"]); // latest display case wins
  });

  test("rfc1459 treats [nick] and {nick} as the same key", () => {
    const map = new IrcMap<string>(new CaseMapper("rfc1459"));
    map.set("[Away]Bob", "x");
    expect(map.get("{away}bob")).toBe("x");
  });

  test("iteration yields display keys and values", () => {
    const map = new IrcMap<number>(new CaseMapper("ascii"));
    map.set("a", 1).set("B", 2);
    expect([...map.entries()]).toEqual([
      ["a", 1],
      ["B", 2],
    ]);
    expect([...map.values()]).toEqual([1, 2]);
    const seen: string[] = [];
    map.forEach((_v, k) => seen.push(k));
    expect(seen).toEqual(["a", "B"]);
  });

  test("rekey re-folds entries under a new mapper", () => {
    const map = new IrcMap<number>(new CaseMapper("ascii"));
    map.set("Foo[]", 1);
    // Under ascii, `foo{}` is a different key.
    expect(map.get("foo{}")).toBeUndefined();
    map.rekey(new CaseMapper("rfc1459"));
    // After rekey, the rfc1459 fold makes them equal.
    expect(map.get("foo{}")).toBe(1);
    expect(map.mapper.mapping).toBe("rfc1459");
  });
});

describe("IrcSet", () => {
  test("add/has/delete case-insensitively, preserves display case", () => {
    const set = new IrcSet(new CaseMapper("rfc1459"));
    set.add("Chan[]");
    expect(set.has("chan{}")).toBe(true);
    expect([...set]).toEqual(["Chan[]"]);
    expect(set.size).toBe(1);
    expect(set.delete("CHAN{}")).toBe(true);
    expect(set.size).toBe(0);
  });
});
