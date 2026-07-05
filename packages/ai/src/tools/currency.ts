import { tool } from "ai";
import { z } from "zod";
import { fetchJson } from "./http.ts";
import { TtlCache } from "./cache.ts";
import type { ToolDefinition } from "./define.ts";

const PRIMARY_URL = "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies";
const FALLBACK_URL = "https://latest.currency-api.pages.dev/v1/currencies";
// Rates are published once daily; a day-long cache avoids refetching the
// (large — 200+ currency) rate table on every conversion.
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const rateCache = new TtlCache<Record<string, number>>(50);

async function getRates(from: string): Promise<Record<string, number>> {
  const key = from.toLowerCase();
  const cached = rateCache.get(key);
  if (cached) return cached;

  let data: Record<string, unknown>;
  try {
    data = await fetchJson(`${PRIMARY_URL}/${key}.json`);
  } catch {
    data = await fetchJson(`${FALLBACK_URL}/${key}.json`);
  }
  const rates = data[key] as Record<string, number> | undefined;
  if (!rates) throw new Error(`unknown currency code "${from}"`);
  rateCache.set(key, rates, CACHE_TTL_MS);
  return rates;
}

/**
 * Currency/crypto conversion via the same free, keyless jsDelivr-hosted API
 * mojo-ai3 used (with its Cloudflare Pages mirror as a fallback). Modernized:
 * the hardcoded name→code alias tables ("dollar"→"usd") are dropped — the
 * tool only accepts codes, and the guidance tells the MODEL to normalize a
 * name to its code itself before calling, rather than the tool maintaining
 * an alias list that inevitably falls behind.
 */
export function currencyConvertTool(): ToolDefinition {
  return {
    name: "currency_convert",
    durableTranscript: false,
    tool: tool({
      description: "Convert an amount between currencies (200+ fiat currencies and cryptocurrencies) using current exchange rates.",
      inputSchema: z.object({
        amount: z.number().describe("The amount to convert"),
        from: z.string().describe("ISO 4217 currency code or crypto symbol, e.g. USD, EUR, BTC"),
        to: z.string().describe("ISO 4217 currency code or crypto symbol, e.g. USD, EUR, BTC"),
      }),
      execute: async ({ amount, from, to }) => {
        const rates = await getRates(from);
        const rate = rates[to.toLowerCase()];
        if (rate === undefined) throw new Error(`unknown currency code "${to}"`);
        return {
          originalAmount: amount,
          from: from.toUpperCase(),
          to: to.toUpperCase(),
          convertedAmount: amount * rate,
          exchangeRate: rate,
        };
      },
    }),
    guidance: {
      id: "tool-currency-convert",
      title: "currency_convert",
      body: `Call when the user asks for currency conversion or an exchange rate (e.g. "100 USD to EUR"). This tool takes ISO 4217 codes or crypto symbols (USD, EUR, BTC) — if the user names a currency ("dollars", "euros"), convert it to its code yourself before calling. NEVER make up or guess an exchange rate.`,
    },
  };
}
