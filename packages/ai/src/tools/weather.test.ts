import { afterEach, describe, expect, test } from "bun:test";
import { weatherForecastTool } from "./weather.ts";

const execute = weatherForecastTool().tool.execute!;
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

function mockFetch(geocodeBody: unknown, forecastBody: unknown): typeof fetch {
  return (async (url: string) => (url.includes("geocoding-api") ? jsonResponse(geocodeBody) : jsonResponse(forecastBody))) as unknown as typeof fetch;
}

const GEOCODE_OK = { results: [{ name: "Tokyo", country: "Japan", latitude: 35.68, longitude: 139.69 }] };

describe("weather_forecast", () => {
  test("returns current conditions, daylight, and the next 4 hours", async () => {
    globalThis.fetch = mockFetch(GEOCODE_OK, {
      current: { time: "2026-07-06T10:00", temperature_2m: 22, apparent_temperature: 24, relative_humidity_2m: 60, wind_speed_10m: 10, weather_code: 3 },
      hourly: {
        time: ["2026-07-06T09:00", "2026-07-06T10:00", "2026-07-06T11:00", "2026-07-06T12:00", "2026-07-06T13:00"],
        temperature_2m: [21, 22, 23, 24, 25],
        weather_code: [2, 3, 3, 1, 0],
      },
      daily: { sunrise: ["2026-07-06T05:00"], sunset: ["2026-07-06T19:00"] },
    });

    const result = (await execute({ location: "Tokyo", unit: "metric" }, {} as never)) as any;
    expect(result.location).toBe("Tokyo, Japan");
    expect(result.current).toEqual({ summary: "Overcast", temperature: 22, feelsLike: 24, humidity: 60, wind: 10 });
    expect(result.daylight).toEqual({ sunrise: "2026-07-06T05:00", sunset: "2026-07-06T19:00" });
    // Starts AT the current hour (10:00), not the array's first entry (09:00).
    expect(result.nextHours.map((h: any) => h.time)).toEqual([
      "2026-07-06T10:00",
      "2026-07-06T11:00",
      "2026-07-06T12:00",
      "2026-07-06T13:00",
    ]);
    expect(result.nextHours[0].conditions).toBe("Overcast");
  });

  test("selects hourly rows by matching timestamp, not array index — the midnight-rollover bug this fixes", async () => {
    // The hourly array's first entry is midnight of a NEW day, while `current.time`
    // is late the PREVIOUS day per this endpoint's actual (unusual but real)
    // response shape — an index-based "currentHour + i" lookup would misalign here.
    globalThis.fetch = mockFetch(GEOCODE_OK, {
      current: { time: "2026-07-06T23:00", temperature_2m: 15, apparent_temperature: 15, relative_humidity_2m: 80, wind_speed_10m: 5, weather_code: 61 },
      hourly: {
        time: ["2026-07-06T22:00", "2026-07-06T23:00", "2026-07-07T00:00", "2026-07-07T01:00"],
        temperature_2m: [16, 15, 14, 14],
        weather_code: [61, 61, 3, 3],
      },
      daily: { sunrise: ["2026-07-06T05:00"], sunset: ["2026-07-06T19:00"] },
    });

    const result = (await execute({ location: "Tokyo", unit: "metric" }, {} as never)) as any;
    // Must start at 23:00 (the actual current hour), never at 22:00 (index 0).
    expect(result.nextHours[0].time).toBe("2026-07-06T23:00");
    expect(result.nextHours.map((h: any) => h.time)).toEqual(["2026-07-06T23:00", "2026-07-07T00:00", "2026-07-07T01:00"]);
  });

  test("a sub-hour current.time (Open-Meteo's real 15-minute resolution) still starts at the CURRENT hour, not the next one", async () => {
    // Real Open-Meteo `current.time` is e.g. "…T07:30", not hour-aligned. A
    // naive `>= current.time` match would skip 07:00 and wrongly start at
    // 08:00, dropping the in-progress hour — this is the exact bug caught in
    // adversarial review (the earlier fixture tests only used hour-aligned
    // times, which happened to mask it).
    globalThis.fetch = mockFetch(GEOCODE_OK, {
      current: { time: "2026-07-06T07:30", temperature_2m: 20, apparent_temperature: 20, relative_humidity_2m: 55, wind_speed_10m: 8, weather_code: 1 },
      hourly: {
        time: ["2026-07-06T06:00", "2026-07-06T07:00", "2026-07-06T08:00", "2026-07-06T09:00", "2026-07-06T10:00"],
        temperature_2m: [18, 19, 20, 21, 22],
        weather_code: [1, 1, 1, 2, 2],
      },
      daily: { sunrise: ["2026-07-06T05:00"], sunset: ["2026-07-06T19:00"] },
    });

    const result = (await execute({ location: "Tokyo" }, {} as never)) as any;
    expect(result.nextHours[0].time).toBe("2026-07-06T07:00");
    expect(result.nextHours.map((h: any) => h.time)).toEqual([
      "2026-07-06T07:00",
      "2026-07-06T08:00",
      "2026-07-06T09:00",
      "2026-07-06T10:00",
    ]);
  });

  test("imperial unit passes fahrenheit/mph to the forecast request", async () => {
    let forecastUrl = "";
    globalThis.fetch = (async (url: string) => {
      if (url.includes("geocoding-api")) return jsonResponse(GEOCODE_OK);
      forecastUrl = url;
      return jsonResponse({
        current: { time: "2026-07-06T10:00", temperature_2m: 72, apparent_temperature: 74, relative_humidity_2m: 50, wind_speed_10m: 6, weather_code: 0 },
        hourly: { time: ["2026-07-06T10:00"], temperature_2m: [72], weather_code: [0] },
        daily: { sunrise: ["2026-07-06T05:00"], sunset: ["2026-07-06T19:00"] },
      });
    }) as unknown as typeof fetch;

    await execute({ location: "Tokyo", unit: "imperial" }, {} as never);
    expect(forecastUrl).toContain("temperature_unit=fahrenheit");
    expect(forecastUrl).toContain("wind_speed_unit=mph");
  });

  test("throws when the location can't be geocoded", async () => {
    globalThis.fetch = mockFetch({ results: [] }, {});
    expect(execute({ location: "Nowhereville" }, {} as never)).rejects.toThrow(/could not find a location/);
  });

  test("an unrecognized WMO code degrades to a labeled 'unknown' rather than throwing", async () => {
    globalThis.fetch = mockFetch(GEOCODE_OK, {
      current: { time: "2026-07-06T10:00", temperature_2m: 20, apparent_temperature: 20, relative_humidity_2m: 50, wind_speed_10m: 5, weather_code: 9999 },
      hourly: { time: ["2026-07-06T10:00"], temperature_2m: [20], weather_code: [9999] },
      daily: { sunrise: ["2026-07-06T05:00"], sunset: ["2026-07-06T19:00"] },
    });
    const result = (await execute({ location: "Tokyo" }, {} as never)) as any;
    expect(result.current.summary).toBe("Unknown conditions (WMO code 9999)");
  });
});
