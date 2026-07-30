import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { accessSubject } from "../_shared/access.ts";
import {
  computeGuard,
  STALE_MIN,
  LOW_MGDL,
  SEVERE_LOW_MGDL,
  trendFromReadings,
  recentHypoFrom,
  minutesSinceLastRescue,
  activeIob,
  insulinActionMinutes,
  iobStatusPhrase,
  iobSystemLine,
  combinedActionLine,
  situationHint,
  stripInsulinNumbers,
  enforceInsulinCeiling,
  noDoseDue,
  softenCorrectionTalk,
  mealCarbSpeed,
  predictiveAdvice,
  predictiveLine,
  sugarTimingFact,
  hypoIobWarning,
  uncoveredMealWarning,
  inRangeActionLine,
  mealBolusPlan,
  planMealDose,
  mealPlanLine,
  plannedMealNote,
  type GuardProfile,
} from "../_shared/doseGuard.ts";
import { chatJson, llmErrorKind, llmErrorMessage } from "../_shared/llm.ts";

// How far back the STORED history is merged into the series the analysis reads. The phone only polls
// the patient on screen, so a followed patient's payload has real holes; the 24/7 monitor has been
// filling this table for every patient regardless.
//
// A FULL DAY, on purpose. Everything downstream windows itself to the question it is asking — the
// trend and the projection fit the last 20-45 min, the "last hour" note filters an hour, the meal
// spike detector looks around each meal — so a longer series can only ADD context, never blur a
// short-term answer. What it fixes is the opposite failure: variability, swings and the day's shape
// were being computed from whatever few hours the phone happened to be holding.
const TREND_HISTORY_HOURS = 24;

// Doctor Claude coach (FR/ES). Saves glucose history pseudonymously, then writes a short
// coaching message about the PAST DAY (last 24h) — and the EXACT next action, which is
// COMPUTED IN CODE by the deterministic guard (_shared/doseGuard.ts), never by the model.
// The model writes the analysis wording (no dose numbers); code appends the safe action
// (correction minus IOB, or fast sugar, or "recheck" — blocked when in-range/falling/stale).
// On-screen text in mg/dL; spoken voice in the local idiom. 10-min cache saves AI credits.

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

const DEEPSEEK_API_KEY = Deno.env.get("MECHABETICS_DEEPSEEK_API_KEY") ?? "";
const DEEPSEEK_MODEL = Deno.env.get("MECHABETICS_DEEPSEEK_MODEL") ?? "deepseek-v4-flash";
// BYOK Gemini text model — pin a newer id (e.g. gemini-3.x) via this secret, no code change needed.
const GEMINI_TEXT_MODEL = Deno.env.get("MECHABETICS_GEMINI_TEXT_MODEL") ?? "gemini-2.5-flash";
const ELEVENLABS_API_KEY = Deno.env.get("MECHABETICS_ELEVENLABS_API_KEY") ?? "";
const ELEVENLABS_VOICE_ID = Deno.env.get("MECHABETICS_ELEVENLABS_VOICE_ID") ?? "21m00Tcm4TlvDq8ikWAM";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { ...CORS, "content-type": "application/json" } });
}

async function loadPrompts(lang: string): Promise<Record<string, string>> {
  try {
    const { data } = await db.from("mechabetics_prompts").select("name, content").eq("lang", lang);
    const map: Record<string, string> = {};
    for (const row of (data ?? [])) map[(row as any).name] = (row as any).content;
    return map;
  } catch (_) {
    return {};
  }
}
function P(pr: Record<string, string>, name: string, fallback: string): string {
  const v = pr[name];
  return (typeof v === "string" && v.trim()) ? v : fallback;
}

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(bin);
}

function extractStr(raw: string, key: string): string | null {
  let i = raw.indexOf('"' + key + '"');
  if (i < 0) return null;
  i = raw.indexOf('"', i + key.length + 2);
  if (i < 0) return null;
  i++;
  let out = "";
  while (i < raw.length) {
    const c = raw[i];
    if (c === "\\") {
      const n = raw[i + 1];
      if (n === undefined) break;
      out += n === "n" ? "\n" : n === "t" ? "\t" : n;
      i += 2;
      continue;
    }
    if (c === '"') return out;
    out += c;
    i++;
  }
  return out.length ? out : null;
}

// A complete sentence ends with terminal punctuation (or a closing quote/paren). A salvaged
// fragment like "...5 mont" does not — used to make sure we never persist a truncated half-sentence.
function looksTruncated(s: string): boolean {
  const t = (s || "").trim();
  if (!t) return true;
  return !/[.!?…»)"'\]]$/.test(t);
}

// Deterministic 24h summary from the computed stats — a guaranteed-complete fallback used only when
// the model output is missing or truncated, so the user never sees a half-sentence. Always names what
// each number counts (e.g. "11 chutes rapides"), never a bare figure.
function statsSummary(s: any, lang: string, stability?: { word: string; note: string }): string {
  if (!s || !s.count_24h) {
    return lang === "es"
      ? "Aún hay pocos datos hoy; sigue midiendo y te hago el balance."
      : "Encore peu de données aujourd'hui ; continue de mesurer et je te fais le bilan.";
  }
  // Lead with the code-computed DAY VERDICT (from time-in-range), so even the fallback never calls a
  // high day "stable". Stability (oscillations) is a separate thing, not the day's verdict.
  const lead = lang === "es" ? `Día ${dayQuality(s, lang)}. ` : `Journée ${dayQuality(s, lang)}. `;
  const drops = Number(s.rapid_drops_24h) || 0;
  // The exact figures (today's %, average, vs-yesterday) are the CODE-OWNED dayStatsLine, prepended
  // separately, so this fallback stays QUALITATIVE — no number here to duplicate or be read as today.
  if (lang === "es") {
    const d = drops ? ` ${drops} bajada(s) rápida(s) de glucosa.` : "";
    return `${lead}${d} Sigue ajustando para suavizar las variaciones.`;
  }
  const d = drops ? ` ${drops} chute(s) rapide(s) de glycémie.` : "";
  return `${lead}${d} Continue d'ajuster pour lisser les variations.`;
}

function toGuardProfile(p: any): GuardProfile | null {
  if (!p) return null;
  return {
    carbRatio: p.carb_ratio ?? null,
    correctionFactor: p.correction_factor ?? null,
    targetMgdl: p.target_mgdl ?? null,
    weightKg: p.weight_kg ?? null,
    rapidInsulin: p.rapid_insulin ?? null,
  };
}

/** "il y a 3 min" / "il y a 2 h" — a human relative time so the model (and the accounting line)
 *  can tie a meal to a glucose move. */
function agoLabel(mins: number, lang: string): string {
  const es = lang === "es";
  if (mins < 1) return es ? "ahora" : "à l'instant";
  if (mins >= 90) return es ? `hace ${Math.round(mins / 60)} h` : `il y a ${Math.round(mins / 60)} h`;
  return es ? `hace ${mins} min` : `il y a ${mins} min`;
}

function profileContext(p: any, meals: any[], lang: string, nowMs: number): string {
  const bits: string[] = [];
  if (p?.nickname) bits.push(p.nickname);
  if (p?.age) bits.push(lang === "es" ? `${p.age} años` : `${p.age} ans`);
  if (p?.weight_kg) bits.push(`${p.weight_kg} kg`);
  if (p?.diagnosis_date) bits.push(lang === "es" ? `diabético desde ${p.diagnosis_date}` : `diabétique depuis ${p.diagnosis_date}`);
  if (p?.honeymoon) bits.push(lang === "es" ? `luna de miel ${p.honeymoon}` : `lune de miel ${p.honeymoon}`);
  const who = bits.join(", ");
  // List the day's meals WITH their timing (most-recent first, capped) so the model can connect a
  // meal to a glucose move — e.g. a spike after the donuts. Previously this listed at most 3 meals
  // with no time, so a daily bilan ignored most of what was logged. PLANNED meals (announced, not
  // yet eaten — possibly future-dated) are now INCLUDED and labelled "prévu", so "je vais manger un
  // McDo" stays visible to the coach instead of being silently dropped by the past-only filter.
  const dayMeals = (meals || [])
    .filter((m) => m && m.ts && (m.planned === true || new Date(m.ts).getTime() <= nowMs + 60000))
    .slice(0, 8);
  const mealsTxt = dayMeals
    .map((m) => {
      const mins = Math.round((nowMs - new Date(m.ts).getTime()) / 60000);
      const c = m.carbs_g ? ` ~${m.carbs_g}g` : "";
      const when = m.planned === true
        ? (mins < -1
          ? (lang === "es" ? `previsto en ${-mins} min, aún no comido` : `prévu dans ${-mins} min, pas encore mangé`)
          : (lang === "es" ? "previsto, aún no comido" : "prévu, pas encore mangé"))
        : agoLabel(mins, lang);
      return `${m.description}${c} (${when})`;
    })
    .join(", ");
  const parts: string[] = [];
  if (who) parts.push(lang === "es" ? `Perfil : ${who}.` : `Profil : ${who}.`);
  if (mealsTxt) parts.push(lang === "es" ? `Comidas de hoy : ${mealsTxt}.` : `Repas d'aujourd'hui : ${mealsTxt}.`);
  return parts.join(" ");
}

// A FUTURE-dated dose is a PLANNED injection (not yet active — activeIob skips it): say so instead
// of the nonsense "il y a -53 min". Each PAST dose carries its computed state (still working /
// finished) and the line closes with the SYSTEM total (iobSystemLine) — the model used to see only
// "4 u il y a 290 min" and estimated the decay ITSELF, writing "insuline presque terminée" while
// the computed IOB (and the Insuline tab) said 0.
function insulinContext(doses: any[], iob: number, defaultDur: number, nowMs: number, lang: string): string {
  const rapid = (doses || []).filter((d: any) => d.kind !== "basal");
  if (!rapid.length) return "";
  const es = lang === "es";
  const parts = rapid.map((d: any) => {
    const mins = Math.round((nowMs - new Date(d.ts).getTime()) / 60000);
    const what = `${d.units} u${d.insulin_name ? ` ${d.insulin_name}` : ""}`;
    if (mins < -1) return es ? `${what} PREVISTA en ${-mins} min (aún no activa)` : `${what} PRÉVUE dans ${-mins} min (pas encore active)`;
    const done = mins >= (insulinActionMinutes(d.insulin_name) ?? defaultDur);
    const state = done ? (es ? "ya terminó de actuar" : "a fini d'agir") : (es ? "sigue actuando" : "agit encore");
    return es ? `${what} hace ${Math.max(0, mins)} min (${state})` : `${what} il y a ${Math.max(0, mins)} min (${state})`;
  });
  return es
    ? `INSULINA RÁPIDA RECIENTE: ${parts.join("; ")}. ${iobSystemLine(iob, lang)}`
    : `INSULINE RAPIDE RÉCENTE : ${parts.join(" ; ")}. ${iobSystemLine(iob, lang)}`;
}

function fmtUnits(u: number): string {
  const r = Math.round(u * 10) / 10;
  const s = Number.isInteger(r) ? String(r) : r.toFixed(1);
  return s.replace(".", ","); // FR/ES decimal comma
}

// Transparency line, CODE-OWNED (like the dose): state plainly what the bilan took into account —
// insulin still on board (and the dose that created it) and the last logged meal — or that NONE was
// logged. So the user can trust the action ("no insulin now" BECAUSE a dose is already working)
// instead of guessing, and knows to log a missing dose/meal when the system says none is recorded.
function accountingLine(insulin: any[], meals: any[], iob: number, nowMs: number, lang: string): string {
  const es = lang === "es";
  const rapid = (insulin || []).filter((d: any) => d.kind !== "basal");
  // Split PAST (taken) vs FUTURE (planned) doses: "dernière dose" must be a dose actually injected —
  // a planned future dose used to land here as "il y a -53 min" and read as already on board.
  const past = rapid.filter((d: any) => new Date(d.ts).getTime() <= nowMs + 60000);
  const future = rapid.filter((d: any) => new Date(d.ts).getTime() > nowMs + 60000);
  let insPart: string;
  if (past.length) {
    const d = past[0]; // most recent taken (rows arrive newest-first)
    const mins = Math.max(0, Math.round((nowMs - new Date(d.ts).getTime()) / 60000));
    // Three honest tiers (code-owned, tested): a long-finished dose says "terminée", matching the
    // Insuline tab's 0 — "presque épuisée" used to cover finished doses too and read as still active.
    const act = iobStatusPhrase(iob, lang);
    insPart = es
      ? `insulina ${act} (última dosis ${fmtUnits(Number(d.units))} u ${agoLabel(mins, lang)}, tenida en cuenta)`
      : `insuline ${act} (dernière dose ${fmtUnits(Number(d.units))} u ${agoLabel(mins, lang)}, prise en compte)`;
  } else {
    insPart = es ? "ninguna insulina registrada" : "aucune insuline loggée";
  }
  if (future.length) {
    const f = future[future.length - 1]; // the soonest upcoming (rows newest-first → last is earliest)
    const inMins = Math.max(1, Math.round((new Date(f.ts).getTime() - nowMs) / 60000));
    insPart += es
      ? ` · 1 dosis PREVISTA (${fmtUnits(Number(f.units))} u en ${inMins} min, aún no activa)`
      : ` · 1 dose PRÉVUE (${fmtUnits(Number(f.units))} u dans ${inMins} min, pas encore active)`;
  }
  let mealPart: string;
  // Count EVERY meal logged in the last day (scanned OR eaten), naming the most recent — so a day
  // full of logged meals is never reported as "no meal logged" just because the 3 latest rows
  // happened to be planned scans (the exact bug: 3 scans hid 4 real meals → "aucun repas loggé").
  const dayMeals = (meals || [])
    .filter((m: any) => m && m.ts)
    .map((m: any) => ({ desc: String(m.description || "").slice(0, 40), t: new Date(m.ts).getTime() }))
    .filter((m: any) => Number.isFinite(m.t) && m.t <= nowMs + 60000 && m.t >= nowMs - 26 * 3600 * 1000)
    .sort((a: any, b: any) => b.t - a.t);
  if (dayMeals.length) {
    const m = dayMeals[0];
    const ago = agoLabel(Math.round((nowMs - m.t) / 60000), lang);
    mealPart = es
      ? `${dayMeals.length} comida(s) registrada(s) hoy (última « ${m.desc} » ${ago})`
      : `${dayMeals.length} repas loggé(s) aujourd'hui (dernier « ${m.desc} » ${ago})`;
  } else {
    mealPart = es ? "ninguna comida registrada" : "aucun repas loggé";
  }
  return es
    ? `Tenido en cuenta : ${insPart} · ${mealPart}.`
    : `Pris en compte : ${insPart} · ${mealPart}.`;
}

// Recent physical activity -> context (sport lowers glucose; the coach should factor it in).
function activityContext(acts: any[], lang: string): string {
  if (!acts || !acts.length) return "";
  const now = Date.now();
  const ago = lang === "es" ? "hace" : "il y a";
  const parts = acts.slice(0, 3).map((a: any) => {
    const mins = Math.round((now - new Date(a.ts).getTime()) / 60000);
    const what = a.description || a.kind || (lang === "es" ? "actividad" : "activité");
    const when = a.planned ? (lang === "es" ? "previsto" : "prévu") : `${ago} ${mins} min`;
    return `${what} (${when})`;
  });
  return lang === "es"
    ? `ACTIVIDAD FÍSICA RECIENTE: ${parts.join("; ")} — el ejercicio BAJA la glucosa, tenlo en cuenta.`
    : `ACTIVITÉ PHYSIQUE RÉCENTE : ${parts.join(" ; ")} — le sport FAIT BAISSER la glycémie, prends-le en compte.`;
}

// Detect a rapid rise/drop and especially a hyper<->hypo swing in the last 24h (context only).
function swingNote(readings: any[], lang: string): string {
  const raw = readings
    .filter((r: any) => r && Number(r.value) > 0 && r.ts)
    .map((r: any) => ({ t: Number(r.ts), v: Math.round(Number(r.value)) }))
    .sort((a, b) => a.t - b.t);
  // Dedup to one point per 5-min bucket (keep latest) + drop future-dated points, so duplicate /
  // noisy / bad-timezone samples don't distort the peak→trough TIMING (that's what gave the wrong
  // "230→71 in 75 min" instead of the real "230→67 in ~45 min").
  const nowMs = Date.now();
  const bucket = new Map<number, { t: number; v: number }>();
  for (const p of raw) {
    if (p.t > nowMs + 120000) continue;
    const b = Math.floor(p.t / 300000);
    const ex = bucket.get(b);
    if (!ex || p.t > ex.t) bucket.set(b, p);
  }
  const day = [...bucket.values()].filter((p) => p.t >= nowMs - 24 * 3600 * 1000).sort((a, b) => a.t - b.t);
  if (day.length < 2) return "";
  const WIN = 90 * 60 * 1000;
  let danger: { from: number; to: number; min: number } | null = null;
  let dangerRate = 0;
  let move: { from: number; to: number; min: number; drop: boolean; rate: number } | null = null;
  let moveRate = 0;
  for (let i = 0; i < day.length; i++) {
    for (let j = i + 1; j < day.length && day[j].t - day[i].t <= WIN; j++) {
      const delta = day[j].v - day[i].v;
      const mag = Math.abs(delta);
      const mins = Math.round((day[j].t - day[i].t) / 60000);
      if (mins <= 0) continue;
      if ((day[i].v > 180 && day[j].v < 80) || (day[i].v < 70 && day[j].v > 180)) {
        // Pick the STEEPEST qualifying swing, not the biggest — otherwise we stretch the duration by
        // pairing the peak with a slightly-lower-but-much-later trough (the "230→65 in 75 min" bug
        // instead of the real "230→67 in 45 min"). Steepest rate = the tight, real peak→trough.
        const rate = mag / mins;
        if (rate > dangerRate) { dangerRate = rate; danger = { from: day[i].v, to: day[j].v, min: mins }; }
      }
      if (day[j].t - day[i].t <= 60 * 60 * 1000 && mag >= 30) {
        const rate = mag / mins;
        if (rate > moveRate) { moveRate = rate; move = { from: day[i].v, to: day[j].v, min: mins, drop: delta < 0, rate }; }
      }
    }
  }
  if (danger) {
    return lang === "es"
      ? `OSCILACIÓN BRUSCA: la glucosa pasó de ${danger.from} a ${danger.to} mg/dL en ${danger.min} min. Explica en una frase la causa probable.`
      : `SWING BRUTAL : la glycémie est passée de ${danger.from} à ${danger.to} mg/dL en ${danger.min} min. Explique en une phrase la cause probable.`;
  }
  if (move) {
    const steep = move.rate >= 2;
    const r1 = move.rate.toFixed(1);
    if (lang === "es") {
      if (steep) return move.drop
        ? `BAJADA RÁPIDA: de ${move.from} a ${move.to} mg/dL en ${move.min} min (~${r1}/min). Señálalo.`
        : `SUBIDA RÁPIDA: de ${move.from} a ${move.to} mg/dL en ${move.min} min (~${r1}/min). Señálalo.`;
      return move.drop
        ? `Tendencia a la baja pero LENTA (~${r1}/min): di "bajando", NO "bajada rápida".`
        : `Tendencia al alza pero LENTA (~${r1}/min): di "subiendo", NO "subida rápida".`;
    }
    if (steep) return move.drop
      ? `CHUTE RAPIDE : de ${move.from} à ${move.to} mg/dL en ${move.min} min (~${r1}/min). Signale-la.`
      : `MONTÉE RAPIDE : de ${move.from} à ${move.to} mg/dL en ${move.min} min (~${r1}/min). Signale-la.`;
    return move.drop
      ? `Tendance à la baisse mais LENTE (~${r1}/min) : dis « en baisse », PAS « chute rapide ».`
      : `Tendance à la hausse mais LENTE (~${r1}/min) : dis « en hausse », PAS « montée rapide ».`;
  }
  return "";
}

function evoLine(s: any, lang: string): string {
  // Compare LOCAL calendar today vs yesterday so this matches the History screen's per-day bars
  // (fallback to the rolling windows for older clients that don't send a tz offset).
  const t24 = s?.tir_today_cal ?? s?.tir_24h, tPrev = s?.tir_yesterday_cal ?? s?.tir_prev_day, t7 = s?.tir_7d, a7 = s?.avg_7d;
  if (lang === "es") {
    if (t24 != null && tPrev != null) {
      if (t24 > tPrev + 5) return `Mejor que ayer: ${t24}% en objetivo hoy frente al ${tPrev}% de ayer.`;
      if (t24 < tPrev - 5) return `Menos bien que ayer: ${t24}% en objetivo hoy frente al ${tPrev}% de ayer.`;
      return `Similar a ayer en control (~${t24}% en objetivo) — eso NO dice nada de la estabilidad de hoy.`;
    }
    if (t24 != null && t7 != null) return `En los últimos 7 días, ${t7}% del tiempo en objetivo (media ${a7} mg/dL); hoy ${t24}%.`;
    return `Aún hay pocos datos de los días previos: céntrate en hoy.`;
  }
  if (t24 != null && tPrev != null) {
    if (t24 > tPrev + 5) return `Mieux qu'hier : ${t24}% dans la cible aujourd'hui contre ${tPrev}% hier.`;
    if (t24 < tPrev - 5) return `Moins bien qu'hier : ${t24}% dans la cible aujourd'hui contre ${tPrev}% hier.`;
    return `Comparable à hier en contrôle (~${t24}% dans la cible) — ça ne dit RIEN sur la stabilité d'aujourd'hui.`;
  }
  if (t24 != null && t7 != null) return `Sur les 7 derniers jours, ${t7}% du temps dans la cible (moyenne ${a7} mg/dL) ; aujourd'hui ${t24}%.`;
  return `Encore peu de données sur les jours précédents : concentre-toi sur aujourd'hui.`;
}

/** CODE-OWNED day figures shown to the user — time-in-range %, average, and the day-over-day
 *  comparison, ALL from the 08:00→08:00 LOCAL day (tir_today_cal), the SAME window the History
 *  screen's per-day boxes use, so the two screens always agree. The LLM is told NOT to write these
 *  numbers: it had put the "vs hier" % ("71%") in a spot that read as TODAY, while today was 89% —
 *  the user saw "today 71%". Owning the line in code makes today unmistakably "today" and yesterday
 *  unmistakably "hier". Falls back to the rolling 24 h for token-less / very-early-morning clients. */
function dayStatsLine(s: any, lang: string): string {
  if (!s || !s.count_24h) return "";
  const tir = s.tir_today_cal ?? s.tir_24h;
  const avg = s.avg_today_cal ?? s.avg_24h;
  if (tir == null) return "";
  const tPrev = s.tir_yesterday_cal ?? s.tir_prev_day;
  const es = lang === "es";
  let cmp = "";
  if (tPrev != null) {
    if (tir >= tPrev + 5) cmp = es ? ` — mejor que ayer (ayer ${tPrev}%)` : ` — mieux qu'hier (hier ${tPrev}%)`;
    else if (tir <= tPrev - 5) cmp = es ? ` — menos bien que ayer (ayer ${tPrev}%)` : ` — moins bien qu'hier (hier ${tPrev}%)`;
    else cmp = es ? ` — como ayer (ayer ${tPrev}%)` : ` — comme hier (hier ${tPrev}%)`;
  }
  // THE LOW HALF OF THE DAY, ALWAYS. This line is the ONLY place a number reaches the screen (the
  // model is forbidden from writing figures), and it used to carry time-in-target and the average
  // and nothing else. So the day's low side — "6% of today under 70, lowest 52" — had no route to
  // the user at all, which is exactly how a day with three hypos got announced as "better than
  // yesterday". Shown even when it is zero: "0% under 70" is information worth having.
  const lo = s.pct_low_today_cal ?? s.pct_low_24h;
  const mn = s.min_today_cal ?? s.min_24h;
  let lows = "";
  if (lo != null) {
    lows = es
      ? ` Por debajo de 70: ${lo}% del tiempo${mn != null ? `, mínimo ${mn} mg/dL` : ""}.`
      : ` Sous 70 : ${lo}% du temps${mn != null ? `, plus bas ${mn} mg/dL` : ""}.`;
  }
  return es
    ? `Hoy (de 8 h a 8 h): ${tir}% del tiempo en objetivo, media ${avg} mg/dL${cmp}.${lows}`
    : `Aujourd'hui (de 8 h à 8 h) : ${tir}% du temps dans la cible, moyenne ${avg} mg/dL${cmp}.${lows}`;
}

// Clinical consensus targets for time below range: under 4% of the day below 70, under 1% below 54.
// Past those, the day is not a good day whatever the time-in-target says.
const LOW_TIME_WARN_PCT = 4;
const LOW_TIME_BAD_PCT = 10;

/** Did the day go low, and how badly? Read once by the verdict and once by the prompt so the two
 *  can't disagree. */
function dayLows(stats: any): { pct: number | null; min: number | null; any: boolean; severe: boolean } {
  const pctRaw = Number(stats?.pct_low_today_cal ?? stats?.pct_low_24h);
  const minRaw = Number(stats?.min_today_cal ?? stats?.min_24h);
  const pct = Number.isFinite(pctRaw) ? pctRaw : null;
  const min = Number.isFinite(minRaw) && minRaw > 0 ? minRaw : null;
  return {
    pct, min,
    any: (pct != null && pct > 0) || (min != null && min < LOW_MGDL),
    severe: (min != null && min < SEVERE_LOW_MGDL) || (pct != null && pct >= LOW_TIME_BAD_PCT),
  };
}

/** Code-owned sentence about the day's lows, injected into the prompt. Empty when the day stayed
 *  above 70 — so its mere presence tells the model the subject may not be skipped. */
function hypoDayNote(stats: any, lang: string): string {
  const l = dayLows(stats);
  if (!l.any) return "";
  const es = lang === "es";
  const parts = [
    l.pct != null && l.pct > 0 ? (es ? `${l.pct}% del día por debajo de 70` : `${l.pct}% de la journée sous 70`) : "",
    l.min != null ? (es ? `mínimo ${l.min} mg/dL` : `minimum ${l.min} mg/dL`) : "",
  ].filter(Boolean).join(", ");
  return es
    ? `HIPOGLUCEMIAS DE HOY (calculado por el sistema): ${parts}. Es OBLIGATORIO mencionarlas en tu frase — sin cifras, el sistema ya las añade. Un día con pasos por debajo de 70 NO es un "buen día" ni un día "tranquilo", por muy alto que sea el tiempo en objetivo.`
    : `HYPOS D'AUJOURD'HUI (calculé par le système) : ${parts}. Tu DOIS les mentionner dans ta phrase — sans chiffre, le système ajoute déjà la ligne chiffrée. Une journée avec des passages sous 70 n'est PAS une « bonne journée » ni une journée « tranquille », quel que soit le temps dans la cible.`;
}

/** Coefficient of variation (SD / mean, in %) — the clinical measure of glucose variability.
 *  ≤ 36% is considered stable; higher means the line swings a lot. */
function variabilityCv(sorted: { ts: number; value: number }[]): number | null {
  const vals = (sorted || []).map((p) => p.value).filter((v) => v > 0);
  if (vals.length < 6) return null;
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  if (mean <= 0) return null;
  const variance = vals.reduce((a, b) => a + (b - mean) * (b - mean), 0) / vals.length;
  return Math.round((Math.sqrt(variance) / mean) * 100);
}

/** CODE owns the stability word — same principle as "code owns the dose". A day with 21 rapid
 *  swings can't be called "stable" just because the model felt like it: we decide the word from the
 *  real numbers (clinical CV + count of rapid rises/drops) and the model is told to use it. */
function dayStability(stats: any, cv: number | null, lang: string): { word: string; note: string } {
  const es = lang === "es";
  const swings = (Number(stats?.rapid_rises_24h) || 0) + (Number(stats?.rapid_drops_24h) || 0);
  let level: 0 | 1 | 2;
  if ((cv != null && cv >= 45) || swings >= 14) level = 2;
  else if ((cv != null && cv >= 36) || swings >= 7) level = 1;
  else level = 0;
  const word = es
    ? ["estable", "variable", "muy inestable"][level]
    : ["stable", "variable", "très instable"][level];
  const cvTxt = cv != null ? (es ? `, variabilidad ${cv}%` : `, variabilité ${cv}%`) : "";
  const note = es ? `${swings} variaciones rápidas${cvTxt}` : `${swings} variations rapides${cvTxt}`;
  return { word, note };
}

/** CODE owns the DAY VERDICT too — and it comes from TIME IN RANGE, NOT stability. A flat-but-high
 *  day (calm line, little variability, but mostly above target) is a DIFFICULT day, never "stable".
 *  The model must LEAD with this word; the stability word only describes the oscillations. */
function dayQuality(stats: any, lang: string): string {
  // The day that restarts at 08:00 (calendar-local), falling back to the rolling 24 h window.
  const tir = Number(stats?.tir_today_cal ?? stats?.tir_24h);
  const es = lang === "es";
  if (!Number.isFinite(tir)) return es ? "irregular" : "en demi-teinte";
  let level = tir >= 70 ? 0 : tir >= 50 ? 1 : 2;

  // LOWS OUTRANK TIME-IN-TARGET. Time in target alone made this verdict blind to the one thing that
  // actually hurts on the day it happens: an hour spent at 55 mg/dL costs about 4% of the day, so a
  // day with three hypos still scored "bonne" — and, worse, was announced as "better than yesterday"
  // than a day with none. A hypo is not a rounding error in a percentage.
  const l = dayLows(stats);
  if (l.severe) level = 2;                                        // under 54, or lows all day
  else if (l.pct != null && l.pct >= LOW_TIME_WARN_PCT) level = Math.max(level, 2);
  else if (l.any) level = Math.max(level, 1);                     // any dip under 70 caps at "moyenne"

  return es ? ["buena", "regular", "difícil"][level] : ["bonne", "moyenne", "difficile"][level];
}

/** Compact "last hour" + "last 10 minutes" snapshot so the bilan can layer 24h → hour → now. */
function recentWindowNote(sorted: { ts: number; value: number }[], nowMs: number, lang: string): string {
  if (!sorted || !sorted.length) return "";
  const es = lang === "es";
  const hour = sorted.filter((p) => p.ts >= nowMs - 60 * 60000);
  const ten = sorted.filter((p) => p.ts >= nowMs - 12 * 60000);
  const parts: string[] = [];
  if (hour.length >= 2) {
    const vals = hour.map((p) => Math.round(p.value));
    const lo = Math.min(...vals), hi = Math.max(...vals);
    parts.push(es ? `Última hora : entre ${lo} y ${hi} mg/dL.` : `Dernière heure : entre ${lo} et ${hi} mg/dL.`);
  }
  if (ten.length) {
    const t = trendFromReadings(ten.length >= 2 ? ten : sorted.slice(-3), nowMs);
    const dir = es
      ? (t === "rising_fast" || t === "rising" ? "subiendo" : t === "falling_fast" || t === "falling" ? "bajando" : "estable")
      : (t === "rising_fast" || t === "rising" ? "en hausse" : t === "falling_fast" || t === "falling" ? "en baisse" : "stable");
    const last = Math.round(ten[ten.length - 1].value);
    parts.push(es ? `Últimos 10 min : ${last} mg/dL, ${dir}.` : `10 dernières minutes : ${last} mg/dL, ${dir}.`);
  }
  return parts.join(" ");
}

/** Red-flag a logged meal followed by a big climb into hyper, with CARB-SPEED-aware wording: a fast
 *  sugar's quick spike is EXPECTED (don't over-correct, pre-bolus next time), while slow/fatty meals
 *  rise LATE (recheck later, split the fatty bolus). Code-owned; the model just surfaces it. */
function mealSpikeNote(meals: any[], sorted: { ts: number; value: number }[], nowMs: number, lang: string): string {
  const es = lang === "es";
  const eaten = (meals || [])
    .filter((m) => m && m.planned !== true && m.ts)
    .map((m) => ({ desc: String(m.description || ""), t: new Date(m.ts).getTime() }))
    .filter((m) => Number.isFinite(m.t) && m.t > nowMs - 5 * 3600 * 1000 && m.t <= nowMs + 60000)
    .sort((a, b) => b.t - a.t);
  if (!eaten.length || !sorted.length) return "";
  const m = eaten[0];
  const min = Math.max(0, Math.round((nowMs - m.t) / 60000));
  const speed = mealCarbSpeed(m.desc); // fast (sugar) / slow (pasta…) / fatty / normal
  const after = sorted.filter((p) => p.ts >= m.t && p.ts <= m.t + 3 * 3600 * 1000 && p.value > 0);
  if (after.length >= 3) {
    const atMeal = after[0].value;
    const peak = Math.round(Math.max(...after.map((p) => p.value)));
    if (peak >= 185 && peak - atMeal >= 60) {
      if (speed === "fatty") {
        return es
          ? `🚩 SEÑÁLALO claramente: la comida «${m.desc}» (grasa, hace ${min} min) fue seguida de una fuerte subida hasta ${peak} mg/dL. Las comidas grasas (fast-food, pizza, queso…) se digieren LENTO → la glucosa sube con RETRASO; aconseja un bolo dividido (una parte en la comida, otra ~1-2 h después) o recontrolar 2-3 h después. Sin cifras de dosis.`
          : `🚩 SIGNALE-LE clairement : le repas «${m.desc}» (gras, il y a ${min} min) a été suivi d'une forte montée jusqu'à ${peak} mg/dL. Les repas gras (fast-food, pizza, fromage…) digèrent LENTEMENT → la glycémie monte en RETARD ; conseille un bolus étalé (une partie au repas, une partie ~1-2 h après) ou de recontrôler 2-3 h après. Aucun chiffre de dose.`;
      }
      if (speed === "fast") {
        // Fast sugar → a quick post-meal spike is EXPECTED; warn against over-correcting it, and
        // suggest a pre-bolus next time. (Same "code owns the curve" idea as the fatty branch.)
        return es
          ? `SEÑÁLALO: la comida «${m.desc}» (azúcar rápido, hace ${min} min) fue seguida de una subida hasta ${peak} mg/dL — es ESPERABLE con azúcar rápido (sube en 15-45 min). No la sobre-corrijas enseguida; la próxima vez, poner la insulina un poco ANTES de comer frena el pico. Sin cifras de dosis.`
          : `SIGNALE-LE : le repas «${m.desc}» (sucre rapide, il y a ${min} min) a été suivi d'une montée jusqu'à ${peak} mg/dL — c'est ATTENDU avec un sucre rapide (monte en 15-45 min). Ne sur-corrige pas tout de suite ; la prochaine fois, faire l'insuline un peu AVANT de manger limite le pic. Aucun chiffre de dose.`;
      }
      if (speed === "slow") {
        return es
          ? `🚩 SEÑÁLALO: la comida «${m.desc}» (carbohidratos lentos, hace ${min} min) fue seguida de una subida hasta ${peak} mg/dL. Los carbohidratos lentos (pasta, legumbres, integral) suben TARDE y de forma prolongada → la subida puede durar; recontrola más tarde y revisa el momento del bolo. Sin cifras de dosis.`
          : `🚩 SIGNALE-LE : le repas «${m.desc}» (glucides lents, il y a ${min} min) a été suivi d'une montée jusqu'à ${peak} mg/dL. Les glucides lents (pâtes, légumineuses, complet) montent TARD et de façon prolongée → la montée peut durer ; recontrôle plus tard et revois le moment du bolus. Aucun chiffre de dose.`;
      }
      return es
        ? `🚩 SEÑÁLALO: la comida «${m.desc}» (hace ${min} min) fue seguida de una subida hasta ${peak} mg/dL; sugiere revisar el conteo de carbohidratos o el momento del bolo.`
        : `🚩 SIGNALE-LE : le repas «${m.desc}» (il y a ${min} min) a été suivi d'une montée jusqu'à ${peak} mg/dL ; suggère de revoir le compte de glucides ou le moment du bolus.`;
    }
  }
  // No big spike yet — but a slow OR fatty meal in the last 3 h rises LATE → proactive heads-up.
  if ((speed === "fatty" || speed === "slow") && min <= 180) {
    if (speed === "fatty") {
      return es
        ? `La comida «${m.desc}» es grasa: la subida puede llegar con retraso (2-3 h); vigila y recontrola.`
        : `Le repas «${m.desc}» est gras : la montée peut arriver en retard (2-3 h) ; surveille et recontrôle.`;
    }
    return es
      ? `La comida «${m.desc}» son carbohidratos lentos: la subida puede llegar tarde (2-3 h); vigila y recontrola.`
      : `Le repas «${m.desc}» = glucides lents : la montée peut arriver tard (2-3 h) ; surveille et recontrôle.`;
  }
  return "";
}

function buildPrompt(cur: number | null, s: any, lang: string, ctx: string, swing: string, pr: Record<string, string>, hint: string, recent: string, stability: { word: string; note: string }, signalLost: boolean, staleMin: number, sensorExpired: boolean, actionLine: string, noDose: boolean): string {
  const curMg = cur != null ? `${cur} mg/dL` : (lang === "es" ? "desconocida" : "inconnue");
  const evo = evoLine(s, lang);
  const quality = dayQuality(s, lang); // the day's VERDICT (from time-in-range), not the stability word
  // "Today" = the LOCAL day that restarts at 08:00 (tir_today_cal etc.), so the bilan's % match the
  // History per-day boxes. Fall back to the rolling 24 h window for older clients / empty early days.
  const tToday = s?.tir_today_cal ?? s?.tir_24h, aToday = s?.avg_today_cal ?? s?.avg_24h,
    hiToday = s?.pct_high_today_cal ?? s?.pct_high_24h, loToday = s?.pct_low_today_cal ?? s?.pct_low_24h,
    mxToday = s?.max_today_cal ?? s?.max_24h, mnToday = s?.min_today_cal ?? s?.min_24h;
  // THE DECISION IS ALREADY MADE, and the model is told so before it writes a word. Without this it
  // wrote the bilan blind and then had a code-owned action stapled underneath, which is how "une
  // chute rapide à corriger" ended up above "rien à corriger". The reserved-vocabulary clause is the
  // part that actually does the work: the model keeps its observations, the system keeps the verb.
  const decided = actionLine
    ? (lang === "es"
      ? `ACCIÓN YA DECIDIDA POR EL SISTEMA (se mostrará TAL CUAL debajo de tu texto): «${actionLine}». Es la que manda: tu análisis NUNCA debe contradecirla.${noDose ? ` El sistema ha concluido que AHORA MISMO no hay NADA que tomar ni que corregir — así que no escribas en ningún campo que haya que corregir, resucar o inyectar. Un pico o una bajada de HOY se cuentan en pasado, como algo OBSERVADO y a vigilar, nunca como una consigna para ahora.` : ""} El verbo «corregir» y toda orden de actuar ahora pertenecen a esa línea de acción, no a ti.`
      : `ACTION DÉJÀ DÉCIDÉE PAR LE SYSTÈME (elle sera affichée TELLE QUELLE sous ton texte) : «${actionLine}». C'est elle qui fait foi : ton analyse ne doit JAMAIS la contredire.${noDose ? ` Le système a conclu qu'il n'y a RIEN à prendre ni à corriger MAINTENANT — n'écris donc dans aucun champ qu'il faut corriger, resucrer ou injecter. Un pic ou une chute d'AUJOURD'HUI se racontent au passé, comme quelque chose d'OBSERVÉ et à surveiller, jamais comme une consigne pour maintenant.` : ""} Le verbe « corriger » et toute consigne d'agir maintenant appartiennent à cette ligne d'action, pas à toi.`)
    : "";
  const noNumbers = lang === "es"
    ? `IMPORTANTE — DOSIS: NO escribas tú ningún número de dosis (unidades de insulina, gramos o terrones) en "display" ni "voice". El sistema calcula y añade la acción exacta. Tú haces el análisis del día y dices, sin cifras, qué tipo de acción toca.`
    : `IMPORTANT — DOSE : n'écris TOI-MÊME AUCUN chiffre de dose (unités d'insuline, grammes, morceaux) dans "display" ni "voice". Le système calcule et ajoute l'action exacte. Toi, tu fais l'analyse du jour et tu dis, sans chiffre, quel type d'action s'impose.`;

  if (lang === "es") {
    const day = s?.count_24h
      ? `Balance de HOY (desde las 8 h): media ${aToday} mg/dL; ${tToday}% del tiempo en el objetivo 70-180; ${hiToday}% por encima de 180 y ${loToday}% por debajo de 70; ${s.rapid_drops_24h} bajada(s) rápida(s) y ${s.rapid_rises_24h} subida(s) rápida(s); punto más alto ${mxToday}, más bajo ${mnToday} mg/dL.`
      : `Aún pocos datos hoy.`;
    return [
      P(pr, "coach.persona", `Eres Doctor Claude, un coach de salud inteligente y directo para alguien con diabetes tipo 1. Sin cursilerías ni apodos: alguien puede ver la pantalla.`),
      ctx,
      signalLost
        ? (sensorExpired
          ? `SENSOR CADUCADO: los 14 días del sensor se cumplieron y no hay medición desde hace ${staleMin} min — la glucosa ACTUAL es DESCONOCIDA. Última conocida: ${curMg}.`
          : `SEÑAL PERDIDA: sin medición desde hace ${staleMin} min, la glucosa ACTUAL es DESCONOCIDA. Última glucosa conocida: ${curMg} (hace ${staleMin} min).`)
        : `Glucosa actual: ${curMg}.`,
      signalLost
        ? (sensorExpired
          ? `IMPORTANTE — SENSOR CADUCADO: EMPIEZA diciendo claramente que el sensor llegó al final de sus 14 días y que hay que poner uno NUEVO (cuenta ~1 h de arranque tras la colocación). Habla de la ÚLTIMA glucosa conocida (${curMg}), NUNCA como si fuera ahora. Aconseja una punción capilar mientras tanto. NO digas «acercar el teléfono» ni «volver a escanear»: un sensor terminado no vuelve.`
          : `IMPORTANTE — SEÑAL PERDIDA: EMPIEZA diciendo claramente que se perdió la señal (sin medición desde hace ${staleMin} min) y que NO se conoce la glucosa actual. Habla de la ÚLTIMA glucosa conocida (${curMg}) y de la tendencia pasada, pero NUNCA digas «estás en ${cur}» ni «tu glucosa es ${cur}» como si fuera ahora — di «tu última glucosa conocida era ${cur}». Aconseja PRIMERO reconectar el sensor (el teléfono que lo escanea debe estar cerca y conectado, volver a escanear si hace falta); una punción capilar SOLO si la señal no vuelve.`)
        : "",
      day,
      recent,
      hypoDayNote(s, lang),
      `VEREDICTO DEL DÍA (lo calcula el sistema según el TIEMPO EN OBJETIVO **y los pasos por debajo de 70**): día ${quality} (${tToday ?? "?"}% en objetivo hoy, desde las 8 h). ESE es el balance del día — EMPIEZA por esa palabra. NO escribas tú el porcentaje (el sistema añade la línea con cifras).`,
      `ESTABILIDAD (SOLO las oscilaciones): ${stability.word} (${stability.note}). Describe ÚNICAMENTE si la curva está calmada o agitada, NO si el día fue bueno. NUNCA digas "día estable" como balance del día: un día plano pero a menudo por encima del objetivo es un día DIFÍCIL — el tiempo en objetivo manda sobre la regularidad. SIMÉTRICAMENTE, e igual de importante: un día con pasos por debajo de 70 no es "bueno" ni "tranquilo", aunque la curva parezca calmada — una hipoglucemia larga y plana no genera ni variación rápida ni variabilidad alta, así que es INVISIBLE en la palabra de estabilidad. Si arriba existe la línea HIPOGLUCEMIAS, tu frase debe nombrarlas.`,
      `Evolución: ${evo}`,
      `COMPARACIÓN CON AYER: para decir si el día es mejor, peor o comparable a ayer, básate ÚNICAMENTE en el veredicto «Evolución» de arriba (compara el tiempo en objetivo). La palabra de ESTABILIDAD describe SOLO las oscilaciones de hoy: NUNCA escribas «más estable que ayer» ni «menos estable que ayer». Un día poco agitado pero a menudo por encima del objetivo es ESTABLE *y* PEOR que ayer — estabilidad (oscilaciones) y control (tiempo en objetivo) son cosas distintas. NO reescribas los porcentajes (de hoy ni de ayer): el sistema añade la comparación con cifras.`,
      swing,
      hint ? `SITUACIÓN (la calcula el sistema): ${hint}.` : "",
      decided,
      `ESTRUCTURA: rellena CADA campo con UNA frase corta (el sistema los pone en líneas separadas) — "day" = opinión CUALITATIVA del día (bueno/difícil y por qué: picos, bajadas) SIN cifras (% / media — el sistema añade la línea con cifras); "hour" = la última hora (la tendencia); "now" = los últimos 10 minutos (dónde estamos); "tip" = un punto concreto a mejorar, deducido de los datos. La acción con cifras y lo que se ha tenido en cuenta se añaden aparte; no los escribas tú.`,
      P(pr, "coach.rules", `REGLAS: habla del DÍA que acaba de pasar y enlázalo con los días previos. El objetivo es 70-180; lo más alto del día no es un techo aceptable — dilo como un pico OBSERVADO, a evitar los próximos días, no como una consigna para ahora. Tono directo, motivador, basado en cifras. Resalta los progresos REALES — pero nunca "resaltes" un progreso callando una hipoglucemia: señalar un paso por debajo de 70 va ANTES que el tono alentador. Sin falsas promesas de cura.`),
      `COMIDAS: la lista « Comidas de hoy » (arriba, con las horas) dice qué se ha COMIDO y cuándo — úsala para ligar las variaciones de glucosa a las comidas (un pico tras tal comida, etc.). NUNCA afirmes que no se registró ninguna comida si la lista contiene alguna.`,
      `VELOCIDAD DE LOS CARBOHIDRATOS: un azúcar rápido (zumo, refresco, dulces, pan blanco) sube la glucosa MUY RÁPIDO (pico ~15-45 min); los carbohidratos lentos (pasta, legumbres, integral) y las comidas grasas suben DESPACIO y TARDE (pico 2-3 h después). Tenlo en cuenta para EXPLICAR las variaciones y el momento de los picos, y para el TIMING del bolo (azúcar rápido → pre-bolo; lento/graso → más tarde o dividido).`,
      `AZÚCAR: para una hipo (<70), aconseja SOLO terrones de azúcar — nada de refrescos ni zumos (más fácil de dosificar, evita malos hábitos). Solo se toma azúcar por debajo de 70; si baja pero está en rango (70-180), di que tenga azúcar a mano y vigile, NO que lo tome ya. POR ENCIMA DE 180 (hiper), NO hables de azúcar — hace falta una corrección de insulina, no azúcar.`,
      sugarTimingFact(lang),
      `INSULINA ACTIVA: la línea «INSULINA AÚN ACTIVA (calculada por el sistema)» del contexto manda. Si dice «terminada», NUNCA digas que queda insulina activa ni que «está a punto de terminar»; si da una cifra, es la única válida. Nunca estimes tú lo que queda de una dosis.`,
      noNumbers,
      `UNIDADES: en "display", glucosa en mg/dL. En "voice", di la glucosa SIN UNIDAD — solo el número (« 78 », « 218 »), NUNCA digas « mg/dL ».`,
      `REDACCIÓN: escribe frases completas; cuando des una cifra, di SIEMPRE qué cuenta ("11 bajadas rápidas", nunca "11" a secas). Responde en español.`,
      `Responde SOLO en JSON. El campo "summary" es el ÚNICO texto que se muestra: UNA SOLA frase, recapitulativa, que diga a la vez cómo va el día Y dónde estamos ahora, con tu OPINIÓN (bien / a vigilar, y por qué). Sin porcentaje, sin media, sin comparación numérica — el sistema ya añade la línea con cifras. NO uses un campo "display". Glucosa en mg/dL, SIN ninguna cifra de dosis: {"summary":"<UNA frase: el día + dónde estamos + tu opinión>","tip":"<un consejo concreto a mejorar, se muestra solo si no hay nada que hacer>","voice":"<1-2 frases habladas, lo esencial>"}`,
    ].filter(Boolean).join(" ");
  }

  const day = s?.count_24h
    ? `Bilan d'AUJOURD'HUI (depuis 8 h) : moyenne ${aToday} mg/dL ; ${tToday}% du temps dans la cible 70-180 ; ${hiToday}% au-dessus de 180 et ${loToday}% en dessous de 70 ; ${s.rapid_drops_24h} chute(s) rapide(s) et ${s.rapid_rises_24h} montée(s) rapide(s) ; point le plus haut ${mxToday}, le plus bas ${mnToday} mg/dL.`
    : `Encore peu de données aujourd'hui.`;
  return [
    P(pr, "coach.persona", `Tu es Doctor Claude, un coach santé intelligent et direct pour une personne qui a un diabète de type 1. Pas de mièvrerie ni de surnoms : quelqu'un peut voir l'écran.`),
    ctx,
    signalLost
      ? (sensorExpired
        ? `CAPTEUR EXPIRÉ : les 14 jours du capteur sont atteints et aucune mesure depuis ${staleMin} min — la glycémie ACTUELLE est INCONNUE. Dernière connue : ${curMg}.`
        : `SIGNAL PERDU : aucune mesure depuis ${staleMin} min, la glycémie ACTUELLE est INCONNUE. Dernière glycémie connue : ${curMg} (il y a ${staleMin} min).`)
      : `Glycémie actuelle : ${curMg}.`,
    signalLost
      ? (sensorExpired
        ? `IMPORTANT — CAPTEUR EXPIRÉ : COMMENCE en disant clairement que le capteur a atteint ses 14 jours et qu'il faut en poser un NOUVEAU (compte ~1 h de démarrage après la pose). Parle de la DERNIÈRE glycémie connue (${curMg}), JAMAIS comme si c'était maintenant. Conseille un test au doigt en attendant. NE dis PAS « rapprocher le téléphone » ni « re-scanner » : un capteur fini ne revient pas.`
        : `IMPORTANT — SIGNAL PERDU : COMMENCE en disant clairement que le signal est perdu (aucune mesure depuis ${staleMin} min) et qu'on ne connaît PAS la glycémie actuelle. Parle de la DERNIÈRE glycémie connue (${curMg}) et de la tendance passée, mais ne dis JAMAIS « tu es à ${cur} » ni « ta glycémie est ${cur} » comme si c'était maintenant — dis « ta dernière glycémie connue était ${cur} ». Conseille D'ABORD de reconnecter le capteur (le téléphone qui le scanne doit être près de lui et connecté, re-scanner au besoin) ; un test au doigt SEULEMENT si le signal ne revient pas.`)
      : "",
    day,
    recent,
    hypoDayNote(s, lang),
    `VERDICT DE LA JOURNÉE (calculé par le système d'après le TEMPS DANS LA CIBLE **et les passages sous 70**) : journée ${quality} (${tToday ?? "?"}% dans la cible aujourd'hui, depuis 8 h). C'EST le bilan de la journée — COMMENCE par ce mot. Ne cite PAS le pourcentage toi-même (le système ajoute la ligne chiffrée).`,
    `STABILITÉ (les oscillations UNIQUEMENT) : ${stability.word} (${stability.note}). Ça décrit SEULEMENT si la courbe est calme ou agitée, PAS si la journée est bonne. NE dis JAMAIS « journée stable » comme bilan : une journée plate mais souvent au-dessus de la cible est une journée DIFFICILE — le temps dans la cible prime sur la régularité. SYMÉTRIQUEMENT, et c'est tout aussi important : une journée avec des passages sous 70 n'est ni « bonne » ni « tranquille », même si la courbe a l'air calme — une hypo longue et plate ne fait ni variation rapide ni variabilité élevée, elle est donc INVISIBLE dans le mot de stabilité. Si la ligne HYPOS ci-dessus existe, ta phrase doit les nommer.`,
    `Évolution : ${evo}`,
    `COMPARAISON À HIER : pour dire si la journée est meilleure, moins bonne ou comparable à hier, fie-toi UNIQUEMENT au verdict « Évolution » ci-dessus (il compare le temps dans la cible). Le mot de STABILITÉ ne décrit QUE les oscillations d'aujourd'hui : n'écris JAMAIS « plus stable qu'hier » ni « moins stable qu'hier ». Une journée peu agitée mais souvent au-dessus de la cible est STABLE *et* MOINS BONNE qu'hier — la stabilité (les oscillations) et le contrôle (le temps dans la cible) sont deux choses distinctes. Ne réécris PAS les pourcentages (d'aujourd'hui ou d'hier) : le système ajoute la comparaison chiffrée.`,
    swing,
    hint ? `SITUATION (calculée par le système) : ${hint}.` : "",
    decided,
    `LONGUEUR : le texte affiché fait AU TOTAL 4 phrases — la ligne chiffrée (ajoutée par le système), TA phrase de synthèse, la ligne « pris en compte » (système) et l'action (système). Ta part est donc UNE phrase. Sois dense, pas bavard.`,
    `STRUCTURE (rappel, le système compose l'affichage) : ANCIEN format à ne plus utiliser — UNE phrase courte (le système les met sur des lignes séparées) — "day" = avis QUALITATIF sur la journée (bonne/difficile et pourquoi : pics, chutes) SANS chiffre (% / moyenne — le système ajoute la ligne chiffrée d'aujourd'hui) ; "hour" = la dernière heure (la tendance) ; "now" = les 10 dernières minutes (où on en est) ; "tip" = un point concret à améliorer, déduit des données. L'action chiffrée et ce qui a été pris en compte sont ajoutés séparément ; ne les écris pas toi-même.`,
    // "un pic à corriger" removed from the default: it was the prompt itself pushing the model toward
    // the exact wording that then contradicted "rien à corriger". Same meaning, stated as an
    // observation about the day instead of an instruction for now.
    P(pr, "coach.rules", `RÈGLES : parle de la JOURNÉE écoulée et relie-la aux jours précédents. La cible est 70-180 ; le point le plus haut du jour n'est pas un plafond acceptable — dis-le comme un pic OBSERVÉ, à éviter les prochains jours, pas comme une consigne pour maintenant. Ton direct, motivant, basé sur les chiffres. Souligne les progrès RÉELS — mais ne « souligne » jamais un progrès en taisant une hypo : signaler un passage sous 70 passe AVANT le ton encourageant. Pas de fausse promesse de guérison.`),
    `REPAS : la liste « Repas d'aujourd'hui » (ci-dessus, avec les heures) dit ce qui a été MANGÉ et quand — sers-t'en pour relier les variations de glycémie aux repas (un pic après tel repas, etc.). N'affirme JAMAIS qu'aucun repas n'a été loggé si la liste en contient.`,
    `VITESSE DES GLUCIDES : un sucre rapide (jus, soda, bonbons, pain blanc) fait monter la glycémie TRÈS VITE (pic ~15-45 min) ; les glucides lents (pâtes, légumineuses, complet) et les repas gras la font monter LENTEMENT et TARD (pic 2-3 h après). Tiens-en compte pour EXPLIQUER les variations et le moment des pics, et pour le TIMING du bolus (sucre rapide → pré-bolus ; lent/gras → plus tard ou étalé).`,
    `SUCRE : pour une hypo (<70), conseille UNIQUEMENT des morceaux de sucre — pas de soda ni de jus (plus simple à doser, évite les mauvaises habitudes). On ne prend du sucre que sous 70 ; si ça descend mais reste dans la cible (70-180), dis de garder du sucre à portée et de surveiller, PAS d'en prendre tout de suite. Au-dessus de 180 (hyper), ne parle PAS de sucre — c'est une CORRECTION d'insuline qu'il faut, pas du sucre.`,
    sugarTimingFact(lang),
    `INSULINE ACTIVE : la ligne « INSULINE ENCORE ACTIVE (calculée par le système) » du contexte fait foi. Si elle dit « terminée », ne dis JAMAIS qu'il reste de l'insuline active ni qu'elle « se termine bientôt » ; si elle donne un chiffre, c'est le seul valable. N'estime jamais toi-même ce qui reste d'une dose.`,
    noNumbers,
    `UNITÉS : dans "display", glycémie en mg/dL. Dans "voice", dis la glycémie SANS UNITÉ — juste le nombre (« 78 », « 218 »), JAMAIS « mg/dL » ni « grammes par litre ».`,
    `RÉDACTION : écris des phrases complètes ; quand tu donnes un nombre, dis TOUJOURS ce qu'il compte (« 11 chutes rapides », jamais « 11 » tout seul). Réponds en français.`,
    `Réponds UNIQUEMENT en JSON. Le champ "summary" est le SEUL texte affiché : UNE SEULE phrase, récapitulative, qui dit à la fois comment va la journée ET où on en est maintenant, avec ton AVIS (bien / à surveiller, et pourquoi). Pas de pourcentage, pas de moyenne, pas de comparaison chiffrée — le système ajoute déjà la ligne chiffrée. N'utilise PAS de champ "display". Glycémie en mg/dL, AUCUN chiffre de dose : {"summary":"<UNE phrase : la journée + là où on en est + ton avis>","tip":"<un conseil concret à améliorer, affiché seulement s'il n'y a rien à faire>","voice":"<1-2 phrases parlées, l'essentiel>"}`,
  ].filter(Boolean).join(" ");
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ text: "Méthode non autorisée", isError: true }, 405);

  try {
    const body = await req.json().catch(() => ({}));
    const subject = (await accessSubject(req, db, String(body.subject ?? "") || null)) ?? "";
    if (!/^[a-f0-9]{64}$/.test(subject)) return json({ text: "subject invalide (hash attendu).", isError: true });
    const readings = Array.isArray(body.readings) ? body.readings : [];
    const speak = body.speak !== false;
    const lang = body.lang === "es" ? "es" : "fr";
    // An EXPLICIT "ANALYSE" tap sends force:true → bypass the 10-min cache and regenerate against
    // the CURRENT glucose/IOB (otherwise the user taps ANALYSE at 209 but gets the cached 162
    // report from minutes ago). Auto-greet / language-switch / silent prefetch omit it → cached.
    const force = body.force === true;
    // The client's UTC offset (minutes) so "today"/"yesterday" TIR are computed on the user's LOCAL
    // calendar days — matching the History screen's per-day bars (fixes "coach says yesterday 85%
    // while history shows 67%": that was a rolling 24-48h window, not the calendar day).
    const tzOffsetMin = Number.isFinite(Number(body.tzOffsetMin)) ? Math.round(Number(body.tzOffsetMin)) : 0;
    // BYOK: a client-supplied Gemini key routes the LLM to the user's free quota (cost ~0 to us).
    const byokGeminiKey = typeof body.geminiKey === "string" ? body.geminiKey.trim() : "";
    // ElevenLabs audio is generated unless the client explicitly opts into native TTS
    // (premiumVoice:false). Absent field => premium (keeps older installs' voice working).
    const premiumVoice = body.premiumVoice !== false;
    // Cost model: the server's own LLM key is used ONLY in Hosted mode. A free user must bring
    // their own Gemini key (BYOK). New clients always send `hosted`; older installs omit it and
    // are grandfathered (gate only fires on an explicit hosted:false).
    if (!byokGeminiKey && body.hosted === false) {
      return json({ text: lang === "es"
        ? "Para usar la IA: activa el modo Hosted o añade tu clave Gemini en Perfil."
        : "Pour utiliser l'IA : active le mode Hosted ou ajoute ta clé Gemini dans Profil.", isError: true });
    }
    if (!DEEPSEEK_API_KEY && !byokGeminiKey) {
      return json({ text: "Aucune clé IA : ajoute ta clé Gemini (BYOK) dans Profil, ou active le mode Hosted.", isError: true });
    }

    // Never store a FUTURE-dated reading, even if a buggy/cached client (e.g. a phone in the wrong
    // timezone) uploads one — that's what re-polluted the history. Drop anything ahead of now.
    const upsertNow = Date.now();
    const rows = readings
      .filter((r: any) => r && Number(r.value) > 0 && r.ts &&
        Number(r.ts) <= upsertNow + 120000 &&
        Number(r.ts) >= upsertNow - 31 * 24 * 3600 * 1000) // reject ancient / seconds-as-ms (1970) timestamps
      .map((r: any) => ({ subject, ts: new Date(Number(r.ts)).toISOString(), value_mgdl: Math.round(Number(r.value)) }));
    if (rows.length) {
      await db.from("mechabetics_readings").upsert(rows, { onConflict: "subject,ts", ignoreDuplicates: true });
    }

    // Stats FIRST, so even a cached analysis returns the 24h numbers for the dashboard boxes
    // (otherwise the boxes show "…" forever whenever the analysis is served from cache).
    const { data: stats } = await db.rpc("mechabetics_stats", { p_subject: subject, p_tz_offset_min: tzOffsetMin });

    // 10-min cache: reuse the last analysis unless a newer meal exists OR the profile was edited
    // since (so clearing the nickname / changing ratios reflects right away, not after 10 min).
    const { data: prof0 } = await db.from("mechabetics_profiles").select("updated_at").eq("subject", subject).maybeSingle();
    const profUpdatedMs = (prof0 as any)?.updated_at ? new Date((prof0 as any).updated_at).getTime() : 0;
    const { data: lastLog } = await db.from("mechabetics_coach_log")
      .select("message, ts, lang").eq("subject", subject)
      .order("ts", { ascending: false }).limit(1).maybeSingle();
    if (!force && lastLog?.message && lastLog.lang === lang) {
      const logMs = new Date(lastLog.ts).getTime();
      const ageMs = Date.now() - logMs;
      // A NEW LOW SINCE THE CACHED TEXT WAS WRITTEN INVALIDATES IT, always. The cache only ever
      // watched for a newer meal or a profile edit — so glucose could fall from 140 to 58 and the
      // dashboard would keep replaying a ten-minute-old "tout va bien", ACTION LINE INCLUDED, on
      // every automatic refresh. Only an explicit tap on ANALYSE forced a recompute, which is the one
      // moment a parent is least likely to be looking. A rapid drop counts too: the analysis it was
      // built on no longer describes what is happening.
      const sinceCache = (readings as any[])
        .map((r) => ({ ts: Number(r?.ts), value: Number(r?.value) }))
        .filter((r) => Number.isFinite(r.ts) && r.value > 0 && r.ts > logMs)
        .sort((a, b) => a.ts - b.ts);
      const wentLow = sinceCache.some((r) => r.value < LOW_MGDL);
      const droppedFast = sinceCache.length >= 2 &&
        (Math.max(...sinceCache.map((r) => r.value)) - sinceCache[sinceCache.length - 1].value) >= 40;
      if (ageMs < 10 * 60 * 1000 && logMs >= profUpdatedMs && !wentLow && !droppedFast) {
        const { data: newerMeal } = await db.from("mechabetics_meals")
          .select("id").eq("subject", subject).gt("created_at", lastLog.ts).limit(1).maybeSingle();
        if (!newerMeal) {
          // Normalize an OLD cached report too, so its paragraphs blank-line on screen like fresh ones.
          const cachedText = lastLog.message.replace(/\s*\|\|\s*/g, "\n\n").replace(/\n+/g, "\n\n").trim();
          return json({ text: cachedText, audioBase64: null, mime: "audio/mpeg", isError: false, cached: true, stats });
        }
      }
    }

    const { data: profile } = await db
      .from("mechabetics_profiles")
      .select("nickname, age, weight_kg, diagnosis_date, honeymoon, carb_ratio, correction_factor, target_mgdl, rapid_insulin, basal_insulin")
      .eq("subject", subject)
      .maybeSingle();
    // The bilan covers the WHOLE day, so pull the last ~26 h of meals (not just the 3 latest).
    // Before, `limit 3` newest-first let 3 just-scanned PLANNED products crowd out every real
    // eaten meal, so the analysis reported "no meals logged" while the user had logged the day's
    // meals. A full-day window lets the model — and the accounting line — actually see them.
    const { data: meals } = await db
      .from("mechabetics_meals")
      .select("ts, description, carbs_g, planned")
      .eq("subject", subject)
      .gte("ts", new Date(Date.now() - 26 * 3600 * 1000).toISOString())
      .order("ts", { ascending: false })
      .limit(24);
    const { data: insulin } = await db
      .from("mechabetics_insulin")
      .select("ts, units, insulin_name, kind")
      .eq("subject", subject)
      .gte("ts", new Date(Date.now() - 6 * 3600 * 1000).toISOString())
      .order("ts", { ascending: false })
      .limit(6);
    const { data: activity } = await db
      .from("mechabetics_activity")
      .select("ts, kind, description, intensity, planned")
      .eq("subject", subject)
      .gte("ts", new Date(Date.now() - 6 * 3600 * 1000).toISOString())
      .order("ts", { ascending: false })
      .limit(4);
    const nowMs = Date.now();
    // IOB FIRST: the insulin context line hands the model the SYSTEM-computed active insulin, so it
    // never estimates a dose's decay itself (it used to write "presque terminée" off the raw dose
    // list while the computed IOB — and the Insuline tab — said 0).
    const gp = toGuardProfile(profile);
    const rapidDur = insulinActionMinutes(gp?.rapidInsulin) ?? 240; // insulin-type-aware decay
    const iob = activeIob(insulin ?? [], nowMs, rapidDur);
    const insCtx = insulinContext(insulin ?? [], iob, rapidDur, nowMs, lang);
    const actCtx = activityContext(activity ?? [], lang);
    const ctx = profileContext(profile, meals ?? [], lang, nowMs)
      + (insCtx ? " " + insCtx : "")
      + (actCtx ? " " + actCtx : "");
    // THE TREND READS THE DATABASE, NOT JUST THIS PHONE'S PAYLOAD.
    //
    // `readings` is whatever the phone happened to be holding. The phone only polls the patient
    // currently ON SCREEN, so a followed patient's series is stitched from sparse cloud buckets with
    // real holes in it — 49, 56 and 75-minute gaps were measured on a live device. A hole straddling
    // the trend window makes trendFromReadings answer "unknown", and "unknown" above 180 BLOCKS the
    // correction: a child sat at 234 mg/dL and was told "aucune insuline" because of a gap, not
    // because of their glucose.
    //
    // Meanwhile the 24/7 monitor has been writing every patient's readings to this very table all
    // along. The history exists; it simply was not being read back. Merging it in costs one indexed
    // query and closes the holes for the non-active patient — which is exactly who was being hurt.
    // Union, dedupe per timestamp, phone value wins (it is the freshest source for the live point).
    const histSinceIso = new Date(nowMs - TREND_HISTORY_HOURS * 3600 * 1000).toISOString();
    // NEWEST FIRST + AN EXPLICIT LIMIT, and it matters enormously. PostgREST caps a response at a
    // server-side default (commonly 1000 rows) whether or not you ask for a limit — and 24 h of
    // once-a-minute readings is ~1440. Ordered ASCENDING, the cap would have silently returned the
    // OLDEST 1000 and dropped everything recent, so `last` — the value the whole analysis calls
    // "glycémie actuelle" and the guard doses against — would have been hours stale. Descending makes
    // any truncation fall on the far end of history, where it costs nothing. Re-sorted below anyway.
    const { data: storedReadings } = await db.from("mechabetics_readings")
      .select("ts, value_mgdl").eq("subject", subject)
      .gte("ts", histSinceIso).order("ts", { ascending: false }).limit(2000);
    const byTs = new Map<number, number>();
    for (const r of (storedReadings ?? []) as any[]) {
      const t = new Date(r.ts).getTime();
      const v = Number(r.value_mgdl);
      if (Number.isFinite(t) && v > 0) byTs.set(t, v);
    }
    for (const r of readings as any[]) {
      const t = Number(r?.ts);
      const v = Number(r?.value);
      if (Number.isFinite(t) && v > 0) byTs.set(t, v); // phone wins on a tie
    }
    const sorted = [...byTs.entries()]
      .map(([ts, value]) => ({ ts, value }))
      .sort((a, b) => a.ts - b.ts);
    const last = sorted[sorted.length - 1];
    // Current glucose = the LATEST READING only. It used to fall back to the 24 h average, so a
    // call with no readings made the report assert "Glycémie actuelle : 152" — an average is not a
    // measurement. Null lets the guard take its no_reading path and the prompt say "inconnue".
    const cur = last ? Math.round(last.value) : null;
    const lastTs = last ? last.ts : 0;
    const staleMin = lastTs ? Math.round((nowMs - lastTs) / 60000) : 999;
    // Match the client's NO SIGNAL window (GlucoseAlert.FRESHNESS_WINDOW_MS = 5 min): once the last
    // reading is older than that, the LIVE value is UNKNOWN. The analysis/voice must SAY "signal
    // perdu" and speak of the LAST KNOWN glucose — never assert "tu es à X" as if it were current.
    const signalLost = lastTs > 0 && (nowMs - lastTs) > STALE_MIN * 60000;
    // The CLIENT knows the sensor's expiry (LibreLinkUp activation + 14 d). When it flags it AND the
    // signal is indeed gone, the lost signal has a known cause: a finished sensor → advise a NEW one
    // (not "move the phone closer / re-scan", which can't revive it).
    const sensorExpired = body.sensorExpired === true && signalLost;

    // ----- CODE OWNS THE DOSE ----- (gp / iob computed above, before the insulin context)
    const trend = lastTs ? trendFromReadings(sorted, nowMs) : "unknown";
    const recentHypo = recentHypoFrom(sorted, nowMs);
    // recentHypo was DEAD WEIGHT: computed here, handed to computeGuard, and never read by it (the
    // post-hypo correction block was deliberately removed, but the parameter stayed wired to
    // nothing). So a low forty minutes ago reached neither the dose nor a single word of the text.
    // It cannot go back into the dose — correcting a genuine high after a low is the intended
    // behaviour — but the narrative must know: coming up from a hypo is the whole context of the
    // hour that follows, and it explains a rebound the model would otherwise read as a random spike.
    const recentHypoNote = recentHypo
      ? (lang === "es"
        ? `HIPOGLUCEMIA RECIENTE (calculado por el sistema): hubo un valor por debajo de 70 en los últimos 75 minutos. Tenlo en cuenta al explicar lo que pasa ahora (un rebote después de un resucarado es esperable) y menciónalo.`
        : `HYPO RÉCENTE (calculé par le système) : il y a eu une valeur sous 70 dans les 75 dernières minutes. Prends-le en compte pour expliquer ce qui se passe maintenant (un rebond après un resucrage est attendu) et mentionne-le.`)
      : "";
    const minSinceRescue = minutesSinceLastRescue(meals ?? [], nowMs);
    const guard = computeGuard({ glucoseMgdl: cur, trend, staleMin, iobUnits: iob, recentHypo, minSinceRescue, profile: gp });
    const hint = situationHint(guard, lang);

    // Proactive prediction + unlogged-meal heads-up (both SUGGESTION-grade, no dose number).
    const predict = predictiveAdvice(sorted, nowMs);
    const lastMealTs = (meals && meals.length && (meals[0] as any).ts) ? new Date((meals[0] as any).ts).getTime() : 0;
    const risingNow = trend === "rising" || trend === "rising_fast";
    // An overnight rise is almost always the DAWN PHENOMENON (hormonal), not an unlogged meal — so
    // don't nag "log your meal" at night (it read as wrong: a McDo logged 8 h earlier is long gone).
    const localHour = ((Math.floor((nowMs + tzOffsetMin * 60000) / 3600000) % 24) + 24) % 24;
    const isNight = localHour < 7 || localHour >= 23;
    // > 3 h since the last logged meal (was 90 min): a meal keeps glucose rising for ~2–3 h, so a
    // shorter window made the coach suggest "log your meal" long after breakfast WAS logged. Mirrors
    // the client's live banner gate (MainActivity: mealLoggedRecently ≤ 180 min).
    const mealNudge = !isNight && risingNow && cur != null && cur > 140 && (nowMs - lastMealTs > 180 * 60 * 1000);
    const mealNudgeNote = mealNudge
      ? (lang === "es"
        ? "INDICIO: la glucosa sube sin comida registrada; sugiere amablemente registrar lo que ha comido (no inventes ninguna dosis)."
        : "INDICE : la glycémie monte sans repas loggé ; suggère gentiment de logger ce qui a été mangé (n'invente aucune dose).")
      : "";

    const swing = swingNote(readings, lang);
    const recent = signalLost ? "" : recentWindowNote(sorted, nowMs, lang); // a stale "now: X rising" reads as live — drop it
    // CODE owns the stability verdict (variability + rapid swings) so the model can't call a
    // 21-swing day "stable". Fed authoritatively to the prompt + reused in the fallback summary.
    const cv = variabilityCv(sorted);
    const stability = dayStability(stats, cv, lang);
    // Red-flag a meal that spiked the glucose (esp. a fatty one → delayed rise, split-bolus advice).
    const spikeNote = mealSpikeNote(meals ?? [], sorted, nowMs, lang);
    // DECIDE THE ACTION BEFORE WRITING THE ANALYSIS. It used to be computed after the model had
    // already written its bilan, so the model was describing the day with no idea what the app was
    // about to tell the user to do — and the two collided: "bonne journée mais une chute rapide à
    // corriger" printed directly above "Action : dans la cible, rien à corriger". Everything this
    // needs is deterministic and available here, so the decision now leads and the prose follows it.
    // What the NARRATIVE is allowed to name, in units. The guard's own ceiling covers the CORRECTION
    // only, so it cannot be used raw: on a day with a meal to bolus, a perfectly correct "12 u for
    // the meal" in the prose would read as an overshoot against a 2 u correction ceiling. Raised to
    // the real total as soon as a meal plan is computed, just below.
    let proseDoseCeiling = guard.maxInsulinUnits;
    const actionLine = signalLost
      ? (sensorExpired
        ? (lang === "es"
          ? "Sensor caducado: pon un sensor NUEVO lo antes posible (cuenta ~1 h de arranque); mientras tanto, decide solo con una punción capilar."
          : "Capteur expiré : pose un NOUVEAU capteur dès que possible (compte ~1 h de démarrage) ; en attendant, décide uniquement avec un test au doigt.")
        : (lang === "es"
          ? "Señal perdida: reconecta el sensor (acerca el teléfono que lo escanea, vuelve a escanear); si no vuelve, hazte una punción capilar antes de cualquier decisión."
          : "Signal perdu : reconnecte le capteur (rapproche le téléphone qui le scanne, re-scanne) ; s'il ne revient pas, fais un test au doigt avant toute décision."))
      : (() => {
        // WHICH meal to dose, and when — the ANALYSE button used to pass a hardcoded 0 here, so it
        // could never name a dose for food: 120 g logged and unbolused at 175 mg/dL came back as
        // "in range, nothing to correct".
        const plan = mealBolusPlan(meals ?? [], insulin ?? [], nowMs, gp);
        proseDoseCeiling = guard.maxInsulinUnits + Math.max(0, plan.units || 0);
        if (plan.planned && plan.carbsG != null) {
          return mealPlanLine(planMealDose({
            glucoseMgdl: cur, trend, staleMin, iobUnits: iob,
            carbsG: plan.carbsG, description: null,
            minSinceRescue, recentHypo, profile: gp,
          }), lang, gp, true); // concise: the ANALYSE card is a summary + ONE action line
        }
        if (guard.reason === "in_range" && plan.units <= 0) {
          return inRangeActionLine(meals ?? [], insulin ?? [], sorted, nowMs, gp, lang);
        }
        return combinedActionLine(guard, plan.units, lang, gp, plan.planned);
      })();
    const pr = await loadPrompts(lang);
    const prompt = buildPrompt(
      cur, stats, lang,
      ctx + (mealNudgeNote ? " " + mealNudgeNote : "") + (spikeNote ? " " + spikeNote : "")
        + (recentHypoNote ? " " + recentHypoNote : ""),
      swing, pr, hint, recent, stability, signalLost, staleMin, sensorExpired,
      actionLine, noDoseDue(guard),
    );
    let raw = "";
    try {
      raw = await chatJson(
        { user: prompt, temperature: 0.3 },
        { byokGeminiKey, deepseekKey: DEEPSEEK_API_KEY, deepseekModel: DEEPSEEK_MODEL, geminiModel: GEMINI_TEXT_MODEL },
      );
    } catch (e) {
      // AI down (or out of credits / rate-limited / bad key): say WHICH, and still return the
      // code-owned safe action (the guard never needed the model) + the 24h stats so the dashboard
      // boxes stay populated. Coach used to drop both and show only a raw error string.
      const kind = llmErrorKind(e);
      const head = llmErrorMessage(kind, lang, !!byokGeminiKey);
      const showAction = !(guard.reason === "in_range" || guard.reason === "no_reading");
      const out = showAction
        ? `${head}\n\n${lang === "es" ? "Acción" : "Action"} : ${combinedActionLine(guard, 0, lang, gp)}`
        : head;
      return json({ text: out, isError: true, errorKind: kind, stats });
    }
    let parsed: any = {};
    let parseOk = false;
    try { parsed = JSON.parse(raw); parseOk = true; } catch { parsed = {}; }
    // CODE owns the paragraph layout: the model returns the bilan as SEPARATE fields and we join them
    // with a blank line. This GUARANTEES the 24h / last-hour / now / conclusion parts are visually
    // separated — asking the model to emit \n (or a "||" separator) proved unreliable, it ran them
    // into one block. extractStr salvages each field even from truncated/malformed JSON.
    const field = (k: string): string => {
      const v = parsed?.[k];
      if (typeof v === "string" && v.trim()) return v.trim();
      return extractStr(raw, k)?.trim() ?? "";
    };
    // TWO sentences of narrative, then the numbers line, then ONE action — the analysis card is a
    // SUMMARY. Four separate sentences (day / hour / now / tip) plus the stats line, the accounting
    // line and the action produced a wall of text nobody reads to the end, which is exactly what the
    // action at the bottom needs people to read. "hour" is dropped (it repeats "now" with a wider
    // window) and "tip" is kept only when there is no action to give, so the card never ends on two
    // competing instructions.
    const tip = field("tip");
    // ONE narrative sentence. With the code-owned stats line, the "pris en compte" line and the
    // action, the card totals four — which is what makes it readable to the end.
    let display = field("summary");
    if (!display) display = [field("day"), field("now")].filter(Boolean).join(" "); // older/cached shapes
    if (!display) {
      // Legacy single "display" field, else a complete deterministic summary (never a half-sentence).
      const legacy = field("display");
      display = (legacy && !(!parseOk && looksTruncated(legacy))) ? legacy : statsSummary(stats, lang, stability);
    }
    // The model reliably writes ONE flowing block no matter how we ask for separate fields, so we
    // GUARANTEE readability in code: split into sentences and put each on its own paragraph (blank
    // line between). This is what finally aerates the 24h / hour / now / conclusion lines on screen.
    display = display
      .split(/(?<=[.!?…])\s+(?=[A-ZÀ-ÖØ-Þ¿¡])/)
      .map((s) => s.trim())
      .filter(Boolean)
      .join("\n\n");
    // CODE-OWNED day figures LEAD the analysis (today's % / average / vs-yesterday, all 8 h→8 h) so the
    // numbers always match the History screen's per-day boxes and "hier" can never be read as today —
    // the LLM no longer writes them. Skipped during signal loss (the lost-signal warning must lead).
    const dsl = signalLost ? "" : dayStatsLine(stats, lang);
    if (dsl) display = `${dsl}\n\n${display}`;
    const voiceRaw = (typeof parsed.voice === "string" && parsed.voice.trim()) ? parsed.voice.trim() : extractStr(raw, "voice");
    let voice: string = (voiceRaw && !(!parseOk && looksTruncated(voiceRaw))) ? voiceRaw : display.replace(/\n+/g, " ");

    // The model must not state a dose; if insulin is forbidden, strip any it sneaked in, then
    // append the code-computed authoritative action (only when a dose is actually relevant).
    const insulinForbidden = guard.maxInsulinUnits === 0;
    if (insulinForbidden) { display = stripInsulinNumbers(display) || display; voice = stripInsulinNumbers(voice) || voice; }
    // ...and when insulin IS allowed, the narrative may still not name a BIGGER dose than the system
    // decided. Until now nothing checked that: the strip above only covered the forbidden case.
    else {
      const ceiling = { ...guard, maxInsulinUnits: proseDoseCeiling };
      display = enforceInsulinCeiling(display, ceiling) || display;
      voice = enforceInsulinCeiling(voice, ceiling) || voice;
    }

    // Last line of defence on the contradiction: the prompt tells the model the decision and reserves
    // "corriger" for the system, but a model will still slip. When nothing is due, the narrative may
    // not say anything is "to correct" — the observation stays, as something to WATCH. Deliberately
    // here, BEFORE the action line is appended below, or it would rewrite the action's own
    // "rien à corriger" into nonsense.
    if (noDoseDue(guard) && !signalLost) {
      display = softenCorrectionTalk(display, lang);
      voice = softenCorrectionTalk(voice, lang);
    }

    // Transparency: ALWAYS state what was accounted for (insulin on board + last meal) so the action
    // below is trustworthy — e.g. "no insulin now" reads as a decision (a dose is already working),
    // not an oversight — and the user knows to log a dose/meal when the system says none is recorded.
    const acct = accountingLine(insulin ?? [], meals ?? [], iob, nowMs, lang);
    if (acct) display = `${display}\n\n${acct}`;

    // The analysis ALWAYS ends with a concrete action now — a blank "Action" on the (frequent) in-range
    // readings read as "the coach stopped giving advice". Only a TOTAL no-reading has nothing to say.
    // In range we give a contextual, dose-free step (cover a just-logged meal / watch a drift / "in
    // range, keep monitoring"); otherwise the code-owned dose action (sugar / correction / wait).
    const showAction = signalLost || guard.reason !== "no_reading";
    if (showAction) {
      // The SAME string the model was shown above (signal loss included — never append a dose off a
      // value we don't trust). Computed once, so what the analysis was told and what the user reads
      // cannot drift apart.
      const label = lang === "es" ? "Acción" : "Action";
      display = `${display}\n\n${label} : ${actionLine}`;
    } else if (tip) {
      // Nothing to act on: the improvement tip becomes the closing line instead of a blank ending.
      display = `${display}\n\n${tip}`;
      voice = `${voice} ${actionLine}`.trim();
    }

    // A hypo while rapid insulin is STILL on board keeps falling — one rescue often won't hold (the
    // real 6.5 u Fiasp case: an hour under 70 despite 3 sucres twice). Append a code-owned warning so
    // the parent expects to re-treat + rechecks sooner. The rescue grams above are already bumped for
    // IOB by the guard; this explains why and says to keep watching.
    if (guard.kind === "sugar" && !signalLost) {
      const warn = hypoIobWarning(iob, lang);
      if (warn) { display = `${display}\n\n${warn}`; voice = `${voice} ${warn.replace("⚠️", "").trim()}`.trim(); }
    }

    // A high being CORRECTED while a recent meal was logged but never bolused: its carbs (esp. slow/
    // fatty) are still digesting, so a correction alone dips then rebounds / plateaus ABOVE target —
    // the potato-dinner case (why it sat at ~175 with a 120 target). Explain it + say to recheck later.
    if (guard.kind === "correction" && !signalLost) {
      const warn = uncoveredMealWarning(meals ?? [], insulin ?? [], nowMs, gp, lang);
      if (warn) { display = `${display}\n\n${warn}`; voice = `${voice} ${warn.replace("⚠️", "").trim()}`.trim(); }
    }

    // An ANNOUNCED (planned, not-yet-eaten) meal logged in the last ~3 h: remind that it will need
    // its bolus AT EATING TIME and whether a recent dose is on record — mirrors ask's
    // plannedMealNote so "je vais manger un McDo" carries into the next ANALYSE too. Skipped during
    // a hypo (sugar first) and on a lost signal (the lost-signal action must stand alone).
    if (guard.kind !== "sugar" && !signalLost) {
      const upcoming = (meals ?? []).find((m: any) => {
        if (!m || m.planned !== true || !m.ts) return false;
        const t = new Date(m.ts).getTime();
        return Number.isFinite(t) && t >= nowMs - 3 * 3600 * 1000; // announced recently, or future-dated
      });
      if (upcoming) {
        const recentRapid = (insulin ?? []).some((d: any) => {
          if (!d || d.kind === "basal") return false;
          const t = new Date(d.ts).getTime();
          return Number.isFinite(t) && t <= nowMs + 60000 && nowMs - t <= 45 * 60000;
        });
        const note = plannedMealNote(Number((upcoming as any).carbs_g) || null, recentRapid, lang);
        display = `${display}\n\n${note}`;
        voice = `${voice} ${note}`.trim();
      }
    }

    // The spoken voice must never read the unit aloud ("128", not "128 milligrammes par décilitre").
    // Display keeps mg/dL; only the voice is stripped (also covers the voice=display fallback above).
    voice = voice.replace(/\s*mg\s*\/\s*d[lL]/gi, "");

    // NO "Anticipation" line in the report: the dashboard's live ANTICIPATION banner already shows
    // it, and appending it here duplicated it with slightly different numbers (the user saw "41 in
    // 5 min" in one place and "46 in 8 min" in the other). One source only — the banner.

    let audioBase64: string | null = null;
    if (speak && premiumVoice && ELEVENLABS_API_KEY) {
      try {
        const tRes = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`, {
          method: "POST",
          headers: { "xi-api-key": ELEVENLABS_API_KEY, "content-type": "application/json" },
          body: JSON.stringify({ text: voice, model_id: "eleven_multilingual_v2" }),
        });
        if (tRes.ok) audioBase64 = toBase64(new Uint8Array(await tRes.arrayBuffer()));
      } catch (_) { /* voice optional */ }
    }

    await db.from("mechabetics_coach_log").insert({ subject, message: display, glucose_at_time: cur, lang });

    return json({ text: display, voice, audioBase64, mime: "audio/mpeg", isError: false, stats, mealNudge, predict });
  } catch (e) {
    return json({ text: `Erreur serveur: ${(e as Error)?.message ?? e}`, isError: true });
  }
});
