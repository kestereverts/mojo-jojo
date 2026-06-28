import { describe, expect, test } from "bun:test";
import { Tokenizer } from "./Tokenizer.ts";
import { JsFastTokenizer } from "./JsFastTokenizer.ts";
import { Parser } from "../parser/Parser.ts";
import { FlatParser } from "../parser/FlatParser.ts";
import { SAMPLES, maxLengthLine } from "../../bench/corpus.ts";
import { enc, referenceTriples, mulberry32, randomLine } from "./_testutil.ts";

function jsFastTriples(line: string): number[] {
  const tk = new JsFastTokenizer();
  const count = tk.tokenizeInto(enc.encode(line));
  return Array.from(tk.tokens.subarray(0, count * 3));
}

describe("JsFastTokenizer ≡ reference Tokenizer (triples)", () => {
  for (const { name, line } of SAMPLES) {
    test(name, () => {
      expect(jsFastTriples(line)).toEqual(referenceTriples(line));
    });
  }

  test("max-length line", () => {
    const line = maxLengthLine();
    expect(jsFastTriples(line)).toEqual(referenceTriples(line));
  });

  test("empty input", () => {
    expect(jsFastTriples("")).toEqual(referenceTriples(""));
  });

  test("differential fuzz (2000 random lines)", () => {
    const rng = mulberry32(0x1234abcd);
    for (let i = 0; i < 2000; i++) {
      const line = randomLine(rng);
      expect(jsFastTriples(line)).toEqual(referenceTriples(line));
    }
  });
});

describe("FlatParser(JsFast) ≡ Parser(reference) (Message)", () => {
  const refParser = new Parser();
  const flatParser = new FlatParser();
  const refTk = new Tokenizer();
  const fastTk = new JsFastTokenizer();

  const parseRef = (line: string) => {
    const bytes = enc.encode(line);
    return refParser.parse(bytes, refTk.tokenize(bytes));
  };
  const parseFast = (line: string) => {
    const bytes = enc.encode(line);
    const count = fastTk.tokenizeInto(bytes);
    return flatParser.parse(bytes, fastTk.tokens, count);
  };

  for (const { name, line } of SAMPLES) {
    test(name, () => {
      expect(parseFast(line)).toEqual(parseRef(line));
    });
  }

  test("differential fuzz (2000 random lines)", () => {
    const rng = mulberry32(0x55aa55aa);
    for (let i = 0; i < 2000; i++) {
      const line = randomLine(rng);
      expect(parseFast(line)).toEqual(parseRef(line));
    }
  });
});
