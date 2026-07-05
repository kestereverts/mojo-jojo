import { afterEach, describe, expect, test } from "bun:test";
import { currencyConvertTool } from "./currency.ts";

const execute = currencyConvertTool().tool.execute!;
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

// Each test uses a distinct `from` code — the tool's rate cache is a module
// singleton, so reusing a code across tests would read a stale mock response.

describe("currency_convert", () => {
  test("converts using the fetched rate table", async () => {
    globalThis.fetch = (async () => jsonResponse({ date: "2026-01-01", usd: { eur: 0.9, gbp: 0.8 } })) as unknown as typeof fetch;
    const result = (await execute({ amount: 100, from: "usd", to: "eur" }, {} as never)) as any;
    expect(result).toEqual({ originalAmount: 100, from: "USD", to: "EUR", convertedAmount: 90, exchangeRate: 0.9 });
  });

  test("codes are case-insensitive on input, uppercased on output", async () => {
    globalThis.fetch = (async () => jsonResponse({ date: "2026-01-01", eur2: { usd: 1.1 } })) as unknown as typeof fetch;
    const result = (await execute({ amount: 10, from: "EUR2", to: "USD" }, {} as never)) as any;
    expect(result.from).toBe("EUR2");
    expect(result.to).toBe("USD");
    expect(result.convertedAmount).toBe(11);
  });

  test("an unknown `from` code throws", async () => {
    globalThis.fetch = (async () => jsonResponse({ date: "2026-01-01" })) as unknown as typeof fetch; // no "xyz1" key
    expect(execute({ amount: 1, from: "xyz1", to: "usd" }, {} as never)).rejects.toThrow(/unknown currency code "xyz1"/);
  });

  test("an unknown `to` code throws", async () => {
    globalThis.fetch = (async () => jsonResponse({ date: "2026-01-01", xyz2: { eur: 0.9 } })) as unknown as typeof fetch;
    expect(execute({ amount: 1, from: "xyz2", to: "gbp" }, {} as never)).rejects.toThrow(/unknown currency code "gbp"/);
  });

  test("falls back to the mirror URL when the primary fetch fails", async () => {
    let primaryCalled = false;
    globalThis.fetch = (async (url: string) => {
      if (url.includes("jsdelivr")) {
        primaryCalled = true;
        throw new Error("network error");
      }
      return jsonResponse({ date: "2026-01-01", xyz3: { eur: 0.5 } });
    }) as unknown as typeof fetch;
    const result = (await execute({ amount: 10, from: "xyz3", to: "eur" }, {} as never)) as any;
    expect(primaryCalled).toBe(true);
    expect(result.convertedAmount).toBe(5);
  });

  test("caches the rate table for a `from` code — a second call doesn't refetch", async () => {
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount++;
      return jsonResponse({ date: "2026-01-01", xyz4: { eur: 2 } });
    }) as unknown as typeof fetch;
    await execute({ amount: 1, from: "xyz4", to: "eur" }, {} as never);
    await execute({ amount: 2, from: "xyz4", to: "eur" }, {} as never);
    expect(fetchCount).toBe(1);
  });
});
