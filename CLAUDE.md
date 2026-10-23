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
`wl-kb/kb.ts` : modifier les trois ensemble.

Champs d'aide obligatoires (le test échoue sinon) : sur chaque poste `aide` (une phrase pour les humains), `exemples`
(au moins 2 phrases à dire au ☎️) et `aiguillage` (ce qu'on lui transmet) ; sur chaque capacité `nom`, `aide`, `fournir`
et `exemples`. Les stations du plan sans IA (Courrier, Marbre, Radar, Votes) et les bureaux humains (chef, journaliste)
ont leur aide dans `stations`.

Une nouvelle action `api('…')` dans app.js doit être l'exécuteur d'une capacité, ou figurer dans `interne`
avec sa raison, sinon le test échoue. De même, toute action de `wl-tel` est l'exécuteur d'une capacité ou figure dans `interne_tel`.

Exemple complet (poste « Documentaliste » + capacité « dossier_archives ») et description de tous les
champs : **`CONTRIBUTING-writinglab.md`**.
