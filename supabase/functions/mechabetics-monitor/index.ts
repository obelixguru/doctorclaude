import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { Resvg, initWasm } from "https://esm.sh/@resvg/resvg-wasm@2.6.2";
import { buildGlucoseSvg } from "../_shared/glucoseChart.ts";

// ── 24/7 hypo/hyper monitor for Mechabetics ──────────────────────────────
// Logs into LibreLinkUp (follower creds in secrets), reads the latest value, and
// alerts the Telegram GROUP only when glucose crosses a NEW multiple-of-10 step
// vs the LAST reading we saw — remembered in `mechabetics_monitor_state`, so there
// are no repeats within the same ten (the old "stateless" version compared against
// a stale graph point and re-alerted every run). Plus one "back to normal" when it
// crosses back over LOW (70) / HIGH (170) after being red. Secrets: MECHABETICS_*.

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

// True if a multiple-of-10 boundary lies between the two readings.
function tensCrossed(a: number, b: number): boolean {
  return Math.floor(a / 10) !== Math.floor(b / 10);
}

// Alert only on a NEW 10 mg/dL step while out of range, + "back to normal" on return.
function alertFor(prev: number, cur: number): string | null {
  if (prev < LOW && cur >= LOW && cur <= HIGH) return `✅ <b>Glycémie de Ryan revenue à la normale</b> : ${cur} mg/dL`;
  if (prev > HIGH && cur <= HIGH && cur >= LOW) return `✅ <b>Glycémie de Ryan revenue à la normale</b> : ${cur} mg/dL`;
  if (cur < LOW && tensCrossed(prev, cur)) {
    if (cur <= VERY_LOW) return `🚨 <b>Glycémie de Ryan : ${cur} mg/dL — TRÈS BASSE</b>\nResucrage immédiat (15 g de sucre rapide).`;
    return `🔻 <b>Glycémie de Ryan : ${cur} mg/dL — basse</b>`;
  }
  if (cur > HIGH && tensCrossed(prev, cur)) {
    return `🔺 <b>Glycémie de Ryan : ${cur} mg/dL — haute</b>`;
  }
  return null;
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
    const patient = conn?.data?.[0];
    if (!patient?.patientId) return new Response("no patient shared");

    const g = await (await fetch(`https://${s.host}/llu/connections/${patient.patientId}/graph`, { headers: auth })).json();
    const arr: number[] = (g?.data?.graphData ?? [])
      .map((x: any) => Number(x.ValueInMgPerDl))
      .filter((n: number) => n > 0);
    const live = g?.data?.connection?.glucoseMeasurement?.ValueInMgPerDl;
    if (live) arr.push(Number(live));
    if (!arr.length) return new Response("no reading");

    const cur = arr[arr.length - 1];
    const subject = await sha256hex(patient.patientId);

    // Build the chart series for the Telegram image so it MATCHES the in-app homepage
    // graph: the same 24 h window, sourced from the persisted readings (continuous even
    // when the app is closed) PLUS this run's LibreLinkUp graph + live point, deduped to
    // 5-min buckets. FactoryTimestamp is the true UTC time; drop any future-dated point.
    // tsOf/liveM are reused by the persistence block below.
    const tsOf = (x: any): string => (x?.FactoryTimestamp ?? x?.Timestamp ?? "");
    const liveM = g?.data?.connection?.glucoseMeasurement;
    const nowMs0 = Date.now();
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

    // On-demand helpers (no state change, no alert logic):
    //   ?preview  → returns the rendered PNG directly (for eyeballing the image)
    //   ?selftest → sends ONE test image to the group, so the parent can confirm the pipeline
    const params = new URL(req.url).searchParams;
    if (params.has("preview")) {
      const png = await renderGraphPng(chartPoints, tzMin);
      if (!png) return new Response("preview: render unavailable", { status: 500 });
      return new Response(png, { headers: { "content-type": "image/png" } });
    }
    if (params.has("selftest")) {
      const png = await renderGraphPng(chartPoints, tzMin);
      if (!png) return new Response("selftest: render unavailable");
      const ok = await telegramPhoto(png, `🧪 <b>Test Mechabetics</b> — graphe glycémie (actuel ${cur} mg/dL)`);
      return new Response(ok ? "selftest: photo sent" : "selftest: photo FAILED");
    }

    // Compare against the ACTUAL previous reading (remembered), not a stale graph
    // point — this is what stops the repeated alerts.
    const { data: st, error: stErr } = await db
      .from("mechabetics_monitor_state")
      .select("last_value")
      .eq("subject", subject)
      .maybeSingle();
    if (stErr) {
      // A DB read blip — NOT the same as "no prior state". Log it so the 100-default
      // fallback below (which can cause a harmless duplicate alert) is explainable in
      // the logs instead of looking like a silent first run.
      console.error(`monitor_state read failed — ${stErr.message ?? stErr}`);
    }
    const prev = st?.last_value ?? 100; // mid-normal anchor on first run OR on a read blip (logged above)

    const msg = alertFor(prev, cur);

    await db.from("mechabetics_monitor_state").upsert({
      subject,
      last_value: cur,
      updated_at: new Date().toISOString(),
    });

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

    if (msg) {
      // Prefer the image (curve + caption); fall back to plain text so a render or
      // sendPhoto failure never costs us the alert. A rare duplicate (photo landed but
      // its response read failed) is acceptable — a missed hypo/hyper alert is not.
      const png = await renderGraphPng(chartPoints, tzMin);
      let sent = png ? await telegramPhoto(png, msg) : false;
      if (!sent) sent = await telegram(msg);
      // Distinguish a delivered alert from a dropped one so a vanished hypo/hyper push
      // shows up in the cron's return string (and logs), not just silently in Telegram.
      return new Response(sent ? `alert ${cur} (prev ${prev})${png ? " +img" : ""}` : `alert-SEND-FAILED ${cur} (prev ${prev})`);
    }
    return new Response(`ok ${cur} (prev ${prev})`);
  } catch (e) {
    return new Response(`err ${(e as Error)?.message ?? e}`);
  }
});
