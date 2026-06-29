import { describe, expect, test } from "bun:test";
import { ConfigError, Validator, validateConfig } from "./validate.ts";

const DIR = "/tmp/cfg";

/** Run `validateConfig`, expecting a `ConfigError`, and return its issues. */
function issuesOf(raw: unknown): readonly string[] {
  try {
    validateConfig(raw, DIR);
  } catch (err) {
    if (err instanceof ConfigError) return err.issues;
    throw err;
  }
  throw new Error("expected validateConfig to throw");
}

describe("validateConfig", () => {
  test("accepts a minimal config and applies defaults", () => {
    const cfg = validateConfig({ server: { host: "irc.x", nick: "bot" } }, DIR);
    expect(cfg.server.host).toBe("irc.x");
    expect(cfg.server.nick).toBe("bot");
    expect(cfg.bot).toEqual({
      prefix: "!",
      owners: [],
      ignore: [],
      allowPrefixlessInPm: true,
      failOnModuleError: false,
      logLevel: "info",
    });
    expect(cfg.modules).toEqual({});
    expect(cfg.externalModules).toEqual([]);
    expect(cfg.configDir).toBe(DIR);
  });

  test("collects every problem, prefixed with its path", () => {
    const issues = issuesOf({ server: {} });
    expect(issues.some((i) => i.startsWith("server.host:"))).toBe(true);
    expect(issues.some((i) => i.startsWith("server.nick:"))).toBe(true);
  });

  test("rejects a non-table root", () => {
    expect(() => validateConfig("nope", DIR)).toThrow(ConfigError);
    expect(issuesOf(42)).toContain("config: expected a table");
  });

  test("rejects a non-integer port", () => {
    const issues = issuesOf({ server: { host: "h", nick: "n", port: "6697" } });
    expect(issues.some((i) => i.startsWith("server.port:"))).toBe(true);
  });

  test("caps: 'default' and 'all' pass; an array passes; unknown string fails", () => {
    expect(validateConfig({ server: { host: "h", nick: "n", caps: "default" } }, DIR).server.caps).toBe("default");
    expect(validateConfig({ server: { host: "h", nick: "n", caps: "all" } }, DIR).server.caps).toBe("all");
    expect(
      validateConfig({ server: { host: "h", nick: "n", caps: ["server-time"] } }, DIR).server.caps,
    ).toEqual(["server-time"]);
    expect(issuesOf({ server: { host: "h", nick: "n", caps: "modern" } }).some((i) => i.startsWith("server.caps:"))).toBe(true);
  });

  test("sasl: PLAIN needs username + password; EXTERNAL is bare; missing mechanism fails", () => {
    const plain = validateConfig(
      { server: { host: "h", nick: "n", sasl: { mechanism: "PLAIN", username: "u", password: "p" } } },
      DIR,
    );
    expect(plain.server.sasl).toEqual({ mechanism: "PLAIN", username: "u", password: "p" });

    const ext = validateConfig({ server: { host: "h", nick: "n", sasl: { mechanism: "EXTERNAL" } } }, DIR);
    expect(ext.server.sasl).toEqual({ mechanism: "EXTERNAL" });

    expect(issuesOf({ server: { host: "h", nick: "n", sasl: { mechanism: "PLAIN", username: "u" } } }).some((i) => i.includes("server.sasl.password"))).toBe(true);
    expect(issuesOf({ server: { host: "h", nick: "n", sasl: {} } }).some((i) => i.includes("server.sasl.mechanism"))).toBe(true);
  });

  test("tls: boolean and a table both pass", () => {
    expect(validateConfig({ server: { host: "h", nick: "n", tls: false } }, DIR).server.tls).toBe(false);
    expect(
      validateConfig({ server: { host: "h", nick: "n", tls: { rejectUnauthorized: false } } }, DIR).server.tls,
    ).toEqual({ rejectUnauthorized: false });
  });

  test("reconnect table maps recognized fields", () => {
    const cfg = validateConfig(
      { server: { host: "h", nick: "n", reconnect: { enabled: false, initialDelayMs: 2000 } } },
      DIR,
    );
    expect(cfg.server.reconnect).toEqual({ enabled: false, initialDelayMs: 2000 });
  });

  test("modules: presence enables; explicit enabled=false disables; options exclude `enabled`", () => {
    const cfg = validateConfig(
      { server: { host: "h", nick: "n" }, modules: { ping: {}, admin: { enabled: false, allowRaw: true } } },
      DIR,
    );
    expect(cfg.modules.ping?.enabled).toBe(true);
    expect(cfg.modules.ping?.options).toEqual({});
    expect(cfg.modules.admin?.enabled).toBe(false);
    expect(cfg.modules.admin?.options).toEqual({ allowRaw: true });
  });

  test("externalModules must be a string array", () => {
    const cfg = validateConfig(
      { server: { host: "h", nick: "n" }, externalModules: ["./a.ts", "pkg"] },
      DIR,
    );
    expect(cfg.externalModules).toEqual(["./a.ts", "pkg"]);
    expect(issuesOf({ server: { host: "h", nick: "n" }, externalModules: [1] }).some((i) => i.startsWith("externalModules"))).toBe(true);
  });

  test("invalid logLevel fails with the allowed set", () => {
    const issues = issuesOf({ server: { host: "h", nick: "n" }, bot: { logLevel: "loud" } });
    expect(issues.some((i) => i.startsWith("bot.logLevel:"))).toBe(true);
  });

  test("port must be within 1..65535", () => {
    expect(validateConfig({ server: { host: "h", nick: "n", port: 6667 } }, DIR).server.port).toBe(6667);
    for (const port of [0, -1, 70000]) {
      expect(issuesOf({ server: { host: "h", nick: "n", port } }).some((i) => i.startsWith("server.port:"))).toBe(true);
    }
  });

  test("empty/whitespace prefix is rejected", () => {
    expect(issuesOf({ server: { host: "h", nick: "n" }, bot: { prefix: "" } }).some((i) => i.startsWith("bot.prefix:"))).toBe(true);
    expect(issuesOf({ server: { host: "h", nick: "n" }, bot: { prefix: "  " } }).some((i) => i.startsWith("bot.prefix:"))).toBe(true);
  });

  test("reconnect rejects negative delays and factor < 1", () => {
    expect(issuesOf({ server: { host: "h", nick: "n", reconnect: { initialDelayMs: -5 } } }).some((i) => i.includes("reconnect.initialDelayMs"))).toBe(true);
    expect(issuesOf({ server: { host: "h", nick: "n", reconnect: { factor: 0.5 } } }).some((i) => i.includes("reconnect.factor"))).toBe(true);
    expect(issuesOf({ server: { host: "h", nick: "n", reconnect: { maxRetries: 1.5 } } }).some((i) => i.includes("reconnect.maxRetries"))).toBe(true);
  });

  test("tls of the wrong type names both valid shapes", () => {
    expect(issuesOf({ server: { host: "h", nick: "n", tls: "yes" } })).toContain("server.tls: expected a boolean or a table");
  });
});

describe("Validator", () => {
  test("requireString records on empty/non-string", () => {
    const v = new Validator();
    expect(v.requireString("ok", "a")).toBe("ok");
    v.requireString("", "b");
    v.requireString(5, "c");
    expect(v.issues).toEqual(["b: expected a non-empty string", "c: expected a non-empty string"]);
    expect(() => v.throwIfAny()).toThrow(ConfigError);
  });

  test("optStringArray flags non-string and empty elements by index", () => {
    const v = new Validator();
    expect(v.optStringArray(["a", "b"], "p")).toEqual(["a", "b"]);
    expect(v.optStringArray(["a", 2], "p")).toBeUndefined();
    expect(v.optStringArray(["a", "  "], "q")).toBeUndefined();
    expect(v.issues).toContain("p[1]: expected a non-empty string");
    expect(v.issues).toContain("q[1]: expected a non-empty string");
  });

  test("optEnum narrows to the allowed union", () => {
    const v = new Validator();
    expect(v.optEnum("info", "lvl", ["info", "warn"] as const)).toBe("info");
    expect(v.optEnum("nope", "lvl", ["info", "warn"] as const)).toBeUndefined();
    expect(v.issues).toContain("lvl: expected one of: info, warn");
  });

  test("range/bound helpers reject out-of-range values", () => {
    const v = new Validator();
    expect(v.optIntegerInRange(6697, "p", 1, 65535)).toBe(6697);
    expect(v.optIntegerInRange(0, "p", 1, 65535)).toBeUndefined();
    expect(v.optNonNegativeNumber(-1, "d")).toBeUndefined();
    expect(v.optNumberAtLeast(0.5, "f", 1)).toBeUndefined();
    expect(v.optNonNegativeInteger(1.5, "r")).toBeUndefined();
    expect(v.optNonEmptyString("  ", "s")).toBeUndefined();
    expect(v.issues.length).toBe(5);
  });
});
