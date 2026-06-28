import type { Message } from "@mojo-jojo/irc-message";

// IRCv3 capability negotiation helpers: parsing `CAP` messages, reconciling the
// desired set against what the server advertises, and a runtime store that
// tracks available/enabled caps as `CAP NEW`/`CAP DEL` arrive after registration.
//
// The control flow (LS -> REQ -> ACK/NAK -> END) lives in `registration.ts`;
// this module is the pure, unit-testable substrate it builds on.
//
// @see https://ircv3.net/specs/extensions/capability-negotiation

/** A capability's advertised value (`sasl=PLAIN,EXTERNAL`) or `null` when valueless. */
export type CapValue = string | null;

/** Recognized `CAP` subcommands (server -> client). */
export type CapSubcommand = "LS" | "ACK" | "NAK" | "NEW" | "DEL" | "LIST";

/** A single token from a `CAP` capability list, e.g. `sasl=PLAIN` or `-away-notify`. */
export interface CapToken {
  /** Capability name with any leading `-` modifier stripped. */
  readonly name: string;
  /** Advertised value (after `=`), or `null` when the token carries no value. */
  readonly value: CapValue;
  /** True when the token was prefixed with `-` (a disable, used in `ACK`). */
  readonly disabled: boolean;
}

/** A parsed `CAP` message. */
export interface CapMessage {
  /** The subcommand (`LS`, `ACK`, …). */
  readonly subcommand: CapSubcommand;
  /**
   * For `LS`/`LIST`, false when this line carried the `*` continuation marker
   * (more lines follow). Always true for single-shot subcommands.
   */
  readonly final: boolean;
  /** The capability tokens carried by this line. */
  readonly tokens: readonly CapToken[];
}

const CAP_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "LS",
  "ACK",
  "NAK",
  "NEW",
  "DEL",
  "LIST",
]);

/** Parse a single capability token (`name`, `name=value`, or `-name`). */
function parseCapToken(token: string): CapToken {
  const disabled = token.startsWith("-");
  const body = disabled ? token.slice(1) : token;
  const eq = body.indexOf("=");
  if (eq === -1) {
    return { name: body, value: null, disabled };
  }
  return { name: body.slice(0, eq), value: body.slice(eq + 1), disabled };
}

/** Split a space-separated capability list into tokens, ignoring blanks. */
function parseCapList(list: string | undefined): CapToken[] {
  if (!list) return [];
  const tokens: CapToken[] = [];
  for (const part of list.split(" ")) {
    if (part.length > 0) tokens.push(parseCapToken(part));
  }
  return tokens;
}

/**
 * Parse a `CAP` message into its subcommand, continuation flag, and tokens, or
 * `null` if it is not a recognizable `CAP` message.
 *
 * The wire shape is `CAP <client> <subcommand> [*] :<cap list>`, where the `*`
 * (only on `LS`/`LIST`) signals that more lines follow.
 */
export function parseCapMessage(message: Message): CapMessage | null {
  if (message.command !== "CAP") return null;
  const { params } = message;
  // params[0] is the client/nick ("*" pre-registration); the subcommand follows.
  const subcommand = params[1];
  if (subcommand === undefined || !CAP_SUBCOMMANDS.has(subcommand)) return null;

  // For LS/LIST a literal "*" param before the trailing list means "continued".
  const continued = params[2] === "*";
  const list = continued ? params[3] : params[2];

  return {
    subcommand: subcommand as CapSubcommand,
    final: !continued,
    tokens: parseCapList(list),
  };
}

/**
 * Capability dependencies: requesting the key cap implies its values, so they
 * are auto-added when advertised. `labeled-response` multi-line replies arrive
 * wrapped in a `BATCH`, so requesting it without `batch` would mean some replies
 * could not be reassembled — we pull `batch` in to match intent.
 */
const CAP_DEPENDENCIES: ReadonlyMap<string, readonly string[]> = new Map([
  ["labeled-response", ["batch"]],
]);

/**
 * Reconcile the capabilities we want against what the server advertised.
 *
 * With an explicit list, returns the subset the server offers, preserving the
 * list's order. With `"all"`, returns every advertised capability (in
 * advertisement order).
 *
 * `sasl` is treated specially so it always tracks intent: when `saslRequested`
 * is false it is dropped (no point enabling SASL with nothing to authenticate
 * with); when true it is always included if advertised — even if the caller's
 * explicit list omitted it — so configuring credentials is sufficient on its own
 * and never silently fails to request the cap.
 *
 * Capability dependencies (see {@link CAP_DEPENDENCIES}) are likewise auto-added
 * when advertised, so e.g. requesting `labeled-response` also requests `batch`.
 */
export function reconcileCaps(
  desired: readonly string[] | "all",
  available: ReadonlyMap<string, CapValue>,
  saslRequested: boolean,
): string[] {
  const candidates = desired === "all" ? [...available.keys()] : desired;
  const requested: string[] = [];
  for (const cap of candidates) {
    if (!available.has(cap)) continue;
    if (cap === "sasl" && !saslRequested) continue;
    requested.push(cap);
  }
  if (saslRequested && available.has("sasl") && !requested.includes("sasl")) {
    requested.push("sasl");
  }
  // Pull in dependencies of anything we're requesting (when advertised).
  for (const cap of [...requested]) {
    for (const dep of CAP_DEPENDENCIES.get(cap) ?? []) {
      if (available.has(dep) && !requested.includes(dep)) requested.push(dep);
    }
  }
  return requested;
}

/**
 * Tracks the capabilities a connection advertises (`available`) and has enabled
 * (`enabled`). Lives for the duration of a connection so post-registration
 * `CAP NEW`/`CAP DEL` notifications (the `cap-notify` extension) keep it current.
 */
export class CapabilityStore {
  readonly #available = new Map<string, CapValue>();
  readonly #enabled = new Set<string>();

  /** Record advertised capabilities from a `CAP LS`/`CAP NEW` line. */
  addAvailable(tokens: readonly CapToken[]): void {
    for (const token of tokens) this.#available.set(token.name, token.value);
  }

  /** Drop capabilities removed by a `CAP DEL` line (also disables them). */
  removeAvailable(tokens: readonly CapToken[]): void {
    for (const token of tokens) {
      this.#available.delete(token.name);
      this.#enabled.delete(token.name);
    }
  }

  /** Apply a `CAP ACK` line: enable plain tokens, disable `-`-prefixed ones. */
  applyAck(tokens: readonly CapToken[]): void {
    for (const token of tokens) {
      if (token.disabled) this.#enabled.delete(token.name);
      else this.#enabled.add(token.name);
    }
  }

  /** Whether a capability is currently advertised by the server. */
  isAvailable(name: string): boolean {
    return this.#available.has(name);
  }

  /** Whether a capability is currently enabled on this connection. */
  isEnabled(name: string): boolean {
    return this.#enabled.has(name);
  }

  /** The advertised value for a capability (e.g. `PLAIN,EXTERNAL` for `sasl`). */
  valueOf(name: string): CapValue | undefined {
    return this.#available.get(name);
  }

  /** Snapshot of advertised capabilities. */
  get available(): ReadonlyMap<string, CapValue> {
    return new Map(this.#available);
  }

  /** Snapshot of enabled capabilities. */
  get enabled(): ReadonlySet<string> {
    return new Set(this.#enabled);
  }
}
