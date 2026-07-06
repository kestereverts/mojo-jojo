import { afterEach, describe, expect, test } from "bun:test";
import { webReaderTool } from "./web-reader.ts";

const execute = webReaderTool().tool.execute!;
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

// Response's `url` is read-only and not settable via the constructor, so
// each mock fetch stamps it via defineProperty from the requested URL.
function mockFetchReturning(html: string, contentType = "text/html; charset=utf-8", status = 200): typeof fetch {
  return (async (url: string) => {
    const res = new Response(html, { status, headers: { "content-type": contentType } });
    Object.defineProperty(res, "url", { value: url });
    return res;
  }) as unknown as typeof fetch;
}

const ARTICLE_HTML = `<html><head><title>Test Article</title></head><body>
<article>
<h1>Hello World</h1>
<p>This is a test paragraph with some real content in it for extraction purposes.</p>
<ul><li>Item one</li><li>Item two</li></ul>
</article>
</body></html>`;

describe("web_reader — HTML extraction", () => {
  test("extracts title and markdown content from a real article page", async () => {
    globalThis.fetch = mockFetchReturning(ARTICLE_HTML, "text/html", 200);
    const result = (await execute({ url: "https://example.com/unique-1" }, {} as never)) as any;
    expect(result.title).toBe("Test Article");
    expect(result.content).toContain("Hello World");
    expect(result.content).toContain("Item one");
    expect(result.domain).toBe("example.com");
  });

  test("no readable content throws a clear, consent/paywall-aware error", async () => {
    globalThis.fetch = mockFetchReturning("<html><body></body></html>", "text/html", 200);
    expect(execute({ url: "https://example.com/unique-2" }, {} as never)).rejects.toThrow(/no readable text extracted/);
  });

  test("a Defuddle failure falls back to fast-dom extraction with a surfaced warning (not silently), using a FRESH dom rather than one Defuddle may have mutated before throwing", async () => {
    // A real Defuddle crash is genuinely reproducible (pathologically deep
    // HTML nesting throws "Maximum call stack size exceeded" — confirmed by
    // hand), but far too slow for a unit test (tens of seconds even at a
    // few thousand levels of nesting). Mocking the module gives the same
    // catch-path coverage in milliseconds. Uses a fresh module instance
    // (mock.module + a cache-busting dynamic import) so the mock doesn't
    // affect this file's other tests, which already bound the REAL
    // defuddle/node via their own top-level static import before this runs.
    const { mock } = await import("bun:test");
    mock.module("defuddle/node", () => ({
      Defuddle: async () => {
        throw new Error("simulated Defuddle failure");
      },
    }));
    const { webReaderTool: freshTool } = await import(`./web-reader.ts?isolate=${Date.now()}`);
    const freshExecute = freshTool().tool.execute!;

    globalThis.fetch = mockFetchReturning(ARTICLE_HTML, "text/html", 200);
    const result = (await freshExecute({ url: "https://example.com/unique-10" }, {} as never)) as any;

    expect(result.extractorType).toBe("fast-dom-fallback");
    expect(result.extractionWarning).toContain("simulated Defuddle failure");
    // The fast-dom fallback still extracts real content correctly.
    expect(result.content).toContain("Hello World");
  });
});

describe("web_reader — non-HTML text-based content", () => {
  test("wraps JSON as a fenced code block, pretty-printed", async () => {
    globalThis.fetch = mockFetchReturning(JSON.stringify({ a: 1 }), "application/json", 200);
    const result = (await execute({ url: "https://example.com/unique-3.json" }, {} as never)) as any;
    expect(result.content).toBe('```json\n{\n  "a": 1\n}\n```');
  });

  test("leaves plain text unwrapped", async () => {
    globalThis.fetch = mockFetchReturning("just some plain text content", "text/plain", 200);
    const result = (await execute({ url: "https://example.com/unique-4.txt" }, {} as never)) as any;
    expect(result.content).toBe("just some plain text content");
  });

  test("an unsupported content-type throws", async () => {
    globalThis.fetch = mockFetchReturning("binary-ish", "application/octet-stream", 200);
    expect(execute({ url: "https://example.com/unique-5.bin" }, {} as never)).rejects.toThrow(/unsupported content-type/);
  });
});

describe("web_reader — pagination", () => {
  test("paginates long content and reports hasMore/totalLength/nextIndex correctly", async () => {
    const longText = "x".repeat(25_000);
    globalThis.fetch = mockFetchReturning(longText, "text/plain", 200);
    const first = (await execute({ url: "https://example.com/unique-6.txt" }, {} as never)) as any;
    expect(first.content.length).toBe(20_000);
    expect(first.totalLength).toBe(25_000);
    expect(first.hasMore).toBe(true);
    expect(first.nextIndex).toBe(20_000);

    const second = (await execute({ url: "https://example.com/unique-6.txt", startIndex: first.nextIndex }, {} as never)) as any;
    expect(second.content.length).toBe(5_000);
    expect(second.hasMore).toBe(false);
    expect(second.nextIndex).toBeUndefined();
  });

  test("following the documented protocol (startIndex = previous nextIndex, NOT totalLength) reconstructs the full content — regression for a bug caught in review where the guidance told the model to use totalLength, which is always past the end", async () => {
    const original = "y".repeat(45_000);
    globalThis.fetch = mockFetchReturning(original, "text/plain", 200);

    let startIndex: number | undefined = 0;
    let reconstructed = "";
    let calls = 0;
    while (startIndex !== undefined) {
      calls++;
      if (calls > 10) throw new Error("test guard: too many pagination calls");
      const page = (await execute({ url: "https://example.com/unique-9.txt", startIndex }, {} as never)) as any;
      reconstructed += page.content;
      startIndex = page.hasMore ? page.nextIndex : undefined;
    }

    expect(reconstructed).toBe(original);
    expect(calls).toBe(3); // 45_000 / 20_000, rounded up
  });
});

describe("web_reader — request handling", () => {
  test("a non-2xx status throws", async () => {
    globalThis.fetch = mockFetchReturning("nope", "text/html", 500);
    expect(execute({ url: "https://example.com/unique-7" }, {} as never)).rejects.toThrow(/status 500/);
  });

  test("caches the extracted page per URL — a second call (same startIndex=0) doesn't refetch", async () => {
    let fetchCount = 0;
    globalThis.fetch = (async (url: string) => {
      fetchCount++;
      const res = new Response(ARTICLE_HTML, { status: 200, headers: { "content-type": "text/html" } });
      Object.defineProperty(res, "url", { value: url });
      return res;
    }) as unknown as typeof fetch;

    await execute({ url: "https://example.com/unique-8" }, {} as never);
    await execute({ url: "https://example.com/unique-8" }, {} as never);
    expect(fetchCount).toBe(1);
  });

  test("connects to the RESOLVED IP address, not a fresh hostname re-resolution (the DNS-rebinding/TOCTOU fix)", async () => {
    const captured: { url: string; hostHeader: string | null } = { url: "", hostHeader: null };
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      captured.url = url;
      captured.hostHeader = new Headers(init?.headers).get("Host");
      const res = new Response(ARTICLE_HTML, { status: 200, headers: { "content-type": "text/html" } });
      Object.defineProperty(res, "url", { value: url });
      return res;
    }) as unknown as typeof fetch;

    const result = (await execute({ url: "https://example.com/unique-11" }, {} as never)) as any;

    // The actual fetch target's host is a resolved IP, not the hostname —
    // proving the connection uses the SAME address `resolvePublicHttpUrl`
    // validated, rather than fetch() re-resolving "example.com" itself.
    const requestedHost = new URL(captured.url).hostname.replace(/^\[|\]$/g, "");
    expect(requestedHost).not.toBe("example.com");
    expect(captured.hostHeader).toBe("example.com");
    // But the result reports the real, human-meaningful hostname-based URL.
    expect(result.url).toBe("https://example.com/unique-11");
    expect(result.domain).toBe("example.com");
  });
});
