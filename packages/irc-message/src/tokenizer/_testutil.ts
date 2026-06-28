// Shared helpers for the cross-backend parity tests (not a test file itself).

import { Tokenizer } from "./Tokenizer.ts";

export const enc = new TextEncoder();

/** Reference tokenizer → flat `[type, start, end]` triples (the oracle). */
export function referenceTriples(line: string): number[] {
  const tokens = new Tokenizer().tokenize(enc.encode(line));
  const out: number[] = [];
  for (const t of tokens) out.push(t.type, t.start, t.end);
  return out;
}

/** Small seeded PRNG so fuzz runs are deterministic. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Generate a random IRC-ish line exercising tags, prefix, params, escapes. */
export function randomLine(rng: () => number): string {
  const pick = <T>(arr: readonly T[]): T => arr[(rng() * arr.length) | 0]!;
  const chance = (p: number): boolean => rng() < p;
  const word = (chars: string, min = 1, max = 8): string => {
    const n = min + ((rng() * (max - min + 1)) | 0);
    let s = "";
    for (let i = 0; i < n; i++) s += chars[(rng() * chars.length) | 0];
    return s;
  };

  const keyChars = "abcdefghijklmnopqrstuvwxyz0123456789-./";
  const valChars = "abcDEF123-_/.\\:s \t" + "éü"; // incl. escapes + UTF-8
  const nameChars = "abcdefghijklmnopqrstuvwxyz0123456789.-";
  const cmds = ["PRIVMSG", "NOTICE", "JOIN", "PART", "PING", "001", "433", "CAP"];

  let line = "";

  if (chance(0.5)) {
    const parts: string[] = [];
    const n = 1 + ((rng() * 5) | 0);
    for (let i = 0; i < n; i++) {
      let key = (chance(0.25) ? "+" : "") + word(keyChars, 1, 10);
      if (chance(0.6)) key += "=" + word(valChars, 0, 12);
      parts.push(key);
    }
    line += "@" + parts.join(";") + " ";
  }

  if (chance(0.6)) {
    let p = ":" + word(nameChars, 1, 10);
    if (chance(0.5)) p += "!" + word(nameChars, 1, 8);
    if (chance(0.7)) p += "@" + word(nameChars, 1, 12);
    line += p + " ";
  }

  line += pick(cmds);

  const np = (rng() * 5) | 0;
  for (let i = 0; i < np; i++) line += " " + word("abcXYZ#&0123", 1, 8);

  if (chance(0.6)) {
    line += " :" + word("hello world 123 .,!é", 0, 30);
  }

  return line;
}
