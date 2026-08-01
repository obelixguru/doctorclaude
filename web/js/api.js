// The web client's half of the edge-function contract. Every call here has a twin in the Android
// service layer (ai/AnalysisService.kt, ai/MealsService.kt, ai/ProfileService.kt), and the request
// shapes are copied from it so both clients read and write ONE history.
//
// ── Why no capability token ───────────────────────────────────────────────────────────────────
// The phone claims a token from `mechabetics-claim` and sends it as `x-mechabetics-access`. This
// client deliberately does NOT, for a reason documented in `_shared/access.ts`: claiming ROTATES
// the account's token by DELETING the previous one, so a second install sharing the LibreLinkUp
// account evicts the first device. Claiming here would quietly rotate the child's phone out.
//
// That is safe today because `access.ts` runs with REQUIRE_TOKEN = false (the grace window): a
// request with no token falls back to the body `subject`, which is exactly what this client sends.
// It is also the only thing that works from a browser — the deployed functions do not list
// `x-mechabetics-access` in `Access-Control-Allow-Headers`, so a preflight carrying it would fail.
//
// If REQUIRE_TOKEN is ever flipped to true, this client stops reading data. The fix is the one
// access.ts already names — let an account hold several tokens instead of one — after which this
// file can claim like the phone does, and that header must be added to every function's CORS list.

import { ANON_KEY, FUNCTIONS_BASE } from "./config.js";
import { sha256Hex } from "./util.js";

/** POST JSON to an edge function. Returns the parsed body, or null on any failure. */
async function post(fn, body, { timeoutMs = 45000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${FUNCTIONS_BASE}/${fn}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // Required by the platform gateway, not by our code. Several functions are deployed with
        // JWT verification ON, and without this they answer UNAUTHORIZED_NO_AUTH_HEADER before the
        // handler runs. Same header the Android services send.
        "authorization": `Bearer ${ANON_KEY}`,
        "apikey": ANON_KEY,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      console.warn(`${fn}: HTTP ${res.status}`);
      return null;
    }
    return await res.json();
  } catch (e) {
    console.warn(`${fn}: ${e?.name === "AbortError" ? "timeout" : e?.message ?? e}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** The per-patient key every function is scoped by: sha256(patientId). */
export const subjectOf = (patientId) => sha256Hex(patientId);

// ── LibreLinkUp, via our proxy (a browser cannot reach Abbott directly — no CORS) ──────────────

export const llu = {
  login: (email, password) => post("mechabetics-llu", { action: "login", email, password }),
  connections: (s) => post("mechabetics-llu", { action: "connections", ...s }),
  graph: (s, patientId) => post("mechabetics-llu", { action: "graph", ...s, patientId }),
};

// ── Coach / ask / scan — the AI surface ────────────────────────────────────────────────────────

const readingsPayload = (history, n) =>
  (history ?? []).slice(-n).map((r) => ({ ts: r.ts, value: r.value }));

/**
 * The dashboard's day analysis. `force` bypasses the server's 10-minute cache (an explicit ANALYSE
 * tap should regenerate); `speak` asks for the audio-friendly variant.
 */
export const coach = (subject, history, lang, { speak = false, force = false } = {}) =>
  post("mechabetics-coach", {
    subject,
    readings: readingsPayload(history, 288),
    speak,
    lang,
    ...(force ? { force: true } : {}),
    tzOffsetMin: -new Date().getTimezoneOffset(),
  });

export const ask = (question, subject, history, lang) =>
  post("mechabetics-ask", { question, subject, readings: readingsPayload(history, 288), lang });

/** Photo of a plate or a label → carbs + a dose plan. `imageBase64` is raw base64, no data: prefix. */
export const scan = (imageBase64, subject, history, lang, mime = "image/jpeg") =>
  post("mechabetics-scan", { imageBase64, mime, subject, readings: readingsPayload(history, 12), lang });

export const history = (subject, days = 14, lang = "fr") =>
  post("mechabetics-history", { subject, days, lang });

export const diet = (subject, lang = "fr", days = 7) =>
  post("mechabetics-diet", { subject, lang, days });

export const autotune = (subject, lang = "fr") =>
  post("mechabetics-autotune", { subject, lang });

// ── Meals & insulin ───────────────────────────────────────────────────────────────────────────

const meal = (fn) => (subject, extra) => post("mechabetics-meals", { action: fn, subject, ...extra });

export const meals = {
  list: (subject) => meal("list")(subject, {}),

  /** Eaten already. `carbsG` is PER UNIT — the server multiplies by `quantity`. */
  add: (subject, { description, carbsG, quantity = 1, ts, lang = "fr" }) =>
    meal("add")(subject, {
      meal: { description, planned: false, quantity, ...(carbsG != null ? { carbsG } : {}), ...(ts ? { ts } : {}) },
      lang,
    }),

  /** About to eat — the prospective question ("if I eat this, how much insulin?"). `ts` in the
   *  future moves the injection time, not the arithmetic. */
  plan: (subject, { description, carbsG, quantity = 1, ts, lang = "fr" }) =>
    meal("plan")(subject, {
      meal: { description, quantity, ...(carbsG != null ? { carbsG } : {}), ...(ts ? { ts } : {}) },
      lang,
    }),

  update: (subject, id, { description, carbsG, quantity = 1, ts, lang = "fr" }) =>
    meal("update")(subject, {
      id,
      meal: { description, quantity, ...(carbsG != null ? { carbsG } : {}), ...(ts ? { ts } : {}) },
      lang,
    }),

  remove: (subject, id) => meal("delete")(subject, { id }),

  addInsulin: (subject, { units, name, kind = "rapid", ts }) =>
    meal("addInsulin")(subject, {
      insulin: { units, kind: kind === "basal" ? "basal" : "rapid", ...(name ? { name } : {}), ...(ts ? { ts } : {}) },
    }),

  updateInsulin: (subject, id, { units, name, kind = "rapid", ts }) =>
    meal("updateInsulin")(subject, {
      id,
      insulin: { units, kind: kind === "basal" ? "basal" : "rapid", ...(name ? { name } : {}), ...(ts ? { ts } : {}) },
    }),

  removeInsulin: (subject, id) => meal("deleteInsulin")(subject, { id }),
};

// ── Profile ───────────────────────────────────────────────────────────────────────────────────

export const profile = {
  load: (subject) => post("mechabetics-profile", { action: "load", subject }),
  save: (subject, fields) => post("mechabetics-profile", { action: "save", subject, profile: fields }),
};
