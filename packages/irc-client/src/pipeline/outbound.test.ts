import { describe, expect, test } from "bun:test";
import { TestScheduler } from "rxjs/testing";
import { MAX_LINE_BYTES, OutboundQueue } from "./outbound.ts";
import { command } from "../protocol/commands.ts";

const msg = (text: string) => command("PRIVMSG", "#chan", text);

describe("OutboundQueue", () => {
  test("writes the first message immediately, then spaces by floodDelayMs", () => {
    const scheduler = new TestScheduler(() => undefined);
    scheduler.run(({ flush }) => {
      const writes: Array<{ frame: number; line: string }> = [];
      const queue = new OutboundQueue((line) => writes.push({ frame: scheduler.now(), line }), {
        floodDelayMs: 10,
        scheduler,
      });
      queue.send(msg("one"));
      queue.send(msg("two"));
      queue.send(msg("three"));
      flush();
      expect(writes.map((w) => w.frame)).toEqual([0, 10, 20]);
      expect(writes.map((w) => w.line)).toEqual([
        "PRIVMSG #chan one\r\n",
        "PRIVMSG #chan two\r\n",
        "PRIVMSG #chan three\r\n",
      ]);
    });
  });

  test("sendImmediate bypasses the queue and writes synchronously", () => {
    const writes: string[] = [];
    const queue = new OutboundQueue((line) => writes.push(line), { floodDelayMs: 1000 });
    queue.sendImmediate(command("PONG", "token"));
    expect(writes).toEqual(["PONG token\r\n"]);
    queue.close();
  });

  test("close() makes both send paths no-ops", () => {
    const writes: string[] = [];
    const queue = new OutboundQueue((line) => writes.push(line), { floodDelayMs: 1000 });
    queue.close();
    queue.send(msg("dropped"));
    queue.sendImmediate(command("PONG", "dropped"));
    expect(writes).toEqual([]);
  });

  test("close() is idempotent", () => {
    const queue = new OutboundQueue(() => undefined, { floodDelayMs: 1 });
    expect(() => {
      queue.close();
      queue.close();
    }).not.toThrow();
  });

  describe("outbound safety (one call = one line)", () => {
    const newline = String.fromCharCode(10);
    const cr = String.fromCharCode(13);
    const nul = String.fromCharCode(0);

    test("send() throws on CR/LF/NUL (command injection guard)", () => {
      const writes: string[] = [];
      const queue = new OutboundQueue((line) => writes.push(line), { floodDelayMs: 0 });
      // A relayed message that smuggles a second command via a newline.
      expect(() => queue.send(msg(`hi${newline}KICK #chan victim`))).toThrow(/CR, LF, or NUL/);
      expect(() => queue.send(msg(`x${cr}y`))).toThrow();
      expect(() => queue.send(msg(`x${nul}y`))).toThrow();
      expect(writes).toEqual([]); // nothing reached the wire
      queue.close();
    });

    test("send() throws when the serialized line exceeds the limit", () => {
      const writes: string[] = [];
      const queue = new OutboundQueue((line) => writes.push(line), { floodDelayMs: 0 });
      expect(() => queue.send(msg("x".repeat(600)))).toThrow(/IRC line limit/);
      // A message that fits is accepted and is within the limit.
      queue.send(msg("x".repeat(400)));
      expect(writes).toHaveLength(1);
      expect(new TextEncoder().encode(writes[0]!).length).toBeLessThanOrEqual(MAX_LINE_BYTES);
      queue.close();
    });

    test("sendImmediate() is lenient: strips CR/LF/NUL and truncates", () => {
      const writes: string[] = [];
      const queue = new OutboundQueue((line) => writes.push(line), { floodDelayMs: 0 });
      // QUIT/keepalive must never be blocked by bad input — strip, don't throw.
      queue.sendImmediate(command("QUIT", `bye${newline}KICK #x y`));
      expect(writes[0]).toBe("QUIT :byeKICK #x y\r\n"); // single line, no injected newline
      expect(writes[0]).not.toContain(newline.repeat(1) + "KICK"); // no second line
      writes.length = 0;
      queue.sendImmediate(command("QUIT", "z".repeat(600)));
      expect(new TextEncoder().encode(writes[0]!).length).toBeLessThanOrEqual(MAX_LINE_BYTES);
      queue.close();
    });
  });
});
