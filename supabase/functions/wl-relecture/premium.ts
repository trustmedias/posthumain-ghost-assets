// Writinglab — conversion d'une actu en ACTU PREMIUM (02/11/2026, demande de Jonathan) : fonctions pures, testées hors ligne
// (deno test supabase/functions/wl-relecture/premium_test.ts).
//
// Une actu de l'Usine dont la partie « que faire de cette information » vaut de l'or devient une actu premium SANS être réécrite :
// le Correcteur ne touche qu'à la section finale (2 à 4 paragraphes réécrits ou ajoutés, nourris par les sources déjà citées), choisit
// la coupure (phrase de tension lisible, puis UNE phrase d'amorce) et le lab pose exactement ce que pose l'Usine pour une actu premium :
// les deux cartes d'amorce (web + e-mail payants / e-mail gratuits), la coupure paywall, la visibilité « paid » et le tag actu-premium.
// Brouillons et articles programmés seulement : un article publié a déjà été envoyé en entier par e-mail aux inscrits gratuits.
import { type Bloc, court, noeudVersBloc, signature } from "./blocs.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

// Sections du guide de relecture utiles à la conversion (le reste du skill ne sert pas ici : moins de jetons, moins de coût).
export function extraitGuide(guide: string): string {
  const g = "\n" + String(guide || "");
  const section = (n: string) => {
    const i = g.search(new RegExp("\\n## " + n + "\\. "));
    if (i < 0) return "";
    const j = g.slice(i + 1).search(/\n## \d/);
    return g.slice(i + 1, j < 0 ? undefined : i + 1 + j).trim();
  };
  const sous = (titre: RegExp) => {
    const i = g.search(titre);
    if (i < 0) return "";
    const j = g.slice(i + 1).search(/\n##{1,2} /);
    return g.slice(i + 1, j < 0 ? undefined : i + 1 + j).trim();
  };
  // 9.5 (outils Ghost, card_visibility) : sans objet ici, c'est le lab qui pose tout
  const s9 = section("9").replace(/\n### 9\.5[\s\S]*?(?=\n### 9\.6)/, "\n");
  return [section("2"), sous(/\n### 4bis\./), section("8"), s9, section("10")].filter(Boolean).join("\n\n");
}

export const OUTIL_CONVERSION = {
  name: "rendre_conversion",
  description: "Rendu final de la conversion en actu premium (un seul appel, à la toute fin).",
  input_schema: { type: "object", required: ["resume", "coupure"], properties: {
    resume: { type: "string", description: "En 2 ou 3 phrases pour le rédacteur en chef (sur téléphone) : ce qui devient premium, ce que la section finale apporte de plus, où tombe la coupure." },
    corrections: { type: "array", description: "Blocs EXISTANTS réécrits (section finale surtout ; carte des sources si tu ajoutes une source), dans l'ordre de l'article.", items: { type: "object", required: ["bloc", "resume"], properties: {
      bloc: { type: "integer" }, md: { type: "string", description: "Texte COMPLET du bloc après réécriture." },
      items: { type: "array", items: { type: "string" }, description: "Pour une liste : toutes les puces." },
      html: { type: "string", description: "Pour la carte des sources uniquement : l'<ol> complète, sources ajoutées comprises." },
      resume: { type: "string", description: "Ce qui change et pourquoi, en une phrase." }, details: { type: "array", items: { type: "string" } },
      sources: { type: "array", items: { type: "string" }, description: "URL des pages qui appuient les faits ajoutés." } } } },
    insertions: { type: "array", description: "Nouveaux blocs (paragraphes, intertitres h3, listes) de la section finale.", items: { type: "object", required: ["apres", "blocs", "resume"], properties: {
      apres: { type: "integer", description: "Numéro du bloc après lequel insérer." },
      blocs: { type: "array", items: { type: "object", properties: { t: { type: "string", enum: ["p", "h3", "ul", "ol"] }, md: { type: "string" }, items: { type: "array", items: { type: "string" } } } } },
      resume: { type: "string" }, details: { type: "array", items: { type: "string" } }, sources: { type: "array", items: { type: "string" } } } } },
    coupure: { type: "object", required: ["apres", "amorce"], properties: {
      apres: { type: "integer", description: "Numéro du bloc EXISTANT (paragraphe) qui porte la phrase de tension, à sa fin : la coupure tombe juste après lui. Tout bloc que tu insères après ce numéro (ou plus loin) est dans la partie payante." },
      amorce: { type: "string", description: "LA phrase d'amorce : une seule phrase, concrète, qui commence la partie payante et s'efface dans le fondu. Texte brut, sans mise en forme, sans référence au paywall." },
      raison: { type: "string", description: "Pourquoi couper là, en une phrase." } } },
    a_verifier: { type: "array", items: { type: "string" }, description: "Ce que le rédacteur en chef doit vérifier lui-même." },
  } },
};

export function systemeConversion(guideExtrait: string, kb: string): string {
  return [
    "Tu es « Le Correcteur » du Writinglab de Posthumain (média francophone sur abonnement : IA, tech, science ; Ghost ; posthumain.com). Mission : transformer une ACTU déjà écrite par l'Usine en ACTU PREMIUM, sans la réécrire. Le rédacteur en chef valide tout avant que rien ne parte dans Ghost.",
    "=== CE QU'EST UNE ACTU PREMIUM ===\n" + [
      "L'article reste gratuit jusqu'à la section finale (« La stratégie Posthumain », « Ce qu'on peut en faire », « Mode d'emploi » ou équivalent). Cette section devient la valeur payante : ce que le lecteur peut concrètement faire de l'information, par profil ou par horizon de temps, avec des chiffres et des exemples réels.",
      "La coupure tombe DANS la section finale : son intertitre et un premier paragraphe qui pose l'enjeu restent gratuits et finissent par une phrase de tension entièrement lisible ; vient ensuite UNE phrase d'amorce (champ « amorce ») qui commence la partie payante et s'efface dans le fondu ; tout le reste de la section est réservé aux abonnés. Si la partie gratuite répond déjà à « que faire ? », la coupure a échoué.",
      "« coupure.apres » = le numéro du paragraphe EXISTANT qui se termine par la phrase de tension (réécris-le dans « corrections » s'il le faut). Tout bloc inséré après ce numéro, ou plus loin, est dans la partie payante : la partie payante doit compter au moins deux blocs de texte.",
      "Le lab pose lui-même les deux cartes d'amorce (version web + e-mail des abonnés, version coupée pour l'e-mail des gratuits), la coupure, la visibilité « paid » et le tag actu-premium : tu ne rends que le texte.",
      "Le texte ne fait JAMAIS référence au paywall, au mur, à l'abonnement ni au fait que la suite est réservée (ni « derrière le mur », ni « réservé aux abonnés », ni « la suite pour nos abonnés »).",
    ].map((x) => "- " + x).join("\n"),
    "=== CONTRAT : CHANGER LE MOINS POSSIBLE ===\n" + [
      "L'article t'est donné en BLOCS numérotés [i]. Tout ce qui précède la section finale reste tel quel : n'y touche pas, sauf une erreur flagrante qui contredirait la section finale (alors une correction minimale, expliquée).",
      "Section finale : réécris ou complète 2 à 4 paragraphes (au plus 6 blocs en tout). Si elle dépasse 3 ou 4 paragraphes, structure-la en intertitres h3 (2 à 4 sous-axes). Garde le style de l'article : paragraphes courts, un gras au plus par paragraphe, jargon expliqué entre parenthèses, vouvoiement si l'article vouvoie.",
      "Un bloc réécrit = un élément de « corrections » avec son texte COMPLET après réécriture, même mise en forme : **gras**, *italique*, [texte](url), \\[ et \\] pour des crochets littéraux. Les appels de source gardent EXACTEMENT le format déjà utilisé dans l'article (recopie un appel existant).",
      "Un bloc nouveau va dans « insertions » (« apres » = numéro du bloc qui le précède). Pas de suppression de bloc, pas de changement de type de bloc.",
      "Les blocs 🔒 (encarts d'abonnement, images, graphiques, cartes HTML) sont recopiés à l'identique par le lab : n'y touche pas.",
      "Titre, sous-titre et métadonnées ne changent pas.",
    ].map((x) => "- " + x).join("\n"),
    "=== RÉUTILISER CE QUI EXISTE, SANS EXPLOSER LES COÛTS ===\n" + [
      "Matière première : l'article lui-même, ses chiffres et ses graphiques, et les pages de sa liste de sources. Rouvre en priorité les pages déjà citées (web_fetch, 6 au plus) pour en tirer ce que l'Usine n'avait pas exploité : chiffres, conditions, dates, démarches, limites.",
      "Recherche web : 2 au plus, seulement pour combler un vrai manque de la partie « que faire » (une démarche, un tarif, un délai, une règle hors de France). Pas de recherche pour reformuler ce qu'on sait déjà.",
      "Chaque fait nouveau porte un appel de source ; une source nouvelle s'ajoute à la fin de la carte des sources (correction de ce bloc avec l'<ol> complète, même balisage que les autres entrées, numéro suivant). 2 ou 3 appels nouveaux au plus.",
      "Rien d'inventé, rien d'exagéré pour faire spectaculaire. Pas de conseil d'investissement personnalisé ni de promesse de gain : des repères, des scénarios, les risques et les questions à se poser. Si le sujet n'offre pas de levier d'action fort, livre une analyse honnête et profonde plutôt qu'une liste creuse.",
      "Une fois le texte prêt, appelle « rendre_conversion » une seule fois.",
    ].map((x) => "- " + x).join("\n"),
    "=== RÈGLES DU GUIDE DE RELECTURE (extraits : anti-IA, lecteurs hors de France, ton, paywall de tension, section finale) ===\n" + guideExtrait,
    kb ? kb + "\n(Base de connaissances de la rédaction : appuie-toi dessus sans la recopier.)" : "",
  ].filter(Boolean).join("\n\n");
}

export function blocsPourIA(blocs: Bloc[]): string {
  return blocs.map((b) => {
    if (b.t === "protege") return "[" + b.i + "] 🔒 " + b.genre + (b.legende ? " · légende : « " + b.legende + " »" : "") + (b.resume ? " · « " + court(b.resume, 300) + " »" : "");
    if (b.t === "sources") return "[" + b.i + "] (sources, carte HTML modifiable) " + b.html;
    if (b.t === "ul" || b.t === "ol") return "[" + b.i + "] (" + b.t + ")\n" + (b.items || []).map((x, k) => (b.t === "ol" ? (k + 1) + ". " : "- ") + x).join("\n");
    return "[" + b.i + "] (" + b.t + ") " + b.md;
  }).join("\n\n");
}

// deno-lint-ignore no-explicit-any
export function messageConversion(p: any, blocs: Bloc[]): Any[] {
  const tags = (p.tags || []).map((t: { name: string }) => t.name).filter(Boolean);
  const entete = ["Actu à convertir en actu premium (" + (p.status === "scheduled" ? "article programmé" : "brouillon") + ") :", "Titre : " + (p.title || ""), "Sous-titre : " + (p.custom_excerpt || "(vide)"),
    "Tags : " + (tags.join(", ") || "(aucun)"), "Date du jour : " + new Date().toISOString().slice(0, 10), "", "BLOCS DE L'ARTICLE :"].join("\n");
  return [{ type: "text", text: entete + "\n" + blocsPourIA(blocs) }, { type: "text", text: "Convertis cette actu en actu premium selon le contrat (section finale enrichie, coupure, phrase d'amorce), puis appelle « rendre_conversion » une seule fois.", cache_control: { type: "ephemeral" } }];
}

// Un article peut-il être converti ? (null = oui, sinon la raison)
// deno-lint-ignore no-explicit-any
export function raisonRefus(p: any): string | null {
  if (!p) return "article introuvable";
  if (p.email_only) return "article « e-mail seulement » : pas de version web à rendre premium";
  if (p.status === "published" || p.status === "sent") return "article déjà publié : il a déjà été envoyé en entier aux inscrits gratuits. La conversion ne prend que les brouillons et les articles programmés";
  if (!["draft", "scheduled"].includes(String(p.status))) return "statut de l'article non pris en charge (" + p.status + ")";
  if (["paid", "tiers"].includes(String(p.visibility))) return "article déjà réservé aux abonnés payants";
  const slugs = (p.tags || []).map((t: { slug: string }) => String(t.slug || "").toLowerCase());
  if (slugs.includes("premium") || slugs.includes("actu-premium")) return "article déjà premium";
  if (slugs.includes("videos")) return "article vidéo : hors du lab";
  let lex: Any = null; try { lex = typeof p.lexical === "string" ? JSON.parse(p.lexical) : p.lexical; } catch { lex = null; }
  const kids: Any[] = (lex && lex.root && lex.root.children) || [];
  if (!kids.length) return "article sans contenu lisible";
  if (kids.some((n) => n && n.type === "paywall")) return "l'article a déjà une coupure paywall";
  if (kids.some((n) => n && n.type === "html" && /data-ph-teaser-(full|cut)/.test(String(n.html || "")))) return "l'article a déjà des cartes d'amorce";
  return null;
}

// Contrôle de la coupure rendue par le Correcteur. Renvoie la coupure propre, ou une erreur lisible.
export function normaliserCoupure(c: Any, blocs: Bloc[]): { apres: number; amorce: string; raison: string } | { erreur: string } {
  const apres = Math.round(Number(c && c.apres));
  const b = blocs.find((x) => x.i === apres);
  if (!b) return { erreur: "coupure : bloc [" + (c && c.apres) + "] introuvable" };
  if (b.t !== "p") return { erreur: "coupure : le bloc [" + apres + "] n'est pas un paragraphe (" + (b.t === "protege" ? b.genre : b.t) + ")" };
  if (apres < blocs.length * 0.3) return { erreur: "coupure trop haute dans l'article (bloc " + apres + " sur " + blocs.length + ") : la partie gratuite serait trop courte" };
  const sources = blocs.find((x) => x.t === "sources");
  if (sources && apres > sources.i) return { erreur: "coupure placée après la liste des sources" };
  const amorce = String((c && c.amorce) || "").replace(/\s+/g, " ").replace(/\*+/g, "").trim();
  if (amorce.length < 40) return { erreur: "phrase d'amorce absente ou trop courte" };
  if (amorce.length > 420) return { erreur: "phrase d'amorce trop longue (une seule phrase attendue)" };
  if ((amorce.replace(/[.!?…]+\s*$/, "").match(/[.!?](\s|$)/g) || []).length > 0) return { erreur: "la phrase d'amorce doit être une seule phrase" };
  if (/paywall|\bmur\b|abonn[ée]s?\b|r[ée]serv[ée]e? aux/i.test(amorce)) return { erreur: "la phrase d'amorce parle du paywall ou des abonnés" };
  return { apres, amorce, raison: court(c && c.raison, 400) };
}

const escH = (s: string) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
// Version coupée de l'amorce (e-mail des inscrits gratuits) : la même phrase, coupée en plein mot vers 85 %, suivie de « … ».
export function amorceCoupee(phrase: string): string {
  const s = String(phrase || "").trim().replace(/[.!?…]+$/, "");
  const mots = s.split(" ");
  if (mots.length < 4) return s + "…";
  const cible = Math.floor(s.length * 0.85);
  let pos = 0, k = 0;
  for (; k < mots.length; k++) { if (pos + mots[k].length >= cible) break; pos += mots[k].length + 1; }
  if (k >= mots.length - 1) k = mots.length - 2;
  const mot = mots[k], garde = Math.max(2, Math.min(mot.length - 2, Math.ceil(mot.length * 0.6)));
  return mots.slice(0, k).concat([mot.length > 4 ? mot.slice(0, garde) : mot]).join(" ") + "…";
}
const ALL = "status:free,status:-free";
// Les trois nœuds Lexical de la coupure, identiques à ceux que pose l'Usine pour une actu premium (vérifié sur « 22 000 qubits… »).
export function noeudsCoupure(amorce: string): Any[] {
  const carte = (attr: string, texte: string) => '<div class="gh-content" ' + attr + '="">\n  <p>' + escH(texte) + "</p>\n</div>";
  return [
    { type: "html", version: 1, html: carte("data-ph-teaser-full", amorce), visibility: { web: { nonMember: true, memberSegment: ALL }, email: { memberSegment: "status:-free" } } },
    { type: "html", version: 1, html: carte("data-ph-teaser-cut", amorceCoupee(amorce)), visibility: { web: { nonMember: false, memberSegment: "" }, email: { memberSegment: "status:free" } } },
    { type: "paywall", version: 1 },
  ];
}
// Coupure en deux temps, pour que les réécritures retrouvent l'article tel qu'il était : (1) on marque le paragraphe de la phrase de
// tension dans l'article ACTUEL (retrouvé par son contenu), (2) on applique les réécritures, (3) on pose les cartes et la coupure juste
// après le paragraphe marqué. Les blocs insérés après ce paragraphe passent donc APRÈS la coupure (partie payante).
const MARQUE = "__ph_coupure";
export function marquerCoupure(lex: Any, avant: Bloc[], apres: number): void {
  const kids: Any[] = lex.root.children;
  if (kids.some((n) => n && n.type === "paywall")) throw new Error("l'article a déjà une coupure paywall");
  const b = avant.find((x) => x.i === apres);
  if (!b) throw new Error("bloc de coupure introuvable");
  const sig = signature(b);
  const pos = kids.map((n, i) => signature(noeudVersBloc(n, i)) === sig ? i : -1).filter((i) => i >= 0);
  if (!pos.length) throw new Error("le paragraphe où tombe la coupure a été modifié dans Ghost depuis la proposition : relancez la conversion");
  kids[pos.length === 1 ? pos[0] : (pos.includes(apres) ? apres : pos[0])][MARQUE] = true;
}
export function poserCoupure(lex: Any, amorce: string): void {
  const kids: Any[] = lex.root.children;
  const k = kids.findIndex((n) => n && n[MARQUE]);
  if (k < 0) throw new Error("coupure perdue pendant l'application des réécritures");
  kids.forEach((n) => { if (n) delete n[MARQUE]; });
  kids.splice(k + 1, 0, ...noeudsCoupure(amorce));
}
// Ce qui reste payant après la coupure (blocs de texte existants avant la liste des sources + blocs insérés après la coupure).
export function blocsPayants(blocs: Bloc[], apres: number, insertions: { apres: number; blocs: unknown[] }[]): number {
  const fin = (blocs.find((x) => x.t === "sources") || { i: Infinity }).i;
  const existants = blocs.filter((x) => x.i > apres && x.i < fin && ["p", "h2", "h3", "ul", "ol", "quote"].includes(x.t)).length;
  const inseres = insertions.filter((x) => x.apres >= apres && x.apres < fin).reduce((n, x) => n + (x.blocs || []).length, 0);
  return existants + inseres;
}
