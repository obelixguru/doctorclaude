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

// GRACE WINDOW — token NOT required (rolled back 2026-06-09). The hard cut stranded a real device:
// `mechabetics-claim` rotates tokens by DELETING this account's previous token, so a SECOND install
// sharing the same LibreLinkUp account (an emulator, a reinstall) evicts the first device's token.
// The evicted device then sends a now-deleted token, `tokenSubject` returns null, and the hard cut
// turned that into `forbidden_subject` + EMPTY readings/insulin — i.e. flat graphs and missing chart
// markers, with no error surfaced. Until the claim flow stops evicting peers (multi-token per
// account), require-token is unsafe. With this false, an absent/stale token falls back to the body
// subject so every device keeps reading its own data; a PRESENT, VALID token is still enforced to
// its own subject (line above), so token holders gain nothing by spoofing another subject.
// Re-enable (set true) only AFTER the claim function no longer deletes peers' tokens.
const REQUIRE_TOKEN = false;

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
  // No valid token resolved (absent, or stale = rotated away by a peer install). Log which, once,
  // so we can confirm devices are being stranded — then fall back (grace window) or reject (hard cut).
  console.log(`access: noToken hadHeader=${!!req.headers.get("x-mechabetics-access")} requireToken=${REQUIRE_TOKEN} subj=${bodySubject ? bodySubject.slice(0, 8) : "none"}`);
  if (REQUIRE_TOKEN) throw new Error("forbidden_subject");
  return bodySubject;
}
