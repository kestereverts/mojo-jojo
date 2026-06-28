import { describe, expect, test } from "bun:test";
import { Subject } from "rxjs";
import { buildMessage, parseMessage, type Message } from "@mojo-jojo/irc-message";
import {
  register,
  RegistrationError,
  type RegistrationOptions,
  type RegistrationResult,
} from "./registration.ts";

interface Harness {
  readonly sent: Message[];
  lines(): string[];
  feed(line: string): void;
  fail(error: Error): void;
  end(): void;
  readonly result: Promise<RegistrationResult>;
}

function harness(overrides: Partial<RegistrationOptions> = {}): Harness {
  const messages$ = new Subject<Message>();
  const sent: Message[] = [];
  const options: RegistrationOptions = {
    nick: "mojo",
    username: "mojo",
    realName: "Mojo Jojo",
    desiredCaps: [],
    timeoutMs: 1000,
    ...overrides,
  };
  const result = register({ messages$, send: (m) => sent.push(m) }, options);
  return {
    sent,
    lines: () => sent.map(buildMessage),
    feed: (line) => messages$.next(parseMessage(line)),
    fail: (error) => messages$.error(error),
    end: () => messages$.complete(),
    result,
  };
}

describe("register", () => {
  test("sends the opening handshake immediately (CAP LS, NICK, USER)", () => {
    const h = harness();
    expect(h.lines()).toEqual(["CAP LS 302", "NICK mojo", "USER mojo 0 * :Mojo Jojo"]);
    h.feed(":irc 001 mojo :hi");
    return h.result;
  });

  test("sends PASS first when a password is configured", () => {
    const h = harness({ password: "hunter2" });
    expect(h.lines()[0]).toBe("PASS hunter2");
    h.feed(":irc 001 mojo :hi");
    return h.result;
  });

  test("negotiates the intersection of desired and advertised caps", async () => {
    const h = harness({ desiredCaps: ["multi-prefix", "server-time", "batch"] });
    h.feed(":irc CAP * LS :multi-prefix server-time sasl=PLAIN");
    expect(h.lines()).toContain("CAP REQ :multi-prefix server-time");
    h.feed(":irc CAP mojo ACK :multi-prefix server-time");
    expect(h.lines()).toContain("CAP END");
    h.feed(":irc 001 mojo :Welcome");
    const result = await h.result;
    expect(result.capabilities.isEnabled("multi-prefix")).toBe(true);
    expect(result.capabilities.isEnabled("server-time")).toBe(true);
  });

  test("accumulates multi-line CAP LS before requesting", async () => {
    const h = harness({ desiredCaps: ["cap-a", "cap-b"] });
    h.feed(":irc CAP * LS * :cap-a");
    expect(h.lines()).not.toContain("CAP REQ :cap-a"); // still waiting for continuation
    h.feed(":irc CAP * LS :cap-b");
    expect(h.lines()).toContain("CAP REQ :cap-a cap-b");
    h.feed(":irc CAP mojo ACK :cap-a cap-b");
    h.feed(":irc 001 mojo :hi");
    await h.result;
  });

  test("ends negotiation immediately when no desired cap is available", async () => {
    const h = harness({ desiredCaps: ["batch"] });
    h.feed(":irc CAP * LS :multi-prefix server-time");
    expect(h.lines()).toContain("CAP END");
    expect(h.lines().some((l) => l.startsWith("CAP REQ"))).toBe(false);
    h.feed(":irc 001 mojo :hi");
    await h.result;
  });

  test("a NAK still concludes negotiation with CAP END", async () => {
    const h = harness({ desiredCaps: ["batch"] });
    h.feed(":irc CAP * LS :batch");
    // A single-token REQ needs no trailing colon (builder normalizes it away).
    expect(h.lines()).toContain("CAP REQ batch");
    h.feed(":irc CAP mojo NAK :batch");
    expect(h.lines()).toContain("CAP END");
    h.feed(":irc 001 mojo :hi");
    const result = await h.result;
    expect(result.capabilities.isEnabled("batch")).toBe(false);
  });

  test("falls back through altNicks on 433, then numeric suffix", async () => {
    const h = harness({ nick: "mojo", altNicks: ["mojo_"] });
    h.feed(":irc 433 * mojo :Nickname is already in use");
    expect(h.lines()).toContain("NICK mojo_");
    h.feed(":irc 433 * mojo_ :Nickname is already in use");
    expect(h.lines()).toContain("NICK mojo2"); // suffix fallback after altNicks exhausted
    h.feed(":irc 001 mojo2 :Welcome");
    const result = await h.result;
    expect(result.nick).toBe("mojo2");
  });

  test("treats a 421 for CAP as a legacy server and never sends CAP END", async () => {
    const h = harness({ desiredCaps: ["multi-prefix"] });
    h.feed(":irc 421 mojo CAP :Unknown command");
    h.feed(":irc 001 mojo :Welcome");
    await h.result;
    expect(h.lines().some((l) => l === "CAP END")).toBe(false);
  });

  test("resolves on 001 with the server-accepted nick", async () => {
    const h = harness({ nick: "requested" });
    h.feed(":irc 001 actual :Welcome");
    const result = await h.result;
    expect(result.nick).toBe("actual");
    expect(result.welcome.command).toBe("001");
  });

  test("rejects on a fatal registration numeric (432)", async () => {
    const h = harness();
    h.feed(":irc 432 * b@dnick :Erroneous nickname");
    let caught: unknown;
    await h.result.catch((e: unknown) => {
      caught = e;
    });
    expect(caught).toBeInstanceOf(RegistrationError);
  });

  test("rejects immediately on a bad password (464), without waiting for timeout", async () => {
    const h = harness({ password: "wrong", timeoutMs: 5000 });
    h.feed(":irc 464 * :Password incorrect");
    let caught: unknown;
    await h.result.catch((e: unknown) => {
      caught = e;
    });
    expect(caught).toBeInstanceOf(RegistrationError);
    expect((caught as RegistrationError).message).toContain("464");
  });

  test("rejects on a ban (465)", async () => {
    const h = harness();
    h.feed(":irc 465 * :You are banned from this server");
    let caught: unknown;
    await h.result.catch((e: unknown) => {
      caught = e;
    });
    expect(caught).toBeInstanceOf(RegistrationError);
  });

  test("rejects when the connection drops mid-registration", async () => {
    const h = harness();
    h.fail(new Error("reset"));
    let caught: unknown;
    await h.result.catch((e: unknown) => {
      caught = e;
    });
    expect(caught).toBeInstanceOf(RegistrationError);
    expect((caught as RegistrationError).cause?.message).toBe("reset");
  });

  test("rejects on timeout when 001 never arrives", async () => {
    const h = harness({ timeoutMs: 20 });
    let caught: unknown;
    await h.result.catch((e: unknown) => {
      caught = e;
    });
    expect(caught).toBeInstanceOf(RegistrationError);
    expect((caught as RegistrationError).message).toContain("timed out");
  });
});
