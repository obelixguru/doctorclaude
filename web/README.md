# Doctor Claude — client web (iPhone / iPad / navigateur)

Version web installable de l'app Android, pour les iPhone. Elle parle au **même backend Supabase**
que le téléphone : un repas saisi ici apparaît sur le téléphone du porteur du capteur, et
réciproquement. Aucune logique médicale n'est dupliquée — le calcul de dose reste dans
`supabase/functions/_shared/doseGuard.ts`, côté serveur.

> ⚠️ Les mêmes avertissements que l'app Android s'appliquent : ce n'est **pas** un dispositif
> médical. Voir le [README principal](../README.md).

---

## Ce qu'il faut savoir avant de l'installer

**Une page web ne peut sonner que si elle est OUVERTE à l'écran.** iOS ne donne aucun moyen de
faire tourner une alarme de fond depuis un site. Ce n'est pas une régression du modèle de sécurité,
c'est le modèle de sécurité tel qu'il est déjà écrit : `AlarmPolicy.kt` qualifie l'alarme du
téléphone de « couche de CONFORT », et l'alerte Telegram envoyée par le cron serveur de « vrai filet
de sécurité », indépendante du téléphone et de ses réglages.

Concrètement, pour un parent sur iPhone :

| Canal | Marche téléphone rangé ? |
|---|---|
| Alerte **Telegram** (cron serveur) | ✅ oui — c'est le filet de sécurité |
| Alarme **dans l'app web** | ❌ seulement app ouverte à l'écran |

**→ La personne qui utilise cette app doit être dans le groupe Telegram.** C'est ce qui la
prévient la nuit, pas le navigateur. L'écran « Notifications & alarmes » le dit noir sur blanc.

---

## Déployer

C'est du statique : pas de build, pas de bundler, pas de dépendances. N'importe quel hébergeur
HTTPS convient.

> **HTTPS obligatoire.** `crypto.subtle` (qui calcule le `subject` de chaque appel) n'existe que
> dans un contexte sécurisé. En `http://` non-localhost, l'app ne peut rien lire.

### Option A — Netlify / Vercel / Cloudflare Pages (glisser-déposer)

Déposer le dossier `web/` sur netlify.com/drop. Une URL HTTPS est générée immédiatement.

### Option B — GitHub Pages

```bash
git subtree push --prefix web origin gh-pages
```

### Option C — Supabase Storage (là où vit déjà le backend)

```bash
npx --yes supabase storage cp -r web ss:///public-web --project-ref vzafttfgrxpjdraveihh
```

### Tester en local

```bash
python3 -m http.server 8777 --directory web
```

Puis ouvrir <http://localhost:8777> (localhost est un contexte sécurisé, donc tout fonctionne).

---

## Installer sur l'iPhone

1. Ouvrir l'URL **dans Safari** (pas Chrome — seul Safari sait installer sur iOS).
2. Bouton **Partager** → **« Sur l'écran d'accueil »**.
3. L'app s'ouvre en plein écran, sans barre d'adresse, avec son icône.

Se connecter avec le compte **LibreLinkUp** (l'app suiveur Abbott) — le même que sur Android.
Un compte qui suit plusieurs personnes propose un sélecteur dans l'onglet Profil.

Aucun compte développeur Apple, aucun Xcode, aucune expiration à 7 jours.

---

## La fonction serveur à déployer

Le client web a besoin d'**une** nouvelle edge function, `mechabetics-llu` : un navigateur ne peut
pas appeler `api.libreview.io` directement (Abbott ne renvoie aucun en-tête CORS, donc le préflight
échoue avant même l'envoi). Elle relaie login / connections / graph, et rien d'autre.

```bash
npx --yes supabase functions deploy mechabetics-llu --project-ref vzafttfgrxpjdraveihh
```

Elle est **additive** : aucune fonction existante n'est modifiée, l'app Android n'est pas touchée.
Elle ne stocke rien, n'a pas de clé de service, ne lit aucune table — la session LibreLinkUp
elle-même fait l'autorisation, exactement comme pour `mechabetics-claim`.

---

## Architecture

```
web/
  index.html              coquille + méta iOS (standalone, safe-area, apple-touch-icon)
  manifest.webmanifest    installable
  sw.js                   service worker — cache la COQUILLE, jamais les données glycémie
  css/app.css             design repris de ui/theme/Color.kt
  js/
    config.js             backend, cadence de poll, fenêtre de fraîcheur, flèches de tendance
    api.js                les 9 edge functions (contrat identique à ai/*Service.kt)
    store.js              session, patients, readings, réglages, boucle de poll, alertes
    zones.js              zones 60/70/170/180 — miroir de _shared/alertZones.ts
    graph.js              la courbe (portage de ui/GlucoseGraph.kt)
    i18n.js               FR + ES, repris mot pour mot de ui/Localization.kt
    voice.js              TTS, dictée, bip d'alarme (WebAudio)
    util.js               DOM, formats, sha256
    app.js                consentement, onglets, feuille modale, overlay d'alarme
    screens/              login · dashboard · food · insulin · history · profile · notifications
```

### Deux décisions qui méritent d'être connues

**1. Ce client ne réclame PAS de jeton de capacité.** L'app Android appelle `mechabetics-claim` et
envoie `x-mechabetics-access`. Pas ici, pour la raison documentée dans `_shared/access.ts` :
`claim` fait TOURNER le jeton en **supprimant** le précédent du compte, donc une deuxième
installation partageant le compte LibreLinkUp évincerait le téléphone de l'enfant. Ce client envoie
seulement le `subject` dans le corps, ce que `access.ts` accepte tant que `REQUIRE_TOKEN = false`
(la fenêtre de grâce actuelle).

C'est aussi la seule chose qui marche depuis un navigateur : les fonctions déployées ne listent pas
`x-mechabetics-access` dans `Access-Control-Allow-Headers`, donc un préflight qui le porte échoue.

> Si `REQUIRE_TOKEN` repasse un jour à `true`, **ce client cesse de lire les données**. Le correctif
> est celui que `access.ts` nomme déjà — permettre plusieurs jetons par compte — après quoi ce
> client pourra claim comme le téléphone, et il faudra ajouter cet en-tête au CORS des 9 fonctions.

**2. Le service worker ne met JAMAIS en cache une glycémie.** Un service worker sert normalement une
copie stockée quand le réseau manque. Ici ce serait dangereux : une mesure rejouée une heure plus
tard ressemble exactement à une mesure live, alors que toute l'app est bâtie pour qu'un chiffre
périmé ne puisse pas passer pour la glycémie actuelle. Seule la coquille (HTML/CSS/JS/icônes) est
mise en cache ; tout appel aux edge functions va au réseau et n'est jamais stocké.

---

## Tests

Le portage des zones d'alerte est vérifié **contre l'implémentation serveur**, pas relu à l'œil :

```bash
deno test --allow-read --no-check supabase/functions/_shared/webZonesParity.test.ts
```

Ce test balaie ~20 000 couples prev→cur plus toutes les valeurs de bord, et échoue si
`web/js/zones.js` et `_shared/alertZones.ts` divergent d'un seul point. La suite complète
(`supabase/functions/_shared/*.test.ts`) est à 191 tests verts.

---

## Parité avec l'app Android

| Écran | Web | Note |
|---|---|---|
| Consentement / sécurité | ✅ | texte identique |
| Connexion LibreLinkUp | ✅ | via le proxy `mechabetics-llu` |
| Glycémie (live, tendance, courbe) | ✅ | marqueurs repas/insuline, tap → badge → fiche |
| Coach IA + question libre | ✅ | voix native du navigateur |
| Repas (dont « je vais manger ») | ✅ | la question prospective est le bouton principal |
| Scan photo produit | ✅ | `capture=environment` ouvre l'appareil photo |
| Dictée vocale | ✅ | `SpeechRecognition` (Safari iOS 14.5+) |
| Insuline (doses + ratios + autotune) | ✅ | |
| Historique (général / analyses / injections) | ✅ | |
| Profil (dont sélecteur de personne) | ✅ | |
| Notifications & alarmes | ⚠️ | réglages complets, mais **sonne seulement app ouverte** |
| Alarme en arrière-plan | ❌ | impossible sur iOS pour un site — c'est Telegram qui couvre |
| Health Connect (fréquence cardiaque, pas) | ❌ | Android uniquement |
