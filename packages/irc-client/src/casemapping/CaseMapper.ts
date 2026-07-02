// Case-insensitive name comparison for nicks and channels.
//
// IRC compares nick/channel names case-insensitively, but *which* characters
// count as case-equivalent depends on the server's `CASEMAPPING` (advertised in
// ISUPPORT / 005). Because of IRC's Scandinavian origin, RFC 1459 treats the
// characters `{}|^` as the lowercase forms of `[]\~` respectively, on top of the
// usual ASCII `A-Z`. A {@link CaseMapper} folds a display name into a canonical
// key under one of these rules so two names that differ only by case map to the
// same key.
//
// @see https://modern.ircdocs.horse/#casemapping-parameter

/** The casemapping rules a server may advertise via ISUPPORT `CASEMAPPING`. */
export type CaseMapping = "ascii" | "rfc1459" | "rfc1459-strict";

/** The default when a server advertises no (or an unknown) `CASEMAPPING`. */
export const DEFAULT_CASE_MAPPING: CaseMapping = "rfc1459";

const CODE_A = 0x41; // 'A'
const CODE_Z = 0x5a; // 'Z'
const CODE_LBRACKET = 0x5b; // '[' -> '{'  (range [ \ ] is contiguous: 0x5b-0x5d)
const CODE_RBRACKET = 0x5d; // ']' -> '}'
const CODE_TILDE = 0x7e; // '~' -> '^'
const TO_LOWER_OFFSET = 0x20;

/**
 * Folds nick/channel names to a canonical key under a single {@link CaseMapping}.
 *
 * A `CaseMapper` is immutable — when the server changes `CASEMAPPING` (or it is
 * first learned at registration), construct a new one and re-key the affected
 * maps (see {@link IrcMap.rekey}).
 */
export class CaseMapper {
  readonly mapping: CaseMapping;

  constructor(mapping: CaseMapping = DEFAULT_CASE_MAPPING) {
    this.mapping = mapping;
  }

  /**
   * Fold `name` to its canonical (lowercased) key. Two names are the same
   * entity iff their normalized forms are equal.
   */
  normalize(name: string): string {
    const ascii = this.mapping === "ascii";
    // `rfc1459` additionally folds `~`->`^`; `rfc1459-strict` does not.
    const foldTilde = this.mapping === "rfc1459";
    // Fast path: scan for the first char that needs folding. The common case —
    // an already-lowercase nick/channel, checked several times per message — then
    // returns the input string unchanged with zero allocation.
    let i = 0;
    for (; i < name.length; i++) {
      const code = name.charCodeAt(i);
      if (
        (code >= CODE_A && code <= CODE_Z) ||
        (!ascii && code >= CODE_LBRACKET && code <= CODE_RBRACKET) ||
        (foldTilde && code === CODE_TILDE)
      ) {
        break;
      }
    }
    if (i === name.length) return name; // nothing to fold

    let out = name.slice(0, i);
    for (; i < name.length; i++) {
      let code = name.charCodeAt(i);
      if (code >= CODE_A && code <= CODE_Z) {
        code += TO_LOWER_OFFSET; // A-Z -> a-z
      } else if (!ascii && code >= CODE_LBRACKET && code <= CODE_RBRACKET) {
        code += TO_LOWER_OFFSET; // [ \ ]  ->  { | }
      } else if (foldTilde && code === CODE_TILDE) {
        code -= TO_LOWER_OFFSET; // ~ -> ^
      }
      out += String.fromCharCode(code);
    }
    return out;
  }

  /** True when `a` and `b` name the same entity under this mapping. */
  equals(a: string, b: string): boolean {
    return this.normalize(a) === this.normalize(b);
  }
}

/**
 * Coerce an ISUPPORT `CASEMAPPING` token value to a known {@link CaseMapping}.
 *
 * The strict RFC 1459 variant is accepted under both spellings seen in the wild:
 * the historical ISUPPORT-draft token `strict-rfc1459` (advertised by
 * Solanum/Charybdis/Hybrid) and the `rfc1459-strict` form; both normalize to the
 * internal `"rfc1459-strict"`.
 */
export function toCaseMapping(value: string | undefined): CaseMapping {
  switch (value) {
    case "ascii":
    case "rfc1459":
    case "rfc1459-strict":
      return value;
    case "strict-rfc1459":
      return "rfc1459-strict";
    default:
      return DEFAULT_CASE_MAPPING;
  }
}
