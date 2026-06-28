import type { ISupport } from "../isupport/parseIsupport.ts";

// Parsing of channel MODE changes into discrete, parameter-resolved steps.
//
// A MODE message carries a mode string (`+ovk-l`) followed by parameters, where
// whether a given mode letter consumes a parameter depends on its CHANMODES
// group and whether it is being set or unset:
//
//   - status/prefix modes (PREFIX, e.g. o,v,h): always take a param (a nick)
//   - type A (list, e.g. bans):                  always take a param
//   - type B (e.g. key):                         always take a param
//   - type C (e.g. limit):                       param only when set (`+`)
//   - type D (e.g. moderated):                   never take a param
//   - unknown letters:                           assumed paramless (safe default)
//
// @see https://modern.ircdocs.horse/#mode-message

/** The role a mode letter plays, deciding its parameter consumption. */
export type ModeKind = "prefix" | "A" | "B" | "C" | "D" | "unknown";

/** A single resolved mode change extracted from a MODE string. */
export interface ModeChange {
  /** `true` for a `+mode`, `false` for a `-mode`. */
  readonly added: boolean;
  /** The single mode letter. */
  readonly mode: string;
  /** The parameter this change consumed, or `null` if it takes none. */
  readonly param: string | null;
  /** Which CHANMODES group / role the mode belongs to. */
  readonly kind: ModeKind;
}

/** Classify a mode letter using the server's PREFIX + CHANMODES. */
export function classifyMode(mode: string, isupport: ISupport): ModeKind {
  if (isupport.prefixes.some((p) => p.mode === mode)) return "prefix";
  const { a, b, c, d } = isupport.chanModes;
  if (a.includes(mode)) return "A";
  if (b.includes(mode)) return "B";
  if (c.includes(mode)) return "C";
  if (d.includes(mode)) return "D";
  return "unknown";
}

/** Does a mode of `kind` consume a parameter when added/removed? */
function takesParam(kind: ModeKind, added: boolean): boolean {
  switch (kind) {
    case "prefix":
    case "A":
    case "B":
      return true;
    case "C":
      return added; // param only on set
    case "D":
    case "unknown":
      return false;
  }
}

/**
 * Parse a channel MODE change into ordered {@link ModeChange}s, pulling
 * parameters from `params` as each mode requires. Surplus or missing params are
 * tolerated: a mode that needs a param but finds none gets `param: null`.
 *
 * @param modeString the mode segment, e.g. `+ovk-l`
 * @param params the parameter list that follows the mode segment
 */
export function parseModeChanges(
  modeString: string,
  params: readonly string[],
  isupport: ISupport,
): ModeChange[] {
  const changes: ModeChange[] = [];
  let added = true;
  let paramIndex = 0;

  for (const char of modeString) {
    if (char === "+") {
      added = true;
      continue;
    }
    if (char === "-") {
      added = false;
      continue;
    }
    const kind = classifyMode(char, isupport);
    let param: string | null = null;
    if (takesParam(kind, added)) {
      param = paramIndex < params.length ? params[paramIndex]! : null;
      if (param !== null) paramIndex++;
    }
    changes.push({ added, mode: char, param, kind });
  }

  return changes;
}
