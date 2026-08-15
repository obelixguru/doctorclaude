// Pure parsing of LibreLinkUp's wire format, split out of `mechabetics-llu` so it can be unit
// tested — the same discipline as the other `_shared` modules (no Deno/Node APIs in here).
//
// This is small but load-bearing: every rule below exists because getting it wrong makes OLD DATA
// LOOK LIVE, which is the one class of bug this app must never ship. A dose is never computed off a
// stale number, so "unparseable" has to mean "dropped", not "assume now".

export const LLU_DEFAULT_HOST = "api.libreview.io";

export const hostOf = (region?: string | null): string =>
  region ? `api-${region}.libreview.io` : LLU_DEFAULT_HOST;

/**
 * Abbott's region redirect: `{"status":0,"data":{"redirect":true,"region":"xx"}}` — sent as HTTP
 * 200 with the payload REPLACED, not as a 3xx. Returns the region to switch to, else null.
 */
export function redirectRegionOf(root: any): string | null {
  const d = root?.data;
  return d && d.redirect === true && typeof d.region === "string" && d.region ? d.region : null;
}

/**
 * Parses LibreLinkUp's timestamps to an absolute epoch in ms. Typical shape: "5/15/2026 2:32:11 PM".
 *
 * Hand-rolled rather than `Date.parse`, which interprets that form in the RUNTIME's timezone —
 * right only by accident on a UTC edge worker and silently hours out anywhere else. Callers pass
 * `FactoryTimestamp`, which Abbott defines as UTC.
 *
 * Returns null for anything unrecognised, so the reading is dropped rather than stamped "now".
 */
export function parseTimestamp(s: string | undefined | null): number | null {
  if (!s) return null;
  const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})\s*([AaPp])\.?[Mm]\.?$/);
  if (us) {
    const [, mo, d, y, h, mi, sec] = us;
    const ap = us[7].toLowerCase();
    const h12 = Number(h);
    // 12 AM is 00h and 12 PM is 12h — the one case a naive (h + 12) gets wrong in both directions.
    if (h12 < 1 || h12 > 12) return null;
    const hour = ap === "p" ? (h12 === 12 ? 12 : h12 + 12) : (h12 === 12 ? 0 : h12);
    const mon = Number(mo), day = Number(d), min = Number(mi), s2 = Number(sec);
    if (mon < 1 || mon > 12 || day < 1 || day > 31 || min > 59 || s2 > 59) return null;
    const t = Date.UTC(Number(y), mon - 1, day, hour, min, s2);
    // Date.UTC rolls overflow silently (Feb 31 → Mar 3). Round-tripping the day rejects that, so a
    // malformed date is dropped instead of quietly landing on the wrong one.
    return new Date(t).getUTCDate() === day ? t : null;
  }
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/);
  if (iso) {
    const [, y, mo, d, h, mi, sec] = iso;
    const mon = Number(mo), day = Number(d);
    if (mon < 1 || mon > 12 || day < 1 || day > 31 || Number(h) > 23 || Number(mi) > 59 || Number(sec) > 59) return null;
    const t = Date.UTC(Number(y), mon - 1, day, Number(h), Number(mi), Number(sec));
    return new Date(t).getUTCDate() === day ? t : null;
  }
  return null;
}

export interface LluReading {
  ts: number;
  value: number;
  /** 1..5 = falling fast · falling · stable · rising · rising fast. Null when Abbott sent none. */
  trend: number | null;
  isHigh: boolean;
  isLow: boolean;
}

/** One Abbott measurement → our shape, or null when it carries no usable value or time. */
export function parseMeasurement(o: any): LluReading | null {
  if (!o) return null;
  const raw = o.ValueInMgPerDl ?? o.Value;
  const value = Number(raw);
  if (!Number.isFinite(value) || !(value > 0)) return null;
  // FactoryTimestamp is UTC; `Timestamp` is the PATIENT's local time and is only right when the
  // reader happens to sit in that zone — so it is the fallback, never the first choice.
  const ts = parseTimestamp(o.FactoryTimestamp) ?? parseTimestamp(o.Timestamp);
  if (ts == null) return null;
  const t = Number(o.TrendArrow ?? 0);
  return {
    ts,
    value: Math.round(value),
    trend: t >= 1 && t <= 5 ? t : null,
    isHigh: o.isHigh === true,
    isLow: o.isLow === true,
  };
}

/** A Libre sensor lives 14 days from activation. `connection.sensor.a` is epoch SECONDS. */
export const SENSOR_LIFE_MS = 14 * 24 * 3600 * 1000;

export function sensorEndMs(connection: any): number | null {
  const act = Number(connection?.sensor?.a ?? 0);
  return act > 0 ? act * 1000 + SENSOR_LIFE_MS : null;
}
