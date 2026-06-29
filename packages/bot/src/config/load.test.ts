import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { loadConfig } from "./load.ts";
import { ConfigError } from "./validate.ts";

// Note: top-level keys (externalModules) must precede the [table] sections — in
// TOML, a key after a `[table]` header belongs to that table.
const SAMPLE = `
externalModules = ["./modules/karma.ts"]

[server]
host = "irc.androidirc.org"
port = 6697
nick = "mojojojo"
altNicks = ["mojojojo_"]
caps = "default"

[server.reconnect]
enabled = true
maxDelayMs = 30000

[bot]
prefix = "!"
owners = ["account:kester"]

[modules.ping]

[modules.admin]
allowRaw = false
`;

let dir: string;
let configPath: string;

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "mojo-bot-"));
  configPath = path.join(dir, "config.toml");
  writeFileSync(configPath, SAMPLE);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("loadConfig", () => {
  test("parses TOML (nested tables + arrays) into a typed config", async () => {
    const cfg = await loadConfig(configPath, {});
    expect(cfg.server).toMatchObject({
      host: "irc.androidirc.org",
      port: 6697,
      nick: "mojojojo",
      altNicks: ["mojojojo_"],
      caps: "default",
      reconnect: { enabled: true, maxDelayMs: 30000 },
    });
    expect(cfg.bot.prefix).toBe("!");
    expect(cfg.bot.owners).toEqual(["account:kester"]);
    expect(cfg.modules.ping?.enabled).toBe(true);
    expect(cfg.modules.admin?.options).toEqual({ allowRaw: false });
    expect(cfg.externalModules).toEqual(["./modules/karma.ts"]);
    expect(cfg.configDir).toBe(dir);
  });

  test("uses BOT_CONFIG when no path argument is given", async () => {
    const cfg = await loadConfig(undefined, { BOT_CONFIG: configPath });
    expect(cfg.server.host).toBe("irc.androidirc.org");
  });

  test("environment overrides win over the file", async () => {
    const cfg = await loadConfig(configPath, { IRC_NICK: "override", IRC_SASL_USER: "u", IRC_SASL_PASS: "p" });
    expect(cfg.server.nick).toBe("override");
    expect(cfg.server.sasl).toEqual({ mechanism: "PLAIN", username: "u", password: "p" });
  });

  test("a missing file throws ConfigError", async () => {
    await expectRejection(loadConfig(path.join(dir, "nope.toml"), {}), ConfigError);
  });

  test("invalid TOML throws ConfigError", async () => {
    const bad = path.join(dir, "bad.toml");
    writeFileSync(bad, "this is = = not valid");
    await expectRejection(loadConfig(bad, {}), ConfigError);
  });
});

/** Await a promise expected to reject, asserting the rejection's constructor. */
async function expectRejection(p: Promise<unknown>, ctor: new (...args: never[]) => Error): Promise<void> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(ctor);
    return;
  }
  throw new Error("expected promise to reject");
}
