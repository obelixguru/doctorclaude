// The edge functions, run for real end to end against an in-memory database and fake model APIs.
//
//   deno test -A --no-lock --import-map=supabase/tests/import_map.json supabase/tests/pipeline.test.ts
//
// The unit tests prove the decision. These prove the plumbing around it: that the analysis, the voice,
// the photo and the meals screen really do reach it, write what they should, and survive the model
// being down.

// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals, assertMatch, assertStringIncludes } from "jsr:@std/assert@1";
import { resetWorld, world } from "./fake_db.ts";
import { fitForecastModel } from "../functions/_shared/forecast.ts";

const SUBJECT = "a".repeat(64);
const OTHER = "b".repeat(64);
const iso = (ms: number) => new Date(ms).toISOString();
const ago = (m: number) => Date.now() - m * 60000;

Deno.env.set("SUPABASE_URL", "https://example.test");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "service");
Deno.env.set("MECHABETICS_DEEPSEEK_API_KEY", "ds");
Deno.env.set("MECHABETICS_GEMINI_API_KEY", "gem");
Deno.env.set("MECHABETICS_LLU_EMAIL", "follower@example.test");
Deno.env.set("MECHABETICS_LLU_PASSWORD", "test-only");
Deno.env.set("MECHABETICS_TELEGRAM_BOT_TOKEN", "test-only");
Deno.env.set("MECHABETICS_TELEGRAM_CHAT_ID", "1");

// Each function registers its handler with Deno.serve when imported.
let captured: ((r: Request) => Promise<Response>) | null = null;
(Deno as any).serve = (h: any) => { captured = h; return {} as any; };
async function load(name: string) {
  await import(`../functions/${name}/index.ts`);
  const h = captured!;
  return async (body: unknown) => {
    const res = await h(new Request("https://x.test/" + name, { method: "POST", body: JSON.stringify(body) }));
    return await res.json();
  };
}
const coach = await load("mechabetics-coach");
const ask = await load("mechabetics-ask");
const scan = await load("mechabetics-scan");
const meals = await load("mechabetics-meals");
const history = await load("mechabetics-history");
const profile = await load("mechabetics-profile");
const learn = await load("mechabetics-learn");
await import("../functions/mechabetics-monitor/index.ts");
const monitorHandler = captured!;
/** One cron run. Answers in plain text, unlike the others. */
const monitorRun = async () => await (await monitorHandler(new Request("https://x.test/mechabetics-monitor", { method: "POST" }))).text();

// ---- Model APIs -----------------------------------------------------------------------------------
const llm = {
  reply: {} as any, down: false, prompts: [] as string[], learnCalls: 0, visionCarbs: null as number | null, visionDesc: "riz",
  /** Google refuses the key, as it did on 7 November. */
  visionRefused: false,
  /** What each of the family's servers answers to a photo, and what they were sent. */
  door: {} as Record<string, () => Response>,
  doorAsks: [] as { link: string; body: any }[],
};
/** LibreLinkUp and Telegram, as the monitor sees them. */
const libre = {
  value: 120, at: 0, telegram: [] as string[], telegramDown: false, cdnHangs: false,
  /** A second person followed by the same account, listed first or last. */
  other: null as null | { value: number; first: boolean },
};
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(input?.url ?? input);
  if (url.includes("deepseek")) {
    llm.prompts.push(String(init?.body ?? ""));
    if (llm.down) return new Response("boom", { status: 500 });
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(llm.reply) }, finish_reason: "stop" }] }));
  }
  if (url.includes("mechabetics_domino_passes")) return new Response("", { status: 201 });
  if (url.includes("mechabetics-domino")) {
    const link = new URL(url).searchParams.get("link") ?? "";
    llm.doorAsks.push({ link, body: JSON.parse(String(init?.body ?? "{}")) });
    return llm.door[link]?.() ?? new Response("down", { status: 503 });
  }
  if (url.includes("generativelanguage")) {
    if (llm.visionRefused) {
      return new Response(JSON.stringify({ error: { code: 401, message: "API key not valid. Please pass a valid API key.", status: "UNAUTHENTICATED" } }), { status: 401 });
    }
    const text = JSON.stringify({ reply: "Un riz.", voice: "Un riz.", meal: { description: llm.visionDesc, carbsG: llm.visionCarbs } });
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }] }));
  }
  if (url.includes("mechabetics-learn")) {
    llm.learnCalls++;
    return new Response("{}");
  }
  if (url.includes("/llu/auth/login")) {
    return new Response(JSON.stringify({ data: { authTicket: { token: "t" }, user: { id: "u" } } }));
  }
  if (url.endsWith("/llu/connections")) {
    const ryan = { patientId: "patient-1", firstName: "Ryan" };
    const other = { patientId: "patient-2", firstName: "Mehdi" };
    const list = !libre.other ? [ryan] : libre.other.first ? [other, ryan] : [ryan, other];
    return new Response(JSON.stringify({ data: list }));
  }
  if (url.includes("/graph")) {
    const live = { ValueInMgPerDl: url.includes("patient-2") ? libre.other?.value : libre.value, FactoryTimestamp: iso(libre.at) };
    return new Response(JSON.stringify({ data: { graphData: [], connection: { glucoseMeasurement: live, sensor: { a: 0 } } } }));
  }
  if (libre.cdnHangs && (url.includes("unpkg.com") || url.includes("jsdelivr"))) {
    return await new Promise<Response>((_, no) => init?.signal?.addEventListener("abort", () => no(new Error("timed out"))));
  }
  if (url.includes("api.telegram.org")) {
    if (libre.telegramDown) return new Response("down", { status: 500 });
    libre.telegram.push(JSON.parse(String(init?.body ?? "{}")).text ?? "");
    return new Response("{}");
  }
  return new Response("nope", { status: 503 }); // weather and everything else: unavailable
}) as typeof fetch;
void realFetch;

const RYAN = {
  subject: SUBJECT, age: 11, weight_kg: 40, nickname: "SECRETNAME", carb_ratio: 16, correction_factor: 58,
  target_mgdl: 120, rapid_insulin: "Fiasp", basal_insulin: "Lantus", updated_at: iso(ago(5000)),
};

function seed(value: number, slope = 0, extra: Partial<typeof RYAN> & Record<string, unknown> = {}) {
  resetWorld();
  world.tables.mechabetics_profiles = [{ ...RYAN, ...extra }];
  world.tables.mechabetics_readings = [];
  for (let m = 180; m >= 0; m -= 5) {
    world.tables.mechabetics_readings.push({
      subject: SUBJECT, ts: iso(ago(m)), value_mgdl: Math.round(value - m * slope), source: "monitor", suspect: false,
    });
  }
  world.rpc.mechabetics_stats = () => ({ count_24h: 200, avg_24h: 150, tir_24h: 60, pct_high_24h: 30, pct_low_24h: 10 });
  llm.reply = { summary: "Journée correcte, à surveiller.", voice: "Journée correcte.", reply: "D'accord.", scope: "diabetes", tip: "" };
  llm.down = false;
  llm.prompts = [];
  llm.visionDesc = "riz";
  llm.visionRefused = false;
  llm.door = {};
  llm.doorAsks = [];
}
const phone = (values: number[]) => values.map((v, i) => ({ ts: ago((values.length - 1 - i) * 5), value: v }));
const base = { subject: SUBJECT, lang: "fr", tzOffsetMin: 60, speak: false, premiumVoice: false };
const opts = { sanitizeOps: false, sanitizeResources: false };

Deno.test({
  name: "analysis: a blind dose is conditional, and it says so in the action", ...opts, fn: async () => {
    seed(240);
    const r = await coach({ ...base, readings: phone([238, 239, 240]), force: true });
    assertEquals(r.isError, false);
    assertEquals(r.decision.kind, "dose_if");
    assertEquals(r.decision.units, 1.5);
    assertStringIncludes(r.text, "Action : Si aucune insuline rapide depuis 3 h : fais 1,5 u de Fiasp maintenant.");
    assertStringIncludes(r.actionLine, "Si aucune insuline rapide");
    assert(r.decision.forecast?.points?.length === 2, "the forecast travels with the analysis");
    assertStringIncludes(r.text, "Prévision : Dans 30 min");
    assertEquals(world.tables.mechabetics_coach_log.length, 1);
    assertEquals(world.tables.mechabetics_coach_log[0].decision.kind, "dose_if");
    // Conditional or not, it was put in front of someone: the next look asks what happened.
    assertEquals(world.tables.mechabetics_profiles[0].pending_action.units, 1.5);
  },
});

Deno.test({
  name: "a dose told late reaches the decision on every surface: no question about hours already told", ...opts, fn: async () => {
    seed(240);
    world.tables.mechabetics_insulin = [{ id: 1, subject: SUBJECT, ts: iso(ago(212)), units: 1, kind: "rapid", insulin_name: "Fiasp", created_at: iso(ago(91)) }];
    const c = await coach({ ...base, readings: phone([239, 240]), force: true });
    assertEquals(c.decision.knowledge, "told");
    assertEquals(c.decision.kind, "dose");
    assert(!c.text.includes("depuis 3 h"), c.text);
    llm.reply = said({});
    const v = await ask({ ...base, question: "je fais quoi ?", readings: phone([239, 240]) });
    assertEquals(v.decision.knowledge, "told");
    assert(!v.text.includes("Si aucune insuline rapide"), v.text);
    const m = await meals({ action: "plan", subject: SUBJECT, lang: "fr", tzOffsetMin: 60, meal: { description: "riz", carbsG: 60 } });
    assertEquals(m.decision.knowledge, "told");
    assert(!m.actionLine.includes("depuis 3 h"), m.actionLine);
    llm.visionCarbs = 60;
    const s = await scan({ ...base, imageBase64: "AAAA", mime: "image/jpeg", readings: phone([239, 240]) });
    assert(!s.text.includes("depuis 3 h"), s.text);
    // Three hours after the telling, the question is back.
    world.tables.mechabetics_meals = [];
    world.tables.mechabetics_insulin[0].ts = iso(ago(300));
    world.tables.mechabetics_insulin[0].created_at = iso(ago(181));
    world.tables.mechabetics_profiles[0].pending_action = null;
    const later = await coach({ ...base, readings: phone([239, 240]), force: true });
    assertEquals(later.decision.knowledge, "unknown");
    assertEquals(later.decision.kind, "dose_if");
  },
});

Deno.test({
  name: "a dose named on a late telling stays as open as a conditional one", ...opts, fn: async () => {
    seed(240);
    world.tables.mechabetics_insulin = [{ id: 1, subject: SUBJECT, ts: iso(ago(212)), units: 1, kind: "rapid", insulin_name: "Fiasp", created_at: iso(ago(91)) }];
    const c = await coach({ ...base, readings: phone([239, 240]), force: true });
    assertEquals(c.decision.kind, "dose");
    // Ignored, it does not hold every other dose back for four hours.
    assertEquals(world.tables.mechabetics_profiles[0].pending_action.conditional, true);
    // And a dose told just after it answers it, even from before it was named.
    await meals({ action: "addInsulin", subject: SUBJECT, insulin: { units: 1, name: "Fiasp", ts: ago(27) } });
    const next = await coach({ ...base, readings: phone([239, 240]), force: true });
    assertEquals(next.decision.pending, null);
  },
});

Deno.test({
  name: "a dose on record in the window is named firm, and stays firm", ...opts, fn: async () => {
    seed(240);
    world.tables.mechabetics_insulin = [{ id: 1, subject: SUBJECT, ts: iso(ago(170)), units: 1, kind: "rapid", insulin_name: "Fiasp", created_at: iso(ago(170)) }];
    const c = await coach({ ...base, readings: phone([239, 240]), force: true });
    assertEquals(c.decision.knowledge, "logged");
    assertEquals(c.decision.kind, "dose");
    assertEquals(world.tables.mechabetics_profiles[0].pending_action.conditional, false);
  },
});

Deno.test({
  name: "a dose dictated a shade over 3 h ago gets the same answer from the voice and the analysis", ...opts, fn: async () => {
    seed(240);
    llm.reply = said({ insulin: { units: 1, name: "Fiasp", minutesAgo: 183 } });
    const v = await ask({ ...base, question: "il a fait 1 u il y a 3 h", readings: phone([239, 240]) });
    assertEquals(v.decision.knowledge, "told");
    assertEquals(v.decision.kind, "dose");
    const c = await coach({ ...base, readings: phone([239, 240]), force: true });
    assertEquals(c.decision.knowledge, "told");
    assertEquals(c.decision.kind, "dose");
  },
});

/** The servers open their answer with keepalives and progress, then the completion on its own line. */
const serverAnswer = (o: Record<string, unknown>) => () => new Response(
  ` REASON{"kind":"progress","text":"..."}\n${JSON.stringify({ choices: [{ message: { content: "```json\n" + JSON.stringify(o) + "\n```" } }] })}`,
);
const plate = { reply: "Des pâtes au poulet.", voice: "Des pâtes au poulet.", meal: { description: "pâtes au poulet", carbsG: 70, planned: false } };
/** The door opens only where the keys are, as in an edge function. Everything else here runs without it. */
const withDoor = async (run: () => Promise<void>) => {
  Deno.env.set("SUPABASE_ANON_KEY", "anon");
  try { await run(); } finally { Deno.env.delete("SUPABASE_ANON_KEY"); }
};

Deno.test({
  name: "a photo survives a refused key: the family's servers read it and the plate is logged", ...opts, fn: () => withDoor(async () => {
    seed(150);
    llm.visionRefused = true;
    llm.door = { gpt: serverAnswer(plate) };
    const s = await scan({ ...base, imageBase64: "AAAA", mime: "image/jpeg", readings: phone([149, 150]) });
    assertEquals(s.isError, false);
    assertEquals(world.tables.mechabetics_meals.length, 1);
    assertEquals(world.tables.mechabetics_meals[0].carbs_g, 70);
    assertEquals(world.tables.mechabetics_meals[0].carbs_estimated, true);
    assertStringIncludes(s.text, "Des pâtes au poulet.");
    // The picture itself went through, in the form both servers read.
    const content = llm.doorAsks[0].body.messages[1].content;
    assertEquals(content[1], { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "AAAA" } });
  }),
});

Deno.test({
  name: "one server down is not a lost photo", ...opts, fn: () => withDoor(async () => {
    seed(150);
    llm.visionRefused = true;
    llm.door = { claude: serverAnswer(plate) };
    const s = await scan({ ...base, imageBase64: "AAAA", mime: "image/jpeg", readings: phone([149, 150]) });
    assertEquals(s.isError, false);
    assertEquals(world.tables.mechabetics_meals.length, 1);
  }),
});

Deno.test({
  name: "a key that works keeps the photos on it, and the family's servers are left alone", ...opts, fn: () => withDoor(async () => {
    seed(150);
    llm.visionCarbs = 60;
    await scan({ ...base, imageBase64: "AAAA", mime: "image/jpeg", readings: phone([149, 150]) });
    assertEquals(llm.doorAsks.length, 0);
    assertEquals(world.tables.mechabetics_meals[0].carbs_g, 60);
  }),
});

Deno.test({
  name: "when nobody can read the photo it says so, says why, and logs nothing", ...opts, fn: () => withDoor(async () => {
    seed(150);
    llm.visionRefused = true;
    llm.door = { gpt: serverAnswer({}), claude: () => new Response("plan out of credits", { status: 402 }) };
    const s = await scan({ ...base, imageBase64: "AAAA", mime: "image/jpeg", readings: phone([149, 150]) });
    assertEquals(s.isError, true);
    assertEquals(s.errorKind, "auth");
    assertStringIncludes(s.text, "Problème de configuration de l'IA");
    assertEquals(world.tables.mechabetics_meals?.length ?? 0, 0);
  }),
});

Deno.test({
  name: "the prompt carries no first name, and gives the model the curve and the unknown", ...opts, fn: async () => {
    seed(150);
    await coach({ ...base, readings: phone([149, 150]), force: true });
    const p = llm.prompts.join(" ");
    assert(!p.includes("SECRETNAME"), "the first name must not reach the model");
    assertStringIncludes(p, "COURBE (heure locale");
    assertStringIncludes(p, "INCONNUE");
  },
});

Deno.test({
  name: "one tap on « rien depuis 3 h » makes the dose firm, and the dose is remembered", ...opts, fn: async () => {
    seed(240);
    assertEquals((await meals({ action: "confirmNoInsulin", subject: SUBJECT })).ok, true);
    const r = await coach({ ...base, readings: phone([239, 240]), force: true });
    assertEquals(r.decision.kind, "dose");
    assertStringIncludes(r.text, "Action : Fais 1,5 u de Fiasp maintenant.");
    const pending = world.tables.mechabetics_profiles[0].pending_action;
    assertEquals(pending.units, 1.5);
    assertEquals(pending.insulin, "Fiasp");
  },
});

Deno.test({
  name: "a named dose must be answered before another is named, on any surface", ...opts, fn: async () => {
    seed(240, 0, {
      no_insulin_confirmed_at: iso(ago(20)),
      pending_action: { units: 2, at: ago(15), insulin: "Fiasp" },
    });
    const c = await coach({ ...base, readings: phone([239, 240]), force: true });
    assertEquals(c.decision.kind, "ask_done");
    assertEquals(c.decision.units, 0);
    assertEquals(c.decision.pending.units, 2);
    assertMatch(c.text, /Les 2 u de Fiasp proposées à \d\d:\d\d ont-elles été faites/);
    const v = await ask({ ...base, question: "je fais quoi ?", readings: phone([239, 240]) });
    assertEquals(v.decision.kind, "ask_done");
    assertEquals(v.actionLine, c.actionLine);
    // Answering closes it.
    await meals({ action: "doseNotDone", subject: SUBJECT });
    assertEquals(world.tables.mechabetics_profiles[0].pending_action, null);
  },
});

Deno.test({
  name: "the voice gives the analysis' action, word for word, even in range", ...opts, fn: async () => {
    seed(120);
    const a = await coach({ ...base, readings: phone([120, 120]), force: true });
    const v = await ask({ ...base, question: "ça va ?", readings: phone([120, 120]) });
    assert(a.actionLine.length > 0);
    assertEquals(v.actionLine, a.actionLine);
    assertStringIncludes(v.text, `Action : ${a.actionLine}`);
  },
});

Deno.test({
  name: "the voice has a memory: its answers are written, and the next question sees them", ...opts, fn: async () => {
    seed(120);
    await coach({ ...base, readings: phone([120, 120]), force: true });
    await ask({ ...base, question: "3u c'est ce qu'il a fait ?", readings: phone([120, 120]) });
    assertEquals(world.tables.mechabetics_voice_log.length, 1);
    assertEquals(world.tables.mechabetics_voice_log[0].question, "3u c'est ce qu'il a fait ?");
    llm.prompts = [];
    await ask({ ...base, question: "et donc ?", readings: phone([120, 120]) });
    const p = llm.prompts.join(" ");
    assertStringIncludes(p, "3u c'est ce qu'il a fait ?");
    assertStringIncludes(p, "DERNIÈRE ANALYSE");
    assertStringIncludes(p, "À FAIRE");
    const h = await history({ subject: SUBJECT, days: 1 });
    assertEquals(h.voice.length, 2);
  },
});

Deno.test({
  name: "a dose said aloud is logged and counted in the very same answer", ...opts, fn: async () => {
    seed(240, 0, { no_insulin_confirmed_at: iso(ago(5)) });
    llm.reply = { reply: "Noté.", voice: "Noté.", scope: "diabetes", insulin: { units: 2, name: "Fiasp", minutesAgo: 0 } };
    const v = await ask({ ...base, question: "il a fait 2 u", readings: phone([239, 240]) });
    assertEquals(world.tables.mechabetics_insulin.length, 1);
    assertEquals(world.tables.mechabetics_insulin[0].units, 2);
    assertEquals(v.decision.units, 0);
    assertEquals(v.decision.knowledge, "logged");
  },
});

Deno.test({
  name: "« rien depuis ce midi » said aloud counts as the confirmation", ...opts, fn: async () => {
    seed(240);
    llm.reply = { reply: "D'accord.", voice: "D'accord.", scope: "diabetes", noRecentInsulin: true };
    const v = await ask({ ...base, question: "il n'a rien fait depuis midi", readings: phone([239, 240]) });
    assertEquals(v.decision.kind, "dose");
    assert(world.tables.mechabetics_profiles[0].no_insulin_confirmed_at);
  },
});

Deno.test({
  name: "a meal said aloud gets the same dose as the same meal on the meals screen", ...opts, fn: async () => {
    seed(150, 0, { no_insulin_confirmed_at: iso(ago(5)) });
    llm.reply = { reply: "Bon appétit.", voice: "Bon appétit.", scope: "diabetes", meal: { description: "riz", carbsG: 48, planned: false, basis: "stated", minutesAgo: 0 } };
    const v = await ask({ ...base, question: "il mange 48 g de riz", readings: phone([149, 150]) });
    seed(150, 0, { no_insulin_confirmed_at: iso(ago(5)) });
    const m = await meals({ action: "plan", subject: SUBJECT, lang: "fr", meal: { description: "riz", carbsG: 48, quantity: 1 } });
    assertEquals(v.decision.units, 1.5);
    assertEquals(m.decision.units, 1.5);
    assertEquals(v.decision.kind, m.decision.kind);
    assertStringIncludes(m.planLine, "fais 1,5 u de Fiasp");
  },
});

Deno.test({
  name: "photo: same decision, and the plate is logged", ...opts, fn: async () => {
    seed(150, 0, { no_insulin_confirmed_at: iso(ago(5)) });
    llm.visionCarbs = 48;
    const s = await scan({ ...base, imageBase64: "AAAA", mime: "image/jpeg", readings: phone([149, 150]) });
    assertEquals(s.isError, false);
    assertEquals(s.decision.units, 1.5);
    assertEquals(s.decision.kind, "dose");
    assertStringIncludes(s.text, "fais 1,5 u de Fiasp");
    assertEquals(world.tables.mechabetics_meals.length, 1);
    assertEquals(world.tables.mechabetics_profiles[0].pending_action.units, 1.5);
  },
});

Deno.test({
  name: "the model down: the decision still answers, on analysis and voice", ...opts, fn: async () => {
    seed(240);
    llm.down = true;
    const c = await coach({ ...base, readings: phone([239, 240]), force: true });
    assertEquals(c.isError, true);
    assertStringIncludes(c.text, "Si aucune insuline rapide depuis 3 h");
    assertEquals(c.decision.kind, "dose_if");
    const v = await ask({ ...base, question: "je fais quoi ?", readings: phone([239, 240]) });
    assertEquals(v.isError, true);
    assertStringIncludes(v.text, "Si aucune insuline rapide depuis 3 h");
  },
});

Deno.test({
  name: "a phone carrying the other person's readings changes nothing and stores nothing", ...opts, fn: async () => {
    seed(140);
    const before = world.tables.mechabetics_readings.length;
    const wrong = [{ ts: ago(1), value: 67 }, { ts: ago(2), value: 67 }];
    const r = await coach({ ...base, readings: wrong, force: true });
    assertEquals(world.tables.mechabetics_readings.length, before);
    assertEquals(r.decision.kind, "fine");
    assert(world.tables.mechabetics_coach_log[0].glucose_at_time === 140);
  },
});

Deno.test({
  name: "a suspect row is out of the analysis and out of the graph", ...opts, fn: async () => {
    seed(140);
    world.tables.mechabetics_readings.push({ subject: SUBJECT, ts: iso(ago(1)), value_mgdl: 55, source: null, suspect: true });
    const r = await coach({ ...base, readings: [], force: true });
    assertEquals(world.tables.mechabetics_coach_log[0].glucose_at_time, 140);
    assert(r.decision.kind !== "sugar");
    const h = await history({ subject: SUBJECT, days: 1 });
    assert(!h.readings.some((x: any) => x.value === 55));
  },
});

Deno.test({
  name: "the analysis asks for a refit in the background, and once a day at most", ...opts, fn: async () => {
    seed(140);
    llm.learnCalls = 0;
    await coach({ ...base, readings: phone([139, 140]), force: true });
    await new Promise((r) => setTimeout(r, 20));
    assertEquals(llm.learnCalls, 1);
    world.tables.mechabetics_models = [{ subject: SUBJECT, model: {}, fitted_at: iso(ago(60)) }];
    llm.learnCalls = 0;
    await coach({ ...base, readings: phone([139, 140]), force: true });
    await new Promise((r) => setTimeout(r, 20));
    assertEquals(llm.learnCalls, 0);
  },
});

Deno.test({
  name: "learning: months of readings become a model the analysis then uses", ...opts, fn: async () => {
    seed(140);
    const series: [number, number][] = [];
    const now = Math.floor(Date.now() / 1000);
    for (let t = now - 30 * 86400; t <= now; t += 300) {
      const h = ((t / 3600) + 1) % 24;
      series.push([t, Math.round(120 + 60 * Math.exp(-(((h - 13) / 1.5) ** 2)) + 10 * Math.sin(t / 2000))]);
    }
    world.rpc.mechabetics_series5 = () => series;
    const r = await learn({ subject: SUBJECT, tzOffsetMin: 60 });
    assertEquals(r.fitted, true);
    assertEquals(world.tables.mechabetics_models.length, 1);
    const c = await coach({ ...base, readings: phone([139, 140]), force: true });
    assertEquals(c.decision.forecast.source, "learned");
    assert(c.decision.forecast.lowRisk60 != null);
  },
});

Deno.test({
  name: "changing the background insulin is dated, retyping it is not, and the analysis says so", ...opts, fn: async () => {
    seed(120);
    await profile({ subject: SUBJECT, action: "save", profile: { basal_insulin: "lantus " } });
    assertEquals(world.tables.mechabetics_profiles[0].basal_changed_at ?? null, null);
    await profile({ subject: SUBJECT, action: "save", profile: { basal_insulin: "Tresiba" } });
    assert(world.tables.mechabetics_profiles[0].basal_changed_at, "the change is dated");
    const c = await coach({ ...base, readings: phone([119, 120]), force: true });
    assertStringIncludes(c.text, "Nouvelle insuline lente (Tresiba)");
  },
});

Deno.test({
  name: "another person's record is left alone", ...opts, fn: async () => {
    seed(240);
    world.tables.mechabetics_profiles.push({ ...RYAN, subject: OTHER });
    await meals({ action: "confirmNoInsulin", subject: SUBJECT });
    assertEquals(world.tables.mechabetics_profiles[1].no_insulin_confirmed_at, undefined);
  },
});

// ---- What the independent safety review found -----------------------------------------------------
const firm = { no_insulin_confirmed_at: iso(ago(5)) };
const said = (o: Record<string, unknown>) => ({ reply: "Noté.", voice: "Noté.", scope: "diabetes", ...o });

Deno.test({
  name: "at 60 with 3 u just given, the action is the sugar, in grams", ...opts, fn: async () => {
    seed(60, 0, firm);
    llm.reply = said({ insulin: { units: 3, name: "Fiasp", minutesAgo: 0 } });
    const v = await ask({ ...base, question: "il vient de faire 3 u", readings: phone([60, 60]) });
    assertEquals(v.decision.kind, "sugar");
    assertStringIncludes(v.actionLine, `${v.decision.sugarGrams} g de sucre`);
  },
});

Deno.test({
  name: "over-reported: sentence, payload and memory agree that nothing more is due", ...opts, fn: async () => {
    seed(150, 0, firm);
    llm.reply = said({ insulin: { units: 6, name: "Fiasp", minutesAgo: 0 } });
    const v = await ask({ ...base, question: "il a fait 6 u", readings: phone([150, 150]) });
    assertStringIncludes(v.actionLine, "Aucune insuline en plus");
    assertEquals(v.decision.kind, "hold");
    assertEquals(v.decision.units, 0);
    assertEquals(world.tables.mechabetics_profiles[0].pending_action, undefined);
  },
});

Deno.test({
  name: "« il a fait 3 u » with 120 g logged is a dose short of the meal, not one too many", ...opts, fn: async () => {
    seed(150, 0, firm);
    world.tables.mechabetics_meals = [{ id: 1, subject: SUBJECT, ts: iso(ago(2)), description: "riz", carbs_g: 120, planned: false, created_at: iso(ago(2)) }];
    llm.reply = said({ insulin: { units: 3, name: "Fiasp", minutesAgo: 0 } });
    const v = await ask({ ...base, question: "il a fait 3 u", readings: phone([150, 150]) });
    assert(!v.actionLine.includes("Aucune insuline en plus"), v.actionLine);
  },
});

Deno.test({
  name: "a dose announced for later is stored ahead and stops the next dose", ...opts, fn: async () => {
    seed(250, 0, firm);
    llm.reply = said({ insulin: { units: 3, name: "Fiasp", minutesAgo: -30 } });
    const v = await ask({ ...base, question: "je ferai 3 u dans une demi-heure", readings: phone([250, 250]) });
    assertEquals(v.decision.units, 0);
    assert(new Date(world.tables.mechabetics_insulin[0].ts).getTime() > Date.now());
  },
});

Deno.test({
  name: "a background insulin said aloud is stored as one, and the meal still gets its dose", ...opts, fn: async () => {
    seed(120, 0, firm);
    llm.reply = said({ insulin: { units: 14, name: "Lantus", minutesAgo: 0 } });
    await ask({ ...base, question: "il a fait 14 u de lantus", readings: phone([120, 120]) });
    assertEquals(world.tables.mechabetics_insulin[0].kind, "basal");
    llm.reply = said({ meal: { description: "riz", carbsG: 56, planned: false, basis: "stated", minutesAgo: 0 } });
    const v = await ask({ ...base, question: "il mange 56 g de riz", readings: phone([120, 120]) });
    assertEquals(v.decision.units, 1);
    llm.reply = said({ insulin: { units: 10, name: "ma lente", minutesAgo: 0 } });
    await ask({ ...base, question: "il a fait 10 u de sa lente", readings: phone([120, 120]) });
    assertEquals(world.tables.mechabetics_insulin[1].kind, "basal");
    assertEquals(world.tables.mechabetics_insulin[1].insulin_name, "Lantus");
  },
});

Deno.test({
  name: "a dose logged since the last analysis ends the replay", ...opts, fn: async () => {
    seed(240, 0, firm);
    const first = await coach({ ...base, readings: phone([239, 240]), force: true });
    assertEquals(first.decision.kind, "dose");
    await meals({ action: "addInsulin", subject: SUBJECT, insulin: { units: 2, name: "Fiasp" } });
    world.tables.mechabetics_insulin[0].created_at = iso(Date.now() + 1000);
    const next = await coach({ ...base, readings: phone([239, 240]) });
    assert(!next.cached, "not the cached report");
    assertEquals(next.decision.units, 0);
  },
});

Deno.test({
  name: "said after it was logged, a meal or a dose is not written twice", ...opts, fn: async () => {
    seed(150, 0, firm);
    world.tables.mechabetics_meals = [{ id: 1, subject: SUBJECT, ts: iso(ago(3)), description: "pâtes carbonara", carbs_g: 64, planned: false, created_at: iso(ago(3)) }];
    world.tables.mechabetics_insulin = [{ id: 1, subject: SUBJECT, ts: iso(ago(3)), units: 4, kind: "rapid", insulin_name: "Fiasp", created_at: iso(ago(3)) }];
    llm.reply = said({
      meal: { description: "des pâtes", carbsG: 60, planned: false, basis: "stated", minutesAgo: 3 },
      insulin: { units: 4, name: "Fiasp", minutesAgo: 3 },
    });
    const v = await ask({ ...base, question: "il a mangé des pâtes et fait 4 u", readings: phone([150, 150]) });
    assertEquals(world.tables.mechabetics_meals.length, 1);
    assertEquals(world.tables.mechabetics_insulin.length, 1);
    assert(!v.actionLine.includes("Aucune insuline en plus"), "already on record, not an excess");
  },
});

Deno.test({
  name: "a guess at the carbs is said on condition", ...opts, fn: async () => {
    seed(150, 0, firm);
    llm.reply = said({ meal: { description: "pizza", carbsG: 120, planned: false, basis: "estimated", minutesAgo: 0 } });
    const v = await ask({ ...base, question: "il mange de la pizza", readings: phone([150, 150]) });
    assertMatch(v.actionLine, /^Si c'est bien ~120 g de glucides : fais/);
  },
});

Deno.test({
  name: "« dans 3 minutes » is a meal coming, not a meal nobody can see", ...opts, fn: async () => {
    seed(150, 0, firm);
    llm.reply = said({ meal: { description: "riz", carbsG: 48, planned: true, basis: "stated", minutesAgo: -3 } });
    const v = await ask({ ...base, question: "il mange dans 3 minutes", readings: phone([150, 150]) });
    assertEquals(world.tables.mechabetics_meals[0].planned, true);
    assertEquals(v.decision.kind, "dose_later");
    assertEquals(v.decision.laterUnits, 1.5);
  },
});

Deno.test({
  name: "« rien depuis 3 h » counts when it was said, not when only the model says so", ...opts, fn: async () => {
    seed(240);
    llm.reply = { reply: "La capitale est Paris.", voice: "Paris.", scope: "general", noRecentInsulin: true };
    await ask({ ...base, question: "quelle est la capitale de la France ?", readings: phone([239, 240]) });
    assertEquals(world.tables.mechabetics_profiles[0].no_insulin_confirmed_at, undefined);
    llm.reply = said({ noRecentInsulin: true });
    await ask({ ...base, question: "je fais quoi maintenant ?", readings: phone([239, 240]) });
    assertEquals(world.tables.mechabetics_profiles[0].no_insulin_confirmed_at, undefined);
  },
});

Deno.test({
  name: "the alarm's own question never becomes a meal", ...opts, fn: async () => {
    seed(62, 0, firm);
    llm.reply = said({ meal: { description: "sucre", carbsG: 15, planned: false, basis: "stated", minutesAgo: 5 } });
    const v = await ask({ ...base, auto: true, question: "Ma glycémie est à 62 mg/dL, mais je viens de prendre du sucre il y a quelques minutes.", readings: phone([62, 62]) });
    assertEquals(world.tables.mechabetics_meals.length, 0);
    assertEquals(v.decision.kind, "sugar");
  },
});

Deno.test({
  name: "a trial run writes nothing, anywhere", ...opts, fn: async () => {
    seed(240, 0, firm);
    llm.reply = said({ insulin: { units: 1, name: "Fiasp", minutesAgo: 0 } });
    const before = world.tables.mechabetics_readings.length;
    const v = await ask({ ...base, defer: true, question: "il a fait 1 u", readings: [{ ts: ago(1), value: 241 }] });
    assertEquals(v.isError, false);
    assertEquals(world.tables.mechabetics_insulin?.length ?? 0, 0);
    assertEquals(world.tables.mechabetics_voice_log?.length ?? 0, 0);
    assertEquals(world.tables.mechabetics_readings.length, before);
    assertEquals(world.tables.mechabetics_profiles[0].pending_action, undefined);
  },
});

Deno.test({
  name: "logging an old dose leaves the question open", ...opts, fn: async () => {
    seed(240, 0, { ...firm, pending_action: { units: 3, at: ago(15), insulin: "Fiasp" } });
    await meals({ action: "addInsulin", subject: SUBJECT, insulin: { units: 2, name: "Fiasp", ts: ago(175) } });
    const c = await coach({ ...base, readings: phone([239, 240]), force: true });
    assertEquals(c.decision.kind, "ask_done");
  },
});

Deno.test({
  name: "the voice tells the app when something went on record", ...opts, fn: async () => {
    seed(150, 0, firm);
    llm.reply = said({ insulin: { units: 1, name: "Fiasp", minutesAgo: 0 } });
    assertEquals((await ask({ ...base, question: "il a fait 1 u", readings: phone([150, 150]) })).logged, true);
    llm.reply = said({});
    assertEquals((await ask({ ...base, question: "ça va ?", readings: phone([150, 150]) })).logged, false);
  },
});

// ---- What the second safety review found -----------------------------------------------------------
const rapid = (units: number, min: number) => ({ subject: SUBJECT, ts: iso(ago(min)), units, insulin_name: "Fiasp", kind: "rapid" });

Deno.test({
  name: "4 u of Lantus does not swallow the 4 u of Fiasp said five minutes later", ...opts, fn: async () => {
    seed(150, 0, firm);
    world.tables.mechabetics_insulin = [{ subject: SUBJECT, ts: iso(ago(5)), units: 4, insulin_name: "Lantus", kind: "basal" }];
    world.tables.mechabetics_meals = [{ subject: SUBJECT, ts: iso(ago(5)), description: "riz", carbs_g: 60, planned: false }];
    llm.reply = said({ insulin: { units: 4, name: "Fiasp", minutesAgo: 0 } });
    const v = await ask({ ...base, question: "j'ai fait 4 u de Fiasp pour le repas", readings: phone([150, 150]) });
    assertEquals(world.tables.mechabetics_insulin.length, 2);
    assertEquals(v.decision.units, 0);
    assertEquals(v.logged, true);
    assert(!v.text.includes("déjà notée"), v.text);
  },
});

Deno.test({
  name: "« refait », it is a second dose, and it counts", ...opts, fn: async () => {
    seed(350, 0, firm);
    world.tables.mechabetics_insulin = [rapid(3, 10)];
    llm.reply = said({ insulin: { units: 3, name: "Fiasp", minutesAgo: 0 } });
    const v = await ask({ ...base, question: "je viens de refaire 3 u", readings: phone([350, 350]) });
    assertEquals(world.tables.mechabetics_insulin.length, 2);
    assertEquals(v.decision.units, 0);
  },
});

Deno.test({
  name: "the same dose said again is not counted twice, and it says so out loud", ...opts, fn: async () => {
    seed(350, 0, firm);
    world.tables.mechabetics_insulin = [rapid(3, 10)];
    llm.reply = said({ insulin: { units: 3, name: "Fiasp", minutesAgo: 0 } });
    const v = await ask({ ...base, question: "il a fait 3 u", readings: phone([350, 350]) });
    assertEquals(world.tables.mechabetics_insulin.length, 1);
    assertEquals(v.logged, false);
    assertStringIncludes(v.text, "Cette dose est déjà notée");
    assertStringIncludes(v.voice, "Cette dose est déjà notée");
  },
});

Deno.test({
  name: "the same plate said again is not counted twice, and it says so out loud; another one is written", ...opts, fn: async () => {
    seed(150, 0, firm);
    world.tables.mechabetics_meals = [{ subject: SUBJECT, ts: iso(ago(5)), description: "riz et poulet", carbs_g: 60, planned: false }];
    llm.reply = said({ meal: { description: "riz et poulet", carbsG: 60, planned: false, basis: "stated", minutesAgo: 0 } });
    const v = await ask({ ...base, question: "il mange du riz et du poulet", readings: phone([150, 150]) });
    assertEquals(world.tables.mechabetics_meals.length, 1);
    assertStringIncludes(v.voice, "Ce repas est déjà noté");
    await ask({ ...base, question: "il reprend du riz et du poulet", readings: phone([150, 150]) });
    assertEquals(world.tables.mechabetics_meals.length, 2);
    await ask({ ...base, question: "encore une part de riz et poulet", readings: phone([150, 150]) });
    world.tables.mechabetics_meals.pop();
    assertEquals(world.tables.mechabetics_meals.length, 2);
    llm.reply = said({ meal: { description: "riz au lait", carbsG: 45, planned: false, basis: "stated", minutesAgo: 0 } });
    const d = await ask({ ...base, question: "et un riz au lait", readings: phone([150, 150]) });
    assertEquals(world.tables.mechabetics_meals.length, 3);
    assert(!d.text.includes("déjà noté"), d.text);
  },
});

Deno.test({
  name: "a dose said aloud cannot answer the question it was counted in", ...opts, fn: async () => {
    seed(260, 0, firm);
    llm.reply = said({ insulin: { units: 1, name: "Fiasp" } });
    const v = await ask({ ...base, question: "j'ai fait 1 u", readings: phone([260, 260]) });
    assertEquals(v.decision.kind, "dose");
    const p = world.tables.mechabetics_profiles[0].pending_action;
    const row = world.tables.mechabetics_insulin[0];
    assertEquals(Date.parse(row.ts), p.knownDoseAt);
    // Twelve minutes later, nothing else on record.
    const shift = 12 * 60000;
    row.ts = iso(Date.parse(row.ts) - shift);
    world.tables.mechabetics_profiles[0].pending_action = { ...p, at: p.at - shift, knownDoseAt: p.knownDoseAt - shift };
    const c = await coach({ ...base, readings: phone([260, 260]), force: true });
    assertEquals(c.decision.kind, "ask_done");
  },
});

Deno.test({
  name: "a dose that could not be written is said out loud, not only on screen", ...opts, fn: async () => {
    seed(150, 0, firm);
    world.failInsert.add("mechabetics_insulin");
    llm.reply = said({
      meal: { description: "gâteau", carbsG: 48, planned: false, basis: "stated", minutesAgo: 0 },
      insulin: { units: 3, name: "Fiasp", minutesAgo: 0 },
    });
    const v = await ask({ ...base, question: "il mange un gâteau et il a fait 3 u", readings: phone([150, 150]) });
    assertEquals(v.logFailed, true);
    assertEquals(v.logged, true); // the meal went in; the app must still keep this answer on screen
    assertStringIncludes(v.text, "Je n'ai PAS pu enregistrer cette dose");
    assertStringIncludes(v.voice, "Je n'ai PAS pu enregistrer cette dose");
    assert(!v.voice.includes("⚠️"), v.voice);
  },
});

Deno.test({
  name: "answering an open question with the dose named is not an excess", ...opts, fn: async () => {
    seed(150, 0, { ...firm, pending_action: { units: 3, at: ago(12), insulin: "Fiasp" } });
    world.tables.mechabetics_meals = [{ subject: SUBJECT, ts: iso(ago(15)), description: "paella", carbs_g: 120, planned: false }];
    llm.reply = said({ insulin: { units: 3, name: "Fiasp", minutesAgo: 12 } });
    const v = await ask({ ...base, question: "oui il a fait les 3 u", readings: phone([150, 150]) });
    assert(!v.actionLine.includes("Aucune insuline en plus"), v.actionLine);
  },
});

Deno.test({
  name: "a guess stays a guess on every surface, and a figure someone typed does not become one", ...opts, fn: async () => {
    seed(150, 0, firm);
    llm.reply = said({ meal: { description: "paella", carbsG: 120, planned: false, basis: "estimated", minutesAgo: 0 } });
    const v = await ask({ ...base, question: "il mange de la paella", readings: phone([150, 150]) });
    assertEquals(world.tables.mechabetics_meals[0].carbs_estimated, true);
    assertMatch(v.actionLine, /^Si c'est bien ~120 g de glucides : fais/);
    const c = await coach({ ...base, readings: phone([150, 150]), force: true });
    assertMatch(c.actionLine, /^Si c'est bien ~120 g de glucides : fais/);

    seed(150, 0, firm);
    llm.visionCarbs = 48;
    const s = await scan({ ...base, imageBase64: "AAAA", mime: "image/jpeg", readings: phone([149, 150]) });
    assertMatch(s.actionLine, /^Si c'est bien ~48 g de glucides : fais/);
    assertEquals(world.tables.mechabetics_meals[0].carbs_estimated, true);

    seed(150, 0, firm);
    const m = await meals({ action: "add", subject: SUBJECT, lang: "fr", meal: { description: "riz", carbsG: 48, quantity: 1 } });
    assertEquals(world.tables.mechabetics_meals[0].carbs_estimated, false);
    assertMatch(m.actionLine, /^Pour ~48 g de glucides[^:]* : fais 1,5 u/);
    const typed = await coach({ ...base, readings: phone([150, 150]), force: true });
    assert(!typed.actionLine.includes("Si c'est bien"), typed.actionLine);
  },
});

Deno.test({
  name: "correcting a guessed figure by hand makes it a figure", ...opts, fn: async () => {
    seed(150, 0, firm);
    world.tables.mechabetics_meals = [{ id: 7, subject: SUBJECT, ts: iso(ago(3)), description: "paella", carbs_g: 120, planned: false, quantity: 1, carbs_estimated: true }];
    await meals({ action: "update", subject: SUBJECT, id: 7, lang: "fr", meal: { description: "paella", carbsG: 90, quantity: 1 } });
    assertEquals(world.tables.mechabetics_meals[0].carbs_estimated, false);
    // Moving it in time says nothing about the figure.
    world.tables.mechabetics_meals[0].carbs_estimated = true;
    await meals({ action: "update", subject: SUBJECT, id: 7, lang: "fr", meal: { description: "paella", quantity: 1 } });
    assertEquals(world.tables.mechabetics_meals[0].carbs_estimated, true);
  },
});

Deno.test({
  name: "a dose in two parts is still in two parts when asked about later", ...opts, fn: async () => {
    seed(170, 0, firm);
    await meals({ action: "add", subject: SUBJECT, lang: "fr", meal: { description: "pizza", carbsG: 15, quantity: 1 } });
    const p = world.tables.mechabetics_profiles[0].pending_action;
    assertEquals(p.split, true);
    world.tables.mechabetics_profiles[0].pending_action = { ...p, at: ago(12) };
    const c = await coach({ ...base, readings: phone([170, 170]), force: true });
    assertEquals(c.decision.pending.split, true);
  },
});

Deno.test({
  name: "a dose held back by the floor: more than it named, said aloud, gets the hypo watch", ...opts, fn: async () => {
    seed(300, 0, firm);
    llm.reply = said({ insulin: { units: 4, minutesAgo: 0 } });
    const v = await ask({ ...base, question: "il a fait 4 u", readings: phone([300, 300]) });
    assert(/surveille une possible hypo/.test(v.actionLine), v.actionLine);
  },
});

Deno.test({
  name: "no advice on how to give a dose nobody named", ...opts, fn: async () => {
    seed(85, 0, firm);
    llm.reply = said({ meal: { description: "pizza", carbsG: 60, planned: false, basis: "stated", minutesAgo: 0 } });
    const v = await ask({ ...base, question: "il mange une pizza", readings: phone([85, 85]) });
    assertEquals(v.decision.units, 0);
    assert(!/en deux fois/.test(v.text), v.text);
    assert(!/en deux fois/.test(v.voice), v.voice);
  },
});

Deno.test({
  name: "a second photo of the same plate is the same plate", ...opts, fn: async () => {
    seed(150, 0, { no_insulin_confirmed_at: iso(ago(5)) });
    llm.visionCarbs = 80;
    llm.visionDesc = "Riz et poulet";
    const a = await scan({ ...base, imageBase64: "AAAA", mime: "image/jpeg", readings: phone([149, 150]) });
    llm.visionCarbs = 78;
    llm.visionDesc = "Assiette de riz au poulet";
    const b = await scan({ ...base, imageBase64: "AAAA", mime: "image/jpeg", readings: phone([149, 150]) });
    llm.visionDesc = "riz";
    assertEquals(world.tables.mechabetics_meals.length, 1);
    assert(b.decision.units <= a.decision.units, `${a.decision.units} ${b.decision.units}`);
    assertStringIncludes(b.text, "déjà noté");
  },
});

Deno.test({
  name: "a bigger plate after a small bite of the same thing is a plate", ...opts, fn: async () => {
    seed(150, 0, { no_insulin_confirmed_at: iso(ago(5)) });
    llm.visionCarbs = 20;
    llm.visionDesc = "Pizza";
    await scan({ ...base, imageBase64: "AAAA", mime: "image/jpeg", readings: phone([149, 150]) });
    llm.visionCarbs = 110;
    await scan({ ...base, imageBase64: "AAAA", mime: "image/jpeg", readings: phone([149, 150]) });
    llm.visionDesc = "riz";
    assertEquals(world.tables.mechabetics_meals.length, 2);
  },
});

Deno.test({
  name: "a second can at a low is a second treatment", ...opts, fn: async () => {
    seed(62, 0, { no_insulin_confirmed_at: iso(ago(5)) });
    llm.visionCarbs = 33;
    llm.visionDesc = "7up";
    await scan({ ...base, imageBase64: "AAAA", mime: "image/jpeg", readings: phone([62, 62]) });
    await scan({ ...base, imageBase64: "AAAA", mime: "image/jpeg", readings: phone([62, 62]) });
    llm.visionDesc = "riz";
    assertEquals(world.tables.mechabetics_meals.length, 2);
  },
});

Deno.test({
  name: "a trial run writes nothing, model or no model", ...opts, fn: async () => {
    seed(240, 0, firm);
    llm.down = true;
    await ask({ ...base, question: "que faire ?", defer: true, premiumVoice: false, readings: phone([240, 240]) });
    llm.down = false;
    assertEquals(world.tables.mechabetics_profiles[0].pending_action ?? null, null);
    assertEquals((world.tables.mechabetics_named_doses ?? []).length, 0);
  },
});

Deno.test({
  name: "the part held back is on record for the second look", ...opts, fn: async () => {
    seed(160, 0, firm);
    await meals({ action: "add", subject: SUBJECT, lang: "fr", meal: { description: "riz", carbsG: 64, quantity: 1 } });
    const held = world.tables.mechabetics_profiles[0].held_back;
    assertEquals(held.total, 4);
    assertEquals(held.carbsG, 64);
  },
});

Deno.test({
  name: "advice about the meal does not follow a hold", ...opts, fn: async () => {
    seed(122, -1.2, firm);
    llm.reply = said({ meal: { description: "pizza", carbsG: 60, planned: false, basis: "stated", minutesAgo: 0 } });
    const v = await ask({ ...base, question: "il mange une pizza", readings: phone([124, 122]) });
    assert(v.decision.capped === true, JSON.stringify(v.decision.units));
    assert(!/en deux fois/.test(v.text), v.text);
  },
});

Deno.test({
  name: "a dose on the screen is remembered, model or no model, and logged for the score", ...opts, fn: async () => {
    seed(240, 0, firm);
    llm.down = true;
    const r = await coach({ ...base, readings: phone([240, 240]), force: true });
    assertEquals(r.isError, true);
    assertEquals(world.tables.mechabetics_profiles[0].pending_action.units, 1.5);
    assertEquals(world.tables.mechabetics_named_doses.length, 1);
    llm.down = false;

    seed(150, 0, firm);
    world.tables.mechabetics_meals = [{ id: 7, subject: SUBJECT, ts: iso(ago(1)), description: "riz", carbs_g: 30, planned: false, quantity: 1 }];
    await meals({ action: "update", subject: SUBJECT, id: 7, lang: "fr", meal: { description: "riz", carbsG: 48, quantity: 1 } });
    assertEquals(world.tables.mechabetics_profiles[0].pending_action.units, 1.5);
  },
});

Deno.test({
  name: "a dose for later is asked about from its own hour", ...opts, fn: async () => {
    seed(150, 0, firm);
    llm.reply = said({ meal: { description: "riz", carbsG: 48, planned: true, basis: "stated", minutesAgo: -40 } });
    const v = await ask({ ...base, question: "il mange dans 40 minutes", readings: phone([150, 150]) });
    assertEquals(v.decision.kind, "dose_later");
    const p = world.tables.mechabetics_profiles[0].pending_action;
    assertEquals(p.units, v.decision.laterUnits);
    assert(p.at > Date.now() + 30 * 60000, "due at the meal, not now");
    const c = await coach({ ...base, readings: phone([150, 150]), force: true });
    assert(c.decision.kind !== "ask_done", "nothing to ask before its hour");
  },
});

Deno.test({
  name: "the same plate pressed twice does not raise the dose", ...opts, fn: async () => {
    seed(150, 0, firm);
    const a = await meals({ action: "add", subject: SUBJECT, lang: "fr", meal: { description: "riz et poulet", carbsG: 80, quantity: 1 } });
    const b = await meals({ action: "add", subject: SUBJECT, lang: "fr", meal: { description: "riz et poulet", carbsG: 80, quantity: 1 } });
    assertEquals(a.decision.units, 2);
    assertEquals(b.plan.totalUnits, 2);
    assertEquals(world.tables.mechabetics_profiles[0].pending_action.units, 2);
  },
});

Deno.test({
  name: "a figure that moves with each look does not restart the clock on « was it done ? »", ...opts, fn: async () => {
    seed(240, 0, { ...firm, pending_action: { units: 1, at: ago(5), insulin: "Fiasp" } });
    await coach({ ...base, readings: phone([240, 240]), force: true });
    const p = world.tables.mechabetics_profiles[0].pending_action;
    assertEquals(p.units, 1.5);
    assert(p.at < ago(4), "the same clock");
  },
});

Deno.test({
  name: "a word about the glucose does not make a covered plate new", ...opts, fn: async () => {
    seed(200, 0, firm);
    world.tables.mechabetics_meals = [{ subject: SUBJECT, ts: iso(ago(10)), description: "pâtes", carbs_g: 60, planned: false }];
    world.tables.mechabetics_insulin = [rapid(4, 10)];
    llm.reply = said({ meal: { description: "pâtes", carbsG: 60, planned: false, basis: "stated", minutesAgo: 10 } });
    const v = await ask({ ...base, question: "il a mangé ses pâtes mais il est encore à 200", readings: phone([200, 200]) });
    assertEquals(world.tables.mechabetics_meals.length, 1);
    assertEquals(v.decision.units, 0);
  },
});

Deno.test({
  name: "a model's guess at the grams does not make a covered plate new", ...opts, fn: async () => {
    seed(200, 0, firm);
    world.tables.mechabetics_meals = [{ subject: SUBJECT, ts: iso(ago(10)), description: "pâtes", carbs_g: 60, planned: false }];
    world.tables.mechabetics_insulin = [rapid(4, 10)];
    llm.reply = said({ meal: { description: "pâtes", carbsG: 80, planned: false, basis: "estimated", minutesAgo: 0 } });
    const v = await ask({ ...base, question: "il a mangé des pâtes", readings: phone([200, 200]) });
    assertEquals(world.tables.mechabetics_meals.length, 1);
    assertEquals(v.decision.units, 0);
  },
});

Deno.test({
  name: "a rapid dose stays rapid when the slow one is only mentioned", ...opts, fn: async () => {
    seed(150, 0, firm);
    world.tables.mechabetics_meals = [{ subject: SUBJECT, ts: iso(ago(5)), description: "riz", carbs_g: 60, planned: false }];
    llm.reply = said({ insulin: { units: 3, name: null, minutesAgo: 0 } });
    await ask({ ...base, question: "il a fait 3 u pour le repas, je ferai sa lente ce soir", readings: phone([150, 150]) });
    assertEquals(world.tables.mechabetics_insulin[0].kind, "rapid");
  },
});

Deno.test({
  name: "a dose announced before does not answer the question about the dose named after it", ...opts, fn: async () => {
    seed(300, 0, firm);
    llm.reply = said({ insulin: { units: 1, name: "Fiasp", minutesAgo: -20 } });
    const v = await ask({ ...base, question: "il fera 1 u dans 20 minutes", readings: phone([300, 300]) });
    assert(v.decision.units > 0, v.actionLine);
    const p = world.tables.mechabetics_profiles[0].pending_action;
    const row = world.tables.mechabetics_insulin[0];
    assertEquals(p.knownDoseAt, Date.parse(row.ts));
    // Twenty-five minutes on: the announced time has passed, nothing else on record.
    const shift = 25 * 60000;
    row.ts = iso(Date.parse(row.ts) - shift);
    world.tables.mechabetics_profiles[0].pending_action = { ...p, at: p.at - shift, knownDoseAt: p.knownDoseAt - shift };
    const c = await coach({ ...base, readings: phone([300, 300]), force: true });
    assertEquals(c.decision.pending?.units, p.units);
  },
});

Deno.test({
  name: "the card that asks is answered by any dose given there, at whatever time", ...opts, fn: async () => {
    seed(240, 0, { ...firm, pending_action: { units: 2, at: ago(5), insulin: "Fiasp" } });
    await meals({ action: "addInsulin", subject: SUBJECT, insulin: { units: 2, name: "Fiasp", kind: "rapid", ts: ago(30), answersQuestion: true } });
    assertEquals(world.tables.mechabetics_profiles[0].pending_action, null);
    // The Insulin tab is not the card: an old dose entered there does not answer anything.
    seed(240, 0, { ...firm, pending_action: { units: 2, at: ago(5), insulin: "Fiasp" } });
    await meals({ action: "addInsulin", subject: SUBJECT, insulin: { units: 2, name: "Fiasp", kind: "rapid", ts: ago(30) } });
    assert(world.tables.mechabetics_profiles[0].pending_action, "still open");
  },
});

Deno.test({
  name: "a figure the preview filled in stays a guess; sent back unchanged it stays what it was", ...opts, fn: async () => {
    seed(150, 0, firm);
    const m = await meals({ action: "add", subject: SUBJECT, lang: "fr", meal: { description: "paella", carbsG: 60, quantity: 1, carbSource: "estimate" } });
    assertEquals(world.tables.mechabetics_meals[0].carbs_estimated, true);
    assertMatch(m.actionLine, /^Si c'est bien ~60 g de glucides/);
    const id = world.tables.mechabetics_meals[0].id;
    await meals({ action: "update", subject: SUBJECT, id, lang: "fr", meal: { description: "paella", carbsG: 60, quantity: 1, ts: ago(5) } });
    assertEquals(world.tables.mechabetics_meals[0].carbs_estimated, true);
  },
});

Deno.test({
  name: "the voice is told a dose in two parts is in two parts", ...opts, fn: async () => {
    seed(150, 0, { ...firm, pending_action: { units: 5, at: ago(12), insulin: "Fiasp", split: true } });
    llm.prompts = [];
    await ask({ ...base, question: "oui", readings: phone([150, 150]) });
    assertStringIncludes(llm.prompts.join(" "), "EN DEUX FOIS");
  },
});

Deno.test({
  name: "a sport that could not be written is said, on screen and aloud", ...opts, fn: async () => {
    seed(150, 0, firm);
    world.failInsert.add("mechabetics_activity");
    llm.reply = said({ activity: { kind: "foot", description: "foot", intensity: "moderate", planned: false, minutesAgo: 0 } });
    const v = await ask({ ...base, question: "il a fait du foot", readings: phone([150, 150]) });
    assertEquals(v.logFailed, true);
    assertStringIncludes(v.text, "Je n'ai pas pu enregistrer cette activité");
    assertStringIncludes(v.voice, "Je n'ai pas pu enregistrer cette activité");
  },
});

Deno.test({
  name: "the voice and the analysis give a juice at 150 the same answer as the photo", ...opts, fn: async () => {
    seed(150, 0, firm);
    llm.visionCarbs = 20;
    llm.visionDesc = "jus d'orange";
    const photo = await scan({ ...base, imageBase64: "AAAA", mime: "image/jpeg", readings: phone([150, 150]) });
    seed(150, 0, firm);
    llm.reply = said({ meal: { description: "jus d'orange", carbsG: 20, planned: false, basis: "estimated", minutesAgo: 0 } });
    const voice = await ask({ ...base, question: "il boit un jus d'orange", readings: phone([150, 150]) });
    const c = await coach({ ...base, readings: phone([150, 150]), force: true });
    assert(photo.decision.units > 0, photo.actionLine);
    assertEquals(voice.decision.units, photo.decision.units);
    assertEquals(c.decision.units, photo.decision.units);
  },
});

Deno.test({
  name: "« 14 u de lente » is a slow insulin even with no name; a slow rise is not", ...opts, fn: async () => {
    seed(150, 0, firm);
    llm.reply = said({ insulin: { units: 14, name: null, minutesAgo: 0 } });
    await ask({ ...base, question: "j'ai fait 14 u de lente", readings: phone([150, 150]) });
    assertEquals(world.tables.mechabetics_insulin[0].kind, "basal");
    seed(150, 0, firm);
    llm.reply = said({ insulin: { units: 2, name: null, minutesAgo: 0 } });
    await ask({ ...base, question: "ça monte de façon lente, j'ai fait 2 u", readings: phone([150, 150]) });
    assertEquals(world.tables.mechabetics_insulin[0].kind, "rapid");
  },
});

Deno.test({
  name: "FAIT pressed twice on a slow network writes one dose; an older dose being entered is another", ...opts, fn: async () => {
    seed(150, 0, firm);
    const dose = { action: "addInsulin", subject: SUBJECT, insulin: { units: 3, name: "Fiasp", kind: "rapid" } };
    assertEquals((await meals(dose)).ok, true);
    assertEquals((await meals(dose)).ok, true);
    assertEquals(world.tables.mechabetics_insulin.length, 1);
    await meals({ ...dose, insulin: { ...dose.insulin, ts: ago(60) } });
    assertEquals(world.tables.mechabetics_insulin.length, 2);
    await meals({ ...dose, insulin: { ...dose.insulin, kind: "basal" } });
    assertEquals(world.tables.mechabetics_insulin.length, 3);
  },
});

Deno.test({
  name: "after a rescue photo, no advice about the next meal's insulin", ...opts, fn: async () => {
    seed(92, 0, firm);
    for (const r of world.tables.mechabetics_readings) {
      const m = (Date.now() - Date.parse(r.ts)) / 60000;
      if (m > 15 && m < 40) r.value_mgdl = 65;
    }
    llm.visionCarbs = 15;
    llm.visionDesc = "7up";
    const s = await scan({ ...base, imageBase64: "AAAA", mime: "image/jpeg", readings: phone([90, 92]) });
    assertEquals(s.decision.units, 0);
    assertMatch(s.actionLine, /^Pas d'insuline pour ça : ça sert à remonter/);
    assert(!/AVANT|prochaine fois/.test(s.text), s.text);
  },
});

// ---- The monitor looks ahead, and that can never cost it the present --------------------------------
const sha = async (s: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))]
  .map((x) => x.toString(16).padStart(2, "0")).join("");
const PATIENT = await sha("patient-1");

/** A real fitted model, with the lowest-value part set to say what the test needs. */
function modelSaying(drop: number) {
  const pts: { ts: number; value: number }[] = [];
  const now = Date.now();
  for (let t = now - 30 * 86400000; t <= now; t += 300000) pts.push({ ts: t, value: Math.round(130 + 30 * Math.sin(t / 5400000)) });
  const m = fitForecastModel(pts, now, 60)!;
  return { ...m, lowest: { ...m.lowest!, w: [...m.lowest!.w.slice(1).map(() => 0), drop], right: 0.5 } };
}

function seedMonitor(value: number, drop: number, extra: Record<string, unknown> = {}) {
  resetWorld();
  libre.value = value;
  libre.at = Date.now() - 30000;
  libre.telegram = [];
  libre.telegramDown = false;
  libre.cdnHangs = false;
  libre.other = null;
  world.tables.mechabetics_profiles = [{ ...RYAN, subject: PATIENT, ...extra }];
  world.tables.mechabetics_monitor_state = [{ subject: PATIENT, last_value: value }];
  world.tables.mechabetics_models = [{ subject: PATIENT, model: modelSaying(drop), fitted_at: iso(ago(60)) }];
  world.tables.mechabetics_readings = [];
  for (let m = 180; m >= 5; m -= 5) {
    world.tables.mechabetics_readings.push({ subject: PATIENT, ts: iso(ago(m)), value_mgdl: value, source: "monitor", suspect: false });
  }
}
const nextRun = (value = libre.value) => { libre.value = value; libre.at = Date.now() - 20000 + world.tables.mechabetics_forecast_log.length * 1000; };

Deno.test({
  name: "monitor: a low on the way is pushed once, then silence for the hour, and every forecast is kept", ...opts, fn: async () => {
    seedMonitor(110, -60);
    assertMatch(await monitorRun(), /Ryan=warn 110/);
    assertEquals(libre.telegram.length, 1);
    assertStringIncludes(libre.telegram[0], "🔮 <b>Ryan : 110 mg/dL, peut passer sous 70 dans l'heure</b>");
    assertStringIncludes(libre.telegram[0], "5 fois sur 10");
    assert(world.tables.mechabetics_monitor_state[0].low_warned_at, "the warning is dated");
    const log = world.tables.mechabetics_forecast_log;
    assertEquals(log.length, 1);
    assertEquals(log[0].warned, true);
    assertEquals(log[0].low_warning, true);
    assertEquals(log[0].source, "learned");
    assertEquals(log[0].value_mgdl, 110);
    assert(log[0].f30 > 0 && log[0].high60 >= log[0].low60, JSON.stringify(log[0]));

    nextRun();
    assertMatch(await monitorRun(), /Ryan=ok 110/);
    assertEquals(libre.telegram.length, 1);
    assertEquals(world.tables.mechabetics_forecast_log.length, 2);
    assertEquals(world.tables.mechabetics_forecast_log[1].warned, false);
    assertEquals(world.tables.mechabetics_forecast_log[1].low_warning, true);

    world.tables.mechabetics_monitor_state[0].low_warned_at = iso(ago(61));
    nextRun();
    assertMatch(await monitorRun(), /Ryan=warn 110/);
    assertEquals(libre.telegram.length, 2);
  },
});

Deno.test({
  name: "monitor: nothing coming, nothing sent, and the forecast is still kept", ...opts, fn: async () => {
    seedMonitor(130, 0);
    assertMatch(await monitorRun(), /Ryan=ok 130/);
    assertEquals(libre.telegram.length, 0);
    assertEquals(world.tables.mechabetics_forecast_log.length, 1);
    assertEquals(world.tables.mechabetics_forecast_log[0].warned, false);
  },
});

Deno.test({
  name: "monitor: a real alert goes out alone, the forecast does not pile on", ...opts, fn: async () => {
    seedMonitor(100, -60);
    world.tables.mechabetics_monitor_state[0].last_value = 100;
    libre.value = 55;
    assertMatch(await monitorRun(), /Ryan=alert 55/);
    assertEquals(libre.telegram.length, 1);
    assert(!libre.telegram[0].includes("🔮"), libre.telegram[0]);
    assertEquals(world.tables.mechabetics_monitor_state[0].low_warned_at, undefined);
    assertEquals(world.tables.mechabetics_forecast_log[0].warned, false);
  },
});

// 7 November: 255 at 10:09, nothing until 143 at 10:27, then 73 at 10:39 and 47 at 10:54, with the phone offline.
function seedFall(points: [number, number][], lastValue: number) {
  seedMonitor(lastValue, 0);
  world.tables.mechabetics_readings = points.map(([m, v]) => ({ subject: PATIENT, ts: iso(ago(m)), value_mgdl: v, source: "monitor", suspect: false }));
}

Deno.test({
  name: "monitor: back in range at full speed says so, not that all is well", ...opts, fn: async () => {
    seedFall([[60, 280], [50, 278], [40, 277], [30, 275], [25, 270], [20, 255]], 255);
    libre.value = 143;
    assertMatch(await monitorRun(), /Ryan=alert 143 \(prev 255\)/);
    assertEquals(libre.telegram.length, 1);
    assertMatch(libre.telegram[0], /143 mg\/dL, ça descend vite/);
    assertMatch(libre.telegram[0], /255 il y a \d+ min/);
    assert(!/normale/.test(libre.telegram[0]), libre.telegram[0]);
  },
});

Deno.test({
  name: "monitor: 143 then 80 through a hole, in range all the way: warned, once, for the hour", ...opts, fn: async () => {
    seedFall([[60, 280], [40, 277], [35, 255], [20, 133], [16, 143], [12, 143]], 143);
    libre.value = 80;
    assertMatch(await monitorRun(), /Ryan=warn 80 \(prev 143\)/);
    assertEquals(libre.telegram.length, 1);
    assertMatch(libre.telegram[0], /80 mg\/dL, ça descend vite/);
    assert(world.tables.mechabetics_monitor_state[0].low_warned_at, "it counts as the hour's warning");
    assertEquals(world.tables.mechabetics_forecast_log.filter((r: any) => r.warned).length, 1);
    nextRun(76);
    assertMatch(await monitorRun(), /Ryan=ok 76/);
    assertEquals(libre.telegram.length, 1);
  },
});

Deno.test({
  name: "monitor: the forecast sees through the hole too, and its own warning comes first", ...opts, fn: async () => {
    seedFall([[60, 280], [40, 277], [35, 255], [20, 133], [16, 143], [12, 143]], 143);
    libre.value = 73;
    assertMatch(await monitorRun(), /Ryan=warn 73 \(prev 143\)/);
    assertEquals(libre.telegram.length, 1);
    assertMatch(libre.telegram[0], /peut passer sous 70 dans l'heure/);
  },
});

Deno.test({
  name: "monitor: readings stop on the way down, and it says it no longer sees", ...opts, fn: async () => {
    seedFall([[30, 190], [27, 180], [24, 172], [21, 165], [18, 158], [15, 150], [12, 142]], 142);
    libre.value = 142;
    libre.at = ago(12);
    assertMatch(await monitorRun(), /Ryan=warn 142/);
    assertEquals(libre.telegram.length, 1);
    assertMatch(libre.telegram[0], /plus de relevé depuis 12 min, et ça descendait vite/);
    assertMatch(libre.telegram[0], /au doigt/);
    // And it is not said again while nothing changes, even past the point where alerts stop.
    libre.at = ago(20);
    assertMatch(await monitorRun(), /Ryan=ok 142/);
    assertEquals(libre.telegram.length, 1);
  },
});

Deno.test({
  name: "monitor: a hole with nothing falling says nothing", ...opts, fn: async () => {
    seedFall([[60, 120], [50, 121], [40, 120], [35, 122], [30, 120], [25, 119], [12, 120]], 120);
    libre.value = 118;
    assertMatch(await monitorRun(), /Ryan=ok 118/);
    assertEquals(libre.telegram.length, 0);
    assertEquals(world.tables.mechabetics_forecast_log.length, 1, "and the forecast goes through it");
  },
});

Deno.test({
  name: "monitor: a fall the sugar already answers stays quiet", ...opts, fn: async () => {
    seedFall([[60, 280], [40, 277], [35, 255], [20, 133], [16, 143], [12, 143]], 143);
    world.tables.mechabetics_meals = [{ subject: PATIENT, ts: iso(ago(5)), description: "3 sucres", carbs_g: 15 }];
    libre.value = 73;
    assertMatch(await monitorRun(), /Ryan=ok 73/);
    assertEquals(libre.telegram.length, 0);
  },
});

Deno.test({
  name: "monitor: at 65, under the line, the alarm has it and the forecast stays quiet", ...opts, fn: async () => {
    seedMonitor(65, -60);
    assertMatch(await monitorRun(), /Ryan=ok 65/);
    assertEquals(libre.telegram.length, 0);
  },
});

Deno.test({
  name: "monitor: sugar just noted, they are on it", ...opts, fn: async () => {
    seedMonitor(90, -60);
    world.tables.mechabetics_meals = [{ subject: PATIENT, ts: iso(ago(5)), description: "3 sucres", carbs_g: 15 }];
    assertMatch(await monitorRun(), /Ryan=ok 90/);
    assertEquals(libre.telegram.length, 0);
    world.tables.mechabetics_meals[0].ts = iso(ago(16));
    nextRun();
    assertMatch(await monitorRun(), /Ryan=warn 90/);
  },
});

Deno.test({
  name: "monitor: the insulin on record stays on the screen, a dose is no reason to push", ...opts, fn: async () => {
    seedMonitor(120, 0);
    world.tables.mechabetics_insulin = [{ subject: PATIENT, ts: iso(ago(10)), units: 4, insulin_name: "Fiasp", kind: "rapid" }];
    assertMatch(await monitorRun(), /Ryan=ok 120/);
    assertEquals(libre.telegram.length, 0);
  },
});

Deno.test({
  name: "monitor: a dose waiting for an answer does not silence the warning", ...opts, fn: async () => {
    seedMonitor(110, -60, { pending_action: { units: 2, at: ago(30), insulin: "Fiasp" } });
    assertMatch(await monitorRun(), /Ryan=warn 110/);
  },
});

Deno.test({
  name: "monitor: everyone's present goes first, whoever is first in the list", ...opts, fn: async () => {
    seedMonitor(110, -60);
    const mehdi = await sha("patient-2");
    world.tables.mechabetics_monitor_state.push({ subject: mehdi, last_value: 100 });
    libre.other = { value: 55, first: false };
    const run = await monitorRun();
    assertMatch(run, /Ryan=warn 110/);
    assertMatch(run, /Mehdi=alert 55/);
    assertEquals(libre.telegram.length, 2);
    assertStringIncludes(libre.telegram[0], "Mehdi");
    assertStringIncludes(libre.telegram[1], "🔮 <b>Ryan");
    assertEquals(world.tables.mechabetics_monitor_state.length, 2);
    assertEquals(world.tables.mechabetics_monitor_state.find((r: any) => r.subject === mehdi).last_value, 55);
    assertEquals(world.tables.mechabetics_monitor_state.find((r: any) => r.subject === PATIENT).last_value, 110);
  },
});

Deno.test({
  name: "monitor: a reading in the table that the sensor contradicts is no base for a warning", ...opts, fn: async () => {
    seedMonitor(140, -60);
    world.tables.mechabetics_readings.push({ subject: PATIENT, ts: iso(Date.now() - 5000), value_mgdl: 71, source: "phone", suspect: false });
    assertMatch(await monitorRun(), /Ryan=ok 140/);
    assertEquals(libre.telegram.length, 0);
    assertEquals((world.tables.mechabetics_forecast_log ?? []).length, 0);
  },
});

Deno.test({
  name: "monitor: the number in the warning is this run's reading", ...opts, fn: async () => {
    seedMonitor(110, -60);
    world.tables.mechabetics_readings.push({ subject: PATIENT, ts: iso(Date.now() - 5000), value_mgdl: 104, source: "phone", suspect: false });
    assertMatch(await monitorRun(), /Ryan=warn 110/);
    assertStringIncludes(libre.telegram[0], "Ryan : 110 mg/dL");
    assertEquals(world.tables.mechabetics_forecast_log[0].value_mgdl, 110);
  },
});

Deno.test({
  name: "monitor: a warning on a reading seen twice is not lost from the record", ...opts, fn: async () => {
    seedMonitor(110, -60);
    world.tables.mechabetics_monitor_state[0].low_warned_at = iso(ago(30));
    assertMatch(await monitorRun(), /Ryan=ok 110/);
    assertEquals(world.tables.mechabetics_forecast_log[0].warned, false);
    world.tables.mechabetics_monitor_state[0].low_warned_at = iso(ago(90));
    assertMatch(await monitorRun(), /Ryan=warn 110/);
    assertEquals(world.tables.mechabetics_forecast_log.length, 1);
    assertEquals(world.tables.mechabetics_forecast_log[0].warned, true);
  },
});

Deno.test({
  name: "monitor: a state row that went missing still gets the date of the warning", ...opts, fn: async () => {
    seedMonitor(110, -60);
    world.tables.mechabetics_monitor_state = [];
    assertMatch(await monitorRun(), /Ryan=warn 110/);
    assert(world.tables.mechabetics_monitor_state[0].low_warned_at, "dated");
    nextRun();
    assertMatch(await monitorRun(), /Ryan=ok 110/);
  },
});

Deno.test({
  name: "monitor: a reading ten minutes old is too old to warn from", ...opts, fn: async () => {
    seedMonitor(110, -60);
    libre.at = ago(12);
    world.tables.mechabetics_readings = world.tables.mechabetics_readings.filter((r: any) => Date.parse(r.ts) < ago(12));
    assertMatch(await monitorRun(), /Ryan=ok 110/);
    assertEquals(libre.telegram.length, 0);
  },
});

Deno.test({
  name: "monitor: while a new slow insulin settles, the warning goes out without the old record", ...opts, fn: async () => {
    seedMonitor(110, -60, { basal_insulin: "Tresiba", basal_changed_at: iso(ago(5 * 1440)) });
    assertMatch(await monitorRun(), /Ryan=warn 110/);
    assert(!libre.telegram[0].includes("fois sur 10"), libre.telegram[0]);
  },
});

Deno.test({
  name: "monitor: a state it cannot read means no warning, not one every five minutes", ...opts, fn: async () => {
    seedMonitor(110, -60);
    world.failSelect.add("mechabetics_monitor_state");
    assertMatch(await monitorRun(), /Ryan=ok 110/);
    assertEquals(libre.telegram.length, 0);
  },
});

Deno.test({
  name: "monitor: a broken model costs a forecast, never an alert or a stored reading", ...opts, fn: async () => {
    seedMonitor(100, 0);
    world.tables.mechabetics_monitor_state[0].last_value = 100;
    world.tables.mechabetics_models = [{ subject: PATIENT, model: { version: 1, horizons: { "30": { w: null }, "60": { w: null } }, risk: {} }, fitted_at: iso(ago(60)) }];
    libre.value = 55;
    assertMatch(await monitorRun(), /Ryan=alert 55/);
    assertEquals(libre.telegram.length, 1);
    assert(world.tables.mechabetics_readings.some((r: any) => r.value_mgdl === 55), "the reading is stored");
    assertEquals((world.tables.mechabetics_forecast_log ?? []).length, 0);
  },
});

Deno.test({
  name: "monitor: no model yet, no warning, the trend is stored as a trend, and a fit is started", ...opts, fn: async () => {
    const realNow = Date.now;
    try {
      // The first run of an hour, then one later in the hour: a fit is tried once an hour, not every run.
      const hour = Math.floor(realNow() / 3600000) * 3600000;
      Date.now = () => hour + 60000;
      seedMonitor(110, 0);
      world.tables.mechabetics_models = [];
      llm.learnCalls = 0;
      assertMatch(await monitorRun(), /Ryan=ok 110/);
      await new Promise((r) => setTimeout(r, 20));
      assertEquals(libre.telegram.length, 0);
      assertEquals(world.tables.mechabetics_forecast_log[0].source, "trend");
      assertEquals(llm.learnCalls, 1);
      Date.now = () => hour + 600000;
      nextRun();
      assertMatch(await monitorRun(), /Ryan=ok 110/);
      await new Promise((r) => setTimeout(r, 20));
      assertEquals(llm.learnCalls, 1);
    } finally {
      Date.now = realNow;
    }
  },
});

Deno.test({
  name: "monitor: an older model speaks on screen, but only what was measured gets pushed", ...opts, fn: async () => {
    seedMonitor(85, 0);
    const old = { ...world.tables.mechabetics_models[0].model };
    delete old.lowest;
    // Every moment of this table goes low: the screen's sentence would fire.
    old.risk = { ...old.risk, n: old.risk.n.map(() => 100), low60: old.risk.n.map(() => 100), base: { ...old.risk.base, low60: 1 } };
    world.tables.mechabetics_models[0].model = old;
    assertMatch(await monitorRun(), /Ryan=ok 85/);
    assertEquals(libre.telegram.length, 0);
    assertEquals(world.tables.mechabetics_forecast_log[0].low_warning, false);
  },
});

Deno.test({
  name: "monitor: a warning Telegram refused is not counted as sent, so the next run tries again", ...opts, fn: async () => {
    seedMonitor(110, -60);
    libre.telegramDown = true;
    assertMatch(await monitorRun(), /Ryan=warn-SEND-FAILED 110/);
    assertEquals(world.tables.mechabetics_monitor_state[0].low_warned_at, undefined);
    assertEquals(world.tables.mechabetics_forecast_log[0].warned, false);
    libre.telegramDown = false;
    nextRun();
    assertMatch(await monitorRun(), /Ryan=warn 110/);
  },
});

Deno.test({
  name: "monitor: an old reading is no base for a forecast", ...opts, fn: async () => {
    seedMonitor(110, -60);
    world.tables.mechabetics_readings = world.tables.mechabetics_readings.filter((r: any) => Date.parse(r.ts) < ago(60));
    libre.at = ago(40);
    assertMatch(await monitorRun(), /Ryan=ok 110/);
    assertEquals(libre.telegram.length, 0);
    assertEquals((world.tables.mechabetics_forecast_log ?? []).length, 0);
  },
});

Deno.test({
  name: "learning: what was forecast is marked against what followed, and the analysis can say so", ...opts, fn: async () => {
    seed(140);
    const series: [number, number][] = [];
    const now = Math.floor(Date.now() / 1000);
    for (let t = now - 30 * 86400; t <= now; t += 300) {
      const h = ((t / 3600) + 1) % 24;
      series.push([t, Math.round(120 + 60 * Math.exp(-(((h - 13) / 1.5) ** 2)) + 10 * Math.sin(t / 2000))]);
    }
    world.rpc.mechabetics_series5 = () => series;
    world.tables.mechabetics_forecast_log = series.slice(-288 * 8).map(([t, v]) => ({
      subject: SUBJECT, made_at: iso(t * 1000), value_mgdl: v, source: "learned",
      f30: v, low30: v - 40, high30: v + 40, f60: v, low60: v - 60, high60: v + 60, warned: false,
    }));
    world.tables.mechabetics_forecast_log.push({ ...world.tables.mechabetics_forecast_log[0], subject: OTHER, f30: 999 });
    const only = await learn({ subject: SUBJECT, tzOffsetMin: 60, scoreOnly: true });
    assertEquals(only.live.days, 8);
    assertEquals((world.tables.mechabetics_models ?? []).length, 0);
    const r = await learn({ subject: SUBJECT, tzOffsetMin: 60 });
    assertEquals(r.fitted, true);
    assert(r.live.h30.rmse < 40, JSON.stringify(r.live.h30));
    assert(r.warnsPerDay != null);
    assertEquals(world.tables.mechabetics_models[0].model.live.days, 8);
    const c = await coach({ ...base, readings: phone([139, 140]), force: true });
    assertMatch(c.decision.forecastNote, /^Mesuré en vrai sur 8 jours : écart typique \d+ mg\/dL à 30 min/);
  },
});

Deno.test({
  name: "learning: a new slow insulin reaches the fit, and the analysis says the forecast is relearning", ...opts, fn: async () => {
    seed(140, 0, { basal_insulin: "Tresiba", basal_changed_at: iso(ago(20 * 1440)) });
    const series: [number, number][] = [];
    const now = Math.floor(Date.now() / 1000);
    for (let t = now - 60 * 86400; t <= now; t += 300) {
      series.push([t, Math.round(130 + 40 * Math.sin(t / 7000))]);
    }
    world.rpc.mechabetics_series5 = () => series;
    await learn({ subject: SUBJECT, tzOffsetMin: 60 });
    const moved = world.tables.mechabetics_models[0].model;
    world.tables.mechabetics_profiles[0].basal_changed_at = null;
    world.tables.mechabetics_models = [];
    await learn({ subject: SUBJECT, tzOffsetMin: 60 });
    const plain = world.tables.mechabetics_models[0].model;
    const seen = (m: any) => m.risk.n.reduce((a: number, b: number) => a + b, 0);
    assert(seen(moved) < seen(plain) * 0.7, `${seen(moved)} / ${seen(plain)}`);
    world.tables.mechabetics_profiles[0].basal_changed_at = iso(ago(5 * 1440));
    const c = await coach({ ...base, readings: phone([139, 140]), force: true });
    assertMatch(c.decision.forecastNote, /^Nouvelle insuline lente : la prévision apprend encore/);
  },
});

// ---- What the last check found ---------------------------------------------------------------------
Deno.test({
  name: "monitor: an alert Telegram refused goes out on the next run, it is not lost for the episode", ...opts, fn: async () => {
    seedMonitor(100, 0);
    world.tables.mechabetics_monitor_state[0].last_value = 100;
    libre.value = 55;
    libre.telegramDown = true;
    assertMatch(await monitorRun(), /Ryan=alert-SEND-FAILED 55 \(prev 100\)/);
    assertEquals(world.tables.mechabetics_monitor_state[0].last_value, 100);
    assert(world.tables.mechabetics_readings.some((r: any) => r.value_mgdl === 55), "the reading is stored all the same");
    libre.telegramDown = false;
    assertMatch(await monitorRun(), /Ryan=alert 55 \(prev 100\)/);
    assertEquals(libre.telegram.length, 1);
    assertEquals(world.tables.mechabetics_monitor_state[0].last_value, 55);
    assertMatch(await monitorRun(), /Ryan=ok 55 \(prev 55\)/);
    assertEquals(libre.telegram.length, 1);
  },
});

Deno.test({
  name: "monitor: a chart service that hangs costs the picture, not the alert", ...opts, fn: async () => {
    seedMonitor(100, 0);
    world.tables.mechabetics_monitor_state[0].last_value = 100;
    libre.value = 55;
    libre.cdnHangs = true;
    assertMatch(await monitorRun(), /Ryan=alert 55/);
    assertEquals(libre.telegram.length, 1);
    assertEquals(world.tables.mechabetics_monitor_state[0].last_value, 55);
  },
});

Deno.test({
  name: "a sentence about the glucose does not make a covered plate new", ...opts, fn: async () => {
    for (const question of ["et encore une fois il monte", "il a encore des cétones", "sa glycémie a repris", "il a encore une glycémie à 200"]) {
      seed(200, 0, firm);
      world.tables.mechabetics_meals = [{ subject: SUBJECT, ts: iso(ago(10)), description: "pâtes", carbs_g: 60, planned: false }];
      world.tables.mechabetics_insulin = [rapid(4, 10)];
      llm.reply = said({ meal: { description: "pâtes", carbsG: 60, planned: false, basis: "stated", minutesAgo: 10 } });
      const v = await ask({ ...base, question, readings: phone([200, 200]) });
      assertEquals(world.tables.mechabetics_meals.length, 1, question);
      assertEquals(v.decision.units, 0, question);
    }
  },
});

Deno.test({
  name: "food dated in the past on the meals screen is judged at the time it was eaten", ...opts, fn: async () => {
    seed(100, 0, firm);
    for (const r of world.tables.mechabetics_readings) {
      const m = (Date.now() - Date.parse(r.ts)) / 60000;
      if (m > 20) r.value_mgdl = 55;
      else if (m > 0) r.value_mgdl = Math.round(100 - m * 2);
    }
    const m = await meals({ action: "plan", subject: SUBJECT, lang: "fr", meal: { description: "coca", carbsG: 35, quantity: 1, ts: ago(14) } });
    assertEquals(m.decision?.units ?? 0, 0);
  },
});
