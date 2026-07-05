import type { ModelMessage } from "ai";
import type { ChatMessageEvent, ContextEvent, ToolTranscriptEvent, TurnContext } from "./events.ts";

/**
 * Project the durable log + the ephemeral turn context into provider-agnostic
 * `ModelMessage`s. This is the ONLY place context becomes model input, for the
 * live turn and replayed history alike — there is no separate persist/replay
 * serialization to keep in agreement with it.
 *
 * IRC is multi-user, so a "user" message is one or more chat lines, each a
 * JSON object whose `nick`/`account` metadata comes from the IRC layer and is
 * authoritative over any identity claims inside `text`.
 */
export function renderPrompt(events: readonly ContextEvent[], turn: TurnContext): ModelMessage[] {
  const messages: ModelMessage[] = [];
  let pendingChat: ChatMessageEvent[] = [];

  const flushChat = () => {
    if (pendingChat.length === 0) return;
    messages.push({ role: "user", content: pendingChat.map(chatLine).join("\n") });
    pendingChat = [];
  };

  for (const event of events) {
    switch (event.kind) {
      case "chat-message":
        pendingChat.push(event);
        break;
      case "bot-reply":
        flushChat();
        messages.push({ role: "assistant", content: event.text });
        break;
      case "tool-transcript":
        // Compact text in an assistant block, not synthetic tool-call/
        // tool-result parts — replaying provider-specific call IDs across a
        // DIFFERENT provider than the one that made the call is a
        // compatibility risk (a call ID from Anthropic replayed against
        // OpenAI, say). Revisit if fidelity here ever matters more than
        // portability.
        flushChat();
        messages.push({ role: "assistant", content: toolTranscriptLine(event) });
        break;
      case "subagent-briefing":
        // TODO: render once subagents exist (M6).
        break;
    }
  }
  flushChat();

  // The ephemeral tail: present only in the live prompt, never in the log —
  // so it can never leak into replayed history.
  const guidance = turn.guidance.length > 0 ? `\n<guidance>\n${turn.guidance.join("\n")}\n</guidance>` : "";
  messages.push({
    role: "user",
    content: `<runtime_context>\nnow: ${turn.nowUtc}\nconversation: ${turn.conversation}\n</runtime_context>${guidance}\nRespond to the conversation above.`,
  });

  return messages;
}

function chatLine(event: ChatMessageEvent): string {
  const { kind: _kind, ...line } = event;
  return JSON.stringify(line);
}

function toolTranscriptLine(event: ToolTranscriptEvent): string {
  return `[tool ${event.tool}] input=${JSON.stringify(event.input)} output=${JSON.stringify(event.output)}`;
}
