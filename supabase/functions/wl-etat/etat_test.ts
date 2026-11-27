// deno-lint-ignore-file no-explicit-any
// deno test supabase/functions/wl-etat/etat_test.ts
// Sans dépendance réseau (comme comparaison_test.ts) : égalité par JSON, tolérante à l’ordre d’écriture des assertions seulement.
const assertEquals = (a: unknown, b: unknown) => { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) throw new Error("attendu " + y + "\nobtenu  " + x); };
import { assembler, canalDe } from "./etat.ts";

const chef = { email: "j@x.com", id: "jonathan", nom: "Jonathan", titre: "Rédacteur en chef", role: "chef", boite: "jonathan", actif: true, test: false };
const jour = { email: "v@x.com", id: "valisoa", nom: "Valisoa", titre: "Journaliste", role: "redaction", boite: "valisoa", actif: true, test: false };
const inactif = { email: "z@x.com", id: "zoe", nom: "Zoé", titre: "Pigiste", role: "journaliste", boite: null, actif: false, test: true };
const sources = (moi: typeof chef) => ({
  moi, membres: [chef, jour, inactif], maintenant: "2026-11-27T15:00:00.000Z",
  boites: [{ id: "x-pub", adresse: "pub@posthumain.com", role: "mk", nom_affiche: "Pub", actif: true, statut: "ok", fournisseur: "o365" }, { id: "subs", adresse: "subs@posthumain.com", role: "sc" }],
  ghost: { posts: [
    { id: "a1", title: "Article", status: "draft", updated_at: "2026-11-27T10:00:00.000Z", published_at: null, feature_image: null, visibility: "public", email_only: false, authors: [{ name: "Valisoa", email: "V@x.com" }] },
    { id: "a2", title: "TEST — essai", status: "draft", authors: [] },
    { id: "a3", title: "Brief", status: "published", email_only: true, authors: [] },
    { id: "a4", title: "", status: "scheduled", updated_at: "u", published_at: "p", feature_image: "img", visibility: "paid", authors: [{ name: "Jonathan", email: "j@x.com" }] },
  ] },
  fiches: [
    { fiche_id: "f1", article_id: "a1", redacteur: "valisoa", contact_nom: "Dr X", statut: "envoyé", questions: '["q1"]', historique: '[{"e":"Réponse reçue","par":"courrier"}]', pieces: '[{"path":"p","url":"https://signe"}]', reponse: "ok", relances: "2", rebond: "true", copies: null, createdAt: "2026-11-01", updatedAt: "2026-11-20" },
    { fiche_id: "f2", statut: "archivé", updatedAt: "2026-11-25" },
    { fiche_id: "f3", redacteur: "jonathan", reponse_canal: "email", reponse_preuve: '{"lien":"telephone"}', copies: '[{"email":"c@x"}]', createdAt: "2026-11-02", updatedAt: "2026-11-26" },
  ],
  messages: [
    { id: 2, auteur: "valisoa", nom: "Valisoa", texte: "deux", createdAt: "2026-11-27T09:00:00Z" },
    { id: 1, auteur: "jonathan", nom: "Jonathan", texte: "", fichier_path: "d/f.pdf", fichier_nom: "f.pdf", fichier_taille: "12", fichier_url: "https://signe", createdAt: "2026-11-27T08:00:00Z" },
    { id: 3, auteur: "x", texte: "", createdAt: "2026-11-27T10:00:00Z" },
  ],
  courrier: [{ mail_id: "m1", boite: "subs", sujet: "Aide", createdAt: "2026-11-26", pieces: "[]" }, { mail_id: "m2", statut: "archivé" }, { mail_id: "m3", recu_le: "2026-11-27", copies: '[{"email":"k"}]' }],
  campagnes: [{ campagne_id: "c1", nom: "Écoles", offres: '["o"]', createdAt: "2026-11-10" }],
  prospects: [{ prospect_id: "p1", campagne_id: "c1", entreprise: "ACME", historique: "[]", updatedAt: "2026-11-11" }],
});

Deno.test("rédacteur en chef : tout l'état, mêmes champs et mêmes tris que n8n", () => {
  const e = assembler(sources(chef));
  assertEquals(Object.keys(e), ["ok", "boites", "me", "equipe", "articles", "fiches", "messages", "courrier", "campagnes", "prospects", "ghost", "at"]);
  assertEquals(e.me, { id: "jonathan", nom: "Jonathan", titre: "Rédacteur en chef", role: "chef", chef: true, branchee: true, test: false });
  assertEquals(e.equipe.map((m: any) => [m.id, m.branchee, m.actif, m.test]), [["jonathan", true, true, false], ["valisoa", true, true, false], ["zoe", false, false, true]]);
  assertEquals(e.boites, [{ id: "x-pub", adresse: "pub@posthumain.com", role: "mk", nom_affiche: "Pub", actif: true }]);
  assertEquals(e.articles.map((a: any) => a.id), ["a1", "a4"]);
  assertEquals(e.articles[0], { id: "a1", titre: "Article", statut: "draft", maj: "2026-11-27T10:00:00.000Z", publie_le: null, image: "", visibilite: "public", auteurs: ["Valisoa"], mien: false, editeur: "https://the-last-journal.ghost.io/ghost/#/editor/post/a1" });
  assertEquals([e.articles[1].titre, e.articles[1].mien], ["(sans titre)", true]);
  assertEquals(e.fiches.map((f: any) => f.fiche_id), ["f3", "f1"]);
  const f1 = e.fiches[1];
  assertEquals([f1.questions, f1.relances, f1.rebond, f1.copies, f1.canal, f1.canal_choisi, f1.langue, f1.maj, f1.cree], [["q1"], 2, true, null, "email", "", "fr", "2026-11-20", "2026-11-01"]);
  assertEquals(f1.pieces, [{ path: "p", url: "https://signe" }]);
  assertEquals([e.fiches[0].canal, e.fiches[0].canal_choisi, e.fiches[0].copies], ["email+telephone", "email", [{ email: "c@x" }]]);
  assertEquals(e.messages.map((m: any) => m.id), [1, 2]);
  assertEquals(e.messages[0].fichier, { nom: "f.pdf", type: "", taille: 12, categorie: "autres", url: "https://signe" });
  assertEquals(e.courrier.map((c: any) => [c.mail_id, c.recu_le, c.categorie, c.abonne, c.statut]), [["m3", "2026-11-27", "verifier", "non", "nouveau"], ["m1", "2026-11-26", "verifier", "non", "nouveau"]]);
  assertEquals([e.campagnes[0].offres, e.campagnes[0].statut, e.prospects[0].statut], [["o"], "active", "a_contacter"]);
  assertEquals([e.ghost, e.at], ["ok", "2026-11-27T15:00:00.000Z"]);
});

Deno.test("journaliste : ni courrier ni prospection ; « mien » suit son adresse", () => {
  const e = assembler(sources(jour));
  assertEquals([e.courrier, e.campagnes, e.prospects], [[], [], []]);
  assertEquals(e.me.chef, false);
  assertEquals(e.articles.map((a: any) => a.mien), [true, false]);
  assertEquals(e.fiches.length, 2);
});

Deno.test("Ghost muet : aucun article, et le lab le dit", () => {
  const s = sources(chef); (s as { ghost: unknown }).ghost = null;
  const e = assembler(s);
  assertEquals([e.articles, e.ghost], [[], "Ghost ne répond pas"]);
  const s2 = sources(chef); (s2 as { ghost: unknown }).ghost = { errors: [{ message: "x" }] };
  assertEquals(assembler(s2).ghost, "Ghost ne répond pas");
});

Deno.test("canal de la réponse : mêmes règles que n8n", () => {
  assertEquals(canalDe({}), "");
  assertEquals(canalDe({ reponse: "texte" }), "non_precise");
  assertEquals(canalDe({ reponse: "📞 Réponse reçue par téléphone : …" }), "telephone");
  assertEquals(canalDe({ reponse_verifiee: "true" }), "email");
  assertEquals(canalDe({ reponse_verifiee: true, reponse_preuve: { lien: "telephone" } }), "telephone");
  assertEquals(canalDe({ reponse_canal: "telephone" }), "telephone");
});
