import type { CaseMapper, PrivmsgEvent } from "@mojo-jojo/irc-client";

// Identity matching for a PRIVMSG sender against a matcher pattern. Shared by the
// ignore list (M2) and owner/permission checks (M3).
//
// Pattern forms (strongest first):
//   account:<name>   — exact match on the message account-tag (preferred; needs services/SASL)
//   mask:<n!u@h>      — glob (`*`/`?`) match on the sender's nick!user@host
//   <bare>           — case-insensitive nick match (casemapping-aware; spoofable)

const ACCOUNT_PREFIX = "account:";
const MASK_PREFIX = "mask:";

/**
 * Normalize an account value to a real account or `null`. The message-scoped
 * `account-tag` arrives raw, so a logged-out sender can present `"*"` (and some
 * paths `""`); treat both as "no account" so logged-out users never share identity.
 */
export function normalizeAccount(account: string | null | undefined): string | null {
  if (account === null || account === undefined || account === "" || account === "*") return null;
  return account;
}

/**
 * The sender's effective account, per IRCv3 precedence: a PRESENT message account-tag
 * is authoritative — including `*`/`""`, which mean "logged out" (→ `null`). Only when
 * the message carries no tag at all do we fall back to the cached entity account.
 * (`event.account` is the raw tag value, or `null` when there is no tag.)
 */
export function resolveAccount(event: PrivmsgEvent): string | null {
  if (event.account !== null) return normalizeAccount(event.account);
  return normalizeAccount(event.user.account);
}

// Compiled-glob cache (masks come from fixed config lists, so this stays small).
const GLOB_CACHE = new Map<string, RegExp>();
const GLOB_CACHE_MAX = 256;

/** Build (memoized) a case-insensitive RegExp from an IRC glob (`*` = any run, `?` = one char). */
function globToRegExp(glob: string): RegExp {
  const cached = GLOB_CACHE.get(glob);
  if (cached) return cached;
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const pattern = escaped.replace(/\*/g, ".*").replace(/\?/g, ".");
  const compiled = new RegExp(`^${pattern}$`, "i");
  if (GLOB_CACHE.size < GLOB_CACHE_MAX) GLOB_CACHE.set(glob, compiled);
  return compiled;
}

function asciiEqualsIgnoreCase(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function matchesMask(event: PrivmsgEvent, mask: string, caseMapper: CaseMapper | null): boolean {
  const { nick, username, host } = event.user;
  // Fail closed: an unknown user/host must never match a wildcard.
  if (username === null || host === null) return false;
  const fold = (s: string): string => (caseMapper ? caseMapper.normalize(s) : s.toLowerCase());
  const bang = mask.indexOf("!");
  if (bang < 0) {
    // No nick separator: ASCII-glob the whole hostmask.
    return globToRegExp(mask).test(`${nick}!${username}@${host}`);
  }
  // Fold the NICK part under the server CASEMAPPING (so `a{b}` matches `a[b]` on
  // rfc1459); the user@host part stays ASCII case-insensitive.
  const nickOk = globToRegExp(fold(mask.slice(0, bang))).test(fold(nick));
  const hostOk = globToRegExp(mask.slice(bang + 1)).test(`${username}@${host}`);
  return nickOk && hostOk;
}

/**
 * Does `event`'s sender match `pattern`? `caseMapper` (from the live server state,
 * `null` before registration) governs bare-nick comparison; pass `null` to fall
 * back to ASCII case-insensitive comparison.
 */
export function matchesIdentity(
  event: PrivmsgEvent,
  pattern: string,
  caseMapper: CaseMapper | null,
): boolean {
  if (pattern.startsWith(ACCOUNT_PREFIX)) {
    const account = pattern.slice(ACCOUNT_PREFIX.length);
    if (account.length === 0) return false;
    const actual = resolveAccount(event);
    return actual !== null && asciiEqualsIgnoreCase(actual, account);
  }
  if (pattern.startsWith(MASK_PREFIX)) {
    return matchesMask(event, pattern.slice(MASK_PREFIX.length), caseMapper);
  }
  return caseMapper
    ? caseMapper.equals(event.user.nick, pattern)
    : asciiEqualsIgnoreCase(event.user.nick, pattern);
}

/**
 * A stable, case-folded identity key for a sender (for cooldowns/rate-limits):
 * the services `account:` when authenticated, else the lowercased `user@host`
 * (stable across nick changes — the host is server-assigned), else the casemapped
 * nick as a last resort. Note `user@host` can be shared (NAT/bouncer), so distinct
 * users there share a key — an acceptable trade for rate-limiting.
 */
export function senderKey(event: PrivmsgEvent, caseMapper: CaseMapper | null): string {
  const account = resolveAccount(event);
  if (account) return `account:${account.toLowerCase()}`;
  const { nick, username, host } = event.user;
  if (username !== null && host !== null) {
    return `host:${username.toLowerCase()}@${host.toLowerCase()}`;
  }
  return `nick:${caseMapper ? caseMapper.normalize(nick) : nick.toLowerCase()}`;
}

/** True when `event`'s sender matches any pattern in `patterns`. */
export function matchesAny(
  event: PrivmsgEvent,
  patterns: readonly string[],
  caseMapper: CaseMapper | null,
): boolean {
  for (const pattern of patterns) {
    if (matchesIdentity(event, pattern, caseMapper)) return true;
  }
  return false;
}
