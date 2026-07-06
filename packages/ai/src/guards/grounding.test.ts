import { afterEach, describe, expect, test } from "bun:test";
import { checkGrounding, groundingRetryGuidance, stripUngroundedUrls } from "./grounding.ts";
import type { ExchangeStep } from "../exchange.ts";
import type { ContextEvent, ToolTranscriptEvent } from "../context/events.ts";

const originalPortalBaseUrl = process.env.MOJO_PORTAL_BASE_URL;
afterEach(() => {
  if (originalPortalBaseUrl === undefined) delete process.env.MOJO_PORTAL_BASE_URL;
  else process.env.MOJO_PORTAL_BASE_URL = originalPortalBaseUrl;
});

function pasteStep(url: string | undefined, error?: unknown): ExchangeStep {
  return {
    index: 0,
    text: "",
    finishReason: "tool-calls",
    toolCalls: [
      {
        toolName: "paste",
        input: {},
        ...(error !== undefined ? { error } : { output: url === undefined ? {} : { url } }),
      },
    ],
    usage: { inputTokens: 1, outputTokens: 1 } as ExchangeStep["usage"],
    stepTimeMs: 0,
    responseTimeMs: 0,
  };
}

describe("checkGrounding", () => {
  test("a reply with no URLs at all is trivially grounded", () => {
    const result = checkGrounding("Here's your answer, no links needed.", []);
    expect(result.grounded).toBe(true);
    expect(result.ungroundedUrls).toEqual([]);
  });

  test("a portal URL that matches a successful paste call's output is grounded", () => {
    const steps = [pasteStep("https://mojo.v00l.com/:abc123")];
    const result = checkGrounding("Here's your paste: https://mojo.v00l.com/:abc123", steps);
    expect(result.grounded).toBe(true);
    expect(result.ungroundedUrls).toEqual([]);
  });

  test("a trailing-dot variant of the portal host is still recognized and checked (review finding — DNS treats it as the same host)", () => {
    const steps = [pasteStep("https://mojo.v00l.com/:real")];
    // "mojo.v00l.com." (root-anchored FQDN) resolves identically to
    // "mojo.v00l.com" in a real client, but `new URL(...).host` differs by
    // exactly the trailing dot — without normalizing, this URL would have
    // silently skipped the guard entirely instead of being flagged.
    const fabricatedWithTrailingDot = "https://mojo.v00l.com./:fake";
    const result = checkGrounding(`Here's your paste: ${fabricatedWithTrailingDot}`, steps);
    expect(result.grounded).toBe(false);
    expect(result.ungroundedUrls).toEqual([fabricatedWithTrailingDot]);
  });

  test("a real paste URL followed by sentence-ending punctuation is still grounded (review finding — extraction previously swept the period into the URL)", () => {
    const steps = [pasteStep("https://mojo.v00l.com/:abc123")];
    // The extremely common "here's the link: <url>." reply shape — a period
    // right after the URL, no space. Previously extractUrls captured the
    // period AS PART of the URL, which then never matched the paste tool's
    // (period-free) real output, wrongly stripping a legitimate reply.
    const result = checkGrounding("Here's your paste: https://mojo.v00l.com/:abc123.", steps);
    expect(result.grounded).toBe(true);
    expect(result.ungroundedUrls).toEqual([]);
  });

  test("trailing punctuation is stripped without over-trimming a genuinely fabricated URL's own content", () => {
    const steps = [pasteStep("https://mojo.v00l.com/:realone")];
    const result = checkGrounding("Here's your paste: https://mojo.v00l.com/:madeupxyz!", steps);
    expect(result.grounded).toBe(false);
    expect(result.ungroundedUrls).toEqual(["https://mojo.v00l.com/:madeupxyz"]);
  });

  test("a paste created in a PRIOR turn is still grounded via durable history, not just this exchange's own steps (review finding)", () => {
    const priorPaste: ToolTranscriptEvent = {
      kind: "tool-transcript",
      at: "2026-01-01T00:00:00.000Z",
      tool: "paste",
      input: {},
      output: { url: "https://mojo.v00l.com/:fromEarlier" },
    };
    const priorEvents: ContextEvent[] = [priorPaste];
    // No paste call THIS exchange (steps: []) — the model is just re-citing
    // a real paste from an earlier turn ("what was that link again?").
    const result = checkGrounding("It was https://mojo.v00l.com/:fromEarlier", [], priorEvents);
    expect(result.grounded).toBe(true);
    expect(result.ungroundedUrls).toEqual([]);
  });

  test("a paste URL preserved in a COMPACTION summary is still grounded — compaction physically replaces the original tool-transcript (M8 review finding, Ophelia)", () => {
    const priorEvents: ContextEvent[] = [
      {
        kind: "compaction",
        at: "2026-01-01T00:00:00.000Z",
        coversUntil: "2025-12-31T00:00:00.000Z",
        summary: "Alice asked for a paste; the bot created https://mojo.v00l.com/:foldedIntoSummary and shared it.",
        eventCount: 40,
      },
    ];
    const result = checkGrounding("It was https://mojo.v00l.com/:foldedIntoSummary", [], priorEvents);
    expect(result.grounded).toBe(true);
    expect(result.ungroundedUrls).toEqual([]);
  });

  test("a URL NOT mentioned in the compaction summary is still ungrounded — compaction doesn't grant a blanket pass", () => {
    const priorEvents: ContextEvent[] = [
      {
        kind: "compaction",
        at: "2026-01-01T00:00:00.000Z",
        coversUntil: "2025-12-31T00:00:00.000Z",
        summary: "Alice and the bot discussed the weather. No links were mentioned.",
        eventCount: 40,
      },
    ];
    const result = checkGrounding("https://mojo.v00l.com/:neverMentioned", [], priorEvents);
    expect(result.grounded).toBe(false);
  });

  test("a durable transcript from a DIFFERENT tool is never treated as a known paste URL", () => {
    const priorEvents: ContextEvent[] = [
      { kind: "tool-transcript", at: "t", tool: "web_search", input: {}, output: { url: "https://mojo.v00l.com/:notAPaste" } },
    ];
    const result = checkGrounding("https://mojo.v00l.com/:notAPaste", [], priorEvents);
    expect(result.grounded).toBe(false);
  });

  test("a portal URL that does NOT match any paste output is ungrounded (likely fabricated)", () => {
    const steps = [pasteStep("https://mojo.v00l.com/:realone")];
    const result = checkGrounding("Here's your paste: https://mojo.v00l.com/:madeupxyz", steps);
    expect(result.grounded).toBe(false);
    expect(result.ungroundedUrls).toEqual(["https://mojo.v00l.com/:madeupxyz"]);
  });

  test("a NON-portal URL (e.g. quoted from web_reader) is ignored entirely — not this guard's concern", () => {
    const result = checkGrounding("See this article: https://example.com/some-article", []);
    expect(result.grounded).toBe(true);
    expect(result.ungroundedUrls).toEqual([]);
  });

  test("a FAILED paste call's output is never counted as a known/grounded URL", () => {
    const steps = [pasteStep(undefined, new Error("paste failed"))];
    const result = checkGrounding("Here's your paste: https://mojo.v00l.com/:abc123", steps);
    expect(result.grounded).toBe(false);
    expect(result.ungroundedUrls).toEqual(["https://mojo.v00l.com/:abc123"]);
  });

  test("multiple ungrounded URLs are all reported, deduplicated", () => {
    const result = checkGrounding(
      "First https://mojo.v00l.com/:fake1 and again https://mojo.v00l.com/:fake1 and also https://mojo.v00l.com/:fake2",
      [],
    );
    expect(result.grounded).toBe(false);
    expect([...result.ungroundedUrls].sort()).toEqual(["https://mojo.v00l.com/:fake1", "https://mojo.v00l.com/:fake2"]);
  });

  test("respects a custom MOJO_PORTAL_BASE_URL", async () => {
    // MOJO_PORTAL_BASE_URL is read ONCE into a module-level constant (same
    // convention as tools/paste.ts) — setting it after this file's top-level
    // import already ran has no effect, so a fresh module instance is
    // needed (the established cache-busting dynamic-import pattern).
    process.env.MOJO_PORTAL_BASE_URL = "https://paste.example.org";
    const { checkGrounding: freshCheckGrounding } = await import(`./grounding.ts?isolate=${Date.now()}`);
    const steps = [pasteStep("https://paste.example.org/:real")];
    const grounded = freshCheckGrounding("https://paste.example.org/:real", steps);
    expect(grounded.grounded).toBe(true);
    const ungrounded = freshCheckGrounding("https://paste.example.org/:fake", steps);
    expect(ungrounded.grounded).toBe(false);
  });
});

describe("stripUngroundedUrls", () => {
  test("replaces each ungrounded URL with a visible placeholder", () => {
    const reply = "Here's your paste: https://mojo.v00l.com/:fake, enjoy!";
    const result = stripUngroundedUrls(reply, ["https://mojo.v00l.com/:fake"]);
    expect(result).toBe("Here's your paste: [link removed: could not be verified], enjoy!");
  });

  test("leaves the reply unchanged when there's nothing to strip", () => {
    const reply = "No links here.";
    expect(stripUngroundedUrls(reply, [])).toBe(reply);
  });
});

describe("groundingRetryGuidance", () => {
  test("includes the ungrounded URL(s) so the model knows exactly what was wrong", () => {
    const guidance = groundingRetryGuidance(["https://mojo.v00l.com/:fake"]);
    expect(guidance).toContain("https://mojo.v00l.com/:fake");
    expect(guidance.length).toBeGreaterThan(0);
  });
});
