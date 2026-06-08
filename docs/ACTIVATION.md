# À activer (ready-to-activate checklist)

Status of the things that need the maintainer's external accounts. Updated 2026-06-06.

## ✅ Done
- [x] **GitHub repo**: https://github.com/obelixguru/doctorclaude
- [x] **Ko-fi donations**: https://ko-fi.com/doctorclaude (connected to the maintainer's PayPal). Wired into the app (Profil → Soutenir) and the README.
- [x] **Cloud DB**: already **Supabase** (project `vzafttfgrxpjdraveihh`). Glucose readings + meal/insulin/activity logs + AI analyses already sync there (pseudonymous, sha256 subject id). There is nothing extra to "build" — the cloud DB is live and in use.

## ⏸️ Deferred on purpose
- [ ] **Stripe / paid Hosted tier** — parked until there's a registered business behind the project. For now, support = **Ko-fi → PayPal** (above). The in-app "Hosted" toggle still works as a local premium-voice/cloud switch; it's just not a paid subscription yet.
- [ ] **Google Sign-In** — **removed** from the app. It served no purpose: the app authenticates via the CGM follower account, and Google login can't yield a Gemini key. (If ever needed for cross-device identity, re-add Credential Manager — but not now.)

## 🔜 Only when you decide to push for public / paid users
- [ ] **Publish the privacy policy** at a public URL (host `docs/PRIVACY.md` / `docs/PRIVACY.fr.md`, e.g. GitHub Pages) and put that URL in the app + any store listing.
- [ ] **Play Store** — only worth it once you're ready to do community outreach (see the honest note below). Use `docs/PLAY_STORE.md` (no Abbott marks). Fill the Data-safety form from that doc.
- [ ] **Pin newer AI models** (no code change) by setting Supabase secrets:
  - `MECHABETICS_GEMINI_TEXT_MODEL` = e.g. `gemini-3.5-flash` or `gemini-3.1-pro` (BYOK text path).
  - `MECHABETICS_GEMINI_VISION_MODEL` = e.g. `gemini-2.5-flash` (photo scan).
  - `MECHABETICS_DEEPSEEK_MODEL` = e.g. `deepseek-v4-pro` (server analysis — more context).
  The code already tries a fallback chain, so an unknown id degrades gracefully.

## ❌ Not needed (decided)
- [ ] ~~Real doctor ratios~~ — **not required**. The app seeds ratios from weight/TDD and the **autotune** engine refines them from the logged data over time (Profil → "Affiner mes ratios"). You validate by watching the following days' curves. No doctor appointment needed to use the app.

---

## Honest answer: will the Play Store bring organic downloads with zero effort?

**No.** Realistically, a new health app gets ~no organic installs without effort. Reasons:
- The Play Store doesn't surface unknown health apps; you won't rank for "diabetes" / "CGM" against big players, and you **can't** use the CGM-vendor trademarks that people actually search.
- Health/medical apps get extra review scrutiny and ranking caution.

What actually works for this kind of project is **community, not the store**: the #WeAreNotWaiting crowd (Nightscout / Loop / AAPS / xDrip+ forums, r/diabetes, diabetes patient associations, Facebook/Discord groups), and the genuine "a dad built an AI coach for his diabetic son, it's open-source" story. A few authentic posts there will do more than the Play Store listing.

**Suggested order:** ship the GitHub repo + a short write-up → share it in 2–3 communities → only then bother with the Play Store (an APK download / GitHub release is enough to start, and avoids the review hassle while you gather feedback).
