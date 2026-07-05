// Public API of @mojo-jojo/ai — the provider-agnostic agent core.
// The bot module is exported from "@mojo-jojo/ai/mojo-ai".

export type {
  BotReplyEvent,
  ChatMessageEvent,
  ContextEvent,
  Speaker,
  SubagentBriefingEvent,
  ToolTranscriptEvent,
  TurnContext,
} from "./context/events.ts";
export { InMemoryContextLog, type ContextLog } from "./context/log.ts";
export { renderPrompt } from "./context/render.ts";
export { runExchange, type ExchangeOptions } from "./exchange.ts";
export { resolveModel } from "./models.ts";
export { defaultTools } from "./tools.ts";
export { DEFAULT_INSTRUCTIONS } from "./persona.ts";
