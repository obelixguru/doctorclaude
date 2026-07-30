import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { accessSubject } from "../_shared/access.ts";

// Doctor Claude - profil: sauvegarde / chargement (cle = subject, pseudonyme).
// Si les ratios exacts du medecin ne sont pas fournis, on les ESTIME a partir de
// l'age / poids / anciennete / doses d'insuline (regles standard 500 et 1800).
// Ce sont des estimations - toujours presentees "a valider" en aval.

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

const num = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

// Years elapsed since an ISO date string (for honeymoon recompute on a partial save). null if unparseable.
const yearsSince = (d: unknown): number | null => {
  if (typeof d !== "string" || !d) return null;
  const t = Date.parse(d);
  return Number.isFinite(t) ? (Date.now() - t) / (365.25 * 864e5) : null;
};

// Self-computed ESTIMATED HbA1c = GMI (Glucose Management Indicator) — the same indicator the
// LibreLink/LibreView app shows. GMI(%) = 3.31 + 0.02392 * mean glucose (mg/dL) (Bergenstal 2018).
// The mean is aggregated in the DB (mechabetics_gmi RPC) over up to 90 days of stored CGM readings.
// Best-effort: any error never blocks the profile load. The number is only RETURNED once it is
// trustworthy — the GMI is clinically meaningful only over >=14 days of CGM data (ADA/ATTD
// consensus). Below that we send `ready:false` and NO percentage: a 4-day "7.1%" sitting next to a
// 3-month lab "6.4%" would mislead. We also require real coverage across the span (~1 reading / 10
// min on average) so a 14-day span riddled with gaps can't masquerade as ready.
const GMI_MIN_DAYS = 14;
const GMI_MIN_PER_DAY = 144;
async function computeGmi(
  subject: string,
): Promise<{ ready: boolean; pct?: number; mean_mgdl?: number; days: number; readings: number } | null> {
  try {
    const { data } = await db.rpc("mechabetics_gmi", { p_subject: subject, p_days: 90 });
    const n = Number(data?.n) || 0;
    if (n <= 0) return null; // no readings at all → client shows a neutral "coming soon" line
    const days = Math.round(Number(data?.days) || 0);
    const mean = Number(data?.mean_mgdl);
    const ready = days >= GMI_MIN_DAYS && n >= days * GMI_MIN_PER_DAY && Number.isFinite(mean) && mean > 0;
    // Not enough yet → report how far along, but never a (misleading) number.
    if (!ready) return { ready: false, days, readings: n };
    return {
      ready: true,
      pct: Math.round((3.31 + 0.02392 * mean) * 10) / 10,
      mean_mgdl: Math.round(mean),
      days,
      readings: n,
    };
  } catch (_) {
    return null;
  }
}

// Estime ratio glucidique / facteur de correction / cible depuis les bases.
function estimateRatios(p: any): { carb_ratio: number; correction_factor: number; target_mgdl: number } | null {
  const rapid = num(p.rapid_units_per_day) ?? 0;
  const basal = num(p.basal_units_per_day) ?? 0;
  const weight = num(p.weight_kg);
  const age = num(p.age);
  const dxYears = num(p.diagnosis_years);
  const honeymoon = dxYears != null && dxYears < 1.5;

  let tdd = 0;
  if (rapid + basal > 0) tdd = rapid + basal;
  else if (basal > 0) tdd = basal * 2;
  else if (weight) {
    let factor = 0.6;
    if (honeymoon) factor = 0.4;
    else if (age != null && age >= 11) factor = 0.9;
    tdd = weight * factor;
  }
  if (tdd <= 0) return null;

  const carb_ratio = Math.max(2, Math.round(500 / tdd));
  const correction_factor = Math.max(10, Math.round(1800 / tdd));
  const target_mgdl = (age != null && age < 6) ? 120 : 110;
  return { carb_ratio, correction_factor, target_mgdl };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Methode non autorisee" }, 405);

  try {
    const body = await req.json().catch(() => ({}));
    const subject = (await accessSubject(req, db, String(body.subject ?? "") || null)) ?? "";
    if (!/^[a-f0-9]{64}$/.test(subject)) return json({ error: "subject invalide (hash attendu)." }, 400);

    if (body.action !== "save") {
      const { data } = await db.from("mechabetics_profiles").select("*").eq("subject", subject).maybeSingle();
      return json({ profile: data ?? null, gmi: await computeGmi(subject) });
    }

    const provided = body.profile ?? {};
    // MERGE, never blind-overwrite. A PARTIAL save (e.g. applying a suggested ratio from the
    // Insulin page sends ONLY carb_ratio/correction_factor/target_mgdl) must NOT wipe the
    // demographic fields the client didn't include. So load the stored row and fall back to it
    // for every field the request omitted. The client only ever sends real values (it drops
    // blanks), so "key absent" safely means "keep what's already stored".
    const { data: existing } = await db
      .from("mechabetics_profiles").select("*").eq("subject", subject).maybeSingle();
    const base: Record<string, any> = existing ?? {};
    const has = (k: string) => Object.prototype.hasOwnProperty.call(provided, k);
    const pick = (k: string) => (has(k) ? provided[k] : base[k]); // request value wins, else keep stored

    // Diagnosis: a freshly-entered "years since diagnosis" wins and is converted to a date; else
    // keep the stored date. (The app sends diagnosis_years; the column stores diagnosis_date.)
    const newDxYears = has("diagnosis_years") ? num(provided.diagnosis_years) : null;
    const diagnosis_date = newDxYears != null
      ? new Date(Date.now() - newDxYears * 365.25 * 864e5).toISOString().slice(0, 10)
      : (pick("diagnosis_date") ?? null);
    const dxYearsKnown = newDxYears ?? yearsSince(diagnosis_date);
    const honeymoon = dxYearsKnown != null ? (dxYearsKnown < 1.5 ? "en cours" : "finie") : (base.honeymoon ?? null);

    // The user "has" their own ratios as soon as they give the two that matter — carb ratio AND
    // correction factor. Target is optional (defaults to a safe 110, or 120 for under-6s), so a
    // two-field entry sticks as the user's ratios instead of silently staying "estimated".
    const ageN = num(pick("age"));
    const weightN = num(pick("weight_kg"));
    const rapidPerDay = num(pick("rapid_units_per_day"));
    const basalPerDay = num(pick("basal_units_per_day"));
    const carbN = num(pick("carb_ratio"));
    const corrN = num(pick("correction_factor"));
    const hasDoctorRatios = !!(carbN && corrN);
    const est = hasDoctorRatios ? null : estimateRatios({
      rapid_units_per_day: rapidPerDay, basal_units_per_day: basalPerDay,
      weight_kg: weightN, age: ageN, diagnosis_years: dxYearsKnown,
    });

    const targetN = num(pick("target_mgdl"));
    const defaultTarget = (ageN != null && ageN < 6) ? 120 : 110;
    const row: Record<string, unknown> = {
      subject,
      nickname: pick("nickname") ?? null,
      age: ageN != null ? Math.round(ageN) : null,
      weight_kg: weightN,
      diagnosis_date,
      honeymoon,
      rapid_insulin: pick("rapid_insulin") ?? null,
      basal_insulin: pick("basal_insulin") ?? null,
      rapid_units_per_day: rapidPerDay,
      basal_units_per_day: basalPerDay,
      carb_ratio: carbN ?? est?.carb_ratio ?? null,
      correction_factor: corrN ?? est?.correction_factor ?? null,
      target_mgdl: targetN != null ? Math.round(targetN) : (est?.target_mgdl ?? (hasDoctorRatios ? defaultTarget : null)),
      ratios_estimated: !hasDoctorRatios,
      // Last lab HbA1c the user typed (%). Merged like the rest: absent in a partial save → keep stored.
      hba1c: num(pick("hba1c")),
      lang: pick("lang") ?? null,
      // WHERE the person is. Not a formality: the same packaged product carries up to twice the sugar
      // depending on the market — Spanish 7UP is 4.6 g per 100 ml, the classic recipe 10.6 — so an
      // estimate made without a country is a guess about which country. NOT derivable from `lang`:
      // this family speaks French and lives in Spain, which is exactly the case that would break.
      country: pick("country") ?? null,
      notes: pick("notes") ?? null,
      updated_at: new Date().toISOString(),
    };

    const { error } = await db.from("mechabetics_profiles").upsert(row, { onConflict: "subject" });
    if (error) return json({ error: error.message }, 500);
    return json({ profile: row, estimated: !hasDoctorRatios });
  } catch (e) {
    return json({ error: `Erreur serveur: ${(e as Error)?.message ?? e}` }, 500);
  }
});
