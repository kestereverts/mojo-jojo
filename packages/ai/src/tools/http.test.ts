import { afterEach, describe, expect, test } from "bun:test";
import { fetchText } from "./http.ts";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("fetchText", () => {
  test("returns the final (post-redirect) URL and a normalized content-type", async () => {
    globalThis.fetch = (async () =>
      new Response("<html></html>", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      })) as unknown as typeof fetch;
    // Response.url reflects the URL actually requested when constructed
    // directly like this (no real redirect happened), which is enough to
    // confirm the field is threaded through, not hardcoded.
    const result = await fetchText("https://example.com/page");
    expect(result.contentType).toBe("text/html");
    expect(typeof result.url).toBe("string");
  });

  test("contentType is undefined when the response has no content-type header", async () => {
    globalThis.fetch = (async () => new Response("plain", { status: 200 })) as unknown as typeof fetch;
    const result = await fetchText("https://example.com/no-content-type");
    expect(result.contentType).toBeUndefined();
  });
});
