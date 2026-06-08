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
// Pure fetch + Web APIs (no Deno/Node-only calls) so it imports cleanly in edge functions.

export interface LlmRequest {
  system?: string;
  user: string;
  maxTokens?: number;
  temperature?: number;
}

export interface LlmConfig {
  byokGeminiKey?: string | null;
  deepseekKey?: string | null;
  deepseekModel?: string;
  geminiModel?: string;
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

/** True when a usable BYOK Gemini key was provided. */
export function hasByok(cfg: LlmConfig): boolean {
  return !!(cfg.byokGeminiKey && cfg.byokGeminiKey.trim());
}

/** Returns the raw model output (expected to be one JSON object). Throws on transport/HTTP error. */
export async function chatJson(req: LlmRequest, cfg: LlmConfig): Promise<string> {
  const run = (r: LlmRequest): Promise<LlmResult> =>
    hasByok(cfg)
      ? geminiJson(r, cfg.byokGeminiKey!.trim(), cfg.geminiModel || "gemini-2.5-flash")
      : deepseekJson(r, (cfg.deepseekKey || "").trim(), cfg.deepseekModel || "deepseek-v4-flash");

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

async function deepseekJson(req: LlmRequest, key: string, model: string): Promise<LlmResult> {
  if (!key) throw new LlmError("auth", "no_llm_key");
  const messages: { role: string; content: string }[] = [];
  if (req.system) messages.push({ role: "system", content: req.system });
  messages.push({ role: "user", content: req.user });
  const r = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", "authorization": `Bearer ${key}` },
    body: JSON.stringify({
      model,
      messages,
      temperature: req.temperature ?? 0.3,
      max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
      response_format: { type: "json_object" },
    }),
  });
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
  const body = {
    contents: [{ role: "user", parts: [{ text: sys + req.user }] }],
    generationConfig: {
      temperature: req.temperature ?? 0.3,
      maxOutputTokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
      responseMimeType: "application/json",
      // No chain-of-thought for a short JSON answer; thinking would just eat the token budget and
      // risk the same mid-word truncation we fight on the DeepSeek path. (Pro fallback may reject
      // budget 0 with 400 -> the loop simply moves to the next candidate, which accepts it.)
      thinkingConfig: { thinkingBudget: 0 },
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
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
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
    if (r.status !== 404 && r.status !== 400) break;
  }
  throw new LlmError(classifyLlmError(lastStatus, lastBody), lastErr, lastStatus);
}
