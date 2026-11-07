// What the decision engine reads, loaded the same way for the analysis, the voice, the photo and the
// meals screen. Different windows here were enough to give two different answers from the same engine:
// the voice used to see twelve phone readings while the analysis saw 24 h of stored history.

import { blindFallMessage, fastDropMessage, forecastLowMessage } from "./alertZones.ts";
import type { FastDrop } from "./alertZones.ts";
import { buildState, lastCountedDoseMs, PENDING_GRACE_MIN, slowInsulinDaysLeft } from "./decide.ts";
import type { Decision, EngineState } from "./decide.ts";
import { isHypoRescue, LOW_MGDL } from "./doseGuard.ts";
import { blindFall, LOW_WARN_SILENCE_MIN } from "./forecast.ts";
import type { ForecastModel, Pt } from "./forecast.ts";
import { isBasalInsulin } from "./insulins.ts";

/** A stored row carrying the reading's origin, when known. */
export interface StoredReading extends Pt {
  source?: string | null;
}

/** Two sensors in one family, one phone: a reading that disagrees with what the 24/7 monitor recorded
 *  for this person at the same minute belongs to the other person. Real sensors do not jump this far
 *  in three minutes, and 845 mixed rows got into the history through exactly this path. */
export const PHONE_ANCHOR_WINDOW_MS = 3 * 60000;
export const PHONE_ANCHOR_TOLERANCE = 25;

/**
 * Stored history and the phone's payload as one series, ascending. A phone reading wins a tie, it is
 * the freshest source for the live point, unless the monitor contradicts it.
 * `accepted` is what may be written back.
 */
export function mergeReadings(
  stored: StoredReading[],
  phone: { ts: unknown; value: unknown }[],
  nowMs: number,
): { series: Pt[]; accepted: Pt[]; rejected: number } {
  const anchors = (stored || []).filter((r) => r.source === "monitor").sort((a, b) => a.ts - b.ts);
  const byTs = new Map<number, number>();
  for (const r of stored || []) {
    if (Number.isFinite(r.ts) && r.value > 0) byTs.set(r.ts, r.value);
  }
  const accepted: Pt[] = [];
  let rejected = 0;
  for (const raw of phone || []) {
    const ts = Number(raw?.ts);
    const value = Number(raw?.value);
    if (!Number.isFinite(ts) || !(value > 0)) continue;
    if (ts > nowMs + 120000 || ts < nowMs - 31 * 86400000) continue; // wrong clock, or seconds taken for ms
    let lo = 0;
    let hi = anchors.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (anchors[m].ts < ts) lo = m + 1; else hi = m;
    }
    let nearest: StoredReading | null = null;
    for (const a of [anchors[lo - 1], anchors[lo]]) {
      if (a && Math.abs(a.ts - ts) <= PHONE_ANCHOR_WINDOW_MS && (!nearest || Math.abs(a.ts - ts) < Math.abs(nearest.ts - ts))) nearest = a;
    }
    if (nearest && Math.abs(nearest.value - value) > PHONE_ANCHOR_TOLERANCE) {
      rejected++;
      // A LOW IS NEVER ARGUED WITH. The monitor's row can be a 15-minute graph point, and a real fall
      // outruns it: 96 two minutes ago and 72 then 68 on the phone was answered "tout va bien" at 72.
      // Believing it costs a sugar too many; not believing it costs a hypo nobody treats. It stays out
      // of the stored history, where a wrong value would last.
      if (value < LOW_MGDL) byTs.set(ts, value);
      continue;
    }
    byTs.set(ts, value);
    accepted.push({ ts, value });
  }
  const series = [...byTs.entries()].map(([ts, value]) => ({ ts, value })).sort((a, b) => a.ts - b.ts);
  return { series, accepted, rejected };
}

/** Stored readings, newest first in pages: `.limit()` does not lift this project's 1000-row cap, and
 *  a truncated ascending read would silently lose the recent end, the part that decides the dose. */
export async function loadStoredReadings(db: any, subject: string, sinceMs: number): Promise<StoredReading[]> {
  const iso = new Date(sinceMs).toISOString();
  const out: StoredReading[] = [];
  for (let page = 0; page < 3; page++) {
    const from = page * 1000;
    const { data, error } = await db.from("mechabetics_readings")
      .select("ts, value_mgdl, source").eq("subject", subject).eq("suspect", false)
      .gte("ts", iso).order("ts", { ascending: false }).range(from, from + 999);
    if (error) {
      console.error("engine: stored readings failed:", error.message);
      break;
    }
    const rows = data ?? [];
    for (const r of rows) {
      const t = new Date(r.ts).getTime();
      const v = Number(r.value_mgdl);
      if (Number.isFinite(t) && v > 0) out.push({ ts: t, value: v, source: r.source ?? null });
    }
    if (rows.length < 1000) break;
  }
  return out;
}

export interface EngineData {
  profile: any;
  stored: StoredReading[];
  series: Pt[];
  accepted: Pt[];
  rejected: number;
  insulin: any[];
  meals: any[];
  activity: any[];
  model: ForecastModel | null;
  modelFittedAt: number | null;
}

/** The profile, the three logs, the readings and the learned model, in one round of queries. */
export async function loadEngineData(
  db: any,
  subject: string,
  nowMs: number,
  phone: { ts: unknown; value: unknown }[],
  hours = 24,
): Promise<EngineData> {
  const since = (h: number) => new Date(nowMs - h * 3600000).toISOString();
  const [profRes, stored, insRes, mealRes, actRes, modelRes] = await Promise.all([
    db.from("mechabetics_profiles").select("*").eq("subject", subject).maybeSingle(),
    loadStoredReadings(db, subject, nowMs - hours * 3600000),
    // Eight hours: a dose is only spent after six, and regular insulin runs longer still. A cap of
    // six rows hid doses on the days a family logs properly.
    db.from("mechabetics_insulin").select("ts, units, insulin_name, kind").eq("subject", subject)
      .gte("ts", since(36)).order("ts", { ascending: false }).limit(40),
    db.from("mechabetics_meals").select("id, ts, description, carbs_g, planned, carbs_estimated").eq("subject", subject)
      .gte("ts", since(26)).order("ts", { ascending: false }).limit(24),
    db.from("mechabetics_activity").select("ts, kind, description, intensity, duration_min, planned, outdoor").eq("subject", subject)
      .gte("ts", since(14)).order("ts", { ascending: false }).limit(6),
    db.from("mechabetics_models").select("model, fitted_at").eq("subject", subject).maybeSingle(),
  ]);
  const { series, accepted, rejected } = mergeReadings(stored, phone, nowMs);
  return {
    profile: profRes.data ?? null,
    stored, series, accepted, rejected,
    insulin: insRes.data ?? [],
    meals: mealRes.data ?? [],
    activity: actRes.data ?? [],
    model: (modelRes.data?.model ?? null) as ForecastModel | null,
    modelFittedAt: modelRes.data?.fitted_at ? new Date(modelRes.data.fitted_at).getTime() : null,
  };
}

/** Accepted phone readings go back into the table, tagged so the monitor stays the reference. */
export async function storePhoneReadings(db: any, subject: string, accepted: Pt[]): Promise<void> {
  if (!accepted.length) return;
  const rows = accepted.map((r) => ({
    subject, ts: new Date(r.ts).toISOString(), value_mgdl: Math.round(r.value), source: "phone",
  }));
  const { error } = await db.from("mechabetics_readings").upsert(rows, { onConflict: "subject,ts", ignoreDuplicates: true });
  if (error) console.error("engine: phone readings not stored:", error.message);
}

/** Remembers the dose just named, keeping the first time it was named if it is only being repeated,
 *  so a second look a minute later does not reset the clock on "was it done?". Also what was already
 *  on record: the dose counted in this very sum cannot be the answer to it. The figure can move with
 *  each look, the clock does not: 2, 2,5, 3, 3,5 u at eight-minute intervals were otherwise never asked
 *  about, each one restarting it. */
export async function rememberNamedDose(db: any, subject: string, s: EngineState, d: Decision): Promise<void> {
  const later = d.kind === "dose_later";
  const units = later ? d.laterUnits : d.units;
  const dueAt = later ? (d.laterAtMs ?? s.nowMs) : s.nowMs;
  // What the score compares the doses with, at the hour each one falls due. Every surface comes through
  // here, and it costs a dose nothing if this one write fails.
  const { error: logError } = await db.from("mechabetics_named_doses").insert({ subject, units, named_at: new Date(dueAt).toISOString() });
  if (logError) console.error("engine: named dose not logged:", logError.message);
  // What the floor kept back, for the second look. On its own: this column is newer than pending_action,
  // and a missing one must not cost the dose its memory.
  if (d.heldBack) {
    const { error: heldError } = await db.from("mechabetics_profiles").update({ held_back: { ...d.heldBack, at: dueAt } }).eq("subject", subject);
    if (heldError) console.error("engine: part held back not remembered:", heldError.message);
  }
  const open = s.pending;
  // A dose for later waits for its hour, and must not wipe a question still open.
  if (later && open) return;
  const repeat = !!open && s.nowMs - open.at < PENDING_GRACE_MIN * 60000;
  const action = {
    units,
    at: later ? dueAt : repeat ? open!.at : s.nowMs,
    namedAt: s.nowMs,
    insulin: d.insulinName,
    knownDoseAt: repeat ? (open!.knownDoseAt ?? null) : lastCountedDoseMs(s),
    conditional: d.kind === "dose_if",
    split: d.split,
  };
  const { error } = await db.from("mechabetics_profiles").update({ pending_action: action }).eq("subject", subject);
  if (error) console.error("engine: named dose not remembered:", error.message);
}

/** A dose in front of someone, firm or provided the last 3 h are clear: both get asked about next time.
 *  Three conditional doses in a row, each blind to the last, add up just the same. A dose for later too,
 *  from its hour: done at the meal and left unnoted, the next look named it a second time. */
export const dosePutForward = (d: Decision): boolean => d.kind === "dose" || d.kind === "dose_if" || d.kind === "dose_later";

/** How long the same food said again is the same food. Short for sugar: taken again a quarter of an hour
 *  later it is a real second treatment. */
export const MEAL_SAID_AGAIN_MIN = 20;
export const RESCUE_SAID_AGAIN_MIN = 5;
export const DOSE_SAID_AGAIN_MIN = 15;
export const PLATE_PHOTO_AGAIN_MIN = 5;

// Words that say nothing about which food it is. Digits and units go too: "riz (100 g)" and
// "pâtes (100 g)" are not the same plate.
const FILLER = new Set([
  "des", "les", "une", "aux", "avec", "pour", "dans", "que", "qui", "sur", "mon", "son", "ses", "mes",
  "los", "las", "una", "con", "para", "del", "por", "petit", "petite", "grand", "grande", "gros", "grosse",
  "verre", "tasse", "bol", "part", "tranche", "morceau", "menu", "plat", "assiette", "encore",
]);

const plainWords = (t: string): string => (t || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
const foldWord = (w: string): string => (w.length >= 5 ? w.replace(/[sx]$/, "") : w);

function foodWords(t: string): Set<string> {
  const words = plainWords(t).split(/[^a-z0-9]+/).filter((w) => /[a-z]/.test(w)).map(foldWord);
  return new Set(words.filter((w) => w.length >= 3 && !FILLER.has(w)));
}

// WHEN UNSURE, THE SIDE WITH LESS INSULIN. The two lists below are not the same size on purpose. A second
// dose taken for a repeat vanishes and more insulin gets named, so nearly any word will do. A second
// plate taken for a repeat is only a plate not covered, while a repeat taken for a second plate asks for
// insulin nobody needs: "il a mangé ses pâtes mais il est encore à 200" named 3,5 u. So for a plate
// the word has to be about more food.
const ANOTHER_DOSE = /\b(?:re-?fai\w*|re-?piqu\w*|rajout\w*|ajout\w*|re-?mis\b|re-?met\w*|une? autre (?:dose|injection|piq\w*|fois)|en ai (?:re)?fait une autre|deuxi[eè]me|2[eè]me|2e\b|seconde? (?:dose|injection|piq\w*)|suppl[eé]mentaire|encore (?:fait|\d|une?\b)|de plus(?! en plus)|(?<!de plus )en plus|de nouveau|\d\s*u\w* m[aá]s|otr[ao]s?\b|de nuevo|vuelto a|volv[ií]\w* a|segunda dosis|repet\w*|repit\w*)/i;

/** "J'ai refait 3 u", "je lui ai rajouté 3 u": a new dose, whatever the figures look like. */
export const saysAnotherDose = (question: string): boolean => ANOTHER_DOSE.test(question || "");

const SERVINGS = new Set([
  "part", "assiette", "portion", "tranche", "bol", "bols", "verre", "morceau", "bout", "plat", "cuillere",
  "racion", "plato", "trozo", "vaso",
]);
// These can only be about food. Everything else in the next list can be about the glucose too: "il a
// encore des cétones", "sa glycémie a repris", "encore une fois il monte".
const MORE_FOOD = /\b(?:re-?s?servi\w*|re-?mange\w*|rab\b|repiti\w*|repite\w*|ha repetido|en (?:a |ai )?re-?pris\b|en re-?prend\w*)/;
const MAYBE_MORE = /\b(?:re-?pris|re-?prend\w*|re-?demande\w*|encore|une? autre|deuxieme|seconde?|otr[ao])\b/g;

/** "Il reprend des pâtes", "encore une part": more food, said about this plate or a serving of something.
 *  The word has to be followed by the food. */
export function saysAnotherPlate(question: string, description: string): boolean {
  const q = plainWords(question);
  if (/^(?:et )?encore une?$/.test(q) || MORE_FOOD.test(q)) return true;
  const plate = foodWords(description);
  for (const m of q.matchAll(MAYBE_MORE)) {
    const next = q.slice((m.index ?? 0) + m[0].length).split(/[^a-z0-9]+/).filter(Boolean).slice(0, 4).map(foldWord);
    if (next.some((w) => plate.has(w) || SERVINGS.has(w))) return true;
  }
  return false;
}

const FIGURE_THEN_WORD = new RegExp(String.raw`(\d+(?:[.,]\d+)?)\s*(?:u\b|unit[eé]s?|unidad(?:es)?)?\s*(?:de\s+|d')?([\p{L}-]+)`, "giu");
const SLOW_WORD = /^(?:lente|lenta|basale?)$/i;

/**
 * Does the sentence say this dose is a slow insulin, with no name from the model? Only with the word right
 * after the figure: "14 u de lente", "14 u lente". A rapid dose stored as basal disappears from the
 * insulin on board, and more gets named on top of it, so "3 u sa lente c'est ce soir" stays rapid. A slow
 * dose stored as rapid only holds the next dose back, so the doubt goes that way.
 */
export function saidBasalDose(question: string, units: number): boolean {
  for (const m of (question || "").matchAll(FIGURE_THEN_WORD)) {
    const sameFigure = Math.abs(Number(m[1].replace(",", ".")) - units) < 0.01;
    if (sameFigure && (SLOW_WORD.test(m[2]) || isBasalInsulin(m[2]))) return true;
  }
  return false;
}

/** Is this meal, said out loud, one already in the log? Told about a plate logged a moment ago, the
 *  voice used to write it a second time, and the doubled carbs fed the holds and the low warning. It has
 *  to be that plate: all the words of the shorter description, and the same grams when both are known
 *  and someone stated them. A model's guess says nothing: its 80 g against the 60 typed made a covered
 *  plate new. */
export function mealSaidAgain(rows: any[], description: string, carbsG: number | null, atMs: number, gramsStated = true): boolean {
  const window = (isHypoRescue(description, carbsG) ? RESCUE_SAID_AGAIN_MIN : MEAL_SAID_AGAIN_MIN) * 60000;
  const said = foodWords(description);
  if (!said.size) return false;
  return (rows || []).some((m) => {
    const t = new Date(m?.ts).getTime();
    if (!Number.isFinite(t) || Math.abs(t - atMs) > window) return false;
    const known = foodWords(String(m?.description ?? ""));
    if (!known.size) return false;
    const was = Number(m?.carbs_g ?? m?.carbsG ?? 0);
    const bothKnown = gramsStated && carbsG != null && carbsG > 0 && was > 0;
    if (bothKnown && Math.abs(was - (carbsG as number)) > Math.max(5, was * 0.2)) return false;
    const [small, large] = said.size <= known.size ? [said, known] : [known, said];
    return [...small].every((w) => large.has(w));
  });
}

/** A picture taken again a moment later: the same size, whatever the model calls it this time. */
export function plateJustLogged(rows: any[], carbsG: number | null, atMs: number): boolean {
  if (!(Number(carbsG) > 0)) return false;
  return (rows || []).some((m) => {
    const t = new Date(m?.ts).getTime();
    const was = Number(m?.carbs_g ?? m?.carbsG ?? 0);
    return Number.isFinite(t) && Math.abs(t - atMs) <= PLATE_PHOTO_AGAIN_MIN * 60000 && was > 0
      && Math.abs(was - (carbsG as number)) <= Math.max(5, was * 0.2);
  });
}

/** Same for a dose: the same kind, the same units, around the same time. Phantom insulin hides a real
 *  need, but a real dose taken for a phantom one is worse, so the caller says out loud when it does
 *  this: 4 u of Lantus must not swallow the 4 u of Fiasp said five minutes later. */
export function doseSaidAgain(rows: any[], units: number, atMs: number, basal = false): boolean {
  return (rows || []).some((d) => {
    const t = new Date(d?.ts).getTime();
    const wasBasal = d?.kind === "basal" || isBasalInsulin(d?.name ?? d?.insulin_name);
    return wasBasal === basal && Number.isFinite(t) && Math.abs(Number(d?.units) - units) < 0.01 &&
      Math.abs(t - atMs) <= DOSE_SAID_AGAIN_MIN * 60000;
  });
}

export async function clearNamedDose(db: any, subject: string): Promise<void> {
  const { error } = await db.from("mechabetics_profiles").update({ pending_action: null }).eq("subject", subject);
  if (error) console.error("engine: named dose not cleared:", error.message);
}

/** "Nothing injected in the last 3 h", stated by the family. */
export async function confirmNoRecentInsulin(db: any, subject: string, nowMs: number): Promise<void> {
  const { error } = await db.from("mechabetics_profiles")
    .update({ no_insulin_confirmed_at: new Date(nowMs).toISOString(), pending_action: null }).eq("subject", subject);
  if (error) console.error("engine: confirmation not stored:", error.message);
}

export interface ConversationMemory {
  /** What was asked and answered aloud in the last minutes, oldest first. */
  turns: { question: string; reply: string }[];
  /** The action the last analysis showed. */
  lastAction: { line: string; at: number } | null;
}

/** A spoken exchange older than this is a new conversation. */
export const CONVERSATION_WINDOW_MIN = 20;

/** The voice's memory: its own recent turns, and what the analysis last put on screen. */
export async function loadConversationMemory(db: any, subject: string, nowMs: number): Promise<ConversationMemory> {
  const [voice, coach] = await Promise.all([
    db.from("mechabetics_voice_log").select("ts, question, reply").eq("subject", subject)
      .gte("ts", new Date(nowMs - CONVERSATION_WINDOW_MIN * 60000).toISOString())
      .order("ts", { ascending: false }).limit(6),
    db.from("mechabetics_coach_log").select("ts, message").eq("subject", subject)
      .gte("ts", new Date(nowMs - 6 * 3600000).toISOString())
      .order("ts", { ascending: false }).limit(1).maybeSingle(),
  ]);
  const turns = ((voice.data ?? []) as any[]).slice().reverse()
    .map((r) => ({ question: String(r.question ?? ""), reply: String(r.reply ?? "") }));
  const m = /(?:^|\n)(?:Action|Acción) : ([^\n]+)/.exec(String(coach.data?.message ?? ""));
  return {
    turns,
    lastAction: m ? { line: m[1].trim(), at: new Date(coach.data.ts).getTime() } : null,
  };
}

/** Local time offset for this request: the phone's when it sent one, then the last known, then Spain. */
export function tzOffsetOf(body: any, profile: any): number {
  const b = Number(body?.tzOffsetMin);
  if (body?.tzOffsetMin != null && Number.isFinite(b)) return Math.round(b);
  const p = Number(profile?.tz_offset_min);
  return profile?.tz_offset_min != null && Number.isFinite(p) ? p : 60;
}

/** Sugar on record this recently: they are already on it, and the curve has not had time to say so. */
export const RESCUE_QUIET_MIN = 15;
/** A warning about the next hour needs a reading from now, not one that is about to go stale. */
export const WARN_FRESH_MIN = 10;

/** What the monitor sees of the next hour: the forecast, as stored, and a warning when one is due. */
export interface LookAhead {
  row: Record<string, unknown>;
  message: string | null;
}

/**
 * The next hour, from the same state the analysis uses, with nobody needing to open the app. Reads
 * only. A state it cannot read means no warning: without knowing the last one, it would send one every
 * five minutes. `live` is the reading this run got from the sensor: the newest row in the table can be
 * a phone's, and another person's reading has reached it that way before.
 *
 * ONLY THE DEDICATED WARNING IS PUSHED. "What is already in takes him under 70" stays on the screen:
 * replayed on his 52 logged doses it fired on 45 of them, 2.3 times each, and was right 51 % of the time
 * when 29 of the 52 end low anyway. As a push it would mostly say that a dose was given, on top of the
 * volume that was measured.
 */
export async function lookAhead(
  db: any,
  subject: string,
  name: string,
  live: number,
  tzOffsetMin: number,
  nowMs: number,
  url: string,
  key: string,
  drop: FastDrop | null = null,
): Promise<LookAhead | null> {
  const [data, state] = await Promise.all([
    loadEngineData(db, subject, nowMs, [], 6),
    db.from("mechabetics_monitor_state").select("low_warned_at").eq("subject", subject).maybeSingle(),
  ]);
  // Once an hour at most: someone who cannot be fitted yet would otherwise be tried on every run.
  if (nowMs % 3600000 < 300000) refreshModelIfStale(subject, data.modelFittedAt, nowMs, tzOffsetMin, url, key);
  const s = buildState({
    nowMs, lang: "fr", tzOffsetMin, profile: data.profile, readings: data.series,
    insulin: data.insulin, meals: data.meals, activity: data.activity, model: data.model,
  });
  const f = s.forecast;
  if (s.cur == null || Math.abs(s.cur - live) > PHONE_ANCHOR_TOLERANCE) return null;
  const p30 = f?.points.find((p) => p.minutes === 30);
  const p60 = f?.points.find((p) => p.minutes === 60);
  const row = {
    subject,
    made_at: new Date(s.lastTs).toISOString(),
    value_mgdl: live,
    source: f?.source ?? "rule",
    f30: p30?.mgdl ?? null, low30: p30?.low ?? null, high30: p30?.high ?? null,
    f60: p60?.mgdl ?? null, low60: p60?.low ?? null, high60: p60?.high ?? null,
    lowest60: f?.lowest60 ?? null,
    low_risk60: f?.lowRisk60 ?? null,
    low_warning: f?.lowWarning ?? false,
    model_fitted_at: data.modelFittedAt ? new Date(data.modelFittedAt).toISOString() : null,
  };
  const warnedAt = state.data?.low_warned_at ? new Date(state.data.low_warned_at).getTime() : 0;
  const quiet = !!state.error ||
    nowMs - warnedAt < LOW_WARN_SILENCE_MIN * 60000 ||
    (s.minSinceRescue != null && s.minSinceRescue < RESCUE_QUIET_MIN);
  const fresh = nowMs - s.lastTs <= WARN_FRESH_MIN * 60000;
  // Three ways of saying the same thing, one an hour between them: on 62 days the last two add 0.15 message a
  // day to the first, and come before two more lows under 54.
  let message: string | null = null;
  if (!quiet && live >= LOW_MGDL) {
    if (fresh && f?.lowWarning) {
      const odds = f.lowWarningRight != null && slowInsulinDaysLeft(s) == null ? Math.max(1, Math.round(f.lowWarningRight * 10)) : null;
      message = forecastLowMessage(name, live, odds);
    } else if (fresh && drop) {
      message = fastDropMessage(name, live, drop);
    } else {
      const blind = blindFall(data.series, nowMs);
      if (blind) message = blindFallMessage(name, live, blind.ageMin);
    }
  }
  // Nothing forecast and nothing to say: there is no row to keep.
  return f || message ? { row, message } : null;
}

/** Stores what was forecast, for the score, and the warning's time, for the silence. */
export async function recordLookAhead(
  db: any,
  subject: string,
  look: LookAhead,
  warned: boolean,
  nowMs: number,
): Promise<void> {
  // Two runs can see the same reading: a warning sent by the second must not be lost to the first's row.
  const { error } = await db.from("mechabetics_forecast_log")
    .upsert({ ...look.row, warned }, { onConflict: "subject,made_at", ignoreDuplicates: !warned });
  if (error) console.error("engine: forecast not stored:", error.message);
  if (!warned) return;
  // An upsert, with the column that has no default: an update on a missing row would change nothing, and
  // with no date the next run would warn again.
  const { error: stateError } = await db.from("mechabetics_monitor_state")
    .upsert({ subject, last_value: look.row.value_mgdl, low_warned_at: new Date(nowMs).toISOString() });
  if (stateError) console.error("engine: warning time not stored:", stateError.message);
}

/** A model older than this gets refreshed in the background. */
export const MODEL_MAX_AGE_MS = 24 * 3600000;

/** Starts a refit without making anyone wait. The caller's response never depends on it. */
export function refreshModelIfStale(
  subject: string,
  fittedAt: number | null,
  nowMs: number,
  tzOffsetMin: number,
  url: string,
  key: string,
): void {
  if (fittedAt != null && nowMs - fittedAt < MODEL_MAX_AGE_MS) return;
  const work = fetch(`${url}/functions/v1/mechabetics-learn`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ subject, tzOffsetMin }),
  }).then((r) => r.text()).catch((e) => console.error("engine: refit not started:", e?.message ?? e));
  // deno-lint-ignore no-explicit-any
  const rt = (globalThis as any).EdgeRuntime;
  if (rt?.waitUntil) rt.waitUntil(work);
}
