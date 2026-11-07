import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { accessSubject } from "../_shared/access.ts";
import {
  eatenAsTreatment,
  insulinActionMinutes,
  iobSystemLine,
  mealBolusUnits,
  stripInsulinNumbers,
  enforceInsulinCeiling,
  carbsCubesPhrase,
  carbEstimationRules,
  mealCarbSpeed,
  carbSpeedAdvice,
  sugarTimingFact,
  starchyCarbNote,
  speakable,
} from "../_shared/doseGuard.ts";
import { isBasalInsulin } from "../_shared/insulins.ts";
import {
  decisionHint,
  anticipate,
  buildState,
  clock,
  decideAction,
  decisionPayload,
  engineFacts,
  forecastLine,
  sideNotes,
  timedSeries,
} from "../_shared/decide.ts";
import type { Decision, EngineState } from "../_shared/decide.ts";
import {
  clearNamedDose,
  confirmNoRecentInsulin,
  dosePutForward,
  doseSaidAgain,
  loadConversationMemory,
  loadEngineData,
  mealSaidAgain,
  mergeReadings,
  saidBasalDose,
  saysAnotherDose,
  saysAnotherPlate,
  rememberNamedDose,
  storePhoneReadings,
  tzOffsetOf,
} from "../_shared/engineData.ts";
import type { ConversationMemory, EngineData } from "../_shared/engineData.ts";
import { chatJsonWithin, llmErrorKind, llmErrorMessage } from "../_shared/llm.ts";

// A person just spoke and is waiting on an answer; the app gives up at 80 s. Past this the
// model is dropped and the code-owned action answers alone.
const ASK_LLM_MS = 40_000;

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

/** "Je vais manger X" with no time attached: how far ahead to stamp it so `planned` and the clock
 *  cannot disagree. Short on purpose — announcing a meal usually means within the quarter hour, and
 *  once it passes the row becomes an ordinary eaten meal with no flag to clean up. */
const ANNOUNCED_MEAL_LEAD_MIN = 15;

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

// Recent rapid-insulin doses -> a context line (for the model's wording; the guard computes IOB
// itself). A FUTURE-dated dose is a PLANNED injection (not yet active — activeIob skips it): say so
// instead of the nonsense "il y a -53 min". Each PAST dose carries its computed state (still
// working / finished) and the line closes with the SYSTEM total (iobSystemLine) — the model used
// to see only "4 u il y a 290 min" and estimated the decay ITSELF, saying insulin was still ending
// while the computed IOB (and the Insuline tab) said 0.
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
    const m = Math.max(0, mins);
    const ago = m < 60 ? (es ? `hace ${m} min` : `il y a ${m} min`) : (es ? `hace ${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")}` : `il y a ${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")}`);
    return `${what} ${ago} (${state})`;
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

/**
 * What has been said, what has been done, and what is to be done, kept apart in so many words.
 *
 * 6 November, 21:58: the app had proposed "3 u de Fiasp". Asked "c'est ce qu'il a fait ou ce qu'il doit
 * faire ?", the voice answered from the dose log (3 u, two hours earlier), then said there was nothing
 * to do, then that there was. It had never seen the analysis, and each question met it cold.
 */
function factsForTheVoice(s: EngineState, d: Decision, memory: ConversationMemory, lang: string): string {
  const es = lang === "es";
  const tz = s.tzOffsetMin;
  const parts: string[] = [];
  parts.push(es
    ? `ACCIÓN DECIDIDA POR EL SISTEMA AHORA MISMO (se añadirá TAL CUAL debajo de tu respuesta): «${d.line}». Es la misma que en el análisis: NUNCA la contradigas, NUNCA digas otra cosa de una respuesta a la siguiente. Si pregunta qué hacer, es esto.`
    : `ACTION DÉCIDÉE PAR LE SYSTÈME EN CE MOMENT (elle sera ajoutée TELLE QUELLE sous ta réponse) : «${d.line}». C'est la même que dans l'analyse : ne la contredis JAMAIS, ne dis JAMAIS autre chose d'une réponse à l'autre. Si on te demande quoi faire, c'est ça.`);
  const doses = (s.insulin || []).filter((x: any) => x.kind !== "basal" && !isBasalInsulin(x.insulin_name) && new Date(x.ts).getTime() <= s.nowMs && s.nowMs - new Date(x.ts).getTime() <= 8 * 3600000);
  const logged = doses.length
    ? doses.map((x: any) => `${x.units} u ${x.insulin_name ?? ""} (${clock(new Date(x.ts).getTime(), tz)})`.replace("  ", " ")).join(" ; ")
    : (es ? "ninguna" : "aucune");
  parts.push(es
    ? `HECHO (dosis anotadas, ya inyectadas): ${logged}. A HACER (lo que propone la acción de arriba): no está hecho mientras no se anote. No confundas NUNCA las dos cosas: si te preguntan si una dosis «la ha hecho o la tiene que hacer», responde con estas dos listas.`
    : `FAIT (doses notées, déjà injectées) : ${logged}. À FAIRE (ce que propose l'action ci-dessus) : pas fait tant que ce n'est pas noté. Ne confonds JAMAIS les deux : si on te demande si une dose « a été faite ou reste à faire », réponds avec ces deux listes.`);
  const eaten = (s.meals || []).filter((m: any) => {
    const t = new Date(m.ts).getTime();
    return t <= s.nowMs && s.nowMs - t <= 3 * 3600000;
  }).map((m: any) => `${String(m.description ?? "").slice(0, 60)} (${clock(new Date(m.ts).getTime(), tz)})`);
  parts.push(es
    ? `COMIDAS YA ANOTADAS: ${eaten.length ? eaten.join(" ; ") : "ninguna"}. Rellena "meal" e "insulin" SOLO con lo NUEVO, nunca con lo que ya está anotado aquí.`
    : `REPAS DÉJÀ NOTÉS : ${eaten.length ? eaten.join(" ; ") : "aucun"}. Remplis "meal" et "insulin" UNIQUEMENT pour ce qui est NOUVEAU, jamais pour ce qui est déjà noté ici.`);
  if (memory.lastAction) {
    parts.push(es
      ? `ÚLTIMO ANÁLISIS (${clock(memory.lastAction.at, tz)}): «${memory.lastAction.line}». Eso es lo que se le ha enseñado.`
      : `DERNIÈRE ANALYSE (${clock(memory.lastAction.at, tz)}) : «${memory.lastAction.line}». C'est ce qui lui a été montré.`);
  }
  if (s.pending) {
    const at = clock(s.pending.at, tz);
    parts.push(s.pending.split
      ? (es
        ? `DOSIS PROPUESTA SIN RESPUESTA: ${s.pending.units} u a las ${at}, EN DOS VECES. Si dice que se la ha puesto sin decir cuánto, NO rellenes "insulin": pregunta cuántas unidades se puso. Si da una cifra, rellena "insulin" con esa cifra. Si dice que no, pon "pendingAnswer":"not_done".`
        : `DOSE PROPOSÉE SANS RÉPONSE : ${s.pending.units} u à ${at}, EN DEUX FOIS. S'il dit qu'elle a été faite sans dire combien, ne remplis PAS "insulin" : demande combien d'unités ont été faites. S'il donne un chiffre, remplis "insulin" avec ce chiffre. S'il dit que non, mets "pendingAnswer":"not_done".`)
      : (es
        ? `DOSIS PROPUESTA SIN RESPUESTA: ${s.pending.units} u a las ${at}. Si dice que se la ha puesto, rellena "insulin" con esas unidades y el tiempo pasado. Si dice que no, pon "pendingAnswer":"not_done".`
        : `DOSE PROPOSÉE SANS RÉPONSE : ${s.pending.units} u à ${at}. S'il dit qu'elle a été faite, remplis "insulin" avec ces unités et le temps écoulé. S'il dit que non, mets "pendingAnswer":"not_done".`));
  }
  parts.push(es
    ? `Si dice que NO se ha puesto insulina rápida en las últimas 3 h, pon "noRecentInsulin":true.`
    : `S'il dit qu'aucune insuline rapide n'a été faite depuis 3 h, mets "noRecentInsulin":true.`);
  return parts.join(" ");
}

function buildSystem(lang: string, p: any, cur: number | null, series: string, meals: any[], pr: Record<string, string>, insCtx: string, actCtx: string, hint: string, signalLost: boolean, staleMin: number, sensorExpired: boolean, facts: string): string {
  // No name here, on purpose: the history is pseudonymous and the model does not need it.
  const nick = lang === "es" ? "la persona" : "la personne";
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
          ? `GLUCOSA: SENSOR CADUCADO (los 14 días se cumplieron) — sin medición desde hace ${staleMin} min, la actual es DESCONOCIDA; última conocida ${curTxt}. Esa es la CAUSA de la falta de señal: aconseja poner un sensor NUEVO (y una punción capilar mientras tanto) — NADA de «acercar el teléfono» ni «volver a escanear», un sensor terminado no vuelve.`
          : `GLUCOSA: SEÑAL PERDIDA (sin medición desde hace ${staleMin} min) — la actual es DESCONOCIDA; última conocida ${curTxt}. NUNCA digas «estás en X» como si fuera ahora — di «tu última glucosa conocida»; aconseja reconectar el sensor primero (acercar el teléfono que lo escanea, volver a escanear), y una punción capilar si la señal no vuelve.`)
        : `GLUCOSA: actual ${curTxt}.`,
      series,
      `COMIDAS RECIENTES: ${mealsTxt}.`,
      insCtx,
      actCtx,
      hint ? `SITUACIÓN (la calcula el sistema): ${hint}.` : "",
      facts,
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
      `Responde SOLO en JSON: {"scope":"diabetes|general","reply":"<respuesta mostrada en mg/dL — 2-3 frases para diabetes, completa y libre para una pregunta general — SIN número de dosis>","voice":"<lo que se lee en voz alta: para una pregunta general, la respuesta completa; para diabetes, una frase. SIN número de dosis; di la glucosa SIN unidad, solo el número (ej 78, 218)>","meal":{"description":"<comida>","carbsG":<numero>,"planned":<true si futura, false si ya comida>,"basis":"stated|estimated","minutesAgo":<minutos desde que comió, 0 si ahora, NEGATIVO si es futuro (dentro de 10 min → -10)>}|null,"insulin":{"units":<numero>,"name":"<insulina>","minutesAgo":<minutos desde la inyección, 0 si ahora>}|null,"activity":{"kind":"<tipo>","description":"<texto>","intensity":"low|moderate|high","planned":<true|false>,"minutesAgo":<minutos, 0 si ahora>}|null,"noRecentInsulin":<true|false>,"pendingAnswer":"not_done"|null}`,
    ].filter(Boolean).join(" ");
  }
  return [
    persona,
    `PORTÉE ("scope") : décide d'abord si la question touche sa santé / glycémie / diabète / repas / insuline / sport / sommeil / son corps → "scope":"diabetes", ou si c'est une question générale sans rapport (devoirs, culture, sciences, jeux, discussion) → "scope":"general". Question GÉNÉRALE : réponds-y VRAIMENT et complètement, comme un assistant intelligent et bienveillant (adapté à un enfant/ado) — SANS limite de 2-3 phrases, ne parle PAS de diabète ni de glycémie (sauf s'il le demande), et mets "meal","insulin","activity" à null (ne loggue rien). Question DIABÈTE : applique toutes les règles ci-dessous.`,
    `PROFIL : ${profileLine}.`,
    signalLost
      ? (sensorExpired
        ? `GLYCÉMIE : CAPTEUR EXPIRÉ (les 14 jours sont atteints) — plus aucune mesure depuis ${staleMin} min, l'actuelle est INCONNUE ; dernière connue ${curTxt}. C'est la CAUSE de l'absence de signal : conseille de poser un NOUVEAU capteur (et un test au doigt en attendant) — PAS de « rapprocher le téléphone » ni de « re-scanner », un capteur fini ne revient pas.`
        : `GLYCÉMIE : SIGNAL PERDU (aucune mesure depuis ${staleMin} min) — l'actuelle est INCONNUE ; dernière connue ${curTxt}. Ne dis JAMAIS « tu es à X » comme si c'était maintenant — dis « ta dernière glycémie connue » ; conseille de reconnecter le capteur d'abord (rapprocher le téléphone qui le scanne, re-scanner), et un test au doigt si le signal ne revient pas.`)
      : `GLYCÉMIE : actuelle ${curTxt}.`,
    series,
    `REPAS RÉCENTS : ${mealsTxt}.`,
    insCtx,
    actCtx,
    hint ? `SITUATION (calculée par le système) : ${hint}.` : "",
    facts,
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
    `Réponds UNIQUEMENT en JSON : {"scope":"diabetes|general","reply":"<réponse affichée en mg/dL — 2-3 phrases pour le diabète, complète et libre pour une question générale — SANS chiffre de dose>","voice":"<ce qui est lu à voix haute : pour une question générale, la réponse complète ; pour le diabète, une phrase. SANS chiffre de dose ; dis la glycémie SANS unité, juste le nombre (ex 78, 218)>","meal":{"description":"<aliment>","carbsG":<nombre>,"planned":<true si à venir, false si déjà mangé>,"basis":"stated|estimated","minutesAgo":<minutes depuis qu'il a mangé, 0 si maintenant, NÉGATIF si c'est à venir (dans 10 min → -10)>}|null,"insulin":{"units":<nombre>,"name":"<insuline>","minutesAgo":<minutes depuis l'injection, 0 si maintenant>}|null,"activity":{"kind":"<type>","description":"<texte>","intensity":"low|moderate|high","planned":<true|false>,"minutesAgo":<minutes, 0 si maintenant>}|null,"noRecentInsulin":<true|false>,"pendingAnswer":"not_done"|null}`,
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
    // A TRIAL RUN: the whole answer, and nothing written anywhere. What checks a deployment against a
    // real record without touching it. The app never sends it.
    const dryRun = body.defer === true;
    // A question the app asked by itself when an alarm went off. Its wording ("je viens de prendre du
    // sucre") is a template, not news: filed as a meal it would turn "Prends 12 g" into "laisse agir".
    const automatic = body.auto === true;
    // The CLIENT knows the sensor's expiry (LibreLinkUp activation + 14 d) — when it says the sensor
    // is expired, a lost signal has a known cause: advise a NEW sensor, not "re-scan / move closer".
    const sensorExpired = body.sensorExpired === true;
    const didntCatch = lang === "es" ? "No te he entendido, ¿puedes repetir?" : "Je n'ai pas compris, tu peux répéter ?";
    if (!question) return json({ text: didntCatch, isError: true });
    // No BYOK gate any more: text runs on the service's own key (see IGNORE_BYOK_FOR_TEXT in
    // llm.ts), so a phone with "Mode Hosted" off is no longer refused an answer.
    if (!DEEPSEEK_API_KEY) {
      return json({ text: lang === "es"
        ? "La IA no está configurada en el servidor. Avísanos."
        : "L'IA n'est pas configurée côté serveur. Préviens-nous.", isError: true });
    }

    const nowMs = Date.now();
    const empty: EngineData = {
      profile: null, stored: [], ...mergeReadings([], readings, nowMs), insulin: [], meals: [], activity: [],
      model: null, modelFittedAt: null,
    };
    // Same data as the analysis, including the stored history: the voice used to judge the trend from
    // the twelve readings the phone happened to send.
    const data = subject ? await loadEngineData(db, subject, nowMs, readings, 6) : empty;
    if (subject && !dryRun) await storePhoneReadings(db, subject, data.accepted);
    const profile = data.profile;
    const tzOffsetMin = tzOffsetOf(body, profile);
    const memory = subject ? await loadConversationMemory(db, subject, nowMs) : { turns: [], lastAction: null };
    const engine = (meals: any[], insulin: any[], prof: any) => buildState({
      nowMs, lang, tzOffsetMin, profile: prof, readings: data.series, insulin, meals, activity: data.activity,
      sensorExpired, model: data.model,
    });
    // THE SAME DECISION AS THE ANALYSIS, known before the model writes a word.
    const state0 = engine(data.meals, data.insulin, profile);
    const decision0 = decideAction(state0);
    const ahead0 = anticipate(state0, decision0);
    const { cur, guard, iob, signalLost, staleMin } = state0;
    const hint = decisionHint(state0, decision0);
    const recentInsulin = data.insulin.filter((d: any) => new Date(d.ts).getTime() > nowMs - 8 * 3600000);
    const insCtx = insulinContext(recentInsulin, iob, nowMs, lang);
    const actCtx = activityContext(data.activity, lang);
    const pr = await loadPrompts(lang);
    const facts = [factsForTheVoice(state0, decision0, memory, lang), signalLost ? "" : engineFacts(state0, decision0, ahead0)].filter(Boolean).join(" ");
    const sys = buildSystem(lang, profile, cur, signalLost ? "" : timedSeries(state0), data.meals, pr, insCtx, actCtx, hint, signalLost, staleMin, sensorExpired, facts);
    // The turns spoken in the last minutes, oldest first, so "et sinon ?" or "non, plutôt du riz" lands
    // in context instead of being answered cold. From the phone if it sent them, otherwise from the
    // log: the app was sending none, and every question met a stranger.
    const sentTurns = (Array.isArray(body.conversation) ? body.conversation : [])
      .slice(-8)
      .map((t: any) => `${t?.role === "ai" ? "Dr Claude" : (lang === "es" ? "Él" : "Lui")} : ${String(t?.text ?? "").slice(0, 400)}`)
      .filter((l: string) => l.length > 8);
    const convo = (sentTurns.length ? sentTurns : memory.turns.map((t) =>
      `${lang === "es" ? "Él" : "Lui"} : ${t.question.slice(0, 300)}\nDr Claude : ${t.reply.slice(0, 400)}`)).join("\n");

    let raw = "";
    try {
      // IN A CONVERSATION, THE PREVIOUS TURNS ARE PART OF THE QUESTION. Each spoken segment is its
      // own request, so without this the assistant met every sentence as a stranger: "et sinon ?"
      // meant nothing, and someone who just wanted to talk got a fresh clinical greeting every time.
      // The turns are prepended as plain context; the JSON contract for the answer is unchanged.
      const userMsg = convo
        ? `${lang === "es" ? "CONVERSACIÓN EN CURSO (lo ya dicho, para que sigas el hilo):" : "CONVERSATION EN COURS (ce qui a déjà été dit, pour garder le fil) :"}
${convo}

${lang === "es" ? "AHORA dice:" : "MAINTENANT il dit :"} ${question}`
        : question;
      raw = await chatJsonWithin(
        { system: sys, user: userMsg, temperature: 0.3, maxTokens: 4000 },
        { byokGeminiKey, deepseekKey: DEEPSEEK_API_KEY, deepseekModel: DEEPSEEK_MODEL, geminiModel: GEMINI_TEXT_MODEL },
        ASK_LLM_MS,
      );
    } catch (e) {
      // The dose guard is LLM-independent: even if the AI is down, still return the code-owned safe
      // action (rescue sugar for a hypo, a correction for a high, or "recheck") rather than nothing.
      // Say WHICH problem it is (down / out of credits / rate-limited / bad key) so the user knows
      // whether to wait, recharge, or fix a key — instead of one opaque "AI not responding".
      const kind = llmErrorKind(e);
      const head = llmErrorMessage(kind, lang, false) /* text runs on the service key only */;
      const show = guard.reason !== "no_reading";
      const out = show ? `${head}\n\n${lang === "es" ? "Acción" : "Action"} : ${decision0.line}` : head;
      if (show && !dryRun && dosePutForward(decision0)) await rememberNamedDose(db, subject as string, state0, decision0);
      return json({
        text: out, isError: true, errorKind: kind, actionLine: show ? decision0.line : "",
        decision: decisionPayload(state0, decision0, ahead0),
      });
    }
    let parsed: any = {};
    try { parsed = JSON.parse(raw); } catch { parsed = {}; }
    if (automatic) parsed = { ...parsed, meal: null, insulin: null, activity: null, noRecentInsulin: false, pendingAnswer: null };
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
    const mealStated = !!(parsed.meal && typeof parsed.meal === "object" && parsed.meal.basis === "stated");
    const mealEstimated = !!mealCarbs && !mealStated;
    const hasMeal = !!(parsed.meal && typeof parsed.meal === "object" && parsed.meal.description);
    const mealPlanned = !!(parsed.meal && typeof parsed.meal === "object" && parsed.meal.planned === true);
    const reportedUnits = (parsed.insulin && typeof parsed.insulin === "object" && Number.isFinite(Number(parsed.insulin.units)))
      ? Math.min(50, Math.max(0, Number(parsed.insulin.units))) : 0; // clamp so a garbage value can't poison IOB or show an absurd dose

    // Announced meals keep their stated TIME, not just a "planned" flag: "dans 10 minutes" is stored
    // 10 minutes ahead, so the whole app can anticipate it and it becomes an ordinary eaten meal on its
    // own once that moment passes (isEatenBy). An announced meal with no stated time gets a short lead
    // so flag and clock can never disagree.
    const statedTs = offsetIso(parsed.meal?.minutesAgo, nowMs);
    const announced = !statedTs && mealPlanned;
    const mealTs = announced ? new Date(nowMs + ANNOUNCED_MEAL_LEAD_MIN * 60000).toISOString() : statedTs;
    // Planned means it has not happened yet. "Dans 3 minutes" stored as eaten, with a time still ahead,
    // was neither eaten nor announced: invisible to the decision until that time came.
    const plannedFromTs = mealTs ? Date.parse(mealTs) > nowMs : false;
    const insTs = offsetIso(parsed.insulin?.minutesAgo, nowMs);

    // Said again, it is not a second meal or a second dose. Nothing new is written or counted.
    const mealDesc = hasMeal ? String(parsed.meal.description).slice(0, 240) : "";
    // A background insulin said out loud is a background insulin: stored as rapid, 14 u of Lantus read
    // as a dose that covers the next meal. With no name from the model, the word beside the figure decides.
    const saidName = parsed.insulin?.name ? String(parsed.insulin.name).slice(0, 80) : null;
    const saidBasal = saidName
      ? isBasalInsulin(saidName) || /\b(lente|lenta|basale?)\b/i.test(saidName)
      : saidBasalDose(question, reportedUnits);
    const mealAgain = hasMeal && !saysAnotherPlate(question, mealDesc) &&
      mealSaidAgain(data.meals, mealDesc, mealCarbs, mealTs ? Date.parse(mealTs) : nowMs, mealStated);
    const doseAgain = reportedUnits > 0 && !saysAnotherDose(question) &&
      doseSaidAgain(data.insulin, reportedUnits, insTs ? Date.parse(insTs) : nowMs, saidBasal);
    const doseName = saidBasal
      ? (isBasalInsulin(saidName) ? saidName : (profile?.basal_insulin ?? saidName))
      : (saidName ?? profile?.rapid_insulin ?? null);
    const doseKind = saidBasal ? "basal" : "rapid";

    // WHAT WAS JUST SAID COUNTS EXACTLY LIKE WHAT IS LOGGED. A meal or a dose stated in this sentence
    // joins the rows and the very same decision runs again: the voice can no longer reach an answer
    // the analysis would not give a second later, once the row is in the table.
    const saidMeal = hasMeal && !mealAgain
      ? [{ ts: mealTs ?? new Date(nowMs).toISOString(), description: mealDesc, carbs_g: mealCarbs, planned: plannedFromTs, carbs_estimated: mealEstimated }]
      : [];
    const saidDose = reportedUnits > 0 && !doseAgain
      ? [{ ts: insTs ?? new Date(nowMs).toISOString(), units: reportedUnits, kind: doseKind, insulin_name: doseName }]
      : [];
    // What turns a conditional dose into a firm one: it has to have been said, in words, about this.
    // The model's flag alone is not enough, and a general question has nothing to do with insulin.
    const saidNoInsulin = scope !== "general" && parsed.noRecentInsulin === true && reportedUnits <= 0 &&
      /\b(non|pas|rien|aucune?|jamais|no|nada|ninguna?|sin)\b/i.test(question);
    const saidNotDone = scope !== "general" && parsed.pendingAnswer === "not_done";
    const profileNow = profile
      ? {
        ...profile,
        ...(saidNoInsulin ? { no_insulin_confirmed_at: new Date(nowMs).toISOString(), pending_action: null } : {}),
        ...(saidNotDone ? { pending_action: null } : {}),
      }
      : profile;
    const state = engine([...saidMeal, ...data.meals], [...saidDose, ...data.insulin], profileNow);
    let decision = decideAction(state);

    // They already took more than this moment calls for: no more insulin, and a hypo watch. Only for a
    // dose taken about now; one from three hours ago has nothing to say about this moment's need. What
    // this moment calls for includes what the engine was about to name: "il a fait 3 u" with 120 g in
    // the log is a dose short of the meal, not one too many.
    const justTaken = reportedUnits > 0 && !saidBasal && !doseAgain && Math.abs(Number(parsed.insulin?.minutesAgo) || 0) <= 60;
    const expectedUnits = mealBolusUnits(mealCarbs, state0.gp)
      + Math.max(decision0.units, decision0.laterUnits, state0.pending?.units ?? 0, guard.kind === "correction" && !decision0.capped ? guard.insulinUnits : 0);
    const overReported = justTaken && reportedUnits > expectedUnits + 1;
    // It replaces the decision itself, so sentence, buttons and memory all say the same thing. Never a
    // low: 60 mg/dL with 3 u just given is the worst moment to say "watch for a hypo" instead of grams.
    if (overReported && decision.kind !== "sugar" && decision.kind !== "signal") {
      decision = {
        ...decision, kind: "hold", units: 0, laterUnits: 0, split: false, nothingDue: true, insulinForbidden: true,
        line: lang === "es"
          ? "Ninguna insulina más ahora; vigila una posible hipo y ten azúcar rápido a mano, recontrola en 15 min."
          : "Aucune insuline en plus pour l'instant ; surveille une possible hypo et garde du sucre rapide à portée, recontrôle dans 15 min.",
      };
    }
    const ahead = anticipate(state, decision);
    const payload = decisionPayload(state, decision, ahead);

    if (decision.insulinForbidden) { reply = stripInsulinNumbers(reply) || reply; voice = stripInsulinNumbers(voice) || voice; }
    else {
      const ceiling = { ...state.guard, maxInsulinUnits: decision.proseCeiling };
      reply = enforceInsulinCeiling(reply, ceiling) || reply;
      voice = enforceInsulinCeiling(voice, ceiling) || voice;
    }

    let text = reply;
    let voiceText = voice;
    const label = lang === "es" ? "Acción" : "Action";
    let actionLine = "";
    if (scope === "general") {
      // A general answer stays a PURE answer. The one exception is a LIVE hypo (the kid may be asking
      // about homework while at 55): the code-owned sugar action always wins.
      if (decision.kind === "sugar") {
        actionLine = decision.line;
        text = `${text}\n\n${label} : ${decision.line}`;
        voiceText = `${voiceText} ${speakable(decision.line, lang)}`.trim();
      }
    } else {
      // ALWAYS AN ACTION, on every diabetes question, and the same sentence as the analysis.
      actionLine = decision.line;
      text = `${text}\n\n${label} : ${decision.line}`;
      voiceText = `${voiceText} ${speakable(decision.line, lang)}`.trim();
      if (ahead) {
        text = `${text}\n\n${lang === "es" ? "A prever" : "À prévoir"} : ${ahead.line}`;
        voiceText = `${voiceText} ${speakable(ahead.line, lang)}`.trim();
      }
      const likely = signalLost ? "" : forecastLine(state.forecast, lang);
      if (likely) text = `${text}\n\n${lang === "es" ? "Previsión" : "Prévision"} : ${likely}`;
      for (const n of sideNotes(state, decision)) {
        text = `${text}\n\n${n.display}`;
        voiceText = `${voiceText} ${n.voice}`.trim();
      }
      if (mealEstimated && decision.kind !== "sugar" && !signalLost) {
        const nudge = lang === "es"
          ? "Son carbohidratos estimados: para una dosis más precisa, anótalos en la pestaña Comidas o escanea el producto."
          : "Ces glucides sont estimés : pour une dose plus précise, note-les dans l'onglet Repas ou scanne le produit.";
        text = `${text}\n\n${nudge}`;
      }
    }

    // Pair a meal's carbs with their ~4 g sugar-cube equivalent ONLY when we actually advise a meal
    // bolus for it — there the carb count is the basis of the dose, so it's worth making tangible.
    // For sugar-to-treat-a-low (guard "sugar") or a food merely mentioned in passing (no firm dose),
    // tacking "X g = N sucres" onto the end is noise and can even contradict the user (they said
    // "3 sucres", we'd round 15 g back to "4 sucres") — so we skip it there.
    if ((decision.units > 0 || decision.laterUnits > 0) && mealCarbs && decision.kind !== "sugar" && scope !== "general") {
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
    const eatenForALow = hasMeal && eatenAsTreatment(mealTs ? Date.parse(mealTs) : nowMs, state.readings, mealCarbs, mealDesc);
    const doseStands = (decision.units > 0 || decision.laterUnits > 0) && !decision.capped;
    if (parsed.meal && typeof parsed.meal === "object" && decision.kind !== "sugar" && !eatenForALow && doseStands) {
      const speed = mealCarbSpeed(parsed.meal.description);
      const adv = carbSpeedAdvice(speed, lang, mealPlanned);
      if (adv) {
        text = `${text}\n\n${adv}`;
        // The SPOKEN variant carries no food examples: heard without the parentheses, "(jus, bonbons,
        // pain blanc…)" sounds like a list of what was eaten.
        voiceText = `${voiceText} ${carbSpeedAdvice(speed, lang, mealPlanned, true)}`.trim();
      }
    }

    // Treated as already known: said, so the mistake can be seen and put right. Taken for a repeat, a
    // real dose would otherwise vanish behind the model's "c'est noté".
    if (doseAgain) {
      const known = lang === "es"
        ? "Esta dosis ya está anotada: no la cuento dos veces. Si es otra, di «me he puesto otra»."
        : "Cette dose est déjà notée : je ne la compte pas deux fois. Si c'en est une autre, dis « j'en ai refait une ».";
      text = `${text}\n\n${known}`;
      voiceText = `${voiceText} ${known}`.trim();
    }
    if (mealAgain) {
      const known = lang === "es"
        ? "Esta comida ya está anotada: no la cuento dos veces. Si es otra, di «otra ración»."
        : "Ce repas est déjà noté : je ne le compte pas deux fois. Si c'en est un autre, dis « encore un ».";
      text = `${text}\n\n${known}`;
      voiceText = `${voiceText} ${known}`.trim();
    }

    // Auto-log the meal/dose the AI extracted. A FAILED write used to be SILENT — the reply still
    // said "noted" — so the user could believe a meal/dose was tracked when it wasn't. That's
    // dangerous for insulin (a missing dose breaks IOB → a later correction could stack on it).
    // We now check every write, warn explicitly, and flag `logFailed` for the client.
    let logFailed = false;
    let loggedMeal: any = null;
    let wroteSomething = false;
    const writing = !!subject && !dryRun;
    if (writing && saidMeal.length) {
      loggedMeal = {
        subject,
        description: mealDesc,
        carbs_g: mealCarbs,
        planned: plannedFromTs,
        carbs_estimated: mealEstimated,
        ...(mealTs ? { ts: mealTs } : {}),
      };
      const { error: mErr } = await db.from("mechabetics_meals").insert(loggedMeal);
      wroteSomething = wroteSomething || !mErr;
      if (mErr) {
        loggedMeal = null;
        logFailed = true;
        const warning = lang === "es"
          ? "⚠️ No pude registrar esta comida — vuelve a anotarla en la pestaña Comidas."
          : "⚠️ Je n'ai pas pu enregistrer ce repas — re-note-le dans l'onglet Repas.";
        text += `\n\n${warning}`;
        voiceText = `${voiceText} ${warning.replace("⚠️ ", "")}`.trim();
      }
    }

    // Log an insulin dose if the user reported one ("j'ai fait X u de NovoRapid").
    if (writing && saidDose.length) {
      const insulinRow = {
        subject,
        units: reportedUnits, // the CLAMPED value — never store a garbage dose that would corrupt future IOB
        insulin_name: doseName,
        kind: doseKind,
        // The time the sum used. Left to the database it comes after the model's answer, later than
        // the knownDoseAt stored with it, and this dose then reads as the answer to its own question.
        ts: saidDose[0].ts,
      };
      const { error: iErr } = await db.from("mechabetics_insulin").insert(insulinRow);
      wroteSomething = wroteSomething || !iErr;
      if (iErr) {
        logFailed = true;
        // Safety-critical: an unrecorded dose breaks future IOB → a later correction could stack on it.
        const warning = lang === "es"
          ? "⚠️ NO pude registrar esta dosis de insulina. Anótala a mano en la pestaña Insulina, o el cálculo de insulina activa será erróneo."
          : "⚠️ Je n'ai PAS pu enregistrer cette dose d'insuline. Note-la à la main dans l'onglet Insuline, sinon le calcul d'insuline active sera faux.";
        text += `\n\n${warning}`;
        voiceText = `${voiceText} ${warning.replace("⚠️ ", "")}`.trim();
      }
    }

    // Log a physical activity if mentioned ("je vais courir", "j'ai fait du foot").
    if (writing && parsed.activity && typeof parsed.activity === "object" && (parsed.activity.kind || parsed.activity.description)) {
      const actTs = offsetIso(parsed.activity.minutesAgo, nowMs);
      const activityRow = {
        subject,
        kind: parsed.activity.kind ? String(parsed.activity.kind).slice(0, 60) : null,
        description: parsed.activity.description ? String(parsed.activity.description).slice(0, 200) : null,
        intensity: ["low", "moderate", "high"].includes(parsed.activity.intensity) ? parsed.activity.intensity : null,
        planned: !!parsed.activity.planned,
        ...(actTs ? { ts: actTs } : {}),
      };
      const { error: aErr } = await db.from("mechabetics_activity").insert(activityRow);
      wroteSomething = wroteSomething || !aErr;
      if (aErr) {
        logFailed = true;
        const warning = lang === "es"
          ? "⚠️ No pude registrar esta actividad — vuelve a anotarla en la pestaña Deporte."
          : "⚠️ Je n'ai pas pu enregistrer cette activité — re-note-la dans l'onglet Sport.";
        text += `\n\n${warning}`;
        voiceText = `${voiceText} ${warning.replace("⚠️ ", "")}`.trim();
      }
    }

    if (writing) {
      if (saidNoInsulin) await confirmNoRecentInsulin(db, subject as string, nowMs);
      else if (saidNotDone) await clearNamedDose(db, subject as string);
      if (dosePutForward(decision) && scope !== "general") await rememberNamedDose(db, subject as string, state, decision);
      // Written down, so the next question has a memory and the family has a record. Off-topic
      // answers are answered well but not kept: the rule since the start.
      if (scope !== "general") {
        const { error: vErr } = await db.from("mechabetics_voice_log").insert({
          subject, question: question.slice(0, 500), reply: text.slice(0, 2000), action: actionLine || null, scope,
        });
        if (vErr) console.error("ask: voice log not written:", vErr.message);
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

    // `scope` lets the client treat a general answer as transient (spoken/shown, never persisted
    // as an analysis) — the user's rule: off-topic answers are answered well but not kept.
    return json({
      text, voice: voiceText, audioBase64, mime: "audio/mpeg", isError: false, meal: loggedMeal,
      logFailed, scope, actionLine, decision: scope === "general" ? null : payload,
      // Something went on record: an analysis on screen no longer describes the moment.
      logged: wroteSomething || (writing && (saidNoInsulin || saidNotDone)),
    });
  } catch (e) {
    return json({ text: `Erreur serveur: ${(e as Error)?.message ?? e}`, isError: true });
  }
});
