# Consignes pour Claude — dépôt posthumain-ghost-assets

## Writinglab : employés (postes IA) et fonctionnalités (capacités)

**Pour ajouter un employé ou une fonctionnalité au Writinglab : une entrée dans `shared/wl-catalogue.json`,
puis lancer le test. Ne jamais coder un poste ou une action en dur ailleurs** : ni dans `writinglab/app.js`,
ni dans `supabase/functions/wl-tel`, ni dans n8n.

1. Modifier `shared/wl-catalogue.json` (poste dans `postes`, capacité dans `capacites`).
2. `node scripts/wl-catalogue.mjs --ecrire` : recopie dans app.js, dans `supabase/functions/wl-tel/catalogue.ts` et dans
   `supabase/functions/wl-kb/catalogue.ts` (extrait).
3. `node scripts/wl-catalogue.mjs` : le test doit afficher ✓.
4. Commit et push, puis redéployer **wl-tel** avec `index.ts`, `equipe.ts`, `catalogue.ts` et `kb.ts` (et **wl-kb**, mêmes
   fichiers, si les domaines de connaissances ont changé).

Un poste déclaré obtient automatiquement :

- son ☎️ et sa 🎙️ dictée ;
- sa fiche de poste pour l'IA et sa place dans l'aiguillage ;
- ses bulles d'activité et ses droits ;
- son bureau sur le plan (ou « Autres postes ») et un panneau ;
- sa base de connaissances si son champ `connaissances` désigne un domaine (onglet de Paramètres → 📚 Base de connaissances) ;
- son bouton ⓘ « Qui fait quoi » (rôle, capacités avec exemples, aiguillage), généré depuis le catalogue.

Base de connaissances : un domaine = une entrée dans `connaissances` du catalogue (`id`, `nom`, `emoji`, `aide`, `defaut`) ;
chaque poste déclare `connaissances` (id ou `null`). `supabase/functions/_shared/kb.ts` est copié tel quel en `wl-tel/kb.ts` et
`wl-kb/kb.ts` (et aussi `wl-mails/kb.ts`, `wl-relecture/kb.ts`) : modifier toutes les copies ensemble.

## Writinglab : le Correcteur (relecture des brouillons, fonction `wl-relecture`)

- Reprend la relecture du lundi (skill `posthumain-revision:revise-article` + audit des sources + audit des graphiques) en
  traitement par lot Anthropic ; `tic` toutes les 2 min (pg_cron « writinglab-relecture-tic », secret `relecture_cron_secret`).
- Le texte du skill est recopié AUTOMATIQUEMENT dans `wl_reglages` (`relecture_skill`, `relecture_guide`, `relecture_skill_version`)
  par la GitHub Action du dépôt privé `claude-posthumain-article-corrector` à chaque fusion sur main (action `skill_maj`, secret
  `relecture_skill_secret`) : GitHub est la seule source, ne jamais le modifier à la main ni le mettre dans ce dépôt public.
- Graphiques refaits : skill `generate-charts` de l'Usine (Skills API, version latest), en appel direct en tâche de fond (pas de lot),
  avec Sonnet 5.5 depuis le 26/11/2026 (`MODELE_GRAPHIQUE` ; Opus coûtait environ 1,40 € par graphique). Essai sans risque sur une
  relecture d'essai (secret du tic) : action `essai_graphique { id, k }`.
- Rien n'est écrit dans Ghost sans validation humaine (rédacteur en chef, ou journaliste les jours ouverts, voir ci-dessous) ; seul le Lexical est envoyé (blocs protégés intacts).
- **👩‍💻 Validation par la journaliste** (26/11/2026) : `relecture_auto.journalistes` = jours (0–6, heure de Zurich) dont les relectures
  s'ouvrent aussi aux journalistes (vide par défaut = rédacteur en chef seul). Elles ont alors `liste`, `detail`, `valider` (jamais `tout`),
  `refaire_graphique`, `appliquer_graphique` sur ces relectures-là, et la notification « prête ». Jamais : lancer, écarter, convertir en actu
  premium, réglages, coûts, comparaisons. Droits vérifiés côté serveur (`pourJournaliste`) ; `validee_par` garde qui a validé.
  Tests hors ligne : `deno test supabase/functions/wl-relecture/blocs_test.ts`.
- Déploiement : `index.ts`, `blocs.ts`, `premium.ts`, `comparaison.ts`, `equipe.ts`, `kb.ts` (copies identiques à celles de wl-tel).
- **⚖️ IA contre la journaliste** (25/11/2026, `comparaison.ts`, table `wl_comparaisons`) : mesure si le Correcteur relit aussi bien que la
  journaliste les articles de l'Usine. Chaîne À PART des relectures : la version d'origine vient de l'historique Ghost (`post_revisions`,
  raison `initial_revision`), le Correcteur la relit à l'aveugle (même requête qu'une relecture), puis un juge compare les deux relectures
  sous les noms A / B, en alternance d'une comparaison à l'autre (il ne sait pas laquelle vient de l'IA). Une comparaison n'écrit jamais dans Ghost, ne refait aucun
  graphique et n'apparaît jamais dans « Prêtes à valider ». Suivi par le même `tic`, après les relectures et sans pouvoir les bloquer ;
  contrôle du lundi matin réglable (`comparaison_auto` dans `wl_reglages`, désactivé par défaut). Page : section du bureau du Correcteur
  et bouton « ⚖️ Comparer à la journaliste » des articles publiés. Tests hors ligne : `deno test supabase/functions/wl-relecture/comparaison_test.ts`.
  Diagnostic gratuit de l'historique d'un article (secret du tic) : action `diag_revisions`.

Champs d'aide obligatoires (le test échoue sinon) : sur chaque poste `aide` (une phrase pour les humains), `exemples`
(au moins 2 phrases à dire au ☎️) et `aiguillage` (ce qu'on lui transmet) ; sur chaque capacité `nom`, `aide`, `fournir`
et `exemples`. Les stations du plan sans IA (Courrier, Marbre, Radar, Votes) et les bureaux humains (chef, journaliste)
ont leur aide dans `stations`.

Une nouvelle action `api('…')` dans app.js doit être l'exécuteur d'une capacité, ou figurer dans `interne`
avec sa raison, sinon le test échoue. De même, toute action de `wl-tel` est l'exécuteur d'une capacité ou figure dans `interne_tel`.

Exemple complet (poste « Documentaliste » + capacité « dossier_archives ») et description de tous les
champs : **`CONTRIBUTING-writinglab.md`**.

## Writinglab : mails marketing (bureau Marketing → ✉️ Mails marketing)

Un type de mail = une entrée dans `shared/wl-mails.json` (gabarit, blocs ou emplacements éditables, consignes de l'IA, réglages,
canal d'envoi). Pour une source déjà gérée (`ghost_automation` : mail d'une automation Ghost ; `n8n_gabarit` : gabarit HTML figé
d'un workflow n8n), aucun code : `node scripts/wl-catalogue.mjs --ecrire` recopie la déclaration dans `writinglab/app.js`
(marqueurs MAILS-DEBUT/MAILS-FIN) et `supabase/functions/wl-mails/types.ts`, puis le test doit afficher ✓ ; redéployer **wl-mails**
avec `index.ts`, `lexique.ts`, `types.ts`, `equipe.ts` et `kb.ts` (copie de `_shared/kb.ts`, à garder identique). La capacité
☎️ `mails_marketing` prend ses valeurs de `"@types_mails"` (liste résolue par le script).

- Serveur : `supabase/functions/wl-mails` (rédacteur en chef vérifié côté serveur ; `config` en lecture publique pour n8n).
  Conversion Lexical ⇄ blocs testée hors ligne : `deno test supabase/functions/wl-mails/lexique_test.ts`.
- Ghost exige un jeton de personnel (secret Supabase `GHOST_STAFF_API_KEY`) pour les automations et les aperçus/tests de mails.
- n8n lit les réglages à chaque passage avec repli sur les valeurs d'origine : « Série de bienvenue (leads Meta) »
  (O2KTg4ei7beStC6g) et le nœud « Grand Format » du workflow « Best-of premium mensuel » (dSPO5tEWq09YPvk1, déclencheur quotidien
  9h45 avec arrêt silencieux hors du jour réglé). Le gabarit HTML du Grand Format ne se modifie jamais depuis le lab.
- Page (27/10/2026) : le panneau Marketing ne montre que des cartes ; l'édition se fait dans un **studio plein écran** (`mlStudio` dans
  app.js) : texte directement éditable sur une feuille blanche (même grammaire **gras** / *italique* / [lien](url) que `lexique.ts`),
  aperçu exact de Ghost rafraîchi seul ~1 s après chaque modification, onglets Écrire · Aperçu (téléphone) · Julien · Envoi · Versions.
- Historique : table `wl_mails_versions` (versions, sauvegarde de l'automation Ghost avant chaque écriture) ; réglages : `wl_reglages`
  (clé `mails:<type>`).
