// Where the backend lives, and the handful of numbers the UI needs to agree with the server on.
//
// This is the SAME project the Android app talks to (AnalysisService.kt:581), so the web client and
// the phone read and write one history — a meal logged on the phone shows up here, and the reverse.
export const FUNCTIONS_BASE = "https://vzafttfgrxpjdraveihh.supabase.co/functions/v1";

/**
 * The Supabase ANON key, sent as `Authorization: Bearer …` on every call — exactly what the Android
 * app does (ai/MealsService.kt:218 and its twins). Without it the platform rejects the request with
 * `UNAUTHORIZED_NO_AUTH_HEADER` before our function code ever runs.
 *
 * Public by design and by necessity: it is already compiled into the distributed APK, and an "anon"
 * key grants nothing on its own — it only gets you to the function, which then does its own
 * authorisation (the `subject` / capability-token check in `_shared/access.ts`). It is not a secret,
 * and it is not what protects the data.
 */
export const ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZ6YWZ0dGZncnhwamRyYXZlaWhoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcxMTQ3MDAsImV4cCI6MjA5MjY5MDcwMH0.LX0TVh4BaCLnowQd8wnQLZ95iS_mxeJTaPRn-s7zKko";

// How often the dashboard re-reads LibreLinkUp. Abbott publishes about one point a minute and
// rate-limits (HTTP 429) an account that hammers it, so this matches the phone's cadence rather
// than polling as fast as the browser would allow.
export const REFRESH_MS = 60_000;

// A reading older than this is NOT the current glucose and must not be presented as one. Mirrors
// the app's FRESHNESS_WINDOW_MS and the server's STALE_MIN (mechabetics-monitor/index.ts:32).
export const FRESHNESS_WINDOW_MS = 15 * 60_000;

// Trend arrow codes as LibreLinkUp sends them (1..5), mapped to the glyphs the app draws
// (data/Models.kt). 0/absent means "no arrow data" — which is shown as no word, never as "Stable".
export const TREND = {
  1: { arrow: "↓↓", key: "trendFallingFast" },
  2: { arrow: "↓", key: "trendFalling" },
  3: { arrow: "→", key: "trendStable" },
  4: { arrow: "↑", key: "trendRising" },
  5: { arrow: "↑↑", key: "trendRisingFast" },
};

export const STORAGE_KEY = "mechabetics.web.v1";
