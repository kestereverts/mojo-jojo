import { toCaseMapping, type CaseMapping } from "../casemapping/CaseMapper.ts";

// Parsing of the ISUPPORT (numeric 005) tokens that describe a server's
// capabilities and limits. A registration burst typically sends several 005
// lines, so {@link parseIsupport} accumulates onto a previous snapshot.
//
// A token is one of:
//   KEY=value   set KEY to value
//   KEY         set KEY to an empty value (a boolean flag)
//   -KEY        negate KEY (reset it to the server/library default)
//
// Token *values* may contain `\xHH` hex escapes (used for characters that can't
// appear literally, e.g. a space in a value); these are unescaped here.
//
// @see https://modern.ircdocs.horse/#rplisupport-005
// @see https://defs.ircdocs.horse/defs/isupport

/** One `(modes)prefixes` pair from the ISUPPORT `PREFIX` token, e.g. `o`/`@`. */
export interface PrefixSpec {
  /** Channel mode letter (e.g. `o`, `v`). */
  readonly mode: string;
  /** Status prefix character (e.g. `@`, `+`). */
  readonly prefix: string;
}

/**
 * The four CHANMODES groups, which determine how many parameters a mode change
 * consumes (see {@link "../protocol/modeParser.ts"}).
 */
export interface ChanModes {
  /** Type A: list modes; always take a parameter (e.g. bans `b`). */
  readonly a: string;
  /** Type B: always take a parameter, set and unset (e.g. key `k`). */
  readonly b: string;
  /** Type C: take a parameter only when set (e.g. limit `l`). */
  readonly c: string;
  /** Type D: never take a parameter (e.g. moderated `m`). */
  readonly d: string;
}

/** A typed, accumulated view of a server's ISUPPORT tokens. */
export interface ISupport {
  /** Status prefixes, highest rank first (PREFIX order is significant). */
  readonly prefixes: readonly PrefixSpec[];
  /** CHANMODES groups. */
  readonly chanModes: ChanModes;
  /** Channel-type sigils, e.g. `#&`. */
  readonly chanTypes: string;
  /** Active casemapping (default `rfc1459`). */
  readonly caseMapping: CaseMapping;
  /** Network name, or `null` if not advertised. */
  readonly network: string | null;
  /** Max mode changes with parameters per MODE line (ISUPPORT `MODES`), or null. */
  readonly modesPerLine: number | null;
  /**
   * Every token seen, in raw form: `string` for `KEY=value`, `true` for a bare
   * `KEY` flag. Negated (`-KEY`) tokens are removed. The typed fields above are
   * derived from this; the long tail stays reachable here.
   */
  readonly raw: Readonly<Record<string, string | true>>;
}

/** Conventional defaults used before (or absent) a server's PREFIX/CHANMODES. */
const DEFAULT_PREFIXES: readonly PrefixSpec[] = [
  { mode: "o", prefix: "@" },
  { mode: "v", prefix: "+" },
];
const DEFAULT_CHAN_MODES: ChanModes = { a: "b", b: "k", c: "l", d: "imnpst" };
const DEFAULT_CHAN_TYPES = "#&";

/** An empty ISUPPORT snapshot with library defaults; the base for accumulation. */
export const EMPTY_ISUPPORT: ISupport = {
  prefixes: DEFAULT_PREFIXES,
  chanModes: DEFAULT_CHAN_MODES,
  chanTypes: DEFAULT_CHAN_TYPES,
  caseMapping: "rfc1459",
  network: null,
  modesPerLine: null,
  raw: {},
};

/** Unescape ISUPPORT `\xHH` hex sequences in a token value. */
function unescapeValue(value: string): string {
  if (!value.includes("\\x")) return value;
  return value.replace(/\\x([0-9A-Fa-f]{2})/g, (_match, hex: string) =>
    String.fromCharCode(parseInt(hex, 16)),
  );
}

/** Parse a `PREFIX=(modes)prefixes` value into ordered {@link PrefixSpec}s. */
function parsePrefix(value: string): readonly PrefixSpec[] {
  const match = /^\(([^)]*)\)(.*)$/.exec(value);
  if (!match) return DEFAULT_PREFIXES;
  const modes = match[1] ?? "";
  const prefixes = match[2] ?? "";
  if (modes.length === 0 || modes.length !== prefixes.length) return DEFAULT_PREFIXES;
  const specs: PrefixSpec[] = [];
  for (let i = 0; i < modes.length; i++) {
    specs.push({ mode: modes[i]!, prefix: prefixes[i]! });
  }
  return specs;
}

/** Parse a `CHANMODES=A,B,C,D` value into the four groups. */
function parseChanModes(value: string): ChanModes {
  const [a = "", b = "", c = "", d = ""] = value.split(",");
  return { a, b, c, d };
}

/**
 * Apply one or more ISUPPORT token strings (the middle params of a 005 line)
 * onto `previous`, returning a new {@link ISupport}. Pure: `previous` is not
 * mutated.
 */
export function parseIsupport(
  tokens: readonly string[],
  previous: ISupport = EMPTY_ISUPPORT,
): ISupport {
  const raw: Record<string, string | true> = { ...previous.raw };

  for (const token of tokens) {
    if (token.length === 0) continue;
    if (token.startsWith("-")) {
      delete raw[token.slice(1).toUpperCase()];
      continue;
    }
    const eq = token.indexOf("=");
    if (eq === -1) {
      raw[token.toUpperCase()] = true;
    } else {
      raw[token.slice(0, eq).toUpperCase()] = unescapeValue(token.slice(eq + 1));
    }
  }

  return deriveISupport(raw);
}

/** Build the typed view from a raw token record, applying defaults. */
function deriveISupport(raw: Record<string, string | true>): ISupport {
  const prefix = raw["PREFIX"];
  const chanModes = raw["CHANMODES"];
  const chanTypes = raw["CHANTYPES"];
  const caseMapping = raw["CASEMAPPING"];
  const network = raw["NETWORK"];
  const modes = raw["MODES"];

  const modesPerLine =
    typeof modes === "string" && modes.trim() !== "" && Number.isFinite(Number(modes))
      ? Number(modes)
      : null;

  // RFC defaults apply only when a token is *absent*. An explicitly empty value
  // (`PREFIX=` / `CHANTYPES=`) or a bare flag means the server supports none — it
  // must not silently fall back to the defaults, or we'd parse status modes /
  // classify channels the server said don't exist.
  return {
    prefixes:
      prefix === undefined
        ? DEFAULT_PREFIXES
        : typeof prefix === "string" && prefix !== ""
          ? parsePrefix(prefix)
          : [],
    chanModes: typeof chanModes === "string" ? parseChanModes(chanModes) : DEFAULT_CHAN_MODES,
    chanTypes:
      chanTypes === undefined ? DEFAULT_CHAN_TYPES : typeof chanTypes === "string" ? chanTypes : "",
    caseMapping: toCaseMapping(typeof caseMapping === "string" ? caseMapping : undefined),
    network: typeof network === "string" && network !== "" ? network : null,
    modesPerLine,
    raw,
  };
}

/** True when `name` begins with one of the server's channel-type sigils. */
export function isChannelName(name: string, isupport: ISupport): boolean {
  return name.length > 0 && isupport.chanTypes.includes(name[0]!);
}

/** Map a status prefix character (e.g. `@`) to its mode letter (e.g. `o`). */
export function prefixToMode(prefix: string, isupport: ISupport): string | undefined {
  return isupport.prefixes.find((p) => p.prefix === prefix)?.mode;
}

/** Map a mode letter (e.g. `o`) to its status prefix character (e.g. `@`). */
export function modeToPrefix(mode: string, isupport: ISupport): string | undefined {
  return isupport.prefixes.find((p) => p.mode === mode)?.prefix;
}
