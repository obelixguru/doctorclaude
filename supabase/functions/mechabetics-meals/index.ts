import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { accessSubject } from "../_shared/access.ts";
import { chatJson } from "../_shared/llm.ts";
import { carbEstimationRules } from "../_shared/doseGuard.ts";
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
): Promise<{ carbsG: number | null; fact: FoodFact | null }> {
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
  const where = country ? ` La personne est en : ${country}. Les valeurs nutritionnelles d'un même produit varient selon le pays — raisonne pour CE marché.` : "";
  try {
    const raw = await chatJson(
      {
        system: `Tu estimes les glucides d'un aliment pour une personne diabétique.${where} ${carbEstimationRules("fr")}${fact ? " " + foodFactLine(fact, "fr") : ""} Réponds UNIQUEMENT en JSON {"carbsG":<grammes entiers de glucides pour TOUT ce qui est décrit>}. Pas de texte.`,
        user: fact
          ? `Aliment : ${description}`
          : `Aliment : ${description}${country ? ` — acheté/consommé en ${country}` : ""}. S'il s'agit d'un produit emballé d'une marque, CHERCHE sa valeur nutritionnelle officielle POUR CE PAYS (glucides pour 100 g ou 100 ml) avant de répondre, puis multiplie par la quantité décrite. Le même produit n'a pas la même recette selon le pays.`,
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

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Methode non autorisee" }, 405);

  try {
    const body = await req.json().catch(() => ({}));
    const subject = (await accessSubject(req, db, String(body.subject ?? "") || null)) ?? "";
    if (!/^[a-f0-9]{64}$/.test(subject)) return json({ error: "subject invalide (hash attendu)." }, 400);

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
        const est = await estimateCarbs(description, body.geminiKey, country, m.barcode ?? null);
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
      return json({ meal: data, carbSource, carbFact });
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
      const carbs = Number(m.carbsG ?? m.carbs_g);
      const perUnit = Number.isFinite(carbs) && carbs > 0 ? Math.round(carbs) : null;
      const mealTs = clampTs(m.ts);
      const patch: Record<string, unknown> = {
        description: description.slice(0, 240),
        carbs_g: perUnit != null ? Math.min(2000, perUnit * quantity) : null,
        quantity,
        planned: plannedFromTs(mealTs), // re-derive: editing a meal to a past time makes it "eaten"
        ...(mealTs ? { ts: mealTs } : {}),
      };
      const { error } = await db.from("mechabetics_meals").update(patch).eq("subject", subject).eq("id", body.id);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
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
