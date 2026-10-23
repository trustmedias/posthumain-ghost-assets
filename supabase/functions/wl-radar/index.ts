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
// Secrets Supabase : jeton Airtable (AIRTABLE_TOKEN, ou AIRTABLE_API_KEY / AIRTABLE_PAT / POSTHUMAIN_AIRTABLE_TOKEN),
// clé Admin Ghost GHOST_ADMIN_API_KEY (format id:secret) et, facultatif, GHOST_ADMIN_API_URL.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { parEmail, type Membre } from "./equipe.ts";

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
function post(p: any) {
  return { id: p.id, titre: p.title, statut: p.status, visibilite: p.visibility, image: p.feature_image || "", maj: p.updated_at, publie_le: p.published_at,
    extrait: p.custom_excerpt || "", lecture: p.reading_time || 0, url: p.url, apercu: p.uuid ? SITE + "/p/" + p.uuid + "/" : "", editeur: ghostUrl() + "/ghost/#/editor/post/" + p.id };
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
  const qui = await membre(String(b.token || "")).catch(() => null);
  if (!qui) return out({ ok: false, why: "accès réservé à l’équipe" }, 401);
  const chef = !!qui.chef;
  const ecrit = ["choisir", "decocher", "ecarter", "remettre", "imposer", "ordre", "approuver", "ecarter_brouillon", "relancer_radar"];
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
          ghost(`posts/?filter=${encodeURIComponent("status:[draft,scheduled]")}&limit=15&order=updated_at%20desc&fields=${CHAMPS_POST}`).catch((e) => ({ erreur: String(e.message || e) })),
          ghost(`posts/?filter=${encodeURIComponent(`status:published+published_at:>'${minuitZurich()}'`)}&limit=20&order=published_at%20desc&fields=${CHAMPS_POST}`).catch((e) => ({ erreur: String(e.message || e) })),
        ]);
        const brouillons = ((dr as any).posts || []).filter((p: any) => !p.email_only && !/^\s*TEST\s*[—–-]/.test(p.title || "")).map((p: any) => ({ id: "", titre: p.title, type: "", statut: "", post: post(p), social: null }));
        return out({ ok: true, chef, airtable_absent: true, brouillons, usine_ids: [], publies: ((pub as any).posts || []).filter((p: any) => !p.email_only).map(post),
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
        ids.length ? ghost(`posts/?filter=${encodeURIComponent("id:[" + ids.join(",") + "]")}&limit=all&fields=${CHAMPS_POST}`).catch((e) => ({ erreur: String(e.message || e) })) : Promise.resolve({ posts: [] }),
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
      return out({ ok: true, chef, brouillons, usine_ids, publies: ((pub as any).posts || []).filter((p: any) => !p.email_only).map(post),
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
    return out({ ok: false, why: "action inconnue" }, 400);
  } catch (e) {
    return out({ ok: false, why: String((e as Error)?.message || e).slice(0, 240) });
  }
});
