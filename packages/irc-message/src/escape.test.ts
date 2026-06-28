import { describe, expect, test } from "bun:test";
import { escapeTagValue, unescapeTagValue } from "./escape.ts";

describe("escapeTagValue", () => {
  test("escapes the five reserved characters", () => {
    // ; -> \:   space -> \s   \ -> \\   CR -> \r   LF -> \n
    expect(escapeTagValue("a;b c\\d\re\nf")).toBe("a\\:b\\sc\\\\d\\re\\nf");
  });

  test("returns the input unchanged when nothing needs escaping", () => {
    expect(escapeTagValue("plain-value/123")).toBe("plain-value/123");
  });
});

describe("unescapeTagValue", () => {
  test("decodes the five escapes", () => {
    expect(unescapeTagValue("a\\:b\\sc\\\\d\\re\\nf")).toBe("a;b c\\d\re\nf");
  });

  test("drops the backslash on an unknown escape", () => {
    expect(unescapeTagValue("\\a\\b")).toBe("ab");
  });

  test("drops a lone trailing backslash", () => {
    expect(unescapeTagValue("abc\\")).toBe("abc");
  });
});

describe("escape/unescape round-trip", () => {
  for (const value of ["", "simple", "a;b c", "back\\slash", "crlf\r\n", "x\\y"]) {
    test(JSON.stringify(value), () => {
      expect(unescapeTagValue(escapeTagValue(value))).toBe(value);
    });
  }
});
