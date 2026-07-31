import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { accessSubject } from "../_shared/access.ts";
import {
  computeGuard,
  STALE_MIN,
  trendFromReadings,
  recentHypoFrom,
  activeIob,
  insulinActionMinutes,
  mealBolusUnits,
  mealBolusHeldByIob,
  mealBolusHeldLine,
  combinedActionLine,
  situationHint,
  minutesSinceLastRescue,
  stripInsulinNumbers,
  enforceInsulinCeiling,
  carbsCubesPhrase,
  carbEstimationRules,
  mealCarbSpeed,
  carbSpeedAdvice,
  starchyCarbNote,
  type GuardProfile,
} from "../_shared/doseGuard.ts";
import { classifyLlmError, llmErrorMessage, type LlmErrorKind } from "../_shared/llm.ts";

// Doctor Claude product scanner (FR/ES). The phone sends a PHOTO of a food product + subject
// hash + recent readings ({ts, value}). A vision model identifies the product and ESTIMATES the
// carbs (a perception task), auto-logs the meal, and writes the wording — but the EXACT INSULIN
// DOSE IS COMPUTED IN CODE by the deterministic guard (_shared/doseGuard.ts): meal bolus
// (carbs / ratio) + correction (minus IOB, blocked when hypo/in-range/falling/stale). The model
// never writes a dose number. api.deepseek.com is text-only, so vision uses Anthropic if its key
// is set, otherwise Gemini. Voice via ElevenLabs.

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

const ANTHROPIC_API_KEY = Deno.env.get("MECHABETICS_ANTHROPIC_API_KEY") ?? "";
const ANTHROPIC_MODEL = Deno.env.get("MECHABETICS_ANTHROPIC_VISION_MODEL") ?? "claude-sonnet-4-6";
const GEMINI_API_KEY = Deno.env.get("MECHABETICS_GEMINI_API_KEY") ?? "";
const GEMINI_MODEL = Deno.env.get("MECHABETICS_GEMINI_VISION_MODEL") ?? "";
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

function buildSystem(lang: string, p: any, cur: number | null, pr: Record<string, string>, hint: string): string {
  // WHERE THE PRODUCT WAS BOUGHT. The recipe follows the market: the same can is 4.6 g per 100 ml in
  // Spain and 10.6 where the classic formula is sold. Without this the model answers for an average
  // country that exists nowhere.
  const country = (p?.country || "").trim();
  const curTxt = cur != null ? `${cur} mg/dL` : (lang === "es" ? "desconocida" : "inconnue");
  const profileBits: string[] = [];
  if (p?.age) profileBits.push(lang === "es" ? `${p.age} años` : `${p.age} ans`);
  if (p?.weight_kg) profileBits.push(`${p.weight_kg} kg`);
  if (p?.rapid_insulin) profileBits.push(lang === "es" ? `insulina rápida ${p.rapid_insulin}` : `insuline rapide ${p.rapid_insulin}`);
  const profileLine = profileBits.length ? profileBits.join(", ") : (lang === "es" ? "sin detalles" : "non renseigné");

  const noNumbers = lang === "es"
    ? `IMPORTANTE — DOSIS: NO escribas ningún número de dosis (unidades, gramos, terrones) en "reply" ni "voice". El sistema calcula y añade la dosis exacta a partir de los carbohidratos que estimes. Tú identificas el producto y estimas los carbohidratos totales en "meal".`
    : `IMPORTANT — DOSE : n'écris AUCUN chiffre de dose (unités, grammes, morceaux) dans "reply" ni "voice". Le système calcule et ajoute la dose exacte à partir des glucides que tu estimes. Toi, tu identifies le produit et estimes les glucides totaux dans "meal".`;

  if (lang === "es") {
    return [
      P(pr, "scan.persona", `Eres Doctor Claude, un asistente de salud directo para alguien con diabetes tipo 1.`),
      `PERFIL: ${profileLine}. GLUCOSA actual: ${curTxt}.`,
      `Recibes la FOTO de un producto alimentario (etiqueta, envase o plato). IDENTIFICACIÓN: nombra EXACTAMENTE lo que VES, según los indicios visuales (forma, textura, relleno, color, texto del envase) — NO lo sustituyas por un primo parecido (un pain au chocolat/napolitana NO es un brioche; un cruasán NO es un pan de leche; una salchicha NO es una merguez). Si el envase muestra un nombre o una tabla nutricional, LÉELA y usa sus carbohidratos (para la porción REAL, no por 100 g). Si dudas entre dos productos, elige el más probable y DI tu duda en "reply". Estima la porción y los carbohidratos totales en gramos y rellena "meal". Sé PRUDENTE con la porción: ante la duda, mejor subestimar, y di en "reply" que es una ESTIMACIÓN a verificar (el usuario puede corregir los carbohidratos). Si no logras identificarlo con seguridad, dilo y pide otra foto más clara.`,
      country ? `PAÍS: la persona está en ${country}. Si reconoces una MARCA, BUSCA su ficha nutricional oficial PARA ESE PAÍS (carbohidratos por 100 g o 100 ml) antes de responder, y multiplícala por la porción que ves. La misma marca no tiene la misma receta en todos los países. Di en "reply" de dónde sale la cifra (etiqueta leída en la foto, ficha oficial, o estimación).` : "",
      carbEstimationRules(lang),
      hint ? `SITUACIÓN (la calcula el sistema): ${hint}.` : "",
      P(pr, "scan.sugar", `Un producto con carbohidratos —aunque sea muy azucarado— se CUBRE con insulina, no se rechaza ni se sustituye. No propongas una "opción más suave" ni moralices.`),
      noNumbers,
      `Responde SOLO en JSON, sin texto alrededor: {"reply":"<qué es y los carbohidratos estimados, en mg/dL, 2-4 frases, SIN número de dosis>","voice":"<una frase, SIN número de dosis; glucosa en mg/dL>","meal":{"description":"<producto>","carbsG":<numero>,"planned":true}|null}`,
    ].filter(Boolean).join(" ");
  }
  return [
    P(pr, "scan.persona", `Tu es Doctor Claude, un assistant santé direct pour une personne qui a un diabète de type 1.`),
    `PROFIL : ${profileLine}. GLYCÉMIE actuelle : ${curTxt}.`,
    `Tu reçois la PHOTO d'un produit alimentaire (étiquette, emballage ou plat). IDENTIFICATION : nomme EXACTEMENT ce que tu VOIS, d'après les indices visuels (forme, texture, garniture, couleur, texte de l'emballage) — NE remplace PAS le produit par un cousin proche (un pain au chocolat N'EST PAS une brioche ; un croissant N'EST PAS un pain au lait ; une saucisse N'EST PAS une merguez). Si l'emballage montre un nom ou un tableau nutritionnel, LIS-LE et utilise ses glucides (pour la portion RÉELLE, pas pour 100 g). Si tu hésites entre deux produits, choisis le plus probable et DIS ton hésitation dans "reply". Estime la portion et les glucides totaux en grammes et remplis "meal". Sois PRUDENT sur la portion : en cas de doute, sous-estime plutôt, et précise dans "reply" que c'est une ESTIMATION à vérifier (l'utilisateur peut corriger les glucides). Si tu ne peux pas l'identifier avec certitude, dis-le et demande une photo plus nette.`,
    country ? `PAYS : la personne est en ${country}. Si tu reconnais une MARQUE, CHERCHE sa fiche nutritionnelle officielle POUR CE PAYS (glucides pour 100 g ou 100 ml) avant de répondre, et multiplie par la portion que tu vois. La même marque n'a pas la même recette selon le pays. Dis dans "reply" d'où vient le chiffre (étiquette lue sur la photo, fiche officielle, ou estimation).` : "",
    carbEstimationRules(lang),
    hint ? `SITUATION (calculée par le système) : ${hint}.` : "",
    P(pr, "scan.sugar", `Un produit glucidique —même très sucré— se COUVRE avec de l'insuline, il ne se refuse pas et ne se remplace pas. Ne propose pas d'"alternative moins sucrée" et ne fais pas la morale.`),
    noNumbers,
    `Réponds UNIQUEMENT en JSON, sans texte autour : {"reply":"<ce que c'est et les glucides estimés, en mg/dL, 2-4 phrases, SANS chiffre de dose>","voice":"<une phrase, SANS chiffre de dose ; glycémie en grammes par litre à la française>","meal":{"description":"<produit>","carbsG":<nombre>,"planned":true}|null}`,
  ].filter(Boolean).join(" ");
}

type VisionResult = { raw?: string; error?: string; kind?: LlmErrorKind; status?: number };

async function anthropicVision(sys: string, userText: string, imageBase64: string, mime: string): Promise<VisionResult> {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 1500,
      system: sys,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: userText },
          { type: "image", source: { type: "base64", media_type: mime, data: imageBase64 } },
        ],
      }],
    }),
  });
  if (!r.ok) { const t = await r.text(); return { error: `Anthropic ${r.status}: ${t.slice(0, 160)}`, kind: classifyLlmError(r.status, t), status: r.status }; }
  const j = await r.json();
  return { raw: (j?.content?.[0]?.text ?? "").trim() };
}

async function geminiVision(sys: string, userText: string, imageBase64: string, mime: string, geminiKey: string): Promise<VisionResult> {
  const candidates = [GEMINI_MODEL, "gemini-2.5-flash-lite", "gemini-flash-lite-latest", "gemini-2.5-flash", "gemini-flash-latest", "gemini-2.5-pro"]
    .filter((m, i, a) => m && a.indexOf(m) === i);
  let lastErr = "Gemini: aucun modèle disponible";
  let lastStatus = 0;
  let lastBody = "";
  for (const model of candidates) {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // SEE THE PRODUCT, THEN LOOK IT UP. Recognising a package is perception; knowing how much
      // carbohydrate is in THAT country's recipe is a fact that belongs in a search, not in a
      // model's memory — a 33 cl 7UP is 16 g in Spain and 35 g where the classic recipe is sold.
      // Grounding cannot be combined with a forced JSON mime type, so the JSON is asked for in the
      // prompt; the retry below drops the tool if the model or account lacks it.
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: sys }] },
        contents: [{ parts: [{ text: userText }, { inline_data: { mime_type: mime, data: imageBase64 } }] }],
        tools: [{ google_search: {} }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 1600 },
      }),
    });
    if (r.ok) {
      const j = await r.json();
      const parts = j?.candidates?.[0]?.content?.parts ?? [];
      return { raw: parts.map((p: any) => p?.text ?? "").join("").trim() };
    }
    lastBody = await r.text();
    lastStatus = r.status;
    lastErr = `Gemini ${r.status} (${model}): ${lastBody.slice(0, 120)}`;
    // Search unavailable for this model/account: same model, same image, no tool. Losing the scan
    // entirely because a lookup was offered is far worse than a scan that reasons from memory.
    if (r.status === 400 || r.status === 403) {
      const r2 = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: sys }] },
          contents: [{ parts: [{ text: userText }, { inline_data: { mime_type: mime, data: imageBase64 } }] }],
          generationConfig: { temperature: 0.3, maxOutputTokens: 1200, responseMimeType: "application/json" },
        }),
      });
      if (r2.ok) {
        const j2 = await r2.json();
        const parts2 = j2?.candidates?.[0]?.content?.parts ?? [];
        return { raw: parts2.map((p: any) => p?.text ?? "").join("").trim() };
      }
    }
    if (r.status !== 404 && r.status !== 400) return { error: lastErr, kind: classifyLlmError(r.status, lastBody), status: r.status };
  }
  return { error: lastErr, kind: classifyLlmError(lastStatus, lastBody), status: lastStatus };
}

async function visionComplete(sys: string, userText: string, imageBase64: string, mime: string, byokKey: string): Promise<VisionResult> {
  // BYOK: a client Gemini key routes vision to the user's own free quota (cost ~0 to us).
  if (byokKey) return geminiVision(sys, userText, imageBase64, mime, byokKey);
  // Hosted: Anthropic vision first, with a quick retry + a Gemini fallback on a TRANSIENT failure
  // (429 / 5xx). A brief Anthropic rate-spike or overload used to surface as a hard "IA
  // indisponible" even though the rest of the app was fine — exactly the case the user hit: the
  // scan failed but an analysis seconds later worked, because the coach uses a different provider.
  if (ANTHROPIC_API_KEY) {
    let res = await anthropicVision(sys, userText, imageBase64, mime);
    if (!res.error) return res;
    const transient = !res.status || res.status === 429 || res.status >= 500;
    if (transient) {
      await new Promise((r) => setTimeout(r, 600)); // let a momentary rate-spike clear
      res = await anthropicVision(sys, userText, imageBase64, mime);
      if (!res.error) return res;
    }
    // Fall back to the server's own Gemini vision key on ANY Anthropic failure, not just a transient
    // one. A renamed/retired model id answers 404 — not "transient" — and used to kill the scan
    // outright while a perfectly good second provider sat configured and unused.
    if (GEMINI_API_KEY) {
      const g = await geminiVision(sys, userText, imageBase64, mime, GEMINI_API_KEY);
      if (!g.error) return g;
    }
    return res; // surface the classified Anthropic error
  }
  if (GEMINI_API_KEY) return geminiVision(sys, userText, imageBase64, mime, GEMINI_API_KEY);
  return { error: "no-vision-key", kind: "auth" };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ text: "Méthode non autorisée", isError: true }, 405);

  try {
    const body = await req.json().catch(() => ({}));
    const lang = body.lang === "es" ? "es" : "fr";
    const subject = await accessSubject(req, db, (typeof body.subject === "string" && /^[a-f0-9]{64}$/.test(body.subject)) ? body.subject : null);
    const imageBase64 = String(body.imageBase64 ?? "");
    const mime = String(body.mime ?? "image/jpeg");
    const readings = Array.isArray(body.readings) ? body.readings : [];
    const byokGeminiKey = typeof body.geminiKey === "string" ? body.geminiKey.trim() : "";
    const premiumVoice = body.premiumVoice !== false; // absent => premium (older installs keep voice)
    if (!imageBase64) return json({ text: lang === "es" ? "Falta la foto." : "Photo manquante.", isError: true });

    // Cost model: server vision key only in Hosted mode; free users bring a Gemini key (BYOK).
    // New clients always send `hosted`; older installs omit it and are grandfathered.
    if (!byokGeminiKey && body.hosted === false) {
      return json({ text: lang === "es"
        ? "Para usar el escáner: activa el modo Hosted o añade tu clave Gemini en Perfil."
        : "Pour utiliser le scan : active le mode Hosted ou ajoute ta clé Gemini dans Profil.",
        isError: true, errorKind: "auth" });
    }
    if (!ANTHROPIC_API_KEY && !GEMINI_API_KEY && !byokGeminiKey) {
      // NOT the user's problem when they ARE in hosted mode: the scan is the only feature that needs
      // a VISION key (the others run on DeepSeek), so it can be unconfigured server-side while
      // everything else works. Telling a hosted user to "activate hosted mode" — which they already
      // did — is the reported bug; own the failure instead.
      const hostedCaller = body.hosted !== false;
      return json({ text: hostedCaller
        ? (lang === "es"
          ? "El escáner de fotos no está disponible ahora mismo (configuración del servidor). No es culpa de tus ajustes: el modo Hosted sigue activo. Añade la comida a mano, o vuelve a intentarlo más tarde."
          : "Le scan photo n'est pas disponible pour le moment (configuration du serveur). Ce n'est pas tes réglages : le mode Hosted est bien actif. Ajoute le repas à la main, ou réessaie plus tard.")
        : (lang === "es"
          ? "Escáner de fotos no configurado: añade tu clave Gemini (BYOK) en Perfil, o activa el modo Hosted."
          : "Scan photo non configuré : ajoute ta clé Gemini (BYOK) dans Profil, ou active le mode Hosted."),
        isError: true, errorKind: "auth" });
    }

    const nowMs = Date.now();
    const rds = readings
      .map((r: any) => ({ ts: Number(r.ts), value: Number(r.value) }))
      .filter((r: any) => r.value > 0)
      .sort((a: any, b: any) => (a.ts || 0) - (b.ts || 0));
    const lastR = rds.length ? rds[rds.length - 1] : null;
    const cur = lastR ? Math.round(lastR.value) : null;
    const hasTs = !!(lastR && Number.isFinite(lastR.ts) && lastR.ts > 0);
    // No usable timestamp → treat the reading as STALE (forces WAIT), never as fresh. A reading of
    // unknown age must not yield a dose (mirrors the coach's safe default).
    const staleMin = hasTs ? Math.round((nowMs - (lastR as any).ts) / 60000) : 999;
    // Match the client's 5-min NO SIGNAL window: a reading older than that means the LIVE glucose is
    // unknown, so we must not append a dose/sugar action off it (the guard's STALE_MIN=15 is laxer).
    const signalLost = cur != null && (!hasTs || (nowMs - (lastR as any).ts) > STALE_MIN * 60000);
    const trend = hasTs ? trendFromReadings(rds, nowMs) : "unknown";

    let profile: any = null;
    let insulinDoses: any[] = [];
    let meals: any[] = [];
    if (subject) {
      const { data: p } = await db.from("mechabetics_profiles").select("*").eq("subject", subject).maybeSingle();
      profile = p;
      const { data: ins } = await db.from("mechabetics_insulin")
        .select("ts, units, insulin_name, kind").eq("subject", subject)
        .gte("ts", new Date(nowMs - 6 * 3600 * 1000).toISOString())
        .order("ts", { ascending: false }).limit(8);
      insulinDoses = ins ?? [];
      // Recent meals → so a low that was JUST treated isn't told to take MORE sugar (rule of 15).
      // description + carbs_g are REQUIRED: minutesSinceLastRescue only counts an actual rescue
      // (small fast sugar), which it reads off those two fields. Windowed for the same reason as ask.
      const { data: ml } = await db.from("mechabetics_meals")
        .select("ts, description, carbs_g, planned").eq("subject", subject)
        .gte("ts", new Date(nowMs - 26 * 60 * 60 * 1000).toISOString())
        .order("ts", { ascending: false }).limit(6);
      meals = ml ?? [];
    }

    const gp = toGuardProfile(profile);
    const dia = insulinActionMinutes(gp?.rapidInsulin) ?? 240; // insulin-type-aware decay (Fiasp≈4h, regular≈6h)
    const iob = activeIob(insulinDoses, nowMs, dia);
    const recentHypo = hasTs ? recentHypoFrom(rds, nowMs) : rds.some((r) => r.value > 0 && r.value < 70);
    const minSinceRescue = minutesSinceLastRescue(meals, nowMs);
    const guard = computeGuard({ glucoseMgdl: cur, trend, staleMin, iobUnits: iob, recentHypo, minSinceRescue, profile: gp });
    const hint = situationHint(guard, lang);

    const pr = await loadPrompts(lang);
    const sys = buildSystem(lang, profile, cur, pr, hint);
    const userText = lang === "es" ? "Aquí está la foto del producto. ¿Qué hago?" : "Voici la photo du produit. Que dois-je faire ?";

    const vr = await visionComplete(sys, userText, imageBase64, mime, byokGeminiKey);
    if (vr.error) {
      // Vision failed — say WHICH problem (down / out of credits / rate-limited / bad key) and still
      // return the code-owned safe action (the guard doesn't need the model).
      const kind = vr.kind ?? "ai_down";
      const head = llmErrorMessage(kind, lang, !!byokGeminiKey);
      const show = !(guard.reason === "in_range" || guard.reason === "no_reading");
      const out = show
        ? `${head}\n\n${lang === "es" ? "Acción" : "Action"} : ${combinedActionLine(guard, 0, lang, gp)}`
        : head;
      return json({ text: out, isError: true, errorKind: kind });
    }
    const raw = (vr.raw ?? "").trim();
    let parsed: any = {};
    try { parsed = JSON.parse(raw); } catch { parsed = {}; }
    const didnt = lang === "es" ? "No pude leer el producto, prueba otra foto." : "Je n'ai pas pu lire le produit, réessaie une photo.";
    const replyRaw = (typeof parsed.reply === "string" && parsed.reply.trim()) ? parsed.reply.trim() : extractStr(raw, "reply");
    let reply: string = replyRaw || (raw && !raw.trim().startsWith("{") ? raw : didnt);
    const voiceRaw = (typeof parsed.voice === "string" && parsed.voice.trim()) ? parsed.voice.trim() : extractStr(raw, "voice");
    let voice: string = voiceRaw || reply;

    // ----- CODE OWNS THE DOSE -----
    const mealCarbs = (parsed.meal && typeof parsed.meal === "object" && Number.isFinite(Number(parsed.meal.carbsG)))
      ? Math.min(300, Math.max(0, Math.round(Number(parsed.meal.carbsG)))) : null; // clamp a hallucinated carb count
    // NO MEAL BOLUS INTO A FALL ALREADY OWED. The dashboard got this guard; the voice and the photo
    // did not, and they name doses too — so "3 u pour ce repas" at 85 mg/dL with 3.4 u still working
    // was reachable from here exactly as it was from the home screen. The insulin already in keeps
    // going whatever the number on screen says.
    const mealUnitsRaw = mealBolusUnits(mealCarbs, gp);
    const mealHeld = mealUnitsRaw > 0 && mealBolusHeldByIob(cur, iob, gp);
    const mealUnits = mealHeld ? 0 : mealUnitsRaw;
    // Signal lost (stale reading) → forbid any dose off it and override the action with a fingerstick
    // prompt, exactly like coach. Otherwise a 5–15 min-old high could yield a correction the app's own
    // NO SIGNAL state contradicts.
    const insulinForbidden = signalLost || (guard.maxInsulinUnits === 0 && mealUnits === 0);
    if (insulinForbidden) { reply = stripInsulinNumbers(reply) || reply; voice = stripInsulinNumbers(voice) || voice; }
    // Insulin allowed: the answer still may not name MORE units than the system decided (correction
    // plus the meal bolus for the scanned food). Previously unchecked.
    // Plus whatever insulin the context legitimately names (active insulin, a dose logged earlier):
    // echoing one is not proposing one, and judging against the bolus alone gutted correct answers.
    else {
      const ctxUnits = Math.max(iob || 0, 0);
      const ceiling = { ...guard, maxInsulinUnits: guard.maxInsulinUnits + Math.max(0, mealUnits || 0) + ctxUnits };
      reply = enforceInsulinCeiling(reply, ceiling) || reply;
      voice = enforceInsulinCeiling(voice, ceiling) || voice;
    }
    const showAction = signalLost || mealUnits > 0 || !(guard.reason === "in_range" || guard.reason === "no_reading");
    let text = reply;
    let voiceText = voice;
    if (showAction) {
      const line = signalLost
        ? (lang === "es"
          ? "Señal perdida: reconecta el sensor (acerca el teléfono que lo escanea, vuelve a escanear); si no vuelve, hazte una punción capilar antes de cualquier decisión."
          : "Signal perdu : reconnecte le capteur (rapproche le téléphone qui le scanne, re-scanne) ; s'il ne revient pas, fais un test au doigt avant toute décision.")
        : mealHeld
          ? mealBolusHeldLine(cur as number, iob, gp, lang)
          : combinedActionLine(guard, mealUnits, lang, gp);
      const label = lang === "es" ? "Acción" : "Action";
      text = `${reply}\n\n${label} : ${line}`;
      voiceText = `${voice} ${line}`.trim();
    }

    // Make grams tangible: pair the estimated carbs with their ~4 g sugar-cube equivalent.
    if (mealCarbs && mealCarbs > 0) {
      const cn = lang === "es"
        ? `${mealCarbs} g de carbohidratos (${carbsCubesPhrase(mealCarbs, "es")}).`
        : `${mealCarbs} g de glucides (${carbsCubesPhrase(mealCarbs, "fr")}).`;
      const cnVoice = lang === "es"
        ? `${mealCarbs} g de carbohidratos, ${carbsCubesPhrase(mealCarbs, "es", true)}.`
        : `${mealCarbs} g de glucides, ${carbsCubesPhrase(mealCarbs, "fr", true)}.`;
      text = `${text}\n\n${cn}`;
      voiceText = `${voiceText} ${cnVoice}`.trim();
    }

    // A STARCHY food (potato, bread, rice, pasta…) isn't sweet but IS high-carb → explain it, so the
    // "≈ N sucres" carb-equivalent isn't read as "this food is sugary" (the user's exact confusion).
    const starchNote = parsed.meal ? starchyCarbNote(parsed.meal.description, lang) : "";
    if (starchNote) text = `${text}\n\n${starchNote}`;

    // Carb SPEED → timing advice: fast sugar (pre-bolus, quick spike normal) vs slow/fatty (late
    // rise, recheck later — fatty also gets the split-bolus note). Skip during a hypo rescue
    // (guard "sugar"): a "pre-bolus next time" line would contradict "take sugar now".
    if (parsed.meal && typeof parsed.meal === "object" && guard.kind !== "sugar") {
      const speed = mealCarbSpeed(parsed.meal.description);
      const adv = carbSpeedAdvice(speed, lang);
      if (adv) {
        text = `${text}\n\n${adv}`;
        // Spoken variant without the food examples (they are heard as "what you ate").
        voiceText = `${voiceText} ${carbSpeedAdvice(speed, lang, false, true)}`.trim();
      }
    }

    let logFailed = false;
    let loggedMeal: any = null;
    if (subject && parsed.meal && typeof parsed.meal === "object" && parsed.meal.description) {
      loggedMeal = {
        subject,
        description: String(parsed.meal.description).slice(0, 240),
        carbs_g: mealCarbs,
        // A scanned product is being eaten NOW → log it as EATEN, not "prévu". (It used to default
        // to planned=true, so scans showed "prévu" and the daily analysis skipped them as not-eaten.)
        planned: false,
      };
      // A failed write was silent (the reply still showed the food) → user thinks it's logged. Warn.
      const { error: mErr } = await db.from("mechabetics_meals").insert(loggedMeal);
      if (mErr) {
        loggedMeal = null;
        logFailed = true;
        text += `\n\n${lang === "es"
          ? "⚠️ No pude registrar esta comida — vuelve a anotarla en la pestaña Comidas."
          : "⚠️ Je n'ai pas pu enregistrer ce repas — re-note-le dans l'onglet Repas."}`;
      }
    }

    let audioBase64: string | null = null;
    if (premiumVoice && ELEVENLABS_API_KEY) {
      try {
        const tRes = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`, {
          method: "POST",
          headers: { "xi-api-key": ELEVENLABS_API_KEY, "content-type": "application/json" },
          body: JSON.stringify({ text: voiceText, model_id: "eleven_multilingual_v2" }),
        });
        if (tRes.ok) audioBase64 = toBase64(new Uint8Array(await tRes.arrayBuffer()));
      } catch (_) { /* voice optional */ }
    }

    return json({ text, voice: voiceText, audioBase64, mime: "audio/mpeg", isError: false, meal: loggedMeal, logFailed });
  } catch (e) {
    return json({ text: `Erreur serveur: ${(e as Error)?.message ?? e}`, isError: true });
  }
});
