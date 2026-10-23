# Writinglab : ajouter un employé ou une fonctionnalité

**Règle d'or : un poste (employé IA) ou une capacité (fonctionnalité) se déclare UNE seule fois, dans
`shared/wl-catalogue.json`. Ne jamais coder un poste ou une action en dur ailleurs (page, wl-tel, n8n).**

## Les deux commandes

```bash
node scripts/wl-catalogue.mjs --ecrire   # recopie le catalogue dans writinglab/app.js et supabase/functions/wl-tel/catalogue.ts
node scripts/wl-catalogue.mjs            # vérifie tout (échoue au moindre oubli) ; lancé aussi par la GitHub Action
```

Après `--ecrire` : commit, push, puis **redéployer wl-tel** (fichiers `index.ts`, `equipe.ts`, `catalogue.ts`).

## Ce qu'un poste obtient automatiquement

Dès qu'il est déclaré, sans aucune autre ligne de code :

- son **☎️ téléphone** (sur le plan et dans l'en-tête de son panneau), avec la **🎙️ dictée** ;
- sa **fiche de poste pour l'IA** (wl-tel) : son rôle, ses capacités, et le résumé des autres postes pour l'aiguillage ;
- sa place dans la **liste de transmission** des autres postes ;
- ses **bulles d'activité** (« … travaille ») et ses **droits** (`acces` : `tous` ou `chef`) ;
- un **bureau sur le plan** s'il a un `plan` { x, y }, sinon un bouton dans « Autres postes » sous le plan ;
- un **panneau** générique (rôle, capacités, bouton ☎️) s'il n'a pas de panneau dédié dans la page ;
- un bouton **ⓘ « Qui fait quoi »** sur son bureau : son aide, chaque capacité (ce qu'elle fait, exemples de phrases au ☎️,
  ce qu'il faut fournir, le résultat, qui y a droit), les règles d'aiguillage vers les autres postes et « ☎️ Appeler ce poste ».
  Une journaliste ne voit que ce qui lui est accessible.

Une capacité apparaît automatiquement dans la fiche de poste de son porteur. Elle est validée côté serveur
(schéma des paramètres, droits, existence de la fiche, du mail ou de l'article visé) et exécutée par la page
via son `executeur`, sans `switch` à compléter.

## Champs

**Poste** : `id` (minuscules), `nom`, `emoji`, `couleur`, `acces` (`tous` | `chef`), `titre` (sous le nom sur le
plan), `role` (texte pour l'IA, à la 2e personne), `aide` (une phrase claire pour les humains, bouton ⓘ), `exemples`
(au moins 2 phrases à dire au ☎️), `aiguillage` (ce que les autres postes doivent lui transmettre : sert à générer les
règles d'aiguillage des IA et l'aide ⓘ), `contexte` (données lues pour lui : `fiches`, `courrier`, `pieces`), `mail`
({ boite, adresse, role } si `courrier`), `plan` ({ x, y, teinte } ou `null`), `capacites` (ids).

**Capacité** :

- `id` et `postes` (qui la porte) ;
- `nom` (titre lisible, avec son emoji), `aide` (ce qu'elle fait, pour les humains), `fournir` (ce qu'il faut donner),
  `exemples` (au moins 2 phrases à dire au ☎️) : affichés par le bouton ⓘ ;
- `description` (pour l'IA, avec la liste des paramètres) ;
- `params` (schéma : `article`, `fiche`, `mail`, `contact`, `liste`, `qr`, `texte`, `choix`, `cible` ; options
  `requis`, `long`, `max`, `statuts`, `avec_reponse`, `valeurs`) ;
- `droits` (`tous` | `chef` | `journaliste`) ;
- `mode` :
  - `brouillon` : lancée tout de suite, son résultat est à valider ;
  - `immediat` : lancée tout de suite, sans effet externe ;
  - `clic` : attend un clic ;
- `executeur` :
  - `{ type: "api", mode, donnees, bureau, libelle, liste?, resultat, lien?, suite? }` pour une action du webhook n8n ;
  - `{ type: "tel", action, donnees, envoi?, ecarter?, lister? }` pour une action de wl-tel (les actions d'envoi validé,
    d'abandon et de liste d'un brouillon, si la capacité en a, sont aussi vérifiées) ;
  - `{ type: "page", fonction }` pour une fonction de `PAGE_EXEC` dans app.js ;
- `carte` : affichage au téléphone, `{ titre, texte?, liste?, format?, note?, bouton }`.

Valeurs dynamiques :

- `$p.x` : un paramètre ;
- `$r.x` : le résultat ;
- `$l.x` : un champ de chaque élément de la liste résultat ;
- `$requete` : la dernière requête du membre ;
- `$bureau_mail` : le bureau du mail visé ;
- dans les textes : `{p.x}`, `{r.x}`, `{n}`.

**Aiguillage** : `aiguillage.contacts_interview` désigne le poste qui écrit à toute personne qui a une fiche
d'interview. Un poste avec une boîte de courrier (`mail`) ne reçoit jamais ces demandes : la règle est écrite dans la fiche
de poste de chaque IA et vérifiée par wl-tel avant toute transmission.

**Stations** (`stations`) : l'aide ⓘ des bureaux sans IA (`chef`, `journaliste`, `courrier`, `marbre`, `radar`, `votes`) :
`id`, `nom`, `emoji`, `aide`, `actions` (ce que fait son panneau), `acces?`. Une nouvelle station du plan doit y figurer.

## Exemple complet : une Documentaliste

Ajouter dans `postes` :

```json
{
  "id": "documentaliste", "nom": "La Documentaliste", "emoji": "📚", "couleur": "#7a9a4a",
  "acces": "tous", "titre": "Archives et sources",
  "role": "Tu retrouves dans les archives de Posthumain les articles et les sources déjà publiés sur un sujet, et tu en fais un dossier de lecture pour la journaliste.",
  "aide": "Elle retrouve dans les archives de Posthumain les articles et les sources déjà publiés sur un sujet, et en fait un dossier de lecture.",
  "exemples": ["Prépare-moi un dossier d'archives sur les interfaces cerveau-machine.", "Qu'avons-nous déjà publié sur CRISPR ?"],
  "aiguillage": "retrouver les articles et sources déjà publiés par Posthumain sur un sujet (dossier d'archives)",
  "contexte": ["fiches"], "mail": null,
  "plan": { "x": 1305, "y": 250, "teinte": 95 },
  "capacites": ["dossier_archives", "ouvrir"]
}
```

Ajouter dans `capacites` (et `"documentaliste"` dans les `postes` de la capacité `ouvrir`) :

```json
{
  "id": "dossier_archives", "nom": "📚 Dossier d'archives", "postes": ["documentaliste"],
  "description": "prépare un dossier des articles et sources déjà publiés sur un sujet. Paramètres : sujet",
  "aide": "Rassemble les articles et les sources déjà publiés par Posthumain sur un sujet, en une liste à lire.",
  "fournir": "le sujet",
  "exemples": ["Dossier d'archives sur les interfaces cerveau-machine.", "Retrouve nos articles sur l'IA au travail."],
  "params": { "sujet": { "type": "texte", "requis": true, "long": 200 } },
  "droits": "tous", "mode": "immediat",
  "executeur": { "type": "api", "mode": "archives", "bureau": "documentaliste", "libelle": "fouille les archives",
    "donnees": { "sujet": "$p.sujet" }, "liste": { "chemin": "documents", "format": "{titre} · {date}" },
    "resultat": "{n} document(s) trouvé(s)" },
  "carte": { "titre": "📚 Dossier d’archives : {p.sujet}", "bouton": "📚 Préparer le dossier" }
}
```

Ici l'exécuteur appelle `api('archives')` : il faut donc aussi créer cette action dans le webhook n8n
(nœud « Que demande la page ? » puis la branche qui répond), et faire apparaître l'appel `api('archives'…`
dans app.js. Le test refuse un exécuteur `api` introuvable dans la page.

Ensuite :

1. `node scripts/wl-catalogue.mjs --ecrire`
2. `node scripts/wl-catalogue.mjs`
3. commit, push, redéploiement de wl-tel.

La Documentaliste a son bureau, son ☎️, sa dictée, sa fiche de poste, son bouton ⓘ, et les autres postes peuvent lui
transmettre les demandes d'archives (captures `wl-catalogue-poste-fictif.png` et `wl-info-documentaliste.png`). Démonstration au harnais : capture `wl-catalogue-poste-fictif.png`,
avec ce poste uniquement dans le catalogue de test.

## Ce que le test vérifie

- Chaque poste a ses champs obligatoires (dont `aide`, `exemples`, `aiguillage`) et des capacités qui existent ; chaque
  capacité a son aide (`nom`, `aide`, `fournir`, `exemples`) ; chaque station du plan a son aide ; `aiguillage.contacts_interview`
  vise un poste existant qui n'est pas un poste de courrier. Chaque capacité a un porteur qui la
  liste, un schéma valide, des droits, un mode, une carte et un exécuteur qui existe :
  - `api('…')` présent dans app.js ;
  - action présente dans wl-tel ;
  - fonction présente dans `PAGE_EXEC`.
- **Toute action `api('…')` de app.js** est l'exécuteur d'une capacité, ou figure dans `interne` avec sa raison :
  ce sont les boutons habituels (envoi validé, corrections de fiche…).
- **Toute action de wl-tel** (`b.action === "…"`) est un exécuteur de capacité (`action`, `envoi`, `ecarter`, `lister`) ou
  figure dans `interne_tel` avec sa raison (téléphone, canal, « ✓ Marquer comme traitée »…).
- wl-tel n'a plus de postes codés en dur.
- Les copies du catalogue (app.js, wl-tel/catalogue.ts) sont à jour.
