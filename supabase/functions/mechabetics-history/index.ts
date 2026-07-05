import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { accessSubject } from "../_shared/access.ts";

// Returns a subject's SAVED glucose readings (for the long-term graph with dates) + the past AI
// analyses (coach_log) for the history screen. Pseudonymous: keyed by the subject hash only.

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { ...CORS, "content-type": "application/json" } });
}

// Removes noisy-source artefacts before charting: dedupe to one reading per 5-min bucket (keep
// the latest = the live measurement, which tracks the real curve), then drop isolated up-spikes
// (a point >40 mg/dL above BOTH neighbours within 25 min). Never drops lows/hypos.
function cleanSeries(rows: { ts: number; value: number }[]): { ts: number; value: number }[] {
  const byBucket = new Map<number, { ts: number; value: number }>();
  for (const r of rows) {
    if (!r || !(r.value > 0) || !Number.isFinite(r.ts)) continue;
    const b = Math.floor(r.ts / 300000);
    const ex = byBucket.get(b);
    if (!ex || r.ts > ex.ts) byBucket.set(b, r);
  }
  const pts = [...byBucket.values()].sort((a, b) => a.ts - b.ts);
  const out: { ts: number; value: number }[] = [];
  for (let i = 0; i < pts.length; i++) {
    const cur = pts[i], prev = pts[i - 1], next = pts[i + 1];
    if (prev && next) {
      const dp = (cur.ts - prev.ts) / 60000, dn = (next.ts - cur.ts) / 60000;
      if (dp <= 25 && dn <= 25 && cur.value > prev.value + 40 && cur.value > next.value + 40) continue;
    }
    out.push(cur);
  }
  return out;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const body = await req.json().catch(() => ({}));
    const subject = await accessSubject(req, db, (typeof body.subject === "string" && /^[a-f0-9]{64}$/.test(body.subject)) ? body.subject : null);
    if (!subject) return json({ readings: [], analyses: [], error: "subject invalide" });
    const days = Math.min(Math.max(Number(body.days) || 14, 1), 60);
    const lang = body.lang === "es" ? "es" : "fr";
    const since = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();

    // Fetch ALL readings in the window, NEWEST first, PAGING past PostgREST's ~1000-row response cap.
    // A single `.order(asc).limit(5000)` is silently clamped to 1000 rows by the server, and because
    // it was ASCENDING that kept only the OLDEST 1000 — so as the table grew, the most recent days
    // (today, yesterday) vanished from the graph and per-day chips, which read on-screen as a flat
    // line / "the data gets mixed up the further in time you go". Descending + range() pages keep the
    // recent data even if we ever hit the page cap; cleanSeries then dedupes to one point per 5 min.
    const nowMs = Date.now();
    const PAGE = 1000;
    const MAX_PAGES = 20; // ~20k raw rows ≈ 4 weeks at the current cadence; recent days are page 0.
    const raw: { ts: number; value: number }[] = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const from = page * PAGE;
      const { data, error } = await db.from("mechabetics_readings")
        .select("ts, value_mgdl").eq("subject", subject).gte("ts", since)
        .order("ts", { ascending: false }).range(from, from + PAGE - 1);
      if (error || !data || data.length === 0) break;
      for (const r of data) raw.push({ ts: new Date(r.ts).getTime(), value: Number(r.value_mgdl) });
      if (data.length < PAGE) break;
    }
    // Drop any FUTURE-dated reading (a bad-timezone artefact) so the history never shows a point
    // ahead of "now". cleanSeries then dedupes to one point per 5 min.
    const readings = cleanSeries(raw.filter((r) => Number.isFinite(r.ts) && r.ts <= nowMs + 120000));

    // Only the CURRENT language's analyses (plus legacy rows with no lang) — the bilingual prefetch
    // stores both an FR and an ES copy of each report, so without this filter the ANALYSES tab would
    // show whichever was written last (often the ES prefetch) even when the user is in French.
    const { data: logs } = await db.from("mechabetics_coach_log")
      .select("ts, message, glucose_at_time").eq("subject", subject)
      .or(`lang.eq.${lang},lang.is.null`)
      .order("ts", { ascending: false }).limit(40);
    const analyses = (logs ?? []).map((l: any) => ({ ts: new Date(l.ts).getTime(), message: l.message, glucose: l.glucose_at_time }));

    const { data: ins } = await db.from("mechabetics_insulin")
      .select("id, ts, units, insulin_name, kind").eq("subject", subject).gte("ts", since)
      .order("ts", { ascending: false }).limit(200);
    const insulin = (ins ?? []).map((d: any) => ({ id: d.id, ts: new Date(d.ts).getTime(), units: d.units, name: d.insulin_name, kind: d.kind }));

    // Recent meals (EATEN carbs / hypo rescues) — like insulin, so the client can mirror the
    // server's minutesSinceLastRescue and stop telling the user to take MORE sugar when they just
    // did (the dashboard LOW banner reads `planned` + `ts`; planned = not-yet-eaten = not on board).
    const { data: mealRows } = await db.from("mechabetics_meals")
      .select("ts, planned, description, carbs_g").eq("subject", subject).gte("ts", since)
      .order("ts", { ascending: false }).limit(100);
    const meals = (mealRows ?? []).map((m: any) => ({
      ts: new Date(m.ts).getTime(), planned: !!m.planned,
      description: m.description ?? null, carbs_g: m.carbs_g ?? null,
    }));

    // 24h stats (avg / TIR / %high / %low) here too, so the dashboard's average + time-in-range
    // bar work WITHOUT the (gated) AI coach — these are plain DB aggregates, not AI.
    const { data: stats } = await db.rpc("mechabetics_stats", { p_subject: subject });

    return json({ readings, analyses, insulin, meals, stats });
  } catch (e) {
    return json({ readings: [], analyses: [], error: `${(e as Error)?.message ?? e}` });
  }
});
