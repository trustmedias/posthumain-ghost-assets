// Tests hors ligne de la comparaison « IA contre la journaliste » (wl-relecture/comparaison.ts).
// deno test supabase/functions/wl-relecture/comparaison_test.ts
import { bilan, changementsHumains, changementsIA, diffTextes, mapperVerdict, messageJuge, nbChangementsJournaliste, type Revision, texteBloc, textesDe } from "./comparaison.ts";
import type { Bloc } from "./blocs.ts";

const eq = (a: unknown, b: unknown, quoi: string) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(quoi + "\n  obtenu  : " + JSON.stringify(a) + "\n  attendu : " + JSON.stringify(b)); };
const vrai = (c: unknown, quoi: string) => { if (!c) throw new Error(quoi); };
const rev = (auteur: string, journaliste: boolean, titre: string, textes: string[], extrait = ""): Revision => ({ date: "2026-11-01T10:00:00Z", auteur, journaliste, titre, extrait, textes });

Deno.test("texteBloc : types de blocs, blocs protégés ignorés", () => {
  eq(texteBloc({ i: 0, t: "p", md: "Un **fait**." }), "Un **fait**.", "paragraphe");
  eq(texteBloc({ i: 1, t: "h2", md: "Titre" }), "(h2) Titre", "intertitre");
  eq(texteBloc({ i: 2, t: "ul", items: ["a", "b"] }), "- a\n- b", "liste");
  eq(texteBloc({ i: 3, t: "protege", genre: "encart" }), "", "protégé");
  eq(texteBloc({ i: 4, t: "sources", html: '<ol><li id="source-1"><strong>Nature</strong> – Étude<br>Résumé. (<a href="https://nature.com/x">nature.com</a>)</li></ol>' }), "(liste des sources)\nNature – Étude Résumé. (nature.com (https://nature.com/x))", "sources : l'URL reste visible");
  eq(textesDe([{ i: 0, t: "p", md: "A" }, { i: 1, t: "protege" }, { i: 2, t: "p", md: "B" }] as Bloc[]), ["A", "B"], "textesDe");
});

Deno.test("diffTextes : retouche, ajout, suppression", () => {
  eq(diffTextes(["a", "b", "c"], ["a", "b", "c"]), [], "identique");
  eq(diffTextes(["a", "b", "c"], ["a", "B", "c"]), [{ avant: ["b"], apres: ["B"] }], "un bloc retouché");
  eq(diffTextes(["a", "c"], ["a", "b", "c"]), [{ avant: [], apres: ["b"] }], "un bloc ajouté");
  eq(diffTextes(["a", "b", "c"], ["a", "c"]), [{ avant: ["b"], apres: [] }], "un bloc supprimé");
  eq(diffTextes(["a", "b", "c", "d"], ["a", "B", "C", "d"]), [{ avant: ["b"], apres: ["B"] }, { avant: ["c"], apres: ["C"] }], "deux blocs voisins retouchés : présentés un par un");
  eq(diffTextes([], ["x"]), [{ avant: [], apres: ["x"] }], "tout ajouté");
});

Deno.test("changementsHumains : chaque passage attribué à celui qui l'a écrit", () => {
  const revs = [
    rev("Usine", false, "Titre A", ["p1", "p2", "p3", "p4"]),
    rev("Chef", false, "Titre A", ["p1", "p2 (chef)", "p3", "p4"]),                 // le rédacteur en chef retouche p2
    rev("Valisoa", true, "Titre B", ["p1", "p2 (chef)", "p3 (val)", "p4", "p5 (val)"]), // la journaliste retouche p3, ajoute p5, change le titre
    rev("Chef", false, "Titre B", ["p1", "p2 (chef)", "p3 (val)", "p4 (chef)", "p5 (val)"]), // après elle : ignoré
  ];
  const h = changementsHumains(revs)!;
  eq(h.changements, [{ avant: "p2", apres: "p2 (chef)", par: "autre" }, { avant: "p3", apres: "p3 (val)", par: "journaliste" }, { avant: "", apres: "p5 (val)", par: "journaliste" }], "attribution");
  eq(h.titre, { avant: "Titre A", apres: "Titre B", par: "journaliste" }, "titre");
  eq(h.extrait, null, "sous-titre inchangé");
  eq([h.versions, h.versions_journaliste], [4, 1], "versions");
  eq(nbChangementsJournaliste(h), 3, "trois changements de la journaliste (deux passages + le titre)");
});

Deno.test("changementsHumains : passage retouché par les deux = mixte ; aucune version de la journaliste = null", () => {
  const h = changementsHumains([rev("Usine", false, "T", ["p1", "p2"]), rev("Chef", false, "T", ["p1 (chef)", "p2"]), rev("Valisoa", true, "T", ["p1 (chef, val)", "p2"])])!;
  eq(h.changements, [{ avant: "p1", apres: "p1 (chef, val)", par: "mixte" }], "mixte");
  eq(changementsHumains([rev("Usine", false, "T", ["p1"]), rev("Chef", false, "T", ["p1 bis"])]), null, "pas de journaliste");
  const rien = changementsHumains([rev("Usine", false, "T", ["p1"]), rev("Valisoa", true, "T", ["p1"])])!;
  eq(nbChangementsJournaliste(rien), 0, "version enregistrée sans rien changer");
});

const BLOCS: Bloc[] = [{ i: 0, t: "p", md: "Le modèle sort **mardi**." }, { i: 1, t: "protege", genre: "encart" }, { i: 2, t: "ul", items: ["un", "deux"] }, { i: 3, t: "p", md: "Fin." }];
const IA = { titre: "Nouveau titre", corrections: [{ bloc: 2, items: ["un", "deux", "trois"] }, { bloc: 0, md: "Le modèle sort **mercredi**." }, { bloc: 9, md: "inexistant" }, { bloc: 3, md: "Fin." }], insertions: [{ apres: 0, blocs: [{ t: "h2", md: "Sommaire" }] }] };

Deno.test("changementsIA : même forme avant / après, dans l'ordre de l'article", () => {
  eq(changementsIA(IA, BLOCS), [{ avant: "Le modèle sort **mardi**.", apres: "Le modèle sort **mercredi**." }, { avant: "", apres: "(h2) Sommaire" }, { avant: "- un\n- deux", apres: "- un\n- deux\n- trois" }], "corrections et insertion ; bloc inexistant et correction sans effet ignorés");
});

Deno.test("messageJuge : à l'aveugle, l'ordre décide qui est A ; le hors match est à part", () => {
  const humain = changementsHumains([rev("Usine", false, "Titre", ["Le modèle sort **mardi**.", "- un\n- deux", "Fin."]), rev("Chef", false, "Titre", ["Le modèle sort **mardi**.", "- un\n- deux", "Fin (chef)."]), rev("Valisoa", true, "Titre", ["Le modèle sort **jeudi**.", "- un\n- deux", "Fin (chef)."])])!;
  const a = messageJuge({ titre: "Titre", extrait: "", blocs: BLOCS, humain, ia: IA, ordre: "ia_A" }), b = messageJuge({ titre: "Titre", extrait: "", blocs: BLOCS, humain, ia: IA, ordre: "ia_B" });
  const partie = (m: string, nom: string) => m.split("===== " + nom + " =====")[1].split("=====")[0];
  vrai(partie(a, "RELECTURE A").includes("mercredi") && partie(a, "RELECTURE B").includes("jeudi"), "ia_A : l'IA est A");
  vrai(partie(b, "RELECTURE B").includes("mercredi") && partie(b, "RELECTURE A").includes("jeudi"), "ia_B : l'IA est B");
  vrai(partie(a, "RELECTURE A").includes("TITRE\nAVANT : Titre\nAPRÈS : Nouveau titre"), "titre proposé par l'IA");
  vrai(a.includes("HORS MATCH") && a.split("HORS MATCH")[1].includes("Fin (chef).") && !partie(a, "RELECTURE B").includes("Fin (chef)."), "le changement du chef est hors match");
  vrai(!/correcteur|journaliste|valisoa|\bIA\b/i.test(a), "aucun indice sur l'identité des relecteurs");
  vrai(a.includes("VERSION D'ORIGINE") && a.includes("Le modèle sort **mardi**."), "version d'origine jointe");
});

Deno.test("mapperVerdict : les lettres deviennent les vrais noms", () => {
  const brut = { gagnant: "A", resume: "La Relecture A corrige la date ; la Relecture B l'aggrave. Relecture B reste plus fluide.", notes: { A: { faits: 8, sources: 7, style: 6.44, lisibilite: 12, globale: 7.5 }, B: { faits: 3, sources: 5, style: 8, lisibilite: 7, globale: "x" } },
    points: [{ type: "erreur_corrigee_par_A", gravite: "grave", passage: "sort mardi", explication: "La Relecture A a raison.", source: "https://exemple.com/a" }, { type: "erreur_introduite_par_B", gravite: "?", passage: "p", explication: "e" },
      { type: "apport_propre_de_B", gravite: "legere", passage: "p", explication: "e" }, { type: "erreur_manquee_par_les_deux", gravite: "moyenne", passage: "p", explication: "e" }, { type: "inconnu", gravite: "grave", passage: "p", explication: "e" }], limites: "" };
  const v = mapperVerdict(brut, "ia_A", "Valisoa Rasolofo");
  eq(v.gagnant, "ia", "A = IA");
  eq(v.resume, "La relecture du Correcteur corrige la date ; la relecture de Valisoa Rasolofo l'aggrave. La relecture de Valisoa Rasolofo reste plus fluide.", "noms dans le résumé");
  eq(v.notes, { ia: { faits: 8, sources: 7, style: 6.4, lisibilite: 10, globale: 7.5 }, journaliste: { faits: 3, sources: 5, style: 8, lisibilite: 7, globale: 0 } }, "notes bornées");
  eq(v.points.map((p) => p.type + ":" + p.gravite), ["erreur_corrigee_ia:grave", "erreur_introduite_journaliste:moyenne", "apport_propre_journaliste:legere", "erreur_manquee_les_deux:moyenne"], "types et gravités ; type inconnu écarté");
  const w = mapperVerdict(brut, "ia_B", "");
  eq([w.gagnant, w.notes.ia.faits, w.points[0].type], ["journaliste", 3, "erreur_corrigee_journaliste"], "ordre inverse : A = journaliste");
  vrai(w.resume.startsWith("La relecture de la journaliste corrige"), "sans nom : « la journaliste »");
  eq(mapperVerdict({ gagnant: "bof" }, "ia_A", "V").gagnant, "egalite", "verdict illisible = égalité");
});

Deno.test("bilan : victoires, moyennes, tendance sur 30 jours", () => {
  const n = (g: number) => ({ faits: g, sources: g, style: g, lisibilite: g, globale: g });
  const v = (gagnant: "ia" | "journaliste" | "egalite", ia: number, j: number) => ({ gagnant, resume: "", notes: { ia: n(ia), journaliste: n(j) }, points: [], limites: "" });
  const t0 = Date.parse("2026-12-01T00:00:00Z"), il_y_a = (j: number) => new Date(t0 - j * 864e5).toISOString();
  const b = bilan([{ verdict: v("ia", 8, 6), cree: il_y_a(2) }, { verdict: v("journaliste", 5, 7), cree: il_y_a(10) }, { verdict: v("egalite", 6, 6), cree: il_y_a(40) }, { verdict: null, cree: il_y_a(1) }], t0);
  eq([b.n, b.ia, b.journaliste, b.egalite], [3, 1, 1, 1], "décompte (ligne sans verdict ignorée)");
  eq([b.moyennes.ia.globale, b.moyennes.journaliste.globale], [6.3, 6.3], "moyennes");
  eq(b.tendance, { recent: { n: 2, ecart: 0 }, avant: { n: 1, ecart: 0 } }, "tendance");
  eq(bilan([], t0).n, 0, "vide");
});
