import { describe, expect, test } from "bun:test";
import { TestScheduler } from "rxjs/testing";
import { OutboundQueue } from "./outbound.ts";
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
});
