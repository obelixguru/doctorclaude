# Doctor Claude — Politique de confidentialité

_Dernière mise à jour : 2026-06-06_

Cette politique explique ce que Doctor Claude fait de vos données. Elle est écrite de façon honnête et simple, car il s'agit de **données de santé**.

> **En résumé.** Dans la formule **Gratuite / BYOK**, Doctor Claude stocke votre historique de glycémie **uniquement sur votre téléphone**. Rien ne nous est envoyé, car il n'y a ni compte ni serveur dans ce mode. Dans la formule **Hosted** (payante, sur option), vos données sont synchronisées sur un serveur sous forme **pseudonyme** (un hachage irréversible, jamais votre nom), seulement après votre consentement explicite, et vous pouvez les supprimer à tout moment.

## Qui sommes-nous (responsable de traitement)

**Nueve** — contact : **hello@nueveapp.com**.

## Deux modes, deux postures de confidentialité très différentes

### Gratuit / BYOK (par défaut) — sur l'appareil uniquement
- Vos mesures et votre historique sont stockés **localement sur votre appareil** (SQLite). Ils **ne quittent pas le téléphone**.
- **Aucun compte, aucune connexion, aucun stockage côté serveur** de vos données de santé dans ce mode.
- Les requêtes IA utilisent **votre propre** clé Google Gemini (BYOK), stockée chiffrée sur votre appareil. Nous ne recevons ni ne stockons cette clé.
- Comme nous ne recevons jamais vos données dans ce mode, **il n'y a rien à conserver, vendre ou divulguer.**

### Hosted (payant, sur option) — synchronisation cloud pseudonyme
Si, et seulement si, vous activez le mode Hosted et acceptez l'écran de consentement :

**Ce que nous collectons et traitons :**
- Un **identifiant pseudonyme** — un hachage sha256 dérivé de l'identifiant patient de votre CGM. **Nous ne stockons jamais votre nom.**
- Les **mesures de glycémie** (valeur + horodatage).
- Les **journaux que vous créez** : repas (description, glucides estimés), doses d'insuline, activité physique.
- Le **texte des analyses IA** générées pour vous (pour relire les analyses passées).

**Base légale (RGPD) :** la glycémie est une donnée de santé sensible au sens de l'**article 9**. Nous la traitons sur la base de votre **consentement explicite — article 9(2)(a)** — donné via l'écran de consentement de l'application. Vous pouvez retirer ce consentement à tout moment en désactivant le mode Hosted et/ou en supprimant vos données.

**Finalité :** fournir un historique au-delà de la courte fenêtre du cloud CGM, la synchronisation multi-appareils, et les fonctions de coaching que vous avez demandées. Nous n'utilisons **pas** vos données à des fins publicitaires, de profilage étranger au service, ou d'entraînement de modèles tiers.

**Conservation :** conservées tant que votre compte Hosted est actif. Lorsque vous supprimez vos données (ci-dessous), elles sont retirées rapidement. Les sauvegardes sont renouvelées sur un cycle court.

**Vos droits :** accès, rectification, effacement (bouton « **supprimer mes données** » dans l'app), limitation, portabilité et opposition. Pour exercer un droit, utilisez le bouton dans l'app ou écrivez à **hello@nueveapp.com**. Vous avez aussi le droit d'introduire une réclamation auprès de votre autorité de contrôle (par ex. la CNIL en France).

**Sous-traitants (Hosted uniquement) :**
- **Supabase** — base de données + hébergement des edge functions pour les données pseudonymes.
- **Le fournisseur de LLM** (DeepSeek et/ou Google Gemini) — reçoit le contexte nécessaire pour générer une réponse. Envoyé de façon pseudonyme ; non utilisé par nous pour vous identifier.
- **Le fournisseur de voix** (ElevenLabs) — reçoit le texte à synthétiser, uniquement si la voix premium est activée. La voix gratuite / sur l'appareil ne quitte jamais le téléphone.

Nous n'utilisons **aucun SDK publicitaire ou d'analyse** qui vous profilerait.

## Enfants

Doctor Claude peut être utilisé **par ou pour un mineur** (par exemple un parent suivant un enfant diabétique de type 1). Dans ce cas, le parent/tuteur est responsable du compte et fournit le consentement. Nous minimisons les données (pseudonymes, données de santé uniquement) et ne stockons jamais le nom de l'enfant. Si vous pensez que des données concernant un enfant ont été collectées sans consentement valable, contactez-nous et nous les supprimerons.

## Sécurité

Pseudonymisation (sha256), chiffrement en transit (HTTPS), Row-Level Security sur la base, stockage chiffré sur l'appareil pour les clés. Aucun système n'est parfaitement sûr ; voir [SECURITY.md](../SECURITY.md) pour signaler un problème.

## La connexion CGM

Doctor Claude lit depuis un **compte suiveur / de partage CGM compatible que vous possédez et contrôlez déjà**, avec des identifiants que vous fournissez. Nous ne sommes **ni affiliés, ni sponsorisés, ni approuvés par un fabricant de CGM.** Votre usage de ce compte est soumis aux conditions de ce fournisseur.

## Modifications

Nous pouvons mettre à jour cette politique ; les changements importants seront signalés dans l'app. Continuer à utiliser la formule Hosted après une modification vaut acceptation.

## Contact

**hello@nueveapp.com**
