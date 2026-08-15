// Tests for LLM failure classification. Run with Node 24+ (native TS):
//   node --test supabase/functions/_shared/llm.test.ts
// These lock the behavior that lets the app tell the user WHAT is wrong (down vs out-of-credits
// vs rate-limited vs bad key) instead of one opaque "Erreur IA".
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyLlmError, llmErrorKind, llmErrorMessage, LlmError } from "./llm.ts";

test("DeepSeek 402 Insufficient Balance -> out_of_credits", () => {
  assert.equal(classifyLlmError(402, '{"error":{"message":"Insufficient Balance"}}'), "out_of_credits");
});

test("Anthropic 400 credit balance too low -> out_of_credits", () => {
  assert.equal(classifyLlmError(400, "Your credit balance is too low to access the API"), "out_of_credits");
});

test("401 / 403 -> auth", () => {
  assert.equal(classifyLlmError(401, "Unauthorized"), "auth");
  assert.equal(classifyLlmError(403, "Forbidden"), "auth");
});

test("Gemini 400 API_KEY_INVALID -> auth", () => {
  assert.equal(classifyLlmError(400, '{"error":{"status":"INVALID_ARGUMENT","message":"API_KEY_INVALID"}}'), "auth");
});

test("Gemini 429 RESOURCE_EXHAUSTED / quota -> out_of_credits (free quota)", () => {
  assert.equal(classifyLlmError(429, '{"error":{"status":"RESOURCE_EXHAUSTED","message":"You exceeded your current quota"}}'), "out_of_credits");
});

test("plain 429 rate limit -> rate_limited", () => {
  assert.equal(classifyLlmError(429, "Too Many Requests"), "rate_limited");
});

test("5xx / unknown -> ai_down", () => {
  assert.equal(classifyLlmError(500, "Internal Server Error"), "ai_down");
  assert.equal(classifyLlmError(503, "Service Unavailable"), "ai_down");
  assert.equal(classifyLlmError(0, ""), "ai_down");
});

test("llmErrorKind: LlmError keeps its kind, anything else -> ai_down", () => {
  assert.equal(llmErrorKind(new LlmError("out_of_credits", "x")), "out_of_credits");
  assert.equal(llmErrorKind(new TypeError("network")), "ai_down"); // a fetch transport throw
  assert.equal(llmErrorKind("oops"), "ai_down");
});

test("llmErrorMessage: hosted out-of-credits hides the key, BYOK owns it", () => {
  const hosted = llmErrorMessage("out_of_credits", "fr", false);
  const byok = llmErrorMessage("out_of_credits", "fr", true);
  assert.match(hosted, /service/i);
  assert.ok(!/clé/i.test(hosted));         // a Hosted user shouldn't be told to fix a key
  assert.match(byok, /clé/i);              // a BYOK user is told it's their key/quota
});

test("llmErrorMessage: auth + BYOK tells the user to fix the key; ai_down is generic", () => {
  assert.match(llmErrorMessage("auth", "fr", true), /clé/i);
  assert.match(llmErrorMessage("ai_down", "fr", false), /ne répond pas/i);
  assert.match(llmErrorMessage("ai_down", "es", false), /no responde/i);
});
