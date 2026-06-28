import { describe, expect, test } from "bun:test";
import { parseMessage } from "@mojo-jojo/irc-message";
import {
  CapabilityStore,
  parseCapMessage,
  reconcileCaps,
  type CapValue,
} from "./capabilities.ts";

const cap = (line: string) => parseCapMessage(parseMessage(line));

describe("parseCapMessage", () => {
  test("parses a single-line LS with values and valueless caps", () => {
    const result = cap(":irc.test CAP * LS :multi-prefix sasl=PLAIN,EXTERNAL server-time");
    expect(result).not.toBeNull();
    expect(result!.subcommand).toBe("LS");
    expect(result!.final).toBe(true);
    expect(result!.tokens).toEqual([
      { name: "multi-prefix", value: null, disabled: false },
      { name: "sasl", value: "PLAIN,EXTERNAL", disabled: false },
      { name: "server-time", value: null, disabled: false },
    ]);
  });

  test("flags a continued LS line (the `*` marker)", () => {
    const first = cap(":irc.test CAP * LS * :cap-a cap-b");
    const second = cap(":irc.test CAP * LS :cap-c");
    expect(first!.final).toBe(false);
    expect(first!.tokens.map((t) => t.name)).toEqual(["cap-a", "cap-b"]);
    expect(second!.final).toBe(true);
    expect(second!.tokens.map((t) => t.name)).toEqual(["cap-c"]);
  });

  test("parses ACK / NAK token lists", () => {
    expect(cap(":irc.test CAP mojo ACK :multi-prefix server-time")!.subcommand).toBe("ACK");
    expect(cap(":irc.test CAP mojo NAK :batch")!.tokens.map((t) => t.name)).toEqual(["batch"]);
  });

  test("recognizes a `-` disable modifier in ACK tokens", () => {
    const result = cap(":irc.test CAP mojo ACK :-away-notify");
    expect(result!.tokens).toEqual([{ name: "away-notify", value: null, disabled: true }]);
  });

  test("parses NEW / DEL (cap-notify)", () => {
    expect(cap(":irc.test CAP mojo NEW :sasl")!.subcommand).toBe("NEW");
    expect(cap(":irc.test CAP mojo DEL :sasl")!.subcommand).toBe("DEL");
  });

  test("returns null for non-CAP or unknown subcommands", () => {
    expect(cap(":irc.test 001 mojo :hi")).toBeNull();
    expect(cap(":irc.test CAP mojo WAT :x")).toBeNull();
  });
});

describe("reconcileCaps", () => {
  const available = new Map<string, CapValue>([
    ["multi-prefix", null],
    ["sasl", "PLAIN"],
    ["server-time", null],
  ]);

  test("intersects desired with available, preserving desired order", () => {
    expect(reconcileCaps(["server-time", "multi-prefix", "batch"], available, false)).toEqual([
      "server-time",
      "multi-prefix",
    ]);
  });

  test("drops sasl unless explicitly requested", () => {
    expect(reconcileCaps(["sasl", "multi-prefix"], available, false)).toEqual(["multi-prefix"]);
    expect(reconcileCaps(["sasl", "multi-prefix"], available, true)).toEqual([
      "sasl",
      "multi-prefix",
    ]);
  });

  test('"all" requests everything advertised (still filtering sasl)', () => {
    expect(reconcileCaps("all", available, false)).toEqual(["multi-prefix", "server-time"]);
    expect(reconcileCaps("all", available, true)).toEqual(["multi-prefix", "sasl", "server-time"]);
  });
});

describe("CapabilityStore", () => {
  test("tracks available caps and their values", () => {
    const store = new CapabilityStore();
    store.addAvailable([
      { name: "sasl", value: "PLAIN,EXTERNAL", disabled: false },
      { name: "multi-prefix", value: null, disabled: false },
    ]);
    expect(store.isAvailable("sasl")).toBe(true);
    expect(store.valueOf("sasl")).toBe("PLAIN,EXTERNAL");
    expect(store.valueOf("multi-prefix")).toBeNull();
  });

  test("applyAck enables plain tokens and disables `-` tokens", () => {
    const store = new CapabilityStore();
    store.applyAck([
      { name: "multi-prefix", value: null, disabled: false },
      { name: "server-time", value: null, disabled: false },
    ]);
    expect(store.isEnabled("multi-prefix")).toBe(true);
    store.applyAck([{ name: "multi-prefix", value: null, disabled: true }]);
    expect(store.isEnabled("multi-prefix")).toBe(false);
    expect(store.isEnabled("server-time")).toBe(true);
  });

  test("CAP DEL removes availability and disables the cap", () => {
    const store = new CapabilityStore();
    store.addAvailable([{ name: "sasl", value: "PLAIN", disabled: false }]);
    store.applyAck([{ name: "sasl", value: null, disabled: false }]);
    store.removeAvailable([{ name: "sasl", value: null, disabled: false }]);
    expect(store.isAvailable("sasl")).toBe(false);
    expect(store.isEnabled("sasl")).toBe(false);
  });

  test("snapshots are independent copies", () => {
    const store = new CapabilityStore();
    store.addAvailable([{ name: "sasl", value: "PLAIN", disabled: false }]);
    const snapshot = store.available;
    store.removeAvailable([{ name: "sasl", value: null, disabled: false }]);
    expect(snapshot.has("sasl")).toBe(true); // snapshot unaffected by later mutation
  });
});
