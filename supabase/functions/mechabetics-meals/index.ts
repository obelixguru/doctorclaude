import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { accessSubject } from "../_shared/access.ts";
import { chatJsonWithin } from "../_shared/llm.ts";
import {
  carbEstimationRules,
  MEAL_COVER_WINDOW_MIN,
  MEAL_COVER_FRACTION,
  type MealPlanResult,
} from "../_shared/doseGuard.ts";
import { anticipate, buildState, decideAction, decisionPayload, sideNotes } from "../_shared/decide.ts";
import {
  clearNamedDose,
  confirmNoRecentInsulin,
  loadEngineData,
  dosePutForward,
  rememberNamedDose,
  tzOffsetOf,
} from "../_shared/engineData.ts";
import { isBasalInsulin } from "../_shared/insulins.ts";
import { lookupBarcode, lookupProduct, foodFactLine, type FoodFact } from "../_shared/foodFacts.ts";

// How long ONE call to the model may take. Not a guarantee on its own: chatJson retries once when
// the answer was cut off, and the product lookup runs before it — measured live, a "22 s per call"
// budget still produced a 47 s answer, i.e. past the phone's 45 s. The two budgets below are the
// real promise; this only keeps a single stalled call from eating all of one.
const ESTIMATE_BUDGET_MS = 20_000;

/** SAVING A MEAL: how long the parent waits before the meal is written no matter what. Short on
 *  purpose — the meal is stored with whatever we have and the estimate, if it is still running,
 *  finishes in the background and fills the carbs in (see finishInBackground). Nothing about the
 *  save depends on the model any more, so there is no slow provider that can turn into an error. */
const SAVE_ESTIMATE_MS = 12_000;

/** ASKING "how much insulin for this?" (plan / editing a meal): nothing is being written, so a
 *  slow answer beats no answer. Still far enough under the phone's 45 s to never time out. */
const ASK_ESTIMATE_MS = 28_000;

/** Resolves with `fallback` if `p` has not settled within `ms`. The work behind `p` cannot be
 *  called back, but the parent waiting on the meal screen gets an answer on time — which is the
 *  whole point: the carb figure is a convenience, the meal being SAVED is not. */
async function withDeadline<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clock = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  try {
    return await Promise.race([p, clock]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** The estimate outlived the save deadline: let it finish and write the carbs onto the row that is
 *  ALREADY stored. `EdgeRuntime.waitUntil` keeps the isolate alive past the response; where it does
 *  not exist the promise simply runs as long as the platform allows. Guarded so a figure that is
 *  already there — one the parent typed in the meantime — is never overwritten. */
function finishInBackground(p: Promise<CarbEstimate>, id: number, quantity: number): void {
  if (!Number.isFinite(id) || id <= 0) return;
  const job = p.then(async (r) => {
    const n = r?.carbsG;
    if (n == null || !(n > 0)) return;
    await db.from("mechabetics_meals")
      .update({ carbs_g: Math.min(2000, Math.round(n) * quantity), carbs_estimated: !r?.fact })
      .eq("id", id).is("carbs_g", null);
  }).catch(() => { /* the meal is saved; a missing estimate is not an error */ });
  const rt = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime;
  if (rt && typeof rt.waitUntil === "function") rt.waitUntil(job);
}

// Re-saving the SAME wording inside this window is a retry, not a second helping (see the add
// handler). Kept short so a genuine re-treatment of a low — same "3 sucres", a quarter of an hour
// later per the rule of 15 — is still recorded as its own meal.
const DEDUPE_WINDOW_MIN = 3;

/** Wording compared the way a person would: case, accents, spacing and trailing punctuation are
 *  not what makes two entries different meals. */
const normDesc = (s: string): string =>
  // Strip the combining marks FIRST: after NFD an accent is its own character, so folding it
  // into the separator class turned "limon" into "limo n" and the retry slipped through.
  s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ").trim();

const DEEPSEEK_API_KEY = Deno.env.get("MECHABETICS_DEEPSEEK_API_KEY") ?? "";
const DEEPSEEK_MODEL = Deno.env.get("MECHABETICS_DEEPSEEK_MODEL") ?? "deepseek-v4-flash";
const GEMINI_TEXT_MODEL = Deno.env.get("MECHABETICS_GEMINI_TEXT_MODEL") ?? "gemini-2.5-flash";

/** Estimate a meal's carbs (g) from its description via the LLM, so the user never HAS to type
 *  them — diabetes carb-counting is exactly what the AI is good at. Best-effort: returns null when
 *  no AI key is available or the call fails (the meal is still logged, just without a carb number). */
type CarbEstimate = { carbsG: number | null; fact: FoodFact | null };

async function estimateCarbs(
  description: string,
  geminiKey?: unknown,
  country?: string | null,
  barcode?: string | null,
  lang = "fr",
): Promise<CarbEstimate> {
  const es = lang === "es";
  // A SOURCED FIGURE FIRST, ALWAYS. The model answers packaged products from memory with a single
  // global number — that is how a 33 cl 7UP became 35 g when its Spanish label says 16. A barcode is
  // the label itself; a country listing is at least the right market. Either one, when found, is
  // handed to the model as the authoritative value it must multiply by the quantity described.
  // When nothing is found we are exactly where we were before, and the caller says "estimation".
  let fact: FoodFact | null = null;
  try {
    fact = barcode ? await lookupBarcode(barcode) : null;
    if (!fact) fact = await lookupProduct(description, country ?? null);
  } catch (_) { fact = null; }

  const byok = typeof geminiKey === "string" ? geminiKey.trim() : "";
  if (!byok && !DEEPSEEK_API_KEY) return { carbsG: null, fact };
  const where = country
    ? (es
      ? ` La persona está en: ${country}. Los valores nutricionales de un mismo producto varían según el país — razona para ESE mercado.`
      : ` La personne est en : ${country}. Les valeurs nutritionnelles d'un même produit varient selon le pays — raisonne pour CE marché.`)
    : "";
  try {
    const raw = await chatJsonWithin(
      {
        system: es
          ? `Estimas los carbohidratos de un alimento para una persona diabética.${where} ${carbEstimationRules("es")}${fact ? " " + foodFactLine(fact, "es") : ""} Responde ÚNICAMENTE en JSON {"carbsG":<gramos enteros de carbohidratos para TODO lo descrito>}. Sin texto.`
          : `Tu estimes les glucides d'un aliment pour une personne diabétique.${where} ${carbEstimationRules("fr")}${fact ? " " + foodFactLine(fact, "fr") : ""} Réponds UNIQUEMENT en JSON {"carbsG":<grammes entiers de glucides pour TOUT ce qui est décrit>}. Pas de texte.`,
        user: fact
          ? (es ? `Alimento: ${description}` : `Aliment : ${description}`)
          : (es
            ? `Alimento: ${description}${country ? ` — comprado/consumido en ${country}` : ""}. Si es un producto envasado de una marca, BUSCA su ficha nutricional oficial PARA ESE PAÍS (carbohidratos por 100 g o 100 ml) antes de responder, y multiplícala por la cantidad descrita. El mismo producto no tiene la misma receta según el país.`
            : `Aliment : ${description}${country ? ` — acheté/consommé en ${country}` : ""}. S'il s'agit d'un produit emballé d'une marque, CHERCHE sa valeur nutritionnelle officielle POUR CE PAYS (glucides pour 100 g ou 100 ml) avant de répondre, puis multiplie par la quantité décrite. Le même produit n'a pas la même recette selon le pays.`),
        // SEARCH THE WORLD FOR A PACKAGED PRODUCT. A brand's carbohydrate content is a public fact
        // that differs by country, not something to recall — which is how a Spanish 7UP became a
        // global 35 g. Grounding is skipped when the barcode already gave us the label (nothing to
        // look up) and it degrades to a plain call when unavailable, so it can only ever add.
        search: !fact,
        temperature: 0,
        maxTokens: fact ? 200 : 900,
        // A PARENT IS STARING AT A SPINNER. The phone gives up at 45 s (OkHttp callTimeout) and
        // says « Échec de l'enregistrement » — while this function, still waiting on the model,
        // goes on to insert the meal anyway. That is how one ice cream became four rows on
        // 2026-08-05. The estimate is a CONVENIENCE (the parent can always type the grams); the
        // saving is not. So it gets a hard budget far under the phone's, and on timeout the meal
        // is logged with no carb figure rather than not logged at all.
        timeoutMs: ESTIMATE_BUDGET_MS,
      },
      { byokGeminiKey: byok, deepseekKey: DEEPSEEK_API_KEY, deepseekModel: DEEPSEEK_MODEL, geminiModel: GEMINI_TEXT_MODEL },
      ESTIMATE_BUDGET_MS,
    );
    const parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] ?? "{}");
    const n = Math.round(Number(parsed.carbsG));
    return { carbsG: Number.isFinite(n) && n > 0 ? Math.min(300, n) : null, fact };
  } catch {
    return { carbsG: null, fact };
  }
}

// Doctor Claude - repas: liste / ajout (cle = subject, pseudonyme).
// L'IA (mechabetics-ask) loggue deja les repas dits a la voix ; ici on les LISTE
// pour la page Nourritures, et on permet un ajout manuel.

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { ...CORS, "content-type": "application/json" } });
}

/** A client-supplied epoch-ms (backdating a forgotten meal/dose, or PLANNING one ahead), clamped to
 *  a sane window [now-14d, now+36h]. The future side enables planned meals (`planned` derives from a
 *  future ts) and planned insulin doses — every IOB computation (server activeIob + the 3 client
 *  sites) ignores a dose whose ts hasn't arrived yet, so a planned dose can't silence a HIGH alarm
 *  or shrink a correction before it's actually injected. Returns an ISO string, or null when absent
 *  (=> DB stamps now). */
function clampTs(raw: unknown): string | null {
  const t = Number(raw);
  if (!Number.isFinite(t) || t <= 0) return null;
  const now = Date.now();
  return new Date(Math.max(now - 14 * 24 * 3600 * 1000, Math.min(t, now + 36 * 3600 * 1000))).toISOString();
}

/** Quantity multiplier (ate the same item N times), clamped to a sane 1..50. carbs_g stays the
 *  TOTAL (per-unit × quantity) so every consumer keeps reading carbs_g as "carbs eaten". */
function clampQty(raw: unknown): number {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(50, n);
}

/** A meal is "planned" ONLY if its time is in the FUTURE (>5 min out). One logged at/around now or
 *  in the past is EATEN. "Planned" must never stick to a meal whose time has already passed — that
 *  read as "prévu" on a scanned/now-dated meal and made the analysis skip it. null ts = now = eaten. */
function plannedFromTs(mealTs: string | null): boolean {
  if (!mealTs) return false;
  return new Date(mealTs).getTime() > Date.now();
}

// ---- "If I eat this, how much insulin?" ---------------------------------------------------------
// The whole point of the app, and until now it existed on ONE path: talking to it. Logging a meal by
// hand or photographing it produced a carb figure and silence — the number that decides what happens
// for the next four hours was only ever obtainable by asking out loud, and only for a meal announced
// out loud. The dose maths itself has been ready the whole time (planMealDose); what was missing was
// this function ever loading the four things it needs to run.
//
// Nothing here invents a number: planMealDose delegates the correction half to computeGuard, so every
// no-insulin invariant (hypo first, falling, stale data, IOB already covering it, missing ratios) is
// inherited rather than re-implemented.

/** Current glucose, trend, insulin and carbs on board — read fresh, straight from the tables the
 *  monitor and the other functions have been filling all along. `excludeMealId` keeps a meal being
 *  EDITED out of its own carbs-on-board, which would otherwise count against its own bolus. */
async function planContext(subject: string, nowMs: number, lang: string, tzBody: unknown, excludeMealId?: unknown) {
  const data = await loadEngineData(db, subject, nowMs, [], 6);
  // The exclusion is ONLY about carbs-on-board: a meal must not count as sugar already landing against
  // its own bolus. The RESCUE CLOCK still sees every row: editing the three sugars taken two minutes
  // ago would otherwise erase them, drop computeGuard's "you just took sugar, let it work" hold and
  // answer with a second full rescue.
  const forCob = data.meals.filter((m: any) => excludeMealId == null || String(m.id) !== String(excludeMealId));
  const state = buildState({
    nowMs, lang, tzOffsetMin: tzOffsetOf({ tzOffsetMin: tzBody }, data.profile), profile: data.profile,
    readings: data.series, insulin: data.insulin, meals: forCob, rescueMeals: data.meals, activity: data.activity,
    model: data.model,
  });
  return { state, profile: data.profile };
}

/** How long the same dose written twice is one dose written twice. */
const INSULIN_RETRY_MIN = 2;

/** A meal whose time is further in the past than this is EATEN, not planned. */
export const PAST_MEAL_GRACE_MIN = 15;

const insulinNameOf = (ins: any): string | null => (ins?.name ? String(ins.name).slice(0, 80) : null);

/** The plan for a meal of `carbsG` grams eaten at `mealTs` (null = now), plus its prose line.
 *  Returns nulls when there are no carbs to dose — the caller keeps its own wording. */
async function mealDoseAnswer(
  subject: string, nowMs: number, carbsG: number | null, description: string,
  mealTs: string | null, lang: string, excludeMealId?: unknown, tzBody?: unknown, willEat = false,
  /** The figure is a model's guess, not one typed or read off a label. */
  guessed = false,
): Promise<{ plan: MealPlanResult | null; planLine: string | null; alreadyEaten?: boolean; decision?: unknown; actionLine?: string }> {
  if (carbsG == null || !(carbsG > 0)) return { plan: null, planLine: null };
  // Eating LATER moves the injection, not the arithmetic: mealTimingLine says "dans N min" off this.
  const untilMin = mealTs ? Math.round((new Date(mealTs).getTime() - nowMs) / 60000) : 0;
  // A MEAL ALREADY EATEN IS NOT THIS QUESTION. planMealDose answers "if I eat this, how much and
  // when do I inject" — asked about food digested hours ago it hands out a SECOND full meal bolus,
  // because the insulin that covered it the first time has long since decayed out of IOB and cannot
  // hold it back. The trigger is not exotic: opening a row to fix a typo re-sends that meal's own
  // original timestamp, so every ordinary edit came back with "8 u, fais l'insuline au moment de
  // commencer à manger" for a lunch three hours gone. Backdating a forgotten meal does the same.
  // No plan at all is the honest answer; the meal is still logged, and the analysis still covers it.
  if (untilMin < -PAST_MEAL_GRACE_MIN) return { plan: null, planLine: null, alreadyEaten: true };
  const { state, profile } = await planContext(subject, nowMs, lang, tzBody, excludeMealId);
  // ...and inside the grace window, a meal that was ALREADY BOLUSED is finished business too. The
  // fifteen minutes exist so "Maintenant" still works, but they are also exactly when someone
  // reopens the row they just created — and computeGuard subtracts insulin on board from the
  // CORRECTION only, so the meal half would cheerfully name a second full bolus for food whose
  // first one is still working. Same coverage test the uncovered-meal detector uses.
  if (untilMin <= 0 && mealTs) {
    const mt = new Date(mealTs).getTime();
    const need = state.gp?.carbRatio && state.gp.carbRatio > 0 ? carbsG / state.gp.carbRatio : 0;
    const covered = (state.insulin || []).some((d: any) => {
      if (!d || d.kind === "basal" || isBasalInsulin(d.insulin_name)) return false;
      const dt = new Date(d.ts).getTime();
      if (!Number.isFinite(dt) || Math.abs(dt - mt) > MEAL_COVER_WINDOW_MIN * 60000) return false;
      return need <= 0 || Number(d.units) >= need * MEAL_COVER_FRACTION;
    });
    if (covered) return { plan: null, planLine: null, alreadyEaten: true };
  }
  // Same decision as everywhere else, with this meal as the one under discussion.
  const decision = decideAction(state, {
    candidate: {
      carbsG, description, minutesUntil: untilMin > 0 ? untilMin : 0,
      eatenAtMs: untilMin < 0 && mealTs ? new Date(mealTs).getTime() : null,
    },
    estimatedCarbs: guessed ? carbsG : null,
  });
  const ahead = anticipate(state, decision);
  const notes = sideNotes(state, decision).map((n) => n.display);
  const line = [decision.line, ...notes].filter(Boolean).join(" ");
  // Only a meal being saved puts a dose in front of someone; "how much would it be?" does not.
  if (willEat && dosePutForward(decision)) await rememberNamedDose(db, subject, state, decision);
  return { plan: decision.plan, planLine: line, actionLine: decision.line, decision: decisionPayload(state, decision, ahead) };
}

/** The structured half, for a client that wants to style the number rather than print the sentence. */
function planPayload(p: MealPlanResult | null): unknown {
  if (!p) return null;
  return {
    totalUnits: p.totalUnits, mealUnits: p.mealUnits, correctionUnits: p.correctionUnits,
    carbsG: p.carbsG, timing: p.timing, speed: p.speed, reason: p.reason,
    minutesUntilMeal: p.minutesUntilMeal, expectedRiseMgdl: p.expectedRiseMgdl,
    projectedUncoveredMgdl: p.projectedUncoveredMgdl, lowBeforeMeal: p.lowBeforeMeal,
    fastFallCaution: p.fastFallCaution, pendingDropMgdl: p.pendingDropMgdl,
    // So the client can show WHY the number is under carbs ÷ ratio without re-deriving it.
    activityCut: p.activityCut,
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Methode non autorisee" }, 405);

  try {
    const body = await req.json().catch(() => ({}));
    const subject = (await accessSubject(req, db, String(body.subject ?? "") || null)) ?? "";
    if (!/^[a-f0-9]{64}$/.test(subject)) return json({ error: "subject invalide (hash attendu)." }, 400);

    const lang = String(body.lang ?? "fr").toLowerCase() === "es" ? "es" : "fr";
    const nowMs = Date.now();

    // ANSWER BEFORE ANYTHING IS WRITTEN. "Si je mange ça, combien ?" asked from the meal form, with
    // nothing logged and nothing to undo: same carbs, same engine, same sentence as the voice path.
    // Nothing is inserted here, so the carbs being asked about cannot count as carbs-on-board
    // against their own bolus.
    if (body.action === "plan") {
      const m = body.meal ?? {};
      const description = String(m.description ?? "").trim();
      if (!description) return json({ error: "description manquante" }, 400);
      const quantity = clampQty(m.quantity);
      const typed = Number(m.carbsG ?? m.carbs_g);
      let perUnit: number | null = Number.isFinite(typed) && typed > 0 ? Math.round(typed) : null;
      let carbSource: string = perUnit != null ? "user" : "estimate";
      let carbFact: unknown = null;
      if (perUnit == null) {
        const { data: prof } = await db.from("mechabetics_profiles")
          .select("country").eq("subject", subject).maybeSingle();
        const country = (body.country ?? (prof as any)?.country ?? null) as string | null;
        const est = await withDeadline(
          estimateCarbs(description, body.geminiKey, country, m.barcode ?? null, lang),
          ASK_ESTIMATE_MS, { carbsG: null, fact: null },
        );
        perUnit = est.carbsG;
        if (est.fact) {
          carbSource = est.fact.source === "barcode" ? "label_barcode" : "product_db";
          carbFact = { per100: est.fact.carbsPer100, name: est.fact.productName, brand: est.fact.brand, code: est.fact.code, country: est.fact.country, source: est.fact.source };
        }
      }
      const carbsG = perUnit != null ? Math.min(2000, perUnit * quantity) : null;
      const a = await mealDoseAnswer(subject, nowMs, carbsG, description, clampTs(m.ts), lang, undefined, body.tzOffsetMin, false, carbSource === "estimate");
      return json({
        carbsG, carbsPerUnit: perUnit, carbSource, carbFact, plan: planPayload(a.plan), planLine: a.planLine,
        actionLine: a.actionLine, decision: a.decision, alreadyEaten: !!a.alreadyEaten,
      });
    }

    if (body.action === "add") {
      const m = body.meal ?? {};
      const description = String(m.description ?? "").trim();
      if (!description) return json({ error: "description manquante" }, 400);
      const quantity = clampQty(m.quantity);
      const carbs = Number(m.carbsG ?? m.carbs_g);
      // The user shouldn't HAVE to type carbs — if they didn't, let the AI estimate them. carbs_g
      // is the TOTAL eaten = per-unit × quantity (so "ate it 3×" needs no re-scan/re-type).
      let perUnit: number | null = Number.isFinite(carbs) && carbs > 0 ? Math.round(carbs) : null;
      // WHERE THE NUMBER CAME FROM travels with it. A figure the user typed, a figure read off a
      // barcode and a figure a model guessed are three different things, and the app used to print
      // all three the same way. The parent has to be able to tell an estimate from a label.
      // The preview can have filled the field: the figure comes back looking typed, and the phone says so.
      let carbSource: string = perUnit != null && m.carbSource !== "estimate" ? "user" : "estimate";
      let carbFact: unknown = null;
      // Still running when our deadline passed: kept so it can finish the job after the answer.
      let stillEstimating: Promise<CarbEstimate> | null = null;
      if (perUnit == null) {
        // The person's country steers the estimate: the same product differs by market. Read from
        // the profile so an older APK that doesn't send one still benefits.
        const { data: prof } = await db.from("mechabetics_profiles")
          .select("country").eq("subject", subject).maybeSingle();
        const country = (body.country ?? (prof as any)?.country ?? null) as string | null;
        const running = estimateCarbs(description, body.geminiKey, country, m.barcode ?? null, lang);
        const est = await withDeadline<CarbEstimate | null>(running, SAVE_ESTIMATE_MS, null);
        if (est) {
          perUnit = est.carbsG;
          if (est.fact) {
            carbSource = est.fact.source === "barcode" ? "label_barcode" : "product_db";
            carbFact = {
              per100: est.fact.carbsPer100, name: est.fact.productName, brand: est.fact.brand,
              code: est.fact.code, country: est.fact.country, source: est.fact.source,
            };
          }
        } else {
          stillEstimating = running; // answer now, write the number when it lands
        }
      }
      const carbsG = perUnit != null ? Math.min(2000, perUnit * quantity) : null;
      const mealTs = clampTs(m.ts);
      // A RETRY MUST NOT BECOME A SECOND MEAL. When the answer arrives after the phone has given
      // up, the parent sees a failure, presses save again — and the child's record gains a meal
      // they never ate. On 2026-08-05 one ice cream became four rows; carbs-on-board is a term in
      // the dose calculation, so phantom food asks for phantom insulin.
      // Deliberately NARROW: same wording, within DEDUPE_WINDOW_MIN. Re-treating a low with the
      // same "3 sucres" is real and must still be logged — but the rule of 15 puts it a quarter of
      // an hour later, far outside this window.
      const since = new Date(nowMs - DEDUPE_WINDOW_MIN * 60000).toISOString();
      const { data: recent } = await db.from("mechabetics_meals")
        .select("*").eq("subject", subject).gte("created_at", since)
        .order("created_at", { ascending: false }).limit(10);
      const alreadyLogged = (recent ?? []).find((r: any) =>
        normDesc(String(r?.description ?? "")) === normDesc(description));

      // The plan is computed BEFORE the insert, on purpose: carbs-on-board must not include the very
      // meal this dose is meant to cover, or the food would be counted as already-landing sugar and
      // shrink its own dose.
      const answer = await mealDoseAnswer(subject, nowMs, carbsG, description, mealTs, lang, undefined, body.tzOffsetMin, true, carbSource === "estimate");
      if (alreadyLogged) {
        // Answer as a SUCCESS with the row that already exists: the parent's meal is on record, and
        // pressing save again cannot multiply it.
        if (stillEstimating) finishInBackground(stillEstimating, Number((alreadyLogged as any).id), quantity);
        return json({
          meal: alreadyLogged, duplicate: true, carbSource, carbFact,
          plan: planPayload(answer.plan), planLine: answer.planLine, alreadyEaten: !!answer.alreadyEaten,
        });
      }
      const row = {
        subject,
        description: description.slice(0, 240),
        carbs_g: carbsG,
        quantity,
        planned: plannedFromTs(mealTs), // past/now = eaten, only a future time is "prévu"
        carbs_estimated: carbSource === "estimate",
        ...(mealTs ? { ts: mealTs } : {}),
      };
      const { data, error } = await db.from("mechabetics_meals").insert(row).select().single();
      if (error) return json({ error: error.message }, 500);
      if (stillEstimating) finishInBackground(stillEstimating, Number((data as any)?.id), quantity);
      return json({
        meal: data, carbSource, carbFact, plan: planPayload(answer.plan), planLine: answer.planLine,
        actionLine: answer.actionLine, decision: answer.decision,
        alreadyEaten: !!answer.alreadyEaten,
        // The meal is saved; its carb figure is still being worked out and will appear on the next
        // refresh of the list. Said out loud so a blank « — g » reads as "coming", not "failed".
        carbsPending: !!stillEstimating,
      });
    }

    // "Nothing injected in the last 3 h": what lets a conditional dose become a firm one.
    if (body.action === "confirmNoInsulin") {
      await confirmNoRecentInsulin(db, subject, Date.now());
      return json({ ok: true });
    }
    // "The dose you named was not done": the question is closed, the next analysis decides afresh.
    if (body.action === "doseNotDone") {
      await clearNamedDose(db, subject);
      return json({ ok: true });
    }

    // Manual rapid-insulin log (the Insulin page) -> feeds IOB used by coach/ask/scan.
    if (body.action === "addInsulin") {
      const ins = body.insulin ?? {};
      const units = Number(ins.units);
      if (!Number.isFinite(units) || units <= 0) return json({ error: "unites invalides" }, 400);
      const insTs = clampTs(ins.ts);
      const row = {
        subject,
        units: Math.round(units * 100) / 100,
        insulin_name: ins.name ? String(ins.name).slice(0, 80) : null,
        // basal (slow) doses must NOT count toward rapid insulin-on-board; default to rapid.
        kind: ins.kind === "basal" || isBasalInsulin(insulinNameOf(ins)) ? "basal" : "rapid",
        ...(insTs ? { ts: insTs } : {}),
      };
      // A RETRY MUST NOT BECOME A SECOND DOSE, same as for a meal. The answer can reach the phone after
      // it has given up, and FAIT pressed again would write the same injection twice. Same dose, same
      // time, same minute of writing: nobody really injects the same units twice in two minutes.
      const at = insTs ? new Date(insTs).getTime() : nowMs;
      const { data: justWritten } = await db.from("mechabetics_insulin")
        .select("ts, units, kind").eq("subject", subject)
        .gte("created_at", new Date(nowMs - INSULIN_RETRY_MIN * 60000).toISOString())
        .order("created_at", { ascending: false }).limit(5);
      const retried = (justWritten ?? []).some((r: any) =>
        r.kind === row.kind && Math.abs(Number(r.units) - row.units) < 0.01 &&
        Math.abs(new Date(r.ts).getTime() - at) <= INSULIN_RETRY_MIN * 60000);
      if (retried) return json({ ok: true, duplicate: true });
      const { error } = await db.from("mechabetics_insulin").insert(row);
      if (error) return json({ error: error.message }, 500);
      // Whether this answers "was it done?" is decided where the question is read (openPendingDose): a
      // dose from before the one named is not the answer to it. Except from the card that asks: there the
      // family is answering, at whatever time they give, and the question would otherwise stay open.
      if (ins.answersQuestion === true) await clearNamedDose(db, subject);
      return json({ ok: true });
    }

    if (body.action === "delete" && body.id != null) {
      const { error } = await db.from("mechabetics_meals").delete().eq("subject", subject).eq("id", body.id);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    // Edit a meal already in the list (description / carbs / time). Scoped to the subject's own row.
    if (body.action === "update" && body.id != null) {
      const m = body.meal ?? {};
      const description = String(m.description ?? "").trim();
      if (!description) return json({ error: "description manquante" }, 400);
      const quantity = clampQty(m.quantity);
      const rawCarbs = m.carbsG ?? m.carbs_g;
      const carbs = Number(rawCarbs);
      // "Field omitted" and "the user typed 0" are NOT the same instruction. Collapsing both to null
      // left no way at all to clear or refresh a wrong carb figure — the stored one came back every
      // time, for ever. An explicit 0 means "this has no carbs" (a steak, two sausages) and must be
      // obeyed; only an ABSENT field means "I didn't touch the carbs".
      const carbsSent = rawCarbs !== undefined && rawCarbs !== null && Number.isFinite(carbs) && carbs >= 0;
      let perUnit = carbsSent ? Math.max(0, Math.round(carbs)) : null;
      const mealTs = clampTs(m.ts);
      // AN EDIT MUST NOT BLANK THE CARBS. This wrote carbs_g: null whenever the client sent no
      // figure — and correcting a meal's TIME sends no figure. The row then had no carbs, and a meal
      // with no carbs is invisible to every carb computation there is: no bolus named for it, no
      // sugar-on-board counted against the insulin, no uncovered-meal warning. Moving a meal by ten
      // minutes silently deleted it from the safety maths.
      let carbSource: string | null = carbsSent ? (m.carbSource === "estimate" ? "estimate" : "user") : null;
      let carbsG: number | null = perUnit != null ? Math.min(2000, perUnit * quantity) : null;
      // The form sends back the figure it opened with: moving a meal in time says nothing about it.
      if (carbsSent && carbSource === "user") {
        const { data: was } = await db.from("mechabetics_meals")
          .select("carbs_g").eq("subject", subject).eq("id", body.id).maybeSingle();
        if (Number((was as any)?.carbs_g) === carbsG) carbSource = "kept";
      }
      if (perUnit == null) {
        const { data: prev } = await db.from("mechabetics_meals")
          .select("carbs_g, quantity, description").eq("subject", subject).eq("id", body.id).maybeSingle();
        const prevTotal = Number((prev as any)?.carbs_g);
        const prevQty = clampQty((prev as any)?.quantity);
        // ...but a kept figure must still describe the SAME FOOD. Rewriting "pain au chocolat" as
        // "2 saucisses" and keeping its 30 g would hand the new food the old food's carbs, which is
        // how a 0-carb plate ends up with a bolus. Different description → re-estimate from scratch.
        const sameFood = String((prev as any)?.description ?? "").trim().toLowerCase() === description.toLowerCase();
        if (sameFood && Number.isFinite(prevTotal) && prevTotal > 0) {
          perUnit = Math.round(prevTotal / prevQty);        // stored total is per-unit × quantity
          carbsG = Math.min(2000, perUnit * quantity);      // re-scaled if the quantity changed
          carbSource = "kept";
        } else if (!sameFood) {
          const { data: prof } = await db.from("mechabetics_profiles")
            .select("country").eq("subject", subject).maybeSingle();
          const country = (body.country ?? (prof as any)?.country ?? null) as string | null;
          const est = await withDeadline(
          estimateCarbs(description, body.geminiKey, country, m.barcode ?? null, lang),
          ASK_ESTIMATE_MS, { carbsG: null, fact: null },
        );
          if (est.carbsG != null) {
            perUnit = est.carbsG;
            carbsG = Math.min(2000, perUnit * quantity);
            carbSource = est.fact ? (est.fact.source === "barcode" ? "label_barcode" : "product_db") : "estimate";
          } else if (Number.isFinite(prevTotal) && prevTotal > 0) {
            // The estimator is best-effort (no key, network, unparseable reply). Falling through to
            // null here would blank the column and drop the meal out of every carb computation —
            // the exact failure this whole branch exists to prevent. A stale figure is wrong; no
            // figure is invisible, which is worse.
            perUnit = Math.round(prevTotal / prevQty);
            carbsG = Math.min(2000, perUnit * quantity);
            carbSource = "kept";
          }
        }
      }
      const answer = await mealDoseAnswer(subject, nowMs, carbsG, description, mealTs, lang, body.id, body.tzOffsetMin, true, carbSource === "estimate");
      const patch: Record<string, unknown> = {
        description: description.slice(0, 240),
        carbs_g: carbsG,
        quantity,
        planned: plannedFromTs(mealTs), // re-derive: editing a meal to a past time makes it "eaten"
        // A figure typed or read off a label stops being a guess; one kept stays what it was.
        ...(carbSource && carbSource !== "kept" ? { carbs_estimated: carbSource === "estimate" } : {}),
        ...(mealTs ? { ts: mealTs } : {}),
      };
      const { error } = await db.from("mechabetics_meals").update(patch).eq("subject", subject).eq("id", body.id);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true, carbsG, carbSource, plan: planPayload(answer.plan), planLine: answer.planLine, alreadyEaten: !!answer.alreadyEaten });
    }

    // Edit a logged insulin dose (units / name / kind / time).
    if (body.action === "updateInsulin" && body.id != null) {
      const ins = body.insulin ?? {};
      const units = Number(ins.units);
      if (!Number.isFinite(units) || units <= 0) return json({ error: "unites invalides" }, 400);
      const insTs = clampTs(ins.ts);
      const patch: Record<string, unknown> = {
        units: Math.round(units * 100) / 100,
        insulin_name: ins.name ? String(ins.name).slice(0, 80) : null,
        kind: ins.kind === "basal" || isBasalInsulin(insulinNameOf(ins)) ? "basal" : "rapid",
        ...(insTs ? { ts: insTs } : {}),
      };
      const { error } = await db.from("mechabetics_insulin").update(patch).eq("subject", subject).eq("id", body.id);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    if (body.action === "deleteInsulin" && body.id != null) {
      const { error } = await db.from("mechabetics_insulin").delete().eq("subject", subject).eq("id", body.id);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    // ---- PHYSICAL ACTIVITY -----------------------------------------------------------------------
    // `mechabetics_activity` existed and was read in three places, but the ONLY way to write a row was
    // to say it out loud to the voice Q&A and hope the model extracted it. There was no screen and no
    // endpoint, so the table was empty for every patient since it was created — an afternoon of
    // football had never once reached a dose. These three actions are that missing door.
    if (body.action === "addActivity") {
      const a = body.activity ?? {};
      const kind = a.kind ? String(a.kind).slice(0, 60) : null;
      const description = a.description ? String(a.description).slice(0, 200) : null;
      if (!kind && !description) return json({ error: "activite sans nom" }, 400);
      const rawDur = Number(a.durationMin ?? a.duration_min);
      const actTs = clampTs(a.ts);
      const { data, error } = await db.from("mechabetics_activity").insert({
        subject, kind, description,
        intensity: ["low", "moderate", "high"].includes(a.intensity) ? a.intensity : null,
        // Clamped the same way a meal's carbs are: a typo must not become a twelve-hour session.
        duration_min: Number.isFinite(rawDur) && rawDur > 0 ? Math.min(600, Math.round(rawDur)) : null,
        planned: !!a.planned,
        // What the USER said about being outside — never inferred from a position. Null = unknown.
        outdoor: typeof a.outdoor === "boolean" ? a.outdoor : null,
        ...(actTs ? { ts: actTs } : {}),
      }).select("id, ts, kind, description, intensity, duration_min, planned, outdoor").maybeSingle();
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true, activity: data ?? null });
    }

    if (body.action === "updateActivity" && body.id != null) {
      const a = body.activity ?? {};
      const rawDur = Number(a.durationMin ?? a.duration_min);
      const actTs = clampTs(a.ts);
      const patch: Record<string, unknown> = {
        kind: a.kind ? String(a.kind).slice(0, 60) : null,
        description: a.description ? String(a.description).slice(0, 200) : null,
        intensity: ["low", "moderate", "high"].includes(a.intensity) ? a.intensity : null,
        duration_min: Number.isFinite(rawDur) && rawDur > 0 ? Math.min(600, Math.round(rawDur)) : null,
        planned: !!a.planned,
        // What the USER said about being outside — never inferred from a position. Null = unknown.
        outdoor: typeof a.outdoor === "boolean" ? a.outdoor : null,
        ...(actTs ? { ts: actTs } : {}),
      };
      const { error } = await db.from("mechabetics_activity").update(patch).eq("subject", subject).eq("id", body.id);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    if (body.action === "deleteActivity" && body.id != null) {
      const { error } = await db.from("mechabetics_activity").delete().eq("subject", subject).eq("id", body.id);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    if (body.action === "listActivity") {
      const { data } = await db.from("mechabetics_activity")
        .select("id, ts, kind, description, intensity, duration_min, planned, outdoor")
        .eq("subject", subject)
        .order("ts", { ascending: false })
        .limit(50);
      return json({ activity: data ?? [] });
    }

    // list (defaut)
    const { data } = await db.from("mechabetics_meals")
      .select("id, ts, description, carbs_g, planned, quantity")
      .eq("subject", subject)
      .order("ts", { ascending: false })
      .limit(50);
    return json({ meals: data ?? [] });
  } catch (e) {
    return json({ error: `Erreur serveur: ${(e as Error)?.message ?? e}` }, 500);
  }
});
