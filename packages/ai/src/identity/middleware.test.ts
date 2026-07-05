import { describe, expect, test } from "bun:test";
import { runChatMiddleware, type ChatMessage, type ChatMiddleware } from "./middleware.ts";

function msg(text: string, nick = "relay-bot"): ChatMessage {
  return {
    raw: { user: { nick } } as never, // middleware only needs `raw` for identity checks it doesn't run here
    speaker: { nick },
    text,
    channel: "#chan",
    at: "2026-01-01T00:00:00.000Z",
  };
}

describe("runChatMiddleware", () => {
  test("empty chain returns the message unchanged", () => {
    const m = msg("hello");
    expect(runChatMiddleware(m, [])).toBe(m);
  });

  test("runs stages in order, each seeing the previous stage's output", () => {
    const upper: ChatMiddleware = (m) => ({ ...m, text: m.text.toUpperCase() });
    const exclaim: ChatMiddleware = (m) => ({ ...m, text: `${m.text}!` });
    const result = runChatMiddleware(msg("hi"), [upper, exclaim]);
    expect(result?.text).toBe("HI!");
  });

  test("a stage returning null drops the message and short-circuits later stages", () => {
    let laterRan = false;
    const drop: ChatMiddleware = () => null;
    const later: ChatMiddleware = (m) => {
      laterRan = true;
      return m;
    };
    const result = runChatMiddleware(msg("hi"), [drop, later]);
    expect(result).toBeNull();
    expect(laterRan).toBe(false);
  });

  test("rewrites propagate: a stage sees fields an earlier stage set", () => {
    const setAuthor: ChatMiddleware = (m) => ({ ...m, speaker: { ...m.speaker, author: "alice", via: "Telegram" } });
    const readAuthor: ChatMiddleware = (m) => ({ ...m, text: `${m.text} (from ${m.speaker.author} via ${m.speaker.via})` });
    const result = runChatMiddleware(msg("hi"), [setAuthor, readAuthor]);
    expect(result?.text).toBe("hi (from alice via Telegram)");
  });
});
