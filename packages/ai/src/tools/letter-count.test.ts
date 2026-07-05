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
    const result = (await execute({ text: "café" }, {} as never)) as any;
    expect(result.frequencies.é).toBe(1);
    expect(result.letterCount).toBe(4);

    const jp = (await execute({ text: "こんにちは" }, {} as never)) as any;
    expect(jp.letterCount).toBe(5);
  });

  test("ignores non-letters (digits, punctuation, whitespace) in letterCount but counts them in textLength", async () => {
    const result = (await execute({ text: "a1 b!" }, {} as never)) as any;
    expect(result.letterCount).toBe(2);
    expect(result.textLength).toBe(5);
  });
});
