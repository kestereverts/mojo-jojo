import { describe, expect, test } from "bun:test";
import type { Message } from "@mojo-jojo/irc-message";
import { IrcClient } from "./IrcClient.ts";
import { MockTransport } from "./transport/MockTransport.ts";
import type { IrcClientOptions } from "./options.ts";
import type { LifecycleEvent } from "./events/lifecycle.ts";
import type { IrcEvent } from "./events/types.ts";

/** Poll `predicate` until it holds or the timeout elapses. */
async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = performance.now();
  while (!predicate()) {
    if (performance.now() - start > timeoutMs) {
      throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

/** Connect a client to a fresh MockTransport and drive it to a registered state. */
async function registerClient(
  overrides: Partial<IrcClientOptions> = {},
): Promise<{ client: IrcClient; mock: MockTransport; events: LifecycleEvent[] }> {
  const mock = new MockTransport();
  const client = new IrcClient({
    host: "irc.test",
    nick: "mojo",
    tls: false,
    transport: () => mock,
    caps: [],
    floodDelayMs: 0,
    ...overrides,
  });
  const events: LifecycleEvent[] = [];
  client.lifecycle$.subscribe((e) => events.push(e));
  const connected = client.connect();
  await waitFor(() => mock.written.some((l) => l.startsWith("USER")));
  mock.receiveLine(":irc 001 mojo :Welcome");
  await connected;
  return { client, mock, events };
}

describe("IrcClient", () => {
  test("connects, negotiates caps, and registers", async () => {
    const mock = new MockTransport();
    const client = new IrcClient({
      host: "irc.test",
      nick: "mojo",
      tls: false,
      transport: () => mock,
      caps: ["multi-prefix", "server-time"],
      floodDelayMs: 0,
    });
    const events: LifecycleEvent[] = [];
    client.lifecycle$.subscribe((e) => events.push(e));

    const connected = client.connect();
    await waitFor(() => mock.written.some((l) => l.startsWith("USER")));
    expect(mock.written).toContain("CAP LS 302\r\n");

    mock.receiveLine(":irc CAP * LS :multi-prefix server-time sasl=PLAIN");
    await waitFor(() => mock.written.some((l) => l.startsWith("CAP REQ")));
    expect(mock.written).toContain("CAP REQ :multi-prefix server-time\r\n");

    mock.receiveLine(":irc CAP mojo ACK :multi-prefix server-time");
    await waitFor(() => mock.written.includes("CAP END\r\n"));

    mock.receiveLine(":irc 001 mojo :Welcome to the Test IRC Network");
    await connected;

    expect(client.state).toBe("registered");
    expect(client.nick).toBe("mojo");
    expect([...client.enabledCaps].sort()).toEqual(["multi-prefix", "server-time"]);
    // Caps are also mirrored onto the live server state (not just enabledCaps).
    expect([...(client.server?.caps ?? [])].sort()).toEqual(["multi-prefix", "server-time"]);
    expect(events.map((e) => e.type)).toEqual(["connecting", "connected", "registered"]);
    client.quit();
  });

  test("answers a server PING with a PONG carrying the same token", async () => {
    const { client, mock } = await registerClient();
    mock.receiveLine("PING :LAG12345");
    await waitFor(() => mock.written.includes("PONG LAG12345\r\n"));
    client.quit();
  });

  test("falls back to an alternate nick on 433", async () => {
    const mock = new MockTransport();
    const client = new IrcClient({
      host: "irc.test",
      nick: "taken",
      altNicks: ["taken2"],
      tls: false,
      transport: () => mock,
      caps: [],
      floodDelayMs: 0,
    });
    const connected = client.connect();
    await waitFor(() => mock.written.includes("NICK taken\r\n"));
    mock.receiveLine(":irc 433 * taken :Nickname is already in use");
    await waitFor(() => mock.written.includes("NICK taken2\r\n"));
    mock.receiveLine(":irc 001 taken2 :Welcome");
    await connected;
    expect(client.nick).toBe("taken2");
    client.quit();
  });

  test("surfaces inbound messages on the stable messages$ stream", async () => {
    const { client, mock } = await registerClient();
    const received: Message[] = [];
    client.messages$.subscribe((m) => received.push(m));
    mock.receiveLine(":alice!a@host PRIVMSG #mojo2 :hello there");
    await waitFor(() => received.some((m) => m.command === "PRIVMSG"));
    const privmsg = received.find((m) => m.command === "PRIVMSG")!;
    expect(privmsg.params).toEqual(["#mojo2", "hello there"]);
    expect(privmsg.source?.name).toBe("alice");
    client.quit();
  });

  test("quit() sends QUIT, closes the transport, and emits a local disconnect", async () => {
    const { client, mock, events } = await registerClient();
    client.quit("so long");
    expect(mock.written).toContain("QUIT :so long\r\n");
    expect(client.state).toBe("closed");
    expect(events.some((e) => e.type === "disconnected" && e.local === true)).toBe(true);
  });

  test("reconnects with backoff after an abnormal drop", async () => {
    const mocks: MockTransport[] = [];
    const client = new IrcClient({
      host: "irc.test",
      nick: "mojo",
      tls: false,
      transport: () => {
        const m = new MockTransport();
        mocks.push(m);
        return m;
      },
      caps: [],
      floodDelayMs: 0,
      reconnect: { enabled: true, initialDelayMs: 1, factor: 1, jitter: false, maxDelayMs: 5, maxRetries: 5 },
    });
    const events: LifecycleEvent[] = [];
    client.lifecycle$.subscribe((e) => events.push(e));

    const connected = client.connect();
    await waitFor(() => mocks.length === 1 && mocks[0]!.written.some((l) => l.startsWith("USER")));
    mocks[0]!.receiveLine(":irc 001 mojo :hi");
    await connected;
    expect(client.state).toBe("registered");

    // Abnormal drop -> backoff -> a brand-new transport attempt.
    mocks[0]!.fail(new Error("connection reset"));
    await waitFor(
      () => mocks.length === 2 && mocks[1]!.written.some((l) => l.startsWith("USER")),
      2000,
    );
    mocks[1]!.receiveLine(":irc 001 mojo :hi again");
    await waitFor(() => events.filter((e) => e.type === "registered").length === 2, 2000);

    expect(events.some((e) => e.type === "disconnected" && e.local === false)).toBe(true);
    expect(events.some((e) => e.type === "reconnecting")).toBe(true);

    // The PING responder uses the *new* connection's queue after reconnect.
    mocks[1]!.receiveLine("PING :after-reconnect");
    await waitFor(() => mocks[1]!.written.includes("PONG after-reconnect\r\n"));
    expect(mocks[0]!.written.some((l) => l.startsWith("PONG"))).toBe(false);
    client.quit();
  });

  test("quit() during an in-flight connect never registers or writes afterwards", async () => {
    const mock = new MockTransport({ autoConnect: false });
    const client = new IrcClient({
      host: "irc.test",
      nick: "mojo",
      tls: false,
      transport: () => mock,
      caps: [],
      floodDelayMs: 0,
    });
    const connecting = client.connect();
    connecting.catch(() => undefined); // will reject: closed before registration

    // Quit while transport.connect() is still pending, then let it resolve.
    client.quit();
    mock.completeConnect();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(mock.written).toEqual([]); // no CAP LS / NICK / USER after quit
    expect(client.state).toBe("closed");
  });

  test("connect() rejects when registration fails and reconnect is disabled", async () => {
    const mock = new MockTransport();
    const client = new IrcClient({
      host: "irc.test",
      nick: "mojo",
      tls: false,
      transport: () => mock,
      caps: [],
      reconnect: { enabled: false },
      registrationTimeoutMs: 30,
    });
    const events: LifecycleEvent[] = [];
    client.lifecycle$.subscribe((e) => events.push(e));

    let error: unknown;
    await client.connect().catch((e: unknown) => {
      error = e;
    });
    expect((error as Error).message).toContain("timed out");
    expect(client.state).toBe("closed");
    expect(events.some((e) => e.type === "error")).toBe(true);
    expect(events.some((e) => e.type === "disconnected" && e.local === false)).toBe(true);
    client.quit();
  });

  test("connect() rejects if called twice", async () => {
    const { client } = await registerClient();
    let error: unknown;
    await client.connect().catch((e: unknown) => {
      error = e;
    });
    expect((error as Error).message).toContain('state "registered"');
    client.quit();
  });
});

describe("IrcClient — state + events (M3)", () => {
  test("tracks channel/member state and emits entity-resolved events", async () => {
    const { client, mock } = await registerClient();
    const events: IrcEvent[] = [];
    client.events$.subscribe((e) => events.push(e));

    mock.receiveLine(":irc 005 mojo PREFIX=(ov)@+ CHANTYPES=#& NETWORK=TestNet :are supported");
    mock.receiveLine(":mojo!u@h JOIN #mojo2");
    mock.receiveLine(":irc 353 mojo = #mojo2 :@alice mojo");
    mock.receiveLine(":irc 366 mojo #mojo2 :End of NAMES");

    await waitFor(() => client.channel("#mojo2")?.members.has("alice") === true);
    const chan = client.channel("#mojo2")!;
    expect(chan.members.get("alice")?.isOp()).toBe(true);
    expect(client.server?.network).toBe("TestNet");
    expect(client.channels?.size).toBe(1);

    // A per-channel stream and the global firehose both see the message.
    const channelTexts: string[] = [];
    chan.messages$.subscribe((e) => channelTexts.push(e.text));
    mock.receiveLine(":alice!a@h PRIVMSG #mojo2 :hi there");
    await waitFor(() => events.some((e) => e.type === "privmsg"));

    const pm = events.find((e) => e.type === "privmsg");
    expect(pm?.type).toBe("privmsg");
    if (pm?.type === "privmsg") {
      expect(pm.channel?.name).toBe("#mojo2");
      expect(pm.user.nick).toBe("alice");
      expect(pm.member?.isOp()).toBe(true);
    }
    expect(channelTexts).toEqual(["hi there"]);
    client.quit();
  });

  test("events$ completes on quit", async () => {
    const { client } = await registerClient();
    let completed = false;
    client.events$.subscribe({ complete: () => (completed = true) });
    client.quit();
    expect(completed).toBe(true);
  });

  test("quit() completes per-entity streams (no dangling subscriptions)", async () => {
    const { client, mock } = await registerClient();
    mock.receiveLine(":mojo!u@h JOIN #mojo2");
    await waitFor(() => client.channel("#mojo2") !== undefined);
    let channelCompleted = false;
    client.channel("#mojo2")!.messages$.subscribe({ complete: () => (channelCompleted = true) });
    client.quit();
    expect(channelCompleted).toBe(true);
  });

  test("an abnormal drop completes the previous connection's entity streams", async () => {
    const mocks: MockTransport[] = [];
    const client = new IrcClient({
      host: "irc.test",
      nick: "mojo",
      tls: false,
      transport: () => {
        const m = new MockTransport();
        mocks.push(m);
        return m;
      },
      caps: [],
      floodDelayMs: 0,
      reconnect: { enabled: true, initialDelayMs: 1, factor: 1, jitter: false, maxDelayMs: 5 },
    });
    const connected = client.connect();
    await waitFor(() => mocks.length === 1 && mocks[0]!.written.some((l) => l.startsWith("USER")));
    mocks[0]!.receiveLine(":irc 001 mojo :hi");
    await connected;
    mocks[0]!.receiveLine(":mojo!u@h JOIN #mojo2");
    await waitFor(() => client.channel("#mojo2") !== undefined);

    let completed = false;
    client.channel("#mojo2")!.messages$.subscribe({ complete: () => (completed = true) });
    // Drop the connection: the old StateStore's entity streams must complete.
    mocks[0]!.fail(new Error("reset"));
    await waitFor(() => completed, 2000);
    expect(completed).toBe(true);
    client.quit();
  });
});

describe("IrcClient — SASL + P1 caps (M4)", () => {
  test("authenticates with SASL PLAIN before completing registration", async () => {
    const mock = new MockTransport();
    const client = new IrcClient({
      host: "irc.test",
      nick: "mojo",
      tls: false,
      transport: () => mock,
      caps: ["sasl"],
      sasl: { mechanism: "PLAIN", username: "mojo", password: "hunter2" },
      floodDelayMs: 0,
    });
    const connected = client.connect();
    await waitFor(() => mock.written.some((l) => l.startsWith("USER")));

    mock.receiveLine(":irc CAP * LS :sasl=PLAIN,EXTERNAL");
    await waitFor(() => mock.written.includes("CAP REQ sasl\r\n"));
    mock.receiveLine(":irc CAP mojo ACK :sasl");

    // The exchange runs before CAP END.
    await waitFor(() => mock.written.includes("AUTHENTICATE PLAIN\r\n"));
    expect(mock.written.includes("CAP END\r\n")).toBe(false);
    mock.receiveLine("AUTHENTICATE +");
    await waitFor(() =>
      mock.written.some((l) => l.startsWith("AUTHENTICATE ") && l !== "AUTHENTICATE PLAIN\r\n"),
    );
    mock.receiveLine(":irc 900 mojo mojo!u@h MojoAcct :now logged in");
    mock.receiveLine(":irc 903 mojo :SASL authentication successful");
    await waitFor(() => mock.written.includes("CAP END\r\n"));

    mock.receiveLine(":irc 001 mojo :Welcome");
    await connected;
    expect(client.state).toBe("registered");
    expect(client.enabledCaps.has("sasl")).toBe(true);
    // The SASL login account (from 900) is recorded on our own user.
    expect(client.user("mojo")?.account).toBe("MojoAcct");
    client.quit();
  });

  test("a SASL failure aborts the connection (connect rejects)", async () => {
    const mock = new MockTransport();
    const client = new IrcClient({
      host: "irc.test",
      nick: "mojo",
      tls: false,
      transport: () => mock,
      caps: ["sasl"],
      sasl: { mechanism: "PLAIN", username: "mojo", password: "wrong" },
      reconnect: { enabled: false },
      floodDelayMs: 0,
    });
    let error: unknown;
    const connected = client.connect().catch((e: unknown) => {
      error = e;
    });
    await waitFor(() => mock.written.some((l) => l.startsWith("USER")));
    mock.receiveLine(":irc CAP * LS :sasl");
    mock.receiveLine(":irc CAP mojo ACK :sasl");
    await waitFor(() => mock.written.includes("AUTHENTICATE PLAIN\r\n"));
    mock.receiveLine("AUTHENTICATE +");
    mock.receiveLine(":irc 904 mojo :SASL authentication failed");
    await connected;
    expect((error as Error).message).toContain("904");
    expect(client.state).toBe("closed");
  });

  test("account-notify ACCOUNT updates state and emits an account event", async () => {
    const { client, mock } = await registerClient();
    const events: IrcEvent[] = [];
    client.events$.subscribe((e) => events.push(e));

    mock.receiveLine(":irc 005 mojo PREFIX=(ov)@+ CHANTYPES=# :are supported");
    mock.receiveLine(":mojo!u@h JOIN #mojo2");
    mock.receiveLine(":grace!g@h JOIN #mojo2");
    await waitFor(() => client.channel("#mojo2")?.members.has("grace") === true);

    mock.receiveLine(":grace!g@h ACCOUNT graceAcct");
    await waitFor(() => events.some((e) => e.type === "account"));
    const acct = events.find((e) => e.type === "account");
    if (acct?.type === "account") {
      expect(acct.user.nick).toBe("grace");
      expect(acct.account).toBe("graceAcct");
    }
    expect(client.user("grace")?.account).toBe("graceAcct");
    client.quit();
  });
});
