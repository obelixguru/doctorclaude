// Capability-token access control for per-user auth (S2).
//
// The client proves LibreLinkUp ownership via `mechabetics-claim` and gets a SECRET token, which it
// sends as the `x-mechabetics-access` header on every call. Here we map that token back to its
// subject and enforce it.
//
// HARD CUT (CURRENT, REQUIRE_TOKEN = true):
//   - token present  -> it MUST resolve AND match the requested subject, else "forbidden_subject".
//                       (so a token holder can only ever reach their own data.)
//   - token absent    -> rejected ("forbidden_subject"). This is what closes the "anyone with the
//                       public anon key + a subject hash can read" hole. Every install must send a
//                       token; the Phase-B client claims one on login/patient change.
//
// ROLLBACK (grace window, REQUIRE_TOKEN = false):
//   - token absent -> fall back to the body subject so old/token-less installs keep working. Flip the
//     flag below back to false and redeploy if a real device is found stranded without a token.

async function sha256hex(s: string): Promise<string> {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** The subject a presented capability token grants, or null if no/invalid token. */
export async function tokenSubject(req: Request, db: any): Promise<string | null> {
  const tok = req.headers.get("x-mechabetics-access");
  if (!tok || tok.length < 16) return null;
  try {
    const h = await sha256hex(tok);
    const { data } = await db.from("mechabetics_access").select("subject").eq("token_hash", h).maybeSingle();
    return (data as any)?.subject ?? null;
  } catch (_) {
    return null;
  }
}

// HARD CUT — ON. A valid capability token is REQUIRED; a missing/invalid token is rejected
// (forbidden_subject). This closes the "anyone with the public anon key + a subject hash can read"
// hole. Every install must send a token (the Phase-B client claims one on login/patient change).
// Rollback: set this back to false and redeploy the 8 functions to re-open the grace window.
const REQUIRE_TOKEN = true;

/**
 * Resolve the subject this request may act on. Throws Error("forbidden_subject") when a token is
 * presented that does not own the requested subject (or, under the hard cut, when no valid token is
 * presented). Otherwise returns the body subject (grace window). The caller's existing try/catch
 * turns the throw into an error response.
 */
export async function accessSubject(req: Request, db: any, bodySubject: string | null): Promise<string | null> {
  const ts = await tokenSubject(req, db);
  if (ts) {
    if (bodySubject && bodySubject !== ts) throw new Error("forbidden_subject");
    return ts;
  }
  if (REQUIRE_TOKEN) throw new Error("forbidden_subject");
  return bodySubject;
}
