import { describe, expect, test } from "bun:test";
import { Tokenizer } from "./Tokenizer.ts";

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

describe("Tokenizer limits", () => {
  describe("rfc1459DataLimit", () => {
    test("throws when the prefix+command+params exceed the limit", () => {
      const t = new Tokenizer({ rfc1459DataLimit: 10 });
      expect(() =>
        t.tokenize(bytes("PRIVMSG #channel :this is way too long")),
      ).toThrow(/rfc1459DataLimit/);
    });

    test("allows a portion exactly at the limit", () => {
      const t = new Tokenizer({ rfc1459DataLimit: 10 });
      expect(() => t.tokenize(bytes("PING 12345"))).not.toThrow(); // 10 bytes
    });

    test("excludes the tag section from the limit", () => {
      const t = new Tokenizer({ rfc1459DataLimit: 4 });
      // The tags are long, but the RFC1459 portion ("PING") is exactly 4 bytes.
      expect(() => t.tokenize(bytes("@a=1;b=2;c=3 PING"))).not.toThrow();
    });
  });

  describe("paramCountLimit", () => {
    test("throws when the parameter count exceeds the limit", () => {
      const t = new Tokenizer({ paramCountLimit: 3 });
      expect(() => t.tokenize(bytes("CMD a b c d e"))).toThrow(/paramCountLimit/);
    });

    test("allows up to the limit, counting a trailing param", () => {
      const t = new Tokenizer({ paramCountLimit: 3 });
      expect(() => t.tokenize(bytes("CMD a b c"))).not.toThrow();
      expect(() => t.tokenize(bytes("CMD a b :trailing words"))).not.toThrow();
    });
  });

  describe("rfc1459DataLimit default matches the spec (510 bytes)", () => {
    test("the default is 510", () => {
      expect(new Tokenizer().rfc1459DataLimit).toBe(510);
    });

    test("a 510-byte line passes and a 511-byte line throws", () => {
      const at510 = "PING " + "x".repeat(505); // 5 + 505 = 510 bytes
      const at511 = "PING " + "x".repeat(506); // 511 bytes
      expect(() => new Tokenizer().tokenize(bytes(at510))).not.toThrow();
      expect(() => new Tokenizer().tokenize(bytes(at511))).toThrow(
        /rfc1459DataLimit/,
      );
    });
  });

  describe("tagDataLimit uses '>' (max-allowed) semantics", () => {
    // "@k=ab " spans 6 bytes including the trailing space that ends the section.
    test("a tag section exactly at the limit passes", () => {
      expect(() =>
        new Tokenizer({ tagDataLimit: 6 }).tokenize(bytes("@k=ab CMD")),
      ).not.toThrow();
    });

    test("one byte over the limit throws", () => {
      expect(() =>
        new Tokenizer({ tagDataLimit: 5 }).tokenize(bytes("@k=ab CMD")),
      ).toThrow(/tagDataLimit/);
    });
  });

  describe("tagDataLimit default matches the spec (8191 bytes)", () => {
    test("the default is 8191", () => {
      expect(new Tokenizer().tagDataLimit).toBe(8191);
    });

    test("a tag section at 8191 bytes passes and 8192 throws", () => {
      // Measured size = '@' + key + trailing space; 8189 key bytes => 8191 total.
      const at8191 = "@" + "k".repeat(8189) + " CMD";
      const at8192 = "@" + "k".repeat(8190) + " CMD";
      expect(() => new Tokenizer().tokenize(bytes(at8191))).not.toThrow();
      expect(() => new Tokenizer().tokenize(bytes(at8192))).toThrow(
        /tagDataLimit/,
      );
    });
  });
});
