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
export {
  runExchange,
  type ExchangeOptions,
  type ExchangeResult,
  type ExchangeStep,
  type ExchangeToolCall,
} from "./exchange.ts";
export { toReplyLines } from "./reply.ts";
export { resolveModel, resolveEmbeddingModel, type ModelRoles } from "./models.ts";
export { defaultTools } from "./tools.ts";
export { DEFAULT_INSTRUCTIONS } from "./persona.ts";
