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
const NICK_PREFIX = "nick:";

/**
 * Is `pattern` a SECURE owner matcher? `account:` (services-authenticated) and
 * `mask:` (hostmask) are secure; bare-nick and `nick:` are NOT — an attacker who
 * takes the nick while the owner is offline would match.
 */
export function isSecureMatcher(pattern: string): boolean {
  return pattern.startsWith(ACCOUNT_PREFIX) || pattern.startsWith(MASK_PREFIX);
}

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

/**
 * Linear IRC-glob match (`*` = any run, `?` = one char). Iterative greedy match with
 * single-star backtracking — O(pattern·value), so NO catastrophic regex backtracking
 * (ReDoS) even for a pathological `*a*a*a…` mask. Comparison is exact; callers fold
 * case (and casemapping) beforehand.
 */
function globMatch(pattern: string, value: string): boolean {
  let p = 0;
  let v = 0;
  let star = -1;
  let mark = 0;
  while (v < value.length) {
    const pc = pattern[p];
    if (p < pattern.length && (pc === "?" || pc === value[v])) {
      p++;
      v++;
    } else if (pc === "*") {
      star = p++;
      mark = v;
    } else if (star >= 0) {
      p = star + 1;
      v = ++mark;
    } else {
      return false;
    }
  }
  while (pattern[p] === "*") p++;
  return p === pattern.length;
}

function asciiEqualsIgnoreCase(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function matchesMask(event: PrivmsgEvent, mask: string, caseMapper: CaseMapper | null): boolean {
  const { nick, username, host } = event.user;
  // Fail closed: an unknown user/host must never match a wildcard.
  if (username === null || host === null) return false;
  const foldNick = (s: string): string => (caseMapper ? caseMapper.normalize(s) : s.toLowerCase());
  const bang = mask.indexOf("!");
  if (bang < 0) {
    // No nick separator: ASCII-fold and glob the whole hostmask.
    return globMatch(mask.toLowerCase(), `${nick}!${username}@${host}`.toLowerCase());
  }
  // Fold the NICK part under the server CASEMAPPING (so `a{b}` matches `a[b]` on
  // rfc1459); the user@host part stays ASCII case-insensitive.
  const nickOk = globMatch(foldNick(mask.slice(0, bang)), foldNick(nick));
  const hostOk = globMatch(mask.slice(bang + 1).toLowerCase(), `${username}@${host}`.toLowerCase());
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
    // Use the MESSAGE-scoped account-tag ONLY — never the cached entity account — so a
    // stale cache can't authorize a logged-out sender. (On an account-tag network every
    // logged-in message is tagged; without the cap, account: simply cannot be verified.)
    const tag = normalizeAccount(event.account);
    return tag !== null && asciiEqualsIgnoreCase(tag, account);
  }
  if (pattern.startsWith(MASK_PREFIX)) {
    return matchesMask(event, pattern.slice(MASK_PREFIX.length), caseMapper);
  }
  // `nick:<nick>` is the explicit (insecure) nick form; a bare string is the same.
  const wanted = pattern.startsWith(NICK_PREFIX) ? pattern.slice(NICK_PREFIX.length) : pattern;
  return caseMapper ? caseMapper.equals(event.user.nick, wanted) : asciiEqualsIgnoreCase(event.user.nick, wanted);
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
