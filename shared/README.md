# Modules partagés des labs (Writinglab, Videolab)

Demande de Jonathan (22/10/2026) : tout ce qui ne dépend pas du métier d'un lab est écrit **une seule fois** ici, pour qu'une
amélioration faite pour l'un profite à l'autre.

| Fichier | Rôle | Comment il arrive dans la page |
|---|---|---|
| `theme-mode.js` | Mode clair / sombre : même réglage que tout posthumain.com (cookie `tlj_theme`), page isolée du `white-mode` du thème, feuille claire dérivée de la feuille sombre. Utilisé aussi par /vote. | `page.html` de chaque lab, épinglé sur un commit |
| `lab-boot.js` | Écran de chargement (le plan se dessine, chacun rejoint son bureau), appels au webhook n8n du lab avec le jeton Ghost (gardé 2 min, redemandé s'il a expiré), téléchargement puis lancement de l'application. Configuré par chaque `page.html` (pièces, personnages, phrases, couleurs). | `page.html` de chaque lab, épinglé sur le **même** commit que `theme-mode.js` |
| `lab-core.js` | Briques de l'application : `esc`/`url` (liens http(s) seulement), jeton Ghost et appels Supabase, boutons « occupés » (roue, garde anti double-clic, barre en haut), fenêtre de confirmation, toasts, mode clair/sombre du lab, défilement conservé, relecture au retour sur l'onglet, porte de couloir RPG, et leurs styles (`cssParts`). | **Avec l'application**, par le webhook du lab (nœud n8n « App »), lu sur `main` : toujours à jour, aucune exécution de plus |
| `lab-head.html` | En-tête de la page Ghost (« Code injection > Header ») : voile anti-flash, isolement du mode clair. | Recopié automatiquement par le nœud n8n « Page Ghost » de chaque lab (déclencheur « 🛠️ Publier la page … »), avec les couleurs de fond du lab |

## Changer `lab-core.js`
Pousser sur `main` suffit : les deux labs le reçoivent à leur prochaine ouverture (cache GitHub d'environ 5 min).
Les styles (`cssParts`) sont insérés par chaque lab à leur place dans sa feuille, puis passent par sa feuille claire dérivée.

## Changer `lab-boot.js` ou `theme-mode.js`
Ils s'exécutent avant l'application, donc ils sont chargés par jsDelivr, épinglés sur un commit (une version figée, jamais de
cache périmé) :
1. pousser la modification ;
2. remplacer le commit dans les **deux** balises `<script>` de `writinglab/page.html` (dépôt posthumain-ghost-assets) et de
   `videolab/page.html` (dépôt posthumain-motion) — le même commit partout ;
3. relancer « 🛠️ Publier la page Writinglab » et « 🛠️ Publier la page Videolab » (une exécution manuelle chacun).

## Navigation entre les labs
`PHLab.porteSVG({ x, y, dir, taille, href, titre, sous })` dessine au bout du couloir une flèche qui pulse (vrai lien `<a>` :
clic, clavier, clic molette) : « Aller au Videolab » dans le Writinglab, « Aller au Writinglab » dans le Videolab.
