// Tests for LLM failure classification. Run with Node 24+ (native TS):
//   node --test supabase/functions/_shared/llm.test.ts
// These lock the behavior that lets the app tell the user WHAT is wrong (down vs out-of-credits
// vs rate-limited vs bad key) instead of one opaque "Erreur IA".
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chatJsonWithin, classifyLlmError, DOMINO_HEAD_START, DOMINO_MISSES, dominoFrom, emptyAnswer, jsonObjectIn, llmErrorKind,
  llmErrorMessage, LlmError, resetDomino, serverContent,
} from "./llm.ts";

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

// ---- The domino ---------------------------------------------------------------------------------
const door = async () => ({ "x-domino-pass": "p" });
const GPT = { name: "gpt", url: "https://door.test/?link=gpt", access: door, ask: { model: "gpt", reasoning_effort: "low" } };
const CLAUDE = { name: "claude", url: "https://door.test/?link=claude", access: door, ask: { model: "claude-sonnet-5-5", effort: "low" } };
const DS = { deepseekKey: "k", deepseekModel: "m" };
const completion = (text: string) => JSON.stringify({ choices: [{ message: { content: text } }] });
const deepseekOk = (text: string) => new Response(JSON.stringify({ choices: [{ message: { content: text }, finish_reason: "stop" }] }), { status: 200 });

function withFetch(handler: (url: string, init: any) => Promise<Response>) {
  const real = globalThis.fetch;
  globalThis.fetch = ((url: any, init: any) => handler(String(url), init)) as any;
  return () => { globalThis.fetch = real; };
}

test("the streamed answer of the local server is read past its keepalives and progress lines", () => {
  const body = ` \n  REASON{"kind":"progress","text":"x"}\n ${completion('{"summary":"ok"}')}`;
  assert.equal(serverContent(body), '{"summary":"ok"}');
  assert.throws(() => serverContent("   "));
});

test("JSON is dug out of a fence or a sentence, and anything else is refused", () => {
  assert.equal(jsonObjectIn('```json\n{"a":1}\n```'), '{"a":1}');
  assert.equal(jsonObjectIn('Voici : {"a":1} !'), '{"a":1}');
  assert.equal(jsonObjectIn("I cannot help with that"), null);
  assert.equal(jsonObjectIn('{"a":'), null);
});

test("the local answer wins when it arrives inside its head start, and DeepSeek is never called", async () => {
  resetDomino();
  const calls: string[] = [];
  const restore = withFetch(async (url) => {
    calls.push(url);
    return new Response(completion('{"who":"gpt"}'), { status: 200 });
  });
  try {
    assert.equal(await chatJsonWithin({ user: "x" }, { ...DS, domino: [GPT] }, 2000), '{"who":"gpt"}');
    assert.deepEqual(calls, [GPT.url]);
  } finally { restore(); }
});

test("a slow local server loses to DeepSeek, and the analysis is not held back", async () => {
  resetDomino();
  const restore = withFetch((url, init) => {
    if (url.includes("deepseek")) return Promise.resolve(deepseekOk('{"who":"deepseek"}'));
    return new Promise((_ok, no) => init.signal.addEventListener("abort", () => no(new Error("aborted"))));
  });
  try {
    const t0 = Date.now();
    assert.equal(await chatJsonWithin({ user: "x" }, { ...DS, domino: [GPT] }, 500), '{"who":"deepseek"}');
    assert.ok(Date.now() - t0 < 450, `took ${Date.now() - t0} ms`);
  } finally { restore(); }
});

test("a plan that ran out sends the next analyses straight to DeepSeek", async () => {
  resetDomino();
  const calls: string[] = [];
  const restore = withFetch(async (url) => {
    calls.push(url.includes("deepseek") ? "deepseek" : "gpt");
    if (url.includes("deepseek")) return deepseekOk('{"who":"deepseek"}');
    return new Response("quota exceeded", { status: 429 });
  });
  try {
    await chatJsonWithin({ user: "x" }, { ...DS, domino: [GPT] }, 500);
    await chatJsonWithin({ user: "x" }, { ...DS, domino: [GPT] }, 500);
    assert.deepEqual(calls, ["gpt", "deepseek", "deepseek"]);
  } finally { restore(); resetDomino(); }
});

test("outside an edge function there is no door: DeepSeek answers alone", async () => {
  resetDomino();
  const calls: string[] = [];
  const restore = withFetch(async (url) => { calls.push(url); return deepseekOk('{"who":"deepseek"}'); });
  try {
    assert.equal(await chatJsonWithin({ user: "x" }, DS, 500), '{"who":"deepseek"}');
    assert.equal(calls.length, 1);
    assert.ok(calls[0].includes("deepseek"));
  } finally { restore(); }
});

test("an answer with nothing in it is not an answer", () => {
  assert.equal(emptyAnswer(""), true);
  assert.equal(emptyAnswer("{}"), true);
  assert.equal(emptyAnswer('{"reply":"","voice":null}'), true);
  assert.equal(emptyAnswer('{"reply":"ok"}'), false);
  assert.equal(emptyAnswer("du texte"), false);
});

test("{} from the local server does not win: DeepSeek still answers", async () => {
  resetDomino();
  const restore = withFetch(async (url) => {
    if (url.includes("deepseek")) return deepseekOk('{"who":"deepseek"}');
    return new Response(completion("{}"), { status: 200 });
  });
  try {
    assert.equal(await chatJsonWithin({ user: "x" }, { ...DS, domino: [GPT] }, 500), '{"who":"deepseek"}');
  } finally { restore(); }
});

test("an empty DeepSeek answer does not beat a local one still working", async () => {
  resetDomino();
  const restore = withFetch(async (url) => {
    if (url.includes("deepseek")) return deepseekOk("{}");
    await new Promise((r) => setTimeout(r, 300));
    return new Response(completion('{"who":"gpt"}'), { status: 200 });
  });
  try {
    assert.equal(await chatJsonWithin({ user: "x" }, { ...DS, domino: [GPT] }, 500), '{"who":"gpt"}');
  } finally { restore(); }
});

test("a server that hangs twice running stops costing a head start", async () => {
  resetDomino();
  const calls: string[] = [];
  const restore = withFetch((url, init) => {
    calls.push(url.includes("deepseek") ? "deepseek" : "gpt");
    if (url.includes("deepseek")) return Promise.resolve(deepseekOk('{"who":"deepseek"}'));
    return new Promise((_ok, no) => init.signal.addEventListener("abort", () => no(new Error("aborted"))));
  });
  try {
    for (let i = 0; i <= DOMINO_MISSES; i++) await chatJsonWithin({ user: "x" }, { ...DS, domino: [GPT] }, 100);
    assert.deepEqual(calls, ["gpt", "deepseek", "gpt", "deepseek", "deepseek"]);
  } finally { restore(); resetDomino(); }
});

// ---- The whole chain: ChatGPT, then Claude, then DeepSeek ---------------------------------------
const who = (url: string) => url.includes("deepseek") ? "deepseek" : url.includes("link=claude") ? "claude" : "gpt";
const hangs = (init: any) => new Promise<Response>((_ok, no) => init.signal.addEventListener("abort", () => no(new Error("aborted"))));
const later = (ms: number, text: string) => new Promise<Response>((ok) => setTimeout(() => ok(new Response(completion(text), { status: 200 })), ms));

test("the domino: ChatGPT down, Claude takes over at once and DeepSeek is not asked", async () => {
  resetDomino();
  const calls: string[] = [];
  const restore = withFetch(async (url) => {
    calls.push(who(url));
    if (who(url) === "gpt") return new Response("boom", { status: 500 });
    return new Response(completion('{"who":"claude"}'), { status: 200 });
  });
  try {
    const t0 = Date.now();
    assert.equal(await chatJsonWithin({ user: "x" }, { ...DS, domino: [GPT, CLAUDE] }, 2000), '{"who":"claude"}');
    assert.deepEqual(calls, ["gpt", "claude"]);
    assert.ok(Date.now() - t0 < 200, `took ${Date.now() - t0} ms: Claude waited out the head start`);
  } finally { restore(); resetDomino(); }
});

test("the domino: ChatGPT slow, Claude starts at its turn and the first answer wins", async () => {
  resetDomino();
  const started: Record<string, number> = {};
  const t0 = Date.now();
  const restore = withFetch((url, init) => {
    started[who(url)] = Date.now() - t0;
    if (who(url) === "claude") return later(20, '{"who":"claude"}');
    return hangs(init);
  });
  try {
    assert.equal(await chatJsonWithin({ user: "x" }, { ...DS, domino: [GPT, CLAUDE] }, 1000), '{"who":"claude"}');
    assert.ok(started.claude >= 150 && started.claude < 300, `Claude started at ${started.claude} ms`);
    assert.equal(started.deepseek, undefined);
  } finally { restore(); resetDomino(); }
});

test("the domino: an early ChatGPT answer means Claude is never asked", async () => {
  resetDomino();
  const calls: string[] = [];
  const restore = withFetch((url) => { calls.push(who(url)); return later(10, '{"who":"gpt"}'); });
  try {
    assert.equal(await chatJsonWithin({ user: "x" }, { ...DS, domino: [GPT, CLAUDE] }, 1000), '{"who":"gpt"}');
    assert.deepEqual(calls, ["gpt"]);
  } finally { restore(); resetDomino(); }
});

test("the domino: both servers hanging, DeepSeek starts no later than it did with one", async () => {
  resetDomino();
  const started: Record<string, number> = {};
  const t0 = Date.now();
  const restore = withFetch((url, init) => {
    started[who(url)] = Date.now() - t0;
    if (who(url) === "deepseek") return Promise.resolve(deepseekOk('{"who":"deepseek"}'));
    return hangs(init);
  });
  try {
    assert.equal(await chatJsonWithin({ user: "x" }, { ...DS, domino: [GPT, CLAUDE] }, 1000), '{"who":"deepseek"}');
    assert.ok(started.deepseek <= 1000 * DOMINO_HEAD_START + 80, `DeepSeek started at ${started.deepseek} ms`);
  } finally { restore(); resetDomino(); }
});

test("the domino: every link down, DeepSeek down too, the caller gets DeepSeek's error", async () => {
  resetDomino();
  const restore = withFetch(async (url) => {
    if (who(url) === "deepseek") return new Response("Insufficient Balance", { status: 402 });
    return new Response("boom", { status: 500 });
  });
  try {
    await assert.rejects(chatJsonWithin({ user: "x" }, { ...DS, domino: [GPT, CLAUDE] }, 500), (e) => llmErrorKind(e) === "out_of_credits");
  } finally { restore(); resetDomino(); }
});

test("the domino: a shut door costs nothing, nothing is asked of that server and DeepSeek answers at once", async () => {
  resetDomino();
  const calls: string[] = [];
  const shut = async () => { throw new LlmError("ai_down", "no pass"); };
  const restore = withFetch(async (url) => { calls.push(who(url)); return deepseekOk('{"who":"deepseek"}'); });
  try {
    const t0 = Date.now();
    const links = [{ ...GPT, access: shut }, { ...CLAUDE, access: shut }];
    assert.equal(await chatJsonWithin({ user: "x" }, { ...DS, domino: links }, 2000), '{"who":"deepseek"}');
    assert.deepEqual(calls, ["deepseek"]);
    assert.ok(Date.now() - t0 < 200, `took ${Date.now() - t0} ms`);
  } finally { restore(); resetDomino(); }
});

test("the domino: a refused link rests alone, the other one keeps its turn", async () => {
  resetDomino();
  const calls: string[] = [];
  const restore = withFetch(async (url) => {
    calls.push(who(url));
    if (who(url) === "gpt") return new Response("quota exceeded", { status: 429 });
    return new Response(completion('{"who":"claude"}'), { status: 200 });
  });
  try {
    await chatJsonWithin({ user: "x" }, { ...DS, domino: [GPT, CLAUDE] }, 500);
    await chatJsonWithin({ user: "x" }, { ...DS, domino: [GPT, CLAUDE] }, 500);
    assert.deepEqual(calls, ["gpt", "claude", "claude"]);
  } finally { restore(); resetDomino(); }
});

test("the domino: a server beaten by the next link twice running rests, an answer clears the count", async () => {
  resetDomino();
  const calls: string[] = [];
  let gptAnswers = false;
  const restore = withFetch((url, init) => {
    calls.push(who(url));
    if (who(url) === "claude") return later(5, '{"who":"claude"}');
    return gptAnswers ? later(1, '{"who":"gpt"}') : hangs(init);
  });
  try {
    await chatJsonWithin({ user: "x" }, { ...DS, domino: [GPT, CLAUDE] }, 100); // one miss
    gptAnswers = true;
    await chatJsonWithin({ user: "x" }, { ...DS, domino: [GPT, CLAUDE] }, 100); // answered: count back to zero
    gptAnswers = false;
    await chatJsonWithin({ user: "x" }, { ...DS, domino: [GPT, CLAUDE] }, 100); // one miss
    await chatJsonWithin({ user: "x" }, { ...DS, domino: [GPT, CLAUDE] }, 100); // two: it rests
    await chatJsonWithin({ user: "x" }, { ...DS, domino: [GPT, CLAUDE] }, 100);
    assert.deepEqual(calls, ["gpt", "claude", "gpt", "gpt", "claude", "gpt", "claude", "claude"]);
  } finally { restore(); resetDomino(); }
});

test("the domino: what reaches a server is its own words, and the answer is hung up on once someone won", async () => {
  resetDomino();
  const bodies: Record<string, any> = {};
  let claudeHungUp = false;
  const restore = withFetch((url, init) => {
    bodies[who(url)] = JSON.parse(init.body);
    if (who(url) === "gpt") return later(150, '{"who":"gpt"}');
    return new Promise((_ok, no) => init.signal.addEventListener("abort", () => { claudeHungUp = true; no(new Error("aborted")); }));
  });
  try {
    await chatJsonWithin({ system: "s", user: "u" }, { ...DS, domino: [GPT, CLAUDE] }, 500);
    assert.equal(bodies.gpt.reasoning_effort, "low");
    assert.equal(bodies.gpt.model, "gpt");
    assert.equal(bodies.claude.effort, "low");
    assert.equal(bodies.claude.model, "claude-sonnet-5-5");
    assert.deepEqual(bodies.claude.messages, [{ role: "system", content: "s" }, { role: "user", content: "u" }]);
    assert.equal(claudeHungUp, true);
  } finally { restore(); resetDomino(); }
});

test("the door is opened with a pass written here, never with a key of the servers", async () => {
  resetDomino();
  const seen: any[] = [];
  const realDeno = (globalThis as any).Deno;
  const vars: Record<string, string> = { SUPABASE_URL: "https://here.test/", SUPABASE_SERVICE_ROLE_KEY: "service", SUPABASE_ANON_KEY: "public" };
  (globalThis as any).Deno = { env: { get: (k: string) => vars[k] } };
  const restore = withFetch(async (url, init) => {
    seen.push({ url, headers: init.headers, body: init.body });
    if (url.includes("mechabetics_domino_passes")) return new Response(null, { status: 201 });
    return new Response(completion('{"who":"gpt"}'), { status: 200 });
  });
  try {
    assert.deepEqual(dominoFrom({}).map((l) => l.name), ["gpt", "claude"]);
    assert.equal(await chatJsonWithin({ user: "x" }, DS, 500), '{"who":"gpt"}');
    assert.equal(seen[0].url, "https://here.test/rest/v1/mechabetics_domino_passes");
    assert.equal(seen[0].headers.apikey, "service");
    const pass = JSON.parse(seen[0].body).pass;
    assert.match(pass, /^[0-9a-f-]{36}$/);
    assert.ok(seen[1].url.includes("mechabetics-domino?link=gpt"), seen[1].url);
    assert.equal(seen[1].headers["x-domino-pass"], pass);
    assert.equal(seen[1].headers["x-domino-key"], "public");
    assert.ok(!JSON.stringify(seen[1]).includes("service"), "the door must not receive this project's service key");
  } finally {
    restore();
    resetDomino();
    (globalThis as any).Deno = realDeno;
  }
});

test("a pass that cannot be written leaves DeepSeek to answer", async () => {
  resetDomino();
  const realDeno = (globalThis as any).Deno;
  const vars: Record<string, string> = { SUPABASE_URL: "https://here.test", SUPABASE_SERVICE_ROLE_KEY: "service", SUPABASE_ANON_KEY: "public" };
  (globalThis as any).Deno = { env: { get: (k: string) => vars[k] } };
  const calls: string[] = [];
  const restore = withFetch(async (url) => {
    calls.push(url.includes("deepseek") ? "deepseek" : url.includes("domino_passes") ? "pass" : "door");
    if (url.includes("domino_passes")) return new Response("relation does not exist", { status: 404 });
    return deepseekOk('{"who":"deepseek"}');
  });
  try {
    assert.equal(await chatJsonWithin({ user: "x" }, DS, 500), '{"who":"deepseek"}');
    assert.deepEqual(calls, ["pass", "pass", "deepseek"]);
  } finally {
    restore();
    resetDomino();
    (globalThis as any).Deno = realDeno;
  }
});
