import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { accessSubject } from "../_shared/access.ts";
import {
  LOW_MGDL,
  SEVERE_LOW_MGDL,
  trendFromReadings,
  iobStatusPhrase,
  iobSystemLine,
  stripInsulinNumbers,
  enforceInsulinCeiling,
  softenCorrectionTalk,
  mealCarbSpeed,
  sugarTimingFact,
  carbsOnBoard,
  insulinActionMinutes,
  temperatureContext,
  currentActivity,
  speakable,
} from "../_shared/doseGuard.ts";
import {
  decisionHint,
  anticipate,
  buildState,
  decideAction,
  decisionPayload,
  engineFacts,
  forecastLine,
  sideNotes,
  timedSeries,
} from "../_shared/decide.ts";
import {
  loadEngineData,
  refreshModelIfStale,
  dosePutForward,
  rememberNamedDose,
  storePhoneReadings,
  tzOffsetOf,
} from "../_shared/engineData.ts";
import { chatJsonWithin, llmErrorKind, llmErrorMessage } from "../_shared/llm.ts";
import { isBasalInsulin } from "../_shared/insulins.ts";

// The app waits 80 s for an analysis. Measured 68 s on 2026-08-05 — one slow afternoon away from
// « Service injoignable ». Past this the model is dropped and the code-owned action stands alone.
const COACH_LLM_MS = 45_000;
import { currentWeather } from "../_shared/weather.ts";

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

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

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

/** "il y a 3 min" / "il y a 2 h" — a human relative time so the model (and the accounting line)
 *  can tie a meal to a glucose move. */
function agoLabel(mins: number, lang: string): string {
  const es = lang === "es";
  if (mins < 1) return es ? "ahora" : "à l'instant";
  if (mins < 60) return es ? `hace ${mins} min` : `il y a ${mins} min`;
  // To the minute: "il y a 3 h" for a dose given 2 h 31 ago reads as finished when a third of it
  // still has to act, and this figure is what a parent checks the arithmetic against.
  const h = Math.floor(mins / 60);
  const m = String(mins % 60).padStart(2, "0");
  return es ? `hace ${h} h ${m}` : `il y a ${h} h ${m}`;
}

function profileContext(p: any, meals: any[], lang: string, nowMs: number): string {
  // No name here, on purpose: the history is pseudonymous and the model does not need it.
  const bits: string[] = [];
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
function insulinContext(doses: any[], iob: number, nowMs: number, lang: string): string {
  const rapid = (doses || []).filter((d: any) => d.kind !== "basal" && !isBasalInsulin(d.insulin_name));
  if (!rapid.length) return "";
  const es = lang === "es";
  const parts = rapid.map((d: any) => {
    const mins = Math.round((nowMs - new Date(d.ts).getTime()) / 60000);
    const what = `${d.units} u${d.insulin_name ? ` ${d.insulin_name}` : ""}`;
    if (mins < -1) return es ? `${what} PREVISTA en ${-mins} min (aún no activa)` : `${what} PRÉVUE dans ${-mins} min (pas encore active)`;
    const done = mins >= (insulinActionMinutes(d.insulin_name) ?? 300);
    const state = done ? (es ? "ya terminó de actuar" : "a fini d'agir") : (es ? "sigue actuando" : "agit encore");
    return `${what} ${agoLabel(Math.max(0, mins), lang)} (${state})`;
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
  const rapid = (insulin || []).filter((d: any) => d.kind !== "basal" && !isBasalInsulin(d.insulin_name));
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
    insPart = es ? "ninguna insulina anotada (no se sabe si se ha puesto)" : "aucune insuline notée (on ne sait pas si elle a été faite)";
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
    // The carbs still digesting, next to the insulin still active — the two halves of the balance the
    // action line is decided on. Reported: an analysis that named "≈ 4 u encore active" and the meal
    // eaten 16 min earlier, then announced a coming hypo, gave the reader nothing to weigh it
    // against. Whichever way the verdict goes, both numbers behind it are now on screen.
    const cob = Math.round(carbsOnBoard(meals ?? [], nowMs));
    const cobPart = cob > 0
      ? (es ? ` · ~${cob} g de carbohidratos aún digiriéndose` : ` · ~${cob} g de glucides encore en digestion`)
      : "";
    mealPart = (es
      ? `${dayMeals.length} comida(s) registrada(s) hoy (última « ${m.desc} » ${ago})`
      : `${dayMeals.length} repas loggé(s) aujourd'hui (dernier « ${m.desc} » ${ago})`) + cobPart;
  } else {
    mealPart = es ? "ninguna comida registrada" : "aucun repas loggé";
  }
  return es
    ? `Tenido en cuenta : ${insPart} · ${mealPart}.`
    : `Pris en compte : ${insPart} · ${mealPart}.`;
}

// Recent physical activity -> context (sport lowers glucose; the coach should factor it in).
// What the MODEL is told about sport. Rewritten off `currentActivity` so it can no longer disagree
// with the arithmetic sitting next to it. The first version read the raw rows and had two faults:
// a FUTURE session came out as "il y a -40 min" (the subtraction was never guarded), and a row still
// flagged `planned` printed a bare "prévu" with no time however long ago it had actually happened.
// It also never mentioned the intensity, and — worse — never said the dose had ALREADY been reduced,
// so the narrative was free to recommend trimming it a second time.
function activityContext(acts: any[], nowMs: number, cut: number, lang: string): string {
  const a = currentActivity(acts ?? [], nowMs);
  if (!a) return "";
  const es = lang === "es";
  const what = a.label || (es ? "actividad" : "activité");
  const intensity = a.intensity === "high"
    ? (es ? "intensa" : "intense")
    : a.intensity === "moderate" ? (es ? "media" : "moyenne") : (es ? "suave" : "douce");
  const when = a.phase === "soon"
    ? (es ? `empieza en ~${a.minutesAway} min` : `commence dans ~${a.minutesAway} min`)
    : a.phase === "during"
      ? (es ? "en curso" : "en cours")
      : a.phase === "recent"
        ? (es ? `terminó hace ~${a.minutesAway} min` : `terminé il y a ~${a.minutesAway} min`)
        : (es ? `hoy, efecto residual` : `aujourd'hui, effet résiduel`);
  const pct = Math.round((Number(cut) || 0) * 100);
  const already = pct > 0
    ? (es
      ? ` El sistema YA ha reducido la dosis un ${pct} % por esto — NO propongas reducirla otra vez ni des otra cifra.`
      : ` Le système A DÉJÀ réduit la dose de ${pct} % pour ça — ne propose PAS de la réduire encore, ne donne aucun autre chiffre.`)
    : "";
  return es
    ? `ACTIVIDAD FÍSICA: ${what} (${intensity}, ${when}, ${a.durationMin} min) — el ejercicio BAJA la glucosa durante y hasta ~12 h después.${already}`
    : `ACTIVITÉ PHYSIQUE : ${what} (${intensity}, ${when}, ${a.durationMin} min) — le sport FAIT BAISSER la glycémie pendant et jusqu'à ~12 h après.${already}`;
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
  // Six hours, not twenty-four: one swing from the morning used to headline every analysis until the
  // next morning, whatever the glucose had done since.
  const day = [...bucket.values()].filter((p) => p.t >= nowMs - 6 * 3600 * 1000).sort((a, b) => a.t - b.t);
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
      if (mag / mins > 6) continue; // no body moves this fast: a sensor artefact, not a swing
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
      ? `OSCILACIÓN BRUSCA: la glucosa pasó de ${danger.from} a ${danger.to} mg/dL en ${danger.min} min. Si lo anotado la explica, dilo en una frase; si no, di que no se sabe por qué.`
      : `SWING BRUTAL : la glycémie est passée de ${danger.from} à ${danger.to} mg/dL en ${danger.min} min. Si ce qui est noté l'explique, dis-le en une phrase ; sinon dis qu'on ne sait pas pourquoi.`;
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

// A calendar "day" restarts at 08:00 (see mechabetics_stats). Right after that boundary "today so
// far" is a handful of points, and a % over it flatly contradicts the 24 h curve the user is looking
// at — that was the 02:19 "12 % dans la cible" that was really a ~2 h sliver of a rising spike. Below
// this many 5-min points (~3 h of feed) we describe the ROLLING 24 h instead, and label it as such.
const DAY_MIN_POINTS = 36;
function dayIsYoung(s: any): boolean {
  const n = Number(s?.count_today_cal);
  return Number.isFinite(n) && n < DAY_MIN_POINTS;
}

/** The day-headline figures, resolved ONCE so every line (stats line, verdict, evolution, prompt)
 *  agrees. Normally the 08:00→08:00 calendar day (tir_today_cal…, falling back to the rolling 24 h
 *  for token-less / older clients). But when the day only just restarted (dayIsYoung) the calendar
 *  window is too thin to summarise, so we return the rolling 24 h and flag `rolling` — the label then
 *  says "dernières 24 h" and the "vs hier" comparison is dropped (a rolling window has no yesterday).
 *  Reading every figure through here is what stops a min from one window sitting next to a %-low from
 *  another ("plus bas 169 mg/dL" beside "3 % sous 70"). */
function todayView(s: any): {
  tir: number | null; avg: number | null; pctLow: number | null; min: number | null;
  pctHigh: number | null; max: number | null; tPrev: number | null; rolling: boolean;
} {
  const n = (v: any) => (v == null ? null : Number(v));
  if (dayIsYoung(s)) {
    return {
      tir: n(s?.tir_24h), avg: n(s?.avg_24h), pctLow: n(s?.pct_low_24h),
      min: n(s?.min_24h), pctHigh: n(s?.pct_high_24h), max: n(s?.max_24h),
      tPrev: null, rolling: true,
    };
  }
  return {
    tir: n(s?.tir_today_cal ?? s?.tir_24h), avg: n(s?.avg_today_cal ?? s?.avg_24h),
    pctLow: n(s?.pct_low_today_cal ?? s?.pct_low_24h), min: n(s?.min_today_cal ?? s?.min_24h),
    pctHigh: n(s?.pct_high_today_cal ?? s?.pct_high_24h), max: n(s?.max_today_cal ?? s?.max_24h),
    tPrev: n(s?.tir_yesterday_cal ?? s?.tir_prev_day), rolling: false,
  };
}

function evoLine(s: any, lang: string): string {
  // Today vs yesterday from the resolved day-view (calendar 08:00 day, or the rolling 24 h when the
  // day just restarted), so this matches the History screen's per-day bars and the stats line.
  const v = todayView(s);
  const t24 = v.tir, tPrev = v.tPrev, t7 = s?.tir_7d, a7 = s?.avg_7d;
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
 *  comparison, from the 08:00→08:00 LOCAL day (tir_today_cal), the SAME window the History screen's
 *  per-day boxes use, so the two screens always agree — EXCEPT right after the 08:00 restart, when
 *  todayView switches to the rolling 24 h and the label follows (see head, below). The LLM is told
 *  NOT to write these numbers: it had put the "vs hier" % ("71%") in a spot that read as TODAY, while
 *  today was 89% — the user saw "today 71%". Owning the line in code makes today unmistakably "today"
 *  and yesterday unmistakably "hier". Also falls back to the rolling 24 h for token-less clients. */
function dayStatsLine(s: any, lang: string): string {
  if (!s || !s.count_24h) return "";
  // ALL figures from ONE resolved window (todayView) — never a min from the 8 h day next to a
  // "% sous 70" from the rolling 24 h, which is exactly how "plus bas 169" landed beside "3 % sous 70".
  const v = todayView(s);
  const tir = v.tir;
  const avg = v.avg;
  if (tir == null) return "";
  const tPrev = v.tPrev;
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
  const lo = v.pctLow;
  const mn = v.min;
  let lows = "";
  if (lo != null) {
    lows = es
      ? ` Por debajo de 70: ${lo}% del tiempo${mn != null ? `, mínimo ${mn} mg/dL` : ""}.`
      : ` Sous 70 : ${lo}% du temps${mn != null ? `, plus bas ${mn} mg/dL` : ""}.`;
  }
  // The window LABEL must match what the figures cover: a just-restarted day (rolling) is "dernières
  // 24 h", never "de 8 h à 8 h" over 20 minutes of data — the exact mismatch that made 12 % read as a
  // lie against the curve. When it's a real 08:00 day, the label and the numbers are the calendar day.
  const head = v.rolling
    ? (es ? `Últimas 24 h: ` : `Dernières 24 h : `)
    : (es ? `Hoy (de 8 h a 8 h): ` : `Aujourd'hui (de 8 h à 8 h) : `);
  return es
    ? `${head}${tir}% del tiempo en objetivo, media ${avg} mg/dL${cmp}.${lows}`
    : `${head}${tir}% du temps dans la cible, moyenne ${avg} mg/dL${cmp}.${lows}`;
}

// Clinical consensus targets for time below range: under 4% of the day below 70, under 1% below 54.
// Past those, the day is not a good day whatever the time-in-target says.
const LOW_TIME_WARN_PCT = 4;
const LOW_TIME_BAD_PCT = 10;

/** Did the day go low, and how badly? Read once by the verdict and once by the prompt so the two
 *  can't disagree. */
function dayLows(stats: any): { pct: number | null; min: number | null; any: boolean; severe: boolean } {
  // Same resolved window as every other day figure (todayView), so the verdict and the stats line
  // can never be computed over different windows.
  const v = todayView(stats);
  const pctRaw = Number(v.pctLow);
  const minRaw = Number(v.min);
  const pct = Number.isFinite(pctRaw) ? pctRaw : null;
  const min = Number.isFinite(minRaw) && minRaw > 0 ? minRaw : null;
  return {
    pct, min,
    any: (pct != null && pct > 0) || (min != null && min < LOW_MGDL),
    severe: (min != null && min < SEVERE_LOW_MGDL) || (pct != null && pct >= LOW_TIME_BAD_PCT),
  };
}

/**
 * Distinct hypo EPISODES in the merged series, and how many went severe. A percentage of the day is
 * not the same information: 6% below 70 can be one long night or six separate crashes, and those are
 * different problems with different causes. Neither count existed anywhere in the repo.
 *
 * An episode ends only after the glucose has been back above the threshold for RECOVERED_MIN — a
 * curve bouncing 68/71/69 around the line is one episode, not three.
 */
const EPISODE_RECOVERED_MIN = 20;
function hypoEpisodes(sorted: { ts: number; value: number }[]): { count: number; severe: number; lowestNight: number | null } {
  let count = 0, severe = 0;
  let inEpisode = false, episodeSevere = false, aboveSince: number | null = null;
  let lowestNight: number | null = null;
  for (const p of sorted || []) {
    const h = new Date(p.ts).getHours();
    if ((h >= 23 || h < 7) && p.value < LOW_MGDL) lowestNight = lowestNight == null ? p.value : Math.min(lowestNight, p.value);
    if (p.value < LOW_MGDL) {
      if (!inEpisode) { inEpisode = true; episodeSevere = false; count++; }
      aboveSince = null;
      if (p.value < SEVERE_LOW_MGDL && !episodeSevere) { episodeSevere = true; severe++; }
    } else if (inEpisode) {
      if (aboveSince == null) aboveSince = p.ts;
      else if ((p.ts - aboveSince) / 60000 >= EPISODE_RECOVERED_MIN) { inEpisode = false; aboveSince = null; }
    }
  }
  return { count, severe, lowestNight };
}

/** Code-owned sentence about the day's lows, injected into the prompt. Empty when the day stayed
 *  above 70 — so its mere presence tells the model the subject may not be skipped. */
function hypoDayNote(stats: any, lang: string, sorted?: { ts: number; value: number }[]): string {
  const l = dayLows(stats);
  const ep = hypoEpisodes(sorted ?? []);
  if (!l.any && ep.count === 0) return "";
  const es = lang === "es";
  const parts = [
    ep.count > 0 ? (es ? `${ep.count} episodio(s) por debajo de 70` : `${ep.count} épisode(s) sous 70`) : "",
    ep.severe > 0 ? (es ? `${ep.severe} por debajo de 54` : `${ep.severe} sous 54`) : "",
    ep.lowestNight != null ? (es ? `de noche, hasta ${ep.lowestNight} mg/dL` : `dont la nuit, jusqu'à ${ep.lowestNight} mg/dL`) : "",
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
  // The resolved day window (todayView): the 08:00 calendar day, or the rolling 24 h when it just
  // restarted — so the verdict word is never decided over a 2 h sliver.
  const tir = Number(todayView(stats).tir);
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
          ? `🚩 SEÑÁLALO claramente: la comida «${m.desc}» (grasa, hace ${min} min) fue seguida de una fuerte subida hasta ${peak} mg/dL. Las comidas grasas (fast-food, pizza, queso…) se digieren LENTO → la glucosa sube con RETRASO; aconseja la insulina en dos veces (una parte en la comida, otra ~1-2 h después) o recontrolar 2-3 h después. Sin cifras de dosis.`
          : `🚩 SIGNALE-LE clairement : le repas «${m.desc}» (gras, il y a ${min} min) a été suivi d'une forte montée jusqu'à ${peak} mg/dL. Les repas gras (fast-food, pizza, fromage…) digèrent LENTEMENT → la glycémie monte en RETARD ; conseille l'insuline en deux fois (une partie au repas, une partie ~1-2 h après) ou de recontrôler 2-3 h après. Aucun chiffre de dose.`;
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
          ? `🚩 SEÑÁLALO: la comida «${m.desc}» (carbohidratos lentos, hace ${min} min) fue seguida de una subida hasta ${peak} mg/dL. Los carbohidratos lentos (pasta, legumbres, integral) suben TARDE y de forma prolongada → la subida puede durar; recontrola más tarde y revisa el momento de la insulina. Sin cifras de dosis.`
          : `🚩 SIGNALE-LE : le repas «${m.desc}» (glucides lents, il y a ${min} min) a été suivi d'une montée jusqu'à ${peak} mg/dL. Les glucides lents (pâtes, légumineuses, complet) montent TARD et de façon prolongée → la montée peut durer ; recontrôle plus tard et revois le moment de l'insuline. Aucun chiffre de dose.`;
      }
      return es
        ? `🚩 SEÑÁLALO: la comida «${m.desc}» (hace ${min} min) fue seguida de una subida hasta ${peak} mg/dL; sugiere revisar el conteo de carbohidratos o el momento de la insulina.`
        : `🚩 SIGNALE-LE : le repas «${m.desc}» (il y a ${min} min) a été suivi d'une montée jusqu'à ${peak} mg/dL ; suggère de revoir le compte de glucides ou le moment de l'insuline.`;
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

function buildPrompt(cur: number | null, s: any, lang: string, ctx: string, swing: string, pr: Record<string, string>, hint: string, recent: string, stability: { word: string; note: string }, signalLost: boolean, staleMin: number, sensorExpired: boolean, actionLine: string, noDose: boolean, sortedForPrompt: { ts: number; value: number }[] = [], series = "", facts = ""): string {
  const curMg = cur != null ? `${cur} mg/dL` : (lang === "es" ? "desconocida" : "inconnue");
  const evo = evoLine(s, lang);
  const quality = dayQuality(s, lang); // the day's VERDICT (from time-in-range), not the stability word
  // "Today" = the resolved day window (todayView): the 08:00 calendar day so the bilan's % match the
  // History per-day boxes, OR the rolling 24 h when the day just restarted (too few points to judge).
  const dv = todayView(s);
  const tToday = dv.tir, aToday = dv.avg, hiToday = dv.pctHigh, loToday = dv.pctLow,
    mxToday = dv.max, mnToday = dv.min;
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
      ? `${dv.rolling ? "Balance de las ÚLTIMAS 24 H" : "Balance de HOY (desde las 8 h)"}: media ${aToday} mg/dL; ${tToday}% del tiempo en el objetivo 70-180; ${hiToday}% por encima de 180 y ${loToday}% por debajo de 70; ${s.rapid_drops_24h} bajada(s) rápida(s) y ${s.rapid_rises_24h} subida(s) rápida(s); punto más alto ${mxToday}, más bajo ${mnToday} mg/dL.`
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
      series,
      facts,
      hypoDayNote(s, lang, sortedForPrompt),
      `VEREDICTO DEL DÍA (lo calcula el sistema según el TIEMPO EN OBJETIVO **y los pasos por debajo de 70**): día ${quality} (${tToday ?? "?"}% en objetivo ${dv.rolling ? "en las últimas 24 h" : "hoy, desde las 8 h"}). ESE es el balance del día — EMPIEZA por esa palabra. NO escribas tú el porcentaje (el sistema añade la línea con cifras).`,
      `ESTABILIDAD (SOLO las oscilaciones): ${stability.word} (${stability.note}). Describe ÚNICAMENTE si la curva está calmada o agitada, NO si el día fue bueno. NUNCA digas "día estable" como balance del día: un día plano pero a menudo por encima del objetivo es un día DIFÍCIL — el tiempo en objetivo manda sobre la regularidad. SIMÉTRICAMENTE, e igual de importante: un día con pasos por debajo de 70 no es "bueno" ni "tranquilo", aunque la curva parezca calmada — una hipoglucemia larga y plana no genera ni variación rápida ni variabilidad alta, así que es INVISIBLE en la palabra de estabilidad. Si arriba existe la línea HIPOGLUCEMIAS, tu frase debe nombrarlas.`,
      `Evolución: ${evo}`,
      `COMPARACIÓN CON AYER: para decir si el día es mejor, peor o comparable a ayer, básate ÚNICAMENTE en el veredicto «Evolución» de arriba (compara el tiempo en objetivo). La palabra de ESTABILIDAD describe SOLO las oscilaciones de hoy: NUNCA escribas «más estable que ayer» ni «menos estable que ayer». Un día poco agitado pero a menudo por encima del objetivo es ESTABLE *y* PEOR que ayer — estabilidad (oscilaciones) y control (tiempo en objetivo) son cosas distintas. NO reescribas los porcentajes (de hoy ni de ayer): el sistema añade la comparación con cifras.`,
      swing,
      hint ? `SITUACIÓN (la calcula el sistema): ${hint}.` : "",
      decided,
      `LONGITUD: el texto mostrado tiene EN TOTAL 4 frases — la línea con cifras (la añade el sistema), TU frase de síntesis, la línea «tenido en cuenta» (sistema) y la acción (sistema). Tu parte es UNA frase. Sé denso, no charlatán.`,
      P(pr, "coach.rules", `REGLAS: habla del DÍA que acaba de pasar y enlázalo con los días previos. El objetivo es 70-180; lo más alto del día no es un techo aceptable — dilo como un pico OBSERVADO, a evitar los próximos días, no como una consigna para ahora. Tono directo, motivador, basado en cifras. Resalta los progresos REALES — pero nunca "resaltes" un progreso callando una hipoglucemia: señalar un paso por debajo de 70 va ANTES que el tono alentador. Sin falsas promesas de cura.`),
      `COMIDAS: la lista « Comidas de hoy » (arriba, con las horas) dice qué se ha COMIDO y cuándo — úsala para ligar las variaciones de glucosa a las comidas (un pico tras tal comida, etc.). NUNCA afirmes que no se registró ninguna comida si la lista contiene alguna.`,
      `VELOCIDAD DE LOS CARBOHIDRATOS: un azúcar rápido (zumo, refresco, dulces, pan blanco) sube la glucosa MUY RÁPIDO (pico ~15-45 min); los carbohidratos lentos (pasta, legumbres, integral) y las comidas grasas suben DESPACIO y TARDE (pico 2-3 h después). Tenlo en cuenta para EXPLICAR las variaciones y el momento de los picos, y para el MOMENTO de la insulina (azúcar rápido → un poco antes de comer; lento/graso → más tarde o dividido).`,
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
    ? `${dv.rolling ? "Bilan des DERNIÈRES 24 H" : "Bilan d'AUJOURD'HUI (depuis 8 h)"} : moyenne ${aToday} mg/dL ; ${tToday}% du temps dans la cible 70-180 ; ${hiToday}% au-dessus de 180 et ${loToday}% en dessous de 70 ; ${s.rapid_drops_24h} chute(s) rapide(s) et ${s.rapid_rises_24h} montée(s) rapide(s) ; point le plus haut ${mxToday}, le plus bas ${mnToday} mg/dL.`
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
    series,
    facts,
    hypoDayNote(s, lang, sortedForPrompt),
    `VERDICT DE LA JOURNÉE (calculé par le système d'après le TEMPS DANS LA CIBLE **et les passages sous 70**) : journée ${quality} (${tToday ?? "?"}% dans la cible ${dv.rolling ? "sur les dernières 24 h" : "aujourd'hui, depuis 8 h"}). C'EST le bilan de la journée — COMMENCE par ce mot. Ne cite PAS le pourcentage toi-même (le système ajoute la ligne chiffrée).`,
    `STABILITÉ (les oscillations UNIQUEMENT) : ${stability.word} (${stability.note}). Ça décrit SEULEMENT si la courbe est calme ou agitée, PAS si la journée est bonne. NE dis JAMAIS « journée stable » comme bilan : une journée plate mais souvent au-dessus de la cible est une journée DIFFICILE — le temps dans la cible prime sur la régularité. SYMÉTRIQUEMENT, et c'est tout aussi important : une journée avec des passages sous 70 n'est ni « bonne » ni « tranquille », même si la courbe a l'air calme — une hypo longue et plate ne fait ni variation rapide ni variabilité élevée, elle est donc INVISIBLE dans le mot de stabilité. Si la ligne HYPOS ci-dessus existe, ta phrase doit les nommer.`,
    `Évolution : ${evo}`,
    `COMPARAISON À HIER : pour dire si la journée est meilleure, moins bonne ou comparable à hier, fie-toi UNIQUEMENT au verdict « Évolution » ci-dessus (il compare le temps dans la cible). Le mot de STABILITÉ ne décrit QUE les oscillations d'aujourd'hui : n'écris JAMAIS « plus stable qu'hier » ni « moins stable qu'hier ». Une journée peu agitée mais souvent au-dessus de la cible est STABLE *et* MOINS BONNE qu'hier — la stabilité (les oscillations) et le contrôle (le temps dans la cible) sont deux choses distinctes. Ne réécris PAS les pourcentages (d'aujourd'hui ou d'hier) : le système ajoute la comparaison chiffrée.`,
    swing,
    hint ? `SITUATION (calculée par le système) : ${hint}.` : "",
    decided,
    `LONGUEUR : le texte affiché fait AU TOTAL 4 phrases — la ligne chiffrée (ajoutée par le système), TA phrase de synthèse, la ligne « pris en compte » (système) et l'action (système). Ta part est donc UNE phrase. Sois dense, pas bavard.`,
    `STRUCTURE : le système compose l'affichage (ligne chiffrée, ta phrase, ligne « pris en compte », action). Tu ne remplis QUE les champs demandés plus bas — n'écris ni l'action chiffrée ni ce qui a été pris en compte.`,
    // "un pic à corriger" removed from the default: it was the prompt itself pushing the model toward
    // the exact wording that then contradicted "rien à corriger". Same meaning, stated as an
    // observation about the day instead of an instruction for now.
    P(pr, "coach.rules", `RÈGLES : parle de la JOURNÉE écoulée et relie-la aux jours précédents. La cible est 70-180 ; le point le plus haut du jour n'est pas un plafond acceptable — dis-le comme un pic OBSERVÉ, à éviter les prochains jours, pas comme une consigne pour maintenant. Ton direct, motivant, basé sur les chiffres. Souligne les progrès RÉELS — mais ne « souligne » jamais un progrès en taisant une hypo : signaler un passage sous 70 passe AVANT le ton encourageant. Pas de fausse promesse de guérison.`),
    `REPAS : la liste « Repas d'aujourd'hui » (ci-dessus, avec les heures) dit ce qui a été MANGÉ et quand — sers-t'en pour relier les variations de glycémie aux repas (un pic après tel repas, etc.). N'affirme JAMAIS qu'aucun repas n'a été loggé si la liste en contient.`,
    `VITESSE DES GLUCIDES : un sucre rapide (jus, soda, bonbons, pain blanc) fait monter la glycémie TRÈS VITE (pic ~15-45 min) ; les glucides lents (pâtes, légumineuses, complet) et les repas gras la font monter LENTEMENT et TARD (pic 2-3 h après). Tiens-en compte pour EXPLIQUER les variations et le moment des pics, et pour le MOMENT de l'insuline (sucre rapide → un peu avant de manger ; lent/gras → plus tard ou en deux fois).`,
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
    // BYOK: a client-supplied Gemini key routes the LLM to the user's free quota (cost ~0 to us).
    const byokGeminiKey = typeof body.geminiKey === "string" ? body.geminiKey.trim() : "";
    // ElevenLabs audio is generated unless the client explicitly opts into native TTS
    // (premiumVoice:false). Absent field => premium (keeps older installs' voice working).
    const premiumVoice = body.premiumVoice !== false;
    // Cost model: the server's own LLM key is used ONLY in Hosted mode. A free user must bring
    // their own Gemini key (BYOK). New clients always send `hosted`; older installs omit it and
    // are grandfathered (gate only fires on an explicit hosted:false).
    // No BYOK gate any more: text runs on the service's own key (see IGNORE_BYOK_FOR_TEXT in
    // llm.ts), so a phone with "Mode Hosted" off is no longer refused an analysis.
    if (!DEEPSEEK_API_KEY) {
      return json({ text: lang === "es"
        ? "La IA no está configurada en el servidor. Avísanos."
        : "L'IA n'est pas configurée côté serveur. Préviens-nous.", isError: true });
    }

    // Everything the decision reads, in one place, the same way for every surface. Phone readings are
    // checked against what the 24/7 monitor recorded for this person before anything is stored: two
    // sensors shared a phone, and 845 mixed rows got into the history through this very write.
    const nowMs = Date.now();
    const data = await loadEngineData(db, subject, nowMs, readings, TREND_HISTORY_HOURS);
    if (data.rejected) console.warn(`coach: ${data.rejected} phone readings rejected against the monitor`);
    await storePhoneReadings(db, subject, data.accepted);
    const profile = data.profile;
    const tzOffsetMin = tzOffsetOf(body, profile);

    // Stats FIRST, so even a cached analysis returns the 24h numbers for the dashboard boxes
    // (otherwise the boxes show "…" forever whenever the analysis is served from cache).
    const { data: stats } = await db.rpc("mechabetics_stats", { p_subject: subject, p_tz_offset_min: tzOffsetMin });

    // 10-min cache: reuse the last analysis unless a newer meal exists OR the profile was edited
    // since (so clearing the nickname / changing ratios reflects right away, not after 10 min).
    const { data: prof0 } = await db.from("mechabetics_profiles").select("updated_at").eq("subject", subject).maybeSingle();
    const profUpdatedMs = (prof0 as any)?.updated_at ? new Date((prof0 as any).updated_at).getTime() : 0;
    const { data: lastLog } = await db.from("mechabetics_coach_log")
      .select("id, message, ts, lang, glucose_at_time, spoken, decision").eq("subject", subject)
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
      // FROM THE DATABASE AS WELL AS THE PHONE, and that distinction is the whole point. Built on the
      // payload alone this check missed precisely the case it exists for: the father has his own
      // record on screen, so the phone is not polling the son at all, while the 24/7 monitor has been
      // writing the son's 62 mg/dL to this table for six minutes. The son's dashboard would then
      // refresh and replay a ten-minute-old "tout va bien" with its action line. Bounded to the cache
      // age, so it is a handful of rows.
      const { data: dbSince } = await db.from("mechabetics_readings")
        .select("ts, value_mgdl").eq("subject", subject)
        .gt("ts", lastLog.ts).order("ts", { ascending: false }).limit(60);
      const sinceCache = [
        ...data.accepted,
        ...((dbSince ?? []) as any[]).map((r) => ({ ts: new Date(r.ts).getTime(), value: Number(r.value_mgdl) })),
      ]
        .filter((r) => Number.isFinite(r.ts) && r.value > 0 && r.ts > logMs)
        .sort((a, b) => a.ts - b.ts);
      // A low the cached text ALREADY describes must not re-bill an LLM call on every refresh — an
      // hour-long hypo is exactly when the parent reloads most. Only a low that is NEW relative to
      // what the cache was written on invalidates it.
      const cachedGlucose = Number((lastLog as any).glucose_at_time);
      const cachedWasLow = Number.isFinite(cachedGlucose) && cachedGlucose > 0 && cachedGlucose < LOW_MGDL;
      const wentLow = !cachedWasLow && sinceCache.some((r) => r.value < LOW_MGDL);
      const droppedFast = sinceCache.length >= 2 &&
        (Math.max(...sinceCache.map((r) => r.value)) - sinceCache[sinceCache.length - 1].value) >= 40;
      if (ageMs < 10 * 60 * 1000 && logMs >= profUpdatedMs && !wentLow && !droppedFast) {
        const { data: newerMeal } = await db.from("mechabetics_meals")
          .select("id").eq("subject", subject).gt("created_at", lastLog.ts).limit(1).maybeSingle();
        // A NEWLY LOGGED ACTIVITY INVALIDATES THE CACHE TOO. Without this, opening the SPORT tab,
        // logging the football and going straight back to the dashboard replayed the pre-football
        // analysis — dose untrimmed, no warning — for up to ten minutes. That is exactly the window
        // the feature exists for, so a cached answer there is worse than no feature at all.
        const { data: newerActivity } = await db.from("mechabetics_activity")
          .select("id").eq("subject", subject).gt("created_at", lastLog.ts).limit(1).maybeSingle();
        // A DOSE LOGGED SINCE IS THE ANSWER TO THE LAST ANALYSIS. Replayed, "Fais 2 u" came back with its
        // Done button after the 2 u had been logged in the Insulin tab.
        const { data: newerInsulin } = await db.from("mechabetics_insulin")
          .select("id").eq("subject", subject).gt("created_at", lastLog.ts).limit(1).maybeSingle();
        if (!newerMeal && !newerActivity && !newerInsulin) {
          // Normalize an OLD cached report too, so its paragraphs blank-line on screen like fresh ones.
          const cachedText = lastLog.message.replace(/\s*\|\|\s*/g, "\n\n").replace(/\n+/g, "\n\n").trim();
          // The client is about to READ THIS ALOUD (no premium audio on a cache hit — the on-device
          // voice speaks the text). It is the same analysis being delivered by voice, so the row it
          // came from earns the VOIX badge; without this a spoken re-read of a silently-prefetched
          // report stays unbadged and the history under-reports what was actually said out loud.
          if (speak && !(lastLog as any).spoken) {
            await db.from("mechabetics_coach_log").update({ spoken: true }).eq("id", (lastLog as any).id);
          }
          return json({
            text: cachedText, audioBase64: null, mime: "audio/mpeg", isError: false, cached: true, stats,
            decision: (lastLog as any).decision ?? null,
          });
        }
      }
    }

    const meals = data.meals;
    const insulin = data.insulin;
    const activity = data.activity;
    // TODAY'S TEMPERATURE, when a city is stored. Heat speeds insulin absorption, cold slows it. It
    // moves NO dose (no clinical figure supports one); it raises vigilance and explains itself. Null
    // on any failure, and the analysis is then exactly what it was before.
    // `outdoor` comes from what the user ticked on the ACTIVITÉ screen, never from a position.
    const weather = await currentWeather((profile as any)?.city, (profile as any)?.country);
    const outdoor = activity.length ? ((activity as any[])[0]?.outdoor ?? null) : null;

    // THE ONE DECISION: same state, same function as the voice, the photo and the meals screen.
    const state = buildState({
      nowMs, lang, tzOffsetMin, profile, readings: data.series, insulin, meals, activity,
      tempC: weather?.tempC ?? null, outdoor: outdoor === true, place: weather?.place ?? null,
      sensorExpired: body.sensorExpired === true, model: data.model,
    });
    const decision = decideAction(state, { concise: true });
    const ahead = anticipate(state, decision);
    const payload = decisionPayload(state, decision, ahead);
    const { cur, guard, iob, signalLost, sensorExpired, staleMin, trend, predict } = state;
    const sorted = data.series;
    const actionLine = decision.line;

    // The learned model refreshes itself in the background, at most once a day.
    refreshModelIfStale(subject, data.modelFittedAt, nowMs, tzOffsetMin, SUPABASE_URL, SERVICE_KEY);
    if (body.tzOffsetMin != null && profile && profile.tz_offset_min !== tzOffsetMin) {
      await db.from("mechabetics_profiles").update({ tz_offset_min: tzOffsetMin }).eq("subject", subject);
    }

    const recentInsulin = insulin.filter((d: any) => new Date(d.ts).getTime() > nowMs - 8 * 3600000);
    const insCtx = insulinContext(recentInsulin, iob, nowMs, lang);
    // The model is told the SAME cut the code applied, so its prose cannot trim the dose a second time.
    const actCtx = activityContext(activity, nowMs, state.activityCut, lang);
    const tempCtx = temperatureContext(weather?.tempC ?? null, lang, outdoor);
    const ctx = profileContext(profile, meals, lang, nowMs)
      + (insCtx ? " " + insCtx : "")
      + (actCtx ? " " + actCtx : "")
      + (tempCtx ? " " + tempCtx : "");
    const hint = decisionHint(state, decision);
    // recentHypo reaches the narrative only: correcting a genuine high after a low is intended
    // behaviour, but coming up from a hypo is the whole context of the hour that follows.
    const recentHypoNote = state.recentHypo
      ? (lang === "es"
        ? `HIPOGLUCEMIA RECIENTE (calculado por el sistema): hubo un valor por debajo de 70 en los últimos 75 minutos. Tenlo en cuenta al explicar lo que pasa ahora (un rebote después de un resucarado es esperable) y menciónalo.`
        : `HYPO RÉCENTE (calculé par le système) : il y a eu une valeur sous 70 dans les 75 dernières minutes. Prends-le en compte pour expliquer ce qui se passe maintenant (un rebond après un resucrage est attendu) et mentionne-le.`)
      : "";
    const lastMealTs = (meals.length && (meals[0] as any).ts) ? new Date((meals[0] as any).ts).getTime() : 0;
    const risingNow = trend === "rising" || trend === "rising_fast";
    // An overnight rise is almost always the dawn phenomenon, not an unlogged meal: no nagging at night.
    const localHour = ((Math.floor((nowMs + tzOffsetMin * 60000) / 3600000) % 24) + 24) % 24;
    const isNight = localHour < 7 || localHour >= 23;
    const mealNudge = !isNight && risingNow && cur != null && cur > 140 && (nowMs - lastMealTs > 180 * 60 * 1000);
    const mealNudgeNote = mealNudge
      ? (lang === "es"
        ? "INDICIO: la glucosa sube sin comida registrada; sugiere amablemente registrar lo que ha comido (no inventes ninguna dosis)."
        : "INDICE : la glycémie monte sans repas noté ; suggère gentiment de noter ce qui a été mangé (n'invente aucune dose).")
      : "";

    const swing = swingNote(sorted, lang);
    const recent = signalLost ? "" : recentWindowNote(sorted, nowMs, lang); // a stale "now: X rising" reads as live
    // CODE owns the stability verdict so the model can't call a 21-swing day "stable".
    const cv = variabilityCv(sorted);
    const stability = dayStability(stats, cv, lang);
    const spikeNote = mealSpikeNote(meals, sorted, nowMs, lang);
    const pr = await loadPrompts(lang);
    const prompt = buildPrompt(
      cur, stats, lang,
      ctx + (mealNudgeNote ? " " + mealNudgeNote : "") + (spikeNote ? " " + spikeNote : "")
        + (recentHypoNote ? " " + recentHypoNote : ""),
      swing, pr, hint, recent, stability, signalLost, staleMin, sensorExpired,
      actionLine, decision.nothingDue, sorted,
      signalLost ? "" : timedSeries(state),
      signalLost ? "" : engineFacts(state, decision, ahead),
    );
    let raw = "";
    try {
      raw = await chatJsonWithin(
        { user: prompt, temperature: 0.3 },
        { byokGeminiKey, deepseekKey: DEEPSEEK_API_KEY, deepseekModel: DEEPSEEK_MODEL, geminiModel: GEMINI_TEXT_MODEL },
        COACH_LLM_MS,
      );
    } catch (e) {
      // AI down (or out of credits / rate-limited / bad key): say WHICH, and still return the
      // code-owned safe action (the guard never needed the model) + the 24h stats so the dashboard
      // boxes stay populated. Coach used to drop both and show only a raw error string.
      const kind = llmErrorKind(e);
      const head = llmErrorMessage(kind, lang, false) /* text runs on the service key only */;
      const show = guard.reason !== "no_reading";
      const out = show ? `${head}\n\n${lang === "es" ? "Acción" : "Action"} : ${actionLine}` : head;
      // The model being down changes nothing about the dose on the screen: it still has to be asked about.
      if (show && dosePutForward(decision)) await rememberNamedDose(db, subject, state, decision);
      return json({
        text: out, isError: true, errorKind: kind, stats, decision: payload,
        actionLine: show ? actionLine : "", predict,
      });
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
    // CODE-OWNED day figures LEAD the analysis (today's % / average / vs-yesterday, from the 8 h→8 h
    // day so they match the History screen's per-day boxes — or the rolling 24 h when the day just
    // restarted, dayStatsLine labels which). "hier" can never be read as today; the LLM no longer
    // writes them. Skipped during signal loss (the lost-signal warning must lead).
    const dsl = signalLost ? "" : dayStatsLine(stats, lang);
    if (dsl) display = `${dsl}\n\n${display}`;
    const voiceRaw = (typeof parsed.voice === "string" && parsed.voice.trim()) ? parsed.voice.trim() : extractStr(raw, "voice");
    let voice: string = (voiceRaw && !(!parseOk && looksTruncated(voiceRaw))) ? voiceRaw : display.replace(/\n+/g, " ");

    // The model must not state a dose; if insulin is forbidden, strip any it sneaked in, then
    // append the code-computed authoritative action (only when a dose is actually relevant).
    const insulinForbidden = decision.insulinForbidden;
    if (insulinForbidden) { display = stripInsulinNumbers(display) || display; voice = stripInsulinNumbers(voice) || voice; }
    // ...and when insulin IS allowed, the narrative may still not name a BIGGER dose than the system
    // decided. Until now nothing checked that: the strip above only covered the forbidden case.
    else {
      const ceiling = { ...guard, maxInsulinUnits: decision.proseCeiling };
      display = enforceInsulinCeiling(display, ceiling) || display;
      voice = enforceInsulinCeiling(voice, ceiling) || voice;
    }

    // Last line of defence on the contradiction: the prompt tells the model the decision and reserves
    // "corriger" for the system, but a model will still slip. When nothing is due, the narrative may
    // not say anything is "to correct" — the observation stays, as something to WATCH. Deliberately
    // here, BEFORE the action line is appended below, or it would rewrite the action's own
    // "rien à corriger" into nonsense.
    if (decision.nothingDue && !signalLost) {
      display = softenCorrectionTalk(display, lang);
      voice = softenCorrectionTalk(voice, lang);
    }

    // COMPACT CARD (app ≥3.6): the card shows ONLY the action + ONE sentence; the full report lives
    // behind "Voir plus". The paragraphs are one-sentence each (split above), so the summary is the
    // first narrative paragraph — and on a lost signal that paragraph IS the warning, which is
    // exactly the one sentence the card must show. Captured AFTER the strip/soften passes so a
    // forbidden dose can never survive in the short form, BEFORE the accounting/notes appends.
    const summaryLine = (dsl ? display.split("\n\n").slice(1) : display.split("\n\n"))[0]?.trim() ?? "";

    // Transparency: ALWAYS state what was accounted for (insulin on board + last meal) so the action
    // below is trustworthy — e.g. "no insulin now" reads as a decision (a dose is already working),
    // not an oversight — and the user knows to log a dose/meal when the system says none is recorded.
    const acct = accountingLine(recentInsulin, meals, iob, nowMs, lang);
    if (acct) display = `${display}\n\n${acct}`;

    // The analysis ALWAYS ends with a concrete action. Only a TOTAL no-reading has nothing to say.
    const showAction = signalLost || guard.reason !== "no_reading";
    if (showAction) {
      const label = lang === "es" ? "Acción" : "Action";
      display = `${display}\n\n${label} : ${actionLine}`;
      voice = `${voice} ${speakable(actionLine, lang)}`.trim();
    } else if (tip) {
      display = `${display}\n\n${tip}`;
    }
    if (ahead) {
      display = `${display}\n\n${lang === "es" ? "A prever" : "À prévoir"} : ${ahead.line}`;
      voice = `${voice} ${speakable(ahead.line, lang)}`.trim();
    }
    const likely = signalLost ? "" : forecastLine(state.forecast, lang);
    if (likely) display = `${display}\n\n${lang === "es" ? "Previsión" : "Prévision"} : ${likely}`;
    for (const n of sideNotes(state, decision)) {
      display = `${display}\n\n${n.display}`;
      voice = `${voice} ${n.voice}`.trim();
    }

    // The spoken voice must never read the unit aloud ("128", not "128 milligrammes par décilitre").
    // Display keeps mg/dL; only the voice is stripped (also covers the voice=display fallback above).
    voice = voice.replace(/\s*mg\s*\/\s*d[lL]/gi, "");

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

    // `spoken` = this analysis was DELIVERED BY VOICE, not just written on screen. It separates the
    // reports the AI actually read aloud from the SILENT ones the app writes for itself — the
    // bilingual prefetch and the auto-greet both call with speak:false and produce a row nobody ever
    // heard. They read differently too (the model writes "display" and "voice" as two texts), which
    // is why an unlabelled history looked like it held two kinds of analysis. The history screen
    // badges these VOIX.
    await db.from("mechabetics_coach_log").insert({ subject, message: display, glucose_at_time: cur, lang, spoken: speak, decision: payload });
    // A firm dose has been put in front of someone: remember it, so the next look asks what happened
    // before naming another one.
    if (dosePutForward(decision)) await rememberNamedDose(db, subject, state, decision);

    return json({
      text: display, voice, audioBase64, mime: "audio/mpeg", isError: false, stats, mealNudge, predict,
      // The compact card's two lines. actionLine is bare (no "Action :" label — the app draws its
      // own); empty when there is nothing actionable (total no-reading), and the app then falls
      // back to the full text.
      summaryLine, actionLine: showAction ? actionLine : "", decision: payload,
    });
  } catch (e) {
    return json({ text: `Erreur serveur: ${(e as Error)?.message ?? e}`, isError: true });
  }
});
