import { afterEach, describe, expect, test } from "bun:test";
import { webSearchTool } from "./web-search.ts";

const execute = webSearchTool().tool.execute!;
const originalFetch = globalThis.fetch;
const originalKey = process.env.BRAVE_SEARCH_API_KEY;
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.BRAVE_SEARCH_API_KEY;
  else process.env.BRAVE_SEARCH_API_KEY = originalKey;
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

// Each test uses a distinct query string — the result cache and rate limiter
// are module singletons, so reusing a query/hammering calls across tests
// would read stale mocks or spuriously rate-limit.

describe("web_search", () => {
  test("maps Brave's web.results into title/url/description/age", async () => {
    process.env.BRAVE_SEARCH_API_KEY = "test-key";
    globalThis.fetch = (async () =>
      jsonResponse({
        web: {
          results: [
            { title: "Bun", url: "https://bun.com", description: "A fast runtime", age: "May 18, 2026" },
            { title: "No desc", url: "https://example.com", extra_snippets: ["fallback snippet"] },
          ],
        },
      })) as unknown as typeof fetch;

    const result = (await execute({ query: "bun-search-query-1" }, {} as never)) as any;
    expect(result.results).toEqual([
      { title: "Bun", url: "https://bun.com", description: "A fast runtime", age: "May 18, 2026" },
      { title: "No desc", url: "https://example.com", description: "fallback snippet" },
    ]);
  });

  test("no web.results block at all degrades to an empty array, not a throw", async () => {
    process.env.BRAVE_SEARCH_API_KEY = "test-key";
    globalThis.fetch = (async () => jsonResponse({})) as unknown as typeof fetch;
    const result = (await execute({ query: "bun-search-query-2" }, {} as never)) as any;
    expect(result.results).toEqual([]);
  });

  test("caches results for the same query — a second call doesn't refetch", async () => {
    process.env.BRAVE_SEARCH_API_KEY = "test-key";
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount++;
      return jsonResponse({ web: { results: [{ title: "X", url: "https://x.com", description: "d" }] } });
    }) as unknown as typeof fetch;
    await execute({ query: "bun-search-query-3" }, {} as never);
    await execute({ query: "  Bun-Search-Query-3  " }, {} as never); // different casing/whitespace, same key
    expect(fetchCount).toBe(1);
  });

  test("throws when BRAVE_SEARCH_API_KEY is not configured", async () => {
    delete process.env.BRAVE_SEARCH_API_KEY;
    expect(execute({ query: "bun-search-query-4" }, {} as never)).rejects.toThrow(/BRAVE_SEARCH_API_KEY/);
  });

  test("a non-2xx response throws", async () => {
    process.env.BRAVE_SEARCH_API_KEY = "test-key";
    globalThis.fetch = (async () => new Response("rate limited", { status: 429 })) as unknown as typeof fetch;
    expect(execute({ query: "bun-search-query-5" }, {} as never)).rejects.toThrow(/HTTP 429/);
  });
});
