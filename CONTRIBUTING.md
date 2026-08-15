# Contributing to Doctor Claude

Thank you for wanting to help. This is a community project for people living with type 1 diabetes and the families who care for them. Patches, bug reports, translations, and field notes are all welcome.

## The one non-negotiable safety rule

**The language model must NEVER emit an insulin dose number. All dose arithmetic stays in deterministic code.**

This is the architectural backbone of the project's non-prescriptive, at-your-own-risk safety stance. Concretely:

- The dose math lives in [`supabase/functions/_shared/doseGuard.ts`](supabase/functions/_shared/doseGuard.ts) (`computeGuard`, `combinedActionLine`, `activeIob`, …). It is pure, deterministic, unit-tested, and is the **single source of truth**.
- The coach / ask / scan prompts instruct the model to write **no dose figures** ("AUCUN chiffre de dose"). Code then appends the authoritative `Action :` line.
- A reported dose is counted toward insulin-on-board **immediately** so the app never stacks a correction on a dose already taken (`mechabetics-ask`). An over-reported dose triggers an explicit hypo-watch, never "more insulin".
- If you touch the guard, **add/keep the unit tests** and run them:
  ```bash
  node --test supabase/functions/_shared/doseGuard.test.ts \
              supabase/functions/_shared/predict_autotune.test.ts
  ```
  Every safety invariant (no insulin when falling / post-hypo / stale / in-range; hypo → sugar by weight; correction minus IOB) must stay covered.

PRs that let the model produce dose numbers, or that weaken a guard invariant without a very good reason and test coverage, will not be merged.

## Building & running

See [README.md → Build from source](README.md#build-from-source). In short:

```bash
export JAVA_HOME="/path/to/Android Studio/jbr"   # PowerShell: $env:JAVA_HOME = "...\jbr"
./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/DoctorClaude-debug.apk
```

- **App:** Kotlin + Jetpack Compose, package `com.nueve.mechabetics` (legacy id — please don't rename it; it breaks existing installs).
- **Backend:** Supabase Edge Functions in `supabase/functions/mechabetics-*` (Deno/TypeScript). Shared logic in `supabase/functions/_shared`.
- The shared `_shared/*.ts` modules are written as **pure TypeScript** (no Deno/Node-only APIs) so they import cleanly in the edge runtime *and* run under the Node test runner.

## Pull requests

1. Fork, branch from `main`, keep changes focused.
2. Match the surrounding code style (comment density, naming, idiom).
3. Run the test suite (above) for any backend/dose change.
4. Describe **what** and **why** — especially any safety-relevant reasoning.
5. Be patient and kind in review. See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## Reporting bugs

Open an issue with: device + Android version, what you expected, what happened, and (if safe to share) anonymised reproduction steps. **Never paste another person's health data or credentials.**

## Security

Found a vulnerability? Please report it privately — see [SECURITY.md](SECURITY.md). Do not open a public issue for security problems.

## Translations

The app is bilingual FR/ES with English in the docs. UI strings live in `app/src/main/java/com/nueve/mechabetics/ui/Localization.kt`. New languages are very welcome — keep the medical wording careful and conservative.

---

By contributing, you agree your contributions are licensed under the project's **AGPL-3.0** licence.
