import { afterEach, describe, expect, test } from "bun:test";
import { placesSearchTool } from "./places-search.ts";

const execute = placesSearchTool().tool.execute!;
const originalFetch = globalThis.fetch;
const originalKey = process.env.GOOGLE_MAPS_API_KEY;
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.GOOGLE_MAPS_API_KEY;
  else process.env.GOOGLE_MAPS_API_KEY = originalKey;
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

// The daily quota is a MODULE-LEVEL singleton shared across every test in
// this file (each `placesSearchTool()` call returns a fresh ToolDefinition,
// but they all close over the same quota instance) — so tests that need
// specific quota state build their OWN fresh tool via a re-imported module
// instance where isolation matters (the exhaustion test), and otherwise
// stay under the 20/day cap collectively.

describe("places_search", () => {
  test("maps Google Places (New) fields, including a friendly price-level label", async () => {
    process.env.GOOGLE_MAPS_API_KEY = "test-key";
    globalThis.fetch = (async () =>
      jsonResponse({
        places: [
          {
            displayName: { text: "Barney's Coffeeshop" },
            formattedAddress: "Haarlemmerstraat 102, Amsterdam",
            rating: 4.6,
            userRatingCount: 5073,
            priceLevel: "PRICE_LEVEL_MODERATE",
            currentOpeningHours: { openNow: false, weekdayDescriptions: ["Monday: 9:00 AM - 1:00 AM"] },
            websiteUri: "https://example.com",
            types: ["coffee_shop", "cafe", "food_store", "food"],
          },
        ],
      })) as unknown as typeof fetch;

    const result = (await execute({ query: "coffee shops in Amsterdam" }, {} as never)) as any;
    expect(result.places).toEqual([
      {
        name: "Barney's Coffeeshop",
        address: "Haarlemmerstraat 102, Amsterdam",
        rating: 4.6,
        userRatingsTotal: 5073,
        priceLevel: "$$",
        openNow: false,
        openingHours: ["Monday: 9:00 AM - 1:00 AM"],
        website: "https://example.com",
        types: ["coffee_shop", "cafe", "food_store"], // capped at 3
      },
    ]);
  });

  test("no places in the response degrades to an empty array, not a throw", async () => {
    process.env.GOOGLE_MAPS_API_KEY = "test-key";
    globalThis.fetch = (async () => jsonResponse({})) as unknown as typeof fetch;
    const result = (await execute({ query: "nowhere" }, {} as never)) as any;
    expect(result.places).toEqual([]);
  });

  test("throws when GOOGLE_MAPS_API_KEY is not configured", async () => {
    delete process.env.GOOGLE_MAPS_API_KEY;
    expect(execute({ query: "x" }, {} as never)).rejects.toThrow(/GOOGLE_MAPS_API_KEY/);
  });

  test("a non-2xx response throws", async () => {
    process.env.GOOGLE_MAPS_API_KEY = "test-key";
    globalThis.fetch = (async () => new Response("denied", { status: 403 })) as unknown as typeof fetch;
    expect(execute({ query: "x" }, {} as never)).rejects.toThrow(/HTTP 403/);
  });
});

describe("places_search — daily quota exhaustion", () => {
  test("the 21st call in a day throws instead of hitting the API", async () => {
    // Fresh module instance so this test's quota consumption can't be
    // affected by (or affect) the describe block above, which shares the
    // same process-wide quota singleton.
    const { placesSearchTool: freshTool } = await import(`./places-search.ts?isolate=${Date.now()}`);
    process.env.GOOGLE_MAPS_API_KEY = "test-key";
    globalThis.fetch = (async () => jsonResponse({ places: [] })) as unknown as typeof fetch;
    const execute = freshTool().tool.execute!;

    for (let i = 0; i < 20; i++) {
      await execute({ query: `query ${i}` }, {} as never);
    }
    expect(execute({ query: "one too many" }, {} as never)).rejects.toThrow(/daily rate limit exceeded/);
  });
});
