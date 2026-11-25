// Writinglab — wl-relecture : « ⚖️ IA contre la journaliste » (25/11/2026 ; demande de Jonathan du 25/10 : mesurer avec le temps si le
// Correcteur relit aussi bien que la journaliste les articles sortis de l'Usine). Module pur (aucun accès réseau), testé hors ligne :
// deno test supabase/functions/wl-relecture/comparaison_test.ts
//
// Principe :
//  1. La VERSION D'ORIGINE de l'Usine est la première version gardée par l'historique de Ghost (raison « initial_revision »).
//  2. Le travail de la JOURNALISTE = ce qui a changé entre cette version et sa dernière version à elle. Chaque passage changé est
//     attribué à celui qui l'a écrit (historique des versions) : ce qu'ont changé le rédacteur en chef ou les automates entre-temps
//     est « hors match », ni pour ni contre elle.
//  3. Le CORRECTEUR relit la version d'origine sans rien voir de ce travail (relecture normale, jamais poussée dans Ghost).
//  4. Un JUGE reçoit les deux relectures sous les noms « Relecture A » et « Relecture B », tirés au sort : il ne sait pas laquelle
//     vient de l'IA. Il vérifie sur le web les faits que l'une ou l'autre a changés, note chacune et dit qui a fait le meilleur travail.
// deno-lint-ignore-file no-explicit-any
import { type Bloc, court } from "./blocs.ts";
type Any = any;

// ---------- Texte comparable d'un bloc ----------
// Seuls les blocs de texte se comparent (paragraphes, intertitres, listes, citations, liste des sources). Les blocs protégés (encarts
// d'abonnement, images, graphiques, coupure) changent au fil de la publication sans que personne ne les relise : ils sont ignorés.
export function texteBloc(b: Bloc): string {
  if (!b || b.t === "protege") return "";
  if (b.t === "sources") return "(liste des sources)\n" + String(b.html || "").replace(/<a\s[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, "$2 ($1)").replace(/<\/li>/gi, "\n").replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/[ \t]+/g, " ").split("\n").map((x) => x.trim()).filter(Boolean).join("\n");
  if (b.t === "ul" || b.t === "ol") return (b.items || []).map((x) => "- " + x).join("\n");
  return (b.t === "p" ? "" : "(" + b.t + ") ") + String(b.md || "");
}
export const textesDe = (blocs: Bloc[]): string[] => (blocs || []).map(texteBloc).filter((x) => x.trim());

// ---------- Différence entre deux listes de blocs (plus longue sous-suite commune) ----------
export type Segment = { avant: string[]; apres: string[] };
export function diffTextes(a: string[], b: string[]): Segment[] {
  const n = a.length, m = b.length, T: Int32Array[] = [];
  for (let i = 0; i <= n; i++) T.push(new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) T[i][j] = a[i] === b[j] ? T[i + 1][j + 1] + 1 : Math.max(T[i + 1][j], T[i][j + 1]);
  const out: Segment[] = []; let cur: Segment | null = null, i = 0, j = 0;
  const flush = () => { if (cur) { decouper(cur, out); cur = null; } };
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) { flush(); i++; j++; continue; }
    cur = cur || { avant: [], apres: [] };
    if (j >= m || (i < n && T[i + 1][j] >= T[i][j + 1])) cur.avant.push(a[i++]); else cur.apres.push(b[j++]);
  }
  flush();
  return out;
}
// Autant de blocs avant qu'après : ce sont des paragraphes retouchés un à un, on les présente un par un.
function decouper(s: Segment, out: Segment[]) {
  if (s.avant.length === s.apres.length && s.avant.length > 1) for (let k = 0; k < s.avant.length; k++) out.push({ avant: [s.avant[k]], apres: [s.apres[k]] });
  else out.push(s);
}

// ---------- Le travail de la journaliste, lu dans l'historique des versions ----------
export type Revision = { date: string; auteur: string; journaliste: boolean; titre: string; extrait: string; textes: string[] };
export type Changement = { avant: string; apres: string; par?: "journaliste" | "mixte" | "autre" };
export type Humain = { changements: Changement[]; titre: Changement | null; extrait: Changement | null; versions: number; versions_journaliste: number; origine_le: string; fin_le: string };
// revs : versions de la plus ancienne à la plus récente ; la première est la version d'origine. Rend null si la journaliste n'a
// enregistré aucune version après elle.
export function changementsHumains(revs: Revision[]): Humain | null {
  let fin = -1;
  for (let k = revs.length - 1; k >= 1; k--) if (revs[k].journaliste) { fin = k; break; }
  if (fin < 1) return null;
  // qui a écrit chaque passage nouveau, qui a retiré chaque passage disparu (la dernière fois que c'est arrivé)
  const ecrit = new Map<string, boolean>(), retire = new Map<string, boolean>();
  let titrePar = false, extraitPar = false;
  for (let k = 1; k <= fin; k++) {
    const av = new Set(revs[k - 1].textes), ap = new Set(revs[k].textes), j = revs[k].journaliste;
    for (const t of ap) if (!av.has(t)) ecrit.set(t, j);
    for (const t of av) if (!ap.has(t)) retire.set(t, j);
    if (revs[k].titre !== revs[k - 1].titre) titrePar = j;
    if (revs[k].extrait !== revs[k - 1].extrait) extraitPar = j;
  }
  const changements: Changement[] = [];
  for (const s of diffTextes(revs[0].textes, revs[fin].textes)) {
    const votes = s.apres.map((t) => ecrit.get(t)).concat(s.avant.map((t) => retire.get(t))).filter((x) => x !== undefined);
    const j = votes.some((x) => x === true), a = votes.some((x) => x === false);
    changements.push({ avant: s.avant.join("\n\n"), apres: s.apres.join("\n\n"), par: j && a ? "mixte" : j ? "journaliste" : "autre" });
  }
  const champ = (avant: string, apres: string, j: boolean): Changement | null => (avant.trim() !== apres.trim() ? { avant, apres, par: j ? "journaliste" : "autre" } : null);
  return { changements, titre: champ(revs[0].titre, revs[fin].titre, titrePar), extrait: champ(revs[0].extrait, revs[fin].extrait, extraitPar),
    versions: revs.length, versions_journaliste: revs.filter((r, k) => k >= 1 && r.journaliste).length, origine_le: revs[0].date, fin_le: revs[fin].date };
}
const deLaJournaliste = (c: Changement | null) => !!c && c.par !== "autre";
export const nbChangementsJournaliste = (h: Humain | null) => (h ? h.changements.filter(deLaJournaliste).length + (deLaJournaliste(h.titre) ? 1 : 0) + (deLaJournaliste(h.extrait) ? 1 : 0) : 0);

// ---------- Le travail du Correcteur, mis sous la même forme (avant / après) ----------
export type RelectureIA = { titre?: string; extrait?: string; corrections?: Any[]; insertions?: Any[] };
export function changementsIA(ia: RelectureIA, blocs: Bloc[]): Changement[] {
  const parI: Record<number, Bloc> = {}; for (const b of blocs || []) parI[b.i] = b;
  const l: { pos: number; c: Changement }[] = [];
  for (const c of ia.corrections || []) {
    const b = parI[Number(c.bloc)]; if (!b) continue;
    const apres = texteBloc({ ...b, ...(c.md != null ? { md: String(c.md) } : {}), ...(Array.isArray(c.items) ? { items: c.items.map(String) } : {}), ...(c.html != null ? { html: String(c.html) } : {}) });
    const avant = texteBloc(b);
    if (apres !== avant) l.push({ pos: b.i, c: { avant, apres } });
  }
  for (const x of ia.insertions || []) {
    const apres = (Array.isArray(x.blocs) ? x.blocs : []).map((y: Any) => texteBloc({ i: -1, t: String(y?.t || "p"), md: y?.md, items: y?.items })).filter(Boolean).join("\n\n");
    if (apres) l.push({ pos: Number(x.apres) + 0.5, c: { avant: "", apres } });
  }
  return l.sort((a, b) => a.pos - b.pos).map((x) => x.c);
}

// ---------- Le juge ----------
const NOTE = { type: "number", description: "Note de 0 à 10 (une décimale possible)." };
const NOTES = { type: "object", required: ["faits", "sources", "style", "lisibilite", "globale"], properties: { faits: NOTE, sources: NOTE, style: NOTE, lisibilite: NOTE, globale: NOTE } };
export const TYPES_POINT = ["erreur_corrigee_par_les_deux", "erreur_corrigee_par_A", "erreur_corrigee_par_B", "erreur_introduite_par_A", "erreur_introduite_par_B", "erreur_manquee_par_les_deux", "amelioration_de_A", "amelioration_de_B", "apport_propre_de_A", "apport_propre_de_B"];
export const OUTIL_VERDICT = {
  name: "rendre_verdict",
  description: "Verdict final de la comparaison (un seul appel, à la toute fin, après les vérifications).",
  input_schema: { type: "object", required: ["gagnant", "resume", "notes", "points"], properties: {
    gagnant: { type: "string", enum: ["A", "B", "egalite"], description: "La relecture qui laisse le meilleur article au lecteur ; « egalite » si l'écart est faible ou tient à des goûts." },
    resume: { type: "string", description: "3 ou 4 phrases pour le rédacteur en chef (sur téléphone) : qui a fait le meilleur travail et pourquoi, concrètement." },
    notes: { type: "object", required: ["A", "B"], properties: { A: NOTES, B: NOTES } },
    points: { type: "array", description: "Les 25 constats les plus importants au plus, du plus grave au moins grave.", items: { type: "object", required: ["type", "gravite", "passage", "explication"], properties: {
      type: { type: "string", enum: TYPES_POINT }, gravite: { type: "string", enum: ["grave", "moyenne", "legere"] },
      passage: { type: "string", description: "Le passage concerné, en quelques mots (citation courte)." },
      explication: { type: "string", description: "Ce qui a été fait ou manqué, et pourquoi c'est juste ou faux, en une ou deux phrases. Pour un fait : ce que dit la source vérifiée." },
      source: { type: "string", description: "URL de la page qui a permis de vérifier, s'il y en a une." } } } },
    limites: { type: "string", description: "Ce que tu n'as pas pu vérifier ou départager, en une ou deux phrases (vide s'il n'y a rien à signaler)." },
  } },
};
export function systemeJuge(): string {
  return [
    "Tu es le juge d'un contrôle qualité de la rédaction de Posthumain (média francophone sur abonnement : IA, tech, science, pour le grand public curieux). Personne n'est là pour te répondre : fais tout le travail et rends-le avec l'outil « rendre_verdict ».",
    "On te remet un article dans sa VERSION D'ORIGINE (un premier jet), puis deux relectures indépendantes de ce même premier jet : « Relecture A » et « Relecture B ». Chacune est la liste des passages qu'un relecteur a changés (avant / après). Les deux relecteurs ont travaillé séparément, sans se voir. Tu ne sais pas qui ils sont et tu ne cherches pas à le deviner : seul compte l'article que chacun laisse au lecteur.",
    "CE QUE TU JUGES, dans cet ordre d'importance :\n" + [
      "Les FAITS : une erreur de fait, de chiffre, de date, de nom ou d'attribution corrigée est le meilleur travail possible ; une erreur introduite est le pire. Quand une relecture change un fait, ou que les deux ne disent pas la même chose, VÉRIFIE avec web_search et web_fetch (les liens des sources de l'article sont dans la version d'origine). Ton nombre de vérifications est limité : commence par ce qui compte le plus pour le lecteur. Un changement que tu n'as pas pu vérifier n'est ni une correction ni une erreur : tu le dis dans « limites ».",
      "Les SOURCES : liens exacts, bonne attribution, liste des sources juste et complète.",
      "Le STYLE : français correct et naturel, tournures mécaniques ou creuses retirées, pas de sens déformé, ton du média respecté. Un titre ou une accroche retouchés doivent garder l'angle de l'original.",
      "La LISIBILITÉ pour un lecteur non spécialiste : jargon expliqué, phrases claires, rien d'obscur laissé en place.",
    ].map((x) => "- " + x).join("\n"),
    "RÈGLES D'ÉQUITÉ :\n" + [
      "Changer beaucoup n'est pas mieux que changer peu : une relecture sobre et juste vaut mieux qu'une relecture abondante qui introduit des erreurs ou réécrit sans raison. Mais laisser passer une vraie erreur que l'autre a corrigée compte contre celle qui l'a laissée.",
      "Relis toi-même la version d'origine : une erreur que NI l'une NI l'autre n'a vue se signale aussi (erreur_manquee_par_les_deux).",
      "Un APPORT PROPRE est un contenu nouveau qu'une relecture ne peut pas produire seule : la citation d'une personne interrogée pour l'article, une information obtenue directement. Signale-le (apport_propre_de_A ou _de_B), mais il ne compte PAS dans les notes ni dans le verdict : on compare ici deux relectures, pas deux enquêtes. Ne le traite jamais comme une erreur au motif que tu ne peux pas le vérifier.",
      "La section « Hors match », si elle existe, liste des passages modifiés par d'autres personnes de la rédaction : ne les compte ni pour ni contre personne.",
      "Les différences de pur goût (deux formulations également bonnes) ne départagent pas : dans ce cas, « egalite ».",
    ].map((x) => "- " + x).join("\n"),
    "NOTES : pour chaque relecture, de 0 à 10, sur les faits, les sources, le style, la lisibilité, puis une note globale (les faits pèsent le plus). 5 = l'article n'est ni meilleur ni pire qu'avant ; au-dessus, la relecture l'a amélioré ; au-dessous, elle l'a abîmé.",
    "DANS TES TEXTES (résumé, explications, limites), désigne toujours les deux relectures par les mots exacts « Relecture A » et « Relecture B », jamais « A » ou « B » tout seuls : ils seront remplacés par les vrais noms après ton verdict.",
  ].join("\n\n");
}
const bloc = (c: Changement, k: number) => "Passage " + (k + 1) + "\nAVANT : " + (c.avant || "(rien : passage ajouté)") + "\nAPRÈS : " + (c.apres || "(passage supprimé)");
function relectureTxt(nom: string, titre: Changement | null, extrait: Changement | null, l: Changement[]): string {
  const t: string[] = ["===== " + nom + " ====="];
  if (titre) t.push("TITRE\nAVANT : " + titre.avant + "\nAPRÈS : " + titre.apres);
  if (extrait) t.push("SOUS-TITRE\nAVANT : " + (extrait.avant || "(vide)") + "\nAPRÈS : " + (extrait.apres || "(vide)"));
  t.push(l.length ? l.map(bloc).join("\n\n") : "(aucun passage du texte modifié)");
  return t.join("\n\n");
}
export type Ordre = "ia_A" | "ia_B";
export function messageJuge(x: { titre: string; extrait: string; blocs: Bloc[]; humain: Humain; ia: RelectureIA; ordre: Ordre }): string {
  const champ = (avant: string, apres: string | undefined): Changement | null => (apres && apres.trim() && apres.trim() !== avant.trim() ? { avant, apres } : null);
  const ia = relectureTxt("@", champ(x.titre, x.ia.titre), champ(x.extrait, x.ia.extrait), changementsIA(x.ia, x.blocs));
  const h = x.humain, hj = relectureTxt("@", deLaJournaliste(h.titre) ? h.titre : null, deLaJournaliste(h.extrait) ? h.extrait : null, h.changements.filter(deLaJournaliste));
  const A = (x.ordre === "ia_A" ? ia : hj).replace("@", "RELECTURE A"), B = (x.ordre === "ia_A" ? hj : ia).replace("@", "RELECTURE B");
  const hors = h.changements.filter((c) => c.par === "autre");
  return [
    "===== VERSION D'ORIGINE =====\nTitre : " + x.titre + "\nSous-titre : " + (x.extrait || "(vide)") + "\n\n" + textesDe(x.blocs).join("\n\n"),
    A, B,
    hors.length ? "===== HORS MATCH (modifié par d'autres personnes de la rédaction : ni pour ni contre personne) =====\n\n" + hors.map(bloc).join("\n\n") : "",
    "Date du jour : " + new Date().toISOString().slice(0, 10) + ". Vérifie ce qui doit l'être, puis appelle « rendre_verdict » une seule fois.",
  ].filter(Boolean).join("\n\n");
}

// ---------- Verdict : des lettres A / B aux vrais noms ----------
export type Notes = { faits: number; sources: number; style: number; lisibilite: number; globale: number };
export type Verdict = { gagnant: "ia" | "journaliste" | "egalite"; resume: string; notes: { ia: Notes; journaliste: Notes }; points: { type: string; gravite: string; passage: string; explication: string; source: string }[]; limites: string };
const note = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? Math.round(Math.min(10, Math.max(0, x)) * 10) / 10 : 0; };
const notes = (o: Any): Notes => ({ faits: note(o?.faits), sources: note(o?.sources), style: note(o?.style), lisibilite: note(o?.lisibilite), globale: note(o?.globale) });
export function mapperVerdict(o: Any, ordre: Ordre, nomJournaliste: string): Verdict {
  const iaEst = ordre === "ia_A" ? "A" : "B", qui = (lettre: string) => (lettre === iaEst ? "ia" : "journaliste");
  // « la Relecture A » → « la relecture du Correcteur » / « la relecture de <journaliste> » (l'article « la » est ajouté s'il manque)
  // Le juge écrit parfois « A » ou « B » tout court : remplacés seulement là où la lettre désigne sans doute une relecture (après
  // « de », « par », « à »…, ou en tête de phrase devant un verbe), jamais ailleurs (« A Dallas », « le plan B »).
  const nomDe = (l: string) => "la relecture " + (l.toUpperCase() === iaEst ? "du Correcteur" : "de " + (nomJournaliste || "la journaliste"));
  const noms = (s: unknown, n: number) => court(s, n).replace(/(\bla\s+)?\brelecture ([AB])\b/gi, (_m, _art, l) => nomDe(String(l)))
    .replace(/(^|[\s(«])(de|par|que|et|ou|chez|pour|comme|contre|à) ([AB])(?=$|[\s,.;:!?)»])/g, (_m, a, mot, l) => a + mot + " " + nomDe(l))
    .replace(/(^|[.!?:;]\s+)([AB])(?= (?:a|et|ou|n’a|n'a|est|corrige|laisse|ajoute|remplace|retire|garde|règle|fait|perd) )/g, (_m, a, l) => a + nomDe(l))
    .replace(/(^|[.!?:]\s+)(la relecture d)/g, (_m, a) => a + "La relecture d");
  const g = String(o?.gagnant || "");
  const points = (Array.isArray(o?.points) ? o.points : []).slice(0, 25).map((p: Any) => {
    const t = String(p?.type || "");
    if (!TYPES_POINT.includes(t)) return null;
    return { type: t.replace(/_(?:de_|par_)?([AB])$/, (_m, l) => "_" + qui(l)).replace(/_par_les_deux$/, "_les_deux"), gravite: ["grave", "moyenne", "legere"].includes(String(p?.gravite)) ? String(p.gravite) : "moyenne",
      passage: court(p?.passage, 300), explication: noms(p?.explication, 700), source: /^https?:\/\//.test(String(p?.source || "")) ? court(p.source, 600) : "" };
  }).filter(Boolean) as Verdict["points"];
  return { gagnant: g === "A" || g === "B" ? qui(g) : "egalite", resume: noms(o?.resume, 1000), notes: { ia: notes(o?.notes?.[iaEst]), journaliste: notes(o?.notes?.[iaEst === "A" ? "B" : "A"]) }, points, limites: noms(o?.limites, 700) };
}

// ---------- Bilan cumulé ----------
export type LigneBilan = { verdict: Verdict | null; cree: string };
const moy = (l: number[]) => (l.length ? Math.round((l.reduce((a, b) => a + b, 0) / l.length) * 10) / 10 : null);
export function bilan(lignes: LigneBilan[], maintenant = Date.now()) {
  const L = lignes.filter((x) => x.verdict && x.verdict.notes);
  const de = (l: LigneBilan[], qui: "ia" | "journaliste", k: keyof Notes) => moy(l.map((x) => x.verdict!.notes[qui][k]));
  const moyennes = (l: LigneBilan[]) => ({ ia: { faits: de(l, "ia", "faits"), sources: de(l, "ia", "sources"), style: de(l, "ia", "style"), lisibilite: de(l, "ia", "lisibilite"), globale: de(l, "ia", "globale") },
    journaliste: { faits: de(l, "journaliste", "faits"), sources: de(l, "journaliste", "sources"), style: de(l, "journaliste", "style"), lisibilite: de(l, "journaliste", "lisibilite"), globale: de(l, "journaliste", "globale") } });
  const age = (x: LigneBilan) => (maintenant - Date.parse(x.cree)) / 864e5;
  const recent = L.filter((x) => age(x) <= 30), avant = L.filter((x) => age(x) > 30 && age(x) <= 60);
  const ecart = (l: LigneBilan[]) => { const a = de(l, "ia", "globale"), b = de(l, "journaliste", "globale"); return a === null || b === null ? null : Math.round((a - b) * 10) / 10; };
  return { n: L.length, ia: L.filter((x) => x.verdict!.gagnant === "ia").length, journaliste: L.filter((x) => x.verdict!.gagnant === "journaliste").length, egalite: L.filter((x) => x.verdict!.gagnant === "egalite").length,
    moyennes: moyennes(L), tendance: { recent: { n: recent.length, ecart: ecart(recent) }, avant: { n: avant.length, ecart: ecart(avant) } } };
}
