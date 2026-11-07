import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { accessSubject } from "../_shared/access.ts";
import { DOSE_SCORE_DAYS, fitForecastModel, scoreDoses, scoreForecasts, TRAIN_DAYS } from "../_shared/forecast.ts";
import type { DoseScore, ForecastLogRow, Pt } from "../_shared/forecast.ts";
import { insulinByName, isBasalInsulin } from "../_shared/insulins.ts";

// Doctor Claude: learns from a patient's own months of sensor data. Refits the forecast and the
// "what usually happens at this level, at this hour" table, at most once a day, started by the analysis
// in the background. Nobody waits on it, and the analysis works without it (see forecastGlucose).
//
// Nothing here touches a ratio. The model feeds the forecast and the warnings, and the one thing it does to
// a dose is make it smaller: see scoreDoses.
//
// It also marks its own homework: every forecast the monitor stored and every dose on record are compared
// with what really followed, and the score travels with the model, so an analysis can say what it costs
// nothing to read. `scoreOnly` returns that score without fitting anything.

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

/** A month is enough to judge, and short enough that an old insulin stops counting. */
const LIVE_SCORE_DAYS = 30;

/** The stored forecasts, newest first in pages: this project caps a response at 1000 rows. */
async function storedForecasts(subject: string, nowMs: number): Promise<ForecastLogRow[]> {
  const since = new Date(nowMs - LIVE_SCORE_DAYS * 86400000).toISOString();
  const out: ForecastLogRow[] = [];
  for (let page = 0; page < 12; page++) {
    const from = page * 1000;
    const { data, error } = await db.from("mechabetics_forecast_log")
      .select("made_at, value_mgdl, source, f30, low30, high30, f60, low60, high60, warned")
      .eq("subject", subject).gte("made_at", since)
      .order("made_at", { ascending: false }).range(from, from + 999);
    if (error) {
      console.error("learn: stored forecasts failed:", error.message);
      break;
    }
    const rows = (data ?? []) as ForecastLogRow[];
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}

/**
 * What the doses of the last month did, and which of them the app had just named. Null when something could
 * not be read: a month that cannot be judged says nothing, and must not put the caution back at its start.
 * The analyses are read as well as the named doses, for the month before that table existed.
 */
async function doseScore(subject: string, pts: Pt[], nowMs: number): Promise<DoseScore | null> {
  const since = new Date(nowMs - (DOSE_SCORE_DAYS + 1) * 86400000).toISOString();
  const [ins, logs, said] = await Promise.all([
    db.from("mechabetics_insulin").select("ts, units, kind, insulin_name")
      .eq("subject", subject).gte("ts", since).order("ts", { ascending: false }).limit(1000),
    db.from("mechabetics_coach_log").select("ts, decision")
      .eq("subject", subject).gte("ts", since).order("ts", { ascending: false }).limit(1000),
    db.from("mechabetics_named_doses").select("named_at, units")
      .eq("subject", subject).gte("named_at", since).order("named_at", { ascending: false }).limit(1000),
  ]);
  if (ins.error || logs.error || said.error) {
    console.error("learn: dose score not read:", ins.error?.message ?? logs.error?.message ?? said.error?.message);
    return null;
  }
  const doses = (ins.data ?? []).filter((d: any) => d.kind !== "basal" && !isBasalInsulin(d.insulin_name));
  const named = [
    ...(logs.data ?? []).map((l: any) => ({
      ms: new Date(l.ts).getTime(),
      units: Math.max(Number(l.decision?.units) || 0, Number(l.decision?.laterUnits) || 0),
    })),
    ...(said.data ?? []).map((n: any) => ({ ms: new Date(n.named_at).getTime(), units: Number(n.units) || 0 })),
  ].filter((n: { ms: number; units: number }) => n.units > 0);
  return scoreDoses(doses, pts, named, nowMs);
}

/** The score already stored, for the day a new one cannot be worked out. Undefined when that cannot be read
 *  either: the model is then left as it stands rather than rewritten without its caution. */
async function storedDoseScore(subject: string): Promise<DoseScore | null | undefined> {
  const { data, error } = await db.from("mechabetics_models").select("model").eq("subject", subject).maybeSingle();
  if (error) {
    console.error("learn: stored score not read:", error.message);
    return undefined;
  }
  return (data?.model as { doses?: DoseScore | null } | null)?.doses ?? null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method" }, 405);
  try {
    const body = await req.json().catch(() => ({}));
    const subject = (await accessSubject(req, db, String(body.subject ?? "") || null)) ?? "";
    if (!/^[a-f0-9]{64}$/.test(subject)) return json({ error: "subject invalide" }, 400);
    const tz = Number(body.tzOffsetMin);
    const tzOffsetMin = Number.isFinite(tz) ? Math.round(tz) : 60;
    const nowMs = Date.now();

    // One JSON value, not rows: this project's PostgREST caps a response at 1000 rows, and four months
    // of five-minute buckets is about 34 000.
    const { data, error } = await db.rpc("mechabetics_series5", {
      p_subject: subject,
      p_since: new Date(nowMs - TRAIN_DAYS * 86400000).toISOString(),
    });
    if (error) return json({ error: error.message }, 500);
    const pts: Pt[] = ((data ?? []) as [number, number][]).map(([e, v]) => ({ ts: e * 1000, value: v }));

    const live = scoreForecasts(await storedForecasts(subject, nowMs), pts);
    const doses = await doseScore(subject, pts, nowMs);
    if (body.scoreOnly === true) return json({ ok: true, live, doses });

    const { data: profile } = await db.from("mechabetics_profiles")
      .select("basal_insulin, basal_changed_at").eq("subject", subject).maybeSingle();
    const model = fitForecastModel(pts, nowMs, tzOffsetMin, {
      regimeChangedAt: profile?.basal_changed_at ? new Date(profile.basal_changed_at).getTime() : null,
      settleDays: insulinByName(profile?.basal_insulin)?.settlesDays,
    });
    if (!model) return json({ ok: true, fitted: false, points: pts.length, live, doses });
    model.live = live;
    const score = doses ?? await storedDoseScore(subject);
    if (score === undefined) return json({ ok: true, fitted: false, points: pts.length, live, doses });
    model.doses = score;

    const { error: wErr } = await db.from("mechabetics_models")
      .upsert({ subject, model, fitted_at: new Date(nowMs).toISOString() }, { onConflict: "subject" });
    if (wErr) return json({ error: wErr.message }, 500);
    return json({
      ok: true, fitted: true, points: pts.length, days: model.days,
      warnsPerDay: model.lowest?.perDay ?? null, warnsRight: model.lowest?.right ?? null, live, doses,
    });
  } catch (e) {
    return json({ error: `${(e as Error)?.message ?? e}` }, 500);
  }
});
