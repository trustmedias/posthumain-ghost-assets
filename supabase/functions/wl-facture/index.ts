// Writinglab — wl-facture : factures mensuelles de la rédaction (Valisoa), générées en PDF le dernier jour du mois à 23 h (Zurich) par n8n.
// Lignes : enquêtes premium et articles standards (comptés par n8n dans Ghost : autrice/co-autrice, ou relecture d'un article de Julien
// prouvée par l'historique des révisions), + « Interviews » = montants des pièces comptabilisées et pas encore facturées (sans quantité).
// Appels : n8n (en-tête x-tv-secret) → generer ; page du lab (jeton membre Ghost) → liste, payer, ajuster, tarifs, zip, lancer.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import * as PDFLib from "npm:pdf-lib@1.17.1";
import { zipSync } from "npm:fflate@0.8.2";
import { equipe, parEmail, chefs, type Membre } from "./equipe.ts";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const BUCKET = "writinglab";
// Équipe : table wl_equipe (equipe.ts, cache 60 s), rechargée à chaque requête. NOMS couvre aussi les inactifs (historique).
let NOMS: Record<string, string> = {}, ACTIFS = new Set<string>(), TESTS = new Set<string>(), CHEF = "jonathan";
async function chargerEquipe() {
  const l = await equipe(db); NOMS = {}; ACTIFS = new Set(); TESTS = new Set();
  for (const m of l) { NOMS[m.id] = m.nom; if (m.actif) ACTIFS.add(m.id); if (m.test) TESTS.add(m.id); }
  CHEF = (await chefs(db))[0];
}
// Initiales du N° de facture : prénom + nom (« Valisoa Rasolofo » → VR), inchangées pour les membres existants.
const initiales = (m: string) => { const p = String(NOMS[m] || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").split(/\s+/).filter(Boolean); return p.length >= 2 ? (p[0][0] + p[p.length - 1][0]).toUpperCase() : m.slice(0, 2).toUpperCase(); };
const ORIGINES = ["https://posthumain.com", "https://www.posthumain.com"];
const SITE = "https://posthumain.com";
const N8N_WEBHOOK = "https://trustmedias.app.n8n.cloud/webhook/wl-factures";
const LOGO_URL = "https://trustmedias.com/wp-content/uploads/2018/06/trustmedias-logo-black-retina.png";
const MOIS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];

function cors(req: Request) {
  const o = req.headers.get("origin") || "";
  return { "Access-Control-Allow-Origin": ORIGINES.includes(o) ? o : ORIGINES[0], "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "content-type", "Vary": "Origin" };
}
function safeEqual(a: string, b: string) { if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; }
const b64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), (c) => c.charCodeAt(0));
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
  return await parEmail(db, String(payload.sub || ""));
}
async function reglage(cle: string, def: any) { const { data } = await db.from("wl_reglages").select("valeur").eq("cle", cle).limit(1); const v = data && data[0] ? data[0].valeur : null; if (v == null) return def; try { return JSON.parse(v); } catch { return v; } }
async function pousser(membres: string[], title: string, message: string) {
  const key = Deno.env.get("WEBPUSHR_KEY") || "", token = Deno.env.get("WEBPUSHR_TOKEN") || "";
  if (!key || !token) return;
  const { data } = await db.from("wl_push").select("membre,sid").in("membre", membres);
  await Promise.all((data || []).map((r: any) => fetch("https://api.webpushr.com/v1/notification/send/sid", { method: "POST", headers: { webpushrKey: key, webpushrAuthToken: token, "Content-Type": "application/json" },
    body: JSON.stringify({ title: title.slice(0, 100), message: message.slice(0, 250), target_url: SITE + "/writinglab/#factures", sid: String(r.sid), auto_hide: 0, expire_push: "24h" }) }).catch(() => null)));
}
async function annoncer(texte: string, membres: string[], titre: string, msg: string) {
  await db.from("wl_messages").insert({ auteur: "compta", nom: "🧮 Le Comptable", texte });
  await pousser(membres, titre, msg);
}
const eur = (n: number) => n.toFixed(2).replace(".", ",") + " €";
const dernierJour = (a: number, m: number) => new Date(Date.UTC(a, m, 0)).getUTCDate();
async function logo(): Promise<Uint8Array | null> {
  const p = "factures/logo-trustmedias.png";
  const { data } = await db.storage.from(BUCKET).download(p);
  if (data) return new Uint8Array(await data.arrayBuffer());
  try { const r = await fetch(LOGO_URL); if (!r.ok) return null; const b = new Uint8Array(await r.arrayBuffer()); await db.storage.from(BUCKET).upload(p, b, { contentType: "image/png", upsert: true }); return b; } catch { return null; }
}

// Facture Posthumain — mise en page A4 sobre et administrative (pdf-lib, Helvetica).
// build(PDFLib, d, logoBytes) -> Uint8Array
// d = { numero, periode, date, prestataire:{nom,adresse[],tel,email?,paiement,banque{titulaire,adresse,compte,domiciliation},mention},
//       client:{nom,contact,adresse[],tel,email}, lignes:[{libelle,qte|null,unite,pu|null,total}], total }
async function build(PDFLib: any, d: any, logoBytes: Uint8Array | null): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts, rgb } = PDFLib;
  const doc = await PDFDocument.create();
  doc.setTitle('Facture ' + d.numero); doc.setAuthor(d.prestataire.nom); doc.setSubject('Facture Posthumain ' + d.periode); doc.setCreator('Writinglab Posthumain');
  const page = doc.addPage([595.28, 841.89]);
  const F = await doc.embedFont(StandardFonts.Helvetica), B = await doc.embedFont(StandardFonts.HelveticaBold), I = await doc.embedFont(StandardFonts.HelveticaOblique);
  const encre = rgb(0.11, 0.13, 0.16), doux = rgb(0.42, 0.45, 0.50), filet = rgb(0.82, 0.84, 0.87), fond = rgb(0.965, 0.97, 0.975), accent = rgb(0.11, 0.17, 0.24), blanc = rgb(1, 1, 1);
  const W = (t, f, s) => f.widthOfTextAtSize(String(t), s);
  const txt = (t, x, y, o) => { o = o || {}; const f = o.f || F, s = o.s || 9; t = String(t == null ? '' : t); let xx = x; if (o.r) xx = x - W(t, f, s); else if (o.c) xx = x - W(t, f, s) / 2; page.drawText(t, { x: xx, y, size: s, font: f, color: o.col || encre }); };
  const rect = (x, y, w, h, col) => page.drawRectangle({ x, y, width: w, height: h, color: col });
  const ligne = (x1, y1, x2, y2, ep, col) => page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: ep || 0.6, color: col || filet });
  const eur = (n) => { const v = (Math.round(Number(n) * 100) / 100).toFixed(2).split('.'); return v[0].replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ',' + v[1] + ' EUR'; };
  const G = 48, D = 547; // marges

  // bandeau supérieur
  rect(0, 826, 595.28, 16, accent);
  if (logoBytes) { try { const img = await doc.embedPng(logoBytes); const w = 118, h = img.height * w / img.width; page.drawImage(img, { x: G, y: 772 - h / 2, width: w, height: h }); } catch (e) { txt('Trust Medias', G, 766, { f: B, s: 16 }); } }
  else txt('Trust Medias', G, 766, { f: B, s: 16 });
  txt('FACTURE', D, 776, { f: B, s: 24, r: true, col: accent });
  // cartouche n° / date / période
  const cart = [['N° de facture', d.numero], ['Date d’émission', d.date], ['Période', d.periode]];
  let yc = 748; cart.forEach((c) => { txt(c[0], D - 150, yc, { s: 8, col: doux }); txt(c[1], D, yc, { f: B, s: 9, r: true }); yc -= 14; });
  ligne(G, 698, D, 698, 0.8);

  // émetteur / destinataire
  const bloc = (x, titre, lignes) => { txt(titre, x, 676, { f: B, s: 7.5, col: doux }); let y = 660; lignes.filter(Boolean).forEach((l, k) => { txt(l, x, y, { f: k === 0 ? B : F, s: k === 0 ? 10.5 : 9 }); y -= k === 0 ? 15 : 12.5; }); };
  bloc(G, 'ÉMETTEUR (PRESTATAIRE)', [d.prestataire.nom].concat(d.prestataire.adresse || [], [d.prestataire.tel, d.prestataire.email]));
  rect(312, 572, D - 312, 116, fond);
  bloc(326, 'FACTURÉ À', [d.client.nom, 'À l’attention de ' + (d.client.contact || '')].concat(d.client.adresse || [], [d.client.email]));

  // objet
  txt('Objet', G, 540, { f: B, s: 9 }); txt('Prestations éditoriales pour Posthumain.com (rédaction, relecture et interviews)', G + 40, 540, { s: 9 });

  // tableau
  const cx = { des: G + 10, qte: 360, pu: 450, tot: D - 10 };
  let y = 512;
  rect(G, y - 6, D - G, 22, accent);
  txt('DÉSIGNATION', cx.des, y + 1, { f: B, s: 8, col: blanc }); txt('QTÉ', cx.qte, y + 1, { f: B, s: 8, col: blanc, c: true });
  txt('PRIX UNITAIRE', cx.pu, y + 1, { f: B, s: 8, col: blanc, c: true }); txt('MONTANT', cx.tot, y + 1, { f: B, s: 8, col: blanc, r: true });
  y -= 30;
  d.lignes.forEach((l, k) => {
    if (k % 2 === 1) rect(G, y - 8, D - G, 26, fond);
    txt(l.libelle, cx.des, y + 2, { f: B, s: 9.5 });
    if (l.detail) txt(l.detail, cx.des, y - 7, { s: 7.5, col: doux });
    if (l.qte != null) txt(String(l.qte), cx.qte, y + 2, { c: true, s: 9.5 });
    if (l.pu != null) txt(eur(l.pu), cx.pu, y + 2, { c: true, s: 9.5 });
    txt(eur(l.total), cx.tot, y + 2, { r: true, s: 9.5 });
    y -= 26;
  });
  ligne(G, y + 12, D, y + 12, 0.8);

  // totaux
  y -= 10;
  const tot = (lib, val, gras) => { txt(lib, 360, y, { f: gras ? B : F, s: gras ? 10 : 9, col: gras ? blanc : encre }); txt(val, cx.tot, y, { f: gras ? B : F, s: gras ? 11 : 9, r: true, col: gras ? blanc : encre }); };
  tot('Total HT', eur(d.total)); y -= 15;
  tot('TVA (0 %)', eur(0)); y -= 24;
  rect(350, y - 9, D - 350, 26, accent); tot('TOTAL À PAYER', eur(d.total), true);
  y -= 30;
  txt(d.prestataire.mention || 'TVA non applicable : prestataire non assujetti à la TVA.', G, y + 30, { f: I, s: 8, col: doux });

  // règlement
  const bq = d.prestataire.banque || {};
  let yr = 250;
  txt('RÈGLEMENT', G, yr, { f: B, s: 7.5, col: doux }); ligne(G, yr - 5, D, yr - 5);
  yr -= 20;
  const reg = [['Mode de paiement', d.prestataire.paiement || 'Virement bancaire'], ['Titulaire du compte', bq.titulaire], ['IBAN', bq.compte], ['Banque', bq.domiciliation], ['Adresse du titulaire', bq.adresse], ['Référence à indiquer', d.numero]];
  reg.filter((r) => r[1]).forEach((r) => { txt(r[0], G, yr, { s: 8.5, col: doux }); txt(r[1], G + 120, yr, { f: r[0] === 'IBAN' || r[0] === 'Référence à indiquer' ? B : F, s: 8.5 }); yr -= 14; });

  // pied
  ligne(G, 62, D, 62);
  txt(d.prestataire.nom + ' · ' + (d.prestataire.adresse || []).join(', ') + (d.prestataire.tel ? ' · ' + d.prestataire.tel : ''), 297.6, 48, { s: 7, col: doux, c: true });
  txt('Facture générée par le Writinglab de Posthumain · ' + d.numero, 297.6, 37, { s: 6.5, col: doux, c: true });
  return await doc.save({ useObjectStreams: true });
}

// Construit (ou reconstruit) la facture d'un membre pour un mois. Une facture déjà payée n'est jamais régénérée.
async function fabriquer(m: string, mois: string, entree: { premium?: any[]; standard?: any[] } | null, ajust: any | null) {
  const [a, mm] = mois.split("-").map(Number);
  const { data: ex0 } = await db.from("wl_factures").select("*").eq("membre", m).eq("mois", mois).limit(1);
  const ex = ex0 && ex0[0];
  if (ex && ex.statut === "payee") return { ok: false, why: "facture déjà payée : elle n’est plus modifiable" };
  const tp = Number(await reglage("tarif_premium", 7)), ts = Number(await reglage("tarif_standard", 5));
  const details: any = ex ? (ex.details || {}) : {};
  if (entree) { details.premium = entree.premium || []; details.standard = entree.standard || []; }
  if (ajust) details.ajust = Object.assign({}, details.ajust || {}, ajust);
  details.premium = details.premium || []; details.standard = details.standard || [];
  // pièces comptabilisées et pas encore facturées → ligne « Interviews » (cochées « ajoutées à la facture » automatiquement)
  details.conversions = details.conversions || [];
  // N° automatique : F-AAAAMMJJ-INITIALES, daté du dernier jour de la période (stable : une régénération garde le même numéro).
  const numero = "F-" + a + String(mm).padStart(2, "0") + String(dernierJour(a, mm)).padStart(2, "0") + "-" + initiales(m);
  const { data: cs } = await db.from("wl_conversions").select("id,montant").eq("membre", m).eq("statut", "a_facturer").eq("type", "conversion");
  for (const c of cs || []) if (!details.conversions.find((x: any) => x.id === c.id)) details.conversions.push({ id: c.id, montant: Number(c.montant) });
  const aj = details.ajust || {};
  const qp = aj.premium_qte != null ? Number(aj.premium_qte) : details.premium.length;
  const qs = aj.standard_qte != null ? Number(aj.standard_qte) : details.standard.length;
  const pp = aj.tarif_premium != null ? Number(aj.tarif_premium) : (ex && details.tarif_premium != null && !entree ? Number(details.tarif_premium) : tp);
  const ps = aj.tarif_standard != null ? Number(aj.tarif_standard) : (ex && details.tarif_standard != null && !entree ? Number(details.tarif_standard) : ts);
  details.tarif_premium = pp; details.tarif_standard = ps;
  const inter = aj.interview != null ? Number(aj.interview) : details.conversions.reduce((s: number, c: any) => s + Number(c.montant || 0), 0);
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const lignes: any[] = [
    { libelle: "Enquêtes premium", detail: "Rédaction ou relecture d’enquêtes publiées dans le mois", qte: qp, unite: "unit", pu: pp, total: r2(qp * pp) },
    { libelle: "Articles standards", detail: "Rédaction ou relecture d’articles publiés dans le mois", qte: qs, unite: "unit", pu: ps, total: r2(qs * ps) },
  ];
  if (inter > 0) lignes.push({ libelle: "Interviews", detail: "Interviews d’experts intégrées aux articles", qte: null, unite: "", pu: null, total: r2(inter) });
  const total = r2(lignes.reduce((s, l) => s + l.total, 0));
  const prest = await reglage("facture_profil_" + m, { nom: NOMS[m] || m, adresse: [], banque: {} });
  const client = await reglage("facture_client", { nom: "Trust Medias", adresse: [] });
  const now = new Date(), fmt = new Intl.DateTimeFormat("fr-CH", { timeZone: "Europe/Zurich", day: "2-digit", month: "2-digit", year: "numeric" });
  const d = { numero, mois: mm, annee: a, periode: "1er – " + dernierJour(a, mm) + " " + MOIS[mm - 1] + " " + a, date: fmt.format(now).replace(/\./g, "/"), prestataire: prest, client, lignes, total };
  const pdf = await build(PDFLib, d, await logo());
  const path = "factures/" + a + "/Facture_Posthumain_" + numero + ".pdf";
  const up = await db.storage.from(BUCKET).upload(path, pdf, { contentType: "application/pdf", upsert: true });
  if (up.error) return { ok: false, why: "stockage : " + up.error.message };
  const row = { membre: m, mois, numero, lignes, details, total, pdf_path: path, statut: "emise", emise_le: now.toISOString(), updated_at: now.toISOString() };
  const { data: f, error } = await db.from("wl_factures").upsert(row, { onConflict: "membre,mois" }).select();
  if (error) return { ok: false, why: error.message };
  // Les pièces comptabilisées ne passent « facturées » qu'une fois le PDF stocké et la facture enregistrée (22/10/2026).
  if ((cs || []).length) await db.from("wl_conversions").update({ statut: "facture", facture_le: new Date().toISOString(), facture_note: "Facture " + numero, updated_at: new Date().toISOString() }).in("id", (cs || []).map((c: any) => c.id));
  return { ok: true, facture: f && f[0], nouvelle: !ex };
}
async function signer(list: any[]) {
  const paths = list.map((f) => f.pdf_path).filter(Boolean);
  if (!paths.length) return list;
  const { data } = await db.storage.from(BUCKET).createSignedUrls(paths, 3600);
  const mp = new Map((data || []).map((x: any) => [x.path, x.signedUrl]));
  return list.map((f) => ({ ...f, url: mp.get(f.pdf_path) || "" }));
}

Deno.serve(async (req) => {
  const h = { ...cors(req), "Content-Type": "application/json", "Cache-Control": "no-store" };
  if (req.method === "OPTIONS") return new Response(null, { headers: h });
  const out = (v: unknown, s = 200) => new Response(JSON.stringify(v), { status: s, headers: h });
  if (req.method !== "POST") return out({ ok: false, why: "method" }, 405);
  let b: any; try { b = await req.json(); } catch { return out({ ok: false, why: "bad_json" }, 400); }
  const secret = Deno.env.get("TV_ADMIN_SECRET") || "";
  await chargerEquipe();
  const serveur = !!secret && safeEqual(req.headers.get("x-tv-secret") || "", secret);

  // n8n, fin de mois : une facture par rédactrice avec la liste des articles comptés
  if (serveur && b.action === "generer") {
    const mois = String(b.mois || ""); if (!/^\d{4}-\d{2}$/.test(mois)) return out({ ok: false, why: "mois invalide" }, 400);
    const res: any[] = [];
    for (const it of (Array.isArray(b.factures) ? b.factures : [])) {
      const m = String(it.membre || ""); if (!ACTIFS.has(m)) continue; // inconnu ou inactif : pas de nouvelle facture
      const r: any = await fabriquer(m, mois, { premium: it.premium || [], standard: it.standard || [] }, null);
      res.push({ membre: m, ...r });
      if (r.ok) {
        const f = r.facture, [a, mm] = mois.split("-").map(Number);
        await annoncer("🧾 Facture " + MOIS[mm - 1] + " " + a + " de " + NOMS[m] + (r.nouvelle ? " générée" : " mise à jour") + " : " + eur(Number(f.total)) + " (" + f.lignes.map((l: any) => l.libelle + (l.qte != null ? " × " + l.qte : "")).join(", ") + "). Elle est chez le Comptable.",
          [...new Set([m, CHEF])], "🧾 Facture " + MOIS[mm - 1] + " : " + eur(Number(f.total)), NOMS[m] + " — chez le Comptable du Writinglab");
      }
    }
    return out({ ok: true, resultats: res });
  }

  const me = await membre(String(b.token || "")).catch(() => null);
  if (!me) return out({ ok: false, why: "accès réservé à l’équipe" }, 401);
  const qui = me.id, chef = !!me.chef;
  if (b.action === "liste") {
    let q = db.from("wl_factures").select("*").order("mois", { ascending: false }).limit(60);
    if (!chef) q = q.eq("membre", qui);
    const { data } = await q;
    // test : facture d'un compte de test (hors totaux du Comptable) ; nom : nom de l'équipe, « (inactif) » si désactivé.
    const fs = (data || []).map((f: any) => ({ ...f, test: TESTS.has(f.membre), nom: (NOMS[f.membre] || f.membre) + (NOMS[f.membre] && !ACTIFS.has(f.membre) ? " (inactif)" : "") }));
    return out({ ok: true, factures: await signer(fs), tarif_premium: Number(await reglage("tarif_premium", 7)), tarif_standard: Number(await reglage("tarif_standard", 5)) });
  }
  if (!chef) return out({ ok: false, why: "réservé au rédacteur en chef" }, 403);
  if (b.action === "tarifs") {
    const p = Number(String(b.premium).replace(",", ".")), s = Number(String(b.standard).replace(",", "."));
    if (!(p >= 0 && p < 1000 && s >= 0 && s < 1000)) return out({ ok: false, why: "tarifs invalides" }, 400);
    await db.from("wl_reglages").upsert([{ cle: "tarif_premium", valeur: String(p), updated_at: new Date().toISOString() }, { cle: "tarif_standard", valeur: String(s), updated_at: new Date().toISOString() }], { onConflict: "cle" });
    return out({ ok: true, tarif_premium: p, tarif_standard: s });
  }
  if (b.action === "ajuster") {
    const { data: f0 } = await db.from("wl_factures").select("*").eq("id", Number(b.id)).limit(1);
    const f = f0 && f0[0]; if (!f) return out({ ok: false, why: "facture introuvable" }, 404);
    const aj: any = {};
    for (const k of ["premium_qte", "standard_qte", "tarif_premium", "tarif_standard", "interview"]) if (b[k] !== undefined && b[k] !== "" && b[k] !== null) { const v = Number(String(b[k]).replace(",", ".")); if (!(v >= 0)) return out({ ok: false, why: "valeur invalide : " + k }, 400); aj[k] = v; }
    const r: any = await fabriquer(f.membre, f.mois, null, aj);
    if (!r.ok) return out(r);
    const [a, mm] = f.mois.split("-").map(Number);
    await annoncer("🧾 Facture " + MOIS[mm - 1] + " " + a + " corrigée par " + me.nom.split(" ")[0] + " : " + eur(Number(r.facture.total)) + ".", [f.membre], "🧾 Facture " + MOIS[mm - 1] + " corrigée", eur(Number(r.facture.total)));
    return out({ ok: true, facture: (await signer([r.facture]))[0] });
  }
  if (b.action === "payer") {
    const { data: f0 } = await db.from("wl_factures").select("*").eq("id", Number(b.id)).limit(1);
    const f = f0 && f0[0]; if (!f) return out({ ok: false, why: "facture introuvable" }, 404);
    if (f.statut === "payee") return out({ ok: false, why: "déjà payée" });
    const { data } = await db.from("wl_factures").update({ statut: "payee", payee_le: new Date().toISOString(), payee_par: qui, updated_at: new Date().toISOString() }).eq("id", f.id).select();
    const [a, mm] = f.mois.split("-").map(Number);
    await annoncer("💸 Facture " + MOIS[mm - 1] + " " + a + " de " + (NOMS[f.membre] || f.membre) + " payée : " + eur(Number(f.total)) + ". Merci !", [f.membre], "💸 Paiement envoyé", "Facture " + MOIS[mm - 1] + " " + a + " : " + eur(Number(f.total)));
    return out({ ok: true, facture: data && data[0] });
  }
  if (b.action === "zip") {
    const annee = Number(b.annee); if (!(annee > 2000 && annee < 3000)) return out({ ok: false, why: "année invalide" }, 400);
    const { data } = await db.from("wl_factures").select("numero,pdf_path,membre").like("mois", annee + "-%").order("mois");
    if (!data || !data.length) return out({ ok: false, why: "aucune facture en " + annee });
    const files: Record<string, Uint8Array> = {};
    for (const f of data) { const { data: bl } = await db.storage.from(BUCKET).download(f.pdf_path); if (bl) files["Facture_Posthumain_" + f.numero + ".pdf"] = new Uint8Array(await bl.arrayBuffer()); }
    const zip = zipSync(files, { level: 9 });
    const p = "factures/zip/Factures_Posthumain_" + annee + ".zip";
    await db.storage.from(BUCKET).upload(p, zip, { contentType: "application/zip", upsert: true });
    const { data: s } = await db.storage.from(BUCKET).createSignedUrl(p, 3600, { download: "Factures_Posthumain_" + annee + ".zip" });
    return out({ ok: true, url: s && s.signedUrl, nombre: Object.keys(files).length });
  }
  if (b.action === "lancer") {
    // « Générer maintenant » : n8n recompte les articles du mois dans Ghost puis rappelle « generer ».
    const mois = /^\d{4}-\d{2}$/.test(String(b.mois || "")) ? String(b.mois) : new Intl.DateTimeFormat("fr-CA", { timeZone: "Europe/Zurich", year: "numeric", month: "2-digit" }).format(new Date());
    const r = await fetch(N8N_WEBHOOK, { method: "POST", headers: { "Content-Type": "application/json", "x-tv-secret": secret }, body: JSON.stringify({ mois }) }).catch(() => null);
    if (!r || !r.ok) return out({ ok: false, why: "n8n injoignable (" + (r ? r.status : "réseau") + ")" });
    return out({ ok: true, mois, ...(await r.json().catch(() => ({}))) });
  }
  return out({ ok: false, why: "action inconnue" }, 400);
});
