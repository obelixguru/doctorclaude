# MASTER PLAN — Dr Claude (Mechabetics)

> Audit du 2026-07-30 (Fable 5, 5 agents d'exploration + vérifications croisées dans le code).
> Document destiné à une exécution **planner-worker (Opus 5)** : chaque Work Package (WP) est
> autonome, avec cause racine sourcée `fichier:ligne`, spec, critères d'acceptation et tests.
> Les numéros de ligne datent du commit `dcad09a` (master) — re-vérifier avant d'éditer.


> **ÉTAT D'EXÉCUTION — 2026-07-30 (Fable 5).** WP-0 à WP-8 sont **implémentés, testés et
> déployés** (edge functions) ; l'APK debug est construit mais **pas installé** sur le téléphone
> (acte utilisateur). Tests : 103 côté serveur (deno, 0 échec, baseline master = 80),
> `:app:testDebugUnitTest` vert. WP-9 : audit fait, **la bascule `REQUIRE_TOKEN` n'a PAS été
> faite** — voir le rapport final. Deux actions restent côté utilisateur : (1) la clé Gemini
> vision du serveur est refusée (c'est la vraie cause du scan photo), (2) installer l'APK.

---

## 0. Contexte technique (à lire par CHAQUE worker)

**Stack.** App Android Kotlin + Jetpack Compose (`app/src/main/java/com/nueve/mechabetics/`,
~11 500 lignes) + Supabase Edge Functions Deno/TS (`supabase/functions/mechabetics-*`,
logique partagée dans `supabase/functions/_shared/`). Pas de Navigation Compose : les écrans
sont commutés par des booléens/`Tab` dans `MainActivity.kt:664-819`.

**Invariant de sécurité NON NÉGOCIABLE** (CONTRIBUTING.md) : le LLM ne produit **jamais** un
chiffre de dose. Tout le calcul de dose vit dans `_shared/doseGuard.ts` (pur, déterministe,
testé). Le code appose la ligne `Action :` après coup. Tout WP qui touche au conseil de dose
passe par `doseGuard`, jamais par le prompt.

**Contraintes de code connues (pièges vérifiés) :**
- `Localization.kt` : l'interface `Strings` est à 252 propriétés, plafond dex `invoke-range`
  ≈ 254 → **toute nouvelle chaîne UI va dans `BgStrings`** (`Localization.kt:812-838`, accès
  `bgStringsFor(lang)`) ou un nouveau holder. Ajouter dans `Strings` = `VerifyError` runtime
  qui compile sans erreur (documenté à `Localization.kt:806-811`).
- Toute chaîne visible existe en **FR et ES** (client) ; les messages serveur ont les deux
  variantes inline (`lang === "es" ? … : …`).
- Ne pas renommer le package `com.nueve.mechabetics` (installs existants).
- Les modules `_shared/*.ts` restent du **TypeScript pur** (pas d'API Deno/Node) pour être
  testables des deux côtés.
- Le schéma DB n'est **pas** dans le repo (pas de migrations sur master) : la forme des tables
  s'infère des edge functions (`mechabetics_meals` : `id, ts, description, carbs_g, planned,
  quantity` — cf. `mechabetics-meals/index.ts:189`).

**Commandes (spécifiques à cette machine) :**
```bash
# Tests edge functions (PAS node --test : Node 20 ne charge pas les .ts)
deno test --allow-read --no-check supabase/functions/_shared/doseGuard.test.ts supabase/functions/_shared/predict_autotune.test.ts
# Baseline 2026-07-26 : 83 tests verts.

# Build APK
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
export ANDROID_HOME="$HOME/Library/Android/sdk"
./gradlew :app:assembleDebug   # → app/build/outputs/apk/debug/DoctorClaude-debug.apk

# Tests unitaires app (AlarmBehaviorTest, SignalStalenessTest)
./gradlew :app:testDebugUnitTest

# Déploiement d'une edge function (depuis la racine du repo, ref OBLIGATOIRE)
npx --yes supabase functions deploy <nom> --project-ref vzafttfgrxpjdraveihh
```
⚠️ Le build debug (`com.nueve.mechabetics.debug`) est l'app **réellement utilisée par la
famille** sur le téléphone de test. Les correctifs serveur ne partent QUE via le deploy.

**Atout majeur découvert : la branche `fix/dose-engine-and-launch-crash`** (tip `e0bba66`,
non fusionnée). Le commit `01482a7` « Dose the meal, and dose it BEFORE eating » contient
déjà le moteur prospectif complet (+368 lignes dans `doseGuard.ts` : `carbsOnBoard`,
`planMealDose`, `mealBolusPlan`, `mealTimingLine`, `isHypoRescue`…). Master a subi un
rollback (`6cd1f34` n'a réappliqué que les « améliorations sûres »). Les WP-0 et WP-7
**portent** ce travail au lieu de le réécrire — après enquête sur la raison du rollback.

---

## 1. Vue d'ensemble des Work Packages

| WP | Tâche utilisateur | Priorité | Taille | Côté | Dépend de |
|----|-------------------|----------|--------|------|-----------|
| WP-0 | (découvert en audit) un repas quelconque bloque le conseil d'hypo | **P0 sécurité** | S | serveur | — |
| WP-1 | Analyse vocale « pain blanc » inventé | **P0** | S | serveur | — |
| WP-2 | Alarmes unifiées (zones 60/70/170/180) sur app, push ET Telegram ; stop au « ça sonne à l'ouverture » | **P0** | M | app + serveur + ops | — |
| WP-3 | Bandeau « audio en cours » + STOP | P1 | S | app | — |
| WP-4 | Scan photo : faux « mode hosted pas actif » | P1 | S | serveur (+ops) | — |
| WP-5 | Tap sur point du graphe → ouvre le repas/l'insuline | P1 | M | app + serveur | — |
| WP-6 | Suggestions « il y a 10/15/20/30 min » sur la date | P1 | S | app | — |
| WP-7 | Repas futurs : « 30 sucres dans 10 min » → anticipation | **P1 (cœur produit)** | L | serveur + app | WP-0 |
| WP-8 | « Sucre encore actif » (COB) visible page Repas | P2 | M | app | WP-7 (logique) |
| WP-9 | (validé utilisateur) Trous de sécurité : token serveur, fraîcheur monitor, IOB du service | P1 | M | serveur + app | — |

Ordre d'exécution recommandé : **WP-0 → WP-1 → WP-2** (les trois urgences, parallélisables),
puis WP-3/WP-4/WP-5/WP-6/WP-9 en parallèle, puis WP-7, puis WP-8. Le backlog §3 vient après.

---

## 2. Work Packages détaillés

### WP-0 — [SÉCURITÉ] N'importe quel repas compte comme « resucrage récent »

**Constat (audit).** `minutesSinceLastRescue` (`_shared/doseGuard.ts:149-157`) ne filtre ni
les glucides ni la description : 80 g de riz enregistrés 10 min avant une glycémie à 65
déclenchent la gate `sugar_recent` (`doseGuard.ts:91`) et l'app répond « tu as déjà pris du
sucre, attends 15 min » — alors que du riz ne remonte rien en 15 min. Corrigé **uniquement**
sur la branche (`isHypoRescue` + `RESCUE_MAX_CARBS = 25`, branche `doseGuard.ts:146-166`).

**Spec.** Porter `isHypoRescue`/`RESCUE_MAX_CARBS` de `01482a7` sur master : seul un vrai
resucrage (sucre rapide, ≤ 25 g) alimente `minutesSinceLastRescue`. Reprendre les tests de
la branche s'ils existent, sinon en écrire (riz 80 g ne bloque pas ; 3 sucres bloquent).

**Fichiers.** `supabase/functions/_shared/doseGuard.ts`, `doseGuard.test.ts`.
**Acceptation.** Test : glycémie 65 + repas riz 80 g il y a 10 min → le guard recommande le
resucrage (pas de gate `sugar_recent`). Suite deno verte. Déployer **toutes** les fonctions
qui importent doseGuard (`mechabetics-ask`, `-coach`, `-scan`, `-meals`, `-monitor` selon
imports réels).

---

### WP-1 — L'analyse vocale « invente » du pain blanc

**Cause racine (confirmée dans le code — ce n'est PAS une hallucination du LLM).**
Le conseil codé en dur `carbSpeedAdvice` contient la liste d'exemples
« Sucre rapide (jus, bonbons, pain blanc…) » (`_shared/doseGuard.ts:657` version repas
annoncé, `:661` version repas passé). `mechabetics-ask/index.ts:501-505` l'ajoute à
**`voiceText`** ; lu par la TTS (parenthèses inaudibles), l'utilisateur entend « …tu as pris
du pain blanc… ». Le « 8 sucres » entendu juste avant vient du bloc précédent
(`carbsCubesPhrase`, `doseGuard.ts:278-288`, ajouté à `ask/index.ts:487-492`) : 32 g ÷ 4.
Le mot « sucre » de l'utilisateur matche `FAST_CARB_WORDS` (`doseGuard.ts:604+`) → le
conseil part à chaque fois. Même mécanique dans `mechabetics-scan/index.ts:366`.

**Spec.**
1. Séparer version écrite / version orale : `carbSpeedAdvice` garde les exemples à l'écrit,
   mais la chaîne concaténée à `voiceText` ne doit contenir **aucun nom d'aliment** —
   p.ex. « Sucre rapide : la glycémie monte très vite (pic 15 à 45 minutes)… ». Faire pareil
   en ES, et pour les branches `slow`/fatty si elles citent des aliments. Appliquer aux deux
   appelants (`mechabetics-ask/index.ts:501-507`, `mechabetics-scan/index.ts:366`).
   Règle générale à retenir : **tout texte destiné à la TTS doit être écoutable tel quel**
   (pas de parenthèses d'exemples, pas de « ≈ », pas d'ellipses).
2. Fenêtrer les repas du prompt : `mechabetics-ask/index.ts:302-304` sélectionne les 6
   derniers repas **sans borne temporelle** (un repas d'il y a 3 semaines est présenté au
   modèle comme « REPAS RÉCENTS »). Ajouter `.gte("ts", now − 26 h)` (aligné sur le coach,
   `mechabetics-coach/index.ts:713`). Idem `mechabetics-scan/index.ts:283-285`.
3. Ajouter une clause anti-invention dans le prompt d'ask (`ask/index.ts:216-243`), calquée
   sur celle du régime (`mechabetics-diet/index.ts:172` « n'invente jamais un aliment ») :
   ne jamais nommer un aliment que l'utilisateur n'a pas mentionné ou qui n'est pas dans
   REPAS RÉCENTS.
4. Vérifier la table `mechabetics_prompts` (overrides runtime chargés à `ask/index.ts:59-72`)
   — hors repo, à inspecter via le dashboard Supabase : si `ask.persona`/`ask.sugar` y sont
   surchargés avec des exemples d'aliments, les nettoyer aussi.

**Fichiers.** `_shared/doseGuard.ts`, `mechabetics-ask/index.ts`, `mechabetics-scan/index.ts`,
tests deno.
**Acceptation.** Test unitaire : la chaîne retournée pour la voie orale ne contient aucun
élément de `FAST_CARB_WORDS`/`SLOW_CARB_WORDS`. Test manuel : dire « j'ai pris du sucre il y
a 15 minutes » → l'audio ne cite plus aucun aliment non mentionné. Déploiement : ask + scan.

---

### WP-2 — Alarmes unifiées (app, push, Telegram) + fin du « ça sonne à l'ouverture »

**Référence Telegram (la mécanique que l'utilisateur aime — les SEUILS, eux, changent,
cf. décision utilisateur dans la spec)** — `supabase/functions/mechabetics-monitor/index.ts` :
- Seuils actuels : LOW < 70 (`:24`), HIGH > 180 par défaut **mais le secret live vaut 240
  d'après le commentaire `:25-28`**. VERY_LOW 50 ne change que le texte.
- **Règle cœur de dé-duplication** : n'alerte que si un **palier de 10 mg/dL** est franchi
  entre la lecture précédente et l'actuelle (`Math.floor(prev/10) !== Math.floor(cur/10)`,
  `:167-170`, `:178`, `:182`). Stagner à 250 = silence. `prev` = lecture d'il y a ~5 min,
  réécrite à chaque run (`:369-388`).
- Retour en zone : un seul message « ✅ revenue à la normale » (`:176-177`).
- **Aucun** cooldown temporel, aucune quiet hour, aucune alerte de pente.

**Ce que fait l'app aujourd'hui et pourquoi ça sonne à l'ouverture.**
La décision de sonner existe en **deux copies divergentes** : `AlarmEngine.decide`
(`data/AlarmEngine.kt:27-68`, testée) pour le service en arrière-plan, et une copie inline
dans `MainActivity.kt:533-546` pour le premier plan — qui, elle, n'a **pas** le palier HIGH
ajouté par `6cd1f34` (régression : le test
`sittingHigh_neverReRingsOnTime_butDoesOnANewPalier`, `AlarmBehaviorTest.kt:137-144`, est
vert alors que l'UI viole exactement ce qu'il affirme, car l'UI n'appelle pas l'engine).
Trois mécanismes précis font sonner à chaque ouverture :
- **(A) Snapshot périmé** : `firedAlert`/`ackAlert` sont capturés une fois dans Compose
  (`MainActivity.kt:492-493`) pendant que `MonitorService` réécrit les mêmes clés en
  arrière-plan (`MonitorService.kt:117-126`). À la réouverture, `newEpisode = firedAlert !=
  kindName` (`:535`) est vrai à tort → le snooze est court-circuité (`:543`) → sonnerie
  (`:552-556`). L'`AlarmService.stop()` du `onResume` (`:967`) remet `isRinging=false`
  juste avant, ce qui réarme le carillon.
- **(B) Re-sonnerie temporelle HIGH** : au premier plan, `snoozed` n'a pas de terme
  `worseningHigh`/palier → toute ouverture > 20 min après la dernière sonnerie, en
  hyperglycémie persistante (cas fréquent au-dessus de 180), sonne.
- **(C) `START_STICKY`** (`AlarmService.kt:63`) : l'OS peut recréer le service avec un
  intent null → carillon par défaut sans donnée derrière (`:52-59`).

**Spec.**
1. **Une seule source de décision** : supprimer le bloc inline de `MainActivity.kt:510-556`
   au profit d'un appel à `AlarmEngine.decide(...)`, avec l'état (`firedAlert`,
   `lastAlarmMs/Value`, `prevValue`…) lu **frais depuis `CredentialsStore` au moment de
   l'évaluation** (jamais depuis `remember`). Le commentaire mensonger `AlarmEngine.kt:8-10`
   (« ne peuvent pas diverger ») devient enfin vrai.
2. **Modèle de zones unifié — DÉCISION UTILISATEUR DU 2026-07-30, remplace les seuils
   actuels des DEUX côtés (app et Telegram)** :

   | Zone | Bornes (mg/dL) | À l'entrée de la zone | Ré-alerte dans la zone |
   |------|----------------|----------------------|------------------------|
   | ROUGE BAS | < 60 (sévère : < 54) | carillon alarme / Telegram 🚨 | palier de **5** ; le franchissement de 54 alerte TOUJOURS (corrige le silence 55→50 actuel, `monitor/index.ts:178-179`) |
   | ORANGE BAS | 60–69 | notification discrète / Telegram ⚠️ | aucune (l'aggravation fait entrer en rouge) |
   | NORMALE | 70–170 | message « revenue à la normale » (sans carillon) au retour | — |
   | ORANGE HAUT | 171–180 | notification discrète / Telegram ⚠️ | aucune |
   | ROUGE HAUT | > 180 | carillon alarme / Telegram 🚨 | palier de **10** (la règle Telegram actuelle) |

   - une alerte ne part que sur **nouvelle lecture** (changement de `timestampMs`, cadence
     capteur ~5 min) et sur **aggravation de zone** ou franchissement de palier ; stagner
     dans une zone = silence ; persister `prevValue`/`prevZone` dans le store ;
   - amélioration rouge→orange : silencieuse (mise à jour de la notification existante) ;
     seul le retour en zone NORMALE émet le message de retour ;
   - supprimer la re-sonnerie au bout du snooze de 20 min et la notion d'épisode pour la
     décision sonore (le bandeau à l'écran peut garder sa logique d'épisode/ACK) ;
   - **garder** les suppresseurs silencieux côté app : fraîcheur 15 min
     (`GlucoseAlert.kt:44`), suppression des tiers HAUTS sous IOB (`:104-105`), quiet hours
     (`AlarmPolicy.kt`) — le ROUGE BAS continue de percer les quiet hours ;
   - **RAPID_FALL ne sonne plus** (bannière in-app seule) et RAPID_RISE reste bannière —
     validé par l'utilisateur le 2026-07-30.
3. **Côté Telegram (`mechabetics-monitor`)** : implémenter le même modèle de zones (le code
   actuel n'a que deux seuils + la règle des dizaines, `monitor/index.ts:167-186`). Env vars
   explicites avec ces défauts (60/70/170/180/54). **Ops** : mettre à jour les secrets du
   projet — `MECHABETICS_HIGH` vaut 240 en live d'après `monitor/index.ts:25-28`, il doit
   redevenir 180 (ou être supprimé au profit du nouveau défaut) ; ajuster `MECHABETICS_LOW`
   et `MECHABETICS_VERY_LOW` (50 → 54) de même. Déployer monitor.
4. `AlarmService` : `START_NOT_STICKY` ; dans `onResume`, ne plus enchaîner stop-puis-
   réévaluation qui re-sonne (avec la règle de zones, une ouverture sans nouvelle lecture
   ne sonne plus de toute façon).
5. Réécrire/étendre `AlarmBehaviorTest.kt` sur la nouvelle sémantique : stagnation à 250 →
   silence ; 175→185 → carillon ; 165→172 → notification discrète ; 185→192 → silence
   (même palier) ; 55→49 → carillon (sévère, plus jamais silencieux) ; ouverture de l'app
   sans nouvelle lecture → silence ; 185→160 → message de retour sans carillon ; données
   périmées → rien. Ajouter un test garantissant que le chemin UI et le chemin service
   passent par la même fonction (décision pure, plus aucune logique de décision dans
   MainActivity).

**Fichiers.** `data/AlarmEngine.kt`, `data/GlucoseAlert.kt`, `MainActivity.kt`,
`AlarmService.kt`, `data/CredentialsStore.kt` (clés `prevValue`/`prevZone`),
`MonitorService.kt`, `supabase/functions/mechabetics-monitor/index.ts`,
`AlarmBehaviorTest.kt`, `Localization` (nouvelles chaînes → `BgStrings`).
**Acceptation.** Ouvrir l'app en hyper stable → **aucun son**. Mêmes lectures → mêmes
alertes aux mêmes moments sur les trois canaux (app au premier plan, notification locale,
Telegram), avec les seuils 60/70/170/180 identiques partout. 55→49 alerte toujours.
`./gradlew :app:testDebugUnitTest` vert ; deploy monitor fait.

---

### WP-3 — Bandeau global « lecture audio » avec STOP

**Cause racine.** `AnalysisService.stopSpeaking()` existe et marche
(`ai/AnalysisService.kt:527-532`), l'état `speaking: StateFlow<Boolean>` existe (`:70-71`)
et est déjà collecté (`MainActivity.kt:160`) — mais le **seul** bouton stop de l'app est
dans une carte du Dashboard qui n'apparaît que si `aiText` est non vide et < 20 min
(`DashboardScreen.kt:911`, TTL `:844`). Or une réponse vocale ne remplit pas `aiText`
(`MainActivity.kt:238-251`), et les onglets Repas/Injections n'ont aucun contrôle alors que
`FoodScreen.kt:94/:114` **lance** de l'audio (scan). Aucun Snackbar/Toast dans l'app.

**Spec.** Ajouter un bandeau global dans le `Scaffold` de `MainActivity.kt:628-657`, empilé
avec `NetworkBanner` (`:653`) et `ServiceHealthBanner` (`:656`) : visible quand
`isSpeaking`, texte court (« Lecture en cours… ») + bouton STOP → `ai.stopSpeaking()`.
Présent sur **tous** les onglets, couvre **toutes** les sources (ask vocal, scan, coach,
replay). Réutiliser `s.stopVoice` si utilisable, sinon nouvelles chaînes **dans `BgStrings`**
(FR+ES). S'inspirer des deux bandeaux existants pour le style.
**Fichiers.** `MainActivity.kt`, éventuellement `ui/DashboardScreen.kt` (extraction du
composable bandeau), `ui/Localization.kt` (BgStrings).
**Acceptation.** Depuis chaque onglet : lancer un scan/une question vocale → le bandeau
apparaît pendant la lecture, STOP coupe le son immédiatement (MediaPlayer **et** TTS
native), le bandeau disparaît à la fin naturelle de la lecture.

---

### WP-4 — Scan photo : faux « mode hosted pas actif »

**Cause racine.** Le mode hosted est un booléen local envoyé au serveur (`putAiFlags`,
`ai/AnalysisService.kt:80-85`) — le plumbing client du scan est identique aux autres
features. Mais côté serveur, `mechabetics-scan` est la **seule** fonction qui a besoin de
clés vision (`MECHABETICS_ANTHROPIC_API_KEY` `scan/index.ts:38`,
`MECHABETICS_GEMINI_API_KEY` `:40`) — ask/coach/diet tournent sur
`MECHABETICS_DEEPSEEK_API_KEY`. Le second garde-fou (`scan/index.ts:249-253`) se déclenche
quand **aucune clé vision n'est configurée côté serveur, sans regarder `body.hosted`**, avec
un message qui dit « …ou active le mode Hosted » à un utilisateur déjà en hosted.
Hypothèse n°2 (à tester) : modèle Anthropic épinglé `claude-sonnet-4-6` (`:39`) → un 404
n'est pas « transient » (`:210`) → retour immédiat (`:221`) **sans** essayer le fallback
Gemini configuré (`:216-219`) → bannière AUTH trompeuse (`Localization.kt:486`).

**Spec.**
1. **Ops d'abord** : vérifier sur le dashboard Supabase que les secrets
   `MECHABETICS_ANTHROPIC_API_KEY` et/ou `MECHABETICS_GEMINI_API_KEY` existent pour le
   projet `vzafttfgrxpjdraveihh` (ils ne sont documentés nulle part — `docs/ACTIVATION.md`
   ne liste que les secrets de noms de modèles). Les créer si absents : c'est probablement
   LE fix immédiat du symptôme.
2. Corriger le message du garde-fou `scan/index.ts:249-253` : si `body.hosted === true`,
   répondre « Scan indisponible côté serveur (configuration) — réessaie plus tard » (FR+ES),
   sans jamais suggérer d'activer un mode déjà actif.
3. Ajouter `errorKind` aux deux early-returns `:244-253` : aujourd'hui leur absence fait
   passer `AnalysisService.kt:403` par `reportAiOk()` — une panne de config **efface** la
   bannière de santé au lieu de la lever.
4. Fallback vision : à `scan/index.ts:210-221`, sur échec Anthropic non-transient
   (404/400), tenter quand même `GEMINI_API_KEY` avant de rendre l'erreur. Vérifier au
   passage que le modèle épinglé `claude-sonnet-4-6` existe encore (sinon corriger le
   défaut).
**Fichiers.** `supabase/functions/mechabetics-scan/index.ts` (+ éventuellement
`ai/AnalysisService.kt` si mapping `errorKind` à ajuster). Déploiement : scan.
**Acceptation.** En hosted sans clé BYOK : le scan d'une photo aboutit (si secrets posés) ;
si le serveur est réellement mal configuré, le message ne parle plus du mode hosted et la
bannière santé s'allume au lieu de s'éteindre.

---

### WP-5 — Tap sur un point du graphe → ouvre le repas / l'insuline

**État des lieux.** Les événements du graphe (`GlucoseGraph.kt`) : repas = **rouge**,
insuline = **vert** (mnémonique de l'utilisateur, commentaire `:56-58`). Un tap sur point
ouvre aujourd'hui un badge d'aperçu in-graph (`:310-348`) ; un tap hors point appelle
`onBackgroundClick` → historique (Dashboard). Deux vraies causes du ressenti « tout ouvre
l'historique » : le hit-test utilise un rayon en **pixels bruts** (rayon 14f, slop 44.0,
`:186`, `:296-300`) ≈ 14,7 dp à densité 3× → presque tous les taps ratent le point ; et
`ChartCard` a un `.clickable` sur toute la Surface (`DashboardScreen.kt:776`) en plus du
gesture handler du canvas. De plus `GraphEvent` (`GlucoseGraph.kt:54`) ne porte **aucun id**
: l'id insuline est jeté à la construction (`:94`), et le serveur n'envoie même pas l'id des
repas (`mechabetics-history/index.ts:99` sélectionne `ts, planned, description, carbs_g`
sans `id`, contrairement aux insulines `:91`). Les éditeurs existent mais sont des
`AlertDialog` à état local privé (`FoodScreen.kt:244-320`, `InsulinScreen.kt:303-368`),
inaccessibles de l'extérieur.

**Spec.**
1. Serveur : ajouter `id` (et `quantity`) au select des repas de `mechabetics-history`
   (`index.ts:99` + le map `:101-105`). Déployer.
2. Client data : ajouter `id` à `AnalysisService.RecentMeal` (`AnalysisService.kt:143`,
   parse `:481`) et à `GraphEvent` (+ type meal/insulin déjà présent) ; le propager dans
   `buildGraphEvents` (`GlucoseGraph.kt:86-104`).
3. Geste : hit-test en **dp** (cible ~24 dp de rayon, points dessinés un peu plus gros),
   priorité au point le plus proche ; cluster repas+insuline → sous-hit-test sur les offsets
   `x−8`/`x+2` (`:296-298`) ou mini-menu de choix. Nouveau callback
   `onEventClick(GraphEvent)` sur `GlucoseGraph` (`:120`), threading via `ChartCard`
   (`DashboardScreen.kt:770-784`) et l'écran Historique (`HistoryScreen.kt:392`, qui ne
   passe aujourd'hui aucun `onBackgroundClick` — l'ajouter pour cohérence).
4. Navigation : paramètre `openEditForId: Long?` (+ consommation one-shot) sur
   `FoodScreen`/`InsulinScreen`, et dans `MainActivity` : tap point repas → `tab =
   Tab.MEALS` + id ; tap point insuline → `tab = Tab.INSULIN` + id (pattern existant
   `onLogMeal`, `MainActivity.kt:815` ; `:647` remet déjà `showAllHistory = false`).
5. Tap hors point : conserver l'ouverture de l'historique (Dashboard), et retirer le
   `.clickable` plein-Surface de `ChartCard` qui double le geste (`DashboardScreen.kt:776`)
   si redondant.
**Acceptation.** Tap sur un point vert → dialog d'édition de CETTE dose pré-remplie ; point
rouge → CE repas ; tap hors points → historique complet ; comportement identique depuis le
graphe de l'écran Historique. Cibles tactiles ≥ 44 dp effectives.

---

### WP-6 — Chips « il y a 10/15/20/30 min » dans le sélecteur de date

**État des lieux.** `WhenPicker` (`ui/WhenPicker.kt`, 121 lignes) est utilisé par exactement
deux appelants — repas (`FoodScreen.kt:275`) et insuline (`InsulinScreen.kt:324`), en ajout
comme en édition. Il a déjà le pattern à cloner : rangée de `FilterChip` Hier/Aujourd'hui/
Demain (`:79-88`). Aucune chaîne relative n'existe dans `Localization.kt`.

**Spec.**
1. Ajouter une rangée de chips relatives au-dessus du `TimePicker` (`WhenPicker.kt:88-89`) :
   **Maintenant · −10 min · −15 min · −20 min · −30 min**, chaque chip faisant
   `onChange(System.currentTimeMillis() − n·60_000)` et fermant le dialog (one-tap).
2. Envisager aussi les chips au niveau collapsed (à côté du bouton « Quand ? ») pour du
   vrai one-tap sans ouvrir le dialog — à trancher à l'implémentation selon la place.
3. Chaînes : **une** format-string dans `BgStrings` (`"il y a %d min"` / `"hace %d min"`)
   — PAS dans `Strings` (plafond dex, cf. §0).
4. **Fix du bug adjacent** : en édition, « Maintenant » est un no-op silencieux —
   `onChange(null)` fait sauter le champ `ts` de `MealsService.update`
   (`ai/MealsService.kt:89`, `:103`) donc l'ancienne date reste. En mode édition, envoyer un
   timestamp explicite (`System.currentTimeMillis()`) au lieu de null.
**Acceptation.** Créer ou modifier un repas/une insuline « il y a 15 min » = 2 taps ; la
date affichée et persistée est now−15 min ; « Maintenant » en édition met vraiment la date
courante. FR+ES.

---

### WP-7 — Repas futurs : « je mange 30 sucres dans 10 minutes » → l'app anticipe

**C'est le cœur du produit** (« l'app doit répondre : si je mange ça, combien d'insuline,
AVANT le repas »). L'audit montre que le moteur existe sur la branche et que master perd
l'information « futur » à trois endroits :

1. **Voix : l'heure future est jetée.** Le schéma LLM d'ask n'a que
   `minutesAgo ≥ 0` (`mechabetics-ask/index.ts:242`) et `backdatedIso` est backward-only
   (`:249-253`) → « dans 10 minutes » est stocké `ts = now` avec `planned` pris du flag
   modèle (`:521`). Deux sources de vérité pour `planned` divergent d'ailleurs :
   dérivé du ts dans `mechabetics-meals/index.ts:79-82` (>now+5 min), asserté par le modèle
   dans ask, forcé `false` dans scan (`scan/index.ts:379`). (Manuel : OK — WhenPicker
   `allowFuture=true`, serveur clampe à `[now−14 j, now+36 h]`, `meals/index.ts:61-66`.)
2. **Rien ne « dé-planifie » jamais un repas.** Aucun chemin ne repasse `planned` true→false
   quand l'heure passe → le repas annoncé reste invisible À VIE pour tous les consommateurs
   (COB `InsulinScreen.kt:144`, `findUncoveredMeal` `doseGuard.ts:728`, marqueurs graphe
   `GlucoseGraph.kt:97`, horloge resucrage `MainActivity.kt:296`), pendant que le coach le
   re-signale 3 h (`mechabetics-coach/index.ts:928-930`).
3. **Le conseil n'anticipe pas.** La prédiction est une extrapolation linéaire de pente sans
   terme glucides/insuline (`data/Prediction.kt:94-124`, `doseGuard.ts:542-566`). Le coach
   appelle `combinedActionLine(guard, 0, …)` — `mealUnits` codé en dur à 0
   (`mechabetics-coach/index.ts:810`, `:832`) : le bouton ANALYSE ne peut jamais doser un
   repas.

**Spec.**
1. **Étape 0 (obligatoire) : enquête sur le rollback.** `git log master..fix/dose-engine-
   and-launch-crash`, diff complet, identifier pourquoi `6cd1f34` a écarté le moteur
   (crash au lancement ? autre ?). Ne porter QUE `01482a7` (et ses tests), pas les commits
   de revert/patient de la branche. Documenter la conclusion dans la PR.
2. **Porter le moteur** dans `_shared/doseGuard.ts` master : `carbsOnBoard` (branche
   `:761-776`), `MealBolusPlan`/`mealBolusPlan` (`:778-821`), `planMealDose`
   (`:1019-1082` — délègue la correction à `computeGuard`, donc hérite des invariants
   no-insulin), `mealTimingLine`/`mealPlanLine` (`:1085+`). Recâbler ask
   (branche `mechabetics-ask/index.ts:462-469`) et coach (branche
   `mechabetics-coach/index.ts:878-910`) — ce qui corrige aussi le `mealUnits = 0` du coach.
3. **Combler les deux trous que la branche a AUSSI** :
   - le LLM ne sait pas annoncer le futur : étendre le schéma (champ `minutesUntil` ou
     `minutesAgo` négatif documenté dans le prompt) et remplacer `backdatedIso` par un
     `offsetIso` bidirectionnel (clamp serveur +36 h déjà en place côté meals ; appliquer le
     même clamp dans ask) ;
   - `minutesUntilMeal` est déclaré mais jamais lu dans `planMealDose` (branche
     `doseGuard.ts:982`) : l'utiliser (timing du pré-bolus relatif à l'heure annoncée,
     p.ex. « dans ~10 min, au moment de manger » vs « pré-bolus maintenant » si fast carbs).
4. **Unifier `planned`** : une seule règle = dérivée du timestamp (`ts > now + 5 min`),
   partout (ask, meals, scan) ; « dé-planification » **calculée à la lecture** (pas de cron) :
   remplacer tous les tests `!planned` par un helper `isEatenBy(meal, now)` (= `!planned ||
   ts ≤ now`) côté TS et Kotlin, pour que le repas bascule tout seul dans le COB, les
   marqueurs graphe, l'horloge resucrage et cesse d'être re-signalé par le coach.
5. **Voix bout-en-bout** : « je vais manger 30 sucres dans 10 minutes » → repas stocké
   `ts = now+10 min`, `planned` dérivé, réponse vocale = plan issu de `planMealDose`
   (dose repas au moment de manger / pré-bolus si sucre rapide sans hypo), chiffres 100 %
   doseGuard (invariant §0). Garder le comptage IOB immédiat d'une dose déclarée
   (anti-stacking, `ask/index.ts:391-401`).
6. **Tests** (deno) : minutesUntil → ts futur correct ; repas annoncé fast-carb hors hypo →
   plan avec pré-bolus à l'heure dite ; repas annoncé puis heure passée → compte dans COB et
   plus « prévu » ; jamais d'insuline si `computeGuard` l'interdit (falling/post-hypo/stale);
   baseline 83 tests toujours verte + nouveaux.
**Fichiers.** `_shared/doseGuard.ts` (+ tests), `mechabetics-ask/index.ts`,
`mechabetics-coach/index.ts`, `mechabetics-meals/index.ts`, `mechabetics-scan/index.ts`
(planned dérivé), côté app : `GlucoseGraph.kt:97`, `MainActivity.kt:296`,
`InsulinScreen.kt:144`, `FoodScreen.kt:353-362` (chip « prévu » basé sur l'heure).
**Acceptation.** Scénario vocal du user : « 30 sucres dans 10 min » → l'app répond avant le
repas avec le plan (quantité doseGuard + timing), le repas apparaît « prévu » 10 min puis
bascule « mangé » seul, entre alors dans le COB et le graphe. Déploiement : ask, coach,
meals, scan (+ APK).

---

### WP-8 — « Sucre encore actif » (COB) visible sur la page Repas

**État des lieux.** Un COB client existe déjà mais caché dans l'onglet RÉGLAGES de la page
Injections (`InsulinScreen.kt:138-155` + visuel tir-à-la-corde `SugarVsInsulinTug`
`:384-476`), avec une fenêtre plate de 120 min pour tout aliment — alors que le serveur a
des fenêtres par vitesse 120/180/240 min (`doseGuard.ts:690-704`) et que la branche a le
vrai `carbsOnBoard` par-repas. `FoodScreen` n'a aucun affichage COB. Deux bugs de fraîcheur:
`remember(doses)`/`remember(recentMeals)` figent IOB/COB à l'ouverture de l'écran
(`InsulinScreen.kt:129`, `:141`).

**Spec.**
1. Porter en Kotlin la logique vitesse-aware (miroir de doseGuard, à côté du miroir IOB
   dans `data/Insulin.kt` ou un `Carbs.kt` sibling) : `mealCarbSpeed`, `cobWindowMin`,
   `carbsOnBoard` — mêmes constantes que le serveur (120/180/240).
2. Page Repas (`FoodScreen.kt`) :
   - carte d'en-tête « Sucre encore actif : ≈ N g » (miroir de la carte IOB
     `InsulinScreen.kt:176-187`), en tête de la `LazyColumn` (`:169`) ;
   - par repas récent, sous-ligne « encore ~X g actifs » à côté du `~Ng (≈ N sucres)`
     existant (`MealRow`, `:340-350`) ;
   - inclure les repas annoncés une fois l'heure passée (helper WP-7 §4).
3. Ticker : recalcul périodique (60 s) au lieu des `remember` figés — corriger aussi les
   deux points de gel d'InsulinScreen.
4. Harmoniser le COB d'InsulinScreen sur la même fonction (fin du 120 min plat) et élargir
   `SugarVsInsulinTug` (`private` → `internal`) si on veut le réutiliser côté Repas.
5. Chaînes dans `BgStrings` (FR+ES).
**Acceptation.** Après un repas de pâtes, la page Repas montre des grammes actifs qui
décroissent sur ~4 h (pas 2 h) ; un jus décroît sur ~2 h ; la valeur bouge sans quitter
l'écran ; cohérence InsulinScreen/FoodScreen (même fonction).

---

### WP-9 — [VALIDÉ UTILISATEUR 2026-07-30] Trous de sécurité & robustesse des alertes

L'utilisateur a validé la correction des trous de sécurité relevés en audit (« c'est une
aberration »). Regroupés ici ; l'hypo sévère silencieuse de Telegram est déjà couverte par
le modèle de zones du WP-2.

1. **Réactiver l'auth par token de capacité.** `_shared/access.ts:46` `REQUIRE_TOKEN =
   false` : aujourd'hui la clé anon committée + un hash de subject donnent lecture/écriture
   sur n'importe quel sujet. Étapes :
   a. inventorier TOUS les appels client et vérifier qu'ils attachent `x-mechabetics-access`
      (l'intercepteur d'`AnalysisService` le fait, `AnalysisService.kt:41-47` ; contrôler
      `MealsService`, `ProfileService`, l'historique, et tout appel direct) ;
   b. combler les manques côté app, builder l'APK, **mettre à jour le téléphone familial
      d'abord** (un vieux client sans token serait coupé au flip) ;
   c. passer `REQUIRE_TOKEN = true`, déployer toutes les fonctions, tester chaque feature ;
   d. ensuite seulement : centraliser URL + clé anon en une constante partagée
      (`MealsService.kt:154`, `ClaimService.kt:66-68`, `AnalysisService.kt:577-580`) et
      envisager la rotation de la clé anon.
2. **Garde de fraîcheur sur le monitor Telegram** : `monitor/index.ts:257-262` peut alerter
   sur une lecture d'une heure — appliquer la même règle de 15 min que le chemin
   capteur-expiré (`:286`).
3. **IOB du service d'arrière-plan** : après un démarrage au boot, `MonitorService.kt:113`
   calcule IOB=0 (les doses ne sont poussées que par l'UI, `GlucoseRepository.kt:23-25`) →
   HIGH sonne malgré l'insuline active. Persister les doses récentes localement (ou les
   recharger côté service) pour que la suppression sous IOB marche sans ouvrir l'app.

**Acceptation.** Un appel sans token valide est refusé par le serveur (une fois c. fait) ;
toutes les features marchent depuis l'APK à jour ; plus d'alerte Telegram sur donnée
périmée ; après reboot sans ouvrir l'app, une hyper sous insuline active ne sonne pas.

---

## 3. Backlog secondaire (découvert en audit — ne pas mélanger aux WP)

**Sécurité / données — promus en WP-9 et WP-2 (décision utilisateur), rappel :**
- `REQUIRE_TOKEN = false` + clé anon en clair → WP-9.1.
- Hypo sévère silencieuse Telegram (55→50) → WP-2 (zones, franchissement de 54).
- Fraîcheur du monitor Telegram → WP-9.2 ; IOB=0 du service au boot → WP-9.3.

**Robustesse serveur :**
- `mechabetics-scan/index.ts:195` : la boucle Gemini réessaie un HTTP 400 sur les 6 modèles
  avec l'image complète (aggrave les timeouts).
- `premiumVoice = body.premiumVoice !== false` (`scan:239`, `ask:269`, `coach:651`) :
  facture ElevenLabs à tout client legacy qui omet le champ.
- Timeout client 80 s (`AnalysisService.kt:39`) < pire cas serveur scan → « service
  injoignable » alors que le repas est déjà inséré (double-log silencieux).
- Pas de migrations dans le repo : envisager un dossier `supabase/migrations/` schéma-as-code
  (la branche a `20260727_voice_log.sql`, à appliquer à la main).

**Qualité client :**
- IOB dupliqué 4× (`Insulin.kt:36`, `InsulinScreen.kt:129`, `MainActivity.kt:281`,
  `GlucoseRepository.kt:27`) → une seule fonction (le `Triple` du monitor ne porte pas
  `kind`, cf. `MainActivity.kt:288-292`).
- `ui/FoodScreen.kt:411-423` `processUri` : décode plein format (OOM possible) et ignore
  l'EXIF (photos galerie envoyées de travers) — contrairement à `processImage:387-401`.
- `InsulinScreen.kt:355` : après sauvegarde, `name`/`doseKind` restent pré-remplis de la
  dose précédente.
- `GlucoseGraph.kt:164` : chaque nouvelle lecture referme le badge d'aperçu ouvert.
- `AlarmService` déclaré `foregroundServiceType="mediaPlayback"` pour un son `USAGE_ALARM`
  (risque policy Play Store) ; commentaire manifest obsolète (« rings until STOP » vs 2
  carillons + auto-clear 60 s).
- `MonitorService.kt:117-119` : écritures EncryptedSharedPreferences à chaque émission
  (plusieurs/minute, en continu).
- Code mort : `ai/VoiceRecorder.kt` (remplacé par `VoiceInput`), imports morts
  `GlucoseGraph.kt:31/:33` ; KDoc périmé `GlucoseAlert.kt:36-38` (5 vs 15 min).
- `coach.mp3` réécrit pendant qu'un MediaPlayer peut encore le tenir
  (`AnalysisService.kt:503-525`) ; `NativeTts.pending` ne garde qu'un énoncé (`:41`).

---

## 4. Consignes d'exécution pour le planner (Opus 5)

1. **Un WP = une branche = une PR**, tests inclus. Ne pas grouper WP-0/1/2 avec le reste.
2. Chaque worker relit §0 (invariant dose, BgStrings, FR+ES, commandes machine).
3. Après tout changement `_shared/` : lancer la suite deno (baseline 83) **puis** déployer
   chaque fonction impactée avec `--project-ref vzafttfgrxpjdraveihh` (les edge functions ne
   partent pas avec l'APK).
4. Après tout changement app : `./gradlew :app:testDebugUnitTest` puis `assembleDebug` ;
   l'installation sur le téléphone familial est un acte utilisateur (le signaler, ne pas
   pousser d'office).
5. Les numéros de ligne de ce document datent de `dcad09a` : toujours re-localiser avant
   édition.
6. Décisions utilisateur DÉJÀ ACTÉES le 2026-07-30 (ne pas re-demander) :
   - RAPID_FALL ne sonne plus (bannière seule) ;
   - seuils unifiés sur les trois canaux (app, push local, Telegram) : rouge < 60 et > 180,
     orange 60–69 et 171–180, normale 70–170 — le secret Telegram à 240 doit être ramené
     à 180 ;
   - trous de sécurité : correction validée → WP-9.
   Seul point restant à faire valider : WP-7 — conclusions de l'enquête rollback avant de
   porter le moteur.
