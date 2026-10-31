// Writinglab — wl-citations (31/10/2026, demande de Jonathan et de Valisoa) : ce que l'Assistant propose ne se perd plus.
//  1. Propositions de citations gardées par fiche (table wl_citations) : on les retrouve après une fermeture de page, un redémarrage
//     ou sur un autre appareil, avec ce qui a été écarté, modifié ou inséré.
//  2. Relecture des citations par le contact : « demander » prépare dans le fil de la fiche un mail au texte FIXE (les passages
//     recopiés mot pour mot, date limite à J+7), qui ne part qu'après « Valider et envoyer » (wl-tel suite_envoyer) ; « déjà envoyée »
//     si la journaliste l'a fait elle-même ; « validée » quand le contact a dit oui. Sans réponse du contact 7 jours après l'envoi
//     (et au plus tôt à la date annoncée), les citations passent « auto-validées » : trace datée dans l'historique de la fiche et
//     message de l'Assistant dans l'Interphone (notification). Insérer sans attendre reste possible ; c'est noté à l'insertion (n8n).
//  3. Brouillon de l'Assistant (contact, questions proposées, angle) gardé par membre et par article (table wl_brouillons).
// Appel public depuis posthumain.com/writinglab, mais rien n'est accepté sans le jeton du membre Ghost (vérifié avec les clés publiques
// du site) ET un membre actif de l'équipe (equipe.ts, copie identique à celle des autres fonctions). Lecture : toute l'équipe (tout le
// monde voit tout dans le lab) ; écriture : la rédactrice de la fiche ou un rédacteur en chef.
// Corps JSON : { token, action, ... }
//   citations_lire { fiche_id } · citations_enregistrer { fiche_id, props, nouvelles? } · citations_validation { fiche_id, etape, le? }
//   citations_echeances {} · brouillon_lire { article_id } · brouillon_ecrire { article_id, data }
// Règles de calcul (échéance, auto-validation, mail) : citations.ts, testées hors ligne (deno test supabase/functions/wl-citations).
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { parEmail, type Membre } from "./equipe.ts";
import { bilanValidation, CIT_JOURS, dateLongue, echeanceDe, mailRelecture, passage, propsPropres } from "./citations.ts";

const env = (k: string) => (Deno.env.get(k) || "").trim();
const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const ORIGINES = ["https://posthumain.com", "https://www.posthumain.com"];
const SITE = "https://posthumain.com";

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
  if (!jwksCache || Date.now() - jwksCache.at > 3600e3) {
    const r = await fetch(SITE + "/members/.well-known/jwks.json"); if (!r.ok) return null;
    jwksCache = { at: Date.now(), keys: (await r.json()).keys || [] };
  }
  // deno-lint-ignore no-explicit-any
  const jwk = jwksCache.keys.find((k: any) => !header.kid || k.kid === header.kid);
  if (!jwk) return null;
  const key = await crypto.subtle.importKey("jwk", { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: header.alg, ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: hashes[header.alg] }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64u(parts[2]), new TextEncoder().encode(parts[0] + "." + parts[1]));
  if (!ok || !payload.exp || payload.exp * 1000 < Date.now()) return null;
  if (payload.iss && !/^https:\/\/(posthumain\.com|the-last-journal\.ghost\.io)\//.test(String(payload.iss))) return null;
  return await parEmail(db, String(payload.sub || ""));
}
// deno-lint-ignore no-explicit-any
const pj = (v: any) => { if (v == null) return null; if (typeof v !== "string") return v; try { return JSON.parse(v); } catch { return null; } };

// Validation automatique, appliquée à la lecture (fiche ouverte, ouverture du lab) : trace dans l'historique de la fiche, datée du
// moment où l'échéance est tombée, et message de l'Assistant dans l'Interphone (wl-db envoie la notification à l'équipe).
// deno-lint-ignore no-explicit-any
async function citEcheance(c: any, f: any): Promise<any> {
  const hist = pj(f.historique) || [];
  const r = bilanValidation(c, f, hist, new Date());
  if (!r) return c;
  const { data } = await db.from("wl_citations").update({ ...r.patch, updated_at: new Date().toISOString() }).eq("fiche_id", c.fiche_id).eq("etat", "a_valider").select("*");
  const c2 = (data && data[0]) || null;
  if (!c2) { const { data: d2 } = await db.from("wl_citations").select("*").eq("fiche_id", c.fiche_id).limit(1); return (d2 && d2[0]) || c; }
  if (r.auto) {
    const nom = String(f.contact_nom || "le contact"), envoi = dateLongue(new Date(r.envoyee_le), false);
    hist.push({ t: r.patch.validee_le, e: "citations auto-validées par non-réponse : " + nom + " n’a pas répondu à la demande de relecture envoyée le " + envoi + " (" + CIT_JOURS + " jours)", par: "assistant" });
    await db.from("wl_fiches").update({ historique: JSON.stringify(hist.slice(-60)) }).eq("fiche_id", f.fiche_id);
    try {
      await fetch(env("SUPABASE_URL") + "/functions/v1/wl-db", { method: "POST", signal: AbortSignal.timeout(15000), headers: { "Content-Type": "application/json", "x-tv-secret": env("TV_ADMIN_SECRET") },
        body: JSON.stringify({ action: "insert", table: "messages", row: { auteur: "assistant", nom: "🧠 L’Assistant", article_id: f.article_id || null, article_titre: f.article_titre || null,
          texte: "✅ Les citations de " + nom + " sont validées automatiquement : pas de réponse " + CIT_JOURS + " jours après la demande de relecture du " + envoi + ". Elles peuvent être insérées dans « " + (f.article_titre || "l’article") + " » (si " + nom + " se manifeste plus tard, on corrigera)." } }) });
    } catch (_) { /* la notification ne bloque jamais */ }
  }
  return c2;
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

    if (b.action === "citations_lire" || b.action === "citations_enregistrer" || b.action === "citations_validation") {
      const { data: f0 } = await db.from("wl_fiches").select("fiche_id,article_id,article_titre,redacteur,statut,contact_nom,contact_email,langue,reponse_le,reponse_preuve,historique,mail_sujet,suite_corps,suites,copies").eq("fiche_id", String(b.fiche_id || "")).limit(1);
      const f = f0 && f0[0];
      if (!f) return out({ ok: false, why: "fiche introuvable" }, 404);
      const peut = me.chef || f.redacteur === me.id;
      const { data: c0 } = await db.from("wl_citations").select("*").eq("fiche_id", f.fiche_id).limit(1);
      // deno-lint-ignore no-explicit-any
      let c: any = (c0 && c0[0]) || null;
      if (c) c = await citEcheance(c, f);
      if (b.action === "citations_lire") return out({ ok: true, cit: c, peut });
      if (!peut) return out({ ok: false, why: "cette fiche n’est pas la vôtre" }, 403);
      const now = new Date(), hist = pj(f.historique) || [];
      if (b.action === "citations_enregistrer") {
        const props = propsPropres(b.props);
        // deno-lint-ignore no-explicit-any
        const row: any = { fiche_id: f.fiche_id, article_id: f.article_id || null, props, updated_at: now.toISOString() };
        if (!c) row.cree_par = me.id;
        if (b.nouvelles === true && c && c.etat !== "proposees") {
          Object.assign(row, { etat: "proposees", demandee_le: null, envoyee_le: null, echeance: null, validee_le: null, validation_mode: null, validee_par: null });
          hist.push({ t: now.toISOString(), e: "nouvelles propositions de citations (la relecture précédente ne s’applique plus)", par: me.id });
          await db.from("wl_fiches").update({ historique: JSON.stringify(hist.slice(-60)) }).eq("fiche_id", f.fiche_id);
        }
        const { data, error } = await db.from("wl_citations").upsert(row, { onConflict: "fiche_id" }).select("*");
        if (error) return out({ ok: false, why: "enregistrement impossible" }, 500);
        return out({ ok: true, cit: data && data[0], peut });
      }
      // citations_validation : demander | deja_envoyee | validee | annuler
      if (!c || !(c.props || []).length) return out({ ok: false, why: "aucune proposition enregistrée pour cette fiche" });
      const etape = String(b.etape || ""), nom = String(f.contact_nom || "le contact");
      // deno-lint-ignore no-explicit-any
      let patch: any = null, ev = "", mail: any = null;
      // deno-lint-ignore no-explicit-any
      const envoyees: any[] = Array.isArray(f.suites) ? f.suites : (pj(f.suites) || []);
      if (etape === "demander") {
        if (f.suite_corps) return out({ ok: false, why: "une réponse attend déjà d’être envoyée dans cette fiche : envoyez-la ou écartez-la d’abord" });
        if (!["envoyé", "a répondu", "relance", "inséré"].includes(String(f.statut))) return out({ ok: false, why: "pas de mail possible dans le fil de cette fiche (statut : " + f.statut + ")" });
        const emailOk = (e: string) => /^[^\s@<>]+@[^\s@<>]+\.[a-z]{2,}$/i.test(e);
        const pv = pj(f.reponse_preuve) || {}, contact = String(f.contact_email || "").trim().toLowerCase(), de = String(pv.de || "").trim().toLowerCase();
        const dom = (e: string) => e.split("@")[1] || "";
        // Même destinataire que wl-tel suite_rediger : la personne qui a écrit (même domaine que le contact), sinon le contact ;
        // et si le dernier échange avait été adressé à une personne en copie (son assistante…), on continue avec elle.
        const destContact = de && emailOk(de) && pv.lien !== "telephone" && (de === contact || dom(de) === dom(contact)) ? de : contact;
        if (!emailOk(destContact)) return out({ ok: false, why: "adresse e-mail du contact manquante ou invalide" });
        const dern = envoyees.length ? envoyees[envoyees.length - 1] : null;
        // deno-lint-ignore no-explicit-any
        const copiesF: any[] = (pj(f.copies) || []).filter((x: any) => x && emailOk(String(x.email || "")));
        const aDern = dern && Array.isArray(dern.cc) && dern.cc.length ? String(dern.a || "").toLowerCase() : "";
        const dest = aDern && copiesF.some((x) => x.email === aDern) ? aDern : destContact;
        const cc = dest !== destContact ? [destContact] : [];
        // deno-lint-ignore no-explicit-any
        const liste = (c.props || []).filter((x: any) => !x.skip);
        if (!liste.length) return out({ ok: false, why: "toutes les propositions sont écartées" });
        const ech = echeanceDe(now), en = f.langue === "en";
        const base = String(f.mail_sujet || "").trim();
        const sujet = (/^\s*(re|tr|fwd?)\s*:/i.test(base) ? base : "Re: " + base).slice(0, 300);
        const nomA = dest === destContact ? nom : String((copiesF.find((x) => x.email === dest) || {}).nom || "");
        const corps = mailRelecture({ nom: nomA, titre: String(f.article_titre || ""), en, passages: liste.map(passage), echeance: ech });
        hist.push({ t: now.toISOString(), e: "relecture des citations demandée à " + nom + " (mail préparé, à valider ; réponse attendue d’ici le " + dateLongue(ech, false) + ")", par: me.id });
        // Rangé comme une réponse dans le fil (mêmes colonnes que wl-tel suite_rediger) : relu, puis « Valider et envoyer » dans la fiche.
        await db.from("wl_fiches").update({ suite_sujet: sujet, suite_corps: corps, suite_consigne: "Demande de relecture des citations (texte fixe, passages recopiés à l’identique).", suite_a: dest, suite_cc: cc, suite_prete_le: now.toISOString(), historique: JSON.stringify(hist.slice(-60)) }).eq("fiche_id", f.fiche_id);
        patch = { etat: "a_valider", demandee_le: now.toISOString(), envoyee_le: null, echeance: ech.toISOString(), validee_le: null, validation_mode: null, validee_par: null };
        mail = { sujet, corps, a: dest, cc };
      } else if (etape === "deja_envoyee") {
        // Envoyés par la journaliste elle-même : date fournie (passée, de moins de 30 jours), sinon sa dernière réponse dans le fil.
        const dl = b.le ? new Date(String(b.le)) : null;
        const derniere = envoyees.length ? new Date(String(envoyees[envoyees.length - 1].le || "")) : null;
        const le = dl && !isNaN(dl.getTime()) && dl <= now && now.getTime() - dl.getTime() < 30 * 864e5 ? dl : derniere && !isNaN(derniere.getTime()) ? derniere : now;
        patch = { etat: "a_valider", demandee_le: le.toISOString(), envoyee_le: le.toISOString(), echeance: echeanceDe(le).toISOString(), validee_le: null, validation_mode: null, validee_par: null };
        ev = "citations envoyées à " + nom + " pour relecture le " + dateLongue(le, false) + " (indiqué par " + me.nom + ") : sans réponse, validation automatique après " + CIT_JOURS + " jours";
      } else if (etape === "validee") {
        patch = { etat: "validees", validee_le: now.toISOString(), validation_mode: "contact", validee_par: me.id };
        ev = "citations validées par " + nom + " (confirmé par " + me.nom + ")";
      } else if (etape === "annuler") {
        patch = { etat: "proposees", demandee_le: null, envoyee_le: null, echeance: null, validee_le: null, validation_mode: null, validee_par: null };
        ev = "demande de relecture des citations annulée";
      } else return out({ ok: false, why: "étape inconnue" }, 400);
      if (ev) { hist.push({ t: now.toISOString(), e: ev, par: me.id }); await db.from("wl_fiches").update({ historique: JSON.stringify(hist.slice(-60)) }).eq("fiche_id", f.fiche_id); }
      const { data, error } = await db.from("wl_citations").update({ ...patch, updated_at: now.toISOString() }).eq("fiche_id", f.fiche_id).select("*");
      if (error) return out({ ok: false, why: "enregistrement impossible" }, 500);
      return out({ ok: true, cit: data && data[0], peut, mail });
    }
    // Échéances : à l'ouverture du lab, les relectures restées 7 jours sans réponse passent « auto-validées ».
    if (b.action === "citations_echeances") {
      const { data: cs } = await db.from("wl_citations").select("*").eq("etat", "a_valider").limit(200);
      let n = 0;
      for (const c of cs || []) {
        const { data: f0 } = await db.from("wl_fiches").select("fiche_id,article_id,article_titre,redacteur,contact_nom,reponse_le,historique").eq("fiche_id", c.fiche_id).limit(1);
        if (f0 && f0[0]) { const r = await citEcheance(c, f0[0]); if (r && r.etat === "auto_validees") n++; }
      }
      return out({ ok: true, auto: n });
    }
    // Brouillon de l'Assistant (contact, questions proposées, angle), par membre et par article.
    if (b.action === "brouillon_lire") {
      const aid = String(b.article_id || "").slice(0, 80); if (!aid) return out({ ok: false, why: "article manquant" }, 400);
      const { data } = await db.from("wl_brouillons").select("data,updated_at").eq("membre", me.id).eq("article_id", aid).limit(1);
      return out({ ok: true, data: data && data[0] ? data[0].data : null, maj: data && data[0] ? data[0].updated_at : null });
    }
    if (b.action === "brouillon_ecrire") {
      const aid = String(b.article_id || "").slice(0, 80); if (!aid) return out({ ok: false, why: "article manquant" }, 400);
      const d = b.data && typeof b.data === "object" && !Array.isArray(b.data) ? b.data : {};
      if (JSON.stringify(d).length > 80000) return out({ ok: false, why: "brouillon trop long" }, 400);
      const { error } = await db.from("wl_brouillons").upsert({ membre: me.id, article_id: aid, data: d, updated_at: new Date().toISOString() }, { onConflict: "membre,article_id" });
      if (error) return out({ ok: false, why: "enregistrement impossible" }, 500);
      return out({ ok: true });
    }
    return out({ ok: false, why: "action inconnue" }, 400);
  } catch (e) {
    return out({ ok: false, why: String((e as Error)?.message || e).slice(0, 200) });
  }
});
