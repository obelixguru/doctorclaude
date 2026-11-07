// The door to the domino, with the network faked. From the repo root, with deno on PATH:
//   deno test -A --no-lock --no-check supabase/tests/domino_door.test.ts
// What matters here is what it refuses: this address is open to the internet, and behind it are the family's plans.
import { assertEquals } from "jsr:@std/assert@1";

Deno.env.set("GPT_CODE_SERVER_TOKEN", "gpt-key");
Deno.env.set("CLAUDE_CODE_SERVER_TOKEN", "claude-key");

// deno-lint-ignore no-explicit-any
let handler: (req: Request) => Promise<Response> = null as any;
// deno-lint-ignore no-explicit-any
(Deno as any).serve = (h: typeof handler) => {
  handler = h;
  return {};
};
await import("../functions-nueve/mechabetics-domino/index.ts");

const PASS = "6f1c2f4e-3a53-4d3b-9d6e-0c8f4f1a2b3c";
const realFetch = globalThis.fetch;
// deno-lint-ignore no-explicit-any
let seen: { url: string; init: any }[] = [];
let passIsGood = true;

globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  seen.push({ url, init });
  if (url.includes("mechabetics_domino_pass")) return Promise.resolve(new Response(JSON.stringify(passIsGood), { status: 200 }));
  return Promise.resolve(new Response(' \nREASON{"kind":"progress"}\n{"choices":[{"message":{"content":"{}"}}]}', { status: 200 }));
}) as typeof fetch;

function ask(link: string, body: unknown, headers: Record<string, string> = { "x-domino-pass": PASS, "x-domino-key": "public" }, method = "POST") {
  seen = [];
  passIsGood = true;
  return new Request(`https://door.test/functions/v1/mechabetics-domino?link=${link}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: method === "POST" ? JSON.stringify(body) : undefined,
  });
}
const servers = () => seen.filter((c) => c.url.includes("nueveapp.com"));
const messages = [{ role: "user", content: "x" }];

Deno.test("nothing goes through without a pass, and no server is touched", async () => {
  for (const headers of [{}, { "x-domino-pass": "guess", "x-domino-key": "public" }, { "x-domino-pass": PASS }]) {
    const r = await handler(ask("gpt", { messages }, headers as Record<string, string>));
    assertEquals(r.status, 401);
    await r.body?.cancel();
    assertEquals(servers().length, 0);
  }
});

Deno.test("a pass the other project does not know opens nothing", async () => {
  const req = ask("gpt", { messages });
  passIsGood = false;
  const r = await handler(req);
  assertEquals(r.status, 401);
  await r.body?.cancel();
  assertEquals(servers().length, 0);
});

Deno.test("the pass is checked at the fixed address, whatever the caller says", async () => {
  const r = await handler(ask("gpt", { messages, url: "https://evil.test" }, { "x-domino-pass": PASS, "x-domino-key": "public", host: "evil.test" }));
  await r.body?.cancel();
  assertEquals(seen[0].url, "https://vzafttfgrxpjdraveihh.supabase.co/rest/v1/rpc/mechabetics_domino_pass");
  assertEquals(JSON.parse(seen[0].init.body), { p_pass: PASS });
});

Deno.test("each link goes to its own server, with its own key, on the chat route only", async () => {
  for (const [link, host, key] of [["gpt", "gpt.nueveapp.com", "gpt-key"], ["claude", "claude.nueveapp.com", "claude-key"]]) {
    const r = await handler(ask(link, { messages }));
    assertEquals(r.status, 200);
    await r.body?.cancel();
    assertEquals(servers().length, 1);
    assertEquals(servers()[0].url, `https://${host}/v1/chat/completions`);
    assertEquals(servers()[0].init.headers.authorization, `Bearer ${key}`);
  }
});

Deno.test("only the fields of a chat go through: no working folder for the agent behind it", async () => {
  const r = await handler(ask("claude", {
    model: "claude-sonnet-5-5", effort: "low", temperature: 0.3, max_tokens: 100, messages,
    workspace_dirs: ["/home"], tools: ["bash"],
  }));
  await r.body?.cancel();
  assertEquals(JSON.parse(servers()[0].init.body), { model: "claude-sonnet-5-5", effort: "low", temperature: 0.3, max_tokens: 100, messages });
});

Deno.test("an unknown link, a missing list of messages or another method is refused", async () => {
  for (const name of ["other", "constructor", "__proto__", ""]) {
    const r = await handler(ask(name, { messages }));
    assertEquals(r.status, 400, name);
    await r.body?.cancel();
    assertEquals(servers().length, 0);
  }
  const noMessages = await handler(ask("gpt", {}));
  assertEquals(noMessages.status, 400);
  await noMessages.body?.cancel();
  const get = await handler(ask("gpt", null, {}, "GET"));
  assertEquals(get.status, 405);
  await get.body?.cancel();
});

Deno.test("the answer comes back as it came, keepalives and progress included", async () => {
  const r = await handler(ask("gpt", { messages }));
  assertEquals(await r.text(), ' \nREASON{"kind":"progress"}\n{"choices":[{"message":{"content":"{}"}}]}');
});

Deno.test("a server out of reach is an error the caller can read, not a crash", async () => {
  const req = ask("gpt", { messages });
  const fake = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    if (String(input).includes("nueveapp.com")) return Promise.reject(new Error("tunnel down"));
    return fake(input, init);
  }) as typeof fetch;
  const r = await handler(req);
  assertEquals(r.status, 502);
  await r.body?.cancel();
  globalThis.fetch = fake;
});

Deno.test("cleanup", () => {
  globalThis.fetch = realFetch;
});
