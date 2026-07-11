// Weather — today's forecast via OpenWeatherMap.
//
// Real implementation: uses One Call API 3.0 daily forecast.
// Stub mode: returns demo snapshot when OPENWEATHER_API_KEY is unset.

import type { WeatherSnapshot } from "../types.js";

const DEMO: WeatherSnapshot = {
  high_f: 68,
  low_f: 54,
  precip_probability: 0.1,
  conditions: "[stub] Partly cloudy",
};

type OneCallResponse = {
  daily?: Array<{
    temp: { min: number; max: number };
    pop: number;
    weather: Array<{ main: string; description: string }>;
  }>;
};

export async function fetchWeather(opts: {
  apiKey?: string;
  lat: number;
  lon: number;
}): Promise<{ weather: WeatherSnapshot | null; warning?: string }> {
  if (!opts.apiKey) {
    return { weather: DEMO, warning: "weather:stub (no OPENWEATHER_API_KEY)" };
  }

  const url = `https://api.openweathermap.org/data/3.0/onecall?lat=${opts.lat}&lon=${opts.lon}&exclude=minutely,hourly,alerts&units=imperial&appid=${opts.apiKey}`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      return { weather: null, warning: `weather:http-${res.status}` };
    }
    const json = (await res.json()) as OneCallResponse;
    const today = json.daily?.[0];
    if (!today) {
      return { weather: null, warning: "weather:no-daily-data" };
    }
    return {
      weather: {
        high_f: Math.round(today.temp.max),
        low_f: Math.round(today.temp.min),
        precip_probability: today.pop ?? 0,
        conditions: today.weather?.[0]?.description ?? today.weather?.[0]?.main ?? "—",
      },
    };
  } catch (err) {
    return { weather: null, warning: `weather:fetch-error:${(err as Error).message}` };
  }
}
