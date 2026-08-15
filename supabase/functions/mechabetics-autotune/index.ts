import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { accessSubject } from "../_shared/access.ts";
import { suggestRatios, autotuneLine } from "../_shared/autotune.ts";

// Doctor Claude — autotune. Reads the saved readings + logged insulin + profile (by subject hash)
// and SUGGESTS a refined carb-ratio (ICR) and correction-factor (ISF) from the MEASURED total
// daily dose. Read-only: it NEVER writes the profile — the app shows the suggestion and the user
// (ideally with their doctor) decides whether to apply it. See _shared/autotune.ts for the math.

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

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method", isError: true }, 405);

  try {
    const body = await req.json().catch(() => ({}));
    const subject = (await accessSubject(req, db, String(body.subject ?? "") || null)) ?? "";
    if (!/^[a-f0-9]{64}$/.test(subject)) return json({ error: "subject invalide (hash attendu).", isError: true }, 400);
    const lang = body.lang === "es" ? "es" : "fr";

    const nowMs = Date.now();
    const since = new Date(nowMs - 14 * 24 * 3600 * 1000).toISOString();

    const { data: profile } = await db
      .from("mechabetics_profiles")
      .select("carb_ratio, correction_factor, target_mgdl, rapid_units_per_day, basal_units_per_day")
      .eq("subject", subject)
      .maybeSingle();

    const { data: insulin } = await db
      .from("mechabetics_insulin")
      .select("ts, units, kind")
      .eq("subject", subject)
      .gte("ts", since)
      .order("ts", { ascending: false })
      .limit(500);

    const { data: readings } = await db
      .from("mechabetics_readings")
      .select("ts, value_mgdl")
      .eq("subject", subject)
      .gte("ts", since)
      .order("ts", { ascending: false })
      .limit(4000);

    const prof = profile
      ? {
        carbRatio: profile.carb_ratio ?? null,
        correctionFactor: profile.correction_factor ?? null,
        targetMgdl: profile.target_mgdl ?? null,
        rapidUnitsPerDay: profile.rapid_units_per_day ?? null,
        basalUnitsPerDay: profile.basal_units_per_day ?? null,
      }
      : null;
    const ins = (insulin ?? []).map((d: any) => ({ ts: d.ts, units: Number(d.units), kind: d.kind }));
    const rds = (readings ?? []).map((r: any) => ({ ts: new Date(r.ts).getTime(), value: Number(r.value_mgdl) }));

    const result = suggestRatios({ insulin: ins, readings: rds, profile: prof, nowMs });
    const message = autotuneLine(result, lang);
    return json({ ...result, message, isError: false });
  } catch (e) {
    return json({ error: `${(e as Error)?.message ?? e}`, isError: true });
  }
});
