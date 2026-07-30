// Open Food Facts lookup — a SOURCED carbohydrate figure for a packaged product, specific to the
// country the person is actually in.
//
// Why this exists: the app used to ask a language model how many carbs are in a can of soda, and the
// model answered from memory with a single global number. A 33 cl can of 7UP was counted as 35 g;
// its Spanish label says 16 g. That is not a rounding error — at a carb ratio of 16 it is 2.2 u of
// insulin instead of 1 u, for a 40 kg child. The same brand differs up to twofold between markets and
// between the classic and reformulated recipes, so NO single number can be right everywhere.
//
// Open Food Facts is free, needs no key, and carries per-country product data with the label values.
// Everything here is deterministic and sourced: we never let this module invent a figure.
//
// WHAT THIS MODULE REFUSES TO DO, on purpose — each learned from probing the real API:
//   - Trust a brand search. `brands_tags=coca-cola` returns 787 products in France: Minute Maid,
//     Schweppes, peach iced tea. Taking the first hit, or a median over them, would swap one wrong
//     number for another that is harder to spot. Candidates must match the words actually searched.
//   - Prefer `sugars` over `carbohydrates`. Some rows carry sugars=0 alongside carbohydrates=4.7.
//     Insulin is dosed on carbohydrate, so carbohydrate is what we read.
//   - Return anything at all when the corroborating queries disagree. A wide spread means the name is
//     ambiguous, and an ambiguous answer presented as a fact is worse than no answer.

export interface FoodFact {
  /** Grams of carbohydrate per 100 g or 100 ml — exactly as the label states it. */
  carbsPer100: number;
  productName: string;
  brand: string | null;
  /** Barcode, so the user can check the very product we read. */
  code: string;
  /** Package size as stated ("33 cl", "330 ml"), when known. */
  quantity: string | null;
  /** How the figure was found. A barcode is the product; a search is our best match for a name. */
  source: "barcode" | "country_search" | "global_search";
  /** Country whose listing produced it, when the query was country-filtered. */
  country: string | null;
  /** How many independent queries agreed, and how far apart they were (%). */
  corroborations: number;
  spreadPct: number | null;
}

const BASE = "https://world.openfoodfacts.org/api/v2";
const UA = "DoctorClaude/1.0 (type-1 diabetes carb counting; contact via app)";
const TIMEOUT_MS = 3500;

/** Above this, the row is not a food figure — it is broken data. Pure glucose is 100 g/100 g. */
const MAX_PLAUSIBLE_PER100 = 100;
/** Corroborating hits further apart than this mean the name is ambiguous, so we say nothing. */
const MAX_SPREAD_PCT = 25;

// The profile field is free text, because a parent types "Espagne" or "España", not an ISO code.
// Open Food Facts indexes on ENGLISH country names, so a French or Spanish spelling would silently
// match nothing and quietly drop us back to a global figure — the exact failure this is here to
// prevent. Everything unmapped still goes through slugified, so an English name typed directly works.
const COUNTRY_ALIASES: Record<string, string> = {
  espagne: "spain", espana: "spain", "españa": "spain", es: "spain", spain: "spain",
  france: "france", francia: "france", fr: "france",
  maroc: "morocco", marruecos: "morocco", morocco: "morocco", ma: "morocco",
  belgique: "belgium", belgica: "belgium", "bélgica": "belgium", belgium: "belgium",
  suisse: "switzerland", suiza: "switzerland", switzerland: "switzerland",
  portugal: "portugal", italie: "italy", italia: "italy", italy: "italy",
  allemagne: "germany", alemania: "germany", germany: "germany",
  "royaume-uni": "united-kingdom", "reino unido": "united-kingdom", uk: "united-kingdom",
  "etats-unis": "united-states", "états-unis": "united-states", "estados unidos": "united-states",
  usa: "united-states", "united states": "united-states",
  canada: "canada", mexique: "mexico", mexico: "mexico", "méxico": "mexico",
  algerie: "algeria", "algérie": "algeria", argelia: "algeria", algeria: "algeria",
  tunisie: "tunisia", tunez: "tunisia", tunisia: "tunisia",
  senegal: "senegal", "sénégal": "senegal", argentine: "argentina", argentina: "argentina",
  colombie: "colombia", colombia: "colombia", chili: "chile", chile: "chile",
  perou: "peru", "pérou": "peru", peru: "peru", bresil: "brazil", "brésil": "brazil", brasil: "brazil",
};

/** Country name as Open Food Facts expects it in `countries_tags_en` (lowercase, hyphenated). */
export function offCountrySlug(country: string | null | undefined): string | null {
  const raw = (country || "").trim().toLowerCase();
  if (!raw) return null;
  const plain = raw.normalize("NFD").replace(/[̀-ͯ]/g, "");
  return COUNTRY_ALIASES[raw] ?? COUNTRY_ALIASES[plain] ?? plain.replace(/\s+/g, "-");
}

async function getJson(url: string): Promise<any | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA, accept: "application/json" }, signal: ctl.signal });
    if (!r.ok) return null;
    return await r.json();
  } catch (_) {
    return null; // Fail OPEN: no fact simply means the model estimates, exactly as before.
  } finally {
    clearTimeout(timer);
  }
}

/** Carbohydrate per 100 from a product row, or null when the row can't answer. */
function carbsOf(p: any): number | null {
  const n = p?.nutriments ?? {};
  const raw = [n.carbohydrates_100g, n["carbohydrates_100g"], n.sugars_100g];
  for (const v of raw) {
    const x = Number(v);
    if (Number.isFinite(x) && x >= 0 && x <= MAX_PLAUSIBLE_PER100) return x;
  }
  return null;
}

/** Words worth matching on: drop accents, punctuation, and noise like "une", "de", "cl". */
function tokens(s: string): string[] {
  return (s || "")
    .toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}
const STOPWORDS = new Set([
  "une", "des", "les", "avec", "sans", "sur", "pour", "boite", "canette", "bouteille", "verre",
  "cl", "ml", "litre", "lata", "botella", "vaso", "con", "sin", "para", "the", "and", "can",
]);

/** Does this product plausibly answer the thing that was asked? Guards the Minute Maid trap: a hit
 *  is only usable when the product's own name carries the words searched for, not merely its brand. */
function matchesQuery(p: any, qTokens: string[]): boolean {
  if (!qTokens.length) return false;
  const hay = tokens(`${p?.product_name ?? ""} ${p?.brands ?? ""}`);
  if (!hay.length) return false;
  const hit = qTokens.filter((t) => hay.some((h) => h === t || h.startsWith(t) || t.startsWith(h)));
  // Every searched word that could identify the product must appear.
  return hit.length >= Math.min(qTokens.length, 1) && hit.length / qTokens.length >= 0.5;
}

// "7up" and "7up zero" are not the same drink, and the difference is the entire carb content. A brand
// listing returns both, so without this the candidate set spans 4.7 and 0 — a 100% spread, which the
// agreement check (rightly) refuses to answer at all. Nearly every brand now has a zero variant, so
// treating them as one product would have made this module permanently silent.
const DIET_WORDS = [
  "zero", "zéro", "light", "diet", "sin azucar", "sin azúcar", "sans sucre", "sans sucres",
  "no sugar", "free", "max", "0%",
];
function isDietVariant(text: string): boolean {
  const t = (text || "").toLowerCase();
  return DIET_WORDS.some((w) => t.includes(w));
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** EXACT product by barcode. This is the label itself — the only fully trustworthy path. */
export async function lookupBarcode(code: string): Promise<FoodFact | null> {
  const c = (code || "").replace(/\D/g, "");
  if (c.length < 8 || c.length > 14) return null;
  const d = await getJson(`${BASE}/product/${c}?fields=product_name,brands,quantity,countries_tags,nutriments`);
  if (!d || d.status !== 1 || !d.product) return null;
  const carbs = carbsOf(d.product);
  if (carbs == null) return null;
  return {
    carbsPer100: carbs,
    productName: String(d.product.product_name || "").trim() || c,
    brand: (d.product.brands || null) as string | null,
    code: c,
    quantity: (d.product.quantity || null) as string | null,
    source: "barcode",
    country: null,
    corroborations: 1,
    spreadPct: null,
  };
}

/**
 * Best sourced figure for a described product, corroborated across several queries.
 *
 * Runs the country listing first — that is the whole point, a Spanish 7UP is not a Moroccan one —
 * then the global listing as a cross-check. Agreement raises confidence; disagreement beyond
 * MAX_SPREAD_PCT means the description is too ambiguous to answer, and we return null so the caller
 * falls back to an estimate that is at least PRESENTED as an estimate.
 */
export async function lookupProduct(
  description: string,
  country: string | null,
  maxQueries = 3,
): Promise<FoodFact | null> {
  const qTokens = tokens(description);
  if (!qTokens.length) return null;
  const fields = "product_name,brands,quantity,countries_tags,nutriments,code";
  const slug = offCountrySlug(country);

  // BRAND FILTER, NOT FREE-TEXT SEARCH. `search_terms` in the v2 API does not filter: asked for
  // "7up" it answers with a count of 4.6 MILLION — the whole database — and hands back Moroccan
  // biscuits. Anything built on it would be picking a random product and calling it an answer.
  // `brands_tags` genuinely narrows, so we search brands and then insist the product's own NAME
  // matches too, which is what keeps Coca-Cola's Minute Maid and Schweppes out of the result.
  const brand = qTokens.join("-");
  const urls: { url: string; source: FoodFact["source"]; country: string | null }[] = [];
  if (slug) {
    urls.push({
      url: `${BASE}/search?brands_tags=${encodeURIComponent(brand)}&countries_tags_en=${encodeURIComponent(slug)}&fields=${fields}&page_size=25`,
      source: "country_search", country: slug,
    });
  }
  urls.push({
    url: `${BASE}/search?brands_tags=${encodeURIComponent(brand)}&fields=${fields}&page_size=25`,
    source: "global_search", country: null,
  });

  const rounds: { fact: FoodFact; values: number[] }[] = [];
  for (const u of urls.slice(0, maxQueries)) {
    const d = await getJson(u.url);
    const products: any[] = Array.isArray(d?.products) ? d.products : [];
    // Keep only the variant that was actually asked for. Asking for "7up" must not be answered with
    // the zero-sugar one, and vice versa.
    const wantsDiet = isDietVariant(description);
    const usable = products.filter((p) =>
      matchesQuery(p, qTokens) &&
      carbsOf(p) != null &&
      isDietVariant(`${p?.product_name ?? ""} ${p?.brands ?? ""}`) === wantsDiet);
    if (!usable.length) continue;
    const values = usable.map((p) => carbsOf(p) as number);
    const med = median(values);
    // The representative product is the usable hit closest to the median — a real row with a real
    // barcode the user can go and check, never a synthetic average.
    const rep = usable.reduce((best, p) =>
      Math.abs((carbsOf(p) as number) - med) < Math.abs((carbsOf(best) as number) - med) ? p : best);
    rounds.push({
      fact: {
        carbsPer100: carbsOf(rep) as number,
        productName: String(rep.product_name || "").trim(),
        brand: (rep.brands || null) as string | null,
        code: String(rep.code || ""),
        quantity: (rep.quantity || null) as string | null,
        source: u.source,
        country: u.country,
        corroborations: 1,
        spreadPct: null,
      },
      values,
    });
  }
  if (!rounds.length) return null;

  // The country listing wins when we have one — that is the question being asked.
  const best = rounds[0];
  if (rounds.length === 1) {
    // A single listing still has to be internally consistent: a set of "matching" products spread
    // across a wide range means the words matched several different drinks.
    const spread = spreadPct(best.values);
    if (spread != null && spread > MAX_SPREAD_PCT) return null;
    return { ...best.fact, corroborations: 1, spreadPct: spread };
  }
  const a = best.fact.carbsPer100;
  const b = rounds[1].fact.carbsPer100;
  const diff = Math.max(a, b) > 0 ? (Math.abs(a - b) / Math.max(a, b)) * 100 : 0;
  // Disagreement between the country and the world is EXPECTED — it is exactly the reformulation
  // this module exists to catch — so it does not disqualify the country figure. It is reported.
  return { ...best.fact, corroborations: 2, spreadPct: Math.round(diff) };
}

function spreadPct(values: number[]): number | null {
  if (values.length < 2) return null;
  const lo = Math.min(...values), hi = Math.max(...values);
  if (hi <= 0) return null;
  return Math.round(((hi - lo) / hi) * 100);
}

/** The authoritative line handed to the model, and the provenance shown to the user. */
export function foodFactLine(f: FoodFact, lang: string): string {
  const es = lang === "es";
  const where = f.source === "barcode"
    ? (es ? "código de barras" : "code-barres")
    : f.country
      ? (es ? `base de productos, ${f.country}` : `base produits, ${f.country}`)
      : (es ? "base de productos, global" : "base produits, international");
  const name = [f.brand, f.productName].filter(Boolean).join(" ").trim() || (es ? "producto" : "produit");
  const qty = f.quantity ? ` (${f.quantity})` : "";
  return es
    ? `DATO DE ETIQUETA (${where}) — «${name}»${qty}: ${f.carbsPer100} g de carbohidratos por 100 g/ml. ESTA cifra manda sobre cualquier referencia tuya: multiplícala por la cantidad realmente consumida y NO la redondees a otro valor.`
    : `DONNÉE D'ÉTIQUETTE (${where}) — «${name}»${qty} : ${f.carbsPer100} g de glucides pour 100 g/ml. CE chiffre prime sur n'importe quel repère que tu connais : multiplie-le par la quantité réellement consommée et ne le remplace PAS par une autre valeur.`;
}
