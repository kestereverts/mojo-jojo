import { afterEach, describe, expect, test } from "bun:test";
import { wolframAlphaTool } from "./wolfram.ts";

const execute = wolframAlphaTool().tool.execute!;
const originalFetch = globalThis.fetch;
const originalId = process.env.WOLFRAM_ALPHA_APP_ID;
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalId === undefined) delete process.env.WOLFRAM_ALPHA_APP_ID;
  else process.env.WOLFRAM_ALPHA_APP_ID = originalId;
});

function textResponse(body: string, status = 200): Response {
  return new Response(body, { status });
}

describe("wolfram_alpha", () => {
  test("returns the trimmed plain-text result on success", async () => {
    process.env.WOLFRAM_ALPHA_APP_ID = "test-id";
    globalThis.fetch = (async () => textResponse("Query:\n\"2+2\"\n\nResult:\n4\n")) as unknown as typeof fetch;
    const result = (await execute({ query: "2+2" }, {} as never)) as any;
    expect(result.query).toBe("2+2");
    expect(result.result).toBe('Query:\n"2+2"\n\nResult:\n4');
  });

  test("a 501 (uninterpretable query) throws with the response body as the message", async () => {
    process.env.WOLFRAM_ALPHA_APP_ID = "test-id";
    globalThis.fetch = (async () => textResponse("Things to try instead:\nrephrase your query", 501)) as unknown as typeof fetch;
    expect(execute({ query: "asdkjfhqwoeirjqwoeir" }, {} as never)).rejects.toThrow(/could not interpret/);
  });

  test("throws when WOLFRAM_ALPHA_APP_ID is not configured", async () => {
    delete process.env.WOLFRAM_ALPHA_APP_ID;
    expect(execute({ query: "2+2" }, {} as never)).rejects.toThrow(/WOLFRAM_ALPHA_APP_ID/);
  });

  test("a non-501 HTTP error throws generically", async () => {
    process.env.WOLFRAM_ALPHA_APP_ID = "test-id";
    globalThis.fetch = (async () => textResponse("server error", 500)) as unknown as typeof fetch;
    expect(execute({ query: "2+2" }, {} as never)).rejects.toThrow(/HTTP 500/);
  });
});
