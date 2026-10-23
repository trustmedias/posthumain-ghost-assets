# Writinglab — la rédaction de Posthumain (posthumain.com/writinglab)

Demande de Jonathan (20/10/2026) : un lab pour la rédaction, sur le principe du Videolab (bureau vu de haut, chaque
agent IA est un employé, ses fiches flottent au-dessus de sa tête), mais **un outil à part** : rien n'est partagé avec
le Videolab.

## Les employés
- **La journaliste** (une par compte de l'équipe) : choisit l'article en cours parmi les brouillons Ghost.
- **L'Assistant** : propose qui interroger (auteurs des études citées, avec adresse seulement si elle est publiée
  officiellement) et des questions ; la journaliste garde, fait reformuler ou retire chaque question.
- **La Secrétaire** : rédige le mail (demande d'interview, message libre, relance). **Rien ne part sans le clic
  « Valider et envoyer »** de la journaliste, après relecture et corrections.
- **Le Courrier** : relève les boîtes toutes les 30 min en semaine (7 h – 21 h) ou sur demande, range chaque réponse
  dans sa fiche.
- **Le Marbre (Ghost)** : les brouillons ; la citation validée est insérée dans le brouillon, après le bloc choisi.
- **Le bureau du rédacteur en chef** : vue d'ensemble de l'équipe et de l'activité.
- **L'interphone** : messages entre la rédaction et le rédacteur en chef (à la place de Google Chat, qui exige
  Google Workspace).

## Comment c'est branché
- `page.html` : petit chargeur publié dans la page Ghost `/writinglab` (déclencheur manuel « 🛠️ Publier la page
  Writinglab » du workflow, à relancer seulement si ce fichier change).
- `app.js` : l'application, servie par le webhook **après** vérification du jeton d'identité du membre Ghost connecté.
  La modifier ici et pousser suffit (le webhook la relit sur GitHub à chaque ouverture).
- **Un seul webhook** : `POST https://trustmedias.app.n8n.cloud/webhook/writinglab`, workflow n8n
  « Posthumain — Writinglab (la rédaction) » (`18DWxWhSFckDXhvn`). Le champ `mode` dit ce qu'on demande :
  `app`, `etat`, `questions`, `contacts`, `reformuler`, `rediger`, `citation`, `envoyer`, `paragraphes`, `inserer`,
  `maj`, `ecrire`, `relever`.
- Données : tables n8n « Writinglab fiches » (une fiche par contact) et « Writinglab messages » (interphone).

## Boîtes mail (Infomaniak, oct. 2026)
- 4 boîtes : jonathan.paiano@, valisoa.rasolofo@, subs@ (service client), redaction@ (marketing).
- Envoi : nœuds « ✉️ Envoi — x » (credentials « SMTP — x », mail.infomaniak.com:465 SSL). Relève : déclencheurs « 📥 IMAP — x » (credentials « IMAP — x », port 993), en continu.
- Tri des mails reçus par règles fixes dans « Courrier — trier » (aucun appel à Claude) : notifications, newsletters, réponses automatiques écartées ;
  subs@/redaction@ → table « Writinglab courrier » (bureaux de Julien, visibles du rédacteur en chef seulement) ; jonathan/valisoa → fiche du chercheur qui répond.
- Julien ne rédige (Claude Haiku) que sur clic « Proposer une réponse », à partir de la base de connaissances de son domaine (Paramètres → 📚 Base de connaissances ; repli sur `connaissances/*.md`) ; rien ne part sans « Valider et envoyer ».
- Base de connaissances (rédacteur en chef) : un onglet par domaine du catalogue (Rédaction, Service client, Marketing), Instructions pré-remplies depuis `connaissances/*.md`, documents et sites résumés par Claude (fonction `wl-kb`, tables `wl_kb_*`, stockage privé `writinglab/kb/`).
- Ajouter quelqu'un : ligne dans `EQUIPE` (nœud Accès), boîte dans `BOITES`/`ADRESSES`, sortie dans « Boîte ? » + nœud d'envoi SMTP + déclencheur IMAP.

## Garde-fous
- Insertion dans Ghost **en Lexical**, jamais en HTML (les encarts CTA et leur visibilité restent intacts),
  et seulement dans un brouillon ou un article programmé.
- Une journaliste ne voit et ne modifie que ses fiches ; le rédacteur en chef voit tout.
- Les réponses reçues sont données à Claude comme des données, jamais comme des instructions.

## Mode clair / sombre (22/10/2026)
- Même réglage que tout le site : cookie `tlj_theme` (white | dark), piloté par `shared/theme-mode.js` (chargé par `page.html`, épinglé sur un commit). Bouton ☀️/🌙 dans la barre du lab.
- La page est **isolée** (`PHTheme.isoler()`) : jamais de classe `white-mode` sur `<html>` (le thème du site, en clair, force fond blanc / texte noir sur toute la page) ; le clair est signalé par `ph-clair`.
- La feuille claire est **dérivée** de la feuille sombre (`PHTheme.deriverClair(CSS, '#wl', '#wl.wl-clair')`) : elle ne s'applique que sous `#wl.wl-clair`, donc le sombre reste identique. Compléments à la main dans `CSS_CLAIR_MAIN` (sols du plan, textes forcés par le thème).
- L'en-tête Ghost (voile anti-flash) est `shared/lab-head.html`, recopié automatiquement par « 🛠️ Publier la page Writinglab ».

## Briques communes avec le Videolab (22/10/2026)
Écran de chargement, appels au webhook, boutons occupés, confirmations, toasts, thème, porte de couloir « Aller au Videolab » :
voir `shared/README.md`. `page.html` ne contient plus que la configuration de l'écran de chargement.
