// Writinglab — wl-radar : la Salle du Radar et le Marbre du lab (22/10/2026), sans exécution n8n.
// Remplace l'usage quotidien des commandes Telegram de l'Usine (/radar, /ecrire, /enquete, /file, /inverser, lien Approuver)
// par des actions authentifiées : jeton d'identité du membre Ghost (signé, vérifié avec les clés publiques du site) + liste de l'équipe.
// Le rédacteur en chef agit ; les autres membres de l'équipe lisent seulement.
//
// Les écritures Airtable reproduisent EXACTEMENT celles du nœud « Parse commande enquete » de l'Usine (uwlkhayj6nCR3AxL)
// et du nœud « Marque approuve (Airtable) » :
//   - /ecrire N [type]      → PATCH { Choisir:true [, Type, ActuPremium] } (typecast)
//   - /ecrire sujet|url|type → POST { Title, Type, Status:'new', Score:100, Choisir:true, CreatedAt [, Angle, URL, ActuPremium] }
//   - /enquete sujet|url     → POST { Title, Type:'premium', Status:'new', Score:100, Choisir:true, CreatedAt [, Angle, URL] }
//   - /file, /inverser       → file = Choisir=1 ET Status='new', triée Priorite desc, Score desc, CreatedAt desc ; ordre = champ Priorite
//   - Approuver              → PATCH { Status:'approved' } (publié au batch de 18 h 30)
//   - sujet écarté           → { Status:'skipped', Choisir:false } (comme « Gere echec redaction » et « Archiver anciens candidats »)
//   - brouillon écarté (Marbre) → { Status:'skipped', Choisir:false, Rationale += « [écarté depuis le Marbre le JJ/MM] » }
// « Relancer le Radar » est la seule action qui coûte une exécution n8n : on poste au webhook Telegram de l'Usine
// (posthumain-enquete) la même mise à jour qu'un « /radar » tapé par Jonathan dans son chat ; l'Usine n'est pas modifiée.
// Rapport du brouillon (22/10/2026) : l'Usine envoie, juste après « Prepare notif brouillon », le rapport détaillé qu'elle
// ne mettait jusque-là que dans le message Telegram (alertes de rédaction, contrôle des sources, photos, encart vidéo,
// graphiques non placés, mise en forme, couverture) → table usine_rapports (action « rapport », en-tête x-tv-secret),
// affiché sous chaque brouillon du Marbre.
// 23/10/2026 (Telegram → lab) : l'Usine envoie aussi en miroir ses messages Telegram (action « evenement », en-tête x-tv-secret)
// → table usine_evenements : brouillon prêt et échecs (push), alertes (onglet ⚠️ Alertes du Radar, chef seul), journal du soir
// (Marbre), résumé du Radar. « Lancer l'Usine maintenant » (= /usine) passe par le même webhook Telegram que « Relancer le Radar ».
// Tag interne Ghost « #fini » (slug hash-fini) : la journaliste signale qu'un brouillon est prêt à relire (« fini » / « reprendre »).
// Secrets Supabase : jeton Airtable (AIRTABLE_TOKEN, ou AIRTABLE_API_KEY / AIRTABLE_PAT / POSTHUMAIN_AIRTABLE_TOKEN),
// clé Admin Ghost GHOST_ADMIN_API_KEY (format id:secret) et, facultatif, GHOST_ADMIN_API_URL.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { equipe, parEmail, type Membre } from "./equipe.ts";

const env = (k: string) => (Deno.env.get(k) || "").trim();
const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const SITE = "https://posthumain.com";
const ORIGINES = ["https://posthumain.com", "https://www.posthumain.com"];
// Équipe (23/10/2026) : table wl_equipe via equipe.ts (cache 60 s) ; le rédacteur en chef = rôle « chef ».
const AIRTABLE_BASE = "appPc2y4ts9tVZCjQ"; // base « Radar » de l'Usine (identifiant non secret)
const USINE_TELEGRAM_WEBHOOK = "https://trustmedias.app.n8n.cloud/webhook/posthumain-enquete";
const JONATHAN_CHAT = 8382186188; // chat Telegram autorisé par l'Usine (non secret : seul filtre du webhook)
const VOTE_PREFIX = "https://posthumain.com/vote";

const airKey = () => env("AIRTABLE_TOKEN") || env("AIRTABLE_API_KEY") || env("AIRTABLE_PAT") || env("POSTHUMAIN_AIRTABLE_TOKEN");
const airBase = () => env("AIRTABLE_BASE") || AIRTABLE_BASE;
const ghostUrl = () => (env("GHOST_ADMIN_API_URL") || "https://the-last-journal.ghost.io").replace(/\/+$/g, "");

function cors(req: Request) {
  const o = req.headers.get("origin") || "";
  return { "Access-Control-Allow-Origin": ORIGINES.includes(o) ? o : ORIGINES[0], "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "content-type", "Vary": "Origin" };
}
const b64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), (c) => c.charCodeAt(0));
const b64uEnc = (b: Uint8Array | string) => btoa(typeof b === "string" ? b : String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
let jwksCache: { at: number; keys: any[] } | null = null;
async function membre(token: string): Promise<Membre | null> {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return null;
  let header: any, payload: any;
  try { header = JSON.parse(new TextDecoder().decode(b64u(parts[0]))); payload = JSON.parse(new TextDecoder().decode(b64u(parts[1]))); } catch { return null; }
  const hashes: Record<string, string> = { RS256: "SHA-256", RS384: "SHA-384", RS512: "SHA-512" };
  if (!hashes[header.alg]) return null;
  if (!jwksCache || Date.now() - jwksCache.at > 3600e3) { const r = await fetch(SITE + "/members/.well-known/jwks.json"); if (!r.ok) return null; jwksCache = { at: Date.now(), keys: (await r.json()).keys || [] }; }
  const jwk = jwksCache.keys.find((k: any) => !header.kid || k.kid === header.kid);
  if (!jwk) return null;
  const key = await crypto.subtle.importKey("jwk", { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: header.alg, ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: hashes[header.alg] }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64u(parts[2]), new TextEncoder().encode(parts[0] + "." + parts[1]));
  if (!ok || !payload.exp || payload.exp * 1000 < Date.now()) return null;
  if (payload.iss && !/^https:\/\/(posthumain\.com|the-last-journal\.ghost\.io)\//.test(String(payload.iss))) return null;
  return await parEmail(db, String(payload.sub || ""));
}

// ---------- Airtable ----------
async function air(path: string, init: RequestInit = {}) {
  const key = airKey();
  if (!key) throw new Error("jeton Airtable absent des secrets Supabase (AIRTABLE_TOKEN)");
  const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 15000);
  try {
    const r = await fetch(`https://api.airtable.com/v0/${airBase()}/${path}`, { ...init, signal: ctl.signal, headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...(init.headers || {}) } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error("Airtable " + r.status + " " + String(j?.error?.message || j?.error?.type || j?.error || "").slice(0, 160));
    return j;
  } finally { clearTimeout(to); }
}
const q = (formula: string, extra = "") => `?filterByFormula=${encodeURIComponent(formula)}${extra}`;
const SORT_SCORE = "&sort%5B0%5D%5Bfield%5D=Score&sort%5B0%5D%5Bdirection%5D=desc";
const SORT_CREE = "&sort%5B0%5D%5Bfield%5D=CreatedAt&sort%5B0%5D%5Bdirection%5D=desc";
function sujet(r: any) {
  const f = r.fields || {};
  return { id: r.id, titre: f.Title || "", url: f.URL || "", type: f.Type || "actu", actu_premium: !!f.ActuPremium, format: f.Format || "", score: Number(f.Score) || 0,
    angle: f.Angle || "", rationale: String(f.Rationale || "").slice(0, 600), source: f.Source || "", choisir: !!f.Choisir, priorite: Number(f.Priorite) || 0,
    statut: f.Status || "", cree: f.CreatedAt || null, ghost_id: f.GhostPostId || "", couverture_ref: f.CoverReference || "", newsletter: f.PlannedNewsletter || "",
    vote: String(f.URL || "").startsWith(VOTE_PREFIX), manuel: /\[MANUEL/.test(String(f.Rationale || "")) };
}
async function file() {
  const r = await air("Radar" + q("AND({Choisir}=1,{Status}='new')", "&maxRecords=20"));
  const recs = (r.records || []).map(sujet);
  recs.sort((a: any, b: any) => (b.priorite - a.priorite) || (b.score - a.score) || ((Date.parse(b.cree) || 0) - (Date.parse(a.cree) || 0)));
  return recs;
}
async function lireUn(id: string) {
  if (!/^rec[A-Za-z0-9]{10,20}$/.test(id)) throw new Error("identifiant de sujet invalide");
  return sujet(await air("Radar/" + id));
}
async function patch(id: string, fields: Record<string, unknown>) {
  return sujet(await air("Radar/" + id, { method: "PATCH", body: JSON.stringify({ fields, typecast: true }) }));
}

// ---------- Ghost Admin ----------
async function ghostToken() {
  const [id, secret] = env("GHOST_ADMIN_API_KEY").split(":");
  if (!id || !secret) throw new Error("clé Admin Ghost absente des secrets Supabase (GHOST_ADMIN_API_KEY)");
  const now = Math.floor(Date.now() / 1000);
  const head = b64uEnc(JSON.stringify({ alg: "HS256", typ: "JWT", kid: id }));
  const body = b64uEnc(JSON.stringify({ iat: now, exp: now + 300, aud: "/admin/" }));
  const k = await crypto.subtle.importKey("raw", Uint8Array.from(secret.match(/.{2}/g)!.map((h) => parseInt(h, 16))), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(head + "." + body)));
  return head + "." + body + "." + b64uEnc(sig);
}
async function ghost(path: string) {
  const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 15000);
  try {
    const r = await fetch(ghostUrl() + "/ghost/api/admin/" + path, { signal: ctl.signal, headers: { Authorization: "Ghost " + (await ghostToken()), "Accept-Version": "v5.0" } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error("Ghost " + r.status + " " + String(j?.errors?.[0]?.message || "").slice(0, 160));
    return j;
  } finally { clearTimeout(to); }
}
const CHAMPS_POST = "id,uuid,title,slug,feature_image,status,visibility,updated_at,published_at,custom_excerpt,url,reading_time,email_only";
const minuitZurich = () => {
  const now = new Date();
  const d = new Intl.DateTimeFormat("fr-CA", { timeZone: "Europe/Zurich", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const off = (new Date(now.toLocaleString("en-US", { timeZone: "Europe/Zurich" })).getTime() - new Date(now.toLocaleString("en-US", { timeZone: "UTC" })).getTime()) / 60000;
  return new Date(Date.parse(d + "T00:00:00Z") - off * 60000).toISOString().slice(0, 19).replace("T", " ");
};
// Auteurs Ghost → journaliste de l'équipe (non chef, active). Les e-mails ne quittent jamais le serveur : la page reçoit « chez ».
async function sansEmails(l: any[]) {
  const eq = await equipe(db).catch(() => [] as Membre[]);
  for (const x of l) {
    if (!x || !Array.isArray(x.auteurs)) continue;
    const j = eq.filter((m) => !m.chef && m.actif && x.auteurs.includes(m.email)).map((m) => m.nom);
    x.chez = j[0] || ""; delete x.auteurs;
  }
  return l;
}
function post(p: any) {
  return { id: p.id, titre: p.title, statut: p.status, visibilite: p.visibility, image: p.feature_image || "", maj: p.updated_at, publie_le: p.published_at,
    extrait: p.custom_excerpt || "", lecture: p.reading_time || 0, url: p.url, apercu: p.uuid ? SITE + "/p/" + p.uuid + "/" : "", editeur: ghostUrl() + "/ghost/#/editor/post/" + p.id,
    // 23/10/2026 : tag interne « #fini » (prêt à relire) et e-mails des auteurs Ghost (une journaliste auteure sans #fini = « en cours chez elle »)
    fini: Array.isArray(p.tags) ? p.tags.some(estFini) : undefined, auteurs: Array.isArray(p.authors) ? p.authors.map((u: any) => String(u.email || "").toLowerCase()).filter(Boolean) : undefined };
}

function egal(a: string, b: string) { if (!a || a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; }
const txt = (v: unknown, max: number) => String(v ?? "").slice(0, max);
const liste = (v: unknown, n: number, max: number) => (Array.isArray(v) ? v : v ? [v] : []).map((x) => txt(x, max)).filter((x) => x.trim()).slice(0, n);
// Rapport envoyé par l'Usine (n8n, en-tête x-tv-secret) : on ne garde que des champs connus, de taille bornée.
async function enregistrerRapport(b: any) {
  const id = txt(b.post_id, 40).trim();
  if (!/^[a-f0-9]{24}$/.test(id)) return { ok: false, why: "post_id invalide" };
  const r = b.rapport || {};
  const rapport = {
    type: txt(r.type, 40), editeur: txt(r.editeur, 300),
    couverture: { ok: r.couverture?.ok !== false, cause: txt(r.couverture?.cause, 400) },
    reference: liste(r.reference, 6, 400), photos: liste(r.photos, 12, 400), video: liste(r.video, 4, 600),
    alertes: liste(r.alertes, 20, 400), graphiques_non_places: liste(r.graphiques_non_places, 12, 300),
    mise_en_forme: liste(r.mise_en_forme, 15, 400), sources: txt(r.sources, 6000),
  };
  const row = { post_id: id, airtable_id: txt(b.airtable_id, 30) || null, titre: txt(b.titre, 300) || null, type: rapport.type || null, rapport, texte: txt(b.texte, 12000) || null, updated_at: new Date().toISOString() };
  const { error } = await db.from("usine_rapports").upsert(row, { onConflict: "post_id" });
  if (error) return { ok: false, why: error.message };
  return { ok: true, post_id: id };
}

// ---------- Événements de l'Usine (miroir des messages Telegram), 23/10/2026 ----------
const GENRES = ["brouillon", "echec", "alerte", "panne", "soir", "radar", "special", "fini", "inscriptions"];
const GENRES_ALERTE = ["alerte", "echec", "panne"];
async function pushEquipe(to: string[] | null, title: string, message: string, ancre = "") {
  try {
    const r = await fetch(env("SUPABASE_URL") + "/functions/v1/wl-db", { method: "POST", headers: { "Content-Type": "application/json", "x-tv-secret": env("TV_ADMIN_SECRET") },
      body: JSON.stringify({ action: "push", ...(to ? { to } : {}), title, message, ancre }) });
    return r.ok;
  } catch (_) { return false; }
}
async function chefsIds(): Promise<string[]> {
  const { data } = await db.from("wl_equipe").select("id").eq("role", "chef").eq("actif", true);
  const l = (data || []).map((x: any) => String(x.id));
  return l.length ? l : ["jonathan"];
}
async function reglage(cle: string) { const { data } = await db.from("wl_reglages").select("valeur").eq("cle", cle).limit(1); return String((data && data[0] && data[0].valeur) || ""); }
// Ligne d'événement, bornée ; clé de dédoublonnage facultative (un même message n'est jamais enregistré deux fois).
async function noterEvenement(e: { genre: string; titre?: string; texte?: string; donnees?: any; cle?: string; test?: boolean }) {
  const row: Record<string, unknown> = { genre: e.genre, titre: txt(e.titre, 300) || null, texte: txt(e.texte, 6000) || null, donnees: e.donnees && typeof e.donnees === "object" ? e.donnees : {}, test: !!e.test };
  if (e.cle) row.cle = txt(e.cle, 200);
  const { data, error } = await db.from("usine_evenements").insert(row).select("id").limit(1);
  if (error) { if (/duplicate|unique/i.test(error.message)) return { ok: true, doublon: true }; return { ok: false, why: error.message }; }
  return { ok: true, id: data && data[0] && data[0].id };
}
const premiereLigne = (t: string) => String(t || "").split("\n").map((x) => x.trim()).filter(Boolean)[0] || "";
const lst = (v: unknown, n = 12) => (Array.isArray(v) ? v : []).map((x) => txt(x, 200)).filter(Boolean).slice(0, n);
function texteSoir(d: any): string {
  const k = String(d.kind || "");
  if (k === "batch") {
    const n = Number(d.publishedCount) || 0, t = lst(d.publishedTitles);
    if (!n && !t.length) return "Batch du soir : aucun article à publier.";
    return "📰 Batch du soir : " + n + " article" + (n > 1 ? "s" : "") + " publié" + (n > 1 ? "s" : "") + " (premium " + (Number(d.premiumCount) || 0) + ", gratuits " + (Number(d.actuPubCount) || 0) + ")" +
      (t.length ? "\n" + t.map((x) => "• " + x).join("\n") : "") + (Array.isArray(d.finiRetires) && d.finiRetires.length ? "\nTag #fini retiré : " + lst(d.finiRetires).join(" · ") : "");
  }
  if (k === "verrou") {
    const v = d.verrou || {}, late = lst(d.latePublished);
    const r = String(v.role || "");
    let t = "🔒 Verrou du soir (21 h)" + (r === "gagnant" ? " : passage retenu" : r ? " : " + r : "");
    if (late.length) t += "\nValidés après 18 h 30, publiés à 21 h :\n" + late.map((x) => "• " + x).join("\n");
    if (v.error) t += "\n⚠️ " + txt(v.error, 200);
    if (d.weekend) t += "\nWeek-end : pas de brief.";
    return t;
  }
  if (k === "brief") {
    if (d.sent) return "✉️ Brief envoyé : « " + txt(d.subject, 200) + " » (" + (Number(d.articles) || 0) + " article" + ((Number(d.articles) || 0) > 1 ? "s" : "") + ")";
    return "✉️ Brief non envoyé" + (Array.isArray(d.problems) && d.problems.length ? " : " + d.problems.map((x: unknown) => txt(typeof x === "string" ? x : JSON.stringify(x), 160)).join(" · ") : "");
  }
  return "";
}
function texteSpecial(d: any): string {
  if (d.type === "bestof") return "📬 Best-of premium prêt (brouillon) : « " + txt(d.objet, 200) + " »" + (lst(d.picks).length ? "\n" + lst(d.picks).map((x) => "• " + x).join("\n") : "");
  if (d.type === "grandformat") return "📺 Grand Format " + (d.scheduledAt ? "programmé" : "prêt") + " : « " + txt(d.objet, 200) + " »" + (lst(d.videos).length ? "\n" + lst(d.videos).map((x) => "• " + x).join("\n") : "");
  return "";
}
async function recevoirEvenement(b: any) {
  const genre = String(b.genre || "");
  if (!GENRES.includes(genre)) return { ok: false, why: "genre inconnu" };
  let texte = txt(b.texte, 6000);
  // l'Usine peut passer le corps Telegram tel quel ({ chat_id, text }) ou sa chaîne JSON
  if (!texte && b.telegram) { try { const t = typeof b.telegram === "string" ? JSON.parse(b.telegram) : b.telegram; texte = txt(t.text || t.caption || "", 6000); } catch (_) { texte = txt(b.telegram, 6000); } }
  const d = b.donnees && typeof b.donnees === "object" ? b.donnees : {};
  // Journal du soir : l'Usine envoie ses données brutes ; le texte lisible est composé ici.
  if (genre === "soir" && !texte) texte = texteSoir(d);
  if (genre === "special" && !texte) texte = texteSpecial(d);
  if (!texte && !txt(b.titre, 300)) return { ok: true, ignore: "rien à noter" };
  const titre = txt(b.titre, 300) || premiereLigne(texte).slice(0, 200);
  const test = b.test === true;
  const r = await noterEvenement({ genre, titre, texte, donnees: d, cle: b.cle, test });
  if (!r.ok || (r as any).doublon) return r;
  const low = texte.toLowerCase();
  // alertes dérivées : crédits OpenAI épuisés (rapport du brouillon), sujets écartés par l'anti-doublon (résumé du Radar)
  if (genre === "brouillon" && /(billing|quota|insufficient|crédit|credit).{0,40}(openai|image)|openai.{0,60}(billing|quota|crédit|credit|insufficient)/i.test(texte))
    await noterEvenement({ genre: "alerte", titre: "Crédits OpenAI épuisés : couverture non générée", texte: titre, donnees: { source: "brouillon" }, test });
  if (genre === "radar") {
    const lignes = texte.split("\n").filter((x) => /écart|ecart|trop proche|doublon/i.test(x));
    if (lignes.length) await noterEvenement({ genre: "alerte", titre: "Radar : sujets écartés par l’anti-doublon", texte: lignes.join("\n").slice(0, 3000), donnees: { source: "radar" }, test });
  }
  // #fini non retiré à la publication : jamais bloquant pour l'Usine, mais signalé au chef (onglet Alertes)
  if (genre === "soir" && Array.isArray(d.finiErreurs) && d.finiErreurs.length)
    await noterEvenement({ genre: "alerte", titre: "Tag #fini non retiré à la publication", texte: d.finiErreurs.map((x: unknown) => "• " + txt(x, 300)).join("\n"), donnees: { source: "batch" }, test });
  if (genre === "soir" && d.kind === "brief" && d.sent === false && Array.isArray(d.problems) && d.problems.length)
    await noterEvenement({ genre: "alerte", titre: "Brief du soir non envoyé", texte: d.problems.map((x: unknown) => "• " + txt(typeof x === "string" ? x : JSON.stringify(x), 300)).join("\n"), donnees: { source: "brief" }, test });
  if (test) return { ok: true, id: (r as any).id, push: false };
  const chefs = await chefsIds();
  if (genre === "brouillon") await pushEquipe(chefs, "📝 Brouillon prêt", titre.replace(/^📝\s*/, "") || "Un nouveau brouillon de l’Usine est sur le Marbre.", "marbre");
  else if (genre === "echec") await pushEquipe(chefs, "⚠️ Rédaction échouée", titre || "L’Usine n’a pas pu rédiger le sujet.", "radar");
  else if (genre === "alerte") await pushEquipe(chefs, "⚠️ Usine : alerte", titre, "radar");
  else if (genre === "radar" && (await reglage("push_radar_matin")) === "1") await pushEquipe(chefs, "📡 Radar du jour", titre || "Les sujets du jour sont arrivés.", "radar");
  return { ok: true, id: (r as any).id };
}
// Tags d'un post Ghost (Admin API) ; écrit le tableau de tags complet (Ghost remplace la liste).
async function ghostEcrire(path: string, method: string, body: unknown) {
  const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 15000);
  try {
    const r = await fetch(ghostUrl() + "/ghost/api/admin/" + path, { method, signal: ctl.signal, headers: { Authorization: "Ghost " + (await ghostToken()), "Accept-Version": "v5.0", "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error("Ghost " + r.status + " " + String(j?.errors?.[0]?.message || "").slice(0, 160));
    return j;
  } finally { clearTimeout(to); }
}
const FINI = { name: "#fini", slug: "hash-fini" };
const estFini = (t: any) => t && (t.slug === FINI.slug || String(t.name || "").toLowerCase() === FINI.name);

// Brouillons marqués « #fini » (prêts à relire), tous auteurs. Un #fini posé directement dans Ghost (sans le bouton du lab) est
// détecté ici, une seule fois par article et par jour : événement « fini » + push au rédacteur en chef. Jamais bloquant.
async function brouillonsFinis() {
  try {
    const r: any = await ghost(`posts/?filter=${encodeURIComponent("tag:hash-fini+status:[draft,scheduled]")}&limit=30&fields=id,title,updated_at&include=authors`);
    const l = (r.posts || []).map((p: any) => ({ id: p.id, titre: p.title, maj: p.updated_at, editeur: ghostUrl() + "/ghost/#/editor/post/" + p.id, auteurs: (p.authors || []).map((u: any) => String(u.name || "")).filter(Boolean) }));
    const jour = new Intl.DateTimeFormat("fr-CA", { timeZone: "Europe/Zurich" }).format(new Date());
    for (const p of l) {
      const n = await noterEvenement({ genre: "fini", titre: p.titre, texte: "« " + p.titre + " » marqué #fini", donnees: { post_id: p.id, source: "ghost" }, cle: "fini:" + p.id + ":" + jour });
      if (n.ok && !(n as any).doublon) {
        // déjà signalé par le bouton du lab dans les 12 dernières heures ? pas de deuxième push
        const { data } = await db.from("usine_evenements").select("id").eq("genre", "fini").is("cle", null).gte("at", new Date(Date.now() - 12 * 3600e3).toISOString()).contains("donnees", { post_id: p.id }).limit(1);
        if (!data || !data.length) await pushEquipe(await chefsIds(), "✅ Prêt à relire", "« " + p.titre + " »" + (p.auteurs.length ? " (" + p.auteurs.join(", ") + ")" : "") + " est marqué #fini.", "marbre");
      }
    }
    return l;
  } catch (_) { return null; }
}

// ---------- 🧠 Proposer un sujet à l'Usine (24/10/2026) ----------
// L'assistant propose jusqu'à 3 titres et 3 angles pour une idée de sujet (Radar → « Proposer un sujet », sujet du vote, ☎️ de
// l'Assistant). Recherche web facultative (outil web_search d'Anthropic) pour un premier tour d'horizon : ce qu'on trouve, si le
// sujet vaut un article, et un angle renforcé par ce qu'on a trouvé. Rien n'est écrit dans le Radar : on choisit, puis on met en file.
const MODELE_SUJET = "claude-sonnet-5-5";
const SYS_SUJET = "Tu es le rédacteur en chef adjoint de Posthumain, média français par abonnement (IA, technologies, science, cerveau, futur humain) "
  + "lu par un grand public curieux, pas par des spécialistes. On te confie une idée de sujet pour l'Usine à articles. Propose EXACTEMENT 3 titres et 3 angles, différents entre eux.\n"
  + "Titres : en français, accrocheurs mais honnêtes (le contenu doit tenir la promesse), 110 caractères au plus, jamais à la première personne (« J'ai testé… » interdit), "
  + "pas de point final. Un titre de type guide, liste (« les 7… »), comparatif ou test n'est permis que si l'angle livre vraiment ce format.\n"
  + "Angles : 2 à 4 phrases chacun : la question centrale, ce que l'article apporte de neuf ou d'utile au lecteur, ce qu'il doit absolument traiter. "
  + "Donne à chaque angle un nom court (3 à 6 mots).\n"
  + "Si on te donne déjà un angle, garde-le comme premier angle (amélioré si besoin) et propose deux alternatives. Respecte la consigne du rédacteur en chef si elle est donnée.\n"
  + "Si la recherche web est disponible, fais 2 à 4 recherches rapides : ce qui est récent et vérifiable, les chiffres clés, les sources sérieuses. Dis en une ou deux phrases si le sujet vaut un article "
  + "(intérêt fort, moyen ou faible, et pourquoi) et, si la recherche te permet un angle plus intéressant que l'idée de départ, dis-le dans « note » (« En faisant la recherche, je peux proposer un angle plus intéressant : … ») "
  + "et place cet angle en premier. Sans recherche, ne cite aucun fait daté que tu ne connais pas avec certitude.\n"
  + "Réponds UNIQUEMENT par un objet JSON, sans texte autour : {\"titres\":[\"…\",\"…\",\"…\"],\"angles\":[{\"nom\":\"…\",\"texte\":\"…\"},{…},{…}],"
  + "\"interet\":\"fort|moyen|faible|inconnu\",\"pourquoi\":\"…\",\"note\":\"…\",\"sources\":[{\"titre\":\"…\",\"url\":\"https://…\"}]}";
const TYPES_SUJET: Record<string, string> = { actu: "article d'actualité gratuit (court, factuel, utile)", "actu-premium": "actualité avec une dernière partie réservée aux abonnés (la stratégie Posthumain)", premium: "enquête premium payante (article de fond, 3 000 mots et plus)" };
async function claudeSujet(user: string, web: boolean) {
  const key = env("ANTHROPIC_API_KEY"); if (!key) throw new Error("clé Anthropic absente");
  const body: any = { model: MODELE_SUJET, max_tokens: 6000, thinking: { type: "adaptive" }, output_config: { effort: web ? "medium" : "low" }, system: SYS_SUJET, messages: [{ role: "user", content: user }] };
  if (web) body.tools = [{ type: "web_search_20250305", name: "web_search", max_uses: 4 }];
  const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", signal: AbortSignal.timeout(110000),
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" }, body: JSON.stringify(body) });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error("Claude " + r.status + " : " + String(j?.error?.message || "").slice(0, 160)), { statut: r.status });
  return j;
}
async function proposerSujet(b: any, qui: string) {
  const titre = txt(b.titre, 300).trim(), angle = txt(b.angle, 3000).trim(), lien = txt(b.url, 1000).trim(), consigne = txt(b.consigne, 1500).trim();
  if (titre.length < 4) throw new Error("donnez au moins une idée de sujet ou un titre");
  if (lien && !/^https?:\/\//i.test(lien)) throw new Error("lien invalide (http ou https)");
  const type = TYPES_SUJET[String(b.type)] ? String(b.type) : "actu";
  let web = !!b.web, webIndispo = false;
  const user = "Idée de sujet : " + titre + "\nFormat visé : " + TYPES_SUJET[type] + (angle ? "\nAngle déjà envisagé : " + angle : "") + (lien ? "\nLien source : " + lien : "")
    + (consigne ? "\nConsigne du rédacteur en chef : " + consigne : "") + "\nDate du jour : " + new Date().toISOString().slice(0, 10) + (web ? "\nRecherche web : disponible." : "\nRecherche web : non demandée.");
  let j: any;
  try { j = await claudeSujet(user, web); }
  catch (e) { if (!web) throw e; webIndispo = true; web = false; j = await claudeSujet(user.replace("Recherche web : disponible.", "Recherche web : indisponible."), false); }
  const texte = (j.content || []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("").trim();
  const a = texte.indexOf("{"), z = texte.lastIndexOf("}");
  let o: any = null; try { o = JSON.parse(texte.slice(a, z + 1)); } catch { o = null; }
  if (!o) throw new Error("réponse de l'assistant illisible, réessayez");
  const u = j.usage || {}, tin = Number(u.input_tokens || 0), tout = Number(u.output_tokens || 0), nbWeb = Number(u.server_tool_use?.web_search_requests || 0);
  try { await db.from("wl_couts").insert({ membre: qui, usage: "sujet_usine", modele: String(j.model || MODELE_SUJET), tokens_in: tin, tokens_out: tout, cout_eur: Math.round((((tin * 2 + tout * 10) / 1e6) + nbWeb * 0.01) * 0.92 * 1e5) / 1e5 }); } catch (_) { /* comptage facultatif */ }
  const sources = (Array.isArray(o.sources) ? o.sources : []).filter((x: any) => x && /^https?:\/\//.test(String(x.url || ""))).slice(0, 6).map((x: any) => ({ titre: txt(x.titre || x.url, 160), url: txt(x.url, 600) }));
  return { ok: true, web, web_indisponible: webIndispo, recherches: nbWeb,
    titres: liste(o.titres, 3, 160), angles: (Array.isArray(o.angles) ? o.angles : []).slice(0, 3).map((x: any) => ({ nom: txt(x && x.nom, 80), texte: txt(x && (x.texte || x), 1200) })).filter((x: any) => x.texte.trim()),
    interet: ["fort", "moyen", "faible"].includes(String(o.interet)) ? String(o.interet) : "inconnu", pourquoi: txt(o.pourquoi, 600), note: txt(o.note, 800), sources };
}

Deno.serve(async (req) => {
  const h = { ...cors(req), "Content-Type": "application/json", "Cache-Control": "no-store" };
  if (req.method === "OPTIONS") return new Response(null, { headers: h });
  const out = (v: unknown, s = 200) => new Response(JSON.stringify(v), { status: s, headers: h });
  if (req.method !== "POST") return out({ ok: false, why: "method" }, 405);
  let b: any; try { b = await req.json(); } catch { return out({ ok: false, why: "bad_json" }, 400); }
  // Usine (serveur à serveur) : dépôt du rapport du brouillon.
  if (b.action === "rapport") {
    if (!egal(req.headers.get("x-tv-secret") || "", env("TV_ADMIN_SECRET"))) return out({ ok: false, why: "unauthorized" }, 401);
    try { return out(await enregistrerRapport(b)); } catch (e) { return out({ ok: false, why: String((e as Error)?.message || e).slice(0, 200) }, 500); }
  }
  // Usine (serveur à serveur) : miroir d'un message Telegram (23/10/2026). Jamais bloquant côté Usine (réponse rapide, erreurs avalées).
  if (b.action === "evenement") {
    if (!egal(req.headers.get("x-tv-secret") || "", env("TV_ADMIN_SECRET"))) return out({ ok: false, why: "unauthorized" }, 401);
    try { return out(await recevoirEvenement(b)); } catch (e) { return out({ ok: false, why: String((e as Error)?.message || e).slice(0, 200) }); }
  }
  const qui = await membre(String(b.token || "")).catch(() => null);
  if (!qui) return out({ ok: false, why: "accès réservé à l’équipe" }, 401);
  const chef = !!qui.chef;
  const ecrit = ["proposer", "preciser", "choisir", "decocher", "ecarter", "remettre", "imposer", "ordre", "approuver", "ecarter_brouillon", "relancer_radar", "lancer_usine", "alertes", "alertes_lu", "reglage_radar", "valider_special", "annuler_special", "inscriptions"];
  if (ecrit.includes(String(b.action)) && !chef) return out({ ok: false, why: "réservé au rédacteur en chef" }, 403);
  try {
    // État de configuration (aucune valeur de secret n'est renvoyée).
    if (b.action === "diag") return out({ ok: true, chef, airtable: !!airKey(), ghost: !!env("GHOST_ADMIN_API_KEY"), ghost_url: !!env("GHOST_ADMIN_API_URL") });

    // Salle du Radar : le lot du jour (Status 'new' : l'Usine archive les anciens candidats à chaque Radar), la file, le sujet voté.
    if (b.action === "radar") {
      const [lot, fl, votes] = await Promise.all([
        air("Radar" + q("{Status}='new'", "&maxRecords=60" + SORT_SCORE)),
        file(),
        air("Radar" + q(`AND(LEFT({URL},${VOTE_PREFIX.length})='${VOTE_PREFIX}',OR({Status}='new',{Status}='skipped'))`, "&maxRecords=5" + SORT_CREE)).catch(() => ({ records: [] })),
      ]);
      const sujets = (lot.records || []).map(sujet).filter((s: any) => !s.vote);
      return out({ ok: true, chef, sujets, file: fl, votes: (votes.records || []).map(sujet), at: new Date().toISOString() });
    }
    // Coche un sujet du Radar (= /ecrire N [type]).
    if (b.action === "choisir") {
      const s = await lireUn(String(b.id));
      if (s.statut !== "new") return out({ ok: false, why: "ce sujet n’est plus disponible (statut : " + s.statut + ")" });
      const fields: Record<string, unknown> = { Choisir: true };
      const t = String(b.type || "");
      if (t === "actu-premium") { fields.Type = "actu"; fields.ActuPremium = true; }
      else if (t === "premium") { fields.Type = "premium"; fields.ActuPremium = false; }
      else if (t === "actu") { fields.Type = "actu"; fields.ActuPremium = false; }
      return out({ ok: true, sujet: await patch(s.id, fields), file: await file() });
    }
    // Retire un sujet de la file sans l'écarter (il redevient un simple candidat du jour).
    if (b.action === "decocher") {
      const s = await lireUn(String(b.id));
      if (s.statut !== "new") return out({ ok: false, why: "ce sujet n’est plus dans la file (statut : " + s.statut + ")" });
      return out({ ok: true, sujet: await patch(s.id, { Choisir: false }), file: await file() });
    }
    // Sujet voté par le public : « Ne pas l'écrire » / « Le remettre » (tant qu'il n'est pas rédigé).
    if (b.action === "ecarter") {
      const s = await lireUn(String(b.id));
      if (s.statut !== "new") return out({ ok: false, why: "déjà " + (s.statut === "skipped" ? "écarté" : "pris par l’Usine (" + s.statut + ")") });
      return out({ ok: true, sujet: await patch(s.id, { Status: "skipped", Choisir: false }) });
    }
    if (b.action === "remettre") {
      const s = await lireUn(String(b.id));
      if (s.statut !== "skipped") return out({ ok: false, why: s.statut === "new" ? "il est déjà en file" : "déjà rédigé (" + s.statut + ")" });
      return out({ ok: true, sujet: await patch(s.id, { Status: "new", Choisir: true }) });
    }
    // Impose un sujet neuf (= /ecrire sujet|url|type + angle) ou une enquête (= /enquete sujet|url + angle).
    if (b.action === "imposer") {
      const titre = String(b.titre || "").trim().slice(0, 300);
      if (titre.length < 6) return out({ ok: false, why: "titre trop court" }, 400);
      const lien = String(b.url || "").trim().slice(0, 1000);
      if (lien && !/^https?:\/\//i.test(lien)) return out({ ok: false, why: "lien invalide (http ou https)" }, 400);
      const angle = String(b.angle || "").trim().slice(0, 3000);
      const t = b.enquete ? "premium" : String(b.type || "actu");
      const fields: Record<string, unknown> = { Title: titre, Type: t === "premium" ? "premium" : "actu", Status: "new", Score: 100, Choisir: true, CreatedAt: new Date().toISOString() };
      if (angle) fields.Angle = angle;
      if (t === "actu-premium") fields.ActuPremium = true;
      if (lien) fields.URL = lien;
      const r = await air("Radar", { method: "POST", body: JSON.stringify({ fields, typecast: true }) });
      return out({ ok: true, sujet: sujet(r), file: await file() });
    }
    // 🧠 L'assistant propose titres et angles (24/10/2026) : rien n'est écrit.
    if (b.action === "proposer") return out(await proposerSujet(b, qui.id));
    // Préciser un sujet déjà dans le Radar (sujet voté par le public, sujet du jour) avant l'Usine : titre, angle, lien, format.
    // Le lien d'un sujet voté (posthumain.com/vote…) est gardé (il identifie le vote) : un lien source part alors dans l'angle.
    if (b.action === "preciser") {
      const s = await lireUn(String(b.id));
      if (s.statut !== "new" && s.statut !== "skipped") return out({ ok: false, why: "déjà pris par l’Usine (" + s.statut + ")" });
      const fields: Record<string, unknown> = { Choisir: true, Status: "new" };
      const titre = String(b.titre || "").trim().slice(0, 300), angle = String(b.angle || "").trim().slice(0, 3000), lien = String(b.url || "").trim().slice(0, 1000);
      if (lien && !/^https?:\/\//i.test(lien)) return out({ ok: false, why: "lien invalide (http ou https)" }, 400);
      if (titre.length >= 6) fields.Title = titre;
      if (angle || b.angle === "") fields.Angle = angle + (lien && s.vote ? (angle ? "\n\n" : "") + "Source à exploiter : " + lien : "");
      else if (lien && s.vote) fields.Angle = (s.angle ? s.angle + "\n\n" : "") + "Source à exploiter : " + lien;
      if (lien && !s.vote) fields.URL = lien;
      const t = String(b.type || "");
      if (t === "actu-premium") { fields.Type = "actu"; fields.ActuPremium = true; }
      else if (t === "premium") { fields.Type = "premium"; fields.ActuPremium = false; }
      else if (t === "actu") { fields.Type = "actu"; fields.ActuPremium = false; }
      return out({ ok: true, sujet: await patch(s.id, fields), file: await file() });
    }
    // Réordonne la file (généralise /inverser) : ids dans l'ordre voulu → Priorite décroissante.
    if (b.action === "ordre") {
      const ids: string[] = (Array.isArray(b.ids) ? b.ids : []).map(String).slice(0, 20);
      const fl = await file();
      const connus = new Set(fl.map((s: any) => s.id));
      if (!ids.length || ids.length !== fl.length || !ids.every((id) => connus.has(id))) return out({ ok: false, why: "la file a changé entre-temps : actualisez" });
      const base = ids.length + 10, recs = ids.map((id, i) => ({ id, fields: { Priorite: base - i } }));
      for (let i = 0; i < recs.length; i += 10) await air("Radar", { method: "PATCH", body: JSON.stringify({ records: recs.slice(i, i + 10), typecast: true }) });
      return out({ ok: true, file: await file() });
    }
    // Le Marbre : brouillons de l'Usine (drafted / approved) + leur post Ghost + le visuel social ; publiés aujourd'hui.
    if (b.action === "marbre") {
      // Sans jeton Airtable : on montre quand même les brouillons Ghost récents (sans « Approuver », qui écrit dans Airtable).
      if (!airKey()) {
        const [dr, pub] = await Promise.all([
          ghost(`posts/?filter=${encodeURIComponent("status:[draft,scheduled]")}&limit=15&order=updated_at%20desc&fields=${CHAMPS_POST}&include=tags,authors`).catch((e) => ({ erreur: String(e.message || e) })),
          ghost(`posts/?filter=${encodeURIComponent(`status:published+published_at:>'${minuitZurich()}'`)}&limit=20&order=published_at%20desc&fields=${CHAMPS_POST}`).catch((e) => ({ erreur: String(e.message || e) })),
        ]);
        const brouillons = ((dr as any).posts || []).filter((p: any) => !p.email_only && !/^\s*TEST\s*[—–-]/.test(p.title || "")).map((p: any) => ({ id: "", titre: p.title, type: "", statut: "", post: post(p), social: null }));
        await sansEmails(brouillons.map((x: any) => x.post));
        return out({ ok: true, chef, airtable_absent: true, brouillons, usine_ids: [], finis: await brouillonsFinis(), publies: await sansEmails(((pub as any).posts || []).filter((p: any) => !p.email_only).map(post)),
          erreur_ghost: (dr as any).erreur || (pub as any).erreur || "", at: new Date().toISOString() });
      }
      // usine_ids (23/10/2026) : les posts Ghost écrits par l'Usine (GhostPostId du Radar, 100 plus récents, tous statuts), pour que la
      // page puisse masquer les brouillons de l'Usine (« Inclure les brouillons de l'Usine »). Une seule page Airtable, champ unique.
      const [r, us] = await Promise.all([
        air("Radar" + q("OR({Status}='drafted',{Status}='approved')", "&maxRecords=15" + SORT_CREE)),
        air("Radar" + q("NOT({GhostPostId}='')", "&pageSize=100&fields%5B%5D=GhostPostId" + SORT_CREE)).catch(() => ({ records: [] })),
      ]);
      const usine_ids = [...new Set(((us as any).records || []).map((x: any) => String(x.fields?.GhostPostId || "")).filter((x: string) => /^[a-f0-9]{24}$/.test(x)))];
      const recs = (r.records || []).map(sujet).filter((s: any) => s.ghost_id);
      const ids = recs.map((s: any) => s.ghost_id).filter((x: string) => /^[a-f0-9]{24}$/.test(x));
      const [posts, soc, pub] = await Promise.all([
        ids.length ? ghost(`posts/?filter=${encodeURIComponent("id:[" + ids.join(",") + "]")}&limit=all&fields=${CHAMPS_POST}&include=tags,authors`).catch((e) => ({ erreur: String(e.message || e) })) : Promise.resolve({ posts: [] }),
        ids.length ? air("Social" + q("OR(" + ids.map((i: string) => `{GhostPostId}='${i}'`).join(",") + ")", "&maxRecords=30")).catch(() => ({ records: [] })) : Promise.resolve({ records: [] }),
        ghost(`posts/?filter=${encodeURIComponent(`status:published+published_at:>'${minuitZurich()}'`)}&limit=20&order=published_at%20desc&fields=${CHAMPS_POST}`).catch((e) => ({ erreur: String(e.message || e) })),
      ]);
      const { data: rps } = ids.length ? await db.from("usine_rapports").select("post_id,rapport,updated_at").in("post_id", ids) : { data: [] };
      const rm = new Map((rps || []).map((x: any) => [x.post_id, { ...x.rapport, le: x.updated_at }]));
      const pm = new Map(((posts as any).posts || []).map((p: any) => [p.id, post(p)]));
      const sm = new Map(((soc as any).records || []).map((x: any) => [x.fields?.GhostPostId, { image: x.fields?.ImageURL || "", legende: x.fields?.Caption || "", hashtags: x.fields?.Hashtags || "", statut: x.fields?.Status || "" }]));
      const brouillons = recs.map((s: any) => ({ ...s, post: pm.get(s.ghost_id) || null, social: sm.get(s.ghost_id) || null, rapport: rm.get(s.ghost_id) || null }))
        .filter((x: any) => !x.post || x.post.statut === "draft" || x.post.statut === "scheduled")
        // Post Ghost introuvable alors que la requête Ghost a réussi : il a été supprimé à la main (22/10/2026).
        .map((x: any) => ({ ...x, ghost_supprime: !x.post && !(posts as any).erreur && /^[a-f0-9]{24}$/.test(x.ghost_id) }));
      await sansEmails(brouillons.map((x: any) => x.post));
      return out({ ok: true, chef, brouillons, usine_ids, finis: await brouillonsFinis(), publies: await sansEmails(((pub as any).posts || []).filter((p: any) => !p.email_only).map(post)),
        erreur_ghost: (posts as any).erreur || (pub as any).erreur || "", at: new Date().toISOString() });
    }
    // Approuver (= lien « Approuver » de Telegram, mais authentifié) : publié au batch du soir (~18 h 30).
    if (b.action === "approuver") {
      const s = await lireUn(String(b.id));
      if (s.statut === "approved") return out({ ok: true, sujet: s, deja: true });
      if (s.statut !== "drafted" || !s.ghost_id) return out({ ok: false, why: "ce sujet n’est pas un brouillon en attente (statut : " + s.statut + ")" });
      return out({ ok: true, sujet: await patch(s.id, { Status: "approved" }) });
    }
    // Écarter un brouillon de l'Usine depuis le Marbre (22/10/2026) : il ne sera pas publié au batch du soir.
    // Même écriture qu'un sujet écarté ({ Status:'skipped', Choisir:false }) + trace dans Rationale. Le post Ghost n'est JAMAIS touché.
    // Pas de risque de réécriture : l'Usine ne prend que des sujets 'new', et « Dedup candidats » écarte du Radar toute URL / tout titre
    // déjà présent dans la table, quel que soit son statut.
    if (b.action === "ecarter_brouillon") {
      const id = String(b.id || "");
      if (!/^rec[A-Za-z0-9]{10,20}$/.test(id)) return out({ ok: false, why: "identifiant de sujet invalide" }, 400);
      const raw = await air("Radar/" + id), f = raw.fields || {};
      const st = String(f.Status || "");
      if (st === "skipped") return out({ ok: true, sujet: sujet(raw), deja: true });
      if (st !== "drafted") return out({ ok: false, why: st === "approved" ? "déjà approuvé : il partira au batch du soir (retirez l’approbation dans Airtable si besoin)" : "ce sujet n’est pas un brouillon en attente (statut : " + (st || "?") + ")" });
      const jour = new Intl.DateTimeFormat("fr-CH", { timeZone: "Europe/Zurich", day: "2-digit", month: "2-digit" }).format(new Date()).replace(".", "/");
      const rat = String(f.Rationale || "").trim();
      const trace = "[écarté depuis le Marbre le " + jour + "]";
      return out({ ok: true, sujet: await patch(id, { Status: "skipped", Choisir: false, Rationale: (rat ? rat + " " : "") + trace }) });
    }
    // Relancer le Radar (= /radar) : 1 exécution n8n ; au plus une fois toutes les 10 minutes.
    if (b.action === "relancer_radar") {
      const { data } = await db.from("wl_reglages").select("valeur").eq("cle", "radar_relance_le").limit(1);
      const last = Date.parse(String((data && data[0] && data[0].valeur) || "")) || 0;
      if (Date.now() - last < 10 * 60e3) return out({ ok: false, why: "Radar déjà relancé il y a moins de 10 minutes : le résumé arrive" });
      await db.from("wl_reglages").upsert({ cle: "radar_relance_le", valeur: new Date().toISOString(), updated_at: new Date().toISOString() }, { onConflict: "cle" });
      const upd = { update_id: Date.now(), message: { message_id: Date.now() % 1e9, date: Math.floor(Date.now() / 1000), text: "/radar", chat: { id: JONATHAN_CHAT, type: "private" }, from: { id: JONATHAN_CHAT, is_bot: false, first_name: "Writinglab" } } };
      const r = await fetch(USINE_TELEGRAM_WEBHOOK, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(upd) }).catch(() => null);
      if (!r || !r.ok) return out({ ok: false, why: "l’Usine ne répond pas (" + (r ? r.status : "réseau") + ")" });
      return out({ ok: true, why: "Radar relancé : les nouveaux sujets arrivent d’ici quelques minutes" });
    }
    // Lancer l'Usine maintenant (= /usine) : même webhook Telegram que « Relancer le Radar » ; l'Usine applique ses propres garde-fous
    // (pas deux /usine en 12 min, pas pendant un passage programmé) et répond aussi sur Telegram. Verrou du lab : 12 minutes.
    if (b.action === "lancer_usine") {
      const now = new Date(), hm = Number(new Intl.DateTimeFormat("fr-CH", { timeZone: "Europe/Zurich", hour: "2-digit", hour12: false }).format(now)) * 60 + Number(new Intl.DateTimeFormat("fr-CH", { timeZone: "Europe/Zurich", minute: "2-digit" }).format(now));
      if ((hm >= 510 && hm < 525) || (hm >= 720 && hm < 735)) return out({ ok: false, why: "un passage programmé de l’Usine est en cours (" + (hm < 600 ? "8 h 30" : "12 h") + ") : attendez le brouillon" });
      const last = Date.parse(await reglage("usine_lance_le")) || 0;
      if (Date.now() - last < 12 * 60e3) return out({ ok: false, why: "Usine déjà lancée il y a moins de 12 minutes : le brouillon arrive (environ 8 min)" });
      await db.from("wl_reglages").upsert({ cle: "usine_lance_le", valeur: now.toISOString(), updated_at: now.toISOString() }, { onConflict: "cle" });
      const upd = { update_id: Date.now(), message: { message_id: Date.now() % 1e9, date: Math.floor(Date.now() / 1000), text: "/usine", chat: { id: JONATHAN_CHAT, type: "private" }, from: { id: JONATHAN_CHAT, is_bot: false, first_name: "Writinglab" } } };
      const r = await fetch(USINE_TELEGRAM_WEBHOOK, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(upd) }).catch(() => null);
      if (!r || !r.ok) return out({ ok: false, why: "l’Usine ne répond pas (" + (r ? r.status : "réseau") + ")" });
      return out({ ok: true, why: "Usine lancée : le brouillon arrive sur le Marbre d’ici 8 à 10 minutes" });
    }
    // Onglet ⚠️ Alertes du Radar (chef seul) : alertes et échecs de l'Usine + pannes des workflows (wl_alertes).
    if (b.action === "alertes") {
      const [ev, pn] = await Promise.all([
        db.from("usine_evenements").select("id,at,genre,titre,texte,lu_le,test").in("genre", GENRES_ALERTE).order("at", { ascending: false }).limit(80),
        db.from("wl_alertes").select("cle,derniere,nombre,detail").order("derniere", { ascending: false }).limit(20),
      ]);
      const alertes = (ev.data || []).map((x: any) => ({ id: x.id, at: x.at, genre: x.genre, titre: x.titre || "", texte: x.texte || "", lu: !!x.lu_le, test: !!x.test }));
      const lus = await reglage("alertes_pannes_lues_le");
      const pannes = (pn.data || []).map((x: any) => ({ cle: x.cle, at: x.derniere, nombre: Number(x.nombre) || 1, texte: x.detail || "", lu: !!lus && Date.parse(lus) >= Date.parse(x.derniere) }));
      const radar_matin = (await reglage("push_radar_matin")) === "1";
      return out({ ok: true, alertes, pannes, non_lues: alertes.filter((x: any) => !x.lu && !x.test).length + pannes.filter((x: any) => !x.lu).length, radar_matin });
    }
    if (b.action === "alertes_lu") {
      const now = new Date().toISOString();
      if (b.tout) {
        await db.from("usine_evenements").update({ lu_le: now }).in("genre", GENRES_ALERTE).is("lu_le", null);
        await db.from("wl_reglages").upsert({ cle: "alertes_pannes_lues_le", valeur: now, updated_at: now }, { onConflict: "cle" });
      } else if (b.panne) await db.from("wl_reglages").upsert({ cle: "alertes_pannes_lues_le", valeur: now, updated_at: now }, { onConflict: "cle" });
      else if (Number(b.id) > 0) await db.from("usine_evenements").update({ lu_le: now }).eq("id", Number(b.id)).in("genre", GENRES_ALERTE);
      return out({ ok: true });
    }
    // Interrupteur du chef : push du résumé du Radar le matin (désactivé par défaut).
    if (b.action === "reglage_radar") {
      const v = b.push_radar_matin ? "1" : "0";
      await db.from("wl_reglages").upsert({ cle: "push_radar_matin", valeur: v, updated_at: new Date().toISOString() }, { onConflict: "cle" });
      return out({ ok: true, push_radar_matin: v === "1" });
    }
    // Journal du soir (toute l'équipe, lecture) : ce que l'Usine a fait au batch (publiés, brief, push, réseaux, verrou) depuis 36 h.
    if (b.action === "journal") {
      const depuis = new Date(Date.now() - 36 * 3600e3).toISOString();
      const { data } = await db.from("usine_evenements").select("id,at,genre,titre,texte,donnees").in("genre", ["soir", "special"]).eq("test", false).gte("at", depuis).order("at", { ascending: true }).limit(40);
      return out({ ok: true, journal: (data || []).map((x: any) => ({ id: x.id, at: x.at, genre: x.genre, titre: x.titre || "", texte: x.texte || "", donnees: x.donnees || {} })) });
    }
    // Envois spéciaux (Best-of mensuel, Grand Format du samedi) : 14 derniers jours, lecture équipe. Le lien de programmation du
    // Best-of (il contient la clé du webhook) ne quitte jamais le serveur.
    if (b.action === "speciaux") {
      const { data } = await db.from("usine_evenements").select("id,at,titre,texte,donnees").eq("genre", "special").eq("test", false).gte("at", new Date(Date.now() - 14 * 864e5).toISOString()).order("at", { ascending: false }).limit(10);
      return out({ ok: true, speciaux: (data || []).map((x: any) => { const d = { ...(x.donnees || {}) }; const lien = !!d.lien; delete d.lien;
        return { id: x.id, at: x.at, titre: x.titre || "", texte: x.texte || "", type: d.type || "", post_id: d.post_id || "", editeur: d.post_id ? ghostUrl() + "/ghost/#/editor/post/" + d.post_id : "", programme: d.programme || d.scheduledAt || "", valide: !!d.valide_le, annule: !!d.annule_le, peut_valider: lien && !d.valide_le, donnees: d }; }) });
    }
    if (b.action === "valider_special" || b.action === "annuler_special") {
      const { data } = await db.from("usine_evenements").select("id,donnees").eq("id", Number(b.id) || 0).eq("genre", "special").limit(1);
      const ev: any = data && data[0];
      if (!ev) return out({ ok: false, why: "envoi introuvable" });
      const d = ev.donnees || {};
      if (b.action === "valider_special") {
        if (d.type !== "bestof" || !d.lien) return out({ ok: false, why: "rien à valider pour cet envoi" });
        if (d.valide_le) return out({ ok: true, deja: true, why: "déjà validé" });
        const r = await fetch(String(d.lien), { method: "GET" }).catch(() => null);
        const html = r ? await r.text().catch(() => "") : "";
        const t = (html.match(/<h1[^>]*>([^<]*)<\/h1>/i) || [])[1] || "", p2 = ((html.match(/<p>([\s\S]*?)<\/p>/i) || [])[1] || "").replace(/<[^>]+>/g, "").trim();
        const ok = !!r && r.ok && !/invalide|erreur/i.test(t);
        if (ok) await db.from("usine_evenements").update({ donnees: { ...d, valide_le: new Date().toISOString(), valide_msg: (t + " — " + p2).slice(0, 300) } }).eq("id", ev.id);
        return out({ ok, why: (t ? t + (p2 ? " : " + p2 : "") : (r ? "réponse " + r.status : "le workflow ne répond pas")).slice(0, 300) });
      }
      // Annuler le Grand Format programmé : repasse le post en brouillon (rien n'est envoyé).
      if (d.type !== "grandformat" || !/^[a-f0-9]{24}$/.test(String(d.post_id || ""))) return out({ ok: false, why: "rien à annuler pour cet envoi" });
      const pg: any = ((await ghost(`posts/${d.post_id}/?fields=id,status,updated_at`)) as any).posts?.[0];
      if (!pg) return out({ ok: false, why: "post introuvable dans Ghost" });
      if (pg.status !== "scheduled") return out({ ok: false, why: pg.status === "draft" ? "déjà annulé (brouillon)" : "déjà envoyé (" + pg.status + ")" });
      await ghostEcrire(`posts/${d.post_id}/`, "PUT", { posts: [{ status: "draft", updated_at: pg.updated_at }] });
      await db.from("usine_evenements").update({ donnees: { ...d, annule_le: new Date().toISOString() } }).eq("id", ev.id);
      return out({ ok: true, why: "Grand Format annulé : le post est repassé en brouillon" });
    }
    // Bilan des inscriptions newsletter (Meta Ads + popup) envoyé chaque soir par le workflow des inscrits : 14 derniers bilans.
    if (b.action === "inscriptions") {
      const { data } = await db.from("usine_evenements").select("id,at,titre,texte,donnees").eq("genre", "inscriptions").eq("test", false).order("at", { ascending: false }).limit(14);
      return out({ ok: true, inscriptions: (data || []).map((x: any) => ({ id: x.id, at: x.at, titre: x.titre || "", texte: x.texte || "", donnees: x.donnees || {} })) });
    }
    // Tag interne « #fini » : la journaliste signale qu'un brouillon est prêt à relire (ou le reprend). Toute l'équipe peut le poser
    // sur un brouillon ou un article programmé ; jamais sur un article publié. Les autres tags sont conservés tels quels.
    if (b.action === "fini" || b.action === "reprendre") {
      const id = String(b.post_id || "");
      if (!/^[a-f0-9]{24}$/.test(id)) return out({ ok: false, why: "article invalide" }, 400);
      const p = ((await ghost(`posts/${id}/?include=tags&formats=html`)) as any).posts?.[0];
      if (!p) return out({ ok: false, why: "article introuvable dans Ghost" });
      if (p.status === "published" || p.status === "sent") return out({ ok: false, why: "article déjà publié" });
      const tags = (p.tags || []).map((t: any) => ({ id: t.id, name: t.name, slug: t.slug }));
      const a = tags.some(estFini);
      if (b.action === "fini" && a) return out({ ok: true, fini: true, deja: true });
      if (b.action === "reprendre" && !a) return out({ ok: true, fini: false, deja: true });
      const nv = b.action === "fini" ? tags.map((t: any) => (t.id ? { id: t.id } : { name: t.name })).concat([{ name: FINI.name }]) : tags.filter((t: any) => !estFini(t)).map((t: any) => ({ id: t.id }));
      await ghostEcrire(`posts/${id}/`, "PUT", { posts: [{ tags: nv, updated_at: p.updated_at }] });
      if (b.action === "fini") {
        await noterEvenement({ genre: "fini", titre: p.title, texte: qui.nom + " a fini « " + p.title + " »", donnees: { post_id: id, membre: qui.id } });
        if (!qui.chef) await pushEquipe(await chefsIds(), "✅ " + qui.nom.split(" ")[0] + " a fini", "« " + p.title + " » est prêt à relire.", "marbre");
      }
      return out({ ok: true, fini: b.action === "fini" });
    }
    return out({ ok: false, why: "action inconnue" }, 400);
  } catch (e) {
    return out({ ok: false, why: String((e as Error)?.message || e).slice(0, 240) });
  }
});
