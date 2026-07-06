import { tool } from "ai";
import { z } from "zod";
import { fetchJson } from "./http.ts";
import { TtlCache } from "./cache.ts";
import { TokenBucket } from "./quota.ts";
import type { ToolDefinition } from "./define.ts";

interface BraveWebResult {
  readonly title?: string;
  readonly url?: string;
  readonly description?: string;
  readonly extra_snippets?: readonly string[];
  readonly age?: string;
}
interface BraveSearchResponse {
  readonly web?: { readonly results?: readonly BraveWebResult[] };
}

interface SearchResult {
  readonly title: string;
  readonly url: string;
  readonly description: string;
  readonly age?: string;
}

const CACHE_TTL_MS = 5 * 60 * 1000; // news-sensitive; short-lived
const resultCache = new TtlCache<readonly SearchResult[]>(200);
// Client-side burst guard, independent of Brave's own server-side plan
// limits — this bounds what THIS process can spend, not what Brave allows.
const rateLimiter = new TokenBucket(15, 4_000); // ~15/min sustained, small burst

function requireApiKey(): string {
  const key = process.env.BRAVE_SEARCH_API_KEY;
  if (!key) throw new Error("BRAVE_SEARCH_API_KEY is not configured");
  return key;
}

export function webSearchTool(): ToolDefinition {
  return {
    name: "web_search",
    durableTranscript: false,
    tool: tool({
      description:
        "Search the web via Brave Search. Returns up to 10 results with title, URL, and a short snippet — " +
        "NOT the full page content. Use web_reader to fetch a result's full content before answering from it.",
      inputSchema: z.object({
        query: z.string().describe("The search query. Be specific and descriptive for best results."),
      }),
      execute: async ({ query }) => {
        const key = query.trim().toLowerCase();
        const cached = resultCache.get(key);
        if (cached) return { query, results: cached };

        if (!rateLimiter.tryConsume()) {
          throw new Error("web_search is rate-limited right now — try again shortly");
        }

        const apiKey = requireApiKey();
        const params = new URLSearchParams({ q: query.trim(), count: "10" });
        const data = await fetchJson<BraveSearchResponse>(
          `https://api.search.brave.com/res/v1/web/search?${params.toString()}`,
          { headers: { "X-Subscription-Token": apiKey, Accept: "application/json" } },
        );

        const results: SearchResult[] = (data.web?.results ?? []).map((r) => ({
          title: r.title ?? "",
          url: r.url ?? "",
          description: r.description ?? r.extra_snippets?.[0] ?? "",
          ...(r.age ? { age: r.age } : {}),
        }));

        resultCache.set(key, results, CACHE_TTL_MS);
        return { query, results };
      },
    }),
    guidance: {
      id: "tool-web-search",
      title: "web_search",
      body: `Call when the user asks about current events, news, or anything that may need up-to-date or multi-source information. Results are short snippets only — do NOT answer from titles/descriptions alone. Always follow up with web_reader on the most relevant result(s) before answering.`,
    },
  };
}
