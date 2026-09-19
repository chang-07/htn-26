import { z } from "zod";

const Place = z.object({
  id: z.number().int(), name: z.string(), country: z.string().optional(), admin1: z.string().optional(),
  latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180), timezone: z.string(),
});
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => {
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === s;
}, "Use a real calendar date (YYYY-MM-DD)");
export const locationArgs = z.object({ query: z.string().trim().min(2).max(160) });
export const weatherArgs = z.object({ locationId: z.number().int().positive(), date });

async function getJson(url: URL): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Open-Meteo: HTTP ${res.status}`);
  return res.json();
}

export async function findLocations(args: z.infer<typeof locationArgs>) {
  const { query } = locationArgs.parse(args);
  const url = new URL("https://geocoding-api.open-meteo.com/v1/search");
  url.search = new URLSearchParams({ name: query, count: "5", language: "en", format: "json" }).toString();
  const { results = [] } = z.object({ results: z.array(Place).optional() }).parse(await getJson(url));
  return { locations: results, source: "https://open-meteo.com/en/docs/geocoding-api", attribution: "Open-Meteo / GeoNames",
    guidance: "Choose the result matching the user's stated region. Ask if ambiguous; never silently choose the first match. These are place coordinates, not a person's live location." };
}

/** Resolve an actual GeoNames id; the model cannot invent weather coordinates. */
export async function getWeather(args: z.infer<typeof weatherArgs>) {
  const input = weatherArgs.parse(args);
  const placeUrl = new URL("https://geocoding-api.open-meteo.com/v1/get");
  placeUrl.searchParams.set("id", String(input.locationId));
  const place = Place.parse(await getJson(placeUrl));
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: place.timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const days = (Date.parse(input.date) - Date.parse(today)) / 86_400_000;
  if (days < 0 || days > 15) return { status: "outside_forecast_window", place, date: input.date,
    summary: "Forecasts are available from today through the next 15 days. Recheck closer to the outing; do not substitute today's weather." };
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.search = new URLSearchParams({ latitude: String(place.latitude), longitude: String(place.longitude), timezone: place.timezone,
    start_date: input.date, end_date: input.date, temperature_unit: "celsius", wind_speed_unit: "kmh",
    daily: "temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max,weather_code",
  }).toString();
  const values = z.array(z.number().nullable()).length(1);
  const forecast = z.object({ timezone: z.string(), daily_units: z.record(z.string(), z.string()), daily: z.object({
    time: z.array(date).length(1), temperature_2m_max: values, temperature_2m_min: values,
    precipitation_probability_max: values, wind_speed_10m_max: values, weather_code: values,
  }) }).parse(await getJson(url));
  if (forecast.daily.time[0] !== input.date) throw new Error("Forecast returned the wrong date");
  return { status: "forecast", place, ...forecast, checkedAt: new Date().toISOString(), source: "https://open-meteo.com/",
    guidance: "Daily forecast, not certainty or an hourly prediction. Null means unavailable. Mention rain/wind only if it changes the plan; attribute Open-Meteo." };
}
