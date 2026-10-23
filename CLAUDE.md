# Consignes pour Claude — dépôt posthumain-ghost-assets

## Writinglab : employés (postes IA) et fonctionnalités (capacités)

**Pour ajouter un employé ou une fonctionnalité au Writinglab : une entrée dans `shared/wl-catalogue.json`,
puis lancer le test. Ne jamais coder un poste ou une action en dur ailleurs** : ni dans `writinglab/app.js`,
ni dans `supabase/functions/wl-tel`, ni dans n8n.

1. Modifier `shared/wl-catalogue.json` (poste dans `postes`, capacité dans `capacites`).
2. `node scripts/wl-catalogue.mjs --ecrire` : recopie dans app.js et dans `supabase/functions/wl-tel/catalogue.ts`.
3. `node scripts/wl-catalogue.mjs` : le test doit afficher ✓.
4. Commit et push, puis redéployer **wl-tel** avec `index.ts`, `equipe.ts` et `catalogue.ts`.

Un poste déclaré obtient automatiquement :

- son ☎️ et sa 🎙️ dictée ;
- sa fiche de poste pour l'IA et sa place dans l'aiguillage ;
- ses bulles d'activité et ses droits ;
- son bureau sur le plan (ou « Autres postes ») et un panneau ;
- son bouton ⓘ « Qui fait quoi » (rôle, capacités avec exemples, aiguillage), généré depuis le catalogue.

Champs d'aide obligatoires (le test échoue sinon) : sur chaque poste `aide` (une phrase pour les humains), `exemples`
(au moins 2 phrases à dire au ☎️) et `aiguillage` (ce qu'on lui transmet) ; sur chaque capacité `nom`, `aide`, `fournir`
et `exemples`. Les stations du plan sans IA (Courrier, Marbre, Radar, Votes) et les bureaux humains (chef, journaliste)
ont leur aide dans `stations`.

Une nouvelle action `api('…')` dans app.js doit être l'exécuteur d'une capacité, ou figurer dans `interne`
avec sa raison, sinon le test échoue.

Exemple complet (poste « Documentaliste » + capacité « dossier_archives ») et description de tous les
champs : **`CONTRIBUTING-writinglab.md`**.
