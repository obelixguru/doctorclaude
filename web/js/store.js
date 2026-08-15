// Application state: the LibreLinkUp session, who we are following, the readings, and the user's
// settings. Plus the poll loop that keeps the glucose current and decides when to raise an alert.

import { FRESHNESS_WINDOW_MS, REFRESH_MS, STORAGE_KEY } from "./config.js";
import * as api from "./api.js";
import { setLang } from "./i18n.js";
import { zoneAlert } from "./zones.js";

/**
 * What survives a reload, in localStorage.
 *
 * The LibreLinkUp TOKEN is kept; the PASSWORD deliberately is not. The Android app stores both
 * (CredentialsStore) so it can silently re-login from a background service — a web page has no
 * background to re-login from, so keeping the password would buy nothing and would leave a reusable
 * credential sitting in storage. When the token expires the login screen simply comes back.
 */
const DEFAULTS = {
  session: null,          // { token, region, accountIdHash }
  patients: [],           // [{ patientId, firstName, lastName }]
  activePatientId: null,
  lang: "fr",
  consented: false,
  settings: {
    soundEnabled: true,
    volumePct: 80,
    hypoEnabled: true,
    hyperEnabled: true,
    hypoAlwaysSounds: true,   // a low pierces quiet hours by default — the dangerous direction is not muted by a clock
    quietHoursEnabled: false,
    quietStartMin: 22 * 60,
    quietEndMin: 7 * 60,
    voiceEnabled: true,
  },
};

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return structuredClone(DEFAULTS);
    const saved = JSON.parse(raw);
    return { ...structuredClone(DEFAULTS), ...saved, settings: { ...DEFAULTS.settings, ...(saved.settings ?? {}) } };
  } catch {
    return structuredClone(DEFAULTS);
  }
}

export const state = {
  ...load(),
  // Not persisted — re-fetched on every start so nothing stale is ever presented as live.
  subject: null,
  current: null,          // { ts, value, trend, isHigh, isLow }
  history: [],            // [{ ts, value }] ascending
  sensorEndMs: null,
  meals: [],              // Food screen: 50 most recent, `tsMs` normalised
  storedMeals: [],        // from history: within the window, used for the chart markers
  insulin: [],            // from history: [{ id, ts, units, name, kind }]
  storedReadings: [],     // from history: the persisted (continuous) series
  analyses: [],           // past coach reports
  stats: null,            // { avg, tir, high, low } — plain DB aggregates, not AI
  profile: null,
  lastError: null,
  loading: false,
  activeAlert: null,      // { zone, reason, severe, value } while an alarm is showing
};

setLang(state.lang);

export function persist() {
  const { session, patients, activePatientId, lang, consented, settings } = state;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ session, patients, activePatientId, lang, consented, settings }));
  } catch (e) {
    console.warn("persist failed", e);
  }
}

// ── Subscriptions: screens re-render when something they show has changed ──────────────────────

const listeners = new Set();
export const subscribe = (fn) => (listeners.add(fn), () => listeners.delete(fn));
export const emit = () => listeners.forEach((fn) => { try { fn(); } catch (e) { console.error(e); } });

export function set(patch) {
  Object.assign(state, patch);
  emit();
}

// ── Session ───────────────────────────────────────────────────────────────────────────────────

export async function login(email, password) {
  const r = await api.llu.login(email, password);
  if (!r) return { ok: false, reason: "network" };
  if (!r.ok) return { ok: false, reason: r.error === "invalid_credentials" ? "bad" : r.error === "rate_limited" ? "rate" : "network" };
  state.session = { token: r.token, region: r.region ?? null, accountIdHash: r.accountIdHash };
  persist();
  const conns = await refreshPatients();
  if (!conns.ok) return conns;
  return { ok: true };
}

export function logout() {
  state.session = null;
  state.patients = [];
  state.activePatientId = null;
  state.subject = null;
  state.current = null;
  state.history = [];
  state.meals = [];
  state.insulin = [];
  state.profile = null;
  persist();
  emit();
}

export async function refreshPatients() {
  if (!state.session) return { ok: false, reason: "no_session" };
  const r = await api.llu.connections(state.session);
  if (!r?.ok) {
    if (r?.needsLogin) { logout(); return { ok: false, reason: "expired" }; }
    // Recorded so the dashboard can SAY the server is unreachable. Without this the screen shows
    // "En attente de mesures…", which reads as "the sensor is quiet" — a very different thing from
    // "this app cannot reach anything", and the one the reader most needs told apart.
    state.lastError = r?.error ?? "network";
    emit();
    return { ok: false, reason: "network" };
  }
  state.lastError = null;
  // The proxy reports the region it ended up on; remembering it skips the redirect next time.
  if (r.region !== undefined) state.session.region = r.region;
  state.patients = r.patients ?? [];
  if (!state.patients.length) return { ok: false, reason: "no_patient" };
  if (!state.patients.some((p) => p.patientId === state.activePatientId)) {
    state.activePatientId = state.patients[0].patientId;
  }
  await setPatient(state.activePatientId);
  return { ok: true };
}

export async function setPatient(patientId) {
  state.activePatientId = patientId;
  state.subject = await api.subjectOf(patientId);
  // Another person's numbers must never linger on screen through a switch.
  state.current = null;
  state.history = [];
  state.meals = [];
  state.storedMeals = [];
  state.insulin = [];
  state.storedReadings = [];
  state.analyses = [];
  state.stats = null;
  state.profile = null;
  lastAlertValue = null;
  persist();
  emit();
}

export const activePatient = () =>
  state.patients.find((p) => p.patientId === state.activePatientId) ?? null;

// ── Freshness ─────────────────────────────────────────────────────────────────────────────────

/** Is the current reading recent enough to BE the current glucose? Everything that presents a
 *  number as live — and every alarm — is gated on this. */
export const isFresh = () =>
  state.current != null && Date.now() - state.current.ts <= FRESHNESS_WINDOW_MS;

export const sensorExpired = () =>
  state.sensorEndMs != null && Date.now() > state.sensorEndMs;

// ── Poll loop ─────────────────────────────────────────────────────────────────────────────────

let timer = null;
let lastAlertValue = null;

export async function refreshGlucose() {
  if (!state.session || !state.activePatientId) return;
  const r = await api.llu.graph(state.session, state.activePatientId);
  if (!r?.ok) {
    if (r?.needsLogin) { logout(); return; }
    state.lastError = r?.error ?? "network";
    emit();
    return;
  }
  if (r.region !== undefined) state.session.region = r.region;
  state.lastError = null;
  state.current = r.current ?? null;
  state.history = r.history ?? [];
  state.sensorEndMs = r.sensorEndMs ?? null;

  evaluateAlert();
  emit();
}

/**
 * Decide whether this new reading should raise the in-page alarm, using the SAME rules as the
 * server monitor and the Android app (see zones.js).
 *
 * A stale reading never alerts: an alarm is a claim about the glucose RIGHT NOW, and a 40-minute-old
 * number cannot make it.
 */
function evaluateAlert() {
  if (!isFresh() || !state.current) return;
  const v = state.current.value;
  const prev = lastAlertValue;
  lastAlertValue = v;
  if (prev == null) return;   // first reading of the session: nothing to compare against

  const a = zoneAlert(prev, v);
  if (!a || a.reason === "recovery") {
    if (a?.reason === "recovery") state.activeAlert = null;
    return;
  }
  const isLow = a.zone === "red_low";
  const isHigh = a.zone === "red_high";
  if (isLow && !state.settings.hypoEnabled) return;
  if (isHigh && !state.settings.hyperEnabled) return;
  if (!isLow && !isHigh) return;   // amber bands are shown, never sounded
  state.activeAlert = { ...a, value: v };
}

export const dismissAlert = () => set({ activeAlert: null });

/** True when the user's quiet window is in force for this alert type. Mirrors AlarmPolicy.kt:
 *  a hypo pierces the window by default; everything else is silenced inside it. */
export function quieted(zone) {
  const s = state.settings;
  if (!s.quietHoursEnabled) return false;
  if (zone === "red_low" && s.hypoAlwaysSounds) return false;
  const now = new Date();
  const m = now.getHours() * 60 + now.getMinutes();
  const { quietStartMin: a, quietEndMin: b } = s;
  if (a === b) return false;
  return a < b ? m >= a && m < b : m >= a || m < b;
}

export function startPolling() {
  stopPolling();
  refreshGlucose();
  timer = setInterval(refreshGlucose, REFRESH_MS);
  // A phone screen that has been off does not run timers. Catching up on wake is what stops the
  // dashboard showing a number from half an hour ago as if it were current.
  document.addEventListener("visibilitychange", onVisible);
}

function onVisible() {
  if (document.visibilityState === "visible") refreshGlucose();
}

export function stopPolling() {
  if (timer) clearInterval(timer);
  timer = null;
  document.removeEventListener("visibilitychange", onVisible);
}

// ── Server-side data (shared with the phone) ───────────────────────────────────────────────────

/**
 * The Food screen's list: the 50 most recent meals.
 *
 * `mechabetics-meals` action=list returns `ts` as the raw DB timestamp STRING, unlike
 * `mechabetics-history`, which converts to epoch ms. Normalising here means every screen downstream
 * can assume `tsMs` and nothing has to remember which endpoint a row came from.
 */
export async function loadMeals() {
  if (!state.subject) return;
  const r = await api.meals.list(state.subject);
  state.meals = (r?.meals ?? []).map((m) => ({ ...m, tsMs: Date.parse(m.ts) }));
  emit();
}

/**
 * Readings, past analyses, insulin doses, meals and the 24 h stats — one call.
 *
 * The stats are plain DB aggregates, not AI, so the average and the time-in-range bar work even
 * when the coach is unavailable (mechabetics-history/index.ts:108).
 */
export async function loadHistory(days = 14) {
  if (!state.subject) return;
  const r = await api.history(state.subject, days, state.lang);
  if (!r) return;
  state.analyses = r.analyses ?? [];
  state.insulin = r.insulin ?? [];
  state.storedMeals = r.meals ?? [];
  state.stats = Array.isArray(r.stats) ? r.stats[0] ?? null : r.stats ?? null;
  state.storedReadings = r.readings ?? [];
  emit();
}

export async function loadProfile() {
  if (!state.subject) return;
  const r = await api.profile.load(state.subject);
  state.profile = r?.profile ?? null;
  emit();
}
