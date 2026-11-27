// Writinglab — wl-etat (27/11/2026) : l'état affiché par la page (articles en cours, fiches, interphone, courrier, prospection), lu
// DIRECTEMENT dans Supabase. Avant, chaque relecture de l'état passait par le workflow n8n « Writinglab » (mode « etat ») : une exécution
// n8n à chaque retour sur l'onglet, à chaque mail ou message, après chaque action, pour chaque page ouverte — environ 860 par mois, soit
// le premier poste du forfait n8n. La page appelle maintenant cette fonction ; n8n reste le secours si elle ne répond pas.
// Accès : jeton d'identité du membre Ghost connecté (signature vérifiée avec les clés publiques du site), membre actif de wl_equipe.
// Secrets : SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GHOST_ADMIN_API_KEY (id:secret), TV_ADMIN_SECRET (alerte « Ghost ne répond pas »
// envoyée par wl-db, comme le faisait n8n). Déploiement : index.ts, etat.ts, equipe.ts (copie de wl-db/equipe.ts).
// deno-lint-ignore-file no-explicit-any
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { equipe, type Membre } from "./equipe.ts";
import { assembler, empreinte } from "./etat.ts";

const env = (k: string) => (Deno.env.get(k) || "").trim();
const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const SITE = "https://posthumain.com";
const ORIGINES = ["https://posthumain.com", "https://www.posthumain.com"];
const BUCKET = "writinglab";
const ghostUrl = () => (env("GHOST_ADMIN_API_URL") || "https://the-last-journal.ghost.io").replace(/\/+$/g, "");

function cors(req: Request) {
  const o = req.headers.get("origin") || "";
  return { "Access-Control-Allow-Origin": ORIGINES.includes(o) ? o : ORIGINES[0], "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "content-type", "Vary": "Origin" };
}
const b64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), (c) => c.charCodeAt(0));
const b64uEnc = (b: Uint8Array | string) => btoa(typeof b === "string" ? b : String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");

// ---------- qui appelle ? (même contrôle que le nœud « Accès » de n8n, mêmes refus) ----------
let jwksCache: { at: number; keys: any[] } | null = null;
async function membre(token: string): Promise<{ moi?: Membre; refus?: string }> {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return { refus: "non connecté" };
  let header: any, payload: any;
  try { header = JSON.parse(new TextDecoder().decode(b64u(parts[0]))); payload = JSON.parse(new TextDecoder().decode(b64u(parts[1]))); } catch { return { refus: "jeton illisible" }; }
  const hashes: Record<string, string> = { RS256: "SHA-256", RS384: "SHA-384", RS512: "SHA-512" };
  if (!hashes[header.alg]) return { refus: "algorithme refusé" };
  if (!jwksCache || Date.now() - jwksCache.at > 3600e3) {
    const r = await fetch(SITE + "/members/.well-known/jwks.json", { signal: AbortSignal.timeout(8000) }).catch(() => null);
    if (!r || !r.ok) return { refus: "clés du site injoignables" };
    jwksCache = { at: Date.now(), keys: (await r.json()).keys || [] };
  }
  const jwk = jwksCache.keys.find((k: any) => !header.kid || k.kid === header.kid);
  if (!jwk) return { refus: "clé inconnue" };
  let ok = false;
  try {
    const key = await crypto.subtle.importKey("jwk", { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: header.alg, ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: hashes[header.alg] }, false, ["verify"]);
    ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64u(parts[2]), new TextEncoder().encode(parts[0] + "." + parts[1]));
  } catch { return { refus: "vérification impossible" }; }
  if (!ok) return { refus: "signature fausse" };
  if (!payload.exp || payload.exp * 1000 < Date.now()) return { refus: "jeton expiré" };
  if (payload.iss && !/^https:\/\/(posthumain\.com|the-last-journal\.ghost\.io)\//.test(String(payload.iss))) return { refus: "émetteur inconnu" };
  const email = String(payload.sub || "").toLowerCase();
  const moi = (await equipe(db)).find((m) => m.email === email);
  if (!moi) return { refus: "accès réservé" };
  if (!moi.actif) return { refus: "accès désactivé : demandez au rédacteur en chef de réactiver votre compte" };
  return { moi };
}

// ---------- Ghost : brouillons, programmés et publiés depuis 8 jours (même requête que le nœud « Ghost — brouillons ») ----------
async function ghostToken() {
  const [id, secret] = env("GHOST_ADMIN_API_KEY").split(":");
  if (!id || !secret) throw new Error("clé Admin Ghost absente");
  const now = Math.floor(Date.now() / 1000);
  const head = b64uEnc(JSON.stringify({ alg: "HS256", typ: "JWT", kid: id }));
  const body = b64uEnc(JSON.stringify({ iat: now, exp: now + 300, aud: "/admin/" }));
  const k = await crypto.subtle.importKey("raw", Uint8Array.from(secret.match(/.{2}/g)!.map((h) => parseInt(h, 16))), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(head + "." + body)));
  return head + "." + body + "." + b64uEnc(sig);
}
async function ghostBrouillons(): Promise<any> {
  try {
    const depuis = new Date(Date.now() - 8 * 864e5).toISOString().slice(0, 19).replace("T", " ");
    const filtre = "(status:[draft,scheduled],published_at:>'" + depuis + "')+tag:-videos+status:-sent";
    const r = await fetch(ghostUrl() + "/ghost/api/admin/posts/?filter=" + encodeURIComponent(filtre) + "&limit=100&order=updated_at%20desc&include=authors&fields=id,title,status,updated_at,published_at,feature_image,visibility,email_only",
      { signal: AbortSignal.timeout(20000), headers: { Authorization: "Ghost " + (await ghostToken()), "Accept-Version": "v5.0" } });
    return await r.json();
  } catch (_) { return null; }
}

// ---------- tables : même mise en forme que wl-db (createdAt / updatedAt, liens signés d'une heure) ----------
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
// Une table illisible fait échouer la lecture entière (comme dans n8n, où le nœud s'arrêtait) : la page garde alors son dernier état
// et retente par n8n, au lieu d'afficher un lab vidé de ses fiches.
async function lire(table: string, asc: boolean, limite: number) {
  const { data, error } = await db.from(table).select("*").order("created_at", { ascending: asc }).limit(limite);
  if (error) throw new Error(table + " : " + error.message);
  return await shape(data);
}

async function etatPour(moi: Membre) {
  const chef = moi.role === "chef";
  const [membres, bx, ghost, fiches, messages, courrier, campagnes, prospects] = await Promise.all([
    equipe(db, true),
    db.from("wl_boites").select("id,adresse,role,nom_affiche,actif,statut,fournisseur").order("created_at").then((r) => r.data || []),
    ghostBrouillons(),
    lire("wl_fiches", true, 1000),
    lire("wl_messages", false, 150),
    // courrier et prospection : données clients, lues seulement pour le rédacteur en chef (n8n les lisait puis les retirait)
    chef ? lire("wl_courrier", false, 200) : Promise.resolve([]),
    chef ? lire("wl_campagnes", false, 100) : Promise.resolve([]),
    chef ? lire("wl_prospects", false, 800) : Promise.resolve([]),
  ]);
  const e = assembler({ moi, membres, boites: bx, ghost, fiches, messages, courrier, campagnes, prospects });
  if (e.ghost !== "ok") alerteGhost();
  return e;
}
// Même alerte que le nœud « Alerte — Ghost » de n8n (wl-db la dédoublonne par sa clé) ; jamais bloquante.
function alerteGhost() {
  const secret = env("TV_ADMIN_SECRET"); if (!secret) return;
  fetch(env("SUPABASE_URL") + "/functions/v1/wl-db", { method: "POST", signal: AbortSignal.timeout(10000), headers: { "Content-Type": "application/json", "x-tv-secret": secret },
    body: JSON.stringify({ action: "alerte", cle: "writinglab:ghost", titre: "Ghost ne répond pas", texte: "Le Writinglab n’arrive pas à lire les brouillons Ghost : la liste des articles est vide. Vérifiez la clé Admin API Ghost dans les secrets Supabase ou l’état de Ghost." }) }).catch(() => {});
}

function safeEqual(a: string, b: string) { if (!a || a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; }

Deno.serve(async (req) => {
  const h = { ...cors(req), "Content-Type": "application/json", "Cache-Control": "no-store" };
  const out = (v: unknown, s = 200) => new Response(JSON.stringify(v), { status: s, headers: h });
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
  if (req.method !== "POST") return out({ ok: false, why: "méthode" }, 405);
  let b: any; try { b = await req.json(); } catch { return out({ ok: false, why: "requête illisible" }, 400); }
  try {
    // Contrôle (secret du tic du Correcteur, jamais la page) : empreinte de l'état d'un membre, pour le comparer à celui de n8n
    // sans sortir une seule donnée du lab.
    if (b && b.action === "empreinte") {
      const { data } = await db.from("wl_reglages").select("valeur").eq("cle", "relecture_cron_secret").limit(1);
      if (!safeEqual(String(b.secret || ""), String(data?.[0]?.valeur || ""))) return out({ ok: false, why: "accès réservé" }, 401);
      const moi = (await equipe(db, true)).find((m) => m.id === String(b.membre || ""));
      if (!moi) return out({ ok: false, why: "membre inconnu" }, 404);
      const t0 = Date.now(); const e = await etatPour(moi);
      return out({ ok: true, ms: Date.now() - t0, empreinte: await empreinte(e) });
    }
    const qui = await membre(String(b?.token || ""));
    if (!qui.moi) return out({ ok: false, refus: true, why: qui.refus || "accès réservé" }, 403);
    return out(await etatPour(qui.moi));
  } catch (e) {
    return out({ ok: false, why: "lecture impossible : " + String((e as Error)?.message || e).slice(0, 200) }, 500);
  }
});
