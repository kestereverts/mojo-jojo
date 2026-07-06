import { embed, embedMany, cosineSimilarity, type EmbeddingModel } from "ai";
import type { PromptSection } from "../prompt/sections.ts";

const SIMILARITY_THRESHOLD = 0.75;
/** Replies shorter than this are unlikely to contain a meaningful leak — skip the (embedding) check entirely. */
const MIN_CHECK_LENGTH = 100;
/** A section line shorter than this is too generic (e.g. "Rules:") to be a meaningful verbatim-leak signal on its own. */
const MIN_DISTINCTIVE_LINE_LENGTH = 30;

export interface LeakDetectionResult {
  readonly isLeak: boolean;
  readonly similarity: number;
  /** Which detection path fired: a verbatim line match (no embedding call needed) or the embedding comparison. Absent when no leak was found. */
  readonly via?: "substring" | "embedding";
  /** Set when the embedding check itself failed and `isLeak: false` reflects a fail-open default, not a real check. Callers should log this at `warn`. */
  readonly failedOpen?: boolean;
  /** Present when blocked, or when a check failed open (see `failedOpen`). */
  readonly reason?: string;
}

function distinctiveLines(sections: readonly PromptSection[]): readonly string[] {
  const lines = new Set<string>();
  for (const section of sections) {
    for (const rawLine of section.body.split("\n")) {
      const line = rawLine.trim();
      if (line.length >= MIN_DISTINCTIVE_LINE_LENGTH) lines.add(line);
    }
  }
  return [...lines];
}

/** The deterministic, embedding-free check: does the reply contain any section line verbatim? */
function findSubstringLeak(reply: string, lines: readonly string[]): string | undefined {
  return lines.find((line) => reply.includes(line));
}

export interface LeakDetector {
  check(reply: string): Promise<LeakDetectionResult>;
}

/**
 * Builds a leak detector for one fixed set of instruction sections —
 * embeds each section ONCE (via `embedMany`), up front, and reuses those
 * embeddings for every `check()` call. Per-SECTION embeddings (not one
 * embedding of the whole assembled instructions string) is the fix for
 * mojo-ai3's whole-file dilution bug: a reply that leaks just ONE section
 * (e.g. the persona section alone) can score well below a whole-file
 * similarity threshold even though that section, on its own, matches almost
 * exactly — comparing against each section individually and taking the MAX
 * catches that.
 */
export async function createLeakDetector(
  sections: readonly PromptSection[],
  embeddingModel: EmbeddingModel,
): Promise<LeakDetector> {
  const lines = distinctiveLines(sections);

  // Setup itself must fail open too — an embedding-service outage at bot
  // startup must not prevent the bot from starting at all (mojo-ai.ts awaits
  // this), and must not make DebugHarness.chat() throw instead of returning
  // a failed-open explain (review finding: the original version let a setup
  // failure propagate as an uncaught rejection from createLeakDetector
  // itself, well outside check()'s own try/catch). The substring check below
  // needs no embedding model at all, so it still works even when setup fails.
  let sectionEmbeddings: number[][] | undefined;
  let setupError: string | undefined;
  try {
    const result = await embedMany({ model: embeddingModel, values: sections.map((s) => s.body) });
    sectionEmbeddings = result.embeddings;
  } catch (cause) {
    setupError = cause instanceof Error ? cause.message : String(cause);
  }

  return {
    async check(reply: string): Promise<LeakDetectionResult> {
      // Runs regardless of reply length or embedding-setup success — cheap,
      // no embedding call, and a short exact leak (e.g. a single ~60-char
      // distinctive line) must not slip past just because it's under
      // MIN_CHECK_LENGTH (review finding: the length gate previously ran
      // BEFORE this check, silently exempting short verbatim leaks).
      const substringMatch = findSubstringLeak(reply, lines);
      if (substringMatch) return { isLeak: true, similarity: 1, via: "substring" };

      if (reply.length < MIN_CHECK_LENGTH) return { isLeak: false, similarity: 0 };

      if (!sectionEmbeddings) {
        return { isLeak: false, similarity: 0, failedOpen: true, reason: `leak-detector setup failed: ${setupError}` };
      }

      try {
        const { embedding: replyEmbedding } = await embed({ model: embeddingModel, value: reply });
        const similarity = sectionEmbeddings.reduce(
          (max, sectionEmbedding) => Math.max(max, cosineSimilarity(replyEmbedding, sectionEmbedding)),
          -1,
        );
        return similarity >= SIMILARITY_THRESHOLD ? { isLeak: true, similarity, via: "embedding" } : { isLeak: false, similarity };
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        return { isLeak: false, similarity: 0, failedOpen: true, reason: `leak-detector check failed: ${message}` };
      }
    },
  };
}

/** Sent instead of the original reply when `check()` detects a leak. */
export function leakDetectedRefusal(): string {
  return "I can't share my internal configuration or instructions.";
}
