// Writinglab — wl-mail : envoie un mail depuis une boîte @posthumain.com (SMTP Infomaniak), DANS LE FIL de la conversation
// (en-têtes In-Reply-To / References) et avec pièces jointes. Appelée par n8n avec l'en-tête x-tv-secret.
// Mot de passe SMTP : WL_SMTP_PASS (commun aux 4 boîtes), ou un secret propre à une boîte s'il existe
// (WL_SMTP_JONATHAN, WL_SMTP_VALISOA, WL_SMTP_SUBS, WL_SMTP_REDACTION), qui passe alors avant le commun.
// Sans mot de passe, répond ok:false et n8n envoie par son propre SMTP (sans fil ni pièces jointes).
// 21/10/2026 : champ « html » facultatif (signature en gras/italique/liens) envoyé en plus du texte brut.
// 21/10/2026 : copie du mail déposée dans « Éléments envoyés » de la boîte (IMAP APPEND), pour le retrouver dans Outlook/webmail.
// Un envoi SMTP seul n'y laisse aucune trace ; dépôt en arrière-plan après la réponse (si il échoue, le mail reste envoyé : voir les logs).
// Délais SMTP courts (10 s connexion, 20 s inactivité) : la fonction répond toujours avant le délai de 60 s de n8n.
// 22/10/2026 : échec SMTP ou copie « Envoyés » impossible → alerte au rédacteur en chef (wl-db « alerte », une par heure au plus).
// 23/10/2026 : boîtes ajoutées depuis le lab (table wl_boites, actives) acceptées EN PLUS des 4 boîtes historiques, qui gardent
// exactement le même chemin (secrets WL_SMTP_*, mail.infomaniak.com). Pour ces boîtes : mot de passe lu dans Supabase Vault
// (fonction wl_boite_secret_lire, service role), serveurs SMTP / IMAP du fournisseur enregistrés dans wl_boites.
// 28/10/2026 : champ « cc » facultatif (adresse ou liste) : personnes en copie, ajoutées à l'en-tête Cc ET à l'enveloppe SMTP.
//   Sert à « Répondre à la personne en copie » (l'assistante d'un chercheur) : elle passe en destinataire, le chercheur en copie.
// 28/10/2026 : action « entetes » { action, boite (adresse), message_id } : relit dans la boîte de réception (IMAP) les destinataires
//   et les personnes en copie d'un mail déjà reçu (rattrapage des réponses arrivées avant la relève des copies). Rien n'est modifié.
//   Options (28/10/2026) : dossier "envoyes" (cherche dans « Éléments envoyés » au lieu de la boîte de réception) et texte: true
//   (renvoie aussi le texte brut du mail) : sert à retrouver le texte d'une réponse déjà envoyée dans le fil d'une fiche.
import nodemailer from "npm:nodemailer@6.9.14";
import MailComposer from "npm:nodemailer@6.9.14/lib/mail-composer/index.js";
import { ImapFlow } from "npm:imapflow@1.0.164";
import { Buffer } from "node:buffer";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { simpleParser } from "npm:mailparser@3.7.1";

const SECRETS: Record<string, string> = {
  "jonathan.paiano@posthumain.com": "WL_SMTP_JONATHAN",
  "valisoa.rasolofo@posthumain.com": "WL_SMTP_VALISOA",
  "subs@posthumain.com": "WL_SMTP_SUBS",
  "redaction@posthumain.com": "WL_SMTP_REDACTION",
};
const INFOMANIAK = { smtp_host: "mail.infomaniak.com", smtp_port: 465, imap_host: "mail.infomaniak.com", imap_port: 993 };
function json(v: unknown, status = 200) {
  return new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
// Liste d'adresses (« "Nom, Prénom" <a@b.ch>, c@d.org » ou tableau) → adresses valides, sans doublon, 10 au plus.
const emailOk = (e: string) => /^[^\s@<>",;]+@[^\s@<>",;]+\.[a-z]{2,}$/i.test(e);
function listeAdresses(v: unknown): string[] {
  const brut = Array.isArray(v) ? v.map(String) : String(v || "").split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/);
  const out: string[] = [];
  for (const x of brut) { const m = x.match(/<([^>]+)>/); const e = String(m ? m[1] : x).trim().toLowerCase(); if (emailOk(e) && !out.includes(e)) out.push(e); }
  return out.slice(0, 10);
}
const mid = (s: unknown) => { const v = String(s || "").trim(); return /^<[^<>\s]+@[^<>\s]+>$/.test(v) ? v : ""; };
async function alerter(cle: string, titre: string, texte: string) {
  try {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 8000);
    await fetch(Deno.env.get("SUPABASE_URL") + "/functions/v1/wl-db", { method: "POST", signal: ctl.signal,
      headers: { "Content-Type": "application/json", "x-tv-secret": Deno.env.get("TV_ADMIN_SECRET") || "" },
      body: JSON.stringify({ action: "alerte", cle, titre, texte }) });
    clearTimeout(t);
  } catch (_) { /* l'alerte ne doit jamais bloquer l'envoi */ }
}
// Boîte ajoutée depuis le lab : réglages + mot de passe (Vault). null si l'adresse n'y est pas (ou boîte désactivée).
// deno-lint-ignore no-explicit-any
async function boiteLab(user: string): Promise<any> {
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const { data } = await db.from("wl_boites").select("id,adresse,identifiant,imap_host,imap_port,smtp_host,smtp_port,secret_id,actif").eq("adresse", user).eq("actif", true).limit(1);
  const b = data && data[0];
  if (!b || !b.secret_id) return null;
  const { data: pass } = await db.rpc("wl_boite_secret_lire", { p_secret_id: b.secret_id });
  return pass ? { ...b, pass: String(pass) } : null;
}

// deno-lint-ignore no-explicit-any
async function deposerEnvoyes(srv: any, user: string, pass: string, raw: Uint8Array) {
  const c = new ImapFlow({ host: srv.imap_host, port: srv.imap_port, secure: srv.imap_port === 993, auth: { user, pass }, logger: false, connectionTimeout: 10000, greetingTimeout: 8000, socketTimeout: 20000 });
  await c.connect();
  try {
    const boites = await c.list();
    // deno-lint-ignore no-explicit-any
    const sent = boites.find((x: any) => x.specialUse === "\\Sent") || boites.find((x: any) => /^(sent|envoy|éléments envoyés|sent items)/i.test(String(x.name || x.path)));
    const path = sent ? sent.path : "Sent";
    await c.append(path, Buffer.from(raw), ["\\Seen"]);
    return path;
  } finally { await c.logout().catch(() => {}); }
}

// Identifiants d'une boîte (historique ou ajoutée depuis le lab) : { srv, login, pass } ou null.
// deno-lint-ignore no-explicit-any
async function acces(user: string): Promise<any> {
  if (SECRETS[user]) { const pass = Deno.env.get(SECRETS[user]) || Deno.env.get("WL_SMTP_PASS") || ""; return pass ? { srv: INFOMANIAK, login: user, pass } : null; }
  const bx = await boiteLab(user).catch(() => null);
  return bx ? { srv: bx, login: String(bx.identifiant || bx.adresse), pass: bx.pass } : null;
}
// 28/10/2026 : destinataires et copies d'un mail reçu, relus dans la boîte de réception (lecture seule, sans marquer le mail lu).
// deno-lint-ignore no-explicit-any
async function entetes(b: any) {
  const user = String(b.boite || "").trim().toLowerCase(), id = mid(b.message_id);
  if (!user || !id) return { ok: false, why: "boîte ou identifiant du mail manquant" };
  const ac = await acces(user); if (!ac) return { ok: false, why: "boîte inconnue ou sans mot de passe" };
  const c = new ImapFlow({ host: ac.srv.imap_host, port: ac.srv.imap_port, secure: ac.srv.imap_port === 993, auth: { user: ac.login, pass: ac.pass }, logger: false, connectionTimeout: 10000, greetingTimeout: 8000, socketTimeout: 20000 });
  const lire = async () => {
    await c.connect();
    try {
      let dossier = "INBOX";
      if (b.dossier === "envoyes") {
        const boites = await c.list();
        // deno-lint-ignore no-explicit-any
        const sent = boites.find((x: any) => x.specialUse === "\\Sent") || boites.find((x: any) => /^(sent|envoy|éléments envoyés|sent items)/i.test(String(x.name || x.path)));
        dossier = sent ? sent.path : "Sent";
      }
      const lock = await c.getMailboxLock(dossier, { readOnly: true });
      try {
        const uids = await c.search({ header: { "message-id": id } }, { uid: true });
        if (!uids || !uids.length) return { ok: true, trouve: false, to: [], cc: [] };
        // deno-lint-ignore no-explicit-any
        const msg: any = await c.fetchOne(String(uids[uids.length - 1]), { envelope: true, source: b.texte === true }, { uid: true });
        let texte = "";
        if (b.texte === true && msg && msg.source) { try { const pm = await simpleParser(msg.source); texte = String(pm.text || "").trim().slice(0, 20000); } catch (_) { texte = ""; } }
        // deno-lint-ignore no-explicit-any
        const conv = (l: any[]) => (l || []).map((a: any) => ({ email: String(a.address || "").toLowerCase(), nom: String(a.name || "").trim() })).filter((a: any) => emailOk(a.email));
        const env = (msg && msg.envelope) || {};
        return { ok: true, trouve: true, de: conv(env.from)[0] || null, to: conv(env.to), cc: conv(env.cc), ...(b.texte === true ? { texte } : {}) };
      } finally { lock.release(); }
    } finally { await c.logout().catch(() => {}); }
  };
  try { return await Promise.race([lire(), new Promise<never>((_, ko) => setTimeout(() => ko(new Error("délai IMAP dépassé")), 30000))]); }
  catch (e) { return { ok: false, why: "imap: " + String((e as Error)?.message || e).slice(0, 160) }; }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ ok: false, why: "method" }, 405);
  const secret = Deno.env.get("TV_ADMIN_SECRET") || "";
  if (!secret || !safeEqual(req.headers.get("x-tv-secret") || "", secret)) return json({ ok: false, why: "unauthorized" }, 401);
  // deno-lint-ignore no-explicit-any
  let b: any; try { b = await req.json(); } catch { return json({ ok: false, why: "bad_json" }); }
  if (b.action === "entetes") return json(await entetes(b));
  const m = String(b.from || "").match(/<([^>]+)>/);
  const user = String(m ? m[1] : b.from || "").trim().toLowerCase();
  // Expéditeur : boîte historique (chemin inchangé) ou boîte active ajoutée depuis le lab.
  // deno-lint-ignore no-explicit-any
  let srv: any = INFOMANIAK, login = user, pass = "";
  if (SECRETS[user]) {
    pass = Deno.env.get(SECRETS[user]) || Deno.env.get("WL_SMTP_PASS") || "";
    if (!pass) { await alerter("wl-mail:mdp", "mot de passe SMTP absent", "Le mot de passe SMTP des boîtes @posthumain.com est absent de Supabase : les mails partent par le secours n8n (sans fil, sans pièces jointes ni copie dans les Envoyés)."); return json({ ok: false, why: "mot de passe SMTP absent" }); }
  } else {
    const bx = await boiteLab(user).catch(() => null);
    if (!bx) return json({ ok: false, why: "expéditeur refusé" });
    srv = bx; login = String(bx.identifiant || bx.adresse); pass = bx.pass;
  }
  if (!b.to || !b.sujet || !b.corps) return json({ ok: false, why: "mail incomplet" });
  const irt = mid(b.in_reply_to);
  const refs = String(b.references || "").split(/\s+/).map(mid).filter(Boolean).slice(-20);
  if (irt && !refs.includes(irt)) refs.push(irt);
  const domaine = SECRETS[user] ? "posthumain.com" : (user.split("@")[1] || "posthumain.com");
  const messageId = "<wl-" + crypto.randomUUID() + "@" + domaine + ">";
  // deno-lint-ignore no-explicit-any
  const attachments = (Array.isArray(b.attachments) ? b.attachments : []).slice(0, 5).map((a: any) => ({
    // deno-lint-ignore no-explicit-any
    filename: String(a.nom || "fichier").slice(0, 200), contentType: String(a.type || "application/octet-stream"), content: String(a.data || ""), encoding: "base64" })).filter((a: any) => a.content);
  const html = typeof b.html === "string" && b.html.trim() ? String(b.html).slice(0, 80000) : undefined;
  // Copie (28/10/2026) : jamais l'expéditeur ni un destinataire principal ; l'en-tête garde les noms tels que fournis.
  const toAdr = listeAdresses(b.to), ccAdr = listeAdresses(b.cc).filter((e) => e !== user && !toAdr.includes(e));
  const ccHdr = ccAdr.length ? (Array.isArray(b.cc) ? b.cc.map(String) : String(b.cc).split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)).map((x) => x.trim())
    .filter((x) => { const mm = x.match(/<([^>]+)>/); return ccAdr.includes(String(mm ? mm[1] : x).trim().toLowerCase()); }).join(", ") : "";
  // deno-lint-ignore no-explicit-any
  const opts: any = { from: b.from, to: b.to, cc: ccHdr || undefined, subject: String(b.sujet).slice(0, 300), text: String(b.corps).slice(0, 50000), html, date: new Date(),
    messageId, inReplyTo: irt || undefined, references: refs.length ? refs.join(" ") : undefined, attachments };
  let raw: Uint8Array;
  try { raw = new Uint8Array(await new MailComposer(opts).compile().build()); }
  catch (e) { return json({ ok: false, why: "composition: " + String((e as Error)?.message || e).slice(0, 200) }); }
  // deno-lint-ignore no-explicit-any
  let info: any;
  try {
    const t = nodemailer.createTransport({ host: srv.smtp_host, port: srv.smtp_port, secure: srv.smtp_port === 465, auth: { user: login, pass }, connectionTimeout: 10000, greetingTimeout: 8000, socketTimeout: 20000 });
    // Envoi du message déjà composé : la copie déposée dans « Envoyés » est identique, octet pour octet.
    const dest = [...toAdr, ...ccAdr].join(",") || ([] as string[]).concat(b.to).join(",");
    info = await t.sendMail({ envelope: { from: user, to: dest }, raw: Buffer.from(raw) });
  } catch (e) {
    const why = String((e as Error)?.message || e).slice(0, 200);
    await alerter("wl-mail:smtp:" + user, "envoi refusé", "Le serveur d’envoi " + srv.smtp_host + " a refusé un mail de " + user + " : " + why + ". Le secours n8n a pris le relais si c’était possible.");
    return json({ ok: false, why: "smtp: " + why });
  }
  // Copie dans « Éléments envoyés » en arrière-plan : la réponse part dès que le SMTP a accepté le mail,
  // pour que n8n n'attende jamais (et ne croie jamais à un échec suivi d'un renvoi en double).
  const copie = Promise.race([deposerEnvoyes(srv, login, pass, raw), new Promise<never>((_, ko) => setTimeout(() => ko(new Error("délai IMAP dépassé")), 25000))])
    .then((dossier) => console.log("wl-mail copie", user, dossier))
    .catch(async (e) => {
      const why = String((e as Error)?.message || e).slice(0, 200);
      console.log("wl-mail copie échouée", user, why);
      await alerter("wl-mail:imap:" + user, "copie Envoyés impossible", "Un mail de " + user + " est bien parti, mais sa copie n’a pas pu être rangée dans les Éléments envoyés (" + why + ").");
    });
  // deno-lint-ignore no-explicit-any
  try { (globalThis as any).EdgeRuntime?.waitUntil(copie); } catch (_) { /* hors Supabase : la promesse continue seule */ }
  return json({ ok: true, via: "supabase", message_id: messageId, cc: ccAdr, accepted: info.accepted || [], copie_envoyes: "en cours" });
});
