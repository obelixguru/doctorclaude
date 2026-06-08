# Doctor Claude — Privacy Policy

_Last updated: 2026-06-06_

This policy explains what Doctor Claude does with your data. It is written to be honest and plain, because we are handling **health data**.

> **The short version.** In the **Free / BYOK** tier, Doctor Claude stores your glucose history **only on your phone**. Nothing is sent to us, because there is no account and no server in that mode. In the **Hosted** tier (paid, opt-in), your data syncs to a server in **pseudonymous** form (an irreversible hash, never your name), only after you give explicit consent, and you can delete it at any time.

## Who we are (data controller)

**Nueve** — contact: **hello@nueveapp.com**.

## Two modes, two very different privacy postures

### Free / BYOK (default) — on-device only
- Your glucose readings and history are stored **locally on your device** (SQLite). They **do not leave the phone**.
- There is **no account, no sign-in, and no server-side storage** of your health data in this mode.
- AI requests use **your own** Google Gemini API key (BYOK), stored encrypted on your device, to call the model. We do not receive or store that key.
- Because we never receive your data in this mode, **there is nothing for us to retain, sell, or disclose.**

### Hosted (paid, opt-in) — pseudonymous cloud sync
If, and only if, you turn on Hosted mode and accept the consent screen:

**What we collect and process:**
- A **pseudonymous subject identifier** — a sha256 hash derived from your CGM patient id. **We never store your name.**
- **Glucose readings** (value + timestamp).
- **Logs you create**: meals (description, estimated carbs), insulin doses, physical activity.
- **AI analysis text** generated for you (so you can re-read past analyses).

**Lawful basis (GDPR):** Glucose is special-category health data under **Article 9**. We process it on the basis of your **explicit consent — Article 9(2)(a)** — given via the in-app consent screen. You can withdraw consent at any time by turning off Hosted mode and/or deleting your data.

**Purpose:** to provide history beyond the CGM cloud's short rolling window, cross-device sync, and the coaching features you asked for. We do **not** use your data for advertising, profiling unrelated to the service, or training third-party models.

**Retention:** kept while your Hosted account is active. When you delete your data (below) it is removed promptly. Backups are rotated on a short cycle.

**Your rights:** access, rectification, erasure ("**delete my data**" button in the app), restriction, portability, and objection. To exercise any right, use the in-app button or email **hello@nueveapp.com**. You also have the right to lodge a complaint with your data-protection supervisory authority (e.g. the CNIL in France).

**Sub-processors (Hosted only):**
- **Supabase** — database + edge-function hosting for the pseudonymous data.
- **The LLM provider** (DeepSeek and/or Google Gemini) — receives the prompt context needed to generate a reply. Sent pseudonymously; not used by us to identify you.
- **The voice provider** (ElevenLabs) — receives the text to synthesise, only when premium voice is enabled. Free/on-device voice never leaves the phone.

We use **no advertising or analytics SDKs** that profile you.

## Children

Doctor Claude may be used **by or for a minor** (for example, a parent following a child with type 1 diabetes). In that case the parent/guardian is responsible for the account and provides consent. We minimise data (pseudonymous, health data only) and never store the child's name. If you believe data about a child has been collected without proper consent, contact us and we will delete it.

## Security

Pseudonymisation (sha256), encryption in transit (HTTPS), Row-Level Security on the database, encrypted on-device storage for keys. No system is perfectly secure; see [SECURITY.md](../SECURITY.md) to report an issue.

## The CGM connection

Doctor Claude reads from a **compatible CGM follower/share account that you already own and control**, using credentials you provide. We are **not affiliated with, sponsored by, or endorsed by any CGM manufacturer.** Your use of that account is subject to that vendor's own terms.

## Changes

We may update this policy; material changes will be surfaced in-app. Continued use of the Hosted tier after a change means you accept the updated policy.

## Contact

**hello@nueveapp.com**
