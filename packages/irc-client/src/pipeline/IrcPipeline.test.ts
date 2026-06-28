import { describe, expect, test } from "bun:test";
import { firstValueFrom, take, toArray } from "rxjs";
import { MockTransport } from "../transport/MockTransport.ts";
import { TransportClosedError } from "../transport/Transport.ts";
import { createMessageStream } from "./IrcPipeline.ts";

describe("createMessageStream", () => {
  test("parses scripted lines into Messages", async () => {
    const transport = new MockTransport();
    const messages$ = createMessageStream(transport);
    const collected = firstValueFrom(messages$.pipe(take(3), toArray()));

    transport.receiveLine(":nick!user@host PRIVMSG #chan :hello world");
    transport.receiveLine("PING :abc");
    transport.receiveLine(":irc.example.com 001 nick :Welcome to IRC");

    const msgs = await collected;
    expect(msgs).toHaveLength(3);
    expect(msgs[0]).toMatchObject({
      command: "PRIVMSG",
      params: ["#chan", "hello world"],
      source: { name: "nick", user: "user", host: "host" },
    });
    expect(msgs[1]).toMatchObject({ command: "PING", params: ["abc"] });
    expect(msgs[2]).toMatchObject({ command: "001", params: ["nick", "Welcome to IRC"] });
  });

  test("parses an IRCv3-tagged line, exposing tags on the Message", async () => {
    const transport = new MockTransport();
    const messages$ = createMessageStream(transport);
    const collected = firstValueFrom(messages$.pipe(take(1), toArray()));

    transport.receiveLine(
      "@time=2026-06-28T12:00:00.000Z;account=bob :bob!b@h PRIVMSG #c :hi",
    );

    const [msg] = await collected;
    expect(msg?.command).toBe("PRIVMSG");
    expect(msg?.tags).toMatchObject({
      time: "2026-06-28T12:00:00.000Z",
      account: "bob",
    });
  });

  test("reassembles a message whose line is split across byte chunks", async () => {
    const transport = new MockTransport();
    const messages$ = createMessageStream(transport);
    const collected = firstValueFrom(messages$.pipe(take(1), toArray()));

    transport.receive("PRIVMSG #c :par");
    transport.receive("tial line\r\n");

    const [msg] = await collected;
    expect(msg).toMatchObject({ command: "PRIVMSG", params: ["#c", "partial line"] });
  });

  test("is multicast: every subscriber receives each message", async () => {
    const transport = new MockTransport();
    const messages$ = createMessageStream(transport);
    const a = firstValueFrom(messages$.pipe(take(2), toArray()));
    const b = firstValueFrom(messages$.pipe(take(2), toArray()));

    transport.receiveLine("PING :1");
    transport.receiveLine("PING :2");

    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.map((m) => m.params[0])).toEqual(["1", "2"]);
    expect(rb.map((m) => m.params[0])).toEqual(["1", "2"]);
  });

  test("honours the backend option", async () => {
    const transport = new MockTransport();
    const messages$ = createMessageStream(transport, { backend: "reference" });
    const collected = firstValueFrom(messages$.pipe(take(1), toArray()));

    transport.receiveLine("JOIN #chan");

    const [msg] = await collected;
    expect(msg).toMatchObject({ command: "JOIN", params: ["#chan"] });
  });

  test("completes when the transport closes locally", async () => {
    const transport = new MockTransport();
    const messages$ = createMessageStream(transport);
    const collected = firstValueFrom(messages$.pipe(toArray()));

    transport.receiveLine("PING :1");
    transport.close();

    const msgs = await collected;
    expect(msgs.map((m) => m.command)).toEqual(["PING"]);
  });

  test("errors when the transport fails abnormally", async () => {
    const transport = new MockTransport();
    const messages$ = createMessageStream(transport);
    const collected = firstValueFrom(messages$.pipe(toArray()));

    transport.receiveLine("PING :1");
    transport.fail(new Error("connection reset"));

    let caught: unknown;
    await collected.catch((err: unknown) => {
      caught = err;
    });
    expect(caught).toBeInstanceOf(TransportClosedError);
    expect((caught as TransportClosedError).cause?.message).toBe("connection reset");
  });
});
