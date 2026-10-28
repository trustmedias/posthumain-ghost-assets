// Writinglab — wl-tel (23/10/2026) : le « téléphone » de chaque bureau IA et la réponse d'interview par téléphone.
// Appelée par la page posthumain.com/writinglab avec le jeton du membre Ghost (vérifié avec les clés publiques du site) ; membre
// actif de wl_equipe obligatoire. Rien n'est envoyé ni publié ici : chaque poste répond par une PROPOSITION (JSON structuré)
// que la page exécute avec ses actions habituelles (brouillons à valider, réponse enregistrée dans une fiche après un clic…).
// Actions :
//  - capacites                              → { transcription_fichier: bool } (import audio possible seulement si une clé existe)
//  - historique { poste }                   → fil du membre avec ce poste (wl_tel)
//  - telephone { poste, texte, article_id?, fiche_id?, articles? }
//        → Claude, dans le rôle du poste (capacités réelles du lab + contexte : article en cours, fiches, courrier, pièces).
//          Réponse : faire (action proposée) | transmettre (UNE fois, au bon poste, qui traite à son tour) | question.
//  - action_faite { id, resultat }          → note sur le fil que la proposition a été exécutée
//  - appel_traiter { fiche_id, transcription } → l'Assistant tire résumé + réponses par question (aucune écriture)
//  - appel_enregistrer { fiche_id, resume, reponses, transcription, source: appel|notes, consentement }
//        → réponse de la fiche « reçue par téléphone le … » ; pièces éventuelles « à vérifier » (motif « réponse par téléphone »).
//  - suite_rediger { fiche_id, consigne, telephone? } → réponse dans le FIL de la fiche d'interview, rédigée par la Secrétaire,
//        gardée en brouillon dans la fiche (suite_sujet / suite_corps), rien n'est envoyé
//  - suite_envoyer { fiche_id, sujet, corps, valide: true } → après « Valider et envoyer » dans la fiche : envoi par wl-mail dans le
//        fil (In-Reply-To = dernier message du contact, sinon notre mail ; References complètes ; copie dans « Envoyés »),
//        depuis la boîte de la fiche, signature du membre dans la langue de la fiche ; historique « suite envoyée ». Statut inchangé.
//  - suite_ecarter { fiche_id } / suites → brouillon écarté / brouillons et réponses envoyées dans le fil (pour la page)
//    28/10/2026 : suite_rediger accepte « a » = l'adresse d'une personne que le contact a mise en copie (son assistante…) : la réponse
//    lui est adressée et le contact passe en copie (suite_a / suite_cc), toujours dans le même fil. Sans « a », si le dernier échange
//    envoyé était déjà adressé à une personne en copie, le fil continue avec elle. Seuls le contact et ses copies sont acceptés.
//  - copies_rattraper { fiche_id } → personnes en copie de la dernière réponse du contact, relues dans la boîte (wl-mail « entetes »)
//    pour les réponses arrivées avant la relève des copies ; enregistrées dans wl_fiches.copies (une seule fois).
//  - fiche_traitee { fiche_id } → « ✓ Marquer comme traitée » : historique « réponse marquée traitée » (statut réel inchangé)
// Rôles : une journaliste n'a que Secrétaire, Assistant, Comptable, et seulement ses fiches ; Julien (mk, sc) = rédacteur en chef.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { equipe, parEmail, type Membre } from "./equipe.ts";
import { CATALOGUE } from "./catalogue.ts";
import { contexteKb } from "./kb.ts"; // base de connaissances par domaine (Paramètres → Base de connaissances), 23/10/2026

const env = (k: string) => (Deno.env.get(k) || "").trim();
const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const SITE = "https://posthumain.com";
const ORIGINES = ["https://posthumain.com", "https://www.posthumain.com"];
const MODELE = "claude-opus-5-5"; // 24/10/2026 (Jonathan) : Opus 5.5, effort faible pour les mails simples, moyen pour le reste
// Boîtes historiques (mêmes adresses que n8n et wl-mail) ; les boîtes ajoutées depuis le lab sont lues dans wl_boites.
const ADRESSES: Record<string, string> = { jonathan: "jonathan.paiano@posthumain.com", valisoa: "valisoa.rasolofo@posthumain.com", subs: "subs@posthumain.com", redaction: "redaction@posthumain.com" };
function cors(req: Request) {
  const o = req.headers.get("origin") || "";
  return { "Access-Control-Allow-Origin": ORIGINES.includes(o) ? o : ORIGINES[0], "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "content-type", "Vary": "Origin" };
}
const b64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), (c) => c.charCodeAt(0));
// deno-lint-ignore no-explicit-any
let jwksCache: { at: number; keys: any[] } | null = null;
async function membre(token: string): Promise<Membre | null> {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return null;
  // deno-lint-ignore no-explicit-any
  let header: any, payload: any;
  try { header = JSON.parse(new TextDecoder().decode(b64u(parts[0]))); payload = JSON.parse(new TextDecoder().decode(b64u(parts[1]))); } catch { return null; }
  const hashes: Record<string, string> = { RS256: "SHA-256", RS384: "SHA-384", RS512: "SHA-512" };
  if (!hashes[header.alg]) return null;
  if (!jwksCache || Date.now() - jwksCache.at > 3600e3) { const r = await fetch(SITE + "/members/.well-known/jwks.json"); if (!r.ok) return null; jwksCache = { at: Date.now(), keys: (await r.json()).keys || [] }; }
  // deno-lint-ignore no-explicit-any
  const jwk = jwksCache.keys.find((k: any) => !header.kid || k.kid === header.kid);
  if (!jwk) return null;
  const key = await crypto.subtle.importKey("jwk", { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: header.alg, ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: hashes[header.alg] }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64u(parts[2]), new TextEncoder().encode(parts[0] + "." + parts[1]));
  if (!ok || !payload.exp || payload.exp * 1000 < Date.now()) return null;
  if (payload.iss && !/^https:\/\/(posthumain\.com|the-last-journal\.ghost\.io)\//.test(String(payload.iss))) return null;
  return await parEmail(db, String(payload.sub || ""));
}

// ---------- Postes et capacités : catalogue unique (shared/wl-catalogue.json → catalogue.ts, généré) ----------
// Un poste déclaré au catalogue obtient automatiquement ici sa fiche de poste pour l'IA, ses capacités, sa place dans l'aiguillage
// (transmission) et ses droits ; une capacité est validée avec son schéma de paramètres et ses droits. Rien n'est codé en dur.
// deno-lint-ignore no-explicit-any
type Cap = { id: string; postes: string[]; description: string; params: Record<string, any>; droits: string; mode: string; au_moins_un?: string[]; enrichir?: Record<string, string> };
type Poste = { id: string; nom: string; chefSeul: boolean; role: string; aiguillage: string; actions: string[]; contexte: string[]; mail: { boite: string; role: string } | null; kb: string | null };
// deno-lint-ignore no-explicit-any
const POSTES: Record<string, Poste> = Object.fromEntries((CATALOGUE.postes || []).map((p: any) => [p.id, { id: p.id, kb: p.connaissances || null, nom: p.emoji + " " + p.nom, chefSeul: p.acces === "chef", role: p.role, aiguillage: p.aiguillage || String(p.role || "").split(".")[0], actions: p.capacites || [], contexte: p.contexte || [], mail: p.mail || null }]));
// deno-lint-ignore no-explicit-any
const CAPS: Record<string, Cap> = Object.fromEntries((CATALOGUE.capacites || []).map((c: any) => [c.id, c]));
const ACTIONS_DOC: Record<string, string> = Object.fromEntries(Object.values(CAPS).map((c) => [c.id, c.id + " — " + c.description]));
// Aiguillage (catalogue.aiguillage) : le poste qui écrit aux contacts d'interview ; les postes « courrier » (avec une boîte) ne les reçoivent jamais.
const POSTE_CONTACTS: string = (CATALOGUE.aiguillage && CATALOGUE.aiguillage.contacts_interview) || "";
const sansAccent = (s: unknown) => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
const MOTS_VIDES = new Set(["monsieur", "madame", "docteur", "professeur", "prof", "mme", "mlle", "dr", "pr", "de", "du", "des", "la", "le", "van", "von", "der"]);
// La requête cite-t-elle une personne qui a une fiche d'interview ? (nom de famille ou prénom de plus de 3 lettres, accents ignorés)
// deno-lint-ignore no-explicit-any
function ficheCitee(texte: string, ctx: any): any {
  const t = " " + sansAccent(texte).replace(/[^a-z0-9]+/g, " ") + " ";
  const l = (ctx.fiches || ctx.contacts_fiches || []) as { fiche_id: string; contact: string; nom?: string }[];
  for (const f of l) {
    const nom = sansAccent(f.nom || String(f.contact || "").split(",")[0]).replace(/[^a-z0-9]+/g, " ").trim();
    const mots = nom.split(" ").filter((w) => w.length > 3 && !MOTS_VIDES.has(w));
    if (mots.length && mots.some((w) => t.includes(" " + w + " "))) return f;
  }
  return null;
}

// ---------- Contexte (lu en base, filtré selon le rôle) ----------
// deno-lint-ignore no-explicit-any
const pj = (v: any) => { if (v == null) return null; if (typeof v !== "string") return v; try { return JSON.parse(v); } catch { return null; } };
const heureZ = (d: unknown) => d ? new Date(String(d)).toLocaleString("fr-CH", { timeZone: "Europe/Zurich", dateStyle: "short", timeStyle: "short" }) : null;
const court = (s: unknown, n: number) => { const t = String(s || "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };
// deno-lint-ignore no-explicit-any
async function fichesVisibles(me: Membre, articleId: string, texte: string): Promise<any[]> {
  let q = db.from("wl_fiches").select("fiche_id,article_id,article_titre,redacteur,contact_nom,contact_email,contact_role,contact_institution,langue,statut,questions,reponse,reponse_le,envoye_le,updated_at,created_at,reponse_canal,relances,relance_envoyee_le,relance_prete_le,rebond,rebond_motif,suite_prete_le,suites,citation,historique,copies").neq("statut", "archivé").order("updated_at", { ascending: false }).limit(120);
  if (!me.chef) q = q.eq("redacteur", me.id);
  const { data } = await q;
  const l = data || [], t = texte.toLowerCase();
  const score = (f: { article_id: string; contact_nom: string }) => (articleId && f.article_id === articleId ? 2 : 0) + (String(f.contact_nom || "").toLowerCase().split(/\s+/).some((w) => w.length > 3 && t.includes(w)) ? 3 : 0);
  return l.map((f, i) => ({ f, s: score(f), i })).sort((a, b) => b.s - a.s || a.i - b.i).slice(0, 25).map((x) => x.f);
}
// deno-lint-ignore no-explicit-any
function ficheCtx(f: any) {
  const qs = pj(f.questions);
  return { fiche_id: f.fiche_id, nom: f.contact_nom || "", contact: [f.contact_nom, f.contact_role, f.contact_institution].filter(Boolean).join(", "), email: f.contact_email || "", langue: f.langue || "fr",
    statut: f.statut, article_id: f.article_id, article: court(f.article_titre, 90), redacteur: f.redacteur, questions: Array.isArray(qs) ? qs.slice(0, 8).map((x: unknown) => court(x, 220)) : [],
    reponse: f.reponse ? court(f.reponse, 400) : "",
    // suivi (28/10/2026) : dates, relances, rebonds, échanges dans le fil, citation, derniers événements
    creee_le: heureZ(f.created_at), envoye_le: heureZ(f.envoye_le), reponse_le: heureZ(f.reponse_le), reponse_canal: f.reponse_canal || null,
    jours_sans_reponse: f.envoye_le && !f.reponse_le ? Math.floor((Date.now() - Date.parse(f.envoye_le)) / 864e5) : null,
    relances_envoyees: Number(f.relances || 0), derniere_relance_le: heureZ(f.relance_envoyee_le), relance_a_valider: !!f.relance_prete_le && !f.relance_envoyee_le,
    adresse_refusee: f.rebond ? court(f.rebond_motif || "oui", 160) : null, reponse_dans_le_fil_a_valider: !!f.suite_prete_le,
    echanges_envoyes_dans_le_fil: (Array.isArray(f.suites) ? f.suites : (pj(f.suites) || [])).length, citee_dans_l_article: !!f.citation,
    // personnes que le contact a mises en copie de sa réponse (28/10/2026) : « a » de suite_interview pour leur répondre
    // deno-lint-ignore no-explicit-any
    en_copie: (pj(f.copies) || []).slice(0, 6).map((c: any) => ({ nom: c.nom || "", email: c.email })),
    // deno-lint-ignore no-explicit-any
    historique: ((Array.isArray(f.historique) ? f.historique : pj(f.historique)) || []).slice(-6).map((h: any) => ({ le: heureZ(h.t), quoi: court(h.e, 120), par: h.par || null })) };
}
// Bilan de toutes les fiches visibles, archivées comprises (28/10/2026) : pour « combien d'interviews ce mois-ci », « qui n'a pas répondu ».
async function fichesBilan(me: Membre) {
  let q = db.from("wl_fiches").select("fiche_id,redacteur,contact_nom,article_titre,statut,envoye_le,reponse_le,citation,relances,created_at").order("created_at", { ascending: false }).limit(1000);
  if (!me.chef) q = q.eq("redacteur", me.id);
  const { data } = await q;
  const l = data || [], mois = new Intl.DateTimeFormat("fr-CA", { timeZone: "Europe/Zurich", year: "numeric", month: "2-digit" }).format(new Date());
  const dansMois = (d: unknown) => !!d && new Intl.DateTimeFormat("fr-CA", { timeZone: "Europe/Zurich", year: "numeric", month: "2-digit" }).format(new Date(String(d))) === mois;
  const parStatut: Record<string, number> = {}, parRedacteur: Record<string, number> = {};
  for (const f of l) { parStatut[f.statut] = (parStatut[f.statut] || 0) + 1; parRedacteur[f.redacteur] = (parRedacteur[f.redacteur] || 0) + 1; }
  return { total: l.length, par_statut: parStatut, par_redacteur: parRedacteur,
    ce_mois: { mails_envoyes: l.filter((f) => dansMois(f.envoye_le)).length, reponses_recues: l.filter((f) => dansMois(f.reponse_le)).length, citees: l.filter((f) => f.citation && dansMois(f.reponse_le)).length },
    sans_reponse_depuis_5_jours: l.filter((f) => f.statut !== "archivé" && f.envoye_le && !f.reponse_le && Date.now() - Date.parse(f.envoye_le) > 5 * 864e5)
      .slice(0, 20).map((f) => ({ fiche_id: f.fiche_id, nom: f.contact_nom, article: court(f.article_titre, 80), envoye_le: heureZ(f.envoye_le), relances: Number(f.relances || 0) })) };
}
async function courrierBureau(mail: { boite: string; role: string }) {
  const { data: bx } = await db.from("wl_boites").select("id,role").eq("role", mail.role);
  const boites = [mail.boite].concat((bx || []).map((b) => String(b.id)));
  const { data } = await db.from("wl_courrier").select("mail_id,boite,de_nom,de_email,sujet,texte,categorie,statut,abonne,brouillon_corps,recu_le").in("boite", boites).not("statut", "in", "(répondu,archivé)").order("recu_le", { ascending: false }).limit(15);
  return (data || []).map((m) => ({ mail_id: m.mail_id, de: (m.de_nom || "") + " <" + m.de_email + ">", sujet: court(m.sujet, 140), categorie: m.categorie, abonne: m.abonne, brouillon: !!m.brouillon_corps, recu_le: m.recu_le, extrait: court(m.texte, 350) }));
}
// Courrier déjà traité du bureau (28/10/2026) : réponses envoyées et mails archivés, pour « à qui ai-je répondu », « qu'a-t-on dit à X ».
async function courrierTraite(mail: { boite: string; role: string }) {
  const { data: bx } = await db.from("wl_boites").select("id,adresse").eq("role", mail.role);
  const boites = [mail.boite].concat((bx || []).map((b) => String(b.id)));
  const [{ data }, { data: tous }] = await Promise.all([
    db.from("wl_courrier").select("mail_id,boite,de_nom,de_email,sujet,texte,categorie,statut,abonne,brouillon_corps,recu_le,envoye_le,historique").in("boite", boites).in("statut", ["répondu", "archivé"]).order("updated_at", { ascending: false }).limit(15),
    db.from("wl_courrier").select("boite,statut,recu_le").in("boite", boites).limit(2000)]);
  const parStatut: Record<string, number> = {}, parBoite: Record<string, number> = {};
  for (const m of tous || []) { parStatut[m.statut] = (parStatut[m.statut] || 0) + 1; parBoite[m.boite] = (parBoite[m.boite] || 0) + 1; }
  return { boites: [mail.boite].concat((bx || []).map((b) => String(b.adresse || b.id))), total: (tous || []).length, par_statut: parStatut, par_boite: parBoite,
    derniers_traites: (data || []).map((m) => ({ mail_id: m.mail_id, de: (m.de_nom || "") + " <" + m.de_email + ">", sujet: court(m.sujet, 140), categorie: m.categorie, statut: m.statut, abonne: m.abonne,
      recu_le: heureZ(m.recu_le), repondu_le: heureZ(m.envoye_le), extrait_recu: court(m.texte, 200), notre_reponse: m.statut === "répondu" ? court(m.brouillon_corps, 300) : null,
      // deno-lint-ignore no-explicit-any
      historique: ((Array.isArray(m.historique) ? m.historique : pj(m.historique)) || []).slice(-4).map((h: any) => ({ le: heureZ(h.t), quoi: court(h.e, 100), par: h.par || null })) })) };
}
// Prospection du Marketing (campagnes et prospects) et réglages des mails marketing automatiques (28/10/2026).
async function prospectionCtx() {
  const [{ data: cs }, { data: ps }] = await Promise.all([
    db.from("wl_campagnes").select("campagne_id,nom,offres,cible,zone,statut,notes,created_at").order("created_at", { ascending: false }).limit(10),
    db.from("wl_prospects").select("prospect_id,campagne_id,entreprise,site,secteur,pays,contact_nom,contact_role,email,statut,pourquoi,mail_sujet,envoye_le,relance_le").order("updated_at", { ascending: false }).limit(60)]);
  const parStatut: Record<string, number> = {}; for (const p of ps || []) parStatut[p.statut] = (parStatut[p.statut] || 0) + 1;
  return { campagnes: (cs || []).map((c) => ({ ...c, notes: court(c.notes, 300), offres: typeof c.offres === "string" ? court(c.offres, 300) : c.offres, created_at: heureZ(c.created_at) })),
    prospects_par_statut: parStatut,
    prospects: (ps || []).slice(0, 30).map((p) => ({ prospect_id: p.prospect_id, campagne_id: p.campagne_id, entreprise: p.entreprise, site: p.site, secteur: p.secteur, pays: p.pays, contact: [p.contact_nom, p.contact_role].filter(Boolean).join(", "),
      email: p.email, statut: p.statut, pourquoi: court(p.pourquoi, 160), sujet_du_mail: court(p.mail_sujet, 120), envoye_le: heureZ(p.envoye_le), relance_le: heureZ(p.relance_le) })) };
}
async function mailsMarketingCtx() {
  const [{ data: rg }, { data: vs }] = await Promise.all([
    db.from("wl_reglages").select("cle,valeur,updated_at").like("cle", "mails:%"),
    db.from("wl_mails_versions").select("type,note,auteur,created_at").order("created_at", { ascending: false }).limit(10)]);
  // deno-lint-ignore no-explicit-any
  const types = (rg || []).map((r) => { let v: any = {}; try { v = JSON.parse(r.valeur); } catch (_) { v = {}; } return { type: r.cle.slice(6), reglages: v.reglages || null, modifie_le: heureZ(v.maj || r.updated_at), par: v.par || null }; });
  return { types, dernieres_versions: (vs || []).map((v) => ({ type: v.type, note: court(v.note, 160), par: v.auteur, le: heureZ(v.created_at) })),
    reperes: "bienvenue_1 / bienvenue_2 : mails de bienvenue (jours = jours après l'inscription, conservation = jours dans l'historique Ghost) ; grand_format : Le Grand Format (jour 0 = dimanche … 6 = samedi)." };
}
async function piecesCtx(me: Membre) {
  let q = db.from("wl_pieces").select("membre,montant,statut,motif,contact,article_titre,created_at,conversion_id").order("created_at", { ascending: false }).limit(300);
  if (!me.chef) q = q.eq("membre", me.id);
  const [{ data }, { data: tx }] = await Promise.all([q, db.from("wl_reglages").select("valeur").eq("cle", "taux_piece").limit(1)]);
  const taux = Number(tx && tx[0] && tx[0].valeur) || 0.2, soldes: Record<string, number> = {}, aVerifier: unknown[] = [];
  for (const p of data || []) {
    if (p.statut === "acquis" && !p.conversion_id) soldes[p.membre] = (soldes[p.membre] || 0) + Number(p.montant || 0);
    if (p.statut === "a_verifier" && aVerifier.length < 10) aVerifier.push({ membre: p.membre, montant: p.montant, motif: court(p.motif, 160), contact: p.contact });
  }
  return { taux_euros_par_piece: taux, soldes_non_convertis: soldes, a_verifier: aVerifier, recentes: (data || []).slice(0, 8).map((p) => ({ membre: p.membre, montant: p.montant, statut: p.statut, contact: p.contact, le: p.created_at })) };
}
// Comptable (28/10/2026) : articles comptés et gains de chaque journaliste, pour répondre à « combien d'articles a-t-elle faits,
// combien a-t-elle déjà gagné ». Sources : factures émises (wl_factures, mois clos), pièces converties (wl_conversions) et, pour le
// mois en cours, le décompte en direct dans Ghost par le workflow n8n des factures en mode « aperçu » (même règle que la facture :
// autrice/co-autrice ou relecture prouvée par les révisions ; aucune facture créée). Aperçu gardé 30 min dans wl_reglages et
// demandé seulement si la question porte sur les articles ou l'argent (une exécution n8n par demande au plus).
// Une journaliste ne voit que ses propres chiffres ; le rédacteur en chef voit tout le monde.
const N8N_FACTURES = "https://trustmedias.app.n8n.cloud/webhook/wl-factures";
const QUESTION_COMPTE = /article|enqu[êe]te|relu|relecture|publi|gagn|factur|pay|vers|combien|total|mois|euro|€|r[ée]mun|argent|salaire|compt/i;
const moisZurich = () => new Intl.DateTimeFormat("fr-CA", { timeZone: "Europe/Zurich", year: "numeric", month: "2-digit" }).format(new Date());
// deno-lint-ignore no-explicit-any
async function apercuMois(mois: string): Promise<any> {
  const cle = "compta_apercu:" + mois;
  const { data } = await db.from("wl_reglages").select("valeur,updated_at").eq("cle", cle).limit(1);
  if (data && data[0] && Date.now() - Date.parse(data[0].updated_at) < 30 * 60e3) { try { return JSON.parse(data[0].valeur); } catch (_) { /* recompte */ } }
  const r = await fetch(N8N_FACTURES, { method: "POST", signal: AbortSignal.timeout(45000), headers: { "Content-Type": "application/json", "x-tv-secret": env("TV_ADMIN_SECRET") },
    body: JSON.stringify({ mois, apercu: true }) }).catch(() => null);
  const j = r && r.ok ? await r.json().catch(() => null) : null;
  if (!j || !Array.isArray(j.factures)) return null;
  // deno-lint-ignore no-explicit-any
  const art = (l: any[]) => (l || []).map((a) => ({ titre: court(a.titre, 110), publie_le: String(a.publie_le || "").slice(0, 10), role: a.role }));
  // deno-lint-ignore no-explicit-any
  const v = { mois, compte_le: new Date().toISOString(), par_membre: j.factures.map((f: any) => ({ membre: f.membre, enquetes_premium: art(f.premium), articles_standards: art(f.standard) })) };
  await db.from("wl_reglages").upsert({ cle, valeur: JSON.stringify(v), updated_at: new Date().toISOString() }, { onConflict: "cle" });
  return v;
}
async function comptaCtx(me: Membre, texte: string) {
  const r2 = (n: number) => Math.round(n * 100) / 100;
  let qf = db.from("wl_factures").select("membre,mois,numero,total,statut,emise_le,payee_le,lignes,details").order("mois", { ascending: false }).limit(36);
  let qc = db.from("wl_conversions").select("membre,type,statut,pieces,montant,created_at,facture_le").limit(500);
  let qp = db.from("wl_pieces").select("membre,montant,statut,conversion_id").limit(5000);
  if (!me.chef) { qf = qf.eq("membre", me.id); qc = qc.eq("membre", me.id); qp = qp.eq("membre", me.id); }
  const [{ data: fs }, { data: cs }, { data: ps }, { data: rg }, liste] = await Promise.all([qf, qc, qp,
    db.from("wl_reglages").select("cle,valeur").in("cle", ["tarif_premium", "tarif_standard", "taux_piece"]), equipe(db)]);
  const reg: Record<string, number> = {}; for (const x of rg || []) reg[x.cle] = Number(x.valeur);
  const tp = reg.tarif_premium || 7, ts = reg.tarif_standard || 5, taux = reg.taux_piece || 0.2;
  const tests = new Set(liste.filter((m) => m.test).map((m) => m.id));
  // deno-lint-ignore no-explicit-any
  const M: Record<string, any> = {};
  const de = (id: string) => M[id] || (M[id] = { membre: id, nom: (liste.find((m) => m.id === id) || { nom: id }).nom, compte_de_test: tests.has(id) || undefined,
    factures: [], cumul_factures: { enquetes_premium: 0, articles_standards: 0, total_facture_euros: 0, deja_paye_euros: 0, emis_non_paye_euros: 0 },
    pieces: { acquises: 0, a_verifier: 0, non_converties: 0, converties: 0, euros_convertis: 0, euros_a_ajouter_a_la_facture: 0 } });
  for (const f of fs || []) {
    const m = de(f.membre), d = f.details || {}, aj = d.ajust || {};
    const np = aj.premium_qte != null ? Number(aj.premium_qte) : (d.premium || []).length, ns = aj.standard_qte != null ? Number(aj.standard_qte) : (d.standard || []).length;
    // deno-lint-ignore no-explicit-any
    const inter = (f.lignes || []).find((l: any) => /interview/i.test(l.libelle || ""));
    m.factures.push({ mois: f.mois, numero: f.numero, statut: f.statut === "payee" ? "payée" : "émise, pas encore payée", payee_le: f.payee_le ? String(f.payee_le).slice(0, 10) : null,
      enquetes_premium: np, articles_standards: ns, interviews_euros: inter ? Number(inter.total) : 0, total_euros: Number(f.total),
      // titres : seulement pour les 3 dernières factures (taille du contexte)
      titres: m.factures.length < 3 ? { premium: (d.premium || []).map((a: { titre?: string }) => court(a.titre, 100)), standard: (d.standard || []).map((a: { titre?: string }) => court(a.titre, 100)) } : undefined });
    const c = m.cumul_factures; c.enquetes_premium += np; c.articles_standards += ns; c.total_facture_euros = r2(c.total_facture_euros + Number(f.total));
    if (f.statut === "payee") c.deja_paye_euros = r2(c.deja_paye_euros + Number(f.total)); else c.emis_non_paye_euros = r2(c.emis_non_paye_euros + Number(f.total));
  }
  for (const p of ps || []) {
    const m = de(p.membre).pieces, n = Number(p.montant || 0);
    if (p.statut === "acquis") { m.acquises += n; if (!p.conversion_id) m.non_converties += n; }
    if (p.statut === "a_verifier") m.a_verifier += n;
  }
  for (const c of cs || []) {
    if (c.type !== "conversion") continue;
    const m = de(c.membre).pieces; m.converties += Number(c.pieces || 0); m.euros_convertis = r2(m.euros_convertis + Number(c.montant || 0));
    if (c.statut === "a_facturer") m.euros_a_ajouter_a_la_facture = r2(m.euros_a_ajouter_a_la_facture + Number(c.montant || 0));
  }
  // deno-lint-ignore no-explicit-any
  const out: any = { tarifs: { enquete_premium_euros: tp, article_standard_euros: ts, piece_euros: taux },
    regles: "Payé = factures marquées payées. Facturé = factures émises (fin de mois, dernier jour à 23 h). Le mois en cours n'est pas encore facturé : son décompte vient de Ghost en direct et son montant est une ESTIMATION aux tarifs actuels (la facture peut être ajustée). Les paiements antérieurs à l'ouverture du lab (octobre 2026) ne sont pas enregistrés ici : ne les invente pas.",
    par_membre: [] };
  const mois = moisZurich();
  if (QUESTION_COMPTE.test(texte)) {
    const a = await apercuMois(mois).catch(() => null);
    if (!a) out.mois_en_cours = { mois, indisponible: "décompte Ghost injoignable pour l'instant" };
    else for (const x of a.par_membre || []) {
      if (!me.chef && x.membre !== me.id) continue;
      if ((fs || []).some((f) => f.membre === x.membre && f.mois === mois)) continue; // déjà facturé : la facture fait foi
      const np = x.enquetes_premium.length, ns = x.articles_standards.length, m = de(x.membre);
      m.mois_en_cours = { mois, compte_le: a.compte_le, enquetes_premium: np, articles_standards: ns, total_articles: np + ns,
        estimation_euros: r2(np * tp + ns * ts + m.pieces.euros_a_ajouter_a_la_facture), dont_pieces_converties_euros: m.pieces.euros_a_ajouter_a_la_facture,
        enquetes_premium_detail: x.enquetes_premium, articles_standards_detail: x.articles_standards };
    }
  }
  out.par_membre = Object.values(M);
  return out;
}
// Correcteur (28/10/2026) : ce qu'il a relu, ce qui est en cours, à valider ou en erreur, ce qui a été laissé de côté (corrections
// non appliquées, points « à vérifier », sources inaccessibles, graphiques imprécis non refaits), et les brouillons pas encore relus.
// Lu dans wl_relectures (écrites par wl-relecture) : le Correcteur répond sur son propre travail, en lecture seule.
const VERDICTS_SOURCE_A_SIGNALER = ["inaccessible", "retiree", "remplacee", "corrigee", "ajoutee"];
// deno-lint-ignore no-explicit-any
function relectureCtx(r: any, detail: boolean) {
  // deno-lint-ignore no-explicit-any
  const res: any = r.resultat || {}, app: any = r.appliquees || {}, meta: any = r.meta || {};
  // deno-lint-ignore no-explicit-any
  const corr: any[] = Array.isArray(res.corrections) ? res.corrections : [];
  const appl = new Set<number>(Array.isArray(app.corrections) ? app.corrections.map(Number) : []);
  const parCat: Record<string, number> = {};
  for (const c of corr) for (const k of (Array.isArray(c.categories) ? c.categories : ["autre"])) parCat[k] = (parCat[k] || 0) + 1;
  // deno-lint-ignore no-explicit-any
  const sources: any[] = Array.isArray(res.sources_audit) ? res.sources_audit : [];
  const parVerdict: Record<string, number> = {}; for (const x of sources) parVerdict[x.verdict || "?"] = (parVerdict[x.verdict || "?"] || 0) + 1;
  // deno-lint-ignore no-explicit-any
  const graphs: any[] = Array.isArray(res.graphiques) ? res.graphiques : [];
  // deno-lint-ignore no-explicit-any
  const refaits: any[] = Array.isArray(r.graphes) ? r.graphes : [];
  // deno-lint-ignore no-explicit-any
  const blocs: any[] = Array.isArray(r.blocs) ? r.blocs : [];
  // deno-lint-ignore no-explicit-any
  const avant = (n: number) => { const b = blocs.find((x: any) => Number(x.i ?? x.n ?? x.bloc) === n) || blocs[n]; return b ? court(b.md || (Array.isArray(b.items) ? b.items.join(" · ") : "") || b.legende || b.resume || "", 280) : ""; };
  const valide = r.statut === "validee";
  // deno-lint-ignore no-explicit-any
  const o: any = {
    relecture_id: r.id, post_id: r.post_id, titre: court(r.titre, 120), statut: r.statut,
    article: meta.statut === "published" ? "déjà publié au moment de la relecture" : "brouillon", auto: !!r.auto, lancee_par: r.lance_par || null,
    lancee_le: heureZ(r.created_at), validee_le: heureZ(r.validee_le), validee_par: r.validee_par || null,
    cout_euros: r.cout_eur != null ? Number(r.cout_eur) : null, erreur: r.erreur ? court(r.erreur, 300) : null,
    resume: court(res.resume, detail ? 1200 : 400),
    corrections: { proposees: corr.length, appliquees: valide ? appl.size : null, par_categorie: parCat },
    a_verifier: (Array.isArray(res.a_verifier) ? res.a_verifier : []).map((x: unknown) => court(x, detail ? 420 : 200)),
    sources: { verifiees: sources.length, par_verdict: parVerdict },
    graphiques: graphs.map((g) => ({ bloc: g.bloc, verdict: g.verdict, note: court(g.note, detail ? 300 : 140) })),
    graphiques_refaits: refaits.map((g) => ({ k: g.k, statut: g.statut, erreur: g.erreur ? court(g.erreur, 160) : null })),
  };
  if (valide) {
    // ce qui a été proposé mais NON appliqué lors de la validation (choix du rédacteur en chef ou conflit)
    o.non_appliquees = corr.map((c, i) => ({ i, c })).filter((x) => !appl.has(x.i)).map((x) => ({ bloc: x.c.bloc, categories: x.c.categories, resume: court(x.c.resume, 220) }));
    o.conflits = Array.isArray(app.conflits) ? app.conflits.slice(0, 10) : [];
    o.titre_propose_applique = app.titre ? true : (res.titre ? false : null);
  }
  if (detail) {
    o.corrections_detail = corr.slice(0, 40).map((c, i) => ({ bloc: c.bloc, categories: c.categories, resume: court(c.resume, 260), appliquee: valide ? appl.has(i) : null,
      ...((Array.isArray(c.categories) && c.categories.includes("fact_check")) ? { avant: avant(Number(c.bloc)), apres: court(c.md, 280) } : {}) }));
    o.sources_signalees = sources.filter((x) => VERDICTS_SOURCE_A_SIGNALER.includes(x.verdict)).slice(0, 20).map((x) => ({ n: x.n, verdict: x.verdict, url: court(x.url, 160), note: court(x.note, 260) }));
    o.suggestions = (Array.isArray(res.suggestions) ? res.suggestions : []).slice(0, 8).map((x: unknown) => court(x, 260));
    o.rejets = (Array.isArray(res.rejets) ? res.rejets : []).slice(0, 8).map((x: unknown) => court(typeof x === "string" ? x : JSON.stringify(x), 200));
    o.titre_propose = res.titre ? court(res.titre, 160) : null;
    o.titre_raison = res.titre_raison ? court(res.titre_raison, 260) : null;
  }
  return o;
}
// deno-lint-ignore no-explicit-any
async function relecturesCtx(texte: string, articles: any[]) {
  const { data } = await db.from("wl_relectures").select("id,post_id,titre,statut,auto,lance_par,tours,erreur,cout_eur,created_at,updated_at,validee_le,validee_par,meta,resultat,appliquees,graphes")
    .order("created_at", { ascending: false }).limit(40);
  const l = data || [], t = sansAccent(texte);
  // Détail complet : relectures en cours, à valider, les 3 plus récentes, et celles dont le titre est cité dans la demande.
  const cite = (titre: string) => { const mots = sansAccent(titre).replace(/[^a-z0-9]+/g, " ").split(" ").filter((w) => w.length > 4); return mots.filter((w) => t.includes(w)).length >= 2; };
  let n = 0;
  const detail = l.map((r) => { const d = ["en_cours", "prete", "erreur"].includes(r.statut) || n < 3 || cite(r.titre || ""); if (r.statut === "validee" || r.statut === "ecartee") n++; return d; });
  // texte d'origine des blocs (pour « avant / après » des corrections de fait) : seulement pour les relectures détaillées
  const ids = l.filter((_, i) => detail[i]).map((r) => r.id);
  const { data: bl } = ids.length ? await db.from("wl_relectures").select("id,blocs").in("id", ids) : { data: [] };
  const blocsDe = new Map((bl || []).map((x) => [x.id, x.blocs]));
  const relectures = l.map((r, i) => relectureCtx({ ...r, blocs: blocsDe.get(r.id) || [] }, detail[i]));
  const relus = new Set(l.filter((r) => r.statut !== "ecartee" && r.statut !== "erreur").map((r) => r.post_id));
  const brouillons = articles.filter((a) => /draft|brouillon/i.test(a.statut || ""));
  const { data: ra } = await db.from("wl_reglages").select("valeur").eq("cle", "relecture_auto").limit(1);
  let auto: unknown = null; try { auto = ra && ra[0] ? JSON.parse(ra[0].valeur) : null; } catch (_) { auto = null; }
  return {
    reperes: "Statuts : en_cours = lot Anthropic en traitement ; prete = résultat prêt, à valider par le rédacteur en chef ; validee = corrections choisies poussées dans Ghost ; ecartee = relecture jetée sans rien appliquer ; erreur = échec. Catégories de correction : fact_check (fait ou chiffre faux) et sources sont les plus graves, surtout sur un article déjà publié ; redaction, vulgarisation, anti_ia, putaclic, sommaire, vitrine relèvent de la forme. Verdicts des sources : ok, corrigee, remplacee, ajoutee, retiree, inaccessible (= NON vérifiée). Graphiques : juste, imprecision, faute (une faute est refaite automatiquement).",
    relecture_auto: auto,
    en_cours: l.filter((r) => r.statut === "en_cours").length, a_valider: l.filter((r) => r.statut === "prete").length, en_erreur: l.filter((r) => r.statut === "erreur").length,
    brouillons_pas_encore_relus: brouillons.filter((a) => !relus.has(a.id)).map((a) => ({ id: a.id, titre: a.titre })),
    relectures,
  };
}
// deno-lint-ignore no-explicit-any
async function filDe(me: Membre, poste: string, n = 12): Promise<any[]> {
  const { data } = await db.from("wl_tel").select("id,de,transmis_par,mode,texte,action,created_at").eq("membre", me.id).eq("poste", poste).order("created_at", { ascending: false }).limit(n);
  return (data || []).reverse();
}

// ---------- Claude ----------
const TARIF = [4, 20]; // USD / million de jetons (Opus 5.5), conversion EUR approximative
// deno-lint-ignore no-explicit-any
async function claude(system: string, messages: any[], tool: any, maxTokens = 6000, usage = "telephone", qui = "", effort: "low" | "medium" = "medium"): Promise<any> {
  const key = env("ANTHROPIC_API_KEY"); if (!key) throw new Error("clé Anthropic absente");
  const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", signal: AbortSignal.timeout(110000),
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    // tool_choice « tool » / « any » refusé par ce modèle : « auto » + consigne ferme dans le système, et repli sur le texte.
    body: JSON.stringify({ model: MODELE, max_tokens: maxTokens, thinking: { type: "adaptive" }, output_config: { effort }, system: system + "\n\nIMPORTANT : réponds UNIQUEMENT en appelant l'outil « " + tool.name + " », sans texte autour.", messages, tools: [tool], tool_choice: { type: "auto" } }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("Claude " + r.status + " : " + court(j?.error?.message, 160));
  // deno-lint-ignore no-explicit-any
  let t = (j.content || []).find((c: any) => c.type === "tool_use");
  if (!t || !t.input) {
    // deno-lint-ignore no-explicit-any
    const txt = (j.content || []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("").trim();
    const m = txt.match(/\{[\s\S]*\}/); let v = null; if (m) { try { v = JSON.parse(m[0]); } catch { v = null; } }
    if (v) t = { input: v };
    else if (txt && tool.name === "repondre") t = { input: { mode: "faire", message: txt.slice(0, 4000) } };
    else throw new Error("réponse de Claude illisible");
  }
  try {
    const u = j.usage || {}, tin = Number(u.input_tokens || 0), tout = Number(u.output_tokens || 0);
    await db.from("wl_couts").insert({ membre: qui || null, usage, modele: String(j.model || MODELE), tokens_in: tin, tokens_out: tout, cout_eur: Math.round(((tin * TARIF[0] + tout * TARIF[1]) / 1e6) * 0.92 * 1e5) / 1e5 });
  } catch (_) { /* comptage facultatif */ }
  return t.input;
}
const OUTIL_TEL = (postesPossibles: string[], actions: string[], peutTransmettre: boolean) => ({
  name: "repondre", description: "Ta réponse au membre de la rédaction, sous forme structurée.",
  input_schema: { type: "object", additionalProperties: false, required: ["mode", "message"], properties: {
    mode: { type: "string", enum: peutTransmettre ? ["faire", "transmettre", "question"] : ["faire", "question"], description: "faire : tu t'en charges (avec une action proposée, ou une simple réponse si c'est une information) ; transmettre : ce n'est pas de ton ressort ; question : il te manque une précision indispensable." },
    message: { type: "string", description: "Ce que tu dis au membre, en français, court et concret (2 à 6 phrases), vouvoiement." },
    ...(peutTransmettre ? { transmettre_a: { type: "string", enum: postesPossibles, description: "Poste compétent (mode transmettre seulement)." }, note_transmission: { type: "string", description: "Ce que le poste suivant doit savoir (mode transmettre)." } } : {}),
    action: { type: "object", additionalProperties: false, required: ["type", "params"], description: "Action proposée (mode faire), exécutée par la page avec validation humaine.", properties: {
      type: { type: "string", enum: actions }, params: { type: "object", description: "Paramètres de l'action, selon le catalogue." } } },
  } },
});
function systemePoste(p: Poste, me: Membre, peutTransmettre: boolean, autres: Poste[]) {
  return [
    "Tu es " + p.nom + ", un poste IA du Writinglab, la salle de rédaction en ligne de Posthumain (média suisse francophone sur la science et la technologie, posthumain.com).",
    "Tu parles avec " + me.nom + " (" + (me.chef ? "rédacteur en chef" : "journaliste") + "), qui t'appelle au « téléphone » de ton bureau avec une requête libre, écrite ou dictée (la dictée peut contenir des mots mal reconnus).",
    "TON RÔLE : " + p.role,
    "TES ACTIONS (les seules que tu peux proposer) :\n" + p.actions.map((a) => "- " + ACTIONS_DOC[a]).join("\n"),
    peutTransmettre ? "SI CE N'EST PAS DE TON RESSORT : mode « transmettre », vers le poste compétent :\n" + autres.map((x) => "- " + x.id + " (" + x.nom + ") : " + x.aiguillage).join("\n") + "\nLa requête lui sera transmise automatiquement, une seule fois." : "La requête t'a été TRANSMISE par un autre poste : traite-la (mode « faire » ou « question »), tu ne peux pas la transmettre à nouveau. Si elle n'est pas de ton ressort, dis-le clairement et indique précisément quel poste appeler (☎️ de son bureau) : ne renvoie jamais la balle sans solution.",
    reglesAiguillage(p, peutTransmettre, autres),
    "RÈGLES :\n- Jamais d'envoi ni de publication : tu produis seulement des propositions que le membre valide (brouillon, réponse à enregistrer, citations proposées).\n- Utilise uniquement les identifiants (article_id, fiche_id, mail_id) présents dans le contexte. Si la fiche ou le mail visé est ambigu ou absent, pose une question (mode « question ») en citant les possibilités.\n- N'invente aucun fait, aucune citation, aucune adresse, aucun numéro : seulement ce qui est dans la requête ou le contexte.\n- Si la demande relève d'un AUTRE poste, transmets-la (ou indique quel poste appeler) au lieu de répondre que tu ne peux pas.\n- Pour reponse_fiche : une réponse par question de la fiche quand le membre en a rapporté le contenu ; laisse de côté les questions sans réponse et dis-le ; les propos qui ne répondent à aucune question vont dans une entrée dont la question est « Complément ».\n- Une simple information (un solde, un état) : mode « faire » sans action, la réponse est dans le message.\n- En mode « question » : demande seulement ce qui manque. N'annonce jamais qu'un résultat est en cours, prêt ou « sera prêt » : dis ce qui serait fait une fois la réponse reçue, au conditionnel (par exemple « Avec votre numéro, je pourrais préparer la réponse dans sa fiche. »).\n- Réponds avec l'outil « repondre ».",
  ].filter(Boolean).join("\n\n");
}
// Règles d'aiguillage générées depuis le catalogue (postes, aiguillage.contacts_interview, paramètre « telephone » des capacités).
function reglesAiguillage(p: Poste, peut: boolean, autres: Poste[]): string {
  const ci = POSTES[POSTE_CONTACTS], courrier = Object.values(POSTES).filter((x) => x.mail).map((x) => x.nom);
  const r: string[] = [];
  if (ci) r.push("CONTACTS D'INTERVIEW : une personne citée qui a une fiche (« fiches » ou « contacts_fiches » du contexte : compare le nom cité, même approximatif ou mal dicté, aux noms des fiches) est un contact d'interview, jamais un mail du Courrier. " +
    (ci.id === p.id ? "Tout mail à lui écrire (répondre à son mail, remercier, proposer un appel ou une autre formule, fixer un rendez-vous, donner notre numéro) est pour TOI : propose l'action adaptée sur SA fiche, ne transmets pas." : "Tout mail à lui écrire (répondre à son mail, remercier, proposer un appel, fixer un rendez-vous, donner notre numéro) relève de " + ci.nom + (peut && autres.some((x) => x.id === ci.id) ? " : transmets-lui." : " : indique au membre d'appeler " + ci.nom + ".")) +
    (courrier.length && !p.mail ? " Ne transmets JAMAIS une telle demande à " + courrier.join(" ni à ") + " (ils ne gèrent que les mails de leur courrier)." : ""));
  if (p.mail) r.push("TON COURRIER : tu ne traites que les mails présents dans « courrier » du contexte. Si la personne citée n'y est pas, dis-le clairement (« ce contact n'est pas dans mon courrier ») ; si elle a une fiche, précise que c'est un contact d'interview" +
    (ci ? (peut ? " et transmets à " + ci.nom : " et indique d'appeler " + ci.nom + " (☎️ de son bureau)") : "") + ". Ne réponds jamais seulement que le courrier est vide : donne toujours la solution.");
  if (p.actions.some((a) => CAPS[a] && CAPS[a].params && CAPS[a].params.telephone)) r.push("NUMÉRO DE TÉLÉPHONE : le numéro du membre est « moi.telephone » dans le contexte (vide = non renseigné). Quand il faut donner notre numéro (le membre le demande, ou le contact l'a demandé pour un appel que le membre souhaite), mets-le dans le paramètre « telephone ». S'il est vide et que la requête n'en donne pas, pose la question (mode « question ») en demandant le numéro à donner : n'invente jamais de numéro.");
  return r.join("\n\n");
}
// Validation générique d'une capacité proposée par Claude : porteur, droits, schéma des paramètres, existence des éléments visés.
// deno-lint-ignore no-explicit-any
function valider(me: Membre, p: Poste, a: any, ctx: any): { ok: true; action: any } | { ok: false; why: string } {
  if (!a || !a.type) return { ok: true, action: null };
  const cap = CAPS[a.type];
  if (!cap || !p.actions.includes(a.type) || !(cap.postes || []).includes(p.id)) return { ok: false, why: "action hors du rôle de ce poste" };
  if ((cap.droits === "chef" && !me.chef) || (cap.droits === "journaliste" && me.chef)) return { ok: false, why: "action réservée " + (cap.droits === "chef" ? "au rédacteur en chef" : "aux journalistes") };
  const pr = a.params && typeof a.params === "object" ? a.params : {};
  const fiche = (id: string) => (ctx.fiches || []).find((f: { fiche_id: string }) => f.fiche_id === id);
  const art = (id: string) => (ctx.articles || []).some((x: { id: string }) => x.id === id) || (ctx.fiches || []).some((f: { article_id: string }) => f.article_id === id);
  // deno-lint-ignore no-explicit-any
  const out: Record<string, any> = {}, refs: Record<string, any> = {};
  for (const [nom, d] of Object.entries(cap.params || {})) {
    const v = pr[nom], vide = v == null || v === "" || (Array.isArray(v) && !v.length);
    if (vide) {
      if (d.requis) return { ok: false, why: d.type === "contact" ? "contact sans nom" : d.type === "liste" ? "aucune question" : nom + " manquant" };
      if (d.type === "texte") out[nom] = ""; else if (d.type === "liste" || d.type === "qr") out[nom] = [];
      continue;
    }
    if (d.type === "article") { if (!art(String(v))) return { ok: false, why: "article inconnu" }; out[nom] = String(v); }
    else if (d.type === "fiche") {
      const f = fiche(String(v)); if (!f) return { ok: false, why: "fiche inconnue (ou pas la vôtre)" };
      if (Array.isArray(d.statuts) && !d.statuts.includes(String(f.statut))) return { ok: false, why: "la fiche n'attend pas de réponse (statut : " + f.statut + ")" };
      if (d.avec_reponse && !f.reponse) return { ok: false, why: "la fiche n'a pas encore de réponse" };
      out[nom] = f.fiche_id; refs.fiche = f;
    } else if (d.type === "mail") {
      const m = (ctx.courrier || []).find((x: { mail_id: string }) => x.mail_id === String(v)); if (!m) return { ok: false, why: "mail inconnu" };
      out[nom] = m.mail_id; refs.mail = m;
    } else if (d.type === "contact") {
      const c = typeof v === "object" ? v : {}; if (!String(c.nom || "").trim()) return { ok: false, why: "contact sans nom" };
      out[nom] = { nom: court(c.nom, 120), email: String(c.email || "").trim().slice(0, 160), role: court(c.role, 200), institution: court(c.institution, 200), langue: c.langue === "en" ? "en" : "fr" };
    } else if (d.type === "liste") {
      const l = (Array.isArray(v) ? v : []).map((q: unknown) => court(q, d.long || 600)).filter(Boolean).slice(0, d.max || 12);
      if (!l.length && d.requis) return { ok: false, why: "aucune question" }; out[nom] = l;
    } else if (d.type === "qr") {
      out[nom] = (Array.isArray(v) ? v : []).map((x: { question?: unknown; reponse?: unknown }) => ({ question: court(x && x.question, 600), reponse: String((x && x.reponse) || "").trim().slice(0, 6000) })).filter((x: { reponse: string }) => x.reponse).slice(0, d.max || 12);
    } else if (d.type === "texte") out[nom] = d.brut ? String(v).trim().slice(0, d.long || 3000) : court(v, d.long || 500);
    else if (d.type === "choix") { if (!(d.valeurs || []).includes(String(v))) return { ok: false, why: nom + " invalide" }; out[nom] = String(v); }
    else if (d.type === "cible") out[nom] = String(v);
  }
  if (cap.au_moins_un && !cap.au_moins_un.some((k) => out[k] && (Array.isArray(out[k]) ? out[k].length : String(out[k]).trim()))) return { ok: false, why: "réponse vide" };
  for (const [nom, d] of Object.entries(cap.params || {})) if (d.type === "cible") {
    const c = String(out.cible || ""), id = String(out[nom] || "");
    const ok = (c === "fiche" && fiche(id)) || (c === "mail" && (ctx.courrier || []).some((x: { mail_id: string }) => x.mail_id === id)) || (c === "panneau" && POSTES[id] && (me.chef || !POSTES[id].chefSeul));
    if (!ok) return { ok: false, why: "élément à ouvrir introuvable" };
  }
  for (const [k, chemin] of Object.entries(cap.enrichir || {})) { const [o, ch] = chemin.split("."); if (refs[o]) out[k] = refs[o][ch]; }
  return { ok: true, action: { type: a.type, params: out } };
}
// deno-lint-ignore no-explicit-any
async function contexte(me: Membre, p: Poste, b: any) {
  const articles = (Array.isArray(b.articles) ? b.articles : []).slice(0, 20).map((a: { id?: unknown; titre?: unknown; statut?: unknown }) => ({ id: String(a.id || "").slice(0, 40), titre: court(a.titre, 140), statut: String(a.statut || "").slice(0, 20) })).filter((a: { id: string }) => a.id);
  const articleId = String(b.article_id || "");
  // deno-lint-ignore no-explicit-any
  const ctx: any = { date: new Date().toLocaleString("fr-CH", { timeZone: "Europe/Zurich" }), article_en_cours: articles.find((a: { id: string }) => a.id === articleId) || (articleId ? { id: articleId } : null), articles };
  const { data: eqTel } = await db.from("wl_equipe").select("telephone").eq("id", me.id).limit(1);
  ctx.moi = { nom: me.nom, telephone: String((eqTel && eqTel[0] && eqTel[0].telephone) || "") };
  if (p.contexte.includes("fiches") || b.fiche_id) ctx.fiches = (await fichesVisibles(me, articleId, String(b.texte || ""))).map(ficheCtx);
  else ctx.contacts_fiches = (await fichesVisibles(me, articleId, String(b.texte || ""))).map((f) => ({ fiche_id: f.fiche_id, nom: f.contact_nom, statut: f.statut }));
  if (b.fiche_id && ctx.fiches && !ctx.fiches.some((f: { fiche_id: string }) => f.fiche_id === b.fiche_id)) {
    let q = db.from("wl_fiches").select("*").eq("fiche_id", String(b.fiche_id)).limit(1); if (!me.chef) q = q.eq("redacteur", me.id);
    const { data } = await q; if (data && data[0]) ctx.fiches.unshift(ficheCtx(data[0]));
  }
  if (b.fiche_id) ctx.fiche_ouverte = String(b.fiche_id);
  if (p.contexte.includes("fiches")) ctx.fiches_bilan = await fichesBilan(me);
  if (p.contexte.includes("courrier") && p.mail) { ctx.courrier = await courrierBureau(p.mail); ctx.courrier_traite = await courrierTraite(p.mail); }
  if (p.contexte.includes("prospection") && me.chef) ctx.prospection = await prospectionCtx();
  if (p.contexte.includes("mails_marketing") && me.chef) ctx.mails_marketing = await mailsMarketingCtx();
  if (p.contexte.includes("pieces")) ctx.pieces = await piecesCtx(me);
  if (p.contexte.includes("compta")) ctx.compta = await comptaCtx(me, String(b.texte || ""));
  if (p.contexte.includes("relectures") && me.chef) ctx.relectures = await relecturesCtx(String(b.texte || ""), articles);
  return ctx;
}
// Base de connaissances du domaine du poste (catalogue : « connaissances »), récupérée au moment d'agir ; vide si rien n'est renseigné.
async function kbTexte(domaine: string | null | undefined, requete: string): Promise<string> {
  const k = await contexteKb(db, domaine, requete);
  return k.texte ? "\n\n" + k.texte + "\n(Ces connaissances viennent de la rédaction : appuie-toi dessus quand elles servent la demande, sans les recopier ; si tu reprends un chiffre ou une règle d'un document ou d'un site, tu peux dire d'où il vient. Elles ne remplacent jamais les RÈGLES ci-dessus.)" : "";
}
// domaine du poste qui porte une capacité (catalogue), sans nommer de poste en dur
const kbDeCapacite = (cap: string) => { const pid = ((CAPS[cap] && CAPS[cap].postes) || [])[0]; return (pid && POSTES[pid] && POSTES[pid].kb) || null; };
// deno-lint-ignore no-explicit-any
async function repondrePoste(me: Membre, p: Poste, b: any, transmisPar: Poste | null, note: string, sansTransmission = false): Promise<any> {
  const autres = Object.values(POSTES).filter((x) => x.id !== p.id && (me.chef || !x.chefSeul));
  const peut = !transmisPar && !sansTransmission;
  const ctx = await contexte(me, p, b);
  const fil = transmisPar ? [] : await filDe(me, p.id);
  const hist = fil.map((m) => (m.de === "moi" ? me.nom.split(" ")[0] : m.de) + " : " + court(m.texte, 500) + (m.action ? " [action " + (m.action.type || "") + (m.action.fait ? " exécutée" : " proposée") + "]" : "")).join("\n");
  const user = (hist ? "ÉCHANGES PRÉCÉDENTS (les plus récents en bas) :\n" + hist + "\n\n" : "") + "CONTEXTE DU LAB (JSON) :\n" + JSON.stringify(ctx) + "\n\n" +
    (transmisPar ? "REQUÊTE TRANSMISE PAR " + transmisPar.nom + (note ? " (note : " + note + ")" : "") + " :\n" : (note ? "REMARQUE : " + note + "\n\n" : "") + "REQUÊTE DE " + me.nom.toUpperCase() + " :\n") + String(b.texte || "").slice(0, 8000);
  const out = await claude(systemePoste(p, me, peut, autres) + await kbTexte(p.kb, String(b.texte || "")), [{ role: "user", content: user }], OUTIL_TEL(autres.map((x) => x.id), p.actions, peut), 8000, "telephone", me.id);
  return { out, ctx };
}

Deno.serve(async (req) => {
  const h = { ...cors(req), "Content-Type": "application/json", "Cache-Control": "no-store" };
  if (req.method === "OPTIONS") return new Response(null, { headers: h });
  const out = (v: unknown, s = 200) => new Response(JSON.stringify(v), { status: s, headers: h });
  if (req.method !== "POST") return out({ ok: false, why: "method" }, 405);
  // deno-lint-ignore no-explicit-any
  let b: any; try { b = await req.json(); } catch { return out({ ok: false, why: "bad_json" }, 400); }
  try {
    const me = await membre(String(b.token || "")).catch(() => null);
    if (!me) return out({ ok: false, why: "accès réservé à l’équipe" }, 401);
    const posteOk = (id: string) => POSTES[id] && (me.chef || !POSTES[id].chefSeul) ? POSTES[id] : null;

    if (b.action === "capacites") return out({ ok: true, transcription_fichier: !!env("OPENAI_API_KEY"), postes: Object.values(POSTES).filter((p) => me.chef || !p.chefSeul).map((p) => ({ id: p.id, nom: p.nom })) });

    if (b.action === "historique") {
      const p = posteOk(String(b.poste || "")); if (!p) return out({ ok: false, why: "poste indisponible pour votre rôle" }, 403);
      return out({ ok: true, poste: p.id, fil: await filDe(me, p.id, 40) });
    }

    if (b.action === "telephone") {
      const p = posteOk(String(b.poste || "")); if (!p) return out({ ok: false, why: "poste indisponible pour votre rôle" }, 403);
      const texte = String(b.texte || "").trim(); if (!texte) return out({ ok: false, why: "requête vide" }, 400);
      const ajout = async (row: Record<string, unknown>) => { const { data } = await db.from("wl_tel").insert({ membre: me.id, poste: p.id, ...row }).select("id,de,transmis_par,mode,texte,action,created_at"); return data && data[0]; };
      const fil: unknown[] = [await ajout({ de: "moi", texte: texte.slice(0, 8000) })];
      let { out: r, ctx } = await repondrePoste(me, p, b, null, "");
      let qui = p;
      // Garde-fou d'aiguillage : une personne qui a une fiche d'interview n'est jamais transmise à un poste « courrier ».
      if (r.mode === "transmettre") {
        const c0 = POSTES[String(r.transmettre_a || "")], fc = c0 && c0.mail ? ficheCitee(texte, ctx) : null;
        if (fc && POSTE_CONTACTS) {
          if (POSTE_CONTACTS === p.id) ({ out: r, ctx } = await repondrePoste(me, p, b, null, "ne transmets pas : " + (fc.nom || fc.contact) + " a une fiche d'interview (fiche_id " + fc.fiche_id + "), ce n'est pas un mail du Courrier ; c'est à toi de proposer l'action sur sa fiche.", true));
          else if (posteOk(POSTE_CONTACTS)) { r.transmettre_a = POSTE_CONTACTS; r.note_transmission = (r.note_transmission ? r.note_transmission + " " : "") + "(" + (fc.nom || fc.contact) + " a une fiche d'interview : fiche_id " + fc.fiche_id + ")"; }
        }
      }
      if (r.mode === "transmettre") {
        const cible = posteOk(String(r.transmettre_a || ""));
        if (!cible || cible.id === p.id) {
          fil.push(await ajout({ de: p.id, mode: "faire", texte: String(r.message || "Ce n’est pas de mon ressort.") + (r.transmettre_a && !cible ? " (Ce poste n’est pas accessible depuis votre rôle : demandez au rédacteur en chef.)" : "") }));
          return out({ ok: true, fil });
        }
        fil.push(await ajout({ de: p.id, mode: "transmettre", texte: String(r.message || "Ce n’est pas de mon ressort, je transmets.") + " → " + cible.nom, action: { type: "transmission", params: { vers: cible.id } } }));
        ({ out: r, ctx } = await repondrePoste(me, cible, b, p, String(r.note_transmission || "")));
        qui = cible;
        if (r.mode === "transmettre") r.mode = "faire"; // une seule transmission, jamais de boucle
      }
      const v = valider(me, qui, r.mode === "faire" ? r.action : null, ctx);
      const action = v.ok ? v.action : null;
      const msg = String(r.message || "").slice(0, 4000) + (!v.ok ? "\n\n(Je ne peux pas le faire directement : " + v.why + ".)" : "");
      fil.push(await ajout({ de: qui.id, transmis_par: qui.id !== p.id ? p.id : null, mode: r.mode === "question" ? "question" : "faire", texte: msg, action }));
      return out({ ok: true, fil });
    }

    // Canal de la réponse choisi à la main dans la fiche (23/10/2026) : « Reçue par : e-mail / téléphone / en personne ».
    if (b.action === "canal") {
      const c = String(b.canal || "");
      if (c && !["email", "telephone", "email+telephone", "personne"].includes(c)) return out({ ok: false, why: "canal inconnu" }, 400);
      let q = db.from("wl_fiches").select("fiche_id,historique").eq("fiche_id", String(b.fiche_id || "")).limit(1); if (!me.chef) q = q.eq("redacteur", me.id);
      const { data } = await q; const f = data && data[0];
      if (!f) return out({ ok: false, why: "fiche introuvable (ou pas la vôtre)" }, 404);
      const hist = pj(f.historique) || []; hist.push({ t: new Date().toISOString(), e: "canal de la réponse : " + ({ email: "e-mail", telephone: "téléphone", "email+telephone": "e-mail et téléphone", personne: "en personne" }[c] || "non précisé"), par: me.id });
      const { error } = await db.from("wl_fiches").update({ reponse_canal: c || null, historique: JSON.stringify(hist.slice(-60)) }).eq("fiche_id", f.fiche_id);
      if (error) return out({ ok: false, why: "enregistrement impossible" }, 500);
      return out({ ok: true, canal: c || null });
    }

    if (b.action === "action_faite") {
      const id = Number(b.id); if (!id) return out({ ok: false, why: "id" }, 400);
      const { data } = await db.from("wl_tel").select("id,action").eq("id", id).eq("membre", me.id).limit(1);
      if (!data || !data[0] || !data[0].action) return out({ ok: false, why: "proposition introuvable" }, 404);
      const a = { ...data[0].action, fait: true, resultat: court(b.resultat, 300) };
      await db.from("wl_tel").update({ action: a }).eq("id", id);
      return out({ ok: true, action: a });
    }

    // ---------- Réponse par téléphone dans une fiche ----------
    if (b.action === "appel_traiter" || b.action === "appel_enregistrer") {
      let q = db.from("wl_fiches").select("*").eq("fiche_id", String(b.fiche_id || "")).limit(1); if (!me.chef) q = q.eq("redacteur", me.id);
      const { data: f0 } = await q; const f = f0 && f0[0];
      if (!f) return out({ ok: false, why: "fiche introuvable (ou pas la vôtre)" }, 404);
      if (!["envoyé", "a répondu", "relance", "inséré"].includes(String(f.statut))) return out({ ok: false, why: "cette fiche n’attend pas de réponse (statut : " + f.statut + ")" });
      const qs: string[] = (pj(f.questions) || []).map((x: unknown) => String(x || "")).filter(Boolean);
      if (b.action === "appel_traiter") {
        const tr = String(b.transcription || "").trim(); if (tr.length < 20) return out({ ok: false, why: "transcription trop courte" });
        const outil = { name: "reponses", description: "Réponse d'interview structurée.", input_schema: { type: "object", additionalProperties: false, required: ["resume", "reponses"], properties: {
          resume: { type: "string", description: "Résumé fidèle de ce qu'a dit le contact (3 à 6 phrases), dans la langue de l'interview." },
          reponses: { type: "array", items: { type: "object", additionalProperties: false, required: ["question", "reponse"], properties: { question: { type: "string" }, reponse: { type: "string", description: "Ce que le contact a répondu à cette question, fidèlement (propos rapportés ; garde ses formulations fortes entre guillemets quand elles sont nettes). Vide si rien n'a été dit." } } } },
          citations: { type: "array", items: { type: "string" }, description: "2 à 4 phrases du contact, citables telles quelles (corrigées seulement de l'oral : hésitations, répétitions)." },
          manque: { type: "string", description: "Questions restées sans réponse ou passages incompréhensibles de la transcription." } } } };
        const sys = "Tu es l’Assistant du Writinglab de Posthumain. Une journaliste a mené une interview PAR TÉLÉPHONE ; voici la transcription automatique (reconnaissance vocale : mots mal reconnus possibles, les deux voix mélangées) ou ses notes d'appel. Tu en tires un résumé et la réponse du contact à CHAQUE question de la fiche, dans l'ordre. N'invente rien : si une question n'a pas été abordée, laisse sa réponse vide et signale-la dans « manque ». Réponds avec l'outil « reponses ».";
        const user = "Article : " + (f.article_titre || "") + "\nContact : " + [f.contact_nom, f.contact_role, f.contact_institution].filter(Boolean).join(", ") + "\nLangue de l'interview : " + (f.langue === "en" ? "anglais" : "français") +
          "\nQuestions de la fiche :\n" + (qs.length ? qs.map((x, i) => (i + 1) + ". " + x).join("\n") : "(aucune question enregistrée : structure par thème)") + "\n\nTRANSCRIPTION / NOTES :\n" + tr.slice(0, 30000);
        const r = await claude(sys + await kbTexte(kbDeCapacite("reponse_fiche"), tr.slice(0, 600)), [{ role: "user", content: user }], outil, 8000, "telephone", me.id);
        const reps = (Array.isArray(r.reponses) ? r.reponses : []).map((x: { question?: string; reponse?: string }) => ({ question: String(x.question || ""), reponse: String(x.reponse || "") }));
        return out({ ok: true, resume: String(r.resume || ""), reponses: reps, citations: Array.isArray(r.citations) ? r.citations.map(String).slice(0, 6) : [], manque: String(r.manque || ""), questions: qs });
      }
      // appel_enregistrer
      const source = b.source === "appel" ? "appel" : "notes";
      if (source === "appel" && b.consentement !== true) return out({ ok: false, why: "consentement de la personne requis avant d’enregistrer un appel écouté" });
      const reps = (Array.isArray(b.reponses) ? b.reponses : []).map((x: { question?: unknown; reponse?: unknown }) => ({ question: String((x && x.question) || "").slice(0, 600), reponse: String((x && x.reponse) || "").trim().slice(0, 6000) })).filter((x: { reponse: string }) => x.reponse).slice(0, 12);
      const resume = String(b.resume || "").trim().slice(0, 3000);
      if (!reps.length && !resume) return out({ ok: false, why: "réponse vide" });
      const now = new Date(), quand = now.toLocaleString("fr-CH", { timeZone: "Europe/Zurich", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
      const en = f.langue === "en";
      const texte = "📞 " + (en ? "Answer received by phone on " : "Réponse reçue par téléphone le ") + quand + " (" + (source === "appel" ? (en ? "call transcribed with consent" : "appel retranscrit avec l’accord de la personne") : (en ? "call notes" : "notes d’appel")) + ", " + me.nom + ")\n\n" +
        (resume ? (en ? "Summary: " : "Résumé : ") + resume + "\n\n" : "") + reps.map((x: { question: string; reponse: string }, i: number) => (x.question ? (i + 1) + ". " + x.question + "\n" : "") + x.reponse).join("\n\n");
      const hist = pj(f.historique) || []; hist.push({ t: now.toISOString(), e: "réponse reçue par téléphone" + (source === "appel" ? " (appel retranscrit, accord de la personne)" : " (notes d’appel)"), par: me.id });
      // Fiche qui a déjà une réponse (par mail) : la réponse au téléphone s'AJOUTE, et une preuve par mail déjà obtenue est gardée.
      const avant = String(f.reponse || "").trim(), pv0 = pj(f.reponse_preuve);
      const garderPreuve = !!(f.reponse_verifiee && pv0 && pv0.lien !== "telephone");
      const row: Record<string, unknown> = { reponse: ((avant ? avant + "\n\n— — —\n\n" : "") + texte).slice(0, 40000), reponse_le: now.toISOString(), historique: JSON.stringify(hist.slice(-60)) };
      if (f.statut !== "inséré") row.statut = "a répondu";
      // Passage par wl-db (mêmes notifications qu'une réponse reçue), puis la preuve « téléphone » (colonnes hors wl-db).
      const r = await fetch(env("SUPABASE_URL") + "/functions/v1/wl-db", { method: "POST", headers: { "Content-Type": "application/json", "x-tv-secret": env("TV_ADMIN_SECRET") }, signal: AbortSignal.timeout(30000),
        body: JSON.stringify({ action: "update", table: "fiches", where: { fiche_id: f.fiche_id }, row }) });
      if (!r.ok) return out({ ok: false, why: "enregistrement impossible (wl-db " + r.status + ")" }, 500);
      if (!garderPreuve) await db.from("wl_fiches").update({ reponse_verifiee: true, reponse_preuve: JSON.stringify({ lien: "telephone", de: String(f.contact_email || "").toLowerCase(), recu_le: now.toISOString(), par: me.id, source, consentement: source === "appel" ? true : null, note: "réponse par téléphone : pas de preuve par les en-têtes de mail, pièces à vérifier" }) }).eq("fiche_id", f.fiche_id);
      await db.from("wl_appels").insert({ fiche_id: f.fiche_id, membre: me.id, source, consentement: source === "appel", transcription: String(b.transcription || "").slice(0, 60000) || null, resume: resume || null, reponses: reps });
      return out({ ok: true, fiche_id: f.fiche_id, reponse: texte });
    }
    // « ✓ Marquer comme traitée » (23/10/2026) : réponse purement logistique, sans contenu à citer. Seul l'historique change : la page
    // affiche alors la fiche « en attente de réponse » ; statut réel, réponse, preuve et pièces restent intacts.
    if (b.action === "fiche_traitee") {
      let q = db.from("wl_fiches").select("fiche_id,statut,historique").eq("fiche_id", String(b.fiche_id || "")).limit(1); if (!me.chef) q = q.eq("redacteur", me.id);
      const { data } = await q; const f = data && data[0];
      if (!f) return out({ ok: false, why: "fiche introuvable (ou pas la vôtre)" }, 404);
      if (f.statut !== "a répondu") return out({ ok: false, why: "seule une fiche « a répondu » peut être marquée traitée" });
      const hist = pj(f.historique) || []; hist.push({ t: new Date().toISOString(), e: "réponse marquée traitée", par: me.id });
      const { error } = await db.from("wl_fiches").update({ historique: JSON.stringify(hist.slice(-60)) }).eq("fiche_id", f.fiche_id);
      if (error) return out({ ok: false, why: "enregistrement impossible" }, 500);
      return out({ ok: true });
    }
    // ---------- Réponse dans le fil d'une fiche d'interview (capacité du catalogue dont l'exécuteur est « suite_rediger ») ----------
    if (b.action === "suites") {
      let q = db.from("wl_fiches").select("fiche_id,suite_sujet,suite_corps,suite_consigne,suite_a,suite_cc,suite_prete_le,suites").neq("statut", "archivé").order("updated_at", { ascending: false }).limit(400);
      if (!me.chef) q = q.eq("redacteur", me.id);
      const [{ data }, { data: eqTel }] = await Promise.all([q, db.from("wl_equipe").select("telephone").eq("id", me.id).limit(1)]);
      const l: Record<string, unknown> = {};
      for (const f of data || []) { const env0 = Array.isArray(f.suites) ? f.suites : (pj(f.suites) || []); if (f.suite_corps || env0.length) l[f.fiche_id] = { sujet: f.suite_sujet || "", corps: f.suite_corps || "", consigne: f.suite_consigne || "", a: f.suite_a || "", cc: Array.isArray(f.suite_cc) ? f.suite_cc : [], prete_le: f.suite_prete_le, envoyees: env0 }; }
      return out({ ok: true, suites: l, telephone: String((eqTel && eqTel[0] && eqTel[0].telephone) || "") });
    }
    // ---------- Personnes en copie d'une réponse déjà reçue (28/10/2026) ----------
    if (b.action === "copies_rattraper") {
      let q = db.from("wl_fiches").select("fiche_id,boite,redacteur,contact_email,reponse_preuve,copies").eq("fiche_id", String(b.fiche_id || "")).limit(1); if (!me.chef) q = q.eq("redacteur", me.id);
      const { data: f0 } = await q; const f = f0 && f0[0];
      if (!f) return out({ ok: false, why: "fiche introuvable (ou pas la vôtre)" }, 404);
      if (f.copies != null) return out({ ok: true, copies: pj(f.copies) || [] });
      const pv = pj(f.reponse_preuve) || {}, idm = String(pv.reponse_message_id || "").trim();
      if (!/^<[^<>\s]+@[^<>\s]+>$/.test(idm) || pv.lien === "telephone") { await db.from("wl_fiches").update({ copies: "[]" }).eq("fiche_id", f.fiche_id); return out({ ok: true, copies: [] }); }
      let adr = ADRESSES[String(f.boite || "")] || "";
      if (!adr && f.boite) { const { data: bx } = await db.from("wl_boites").select("adresse").eq("id", f.boite).limit(1); adr = String((bx && bx[0] && bx[0].adresse) || ""); }
      if (!adr) return out({ ok: false, why: "boîte de la fiche inconnue" });
      // deno-lint-ignore no-explicit-any
      let r: any = null;
      try {
        const rr = await fetch(env("SUPABASE_URL") + "/functions/v1/wl-mail", { method: "POST", signal: AbortSignal.timeout(40000), headers: { "Content-Type": "application/json", "x-tv-secret": env("TV_ADMIN_SECRET") },
          body: JSON.stringify({ action: "entetes", boite: adr, message_id: idm }) });
        r = await rr.json().catch(() => null);
      } catch (_) { r = null; }
      if (!r || !r.ok) return out({ ok: false, why: "boîte mail injoignable pour l’instant" });
      const nous = new Set([...Object.values(ADRESSES), adr, ...(await equipe(db)).map((m) => m.email)].map((x) => String(x).toLowerCase()));
      const { data: bxs } = await db.from("wl_boites").select("adresse"); for (const x of bxs || []) nous.add(String(x.adresse || "").toLowerCase());
      const exclus = new Set([String(f.contact_email || "").toLowerCase(), String(pv.de || "").toLowerCase(), String((r.de && r.de.email) || "")]);
      // deno-lint-ignore no-explicit-any
      const copies: any[] = [];
      // deno-lint-ignore no-explicit-any
      for (const [champ, l] of [["cc", r.cc || []], ["to", r.to || []]] as [string, any[]][]) for (const a of l) {
        const e = String(a.email || "").toLowerCase();
        if (!e || nous.has(e) || /@posthumain\.com$/.test(e) || exclus.has(e) || copies.some((c) => c.email === e)) continue;
        copies.push({ email: e, nom: String(a.nom || "").replace(/["<>\r\n]/g, "").trim().slice(0, 120), champ, vu_le: pv.recu_le || null });
      }
      await db.from("wl_fiches").update({ copies: JSON.stringify(copies.slice(0, 10)) }).eq("fiche_id", f.fiche_id);
      return out({ ok: true, copies: copies.slice(0, 10) });
    }
    if (b.action === "suite_rediger" || b.action === "suite_envoyer" || b.action === "suite_ecarter") {
      let q = db.from("wl_fiches").select("*").eq("fiche_id", String(b.fiche_id || "")).limit(1); if (!me.chef) q = q.eq("redacteur", me.id);
      const { data: f0 } = await q; const f = f0 && f0[0];
      if (!f) return out({ ok: false, why: "fiche introuvable (ou pas la vôtre)" }, 404);
      // deno-lint-ignore no-explicit-any
      const capS: any = Object.values(CAPS).find((c: any) => c.executeur && c.executeur.action === "suite_rediger");
      const statuts: string[] = (capS && capS.params && capS.params.fiche_id && capS.params.fiche_id.statuts) || ["envoyé", "a répondu", "relance", "inséré"];
      const hist = pj(f.historique) || [], now = new Date().toISOString();
      if (b.action === "suite_ecarter") {
        hist.push({ t: now, e: "réponse dans le fil écartée", par: me.id });
        await db.from("wl_fiches").update({ suite_sujet: null, suite_corps: null, suite_consigne: null, suite_a: null, suite_cc: null, suite_prete_le: null, historique: JSON.stringify(hist.slice(-60)) }).eq("fiche_id", f.fiche_id);
        return out({ ok: true });
      }
      if (!statuts.includes(String(f.statut))) return out({ ok: false, why: "pas de réponse dans le fil possible pour cette fiche (statut : " + f.statut + ")" });
      const mid = (s: unknown) => { const v = String(s || "").trim(); return /^<[^<>\s]+@[^<>\s]+>$/.test(v) ? v : ""; };
      const emailOk = (e: string) => /^[^\s@<>]+@[^\s@<>]+\.[a-z]{2,}$/i.test(e);
      const pv = pj(f.reponse_preuve) || {}, contact = String(f.contact_email || "").trim().toLowerCase(), de = String(pv.de || "").trim().toLowerCase();
      const dom = (e: string) => e.split("@")[1] || "";
      // On répond à la personne qui a écrit (autre adresse du même domaine que le contact, déjà validée dans la preuve), sinon au contact.
      const destContact = de && emailOk(de) && pv.lien !== "telephone" && (de === contact || dom(de) === dom(contact)) ? de : contact;
      if (!emailOk(destContact)) return out({ ok: false, why: "adresse e-mail du contact manquante ou invalide" });
      // 28/10/2026 : on peut répondre à une personne que le contact a mise en copie (son assistante, sa secrétaire…) : elle devient
      // la destinataire et le contact passe en copie, dans le même fil. Seuls le contact et les personnes en copie sont acceptés.
      // deno-lint-ignore no-explicit-any
      const copiesF: any[] = (pj(f.copies) || []).filter((c: any) => c && emailOk(String(c.email || "")));
      const nomDe = (e: string) => e === contact || e === de ? String(f.contact_nom || "") : String((copiesF.find((c) => c.email === e) || {}).nom || "");
      const permis = (e: string) => !!e && (e === contact || e === destContact || copiesF.some((c) => c.email === e));
      const base = String(f.mail_sujet || "").trim();
      const sujetDef = (/^\s*(re|tr|fwd?)\s*:/i.test(base) ? base : "Re: " + base).slice(0, 300);
      // deno-lint-ignore no-explicit-any
      const envoyees: any[] = Array.isArray(f.suites) ? f.suites : (pj(f.suites) || []);
      // Destinataire : demandé par la page (« Répondre à … »), sinon celui du brouillon en cours, sinon le dernier échange redirigé.
      const dern = envoyees.length ? envoyees[envoyees.length - 1] : null;
      const aDemande = String(b.a || "").trim().toLowerCase();
      if (aDemande && !permis(aDemande)) return out({ ok: false, why: "cette adresse n’est ni le contact ni une personne qu’il a mise en copie" });
      const aSuite = String(f.suite_a || "").toLowerCase(), aDern = dern && Array.isArray(dern.cc) && dern.cc.length ? String(dern.a || "").toLowerCase() : "";
      const dest = b.action === "suite_envoyer" ? (permis(aSuite) ? aSuite : destContact) : aDemande || (permis(aDern) ? aDern : destContact);
      const redirige = dest !== contact && dest !== destContact;
      const cc: string[] = redirige ? [destContact] : [];
      const { data: eqRows } = await db.from("wl_equipe").select("id,nom,boite,signature,signature_en,telephone,actif").or("id.eq." + String(f.redacteur || "_") + (f.boite ? ",boite.eq." + String(f.boite) : ""));
      const boite = String(f.boite || ((eqRows || []).find((x) => x.id === f.redacteur) || {}).boite || "");
      const owner = (eqRows || []).find((x) => x.boite === boite && x.actif !== false) || (eqRows || []).find((x) => x.id === f.redacteur) || { id: f.redacteur, nom: "", signature: "", signature_en: "" };
      if (b.action === "suite_rediger") {
        const consigne = String(b.consigne || "").trim().slice(0, 1500); if (consigne.length < 3) return out({ ok: false, why: "dites ce qu’il faut lui répondre" });
        const tel = String(b.telephone || "").replace(/[^\d+().\s\/-]/g, "").replace(/\s+/g, " ").trim().slice(0, 30);
        const telOk = tel.replace(/\D/g, "").length >= 6 ? tel : "";
        const en = f.langue === "en";
        const outil = { name: "mail", description: "Le texte de la réponse.", input_schema: { type: "object", additionalProperties: false, required: ["corps"], properties: { corps: { type: "string", description: "Texte du mail : formule d'appel, message, formule de politesse courte, SANS signature ni nom." } } } };
        const nomA = nomDe(dest);
        const pour = redirige ? "Ce message est adressé à " + (nomA ? nomA + " (" + dest + ")" : dest) + ", que " + (f.contact_nom || "le contact") + " a mis(e) en copie de sa réponse ; " + (f.contact_nom || "le contact") + " reste en copie. " +
          "N'invente pas sa fonction : si la réponse du contact la précise (assistante, secrétaire…), tu peux t'appuyer dessus. Formule d'appel avec le nom de cette personne s'il est connu (sinon « Bonjour, » / « Dear Sir or Madam, »), et fais le lien avec le contact (« comme convenu avec le Professeur X… »). " : "";
        const sys = "Tu es la Secrétaire du Writinglab de Posthumain (média suisse francophone sur la science et la technologie, posthumain.com). Tu rédiges une réponse courte dans le FIL d'une demande d'interview, au nom de " + (owner.nom || me.nom) + ". " + pour +
          "Langue : " + (en ? "anglais" : "français") + ". Vouvoiement, ton cordial et professionnel, 3 à 8 phrases, naturel (pas de formules creuses). Suis fidèlement la consigne du membre : n'ajoute aucun engagement, aucune date, aucun fait qui n'y est pas. " +
          "Réponds au dernier message du contact s'il y en a un, sans le recopier. " + (telOk ? "Donne ce numéro de téléphone tel quel : " + telOk + "." : "Ne mentionne aucun numéro de téléphone et n'en invente aucun.") +
          (redirige ? " Commence par la formule d'appel indiquée ci-dessus" : " Commence par la formule d'appel avec le nom du contact (« Bonjour Monsieur X, » / « Dear Dr X, »)") + ", termine par une formule de politesse courte, SANS signature ni nom : la signature est ajoutée à l'envoi. Réponds avec l'outil « mail ».";
        const user = "Contact : " + [f.contact_nom, f.contact_role, f.contact_institution].filter(Boolean).join(", ") + "\nArticle : " + (f.article_titre || "") +
          "\n\nNOTRE PREMIER MAIL (objet : " + base + ") :\n" + String(f.mail_corps || "").slice(0, 2500) +
          (f.reponse ? "\n\nSA RÉPONSE (" + (f.reponse_le || "") + ") :\n" + String(f.reponse).slice(-3000) : "\n\n(Pas encore de réponse du contact.)") +
          (envoyees.length ? "\n\nRÉPONSES DÉJÀ ENVOYÉES DANS LE FIL : " + envoyees.map((x) => (x.le || "").slice(0, 10) + " « " + (x.sujet || "") + " »").join(" ; ") : "") +
          "\n\nCONSIGNE DU MEMBRE (" + me.nom + ") :\n" + consigne + "\n\nNUMÉRO À DONNER : " + (telOk || "(aucun)");
        const r = await claude(sys + await kbTexte(kbDeCapacite("suite_interview"), consigne), [{ role: "user", content: user }], outil, 8000, "telephone", me.id, "low"); // réponse dans le fil d'une fiche : mail simple
        const corps = String(r.corps || "").trim().slice(0, 8000); if (!corps) return out({ ok: false, why: "rédaction impossible, réessayez" });
        hist.push({ t: now, e: "réponse dans le fil préparée (à valider)", par: me.id });
        const { error } = await db.from("wl_fiches").update({ suite_sujet: sujetDef, suite_corps: corps, suite_consigne: consigne, suite_a: dest, suite_cc: cc, suite_prete_le: now, historique: JSON.stringify(hist.slice(-60)) }).eq("fiche_id", f.fiche_id);
        if (error) return out({ ok: false, why: "enregistrement impossible" }, 500);
        return out({ ok: true, fiche_id: f.fiche_id, sujet: sujetDef, corps, a: dest, a_nom: nomA, cc });
      }
      // suite_envoyer : seulement après « Valider et envoyer » dans la fiche
      if (b.valide !== true) return out({ ok: false, why: "la réponse doit être relue et validée" });
      if (me.test) return out({ ok: false, why: "compte de test : l’envoi de mails est désactivé" });
      if (!mid(f.message_id)) return out({ ok: false, why: "pas de fil : le premier mail n’a pas d’identifiant" });
      const sujet = String(b.sujet || f.suite_sujet || sujetDef).trim().slice(0, 300), corps = String(b.corps || f.suite_corps || "").trim().slice(0, 20000);
      if (!sujet || !corps) return out({ ok: false, why: "objet ou message vide" });
      let adr = ADRESSES[boite] || "";
      if (!adr && boite) { const { data: bx } = await db.from("wl_boites").select("adresse,actif").eq("id", boite).limit(1); if (bx && bx[0] && bx[0].actif) adr = String(bx[0].adresse || ""); }
      if (!adr) return out({ ok: false, why: "aucune boîte Posthumain pour cette fiche" });
      // Fil : on répond au dernier message connu du contact (Message-ID gardé dans la preuve), sinon à notre dernier envoi.
      const repId = mid(pv.reponse_message_id);
      const irt = repId || (envoyees.length ? mid(envoyees[envoyees.length - 1].message_id) : "") || mid(f.message_id);
      const refs = [...new Set([mid(f.message_id), mid(pv.en_reponse_a), repId, ...envoyees.map((x) => mid(x.message_id))].filter(Boolean))];
      // Signature : la même que pour le premier mail et les relances (wl-push « signatures »), dans la langue de la fiche.
      const langue = f.langue === "en" ? "en" : "fr";
      let sigHtml = "";
      try {
        const rs = await fetch(env("SUPABASE_URL") + "/functions/v1/wl-push", { method: "POST", signal: AbortSignal.timeout(8000), headers: { "Content-Type": "application/json", origin: SITE }, body: JSON.stringify({ token: String(b.token || ""), action: "signatures" }) });
        const js = await rs.json().catch(() => null); if (js && js.ok && js.signatures && js.signatures[owner.id]) sigHtml = String(js.signatures[owner.id][langue] || "");
      } catch (_) { sigHtml = ""; }
      const escH = (t: string) => String(t).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c] as string));
      if (!sigHtml) sigHtml = String((langue === "en" ? (owner.signature_en || owner.signature) : owner.signature) || "").split("\n").map(escH).join("<br>");
      const sigTxt = sigHtml.replace(/<br\s*\/?>/gi, "\n").replace(/<a [^>]*href="([^"]+)"[^>]*>([^<]*)<\/a>/gi, (_m, h, t) => t === h ? t : t + " (" + h + ")").replace(/<[^>]+>/g, "")
        .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").trim();
      let lignes = corps.replace(/\s+$/, "").split("\n");
      if (owner.nom) { for (let i = Math.max(0, lignes.length - 8); i < lignes.length; i++) { if (lignes[i].trim().replace(/\*/g, "") === owner.nom) { lignes = lignes.slice(0, i); break; } } }
      const texte = lignes.join("\n").replace(/\s+$/, "");
      const html = '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.55;color:#1f1a12">' + escH(texte).replace(/\n/g, "<br>") + (sigHtml ? '<br><br><div style="color:#444">' + sigHtml + "</div>" : "") + "</div>";
      const nomQ = (s: unknown) => String(s || "").replace(/["<>\r\n]/g, "").trim();
      const from = (nomQ(owner.nom) ? '"' + nomQ(owner.nom) + ' – Posthumain" ' : "") + "<" + adr + ">";
      const to = (nomQ(nomDe(dest)) ? '"' + nomQ(nomDe(dest)) + '" ' : "") + "<" + dest + ">";
      const ccTxt = cc.map((e) => (nomQ(nomDe(e)) ? '"' + nomQ(nomDe(e)) + '" ' : "") + "<" + e + ">").join(", ");
      // Verrou : un seul envoi à la fois (deux clics, deux onglets) ; libéré après l'envoi ou au bout de 3 minutes.
      const lim = new Date(Date.now() - 180000).toISOString();
      const { data: lk } = await db.from("wl_fiches").update({ suite_verrou: now }).eq("fiche_id", f.fiche_id).or("suite_verrou.is.null,suite_verrou.lt." + lim).select("fiche_id");
      if (!lk || !lk.length) return out({ ok: false, why: "cette réponse est déjà en cours d’envoi" });
      // deno-lint-ignore no-explicit-any
      let rm: any = null;
      try {
        const rr = await fetch(env("SUPABASE_URL") + "/functions/v1/wl-mail", { method: "POST", signal: AbortSignal.timeout(58000), headers: { "Content-Type": "application/json", "x-tv-secret": env("TV_ADMIN_SECRET") },
          body: JSON.stringify({ from, to, cc: ccTxt, sujet, corps: sigTxt ? texte + "\n\n" + sigTxt : texte, html, in_reply_to: irt, references: refs.join(" "), attachments: [] }) });
        rm = await rr.json().catch(() => null);
      } catch (e) { rm = { ok: false, why: court((e as Error)?.message || e, 120) }; }
      if (!rm || !rm.ok) { await db.from("wl_fiches").update({ suite_verrou: null }).eq("fiche_id", f.fiche_id); return out({ ok: false, why: "envoi impossible : " + ((rm && rm.why) || "erreur") }); }
      hist.push({ t: now, e: "suite envoyée", par: me.id });
      if (redirige) hist.push({ t: now, e: "réponse adressée à " + (nomDe(dest) || dest) + " (en copie du contact), " + (f.contact_nom || "le contact") + " en copie", par: me.id });
      envoyees.push({ le: now, a: dest, cc, sujet, message_id: String(rm.message_id || ""), par: me.id });
      await db.from("wl_fiches").update({ suites: envoyees.slice(-30), suite_sujet: null, suite_corps: null, suite_consigne: null, suite_a: null, suite_cc: null, suite_prete_le: null, suite_verrou: null, historique: JSON.stringify(hist.slice(-60)), updated_at: now }).eq("fiche_id", f.fiche_id);
      return out({ ok: true, fiche_id: f.fiche_id, a: dest, cc });
    }
    return out({ ok: false, why: "action inconnue" }, 400);
  } catch (e) {
    return out({ ok: false, why: court((e as Error)?.message || e, 200) });
  }
});
