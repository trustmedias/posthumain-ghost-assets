// Writinglab — wl-consent : engagement de confidentialité signé par chaque journaliste à sa première connexion (23/10/2026).
// Identité : jeton du membre Ghost (signé, vérifié avec les clés publiques du site) + liste de l'équipe, comme wl-radar / wl-push.
// Le texte de l'engagement vit ICI (version + SHA-256 du texte exact) : la page affiche ce texte et la signature n'est acceptée que
// pour la version et l'empreinte courantes. signe_le = horloge du serveur (now() de Postgres), jamais celle du navigateur.
// Table wl_consentements : RLS fermée, accès uniquement par cette fonction (service role).
// Actions : etat (tout membre), signer (journaliste), liste (rédacteur en chef), signer_test / supprimer_test (rédacteur en chef :
// signature d'essai au nom « test-… », jamais au nom d'une journaliste).
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { PNG } from "npm:pngjs@7.0.0";
import { Buffer } from "node:buffer";

const env = (k: string) => (Deno.env.get(k) || "").trim();
const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const SITE = "https://posthumain.com";
const ORIGINES = ["https://posthumain.com", "https://www.posthumain.com"];
const EQUIPE: Record<string, { id: string; nom: string; role: "chef" | "journaliste"; email?: string }> = {
  "jonathan.paiano@outlook.com": { id: "jonathan", nom: "Jonathan Paiano", role: "chef" },
  "valisoan2915@gmail.com": { id: "valisoa", nom: "Valisoa Rasolofo", role: "journaliste" },
};
const PAR_ID: Record<string, { id: string; nom: string; role: string }> = Object.fromEntries(Object.values(EQUIPE).map((w) => [w.id, w]));

// Parties (23/10/2026). IDE : numéro d'entreprise suisse de Trust Medias, à renseigner ; vide = mention absente (jamais de « à compléter »).
export const IDE = "";
export const EDITEUR = "Trust Medias, Rue Johann-Aberli 15, 2503 Biel/Bienne, Suisse" + (IDE ? " (IDE " + IDE + ")" : "");
export const VERSION = "v1";
export const DATE_TEXTE = "23/10/2026";
export const TITRE = "Engagement de confidentialité — " + VERSION + " — " + DATE_TEXTE;
export const TEXTE = [
  TITRE,
  "",
  "Entre " + EDITEUR + ", éditrice de Posthumain (posthumain.com), représentée par Jonathan Paiano, et la personne signataire identifiée ci-dessous (nom saisi et adresse e-mail de son compte).",
  "",
  "Le Writinglab est la rédaction virtuelle de Posthumain : une technologie et des outils internes, développés pour Posthumain et strictement confidentiels. En y accédant, vous rejoignez un cercle restreint. Nous vous demandons une confidentialité sans faille.",
  "",
  "Ce qui est confidentiel",
  "1. L’existence même du Writinglab, son fonctionnement et son organisation.",
  "2. Les outils, les automatisations, les instructions données aux intelligences artificielles (prompts) et les enchaînements de travail.",
  "3. Les sources, les chercheurs et les contacts, ainsi que les échanges avec eux.",
  "4. Les articles et brouillons non publiés, les sujets en préparation et les choix éditoriaux.",
  "5. Les chiffres de Posthumain, les coûts, les données des abonnés et des lecteurs.",
  "6. Tous les échanges internes de la rédaction.",
  "",
  "Ce à quoi je m’engage",
  "7. Ne rien divulguer, ne rien montrer et ne rien décrire de ce qui précède, à qui que ce soit, en dehors de l’équipe de Posthumain.",
  "8. Ne faire aucune capture d’écran, photo, vidéo ni aucun enregistrement du Writinglab ou de son contenu.",
  "9. Ne jamais partager mes accès, mes mots de passe ni ma session, et ne laisser personne utiliser le Writinglab à ma place.",
  "10. N’utiliser le Writinglab et ce que j’y découvre que pour mon travail pour Posthumain.",
  "11. Prévenir Jonathan Paiano sans attendre en cas de fuite, de perte d’accès ou de doute.",
  "",
  "Durée",
  "12. Cet engagement vaut pendant toute ma collaboration avec Posthumain et après sa fin, sans limite de durée.",
  "",
  "En cas de manquement",
  "13. Tout manquement entraîne la fin immédiate de mon accès au Writinglab et de notre collaboration, et peut donner lieu à des poursuites.",
  "",
  "Droit applicable et for",
  "14. Droit applicable : droit suisse. For : Biel/Bienne.",
  "",
  "En signant, je déclare avoir lu et compris cet engagement et l’accepter sans réserve.",
].join("\n");

async function sha256(s: string) { const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)); return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join(""); }
const HASH = sha256(TEXTE);

function cors(req: Request) {
  const o = req.headers.get("origin") || "";
  return { "Access-Control-Allow-Origin": ORIGINES.includes(o) ? o : ORIGINES[0], "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "content-type", "Vary": "Origin" };
}
const b64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), (c) => c.charCodeAt(0));
let jwksCache: { at: number; keys: any[] } | null = null;
async function membre(token: string) {
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
  const sub = String(payload.sub || "").toLowerCase(), w = EQUIPE[sub];
  return w ? { ...w, email: sub } : null;
}
// Nom tapé : majuscules, accents, espaces et tirets tolérés ; tout le reste doit correspondre au nom de l'équipe.
const normNom = (s: string) => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[-\u2010\u2011\u2019']/g, " ").replace(/\s+/g, " ").trim();
// Signature : PNG décodé côté serveur ; refus d'un pavé vide ou d'un simple point (pixels encrés et étendue minimale).
function analyserSignature(dataUrl: string) {
  const m = String(dataUrl || "").match(/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/);
  if (!m) return { ok: false, why: "signature absente ou illisible" };
  if (m[1].length > 600000) return { ok: false, why: "signature trop lourde" };
  let png: any; try { png = PNG.sync.read(Buffer.from(m[1], "base64")); } catch { return { ok: false, why: "signature illisible" }; }
  const { width: w, height: h, data } = png;
  if (w < 150 || h < 60 || w > 2400 || h > 1200) return { ok: false, why: "format de signature inattendu" };
  let n = 0, x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const a = data[(y * w + x) * 4 + 3]; if (a > 60) { n++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } }
  const larg = x1 - x0 + 1, haut = y1 - y0 + 1;
  if (n < 250 || larg < w * 0.12 || (larg < w * 0.2 && haut < h * 0.2)) return { ok: false, why: "signature trop courte : signez avec votre signature habituelle" };
  return { ok: true, encre: n, etendue: [larg, haut] };
}
const ip = (req: Request) => (req.headers.get("cf-connecting-ip") || req.headers.get("x-real-ip") || String(req.headers.get("x-forwarded-for") || "").split(",")[0] || "").trim().slice(0, 80);
const zurich = (iso: string) => new Intl.DateTimeFormat("fr-CH", { timeZone: "Europe/Zurich", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(iso));
const CHAMPS = "id,journaliste_id,email,nom_saisi,signature_png,texte_version,texte_hash,signe_le,user_agent,ip,fuseau,heure_locale,test";

async function enregistrer(req: Request, b: any, id: string, nomAttendu: string, test: boolean, email: string) {
  const hash = await HASH;
  if (String(b.version || "") !== VERSION || String(b.hash || "") !== hash) return { ok: false, why: "le texte a changé : rechargez la page pour lire la version en vigueur" };
  if (b.accepte !== true) return { ok: false, why: "cochez « J’ai lu et j’accepte sans réserve cet engagement de confidentialité »" };
  if (normNom(b.nom) !== normNom(nomAttendu)) return { ok: false, why: "le nom tapé ne correspond pas à « " + nomAttendu + " »" };
  const sig = analyserSignature(b.signature);
  if (!sig.ok) return sig;
  const version = test ? "TEST-" + VERSION : VERSION;
  const { data: deja } = await db.from("wl_consentements").select(CHAMPS).eq("journaliste_id", id).eq("texte_version", version).limit(1);
  if (deja && deja[0]) return { ok: true, deja: true, consentement: deja[0], signe_le_zurich: zurich(deja[0].signe_le) };
  const row = { journaliste_id: id, email, nom_saisi: String(b.nom).trim().slice(0, 120), signature_png: String(b.signature), texte_version: version, texte_hash: hash,
    user_agent: String(req.headers.get("user-agent") || "").slice(0, 400), ip: ip(req) || null, fuseau: String(b.fuseau || "").slice(0, 80) || null, heure_locale: String(b.heure_locale || "").slice(0, 80) || null, test };
  const { data, error } = await db.from("wl_consentements").insert(row).select(CHAMPS).single();   // signe_le : default now() (serveur)
  if (error) return { ok: false, why: error.message };
  return { ok: true, consentement: data, signe_le_zurich: zurich(data.signe_le), encre: sig.encre };
}

Deno.serve(async (req) => {
  const h = { ...cors(req), "Content-Type": "application/json", "Cache-Control": "no-store" };
  if (req.method === "OPTIONS") return new Response(null, { headers: h });
  const out = (v: unknown, s = 200) => new Response(JSON.stringify(v), { status: s, headers: h });
  if (req.method !== "POST") return out({ ok: false, why: "method" }, 405);
  let b: any; try { b = await req.json(); } catch { return out({ ok: false, why: "bad_json" }, 400); }
  const me = await membre(String(b.token || "")).catch(() => null);
  if (!me) return out({ ok: false, why: "accès réservé à l’équipe" }, 401);
  const chef = me.role === "chef";
  try {
    if (b.action === "etat") {
      const requis = me.role === "journaliste";
      const { data } = requis ? await db.from("wl_consentements").select("id,signe_le,texte_version,nom_saisi").eq("journaliste_id", me.id).eq("texte_version", VERSION).limit(1) : { data: [] };
      const s = data && data[0];
      return out({ ok: true, requis, signe: s ? { ...s, signe_le_zurich: zurich(s.signe_le) } : null, version: VERSION, titre: TITRE, texte: TEXTE, hash: await HASH, nom: me.nom, id: me.id, email: me.email, editeur: EDITEUR });
    }
    if (b.action === "signer") {
      if (me.role !== "journaliste") return out({ ok: false, why: "seules les journalistes signent cet engagement" }, 403);
      return out(await enregistrer(req, b, me.id, me.nom, false, me.email || ""));
    }
    if (b.action === "signer_test") {
      if (!chef) return out({ ok: false, why: "réservé au rédacteur en chef" }, 403);
      return out(await enregistrer(req, b, "test-" + me.id, me.nom, true, me.email || ""));
    }
    if (b.action === "supprimer_test") {
      if (!chef) return out({ ok: false, why: "réservé au rédacteur en chef" }, 403);
      const { data, error } = await db.from("wl_consentements").delete().eq("test", true).like("journaliste_id", "test-%").select("id");
      if (error) return out({ ok: false, why: error.message });
      return out({ ok: true, supprimes: (data || []).length });
    }
    if (b.action === "liste") {
      if (!chef) return out({ ok: false, why: "réservé au rédacteur en chef" }, 403);
      const { data, error } = await db.from("wl_consentements").select(CHAMPS).order("signe_le", { ascending: false }).limit(200);
      if (error) return out({ ok: false, why: error.message });
      const journalistes = Object.values(PAR_ID).filter((w) => w.role === "journaliste").map((w) => ({ id: w.id, nom: w.nom }));
      return out({ ok: true, version: VERSION, titre: TITRE, texte: TEXTE, hash: await HASH, journalistes, editeur: EDITEUR,
        consentements: (data || []).map((r: any) => ({ ...r, signe_le_zurich: zurich(r.signe_le) })) });
    }
    return out({ ok: false, why: "action inconnue" }, 400);
  } catch (e) {
    return out({ ok: false, why: String((e as Error)?.message || e).slice(0, 240) });
  }
});
