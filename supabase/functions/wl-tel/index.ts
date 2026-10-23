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
// Rôles : une journaliste n'a que Secrétaire, Assistant, Comptable, et seulement ses fiches ; Julien (mk, sc) = rédacteur en chef.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { parEmail, type Membre } from "./equipe.ts";
import { CATALOGUE } from "./catalogue.ts";

const env = (k: string) => (Deno.env.get(k) || "").trim();
const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const SITE = "https://posthumain.com";
const ORIGINES = ["https://posthumain.com", "https://www.posthumain.com"];
const MODELE = "claude-sonnet-5-5";
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
type Poste = { id: string; nom: string; chefSeul: boolean; role: string; actions: string[]; contexte: string[]; mail: { boite: string; role: string } | null };
// deno-lint-ignore no-explicit-any
const POSTES: Record<string, Poste> = Object.fromEntries((CATALOGUE.postes || []).map((p: any) => [p.id, { id: p.id, nom: p.emoji + " " + p.nom, chefSeul: p.acces === "chef", role: p.role, actions: p.capacites || [], contexte: p.contexte || [], mail: p.mail || null }]));
// deno-lint-ignore no-explicit-any
const CAPS: Record<string, Cap> = Object.fromEntries((CATALOGUE.capacites || []).map((c: any) => [c.id, c]));
const ACTIONS_DOC: Record<string, string> = Object.fromEntries(Object.values(CAPS).map((c) => [c.id, c.id + " — " + c.description]));

// ---------- Contexte (lu en base, filtré selon le rôle) ----------
// deno-lint-ignore no-explicit-any
const pj = (v: any) => { if (v == null) return null; if (typeof v !== "string") return v; try { return JSON.parse(v); } catch { return null; } };
const court = (s: unknown, n: number) => { const t = String(s || "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };
// deno-lint-ignore no-explicit-any
async function fichesVisibles(me: Membre, articleId: string, texte: string): Promise<any[]> {
  let q = db.from("wl_fiches").select("fiche_id,article_id,article_titre,redacteur,contact_nom,contact_email,contact_role,contact_institution,langue,statut,questions,reponse,reponse_le,envoye_le,updated_at").neq("statut", "archivé").order("updated_at", { ascending: false }).limit(120);
  if (!me.chef) q = q.eq("redacteur", me.id);
  const { data } = await q;
  const l = data || [], t = texte.toLowerCase();
  const score = (f: { article_id: string; contact_nom: string }) => (articleId && f.article_id === articleId ? 2 : 0) + (String(f.contact_nom || "").toLowerCase().split(/\s+/).some((w) => w.length > 3 && t.includes(w)) ? 3 : 0);
  return l.map((f, i) => ({ f, s: score(f), i })).sort((a, b) => b.s - a.s || a.i - b.i).slice(0, 25).map((x) => x.f);
}
// deno-lint-ignore no-explicit-any
function ficheCtx(f: any) {
  const qs = pj(f.questions);
  return { fiche_id: f.fiche_id, contact: [f.contact_nom, f.contact_role, f.contact_institution].filter(Boolean).join(", "), email: f.contact_email || "", langue: f.langue || "fr",
    statut: f.statut, article_id: f.article_id, article: court(f.article_titre, 90), redacteur: f.redacteur, questions: Array.isArray(qs) ? qs.slice(0, 8).map((x: unknown) => court(x, 220)) : [],
    reponse: f.reponse ? court(f.reponse, 400) : "" };
}
async function courrierBureau(mail: { boite: string; role: string }) {
  const { data: bx } = await db.from("wl_boites").select("id,role").eq("role", mail.role);
  const boites = [mail.boite].concat((bx || []).map((b) => String(b.id)));
  const { data } = await db.from("wl_courrier").select("mail_id,boite,de_nom,de_email,sujet,texte,categorie,statut,abonne,brouillon_corps,recu_le").in("boite", boites).not("statut", "in", "(répondu,archivé)").order("recu_le", { ascending: false }).limit(15);
  return (data || []).map((m) => ({ mail_id: m.mail_id, de: (m.de_nom || "") + " <" + m.de_email + ">", sujet: court(m.sujet, 140), categorie: m.categorie, abonne: m.abonne, brouillon: !!m.brouillon_corps, recu_le: m.recu_le, extrait: court(m.texte, 350) }));
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
// deno-lint-ignore no-explicit-any
async function filDe(me: Membre, poste: string, n = 12): Promise<any[]> {
  const { data } = await db.from("wl_tel").select("id,de,transmis_par,mode,texte,action,created_at").eq("membre", me.id).eq("poste", poste).order("created_at", { ascending: false }).limit(n);
  return (data || []).reverse();
}

// ---------- Claude ----------
const TARIF = [2, 10]; // USD / million de jetons (Sonnet 5.5), conversion EUR approximative
// deno-lint-ignore no-explicit-any
async function claude(system: string, messages: any[], tool: any, maxTokens = 2500, usage = "telephone", qui = ""): Promise<any> {
  const key = env("ANTHROPIC_API_KEY"); if (!key) throw new Error("clé Anthropic absente");
  const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", signal: AbortSignal.timeout(55000),
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    // tool_choice « tool » / « any » refusé par ce modèle : « auto » + consigne ferme dans le système, et repli sur le texte.
    body: JSON.stringify({ model: MODELE, max_tokens: maxTokens, system: system + "\n\nIMPORTANT : réponds UNIQUEMENT en appelant l'outil « " + tool.name + " », sans texte autour.", messages, tools: [tool], tool_choice: { type: "auto" } }) });
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
    peutTransmettre ? "SI CE N'EST PAS DE TON RESSORT : mode « transmettre », vers l'un de ces postes : " + autres.map((x) => x.id + " (" + x.nom + " : " + x.role.split(".")[0] + ")").join(" ; ") + ". La requête lui sera transmise automatiquement, une seule fois." : "La requête t'a été TRANSMISE par un autre poste : traite-la (mode « faire » ou « question »), tu ne peux pas la transmettre à nouveau. Si vraiment elle n'est pas faisable, dis-le simplement dans le message.",
    "RÈGLES :\n- Jamais d'envoi ni de publication : tu produis seulement des propositions que le membre valide (brouillon, réponse à enregistrer, citations proposées).\n- Utilise uniquement les identifiants (article_id, fiche_id, mail_id) présents dans le contexte. Si la fiche ou le mail visé est ambigu ou absent, pose une question (mode « question ») en citant les possibilités.\n- N'invente aucun fait, aucune citation, aucune adresse : seulement ce qui est dans la requête ou le contexte.\n- Si la demande relève d'une action d'un AUTRE poste (structurer une réponse d'interview ou des notes d'appel = l'Assistant ; rédiger un mail d'interview = la Secrétaire ; répondre à un mail reçu = Julien), transmets-la au lieu de répondre que tu ne peux pas.\n- Pour reponse_fiche : une réponse par question de la fiche quand le membre en a rapporté le contenu ; laisse de côté les questions sans réponse et dis-le ; les propos qui ne répondent à aucune question vont dans une entrée dont la question est « Complément ».\n- Une simple information (un solde, un état) : mode « faire » sans action, la réponse est dans le message.\n- Réponds avec l'outil « repondre ».",
  ].join("\n\n");
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
  if (p.contexte.includes("fiches") || b.fiche_id) ctx.fiches = (await fichesVisibles(me, articleId, String(b.texte || ""))).map(ficheCtx);
  if (b.fiche_id && ctx.fiches && !ctx.fiches.some((f: { fiche_id: string }) => f.fiche_id === b.fiche_id)) {
    let q = db.from("wl_fiches").select("*").eq("fiche_id", String(b.fiche_id)).limit(1); if (!me.chef) q = q.eq("redacteur", me.id);
    const { data } = await q; if (data && data[0]) ctx.fiches.unshift(ficheCtx(data[0]));
  }
  if (b.fiche_id) ctx.fiche_ouverte = String(b.fiche_id);
  if (p.contexte.includes("courrier") && p.mail) ctx.courrier = await courrierBureau(p.mail);
  if (p.contexte.includes("pieces")) ctx.pieces = await piecesCtx(me);
  return ctx;
}
// deno-lint-ignore no-explicit-any
async function repondrePoste(me: Membre, p: Poste, b: any, transmisPar: Poste | null, note: string): Promise<any> {
  const autres = Object.values(POSTES).filter((x) => x.id !== p.id && (me.chef || !x.chefSeul));
  const peut = !transmisPar;
  const ctx = await contexte(me, p, b);
  const fil = transmisPar ? [] : await filDe(me, p.id);
  const hist = fil.map((m) => (m.de === "moi" ? me.nom.split(" ")[0] : m.de) + " : " + court(m.texte, 500) + (m.action ? " [action " + (m.action.type || "") + (m.action.fait ? " exécutée" : " proposée") + "]" : "")).join("\n");
  const user = (hist ? "ÉCHANGES PRÉCÉDENTS (les plus récents en bas) :\n" + hist + "\n\n" : "") + "CONTEXTE DU LAB (JSON) :\n" + JSON.stringify(ctx) + "\n\n" +
    (transmisPar ? "REQUÊTE TRANSMISE PAR " + transmisPar.nom + (note ? " (note : " + note + ")" : "") + " :\n" : "REQUÊTE DE " + me.nom.toUpperCase() + " :\n") + String(b.texte || "").slice(0, 8000);
  const out = await claude(systemePoste(p, me, peut, autres), [{ role: "user", content: user }], OUTIL_TEL(autres.map((x) => x.id), p.actions, peut), 8000, "telephone", me.id);
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
        const r = await claude(sys, [{ role: "user", content: user }], outil, 8000, "telephone", me.id);
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
    return out({ ok: false, why: "action inconnue" }, 400);
  } catch (e) {
    return out({ ok: false, why: court((e as Error)?.message || e, 200) });
  }
});
