// Representative IRC lines shared by the parity tests and the benchmarks.
// Each `line` is a single message WITHOUT the trailing CRLF.

export interface Sample {
  readonly name: string;
  readonly line: string;
}

export const SAMPLES: readonly Sample[] = [
  { name: "ping", line: "PING" },
  { name: "join", line: ":nick!user@host JOIN #channel" },
  {
    name: "privmsg",
    line: ":nick!user@host PRIVMSG #channel :Hello, world!",
  },
  {
    name: "numeric",
    line: ":irc.example.com 001 nick :Welcome to the Internet Relay Network",
  },
  {
    name: "many-params",
    line: "CMD a b c d e f g h i j k l m n o p :trailing text here",
  },
  {
    name: "tags",
    line: "@id=123;+example.com/foo=bar;account=nick :nick!user@host PRIVMSG #channel :hi there",
  },
  {
    name: "tags-heavy",
    line: "@time=2026-06-28T12:00:00.000Z;msgid=abc123def456;+draft/reply=987;account=someuser;subscriber=1;badges=broadcaster/1,subscriber/12 :someuser!someuser@someuser.tmi.example.com PRIVMSG #somechannel :This is a longer message body with several words to scan, including an escaped \\:semicolon and a \\sspace.",
  },
];

/** A line whose RFC1459 portion is exactly 510 bytes (the spec max). */
export function maxLengthLine(): string {
  const head = "PRIVMSG #channel :";
  return head + "x".repeat(510 - head.length);
}

/** Join `n` cycled samples into one CRLF-separated buffer (batch input). */
export function makeBatch(n: number): string {
  const lines: string[] = [];
  for (let i = 0; i < n; i++) {
    lines.push(SAMPLES[i % SAMPLES.length]!.line);
  }
  return lines.join("\r\n");
}

/** Split a buffer into `[start, contentEnd)` line ranges (strip trailing \r). */
export function lineRanges(bytes: Uint8Array): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let i = 0;
  while (i < bytes.length) {
    let le = i;
    while (le < bytes.length && bytes[le] !== 10) le++;
    let end = le;
    if (end > i && bytes[end - 1] === 13) end--;
    ranges.push([i, end]);
    i = le + 1;
  }
  return ranges;
}
