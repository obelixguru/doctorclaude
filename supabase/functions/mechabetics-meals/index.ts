import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { accessSubject } from "../_shared/access.ts";
import { chatJson } from "../_shared/llm.ts";
import {
  carbEstimationRules,
  toGuardProfile,
  trendFromReadings,
  recentHypoFrom,
  activeIob,
  insulinActionMinutes,
  carbsOnBoard,
  balanceRates,
  minutesSinceLastRescue,
  MEAL_COVER_WINDOW_MIN,
  MEAL_COVER_FRACTION,
  planMealDose,
  mealPlanLine,
  type GuardProfile,
  type MealPlanResult,
} from "../_shared/doseGuard.ts";
import { lookupBarcode, lookupProduct, foodFactLine, type FoodFact } from "../_shared/foodFacts.ts";

const DEEPSEEK_API_KEY = Deno.env.get("MECHABETICS_DEEPSEEK_API_KEY") ?? "";
const DEEPSEEK_MODEL = Deno.env.get("MECHABETICS_DEEPSEEK_MODEL") ?? "deepseek-v4-flash";
const GEMINI_TEXT_MODEL = Deno.env.get("MECHABETICS_GEMINI_TEXT_MODEL") ?? "gemini-2.5-flash";

/** Estimate a meal's carbs (g) from its description via the LLM, so the user never HAS to type
 *  them — diabetes carb-counting is exactly what the AI is good at. Best-effort: returns null when
 *  no AI key is available or the call fails (the meal is still logged, just without a carb number). */
async function estimateCarbs(
  description: string,
  geminiKey?: unknown,
  country?: string | null,
  barcode?: string | null,
  lang = "fr",
): Promise<{ carbsG: number | null; fact: FoodFact | null }> {
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
    const raw = await chatJson(
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
      },
      { byokGeminiKey: byok, deepseekKey: DEEPSEEK_API_KEY, deepseekModel: DEEPSEEK_MODEL, geminiModel: GEMINI_TEXT_MODEL },
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
  return new Date(mealTs).getTime() > Date.now() + 5 * 60 * 1000;
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
async function planContext(subject: string, nowMs: number, excludeMealId?: unknown): Promise<{
  gp: GuardProfile | null;
  cur: number | null;
  trend: ReturnType<typeof trendFromReadings>;
  staleMin: number;
  iob: number;
  cob: number;
  minSinceRescue: number | null;
  recentHypo: boolean;
  doses: any[];
  rates: ReturnType<typeof balanceRates>;
}> {
  const [profRes, readRes, insRes, mealRes] = await Promise.all([
    db.from("mechabetics_profiles")
      .select("carb_ratio, correction_factor, target_mgdl, weight_kg, rapid_insulin")
      .eq("subject", subject).maybeSingle(),
    db.from("mechabetics_readings")
      .select("ts, value_mgdl").eq("subject", subject)
      .gte("ts", new Date(nowMs - 3 * 3600 * 1000).toISOString())
      .order("ts", { ascending: false }).limit(60),
    db.from("mechabetics_insulin")
      .select("ts, units, insulin_name, kind").eq("subject", subject)
      .gte("ts", new Date(nowMs - 8 * 3600 * 1000).toISOString())
      .order("ts", { ascending: false }).limit(24),
    db.from("mechabetics_meals")
      .select("id, ts, description, carbs_g, planned").eq("subject", subject)
      .gte("ts", new Date(nowMs - 26 * 3600 * 1000).toISOString())
      .order("ts", { ascending: false }).limit(24),
  ]);

  const rds = ((readRes.data ?? []) as any[])
    .map((r) => ({ ts: new Date(r.ts).getTime(), value: Number(r.value_mgdl) }))
    .filter((r) => Number.isFinite(r.ts) && r.value > 0)
    .sort((a, b) => a.ts - b.ts);
  const last = rds.length ? rds[rds.length - 1] : null;
  const cur = last ? Math.round(last.value) : null;
  // No reading at all reads as STALE, never as fresh: computeGuard then refuses a correction, which
  // is the honest answer when nobody knows the glucose. The MEAL half is unaffected — carb counting
  // does not need a glucose — so the user still gets the number they came for.
  const staleMin = last ? Math.round((nowMs - last.ts) / 60000) : 999;
  const trend = last ? trendFromReadings(rds, nowMs) : "unknown";

  const gp = toGuardProfile(profRes.data);
  const dia = insulinActionMinutes(gp?.rapidInsulin) ?? 240;
  const doses = ((insRes.data ?? []) as any[]).map((d) => ({ ...d, ts: new Date(d.ts).getTime() }));
  const allMeals = (mealRes.data ?? []) as any[];
  // The exclusion is ONLY about carbs-on-board — a meal must not count as sugar already landing
  // against its own bolus. The RESCUE CLOCK must still see every row: editing the three sugars you
  // took two minutes ago would otherwise erase them from minutesSinceLastRescue, drop computeGuard's
  // "you just took sugar, let it work" hold, and answer with a second full rescue.
  const forCob = allMeals.filter((m) => excludeMealId == null || String(m.id) !== String(excludeMealId));

  return {
    gp, cur, trend, staleMin,
    iob: activeIob(doses as any, nowMs, dia),
    cob: carbsOnBoard(forCob as any, nowMs),
    minSinceRescue: minutesSinceLastRescue(allMeals, nowMs),
    recentHypo: recentHypoFrom(rds, nowMs),
    doses,
    // Arrival rates, so a slow meal's carbs are not counted as protection they cannot give in time.
    rates: balanceRates(forCob as any, doses as any, nowMs, dia),
  };
}

/** A meal whose time is further in the past than this is EATEN, not planned. */
export const PAST_MEAL_GRACE_MIN = 15;

/** The plan for a meal of `carbsG` grams eaten at `mealTs` (null = now), plus its prose line.
 *  Returns nulls when there are no carbs to dose — the caller keeps its own wording. */
async function mealDoseAnswer(
  subject: string, nowMs: number, carbsG: number | null, description: string,
  mealTs: string | null, lang: string, excludeMealId?: unknown,
): Promise<{ plan: MealPlanResult | null; planLine: string | null; alreadyEaten?: boolean }> {
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
  const ctx = await planContext(subject, nowMs, excludeMealId);
  // ...and inside the grace window, a meal that was ALREADY BOLUSED is finished business too. The
  // fifteen minutes exist so "Maintenant" still works, but they are also exactly when someone
  // reopens the row they just created — and computeGuard subtracts insulin on board from the
  // CORRECTION only, so the meal half would cheerfully name a second full bolus for food whose
  // first one is still working. Same coverage test the uncovered-meal detector uses.
  if (untilMin <= 0 && mealTs) {
    const mt = new Date(mealTs).getTime();
    const need = ctx.gp?.carbRatio && ctx.gp.carbRatio > 0 ? carbsG / ctx.gp.carbRatio : 0;
    const covered = (ctx.doses || []).some((d: any) => {
      if (!d || d.kind === "basal") return false;
      const dt = Number(d.ts);
      if (!Number.isFinite(dt) || Math.abs(dt - mt) > MEAL_COVER_WINDOW_MIN * 60000) return false;
      return need <= 0 || Number(d.units) >= need * MEAL_COVER_FRACTION;
    });
    if (covered) return { plan: null, planLine: null, alreadyEaten: true };
  }
  const plan = planMealDose({
    glucoseMgdl: ctx.cur, trend: ctx.trend, staleMin: ctx.staleMin, iobUnits: ctx.iob,
    carbsG, description, cobGrams: ctx.cob, rates: ctx.rates,
    minutesUntilMeal: untilMin > 0 ? untilMin : 0,
    minSinceRescue: ctx.minSinceRescue, recentHypo: ctx.recentHypo, profile: ctx.gp,
  });
  return { plan, planLine: mealPlanLine(plan, lang, ctx.gp) };
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
        const est = await estimateCarbs(description, body.geminiKey, country, m.barcode ?? null, lang);
        perUnit = est.carbsG;
        if (est.fact) {
          carbSource = est.fact.source === "barcode" ? "label_barcode" : "product_db";
          carbFact = { per100: est.fact.carbsPer100, name: est.fact.productName, brand: est.fact.brand, code: est.fact.code, country: est.fact.country, source: est.fact.source };
        }
      }
      const carbsG = perUnit != null ? Math.min(2000, perUnit * quantity) : null;
      const a = await mealDoseAnswer(subject, nowMs, carbsG, description, clampTs(m.ts), lang);
      return json({ carbsG, carbsPerUnit: perUnit, carbSource, carbFact, plan: planPayload(a.plan), planLine: a.planLine, alreadyEaten: !!a.alreadyEaten });
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
      let carbSource: string = perUnit != null ? "user" : "estimate";
      let carbFact: unknown = null;
      if (perUnit == null) {
        // The person's country steers the estimate: the same product differs by market. Read from
        // the profile so an older APK that doesn't send one still benefits.
        const { data: prof } = await db.from("mechabetics_profiles")
          .select("country").eq("subject", subject).maybeSingle();
        const country = (body.country ?? (prof as any)?.country ?? null) as string | null;
        const est = await estimateCarbs(description, body.geminiKey, country, m.barcode ?? null, lang);
        perUnit = est.carbsG;
        if (est.fact) {
          carbSource = est.fact.source === "barcode" ? "label_barcode" : "product_db";
          carbFact = {
            per100: est.fact.carbsPer100, name: est.fact.productName, brand: est.fact.brand,
            code: est.fact.code, country: est.fact.country, source: est.fact.source,
          };
        }
      }
      const carbsG = perUnit != null ? Math.min(2000, perUnit * quantity) : null;
      const mealTs = clampTs(m.ts);
      // The plan is computed BEFORE the insert, on purpose: carbs-on-board must not include the very
      // meal this dose is meant to cover, or the food would be counted as already-landing sugar and
      // shrink its own bolus.
      const answer = await mealDoseAnswer(subject, nowMs, carbsG, description, mealTs, lang);
      const row = {
        subject,
        description: description.slice(0, 240),
        carbs_g: carbsG,
        quantity,
        planned: plannedFromTs(mealTs), // past/now = eaten, only a future time is "prévu"
        ...(mealTs ? { ts: mealTs } : {}),
      };
      const { data, error } = await db.from("mechabetics_meals").insert(row).select().single();
      if (error) return json({ error: error.message }, 500);
      return json({ meal: data, carbSource, carbFact, plan: planPayload(answer.plan), planLine: answer.planLine, alreadyEaten: !!answer.alreadyEaten });
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
        kind: ins.kind === "basal" ? "basal" : "rapid",
        ...(insTs ? { ts: insTs } : {}),
      };
      const { error } = await db.from("mechabetics_insulin").insert(row);
      if (error) return json({ error: error.message }, 500);
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
      let carbSource: string | null = carbsSent ? "user" : null;
      let carbsG: number | null = perUnit != null ? Math.min(2000, perUnit * quantity) : null;
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
          const est = await estimateCarbs(description, body.geminiKey, country, m.barcode ?? null, lang);
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
      const answer = await mealDoseAnswer(subject, nowMs, carbsG, description, mealTs, lang, body.id);
      const patch: Record<string, unknown> = {
        description: description.slice(0, 240),
        carbs_g: carbsG,
        quantity,
        planned: plannedFromTs(mealTs), // re-derive: editing a meal to a past time makes it "eaten"
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
        kind: ins.kind === "basal" ? "basal" : "rapid",
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
