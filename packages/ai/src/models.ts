import { createGoogle } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";

/**
 * Resolve a `"provider/model-id"` config string to a concrete model, so the
 * provider stays a config concern. Direct provider SDKs (no gateway); keys
 * come from the environment: GEMINI_API_KEY (the Google SDK's own default is
 * GOOGLE_GENERATIVE_AI_API_KEY, so it is passed explicitly) and OPENAI_API_KEY.
 */
export function resolveModel(spec: string): LanguageModel {
  const slash = spec.indexOf("/");
  if (slash <= 0 || slash === spec.length - 1) {
    throw new Error(`model must be "provider/model-id", got "${spec}"`);
  }
  const provider = spec.slice(0, slash);
  const modelId = spec.slice(slash + 1);
  const factory = providerFactories[provider];
  if (!factory) {
    const known = Object.keys(providerFactories).join(", ");
    throw new Error(`unknown model provider "${provider}" (known: ${known})`);
  }
  return factory(modelId);
}

const providerFactories: Record<string, ((modelId: string) => LanguageModel) | undefined> = {
  google: (modelId) => googleProvider().languageModel(modelId),
  openai: (modelId) => openaiProvider().languageModel(modelId),
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
