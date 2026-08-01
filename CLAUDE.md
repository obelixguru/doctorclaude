# CLAUDE.md — Dr Claude (Mechabetics)

Assistant de dosage d'insuline pour un enfant diabétique : lectures de glycémie,
calcul de la dose **avant** le repas (voix, photo, formulaire), alertes hypo/hyper.

---

## RÈGLE ABSOLUE — GitHub fait foi, daté du 2026-08-01 (à lire en premier)

**La version de référence est celle qui est sur GitHub**, poussée le **2026-08-01** depuis le Mac
de l'auteur, juste avant un départ d'environ un an sans accès à cette machine.
Tags de repère : `derniere-version-2026-08-01` (master) et `derniere-version-2026-08-01-ios`
(`ios-web-client`).

**Sur toute autre machine** — en particulier l'ordinateur repris le **2026-08-02** après ~14 jours
d'arrêt — les **modifications locales non commitées sont périmées et non désirées**. Demandé
explicitement le 2026-08-01 : *« je veux plus »* de cette partie locale, *« je veux notre version
d'ici partout »*.

**Au premier démarrage sur une autre machine, avant toute autre chose :**

1. Ne pas lire, reprendre, fusionner ni « sauver » ces modifications locales.
2. `git fetch --all --prune`
3. S'il reste des modifications locales, les jeter :
   `git reset --hard origin/<branche>` puis `git clean -fd`
   (**sans `-x`** : les fichiers ignorés — clés, `local.properties`, `.env` — doivent survivre).
4. Ne jamais proposer merge / rebase / stash pour conserver ce travail local : il est abandonné.

**Seule exception :** si cette machine porte des *commits* non poussés (et non de simples fichiers
modifiés), le signaler à l'auteur avant de les jeter — il n'a parlé que de travail **non commité**.
Vérification : `git log --branches --not --remotes --oneline`.

---

## Branches sur GitHub

- `master` — l'app Android, installée sur le téléphone de l'enfant.
- `ios-web-client` — le client iPhone (PWA) + le proxy LLU. **Pas fusionnée dans `master`.**
- `gh-pages` — le web app construit, servi sur https://obelixguru.github.io/doctorclaude/
- `fix/dose-engine-and-launch-crash`, `rollback/pre-today` — historique conservé, poussé le
  2026-08-01 pour que rien ne reste seulement en local.

Rien en production ne dépend du Mac de l'auteur : la PWA est sur GitHub Pages, les edge functions
et le cron d'alertes sur Supabase, l'app Android déjà installée sur le téléphone.
