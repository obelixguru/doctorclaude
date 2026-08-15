# Security Policy

## Reporting a vulnerability

Please report security issues **privately** to **hello@nueveapp.com**. Do not open a public GitHub issue for a vulnerability.

Include, where possible:
- a description of the issue and its impact,
- steps to reproduce,
- affected version / commit,
- any suggested remediation.

We aim to acknowledge reports within a few days and to coordinate a fix and disclosure timeline with you. Please give us reasonable time to address the issue before any public disclosure. We're a small community project — thank you for your patience and for helping keep patients safe.

## Scope

In scope:
- The Android app (`com.nueve.mechabetics`).
- The Supabase Edge Functions (`supabase/functions/mechabetics-*`) and the dose-safety guard.
- Authentication / data-isolation issues (one user's data leaking to another).
- Anything that could cause the app to surface an unsafe insulin/dose recommendation.

Especially valued: any path by which the **language model could cause a dose number to be shown**, or by which a **guard invariant** (no insulin when falling / post-hypo / stale / in-range; IOB not deducted; hypo not treated as sugar) could be bypassed. These are safety-critical.

## Keys & secrets model

- **No private keys ship in the app.** The only key embedded in the client is the Supabase **anon** key, which is public by design and protected by Row-Level Security + edge-function logic.
- **BYOK:** a user's own Google Gemini key is stored **encrypted on their device** (`EncryptedSharedPreferences`) and sent only to the project's edge functions to call the model on the user's behalf. It is never persisted server-side.
- **Server secrets** (LLM keys, voice keys, follower credentials, service-role key) live only in the Supabase project's secret store and are never exposed to clients.
- **Health data** is pseudonymous in the Hosted tier (sha256 subject id, never the person's name) and never leaves the device in the Free/BYOK tier.

## Good practice for users

- Use a CGM follower/share account **you own**, with a password you don't reuse elsewhere.
- Prefer the **Free / on-device** tier if you want zero cloud exposure.
- Keep your meter and your care team in the loop — the app is a companion, not a medical device.
