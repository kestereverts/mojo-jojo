import type { ExchangeStep } from "../exchange.ts";

// Same env var / default as tools/paste.ts — the portal host this bot's own
// paste tool uploads to. Deliberately narrow: this guard only cares about
// URLs the bot itself could have fabricated in place of a real paste tool
// result. A URL from web_reader (quoting a page the model actually read) or
// any other domain isn't this guard's concern — it isn't the bot's own
// generated artifact, so there's nothing here to "ground" it against.
const PORTAL_BASE_URL = process.env.MOJO_PORTAL_BASE_URL ?? "https://mojo.v00l.com";

export interface GroundingResult {
  readonly grounded: boolean;
  /** Portal URLs the reply mentions that don't appear in any successful `paste` call's output this exchange — i.e. likely fabricated rather than copied from a real tool result. */
  readonly ungroundedUrls: readonly string[];
}

function extractUrls(text: string): string[] {
  return text.match(/https?:\/\/[^\s)>\]"']+/g) ?? [];
}

function portalHost(): string | undefined {
  try {
    return new URL(PORTAL_BASE_URL).host;
  } catch {
    return undefined;
  }
}

/** Every URL a successful `paste` call actually returned this exchange — the ground truth a reply's portal URLs must match. */
function knownPasteUrls(steps: readonly ExchangeStep[]): Set<string> {
  const urls = new Set<string>();
  for (const step of steps) {
    for (const call of step.toolCalls) {
      if (call.error !== undefined || call.toolName !== "paste") continue;
      const output = call.output as { url?: unknown } | undefined;
      if (typeof output?.url === "string") urls.add(output.url);
    }
  }
  return urls;
}

/**
 * Deterministic replacement for mojo-ai3's LLM-based verifier (which made an
 * extra model round-trip just to check/"correct" a URL — slow, costly, and
 * non-deterministic: an LLM told to "not change anything else" can still
 * subtly rephrase the message). This just checks: does every portal URL the
 * reply mentions actually appear in this exchange's own successful `paste`
 * tool outputs? A URL the model invented (plausible-looking but never
 * actually returned by a real `paste` call) fails.
 */
export function checkGrounding(reply: string, steps: readonly ExchangeStep[]): GroundingResult {
  const host = portalHost();
  if (!host) return { grounded: true, ungroundedUrls: [] };

  const mentionedPortalUrls = extractUrls(reply).filter((url) => {
    try {
      return new URL(url).host === host;
    } catch {
      return false;
    }
  });
  if (mentionedPortalUrls.length === 0) return { grounded: true, ungroundedUrls: [] };

  const known = knownPasteUrls(steps);
  const ungroundedUrls = [...new Set(mentionedPortalUrls.filter((url) => !known.has(url)))];
  return { grounded: ungroundedUrls.length === 0, ungroundedUrls };
}

/** Removes each ungrounded URL from the reply, replacing it with a visible placeholder rather than silently vanishing text. */
export function stripUngroundedUrls(reply: string, ungroundedUrls: readonly string[]): string {
  return ungroundedUrls.reduce((text, url) => text.split(url).join("[link removed: could not be verified]"), reply);
}

/** Ephemeral `turn.guidance` feedback for the one grounding retry — the formalized ephemeral-instruction channel, not a new mechanism. */
export function groundingRetryGuidance(ungroundedUrls: readonly string[]): string {
  return `Your previous reply included a link that doesn't match any paste you actually created this turn (${ungroundedUrls.join(", ")}). Only reference paste URLs that were actually returned by the paste tool — never invent or guess one.`;
}
