import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// mechabetics-claim — per-user access foundation (S2).
//
// The legitimate owner of a `subject` (= sha256(patientId)) is whoever can read that patient on
// LibreLinkUp. The client sends its OWN LibreLinkUp session (token + region + account-id hash) plus
// the patientId; this function asks LibreLinkUp `/llu/connections` whether that session can actually
// see that patient. If yes, it mints a SECRET capability token bound to the subject and returns it.
// The other edge functions will then require this token (a secret the device holds) instead of a
// guessable subject hash — closing "anyone with the public anon key + a subject hash can read".
//
// This is non-breaking: deploying it changes nothing until the client starts calling it and the
// other functions start enforcing the token.

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

async function sha256hex(s: string): Promise<string> {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

function randomToken(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

function lluHeaders(token: string, accountIdHash: string): Record<string, string> {
  return {
    "content-type": "application/json",
    "product": "llu.android",
    "version": "4.16.0",
    "accept": "application/json",
    "authorization": `Bearer ${token}`,
    "account-id": accountIdHash,
  };
}

/** Does this LibreLinkUp session actually list `patientId` among its connections? */
async function ownsPatient(region: string, token: string, accountIdHash: string, patientId: string): Promise<boolean> {
  const host = region ? `api-${region}.libreview.io` : "api.libreview.io";
  try {
    const r = await fetch(`https://${host}/llu/connections`, { headers: lluHeaders(token, accountIdHash) });
    if (!r.ok) return false;
    const j = await r.json().catch(() => null);
    const conns: any[] = j?.data ?? [];
    return conns.some((c) => String(c?.patientId ?? "") === patientId);
  } catch (_) {
    return false;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "method" }, 405);

  try {
    const body = await req.json().catch(() => ({}));
    const patientId = String(body.patientId ?? "").trim();
    const lluToken = String(body.lluToken ?? "").trim();
    const region = String(body.region ?? "").trim().toLowerCase().replace(/[^a-z0-9-]/g, "");
    const accountIdHash = String(body.accountIdHash ?? "").trim();
    const label = (typeof body.label === "string" ? body.label : "").slice(0, 60);

    if (!patientId || !lluToken || !accountIdHash) {
      return json({ ok: false, error: "missing patientId / lluToken / accountIdHash" }, 400);
    }
    // /^[0-9a-f-]+$/ patientIds are GUIDs; keep it permissive but bounded.
    if (patientId.length > 80 || lluToken.length > 4096 || accountIdHash.length > 128) {
      return json({ ok: false, error: "bad input" }, 400);
    }

    // The actual ownership proof: ask LibreLinkUp.
    const owns = await ownsPatient(region, lluToken, accountIdHash, patientId);
    if (!owns) return json({ ok: false, error: "not_owner" }, 403);

    const subject = await sha256hex(patientId);
    const token = randomToken();
    const tokenHash = await sha256hex(token);

    // One current token per (subject, device): rotate by clearing this device's old tokens first.
    await db.from("mechabetics_access").delete().eq("subject", subject).eq("account_hash", accountIdHash);
    const { error } = await db.from("mechabetics_access").insert({
      token_hash: tokenHash,
      subject,
      account_hash: accountIdHash,
      label: label || null,
    });
    if (error) return json({ ok: false, error: "store_failed" }, 500);

    // Return the RAW token once (only its hash is stored) + the subject (so the client can keep
    // sending the same subject it already uses).
    return json({ ok: true, token, subject });
  } catch (e) {
    return json({ ok: false, error: `server: ${(e as Error)?.message ?? e}` }, 500);
  }
});
