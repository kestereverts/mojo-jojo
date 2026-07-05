import { describe, expect, test } from "bun:test";
import { MockLanguageModelV4 } from "ai/test";
import type { Friend } from "../identity/speakers.ts";
import { DebugHarness, parseContextEvents } from "./harness.ts";

const FIXED = () => new Date("2026-01-01T00:00:00.000Z");

/** A mock that returns fixed text/usage — proves the injection seam needs no API key. */
function textModel(text: string) {
  return new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: "text", text }],
      finishReason: { unified: "stop", raw: undefined },
      usage: {
        inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 5, text: 5, reasoning: undefined },
      },
      warnings: [],
    }),
  });
}

describe("DebugHarness.chat", () => {
  test("records the incoming line and the delivered reply, returns a result", async () => {
    const h = new DebugHarness({ model: textModel("hi there"), now: FIXED, tools: {} });
    const outcome = await h.chat("hello", { as: "alice" });

    expect(outcome.error).toBeUndefined();
    expect(outcome.reply).toBe("hi there");
    expect(outcome.result?.finishReason).toBe("stop");
    expect(outcome.result?.usage.inputTokens).toBe(10);
    expect(outcome.result?.usage.outputTokens).toBe(5);

    // History: the user's line, then the bot reply — the projection's source of truth.
    const kinds = outcome.history.map((e) => e.kind);
    expect(kinds).toEqual(["chat-message", "bot-reply"]);
    const first = outcome.history[0];
    expect(first).toMatchObject({ kind: "chat-message", speaker: { nick: "alice" }, at: FIXED().toISOString() });
  });

  test("the rendered prompt is exactly what ran (single render path)", async () => {
    const h = new DebugHarness({ model: textModel("ok"), now: FIXED, tools: {} });
    const outcome = await h.chat("ping", { conversation: "#room" });
    // The ephemeral tail carries runtime context + guidance, never appended to the log.
    const tail = outcome.result?.prompt.at(-1);
    expect(String(tail?.content)).toContain("conversation: #room");
    expect(String(tail?.content)).toContain("Reply in at most 3 short lines.");
    expect(outcome.history.some((e) => JSON.stringify(e).includes("runtime_context"))).toBe(false);
  });

  test("caps delivered lines at replyLines and records the capped reply", async () => {
    // NB: this models delivery shaping (the line cap), not IRC transport
    // admission (the live path's per-line safeSay filter) — see DebugHarness.chat.
    const h = new DebugHarness({ model: textModel("l1\nl2\nl3\nl4"), replyLines: 2, tools: {} });
    const outcome = await h.chat("go");
    expect(outcome.replyLines).toEqual(["l1", "l2"]);
    expect(outcome.history.at(-1)).toMatchObject({ kind: "bot-reply", text: "l1\nl2" });
  });

  test("captures exchange errors without swallowing, and does not record a bot-reply", async () => {
    const boom = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new Error("provider exploded");
      },
    });
    const h = new DebugHarness({ model: boom, tools: {} });
    const outcome = await h.chat("hello");
    expect(outcome.result).toBeUndefined();
    expect(outcome.error?.message).toBe("provider exploded");
    expect(outcome.history.map((e) => e.kind)).toEqual(["chat-message"]);
  });

  test("inject stages events before the chat", async () => {
    const h = new DebugHarness({ model: textModel("y"), tools: {} });
    h.inject({
      kind: "chat-message",
      at: FIXED().toISOString(),
      speaker: { nick: "bob", trust: "nick" },
      text: "prior",
      addressed: true,
    });
    const outcome = await h.chat("now");
    expect(outcome.history.map((e) => e.kind)).toEqual(["chat-message", "chat-message", "bot-reply"]);
  });

  describe("identity resolution", () => {
    const alice: Friend = { id: "alice", name: "Alice", aliases: ["alice", "AliceTG"], accounts: ["alice"] };

    test("direct chat (no --via): speaker.trust is 'nick' by default, 'account' when --account is set", async () => {
      const h = new DebugHarness({ model: textModel("hi"), tools: {}, friends: [alice] });
      const direct = await h.chat("hi", { as: "alice" });
      expect(direct.speaker).toMatchObject({ nick: "alice", trust: "nick", personId: "alice" });
      expect(direct.speaker.account).toBeUndefined();

      const withAccount = await h.chat("hi", { as: "alice", account: "alice" });
      expect(withAccount.speaker).toMatchObject({ nick: "alice", account: "alice", trust: "account", personId: "alice" });
    });

    test("--via simulates a relay: nick becomes the relay bot, --as becomes the author, trust is 'relay'", async () => {
      const h = new DebugHarness({ model: textModel("hi"), tools: {}, friends: [alice] });
      const outcome = await h.chat("what city", { as: "AliceTG", via: "Telegram" });
      expect(outcome.speaker).toEqual({
        nick: "Telegram",
        author: "AliceTG",
        via: "Telegram",
        personId: "alice",
        trust: "relay",
      });
      // Persisted in history exactly as resolved — same object, same fidelity as the live module.
      expect(outcome.history[0]).toMatchObject({ kind: "chat-message", speaker: outcome.speaker });
    });

    test("--via ignores --account (a relay-attributed author has no IRC account)", async () => {
      const h = new DebugHarness({ model: textModel("hi"), tools: {} });
      const outcome = await h.chat("hi", { as: "bob", via: "Discord", account: "should-be-ignored" });
      expect(outcome.speaker.account).toBeUndefined();
      expect(outcome.speaker.trust).toBe("relay");
    });

    test("no friend match -> personId absent, resolution still succeeds", async () => {
      const h = new DebugHarness({ model: textModel("hi"), tools: {}, friends: [alice] });
      const outcome = await h.chat("hi", { as: "stranger" });
      expect(outcome.speaker.personId).toBeUndefined();
    });

    test("instructions include the known-users section when friends are configured", async () => {
      const captured: { systemPrompt?: unknown } = {};
      const model = new MockLanguageModelV4({
        doGenerate: async (options: { prompt: unknown }) => {
          captured.systemPrompt = options.prompt;
          return {
            content: [{ type: "text", text: "hi" }],
            finishReason: { unified: "stop", raw: undefined },
            usage: {
              inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
              outputTokens: { total: 1, text: 1, reasoning: undefined },
            },
            warnings: [],
          };
        },
      });
      const h = new DebugHarness({ model, tools: {}, friends: [{ ...alice, city: "Testville" }] });
      await h.chat("hi", { as: "alice" });
      expect(JSON.stringify(captured.systemPrompt)).toContain("Testville");
    });
  });

  describe("default tool registry (tools omitted entirely)", () => {
    test("omitting `tools` uses the real registry — its guidance is folded into instructions", async () => {
      const captured: { systemPrompt?: unknown } = {};
      const model = new MockLanguageModelV4({
        doGenerate: async (options: { prompt: unknown }) => {
          captured.systemPrompt = options.prompt;
          return {
            content: [{ type: "text", text: "hi" }],
            finishReason: { unified: "stop", raw: undefined },
            usage: {
              inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
              outputTokens: { total: 1, text: 1, reasoning: undefined },
            },
            warnings: [],
          };
        },
      });
      // No `tools` field at all — must default to the real registry.
      const h = new DebugHarness({ model });
      await h.chat("hi");
      // A real tool's guidance body text, proving the registry's guidance (not
      // just an empty default) made it into the assembled instructions.
      expect(JSON.stringify(captured.systemPrompt)).toContain("NEVER guess letter counts");
    });

    test("an explicit `tools: {}` opts out of default guidance/durable names entirely", async () => {
      const captured: { systemPrompt?: unknown } = {};
      const model = new MockLanguageModelV4({
        doGenerate: async (options: { prompt: unknown }) => {
          captured.systemPrompt = options.prompt;
          return {
            content: [{ type: "text", text: "hi" }],
            finishReason: { unified: "stop", raw: undefined },
            usage: {
              inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
              outputTokens: { total: 1, text: 1, reasoning: undefined },
            },
            warnings: [],
          };
        },
      });
      const h = new DebugHarness({ model, tools: {} });
      await h.chat("hi");
      expect(JSON.stringify(captured.systemPrompt)).not.toContain("NEVER guess letter counts");
    });
  });
});

describe("parseContextEvents", () => {
  test("accepts a single event and an array, stamping missing `at`", () => {
    const one = parseContextEvents({ kind: "bot-reply", text: "hi" }, FIXED);
    expect(one).toEqual([{ kind: "bot-reply", text: "hi", at: FIXED().toISOString() }]);
    const many = parseContextEvents([
      { kind: "chat-message", speaker: { nick: "a" }, text: "x", addressed: true },
      { kind: "bot-reply", text: "y", at: "2020-01-01T00:00:00.000Z" },
    ]);
    expect(many).toHaveLength(2);
    expect(many[1]?.at).toBe("2020-01-01T00:00:00.000Z");
  });

  test("rejects unknown kinds and non-objects", () => {
    expect(() => parseContextEvents({ kind: "nope" })).toThrow(/invalid kind/);
    expect(() => parseContextEvents([42])).toThrow(/not an object/);
  });
});
