import type { Friend } from "../identity/speakers.ts";
import type { PromptSection } from "./sections.ts";

/**
 * Render `friends.toml` data into the "Known Users" section — the
 * PII-excised successor to mojo-ai3's hardcoded Known Users table. `null`
 * when there are no friends (missing file, empty file, or every entry failed
 * to parse), so the caller omits the section entirely rather than showing an
 * empty "Known Users" heading.
 */
export function buildKnownUsersSection(friends: readonly Friend[]): PromptSection | null {
  if (friends.length === 0) return null;
  const body = [
    "The following are people known to the bot across platforms — the same person may speak under different nicks/names on IRC, Telegram, or Discord. When a message's `personId` (see Message Format) matches one of these people, treat these facts as accurate context about them.",
    "",
    ...friends.map(renderFriendLine),
  ].join("\n");
  return { id: "known-users", title: "Known Users", body };
}

function renderFriendLine(friend: Friend): string {
  const aliasList = friend.aliases.length > 0 ? friend.aliases.join(", ") : friend.name;
  const parts = [`You know ${aliasList} as ${friend.name}.`];
  if (friend.city) parts.push(`Lives in ${friend.city}.`);
  if (friend.notes) parts.push(friend.notes);
  return parts.join(" ");
}
