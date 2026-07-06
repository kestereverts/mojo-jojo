import { afterEach, describe, expect, test } from "bun:test";
import { getPasteTool } from "./get-paste.ts";

const execute = getPasteTool().tool.execute!;
const originalFetch = globalThis.fetch;
const originalKey = process.env.MOJO_PORTAL_API_KEY;
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.MOJO_PORTAL_API_KEY;
  else process.env.MOJO_PORTAL_API_KEY = originalKey;
});

function textResponse(body: string, status = 200): Response {
  return new Response(body, { status });
}

const PASTE_BODY = JSON.stringify({
  title: "My Paste",
  files: [{ filename: "a.txt", content: "hello", language: "text" }],
});

describe("get_paste — ID/URL parsing (the URL-API modernization)", () => {
  const cases: [string, string][] = [
    [":GESjAk", "https://mojo.v00l.com/api/paste/:GESjAk"], // bare ID with colon
    ["GESjAk", "https://mojo.v00l.com/api/paste/:GESjAk"], // bare ID, colon added
    ["https://mojo.v00l.com/:GESjAk", "https://mojo.v00l.com/api/paste/:GESjAk"], // full URL
    ["  :GESjAk  ", "https://mojo.v00l.com/api/paste/:GESjAk"], // whitespace trimmed
    ["https://mojo.v00l.com/:GESjAk/", "https://mojo.v00l.com/api/paste/:GESjAk"], // trailing slash stripped (review finding)
  ];

  for (const [input, expectedUrl] of cases) {
    test(`"${input}" -> ${expectedUrl}`, async () => {
      process.env.MOJO_PORTAL_API_KEY = "test-key";
      let sentUrl = "";
      globalThis.fetch = (async (url: string) => {
        sentUrl = url;
        return textResponse(PASTE_BODY);
      }) as unknown as typeof fetch;
      await execute({ id: input }, {} as never);
      expect(sentUrl).toBe(expectedUrl);
    });
  }

  test("a URL with no path segment throws a clear error rather than hitting the API with an empty ID", async () => {
    process.env.MOJO_PORTAL_API_KEY = "test-key";
    expect(execute({ id: "https://mojo.v00l.com/" }, {} as never)).rejects.toThrow(/could not extract a valid paste ID/);
  });

  test("a bare colon (no ID characters) is rejected rather than silently sent to the API (review finding)", async () => {
    process.env.MOJO_PORTAL_API_KEY = "test-key";
    expect(execute({ id: ":" }, {} as never)).rejects.toThrow(/could not extract a valid paste ID/);
  });

  test("a bare ID with a query-string-like tail is rejected rather than silently included in the ID (review finding)", async () => {
    process.env.MOJO_PORTAL_API_KEY = "test-key";
    expect(execute({ id: ":GESjAk?x=1" }, {} as never)).rejects.toThrow(/could not extract a valid paste ID/);
  });
});

describe("get_paste — request handling", () => {
  test("returns title/files on success", async () => {
    process.env.MOJO_PORTAL_API_KEY = "test-key";
    globalThis.fetch = (async () => textResponse(PASTE_BODY)) as unknown as typeof fetch;
    const result = (await execute({ id: ":GESjAk" }, {} as never)) as any;
    expect(result).toEqual({ title: "My Paste", files: [{ filename: "a.txt", content: "hello", language: "text" }] });
  });

  test("a 404 throws 'paste not found'", async () => {
    process.env.MOJO_PORTAL_API_KEY = "test-key";
    globalThis.fetch = (async () => textResponse(JSON.stringify({ error: "Paste not found" }), 404)) as unknown as typeof fetch;
    expect(execute({ id: ":nope" }, {} as never)).rejects.toThrow(/paste not found/);
  });

  test("throws when MOJO_PORTAL_API_KEY is not configured", async () => {
    delete process.env.MOJO_PORTAL_API_KEY;
    expect(execute({ id: ":x" }, {} as never)).rejects.toThrow(/MOJO_PORTAL_API_KEY/);
  });
});
