// Unified text-JSON LLM caller for Doctor Claude.
//
// Default path = DeepSeek with the SERVER key (Hosted / our cost). If the client supplied their
// OWN Google Gemini key (BYOK), we call Gemini instead so the marginal AI cost is theirs (~0 to
// us) — the same model as xDrip+/Nightscout's "bring your own everything". Both providers are
// asked for a SINGLE JSON object; we return the raw content string for the caller to parse with
// its existing tolerant parser (so a BYOK switch never changes the response contract).
//
// IMPORTANT (truncation): both default models REASON before answering — DeepSeek-v4-flash emits
// `reasoning_tokens`, Gemini-2.5 "thinks" — and that reasoning is billed INSIDE the token budget.
// Its length is highly variable (measured 250-485 reasoning tokens for one short coaching JSON),
// so a tight cap gets swallowed by it and the JSON answer truncates mid-word ("...5 mont"). Two
// defenses: (1) `max_tokens` is a CEILING, not a target — the model stops naturally, so a generous
// default costs nothing extra and just removes the cliff; (2) if a provider still reports a length
// cutoff, retry once with a doubled cap. For Gemini we also disable thinking (thinkingBudget:0) —
// a short coaching JSON needs no chain-of-thought.
//
// THE DOMINO (v4.0). The family's own models answer first, in the order Nueve uses: ChatGPT, then Claude
// (its accounts take over from one another on the server), then DeepSeek. They write better and cost
// nothing per call, but they run on one machine at home and share their plans with Nueve. A week of their
// logs: a short ask takes 8 s on ChatGPT and 7 s on Claude at the median, 22 s and 16 s for one in ten, and
// the ChatGPT plan ran out for five days in October. So each one gets a head start, never a monopoly: past
// it, or as soon as it fails, the next one starts too, and the first valid answer wins. DeepSeek starts at
// 40 % of the budget at the latest, so nothing here can make an analysis later than DeepSeek alone would
// have been by more than that, and with the door shut this file behaves exactly as it did before.
//
// The servers' keys never come here. They are secrets of the Nueve project, and a door over there uses them
// for us: see supabase/functions-nueve/mechabetics-domino.
//
// Pure fetch + Web APIs (no Deno/Node-only calls) so it imports cleanly in edge functions. The environment
// is read when there is one, through globalThis.

export interface LlmRequest {
  /** Ground the answer in Google Search (Gemini only). For facts that live in the world and change
   *  by country — a packaged product's carbohydrate content — not for reasoning. Grounding forbids
   *  responseMimeType=json, so the caller must tolerate JSON wrapped in prose. */
  search?: boolean;
  system?: string;
  user: string;
  maxTokens?: number;
  temperature?: number;
  /** Hard cap on how long the provider may take, in ms. There was NO cap at all until 2026-08-05,
   *  and that is how "ajouter un repas" started failing: the carb estimate waited on a provider
   *  that had slowed to 30-60 s, the phone gave up at 45 s (OkHttp callTimeout) and showed « Échec
   *  de l'enregistrement » — while the server, still running, went on to insert the meal. The
   *  parent retried and made duplicates of their child's food.
   *  Every caller that a HUMAN IS WAITING ON must pass a value well under the client's timeout. */
  timeoutMs?: number;
}

export interface LlmConfig {
  byokGeminiKey?: string | null;
  deepseekKey?: string | null;
  deepseekModel?: string;
  geminiModel?: string;
  /** The family's own servers, in order. Worked out from the environment when not given here. */
  domino?: DominoLink[] | null;
}

export interface DominoLink {
  /** Who it is, for the logs and for the rest it takes. */
  name: string;
  url: string;
  /** What opens the door for one ask. Throws when it can't, and the next link starts. */
  access: () => Promise<Record<string, string>>;
  /** The model and the effort, in the words that server reads. */
  ask: Record<string, unknown>;
}

interface LlmResult {
  content: string;
  /** True when the provider cut the output at the token cap (the answer is incomplete). */
  truncated: boolean;
}

// ---- Failure classification --------------------------------------------------------------------
// Without this, EVERY provider failure collapsed into one opaque "Erreur IA" string, so the app
// could not tell "the AI is down" from "the AI ran out of money / quota" from "the key is bad".
// We map the provider's HTTP status + error body to a cause the UI can speak to honestly.

/** Classified cause of an LLM failure. */
export type LlmErrorKind = "auth" | "out_of_credits" | "rate_limited" | "ai_down";

export class LlmError extends Error {
  kind: LlmErrorKind;
  status: number;
  constructor(kind: LlmErrorKind, message: string, status = 0) {
    super(message);
    this.name = "LlmError";
    this.kind = kind;
    this.status = status;
  }
}

/** An AbortError from our own timeout, told apart from a network throw so callers can say "too
 *  slow" rather than "down" — and so a caller with a fallback (carbs unknown) can take it. */
export function isLlmTimeout(e: unknown): boolean {
  return e instanceof LlmError && e.status === 408;
}

/** Runs `fetch` with a hard deadline. Without one, a stalled provider holds the request until the
 *  platform kills it — long after the phone gave up (see LlmRequest.timeoutMs). */
async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs?: number): Promise<Response> {
  if (!timeoutMs || !(timeoutMs > 0)) return await fetch(url, init);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctl.signal });
  } catch (e) {
    if ((e as Error)?.name === "AbortError") {
      throw new LlmError("ai_down", `llm_timeout_${timeoutMs}ms`, 408);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** Map an HTTP status + error body from any provider (DeepSeek/Gemini/Anthropic) to a cause. */
export function classifyLlmError(status: number, body: string): LlmErrorKind {
  const b = (body || "").toLowerCase();
  if (status === 401 || status === 403 || b.includes("api key") || b.includes("api_key") ||
      b.includes("unauthor") || b.includes("permission_denied")) return "auth";
  if (status === 402 || b.includes("insufficient") || b.includes("balance") ||
      b.includes("billing") || b.includes("payment")) return "out_of_credits";
  if (status === 429) {
    // 429 is ambiguous: free-tier quota exhaustion (≈ out of credits) vs a transient rate limit.
    if (b.includes("quota") || b.includes("resource_exhausted") || b.includes("exceeded")) return "out_of_credits";
    return "rate_limited";
  }
  return "ai_down"; // 5xx, network, or anything else
}

/** The kind of a caught error (LlmError → its kind; anything else, e.g. a network throw → ai_down). */
export function llmErrorKind(e: unknown): LlmErrorKind {
  return e instanceof LlmError ? e.kind : "ai_down";
}

/** A friendly, localized message for the user. `byok` tailors it: a BYOK user owns the fix
 *  (their own key/quota); a Hosted user just needs to know it's a service-side problem. */
export function llmErrorMessage(kind: LlmErrorKind, lang: string, byok: boolean): string {
  const es = lang === "es";
  switch (kind) {
    case "out_of_credits":
      return byok
        ? (es ? "Tu clave de IA (Gemini) agotó su cuota gratuita. Espera un poco o revisa tu cuenta."
              : "Ta clé IA (Gemini) a épuisé son quota gratuit. Attends un peu ou vérifie ton compte.")
        : (es ? "El servicio de IA no está disponible ahora mismo (problema del servicio). Lo estamos resolviendo."
              : "Le service IA est indisponible pour le moment (problème côté service). On s'en occupe.");
    case "rate_limited":
      return es ? "La IA recibe demasiadas peticiones ahora mismo. Reinténtalo en un momento."
                : "L'IA reçoit trop de requêtes là tout de suite. Réessaie dans un instant.";
    case "auth":
      return byok
        ? (es ? "Tu clave de IA no es válida. Revísala en Perfil." : "Ta clé IA n'est pas valide. Vérifie-la dans Profil.")
        : (es ? "Problema de configuración de la IA. Lo estamos resolviendo." : "Problème de configuration de l'IA. On s'en occupe.");
    default: // ai_down
      return es ? "La IA no responde ahora mismo. Reinténtalo en un momento."
                : "L'IA ne répond pas pour l'instant. Réessaie dans un instant.";
  }
}

/** Generous default cap: headroom for variable reasoning + a short JSON answer (see header note). */
const DEFAULT_MAX_TOKENS = 4000;

/**
 * GEMINI IS OFF FOR TEXT (decision of 2026-08-05, to cut the Google AI bill).
 *
 * The Google project behind the BYOK keys has no billing attached, so those keys run on the free
 * tier: a few requests a minute, then failures — which is what the meal screen was drowning in.
 * DeepSeek (the service's own key) answers everything the text side needs: the prose around the
 * numbers and the carb estimate. The numbers themselves never came from a model.
 *
 * Left as one switch rather than deleted: the BYOK plumbing (client field, config, fallback) still
 * works, so re-enabling is flipping this to `false` — not re-plumbing five functions.
 *
 * NOT affected: the PHOTO SCAN. DeepSeek is text-only, so vision keeps its own chain in
 * mechabetics-scan (Anthropic, then the service's Gemini vision key) — verified answering in 5.4 s
 * with no client key at all.
 */
const IGNORE_BYOK_FOR_TEXT = true;

/** True when a usable BYOK Gemini key was provided AND we are allowed to use it. */
export function hasByok(cfg: LlmConfig): boolean {
  if (IGNORE_BYOK_FOR_TEXT) return false;
  return !!(cfg.byokGeminiKey && cfg.byokGeminiKey.trim());
}

/** Returns the raw model output (expected to be one JSON object). Throws on transport/HTTP error. */
export async function chatJson(req: LlmRequest, cfg: LlmConfig): Promise<string> {
  const serverKey = (cfg.deepseekKey || "").trim();
  const deepseek = (r: LlmRequest): Promise<LlmResult> =>
    deepseekJson(r, serverKey, cfg.deepseekModel || "deepseek-v4-flash");

  // CROSS-PROVIDER FALLBACK. The user's own Gemini key (BYOK) is tried first — it is why the app is
  // free to run — but a key that has been throttled, unbilled or spent must not take the child's
  // app down with it. 2026-08-05: Google AI spending was cut, and the meal screen started answering
  // « Échec de l'enregistrement ». Anything that is NOT the model's fault (auth / quota / rate limit
  // / our own timeout) now falls through to the service's own key when there is one.
  const run = async (r: LlmRequest): Promise<LlmResult> => {
    if (!hasByok(cfg)) return await deepseek(r);
    try {
      return await geminiJson(r, cfg.byokGeminiKey!.trim(), cfg.geminiModel || "gemini-2.5-flash");
    } catch (e) {
      const kind = llmErrorKind(e);
      const recoverable = kind === "auth" || kind === "out_of_credits" || kind === "rate_limited" || isLlmTimeout(e);
      if (!serverKey || !recoverable) throw e;
      return await deepseek(r);
    }
  };

  const base: LlmRequest = { ...req, maxTokens: req.maxTokens ?? DEFAULT_MAX_TOKENS };
  let res = await run(base);
  if (res.truncated) {
    // Reasoning swallowed the budget on this run — retry once with much more headroom and keep
    // whichever answer is longer (the retry, unless it somehow came back shorter).
    const bigger: LlmRequest = { ...base, maxTokens: Math.max((base.maxTokens ?? DEFAULT_MAX_TOKENS) * 2, 8000) };
    const retry = await run(bigger);
    if (retry.content.length >= res.content.length) res = retry;
  }
  return res.content;
}

/** In the Nueve project, because that is where the servers' keys are. */
const DOMINO_DOOR = "https://nppzlbiznfsijlbdxubx.supabase.co/functions/v1/mechabetics-domino";
/** Writing a pass is one row in this project's own database. Past this, the link is skipped. */
const DOMINO_PASS_MS = 3000;

/** One ask, one pass: written here, where only this project's server can write, and checked there. */
async function dominoPass(base: string, service: string, anon: string): Promise<Record<string, string>> {
  const pass = crypto.randomUUID();
  const r = await fetch(`${base}/rest/v1/mechabetics_domino_passes`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "apikey": service,
      "authorization": `Bearer ${service}`,
      "prefer": "return=minimal",
    },
    body: JSON.stringify({ pass }),
    signal: AbortSignal.timeout(DOMINO_PASS_MS),
  });
  if (!r.ok) throw new LlmError("ai_down", `domino: no pass (${r.status})`, r.status);
  return { "x-domino-pass": pass, "x-domino-key": anon };
}

/** The links in order, or none outside an edge function, and nothing changes. Low effort: this is a short
 *  JSON answer someone is waiting for. "gpt" follows whatever model the server's plan is on. */
export function dominoFrom(cfg: LlmConfig): DominoLink[] {
  if (cfg.domino) return cfg.domino;
  // deno-lint-ignore no-explicit-any
  const env = (globalThis as any).Deno?.env;
  const read = (name: string) => String(env?.get?.(name) ?? "").trim();
  const base = read("SUPABASE_URL").replace(/\/+$/, "");
  const service = read("SUPABASE_SERVICE_ROLE_KEY");
  const anon = read("SUPABASE_ANON_KEY");
  if (!base || !service || !anon) return [];
  const access = () => dominoPass(base, service, anon);
  return [
    { name: "gpt", url: `${DOMINO_DOOR}?link=gpt`, access, ask: { model: "gpt", reasoning_effort: "low" } },
    { name: "claude", url: `${DOMINO_DOOR}?link=claude`, access, ask: { model: "claude-sonnet-5-5", effort: "low" } },
  ];
}

/** The servers stream keepalive spaces and `REASON{...}` progress lines before the final completion
 *  JSON, so a plain `res.json()` throws. Returns the model's text. */
export function serverContent(bodyText: string): string {
  const lines = (bodyText || "").split("\n").map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].startsWith("{")) continue;
    let candidate: any = null;
    try { candidate = JSON.parse(lines[i]); } catch { continue; }
    if (candidate?.error) throw new LlmError(classifyLlmError(0, String(candidate.error)), `server: ${String(candidate.error).slice(0, 200)}`);
    const content = candidate?.choices?.[0]?.message?.content;
    if (typeof content === "string" && content.trim()) return content.trim();
  }
  throw new LlmError("ai_down", "server: empty or unreadable answer");
}

/** These servers are agents wrapped as chat endpoints, so the JSON can arrive inside a code fence or
 *  after a sentence. Returns the object as text, or null when there is no valid one. */
export function jsonObjectIn(text: string): string | null {
  const t = (text || "").trim();
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  const candidate = t.slice(start, end + 1);
  try {
    const v = JSON.parse(candidate);
    return v && typeof v === "object" ? candidate : null;
  } catch {
    return null;
  }
}

/** Blank, or a JSON object with nothing in it. Not an answer, whoever sent it. */
export function emptyAnswer(text: string): boolean {
  const t = (text || "").trim();
  if (!t) return true;
  try {
    const v = JSON.parse(t);
    return !v || typeof v !== "object" || !Object.values(v).some((x) => x != null && x !== "");
  } catch {
    return false;
  }
}

async function askLink(req: LlmRequest, link: DominoLink, timeoutMs: number, signal: AbortSignal): Promise<string> {
  const messages: { role: string; content: string }[] = [];
  if (req.system) messages.push({ role: "system", content: req.system });
  messages.push({ role: "user", content: req.user });
  const ctl = new AbortController();
  const stop = () => ctl.abort();
  if (signal.aborted) stop();
  signal.addEventListener("abort", stop);
  const timer = setTimeout(stop, timeoutMs);
  try {
    const access = await link.access();
    const r = await fetch(link.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...access },
      body: JSON.stringify({
        ...link.ask,
        messages,
        temperature: req.temperature ?? 0.3,
        max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
      }),
      signal: ctl.signal,
    });
    const body = await r.text();
    if (!r.ok) throw new LlmError(classifyLlmError(r.status, body), `${link.name} ${r.status}: ${body.slice(0, 200)}`, r.status);
    const json = jsonObjectIn(serverContent(body));
    if (!json || emptyAnswer(json)) throw new LlmError("ai_down", `${link.name}: no JSON object in the answer`);
    return json;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", stop);
  }
}

/** Share of the budget the family's servers have to themselves before DeepSeek starts too. */
export const DOMINO_HEAD_START = 0.4;
/** After an answer that says the plan or the door is the problem, leave that server alone this long
 *  instead of paying its head start on every analysis of a plan that ran out for days. */
export const DOMINO_REST_MS = 10 * 60000;
/** Another link answering first this many times running means the server is hanging, not slow: it gets
 *  the same rest, or every analysis waits out a head start for nothing. */
export const DOMINO_MISSES = 2;
const dominoState = new Map<string, { restUntil: number; misses: number }>();
const stateOf = (name: string) => {
  let s = dominoState.get(name);
  if (!s) dominoState.set(name, s = { restUntil: 0, misses: 0 });
  return s;
};

/** For tests. */
export function resetDomino(): void {
  dominoState.clear();
}

/** An answer from anyone asked so far, or null: every one of them failed, or their time is up. */
async function firstAnswer(asked: Promise<string>[], waitMs: number): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clock = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), Math.max(0, waitMs));
  });
  const first = await Promise.race([Promise.any(asked).catch(() => null), clock]);
  if (timer !== undefined) clearTimeout(timer);
  return first;
}

/**
 * `chatJson` with a HARD ceiling on the WHOLE exchange — provider call, cross-provider fallback and
 * the retry chatJson makes when an answer came back cut off. A per-call timeout is not enough: on
 * 2026-08-05 a "22 s per call" budget still produced a 47 s answer on the meal screen, and a coach
 * analysis measured 68 s against the app's 80 s ceiling — one slow afternoon away from « Service
 * injoignable » on a parent's phone.
 *
 * Throws LlmError(408) on expiry, which every caller already handles the right way: they drop the
 * model's prose and return the CODE-OWNED action instead. The dose never came from the model, so a
 * timed-out analysis is a shorter answer, never a wrong one.
 */
export async function chatJsonWithin(req: LlmRequest, cfg: LlmConfig, totalMs: number): Promise<string> {
  const links = totalMs > 0 ? dominoFrom(cfg).filter((l) => Date.now() >= stateOf(l.name).restUntil) : [];
  if (!links.length) return await remoteWithin(req, cfg, totalMs);

  const started = Date.now();
  const hangUp = new AbortController();
  const stillThinking = new Set<string>();
  const ask = (link: DominoLink): Promise<string> => {
    stillThinking.add(link.name);
    return askLink(req, link, totalMs, hangUp.signal).then((json) => {
      stillThinking.delete(link.name);
      stateOf(link.name).misses = 0;
      console.log(`llm: ${link.name} answered in ${Date.now() - started} ms`);
      return json;
    }).catch((e) => {
      stillThinking.delete(link.name);
      const kind = llmErrorKind(e);
      if (kind === "auth" || kind === "out_of_credits" || kind === "rate_limited") {
        stateOf(link.name).restUntil = Date.now() + DOMINO_REST_MS;
      }
      if (!hangUp.signal.aborted) console.warn(`llm: ${link.name} failed (${kind}): ${(e as Error)?.message ?? e}`);
      throw e;
    });
  };

  const asked: Promise<string>[] = [];
  let answer: string | null = null;
  try {
    // Each link: its share of the head start, cut short the moment everyone asked so far has failed.
    for (let i = 0; i < links.length; i++) {
      asked.push(ask(links[i]));
      const nextAt = totalMs * DOMINO_HEAD_START * (i + 1) / links.length;
      answer = await firstAnswer(asked, nextAt - (Date.now() - started));
      if (answer) return answer;
    }
    // Still nothing: DeepSeek joins in, with what is left of the budget.
    const left = Math.max(1000, totalMs - (Date.now() - started));
    // An empty answer is not a win: a server may still be working on a real one.
    const remote = remoteWithin(req, cfg, left).then((text) => {
      if (emptyAnswer(text)) throw new LlmError("ai_down", "empty answer");
      return text;
    });
    answer = await Promise.any([...asked, remote]).catch((e) => {
      const errors = (e as AggregateError)?.errors ?? [];
      throw errors[errors.length - 1] ?? e; // DeepSeek's error: the one callers know how to word
    });
    return answer;
  } finally {
    // A server still thinking when someone else answered has missed its turn.
    if (answer) {
      for (const name of stillThinking) {
        const s = stateOf(name);
        if (++s.misses >= DOMINO_MISSES) {
          s.restUntil = Date.now() + DOMINO_REST_MS;
          s.misses = 0;
        }
      }
    }
    hangUp.abort(); // whichever way it ended, the servers stop working on an answer nobody will read
  }
}

async function remoteWithin(req: LlmRequest, cfg: LlmConfig, totalMs: number): Promise<string> {
  if (!(totalMs > 0)) return await chatJson(req, cfg);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clock = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new LlmError("ai_down", `llm_total_timeout_${totalMs}ms`, 408)), totalMs);
  });
  try {
    return await Promise.race([chatJson({ ...req, timeoutMs: req.timeoutMs ?? totalMs }, cfg), clock]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function deepseekJson(req: LlmRequest, key: string, model: string): Promise<LlmResult> {
  if (!key) throw new LlmError("auth", "no_llm_key");
  const messages: { role: string; content: string }[] = [];
  if (req.system) messages.push({ role: "system", content: req.system });
  messages.push({ role: "user", content: req.user });
  const r = await fetchWithTimeout("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", "authorization": `Bearer ${key}` },
    body: JSON.stringify({
      model,
      messages,
      temperature: req.temperature ?? 0.3,
      max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
      response_format: { type: "json_object" },
    }),
  }, req.timeoutMs);
  if (!r.ok) {
    const t = await r.text();
    throw new LlmError(classifyLlmError(r.status, t), `DeepSeek ${r.status}: ${t.slice(0, 200)}`, r.status);
  }
  const j = await r.json();
  const choice = j?.choices?.[0];
  const content = (choice?.message?.content ?? "").trim();
  return { content, truncated: choice?.finish_reason === "length" };
}

async function geminiJson(req: LlmRequest, key: string, model: string): Promise<LlmResult> {
  const sys = req.system ? `${req.system}\n\n` : "";
  // Google Search grounding cannot be combined with a forced JSON mime type — the API rejects the
  // pair — so a grounded call asks for JSON in the prompt instead and the caller digs it out.
  const grounded = req.search === true;
  const body: Record<string, unknown> = {
    contents: [{ role: "user", parts: [{ text: sys + req.user }] }],
    ...(grounded ? { tools: [{ google_search: {} }] } : {}),
    generationConfig: {
      temperature: req.temperature ?? 0.3,
      maxOutputTokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
      ...(grounded ? {} : { responseMimeType: "application/json" }),
      // No chain-of-thought for a short JSON answer; thinking would just eat the token budget and
      // risk the same mid-word truncation we fight on the DeepSeek path. (Pro fallback may reject
      // budget 0 with 400 -> the loop simply moves to the next candidate, which accepts it.)
      ...(grounded ? {} : { thinkingConfig: { thinkingBudget: 0 } }),
    },
  };
  // Try the requested model first, then fall back through known-good models if it 404s. This way
  // pinning a newer id (e.g. gemini-3.x) via MECHABETICS_GEMINI_TEXT_MODEL works the moment it
  // exists, and an unknown id degrades gracefully instead of erroring.
  const candidates = [model, "gemini-2.5-flash", "gemini-flash-latest", "gemini-2.5-pro", "gemini-2.5-flash-lite"]
    .filter((m, i, a) => m && a.indexOf(m) === i);
  let lastErr = "Gemini: aucun modèle disponible";
  let lastStatus = 0;
  let lastBody = "";
  for (const m of candidates) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${encodeURIComponent(key)}`;
    const r = await fetchWithTimeout(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, req.timeoutMs);
    if (r.ok) {
      const j = await r.json();
      const cand = j?.candidates?.[0];
      const parts = cand?.content?.parts ?? [];
      const content = parts.map((p: { text?: string }) => p?.text ?? "").join("").trim();
      return { content, truncated: cand?.finishReason === "MAX_TOKENS" };
    }
    lastBody = await r.text();
    lastStatus = r.status;
    lastErr = `Gemini ${r.status} (${m}): ${lastBody.slice(0, 160)}`;
    // GROUNDING MUST NEVER COST US THE ANSWER. Search grounding is an enhancement — it makes a
    // packaged product's carbs a looked-up fact instead of a recollection — but a model that does
    // not support the tool, or an account without it enabled, answers 400. Retry the same model
    // once WITHOUT the tool rather than losing the estimate entirely.
    if (grounded && (r.status === 400 || r.status === 403)) {
      const plain = { ...body };
      delete (plain as Record<string, unknown>).tools;
      (plain as any).generationConfig = {
        ...(body.generationConfig as Record<string, unknown>),
        responseMimeType: "application/json",
        thinkingConfig: { thinkingBudget: 0 },
      };
      const r2 = await fetchWithTimeout(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(plain) }, req.timeoutMs);
      if (r2.ok) {
        const j2 = await r2.json();
        const c2 = j2?.candidates?.[0];
        const parts2 = c2?.content?.parts ?? [];
        return { content: parts2.map((p: { text?: string }) => p?.text ?? "").join("").trim(), truncated: c2?.finishReason === "MAX_TOKENS" };
      }
    }
    if (r.status !== 404 && r.status !== 400) break;
  }
  throw new LlmError(classifyLlmError(lastStatus, lastBody), lastErr, lastStatus);
}
