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

function matchesMask(event: PrivmsgEvent, mask: string): boolean {
  const { nick, username, host } = event.user;
  // Fail closed: an unknown user/host must never match a wildcard.
  if (username === null || host === null) return false;
  return globToRegExp(mask).test(`${nick}!${username}@${host}`);
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
    // Prefer the message-scoped account-tag; only fall back to the cached entity
    // account when the message carries none. Accounts compare case-insensitively (ASCII).
    const actual = normalizeAccount(event.account) ?? normalizeAccount(event.user.account);
    return actual !== null && asciiEqualsIgnoreCase(actual, account);
  }
  if (pattern.startsWith(MASK_PREFIX)) {
    return matchesMask(event, pattern.slice(MASK_PREFIX.length));
  }
  return caseMapper
    ? caseMapper.equals(event.user.nick, pattern)
    : asciiEqualsIgnoreCase(event.user.nick, pattern);
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
