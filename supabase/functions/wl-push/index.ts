// Writinglab — wl-push : la page du lab enregistre ici l'identifiant Webpushr (sid) du membre de l'équipe connecté.
// Appel public depuis posthumain.com/writinglab, mais rien n'est accepté sans le jeton d'identité du membre Ghost
// (signé par Ghost, vérifié avec les clés publiques du site) ET une adresse de l'équipe.
// Corps JSON : { token, action: "register", sid } | { token, action: "test" } | { token, action: "etat" } | { token, action: "dictee", texte }
// « dictee » : remise en forme d'un message dicté (ponctuation, majuscules, mots mal reconnus) par Claude Haiku 5.5, effort minimal.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { equipe, parEmail, parId, chefs, type Membre } from "./equipe.ts";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
// Équipe (23/10/2026) : table wl_equipe via equipe.ts (cache 60 s) ; « chef » = rôle chef (avant : identifiant « jonathan » codé en dur).
const ORIGINES = ["https://posthumain.com", "https://www.posthumain.com"];
const SITE = "https://posthumain.com";

function cors(req: Request) {
  const o = req.headers.get("origin") || "";
  return { "Access-Control-Allow-Origin": ORIGINES.includes(o) ? o : ORIGINES[0], "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "content-type", "Vary": "Origin" };
}
const b64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), (c) => c.charCodeAt(0));
let jwksCache: { at: number; keys: any[] } | null = null;

async function membre(token: string): Promise<string | null> {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return null;
  let header: any, payload: any;
  try { header = JSON.parse(new TextDecoder().decode(b64u(parts[0]))); payload = JSON.parse(new TextDecoder().decode(b64u(parts[1]))); } catch { return null; }
  const hashes: Record<string, string> = { RS256: "SHA-256", RS384: "SHA-384", RS512: "SHA-512" };
  if (!hashes[header.alg]) return null;
  if (!jwksCache || Date.now() - jwksCache.at > 3600e3) {
    const r = await fetch(SITE + "/members/.well-known/jwks.json"); if (!r.ok) return null;
    jwksCache = { at: Date.now(), keys: (await r.json()).keys || [] };
  }
  const jwk = jwksCache.keys.find((k: any) => !header.kid || k.kid === header.kid);
  if (!jwk) return null;
  const key = await crypto.subtle.importKey("jwk", { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: header.alg, ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: hashes[header.alg] }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64u(parts[2]), new TextEncoder().encode(parts[0] + "." + parts[1]));
  if (!ok || !payload.exp || payload.exp * 1000 < Date.now()) return null;
  if (payload.iss && !/^https:\/\/(posthumain\.com|the-last-journal\.ghost\.io)\//.test(String(payload.iss))) return null;
  return (await parEmail(db, String(payload.sub || "")))?.id || null;
}

async function envoyer(sid: string, title: string, message: string) {
  const key = Deno.env.get("WEBPUSHR_KEY") || "", token = Deno.env.get("WEBPUSHR_TOKEN") || "";
  if (!key || !token) return { ok: false, why: "secrets Webpushr absents" };
  const r = await fetch("https://api.webpushr.com/v1/notification/send/sid", {
    method: "POST", headers: { webpushrKey: key, webpushrAuthToken: token, "Content-Type": "application/json" },
    body: JSON.stringify({ title, message, target_url: SITE + "/writinglab/", sid, auto_hide: 0, expire_push: "24h" }),
  });
  const t = await r.text();
  return { ok: r.ok, status: r.status, detail: t.slice(0, 200) };
}

// Remise en forme d'une dictée : modèle le plus léger, effort bas, sortie courte. En cas d'échec, la page garde le texte brut.
async function dictee(texte: string) {
  const key = Deno.env.get("ANTHROPIC_API_KEY") || "";
  if (!key) return { ok: false, why: "clé Anthropic absente" };
  const t = texte.slice(0, 4000);
  const body = {
    model: "claude-haiku-5-5", max_tokens: Math.min(3000, 400 + Math.ceil(t.length / 2)),
    thinking: { type: "adaptive" }, output_config: { effort: "low" },
    system: "Tu remets en forme un message dicté à la voix (reconnaissance vocale du navigateur) pour la messagerie interne d'une rédaction. "
      + "Ajoute la ponctuation et les majuscules, coupe en phrases, corrige les mots manifestement mal reconnus (homophones, accords, noms propres : Posthumain, Ghost, Valisoa, Jonathan, Julien, Claude, n8n, Supabase, Webpushr), "
      + "retire les hésitations (euh, hum) et les répétitions involontaires. Ne reformule pas, ne résume pas, n'ajoute rien, garde la langue, le ton et le tutoiement. "
      + "Si on dicte « point », « virgule », « à la ligne » ou « nouveau paragraphe », applique-les. Réponds UNIQUEMENT par le texte corrigé, sans guillemets ni commentaire.",
    messages: [{ role: "user", content: t }],
  };
  const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", signal: AbortSignal.timeout(25000), headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return { ok: false, why: "Claude " + r.status, detail: String(j?.error?.message || "").slice(0, 200) };
  const out = (j.content || []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("").trim();
  if (!out || j.stop_reason === "max_tokens") return { ok: false, why: "réponse incomplète" };
  return { ok: true, texte: out, usage: j.usage ? { in: j.usage.input_tokens, out: j.usage.output_tokens } : null, _usage: j.usage || null, _modele: String(j.model || body.model) };
}

// ---------- Comptabilité des pièces (21/10/2026) ----------
// Le rédacteur en chef convertit le solde d'une rédactrice en euros (taux réglable) ou le remet à zéro ;
// la rédactrice est prévenue dans l'Interphone, ajoute le montant à sa prochaine facture et le confirme ici.
const NOMS: Record<string, string> = { jonathan: "Jonathan Paiano", valisoa: "Valisoa Rasolofo" }; // complété par l’équipe à chaque appel
async function taux() { const { data } = await db.from("wl_reglages").select("valeur").eq("cle", "taux_piece").limit(1); const t = Number(data && data[0] && data[0].valeur); return isFinite(t) && t >= 0 ? t : 0.2; }
// Barème des pièces (31/10/2026) : { avant, paliers: 3 × {pieces, jours} } réglable par le rédacteur en chef (wl_reglages bareme_pieces) ;
// même défaut et même contrôle que wl-db (« avant » = citation insérée avant la première publication, sans délai).
const BAREME_DEF = { avant: 15, paliers: [{ pieces: 10, jours: 2 }, { pieces: 5, jours: 4 }, { pieces: 2, jours: 7 }] };
function baremeValide(v: any) {
  const pl = Array.isArray(v) ? v : v && Array.isArray(v.paliers) ? v.paliers : null;
  if (!pl || pl.length !== 3) return null;
  const n = (x: any) => Math.round(Number(String(x).replace(",", ".")));
  const b = pl.map((x: any) => ({ pieces: n(x && x.pieces), jours: n(x && x.jours) }));
  if (b.some((x: any) => !isFinite(x.pieces) || x.pieces < 0 || x.pieces > 1000 || !isFinite(x.jours) || x.jours < 1 || x.jours > 365)) return null;
  if (!(b[0].jours < b[1].jours && b[1].jours < b[2].jours)) return null;
  const avant = Array.isArray(v) || v.avant === undefined || v.avant === null || v.avant === "" ? BAREME_DEF.avant : n(v.avant);
  if (!isFinite(avant) || avant < 0 || avant > 1000) return null;
  return { avant, paliers: b };
}
async function baremeLu() {
  const { data } = await db.from("wl_reglages").select("valeur").eq("cle", "bareme_pieces").limit(1);
  let v: any = null; try { v = JSON.parse(String((data && data[0] && data[0].valeur) || "")); } catch { v = null; }
  return baremeValide(v) || BAREME_DEF;
}
const eur = (n: number) => n.toFixed(2).replace(".", ",") + " €";
async function prevenir(membre: string, title: string, message: string) {
  const { data } = await db.from("wl_push").select("sid").eq("membre", membre).limit(1);
  if (data && data[0]) { try { await envoyer(String(data[0].sid), title, message); } catch (_) { /* push perdu */ } }
}
// Fin de mois (heure suisse) : une rédactrice peut demander le paiement de son solde à partir du 25, une fois par mois.
const fmtZ = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("fr-CH", { timeZone: "Europe/Zurich", ...o }).format(new Date());
const moisZurich = () => { const [m, y] = fmtZ({ month: "2-digit", year: "numeric" }).split("."); return y + "-" + m; };
const jourZurich = () => Number(fmtZ({ day: "numeric" }));
async function soldes() {
  const { data } = await db.from("wl_pieces").select("membre,montant").eq("statut", "acquis").is("conversion_id", null).limit(5000);
  const out: Record<string, number> = {}; for (const p of data || []) out[p.membre] = (out[p.membre] || 0) + Number(p.montant || 0); return out;
}


// Signatures des mails (page Paramètres, 21/10/2026) : HTML simple (gras, italique, souligné, liens), une en français, une en anglais.
const SIG_DEF: Record<string, { fr: string; en: string }> = {
  jonathan: { fr: "<b>Jonathan Paiano</b><br>Rédacteur en chef, Posthumain<br><a href=\"https://posthumain.com\">https://posthumain.com</a>",
    en: "<b>Jonathan Paiano</b><br>Editor-in-Chief, Posthumain<br><a href=\"https://posthumain.com\">https://posthumain.com</a>" },
  valisoa: { fr: "<b>Valisoa Rasolofo</b><br>Journaliste, Posthumain<br>valisoa.rasolofo@posthumain.com<br><a href=\"https://posthumain.com\">https://posthumain.com</a>",
    en: "<b>Valisoa Rasolofo</b><br>Journalist, Posthumain<br>valisoa.rasolofo@posthumain.com<br><a href=\"https://posthumain.com\">https://posthumain.com</a>" },
};
function nettoyerSig(html: unknown): string {
  let s = String(html || "").slice(0, 4000);
  s = s.replace(/<(script|style|iframe|object)[\s\S]*?<\/\1>/gi, "");
  s = s.replace(/<\/(div|p)>\s*/gi, "<br>").replace(/<(div|p)[^>]*>/gi, "");
  s = s.replace(/<strong[^>]*>/gi, "<b>").replace(/<\/strong>/gi, "</b>").replace(/<em[^>]*>/gi, "<i>").replace(/<\/em>/gi, "</i>");
  s = s.replace(/<(\/?)([a-z0-9]+)([^>]*)>/gi, (_m, sl, tag, attrs) => {
    tag = tag.toLowerCase();
    if (["b", "i", "u"].includes(tag)) return "<" + sl + tag + ">";
    if (tag === "br") return "<br>";
    if (tag === "a") {
      if (sl) return "</a>";
      const m = /href\s*=\s*["']([^"']+)["']/i.exec(attrs || "");
      const href = m && /^(https?:\/\/|mailto:)/i.test(m[1]) ? m[1].replace(/"/g, "%22") : "";
      return href ? "<a href=\"" + href + "\">" : "<a>";
    }
    return "";
  });
  s = s.replace(/(<br>\s*){3,}/g, "<br><br>").replace(/^(\s*<br>)+|(<br>\s*)+$/g, "").trim();
  return s;
}
// Mode récompense (test) : le rédacteur en chef peut s'activer les pièces pour lui-même depuis ses Paramètres.
async function modeTest(qui: string) { const { data } = await db.from("wl_reglages").select("valeur").eq("cle", "recompense_test_" + qui).limit(1); return !!(data && data[0] && data[0].valeur === "1"); }
// Messageries gratuites à faire passer en « à vérifier » (liste de domaines cochés par le rédacteur en chef ; vide par défaut).
async function webmails(): Promise<string[]> { const { data } = await db.from("wl_reglages").select("valeur").eq("cle", "webmails_a_verifier").limit(1); try { const v = JSON.parse(String((data && data[0] && data[0].valeur) || "[]")); return Array.isArray(v) ? v.map(String) : []; } catch { return []; } }
// Signature texte de wl_equipe → HTML simple (1re ligne en gras, liens cliquables), pour les membres sans signature par défaut ci-dessus.
function sigHtml(t: string): string {
  const e = (x: string) => x.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return String(t || "").split("\n").map((l) => l.trim()).filter(Boolean).map((l, i) => { const x = /^https?:\/\/\S+$/.test(l) ? "<a href=\"" + e(l) + "\">" + e(l) + "</a>" : e(l); return i === 0 ? "<b>" + x + "</b>" : x; }).join("<br>");
}
function sigDefaut(m: Membre | null): { fr: string; en: string } { if (!m) return { fr: "", en: "" }; return SIG_DEF[m.id] || { fr: sigHtml(m.signature), en: sigHtml(m.signature_en || m.signature) }; }
async function signatures(): Promise<Record<string, { fr: string; en: string }>> {
  const out: Record<string, { fr: string; en: string }> = JSON.parse(JSON.stringify(SIG_DEF));
  for (const m of await equipe(db)) if (!out[m.id]) out[m.id] = sigDefaut(m);
  const { data } = await db.from("wl_reglages").select("cle,valeur").like("cle", "signature_%");
  (data || []).forEach((r: any) => { try { const v = JSON.parse(r.valeur); const m = String(r.cle).slice(10); if (out[m]) out[m] = { fr: v.fr || out[m].fr, en: v.en || out[m].en }; } catch (_e) { /* ignore */ } });
  return out;
}

Deno.serve(async (req) => {
  const h = { ...cors(req), "Content-Type": "application/json", "Cache-Control": "no-store" };
  if (req.method === "OPTIONS") return new Response(null, { headers: h });
  if (req.method !== "POST") return new Response(JSON.stringify({ ok: false, why: "method" }), { status: 405, headers: h });
  let b: any; try { b = await req.json(); } catch { return new Response(JSON.stringify({ ok: false, why: "bad_json" }), { status: 400, headers: h }); }
  const out = (v: unknown, s = 200) => new Response(JSON.stringify(v), { status: s, headers: h });
  const qui = await membre(String(b.token || "")).catch(() => null);
  if (!qui) return out({ ok: false, why: "accès réservé à l’équipe" }, 401);
  const moi = await parId(db, qui), estChef = !!(moi && moi.chef), CHEF = (await chefs(db))[0];
  for (const m of await equipe(db)) NOMS[m.id] = m.nom;
  // Interphone (24/10/2026) : numéro du dernier message lu par ce membre, gardé ici (avant : seulement dans le navigateur,
  // le compteur de l'onglet revenait après une reconnexion). { action: "vu" } lit, { action: "vu", id } avance (jamais en arrière).
  if (b.action === "vu") {
    const cle = "interphone_vu_" + qui;
    const { data: v0 } = await db.from("wl_reglages").select("valeur").eq("cle", cle).limit(1);
    let vu = Number((v0 && v0[0] && v0[0].valeur) || 0) || 0;
    const id = Math.floor(Number(b.id) || 0);
    if (id > vu) { vu = id; await db.from("wl_reglages").upsert({ cle, valeur: String(vu), updated_at: new Date().toISOString() }, { onConflict: "cle" }); }
    return out({ ok: true, vu });
  }
  if (b.action === "dictee") {
    const t = String(b.texte || "").trim();
    if (!t) return out({ ok: false, why: "texte vide" }, 400);
    const r: any = await dictee(t).catch(() => ({ ok: false, why: "Claude injoignable" }));
    // Coût IA (22/10/2026) : chaque dictée remise en forme est comptée dans wl_couts (tarif Haiku 5.5, conversion USD→EUR approximative).
    if (r.ok && r._usage) {
      const u = r._usage, tin = Number(u.input_tokens || 0), tout = Number(u.output_tokens || 0);
      const eur = ((tin * 0.1 + tout * 0.5) / 1e6) * 0.92;
      try { await db.from("wl_couts").insert({ membre: qui, usage: "dictee", modele: r._modele, tokens_in: tin, tokens_out: tout, cout_eur: Math.round(eur * 1e5) / 1e5 }); } catch (_) { /* comptage facultatif */ }
    }
    delete r._usage; delete r._modele;
    return out(r);
  }
  // Pièces : tout le monde voit le registre (transparence) ; seul le rédacteur en chef tranche les « à vérifier ».
  if (b.action === "pieces") {
    const chef = estChef;
    let q = db.from("wl_pieces").select("*").order("created_at", { ascending: false }).limit(300);
    let qv = db.from("wl_fiches").select("fiche_id,contact_email,reponse_preuve").eq("reponse_verifiee", true).limit(2000);
    const [{ data: ps }, { data: vs }] = await Promise.all([q, qv]);
    const totaux: Record<string, number> = {};
    for (const p of ps || []) if (p.statut === "acquis") totaux[p.membre] = (totaux[p.membre] || 0) + Number(p.montant || 0);
    const [{ data: cs }, t, so, bareme] = await Promise.all([db.from("wl_conversions").select("*").order("created_at", { ascending: false }).limit(200), taux(), soldes(), baremeLu()]);
    const { data: dm } = await db.from("wl_reglages").select("cle,valeur").like("cle", "demande_%");
    const demandes: Record<string, string> = {}; for (const d of dm || []) demandes[String(d.cle).slice(8)] = String(d.valeur || "");
    // 23/10/2026 : recompense_test rétabli (perdu lors d'un redéploiement du 21/10) — la page s'en sert pour afficher la caisse du rédacteur en chef en mode test.
    const recompense_test = await modeTest(CHEF);
    // Équipe (23/10/2026) : pour le Comptable (badge TEST, membres de test hors totaux, mention « inactif »).
    const membres = (await equipe(db)).map((m) => ({ id: m.id, nom: m.nom, test: m.test, actif: m.actif, chef: m.chef }));
    // 23/10/2026 : expéditeur réel de chaque réponse vérifiée (dans le fil) et son lien avec l'adresse du contact, pour un message exact sur la page.
    const dom = (e: string) => String(e || "").toLowerCase().split("@")[1] || "";
    const preuves: Record<string, { de: string; lien: string }> = {};
    for (const x of (vs || []) as any[]) {
      let pv: any = x.reponse_preuve; if (typeof pv === "string") { try { pv = JSON.parse(pv); } catch { pv = null; } }
      const email = String(x.contact_email || "").toLowerCase(), de = String((pv && pv.de) || email).toLowerCase();
      preuves[x.fiche_id] = { de, lien: (pv && pv.lien) || (de === email ? "meme_adresse" : dom(de) && dom(de) === dom(email) ? "meme_domaine" : "autre_adresse") };
    }
    return out({ ok: true, moi: qui, chef, recompense_test, membres, totaux, soldes: so, taux: t, bareme, demandes, mois: moisZurich(), jour: jourZurich(), conversions: cs || [], pieces: ps || [], verifiees: (vs || []).map((x: any) => x.fiche_id), preuves });
  }
  if (b.action === "taux") {
    if (!estChef) return out({ ok: false, why: "réservé au rédacteur en chef" }, 403);
    const t = Math.round(Number(String(b.taux || "").replace(",", ".")) * 10000) / 10000;
    if (!isFinite(t) || t < 0 || t > 100) return out({ ok: false, why: "taux invalide" }, 400);
    await db.from("wl_reglages").upsert({ cle: "taux_piece", valeur: String(t), updated_at: new Date().toISOString() }, { onConflict: "cle" });
    return out({ ok: true, taux: t });
  }
  if (b.action === "bareme") {
    if (!estChef) return out({ ok: false, why: "réservé au rédacteur en chef" }, 403);
    const nb = baremeValide(b.bareme);
    if (!nb) return out({ ok: false, why: "barème invalide : pièces de 0 à 1000, délais de 1 à 365 jours et de plus en plus longs" }, 400);
    await db.from("wl_reglages").upsert({ cle: "bareme_pieces", valeur: JSON.stringify(nb), updated_at: new Date().toISOString() }, { onConflict: "cle" });
    return out({ ok: true, bareme: nb });
  }
  if (b.action === "convertir" || b.action === "remise_a_zero") {
    if (!estChef) return out({ ok: false, why: "réservé au rédacteur en chef" }, 403);
    const membre = String(b.membre || "");
    const cible = await parId(db, membre, true);
    if (!cible || (cible.chef && !(await modeTest(membre)))) return out({ ok: false, why: "membre inconnu" }, 400);
    const { data: ps } = await db.from("wl_pieces").select("id,montant").eq("membre", membre).eq("statut", "acquis").is("conversion_id", null).limit(5000);
    const n = (ps || []).reduce((a: number, p: any) => a + Number(p.montant || 0), 0);
    if (!n) return out({ ok: false, why: "aucune pièce à convertir" });
    const conv = b.action === "convertir";
    const t = conv ? await taux() : 0, montant = Math.round(n * t * 100) / 100;
    const { data: c, error } = await db.from("wl_conversions").insert({ membre, pieces: n, taux: t, montant, type: conv ? "conversion" : "remise_a_zero", statut: conv ? "a_facturer" : "remis_a_zero", note: String(b.note || "").slice(0, 300) || null, cree_par: qui }).select();
    if (error || !c || !c.length) return out({ ok: false, why: "enregistrement impossible" }, 500);
    await db.from("wl_pieces").update({ conversion_id: c[0].id, updated_at: new Date().toISOString() }).in("id", (ps || []).map((p: any) => p.id));
    if (conv) {
      const texte = "🪙 " + n + " pièces comptabilisées : " + eur(montant) + " (" + eur(t) + " la pièce). Ajoute ce montant à ta prochaine facture, puis coche-le chez le Comptable, dans l’arrière-salle." + (b.note ? "\nNote de " + ((moi && moi.nom.split(" ")[0]) || "Jonathan") + " : " + String(b.note).slice(0, 300) : "");
      await db.from("wl_messages").insert({ auteur: "compta", nom: "🧮 Le Comptable", texte });
      await prevenir(membre, "🪙 " + eur(montant) + " à ajouter à ta facture", n + " pièces comptabilisées. Ajoute-les à ta prochaine facture, puis coche-le chez le Comptable.");
    }
    return out({ ok: true, conversion: c[0] });
  }
  if (b.action === "demande_paiement") {
    if (estChef && !(await modeTest(qui))) return out({ ok: false, why: "réservé aux rédactrices (activez le mode récompense dans les Paramètres pour tester)" }, 403);
    if (jourZurich() < 25) return out({ ok: false, why: "la demande de paiement s’ouvre le 25 du mois" });
    const mois = moisZurich();
    const { data: d0 } = await db.from("wl_reglages").select("valeur").eq("cle", "demande_" + qui).limit(1);
    if (d0 && d0[0] && d0[0].valeur === mois) return out({ ok: false, why: "demande déjà envoyée ce mois-ci" });
    const so = (await soldes())[qui] || 0;
    if (!so) return out({ ok: false, why: "aucune pièce à payer" });
    const t = await taux();
    await db.from("wl_reglages").upsert({ cle: "demande_" + qui, valeur: mois, updated_at: new Date().toISOString() }, { onConflict: "cle" });
    await db.from("wl_messages").insert({ auteur: "compta", nom: "🧮 Le Comptable", texte: "💶 " + (NOMS[qui] || qui) + " demande le paiement de " + so + " pièces (" + eur(so * t) + ")." });
    await prevenir(CHEF, "💶 Demande de paiement", (NOMS[qui] || qui) + " : " + so + " pièces (" + eur(so * t) + ")");
    return out({ ok: true, pieces: so, montant: Math.round(so * t * 100) / 100 });
  }
  if (b.action === "facturee") {
    const id = Number(b.id);
    const { data: c0 } = await db.from("wl_conversions").select("*").eq("id", id).limit(1);
    const c = c0 && c0[0];
    if (!c) return out({ ok: false, why: "conversion introuvable" }, 404);
    if (c.membre !== qui && !estChef) return out({ ok: false, why: "ce n’est pas votre conversion" }, 403);
    if (c.statut !== "a_facturer") return out({ ok: false, why: "déjà confirmée" });
    const note = String(b.note || "").slice(0, 200);
    const { data } = await db.from("wl_conversions").update({ statut: "facture", facture_le: new Date().toISOString(), facture_note: note || null, updated_at: new Date().toISOString() }).eq("id", id).select();
    const autre = estChef ? c.membre : CHEF;
    await db.from("wl_messages").insert({ auteur: "compta", nom: "🧮 Le Comptable", texte: "✅ " + eur(Number(c.montant)) + " (" + c.pieces + " pièces) de " + (NOMS[c.membre] || c.membre) + " ajoutés à la facture, coché par " + (NOMS[qui] || qui) + (note ? " — " + note : "") + ". Archivé." });
    await prevenir(autre, "✅ " + eur(Number(c.montant)) + " ajoutés à la facture", "Coché par " + (NOMS[qui] || qui) + (note ? " — " + note : ""));
    return out({ ok: true, conversion: data && data[0] });
  }
  if (b.action === "pieces_decision") {
    if (!estChef) return out({ ok: false, why: "réservé au rédacteur en chef" }, 403);
    const st = b.statut === "acquis" ? "acquis" : b.statut === "annule" ? "annule" : "";
    const id = Number(b.id);
    if (!st || !id) return out({ ok: false, why: "décision invalide" }, 400);
    const { data, error } = await db.from("wl_pieces").update({ statut: st, decide_par: qui, decide_le: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", id).select();
    if (error || !data || !data.length) return out({ ok: false, why: "pièces introuvables" }, 404);
    return out({ ok: true, piece: data[0] });
  }
  if (b.action === "signatures") return out({ ok: true, signatures: await signatures() });
  if (b.action === "parametres") {
    const sg = await signatures();
    const { data: pu } = await db.from("wl_push").select("sid").eq("membre", qui).limit(1);
    return out({ ok: true, membre: qui, chef: estChef, signature: sg[qui] || { fr: "", en: "" }, defaut: sigDefaut(moi), push: !!(pu && pu[0]), recompense: estChef ? await modeTest(qui) : false, webmails: estChef ? await webmails() : [] });
  }
  if (b.action === "parametres_set") {
    const res: any = { ok: true };
    if (b.recompense !== undefined) {
      if (!estChef) return out({ ok: false, why: "réservé au rédacteur en chef" }, 403);
      await db.from("wl_reglages").upsert({ cle: "recompense_test_" + qui, valeur: b.recompense ? "1" : "0", updated_at: new Date().toISOString() }, { onConflict: "cle" });
      res.recompense = !!b.recompense;
    }
    if (b.webmails !== undefined) {
      if (!estChef) return out({ ok: false, why: "réservé au rédacteur en chef" }, 403);
      const l = (Array.isArray(b.webmails) ? b.webmails : []).map((x: unknown) => String(x).toLowerCase().trim()).filter((x: string) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(x)).slice(0, 60);
      await db.from("wl_reglages").upsert({ cle: "webmails_a_verifier", valeur: JSON.stringify(l), updated_at: new Date().toISOString() }, { onConflict: "cle" });
      res.webmails = l;
    }
    if (b.fr !== undefined || b.en !== undefined) {
      const fr = nettoyerSig(b.fr), en = nettoyerSig(b.en);
      if (!fr || !en) return out({ ok: false, why: "les deux signatures (français et anglais) sont nécessaires" }, 400);
      const { error } = await db.from("wl_reglages").upsert({ cle: "signature_" + qui, valeur: JSON.stringify({ fr, en }), updated_at: new Date().toISOString() }, { onConflict: "cle" });
      if (error) return out({ ok: false, why: "enregistrement impossible" }, 500);
      res.signature = { fr, en };
    }
    return out(res);
  }
  if (b.action === "unregister") {
    await db.from("wl_push").delete().eq("membre", qui);
    return out({ ok: true });
  }
  if (b.action === "register") {
    const sid = String(b.sid || "").trim();
    if (!/^[A-Za-z0-9_-]{2,64}$/.test(sid)) return out({ ok: false, why: "identifiant Webpushr invalide" }, 400);
    const { error } = await db.from("wl_push").upsert({ membre: qui, sid, navigateur: String(req.headers.get("user-agent") || "").slice(0, 200), updated_at: new Date().toISOString() }, { onConflict: "membre" });
    if (error) return out({ ok: false, why: "enregistrement impossible" }, 500);
    return out({ ok: true, membre: qui });
  }
  const { data } = await db.from("wl_push").select("sid,updated_at").eq("membre", qui).limit(1);
  const cur = data && data[0];
  if (b.action === "test") {
    if (!cur) return out({ ok: false, why: "notifications pas encore activées sur ce navigateur" });
    const r: any = await envoyer(String(cur.sid), "🔔 Writinglab", "Les notifications du lab fonctionnent sur ce navigateur.");
    return out(r.ok ? { ok: true, sid: cur.sid, envoi: r.detail } : { ok: false, why: "Webpushr : " + (r.why || r.status), detail: r.detail });
  }
  return out({ ok: true, active: !!cur, sid: cur ? cur.sid : null });
});
