import { tool } from "ai";
import { z } from "zod";
import { fetchJson } from "./http.ts";
import type { ToolDefinition } from "./define.ts";

interface GeocodeResult {
  readonly name: string;
  readonly country?: string;
  readonly latitude: number;
  readonly longitude: number;
}
interface GeocodeResponse {
  readonly results?: readonly GeocodeResult[];
}

interface ForecastResponse {
  readonly current: {
    readonly time: string;
    readonly temperature_2m: number;
    readonly apparent_temperature: number;
    readonly relative_humidity_2m: number;
    readonly wind_speed_10m: number;
    readonly weather_code: number;
  };
  readonly hourly: { readonly time: readonly string[]; readonly temperature_2m: readonly number[]; readonly weather_code: readonly number[] };
  readonly daily: { readonly sunrise: readonly string[]; readonly sunset: readonly string[] };
}

// WMO weather interpretation codes — a stable public standard, not something
// that needs "modernizing"; kept as a static lookup like mojo-ai3's.
const WEATHER_CODES: Record<number, string> = {
  0: "Clear sky",
  1: "Mainly clear",
  2: "Partly cloudy",
  3: "Overcast",
  45: "Fog",
  48: "Depositing rime fog",
  51: "Light drizzle",
  53: "Moderate drizzle",
  55: "Dense drizzle",
  61: "Slight rain",
  63: "Moderate rain",
  65: "Heavy rain",
  71: "Slight snow",
  73: "Moderate snow",
  75: "Heavy snow",
  80: "Slight rain showers",
  81: "Moderate rain showers",
  82: "Violent rain showers",
  95: "Thunderstorm",
  96: "Thunderstorm with slight hail",
  99: "Thunderstorm with heavy hail",
};
function describeCode(code: number): string {
  return WEATHER_CODES[code] ?? `Unknown conditions (WMO code ${code})`;
}

async function geocode(location: string): Promise<{ lat: number; lng: number; name: string }> {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1&language=en&format=json`;
  const data = await fetchJson<GeocodeResponse>(url);
  const first = data.results?.[0];
  if (!first) throw new Error(`could not find a location matching "${location}"`);
  return {
    lat: first.latitude,
    lng: first.longitude,
    name: first.country ? `${first.name}, ${first.country}` : first.name,
  };
}

/** Index of the first hourly row at/after `current.time` — fixes mojo-ai3's `currentHour + i` array-index bug, which broke near midnight/DST when the array didn't align with the wall-clock hour. */
function currentHourIndex(hourly: readonly string[], currentTimeIso: string): number {
  const currentMs = new Date(currentTimeIso).getTime();
  const idx = hourly.findIndex((t) => new Date(t).getTime() >= currentMs);
  return idx === -1 ? 0 : idx;
}

/**
 * Current conditions + short-term hourly forecast via Open-Meteo (free, no
 * API key) — including Open-Meteo's OWN geocoder, dropping the Google Maps
 * dependency this tool doesn't need. `timezone=auto` makes Open-Meteo return
 * every timestamp already in local time, which is what makes the fixed
 * timestamp-based hourly selection below possible.
 */
export function weatherForecastTool(): ToolDefinition {
  return {
    name: "weather_forecast",
    durableTranscript: false,
    tool: tool({
      description: "Current weather conditions and a short-term hourly forecast for a location.",
      inputSchema: z.object({
        location: z.string().describe("A city or place name, e.g. 'Amsterdam'"),
        unit: z.enum(["metric", "imperial"]).default("metric").describe("Temperature/wind unit system"),
      }),
      execute: async ({ location, unit }) => {
        const { lat, lng, name } = await geocode(location);
        const temperatureUnit = unit === "imperial" ? "fahrenheit" : "celsius";
        const windSpeedUnit = unit === "imperial" ? "mph" : "kmh";
        const url =
          `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}` +
          `&current=temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,weather_code` +
          `&hourly=temperature_2m,weather_code&daily=sunrise,sunset&timezone=auto&forecast_days=1` +
          `&temperature_unit=${temperatureUnit}&wind_speed_unit=${windSpeedUnit}`;
        const data = await fetchJson<ForecastResponse>(url);

        const idx = currentHourIndex(data.hourly.time, data.current.time);
        const nextHours = data.hourly.time.slice(idx, idx + 4).map((time, i) => ({
          time,
          temperature: data.hourly.temperature_2m[idx + i],
          conditions: describeCode(data.hourly.weather_code[idx + i] ?? -1),
        }));

        return {
          location: name,
          coordinates: { lat, lng },
          current: {
            summary: describeCode(data.current.weather_code),
            temperature: data.current.temperature_2m,
            feelsLike: data.current.apparent_temperature,
            humidity: data.current.relative_humidity_2m,
            wind: data.current.wind_speed_10m,
          },
          daylight: { sunrise: data.daily.sunrise[0], sunset: data.daily.sunset[0] },
          nextHours,
        };
      },
    }),
    guidance: {
      id: "tool-weather-forecast",
      title: "weather_forecast",
      body: `Call when the user asks about weather conditions or forecast for a location. Returns current conditions plus a short-term hourly outlook. NEVER guess weather — always use this tool.`,
    },
  };
}
