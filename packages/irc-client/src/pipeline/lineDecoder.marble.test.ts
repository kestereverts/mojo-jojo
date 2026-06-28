import { test } from "bun:test";
import { marbles } from "rxjs-marbles/jest";
import { decodeLines } from "./lineDecoder.ts";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

test(
  "emits one decoded line per source emission, preserving order and timing",
  marbles((m) => {
    const source = m.hot("  -a-b-|", { a: enc("X\r\n"), b: enc("Y\r\n") });
    const expected = m.cold("-x-y-|", { x: "X", y: "Y" });
    m.expect(source.pipe(decodeLines())).toBeObservable(expected);
  }),
);

test(
  "holds a partial line until its terminator arrives in a later frame",
  marbles((m) => {
    const source = m.hot("  -a-b-|", { a: enc("PING :to"), b: enc("ken\r\n") });
    const expected = m.cold("---x-|", { x: "PING :token" });
    m.expect(source.pipe(decodeLines())).toBeObservable(expected);
  }),
);
