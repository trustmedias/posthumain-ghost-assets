// Writinglab — wl-db : seule porte d'accès aux tables du lab et aux fichiers (bucket privé « writinglab »).
// Appelée par n8n avec l'en-tête x-tv-secret (même secret que Posthumain TV).
// Corps JSON : { action: get|insert|insert_many|update|upsert|upload|batch|snapshot|annonce|push|cout|couts|relance_prete|alerte|equipe, table, where?, row?, rows?, limit?, order?, file?, ops? }
// Notifications (21/10/2026) : les événements importants partent en push Webpushr vers les SEULS membres de l'équipe abonnés (table wl_push),
// jamais vers les lecteurs : message d'interphone, demande client, réponse d'un chercheur, nouvelle enquête à interviewer.
// row.pieces_upload = [{ nom, type, data(base64) }] : pièces jointes d'un mail, rangées dans writinglab/mails/<AAAA-MM>/…
// Répond toujours par un TABLEAU (n8n en fait un élément par ligne), avec createdAt / updatedAt et des liens signés (1 h).
// Équipe (23/10/2026) : table wl_equipe (equipe.ts, cache 60 s) au lieu des listes codées en dur ; action « equipe » lue par le nœud
// « Équipe — lire » du workflow Writinglab (juste avant « Accès »).
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { equipe } from "./equipe.ts";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const BUCKET = "writinglab";
const CATEGORIES = ["factures", "documents", "images", "contrats", "articles", "autres"];

const TABLES: Record<string, { name: string; key: string | null; cols: string[] }> = {
  fiches: { name: "wl_fiches", key: "fiche_id", cols: ["fiche_id", "article_id", "article_titre", "redacteur", "boite", "contact_nom", "contact_email", "contact_role", "contact_institution", "langue", "statut", "questions", "mail_sujet", "mail_corps", "message_id", "conversation_id", "envoye_le", "reponse", "reponse_le", "citation", "paragraphe", "historique", "messages_vus", "pieces", "relance_sujet", "relance_corps", "relance_prete_le", "relances", "relance_envoyee_le", "rebond", "rebond_motif", "rebond_le"] },
  messages: { name: "wl_messages", key: null, cols: ["auteur", "nom", "texte", "article_id", "article_titre", "categorie"] },
  courrier: { name: "wl_courrier", key: "mail_id", cols: ["mail_id", "boite", "de_email", "de_nom", "sujet", "texte", "recu_le", "categorie", "motif", "abonne", "statut", "brouillon_sujet", "brouillon_corps", "envoye_le", "historique", "message_id", "refs", "pieces", "membre_id", "reponse_message_id"] },
  campagnes: { name: "wl_campagnes", key: "campagne_id", cols: ["campagne_id", "nom", "offres", "cible", "zone", "statut", "notes"] },
  prospects: { name: "wl_prospects", key: "prospect_id", cols: ["prospect_id", "campagne_id", "entreprise", "site", "secteur", "pays", "contact_nom", "contact_role", "email", "source_email", "pourquoi", "statut", "mail_sujet", "mail_corps", "envoye_le", "relance_le", "message_id", "historique"] },
  optout: { name: "wl_optout", key: "cle", cols: ["cle", "raison"] },
};

function json(v: unknown, status = 200) {
  return new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
function clean(t: typeof TABLES[string], row: unknown) {
  const out: Record<string, unknown> = {};
  if (!row || typeof row !== "object") return out;
  for (const c of t.cols) if (c in (row as Record<string, unknown>)) {
    const v = (row as Record<string, unknown>)[c];
    out[c] = v == null ? null : typeof v === "string" ? v : typeof v === "object" ? JSON.stringify(v) : String(v);
  }
  return out;
}
const parse = (s: unknown) => { try { const v = JSON.parse(String(s || "[]")); return Array.isArray(v) ? v : []; } catch { return []; } };
async function shape(rows: Record<string, unknown>[] | null) {
  const list = (rows || []).map((r) => ({ ...r, createdAt: r.created_at, updatedAt: r.updated_at } as Record<string, unknown>));
  const paths: string[] = [];
  for (const r of list) {
    if (r.fichier_path) paths.push(r.fichier_path as string);
    for (const p of parse(r.pieces)) if (p && p.path) paths.push(p.path);
  }
  if (paths.length) {
    const { data } = await db.storage.from(BUCKET).createSignedUrls(paths, 3600);
    const m = new Map((data || []).map((d) => [d.path, d.signedUrl]));
    for (const r of list) {
      if (r.fichier_path) r.fichier_url = m.get(r.fichier_path as string) || "";
      if (r.pieces) r.pieces = JSON.stringify(parse(r.pieces).map((p: any) => ({ ...p, url: m.get(p.path) || "" })));
    }
  }
  return list;
}
function slug(s: string) {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(-90) || "fichier";
}
async function store(dir: string, f: any) {
  const bytes = Uint8Array.from(atob(String(f?.data || "")), (c) => c.charCodeAt(0));
  if (!bytes.length || bytes.length > 10 * 1024 * 1024) return null;
  const nom = String(f.nom || "fichier").slice(0, 200), type = String(f.type || "application/octet-stream").slice(0, 120);
  const path = `${dir}/${new Date().toISOString().slice(0, 7)}/${crypto.randomUUID().slice(0, 8)}-${slug(nom)}`;
  const up = await db.storage.from(BUCKET).upload(path, bytes, { contentType: type, upsert: false });
  if (up.error) throw up.error;
  return { nom, type, taille: bytes.length, path };
}
async function piecesFrom(raw: any, existing: unknown) {
  const list = parse(existing).map((p: any) => ({ nom: p.nom, type: p.type, taille: p.taille, path: p.path }));
  for (const f of (Array.isArray(raw) ? raw : []).slice(0, 8)) { const s = await store("mails", f); if (s) list.push(s); }
  return JSON.stringify(list);
}
// Équipe (23/10/2026) : rechargée à chaque appel depuis wl_equipe (cache 60 s) — membres actifs (push), rédacteurs en chef, adresses.
let EQUIPE: string[] = ["jonathan"];
let CHEFS: string[] = ["jonathan"];
let ADRESSES_EQUIPE: string[] = ["jonathan.paiano@outlook.com"];
const SITE = "https://posthumain.com/writinglab/";
// Push Webpushr ciblé (un appel par abonné de l'équipe) ; ne bloque jamais l'écriture si Webpushr ne répond pas.
async function push(to: string[], title: string, message: string, ancre = "") {
  const key = Deno.env.get("WEBPUSHR_KEY") || "", token = Deno.env.get("WEBPUSHR_TOKEN") || "";
  const qui = [...new Set(to.filter((x) => EQUIPE.includes(x)))];
  if (!key || !token || !qui.length) return { sent: 0, why: !key || !token ? "secrets Webpushr absents" : "personne" };
  const { data } = await db.from("wl_push").select("membre,sid").in("membre", qui);
  let sent = 0;
  await Promise.all((data || []).map(async (r: any) => {
    try {
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 8000);
      const res = await fetch("https://api.webpushr.com/v1/notification/send/sid", {
        method: "POST", signal: ctl.signal,
        headers: { webpushrKey: key, webpushrAuthToken: token, "Content-Type": "application/json" },
        body: JSON.stringify({ title: title.slice(0, 100), message: (message || " ").replace(/\s+/g, " ").slice(0, 250), target_url: (SITE + (ancre ? "#" + ancre : "")).slice(0, 255), sid: String(r.sid), auto_hide: 0, expire_push: "2d" }),
      });
      clearTimeout(t); if (res.ok) sent++;
    } catch (_) { /* push perdu, l'écriture passe avant */ }
  }));
  return { sent };
}
const NOMS: Record<string, string> = { secretaire: "📮 La Secrétaire", assistant: "🧠 L’Assistant", courrier: "📬 Le Courrier", jonathan: "Jonathan", valisoa: "Valisoa" };
async function chargerEquipe() {
  const l = await equipe(db);
  EQUIPE = l.filter((m) => m.actif).map((m) => m.id);
  CHEFS = l.filter((m) => m.chef && m.actif).map((m) => m.id);
  if (!CHEFS.length) CHEFS = ["jonathan"];
  ADRESSES_EQUIPE = l.map((m) => m.email);
  for (const m of l) if (!NOMS[m.id]) NOMS[m.id] = m.nom.split(" ")[0] || m.id;
}
async function apresEcriture(table: string, action: string, row: Record<string, unknown>, data: any[] | null, nouveau = true, meta: any = null) {
  try {
    const r: any = (data && data[0]) || row;
    if (table === "messages" && (action === "insert" || action === "upload")) {
      const auteur = String(r.auteur || "");
      await push(EQUIPE.filter((x) => x !== auteur), "📞 " + (r.nom || NOMS[auteur] || "Interphone"), r.texte || (r.fichier_nom ? "📎 " + r.fichier_nom : "nouveau message"), "interphone");
    }
    if (table === "courrier" && nouveau && r.categorie === "demande") {
      // 23/10/2026 : boîte ajoutée depuis le lab (boite « x-… ») → bureau de son rôle (wl_boites.role : mk ou sc).
      let bureau = r.boite === "redaction" ? "mk" : "sc";
      if (/^x-/.test(String(r.boite || ""))) { const { data: bx } = await db.from("wl_boites").select("role").eq("id", r.boite).limit(1); if (bx && bx[0] && bx[0].role === "mk") bureau = "mk"; }
      await push(CHEFS, (bureau === "mk" ? "📣 Julien · Marketing" : "🎧 Julien · Service client") + " : nouvelle demande", (r.de_nom || r.de_email || "") + " — " + (r.sujet || ""), bureau);
    }
    if (table === "fiches" && row.statut === "inséré") await recompenser(data, meta);
    if (table === "fiches" && row.statut === "rebond") {
      // Adresse du chercheur invalide : message du Courrier dans l'Interphone (sans push général) + push ciblé au rédacteur et au chef.
      for (const f of data || []) {
        const texte = "📭 Le mail à " + (f.contact_nom || f.contact_email || "un contact") + " n’a pas été remis (" + (f.rebond_motif || "adresse refusée") + "). Vérifiez l’adresse dans sa fiche" + (f.article_titre ? " (« " + f.article_titre + " »)" : "") + ".";
        await db.from("wl_messages").insert({ auteur: "courrier", nom: NOMS.courrier, texte, article_id: f.article_id || null, article_titre: f.article_titre || null });
        await push([String(f.redacteur || ""), ...CHEFS], "📭 Mail non remis : " + (f.contact_nom || f.contact_email || ""), String(f.rebond_motif || "adresse refusée"), "suivi");
      }
    }
    if (table === "fiches" && row.statut === "a répondu") {
      for (const f of data || []) await push([String(f.redacteur || ""), ...CHEFS], "📬 Réponse de " + (f.contact_nom || "votre contact"), "Pour « " + (f.article_titre || "") + " » : la réponse est rangée dans sa fiche.", "suivi");
    }
  } catch (_) { /* jamais bloquant */ }
}
// Pièces (récompense des rédactrices) : 10 pièces par parcours COMPLET et PROUVÉ, calculé ici seulement (la page n'a aucun accès direct) :
//  1. le mail est parti de nos serveurs (Message-ID enregistré à l'envoi) ;
//  2. la réponse est arrivée par la relève IMAP, avec dans ses en-têtes (References / In-Reply-To) le Message-ID de NOTRE mail,
//     ET depuis l'adresse du contact → reponse_verifiee (une réponse saisie à la main ne compte pas) ;
//  3. la citation a été insérée dans l'article et Ghost l'a acceptée (statut « inséré » posé par n8n après Ghost).
// Contrôles anti-triche : une seule récompense par fiche ; adresse de l'équipe ou réponse très courte → « à vérifier » par le rédacteur en chef.
// Messageries gratuites (gmail, outlook…) : « à vérifier » SEULEMENT pour les fournisseurs cochés par le rédacteur en chef dans ses Paramètres
// (wl_reglages webmails_a_verifier = liste de domaines ; vide par défaut : beaucoup de gens sérieux ont une adresse gmail ou outlook).
// Le rédacteur en chef ne gagne pas de pièces, sauf s'il active le « mode récompense (test) » dans ses Paramètres (wl_reglages recompense_test_<membre> = 1).
async function modeTest(qui: string) { const { data } = await db.from("wl_reglages").select("valeur").eq("cle", "recompense_test_" + qui).limit(1); return !!(data && data[0] && data[0].valeur === "1"); }
async function webmailsAVerifier(): Promise<string[]> {
  const { data } = await db.from("wl_reglages").select("valeur").eq("cle", "webmails_a_verifier").limit(1);
  try { const v = JSON.parse(String((data && data[0] && data[0].valeur) || "[]")); return Array.isArray(v) ? v.map((x: unknown) => String(x).toLowerCase()) : []; } catch { return []; }
}
// 23/10/2026 : la preuve, ce sont les en-têtes du fil (References / In-Reply-To contenant NOTRE Message-ID, aléatoire et unique).
// L'adresse de l'expéditeur ne décide plus seule : un chercheur répond souvent depuis une autre adresse (pn@ au lieu de info@).
//  - même adresse que le contact → vérifiée ;
//  - même domaine (pn@intotheminds.com pour info@intotheminds.com) → vérifiée, preuve « autre adresse du même domaine » ;
//  - autre domaine (adresse personnelle…) → vérifiée, mais les pièces passent « à vérifier » (voir recompenser) ;
//  - aucune référence à notre mail → non vérifiée, même si l'adresse est la bonne (réponse hors du fil).
// La vraie adresse de l'expéditeur est gardée dans reponse_preuve.de ; lien = meme_adresse | meme_domaine | autre_adresse.
const domaineDe = (e: string) => String(e || "").toLowerCase().trim().split("@")[1] || "";
async function verifierReponse(data: any[] | null, preuves: any[]) {
  for (const f of data || []) {
    if (f.reponse_verifiee || !f.message_id || !f.contact_email) continue;
    const mid = String(f.message_id).trim(), email = String(f.contact_email).toLowerCase().trim();
    const fil = preuves.filter((x: any) => x && String(x.refs || "").includes(mid));
    if (!fil.length) continue;
    const de0 = (x: any) => String(x.de_email || "").toLowerCase().trim();
    const p = fil.find((x: any) => de0(x) === email) || fil.find((x: any) => domaineDe(de0(x)) && domaineDe(de0(x)) === domaineDe(email)) || fil[0];
    const de = de0(p);
    const lien = de === email ? "meme_adresse" : domaineDe(de) && domaineDe(de) === domaineDe(email) ? "meme_domaine" : "autre_adresse";
    const note = lien === "meme_domaine" ? "autre adresse du même domaine" : lien === "autre_adresse" ? "réponse dans le fil depuis une autre adresse (" + de + ")" : "";
    await db.from("wl_fiches").update({ reponse_verifiee: true, reponse_preuve: JSON.stringify({ reponse_message_id: String(p.message_id || "").slice(0, 300), de, recu_le: p.recu_le || null, en_reponse_a: mid, lien, ...(note ? { note } : {}) }) }).eq("fiche_id", f.fiche_id);
  }
}
// Expéditeur réel de la réponse vérifiée (reponse_preuve.de), et son lien avec l'adresse du contact.
function preuveDe(f: any): { de: string; lien: string } {
  let p: any = f && f.reponse_preuve; if (typeof p === "string") { try { p = JSON.parse(p); } catch { p = null; } }
  const email = String((f && f.contact_email) || "").toLowerCase().trim(), de = String((p && p.de) || email).toLowerCase().trim();
  const lien = (p && p.lien) || (de === email ? "meme_adresse" : domaineDe(de) && domaineDe(de) === domaineDe(email) ? "meme_domaine" : "autre_adresse");
  return { de, lien };
}
// Barème selon le délai après publication (date de Ghost, transmise par l'insertion n8n) :
// brouillon / programmé ou ≤ 2 jours → 10 · ≤ 4 jours → 5 · moins de 7 jours → 2 · 7 jours et plus → 0 (créneau manqué).
function bareme(meta: any) {
  const pub = meta && meta.__statut_article === "published" && meta.__publie_le ? Date.parse(String(meta.__publie_le)) : NaN;
  if (!isFinite(pub)) return { montant: 10, note: "avant publication" };
  const j = (Date.now() - pub) / 864e5, jj = Math.max(0, Math.floor(j));
  const quand = "ajoutée " + (jj ? jj + " jour" + (jj > 1 ? "s" : "") : "moins d'un jour") + " après publication";
  if (j <= 2) return { montant: 10, note: quand };
  if (j <= 4) return { montant: 5, note: quand + " (moitié)" };
  if (j < 7) return { montant: 2, note: quand + " (quart)" };
  return { montant: 0, note: quand + " : créneau de 7 jours dépassé" };
}
async function recompenser(data: any[] | null, meta: any = null) {
  for (const f of data || []) {
    const qui = String(f.redacteur || "");
    if (!qui || !f.reponse_verifiee) continue;
    if (CHEFS.includes(qui) && !(await modeTest(qui))) continue;
    const email = String(f.contact_email || "").toLowerCase(), dom = email.split("@")[1] || "";
    const pr = preuveDe(f), domDe = domaineDe(pr.de);
    const doutes: string[] = [];
    if (ADRESSES_EQUIPE.includes(email) || dom === "posthumain.com" || ADRESSES_EQUIPE.includes(pr.de) || domDe === "posthumain.com") doutes.push("adresse de l'équipe");
    else if (pr.lien === "autre_adresse") doutes.push("réponse dans le fil depuis une autre adresse (" + pr.de + ")");
    { const wm = await webmailsAVerifier(), d2 = wm.includes(dom) ? dom : wm.includes(domDe) ? domDe : ""; if (d2) doutes.push("adresse de messagerie gratuite (" + d2 + ")"); }
    if (String(f.reponse || "").replace(/\s+/g, " ").trim().length < 120) doutes.push("réponse très courte");
    const bm = bareme(meta);
    const statut = bm.montant === 0 ? "manque" : doutes.length ? "a_verifier" : "acquis";
    const motif = [bm.note].concat(doutes).join(" · ");
    const { data: ins } = await db.from("wl_pieces").upsert({ membre: qui, fiche_id: f.fiche_id, montant: bm.montant, statut, motif, article_titre: String(f.article_titre || "").slice(0, 300), contact: String(f.contact_nom || "").slice(0, 160) }, { onConflict: "fiche_id", ignoreDuplicates: true }).select();
    if (ins && ins.length) {
      if (statut === "acquis") await push([qui], "🪙 +" + bm.montant + " pièces !", "Parcours complet avec " + (f.contact_nom || "votre contact") + " : interview envoyée, réponse reçue, citation dans l'article (" + bm.note + ").", "pieces");
      if (statut === "manque") await push([qui], "⏳ Créneau manqué", "La citation de " + (f.contact_nom || "votre contact") + " a été ajoutée plus de 7 jours après publication : pas de pièces cette fois. Ce sera pour la prochaine !", "pieces");
      if (!CHEFS.includes(qui)) await push(CHEFS, statut === "acquis" ? "🪙 " + qui + " gagne " + bm.montant + " pièces" : statut === "manque" ? "⏳ " + qui + " : créneau manqué" : "🪙 Pièces à vérifier (" + qui + ")", (f.contact_nom || "") + " — " + motif, "pieces");
      else if (statut === "a_verifier") await push(CHEFS, "🪙 Pièces à vérifier (test)", (f.contact_nom || "") + " — " + motif, "pieces");
    }
  }
}

// Nouvelle enquête premium déposée par l'Usine : la Secrétaire l'annonce dans l'Interphone (une seule fois par article) → push à l'équipe.
async function annonce(b: any) {
  const id = String(b.post_id || "").trim(), titre = String(b.titre || "").slice(0, 300);
  const premium = ["paid", "tiers", "members"].includes(String(b.visibilite || "")) || b.actu_premium === true || b.actu_premium === "true";
  if (!id || !premium) return [{ ok: true, annonce: false, why: !id ? "post_id manquant" : "pas premium" }];
  const { error: dup } = await db.from("wl_annonces").insert({ post_id: id, titre });
  if (dup) return [{ ok: true, annonce: false, why: "déjà annoncée" }];
  const texte = "Nouvelle enquête à interviewer : « " + titre + " ». Lancez les interviews pour obtenir des citations avant publication.";
  const { data } = await db.from("wl_messages").insert({ auteur: "secretaire", nom: NOMS.secretaire, texte, article_id: id, article_titre: titre }).select();
  await push(EQUIPE, "📮 Nouvelle enquête à interviewer", titre, "a-interviewer");
  return [{ ok: true, annonce: true, message: (data || [])[0] || null }];
}

// Un prospect qui répond sur redaction@ : sa fiche passe « a répondu » ; s'il écrit STOP, il ne sera plus jamais contacté.
async function suiviProspect(row: Record<string, unknown>) {
  if (row.boite !== "redaction" || !row.de_email) return;
  const email = String(row.de_email).toLowerCase();
  const stop = /^\s*(stop|unsubscribe|d[ée]sinscri|ne (plus|pas) me contacter)/i.test(String(row.texte || "")) || /^\s*(re:\s*)?stop\b/i.test(String(row.sujet || ""));
  const { data } = await db.from("wl_prospects").select("prospect_id,statut,historique").ilike("email", email);
  for (const p of data || []) {
    if (!["contacte", "relance", "repondu"].includes(String(p.statut)) && !stop) continue;
    const h = parse(p.historique); h.push({ t: new Date().toISOString(), e: stop ? "a demandé à ne plus être contacté" : "a répondu", par: "courrier" });
    await db.from("wl_prospects").update({ statut: stop ? "refus" : "repondu", historique: JSON.stringify(h.slice(-40)) }).eq("prospect_id", p.prospect_id);
  }
  if (stop) await db.from("wl_optout").upsert({ cle: email, raison: "STOP reçu" }, { onConflict: "cle" });
}

// ---------- Coût IA (22/10/2026) ----------
// Tarifs Anthropic en USD par million de jetons (platform.claude.com/docs/en/about-claude/pricing, relevés le 22/10/2026).
const TARIFS: Record<string, [number, number]> = {
  "claude-fable-5-1": [10, 50], "claude-opus-5-5": [4, 20], "claude-sonnet-5-5": [2, 10], "claude-haiku-5-5": [0.1, 0.5],
  "claude-opus-4-8": [5, 25], "claude-sonnet-4-6": [3, 15], "claude-haiku-4-5": [1, 5],
};
const USD_EUR = 0.92; // conversion approximative, suffisante pour un ordre de grandeur mensuel
const RECHERCHE_WEB_USD = 0.01; // 10 $ les 1000 recherches web
const USAGES = ["preparation", "dictee", "citations", "prospection", "autre"];
function coutEur(modele: string, u: any) {
  const k = Object.keys(TARIFS).find((x) => String(modele || "").startsWith(x)) || "claude-sonnet-5-5";
  const [pi, po] = TARIFS[k];
  const tin = Number(u?.input_tokens || 0) + 1.25 * Number(u?.cache_creation_input_tokens || 0) + 0.1 * Number(u?.cache_read_input_tokens || 0);
  const tout = Number(u?.output_tokens || 0);
  const web = Number(u?.server_tool_use?.web_search_requests || 0);
  return { tin: Math.round(tin), tout, eur: ((tin * pi + tout * po) / 1e6 + web * RECHERCHE_WEB_USD) * USD_EUR };
}
async function noterCout(b: any) {
  const u = b.usage_api || {};
  if (!u || (!u.input_tokens && !u.output_tokens)) return { ok: true, note: false };
  const c = coutEur(String(b.modele || ""), u);
  const usage = USAGES.includes(String(b.usage)) ? String(b.usage) : "autre";
  await db.from("wl_couts").insert({ membre: String(b.membre || "").slice(0, 40) || null, usage, modele: String(b.modele || "").slice(0, 60), tokens_in: c.tin, tokens_out: c.tout, cout_eur: Math.round(c.eur * 1e5) / 1e5 });
  return { ok: true, note: true, cout_eur: c.eur };
}
async function couts() {
  const z = new Intl.DateTimeFormat("fr-CA", { timeZone: "Europe/Zurich", year: "numeric", month: "2-digit" }).format(new Date());
  const [a, m] = z.split("-").map(Number);
  const debut = new Date(Date.UTC(m <= 5 ? a - 1 : a, (m - 6 + 12) % 12, 1)).toISOString();
  const { data } = await db.from("wl_couts").select("created_at,usage,cout_eur").gte("created_at", debut).limit(20000);
  const moisDe = (d: string) => new Intl.DateTimeFormat("fr-CA", { timeZone: "Europe/Zurich", year: "numeric", month: "2-digit" }).format(new Date(d));
  const par_usage: Record<string, number> = { preparation: 0, dictee: 0, citations: 0, prospection: 0, autre: 0 };
  const pm: Record<string, number> = {};
  for (let i = 5; i >= 0; i--) { const d = new Date(Date.UTC(a, m - 1 - i, 1)); pm[d.toISOString().slice(0, 7)] = 0; }
  let total = 0;
  for (const r of data || []) {
    const mo = moisDe(r.created_at), v = Number(r.cout_eur || 0);
    if (mo in pm) pm[mo] += v;
    if (mo === z) { total += v; par_usage[USAGES.includes(r.usage) ? r.usage : "autre"] += v; }
  }
  const r2 = (n: number) => Math.round(n * 100) / 100;
  for (const k of Object.keys(par_usage)) par_usage[k] = r2(par_usage[k]);
  return { ok: true, mois: z, total_eur: r2(total), par_usage, par_mois: Object.entries(pm).map(([mois, v]) => ({ mois, total_eur: r2(v) })) };
}
// ---------- Relance prête (22/10/2026) ----------
// Posée par la tournée quotidienne des relances (n8n) : brouillon stocké dans la fiche SI elle est toujours « envoyé » sans brouillon,
// message de la Secrétaire dans l'Interphone (sans push général) et push ciblé au rédacteur de la fiche.
async function relancePrete(b: any) {
  const id = String(b.fiche_id || ""), sujet = String(b.sujet || "").trim().slice(0, 300), corps = String(b.corps || "").trim().slice(0, 8000);
  if (!id || !sujet || !corps) return { ok: false, why: "relance incomplète" };
  if (b.usage_api) await noterCout({ usage: "autre", modele: b.modele, usage_api: b.usage_api, membre: "secretaire" });
  const { data: f0 } = await db.from("wl_fiches").select("*").eq("fiche_id", id).limit(1);
  const f: any = f0 && f0[0];
  if (!f || f.statut !== "envoyé" || f.reponse || String(f.relance_corps || "").trim()) return { ok: true, pose: false, why: "fiche plus concernée" };
  const h = parse(f.historique); h.push({ t: new Date().toISOString(), e: "relance proposée", par: "secretaire" });
  const { data } = await db.from("wl_fiches").update({ relance_sujet: sujet, relance_corps: corps, relance_prete_le: new Date().toISOString(), historique: JSON.stringify(h.slice(-60)) })
    .eq("fiche_id", id).eq("statut", "envoyé").select();
  if (!data || !data.length) return { ok: true, pose: false, why: "fiche modifiée entre-temps" };
  const jours = f.envoye_le ? Math.max(1, Math.floor((Date.now() - Date.parse(f.envoye_le)) / 864e5)) : 0;
  const texte = "⏰ Relance prête pour " + (f.contact_nom || f.contact_email || "un contact") + (f.article_titre ? " (article « " + f.article_titre + " »)" : "") + " : pas de réponse depuis " + jours + " jours. Relisez-la dans sa fiche puis envoyez-la, ou ignorez-la.";
  await db.from("wl_messages").insert({ auteur: "secretaire", nom: NOMS.secretaire, texte, article_id: f.article_id || null, article_titre: f.article_titre || null });
  await push([String(f.redacteur || "")], "⏰ Relance prête : " + (f.contact_nom || ""), (f.article_titre || "") + " — pas de réponse depuis " + jours + " jours", "suivi");
  return { ok: true, pose: true, fiche_id: id };
}
// ---------- Alertes de panne (22/10/2026) ----------
// Une alerte par clé (workflow + nœud) et par heure au plus : message « 🚨 » dans l'Interphone + push au rédacteur en chef.
async function alerte(b: any) {
  const cle = String(b.cle || "inconnu").slice(0, 200), texte = String(b.texte || "Quelque chose a échoué dans le Writinglab.").slice(0, 900);
  const { data: cur } = await db.from("wl_alertes").select("*").eq("cle", cle).limit(1);
  const c: any = cur && cur[0];
  if (c && Date.now() - Date.parse(c.derniere) < 3600e3) {
    await db.from("wl_alertes").update({ nombre: Number(c.nombre || 1) + 1 }).eq("cle", cle);
    return { ok: true, alerte: false, why: "déjà signalée il y a moins d'une heure" };
  }
  await db.from("wl_alertes").upsert({ cle, derniere: new Date().toISOString(), nombre: 1, detail: texte.slice(0, 500) }, { onConflict: "cle" });
  await db.from("wl_messages").insert({ auteur: "alerte", nom: "🚨 Alerte technique", texte: "🚨 " + texte });
  await push(CHEFS, "🚨 Writinglab : " + String(b.titre || "panne").slice(0, 80), texte, "interphone");
  return { ok: true, alerte: true };
}

async function run(b: any): Promise<Record<string, unknown>[]> {
  // Équipe pour le nœud « Accès » de n8n : tous les membres (actifs, inactifs, de test), un seul élément.
  // 23/10/2026 : + boîtes ajoutées depuis le lab (sans aucun secret) pour « Accès » → page et réponses de Julien.
  if (b.action === "equipe") {
    const { data: bx } = await db.from("wl_boites").select("id,adresse,role,nom_affiche,actif,statut,fournisseur").order("created_at");
    return [{ ok: true, membres: await equipe(db, true), boites: bx || [] }];
  }
  if (b.action === "cout") return [await noterCout(b)];
  if (b.action === "couts") return [await couts()];
  if (b.action === "relance_prete") return [await relancePrete(b)];
  if (b.action === "alerte") return [await alerte(b)];
  if (b.action === "snapshot") {
    const [c, p, o] = await Promise.all([
      db.from("wl_campagnes").select("*").order("created_at", { ascending: false }).limit(100),
      db.from("wl_prospects").select("*").order("created_at", { ascending: false }).limit(800),
      db.from("wl_optout").select("cle").limit(5000),
    ]);
    return [{ campagnes: await shape(c.data), prospects: await shape(p.data), optout: (o.data || []).map((x: any) => x.cle) }];
  }
  if (b.action === "annonce") return await annonce(b);
  if (b.action === "push") return [await push(Array.isArray(b.to) ? b.to.map(String) : EQUIPE, String(b.title || "Writinglab"), String(b.message || ""), String(b.ancre || ""))];
  if (b.action === "batch") {
    const out: unknown[] = [];
    for (const op of (Array.isArray(b.ops) ? b.ops : []).slice(0, 60)) out.push(await run(op));
    return [{ ok: true, results: out }];
  }
  const t = TABLES[b?.table];
  if (!t) throw new Error("table");
  const where: Record<string, string> = {};
  if (b.where && typeof b.where === "object") for (const [k, v] of Object.entries(b.where)) if (t.cols.includes(k) && v != null && v !== "") where[k] = String(v);
  if (b.action === "get") {
    let q = db.from(t.name).select("*");
    for (const [k, v] of Object.entries(where)) q = q.eq(k, v);
    q = q.order("created_at", { ascending: b.order !== "desc" }).limit(Math.min(Math.max(Number(b.limit) || 500, 1), 1000));
    const { data, error } = await q; if (error) throw error;
    return await shape(data);
  }
  if (b.action === "insert_many") {
    const rows = (Array.isArray(b.rows) ? b.rows : []).slice(0, 100).map((r: unknown) => clean(t, r));
    if (!rows.length) return [];
    const q = t.key ? db.from(t.name).upsert(rows, { onConflict: t.key, ignoreDuplicates: true }) : db.from(t.name).insert(rows);
    const { data, error } = await q.select(); if (error) throw error;
    return await shape(data);
  }
  const row = clean(t, b.row);
  const pj = b.row && Array.isArray(b.row.pieces_upload) && b.row.pieces_upload.length ? b.row.pieces_upload : null;
  if (row.pieces) delete row.pieces; // les pièces ne s'écrivent que par pieces_upload
  if (b.action === "insert" || b.action === "upload") {
    if (b.action === "upload") {
      if (b.table !== "messages") throw new Error("upload_messages_seulement");
      const cat = CATEGORIES.includes(String(row.categorie)) ? String(row.categorie) : "autres";
      const s = await store(cat, b.file || {});
      if (!s) throw new Error("fichier_vide_ou_trop_gros");
      Object.assign(row, { categorie: cat, fichier_path: s.path, fichier_nom: s.nom, fichier_type: s.type, fichier_taille: s.taille });
    }
    if (pj) row.pieces = await piecesFrom(pj, null);
    const { data, error } = await db.from(t.name).insert(row).select(); if (error) throw error;
    await apresEcriture(b.table, b.action, row, data);
    return await shape(data);
  }
  if (b.action === "update") {
    if (!Object.keys(where).length) throw new Error("where_requis");
    if (t.key) delete row[t.key];
    if (pj) {
      let q0 = db.from(t.name).select("pieces");
      for (const [k, v] of Object.entries(where)) q0 = q0.eq(k, v);
      const { data: cur } = await q0.limit(1);
      row.pieces = await piecesFrom(pj, cur && cur[0] ? (cur[0] as any).pieces : null);
    }
    if (!Object.keys(row).length) return [];
    let q = db.from(t.name).update(row);
    for (const [k, v] of Object.entries(where)) q = q.eq(k, v);
    let { data, error } = await q.select(); if (error) throw error;
    if (b.table === "fiches" && Array.isArray(b.preuves) && b.preuves.length) {
      await verifierReponse(data, b.preuves.slice(0, 20));
      const ids = (data || []).map((f: any) => f.fiche_id);
      if (ids.length) { const again = await db.from("wl_fiches").select("*").in("fiche_id", ids); if (again.data) data = again.data; }
    }
    await apresEcriture(b.table, "update", row, data, true, b.row || null);
    return await shape(data);
  }
  if (b.action === "upsert") {
    if (!t.key || !row[t.key]) throw new Error("cle_requise");
    const { data: cur } = await db.from(t.name).select(t.key === "mail_id" ? "pieces,mail_id" : t.key).eq(t.key, row[t.key] as string).limit(1);
    const nouveau = !(cur && cur.length);
    if (pj) row.pieces = await piecesFrom(pj, cur && cur[0] ? (cur[0] as any).pieces : null);
    const { data, error } = await db.from(t.name).upsert(row, { onConflict: t.key }).select(); if (error) throw error;
    if (b.table === "courrier" && nouveau) { try { await suiviProspect(row); } catch (_) { /* le courrier passe avant */ } }
    await apresEcriture(b.table, "upsert", row, data, nouveau);
    return await shape(data);
  }
  throw new Error("action");
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "method" }, 405);
  const secret = Deno.env.get("TV_ADMIN_SECRET") || "";
  if (!secret || !safeEqual(req.headers.get("x-tv-secret") || "", secret)) return json({ error: "unauthorized" }, 401);
  let b: any; try { b = await req.json(); } catch { return json({ error: "bad_json" }, 400); }
  try { await chargerEquipe(); } catch (_) { /* listes de repli */ }
  try { return json(await run(b)); }
  catch (e) { return json({ error: "db", detail: String((e as Error)?.message || e).slice(0, 300) }, 500); }
});
