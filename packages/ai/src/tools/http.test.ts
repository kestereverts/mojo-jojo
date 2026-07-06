import { afterEach, describe, expect, test } from "bun:test";
import { fetchText, readCapped } from "./http.ts";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function withStampedUrl(res: Response, url: string): Response {
  Object.defineProperty(res, "url", { value: url });
  return res;
}

describe("fetchText", () => {
  test("returns the final (post-redirect) URL and a normalized content-type", async () => {
    globalThis.fetch = (async () =>
      withStampedUrl(
        new Response("<html></html>", { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }),
        "https://example.com/final-after-redirect",
      )) as unknown as typeof fetch;
    const result = await fetchText("https://example.com/original");
    expect(result.contentType).toBe("text/html");
    // Genuinely verifies the field is threaded from the response, not just
    // present as a string — a vacuous `typeof === "string"` check would also
    // pass on the request URL or an empty string.
    expect(result.url).toBe("https://example.com/final-after-redirect");
  });

  test("contentType is undefined when the response has no content-type header", async () => {
    globalThis.fetch = (async () => new Response("plain", { status: 200 })) as unknown as typeof fetch;
    const result = await fetchText("https://example.com/no-content-type");
    expect(result.contentType).toBeUndefined();
  });
});

describe("readCapped — streaming byte cap", () => {
  test("aborts once the running total exceeds maxBytes, without needing the stream to finish", async () => {
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        // An effectively infinite stream — if readCapped buffered the whole
        // thing before checking size, this would hang/OOM instead of
        // rejecting quickly.
        controller.enqueue(new Uint8Array(10_000));
      },
    });
    const res = new Response(stream);
    await expect(readCapped(res, 25_000)).rejects.toThrow(/too large/);
    // 3 chunks of 10k exceed the 25k cap on the 3rd pull; must not have
    // pulled anywhere near an "infinite stream"'s worth.
    expect(pulled).toBeLessThan(10);
  });

  test("returns the full text when under the cap", async () => {
    const res = new Response("hello world");
    expect(await readCapped(res, 1000)).toBe("hello world");
  });
});
