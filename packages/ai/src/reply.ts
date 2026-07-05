/**
 * Split a model reply into deliverable IRC lines: one visible line per array
 * entry, trimmed, blanks dropped, capped at `max`. Shared by the live module's
 * `deliver` and the debug harness so both bound and record replies identically.
 */
export function toReplyLines(reply: string, max: number): string[] {
  return reply
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, max);
}
