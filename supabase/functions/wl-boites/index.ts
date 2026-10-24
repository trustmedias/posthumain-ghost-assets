// Writinglab — wl-boites : boîtes mail ajoutées depuis le lab (Paramètres → ✉️ Boîtes mail de la rédaction), 23/10/2026.
// Rédacteur en chef uniquement (jeton membre Ghost vérifié + table wl_equipe) : liste, test de connexion, enregistrement,
// mot de passe, rôle, activation. Mot de passe : Supabase Vault (fonctions SQL wl_boite_secret_*, service role) ; il n'est
// jamais écrit dans une table, jamais renvoyé au navigateur, jamais journalisé (aucun console.log du corps de requête).
// Test : IMAP (connexion + liste des dossiers) et SMTP (authentification seulement : aucun mail n'est envoyé).
// Relève (pg_cron toutes les 2 minutes, action « relever ») : nouveaux mails de chaque boîte active, triés comme subs@ /
// redaction@ (mêmes règles que le nœud n8n « Courrier — trier » + « Courrier — arrivée »), rangés par wl-db dans wl_courrier
// avec boite = id de la boîte → bureau de son rôle (mk / sc). La boîte n'est jamais modifiée (rien n'est marqué lu ni déplacé).
// Les 4 boîtes historiques @posthumain.com (secrets WL_SMTP_*, IMAP n8n) ne passent PAS par ici : elles sont seulement listées.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import nodemailer from "npm:nodemailer@6.9.14";
import { ImapFlow } from "npm:imapflow@1.0.164";
import { simpleParser } from "npm:mailparser@3.7.1";
import { Buffer } from "node:buffer";
import { parEmail } from "./equipe.ts";
import { ROLES, role, FOURNISSEURS, PORTS_IMAP, PORTS_SMTP, idDe } from "./boites.ts";

const env = (k: string) => (Deno.env.get(k) || "").trim();
const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const SITE = "https://posthumain.com";
const ORIGINES = ["https://posthumain.com", "https://www.posthumain.com"];
const CHAMPS = "id,adresse,fournisseur,offre,imap_host,imap_port,smtp_host,smtp_port,identifiant,role,nom_affiche,actif,statut,derniere_releve,derniere_erreur,erreur_depuis,dernier_test,created_at,updated_at";
// Boîtes historiques : lecture seule (configurées dans les secrets Supabase WL_SMTP_* et les nœuds IMAP n8n).
const LEGACY = [
  { cle: "jonathan", adresse: "jonathan.paiano@posthumain.com", role: "Boîte de Jonathan Paiano (interviews)" },
  { cle: "valisoa", adresse: "valisoa.rasolofo@posthumain.com", role: "Boîte de Valisoa Rasolofo (interviews)" },
  { cle: "subs", adresse: "subs@posthumain.com", role: "Service client — Julien" },
  { cle: "redaction", adresse: "redaction@posthumain.com", role: "Marketing — Julien" },
];

function cors(req: Request) {
  const o = req.headers.get("origin") || "";
  return { "Access-Control-Allow-Origin": ORIGINES.includes(o) ? o : ORIGINES[0], "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "content-type", "Vary": "Origin" };
}
function egal(a: string, b: string) { if (!a || a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; }
const b64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), (c) => c.charCodeAt(0));
// deno-lint-ignore no-explicit-any
let jwksCache: { at: number; keys: any[] } | null = null;
async function membre(token: string) {
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

// ---------- Vault ----------
async function lireSecret(id: string): Promise<string> {
  const { data, error } = await db.rpc("wl_boite_secret_lire", { p_secret_id: id });
  if (error || !data) throw new Error("mot de passe introuvable dans le coffre");
  return String(data);
}
async function ecrireSecret(id: string | null, nom: string, mdp: string): Promise<string> {
  const { data, error } = await db.rpc("wl_boite_secret_ecrire", { p_secret_id: id, p_nom: nom, p_mdp: mdp });
  if (error || !data) throw new Error("coffre : enregistrement impossible");
  return String(data);
}

// ---------- Réglages et test ----------
type Cfg = { adresse: string; identifiant: string; imap_host: string; imap_port: number; smtp_host: string; smtp_port: number };
const HOTE = /^(?=.{3,120}$)[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
// deno-lint-ignore no-explicit-any
function lireCfg(b: any): { ok: true; cfg: Cfg; fournisseur: string; offre: string } | { ok: false; why: string } {
  const adresse = String(b.adresse || "").toLowerCase().trim();
  if (!/^[^\s@<>]+@[^\s@<>]+\.[a-z]{2,}$/i.test(adresse) || adresse.length > 200) return { ok: false, why: "adresse e-mail invalide" };
  if (LEGACY.some((l) => l.adresse === adresse)) return { ok: false, why: "cette adresse est une boîte système, déjà configurée" };
  const fournisseur = FOURNISSEURS[b.fournisseur] ? String(b.fournisseur) : "autre";
  const offre = String(b.offre || "").slice(0, 30);
  const imap_host = String(b.imap_host || "").toLowerCase().trim(), smtp_host = String(b.smtp_host || "").toLowerCase().trim();
  const imap_port = Number(b.imap_port), smtp_port = Number(b.smtp_port);
  if (!HOTE.test(imap_host)) return { ok: false, why: "serveur IMAP invalide" };
  if (!HOTE.test(smtp_host)) return { ok: false, why: "serveur SMTP invalide" };
  if (!PORTS_IMAP.includes(imap_port)) return { ok: false, why: "port IMAP non pris en charge (993 conseillé)" };
  if (!PORTS_SMTP.includes(smtp_port)) return { ok: false, why: "port SMTP non pris en charge (465 conseillé)" };
  const identifiant = String(b.identifiant || "").trim().slice(0, 200) || adresse;
  return { ok: true, cfg: { adresse, identifiant, imap_host, imap_port, smtp_host, smtp_port }, fournisseur, offre };
}
// Message compréhensible, sans jamais reprendre le mot de passe.
// deno-lint-ignore no-explicit-any
function humain(e: any, quoi: "IMAP" | "SMTP", hote: string, port: number) {
  const m = String((e && (e.responseText || e.response || e.message)) || e || "");
  const code = String((e && (e.code || e.serverResponseCode)) || "");
  if (/^timeout : /.test(m)) return "Relève " + quoi + " bloquée à l’étape « " + m.slice(10) + " » (le serveur " + hote + " ne répond plus) : nouvel essai dans 2 minutes.";
  if ((e && e.authenticationFailed) || code === "EAUTH" || /AUTHENTICATIONFAILED|authentication failed|invalid credentials|LOGIN failed|\b535\b|auth(entication)? (failed|error)|incorrect (password|username)/i.test(m))
    return "Mot de passe refusé par le serveur " + quoi + " (vérifiez le mot de passe et l’identifiant, et que l’accès " + quoi + " externe est autorisé pour cette adresse).";
  if (/ENOTFOUND|getaddrinfo|Name or service not known|dns/i.test(code + " " + m)) return "Serveur " + quoi + " « " + hote + " » introuvable : vérifiez son nom.";
  if (/certificate|self.signed|altname|CERT_|SSL|TLS/i.test(code + " " + m)) return "Connexion chiffrée " + quoi + " impossible avec " + hote + ":" + port + " (certificat ou chiffrement refusé) : vérifiez le serveur et le port.";
  if (/ECONNREFUSED|ETIMEDOUT|ECONNRESET|timeout|timed out|Connection closed|EHOSTUNREACH|ENETUNREACH|socket/i.test(code + " " + m) || (quoi === "SMTP" && port === 587))
    return "Serveur " + quoi + " " + hote + ":" + port + " injoignable (délai dépassé ou port fermé)" + (port === 587 ? " : le port 587 est refusé par l’hébergement du lab, utilisez 465 (SSL)." : ".");
  return "Erreur " + quoi + " : " + m.replace(/\s+/g, " ").slice(0, 160);
}
const DELAIS = { connectionTimeout: 10000, greetingTimeout: 8000, socketTimeout: 20000 };
// 24/10/2026 : sans compression IMAP (COMPRESS=DEFLATE, proposée par OVH) ni IDLE automatique : dans l'environnement des fonctions,
// le flux compressé restait parfois bloqué au milieu d'une réponse (lecture d'un mail ou même d'un en-tête qui ne finit jamais).
const IMAP_OPTS = { disableCompression: true, disableAutoIdle: true };
async function testImap(c: Cfg, pass: string) {
  const cl = new ImapFlow({ host: c.imap_host, port: c.imap_port, secure: c.imap_port === 993, auth: { user: c.identifiant, pass }, logger: false, ...DELAIS, ...IMAP_OPTS });
  try {
    await cl.connect();
    const l = await cl.list();
    return { ok: true, dossiers: l.length, envoyes: !!l.find((x: { specialUse?: string }) => x.specialUse === "\\Sent") };
  } catch (e) { return { ok: false, why: humain(e, "IMAP", c.imap_host, c.imap_port) }; }
  finally { try { await cl.logout(); } catch (_) { /* déjà fermé */ } }
}
async function testSmtp(c: Cfg, pass: string) {
  if (c.smtp_port === 587) return { ok: false, why: humain(null, "SMTP", c.smtp_host, 587) };
  const t = nodemailer.createTransport({ host: c.smtp_host, port: c.smtp_port, secure: c.smtp_port === 465, auth: { user: c.identifiant, pass }, ...DELAIS });
  try { await t.verify(); return { ok: true }; } // EHLO + AUTH, rien n'est envoyé
  catch (e) { return { ok: false, why: humain(e, "SMTP", c.smtp_host, c.smtp_port) }; }
  finally { try { t.close(); } catch (_) { /* rien */ } }
}
async function tester(c: Cfg, pass: string) {
  const [imap, smtp] = await Promise.all([testImap(c, pass), testSmtp(c, pass)]);
  return { ok: imap.ok && smtp.ok, imap, smtp };
}
const cfgDe = (r: Record<string, unknown>): Cfg => ({ adresse: String(r.adresse), identifiant: String(r.identifiant || r.adresse), imap_host: String(r.imap_host), imap_port: Number(r.imap_port), smtp_host: String(r.smtp_host), smtp_port: Number(r.smtp_port) });

// ---------- Relève ----------
const ADR_LEGACY = LEGACY.map((l) => l.adresse);
const AUTO = /^(no-?reply|do-?not-?reply|mailer-daemon|postmaster|notifications?|notify|alerts?|bounces?|news(letter)?|marketing|updates?|digest)([+._-][^@]*)?@/;
const DOMS = /(^|\.)(stripe\.com|ghost\.(io|org)|infomaniak\.(com|ch)|google\.com|googlemail\.com|facebookmail\.com|meta\.com|linkedin\.com|x\.com|twitter\.com|tiktok\.com|youtube\.com|substack\.com|mailchimp\.com|mcsv\.net|sendgrid\.net|amazonses\.com|n8n\.(io|cloud)|github\.com|apple\.com|paypal\.com|postiz\.com|bunny\.net|openai\.com|anthropic\.com|airtable\.com|supabase\.(io|com)|vercel\.com|cloudflare\.com|ovh\.(net|com))$/;
const KW: Record<string, RegExp> = {
  subs: /abonn|r[ée]sili|d[ée]sabonn|d[ée]sinscri|rembours|factur|re[çc]u|carte|paiement|pay[ée]|pr[ée]l[èe]v|d[ée]bit|connexion|connecter|lien magique|acc[eè]s|accéder|compte|mot de passe|newsletter|premium|prix|tarif|essai|annul|cancel|refund|subscri|login|invoice|charge|cadeau/,
  redaction: /partenariat|sponsor|collaborat|article|publi|tarif|prix|devis|m[ée]dia ?kit|presse|communiqu|interview|placement|backlink|netlinking|campagne|annonce|marque|brand|partnership|guest post|advertis|rates|pricing|contenu|r[ée]daction/,
};
const strip = (h: string) => String(h || "").replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li|h[1-6])>/gi, "\n")
  .replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "’").replace(/&quot;/g, '"');
async function sha16(s: string) { const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)); return [...new Uint8Array(h)].map((x) => x.toString(16).padStart(2, "0")).join("").slice(0, 16); }
const b64e = (b: Uint8Array | string) => btoa(typeof b === "string" ? b : String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
async function ghostMembre(email: string) {
  const [id, secret] = env("GHOST_ADMIN_API_KEY").split(":");
  if (!id || !secret || !email) return null;
  try {
    const now = Math.floor(Date.now() / 1000);
    const head = b64e(JSON.stringify({ alg: "HS256", typ: "JWT", kid: id })), body = b64e(JSON.stringify({ iat: now, exp: now + 300, aud: "/admin/" }));
    const k = await crypto.subtle.importKey("raw", Uint8Array.from(secret.match(/.{2}/g)!.map((h) => parseInt(h, 16))), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(head + "." + body)));
    const url = (env("GHOST_ADMIN_API_URL") || "https://the-last-journal.ghost.io").replace(/\/+$/g, "") + "/ghost/api/admin/members/?limit=1&filter=" + encodeURIComponent("email:'" + email.replace(/'/g, "") + "'");
    const r = await fetch(url, { headers: { Authorization: "Ghost " + head + "." + body + "." + b64e(sig), "Accept-Version": "v5.0" }, signal: AbortSignal.timeout(12000) });
    if (!r.ok) return null;
    return ((await r.json()).members || [])[0] || null;
  } catch (_) { return null; }
}
async function wlDb(b: unknown) {
  const r = await fetch(env("SUPABASE_URL") + "/functions/v1/wl-db", { method: "POST", headers: { "Content-Type": "application/json", "x-tv-secret": env("TV_ADMIN_SECRET") }, body: JSON.stringify(b), signal: AbortSignal.timeout(50000) });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j || (j as { error?: string }).error) throw new Error("wl-db : " + String((j && JSON.stringify(j).slice(0, 160)) || r.status));
  return j;
}
async function telegram(texte: string) {
  const t = env("TELEGRAM_BOT_TOKEN"); if (!t) return;
  await fetch("https://api.telegram.org/bot" + t + "/sendMessage", { method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(8000),
    body: JSON.stringify({ chat_id: 8382186188, text: texte, disable_web_page_preview: true }) }).catch(() => null);
}
// deno-lint-ignore no-explicit-any
async function trier(box: any, raw: Uint8Array, adresses: string[]) {
  // mailparser attend un Buffer Node (un Uint8Array brut est pris pour un flux : « input.once is not a function »)
  const p = await simpleParser(Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength), { skipImageLinks: true, skipTextToHtml: true });
  const fromV = (p.from && p.from.value && p.from.value[0]) || { address: "", name: "" };
  const de_email = String(fromV.address || "").toLowerCase().trim();
  const de_nom = String(fromV.name || "").replace(/["']/g, "").trim() || de_email;
  const sujet = String(p.subject || "").slice(0, 300);
  let texte = String(p.text || "") || strip(String(p.html || ""));
  const cut = texte.search(/\n[^\n]{0,40}(Le .{5,90} a écrit ?:|On .{5,140} wrote:|-{3,} ?(Original Message|Message d’origine|Message d'origine))/i);
  if (cut > 0) texte = texte.slice(0, cut);
  texte = texte.replace(/\r/g, "").split("\n").filter((l) => !/^\s*>/.test(l)).join("\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, 20000);
  const H = (k: string) => { const v = p.headers.get(k); return v == null ? "" : typeof v === "string" ? v : JSON.stringify(v); };
  const message_id = String(p.messageId || "").trim();
  const d = p.date ? new Date(p.date) : new Date();
  const recu_le = (isNaN(d.getTime()) ? new Date() : d).toISOString();
  const mail_id = "m" + await sha16(message_id || (de_email + "|" + sujet + "|" + recu_le));
  const refs = ([] as string[]).concat(p.references || []).concat(p.inReplyTo ? [p.inReplyTo] : []).join(" ").trim().split(/\s+/).filter(Boolean).slice(-20).join(" ");
  const pieces: { nom: string; type: string; data: string }[] = [];
  for (const a of p.attachments || []) {
    if (pieces.length >= 5) break;
    const type = String(a.contentType || "application/octet-stream"), size = a.content ? a.content.length : 0;
    if (!size || size > 10 * 1024 * 1024 || (/^image\//.test(type) && size < 15000)) continue;
    pieces.push({ nom: String(a.filename || "fichier").slice(0, 200), type, data: a.content.toString("base64") });
  }
  const tri = (role(box.role) || {}).tri || "redaction";
  const dom = de_email.split("@")[1] || "";
  let categorie = "", motif = "";
  if (!de_email) { categorie = "ecarte"; motif = "expéditeur illisible"; }
  else if (adresses.includes(de_email)) { categorie = "ecarte"; motif = "envoyé par nous-mêmes"; }
  else if (AUTO.test(de_email)) { categorie = "ecarte"; motif = "adresse automatique"; }
  else if (DOMS.test(dom)) { categorie = "ecarte"; motif = "notification de service (" + dom + ")"; }
  else if (H("list-unsubscribe") || H("list-id") || /bulk|list|junk/i.test(H("precedence"))) { categorie = "ecarte"; motif = "envoi de masse (newsletter)"; }
  else if (/auto-(replied|generated)/i.test(H("auto-submitted")) || /^(r[ée]ponse automatique|automatic reply|auto[- ]?reply|out of office|absen|abwesenheit)/i.test(sujet)) { categorie = "ecarte"; motif = "réponse automatique"; }
  else if (KW[tri].test((sujet + " " + texte).toLowerCase())) { categorie = "demande"; motif = "mots-clés " + (tri === "subs" ? "abonnement" : "partenariat"); }
  else { categorie = "verifier"; motif = "aucun mot-clé reconnu"; }
  if (categorie === "ecarte") return { mail_id, ignore: motif };
  const mem = await ghostMembre(de_email);
  const abonne = mem ? (mem.status === "free" ? "gratuit" : "oui") : "non";
  if (categorie === "verifier" && mem) { categorie = "demande"; motif = "expéditeur membre Posthumain"; }
  return { mail_id, row: { mail_id, boite: box.id, de_email, de_nom, sujet, texte, recu_le, categorie, motif, abonne, statut: "nouveau", message_id, refs,
    membre_id: mem ? mem.id : "", pieces_upload: pieces, historique: JSON.stringify([{ t: recu_le, e: "reçu", par: "courrier" }]) } };
}
// 24/10/2026 : chaque étape a un délai maximum. Avant, une relève pouvait rester bloquée (IMAP muet) jusqu'à ce que la fonction
// soit coupée : aucune erreur écrite, verrou jamais levé, boîte jamais relevée (info@trustmedias.com, 23/10). Le dernier mail
// traité est aussi enregistré au fur et à mesure : une relève coupée ne repart pas de zéro.
function etape<T>(nom: string, p: Promise<T>, ms = 25000): Promise<T> {
  let t: number | undefined;
  return Promise.race([p, new Promise<T>((_, rej) => { t = setTimeout(() => rej(new Error("timeout : " + nom)), ms); })]).finally(() => clearTimeout(t));
}
// 24/10/2026 : client IMAP minimal en Deno natif (Deno.connectTls) pour la RELÈVE. Avec imapflow (couche de compatibilité Node),
// les petites réponses passaient mais la lecture du contenu d'un mail ne finissait jamais dans l'environnement des fonctions, même
// sans compression et par morceaux de 16 Ko (info@trustmedias.com, OVH). Lecture seule : SELECT + UID SEARCH + UID FETCH
// BODY.PEEK (rien n'est marqué lu ni déplacé). Chaque lecture sur le réseau a son délai maximum. Le test de connexion
// (Paramètres) garde imapflow, qui fonctionne pour la connexion et la liste des dossiers.
const ENC = new TextEncoder(), DEC = new TextDecoder();
const qImap = (s: string) => '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
const MOIS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
class ImapNatif {
  private conn!: Deno.Conn;
  private buf = new Uint8Array(0);
  private n = 0;
  constructor(private host: string, private port: number) {}
  private async plus(quoi: string, ms: number) {
    const m = new Uint8Array(65536);
    const lu = await etape(quoi, this.conn.read(m), ms);
    if (lu === null) throw new Error("Connection closed (" + quoi + ")");
    const nb = new Uint8Array(this.buf.length + lu); nb.set(this.buf); nb.set(m.subarray(0, lu), this.buf.length); this.buf = nb;
  }
  private async ligne(quoi: string, ms: number): Promise<string> {
    for (;;) {
      for (let i = 0; i + 1 < this.buf.length; i++) if (this.buf[i] === 13 && this.buf[i + 1] === 10) { const l = DEC.decode(this.buf.subarray(0, i)); this.buf = this.buf.slice(i + 2); return l; }
      await this.plus(quoi, ms);
    }
  }
  private async octets(n: number, quoi: string, ms: number): Promise<Uint8Array> {
    while (this.buf.length < n) await this.plus(quoi, ms);
    const b = this.buf.slice(0, n); this.buf = this.buf.slice(n); return b;
  }
  private async ecrire(s: string, quoi: string) { const b = ENC.encode(s); let k = 0; while (k < b.length) k += await etape(quoi, this.conn.write(b.subarray(k)), 15000); }
  // Une commande : lignes non étiquetées (littéraux remplacés par \0LITn\0) et littéraux ; erreur si le serveur ne répond pas OK.
  async cmd(c: string, quoi: string, ms = 20000): Promise<{ lignes: string[]; lits: Uint8Array[] }> {
    const tag = "W" + (++this.n), lignes: string[] = [], lits: Uint8Array[] = [];
    await this.ecrire(tag + " " + c + "\r\n", quoi);
    for (;;) {
      let l = await this.ligne(quoi, ms);
      if (l.startsWith(tag + " ")) { if (!/^\S+ OK/i.test(l)) throw new Error(l.slice(tag.length + 1, tag.length + 200)); return { lignes, lits }; }
      let m: RegExpMatchArray | null;
      while ((m = l.match(/\{(\d+)\}$/))) { lits.push(await this.octets(Number(m[1]), quoi, ms)); l = l.slice(0, -m[0].length) + "\u0000LIT" + (lits.length - 1) + "\u0000" + await this.ligne(quoi, ms); }
      lignes.push(l);
    }
  }
  async ouvrir(user: string, pass: string) {
    if (this.port === 993) this.conn = await etape("connexion", Deno.connectTls({ hostname: this.host, port: this.port }), 12000);
    else this.conn = await etape("connexion", Deno.connect({ hostname: this.host, port: this.port }), 12000);
    const g = await this.ligne("accueil du serveur", 10000);
    if (!/^\* (OK|PREAUTH)/i.test(g)) throw new Error("accueil IMAP inattendu : " + g.slice(0, 120));
    if (this.port !== 993) { await this.cmd("STARTTLS", "chiffrement"); this.conn = await etape("chiffrement", Deno.startTls(this.conn as Deno.TcpConn, { hostname: this.host }), 12000); this.buf = new Uint8Array(0); }
    try { await this.cmd("LOGIN " + qImap(user) + " " + qImap(pass), "connexion"); }
    catch (e) { const err = new Error("AUTHENTICATIONFAILED " + String((e as Error).message || "")); throw /^timeout : /.test(String((e as Error).message)) ? e : err; }
  }
  async inbox() {
    const r = await this.cmd("EXAMINE INBOX", "ouverture de la boîte de réception"); // lecture seule
    const t = r.lignes.join("\n");
    return { uidValidity: Number((t.match(/UIDVALIDITY (\d+)/i) || [])[1] || 0), uidNext: Number((t.match(/UIDNEXT (\d+)/i) || [])[1] || 0) };
  }
  async chercher(critere: string): Promise<number[]> {
    const r = await this.cmd("UID SEARCH " + critere, "recherche des mails");
    const out: number[] = [];
    for (const l of r.lignes) if (/^\* SEARCH\b/i.test(l)) for (const x of l.slice(8).trim().split(/\s+/)) if (/^\d+$/.test(x)) out.push(Number(x));
    return out;
  }
  // En-têtes de tri et taille, sans télécharger le mail.
  async entete(uid: number): Promise<{ taille: number; headers: string } | null> {
    const r = await this.cmd("UID FETCH " + uid + " (UID RFC822.SIZE BODY.PEEK[HEADER.FIELDS (FROM LIST-UNSUBSCRIBE LIST-ID PRECEDENCE AUTO-SUBMITTED)])", "lecture d'un en-tête");
    const l = r.lignes.find((x) => /FETCH \(/i.test(x) && new RegExp("UID " + uid + "\\b").test(x));
    if (!l) return null;
    const k = (l.match(/\u0000LIT(\d+)\u0000/) || [])[1];
    return { taille: Number((l.match(/RFC822\.SIZE (\d+)/i) || [])[1] || 0), headers: k == null ? "" : DEC.decode(r.lits[Number(k)]) };
  }
  // Le mail brut, tronqué à max octets (BODY.PEEK[]<0.max>).
  async source(uid: number, max: number): Promise<Uint8Array> {
    const r = await this.cmd("UID FETCH " + uid + " (UID BODY.PEEK[]<0." + max + ">)", "lecture d'un mail", 25000);
    const l = r.lignes.find((x) => /FETCH \(/i.test(x) && /\u0000LIT\d+\u0000/.test(x) && new RegExp("UID " + uid + "\\b").test(x)) || r.lignes.find((x) => /BODY\[\]/i.test(x) && /\u0000LIT\d+\u0000/.test(x));
    const k = l ? (l.match(/\u0000LIT(\d+)\u0000/) || [])[1] : null;
    return k == null ? new Uint8Array(0) : r.lits[Number(k)];
  }
  async fermer() { try { await etape("déconnexion", this.cmd("LOGOUT", "déconnexion", 4000), 5000); } catch (_) { /* rien */ } try { this.conn.close(); } catch (_) { /* déjà fermé */ } }
}
// deno-lint-ignore no-explicit-any
async function releverBoite(box: any, adresses: string[]) {
  const now = new Date().toISOString(), avant = new Date(Date.now() - 3 * 60e3).toISOString();
  const { data: pris } = await db.from("wl_boites").update({ releve_verrou: now }).eq("id", box.id).or("releve_verrou.is.null,releve_verrou.lt." + avant).select("id");
  if (!pris || !pris.length) return { id: box.id, saute: "relève déjà en cours" };
  let dernier = box.dernier_uid == null ? null : Number(box.dernier_uid), validite = box.uid_validity, nouveaux = 0, ignores = 0;
  const c = new ImapNatif(box.imap_host, Number(box.imap_port));
  try {
    await c.ouvrir(box.identifiant || box.adresse, await lireSecret(box.secret_id));
    {
      const mb = await c.inbox();
      if (validite != null && String(mb.uidValidity) !== String(validite)) dernier = null; // boîte recréée côté serveur : on repart des derniers jours
      validite = Number(mb.uidValidity);
      let uids: number[];
      if (dernier == null) { const d = new Date(Date.now() - 7 * 864e5); uids = (await c.chercher("SINCE " + d.getUTCDate() + "-" + MOIS[d.getUTCMonth()] + "-" + d.getUTCFullYear())).slice(-40); } // première relève : 7 derniers jours, 40 mails au plus
      else uids = (await c.chercher("UID " + (dernier + 1) + ":*")).filter((u: number) => u > (dernier as number));
      uids = uids.sort((a, b) => a - b).slice(0, 8); // 8 mails par passage au plus (toutes les 2 minutes), pour rester loin du délai de la fonction
      if (!uids.length && dernier == null) dernier = Math.max(0, Number(mb.uidNext || 1) - 1);
      const deja = new Set<string>();
      // Un passage précédent coupé net sur un mail (trop lourd à lire ou à trier) : on le saute, sinon la boîte resterait bloquée dessus.
      const coupe = box.releve_en_cours == null ? null : Number(box.releve_en_cours);
      for (const uid of uids) {
        if (coupe != null && uid === coupe) { dernier = uid; ignores++; await db.from("wl_boites").update({ dernier_uid: dernier, uid_validity: validite, releve_en_cours: null }).eq("id", box.id); continue; }
        await db.from("wl_boites").update({ releve_en_cours: uid }).eq("id", box.id);
        // 24/10/2026 : d'abord l'enveloppe et les en-têtes de tri (léger) ; un mail automatique ou une newsletter est écarté sans
        // télécharger son contenu. Ensuite seulement le mail, limité à 600 Ko (la lecture d'un gros mail entier bloquait la relève).
        const e = await c.entete(uid);
        const hd = e ? e.headers : "";
        const fromL = ((hd.match(/^from:(.*(?:\r?\n[ \t].*)*)/im) || [])[1] || "");
        const exp = String((fromL.match(/<([^<>\s]+@[^<>\s]+)>/) || fromL.match(/([^\s<>"',;:()]+@[^\s<>"',;:()]+)/) || [])[1] || "").toLowerCase();
        if (!e || (exp && (adresses.includes(exp) || AUTO.test(exp) || DOMS.test(exp.split("@")[1] || ""))) || /^(list-unsubscribe|list-id)\s*:/im.test(hd) || /^precedence\s*:\s*(bulk|list|junk)/im.test(hd) || /^auto-submitted\s*:\s*auto-/im.test(hd)) {
          dernier = uid; ignores++; await db.from("wl_boites").update({ dernier_uid: dernier, uid_validity: validite, releve_en_cours: null }).eq("id", box.id); continue;
        }
        const MAX = 600 * 1024, gros = !!(e.taille && e.taille > MAX);
        const src = await c.source(uid, MAX);
        if (!src.length) { dernier = uid; ignores++; continue; }
        const t = await etape("tri d'un mail", trier(box, src, adresses), 30000);
        if (gros && t.row) { t.row.texte = (t.row.texte ? t.row.texte + "\n\n" : "") + "[Mail volumineux (" + Math.round(Number(e.taille) / 1024 / 1024 * 10) / 10 + " Mo) : pièces jointes non récupérées, voir la boîte " + box.adresse + ".]"; t.row.pieces_upload = []; }
        if (t.row && !deja.has(t.mail_id)) {
          const { data: ex } = await db.from("wl_courrier").select("mail_id").eq("mail_id", t.mail_id).limit(1);
          if (!ex || !ex.length) {
            await etape("rangement d'un mail", wlDb({ action: "upsert", table: "courrier", row: t.row }), 40000); // push, temps réel (wl_signal), pièces jointes : comme le chemin n8n
            nouveaux++;
            if (t.row.categorie === "demande") {
              const r = role(box.role);
              await telegram("📩 Nouvelle demande pour " + (r ? r.nom : "Julien") + " (" + box.adresse + ")\nDe : " + t.row.de_nom + " (" + t.row.de_email + ")" + (t.row.abonne === "oui" ? " · abonné" : t.row.abonne === "gratuit" ? " · membre gratuit" : "") + "\nObjet : " + (t.row.sujet || "(sans objet)") + "\n\nhttps://posthumain.com/writinglab/");
            }
          }
          deja.add(t.mail_id);
        } else ignores++;
        dernier = uid;
        await db.from("wl_boites").update({ dernier_uid: dernier, uid_validity: validite, releve_en_cours: null }).eq("id", box.id); // progression gardée
      }
    }
    await db.from("wl_boites").update({ dernier_uid: dernier, uid_validity: validite, derniere_releve: new Date().toISOString(), statut: "ok", derniere_erreur: null, erreur_depuis: null, releve_verrou: null, releve_en_cours: null }).eq("id", box.id);
    return { id: box.id, nouveaux, ignores };
  } catch (e) {
    const why = humain(e, "IMAP", box.imap_host, box.imap_port);
    await db.from("wl_boites").update({ dernier_uid: dernier, uid_validity: validite, statut: "erreur", derniere_erreur: why, erreur_depuis: box.erreur_depuis || new Date().toISOString(), releve_verrou: null }).eq("id", box.id); // releve_en_cours gardé : le mail fautif sera sauté au prochain passage
    await wlDb({ action: "alerte", cle: "wl-boites:" + box.id, titre: "relève " + box.adresse, texte: "La boîte " + box.adresse + " n’a pas pu être relevée : " + why + " (Paramètres → Boîtes mail de la rédaction)." }).catch(() => null);
    return { id: box.id, erreur: why };
  } finally { await c.fermer(); }
}
async function releverTout() {
  const { data } = await db.from("wl_boites").select("*").eq("actif", true).not("secret_id", "is", null);
  const boites = data || [];
  const adresses = ADR_LEGACY.concat(boites.map((b) => String(b.adresse)));
  const res = [];
  for (const b of boites) res.push(await releverBoite(b, adresses));
  return { ok: true, resultats: res };
}

// ---------- API ----------
// deno-lint-ignore no-explicit-any
const pub = (r: any) => { const o = { ...r }; delete o.secret_id; delete o.releve_verrou; delete o.releve_en_cours; delete o.uid_validity; delete o.dernier_uid; return o; };
async function liste() {
  const [{ data: bs }, { data: cs }] = await Promise.all([
    db.from("wl_boites").select(CHAMPS).order("created_at"),
    db.from("wl_courrier").select("boite,recu_le").in("boite", ["subs", "redaction"]).order("recu_le", { ascending: false }).limit(200),
  ]);
  const dernier: Record<string, string> = {}; for (const c of cs || []) if (!dernier[c.boite]) dernier[c.boite] = c.recu_le;
  return { ok: true, boites: (bs || []).map(pub), roles: ROLES, fournisseurs: FOURNISSEURS,
    legacy: LEGACY.map((l) => ({ ...l, fournisseur: "Infomaniak", releve: "n8n (IMAP)", envoi: "wl-mail (secrets Supabase)", dernier_mail: dernier[l.cle] || null })) };
}

Deno.serve(async (req) => {
  const h = { ...cors(req), "Content-Type": "application/json", "Cache-Control": "no-store" };
  if (req.method === "OPTIONS") return new Response(null, { headers: h });
  const out = (v: unknown, s = 200) => new Response(JSON.stringify(v), { status: s, headers: h });
  if (req.method !== "POST") return out({ ok: false, why: "method" }, 405);
  // deno-lint-ignore no-explicit-any
  let b: any; try { b = await req.json(); } catch { return out({ ok: false, why: "bad_json" }, 400); }
  try {
    // pg_cron (secret dans wl_reglages) ou n8n (x-tv-secret) : relève
    if (b.action === "relever") {
      const { data: s } = await db.from("wl_reglages").select("valeur").eq("cle", "boites_cron_secret").limit(1);
      const okCron = egal(String(b.secret || ""), String((s && s[0] && s[0].valeur) || "")), okSrv = egal(req.headers.get("x-tv-secret") || "", env("TV_ADMIN_SECRET"));
      if (!okCron && !okSrv) return out({ ok: false, why: "unauthorized" }, 401);
      return out(await releverTout());
    }
    const me = await membre(String(b.token || "")).catch(() => null);
    if (!me) return out({ ok: false, why: "accès réservé à l’équipe" }, 401);
    if (!me.chef) return out({ ok: false, why: "réservé au rédacteur en chef" }, 403);
    if (b.action === "liste") return out(await liste());
    // Contrôle SANS ENVOI du chemin d'envoi wl-mail : mail volontairement incomplet (aucun destinataire), donc refusé
    // avant toute composition. Réponse attendue : « mail incomplet » pour une boîte connue dont le mot de passe est trouvé,
    // « expéditeur refusé » pour une adresse inconnue. Sert à comparer avant / après une modification de wl-mail.
    if (b.action === "diag_envoi") {
      const essai = async (from: string) => {
        const r = await fetch(env("SUPABASE_URL") + "/functions/v1/wl-mail", { method: "POST", headers: { "Content-Type": "application/json", "x-tv-secret": env("TV_ADMIN_SECRET") }, body: JSON.stringify({ from }), signal: AbortSignal.timeout(20000) });
        return (await r.json().catch(() => ({ why: "illisible " + r.status }))).why;
      };
      const adr = LEGACY.map((l) => l.adresse).concat(["inconnu@example.invalid"]).concat(((await db.from("wl_boites").select("adresse").eq("actif", true)).data || []).map((x) => String(x.adresse)));
      const res: Record<string, string> = {};
      for (const a of adr) res[a] = await essai(a);
      return out({ ok: true, wl_mail: res, telegram: !!env("TELEGRAM_BOT_TOKEN"), ghost: !!env("GHOST_ADMIN_API_KEY") });
    }

    if (b.action === "tester") { // assistant, étape 2 : rien n'est enregistré
      const c = lireCfg(b); if (!c.ok) return out(c);
      const mdp = String(b.mdp || ""); if (!mdp) return out({ ok: false, why: "mot de passe manquant" });
      return out(await tester(c.cfg, mdp));
    }
    if (b.action === "enregistrer") { // assistant, étape 4 : nouveau test, puis coffre + table
      const c = lireCfg(b); if (!c.ok) return out(c);
      const mdp = String(b.mdp || ""); if (!mdp) return out({ ok: false, why: "mot de passe manquant" });
      const r = role(String(b.role || "")); if (!r || !r.actif) return out({ ok: false, why: "rôle indisponible" });
      const id = idDe(c.cfg.adresse);
      const { data: ex } = await db.from("wl_boites").select("id").eq("id", id).limit(1);
      if (ex && ex.length) return out({ ok: false, why: "cette adresse est déjà enregistrée : changez son mot de passe ou réactivez-la dans la liste" });
      const t = await tester(c.cfg, mdp);
      if (!t.ok) return out({ ok: false, why: "la connexion ne passe plus : " + (t.imap.ok ? "" : t.imap.why + " ") + (t.smtp.ok ? "" : t.smtp.why), test: t });
      const secret_id = await ecrireSecret(null, "wl_boite:" + id, mdp);
      const now = new Date().toISOString();
      const { error } = await db.from("wl_boites").insert({ id, ...c.cfg, fournisseur: c.fournisseur, offre: c.offre, secret_id, role: r.id, nom_affiche: String(b.nom_affiche || "").replace(/["<>\r\n]/g, "").trim().slice(0, 80) || null,
        actif: true, statut: "ok", dernier_test: now, cree_par: me.id });
      if (error) { await db.rpc("wl_boite_secret_supprimer", { p_secret_id: secret_id }); return out({ ok: false, why: error.message }); }
      return out({ ok: true, id, test: t });
    }
    const { data: b0 } = await db.from("wl_boites").select("*").eq("id", String(b.id || "")).limit(1);
    const box = b0 && b0[0];
    if (!box) return out({ ok: false, why: "boîte introuvable" }, 404);
    if (b.action === "retester") {
      const t = await tester(cfgDe(box), await lireSecret(box.secret_id));
      const now = new Date().toISOString(), why = t.ok ? null : [t.imap.ok ? "" : t.imap.why, t.smtp.ok ? "" : t.smtp.why].filter(Boolean).join(" ");
      await db.from("wl_boites").update({ dernier_test: now, statut: t.ok ? "ok" : "erreur", derniere_erreur: why, erreur_depuis: t.ok ? null : (box.erreur_depuis || now), updated_at: now }).eq("id", box.id);
      return out({ ok: true, test: t });
    }
    if (b.action === "mot_de_passe") {
      const mdp = String(b.mdp || ""); if (!mdp) return out({ ok: false, why: "mot de passe manquant" });
      const t = await tester(cfgDe(box), mdp);
      if (!t.ok) return out({ ok: false, why: "nouveau mot de passe refusé : " + [t.imap.ok ? "" : t.imap.why, t.smtp.ok ? "" : t.smtp.why].filter(Boolean).join(" "), test: t });
      await ecrireSecret(box.secret_id, "wl_boite:" + box.id, mdp);
      const now = new Date().toISOString();
      await db.from("wl_boites").update({ dernier_test: now, statut: "ok", derniere_erreur: null, erreur_depuis: null, updated_at: now }).eq("id", box.id);
      return out({ ok: true, test: t });
    }
    if (b.action === "role") {
      const r = role(String(b.role || "")); if (!r || !r.actif) return out({ ok: false, why: "rôle indisponible" });
      const nom = b.nom_affiche === undefined ? box.nom_affiche : (String(b.nom_affiche || "").replace(/["<>\r\n]/g, "").trim().slice(0, 80) || null);
      await db.from("wl_boites").update({ role: r.id, nom_affiche: nom, updated_at: new Date().toISOString() }).eq("id", box.id);
      return out({ ok: true });
    }
    if (b.action === "actif") {
      await db.from("wl_boites").update({ actif: b.actif === true, releve_verrou: null, updated_at: new Date().toISOString() }).eq("id", box.id);
      return out({ ok: true, actif: b.actif === true });
    }
    // Suppression (23/10/2026) : seulement une boîte déjà désactivée ; le mot de passe est effacé du coffre (Vault),
    // le courrier déjà reçu reste dans wl_courrier.
    if (b.action === "supprimer") {
      if (box.actif) return out({ ok: false, why: "désactivez d’abord la boîte" });
      if (box.secret_id) await db.rpc("wl_boite_secret_supprimer", { p_secret_id: box.secret_id });
      const { error } = await db.from("wl_boites").delete().eq("id", box.id);
      if (error) return out({ ok: false, why: error.message });
      return out({ ok: true, supprime: box.id });
    }
    return out({ ok: false, why: "action inconnue" }, 400);
  } catch (e) {
    return out({ ok: false, why: String((e as Error)?.message || e).slice(0, 200) });
  }
});
