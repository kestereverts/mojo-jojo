import { describe, expect, test } from "bun:test";
import { ConsoleLogger, type LogSink } from "./logger.ts";

function captureSink(): { sink: LogSink; lines: Array<[keyof LogSink, string]> } {
  const lines: Array<[keyof LogSink, string]> = [];
  const make = (level: keyof LogSink) => (message: unknown) => lines.push([level, String(message)]);
  return { sink: { debug: make("debug"), info: make("info"), warn: make("warn"), error: make("error") }, lines };
}

describe("ConsoleLogger", () => {
  test("filters messages below the configured level", () => {
    const { sink, lines } = captureSink();
    const log = new ConsoleLogger({ level: "warn", sink });
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");
    expect(lines.map(([lvl]) => lvl)).toEqual(["warn", "error"]);
  });

  test("level 'silent' suppresses everything", () => {
    const { sink, lines } = captureSink();
    const log = new ConsoleLogger({ level: "silent", sink });
    log.error("nope");
    expect(lines).toEqual([]);
  });

  test("child() appends scope with a colon and prefixes lines", () => {
    const { sink, lines } = captureSink();
    const log = new ConsoleLogger({ level: "info", scope: "bot", sink }).child("ping");
    log.info("hello");
    expect(lines).toEqual([["info", "[bot:ping] hello"]]);
  });

  test("a root logger with no scope does not prefix", () => {
    const { sink, lines } = captureSink();
    new ConsoleLogger({ level: "info", sink }).info("hi");
    expect(lines).toEqual([["info", "hi"]]);
  });
});
