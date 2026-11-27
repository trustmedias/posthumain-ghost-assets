// Writinglab — wl-etat : assemblage de l'état affiché par la page (27/11/2026).
// Copie FIDÈLE des nœuds « État — assembler » et « État — canal » du workflow n8n « Writinglab (la rédaction) » : mêmes champs, mêmes
// filtres, mêmes tris. Module pur (aucun accès réseau) pour être testé hors ligne : deno test supabase/functions/wl-etat/etat_test.ts.
// Toute évolution de l'état se fait ICI ; la branche « etat » de n8n ne sert plus que de secours quand Supabase ne répond pas : la garder
// à l'identique tant qu'elle existe.
// deno-lint-ignore-file no-explicit-any

// Boîtes branchées dans n8n (SMTP pour envoyer, IMAP pour relever) : même liste que le nœud « Accès » du workflow.
export const BOITES_BRANCHEES = ["jonathan", "valisoa", "subs", "redaction"];

const J = (s: any, d: any) => { try { const v = JSON.parse(s); return v == null ? d : v; } catch (_) { return d; } };

// Canal de la réponse (23/10/2026) : choix fait à la main dans la fiche, sinon déduit des preuves ; jamais deviné.
export function canalDe(r: any): string {
  r = r || {};
  const h = J(r.historique, []), rep = String(r.reponse || "");
  let pv = r.reponse_preuve; if (typeof pv === "string") pv = J(pv, null);
  const tel = !!(pv && pv.lien === "telephone") || (Array.isArray(h) && h.some((e: any) => /réponse reçue par téléphone/i.test(String((e && e.e) || "")))) || /📞 (Réponse reçue par téléphone|Answer received by phone)/.test(rep);
  const mail = ((r.reponse_verifiee === true || r.reponse_verifiee === "true") && !(pv && pv.lien === "telephone")) || (Array.isArray(h) && h.some((e: any) => e && e.par === "courrier" && /réponse reçue/i.test(String(e.e || ""))));
  const choix = String(r.reponse_canal || "");
  if (choix) return choix === "email" && tel ? "email+telephone" : choix;
  return tel && mail ? "email+telephone" : tel ? "telephone" : mail ? "email" : rep ? "non_precise" : "";
}

export type MembreEtat = { email: string; id: string; nom: string; titre: string; role: string; boite: string | null; actif: boolean; test: boolean };
export type Sources = {
  moi: MembreEtat;            // le membre connecté (déjà vérifié)
  membres: MembreEtat[];      // toute l'équipe (actifs, inactifs, de test)
  boites: any[];              // lignes de wl_boites
  ghost: any;                 // réponse de Ghost (posts) ou null si Ghost n'a pas répondu
  fiches: any[];              // lignes « mises en forme » (createdAt / updatedAt, liens signés) : voir index.ts
  messages: any[];
  courrier: any[];
  campagnes: any[];
  prospects: any[];
  maintenant?: string;
};

export function assembler(s: Sources) {
  const chef = s.moi.role === "chef";
  const g = s.ghost || {};
  // Exclus : les posts « email uniquement », les tests (titre commençant par « TEST — » ou « TEST - ») et les articles vidéo (requête Ghost).
  const posts = (Array.isArray(g.posts) ? g.posts : []).filter((x: any) => !x.email_only && x.status !== "sent" && !/^\s*TEST\s*[—–-]/.test(String(x.title || "")));
  const articles = posts.map((x: any) => {
    const au = (x.authors || []).map((u: any) => ({ nom: u.name, email: String(u.email || "").toLowerCase() }));
    return { id: x.id, titre: x.title || "(sans titre)", statut: x.status, maj: x.updated_at, publie_le: x.published_at || null, image: x.feature_image || "", visibilite: x.visibility,
      auteurs: au.map((u: any) => u.nom), mien: au.some((u: any) => u.email === s.moi.email), editeur: "https://the-last-journal.ghost.io/ghost/#/editor/post/" + x.id };
  });
  const brutes: Record<string, any> = {};
  for (const r of s.fiches) if (r && r.fiche_id) brutes[r.fiche_id] = r;
  // Tout le monde voit tout en lecture (21/10/2026) ; les actions restent contrôlées par propriétaire et par rôle.
  const fiches = s.fiches.filter((r: any) => r && r.fiche_id && r.statut !== "archivé").map((r: any) => ({
    fiche_id: r.fiche_id, article_id: r.article_id || "", article_titre: r.article_titre || "", redacteur: r.redacteur,
    contact: { nom: r.contact_nom || "", email: r.contact_email || "", role: r.contact_role || "", institution: r.contact_institution || "" },
    langue: r.langue || "fr", statut: r.statut || "brouillon", questions: J(r.questions, []), mail_sujet: r.mail_sujet || "", mail_corps: r.mail_corps || "",
    envoye_le: r.envoye_le || null, envoi_prevu_le: r.envoi_prevu_le || null, reponse: r.reponse || "", reponse_le: r.reponse_le || null, citation: r.citation || "", paragraphe: r.paragraphe,
    historique: J(r.historique, []), pieces: J(r.pieces, []), maj: r.updatedAt, cree: r.createdAt,
    // relances et rebonds (22/10/2026)
    relance_sujet: r.relance_sujet || "", relance_corps: r.relance_corps || "", relance_prete_le: r.relance_prete_le || null, relances: Number(r.relances) || 0,
    relance_envoyee_le: r.relance_envoyee_le || null, rebond: r.rebond === true || r.rebond === "true", rebond_motif: r.rebond_motif || "", rebond_le: r.rebond_le || null,
    // personnes en copie de la réponse du contact (28/10/2026) ; null = jamais relevé (la page les fait rattraper une fois)
    copies: r.copies == null ? null : J(r.copies, []),
    canal: canalDe(brutes[r.fiche_id]), canal_choisi: String(brutes[r.fiche_id].reponse_canal || "") }));
  fiches.sort((x: any, y: any) => String(y.maj).localeCompare(String(x.maj)));
  const messages = s.messages.filter((m: any) => m && (m.texte || m.fichier_path))
    .map((m: any) => ({ id: m.id, auteur: m.auteur, nom: m.nom, texte: m.texte || "", article_id: m.article_id || "", article_titre: m.article_titre || "", le: m.createdAt,
      fichier: m.fichier_path ? { nom: m.fichier_nom || "fichier", type: m.fichier_type || "", taille: Number(m.fichier_taille) || 0, categorie: m.categorie || "autres", url: m.fichier_url || "" } : null }))
    .sort((x: any, y: any) => String(x.le).localeCompare(String(y.le)));
  // 23/10/2026 (audit démo) : le courrier de subs@ / redaction@ et la prospection ne quittent le serveur que pour le rédacteur en chef.
  const courrier = !chef ? [] : s.courrier.filter((c: any) => c && c.mail_id && c.statut !== "archivé").map((c: any) => ({
    mail_id: c.mail_id, boite: c.boite, de_email: c.de_email || "", de_nom: c.de_nom || "", sujet: c.sujet || "", texte: c.texte || "", recu_le: c.recu_le || c.createdAt,
    categorie: c.categorie || "verifier", motif: c.motif || "", abonne: c.abonne || "non", statut: c.statut || "nouveau",
    brouillon_sujet: c.brouillon_sujet || "", brouillon_corps: c.brouillon_corps || "", envoye_le: c.envoye_le || null, pieces: J(c.pieces, []), membre_id: c.membre_id || "", copies: J(c.copies, []) }))
    .sort((x: any, y: any) => String(y.recu_le).localeCompare(String(x.recu_le)));
  const campagnes = !chef ? [] : s.campagnes.map((c: any) => ({ campagne_id: c.campagne_id, nom: c.nom, offres: J(c.offres, []), cible: c.cible || "", zone: c.zone || "", statut: c.statut || "active", cree: c.createdAt }));
  const prospects = !chef ? [] : s.prospects.map((x: any) => ({ prospect_id: x.prospect_id, campagne_id: x.campagne_id, entreprise: x.entreprise || "", site: x.site || "", secteur: x.secteur || "", pays: x.pays || "",
    contact_nom: x.contact_nom || "", contact_role: x.contact_role || "", email: x.email || "", source_email: x.source_email || "", pourquoi: x.pourquoi || "", statut: x.statut || "a_contacter",
    mail_sujet: x.mail_sujet || "", mail_corps: x.mail_corps || "", envoye_le: x.envoye_le || null, relance_le: x.relance_le || null, historique: J(x.historique, []), maj: x.updatedAt }));
  // actif / test (table wl_equipe) : la page retire le bureau d'un membre inactif, garde son nom dans l'historique, badge TEST.
  const branchee = (w: MembreEtat) => BOITES_BRANCHEES.includes(String(w.boite));
  const equipe = s.membres.filter((w) => w && w.email && w.id).map((w) => ({ id: w.id, nom: w.nom, titre: w.titre, role: w.role, branchee: branchee(w), actif: w.actif !== false, test: !!w.test }));
  // boîtes ajoutées depuis le lab (identifiant « x-… ») : la page range leur courrier au bureau de leur rôle (mk / sc).
  const boites = (s.boites || []).filter((x: any) => x && /^x-/.test(String(x.id || ""))).map((x: any) => ({ id: String(x.id), adresse: String(x.adresse || ""), role: String(x.role || ""), nom_affiche: String(x.nom_affiche || ""), actif: x.actif !== false }));
  return { ok: true, boites, me: { id: s.moi.id, nom: s.moi.nom, titre: s.moi.titre, role: s.moi.role, chef, branchee: branchee(s.moi), test: !!s.moi.test }, equipe, articles, fiches, messages, courrier, campagnes, prospects,
    ghost: Array.isArray(g.posts) ? "ok" : "Ghost ne répond pas", at: s.maintenant || new Date().toISOString() };
}

// Empreinte d'un état, pour comparer la lecture Supabase à celle de n8n sans sortir une seule donnée : par liste, le nombre d'éléments et
// une empreinte par élément (liens signés et horodatage retirés, puisqu'ils changent à chaque lecture).
export async function empreinte(e: any) {
  const sansLiens = (v: any): any => Array.isArray(v) ? v.map(sansLiens) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().filter((k) => k !== "url").map((k) => [k, sansLiens(v[k])])) : v;
  const h = async (v: any) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(sansLiens(v)))))).slice(0, 6).map((b) => b.toString(16).padStart(2, "0")).join("");
  const cle: Record<string, string> = { articles: "id", fiches: "fiche_id", messages: "id", courrier: "mail_id", campagnes: "campagne_id", prospects: "prospect_id", equipe: "id", boites: "id" };
  const o: Record<string, any> = { me: await h(e.me), ghost: e.ghost, cles: Object.keys(e).sort().join(",") };
  for (const [liste, k] of Object.entries(cle)) { const l = Array.isArray(e[liste]) ? e[liste] : []; const m: Record<string, string> = {}; for (const x of l) m[String(x[k])] = await h(x); o[liste] = { n: l.length, ordre: await h(l.map((x: any) => x[k])), tout: await h(Object.keys(m).sort().map((i) => i + ":" + m[i])), e: m }; }
  return o;
}
