import { describe, expect, test } from "bun:test";
import { bootBot } from "../testing/botHarness.ts";
import { ctcpModule } from "./ctcp.ts";

const A = "\x01";

describe("ctcpModule", () => {
  test("replies to VERSION via NOTICE and rate-limits repeats", async () => {
    const h = await bootBot({ modules: { ctcp: { version: "mojo-test 1.0" } }, factories: { ctcp: ctcpModule } });
    h.send(`:alice!a@h PRIVMSG mojo :${A}VERSION${A}`);
    await h.awaitWritten((l) => l.startsWith("NOTICE alice") && l.includes("VERSION mojo-test 1.0"));
    const noticeCount = h.written().filter((l) => l.startsWith("NOTICE alice")).length;

    h.send(`:alice!a@h PRIVMSG mojo :${A}VERSION${A}`); // within the cooldown window
    await new Promise((r) => setTimeout(r, 20));
    expect(h.written().filter((l) => l.startsWith("NOTICE alice")).length).toBe(noticeCount);
    await h.stop();
  });

  test("PING echoes the token; TIME and CLIENTINFO reply", async () => {
    const h = await bootBot({ modules: { ctcp: {} }, factories: { ctcp: ctcpModule } });
    h.send(`:alice!a@h PRIVMSG mojo :${A}PING 12345${A}`);
    await h.awaitWritten((l) => l.startsWith("NOTICE alice") && l.includes("PING 12345"));
    h.send(`:bob!b@h PRIVMSG mojo :${A}CLIENTINFO${A}`);
    await h.awaitWritten((l) => l.startsWith("NOTICE bob") && l.includes("CLIENTINFO"));
    await h.stop();
  });

  test("ignores unknown CTCP and our own echo", async () => {
    const h = await bootBot({ modules: { ctcp: {} }, factories: { ctcp: ctcpModule } });
    h.send(`:alice!a@h PRIVMSG mojo :${A}FOOBAR${A}`); // unknown tag
    h.send(`:mojo!u@h PRIVMSG mojo :${A}VERSION${A}`); // our own echo
    await new Promise((r) => setTimeout(r, 20));
    expect(h.written().some((l) => l.startsWith("NOTICE"))).toBe(false);
    await h.stop();
  });
});
