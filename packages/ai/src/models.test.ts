import { describe, expect, test } from "bun:test";
import { resolveEmbeddingModel, resolveModel } from "./models.ts";

describe("resolveModel", () => {
  test("rejects specs without a provider/model-id shape", () => {
    expect(() => resolveModel("no-slash")).toThrow(/provider\/model-id/);
    expect(() => resolveModel("/missing-provider")).toThrow(/provider\/model-id/);
    expect(() => resolveModel("openai/")).toThrow(/provider\/model-id/);
    expect(() => resolveModel("")).toThrow(/provider\/model-id/);
  });

  test("rejects an unknown provider, listing the known ones", () => {
    expect(() => resolveModel("anthropic/claude-x")).toThrow(/unknown model provider "anthropic"/);
    expect(() => resolveModel("anthropic/claude-x")).toThrow(/known: google, openai/);
  });

  test("resolves known providers to a model object (construction only, no network)", () => {
    expect(resolveModel("google/gemini-3.5-flash")).toBeTruthy();
    expect(resolveModel("openai/gpt-5.4-mini")).toBeTruthy();
  });

  test("resolving the same spec twice reuses the cached provider instance", () => {
    // Not strictly observable from the returned model, but resolving twice
    // must not throw (e.g. re-registering something on a shared client).
    expect(() => {
      resolveModel("openai/gpt-5.4-mini");
      resolveModel("openai/gpt-5.4-mini");
    }).not.toThrow();
  });
});

describe("resolveEmbeddingModel", () => {
  test("rejects specs without a provider/model-id shape", () => {
    expect(() => resolveEmbeddingModel("no-slash")).toThrow(/provider\/model-id/);
  });

  test("rejects an unknown embedding provider, listing only wired ones", () => {
    expect(() => resolveEmbeddingModel("google/text-embedding-004")).toThrow(
      /unknown embedding provider "google"/,
    );
    expect(() => resolveEmbeddingModel("google/text-embedding-004")).toThrow(/known: openai/);
  });

  test("resolves openai to an embedding model object", () => {
    expect(resolveEmbeddingModel("openai/text-embedding-3-small")).toBeTruthy();
  });
});
