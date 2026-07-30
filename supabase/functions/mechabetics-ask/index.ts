import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { accessSubject } from "../_shared/access.ts";
import {
  computeGuard,
  STALE_MIN,
  trendFromReadings,
  recentHypoFrom,
  minutesSinceLastRescue,
  activeIob,
  insulinActionMinutes,
  iobSystemLine,
  mealBolusUnits,
  combinedActionLine,
  situationHint,
  stripInsulinNumbers,
  enforceInsulinCeiling,
  carbsCubesPhrase,
  carbEstimationRules,
  mealCarbSpeed,
  carbSpeedAdvice,
  sugarTimingFact,
  hypoIobWarning,
  starchyCarbNote,
  plannedMealNote,
  planMealDose,
  mealPlanLine,
  type GuardProfile,
} from "../_shared/doseGuard.ts";
import { chatJson, llmErrorKind, llmErrorMessage } from "../_shared/llm.ts";

// Doctor Claude voice Q&A (FR/ES). The phone sends the transcribed question + subject hash +
// recent readings ({ts, value}). We load the PROFILE (doctor's ratios + weight) + recent MEALS
// + recent INSULIN, then DeepSeek answers — but the EXACT DOSE IS COMPUTED IN CODE by the
// deterministic guard (see _shared/doseGuard.ts), never by the model. The model only estimates
// a meal's carbs and writes the empathetic wording (no dose numbers); code appends the exact,
// safe action (meal bolus + correction, minus IOB, blocked when hypo/in-range/falling/stale).
// On-screen reply in mg/dL; spoken voice in the local idiom. Voice via ElevenLabs.

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

// Recent rapid-insulin doses -> a context line (for the model's wording; the guard computes IOB
// itself). A FUTURE-dated dose is a PLANNED injection (not yet active — activeIob skips it): say so
// instead of the nonsense "il y a -53 min". Each PAST dose carries its computed state (still
// working / finished) and the line closes with the SYSTEM total (iobSystemLine) — the model used
// to see only "4 u il y a 290 min" and estimated the decay ITSELF, saying insulin was still ending
// while the computed IOB (and the Insuline tab) said 0.
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

// Recent physical activity -> a context line (sport lowers glucose).
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
    ? `ACTIVIDAD FÍSICA RECIENTE: ${parts.join("; ")} — el ejercicio BAJA la glucosa.`
    : `ACTIVITÉ PHYSIQUE RÉCENTE : ${parts.join(" ; ")} — le sport FAIT BAISSER la glycémie.`;
}

function buildSystem(lang: string, p: any, cur: number | null, series: string, meals: any[], pr: Record<string, string>, insCtx: string, actCtx: string, hint: string, signalLost: boolean, staleMin: number, sensorExpired: boolean): string {
  const nick = p?.nickname || (lang === "es" ? "la persona" : "la personne");
  const curTxt = cur != null ? `${cur} mg/dL` : (lang === "es" ? "desconocida" : "inconnue");
  const mealsTxt = (meals && meals.length)
    ? meals.map((m) => `${m.planned ? (lang === "es" ? "previsto" : "prévu") : (lang === "es" ? "comido" : "mangé")} ${m.description}${m.carbs_g ? ` (~${m.carbs_g} g)` : ""}`).join(" ; ")
    : (lang === "es" ? "ninguno" : "aucun");

  const profileBits: string[] = [];
  if (p?.age) profileBits.push(lang === "es" ? `${p.age} años` : `${p.age} ans`);
  if (p?.weight_kg) profileBits.push(`${p.weight_kg} kg`);
  if (p?.rapid_insulin) profileBits.push(lang === "es" ? `insulina rápida ${p.rapid_insulin}` : `insuline rapide ${p.rapid_insulin}`);
  if (p?.basal_insulin) profileBits.push(lang === "es" ? `lenta ${p.basal_insulin}` : `lente ${p.basal_insulin}`);
  const profileLine = profileBits.length ? profileBits.join(", ") : (lang === "es" ? "sin detalles" : "non renseigné");

  const persona = lang === "es"
    ? P(pr, "ask.persona", `Eres Doctor Claude, un asistente de salud directo y cercano para {nick}, que tiene diabetes tipo 1.`).replace("{nick}", nick)
    : P(pr, "ask.persona", `Tu es Doctor Claude, un assistant santé direct et bienveillant pour {nick}, qui a un diabète de type 1.`).replace("{nick}", nick);
  const sugarRule = lang === "es"
    ? P(pr, "ask.sugar", `Un alimento o bebida con carbohidratos —aunque sea muy azucarado, refrescos incluidos— se CUBRE con insulina, no se rechaza ni se sustituye. No propongas NUNCA una "opción más suave" ni moralices. "No necesitas azúcar" SOLO vale para rechazar un resucrado cuando NO hay hipo (glucosa ≥ 70).`)
    : P(pr, "ask.sugar", `Un aliment ou une boisson glucidique —même très sucré, sodas compris— se COUVRE avec de l'insuline, il ne se refuse pas et ne se remplace pas. Ne propose JAMAIS d'"alternative moins sucrée" et ne fais pas la morale. "Pas besoin de sucre" ne vaut QUE pour refuser un resucrage quand il n'y a PAS d'hypo (glycémie ≥ 70).`);

  // RESUGAR ONLY BELOW 70, and ONLY with SUGAR CUBES — never soda or juice (easier to dose, and
  // avoids teaching a kid bad habits). The user flagged both "eat sugar at 94" and "proposes soda".
  const sugarTiming = lang === "es"
    ? `RESUCRADO: si la glucosa está por debajo de 70 (hipo real), aconseja SOLO TERRONES DE AZÚCAR (azúcar rápido) — NUNCA refrescos ni zumos (el azúcar es más fácil de dosificar y evita malos hábitos). Entre 70 y 180, AUNQUE baje rápido, NO digas que tome azúcar: dile que tenga azúcar A MANO y que vigile / recontrole en 15 min. POR ENCIMA DE 180 (hiper), NO hables de azúcar — hace falta una CORRECCIÓN de insulina (la calcula el sistema), NO azúcar. No se resucra por adelantado con una glucosa normal.`
    : `RESUCRAGE : si la glycémie est sous 70 (vraie hypo), conseille UNIQUEMENT des MORCEAUX DE SUCRE (sucre rapide) — JAMAIS de soda ni de jus de fruit (le sucre est plus simple à doser et évite les mauvaises habitudes). Entre 70 et 180, MÊME si ça descend vite, ne dis PAS d'en prendre : dis de GARDER du sucre À PORTÉE et de surveiller / recontrôler dans 15 min. AU-DESSUS DE 180 (hyper), ne parle PAS de sucre — il faut une CORRECTION d'insuline (le système la calcule), PAS du sucre. On ne se resucre pas par anticipation sur une glycémie normale.`;

  // The DOSE is owned by code. The model must NOT write any dose number.
  const noNumbers = lang === "es"
    ? `IMPORTANTE — DOSIS: NO escribas tú ningún número de dosis (unidades de insulina, gramos o terrones de azúcar) en "reply" ni en "voice". El sistema calcula y añade la acción exacta. Tú solo explicas, tranquilizas y, si menciona comida, estimas los carbohidratos en "meal".`
    : `IMPORTANT — DOSE : n'écris TOI-MÊME AUCUN chiffre de dose (unités d'insuline, grammes ou morceaux de sucre) dans "reply" ni "voice". Le système calcule et ajoute l'action exacte. Toi, tu expliques, tu rassures, et si un aliment est mentionné tu estimes les glucides dans "meal".`;

  if (lang === "es") {
    return [
      persona,
      `ÁMBITO ("scope"): decide primero si la pregunta toca su salud / glucosa / diabetes / comidas / insulina / deporte / sueño / su cuerpo → "scope":"diabetes", o si es una pregunta general sin relación (deberes, cultura, ciencia, juegos, charla) → "scope":"general". Pregunta GENERAL: respóndela DE VERDAD y de forma completa, como un asistente inteligente y amable (adaptado a un niño/adolescente) — SIN límite de 2-3 frases, sin hablar de diabetes ni de glucosa (salvo que lo pida), y pon "meal","insulin","activity" en null (no registres nada). Pregunta de DIABETES: aplica todas las reglas siguientes.`,
      `PERFIL: ${profileLine}.`,
      signalLost
        ? (sensorExpired
          ? `GLUCOSA: SENSOR CADUCADO (los 14 días se cumplieron) — sin medición desde hace ${staleMin} min, la actual es DESCONOCIDA; última conocida ${curTxt}; recientes (mg/dL): ${series || "n/d"}. Esa es la CAUSA de la falta de señal: aconseja poner un sensor NUEVO (y una punción capilar mientras tanto) — NADA de «acercar el teléfono» ni «volver a escanear», un sensor terminado no vuelve.`
          : `GLUCOSA: SEÑAL PERDIDA (sin medición desde hace ${staleMin} min) — la actual es DESCONOCIDA; última conocida ${curTxt}; recientes (mg/dL): ${series || "n/d"}. NUNCA digas «estás en X» como si fuera ahora — di «tu última glucosa conocida»; aconseja reconectar el sensor primero (acercar el teléfono que lo escanea, volver a escanear), y una punción capilar si la señal no vuelve.`)
        : `GLUCOSA: actual ${curTxt}; recientes (mg/dL): ${series || "n/d"}.`,
      `COMIDAS RECIENTES: ${mealsTxt}.`,
      insCtx,
      actCtx,
      hint ? `SITUACIÓN (la calcula el sistema): ${hint}.` : "",
      `REGLAS (preguntas de diabetes): responde a su pregunta, español sencillo y breve, glucosa en mg/dL. Si menciona algo que comió o va a comer, estima los carbohidratos y rellena "meal". Si dice que se puso X unidades de insulina, rellena "insulin".`,
      `COMIDA FUTURA: si dice que VA a comer algo («voy a comer un McDonald's», «esta noche pasta»), rellena "meal" con "planned":true y tu mejor estimación de carbohidratos — el sistema añadirá la consigna de ponerse la insulina al comer.`,
      `SENSOR: si dice que su sensor está caducado / terminado o que acaba de cambiarlo, tenlo en cuenta (un sensor nuevo tarda ~1 h en arrancar) y aconseja punción capilar mientras tanto — no le digas que «vuelva a escanear» un sensor terminado.`,
      `TIEMPO: si dice CUÁNDO lo comió o se inyectó («hace 3 horas», «esta mañana», «a las 14h»), calcula los minutos transcurridos y ponlos en "minutesAgo" (0 si es ahora o no lo dice). No lo inventes.`,
      `TIEMPO — FUTURO: si anuncia algo POR VENIR («voy a comer dentro de 10 minutos», «como a las 20h», «me pongo la insulina dentro de media hora»), pon "minutesAgo" NEGATIVO = los minutos que faltan (dentro de 10 minutos → -10; dentro de una hora → -60). Es lo que permite al sistema preparar la dosis ANTES de la comida.`,
      `ALIMENTOS: NUNCA nombres un alimento que él no haya dicho y que no esté en COMIDAS RECIENTES — no inventes ejemplos de alimentos ni completes una comida con lo que «podría» haber comido. Si no sabes qué comió, pregúntaselo.`,
      `Si menciona ejercicio o deporte (hecho o previsto), rellena "activity".`,
      `Si dice que YA se puso una dosis (rellena "insulin"), NO propongas otra inyección; si parece mucha insulina, aconseja vigilar una hipo y tener azúcar a mano. Nunca aconsejes más insulina sobre una dosis ya puesta.`,
      carbEstimationRules(lang),
      `Para "meal", añade "basis":"stated" si dijo claramente el alimento y/o la cantidad, o "estimated" si es vago o lo estimas tú. No se inventa una dosis firme sobre una estimación. "carbsG" SIEMPRE se rellena para un alimento: da TU MEJOR ESTIMACIÓN en gramos (nunca null, y 0-2 SOLO para un alimento sin carbohidratos como carne/huevo/queso) — es la base del análisis.`,
      noNumbers,
      sugarRule,
      sugarTiming,
      sugarTimingFact(lang),
      `Es un consejo, no un dispositivo médico.`,
      `Responde SOLO en JSON: {"scope":"diabetes|general","reply":"<respuesta mostrada en mg/dL — 2-3 frases para diabetes, completa y libre para una pregunta general — SIN número de dosis>","voice":"<lo que se lee en voz alta: para una pregunta general, la respuesta completa; para diabetes, una frase. SIN número de dosis; di la glucosa SIN unidad, solo el número (ej 78, 218)>","meal":{"description":"<comida>","carbsG":<numero>,"planned":<true si futura, false si ya comida>,"basis":"stated|estimated","minutesAgo":<minutos desde que comió, 0 si ahora, NEGATIVO si es futuro (dentro de 10 min → -10)>}|null,"insulin":{"units":<numero>,"name":"<insulina>","minutesAgo":<minutos desde la inyección, 0 si ahora>}|null,"activity":{"kind":"<tipo>","description":"<texto>","intensity":"low|moderate|high","planned":<true|false>,"minutesAgo":<minutos, 0 si ahora>}|null}`,
    ].filter(Boolean).join(" ");
  }
  return [
    persona,
    `PORTÉE ("scope") : décide d'abord si la question touche sa santé / glycémie / diabète / repas / insuline / sport / sommeil / son corps → "scope":"diabetes", ou si c'est une question générale sans rapport (devoirs, culture, sciences, jeux, discussion) → "scope":"general". Question GÉNÉRALE : réponds-y VRAIMENT et complètement, comme un assistant intelligent et bienveillant (adapté à un enfant/ado) — SANS limite de 2-3 phrases, ne parle PAS de diabète ni de glycémie (sauf s'il le demande), et mets "meal","insulin","activity" à null (ne loggue rien). Question DIABÈTE : applique toutes les règles ci-dessous.`,
    `PROFIL : ${profileLine}.`,
    signalLost
      ? (sensorExpired
        ? `GLYCÉMIE : CAPTEUR EXPIRÉ (les 14 jours sont atteints) — plus aucune mesure depuis ${staleMin} min, l'actuelle est INCONNUE ; dernière connue ${curTxt} ; récentes (mg/dL) : ${series || "n/d"}. C'est la CAUSE de l'absence de signal : conseille de poser un NOUVEAU capteur (et un test au doigt en attendant) — PAS de « rapprocher le téléphone » ni de « re-scanner », un capteur fini ne revient pas.`
        : `GLYCÉMIE : SIGNAL PERDU (aucune mesure depuis ${staleMin} min) — l'actuelle est INCONNUE ; dernière connue ${curTxt} ; récentes (mg/dL) : ${series || "n/d"}. Ne dis JAMAIS « tu es à X » comme si c'était maintenant — dis « ta dernière glycémie connue » ; conseille de reconnecter le capteur d'abord (rapprocher le téléphone qui le scanne, re-scanner), et un test au doigt si le signal ne revient pas.`)
      : `GLYCÉMIE : actuelle ${curTxt} ; récentes (mg/dL) : ${series || "n/d"}.`,
    `REPAS RÉCENTS : ${mealsTxt}.`,
    insCtx,
    actCtx,
    hint ? `SITUATION (calculée par le système) : ${hint}.` : "",
    `RÈGLES (questions diabète) : réponds à sa question, français simple et court, glycémie en mg/dL. S'il mentionne un aliment mangé ou à venir, estime les glucides et remplis "meal". S'il dit avoir fait X unités d'insuline, remplis "insulin".`,
    `REPAS À VENIR : s'il dit qu'il VA manger quelque chose (« je vais manger un McDo », « ce soir je mange des pâtes »), remplis "meal" avec "planned":true et ta meilleure estimation de glucides — le système ajoutera la consigne de faire l'insuline au moment de manger.`,
    `CAPTEUR : s'il dit que son capteur est expiré / fini ou qu'il vient d'en changer, prends-le en compte (un capteur neuf met ~1 h à démarrer) et conseille un test au doigt en attendant — ne lui dis pas de « re-scanner » un capteur fini.`,
    `QUAND : s'il précise QUAND il l'a mangé ou injecté («il y a 3 heures», «ce matin», «à 14h»), calcule les minutes écoulées et mets-les dans "minutesAgo" (0 si c'est maintenant ou non précisé). N'invente pas.`,
    `QUAND — FUTUR : s'il annonce quelque chose À VENIR («je vais manger dans 10 minutes», «je mange à 20h», «je fais mon insuline dans une demi-heure»), mets "minutesAgo" NÉGATIF = le nombre de minutes qui restent (dans 10 minutes → -10 ; dans une heure → -60). C'est ce qui permet au système de préparer la dose AVANT le repas.`,
    `ALIMENTS : ne nomme JAMAIS un aliment qu'il n'a pas dit lui-même et qui n'est pas dans REPAS RÉCENTS — n'invente pas d'exemples d'aliments, ne complète pas un repas avec ce qu'il « pourrait » avoir mangé. Si tu ne sais pas ce qu'il a mangé, demande.`,
    `S'il mentionne du sport ou une activité (faite ou prévue), remplis "activity".`,
    `S'il dit avoir DÉJÀ fait une dose (remplis "insulin"), ne propose pas d'en refaire ; si ça semble beaucoup d'insuline, conseille de surveiller une hypo et d'avoir du sucre à portée. Ne conseille jamais d'insuline en plus d'une dose déjà faite.`,
    carbEstimationRules(lang),
    `Pour "meal", ajoute "basis":"stated" s'il a clairement dit l'aliment et/ou la quantité, ou "estimated" si c'est vague ou que tu l'estimes. On n'invente pas de dose ferme sur une estimation. "carbsG" est TOUJOURS rempli pour un aliment : donne TA MEILLEURE ESTIMATION en grammes (jamais null, et 0-2 SEULEMENT pour un aliment sans glucides comme viande/œuf/fromage) — c'est la base de l'analyse.`,
    noNumbers,
    sugarRule,
    sugarTiming,
    sugarTimingFact(lang),
    `C'est un conseil, pas un dispositif médical.`,
    `Réponds UNIQUEMENT en JSON : {"scope":"diabetes|general","reply":"<réponse affichée en mg/dL — 2-3 phrases pour le diabète, complète et libre pour une question générale — SANS chiffre de dose>","voice":"<ce qui est lu à voix haute : pour une question générale, la réponse complète ; pour le diabète, une phrase. SANS chiffre de dose ; dis la glycémie SANS unité, juste le nombre (ex 78, 218)>","meal":{"description":"<aliment>","carbsG":<nombre>,"planned":<true si à venir, false si déjà mangé>,"basis":"stated|estimated","minutesAgo":<minutes depuis qu'il a mangé, 0 si maintenant, NÉGATIF si c'est à venir (dans 10 min → -10)>}|null,"insulin":{"units":<nombre>,"name":"<insuline>","minutesAgo":<minutes depuis l'injection, 0 si maintenant>}|null,"activity":{"kind":"<type>","description":"<texte>","intensity":"low|moderate|high","planned":<true|false>,"minutesAgo":<minutes, 0 si maintenant>}|null}`,
  ].filter(Boolean).join(" ");
}

/** When the user said WHEN ("il y a 3 heures"), the model fills minutesAgo → backdate the logged
 *  ts so IOB / meal timing are correct. Returns an ISO string, or null (=> let the DB stamp now).
 *  Clamped to the past and to ≤36 h so a hallucinated value can't poison the timeline. */
function backdatedIso(minutesAgo: unknown, nowMs: number): string | null {
  const m = Number(minutesAgo);
  if (!Number.isFinite(m) || m <= 0) return null;
  return new Date(nowMs - Math.min(m, 36 * 60) * 60000).toISOString();
}

/** Minutes UNTIL an announced meal ("je mange dans 10 minutes"), from the model's negative
 *  minutesAgo. 0 when it is being eaten now or nothing was said. Clamped to 36 h like the past
 *  direction, so a hallucinated value can't push a meal a week out. */
function minutesUntil(minutesAgo: unknown, ): number {
  const m = Number(minutesAgo);
  if (!Number.isFinite(m) || m >= 0) return 0;
  return Math.min(-m, 36 * 60);
}

/** The logged timestamp for a meal/dose, in EITHER direction. The old helper only went backwards, so
 *  "dans 10 minutes" was stored as "now" and the announced time — the whole point of announcing —
 *  was thrown away before anything could anticipate it. */
function offsetIso(minutesAgo: unknown, nowMs: number): string | null {
  const ahead = minutesUntil(minutesAgo);
  if (ahead > 0) return new Date(nowMs + ahead * 60000).toISOString();
  return backdatedIso(minutesAgo, nowMs);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ text: "Méthode non autorisée", isError: true }, 405);

  try {
    const body = await req.json().catch(() => ({}));
    const question = String(body.question ?? "").trim();
    const lang = body.lang === "es" ? "es" : "fr";
    const subject = await accessSubject(req, db, (typeof body.subject === "string" && /^[a-f0-9]{64}$/.test(body.subject)) ? body.subject : null);
    const readings = Array.isArray(body.readings) ? body.readings : [];
    const byokGeminiKey = typeof body.geminiKey === "string" ? body.geminiKey.trim() : "";
    const premiumVoice = body.premiumVoice !== false; // absent => premium (older installs keep voice)
    // The CLIENT knows the sensor's expiry (LibreLinkUp activation + 14 d) — when it says the sensor
    // is expired, a lost signal has a known cause: advise a NEW sensor, not "re-scan / move closer".
    const sensorExpired = body.sensorExpired === true;
    const didntCatch = lang === "es" ? "No te he entendido, ¿puedes repetir?" : "Je n'ai pas compris, tu peux répéter ?";
    if (!question) return json({ text: didntCatch, isError: true });
    // Cost model: server LLM key only in Hosted mode; free users bring a Gemini key (BYOK).
    // New clients always send `hosted`; older installs omit it and are grandfathered.
    if (!byokGeminiKey && body.hosted === false) {
      return json({ text: lang === "es"
        ? "Para usar la IA: activa el modo Hosted o añade tu clave Gemini en Perfil."
        : "Pour utiliser l'IA : active le mode Hosted ou ajoute ta clé Gemini dans Profil.", isError: true });
    }
    if (!DEEPSEEK_API_KEY && !byokGeminiKey) {
      return json({ text: lang === "es" ? "Sin clave de IA: añade tu clave Gemini (BYOK) en Perfil." : "Aucune clé IA : ajoute ta clé Gemini (BYOK) dans Profil.", isError: true });
    }

    const nowMs = Date.now();
    const rds = readings
      .map((r: any) => ({ ts: Number(r.ts), value: Number(r.value) }))
      .filter((r: any) => r.value > 0)
      .sort((a: any, b: any) => (a.ts || 0) - (b.ts || 0));
    const lastR = rds.length ? rds[rds.length - 1] : null;
    const cur = lastR ? Math.round(lastR.value) : null;
    const series = rds.slice(-12).map((r) => Math.round(r.value)).join(", ");
    const hasTs = !!(lastR && Number.isFinite(lastR.ts) && lastR.ts > 0);
    // No usable timestamp → treat as STALE (forces WAIT), never as fresh: a reading of unknown age
    // must not yield a dose (mirrors the coach's safe default).
    const staleMin = hasTs ? Math.round((nowMs - (lastR as any).ts) / 60000) : 999;
    const trend = hasTs ? trendFromReadings(rds, nowMs) : "unknown";

    let profile: any = null;
    let meals: any[] = [];
    if (subject) {
      const { data: p } = await db.from("mechabetics_profiles").select("*").eq("subject", subject).maybeSingle();
      profile = p;
      // WINDOWED like the coach's: these rows are handed to the model under the heading "REPAS
      // RÉCENTS". Without a time bound, a meal logged weeks ago is presented as something just
      // eaten, and the model repeats that food back at the user for ever.
      const mealsSinceIso = new Date(nowMs - 26 * 60 * 60 * 1000).toISOString();
      const { data: m } = await db.from("mechabetics_meals")
        .select("ts, description, carbs_g, planned").eq("subject", subject)
        .gte("ts", mealsSinceIso)
        .order("ts", { ascending: false }).limit(6);
      meals = m ?? [];
    }

    let insulinDoses: any[] = [];
    if (subject) {
      const { data: ins } = await db.from("mechabetics_insulin")
        .select("ts, units, insulin_name, kind").eq("subject", subject)
        .gte("ts", new Date(nowMs - 6 * 3600 * 1000).toISOString())
        .order("ts", { ascending: false }).limit(8);
      insulinDoses = ins ?? [];
    }

    let activity: any[] = [];
    if (subject) {
      const { data: act } = await db.from("mechabetics_activity")
        .select("ts, kind, description, intensity, planned").eq("subject", subject)
        .gte("ts", new Date(nowMs - 6 * 3600 * 1000).toISOString())
        .order("ts", { ascending: false }).limit(4);
      activity = act ?? [];
    }

    const gp = toGuardProfile(profile);
    const dia = insulinActionMinutes(gp?.rapidInsulin) ?? 240; // insulin-type-aware decay (Fiasp≈4h, regular≈6h)
    const iob = activeIob(insulinDoses, nowMs, dia);
    const recentHypo = hasTs ? recentHypoFrom(rds, nowMs) : rds.some((r) => r.value > 0 && r.value < 70);
    // Sugar already taken recently? Don't re-recommend sugar for a low that's already being treated.
    const minSinceRescue = minutesSinceLastRescue(meals, nowMs);
    const guard = computeGuard({ glucoseMgdl: cur, trend, staleMin, iobUnits: iob, recentHypo, minSinceRescue, profile: gp });
    const hint = situationHint(guard, lang);

    const insCtx = insulinContext(insulinDoses, iob, dia, nowMs, lang);
    const actCtx = activityContext(activity, lang);
    // Match the client's NO SIGNAL window (5 min): a stale last reading means the LIVE value is
    // unknown — the spoken reply must not assert "tu es à X", only the LAST KNOWN value.
    const signalLost = cur != null && (!hasTs || (nowMs - (lastR as any).ts) > STALE_MIN * 60000);
    const pr = await loadPrompts(lang);
    const sys = buildSystem(lang, profile, cur, series, meals, pr, insCtx, actCtx, hint, signalLost, staleMin, sensorExpired);

    let raw = "";
    try {
      raw = await chatJson(
        { system: sys, user: question, temperature: 0.3, maxTokens: 4000 },
        { byokGeminiKey, deepseekKey: DEEPSEEK_API_KEY, deepseekModel: DEEPSEEK_MODEL, geminiModel: GEMINI_TEXT_MODEL },
      );
    } catch (e) {
      // The dose guard is LLM-independent: even if the AI is down, still return the code-owned safe
      // action (rescue sugar for a hypo, a correction for a high, or "recheck") rather than nothing.
      // Say WHICH problem it is (down / out of credits / rate-limited / bad key) so the user knows
      // whether to wait, recharge, or fix a key — instead of one opaque "AI not responding".
      const kind = llmErrorKind(e);
      const head = llmErrorMessage(kind, lang, !!byokGeminiKey);
      const show = !(guard.reason === "in_range" || guard.reason === "no_reading");
      const out = show
        ? `${head}\n\n${lang === "es" ? "Acción" : "Action"} : ${combinedActionLine(guard, 0, lang, gp)}`
        : head;
      return json({ text: out, isError: true, errorKind: kind });
    }
    let parsed: any = {};
    try { parsed = JSON.parse(raw); } catch { parsed = {}; }
    const replyRaw = (typeof parsed.reply === "string" && parsed.reply.trim()) ? parsed.reply.trim() : extractStr(raw, "reply");
    let reply: string = replyRaw || (raw && !raw.trim().startsWith("{") ? raw : didntCatch);
    const voiceRaw = (typeof parsed.voice === "string" && parsed.voice.trim()) ? parsed.voice.trim() : extractStr(raw, "voice");
    let voice: string = voiceRaw || reply;

    // Off-topic (GENERAL) question: the model answered freely; the diabetic apparatus (Action line,
    // carb notes, auto-logging) stays OUT of it, and the client won't persist it. Belt: any extracted
    // meal/insulin/activity forces "diabetes" — a question that logs something is never off-topic.
    const scope = (parsed.scope === "general" && !parsed.meal && !parsed.insulin && !parsed.activity)
      ? "general" : "diabetes";

    // ----- CODE OWNS THE DOSE -----
    const mealCarbs = (parsed.meal && typeof parsed.meal === "object" && Number.isFinite(Number(parsed.meal.carbsG)))
      ? Math.min(300, Math.max(0, Math.round(Number(parsed.meal.carbsG)))) : null; // clamp a hallucinated/injected carb count
    // Food fallback: only bolus carbs the user actually STATED. A vague/guessed carb count gets a
    // "log it for a precise dose" nudge instead of a firm number (safety > convenience).
    const mealStated = !!(parsed.meal && typeof parsed.meal === "object" && parsed.meal.basis === "stated");
    const mealUnits = mealStated ? mealBolusUnits(mealCarbs, gp) : 0;
    const mealEstimated = !!mealCarbs && !mealStated;
    // An ANNOUNCED future meal ("je vais manger un McDo"): its bolus happens AT EATING TIME, never
    // now — combinedActionLine words it accordingly, and the estimated case gets plannedMealNote.
    const mealPlanned = !!(parsed.meal && typeof parsed.meal === "object" && parsed.meal.planned === true);

    // SAFETY (overdose guard): if the user just told us they injected a dose, count it toward
    // insulin-on-board NOW and re-run the guard, so we NEVER stack a correction on top of a dose
    // already taken. If the reported dose is clearly more than (meal + the correction we'd advise),
    // treat it as an over-dose: no more insulin + an explicit hypo-watch, overriding everything.
    const reportedUnits = (parsed.insulin && typeof parsed.insulin === "object" && Number.isFinite(Number(parsed.insulin.units)))
      ? Math.min(50, Math.max(0, Number(parsed.insulin.units))) : 0; // clamp so a garbage value can't poison IOB or show an absurd dose
    let guardForAction = guard;
    if (reportedUnits > 0) {
      // Backdate the reported dose if the user said when ("il y a 3h") so its IOB contribution is
      // computed from the real injection time, not "now" (which would overstate it).
      const repTs = backdatedIso(parsed.insulin?.minutesAgo, nowMs);
      const repMs = repTs ? new Date(repTs).getTime() : nowMs;
      const iob2 = activeIob([...insulinDoses, { ts: repMs, units: reportedUnits, kind: "rapid", insulin_name: gp?.rapidInsulin }], nowMs, dia);
      guardForAction = computeGuard({ glucoseMgdl: cur, trend, staleMin, iobUnits: iob2, recentHypo, minSinceRescue, profile: gp });
    }
    const expectedUnits = mealUnits + (guard.kind === "correction" ? guard.insulinUnits : 0);
    const overReported = reportedUnits > 0 && reportedUnits > expectedUnits + 1;

    const insulinForbidden = overReported || (guardForAction.maxInsulinUnits === 0 && mealUnits === 0);
    if (insulinForbidden) { reply = stripInsulinNumbers(reply) || reply; voice = stripInsulinNumbers(voice) || voice; }
    // Insulin allowed: the answer still may not name MORE units than the system decided (correction
    // plus the meal bolus, which is the legitimate total here). Previously unchecked.
    else {
      const ceiling = { ...guardForAction, maxInsulinUnits: guardForAction.maxInsulinUnits + Math.max(0, mealUnits || 0) };
      reply = enforceInsulinCeiling(reply, ceiling) || reply;
      voice = enforceInsulinCeiling(voice, ceiling) || voice;
    }

    let text = reply;
    let voiceText = voice;
    if (scope === "general") {
      // A general answer stays a PURE answer — no diabetic Action appended, nothing logged. The one
      // exception is a LIVE hypo (the kid may be asking about homework while at 55): the code-owned
      // sugar action always wins. Everything else (alarms, banners) is the rest of the app's job.
      if (!signalLost && guard.kind === "sugar") {
        const label = lang === "es" ? "Acción" : "Action";
        const line = combinedActionLine(guard, 0, lang, gp);
        text = `${text}\n\n${label} : ${line}`;
        voiceText = `${voiceText} ${line}`.trim();
      }
    } else if (signalLost) {
      // Reading is older than the 5-min NO SIGNAL window → the LIVE value is unknown, so NEVER append a
      // dose/sugar action off it (mirrors coach + the screen's own NO SIGNAL state). Tell them to
      // reconnect / fingerstick instead — or to REPLACE the sensor when we know it's expired — and
      // strip any dose the model may have stated in its prose.
      const safeReply = stripInsulinNumbers(reply) || reply;
      const safeVoice = stripInsulinNumbers(voice) || voice;
      const label = lang === "es" ? "Acción" : "Action";
      const line = sensorExpired
        ? (lang === "es"
          ? "Sensor caducado: pon un sensor NUEVO lo antes posible (cuenta ~1 h de arranque); mientras tanto, decide solo con una punción capilar."
          : "Capteur expiré : pose un NOUVEAU capteur dès que possible (compte ~1 h de démarrage) ; en attendant, décide uniquement avec un test au doigt.")
        : (lang === "es"
          ? "Señal perdida: reconecta el sensor (acerca el teléfono que lo escanea, vuelve a escanear); si no vuelve, hazte una punción capilar antes de cualquier decisión."
          : "Signal perdu : reconnecte le capteur (rapproche le téléphone qui le scanne, re-scanne) ; s'il ne revient pas, fais un test au doigt avant toute décision.");
      text = `${safeReply}\n\n${label} : ${line}`;
      voiceText = `${safeVoice} ${line}`.trim();
    } else if (overReported) {
      // They already took more than enough — never suggest more insulin; warn about a coming hypo.
      const label = lang === "es" ? "Acción" : "Action";
      const noMore = lang === "es"
        ? "ninguna insulina más ahora; vigila una posible hipo y ten azúcar rápido a mano, recontrola en 15 min."
        : "aucune insuline en plus pour l'instant ; surveille une possible hypo et garde du sucre rapide à portée, recontrôle dans 15 min.";
      text = `${reply}\n\n${label} : ${noMore}`;
      voiceText = `${voice} ${noMore}`.trim();
    } else {
      // Show the code action line for every dose-relevant situation (incl. blocked highs:
      // falling/post-hypo/covered/stale -> explicit "aucune insuline"). Stay silent only for a
      // plain in-range reading or when there's no glucose data at all.
      const showAction = mealUnits > 0 || mealPlanned ||
        !(guardForAction.reason === "in_range" || guardForAction.reason === "no_reading");
      if (showAction) {
        // A meal ANNOUNCED for later is the forward-looking case the whole app exists for ("si je
        // mange 30 sucres dans 10 minutes, combien d'insuline ?"): answer it BEFORE the meal, with
        // the dose, what the carbs would do uncovered and when to inject — instead of waiting for
        // the glucose to rise and reacting to it. planMealDose delegates the correction half to
        // computeGuard, so every no-insulin invariant still holds.
        const line = mealPlanned && (mealCarbs ?? 0) > 0
          ? mealPlanLine(planMealDose({
              glucoseMgdl: cur, trend, staleMin, iobUnits: iob,
              carbsG: mealCarbs, description: parsed.meal?.description,
              minutesUntilMeal: minutesUntil(parsed.meal?.minutesAgo),
              minSinceRescue, recentHypo, profile: gp,
            }), lang, gp)
          : combinedActionLine(guardForAction, mealUnits, lang, gp, mealPlanned);
        const label = lang === "es" ? "Acción" : "Action";
        text = `${reply}\n\n${label} : ${line}`;
        voiceText = `${voice} ${line}`.trim();
      }
      // Hypo while rapid insulin is still active → it'll keep falling, one rescue may not hold; warn
      // (the grams are already bumped for IOB by the guard) so the parent rechecks sooner + re-treats.
      if (guardForAction.kind === "sugar") {
        const warn = hypoIobWarning(iob, lang);
        if (warn) { text = `${text}\n\n${warn}`; voiceText = `${voiceText} ${warn.replace("⚠️", "").trim()}`.trim(); }
      }
      // Estimated (not user-stated) carbs -> no firm number. For an ANNOUNCED future meal, the note
      // still says PLAINLY that insulin will be needed at eating time and whether any dose is on
      // record (the McDo case); otherwise, the usual "log it for a precise dose" nudge.
      if (mealEstimated && guardForAction.kind !== "sugar" && mealPlanned && mealCarbs <= 0) {
        const recentRapid = (insulinDoses || []).some((d: any) => {
          if (!d || d.kind === "basal") return false;
          const t = new Date(d.ts).getTime();
          return Number.isFinite(t) && t <= nowMs + 60000 && nowMs - t <= 45 * 60000;
        });
        const note = plannedMealNote(mealCarbs, recentRapid, lang);
        text = `${text}\n\n${note}`;
        voiceText = `${voiceText} ${note}`.trim();
      } else if (mealEstimated) {
        const nudge = lang === "es"
          ? "Para una dosis de comida precisa, registra los carbohidratos (pestaña Comidas o escanea el producto)."
          : "Pour une dose de repas précise, logge les glucides (onglet Repas ou scanne le produit).";
        text = `${text}\n\n${nudge}`;
      }
    }

    // Pair a meal's carbs with their ~4 g sugar-cube equivalent ONLY when we actually advise a meal
    // bolus for it — there the carb count is the basis of the dose, so it's worth making tangible.
    // For sugar-to-treat-a-low (guard "sugar") or a food merely mentioned in passing (no firm dose),
    // tacking "X g = N sucres" onto the end is noise and can even contradict the user (they said
    // "3 sucres", we'd round 15 g back to "4 sucres") — so we skip it there.
    if (mealUnits > 0 && guardForAction.kind !== "sugar") {
      const cn = lang === "es"
        ? `${mealCarbs} g de carbohidratos (${carbsCubesPhrase(mealCarbs, "es")}).`
        : `${mealCarbs} g de glucides (${carbsCubesPhrase(mealCarbs, "fr")}).`;
      // Spoken, the symbol and the "(s)" are noise — say it the way a person would.
      const cnVoice = lang === "es"
        ? `${mealCarbs} g de carbohidratos, ${carbsCubesPhrase(mealCarbs, "es", true)}.`
        : `${mealCarbs} g de glucides, ${carbsCubesPhrase(mealCarbs, "fr", true)}.`;
      text = `${text}\n\n${cn}`;
      voiceText = `${voiceText} ${cnVoice}`.trim();
      // Starchy food (potato/bread/rice/pasta) isn't sweet but IS high-carb → explain it.
      const sn = starchyCarbNote(parsed.meal?.description, lang);
      if (sn) text = `${text}\n\n${sn}`;
    }

    // Carb SPEED → timing advice: fast sugar (pre-bolus, quick spike normal) vs slow/fatty (late
    // rise, recheck later — fatty also gets the split-bolus note). Skip during a hypo rescue
    // (guard "sugar"): telling someone treating a low to "pre-bolus next time" is contradictory.
    if (parsed.meal && typeof parsed.meal === "object" && guardForAction.kind !== "sugar") {
      const speed = mealCarbSpeed(parsed.meal.description);
      const adv = carbSpeedAdvice(speed, lang, mealPlanned);
      if (adv) {
        text = `${text}\n\n${adv}`;
        // The SPOKEN variant carries no food examples: heard without the parentheses, "(jus, bonbons,
        // pain blanc…)" sounds like a list of what was eaten.
        voiceText = `${voiceText} ${carbSpeedAdvice(speed, lang, mealPlanned, true)}`.trim();
      }
    }

    // Auto-log the meal/dose the AI extracted. A FAILED write used to be SILENT — the reply still
    // said "noted" — so the user could believe a meal/dose was tracked when it wasn't. That's
    // dangerous for insulin (a missing dose breaks IOB → a later correction could stack on it).
    // We now check every write, warn explicitly, and flag `logFailed` for the client.
    let logFailed = false;
    let loggedMeal: any = null;
    if (subject && parsed.meal && typeof parsed.meal === "object" && parsed.meal.description) {
      // Announced meals keep their stated TIME, not just a "planned" flag: "dans 10 minutes" is
      // stored 10 minutes ahead, so the whole app can anticipate it and so it becomes an ordinary
      // eaten meal on its own once that moment passes (isEatenBy).
      const mealTs = offsetIso(parsed.meal.minutesAgo, nowMs);
      // ONE source of truth for "planned": the timestamp. The model's own flag is only a fallback
      // for when it gave no timing at all — the two used to disagree and both were stored.
      const plannedFromTs = mealTs ? Date.parse(mealTs) > nowMs + 5 * 60000 : !!parsed.meal.planned;
      loggedMeal = {
        subject,
        description: String(parsed.meal.description).slice(0, 240),
        carbs_g: mealCarbs,
        planned: plannedFromTs,
        ...(mealTs ? { ts: mealTs } : {}),
      };
      const { error: mErr } = await db.from("mechabetics_meals").insert(loggedMeal);
      if (mErr) {
        loggedMeal = null;
        logFailed = true;
        text += `\n\n${lang === "es"
          ? "⚠️ No pude registrar esta comida — vuelve a anotarla en la pestaña Comidas."
          : "⚠️ Je n'ai pas pu enregistrer ce repas — re-note-le dans l'onglet Repas."}`;
      }
    }

    // Log an insulin dose if the user reported one ("j'ai fait X u de NovoRapid").
    if (subject && reportedUnits > 0) {
      const insTs = offsetIso(parsed.insulin?.minutesAgo, nowMs);
      const { error: iErr } = await db.from("mechabetics_insulin").insert({
        subject,
        units: reportedUnits, // the CLAMPED value — never store a garbage dose that would corrupt future IOB
        insulin_name: parsed.insulin.name ? String(parsed.insulin.name).slice(0, 80) : (profile?.rapid_insulin ?? null),
        kind: "rapid",
        ...(insTs ? { ts: insTs } : {}),
      });
      if (iErr) {
        logFailed = true;
        // Safety-critical: an unrecorded dose breaks future IOB → a later correction could stack on it.
        text += `\n\n${lang === "es"
          ? "⚠️ NO pude registrar esta dosis de insulina. Anótala a mano en la pestaña Insulina, o el cálculo de insulina activa será erróneo."
          : "⚠️ Je n'ai PAS pu enregistrer cette dose d'insuline. Note-la à la main dans l'onglet Insuline, sinon le calcul d'insuline active sera faux."}`;
      }
    }

    // Log a physical activity if mentioned ("je vais courir", "j'ai fait du foot").
    if (subject && parsed.activity && typeof parsed.activity === "object" && (parsed.activity.kind || parsed.activity.description)) {
      const actTs = offsetIso(parsed.activity.minutesAgo, nowMs);
      const { error: aErr } = await db.from("mechabetics_activity").insert({
        subject,
        kind: parsed.activity.kind ? String(parsed.activity.kind).slice(0, 60) : null,
        description: parsed.activity.description ? String(parsed.activity.description).slice(0, 200) : null,
        intensity: ["low", "moderate", "high"].includes(parsed.activity.intensity) ? parsed.activity.intensity : null,
        planned: !!parsed.activity.planned,
        ...(actTs ? { ts: actTs } : {}),
      });
      if (aErr) logFailed = true;
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

    // `scope` lets the client treat a general answer as transient (spoken/shown, never persisted
    // as an analysis) — the user's rule: off-topic answers are answered well but not kept.
    return json({ text, voice: voiceText, audioBase64, mime: "audio/mpeg", isError: false, meal: loggedMeal, logFailed, scope });
  } catch (e) {
    return json({ text: `Erreur serveur: ${(e as Error)?.message ?? e}`, isError: true });
  }
});
