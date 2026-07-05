import type { CaseMapper } from "@mojo-jojo/irc-client";
import { Validator } from "@mojo-jojo/bot";
import type { ChatMiddleware } from "./middleware.ts";

/** A configured relay/bridge bot: its IRC nick, and the pattern that unwraps its lines. */
export interface RelayDefinition {
  readonly nick: string;
  /** Must contain named groups `(?<author>...)` and `(?<text>...)`; validated at parse time. */
  readonly pattern: RegExp;
}

/**
 * Strip mIRC-style formatting control codes so a relay pattern can stay a
 * clean, human-writable regex. Discord bridges commonly color-wrap the
 * author (`<\x0304 Author \x0F> text`), which would otherwise break a plain
 * `^<(?<author>...)>` pattern.
 *
 * Codes removed: bold `\x02`, color `\x03` (+ optional 1-2 digit fg[,bg]),
 * reset `\x0F`, italic `\x1D`, strikethrough `\x1E`, underline `\x1F`,
 * reverse `\x16`, monospace `\x11`, and IRCv3-draft hex color `\x04RRGGBB[,RRGGBB]`.
 */
export function stripIrcFormatting(text: string): string {
  return text
    .replace(/\x03\d{0,2}(,\d{1,2})?/g, "")
    .replace(/\x04[0-9A-Fa-f]{6}(,[0-9A-Fa-f]{6})?/g, "")
    .replace(/[\x02\x0F\x11\x16\x1D\x1E\x1F]/g, "");
}

const AUTHOR_GROUP = /\(\?<author>/;
const TEXT_GROUP = /\(\?<text>/;

/**
 * Validate + parse `[[modules.mojo-ai.relays]]` entries into {@link RelayDefinition}s.
 * Shares the caller's `Validator` (collect-all-errors); a malformed entry is
 * recorded via `v.fail` and skipped, not thrown — the caller's `throwIfAny()`
 * surfaces every issue at once, same as the rest of the module's config.
 */
export function parseRelays(v: Validator, raw: unknown, path: string): RelayDefinition[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    v.fail(path, "expected an array of tables");
    return [];
  }
  const relays: RelayDefinition[] = [];
  raw.forEach((entryRaw, i) => {
    const entry = v.optRecord(entryRaw, `${path}[${i}]`);
    if (!entry) return;
    const nick = v.requireString(entry.nick, `${path}[${i}].nick`);
    const patternSource = v.requireString(entry.pattern, `${path}[${i}].pattern`);
    if (!nick || !patternSource) return; // already recorded by requireString

    if (!AUTHOR_GROUP.test(patternSource) || !TEXT_GROUP.test(patternSource)) {
      v.fail(`${path}[${i}].pattern`, "must contain named groups (?<author>...) and (?<text>...)");
      return;
    }
    try {
      relays.push({ nick, pattern: new RegExp(patternSource) });
    } catch (cause) {
      v.fail(`${path}[${i}].pattern`, `invalid regex: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  });
  return relays;
}

/**
 * The relay-unwrapping middleware: if the message's actual sender nick
 * matches a configured relay bot, extract `author`/`text` from the
 * formatting-stripped line via that bot's pattern. No match (including no
 * configured relays, or the pattern not matching this particular line) passes
 * the message through unchanged — the safe degrade is "the relay bot said
 * this literally", same as mojo-ai3.
 *
 * `getCaseMapper` is read per-message (not captured once) because casemapping
 * is live server state that can change across a reconnect — same pattern
 * `mojo-ai.ts` already uses for nick/channel comparisons.
 */
export function createRelayMiddleware(
  relays: readonly RelayDefinition[],
  getCaseMapper: () => CaseMapper | null,
): ChatMiddleware {
  if (relays.length === 0) return (msg) => msg;
  return (msg) => {
    const mapper = getCaseMapper();
    const relay = relays.find((r) => nickEquals(msg.raw.user.nick, r.nick, mapper));
    if (!relay) return msg;

    const match = relay.pattern.exec(stripIrcFormatting(msg.text));
    const author = match?.groups?.author;
    const text = match?.groups?.text;
    if (author === undefined || text === undefined) return msg;

    // Drop any IRC account carried by `msg.speaker` — it belongs to the RELAY
    // BOT (which may itself be registered/authenticated to avoid being
    // killed/kicked on networks that require it), not the person actually
    // speaking through the bridge. Without this, a message would inherit the
    // bridge's own account and wrongly resolve to trust:"account" instead of
    // the weaker "relay" tier its evidence actually supports.
    const { account: _relayBotAccount, ...facts } = msg.speaker;
    return { ...msg, speaker: { ...facts, author, via: relay.nick }, text };
  };
}

function nickEquals(a: string, b: string, mapper: CaseMapper | null): boolean {
  return mapper ? mapper.equals(a, b) : a.toLowerCase() === b.toLowerCase();
}
