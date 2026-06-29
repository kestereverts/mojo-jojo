import { describe, expect, test } from "bun:test";
import { buildMessage, parseMessage } from "@mojo-jojo/irc-message";
import {
  chunkSaslResponse,
  decodeBase64,
  encodeBase64,
  external,
  mechanismFor,
  plain,
  SaslSession,
  type SaslMechanism,
  type SaslStep,
} from "./sasl.ts";

// PLAIN's SASL separator is the NUL byte (U+0000).
const NUL = String.fromCharCode(0); // U+0000, no literal NUL byte in source

describe("SASL mechanisms", () => {
  test("PLAIN encodes authzid NUL authcid NUL passwd (empty authzid by default)", () => {
    const mech = plain("mojo", "hunter2");
    expect(mech.name).toBe("PLAIN");
    expect(mech.respond("")).toBe(`${NUL}mojo${NUL}hunter2`);
  });

  test("PLAIN honours an explicit authzid", () => {
    expect(plain("authcid", "pw", "authzid").respond("")).toBe(`authzid${NUL}authcid${NUL}pw`);
  });

  test("EXTERNAL sends an empty authzid by default", () => {
    const mech = external();
    expect(mech.name).toBe("EXTERNAL");
    expect(mech.respond("")).toBe("");
  });

  test("mechanismFor maps SaslOptions to the right mechanism", () => {
    expect(mechanismFor({ mechanism: "PLAIN", username: "u", password: "p" }).name).toBe("PLAIN");
    expect(mechanismFor({ mechanism: "EXTERNAL" }).name).toBe("EXTERNAL");
  });
});

describe("base64 helpers", () => {
  test("encode/decode round-trips ASCII and UTF-8", () => {
    expect(encodeBase64("foobar")).toBe("Zm9vYmFy");
    expect(decodeBase64("Zm9vYmFy")).toBe("foobar");
    const unicode = "héllo 💡 wörld";
    expect(decodeBase64(encodeBase64(unicode))).toBe(unicode);
  });

  test("empty string encodes to empty base64", () => {
    expect(encodeBase64("")).toBe("");
    expect(decodeBase64("")).toBe("");
  });

  test("encodes a PLAIN payload reversibly (NUL separators survive)", () => {
    const payload = `${NUL}mojo${NUL}hunter2`;
    expect(decodeBase64(encodeBase64(payload))).toBe(payload);
  });
});

describe("chunkSaslResponse", () => {
  const params = (lines: ReturnType<typeof chunkSaslResponse>): string[] =>
    lines.map((m) => m.params[0] ?? "");

  test("an empty response is a single AUTHENTICATE +", () => {
    const lines = chunkSaslResponse("");
    expect(lines).toHaveLength(1);
    expect(buildMessage(lines[0]!)).toBe("AUTHENTICATE +");
  });

  test("a short response is one line with no trailing +", () => {
    const lines = chunkSaslResponse("a".repeat(399));
    expect(params(lines)).toEqual(["a".repeat(399)]);
  });

  test("a response of exactly 400 bytes gets a trailing AUTHENTICATE +", () => {
    const lines = chunkSaslResponse("a".repeat(400));
    expect(params(lines)).toEqual(["a".repeat(400), "+"]);
  });

  test("a response of 401 bytes splits into 400 + 1 (no trailing +)", () => {
    const lines = chunkSaslResponse("a".repeat(401));
    expect(params(lines)).toEqual(["a".repeat(400), "a"]);
  });

  test("an exact multiple of 400 (800) terminates with a +", () => {
    const lines = chunkSaslResponse("a".repeat(800));
    expect(params(lines)).toEqual(["a".repeat(400), "a".repeat(400), "+"]);
  });
});

describe("SaslSession — PLAIN", () => {
  const feed = (session: SaslSession, line: string): SaslStep =>
    session.handle(parseMessage(line));

  test("opens with AUTHENTICATE PLAIN", () => {
    const session = new SaslSession(plain("mojo", "pw"));
    expect(buildMessage(session.start())).toBe("AUTHENTICATE PLAIN");
  });

  test("responds to the + prompt with the base64 payload, then succeeds on 903", () => {
    const session = new SaslSession(plain("mojo", "hunter2"));
    session.start();

    const step = feed(session, "AUTHENTICATE +");
    expect(step.type).toBe("send");
    if (step.type !== "send") throw new Error("unreachable");
    expect(step.messages).toHaveLength(1);
    const payload = step.messages[0]!.params[0]!;
    expect(decodeBase64(payload)).toBe(`${NUL}mojo${NUL}hunter2`);

    expect(feed(session, ":server 900 mojo mojo!u@h Mojo :now logged in").type).toBe("continue");
    const done = feed(session, ":server 903 mojo :SASL authentication successful");
    expect(done).toEqual({ type: "success", account: "Mojo" });
  });

  test("ignores further messages once finished", () => {
    const session = new SaslSession(plain("mojo", "pw"));
    feed(session, "AUTHENTICATE +");
    feed(session, ":server 903 mojo :ok");
    expect(feed(session, ":server 904 mojo :too late").type).toBe("continue");
  });
});

describe("SaslSession — EXTERNAL", () => {
  test("sends an empty response (AUTHENTICATE +) to the prompt", () => {
    const session = new SaslSession(external());
    expect(buildMessage(session.start())).toBe("AUTHENTICATE EXTERNAL");
    const step = session.handle(parseMessage("AUTHENTICATE +"));
    expect(step.type).toBe("send");
    if (step.type !== "send") throw new Error("unreachable");
    expect(buildMessage(step.messages[0]!)).toBe("AUTHENTICATE +");
  });
});

describe("SaslSession — failures", () => {
  const fails = (line: string, code: string): void => {
    const session = new SaslSession(plain("mojo", "pw"));
    session.handle(parseMessage("AUTHENTICATE +"));
    const step = session.handle(parseMessage(line));
    expect(step.type).toBe("failure");
    if (step.type !== "failure") throw new Error("unreachable");
    expect(step.code).toBe(code);
  };

  test("904 (bad credentials) is terminal", () => {
    fails(":server 904 mojo :SASL authentication failed", "904");
  });
  test("902 (nick locked) is terminal", () => {
    fails(":server 902 mojo :Account is locked", "902");
  });
  test("905 (too long) is terminal", () => {
    fails(":server 905 mojo :SASL message too long", "905");
  });
  test("906 (aborted) is terminal", () => {
    fails(":server 906 mojo :SASL aborted", "906");
  });

  test("907 (already authenticated) is treated as success", () => {
    const session = new SaslSession(plain("mojo", "pw"));
    const step = session.handle(parseMessage(":server 907 mojo :already authenticated"));
    expect(step.type).toBe("success");
  });

  test("908 (mechanism list) is informational; the following 904 fails", () => {
    const session = new SaslSession(plain("mojo", "pw"));
    expect(session.handle(parseMessage(":server 908 mojo PLAIN,EXTERNAL :are available")).type).toBe(
      "continue",
    );
    expect(session.handle(parseMessage(":server 904 mojo :no")).type).toBe("failure");
  });

  test("a malformed (non-base64) challenge fails the exchange without throwing", () => {
    const echo: SaslMechanism = { name: "ECHO", respond: (c) => c };
    const session = new SaslSession(echo);
    // `!!!!` is not valid base64; the session must report failure, not throw.
    const step = session.handle(parseMessage("AUTHENTICATE !!!!notbase64!!!!"));
    expect(step.type).toBe("failure");
    if (step.type !== "failure") throw new Error("unreachable");
    expect(step.code).toBe("PARSE");
  });
});

describe("SaslSession — challenge reassembly", () => {
  test("reassembles a server challenge split across 400-byte AUTHENTICATE lines", () => {
    // An echo mechanism reflects the decoded challenge straight back.
    const echo: SaslMechanism = { name: "ECHO", respond: (c) => c };
    const session = new SaslSession(echo);

    const challenge = "A".repeat(450);
    const encoded = encodeBase64(challenge); // 600 base64 chars
    expect(encoded.length).toBe(600);

    // Server delivers it as a 400-byte chunk then the remainder.
    expect(session.handle(parseMessage(`AUTHENTICATE ${encoded.slice(0, 400)}`)).type).toBe(
      "continue",
    );
    const step = session.handle(parseMessage(`AUTHENTICATE ${encoded.slice(400)}`));
    expect(step.type).toBe("send");
    if (step.type !== "send") throw new Error("unreachable");

    // The echoed response, reassembled, decodes back to the original challenge.
    const responseB64 = step.messages
      .map((m) => m.params[0]!)
      .filter((p) => p !== "+")
      .join("");
    expect(decodeBase64(responseB64)).toBe(challenge);
  });

  test("a never-terminating challenge is bounded and fails closed", () => {
    const echo: SaslMechanism = { name: "ECHO", respond: (c) => c };
    const session = new SaslSession(echo);
    const chunk = "A".repeat(400); // a 400-byte, non-'+' chunk => "more coming"
    let failed = false;
    for (let i = 0; i < 1000 && !failed; i++) {
      const step = session.handle(parseMessage(`AUTHENTICATE ${chunk}`));
      if (step.type === "failure") {
        failed = true;
        expect(step.code).toBe("TOOLONG"); // bounded before any handshake timeout
      }
    }
    expect(failed).toBe(true);
  });
});
