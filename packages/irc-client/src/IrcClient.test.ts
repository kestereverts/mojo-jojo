import { describe, expect, test } from "bun:test";
import type { Message } from "@mojo-jojo/irc-message";
import { IrcClient } from "./IrcClient.ts";
import { MockTransport } from "./transport/MockTransport.ts";
import type { IrcClientOptions } from "./options.ts";
import type { LifecycleEvent } from "./events/lifecycle.ts";
import type { ClientEvent, IrcEvent, PrivmsgEvent } from "./events/types.ts";

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

describe("IrcClient — unified facade + actions (M5)", () => {
  test("top-level on() observes both lifecycle and protocol events", async () => {
    const mock = new MockTransport();
    const client = new IrcClient({
      host: "irc.test",
      nick: "mojo",
      tls: false,
      transport: () => mock,
      caps: [],
      floodDelayMs: 0,
    });
    const registeredNicks: string[] = [];
    const lifecycleTypes: string[] = [];
    const privmsgs: string[] = [];
    // Attach before connect so the lifecycle events aren't missed (no replay).
    client.on("connecting", (e) => lifecycleTypes.push(e.type));
    client.on("registered", (e) => registeredNicks.push(e.nick)); // narrows to RegisteredEvent
    client.on("privmsg", (e) => privmsgs.push(e.text)); // narrows to PrivmsgEvent

    const connected = client.connect();
    await waitFor(() => mock.written.some((l) => l.startsWith("USER")));
    mock.receiveLine(":irc 001 mojo :Welcome");
    await connected;
    expect(registeredNicks).toEqual(["mojo"]);
    expect(lifecycleTypes).toEqual(["connecting"]);

    mock.receiveLine(":alice!a@h PRIVMSG mojo :hey");
    await waitFor(() => privmsgs.length > 0);
    expect(privmsgs).toEqual(["hey"]);
    client.quit();
  });

  test("clientEvents$ carries protocol and lifecycle events together", async () => {
    const mock = new MockTransport();
    const client = new IrcClient({
      host: "irc.test",
      nick: "mojo",
      tls: false,
      transport: () => mock,
      caps: [],
      floodDelayMs: 0,
    });
    const types: ClientEvent["type"][] = [];
    client.clientEvents$.subscribe((e) => types.push(e.type));

    const connected = client.connect();
    await waitFor(() => mock.written.some((l) => l.startsWith("USER")));
    mock.receiveLine(":irc 001 mojo :Welcome");
    await connected;
    mock.receiveLine(":alice!a@h PRIVMSG mojo :hi");
    await waitFor(() => types.includes("privmsg"));

    expect(types).toContain("connecting");
    expect(types).toContain("connected");
    expect(types).toContain("registered");
    expect(types).toContain("privmsg");
    client.quit();
  });

  test("dual-surface parity: one PRIVMSG reaches channel, user, and client.on()", async () => {
    const { client, mock } = await registerClient();
    mock.receiveLine(":irc 005 mojo PREFIX=(ov)@+ CHANTYPES=# :are supported");
    mock.receiveLine(":mojo!u@h JOIN #mojo2");
    mock.receiveLine(":alice!a@h JOIN #mojo2");
    await waitFor(() => client.channel("#mojo2")?.members.has("alice") === true);

    const chan = client.channel("#mojo2")!;
    const user = client.user("alice")!;
    const fromChannel: string[] = [];
    const fromUser: string[] = [];
    const fromClient: string[] = [];
    chan.messages$.subscribe((e) => fromChannel.push(e.text));
    user.messages$.subscribe((e) => fromUser.push(e.text));
    client.on("privmsg", (e) => fromClient.push(e.text));

    mock.receiveLine(":alice!a@h PRIVMSG #mojo2 :parity");
    await waitFor(() => fromClient.length > 0);
    expect(fromChannel).toEqual(["parity"]);
    expect(fromUser).toEqual(["parity"]);
    expect(fromClient).toEqual(["parity"]);
    client.quit();
  });

  test("once() fires a single time; off() removes a handler by reference", async () => {
    const { client, mock } = await registerClient();
    const onceSeen: string[] = [];
    const onSeen: string[] = [];
    const handler = (e: PrivmsgEvent): void => void onSeen.push(e.text);
    client.once("privmsg", (e) => onceSeen.push(e.text));
    client.on("privmsg", handler);

    // messages$ emits before events$ for the same line, so when "two" lands on
    // messages$ the dispatch+facade for it has already run synchronously.
    const rawTexts: string[] = [];
    client.messages$.subscribe((m) => {
      if (m.command === "PRIVMSG") rawTexts.push(m.params[1]!);
    });

    mock.receiveLine(":a!a@h PRIVMSG mojo :one");
    await waitFor(() => rawTexts.includes("one"));
    client.off("privmsg", handler);
    mock.receiveLine(":a!a@h PRIVMSG mojo :two");
    await waitFor(() => rawTexts.includes("two"));

    expect(onceSeen).toEqual(["one"]); // once: only the first
    expect(onSeen).toEqual(["one"]); // off removed it before "two"
    client.quit();
  });

  test("action methods send the right wire commands through the queue", async () => {
    const { client, mock } = await registerClient();
    client.say("#chan", "hello there");
    client.notice("bob", "heads up");
    client.action("#chan", "waves");
    client.join("#chan", "key");
    client.part("#chan", "bye now");
    client.kick("#chan", "bob", "go away");
    client.setNick("mojo2");
    client.mode("#chan", "+o", "bob");
    client.topic("#chan", "new topic");
    client.invite("bob", "#chan");
    client.whois("bob");
    client.who("#chan");
    client.names("#chan");
    client.away("be right back");
    client.raw("CUSTOM", "a", "b");

    await waitFor(() => mock.written.includes("CUSTOM a b\r\n"));
    expect(mock.written).toContain("PRIVMSG #chan :hello there\r\n");
    expect(mock.written).toContain("NOTICE bob :heads up\r\n");
    expect(mock.written).toContain("PRIVMSG #chan :\x01ACTION waves\x01\r\n");
    expect(mock.written).toContain("JOIN #chan key\r\n");
    expect(mock.written).toContain("PART #chan :bye now\r\n");
    expect(mock.written).toContain("KICK #chan bob :go away\r\n");
    expect(mock.written).toContain("NICK mojo2\r\n");
    expect(mock.written).toContain("MODE #chan +o bob\r\n");
    expect(mock.written).toContain("TOPIC #chan :new topic\r\n");
    expect(mock.written).toContain("INVITE bob #chan\r\n");
    expect(mock.written).toContain("WHOIS bob\r\n");
    expect(mock.written).toContain("WHO #chan\r\n");
    expect(mock.written).toContain("NAMES #chan\r\n");
    expect(mock.written).toContain("AWAY :be right back\r\n");
    client.quit();
  });

  test("actions are a no-op before connect (no active queue)", () => {
    const mock = new MockTransport();
    const client = new IrcClient({
      host: "irc.test",
      nick: "mojo",
      tls: false,
      transport: () => mock,
      caps: [],
      floodDelayMs: 0,
    });
    client.say("#x", "early"); // before connect()
    expect(mock.written).toEqual([]);
  });

  test("quit() completes clientEvents$ and disposes on() handlers (no leak)", async () => {
    const { client, mock } = await registerClient();
    let completed = false;
    client.clientEvents$.subscribe({ complete: () => (completed = true) });
    const seen: string[] = [];
    client.on("privmsg", (e) => seen.push(e.text));

    mock.receiveLine(":a!a@h PRIVMSG mojo :before");
    await waitFor(() => seen.length === 1);

    client.quit();
    expect(completed).toBe(true); // merged firehose completes when its sources do
    expect(seen).toEqual(["before"]); // facade listeners disposed; nothing more arrives
  });

  test("on()/once() after quit() are safe no-ops (no retained listeners)", async () => {
    const { client } = await registerClient();
    client.quit();
    // The merged stream is already completed; registering must not throw, must
    // never fire, and must not retain the handler (subscription closes on subscribe).
    const seen: string[] = [];
    const unsubOn = client.on("privmsg", (e) => seen.push(e.text));
    const unsubOnce = client.once("registered", () => seen.push("registered"));
    expect(() => {
      unsubOn();
      unsubOnce();
    }).not.toThrow();
    expect(seen).toEqual([]);
  });
});

describe("IrcClient — labeled-response + chathistory (M6)", () => {
  const msg = (command: string, ...params: string[]): Message => ({
    tags: {},
    source: null,
    command,
    params,
  });

  /** The `@label=` value of the most recent labeled write. */
  function labelOf(mock: MockTransport): string {
    const line = [...mock.written].reverse().find((l) => l.startsWith("@label="));
    if (line === undefined) throw new Error("no labeled write found");
    return line.match(/@label=(\S+)/)![1]!;
  }

  /** Connect and negotiate `caps` so they show up in `enabledCaps`. */
  async function registerWithCaps(
    caps: string[],
  ): Promise<{ client: IrcClient; mock: MockTransport }> {
    const mock = new MockTransport();
    const client = new IrcClient({
      host: "irc.test",
      nick: "mojo",
      tls: false,
      transport: () => mock,
      caps,
      floodDelayMs: 0,
    });
    const connected = client.connect();
    await waitFor(() => mock.written.some((l) => l.startsWith("USER")));
    mock.receiveLine(`:irc CAP * LS :${caps.join(" ")}`);
    await waitFor(() => mock.written.some((l) => l.startsWith("CAP REQ")));
    mock.receiveLine(`:irc CAP mojo ACK :${caps.join(" ")}`);
    await waitFor(() => mock.written.includes("CAP END\r\n"));
    mock.receiveLine(":irc 001 mojo :Welcome");
    await connected;
    return { client, mock };
  }

  test("sendLabeled resolves [] on an ACK", async () => {
    const { client, mock } = await registerWithCaps(["labeled-response"]);
    const p = client.sendLabeled(msg("AWAY", "brb"));
    await waitFor(() => mock.written.some((l) => l.startsWith("@label=")));
    mock.receiveLine(`@label=${labelOf(mock)} :irc ACK`);
    expect(await p).toEqual([]);
    client.quit();
  });

  test("sendLabeled resolves a single labeled reply", async () => {
    const { client, mock } = await registerWithCaps(["labeled-response"]);
    const p = client.sendLabeled(msg("WHOIS", "bob"));
    await waitFor(() => mock.written.some((l) => l.startsWith("@label=")));
    mock.receiveLine(`@label=${labelOf(mock)} :irc 318 mojo bob :End of WHOIS`);
    const res = await p;
    expect(res).toHaveLength(1);
    expect(res[0]?.command).toBe("318");
    client.quit();
  });

  test("chatHistory resolves the labeled batch's inner messages", async () => {
    const { client, mock } = await registerWithCaps(["labeled-response", "batch", "server-time"]);
    const p = client.chatHistory("LATEST", "#chan", "*", "2");
    await waitFor(() => mock.written.some((l) => l.includes("CHATHISTORY")));
    const label = labelOf(mock);
    mock.receiveLine(`@label=${label} :irc BATCH +hh chathistory #chan`);
    mock.receiveLine(`@batch=hh :alice!a@h PRIVMSG #chan :old one`);
    mock.receiveLine(`@batch=hh :bob!b@h PRIVMSG #chan :old two`);
    mock.receiveLine(":irc BATCH -hh");
    const res = await p;
    expect(res.map((m) => m.command)).toEqual(["PRIVMSG", "PRIVMSG"]);
    expect(res.map((m) => m.params[1])).toEqual(["old one", "old two"]);
    client.quit();
  });

  test("sendLabeled rejects when labeled-response is not enabled", async () => {
    const { client } = await registerClient(); // caps: [] → cap not enabled
    let error: unknown;
    await client.sendLabeled(msg("AWAY", "x")).catch((e: unknown) => {
      error = e;
    });
    expect((error as Error).message).toContain("labeled-response");
    client.quit();
  });

  test("sendLabeled rejects on timeout", async () => {
    const { client } = await registerWithCaps(["labeled-response"]);
    let error: unknown;
    await client.sendLabeled(msg("AWAY", "x"), { timeoutMs: 20 }).catch((e: unknown) => {
      error = e;
    });
    expect((error as Error).message).toContain("timed out");
    client.quit();
  });

  test("sendLabeled rejects if the connection closes before the reply", async () => {
    const { client, mock } = await registerWithCaps(["labeled-response"]);
    let error: unknown;
    const p = client.sendLabeled(msg("AWAY", "x")).catch((e: unknown) => {
      error = e;
    });
    await waitFor(() => mock.written.some((l) => l.startsWith("@label=")));
    client.quit();
    await p;
    expect((error as Error).message).toContain("closed before response");
  });

  test("sendLabeled rejects if the connection drops before the reply", async () => {
    const { client, mock } = await registerWithCaps(["labeled-response"]);
    let error: unknown;
    const p = client.sendLabeled(msg("AWAY", "x")).catch((e: unknown) => {
      error = e;
    });
    await waitFor(() => mock.written.some((l) => l.startsWith("@label=")));
    mock.fail(new Error("socket hung up"));
    await p;
    expect((error as Error).message).toContain("connection dropped before response");
    client.quit();
  });

  test("enabledCaps clears during the reconnect window (no stale caps)", async () => {
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
      caps: ["labeled-response", "batch"],
      floodDelayMs: 0,
      reconnect: { enabled: true, initialDelayMs: 1, factor: 1, jitter: false, maxDelayMs: 5 },
    });
    const connected = client.connect();
    await waitFor(() => mocks.length === 1 && mocks[0]!.written.some((l) => l.startsWith("USER")));
    mocks[0]!.receiveLine(":irc CAP * LS :labeled-response batch");
    await waitFor(() => mocks[0]!.written.some((l) => l.startsWith("CAP REQ")));
    mocks[0]!.receiveLine(":irc CAP mojo ACK :labeled-response batch");
    await waitFor(() => mocks[0]!.written.includes("CAP END\r\n"));
    mocks[0]!.receiveLine(":irc 001 mojo :hi");
    await connected;
    expect(client.enabledCaps.has("labeled-response")).toBe(true);

    // Drop, then wait for the new attempt to start re-negotiating caps. In that
    // window the queue exists but registration isn't done — caps must read empty,
    // not the previous connection's set, so sendLabeled's guard correctly rejects.
    mocks[0]!.fail(new Error("reset"));
    await waitFor(
      () => mocks.length === 2 && mocks[1]!.written.some((l) => l.startsWith("CAP LS")),
      2000,
    );
    expect(client.enabledCaps.has("labeled-response")).toBe(false);
    let error: unknown;
    await client.sendLabeled(msg("AWAY", "x")).catch((e: unknown) => {
      error = e;
    });
    expect((error as Error).message).toContain("labeled-response");
    client.quit();
  });

  test("enabledCaps clears on an abnormal drop (no stale caps in the backoff gap)", async () => {
    // reconnect disabled: nothing re-registers, so this isolates the drop teardown.
    const mock = new MockTransport();
    const client = new IrcClient({
      host: "irc.test",
      nick: "mojo",
      tls: false,
      transport: () => mock,
      caps: ["labeled-response", "batch"],
      floodDelayMs: 0,
      reconnect: { enabled: false },
    });
    const connected = client.connect();
    await waitFor(() => mock.written.some((l) => l.startsWith("USER")));
    mock.receiveLine(":irc CAP * LS :labeled-response batch");
    await waitFor(() => mock.written.some((l) => l.startsWith("CAP REQ")));
    mock.receiveLine(":irc CAP mojo ACK :labeled-response batch");
    await waitFor(() => mock.written.includes("CAP END\r\n"));
    mock.receiveLine(":irc 001 mojo :hi");
    await connected;
    expect(client.enabledCaps.has("labeled-response")).toBe(true);

    // The drop teardown must clear caps immediately — not leave them stale until
    // some later attempt starts (there is no later attempt here).
    mock.fail(new Error("reset"));
    await waitFor(() => !client.enabledCaps.has("labeled-response"));
    expect([...client.enabledCaps]).toEqual([]);
    client.quit();
  });
});

describe("IrcClient — cap-notify (CAP NEW/DEL)", () => {
  /** Connect and negotiate an initial cap set (advertised == requested). */
  async function negotiate(
    optionCaps: string[],
    advertised: string[],
  ): Promise<{ client: IrcClient; mock: MockTransport }> {
    const mock = new MockTransport();
    const client = new IrcClient({
      host: "irc.test",
      nick: "mojo",
      tls: false,
      transport: () => mock,
      caps: optionCaps,
      floodDelayMs: 0,
    });
    const connected = client.connect();
    await waitFor(() => mock.written.some((l) => l.startsWith("USER")));
    mock.receiveLine(`:irc CAP * LS :${advertised.join(" ")}`);
    await waitFor(() => mock.written.some((l) => l.startsWith("CAP REQ")));
    // ACK exactly what we requested.
    const reqLine = mock.written.find((l) => l.startsWith("CAP REQ"))!;
    const acked = reqLine.replace("CAP REQ :", "").trim();
    mock.receiveLine(`:irc CAP mojo ACK :${acked}`);
    await waitFor(() => mock.written.includes("CAP END\r\n"));
    mock.receiveLine(":irc 001 mojo :hi");
    await connected;
    return { client, mock };
  }

  test("CAP DEL disables a cap, mirrors to server.caps, and emits a cap event", async () => {
    const { client, mock } = await negotiate(
      ["labeled-response", "batch", "away-notify"],
      ["labeled-response", "batch", "away-notify"],
    );
    const capEvents: Extract<ClientEvent, { type: "cap" }>[] = [];
    client.on("cap", (e) => capEvents.push(e));
    expect(client.enabledCaps.has("labeled-response")).toBe(true);

    mock.receiveLine(":irc CAP mojo DEL :labeled-response");
    await waitFor(() => !client.enabledCaps.has("labeled-response"));
    expect(client.server?.caps.has("labeled-response")).toBe(false);
    expect(
      capEvents.some((e) => e.subcommand === "DEL" && e.caps.includes("labeled-response")),
    ).toBe(true);

    // The guard now sees the cap is gone, so sendLabeled refuses.
    let error: unknown;
    await client
      .sendLabeled({ tags: {}, source: null, command: "AWAY", params: ["x"] })
      .catch((e: unknown) => {
        error = e;
      });
    expect((error as Error).message).toContain("labeled-response");
    client.quit();
  });

  test("CAP NEW auto-requests a wanted cap and ACK enables it (with deps)", async () => {
    // Want labeled-response+batch, but the server only advertises away-notify at first.
    const { client, mock } = await negotiate(
      ["away-notify", "labeled-response", "batch"],
      ["away-notify"],
    );
    expect(client.enabledCaps.has("away-notify")).toBe(true);
    expect(client.enabledCaps.has("labeled-response")).toBe(false);

    // Server advertises the new caps; the client should auto-REQ what it wants.
    mock.receiveLine(":irc CAP mojo NEW :labeled-response batch");
    await waitFor(() =>
      mock.written.some((l) => l.startsWith("CAP REQ") && l.includes("labeled-response")),
    );

    mock.receiveLine(":irc CAP mojo ACK :labeled-response batch");
    await waitFor(() => client.enabledCaps.has("labeled-response"));
    expect(client.enabledCaps.has("batch")).toBe(true);
    expect(client.server?.caps.has("labeled-response")).toBe(true);
    client.quit();
  });

  test("CAP NEW chunks a large auto-request under the IRC line limit", async () => {
    const mock = new MockTransport();
    const client = new IrcClient({
      host: "irc.test",
      nick: "mojo",
      tls: false,
      transport: () => mock,
      caps: "all", // want everything advertised
      floodDelayMs: 0,
    });
    const connected = client.connect();
    await waitFor(() => mock.written.some((l) => l.startsWith("USER")));
    mock.receiveLine(":irc CAP * LS :away-notify");
    await waitFor(() => mock.written.some((l) => l.startsWith("CAP REQ")));
    mock.receiveLine(":irc CAP mojo ACK :away-notify");
    await waitFor(() => mock.written.includes("CAP END\r\n"));
    mock.receiveLine(":irc 001 mojo :hi");
    await connected;

    const before = mock.written.length;
    // 24 caps × 16 chars = 407 chars of names: the inbound NEW stays under the
    // 510-byte parse limit, but the outbound CAP REQ would exceed MAX_CAP_REQ_LEN
    // (400) if sent as one line — so it must be split into multiple CAP REQ lines.
    const many = Array.from({ length: 24 }, (_, i) => `cap${i}`.padEnd(16, "x"));
    mock.receiveLine(`:irc CAP mojo NEW :${many.join(" ")}`);
    await waitFor(() => mock.written.slice(before).some((l) => l.startsWith("CAP REQ")));

    const reqs = mock.written.slice(before).filter((l) => l.startsWith("CAP REQ"));
    expect(reqs.length).toBeGreaterThan(1); // split across chunks
    for (const line of reqs) expect(line.length).toBeLessThanOrEqual(512); // never overlong
    const all = reqs.join(" ");
    for (const cap of many) expect(all).toContain(cap); // every cap still requested
    client.quit();
  });

  test("CAP NEW only requests the caps it announced that we want (no backlog)", async () => {
    // Want labeled-response, but the server only advertises away-notify initially.
    const { client, mock } = await negotiate(
      ["away-notify", "labeled-response", "batch"],
      ["away-notify"],
    );

    // A NEW for a cap we don't want triggers no request.
    let before = mock.written.length;
    mock.receiveLine(":irc CAP mojo NEW :some-unwanted-cap");
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(mock.written.slice(before).some((l) => l.startsWith("CAP REQ"))).toBe(false);

    // A NEW for a wanted cap requests exactly that — not the whole desired set.
    before = mock.written.length;
    mock.receiveLine(":irc CAP mojo NEW :labeled-response");
    await waitFor(() => mock.written.slice(before).some((l) => l.startsWith("CAP REQ")));
    const req = mock.written.slice(before).find((l) => l.startsWith("CAP REQ"))!;
    expect(req).toContain("labeled-response");
    expect(req).not.toContain("some-unwanted-cap");
    client.quit();
  });

  test("CAP NEW pulls in a dependency advertised earlier but not enabled", async () => {
    // Want labeled-response; at registration the server advertised only `batch`,
    // so nothing was requested. A later NEW for labeled-response must request its
    // `batch` dependency too (matching registration's dependency reconciliation).
    const mock = new MockTransport();
    const client = new IrcClient({
      host: "irc.test",
      nick: "mojo",
      tls: false,
      transport: () => mock,
      caps: ["labeled-response"],
      floodDelayMs: 0,
    });
    const connected = client.connect();
    await waitFor(() => mock.written.some((l) => l.startsWith("USER")));
    mock.receiveLine(":irc CAP * LS :batch"); // labeled-response not yet offered
    await new Promise((resolve) => setTimeout(resolve, 10));
    mock.receiveLine(":irc 001 mojo :hi"); // 001 concludes registration
    await connected;
    expect(client.enabledCaps.has("labeled-response")).toBe(false);

    const before = mock.written.length;
    mock.receiveLine(":irc CAP mojo NEW :labeled-response");
    await waitFor(() => mock.written.slice(before).some((l) => l.startsWith("CAP REQ")));
    const req = mock.written
      .slice(before)
      .filter((l) => l.startsWith("CAP REQ"))
      .join(" ");
    expect(req).toContain("labeled-response");
    expect(req).toContain("batch"); // dependency pulled in
    client.quit();
  });
});

describe("IrcClient — outbound safety", () => {
  const LF = String.fromCharCode(10);
  const CR = String.fromCharCode(13);

  test("actions throw on a newline-injection attempt (no extra command reaches the wire)", async () => {
    const { client, mock } = await registerClient();
    const before = mock.written.length;
    expect(() => client.say("#mojo2", `hello${LF}KICK #mojo2 victim`)).toThrow(/CR, LF, or NUL/);
    expect(() => client.raw("PRIVMSG", "#mojo2", `x${CR}y`)).toThrow();
    expect(() => client.topic("#mojo2", `t${LF}MODE #mojo2 +o evil`)).toThrow();
    // Nothing from those attempts was written.
    expect(mock.written.slice(before)).toEqual([]);
    client.quit();
  });

  test("an over-long action throws rather than emitting an invalid line", async () => {
    const { client } = await registerClient();
    expect(() => client.say("#mojo2", "x".repeat(600))).toThrow(/IRC line limit/);
    client.quit();
  });

  test("quit() is robust to a hostile reason (stripped, single line, no throw)", async () => {
    const { client, mock } = await registerClient();
    expect(() => client.quit(`bye${LF}KICK #mojo2 victim`)).not.toThrow();
    const quitLine = mock.written.find((l) => l.startsWith("QUIT"));
    expect(quitLine).toBeDefined();
    expect(quitLine!).toBe("QUIT :byeKICK #mojo2 victim\r\n"); // newline stripped, one line
    // No standalone injected KICK line was written.
    expect(mock.written.some((l) => l.startsWith("KICK"))).toBe(false);
    expect(client.state).toBe("closed");
  });
});
