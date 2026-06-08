import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { accessSubject } from "../_shared/access.ts";
import { mealCarbSpeed, carbSpeedAdvice, type CarbSpeed } from "../_shared/doseGuard.ts";
import { chatJson, llmErrorKind, llmErrorMessage } from "../_shared/llm.ts";

// Doctor Claude — DIÉTÉTIQUE. Analyses the LOGGED FOOD over the last N days against the glucose
// curve and returns a STRUCTURED report (the app renders it as cards, not a wall of text):
//   - code-owned DATA: meals/day, carbs/day, fast/slow/fatty mix, average post-meal spike, the
//     foods that spiked the most, and post-meal lows (an over-bolus signal);
//   - LLM-written PROSE: a short summary + alerts + good points + one concrete tip, grounded in
//     that data (never any insulin-dose number — code owns doses elsewhere).

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

const DEEPSEEK_API_KEY = Deno.env.get("MECHABETICS_DEEPSEEK_API_KEY") ?? "";
const DEEPSEEK_MODEL = Deno.env.get("MECHABETICS_DEEPSEEK_MODEL") ?? "deepseek-v4-flash";
const GEMINI_TEXT_MODEL = Deno.env.get("MECHABETICS_GEMINI_TEXT_MODEL") ?? "gemini-2.5-flash";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-mechabetics-access",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { ...CORS, "content-type": "application/json" } });
}

interface MealRow { ts: number; desc: string; carbs: number; speed: CarbSpeed }
interface SpikeRow { desc: string; carbs: number; spike: number; speed: CarbSpeed }

/** The glucose RISE (mg/dL) in the 2.5 h after a meal: peak − the value at the meal time. null when
 *  there isn't enough data around the meal to judge. Pure, so it's easy to reason about/test. */
function postMealSpike(mealTs: number, readings: { t: number; v: number }[]): number | null {
  const WIN = 150 * 60_000;
  const after = readings.filter((r) => r.t >= mealTs - 10 * 60_000 && r.t <= mealTs + WIN);
  if (after.length < 3) return null;
  // baseline = the reading closest to the meal time (at or just before/after)
  let base = after[0];
  for (const r of after) if (Math.abs(r.t - mealTs) < Math.abs(base.t - mealTs)) base = r;
  const peak = Math.max(...after.map((r) => r.v));
  return Math.round(peak - base.v);
}

/** Did a hypo (<70) follow the meal within 3 h? (a possible over-bolus / over-estimated carbs.) */
function followedByLow(mealTs: number, readings: { t: number; v: number }[]): boolean {
  return readings.some((r) => r.t > mealTs && r.t <= mealTs + 3 * 3600_000 && r.v > 0 && r.v < 70);
}

function avg(xs: number[]): number {
  return xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0;
}

// A hypo RESCUE (pure sugar taken to fix a low) — NARROW match so real foods (juice, candy…) still
// count. A rescue's rise is intentional and the low that triggered it PRECEDED it, so it must NOT be
// flagged as a "problem food" or inflate the average spike.
const RESCUE_WORDS = ["sucre", "azúcar", "azucar", "sugar", "morceau", "terrón", "terron", "glucose", "resucr"];
function isRescue(desc: string): boolean {
  const d = (desc || "").toLowerCase();
  return RESCUE_WORDS.some((w) => d.includes(w));
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ isError: true }, 405);

  try {
    const body = await req.json().catch(() => ({}));
    const subject = (await accessSubject(req, db, String(body.subject ?? "") || null)) ?? "";
    if (!/^[a-f0-9]{64}$/.test(subject)) return json({ isError: true, error: "subject" }, 400);
    const lang = body.lang === "es" ? "es" : "fr";
    const days = Math.min(30, Math.max(3, Number(body.days) || 7));
    const byokGeminiKey = typeof body.geminiKey === "string" ? body.geminiKey : "";

    const nowMs = Date.now();
    const since = new Date(nowMs - days * 24 * 3600_000).toISOString();

    const [{ data: mealsRaw }, { data: readsRaw }] = await Promise.all([
      db.from("mechabetics_meals").select("ts, description, carbs_g, planned").eq("subject", subject).gte("ts", since).order("ts", { ascending: true }).limit(2000),
      db.from("mechabetics_readings").select("ts, value_mgdl").eq("subject", subject).gte("ts", since).order("ts", { ascending: true }).limit(6000),
    ]);

    const readings = (readsRaw ?? [])
      .map((r: any) => ({ t: new Date(r.ts).getTime(), v: Number(r.value_mgdl) }))
      .filter((r: any) => Number.isFinite(r.t) && r.v > 0);

    // Only EATEN meals (planned ones aren't food yet).
    const eatenAll: MealRow[] = (mealsRaw ?? [])
      .filter((m: any) => m && m.planned !== true && m.ts)
      .map((m: any) => ({
        ts: new Date(m.ts).getTime(),
        desc: String(m.description || "").slice(0, 60),
        carbs: Number(m.carbs_g) || 0,
        speed: mealCarbSpeed(m.description),
      }))
      .filter((m: MealRow) => Number.isFinite(m.ts));

    // Split HYPO RESCUES (sugar taken to FIX a low) OUT of the food analysis. A rescue is medical, not a
    // food choice — counting it as "fast sugar eaten" or in carbs/day would make the diet report scold
    // the child for treating a hypo (the user's point: rescue sugar ≠ pleasure sugar). Reported separately
    // as `rescuesCount`; everything below uses `eaten` = real food only.
    const rescuesCount = eatenAll.filter((m) => isRescue(m.desc)).length;
    const eaten: MealRow[] = eatenAll.filter((m) => !isRescue(m.desc));

    const mealsCount = eaten.length;
    // Span in days actually covered by the data (so "carbs/day" isn't diluted by empty days).
    const spanDays = mealsCount
      ? Math.max(1, Math.round((nowMs - Math.min(...eaten.map((m) => m.ts))) / (24 * 3600_000)))
      : days;
    const totalCarbs = eaten.reduce((s, m) => s + m.carbs, 0);
    const avgCarbsPerDay = Math.round(totalCarbs / spanDays);

    const speed = { fast: 0, slow: 0, fatty: 0, normal: 0 };
    for (const m of eaten) speed[m.speed]++;

    // Post-meal spikes (only for meals with carbs + enough surrounding readings).
    const spikes: SpikeRow[] = [];
    let postMealLows = 0;
    for (const m of eaten) {
      if (isRescue(m.desc)) continue; // a rescue's rise is intentional; skip it from the food analysis
      if (followedByLow(m.ts, readings)) postMealLows++;
      if (m.carbs <= 0) continue;
      const s = postMealSpike(m.ts, readings);
      if (s != null && s > 0) spikes.push({ desc: m.desc, carbs: m.carbs, spike: s, speed: m.speed });
    }
    const avgSpike = avg(spikes.map((s) => s.spike));
    const topSpikers = [...spikes].sort((a, b) => b.spike - a.spike).slice(0, 3)
      .map((s) => ({ desc: s.desc, carbs: s.carbs, spike: s.spike }));
    // Foods that behaved well (small rise) — for the "good points".
    const calmFoods = [...spikes].filter((s) => s.spike <= 40).sort((a, b) => a.spike - b.spike).slice(0, 3).map((s) => s.desc);

    // Not enough logged food to say anything useful — ask for more, don't invent.
    if (mealsCount < 4) {
      return json({
        isError: false, enough: false, days, mealsCount, rescuesCount, avgCarbsPerDay,
        fast: speed.fast, slow: speed.slow, fatty: speed.fatty, normal: speed.normal,
        avgSpike, topSpikers, alerts: [], goodPoints: [], tip: "",
        summary: lang === "es"
          ? "Aún hay pocas comidas registradas para un análisis dietético. Registra tus comidas unos días (con los carbohidratos) y vuelve a mirar."
          : "Encore peu de repas enregistrés pour une analyse diététique. Logge tes repas quelques jours (avec les glucides) et reviens voir.",
      });
    }

    // ---- code-owned DATA summary for the model (it writes prose around these numbers) ----
    const dominant: CarbSpeed = (["fatty", "fast", "slow"] as CarbSpeed[]).find((k) => speed[k] >= 2 && speed[k] === Math.max(speed.fatty, speed.fast, speed.slow)) ?? "normal";
    const speedTip = carbSpeedAdvice(dominant, lang);
    const dataLine = lang === "es"
      ? `DATOS (${spanDays} día(s), ${mealsCount} comidas): ~${avgCarbsPerDay} g de carbohidratos/día; reparto rápidas ${speed.fast} / lentas ${speed.slow} / grasas ${speed.fatty} / normales ${speed.normal}; subida media tras comer ${avgSpike} mg/dL; ${postMealLows} hipo(s) tras comer.${topSpikers.length ? ` Las que más subieron: ${topSpikers.map((t) => `${t.desc} (+${t.spike})`).join(", ")}.` : ""}${calmFoods.length ? ` Bien toleradas: ${calmFoods.join(", ")}.` : ""}`
      : `DONNÉES (${spanDays} jour(s), ${mealsCount} repas) : ~${avgCarbsPerDay} g de glucides/jour ; répartition rapides ${speed.fast} / lents ${speed.slow} / gras ${speed.fatty} / normaux ${speed.normal} ; montée moyenne après repas ${avgSpike} mg/dL ; ${postMealLows} hypo(s) après repas.${topSpikers.length ? ` Ceux qui ont le plus fait monter : ${topSpikers.map((t) => `${t.desc} (+${t.spike})`).join(", ")}.` : ""}${calmFoods.length ? ` Bien tolérés : ${calmFoods.join(", ")}.` : ""}`;

    // Rescues are excluded from the food mix above; mention them separately so the model can note hypo
    // management if relevant, WITHOUT ever calling rescue sugar "fast sugar eaten".
    const rescueNote = rescuesCount
      ? (lang === "es"
          ? ` ${rescuesCount} resucre(s) (azúcar para corregir una hipo) — no cuentan como alimentación.`
          : ` ${rescuesCount} resucrage(s) (sucre pour corriger une hypo) — non comptés dans l'alimentation.`)
      : "";

    const prompt = [
      lang === "es"
        ? "Eres Doctor Claude, un coach de nutrición para una persona con diabetes tipo 1. Analiza SOLO la ALIMENTACIÓN (no des dosis de insulina)."
        : "Tu es Doctor Claude, un coach nutrition pour une personne avec un diabète de type 1. Analyse UNIQUEMENT l'ALIMENTATION (ne donne aucune dose d'insuline).",
      dataLine + rescueNote,
      speedTip ? (lang === "es" ? `Pista de timing (úsala si encaja): ${speedTip}` : `Piste de timing (utilise-la si pertinent) : ${speedTip}`) : "",
      lang === "es"
        ? `Escribe en español sencillo y cálido (quizá sea un niño). Basa TODO en los datos de arriba — nunca inventes alimentos ni cifras. NO escribas ninguna dosis de insulina ni de azúcar.`
        : `Écris en français simple et bienveillant (c'est peut-être un enfant). Base TOUT sur les données ci-dessus — n'invente jamais un aliment ni un chiffre. N'écris AUCUNE dose d'insuline ni de sucre.`,
      lang === "es"
        ? `Responde SOLO en JSON: {"summary":"<1-2 frases: cómo come en general y el punto clave>","alerts":["<1 a 3 alertas concretas a vigilar, p.ej. comidas grasas que suben tarde, demasiada azúcar rápida, hipos tras comer>"],"goodPoints":["<1 a 3 cosas que hace BIEN>"],"tip":"<UN consejo concreto y accionable para mejorar la alimentación>"}`
        : `Réponds UNIQUEMENT en JSON : {"summary":"<1-2 phrases : comment il mange en gros et le point clé>","alerts":["<1 à 3 alertes concrètes à surveiller, ex. repas gras qui montent en retard, trop de sucres rapides, hypos après repas>"],"goodPoints":["<1 à 3 choses qu'il fait BIEN>"],"tip":"<UN conseil concret et actionnable pour améliorer l'alimentation>"}`,
    ].filter(Boolean).join(" ");

    let summary = "";
    let alerts: string[] = [];
    let goodPoints: string[] = [];
    let tip = "";
    try {
      const raw = await chatJson(
        { user: prompt, temperature: 0.4 },
        { byokGeminiKey, deepseekKey: DEEPSEEK_API_KEY, deepseekModel: DEEPSEEK_MODEL, geminiModel: GEMINI_TEXT_MODEL },
      );
      const p = JSON.parse(raw);
      summary = typeof p.summary === "string" ? p.summary.trim() : "";
      alerts = Array.isArray(p.alerts) ? p.alerts.filter((x: any) => typeof x === "string" && x.trim()).map((x: string) => x.trim()).slice(0, 3) : [];
      goodPoints = Array.isArray(p.goodPoints) ? p.goodPoints.filter((x: any) => typeof x === "string" && x.trim()).map((x: string) => x.trim()).slice(0, 3) : [];
      tip = typeof p.tip === "string" ? p.tip.trim() : "";
    } catch (e) {
      // AI down → still return the DATA (the cards stay useful) + a code-owned fallback summary.
      const kind = llmErrorKind(e);
      summary = llmErrorMessage(kind, lang, !!byokGeminiKey);
      if (speedTip) alerts = [speedTip];
      return json({
        isError: true, errorKind: kind, enough: true, days: spanDays, mealsCount, rescuesCount, avgCarbsPerDay,
        fast: speed.fast, slow: speed.slow, fatty: speed.fatty, normal: speed.normal,
        avgSpike, topSpikers, summary, alerts, goodPoints, tip,
      });
    }

    return json({
      isError: false, enough: true, days: spanDays, mealsCount, rescuesCount, avgCarbsPerDay,
      fast: speed.fast, slow: speed.slow, fatty: speed.fatty, normal: speed.normal,
      avgSpike, topSpikers, summary, alerts, goodPoints, tip,
    });
  } catch (e) {
    return json({ isError: true, error: `${(e as Error)?.message ?? e}` });
  }
});
