import { normalizeAccount } from "@mojo-jojo/bot";
import type { Speaker } from "../context/events.ts";
import type { SpeakerFacts } from "./middleware.ts";

/** `Bun.TOML` is present at runtime but absent from `@types/bun`. */
interface TomlNamespace {
  parse(input: string): unknown;
}

/**
 * A known person, from `friends.toml` (gitignored — real names/aliases/facts
 * are not committed to git). One person may have many nicks/relay-author names
 * across IRC/Telegram/Discord; `aliases` covers all of them.
 */
export interface Friend {
  readonly id: string;
  readonly name: string;
  /** Nicks and relay-unwrapped author names, any platform, matched case-insensitively. */
  readonly aliases: readonly string[];
  /** IRC services accounts — the strongest identity signal, when present. */
  readonly accounts: readonly string[];
  readonly city?: string;
  readonly notes?: string;
}

/**
 * Finalize a speaker's identity: compute the trust tier and, if an alias or
 * account matches a known {@link Friend}, attach `personId`. This is the last
 * step before a message is persisted — the resulting {@link Speaker} is what
 * gets frozen into durable memory (see the `Speaker` doc comment).
 *
 * Trust precedence: `account` (IRC services) beats `relay` (bridge-attributed
 * author) beats `nick` (direct IRC, unregistered) — matching how spoofable
 * each signal is, weakest last.
 */
export function resolveSpeaker(facts: SpeakerFacts, friends: readonly Friend[]): Speaker {
  // Normalize once: a raw "*"/"" account tag means "logged out", not "has an
  // account" — trust and matching must agree on that, so both read this, never
  // `facts.account` directly.
  const account = normalizeAccount(facts.account ?? null);
  const trust: Speaker["trust"] = account ? "account" : facts.author ? "relay" : "nick";
  const friend = findFriend(facts, account, friends);
  const { account: _rawAccount, ...rest } = facts;
  return { ...rest, ...(account ? { account } : {}), ...(friend ? { personId: friend.id } : {}), trust };
}

function findFriend(facts: SpeakerFacts, account: string | null, friends: readonly Friend[]): Friend | undefined {
  // An account match is authoritative when present — check it before aliases,
  // which are just names and thus weaker (and spoofable on unregistered nicks).
  if (account) {
    const byAccount = friends.find((f) => f.accounts.some((a) => normalizeAccount(a) === account));
    if (byAccount) return byAccount;
  }
  // Prefer the relay-unwrapped author name when present — that's who is
  // actually speaking on the bridge, not the shared relay-bot nick.
  const identityName = (facts.author ?? facts.nick).toLowerCase();
  return friends.find((f) => f.aliases.some((alias) => alias.toLowerCase() === identityName));
}

/** Keys that would pollute a prototype rather than create an own property. */
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** Mirrors `@mojo-jojo/bot`'s `loadConfig` stripping — same trust boundary, a hand-edited file. */
function stripUnsafeKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripUnsafeKeys);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      if (UNSAFE_KEYS.has(key)) continue;
      out[key] = stripUnsafeKeys(v);
    }
    return out;
  }
  return value;
}

export interface LoadFriendsResult {
  readonly friends: readonly Friend[];
  /** Non-fatal issues (missing/unreadable file, invalid TOML, malformed entries) — the bot still runs. */
  readonly warnings: readonly string[];
}

/**
 * Load `friends.toml`: an array of `[[person]]` tables (see `friends.example.toml`
 * for the shape). Deliberately forgiving — this is optional, hand-edited PII data,
 * not core config: a missing file, unparseable TOML, or one malformed entry
 * degrades to a warning (and that entry is skipped), never a thrown error that
 * would stop the bot from starting.
 */
export async function loadFriendsFile(path: string): Promise<LoadFriendsResult> {
  let text: string;
  try {
    text = await Bun.file(path).text();
  } catch {
    return { friends: [], warnings: [`friends file not found at "${path}" — running without known-user data`] };
  }

  let raw: unknown;
  try {
    raw = stripUnsafeKeys((Bun as unknown as { TOML: TomlNamespace }).TOML.parse(text));
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return { friends: [], warnings: [`friends file at "${path}" is invalid TOML: ${message}`] };
  }

  const list = (raw as { person?: unknown }).person;
  if (list === undefined) return { friends: [], warnings: [] };
  if (!Array.isArray(list)) {
    return { friends: [], warnings: [`friends file at "${path}": "person" must be an array of tables`] };
  }

  const warnings: string[] = [];
  const friends: Friend[] = [];
  const seenIds = new Set<string>();
  list.forEach((entryRaw, i) => {
    const friend = parseFriendEntry(entryRaw, i, warnings);
    if (!friend) return;
    if (seenIds.has(friend.id)) {
      warnings.push(`person[${i}]: duplicate id "${friend.id}", skipping`);
      return;
    }
    seenIds.add(friend.id);
    friends.push(friend);
  });
  return { friends, warnings };
}

function parseFriendEntry(raw: unknown, index: number, warnings: string[]): Friend | undefined {
  if (typeof raw !== "object" || raw === null) {
    warnings.push(`person[${index}]: expected a table, skipping`);
    return undefined;
  }
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === "string" ? r.id.trim() : "";
  const name = typeof r.name === "string" ? r.name.trim() : "";
  if (!id || !name) {
    warnings.push(`person[${index}]: missing required "id" or "name", skipping`);
    return undefined;
  }
  return {
    id,
    name,
    aliases: stringArray(r.aliases),
    accounts: stringArray(r.accounts),
    ...(typeof r.city === "string" ? { city: r.city } : {}),
    ...(typeof r.notes === "string" ? { notes: r.notes } : {}),
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}
