import { tool } from "ai";
import { z } from "zod";
import { fetchJson } from "./http.ts";
import type { ToolDefinition } from "./define.ts";

interface GeocodeResponse {
  readonly status: string;
  readonly results: readonly { formatted_address: string; geometry: { location: { lat: number; lng: number } } }[];
  // Geocoding uses snake_case for this field (the Time Zone API below uses
  // camelCase for the equivalent — an inconsistency in Google's own APIs,
  // verified against both APIs' docs, not assumed).
  readonly error_message?: string;
}

interface TimezoneResponse {
  readonly status: string;
  readonly timeZoneId?: string;
  readonly errorMessage?: string;
}

function requireApiKey(): string {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) throw new Error("GOOGLE_MAPS_API_KEY is not configured");
  return key;
}

async function geocode(location: string): Promise<{ lat: number; lng: number; formattedAddress: string }> {
  const key = requireApiKey();
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(location)}&key=${key}`;
  const data = await fetchJson<GeocodeResponse>(url);
  const first = data.results[0];
  if (data.status !== "OK" || !first) {
    const detail = data.error_message ? `: ${data.error_message}` : "";
    throw new Error(`could not find a location matching "${location}" (${data.status})${detail}`);
  }
  return { lat: first.geometry.location.lat, lng: first.geometry.location.lng, formattedAddress: first.formatted_address };
}

async function timezoneFor(lat: number, lng: number): Promise<string> {
  const key = requireApiKey();
  const timestamp = Math.floor(Date.now() / 1000);
  const url = `https://maps.googleapis.com/maps/api/timezone/json?location=${lat},${lng}&timestamp=${timestamp}&key=${key}`;
  const data = await fetchJson<TimezoneResponse>(url);
  if (data.status !== "OK" || !data.timeZoneId) {
    const detail = data.errorMessage ? `: ${data.errorMessage}` : "";
    throw new Error(`could not resolve a timezone for this location (${data.status})${detail}`);
  }
  return data.timeZoneId;
}

function isValidIanaZone(zone: string): boolean {
  try {
    // Intl throws a RangeError for an unrecognized timeZone identifier.
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

function formatFor(timeZone: string, place: string) {
  const now = new Date();
  return {
    location: place,
    timezone: timeZone,
    local: new Intl.DateTimeFormat("en-CA", { timeZone, dateStyle: "full", timeStyle: "long" }).format(now),
    dayOfWeek: new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long" }).format(now),
  };
}

/**
 * Current date/time for a place. Ported from mojo-ai3 (kept its Google
 * Geocoding + Time Zone API pairing) but modernized: an exact IANA zone name
 * (e.g. "Asia/Tokyo") is recognized directly with no network call — the M1
 * skeleton's original behavior — before falling back to geocoding a place
 * name; formatting is entirely `Intl`, replacing mojo-ai3's manual UTC-offset
 * round-trip math.
 */
export function localTimeTool(): ToolDefinition {
  return {
    name: "local_time",
    durableTranscript: false,
    tool: tool({
      description: "Current date and time in a given place (city, country, region, or IANA timezone).",
      inputSchema: z.object({
        location: z.string().describe('A place name (e.g. "Tokyo", "New York", "Australia") or an IANA timezone'),
      }),
      execute: async ({ location }) => {
        if (isValidIanaZone(location)) return formatFor(location, location);
        const { lat, lng, formattedAddress } = await geocode(location);
        const timeZone = await timezoneFor(lat, lng);
        return formatFor(timeZone, formattedAddress);
      },
    }),
    guidance: {
      id: "tool-local-time",
      title: "local_time",
      body: `Call when the user asks for the current time in a specific location (e.g. "what time is it in Tokyo"). Do NOT call this just to learn today's date/UTC time for general reasoning — that is already injected into your context.`,
    },
  };
}
