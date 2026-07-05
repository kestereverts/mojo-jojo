import { createGoogle } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import type { EmbeddingModel, LanguageModel } from "ai";

/**
 * The occasions a model gets used for. Each resolves independently through
 * {@link resolveModel} (or {@link resolveEmbeddingModel} for `embedding`), so a
 * cheap/fast model can back classification while a stronger one carries the
 * conversation — and providers can differ per role.
 */
export interface ModelRoles {
  /** The main conversational exchange. */
  readonly chat: string;
  /** Input/output guard classifiers (M7). */
  readonly classifier: string;
  /** Context-compaction summarization (M8). */
  readonly summarizer: string;
  /** Subagents, e.g. research (M6). */
  readonly research: string;
  /** Leak-detector embeddings (M7). */
  readonly embedding: string;
}

/** Split a `"provider/model-id"` spec; shared by the language- and embedding-model resolvers. */
function splitSpec(spec: string): { provider: string; modelId: string } {
  const slash = spec.indexOf("/");
  if (slash <= 0 || slash === spec.length - 1) {
    throw new Error(`model must be "provider/model-id", got "${spec}"`);
  }
  return { provider: spec.slice(0, slash), modelId: spec.slice(slash + 1) };
}

/**
 * Resolve a `"provider/model-id"` config string to a concrete model, so the
 * provider stays a config concern. Direct provider SDKs (no gateway); keys
 * come from the environment: GEMINI_API_KEY (the Google SDK's own default is
 * GOOGLE_GENERATIVE_AI_API_KEY, so it is passed explicitly) and OPENAI_API_KEY.
 */
export function resolveModel(spec: string): LanguageModel {
  const { provider, modelId } = splitSpec(spec);
  const factory = providerFactories[provider];
  if (!factory) {
    const known = Object.keys(providerFactories).join(", ");
    throw new Error(`unknown model provider "${provider}" (known: ${known})`);
  }
  return factory(modelId);
}

/**
 * Resolve a `"provider/model-id"` spec to an embedding model. Only `openai` is
 * wired for now (`text-embedding-3-small` by default, zero new deps); other
 * providers throw the same "known: ..." shape as {@link resolveModel}.
 */
export function resolveEmbeddingModel(spec: string): EmbeddingModel {
  const { provider, modelId } = splitSpec(spec);
  const factory = embeddingProviderFactories[provider];
  if (!factory) {
    const known = Object.keys(embeddingProviderFactories).join(", ");
    throw new Error(`unknown embedding provider "${provider}" (known: ${known})`);
  }
  return factory(modelId);
}

const providerFactories: Record<string, ((modelId: string) => LanguageModel) | undefined> = {
  google: (modelId) => googleProvider().languageModel(modelId),
  openai: (modelId) => openaiProvider().languageModel(modelId),
};

const embeddingProviderFactories: Record<string, ((modelId: string) => EmbeddingModel) | undefined> = {
  openai: (modelId) => openaiProvider().embedding(modelId),
};

// Providers are created lazily (env is read at first use, after .env loading)
// and cached (one HTTP-config object per process, not per exchange).
let google: ReturnType<typeof createGoogle> | undefined;
function googleProvider() {
  google ??= createGoogle({ apiKey: process.env.GEMINI_API_KEY });
  return google;
}

let openai: ReturnType<typeof createOpenAI> | undefined;
function openaiProvider() {
  openai ??= createOpenAI();
  return openai;
}
