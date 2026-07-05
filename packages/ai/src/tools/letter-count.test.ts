import { describe, expect, test } from "bun:test";
import { letterCountTool } from "./letter-count.ts";

const execute = letterCountTool().tool.execute!;

describe("letter_count", () => {
  test("counts ASCII letters case-insensitively", async () => {
    const result = (await execute({ text: "strawberry" }, {} as never)) as any;
    expect(result.frequencies.r).toBe(3);
    expect(result.letterCount).toBe(10);
    expect(result.uniqueLetters).toBe(8); // s,t,r,a,w,b,e,y
  });

  test("is Unicode-aware: accented and non-Latin letters count too (the mojo-ai3 bug this fixes)", async () => {
    const result = (await execute({ text: "café" }, {} as never)) as any; // precomposed "café"
    expect(result.frequencies["é"]).toBe(1);
    expect(result.letterCount).toBe(4);

    const jp = (await execute({ text: "こんにちは" }, {} as never)) as any; // "こんにちは"
    expect(jp.letterCount).toBe(5);
  });

  test("ignores non-letters (digits, punctuation, whitespace) in letterCount but counts them in textLength", async () => {
    const result = (await execute({ text: "a1 b!" }, {} as never)) as any;
    expect(result.letterCount).toBe(2);
    expect(result.textLength).toBe(5);
  });

  test("NFC and NFD forms of the same accented letter count as one key (found in review)", async () => {
    // Built from \u escapes, not typed accented characters, so the two forms
    // can't accidentally collapse to the same bytes: nfc is "café"
    // (precomposed é, one code point); nfd is "cafe" + "́" (combining
    // acute accent) — the same rendered letter, genuinely different bytes.
    const nfc = "café";
    const nfd = "café";
    expect(nfc).not.toBe(nfd);
    expect(nfc.normalize("NFC")).toBe(nfd.normalize("NFC")); // sanity: they really are the same letter
    const resultNfc = (await execute({ text: nfc }, {} as never)) as any;
    const resultNfd = (await execute({ text: nfd }, {} as never)) as any;
    expect(resultNfc.frequencies).toEqual(resultNfd.frequencies);
    expect(Object.keys(resultNfd.frequencies)).toContain("é");
  });
});
