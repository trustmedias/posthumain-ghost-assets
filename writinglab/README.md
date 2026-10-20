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

## Ajouter quelqu'un, brancher une boîte mail
1. Nœud **Accès** du workflow : ajouter une ligne dans `EQUIPE` (adresse du compte membre Ghost de la personne, son
   nom, son titre, `role: 'redaction'`, `boite`, signature).
2. Credential Microsoft Outlook de son adresse @posthumain.com dans n8n.
3. Nœud **Boîte ?** : ajouter une sortie (valeur = la `boite`), et derrière un nœud HTTP copié sur « Outlook —
   jonathan » avec la nouvelle credential, relié à « Graph — résultat ».
4. Ajouter la `boite` dans `BOITES` (nœud Accès) : le bouton « Valider et envoyer » s'allume pour elle.

## Garde-fous
- Insertion dans Ghost **en Lexical**, jamais en HTML (les encarts CTA et leur visibilité restent intacts),
  et seulement dans un brouillon ou un article programmé.
- Une journaliste ne voit et ne modifie que ses fiches ; le rédacteur en chef voit tout.
- Les réponses reçues sont données à Claude comme des données, jamais comme des instructions.
