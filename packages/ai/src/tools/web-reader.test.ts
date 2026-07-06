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
  test("paginates long content and reports hasMore/totalLength correctly", async () => {
    const longText = "x".repeat(25_000);
    globalThis.fetch = mockFetchReturning(longText, "text/plain", 200);
    const first = (await execute({ url: "https://example.com/unique-6.txt" }, {} as never)) as any;
    expect(first.content.length).toBe(20_000);
    expect(first.totalLength).toBe(25_000);
    expect(first.hasMore).toBe(true);

    const second = (await execute({ url: "https://example.com/unique-6.txt", startIndex: 20_000 }, {} as never)) as any;
    expect(second.content.length).toBe(5_000);
    expect(second.hasMore).toBe(false);
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
});
