// Today's temperature where the person is, for the analysis to reason with.
//
// WHY IT IS HERE AT ALL. Heat dilates the vessels under the skin, so the subcutaneous insulin depot
// empties into the blood faster: quicker onset, sharper peak, lows that come out of nowhere. Cold
// does the opposite — the dose seems not to work, then arrives late and all at once. It is the same
// mechanism the sport feature already acts on (exercise raises local blood flow too).
//
// WHAT IT DELIBERATELY DOES NOT DO: change a dose. Exercise has a defensible clinical figure
// (10-30 %); ambient temperature does not. Inventing one would put a number in front of a parent
// that nothing supports. Temperature raises VIGILANCE and explains itself — see temperatureNote and
// temperatureLowWatchBump in doseGuard.ts.
//
// AND IT IS A CITY, NOT A POSITION. The alternative considered was geofencing the places that have
// air conditioning and inferring the rest. It would be wrong most of the time (a car, a shop, a
// friend's house are all "away from home" and all air-conditioned) and it would mean tracking an
// eleven-year-old continuously, in an app whose whole design is pseudonymous. A city name typed once
// gets nearly all of the value and costs nothing.
//
// Open-Meteo: free, no key, no account. Any failure returns null and the analysis carries on exactly
// as it did before — weather may never cost us an answer.

export interface CurrentWeather {
  tempC: number;
  /** What the geocoder actually matched, so the user can see we looked up the right place. */
  place: string;
}

/** How long a temperature is worth reusing. Weather does not move fast, and each analysis would
 *  otherwise re-hit the network. Edge instances are short-lived, so this is a best-effort cache. */
export const WEATHER_TTL_MS = 30 * 60 * 1000;
const cache = new Map<string, { at: number; value: CurrentWeather | null }>();

const GEO_URL = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
/** A hung weather call must never hold up an analysis. */
const TIMEOUT_MS = 3500;

async function getJson(url: string): Promise<any | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return null;
    return await res.json();
  } catch (_) {
    return null;
  }
}

/**
 * Current temperature for `city` (optionally disambiguated by `country`), or null.
 *
 * Null is a perfectly ordinary answer: no city stored, no network, an unknown place name. Every
 * caller must treat it as "no information", never as "mild weather".
 */
export async function currentWeather(
  city?: string | null,
  country?: string | null,
): Promise<CurrentWeather | null> {
  const name = String(city ?? "").trim();
  if (name.length < 2) return null;
  const key = `${name.toLowerCase()}|${String(country ?? "").trim().toLowerCase()}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < WEATHER_TTL_MS) return hit.value;

  let value: CurrentWeather | null = null;
  const geo = await getJson(`${GEO_URL}?name=${encodeURIComponent(name)}&count=5&language=fr&format=json`);
  const results: any[] = Array.isArray(geo?.results) ? geo.results : [];
  if (results.length) {
    // Prefer a match in the stated country — "Valence" is a French town and a Spanish city, and the
    // family speaks French while living in Spain, which is exactly the pair that would go wrong.
    const wanted = String(country ?? "").trim().toLowerCase();
    const best = (wanted
      ? results.find((r) =>
          String(r?.country ?? "").toLowerCase().includes(wanted) ||
          String(r?.country_code ?? "").toLowerCase() === wanted.slice(0, 2))
      : null) ?? results[0];
    const lat = Number(best?.latitude);
    const lon = Number(best?.longitude);
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      const fc = await getJson(`${FORECAST_URL}?latitude=${lat}&longitude=${lon}&current=temperature_2m`);
      const t = Number(fc?.current?.temperature_2m);
      if (Number.isFinite(t)) {
        value = { tempC: Math.round(t), place: String(best?.name ?? name) };
      }
    }
  }
  cache.set(key, { at: Date.now(), value });
  return value;
}
