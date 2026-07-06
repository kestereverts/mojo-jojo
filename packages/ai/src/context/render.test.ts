import { describe, expect, test } from "bun:test";
import type { ContextEvent, TurnContext } from "./events.ts";
import { renderPrompt } from "./render.ts";

const turn: TurnContext = {
  nowUtc: "2026-07-03T12:00:00.000Z",
  conversation: "#mojo2",
  guidance: ["Reply in at most 3 short lines."],
};

const chat = (nick: string, text: string, addressed = false): ContextEvent => ({
  kind: "chat-message",
  at: "2026-07-03T11:59:00.000Z",
  speaker: { nick, trust: "nick" },
  text,
  addressed,
});

describe("renderPrompt", () => {
  test("coalesces consecutive chat lines into one user message", () => {
    const messages = renderPrompt([chat("alice", "hi"), chat("bob", "hello")], turn);
    // one coalesced user message + the ephemeral tail
    expect(messages).toHaveLength(2);
    expect(messages[0]?.role).toBe("user");
    const lines = String(messages[0]?.content).split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toMatchObject({ speaker: { nick: "alice" }, text: "hi" });
  });

  test("bot replies become assistant messages between user blocks", () => {
    const messages = renderPrompt(
      [
        chat("alice", "mojo: hi", true),
        { kind: "bot-reply", at: "2026-07-03T11:59:30.000Z", text: "hi alice" },
        chat("bob", "what did I miss?"),
      ],
      turn,
    );
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "user"]);
    expect(messages[1]?.content).toBe("hi alice");
  });

  test("ephemeral turn context is only in the final message, never mid-history", () => {
    const messages = renderPrompt([chat("alice", "hi")], turn);
    const tail = String(messages.at(-1)?.content);
    expect(tail).toContain("<runtime_context>");
    expect(tail).toContain("2026-07-03T12:00:00.000Z");
    expect(tail).toContain("Reply in at most 3 short lines.");
    for (const message of messages.slice(0, -1)) {
      expect(String(message.content)).not.toContain("<runtime_context>");
    }
  });

  test("no guidance -> no guidance block", () => {
    const messages = renderPrompt([], { ...turn, guidance: [] });
    expect(String(messages.at(-1)?.content)).not.toContain("<guidance>");
  });

  test("tool transcripts render as a compact assistant block, flushing pending chat lines first", () => {
    const messages = renderPrompt(
      [
        chat("alice", "mojo: what's the weather?", true),
        { kind: "tool-transcript", at: "2026-07-03T11:59:15.000Z", tool: "weather", input: { location: "Tokyo" }, output: { tempC: 20 } },
        chat("bob", "cool"),
      ],
      turn,
    );
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "user"]);
    expect(messages[1]?.content).toBe('[tool weather] input={"location":"Tokyo"} output={"tempC":20}');
  });

  test("a subagent briefing renders as a compact assistant block, flushing pending chat lines first", () => {
    const messages = renderPrompt(
      [
        chat("alice", "mojo: research bun"),
        { kind: "subagent-briefing", at: "2026-07-03T11:59:15.000Z", agent: "research_topic", briefing: { summary: "x" } },
        chat("bob", "nice"),
      ],
      turn,
    );
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "user"]);
    expect(messages[1]?.content).toBe('[research_topic briefing] {"summary":"x"}');
  });
});
