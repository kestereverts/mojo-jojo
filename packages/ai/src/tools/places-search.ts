import { tool } from "ai";
import { z } from "zod";
import { fetchJson } from "./http.ts";
import { DailyQuota } from "./quota.ts";
import type { ToolDefinition } from "./define.ts";

interface GooglePlace {
  readonly displayName?: { readonly text?: string };
  readonly formattedAddress?: string;
  readonly rating?: number;
  readonly userRatingCount?: number;
  readonly priceLevel?: string;
  readonly currentOpeningHours?: { readonly openNow?: boolean; readonly weekdayDescriptions?: readonly string[] };
  readonly websiteUri?: string;
  readonly types?: readonly string[];
}
interface GooglePlacesResponse {
  readonly places?: readonly GooglePlace[];
}

const PRICE_LEVELS: Record<string, string> = {
  PRICE_LEVEL_FREE: "Free",
  PRICE_LEVEL_INEXPENSIVE: "$",
  PRICE_LEVEL_MODERATE: "$$",
  PRICE_LEVEL_EXPENSIVE: "$$$",
  PRICE_LEVEL_VERY_EXPENSIVE: "$$$$",
};

const DAILY_LIMIT = 20;
// In-process only — resets on restart, like tools/quota.ts's other consumers
// until M8's SQLite file makes it durable (mojo-ai3's equivalent had the
// same limitation).
const dailyQuota = new DailyQuota(DAILY_LIMIT);

function requireApiKey(): string {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) throw new Error("GOOGLE_MAPS_API_KEY is not configured");
  return key;
}

export function placesSearchTool(): ToolDefinition {
  return {
    name: "places_search",
    durableTranscript: false,
    tool: tool({
      description:
        "Search for local businesses, restaurants, shops, and points of interest via Google Places. " +
        "Returns up to 5 results with name, address, rating, price level, website, and opening hours when available. " +
        `Rate-limited to ${DAILY_LIMIT} calls/day — use only for genuine local business queries.`,
      inputSchema: z.object({
        query: z
          .string()
          .describe(
            "Search query including the type of place and a location, e.g. 'Indian restaurants in Prenzlau' or 'coffee shops near Berlin Mitte'",
          ),
      }),
      execute: async ({ query }) => {
        if (!dailyQuota.tryConsume()) {
          throw new Error("daily rate limit exceeded for places_search — try again tomorrow");
        }

        const apiKey = requireApiKey();
        const data = await fetchJson<GooglePlacesResponse>("https://places.googleapis.com/v1/places:searchText", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Goog-Api-Key": apiKey,
            "X-Goog-FieldMask":
              "places.displayName,places.formattedAddress,places.rating,places.userRatingCount,places.priceLevel,places.currentOpeningHours,places.websiteUri,places.types",
          },
          body: JSON.stringify({ textQuery: query, maxResultCount: 5, languageCode: "en" }),
        });

        const places = (data.places ?? []).map((place) => ({
          name: place.displayName?.text ?? "Unknown",
          address: place.formattedAddress ?? "Address not available",
          rating: place.rating,
          userRatingsTotal: place.userRatingCount,
          priceLevel: place.priceLevel ? PRICE_LEVELS[place.priceLevel] : undefined,
          openNow: place.currentOpeningHours?.openNow,
          openingHours: place.currentOpeningHours?.weekdayDescriptions,
          website: place.websiteUri,
          types: place.types?.slice(0, 3),
        }));

        return { query, places };
      },
    }),
    guidance: {
      id: "tool-places-search",
      title: "places_search",
      body: `Call when the user asks about restaurants, shops, or local points of interest in a location (e.g. "where can I get coffee near Berlin Mitte"). This tool has a daily rate limit — use it only for genuine local-business queries, not general web questions.`,
    },
  };
}
