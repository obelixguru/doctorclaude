# Play Store listing copy

> ⚠️ **Trademark rule — keywords to AVOID.** Do **not** use any CGM-vendor trademark in the title, short description, or keywords: **"LibreLink", "FreeStyle", "Libre", "Dexcom", "Abbott"**, etc. Removal/trademark risk, and you won't outrank the vendor anyway. Refer generically to a *"compatible CGM (continuous glucose monitor) share/follower account"*. Growth comes from community, not ASO.

## Category & rating
- **Category:** Health & Fitness (or Medical — note that Medical gets stricter review; Health & Fitness is usually appropriate for a non-prescriptive coach).
- **Content rating:** Everyone. The app may be used by a parent for a minor; no objectionable content.
- **Health disclaimer:** include the non-prescriptive / not-a-medical-device disclaimer in the description (below) and in-app (already implemented as a consent gate + per-suggestion disclaimer).
- **Ads:** none. **In-app purchases:** the optional Hosted subscription (declare it).

---

## English

**Title (≤30 chars):**
`Doctor Claude: Diabetes Coach`

**Short description (≤80 chars):**
`A calm AI coach for type 1 diabetes. Your CGM data, explained — in your voice.`

**Full description (≤4000 chars):**
```
Doctor Claude is an open-source AI coaching companion for people living with type 1 diabetes — and for the families who help them.

A dad built it for his diabetic son, then opened it to everyone.

WHAT IT DOES
• Reads glucose from a compatible CGM share/follower account you already own.
• Explains your day in plain language: time in range, the shape of your curve, what to watch next.
• Talks with you. Ask "how was my night?" or "why did I spike after lunch?" and get a calm, readable answer grounded in YOUR data.
• Hypo / hyper alarms and proactive heads-ups before things drift out of range.
• Quick logging of meals, insulin and activity — by text or voice.
• Voice-capable, with a free on-device voice by default.
• French, Spanish and English.

NOT A MEDICAL DEVICE
Doctor Claude does not prescribe, diagnose, or treat. It is a do-it-yourself, at-your-own-risk companion in the spirit of the #WeAreNotWaiting community (Nightscout, Loop, AndroidAPS, xDrip+). Any insulin-related number is calculated by deterministic code from ratios YOUR OWN DOCTOR gave you — the AI never invents a dose — and is always shown "to validate with your care team". Always confirm with your meter and your healthcare professional. Insulin is dangerous; never act on this app alone.

PRIVACY FIRST
In the free tier, your history stays on your phone — nothing leaves the device. An optional Hosted tier adds pseudonymous cloud sync with explicit consent and a "delete my data" button. Glucose is special-category health data and we treat it that way.

FREE, BRING-YOUR-OWN-KEY
The free tier runs on your own free Google AI (Gemini) key, so the cost to you is essentially zero. Prefer not to manage a key? The optional Hosted subscription runs it for you and adds a premium voice.

Open source (AGPL-3.0). Not affiliated with or endorsed by any CGM manufacturer.

Take care of yourselves. 💙
```

**Keywords / tags (safe):** diabetes, type 1 diabetes, T1D, CGM, glucose, coach, time in range, hypo, hyper, carb counting, open source.

---

## Français

**Titre (≤30 car.) :**
`Doctor Claude : Coach Diabète`

**Description courte (≤80 car.) :**
`Un coach IA serein pour le diabète type 1. Ta glycémie, expliquée, à ta voix.`

**Description complète (≤4000 car.) :**
```
Doctor Claude est un compagnon de coaching IA open-source pour les personnes vivant avec un diabète de type 1 — et pour les familles qui les accompagnent.

Un papa l'a créé pour son fils diabétique, puis l'a ouvert à tout le monde.

CE QU'IL FAIT
• Lit la glycémie depuis un compte suiveur/de partage CGM compatible que vous possédez déjà.
• Explique votre journée simplement : temps dans la cible, forme de la courbe, ce qu'il faut surveiller.
• Dialogue avec vous. Demandez « comment s'est passée ma nuit ? » et obtenez une réponse claire, fondée sur VOS données.
• Alarmes hypo / hyper et anticipations avant que ça ne dérive.
• Journal rapide des repas, de l'insuline et de l'activité — au texte ou à la voix.
• Voix intégrée, gratuite et sur l'appareil par défaut.
• Français, espagnol et anglais.

PAS UN DISPOSITIF MÉDICAL
Doctor Claude ne prescrit pas, ne diagnostique pas, ne traite pas. C'est un compagnon DIY, à vos risques, dans l'esprit de la communauté #WeAreNotWaiting. Tout chiffre lié à l'insuline est calculé par du code déterministe à partir des ratios donnés par VOTRE médecin — l'IA n'invente jamais de dose — et toujours affiché « à valider avec votre équipe soignante ». Vérifiez toujours avec votre lecteur et un professionnel de santé. L'insuline est dangereuse ; n'agissez jamais sur la seule base de l'app.

LA VIE PRIVÉE D'ABORD
En version gratuite, votre historique reste sur votre téléphone — rien ne le quitte. Une option Hosted ajoute une synchro cloud pseudonyme, avec consentement explicite et un bouton « supprimer mes données ».

GRATUIT, AVEC VOTRE PROPRE CLÉ
La version gratuite tourne sur votre propre clé Google AI (Gemini) gratuite. Vous préférez ne pas gérer de clé ? L'abonnement Hosted s'en charge et ajoute une voix premium.

Open source (AGPL-3.0). Non affilié à aucun fabricant de CGM.

Prenez soin de vous. 💙
```

---

## Data safety form (Play Console) — suggested answers

**Free / BYOK (default) mode:** the app does **not collect or share** any user data — glucose history is stored only on the device. (On-device storage is not "collection" under Play's definition.)

**Hosted (opt-in) mode, if you enable it:**
- **Data collected:** Health & fitness info (glucose readings, meal/insulin/activity logs). Identifiers: a **pseudonymous app-generated id** (sha256), **not** name/email tied to health data.
- **Collected, not shared** with third parties for advertising. Processed by sub-processors (hosting, AI, voice) **only to provide the service**.
- **Encryption in transit:** yes.
- **User can request deletion:** yes (in-app "delete my data" + email).
- **Data is processed on the basis of consent**, and Hosted is optional.

Provide your published **privacy-policy URL** (host `docs/PRIVACY.md`). Declare the **Hosted subscription** as an in-app purchase.
