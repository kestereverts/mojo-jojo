import { describe, expect, test } from "bun:test";
import { applyEnvOverrides, type Env } from "./env.ts";
import { ConfigError } from "./validate.ts";

function server(raw: Record<string, unknown>): Record<string, unknown> {
  return raw.server as Record<string, unknown>;
}

describe("applyEnvOverrides", () => {
  test("overrides host/nick/port and coerces port to a number", () => {
    const out = applyEnvOverrides({}, { IRC_HOST: "irc.x", IRC_NICK: "bot", IRC_PORT: "6697" });
    expect(server(out)).toMatchObject({ host: "irc.x", nick: "bot", port: 6697 });
  });

  test("env wins over file values", () => {
    const out = applyEnvOverrides({ server: { host: "from-toml", nick: "n" } }, { IRC_HOST: "from-env" });
    expect(server(out).host).toBe("from-env");
    expect(server(out).nick).toBe("n");
  });

  test("does not mutate the input", () => {
    const raw = { server: { host: "a" } };
    applyEnvOverrides(raw, { IRC_HOST: "b" });
    expect(raw.server.host).toBe("a");
  });

  test("IRC_PORT must be an integer (blank rejected, not coerced to 0)", () => {
    expect(() => applyEnvOverrides({}, { IRC_PORT: "abc" })).toThrow(ConfigError);
    expect(() => applyEnvOverrides({}, { IRC_PORT: "" })).toThrow(ConfigError);
    expect(() => applyEnvOverrides({}, { IRC_PORT: "  " })).toThrow(ConfigError);
  });

  describe("IRC_TLS / IRC_TLS_INSECURE", () => {
    const cases: Array<[Env, unknown]> = [
      [{ IRC_TLS: "1" }, true],
      [{ IRC_TLS: "true" }, true],
      [{ IRC_TLS: "0" }, false],
      [{ IRC_TLS: "false" }, false],
      [{ IRC_TLS_INSECURE: "1" }, { rejectUnauthorized: false }],
      [{ IRC_TLS: "1", IRC_TLS_INSECURE: "1" }, { rejectUnauthorized: false }],
      [{ IRC_TLS: "0", IRC_TLS_INSECURE: "1" }, false], // explicit plaintext wins
    ];
    for (const [env, expected] of cases) {
      test(`${JSON.stringify(env)} → ${JSON.stringify(expected)}`, () => {
        expect(server(applyEnvOverrides({}, env)).tls).toEqual(expected);
      });
    }

    test("no TLS env ⇒ no tls override", () => {
      expect(server(applyEnvOverrides({}, {})).tls).toBeUndefined();
    });

    test("invalid boolean token throws", () => {
      expect(() => applyEnvOverrides({}, { IRC_TLS: "yes" })).toThrow(ConfigError);
    });

    test("an empty IRC_TLS throws rather than silently downgrading to plaintext (B3)", () => {
      expect(() => applyEnvOverrides({}, { IRC_TLS: "" })).toThrow(ConfigError);
    });
  });

  describe("SASL", () => {
    test("both vars set ⇒ PLAIN", () => {
      const out = applyEnvOverrides({}, { IRC_SASL_USER: "u", IRC_SASL_PASS: "p" });
      expect(server(out).sasl).toEqual({ mechanism: "PLAIN", username: "u", password: "p" });
    });

    test("only one var set throws", () => {
      expect(() => applyEnvOverrides({}, { IRC_SASL_USER: "u" })).toThrow(ConfigError);
      expect(() => applyEnvOverrides({}, { IRC_SASL_PASS: "p" })).toThrow(ConfigError);
    });

    test("env PLAIN creds over a file EXTERNAL mechanism throw, not silently downgrade (B4)", () => {
      const raw = { server: { sasl: { mechanism: "EXTERNAL" } } };
      expect(() =>
        applyEnvOverrides(raw, { IRC_SASL_USER: "u", IRC_SASL_PASS: "p" }),
      ).toThrow(ConfigError);
    });

    test("env creds still fill in a file PLAIN block", () => {
      const raw = { server: { sasl: { mechanism: "PLAIN", username: "old" } } };
      const out = applyEnvOverrides(raw, { IRC_SASL_USER: "u", IRC_SASL_PASS: "p" });
      expect(server(out).sasl).toEqual({ mechanism: "PLAIN", username: "u", password: "p" });
    });
  });

  test("IRC_PASSWORD overrides server password", () => {
    expect(server(applyEnvOverrides({}, { IRC_PASSWORD: "s3cr3t" })).password).toBe("s3cr3t");
  });

  test("BOT_PREFIX and BOT_OWNERS (comma-split, trimmed, empties dropped)", () => {
    const out = applyEnvOverrides({}, { BOT_PREFIX: "?", BOT_OWNERS: "account:kester, mask:*!*@host ,, nick" });
    const bot = out.bot as Record<string, unknown>;
    expect(bot.prefix).toBe("?");
    expect(bot.owners).toEqual(["account:kester", "mask:*!*@host", "nick"]);
  });
});
