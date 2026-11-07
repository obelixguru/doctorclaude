// THE DOOR TO THE DOMINO. Deployed in the NUEVE project (nppzlbiznfsijlbdxubx), not beside the other functions, and kept
// out of supabase/functions so that no deployment of this repo sends it to the wrong place.
//
// The family's model servers run on their Ubuntu: ChatGPT, and Claude with its accounts taking over from one another.
// Both refuse anyone without their key, and the keys are secrets of the Nueve project. They stay there: this function
// reads them from its own environment and hands the ask over, so Dr Claude can use the servers without any key being
// copied anywhere.
//
// Anyone on the internet can reach this address, so nothing goes through without a pass. A Dr Claude function writes a
// one-time pass in its own database, and this door checks it there (see 20261107_v40_domino_passes.sql). Only that
// project's server can write one. Without this check, this address would be a free model for the whole internet, paid
// for by the family's plans.
//
// Only a chat completion goes through, with only the fields it needs: the Claude server also takes a working folder and
// has routes that run code, and none of that is reachable from here. Nothing about the ask is logged.

const PASSES = "https://vzafttfgrxpjdraveihh.supabase.co/rest/v1/rpc/mechabetics_domino_pass";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ASK_FIELDS = ["model", "messages", "temperature", "max_tokens", "reasoning_effort", "effort"];
/** Someone is waiting on the other side: past this nobody reads the answer. */
const LONGEST_ASK_MS = 60_000;

const env = (name: string) => (Deno.env.get(name) ?? "").trim();
const links: Record<string, () => { url: string; token: string }> = {
  gpt: () => ({ url: env("GPT_CODE_SERVER_URL") || "https://gpt.nueveapp.com", token: env("GPT_CODE_SERVER_TOKEN") }),
  claude: () => ({ url: env("CLAUDE_CODE_SERVER_URL") || "https://claude.nueveapp.com", token: env("CLAUDE_CODE_SERVER_TOKEN") }),
};

const refused = (status: number, error: string) =>
  new Response(JSON.stringify({ error }), { status, headers: { "content-type": "application/json" } });

async function passAccepted(pass: string, key: string): Promise<boolean> {
  try {
    const r = await fetch(PASSES, {
      method: "POST",
      headers: { "content-type": "application/json", apikey: key, authorization: `Bearer ${key}` },
      body: JSON.stringify({ p_pass: pass }),
      signal: AbortSignal.timeout(5000),
    });
    return r.ok && (await r.json()) === true;
  } catch (e) {
    console.error(`domino: pass not checked: ${(e as Error)?.message ?? e}`);
    return false;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return refused(405, "method");

  const pass = req.headers.get("x-domino-pass") ?? "";
  const key = req.headers.get("x-domino-key") ?? "";
  if (!UUID.test(pass) || !key) return refused(401, "no pass");
  if (!(await passAccepted(pass, key))) return refused(401, "pass refused");

  const name = new URL(req.url).searchParams.get("link") ?? "";
  const link = Object.hasOwn(links, name) ? links[name]() : null;
  if (!link) return refused(400, "unknown link");
  if (!link.token) return refused(503, "link not configured");

  const asked = await req.json().catch(() => null);
  if (!asked || !Array.isArray(asked.messages)) return refused(400, "no messages");
  const ask: Record<string, unknown> = {};
  for (const field of ASK_FIELDS) if (asked[field] !== undefined) ask[field] = asked[field];

  const started = Date.now();
  try {
    const answer = await fetch(`${link.url.replace(/\/+$/, "")}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${link.token}` },
      body: JSON.stringify(ask),
      signal: AbortSignal.timeout(LONGEST_ASK_MS),
    });
    console.log(`domino: ${name} ${answer.status} after ${Date.now() - started} ms`);
    // Streamed through as it comes: the servers open their answer at once and send keepalives and progress before it.
    // When the caller hangs up, this stream closes and the server stops working on an answer nobody will read.
    return new Response(answer.body, {
      status: answer.status,
      headers: { "content-type": answer.headers.get("content-type") ?? "application/json" },
    });
  } catch (e) {
    console.error(`domino: ${name} unreachable after ${Date.now() - started} ms: ${(e as Error)?.message ?? e}`);
    return refused(502, "link unreachable");
  }
});
