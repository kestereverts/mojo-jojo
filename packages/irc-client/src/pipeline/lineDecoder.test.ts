import { describe, expect, test } from "bun:test";
import { firstValueFrom, from, toArray } from "rxjs";
import { decodeLines } from "./lineDecoder.ts";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

/** Feed string chunks (UTF-8 encoded) through decodeLines and collect the lines. */
function collect(chunks: string[]): Promise<string[]> {
  return firstValueFrom(from(chunks.map(enc)).pipe(decodeLines(), toArray()));
}

/** Feed raw byte chunks through decodeLines and collect the lines. */
function collectBytes(chunks: Uint8Array[]): Promise<string[]> {
  return firstValueFrom(from(chunks).pipe(decodeLines(), toArray()));
}

describe("decodeLines", () => {
  test("splits a single CRLF-terminated line", async () => {
    expect(await collect(["PING :token\r\n"])).toEqual(["PING :token"]);
  });

  test("splits multiple lines in one chunk", async () => {
    expect(await collect(["A\r\nB\r\nC\r\n"])).toEqual(["A", "B", "C"]);
  });

  test("buffers a line split across chunks", async () => {
    expect(await collect(["PRIV", "MSG #c :hel", "lo\r\n"])).toEqual(["PRIVMSG #c :hello"]);
  });

  test("handles a CRLF split across chunks (CR then LF)", async () => {
    expect(await collect(["A\r", "\nB\r\n"])).toEqual(["A", "B"]);
  });

  test("tolerates a bare LF", async () => {
    expect(await collect(["A\nB\n"])).toEqual(["A", "B"]);
  });

  test("drops empty lines", async () => {
    expect(await collect(["\r\n\r\nA\r\n\r\n"])).toEqual(["A"]);
  });

  test("discards an unterminated trailing line on completion", async () => {
    expect(await collect(["A\r\nB"])).toEqual(["A"]);
  });

  test("reassembles a multi-byte UTF-8 char split across chunks", async () => {
    // "é" (U+00E9) is 0xC3 0xA9 in UTF-8; split it across two chunks.
    const head = enc("PRIVMSG :");
    const chunk1 = new Uint8Array([...head, 0xc3]);
    const chunk2 = new Uint8Array([0xa9, ...enc("\r\n")]);
    expect(await collectBytes([chunk1, chunk2])).toEqual(["PRIVMSG :é"]);
  });

  test("preserves IRCv3 tag content (no framing interference)", async () => {
    const line = "@id=123;+ex.com/foo=a\\sb :nick!u@h PRIVMSG #c :hi";
    expect(await collect([line + "\r\n"])).toEqual([line]);
  });
});
