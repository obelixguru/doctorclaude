# Doctor Claude

**An open-source AI coaching companion for people living with type 1 diabetes.**
Reads your CGM data, remembers your history, and talks you through your day — gently, in plain language, in your own voice.

> A dad built an AI coach for his diabetic son. Then he opened it to everyone.

Doctor Claude started as a personal project: a father wanting to give his son with type 1 diabetes a calmer, smarter companion for the relentless daily work of managing glucose — a thing that watches the trend line, says something kind at 3 a.m., helps log a meal, and reminds him to check with his real doctor. It worked well enough that it felt selfish to keep it private. So here it is, open source, for the whole #WeAreNotWaiting community.

It is **not a doctor**, **not a medical device**, and it will never tell you what to do. It coaches, visualizes, and alerts. You keep your meter and your care team in the loop. Always.

---

## ⚠️ Important medical disclaimer — please read first

**Doctor Claude is NOT a medical device. It does NOT prescribe, diagnose, or treat anything.**

- This is a **do-it-yourself, community, at-your-own-risk** project — in the same spirit as Nightscout, Loop, AndroidAPS (AAPS), and xDrip+. It is not certified, cleared, or approved by any regulatory authority (FDA, CE/MDR, ANSM, etc.).
- **Any number you see related to insulin is calculated by deterministic code from ratios YOUR OWN DOCTOR gave you.** The AI language model never invents, guesses, or improvises a dose. Every suggestion is shown as *"to validate with your care team"* — a prompt to think, not an instruction to act.
- **Decisions about insulin, food, and treatment are yours and your medical team's.** Never act on this app alone. **Always confirm with a fingerstick / your meter and your healthcare professional.**
- Insulin is a dangerous drug. Getting it wrong can be life-threatening. If you are unsure, treat conservatively, test, and call your care team or emergency services.
- The app includes safety guardrails (see [Safety model](#safety-model)), a consent screen on first launch, a disclaimer under every AI suggestion, and a recurring *"don't follow the AI blindly"* reminder. These reduce risk; they do not remove it.

**If you do not accept these terms, do not use this app.**

This project is **not affiliated with, sponsored by, or endorsed by any CGM (continuous glucose monitor) manufacturer or any of their cloud services.** It talks to a generic, compatible CGM follower/share account that *you* already own and control.

---

## Features

- **Live glucose, in context.** Pulls readings from a compatible CGM follower ("share") cloud account and shows the current value, the trend arrow, and where the day is heading.
- **A conversational AI coach (persona "Claude").** Ask it "how was my night?", "why did I spike after lunch?", "what should I watch this afternoon?" — and get a calm, readable answer grounded in *your* data, not generic internet advice.
- **Day analysis & trends.** Time-in-range, the shape of your day, recurring patterns, gentle nudges.
- **Hypo / hyper alarms.** Out-of-range and rapid-change alerts so nothing sneaks up on you.
- **Meal, insulin & activity logging.** Quick capture by text or voice; optionally snap a photo of a plate for a rough carb conversation.
- **Gentle, non-prescriptive dose *suggestions*.** Computed by code from *your doctor's* correction factor / carb ratio / insulin-on-board — and only under strict safety conditions, always flagged "to validate".
- **Voice-capable.** Listen hands-free. Default voice is the **free, on-device Android text-to-speech**; an optional premium voice (ElevenLabs) is available in the Hosted tier.
- **Bilingual+ — French & Spanish** (and English), so it speaks the way your family speaks.
- **Privacy-first by default.** In the free tier, your history never leaves your phone.

---

## How it works

Doctor Claude is three simple stages wired together:

```
   ┌──────────────────────┐      ┌─────────────────────┐      ┌────────────────────────┐
   │  Your CGM's cloud     │      │  Local history       │      │  AI coach ("Claude")    │
   │  "follower / share"   │ ───▶ │  (on your phone)      │ ───▶ │  reads context, replies │
   │  account (you own it) │      │  Room / SQLite        │      │  in text + voice        │
   └──────────────────────┘      └─────────────────────┘      └────────────────────────┘
            rolling                  full history kept             deterministic dose math
          ~12–24h window             because the cloud             happens HERE, not in
          of readings                only keeps a short            the language model
                                     window
```

1. **Read.** The app authenticates to a *compatible CGM follower account that you already have* and fetches recent glucose readings. (The vendor's cloud only serves a rolling window of roughly the last 12–24 hours — see why history matters below.)
2. **Remember.** Because that window is short, the app stores readings locally so it can talk about your week, not just the last few hours. In the free tier this lives **only on your device**.
3. **Coach.** When you ask a question (or an alarm fires), the app assembles the relevant numbers, your own ratios, and recent logs, and asks a low-cost large language model (DeepSeek or Google Gemini Flash-Lite) to explain it back to you in warm, plain language — and reads it aloud if you want.
4. **The dose math is separate from the AI.** Any insulin-related figure is produced by **deterministic code** using *your doctor's* parameters, then handed to the model only so it can phrase it kindly. The model is never the one doing arithmetic on your insulin.

---

## Safety model

These guardrails are built in and intentional:

- **A dose suggestion appears only when** glucose is **> 180 mg/dL** *and* the trend is **stable or rising**.
- **Insulin-on-board (IOB) is deducted** so the app doesn't stack corrections on top of insulin already working.
- **No suggestion when** glucose is **falling**, **post-hypo**, or when the **data is stale** (too old to trust).
- **Hypoglycemia → fast sugar.** On a low, the app suggests fast-acting carbohydrate scaled by **body weight**, not a dose of insulin.
- **All dose figures are derived from the user's own doctor-provided ratios** (correction factor, insulin-to-carb ratio, targets). The language model contributes *words*, never *numbers*.
- **Consent gate** on first launch; a **dose disclaimer** under every suggestion; a **periodic "don't follow blindly, validate, keep your meter & doctor in the loop"** reminder.

When in doubt, the app's job is to say: *test, go conservative, and ask your care team.*

---

## Privacy & your data

We try to be honest about this, because it's health data.

- **Glucose is special-category health data** under the GDPR (**Article 9**). We treat it that way.
- **Free / BYOK tier = on-device only.** Your readings and history are stored locally on your phone (Room/SQLite). **Nothing leaves the device.** No cloud account, no sign-in, no server — maximum privacy. There is literally nothing for us to lose or hand over, because we never receive it.
- **Hosted tier (paid, opt-in) = pseudonymous cloud sync.** If — and only if — you choose Hosted, your history syncs to a server so it follows you across devices. The account identifier we store is a **sha256 hash, never your name**. This is **pseudonymous, but it is still personal data** and we say so plainly. Hosted is gated by an **explicit consent screen** and a **privacy policy**, and includes a **"delete my data"** button.
- The CGM cloud connection uses credentials *you* provide for an account *you* own.
- Full details: **[docs/PRIVACY.md](docs/PRIVACY.md)** (English) · **[docs/PRIVACY.fr.md](docs/PRIVACY.fr.md)** (Français).

---

## BYOK setup (Bring Your Own Key)

The free tier runs on **your own free Google Gemini API key**. Your key stays on your device and is used to call the model directly. Marginal AI cost to the project: essentially zero — which is exactly why the free tier can exist.

To get a key (takes about two minutes, no credit card for the free tier):

1. Go to **[Google AI Studio](https://aistudio.google.com/)** and sign in with a Google account.
2. Open **"Get API key"** (left menu) → **"Create API key"**.
3. Choose/confirm a project when prompted, then **copy** the key it generates.
4. In Doctor Claude, open **Settings → AI key (BYOK)** and **paste** it.
5. Done. The coach now runs on your key, on your device.

> Don't want to manage a key? That's exactly what the **Hosted** tier is for — we run the keys for you (see Tiers).

---

## Tiers

| | **Free / BYOK** | **Doctor Claude Hosted** | **Donations** |
|---|---|---|---|
| **Price** | Free | Paid subscription | Pay what you like |
| **AI** | Your own Gemini key | Our managed keys | — |
| **History** | On-device only | Pseudonymous cloud sync | — |
| **Voice** | Free on-device Android TTS | Premium voice (ElevenLabs) + on-device | — |
| **Privacy** | Nothing leaves your phone | Pseudonymous (sha256 id) + consent + delete button | — |
| **Best for** | Privacy-maximalists & tinkerers | People who'd rather not manage keys | Anyone who wants to keep this alive |

- **Free / BYOK** keeps the project sustainable because each user brings their own AI cost and stores their own data.
- **Hosted** is the escape hatch for people who won't (or can't) manage an API key, and funds the project's own infrastructure.
- **Donations** are hugely appreciated and keep development going:
  - Ko-fi: **https://ko-fi.com/doctorclaude** (routes to the maintainer's PayPal)

---

## Build from source

You'll need the Android SDK and a JDK. The easiest JDK is the one **bundled with Android Studio** (Jellyfish/Koala or newer ships JDK 21).

```bash
git clone https://github.com/obelixguru/doctorclaude.git
cd doctorclaude

# Point JAVA_HOME at the JDK bundled with Android Studio
# (adjust the path to wherever Android Studio is installed on your machine)
#   macOS:   /Applications/Android Studio.app/Contents/jbr/Contents/Home
#   Linux:   ~/android-studio/jbr
#   Windows: "C:\Program Files\Android\Android Studio\jbr"
export JAVA_HOME="/path/to/Android Studio/jbr"   # PowerShell: $env:JAVA_HOME = "...\jbr"

# Build a debug APK
./gradlew assembleDebug                          # Windows: .\gradlew.bat assembleDebug

# Output APK:
#   app/build/outputs/apk/debug/DoctorClaude-debug.apk

# Install onto a connected device / emulator
adb install -r app/build/outputs/apk/debug/DoctorClaude-debug.apk
```

> Tip: `local.properties` must point `sdk.dir` at your Android SDK. Android Studio sets this for you automatically the first time you open the project.

---

## Tech stack

- **App:** Kotlin + Jetpack Compose (Android), local persistence via Room / SQLite.
- **Backend (Hosted tier):** Supabase (Postgres + Edge Functions for the coach/ask/scan endpoints), protected by Row-Level Security.
- **AI:** DeepSeek and Google Gemini (Flash-Lite class) — cheap, fast models. BYOK uses your own Gemini key.
- **Voice:** Android on-device Text-to-Speech (default, free) with optional ElevenLabs premium voice in Hosted.
- **Languages:** French, Spanish, English.

---

## Contributing

Pull requests, issues, translations, and field reports from fellow people-who-aren't-waiting are all welcome. Please read:

- **[CONTRIBUTING.md](CONTRIBUTING.md)** — how to build, test, and submit changes, **and the one non-negotiable safety rule** (the language model must never emit a dose number; all dose math stays in deterministic code).
- **[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)** — be kind; this is a community of patients and families.
- **[SECURITY.md](SECURITY.md)** — how to report a vulnerability privately.

## Community

Doctor Claude stands on the shoulders of the **#WeAreNotWaiting** movement. If you're new to DIY diabetes tech, go meet the giants:

- **Nightscout** — open-source CGM in the cloud / "CGM in the Cloud".
- **Loop** (iOS) and **AndroidAPS / AAPS** (Android) — open-source automated insulin delivery.
- **xDrip+** — the Swiss-army-knife CGM app.
- **r/diabetes** and **r/Type1Diabetes** on Reddit, and your local **diabetes patient associations** (e.g. Fédération Française des Diabétiques, JDRF/Breakthrough T1D, ADA, and others in your country).

These communities are the reason any of this is possible. Be generous back.

---

## Licence

**GNU Affero General Public License v3.0 (AGPL-3.0).** See **[LICENSE](LICENSE)**.

Copyright (C) 2026 Nueve (hello@nueveapp.com).

The AGPL means: you are free to use, study, share, and modify Doctor Claude — and if you run a modified version as a network service, you must offer your users the corresponding source. We chose it on purpose, to keep this project and its derivatives open for the community that inspired it.

---

## A final word

You know your body better than any app. Doctor Claude is a companion for the long, tiring marathon of type 1 — a second pair of eyes, a calm voice, a memory that doesn't sleep. It is not a replacement for your meter, your judgment, or your medical team. Keep all three close.

Take care of yourselves. 💙

*Built with love by a dad, for his son, and for everyone still doing the daily work. — Nueve · hello@nueveapp.com*

*Not affiliated with or endorsed by any CGM manufacturer. "Claude" is the in-app coaching persona of this project.*
