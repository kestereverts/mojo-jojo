import { describe, expect, test } from "bun:test";
import {
  parseIsupport,
  isChannelName,
  prefixToMode,
  modeToPrefix,
  EMPTY_ISUPPORT,
} from "./parseIsupport.ts";

describe("parseIsupport", () => {
  test("parses PREFIX into ordered mode/prefix pairs (high rank first)", () => {
    const s = parseIsupport(["PREFIX=(qaohv)~&@%+"]);
    expect(s.prefixes).toEqual([
      { mode: "q", prefix: "~" },
      { mode: "a", prefix: "&" },
      { mode: "o", prefix: "@" },
      { mode: "h", prefix: "%" },
      { mode: "v", prefix: "+" },
    ]);
  });

  test("falls back to default PREFIX on a malformed value", () => {
    const s = parseIsupport(["PREFIX=garbage"]);
    expect(s.prefixes).toEqual([
      { mode: "o", prefix: "@" },
      { mode: "v", prefix: "+" },
    ]);
  });

  test("an explicitly empty PREFIX/CHANTYPES means none (not the RFC default)", () => {
    // Defaults apply only when the token is ABSENT; an explicit `=` (or bare flag)
    // says the server supports none, and must not silently restore the defaults.
    const empty = parseIsupport(["PREFIX=", "CHANTYPES="]);
    expect(empty.prefixes).toEqual([]);
    expect(empty.chanTypes).toBe("");

    const bare = parseIsupport(["PREFIX", "CHANTYPES"]);
    expect(bare.prefixes).toEqual([]);
    expect(bare.chanTypes).toBe("");

    // ...but a totally absent token still uses the RFC defaults.
    const absent = parseIsupport(["NETWORK=Test"]);
    expect(absent.prefixes).toEqual([
      { mode: "o", prefix: "@" },
      { mode: "v", prefix: "+" },
    ]);
    expect(absent.chanTypes).toBe("#&");
  });

  test("parses CHANMODES into A/B/C/D groups", () => {
    const s = parseIsupport(["CHANMODES=eIbq,k,flj,CFLMPQScgimnprstuz"]);
    expect(s.chanModes).toEqual({
      a: "eIbq",
      b: "k",
      c: "flj",
      d: "CFLMPQScgimnprstuz",
    });
  });

  test("parses CHANTYPES, NETWORK, CASEMAPPING, MODES", () => {
    const s = parseIsupport([
      "CHANTYPES=#&",
      "NETWORK=AndroidIRC",
      "CASEMAPPING=ascii",
      "MODES=4",
    ]);
    expect(s.chanTypes).toBe("#&");
    expect(s.network).toBe("AndroidIRC");
    expect(s.caseMapping).toBe("ascii");
    expect(s.modesPerLine).toBe(4);
  });

  test("CASEMAPPING defaults to rfc1459 when absent", () => {
    expect(parseIsupport(["NETWORK=X"]).caseMapping).toBe("rfc1459");
  });

  test("a bare KEY becomes a boolean flag in raw", () => {
    const s = parseIsupport(["WHOX", "SAFELIST"]);
    expect(s.raw["WHOX"]).toBe(true);
    expect(s.raw["SAFELIST"]).toBe(true);
  });

  test("accumulates across multiple 005 lines", () => {
    const first = parseIsupport(["PREFIX=(ov)@+", "CHANTYPES=#"]);
    const second = parseIsupport(["NETWORK=Test"], first);
    expect(second.prefixes).toHaveLength(2);
    expect(second.chanTypes).toBe("#");
    expect(second.network).toBe("Test");
  });

  test("negation (-KEY) resets a key to its default", () => {
    const first = parseIsupport(["CHANTYPES=#&+"]);
    expect(first.chanTypes).toBe("#&+");
    const second = parseIsupport(["-CHANTYPES"], first);
    expect(second.chanTypes).toBe("#&"); // back to default
    expect(second.raw["CHANTYPES"]).toBeUndefined();
  });

  test("unescapes \\xHH in values", () => {
    // \x20 is a space.
    const s = parseIsupport(["NETWORK=Two\\x20Words"]);
    expect(s.network).toBe("Two Words");
  });

  test("the raw token record is bounded against a flood of distinct keys", () => {
    // A hostile server streaming endless distinct 005 tokens must not grow `raw`
    // without bound. Known keys still parse; only brand-new keys past the cap drop.
    const tokens = Array.from({ length: 400 }, (_, i) => `KEY${i}=v`);
    const s = parseIsupport([...tokens, "PREFIX=(ov)@+"]);
    expect(Object.keys(s.raw).length).toBeLessThanOrEqual(256);
  });

  test("detects WHOX support from the bare WHOX token", () => {
    expect(parseIsupport(["WHOX", "CHANTYPES=#"]).whox).toBe(true);
    expect(parseIsupport(["CHANTYPES=#"]).whox).toBe(false);
    // negation turns it back off
    expect(parseIsupport(["-WHOX"], parseIsupport(["WHOX"])).whox).toBe(false);
  });

  test("EMPTY_ISUPPORT carries library defaults", () => {
    expect(EMPTY_ISUPPORT.chanTypes).toBe("#&");
    expect(EMPTY_ISUPPORT.caseMapping).toBe("rfc1459");
    expect(EMPTY_ISUPPORT.network).toBeNull();
  });
});

describe("ISupport helpers", () => {
  const s = parseIsupport(["PREFIX=(ov)@+", "CHANTYPES=#&"]);

  test("isChannelName checks CHANTYPES sigils", () => {
    expect(isChannelName("#chan", s)).toBe(true);
    expect(isChannelName("&local", s)).toBe(true);
    expect(isChannelName("nick", s)).toBe(false);
    expect(isChannelName("", s)).toBe(false);
  });

  test("prefixToMode / modeToPrefix round-trip", () => {
    expect(prefixToMode("@", s)).toBe("o");
    expect(prefixToMode("+", s)).toBe("v");
    expect(prefixToMode("~", s)).toBeUndefined();
    expect(modeToPrefix("o", s)).toBe("@");
    expect(modeToPrefix("v", s)).toBe("+");
    expect(modeToPrefix("q", s)).toBeUndefined();
  });
});
