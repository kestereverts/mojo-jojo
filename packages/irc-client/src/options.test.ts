import { describe, expect, test } from "bun:test";
import { DEFAULT_CAPS, resolveOptions } from "./options.ts";
import { BunSocketTransport } from "./transport/BunSocketTransport.ts";

describe("resolveOptions", () => {
  test("requires host and nick", () => {
    expect(() => resolveOptions({ host: "", nick: "mojo" })).toThrow("`host` is required");
    expect(() => resolveOptions({ host: "irc.test", nick: "  " })).toThrow("`nick` is required");
  });

  test("defaults the port from the TLS setting", () => {
    expect(resolveOptions({ host: "irc.test", nick: "mojo" }).port).toBe(6697); // TLS on by default
    expect(resolveOptions({ host: "irc.test", nick: "mojo", tls: false }).port).toBe(6667);
    expect(resolveOptions({ host: "irc.test", nick: "mojo", port: 7000 }).port).toBe(7000);
  });

  test("defaults username and realName to the nick", () => {
    const resolved = resolveOptions({ host: "irc.test", nick: "mojo" });
    expect(resolved.username).toBe("mojo");
    expect(resolved.realName).toBe("mojo");
  });

  test("defaults caps to the curated set", () => {
    expect(resolveOptions({ host: "irc.test", nick: "mojo" }).caps).toBe(DEFAULT_CAPS);
    expect(resolveOptions({ host: "irc.test", nick: "mojo", caps: "all" }).caps).toBe("all");
  });

  test("merges reconnect overrides over the defaults", () => {
    const resolved = resolveOptions({
      host: "irc.test",
      nick: "mojo",
      reconnect: { initialDelayMs: 250, jitter: false },
    });
    expect(resolved.reconnect.initialDelayMs).toBe(250);
    expect(resolved.reconnect.jitter).toBe(false);
    expect(resolved.reconnect.enabled).toBe(true); // untouched default
    expect(resolved.reconnect.factor).toBe(2);
  });

  test("synthesizes a BunSocketTransport factory when none is given", () => {
    const resolved = resolveOptions({ host: "irc.test", nick: "mojo", tls: false });
    expect(resolved.transportFactory()).toBeInstanceOf(BunSocketTransport);
  });

  test("keeps an injected transport factory", () => {
    const factory = () => new BunSocketTransport({ hostname: "x", port: 1 });
    expect(resolveOptions({ host: "irc.test", nick: "mojo", transport: factory }).transportFactory).toBe(
      factory,
    );
  });
});
