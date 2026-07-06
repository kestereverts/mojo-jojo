import { afterEach, describe, expect, test } from "bun:test";
import { pasteTool } from "./paste.ts";

const execute = pasteTool().tool.execute!;
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

describe("paste", () => {
  test("returns the id/url on success and sends the real portal request shape", async () => {
    process.env.MOJO_PORTAL_API_KEY = "test-key";
    let sentBody: any;
    let sentUrl = "";
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      sentUrl = url;
      sentBody = JSON.parse(init.body as string);
      return textResponse(JSON.stringify({ id: ":abc123", url: "https://mojo.v00l.com/:abc123" }));
    }) as unknown as typeof fetch;

    const result = (await execute(
      { title: "My Title", files: [{ filename: "a.txt", content: "hello", language: "text" }] },
      {} as never,
    )) as any;

    expect(result).toEqual({ id: ":abc123", url: "https://mojo.v00l.com/:abc123" });
    expect(sentUrl).toBe("https://mojo.v00l.com/api/paste");
    expect(sentBody).toEqual({
      title: "My Title",
      files: [{ filename: "a.txt", content: "hello", language: "text", render_markdown: undefined }],
    });
  });

  test("defaults an omitted/blank title to 'Mojo Paste'", async () => {
    process.env.MOJO_PORTAL_API_KEY = "test-key";
    let sentBody: any;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      sentBody = JSON.parse(init.body as string);
      return textResponse(JSON.stringify({ id: ":x", url: "https://mojo.v00l.com/:x" }));
    }) as unknown as typeof fetch;

    await execute({ files: [{ filename: "a.txt", content: "hi" }] }, {} as never);
    expect(sentBody.title).toBe("Mojo Paste");
  });

  test("surfaces the portal's JSON {error} message on failure", async () => {
    process.env.MOJO_PORTAL_API_KEY = "bad-key";
    globalThis.fetch = (async () => textResponse(JSON.stringify({ error: "Invalid API key" }), 401)) as unknown as typeof fetch;
    expect(execute({ files: [{ filename: "a.txt", content: "hi" }] }, {} as never)).rejects.toThrow(/Invalid API key/);
  });

  test("surfaces a plain-text (non-JSON) error body verbatim", async () => {
    process.env.MOJO_PORTAL_API_KEY = "test-key";
    globalThis.fetch = (async () =>
      textResponse("Json deserialize error: missing field `files` at line 1 column 16", 400)) as unknown as typeof fetch;
    expect(execute({ files: [{ filename: "a.txt", content: "hi" }] }, {} as never)).rejects.toThrow(
      /missing field `files`/,
    );
  });

  test("throws when MOJO_PORTAL_API_KEY is not configured", async () => {
    delete process.env.MOJO_PORTAL_API_KEY;
    expect(execute({ files: [{ filename: "a.txt", content: "hi" }] }, {} as never)).rejects.toThrow(
      /MOJO_PORTAL_API_KEY/,
    );
  });
});
