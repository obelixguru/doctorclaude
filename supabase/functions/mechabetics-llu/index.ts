// LibreLinkUp READ PROXY — the one thing a browser client cannot do for itself.
//
// The Android app talks to `api[-region].libreview.io` straight from the device
// (data/LibreLinkUpClient.kt). A web client cannot: Abbott serves no CORS headers, so the
// preflight fails before the request is ever sent. This function is that hop, and nothing more —
// it forwards login / connections / graph and hands the answer back with CORS on it.
//
// TRUST MODEL — deliberately identical to the phone's, not wider:
//   * Credentials are NEVER stored. The e-mail/password appear only inside a `login` call and are
//     forwarded to Abbott in the same breath; the caller keeps the returned token, exactly as the
//     phone keeps it in its own store. This function is stateless and touches no table.
//   * Nothing here reads or writes `mechabetics_*`. It cannot leak another family's data because it
//     holds no subject and no service-role query — the LibreLinkUp session IS the authorisation,
//     the same proof `mechabetics-claim` already relies on.
//   * Nothing is logged that identifies anybody: no credentials, no token, no patient id, no
//     glucose value. The diagnostics below are counts and HTTP statuses only — the same discipline
//     as LibreLinkUpClient.shapeOf().
//
// The region redirect and the TOU/PP steps are ported from the phone client rather than reinvented:
// both are load-bearing. Abbott rebalances accounts between data centres and answers 200 on the old
// host with `{redirect:true,region}` in place of the payload — read naively that parses as a
// perfectly valid EMPTY graph, which is how a wrong-region host can freeze a dashboard on its last
// value with no error anywhere (LibreLinkUpClient.kt:159-175).

import {
  hostOf,
  type LluReading,
  parseMeasurement,
  redirectRegionOf,
  sensorEndMs,
} from "../_shared/lluParse.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  // x-mechabetics-access is listed for symmetry with the other functions' contract. This function
  // does not read it (it has no subject to guard) but a browser preflight refuses any header the
  // server did not name, and the client sends one uniform header set to every endpoint.
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-mechabetics-access",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { ...CORS, "content-type": "application/json" } });
}

/** The header set Abbott's API expects; `product`/`version` are mandatory or it 4xxs. */
function H(extra: Record<string, string> = {}) {
  return {
    "content-type": "application/json",
    "product": "llu.android",
    "version": "4.16.0",
    "accept": "application/json",
    ...extra,
  };
}

async function sha256hex(s: string): Promise<string> {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/**
 * Logs in, following the region redirect and the terms/privacy steps Abbott can interpose.
 * Returns the session, or an error shaped for the UI (`needsLogin` = the password is the problem,
 * so the client shows the login screen instead of a transient-error banner).
 */
async function login(
  email: string,
  password: string,
): Promise<{ ok: true; token: string; region: string | null; accountIdHash: string } | { ok: false; error: string; needsLogin?: boolean }> {
  let region: string | null = null;
  let carriedToken: string | null = null;

  // Bounded: at most 2 region hops and 2 step acceptances, so a server that keeps answering
  // "redirect" or "step" ends as a clean error instead of an unbounded loop against Abbott.
  for (let attempt = 0; attempt < 5; attempt++) {
    let r: Response;
    try {
      r = await fetch(`https://${hostOf(region)}/llu/auth/login`, {
        method: "POST",
        headers: H(),
        body: JSON.stringify({ email, password }),
      });
    } catch (e) {
      return { ok: false, error: `network: ${(e as Error)?.message ?? e}` };
    }
    if (r.status === 429) return { ok: false, error: "rate_limited" };
    const j = await r.json().catch(() => null);
    if (!j) return { ok: false, error: `bad_response_http_${r.status}` };

    const region2 = redirectRegionOf(j);
    if (region2) { region = region2; continue; }

    if (j.status === 4) return { ok: false, error: "invalid_credentials", needsLogin: true };

    const data = j.data;
    if (!data) return { ok: false, error: "empty_login_response" };

    const token: string | undefined = data.authTicket?.token;
    const uid: string | undefined = data.user?.id;
    if (token && uid) {
      return { ok: true, token, region, accountIdHash: await sha256hex(uid) };
    }

    // No session yet: Abbott wants the terms (TOU) or privacy policy (PP) accepted first. The
    // partial ticket authenticates that acceptance, then the login is retried.
    const stepType = String(data.step?.type ?? "").toLowerCase();
    const path = stepType === "tou" ? "/auth/continue/tou" : stepType === "pp" ? "/auth/continue/pp" : null;
    if (!path) return { ok: false, error: "no_token_in_response" };
    carriedToken = data.authTicket?.token ?? carriedToken;
    if (!carriedToken) return { ok: false, error: `step_${stepType}_without_ticket` };
    const sr = await fetch(`https://${hostOf(region)}${path}`, {
      method: "POST",
      headers: H({ authorization: `Bearer ${carriedToken}` }),
      body: "",
    }).catch(() => null);
    if (!sr || !sr.ok) return { ok: false, error: `step_${stepType}_http_${sr?.status ?? "fail"}` };
    // Loop: retry the login now that the step is accepted.
  }
  return { ok: false, error: "too_many_redirects" };
}

/** GET against Abbott with the session headers, transparently following a region redirect. */
async function authedGet(
  path: string,
  token: string,
  accountIdHash: string,
  region: string | null,
): Promise<{ ok: true; body: any; region: string | null } | { ok: false; error: string; needsLogin?: boolean }> {
  let reg = region;
  for (let attempt = 0; attempt < 3; attempt++) {
    let r: Response;
    try {
      r = await fetch(`https://${hostOf(reg)}${path}`, {
        headers: H({ authorization: `Bearer ${token}`, "account-id": accountIdHash }),
      });
    } catch (e) {
      return { ok: false, error: `network: ${(e as Error)?.message ?? e}` };
    }
    if (r.status === 401 || r.status === 403) return { ok: false, error: "session_expired", needsLogin: true };
    if (r.status === 429) return { ok: false, error: "rate_limited" };
    if (!r.ok) return { ok: false, error: `http_${r.status}` };
    const j = await r.json().catch(() => null);
    if (!j) return { ok: false, error: "unparseable_body" };
    const region2 = redirectRegionOf(j);
    // Checked BEFORE the body is read as data: a redirect carries a valid-looking `data` object
    // holding {redirect, region} rather than readings, and parses straight through as "the sensor
    // sent nothing" (LibreLinkUpClient.kt:270-278).
    if (region2) { reg = region2; continue; }
    return { ok: true, body: j, region: reg };
  }
  return { ok: false, error: "too_many_redirects" };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: "bad_json" }, 400);
  }

  const action = String(body?.action ?? "");

  try {
    if (action === "login") {
      const email = String(body?.email ?? "").trim();
      const password = String(body?.password ?? "");
      if (!email || !password) return json({ error: "missing_credentials", needsLogin: true }, 400);
      const s = await login(email, password);
      console.log(`llu login: ok=${s.ok}${s.ok ? "" : ` error=${(s as any).error}`}`);
      if (!s.ok) return json({ error: s.error, needsLogin: s.needsLogin === true }, 200);
      return json({ ok: true, token: s.token, region: s.region, accountIdHash: s.accountIdHash });
    }

    const token = String(body?.token ?? "");
    const accountIdHash = String(body?.accountIdHash ?? "");
    const region: string | null = body?.region ? String(body.region) : null;
    if (!token || !accountIdHash) return json({ error: "not_logged_in", needsLogin: true }, 200);

    if (action === "connections") {
      const r = await authedGet("/llu/connections", token, accountIdHash, region);
      if (!r.ok) return json({ error: r.error, needsLogin: r.needsLogin === true }, 200);
      const arr: any[] = Array.isArray(r.body?.data) ? r.body.data : [];
      console.log(`llu connections: patients=${arr.length}`);
      return json({
        ok: true,
        region: r.region,
        patients: arr
          .filter((p) => p?.patientId)
          .map((p) => ({
            patientId: String(p.patientId),
            firstName: String(p.firstName ?? ""),
            lastName: String(p.lastName ?? ""),
          })),
      });
    }

    if (action === "graph") {
      const patientId = String(body?.patientId ?? "");
      if (!patientId) return json({ error: "missing_patient" }, 400);
      const r = await authedGet(`/llu/connections/${encodeURIComponent(patientId)}/graph`, token, accountIdHash, region);
      if (!r.ok) return json({ error: r.error, needsLogin: r.needsLogin === true }, 200);
      const data = r.body?.data;
      if (!data) return json({ error: "no_graph_data" }, 200);

      const connection = data.connection;
      const live = parseMeasurement(connection?.glucoseMeasurement);
      const history: LluReading[] = (Array.isArray(data.graphData) ? data.graphData : [])
        .map(parseMeasurement)
        .filter((x: LluReading | null): x is LluReading => x !== null)
        .sort((a: LluReading, b: LluReading) => a.ts - b.ts);

      // Abbott's live `glucoseMeasurement` is frequently null (sensor not freshly scanned). Falling
      // back to the newest graph point keeps a real number on screen instead of "--" — and because
      // the value carries its own timestamp, a stale one still reads as stale downstream.
      const current = live ?? (history.length ? history[history.length - 1] : null);

      const ageMin = current ? Math.round((Date.now() - current.ts) / 60000) : -1;
      console.log(`llu graph: points=${history.length} live=${!!live} newestAgeMin=${ageMin}`);
      return json({ ok: true, region: r.region, current, history, sensorEndMs: sensorEndMs(connection) });
    }

    return json({ error: "unknown_action" }, 400);
  } catch (e) {
    console.error(`llu: ${(e as Error)?.message ?? e}`);
    return json({ error: "server_error" }, 500);
  }
});
