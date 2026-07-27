import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { Resvg, initWasm } from "https://esm.sh/@resvg/resvg-wasm@2.6.2";
import { buildGlucoseSvg } from "../_shared/glucoseChart.ts";

// ── 24/7 hypo/hyper monitor for Mechabetics ──────────────────────────────
// Logs into LibreLinkUp (follower creds in secrets), reads the latest value, and alerts the Telegram
// GROUP once per hypo/hyper EPISODE — plus a re-alert only when it crosses a new 50 mg/dL palier
// further out of range (…, 250, 300…) and one "back to normal" on recovery. The episode is remembered
// in `mechabetics_monitor_state` (alert_kind + alert_value), so a value oscillating around a threshold
// no longer re-alerts every 5-min run (the old "multiple-of-10 step" logic stormed the parent). See
// decideEpisode below. Secrets: MECHABETICS_*.

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

const LLU_EMAIL = Deno.env.get("MECHABETICS_LLU_EMAIL") ?? "";
const LLU_PASSWORD = Deno.env.get("MECHABETICS_LLU_PASSWORD") ?? "";
const TG_TOKEN = Deno.env.get("MECHABETICS_TELEGRAM_BOT_TOKEN") ?? "";
const TG_CHAT = Deno.env.get("MECHABETICS_TELEGRAM_CHAT_ID") ?? "";
const LOW = Number(Deno.env.get("MECHABETICS_LOW") ?? "70"); // hypo floor (normal range = LOW..HIGH)
// Default aligned to the in-app HIGH (180). NOTE: the LIVE value is the MECHABETICS_HIGH secret,
// currently 240 — i.e. the parent's Telegram high-alert only fires above 240, NOT 180. Change the
// secret (not just this default) if you want the push alert to match the app's 180 threshold.
const HIGH = Number(Deno.env.get("MECHABETICS_HIGH") ?? "180"); // hyper ceiling (see note above)
const VERY_LOW = Number(Deno.env.get("MECHABETICS_VERY_LOW") ?? "50"); // 🚨 wording below this
// Hysteresis: once an episode has alerted, we only re-arm (and announce "back to normal") after the
// glucose comes this far back INSIDE the range — a value hovering at the threshold can't flip-flop and
// re-alert. Mirrors GlucoseAlert.RECOVERY_MARGIN in the app.
const RECOVERY_MARGIN = 15;
// Re-alert while STILL out of range only when a new multiple-of-PALIER boundary is crossed FURTHER out
// (…, 250, 300, 350 for a high) — the user's "que si ça passe un palier de 50".
const PALIER = 50;
// A worsening LOW escalates on a FINER grid than a high. Below the severe floor (50) the 50-palier
// gives no further step — 0..49 is one band — so a crash 48→30→18 would go SILENT after the first
// "TRÈS BASSE". A hypo is the acute emergency, so a LOW re-alerts on each further HYPO_ESCALATE_DROP
// drop (and the first time it crosses into severe), all the way down.
const HYPO_ESCALATE_DROP = 15;

function H(extra: Record<string, string> = {}) {
  return {
    "content-type": "application/json",
    "product": "llu.android",
    "version": "4.16.0",
    "accept": "application/json",
    ...extra,
  };
}

async function sha256hex(s: string): Promise<string> {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

// Sends the parent's hypo/hyper alert to the Telegram group. Returns true ONLY if
// Telegram accepted the message; false (after logging status+body) if it was lost to
// a missing/expired bot token, a rate-limit, or a transient 5xx. NEVER swallows — a
// vanished alert must be visible in the edge-function logs and in the caller's return
// string. ONE retry on a transient 429/5xx with a short backoff; other 4xx (e.g. 401
// bad token) are not retried because they cannot self-heal.
async function telegram(text: string): Promise<boolean> {
  if (!TG_TOKEN || !TG_CHAT) {
    console.error("telegram: missing bot token or chat id — alert NOT sent");
    return false;
  }
  const url = `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`;
  const body = JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: "HTML" });
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      if (r.ok) return true;
      const detail = (await r.text().catch(() => "")).slice(0, 300);
      console.error(`telegram: HTTP ${r.status} on attempt ${attempt}/2 — ${detail}`);
      // Retry only transient failures; a 4xx like 401 (bad token) won't fix itself.
      if (attempt === 1 && (r.status === 429 || r.status >= 500)) { await sleep(600); continue; }
      return false;
    } catch (e) {
      // Network-level failure (DNS/TLS/timeout): retry once, then give up — logged either way.
      console.error(`telegram: fetch threw on attempt ${attempt}/2 — ${(e as Error)?.message ?? e}`);
      if (attempt === 1) { await sleep(600); continue; }
      return false;
    }
  }
  return false;
}

// ── Glucose chart image for the alert ────────────────────────────────────
// resvg-wasm rasterises our hand-built SVG to a PNG so the parent sees the CURVE,
// not just a number. The wasm is fetched + initialised ONCE per isolate (cached
// promise; cleared on failure so a transient CDN blip can retry next run). Every
// path here is best-effort: any failure returns null and the caller falls back to
// the plain-text alert — an image must NEVER cost us a delivered alert.
// Local-time offset (minutes) for a tz at instant t, computed via Intl — Deno runs in
// UTC, so we can't rely on getTimezoneOffset(). Used to label the x-axis in Paris time.
function tzOffsetMinFor(tz: string, t: number): number {
  try {
    const d = new Date(t);
    const utc = new Date(d.toLocaleString("en-US", { timeZone: "UTC" }));
    const loc = new Date(d.toLocaleString("en-US", { timeZone: tz }));
    return Math.round((loc.getTime() - utc.getTime()) / 60000);
  } catch (_) {
    return 0;
  }
}

let resvgReady: Promise<void> | null = null;
let fontBytes: Uint8Array | null = null; // Inter Regular, for axis labels (resvg ships no fonts)
function ensureResvg(): Promise<void> {
  if (!resvgReady) {
    resvgReady = (async () => {
      const [wasmRes, fontRes] = await Promise.all([
        fetch("https://unpkg.com/@resvg/resvg-wasm@2.6.2/index_bg.wasm"),
        fetch("https://cdn.jsdelivr.net/npm/@expo-google-fonts/inter/Inter_400Regular.ttf"),
      ]);
      if (!wasmRes.ok) throw new Error(`wasm fetch HTTP ${wasmRes.status}`);
      await initWasm(await wasmRes.arrayBuffer());
      // Font is best-effort: without it the chart still renders, just without labels.
      if (fontRes.ok) fontBytes = new Uint8Array(await fontRes.arrayBuffer());
      else console.error(`font fetch HTTP ${fontRes.status} — axis labels will be missing`);
    })().catch((e) => { resvgReady = null; throw e; });
  }
  return resvgReady;
}

async function renderGraphPng(points: { t: number; v: number }[], tzOffsetMin: number): Promise<Uint8Array | null> {
  try {
    if (points.length < 2) return null; // nothing meaningful to draw
    await ensureResvg();
    const svg = buildGlucoseSvg(points, { tzOffsetMin });
    const o: Record<string, unknown> = { background: "white", fitTo: { mode: "width", value: 800 } };
    if (fontBytes) o.font = { fontBuffers: [fontBytes], loadSystemFonts: false, defaultFontFamily: "Inter" };
    return new Resvg(svg, o).render().asPng();
  } catch (e) {
    console.error(`graph render failed — ${(e as Error)?.message ?? e}`);
    return null;
  }
}

// sendPhoto twin of telegram(): same retry/log discipline, multipart upload of the
// PNG with the alert text as the (HTML) caption. Returns true only if Telegram
// accepted it; false (logged) on a missing token, rate-limit, or transient 5xx.
async function telegramPhoto(png: Uint8Array, caption: string): Promise<boolean> {
  if (!TG_TOKEN || !TG_CHAT) {
    console.error("telegramPhoto: missing bot token or chat id — photo NOT sent");
    return false;
  }
  const url = `https://api.telegram.org/bot${TG_TOKEN}/sendPhoto`;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const form = new FormData();
      form.append("chat_id", TG_CHAT);
      form.append("caption", caption);
      form.append("parse_mode", "HTML");
      form.append("photo", new Blob([png], { type: "image/png" }), "glucose.png");
      const r = await fetch(url, { method: "POST", body: form });
      if (r.ok) return true;
      const detail = (await r.text().catch(() => "")).slice(0, 300);
      console.error(`telegramPhoto: HTTP ${r.status} on attempt ${attempt}/2 — ${detail}`);
      if (attempt === 1 && (r.status === 429 || r.status >= 500)) { await sleep(600); continue; }
      return false;
    } catch (e) {
      console.error(`telegramPhoto: fetch threw on attempt ${attempt}/2 — ${(e as Error)?.message ?? e}`);
      if (attempt === 1) { await sleep(600); continue; }
      return false;
    }
  }
  return false;
}

// ── Alert de-spam: ONE alert per hypo/hyper EPISODE, a re-alert ONLY when it gets meaningfully WORSE
//    (a new 50-palier for a high — 250, 300, 350; each further ~15 mg/dL for a low, which stays finer
//    so a worsening hypo keeps escalating), and ONE "back to normal" on recovery. Replaces the old
//    "re-alert on every 10 mg/dL wobble" that stormed the
//    parent's Telegram every 5 min ("les notifs insupportables"). State lives in
//    mechabetics_monitor_state: alert_kind = the episode we're in, alert_value = the glucose at the
//    last alert (so we can tell whether a NEW palier was crossed). `name` is the patient's OWN first
//    name (from LibreLinkUp) so an account following several people never mislabels a value.
type EpisodeKind = "LOW" | "HIGH";
const bandOf = (v: number): number => Math.floor(v / PALIER);

function alertMessage(kind: EpisodeKind, cur: number, name: string): string {
  if (kind === "LOW") {
    if (cur <= VERY_LOW) return `🚨 <b>Glycémie de ${name} : ${cur} mg/dL — TRÈS BASSE</b>\nResucrage immédiat (15 g de sucre rapide).`;
    return `🔻 <b>Glycémie de ${name} : ${cur} mg/dL — basse</b>`;
  }
  return `🔺 <b>Glycémie de ${name} : ${cur} mg/dL — haute</b>`;
}

interface EpisodeDecision {
  message: string | null;           // text to push (null = stay silent this run)
  alertKind: EpisodeKind | null;    // episode state to persist (null = in range / recovered)
  alertValue: number;               // glucose at the last alert (for the next run's palier compare)
}

// Pure decision from the latest value + the persisted episode state: what (if anything) to push, and
// what episode state to persist. No repeats within the same palier; a worsening palier re-alerts;
// recovery is announced once (with hysteresis so a value at the edge can't re-arm and spam).
function decideEpisode(cur: number, name: string, prevKind: string | null, prevAlertValue: number): EpisodeDecision {
  const curKind: EpisodeKind | null = cur < LOW ? "LOW" : cur > HIGH ? "HIGH" : null;

  if (curKind === null) {
    // Back in range. If no episode was open, nothing to do.
    if (prevKind !== "LOW" && prevKind !== "HIGH") return { message: null, alertKind: null, alertValue: 0 };
    // Re-arm + announce "back to normal" ONCE, but only after coming clearly back inside the range
    // (hysteresis) so a value hovering at the threshold can't flip-flop and re-alert every run.
    const recovered =
      (prevKind === "HIGH" && cur <= HIGH - RECOVERY_MARGIN) ||
      (prevKind === "LOW" && cur >= LOW + RECOVERY_MARGIN);
    if (recovered) return { message: `✅ <b>Glycémie de ${name} revenue à la normale</b> : ${cur} mg/dL`, alertKind: null, alertValue: 0 };
    // Still settling near the edge — hold the episode open, stay silent.
    return { message: null, alertKind: prevKind, alertValue: prevAlertValue };
  }

  const newEpisode = prevKind !== curKind;
  // Same episode: re-alert only when it gets genuinely WORSE than the value at the LAST alert — so an
  // oscillation that dips back and re-crosses the same level does NOT re-alert. A HIGH steps on the
  // 50-palier grid (250/300/350). A LOW uses a finer grid (each further HYPO_ESCALATE_DROP drop, plus
  // the first crossing into severe) so a worsening hypo keeps escalating all the way down.
  const worse = !newEpisode && (
    (curKind === "HIGH" && bandOf(cur) > bandOf(prevAlertValue)) ||
    (curKind === "LOW" && (
      cur <= prevAlertValue - HYPO_ESCALATE_DROP ||
      (cur <= VERY_LOW && prevAlertValue > VERY_LOW)
    ))
  );
  if (newEpisode || worse) return { message: alertMessage(curKind, cur, name), alertKind: curKind, alertValue: cur };
  // Same episode, no new palier — stay quiet ("on le sait déjà").
  return { message: null, alertKind: curKind, alertValue: prevAlertValue };
}

async function login(): Promise<{ host: string; token: string; uid: string } | null> {
  let host = "api.libreview.io";
  for (let i = 0; i < 3; i++) {
    const r = await fetch(`https://${host}/llu/auth/login`, {
      method: "POST",
      headers: H(),
      body: JSON.stringify({ email: LLU_EMAIL, password: LLU_PASSWORD }),
    });
    const j = await r.json().catch(() => null);
    if (!j?.data) return null;
    if (j.data.redirect && j.data.region) {
      host = `api-${j.data.region}.libreview.io`;
      continue;
    }
    const token = j.data.authTicket?.token;
    const uid = j.data.user?.id;
    if (token && uid) return { host, token, uid };
    return null;
  }
  return null;
}

Deno.serve(async (req) => {
  try {
    if (!LLU_EMAIL || !LLU_PASSWORD) return new Response("missing LLU creds");
    const s = await login();
    if (!s) return new Response("login failed");

    const auth = H({ authorization: `Bearer ${s.token}`, "account-id": await sha256hex(s.uid) });
    const conn = await (await fetch(`https://${s.host}/llu/connections`, { headers: auth })).json();
    const patients: any[] = Array.isArray(conn?.data) ? conn.data : [];
    if (!patients[0]?.patientId) return new Response("no patient shared");

    // Process EVERY followed patient. A single follower account can follow several people (e.g. a
    // parent following two diabetics); each has its OWN subject = sha256(patientId), its OWN state
    // row, its OWN stored readings, and is named by its OWN firstName in the alert — so a value is
    // NEVER pushed under the wrong person's name (the reason we don't just read conn.data[0]).
    // ?preview / ?selftest are debug tools → scoped to the first patient only.
    const params = new URL(req.url).searchParams;
    const debug = params.has("preview") || params.has("selftest");
    const list = debug ? patients.slice(0, 1) : patients;
    const out: string[] = [];
    for (const patient of list) {
      if (!patient?.patientId) continue;
      const res = await processPatient(patient, s, auth, params, patient === patients[0]);
      if (res instanceof Response) return res; // preview/selftest short-circuit (first patient)
      out.push(`${patient.firstName || "?"}=${res}`);
    }
    return new Response(out.join(" | ") || "no patient");
  } catch (e) {
    return new Response(`err ${(e as Error)?.message ?? e}`);
  }
});

// One patient's full pass: sensor-expiry alert, chart build, hypo/hyper EPISODE decision (see
// decideEpisode), and state + readings persistence — keyed by THIS patient's subject and named by THIS
// patient's firstName, so a value is never pushed under the wrong person's name. Returns a short status
// string, or a Response when `isFirst` and ?preview/?selftest is set (those render/send for one patient).
async function processPatient(
  patient: any,
  s: { host: string; token: string; uid: string },
  auth: Record<string, string>,
  params: URLSearchParams,
  isFirst: boolean,
): Promise<string | Response> {
  const name = String(patient.firstName || "").trim() || "Patient";
  try {
  const g = await (await fetch(`https://${s.host}/llu/connections/${patient.patientId}/graph`, { headers: auth })).json();
  const arr: number[] = (g?.data?.graphData ?? [])
    .map((x: any) => Number(x.ValueInMgPerDl))
    .filter((n: number) => n > 0);
  const live = g?.data?.connection?.glucoseMeasurement?.ValueInMgPerDl;
  if (live) arr.push(Number(live));

  const subject = await sha256hex(patient.patientId);
  // tsOf/liveM/nowMs0 are shared by the expiry check, the chart series and the persistence block.
  const tsOf = (x: any): string => (x?.FactoryTimestamp ?? x?.Timestamp ?? "");
  const liveM = g?.data?.connection?.glucoseMeasurement;
  const nowMs0 = Date.now();

    // ── Sensor EXPIRED? ──────────────────────────────────────────────────
    // connection.sensor.a = the sensor's activation time (epoch s); a Libre sensor lives 14 days.
    // Once past expiry AND the readings have stopped, tell the parent ONCE PER SENSOR to put a new
    // one on (the phone app may be dead — this cron is the safety net). The marker lives in
    // mechabetics_monitor_state.expired_notified_at: a NEW sensor pushes sensorEndMs past the
    // marker, re-arming the alert for the next expiry. Runs BEFORE the "no reading" early-return —
    // a long-dead sensor returns an empty graph, which is exactly when this must still fire.
    try {
      const sensA = Number(g?.data?.connection?.sensor?.a) || 0;
      const sensorEndMs = sensA > 0 ? sensA * 1000 + 14 * 24 * 3600 * 1000 : 0;
      const items0: any[] = [...(g?.data?.graphData ?? [])];
      if (liveM) items0.push(liveM);
      const lastTs = items0.reduce((mx: number, x: any) => {
        const t = Date.parse(tsOf(x));
        return Number.isFinite(t) && t > mx ? t : mx;
      }, 0);
      const signalDead = !arr.length || !lastTs || nowMs0 - lastTs > 15 * 60000;
      if (sensorEndMs > 0 && nowMs0 > sensorEndMs && signalDead) {
        const { data: st0 } = await db
          .from("mechabetics_monitor_state")
          .select("expired_notified_at, last_value")
          .eq("subject", subject)
          .maybeSingle();
        const notifiedAt = (st0 as any)?.expired_notified_at ? Date.parse((st0 as any).expired_notified_at) : 0;
        if (!notifiedAt || notifiedAt < sensorEndMs) {
          const sinceMin = lastTs ? Math.round((nowMs0 - lastTs) / 60000) : null;
          const ok = await telegram(
            `🔌 <b>Capteur de ${name} EXPIRÉ</b> — les 14 jours sont atteints${sinceMin != null ? ` (plus de mesure depuis ${sinceMin} min)` : ""}. Il faut poser un NOUVEAU capteur (compter ~1 h de démarrage) ; en attendant, glycémie au doigt.`,
          );
          if (ok) {
            // 🔑 last_value is NOT NULL with no default. Postgres checks NOT NULL on the proposed
            // INSERT tuple BEFORE resolving ON CONFLICT, so an upsert that OMITS last_value fails
            // with a not_null_violation even when the row already exists — and supabase-js returns
            // that as { error } WITHOUT throwing. The old `upsert({ subject, expired_notified_at })`
            // therefore NEVER persisted the marker, so this "once per sensor" alert re-fired on EVERY
            // 5-min run once the sensor passed 14 days (it stormed the parent's Telegram). Always send
            // last_value too (the stored one, else the latest stale reading, else a mid-normal anchor),
            // and surface any write error so a silent failure can't bring the storm back.
            const lv = (st0 as any)?.last_value ?? (arr.length ? arr[arr.length - 1] : 100);
            const { error: markErr } = await db
              .from("mechabetics_monitor_state")
              .upsert({ subject, last_value: lv, expired_notified_at: new Date().toISOString() });
            if (markErr) console.error(`expiry marker upsert failed — ${markErr.message ?? markErr}`);
          }
        }
      }
    } catch (e) {
      console.error(`sensor-expiry check failed — ${(e as Error)?.message ?? e}`);
    }

    if (!arr.length) return "no-reading";
    const cur = arr[arr.length - 1];

    // Build the chart series for the Telegram image so it MATCHES the in-app homepage
    // graph: the same 24 h window, sourced from the persisted readings (continuous even
    // when the app is closed) PLUS this run's LibreLinkUp graph + live point, deduped to
    // 5-min buckets. FactoryTimestamp is the true UTC time; drop any future-dated point.
    const dayAgo = nowMs0 - 24 * 60 * 60 * 1000;
    let stored: { t: number; v: number }[] = [];
    try {
      const { data: rd } = await db
        .from("mechabetics_readings")
        .select("ts,value_mgdl")
        .eq("subject", subject)
        .gte("ts", new Date(dayAgo).toISOString())
        .order("ts", { ascending: true });
      stored = (rd ?? []).map((r: any) => ({ t: Date.parse(r.ts), v: Number(r.value_mgdl) }));
    } catch (_) { /* fall back to the LLU graph alone */ }
    const llu = [...(g?.data?.graphData ?? [])]
      .concat(liveM ? [liveM] : [])
      .map((x: any) => ({ t: Date.parse(tsOf(x)), v: Number(x.ValueInMgPerDl) }));
    const bucket = new Map<number, { t: number; v: number }>();
    for (
      const p of [...stored, ...llu]
        .filter((p) => p.v > 0 && Number.isFinite(p.t) && p.t >= dayAgo && p.t <= nowMs0 + 120000)
        .sort((a, b) => a.t - b.t)
    ) {
      bucket.set(Math.floor(p.t / 300000), p); // 5-min buckets, last (newest) wins
    }
    const chartPoints = [...bucket.values()].sort((a, b) => a.t - b.t);
    const tzMin = tzOffsetMinFor("Europe/Paris", nowMs0);

    // On-demand helpers (no state change, no alert logic), FIRST patient only:
    //   ?preview  → returns the rendered PNG directly (for eyeballing the image)
    //   ?selftest → sends ONE test image to the group, so the parent can confirm the pipeline
    if (isFirst && params.has("preview")) {
      const png = await renderGraphPng(chartPoints, tzMin);
      if (!png) return new Response("preview: render unavailable", { status: 500 });
      return new Response(png, { headers: { "content-type": "image/png" } });
    }
    if (isFirst && params.has("selftest")) {
      const png = await renderGraphPng(chartPoints, tzMin);
      if (!png) return new Response("selftest: render unavailable");
      const ok = await telegramPhoto(png, `🧪 <b>Test Mechabetics</b> — ${name} (actuel ${cur} mg/dL)`);
      return new Response(ok ? "selftest: photo sent" : "selftest: photo FAILED");
    }

    // Read the EPISODE state we persisted last run (which out-of-range episode we're already alerting
    // for, and the glucose at that last alert) — the memory that turns "alert on every reading" into
    // "alert once per episode + on each new 50-palier".
    const { data: st, error: stErr } = await db
      .from("mechabetics_monitor_state")
      .select("alert_kind, alert_value")
      .eq("subject", subject)
      .maybeSingle();
    if (stErr) {
      // A DB read blip — log it so an unexpected (harmless) duplicate alert is explainable in the
      // logs instead of looking like a silent first run.
      console.error(`monitor_state read failed — ${stErr.message ?? stErr}`);
    }
    const prevKind = ((st as any)?.alert_kind as string | null) ?? null;
    const prevAlertValue = Number((st as any)?.alert_value) || 0;

    const decision = decideEpisode(cur, name, prevKind, prevAlertValue);

    // Persist last_value (NOT NULL → always sent) + the possibly-updated episode state every run. When
    // the decision is "stay silent" the episode fields are written back unchanged, so the episode is
    // remembered across runs. (An upsert only overwrites the columns it names, so the sensor-expiry
    // marker written above is untouched.)
    const { error: stateErr } = await db.from("mechabetics_monitor_state").upsert({
      subject,
      last_value: cur,
      updated_at: new Date().toISOString(),
      alert_kind: decision.alertKind,
      alert_value: decision.alertValue,
    });
    if (stateErr) console.error(`monitor_state upsert failed — ${stateErr.message ?? stateErr}`);

    // Persist the fetched readings so the cloud history stays CONTINUOUS even when the app isn't
    // open — the app only saves while running, which left multi-day holes in the advanced view.
    // Use the UTC FactoryTimestamp (Deno runs in UTC) to match how the app stores points; dedupe
    // on (subject, ts). Each 5-min run also re-stores the last ~12 h, so a missed run self-heals.
    try {
      const nowMs = Date.now();
      // LibreLinkUp's FactoryTimestamp IS the true UTC time (the `Timestamp` field is the patient's
      // LOCAL time with no TZ marker — parsing THAT as UTC is what put readings in the "future").
      // FactoryTimestamp parses correctly in Deno's UTC runtime AND preserves a stale reading's real
      // age, so the app's "signal lost" keeps working. Drop any future-dated point as a safety net.
      // (tsOf/liveM are declared once near `cur`, above, and reused here.)
      const items: any[] = [...(g?.data?.graphData ?? [])];
      if (liveM) items.push(liveM);
      const rows = items
        .map((x) => ({ t: Date.parse(tsOf(x)), v: Number(x.ValueInMgPerDl) }))
        .filter((r) => r.v > 0 && Number.isFinite(r.t) && r.t <= nowMs + 120000)
        .map((r) => ({ subject, ts: new Date(r.t).toISOString(), value_mgdl: Math.round(r.v) }));
      if (rows.length) {
        await db.from("mechabetics_readings").upsert(rows, { onConflict: "subject,ts", ignoreDuplicates: true });
      }
    } catch (_) { /* persistence is best-effort; never block alerting */ }

    if (decision.message) {
      const msg = decision.message;
      // Prefer the image (curve + caption); fall back to plain text so a render or
      // sendPhoto failure never costs us the alert. A rare duplicate (photo landed but
      // its response read failed) is acceptable — a missed hypo/hyper alert is not.
      const png = await renderGraphPng(chartPoints, tzMin);
      let sent = png ? await telegramPhoto(png, msg) : false;
      if (!sent) sent = await telegram(msg);
      // Distinguish a delivered alert from a dropped one so a vanished hypo/hyper push
      // shows up in the cron's return string (and logs), not just silently in Telegram.
      const tag = decision.alertKind ?? "recover";
      return sent ? `alert ${cur} (${tag})${png ? " +img" : ""}` : `alert-SEND-FAILED ${cur} (${tag})`;
    }
    return `ok ${cur} (${decision.alertKind ?? "in-range"})`;
  } catch (e) {
    // One patient's failure must not abort the others — return an error string, keep looping.
    return `err(${name}): ${(e as Error)?.message ?? e}`;
  }
}
