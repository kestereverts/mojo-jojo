import { afterEach, describe, expect, test } from "bun:test";
import { localTimeTool } from "./local-time.ts";

const execute = localTimeTool().tool.execute!;

const originalFetch = globalThis.fetch;
const originalKey = process.env.GOOGLE_MAPS_API_KEY;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.GOOGLE_MAPS_API_KEY;
  else process.env.GOOGLE_MAPS_API_KEY = originalKey;
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

describe("local_time", () => {
  test("an exact IANA timezone resolves via Intl alone — no network call", async () => {
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      throw new Error("should not be called");
    }) as unknown as typeof fetch;

    const result = (await execute({ location: "Asia/Tokyo" }, {} as never)) as any;
    expect(fetchCalled).toBe(false);
    expect(result.timezone).toBe("Asia/Tokyo");
    expect(result.location).toBe("Asia/Tokyo");
    expect(typeof result.local).toBe("string");
  });

  test("a place name geocodes then resolves the timezone, formatting via Intl", async () => {
    process.env.GOOGLE_MAPS_API_KEY = "test-key";
    const calls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      calls.push(url);
      if (url.includes("/geocode/")) {
        return jsonResponse({
          status: "OK",
          results: [{ formatted_address: "Tokyo, Japan", geometry: { location: { lat: 35.68, lng: 139.69 } } }],
        });
      }
      return jsonResponse({ status: "OK", timeZoneId: "Asia/Tokyo" });
    }) as unknown as typeof fetch;

    const result = (await execute({ location: "Tokyo" }, {} as never)) as any;
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("/geocode/json");
    expect(calls[1]).toContain("/timezone/json");
    expect(result.location).toBe("Tokyo, Japan");
    expect(result.timezone).toBe("Asia/Tokyo");
  });

  test("throws when GOOGLE_MAPS_API_KEY is not configured", async () => {
    delete process.env.GOOGLE_MAPS_API_KEY;
    expect(execute({ location: "Nowhereville" }, {} as never)).rejects.toThrow(/GOOGLE_MAPS_API_KEY/);
  });

  test("throws with the geocoder's status when a place can't be found", async () => {
    process.env.GOOGLE_MAPS_API_KEY = "test-key";
    globalThis.fetch = (async () => jsonResponse({ status: "ZERO_RESULTS", results: [] })) as unknown as typeof fetch;
    expect(execute({ location: "Nowhereville" }, {} as never)).rejects.toThrow(/ZERO_RESULTS/);
  });

  test("surfaces the geocoder's error_message (snake_case — the real field name) for a diagnosable failure", async () => {
    process.env.GOOGLE_MAPS_API_KEY = "test-key";
    globalThis.fetch = (async () =>
      jsonResponse({ status: "REQUEST_DENIED", results: [], error_message: "The provided API key is invalid." })) as unknown as typeof fetch;
    expect(execute({ location: "X" }, {} as never)).rejects.toThrow(/The provided API key is invalid\./);
  });

  test("throws with the timezone API's status when it fails after a successful geocode", async () => {
    process.env.GOOGLE_MAPS_API_KEY = "test-key";
    globalThis.fetch = (async (url: string) => {
      if (url.includes("/geocode/")) {
        return jsonResponse({ status: "OK", results: [{ formatted_address: "X", geometry: { location: { lat: 0, lng: 0 } } }] });
      }
      return jsonResponse({ status: "OVER_QUERY_LIMIT" });
    }) as unknown as typeof fetch;
    expect(execute({ location: "X" }, {} as never)).rejects.toThrow(/OVER_QUERY_LIMIT/);
  });

  test("surfaces the timezone API's errorMessage (camelCase — a different convention than the geocoder's, verified against Google's own docs)", async () => {
    process.env.GOOGLE_MAPS_API_KEY = "test-key";
    globalThis.fetch = (async (url: string) => {
      if (url.includes("/geocode/")) {
        return jsonResponse({ status: "OK", results: [{ formatted_address: "X", geometry: { location: { lat: 0, lng: 0 } } }] });
      }
      return jsonResponse({ status: "REQUEST_DENIED", errorMessage: "The provided API key is invalid." });
    }) as unknown as typeof fetch;
    expect(execute({ location: "X" }, {} as never)).rejects.toThrow(/The provided API key is invalid\./);
  });
});
