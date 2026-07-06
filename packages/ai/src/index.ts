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
  recordDurableTranscripts,
  type ExchangeOptions,
  type ExchangeResult,
  type ExchangeStep,
  type ExchangeToolCall,
} from "./exchange.ts";
export { toReplyLines } from "./reply.ts";
export { resolveModel, resolveEmbeddingModel, type ModelRoles } from "./models.ts";
export { buildToolSet, defaultToolDefinitions, type ToolRegistryResult } from "./tools/index.ts";
export type { ToolDefinition } from "./tools/define.ts";
export { fetchJson, fetchText, type FetchLimits } from "./tools/http.ts";
export { TtlCache } from "./tools/cache.ts";
export { DailyQuota, TokenBucket } from "./tools/quota.ts";
export { letterCountTool } from "./tools/letter-count.ts";
export { localTimeTool } from "./tools/local-time.ts";
export { currencyConvertTool } from "./tools/currency.ts";
export { weatherForecastTool } from "./tools/weather.ts";
export { wolframAlphaTool } from "./tools/wolfram.ts";
export { webSearchTool } from "./tools/web-search.ts";
export { webReaderTool } from "./tools/web-reader.ts";
export { pasteTool } from "./tools/paste.ts";
export { getPasteTool } from "./tools/get-paste.ts";
export { placesSearchTool } from "./tools/places-search.ts";
export {
  runChatMiddleware,
  type ChatMessage,
  type ChatMiddleware,
  type SpeakerFacts,
} from "./identity/middleware.ts";
export {
  createRelayMiddleware,
  parseRelays,
  stripIrcFormatting,
  type RelayDefinition,
} from "./identity/relay.ts";
export {
  loadFriendsFile,
  resolveSpeaker,
  type Friend,
  type LoadFriendsResult,
} from "./identity/speakers.ts";
export { type PromptSection, assembleInstructions } from "./prompt/sections.ts";
export { buildKnownUsersSection } from "./prompt/friends.ts";
export { buildDefaultInstructions } from "./prompt/instructions.ts";
