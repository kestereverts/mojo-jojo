import { describe, expect, test } from "bun:test";
import type { TransportFactory } from "@mojo-jojo/irc-client";
import { toIrcClientOptions } from "./toIrcClientOptions.ts";
import type { ServerConfig } from "./schema.ts";

const base: ServerConfig = { host: "irc.x", nick: "bot" };

describe("toIrcClientOptions", () => {
  test("minimal config maps host + nick only", () => {
    const opts = toIrcClientOptions(base);
    expect(opts).toEqual({ host: "irc.x", nick: "bot" });
  });

  test("caps 'default' is omitted (client applies DEFAULT_CAPS)", () => {
    const opts = toIrcClientOptions({ ...base, caps: "default" });
    expect(Object.hasOwn(opts, "caps")).toBe(false);
  });

  test("caps 'all' and explicit lists pass through", () => {
    expect(toIrcClientOptions({ ...base, caps: "all" }).caps).toBe("all");
    expect(toIrcClientOptions({ ...base, caps: ["server-time", "sasl"] }).caps).toEqual([
      "server-time",
      "sasl",
    ]);
  });

  test("scalar + structured fields pass through", () => {
    const opts = toIrcClientOptions({
      ...base,
      port: 6667,
      tls: false,
      username: "ident",
      realName: "Mojo Jojo",
      altNicks: ["bot_", "bot__"],
      password: "pw",
      sasl: { mechanism: "EXTERNAL" },
      whoOnJoin: true,
      reconnect: { enabled: false },
    });
    expect(opts).toMatchObject({
      port: 6667,
      tls: false,
      username: "ident",
      realName: "Mojo Jojo",
      altNicks: ["bot_", "bot__"],
      password: "pw",
      sasl: { mechanism: "EXTERNAL" },
      whoOnJoin: true,
      reconnect: { enabled: false },
    });
  });

  test("a tls table passes through", () => {
    expect(toIrcClientOptions({ ...base, tls: { rejectUnauthorized: false } }).tls).toEqual({
      rejectUnauthorized: false,
    });
  });

  test("the transport factory is injected when provided", () => {
    const transport = (() => {
      throw new Error("not called");
    }) as unknown as TransportFactory;
    expect(toIrcClientOptions(base, { transport }).transport).toBe(transport);
    expect(Object.hasOwn(toIrcClientOptions(base), "transport")).toBe(false);
  });
});
