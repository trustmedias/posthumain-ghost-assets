// Posthumain — vote : « Votez pour la prochaine enquête premium » (posthumain.com/vote), 22/10/2026.
// Tout le système tourne ici (aucune exécution n8n) : état public, propositions, votes, modération et fusion IA,
// clôture mensuelle (appelée par pg_cron via l'action « tick », idempotente), écriture du gagnant dans Airtable Radar,
// vue « Rédaction » et publication de la page Ghost /vote.
//
// Règles (décidées par Jonathan) :
//  - un tour = un mois ; propositions ouvertes 14 jours au plus (jusqu'au 15 à 20 h, heure suisse) ou jusqu'à ce que l'IA
//    ait fixé les 3 sujets (6e proposition) ; vote jusqu'au dernier jour du mois à 20 h ;
//  - seuls les abonnés premium (Ghost : paid ou comped) proposent (1 par tour) et votent (1 par tour, modifiable) ;
//  - les membres gratuits voient tout ; les visiteurs non connectés ne voient que les compteurs ;
//  - à la 6e proposition, Claude fusionne / choisit et reformule EXACTEMENT 3 sujets ; les votes déjà donnés sur une
//    proposition comptent pour le sujet qui l'absorbe ; le gagnant = le plus de votes cumulés depuis le début du tour.
// Contrôles : jeton d'identité Ghost signé (JWKS) + statut lu dans l'API Admin Ghost, verrous SQL (fonctions vote_*),
// limites de débit par membre et par IP, modération IA, CORS limité à posthumain.com.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { createRemoteJWKSet, jwtVerify } from "npm:jose@5.9.6";

const env = (k: string) => (Deno.env.get(k) || "").trim();
const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const SITE = "https://posthumain.com";
const ORIGINES = ["https://posthumain.com", "https://www.posthumain.com"];
const EQUIPE: Record<string, string> = { "jonathan.paiano@outlook.com": "jonathan", "valisoan2915@gmail.com": "valisoa" };
const AIRTABLE_BASE = "appPc2y4ts9tVZCjQ"; // base « Radar » de l'Usine (identifiant non secret ; le jeton, lui, est un secret Supabase)
const THEMES: Record<string, string> = {
  ia: "Intelligence artificielle", cerveau: "Cerveau & neurosciences", vivant: "Génétique & vivant", sante: "Santé & longévité",
  energie: "Énergie & climat", espace: "Espace", cyber: "Cybersécurité & dangers", societe: "Travail & société", futurs: "Futurs",
};
const MAX_AVANT_IA = 5; // les 5 premières propositions entrent telles quelles ; l'IA tranche à la 6e

// ---------------------------------------------------------------------------- outils
const json = (v: unknown, s = 200, h: Record<string, string> = {}) =>
  new Response(JSON.stringify(v), { status: s, headers: { ...h, "Content-Type": "application/json", "Cache-Control": "no-store" } });
function cors(origin: string): Record<string, string> {
  const h: Record<string, string> = { "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "authorization, content-type", "Access-Control-Max-Age": "86400", "Vary": "Origin" };
  if (ORIGINES.includes(origin)) h["Access-Control-Allow-Origin"] = origin;
  return h;
}
const enc = new TextEncoder();
function egal(a: string, b: string) { if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; }
const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, "0")).join("");
async function sha(s: string) { return hex(await crypto.subtle.digest("SHA-256", enc.encode(s))); }
const propre = (s: unknown, max: number) => String(s ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim().slice(0, max);
function waitUntil(p: Promise<unknown>) {
  // deno-lint-ignore no-explicit-any
  const rt = (globalThis as any).EdgeRuntime;
  if (rt && typeof rt.waitUntil === "function") rt.waitUntil(p); else p.catch(() => {});
}

// Heure suisse → instant UTC (gère l'heure d'été)
function offsetZurich(d: Date) {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Zurich", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(d);
  const g = (t: string) => Number(p.find((x) => x.type === t)!.value);
  return Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second")) - d.getTime();
}
function zurich(y: number, m: number, j: number, h = 20, mi = 0) {
  const guess = Date.UTC(y, m - 1, j, h, mi);
  let t = guess - offsetZurich(new Date(guess));
  t = guess - offsetZurich(new Date(t));
  return new Date(t);
}
const dernierJour = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
function partsZurich(d = new Date()) {
  const [y, m, j] = new Intl.DateTimeFormat("fr-CA", { timeZone: "Europe/Zurich", year: "numeric", month: "2-digit", day: "2-digit" }).format(d).split("-").map(Number);
  return { y, m, j };
}
const moisTxt = (mois: string) => { const [y, m] = mois.split("-").map(Number); return ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"][m - 1] + " " + y; };

// ---------------------------------------------------------------------------- Ghost (Admin API + jeton membre)
const JWKS = createRemoteJWKSet(new URL(`${SITE}/members/.well-known/jwks.json`));
const ISSUERS = ["posthumain.com", "www.posthumain.com", "the-last-journal.ghost.io"];
async function emailDuJeton(req: Request): Promise<string | null> {
  const t = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!t || t.length > 4096) return null;
  try {
    const { payload } = await jwtVerify(t, JWKS, { algorithms: ["RS512", "RS256"] });
    let host = ""; try { host = new URL(String(payload.iss || "")).hostname; } catch { /* iss invalide */ }
    if (!ISSUERS.includes(host)) return null;
    const e = String(payload.sub || "").trim().toLowerCase();
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 320 ? e : null;
  } catch { return null; }
}
function b64url(input: ArrayBuffer | string) {
  const bytes = typeof input === "string" ? enc.encode(input) : new Uint8Array(input);
  let s = ""; for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/=+$/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
async function ghostJwt() {
  const [id, secret] = env("GHOST_ADMIN_API_KEY").split(":");
  if (!id || !secret) throw new Error("ghost_not_configured");
  const iat = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: "HS256", kid: id, typ: "JWT" }));
  const body = b64url(JSON.stringify({ iat, exp: iat + 300, aud: "/admin/" }));
  const k = await crypto.subtle.importKey("raw", new Uint8Array(secret.match(/.{2}/g)!.map((h) => parseInt(h, 16))), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return `${head}.${body}.${b64url(await crypto.subtle.sign("HMAC", k, enc.encode(`${head}.${body}`)))}`;
}
// deno-lint-ignore no-explicit-any
async function ghost(path: string, init: RequestInit = {}): Promise<any> {
  const url = env("GHOST_ADMIN_API_URL").replace(/\/+$/g, "");
  if (!url) throw new Error("ghost_not_configured");
  const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 15000);
  try {
    const r = await fetch(`${url}/ghost/api/admin${path}`, { ...init, signal: ctl.signal, headers: { Authorization: `Ghost ${await ghostJwt()}`, "Accept-Version": "v5.0", ...(init.body ? { "Content-Type": "application/json" } : {}) } });
    const t = await r.text(); let d: unknown = null; try { d = t ? JSON.parse(t) : null; } catch { d = t; }
    if (!r.ok) throw new Error(`ghost ${r.status}: ${String(t).slice(0, 200)}`);
    return d;
  } finally { clearTimeout(to); }
}
type Membre = { email: string; nom: string; statut: string; premium: boolean };
const cacheMembres = new Map<string, { m: Membre; exp: number }>();
async function membre(email: string): Promise<Membre> {
  const c = cacheMembres.get(email);
  if (c && c.exp > Date.now()) return c.m;
  const f = encodeURIComponent(`email:'${email.replace(/'/g, "\\'")}'`);
  const out = await ghost(`/members/?filter=${f}&limit=1&fields=id,email,name,status`);
  const g = out?.members?.[0];
  const statut = g ? String(g.status || "free") : "aucun";
  const m = { email, nom: String(g?.name || "").slice(0, 120), statut, premium: statut === "paid" || statut === "comped" };
  cacheMembres.set(email, { m, exp: Date.now() + (m.premium ? 5 : 1) * 60_000 });
  return m;
}

let cacheTiers: { v: unknown; exp: number } | null = null;
async function avantages() {
  if (cacheTiers && cacheTiers.exp > Date.now()) return cacheTiers.v;
  let v: unknown = null;
  try {
    const out = await ghost(`/tiers/?filter=${encodeURIComponent("type:paid+active:true")}&include=monthly_price,yearly_price,benefits&limit=5`);
    v = (out?.tiers || []).filter((x: { visibility?: string }) => x.visibility !== "none").map((x: { name: string; description: string; benefits: string[]; monthly_price: number; yearly_price: number; currency: string }) => ({
      nom: x.name, description: x.description || "", avantages: (x.benefits || []).slice(0, 8), mensuel: x.monthly_price || null, annuel: x.yearly_price || null, devise: String(x.currency || "eur").toUpperCase(),
    }));
  } catch (_) { v = null; }
  cacheTiers = { v, exp: Date.now() + 3600_000 };
  return v;
}

// ---------------------------------------------------------------------------- Claude (modération, fusion, reformulation)
const TARIFS: Record<string, [number, number]> = { "claude-opus-5-5": [4, 20], "claude-sonnet-5-5": [2, 10], "claude-haiku-5-5": [0.1, 0.5] }; // USD / million de jetons (mêmes valeurs que wl-db)
const USD_EUR = 0.92;
// deno-lint-ignore no-explicit-any
async function claude(model: string, effort: string, system: string, user: string, maxTokens: number, timeoutMs: number): Promise<any> {
  const key = env("ANTHROPIC_API_KEY"); if (!key) throw new Error("clé Anthropic absente");
  const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST", signal: ctl.signal,
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model, max_tokens: maxTokens, thinking: { type: "adaptive" }, output_config: { effort }, system, messages: [{ role: "user", content: user }] }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Claude ${r.status}: ${String(j?.error?.message || "").slice(0, 160)}`);
    const u = j.usage || {};
    const [pi, po] = TARIFS[model] || [4, 20];
    const tin = Number(u.input_tokens || 0) + 1.25 * Number(u.cache_creation_input_tokens || 0) + 0.1 * Number(u.cache_read_input_tokens || 0);
    const eur = ((tin * pi + Number(u.output_tokens || 0) * po) / 1e6) * USD_EUR;
    db.from("wl_couts").insert({ membre: "vote", usage: "vote", modele: model, tokens_in: Math.round(tin), tokens_out: Number(u.output_tokens || 0), cout_eur: Math.round(eur * 1e5) / 1e5 }).then(() => {}, () => {});
    const txt = (j.content || []).filter((c: { type: string }) => c.type === "text").map((c: { text: string }) => c.text).join("").trim();
    const m = txt.match(/\{[\s\S]*\}/);
    if (!m) throw new Error("réponse IA illisible");
    return JSON.parse(m[0]);
  } finally { clearTimeout(to); }
}

async function moderer(them: string, titre: string, detail: string): Promise<{ ok: boolean; motif: string }> {
  try {
    const r = await claude("claude-haiku-5-5", "low",
      "Tu modères les propositions de sujets d'enquête envoyées par les abonnés de Posthumain, média francophone sur l'IA, les technologies, la génétique, les neurosciences, la santé du futur, l'énergie, l'espace, la cybersécurité et les futurs de la société. " +
      "Accepte toute idée sincère, même maladroite, mal orthographiée ou en anglais, si elle peut devenir une enquête dans ce périmètre. " +
      "Refuse : insultes, haine, contenu sexuel, attaques contre une personne privée, spam ou publicité, texte vide de sens, demandes dangereuses (fabriquer une arme, pirater, nuire), sujets sans aucun lien avec la ligne éditoriale. " +
      "Réponds UNIQUEMENT en JSON : {\"ok\": true|false, \"motif\": \"si refus : une phrase courte, polie, en français, qui explique quoi changer\"}.",
      `Thématique choisie : ${THEMES[them] || them}\nSujet proposé : ${titre}\nPrécisions : ${detail || "(aucune)"}`, 300, 20000);
    return { ok: r.ok === true, motif: propre(r.motif, 320) };
  } catch (_) {
    // IA indisponible : on n'empêche pas un abonné de participer, la rédaction peut écarter ensuite
    return { ok: true, motif: "" };
  }
}

// Fusion : 6+ propositions → EXACTEMENT 3 sujets, chacun rattaché à ses propositions sources
async function fusion(tourId: number) {
  try {
    const { data: props } = await db.from("vote_propositions").select("id,thematique,titre,detail,statut").eq("tour_id", tourId).neq("statut", "ecartee").order("id");
    const { data: sc } = await db.rpc("vote_scores", { p_tour: tourId });
    const votes = new Map((sc || []).filter((x: { cible_type: string }) => x.cible_type === "proposition").map((x: { cible_id: number; votes: number }) => [x.cible_id, x.votes]));
    const liste = (props || []).map((p) => `#${p.id} [${THEMES[p.thematique] || p.thematique}] ${p.titre}${p.detail ? " — " + p.detail : ""} (${votes.get(p.id) || 0} vote(s))`).join("\n");
    const ids = new Set((props || []).map((p) => p.id));
    let r: { sujets?: { titre: string; description: string; thematique: string; sources: number[] }[]; justification?: string } | null = null, err = "";
    for (let essai = 0; essai < 2 && !r; essai++) {
      try {
        const out = await claude("claude-opus-5-5", "medium",
          "Tu es le rédacteur en chef de Posthumain, média francophone d'enquêtes sur l'IA, les technologies, la génétique, les neurosciences et les futurs humains, lu par un grand public curieux (pas des spécialistes). " +
          "Les abonnés premium ont proposé des sujets pour la prochaine enquête premium. Ton rôle : en tirer EXACTEMENT 3 sujets d'enquête soumis au vote. " +
          "Fusionne les propositions qui se recoupent, garde les idées les plus fortes et fascinantes, tiens compte des votes déjà reçus (une proposition très votée doit rester reconnaissable), et reformule chaque sujet en un titre accrocheur mais honnête (pas de promesse que l'enquête ne pourra pas tenir, pas de point d'exclamation, 90 caractères max) " +
          "et une description d'une phrase (200 caractères max) qui dit ce que l'enquête va révéler. Chaque proposition peut alimenter AU PLUS un sujet ; une proposition faible ou hors-sujet peut n'être rattachée à aucun. Chaque sujet doit avoir au moins une proposition source. " +
          "thematique = une de ces clés : " + Object.keys(THEMES).join(", ") + ". " +
          "Réponds UNIQUEMENT en JSON : {\"sujets\":[{\"titre\":\"…\",\"description\":\"…\",\"thematique\":\"…\",\"sources\":[ids numériques]}],\"justification\":\"3 à 5 phrases pour la rédaction : ce que tu as fusionné, écarté et pourquoi\"}",
          "Propositions des abonnés :\n" + liste, 4000, 120000);
        const s = Array.isArray(out?.sujets) ? out.sujets : [];
        const vus = new Set<number>();
        const net = s.slice(0, 3).map((x: { titre: unknown; description: unknown; thematique: unknown; sources: unknown }) => ({
          titre: propre(x.titre, 160), description: propre(x.description, 400), thematique: THEMES[String(x.thematique)] ? String(x.thematique) : "futurs",
          sources: (Array.isArray(x.sources) ? x.sources : []).map(Number).filter((n: number) => ids.has(n) && !vus.has(n) && (vus.add(n), true)),
        }));
        if (net.length !== 3 || net.some((x: { titre: string; sources: number[] }) => x.titre.length < 8 || !x.sources.length)) throw new Error("l'IA n'a pas rendu 3 sujets valides");
        r = { sujets: net, justification: propre(out?.justification, 2000) };
      } catch (e) { err = String((e as Error)?.message || e).slice(0, 300); }
    }
    if (!r) throw new Error(err || "fusion impossible");
    const { data: ap, error } = await db.rpc("vote_appliquer_ia", { p_tour: tourId, p_sujets: r.sujets, p_justif: r.justification || "" });
    if (error || !ap?.ok) throw new Error(error?.message || ap?.why || "application impossible");
    await annoncer("🗳️ Les 3 sujets du vote sont fixés (" + (props || []).length + " propositions fusionnées par l'IA) : " + r.sujets!.map((x, i) => (i + 1) + ". " + x.titre).join(" · "), "🗳️ Votes : les 3 sujets sont fixés", r.sujets!.map((x) => x.titre).join(" · "));
  } catch (e) {
    const msg = String((e as Error)?.message || e).slice(0, 300);
    await db.from("vote_tours").update({ ia_etat: "echec", ia_erreur: msg }).eq("id", tourId).eq("ia_etat", "en_cours");
    await annoncer("🚨 Votes du public : la fusion IA des propositions a échoué (" + msg + "). Nouvel essai automatique, ou « Relancer l'IA » dans la vue Rédaction de posthumain.com/vote.", "🚨 Votes : fusion IA en échec", msg);
  }
}

// ---------------------------------------------------------------------------- Interphone + push (rédaction)
async function annoncer(texte: string, titrePush: string, msgPush: string, qui: string[] = ["jonathan"]) {
  try { await db.from("wl_messages").insert({ auteur: "vote", nom: "🗳️ Les votes du public", texte: texte.slice(0, 1500) }); } catch (_) { /* jamais bloquant */ }
  const key = env("WEBPUSHR_KEY"), token = env("WEBPUSHR_TOKEN");
  if (!key || !token) return;
  const { data } = await db.from("wl_push").select("sid").in("membre", qui);
  await Promise.all((data || []).map((r: { sid: string }) => fetch("https://api.webpushr.com/v1/notification/send/sid", {
    method: "POST", headers: { webpushrKey: key, webpushrAuthToken: token, "Content-Type": "application/json" },
    body: JSON.stringify({ title: titrePush.slice(0, 100), message: (msgPush || " ").replace(/\s+/g, " ").slice(0, 250), target_url: SITE + "/vote/#redaction", sid: String(r.sid), auto_hide: 0, expire_push: "2d" }),
  }).catch(() => null)));
}

// ---------------------------------------------------------------------------- tours
type Tour = { id: number; mois: string; ouvert_le: string; fin_propositions: string; propositions_fermees_le: string | null; fin_vote: string; statut: string; ia_etat: string; ia_essais: number; ia_debut: string | null; ia_justification: string | null; ia_erreur: string | null; gagnant_type: string | null; gagnant_id: number | null; gagnant_titre: string | null; gagnant_description: string | null; gagnant_votes: number | null; airtable_id: string | null; airtable_erreur: string | null; ghost_post_id: string | null; article: unknown; clos_le: string | null; test: boolean };
function datesDuMois(y: number, m: number) {
  return { mois: `${y}-${String(m).padStart(2, "0")}`, fin_propositions: zurich(y, m, 15, 20).toISOString(), fin_vote: zurich(y, m, dernierJour(y, m), 20).toISOString() };
}
async function tourCourant(): Promise<Tour> {
  const { data } = await db.from("vote_tours").select("*").eq("test", false).eq("statut", "ouvert").order("fin_vote").limit(1);
  if (data && data[0]) return data[0] as Tour;
  // Aucun tour ouvert : on en ouvre un. Démarrage en milieu de mois → tour de lancement (14 jours de propositions,
  // vote jusqu'à la fin du mois qui suit si nécessaire, pour toujours laisser au moins une semaine de vote).
  const now = new Date(), z = partsZurich(now);
  let d = datesDuMois(z.y, z.m);
  if (z.j > 8) {
    const fp = new Date(now.getTime() + 14 * 864e5), zp = partsZurich(fp);
    const finProp = zurich(zp.y, zp.m, zp.j, 20);
    let y = zp.y, m = zp.m;
    if (zurich(y, m, dernierJour(y, m), 20).getTime() - finProp.getTime() < 7 * 864e5) { m++; if (m > 12) { m = 1; y++; } }
    d = { mois: `${y}-${String(m).padStart(2, "0")}`, fin_propositions: finProp.toISOString(), fin_vote: zurich(y, m, dernierJour(y, m), 20).toISOString() };
  }
  await db.from("vote_tours").upsert({ ...d, ouvert_le: now.toISOString() }, { onConflict: "mois", ignoreDuplicates: true });
  const { data: t } = await db.from("vote_tours").select("*").eq("mois", d.mois).limit(1);
  return t![0] as Tour;
}
function phase(t: Tour) {
  const now = Date.now();
  if (t.statut !== "ouvert" || now >= Date.parse(t.fin_vote)) return "resultat";
  if (!t.propositions_fermees_le && now < Date.parse(t.fin_propositions)) return "propositions";
  return "vote";
}

// deno-lint-ignore no-explicit-any
async function lireTour(t: Tour, me: string | null, voirTout: boolean, equipe: boolean): Promise<any> {
  const [{ data: props }, { data: sujets }, { data: sc }, { data: vmoi }] = await Promise.all([
    db.from("vote_propositions").select(equipe ? "*" : "id,thematique,titre,detail,statut,sujet_id,created_at,membre").eq("tour_id", t.id).order("id"),
    db.from("vote_sujets").select("*").eq("tour_id", t.id).neq("statut", "remplace").order("ordre"),
    db.rpc("vote_scores", { p_tour: t.id }),
    me ? db.from("vote_votes").select("cible_type,cible_id").eq("tour_id", t.id).eq("membre", me).limit(1) : Promise.resolve({ data: [] }),
  ]);
  const score = (typ: string, id: number) => ((sc || []).find((x: { cible_type: string; cible_id: number }) => x.cible_type === typ && x.cible_id === id) || { votes: 0 }).votes;
  const visibles = (props || []).filter((p: { statut: string }) => equipe || p.statut !== "ecartee");
  const sv = (sujets || []).filter((s: { statut: string }) => equipe || s.statut === "active");
  const total = (await db.from("vote_votes").select("id", { count: "exact", head: true }).eq("tour_id", t.id)).count || 0;
  const parTheme: Record<string, number> = {};
  for (const p of visibles) parTheme[p.thematique] = (parTheme[p.thematique] || 0) + 1;
  const monProp = me ? (props || []).find((p: { membre: string }) => p.membre === me) : null;
  return {
    tour: { id: t.id, mois: t.mois, mois_txt: moisTxt(t.mois), phase: phase(t), ouvert_le: t.ouvert_le, fin_propositions: t.fin_propositions, propositions_fermees_le: t.propositions_fermees_le, fin_vote: t.fin_vote, ia_etat: t.ia_etat, n_propositions: visibles.filter((p: { statut: string }) => p.statut !== "ecartee").length, max_avant_ia: MAX_AVANT_IA, test: t.test },
    total_votes: total, par_theme: parTheme,
    // deno-lint-ignore no-explicit-any
    propositions: visibles.map((p: any) => ({
      id: p.id, thematique: p.thematique, statut: p.statut, sujet_id: p.sujet_id, votes: score("proposition", p.id), created_at: p.created_at, mienne: !!me && p.membre === me,
      titre: voirTout ? p.titre : null, detail: voirTout ? p.detail : null,
      ...(equipe ? { membre: p.membre, membre_nom: p.membre_nom, membre_statut: p.membre_statut, motif: p.motif } : {}),
    })),
    // deno-lint-ignore no-explicit-any
    sujets: sv.map((s: any) => ({ id: s.id, titre: voirTout ? s.titre : null, description: voirTout ? s.description : null, thematique: s.thematique, statut: s.statut, motif: equipe ? s.motif : undefined, votes: score("sujet", s.id), sources: (props || []).filter((p: { sujet_id: number }) => p.sujet_id === s.id).map((p: { id: number }) => p.id) })),
    me: me ? { proposition_id: monProp ? monProp.id : null, vote: vmoi && vmoi[0] ? { type: vmoi[0].cible_type, id: vmoi[0].cible_id } : null } : null,
  };
}
async function gagnants() {
  const { data } = await db.from("vote_tours").select("mois,gagnant_titre,gagnant_votes,article").eq("test", false).eq("statut", "clos").not("gagnant_titre", "is", null).order("fin_vote", { ascending: false }).limit(8);
  return (data || []).map((t: { mois: string; gagnant_titre: string; gagnant_votes: number; article: unknown }) => ({ mois: t.mois, mois_txt: moisTxt(t.mois), titre: t.gagnant_titre, votes: t.gagnant_votes, article: t.article || null }));
}

// ---------------------------------------------------------------------------- anti-abus
async function limite(cle: string, action: string, max: number, minutes: number) {
  const depuis = new Date(Date.now() - minutes * 60_000).toISOString();
  const { count } = await db.from("vote_journal").select("id", { count: "exact", head: true }).eq("cle", cle).eq("action", action).gte("created_at", depuis);
  return (count || 0) >= max;
}
const journal = (cle: string, action: string, detail = "") => db.from("vote_journal").insert({ cle, action, detail: detail.slice(0, 300) }).then(() => {}, () => {});

// ---------------------------------------------------------------------------- clôture
const airtableCle = () => env("AIRTABLE_TOKEN") || env("POSTHUMAIN_AIRTABLE_TOKEN") || env("AIRTABLE_API_KEY") || env("AIRTABLE_PAT");
async function airtableCreer(fields: Record<string, unknown>) {
  const key = airtableCle();
  if (!key) throw new Error("clé Airtable absente des secrets Supabase (AIRTABLE_TOKEN)");
  const base = env("AIRTABLE_BASE") || AIRTABLE_BASE;
  const r = await fetch(`https://api.airtable.com/v0/${base}/Radar`, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify({ fields, typecast: true }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.id) throw new Error("Airtable " + r.status + " " + String(j?.error?.message || j?.error?.type || "").slice(0, 160));
  return String(j.id);
}
async function airtableLire(id: string) {
  const key = airtableCle();
  if (!key) return null;
  const r = await fetch(`https://api.airtable.com/v0/${env("AIRTABLE_BASE") || AIRTABLE_BASE}/Radar/${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${key}` } });
  return r.ok ? await r.json() : null;
}
async function cloturer(t: Tour) {
  const { data: pris } = await db.from("vote_tours").update({ statut: "cloture_en_cours" }).eq("id", t.id).eq("statut", "ouvert").select();
  if (!pris || !pris.length) return { ok: false, why: "déjà en clôture" };
  const { data: sc } = await db.rpc("vote_scores", { p_tour: t.id });
  const score = (typ: string, id: number) => ((sc || []).find((x: { cible_type: string; cible_id: number }) => x.cible_type === typ && x.cible_id === id) || { votes: 0 }).votes;
  const { data: props } = await db.from("vote_propositions").select("*").eq("tour_id", t.id).neq("statut", "ecartee").order("id");
  const { data: sujets } = await db.from("vote_sujets").select("*").eq("tour_id", t.id).eq("statut", "active").order("ordre");
  let g: { type: string; id: number; titre: string; description: string; votes: number; sources: { titre: string; detail: string | null }[] } | null = null;
  if (t.ia_etat === "fait" && sujets && sujets.length) {
    const best = [...sujets].sort((a, b) => score("sujet", b.id) - score("sujet", a.id) || a.ordre - b.ordre)[0];
    g = { type: "sujet", id: best.id, titre: best.titre, description: best.description || "", votes: score("sujet", best.id), sources: (props || []).filter((p) => p.sujet_id === best.id).map((p) => ({ titre: p.titre, detail: p.detail })) };
  } else if (props && props.length) {
    const best = [...props].sort((a, b) => score("proposition", b.id) - score("proposition", a.id) || a.id - b.id)[0];
    let titre = best.titre, description = best.detail || "";
    try { // reformulation légère du titre pour l'Usine (la proposition d'origine reste dans l'angle)
      const r = await claude("claude-opus-5-5", "medium", "Tu es rédacteur en chef de Posthumain (enquêtes grand public sur l'IA, la tech, la génétique, les neurosciences, les futurs). Reformule la proposition d'un abonné en sujet d'enquête premium : titre accrocheur mais honnête (90 caractères max, pas de point d'exclamation) et une phrase qui dit ce que l'enquête va révéler. Réponds UNIQUEMENT en JSON {\"titre\":\"…\",\"description\":\"…\"}.", `Proposition : ${best.titre}\nPrécisions : ${best.detail || "(aucune)"}`, 600, 60000);
      if (propre(r.titre, 160).length >= 8) { titre = propre(r.titre, 160); description = propre(r.description, 400) || description; }
    } catch (_) { /* titre d'origine */ }
    g = { type: "proposition", id: best.id, titre, description, votes: score("proposition", best.id), sources: [{ titre: best.titre, detail: best.detail }] };
  }
  let airtable_id: string | null = null, airtable_erreur: string | null = null;
  if (g && !t.test) {
    const angle = (g.description ? g.description + "\n\n" : "") + "Sujet choisi par les abonnés premium (vote de " + moisTxt(t.mois) + ", " + g.votes + " vote" + (g.votes > 1 ? "s" : "") + "). Leurs propositions :\n" +
      g.sources.map((s) => "- " + s.titre + (s.detail ? " — " + s.detail : "")).join("\n");
    // Mêmes champs que la commande Telegram « /ecrire <sujet> | <url> | premium » de l'Usine (nœud « Parse commande enquete »),
    // + URL = marqueur partagé avec l'Usine et le Writinglab (https://posthumain.com/vote?tour=AAAA-MM) : enquête SUPPLÉMENTAIRE
    // rédigée par le passage dédié de 14 h 30 (jamais par les passages 8 h 30 / 12 h), en tête du Radar ; Priorite haute.
    try { airtable_id = await airtableCreer({ Title: g.titre, Type: "premium", Status: "new", Score: 100, Choisir: true, Priorite: 1000, CreatedAt: new Date().toISOString(), Angle: angle, URL: `${SITE}/vote?tour=${t.mois}` }); }
    catch (e) { airtable_erreur = String((e as Error)?.message || e).slice(0, 300); }
  }
  await db.from("vote_tours").update({ statut: "clos", clos_le: new Date().toISOString(), gagnant_type: g?.type || null, gagnant_id: g?.id || null, gagnant_titre: g?.titre || null, gagnant_description: g?.description || null, gagnant_votes: g?.votes ?? null, airtable_id, airtable_erreur }).eq("id", t.id);
  if (!t.test) {
    if (g) await annoncer("🗳️ Le public a choisi : « " + g.titre + " » (" + g.votes + " vote" + (g.votes > 1 ? "s" : "") + ", vote de " + moisTxt(t.mois) + "). " + (airtable_id ? "Il sera n°1 du Radar demain et rédigé à 14 h 30 comme enquête supplémentaire, sauf si vous le passez (« Ne pas l'écrire » dans la Salle du Radar du Writinglab)." : "⚠️ Pas pu l'ajouter à l'Usine (" + airtable_erreur + ") : à imposer à la main avec /ecrire " + g.titre + " | " + SITE + "/vote?tour=" + t.mois + " | premium"), "🗳️ Le public a choisi", g.titre);
    else await annoncer("🗳️ Vote de " + moisTxt(t.mois) + " clos sans aucune proposition. Le tour suivant est ouvert.", "🗳️ Vote clos (aucune proposition)", moisTxt(t.mois));
    // tour suivant : le mois qui suit celui qui vient de se clore
    let [y, m] = t.mois.split("-").map(Number); m++; if (m > 12) { m = 1; y++; }
    const d = datesDuMois(y, m);
    await db.from("vote_tours").upsert({ ...d, ouvert_le: new Date().toISOString() }, { onConflict: "mois", ignoreDuplicates: true });
  }
  return { ok: true, gagnant: g, airtable_id, airtable_erreur };
}
// Article publié par l'Usine pour un sujet gagnant (Airtable GhostPostId → Ghost) : affiché dans « Choisis par vous »
async function lierArticles() {
  const { data } = await db.from("vote_tours").select("id,airtable_id").eq("statut", "clos").eq("test", false).not("airtable_id", "is", null).is("ghost_post_id", null).gte("clos_le", new Date(Date.now() - 150 * 864e5).toISOString()).limit(5);
  for (const t of data || []) {
    try {
      const rec = await airtableLire(String(t.airtable_id));
      const pid = rec?.fields?.GhostPostId;
      if (!pid) continue;
      const out = await ghost(`/posts/${encodeURIComponent(String(pid))}/?fields=id,title,url,feature_image,status,published_at`);
      const p = out?.posts?.[0];
      if (!p || p.status !== "published") continue;
      await db.from("vote_tours").update({ ghost_post_id: p.id, article: { title: p.title, url: String(p.url || "").replace("https://the-last-journal.ghost.io", SITE), image: p.feature_image || null, published_at: p.published_at } }).eq("id", t.id);
    } catch (_) { /* nouvel essai au prochain passage */ }
  }
}
async function tick() {
  const t = await tourCourant();
  const res: Record<string, unknown> = { tour: t.mois };
  if (t.statut === "ouvert" && Date.now() >= Date.parse(t.fin_vote)) res.cloture = await cloturer(t);
  else if (t.ia_etat === "echec" || (t.ia_etat === "en_cours" && t.ia_debut && Date.now() - Date.parse(t.ia_debut) > 4 * 60_000)) {
    const { data: ok } = await db.rpc("vote_reserver_ia", { p_tour: t.id, p_force: false });
    if (ok) { waitUntil(fusion(t.id)); res.ia = "relancée"; }
  }
  await lierArticles();
  await db.from("vote_journal").delete().lt("created_at", new Date(Date.now() - 90 * 864e5).toISOString());
  return { ok: true, ...res, config: { airtable: !!airtableCle(), ghost: !!env("GHOST_ADMIN_API_KEY") && !!env("GHOST_ADMIN_API_URL"), anthropic: !!env("ANTHROPIC_API_KEY"), push: !!env("WEBPUSHR_KEY") } };
}

// ---------------------------------------------------------------------------- page Ghost /vote (contenu tiré de GitHub, version figée par commit)
async function publierPage() {
  const repo = "trustmedias/posthumain-ghost-assets";
  const c = await fetch(`https://api.github.com/repos/${repo}/commits/main`, { headers: { Accept: "application/vnd.github+json", "User-Agent": "posthumain-vote" } });
  if (!c.ok) throw new Error("GitHub " + c.status);
  const commit = String((await c.json()).sha || "").slice(0, 12);
  const h = await fetch(`https://raw.githubusercontent.com/${repo}/${commit}/vote/page.html`);
  if (!h.ok) throw new Error("page.html introuvable (" + h.status + ")");
  const html = (await h.text()).replaceAll("{{COMMIT}}", commit);
  const lexical = JSON.stringify({ root: { children: [{ type: "html", version: 1, html }], direction: null, format: "", indent: 0, type: "root", version: 1 } });
  const page = { title: "Votez pour la prochaine enquête premium", slug: "vote", lexical, status: "published", visibility: "public",
    custom_excerpt: "Chaque mois, les abonnés premium de Posthumain proposent et choisissent le sujet de la prochaine enquête.",
    meta_title: "Votez pour la prochaine enquête premium — Posthumain", meta_description: "Proposez un sujet, votez : chaque mois, l'enquête premium la plus demandée par nos abonnés est menée par la rédaction." };
  let ex = null;
  try { ex = (await ghost(`/pages/slug/vote/?fields=id,updated_at`))?.pages?.[0] || null; } catch (_) { ex = null; }
  const out = ex
    ? await ghost(`/pages/${ex.id}/`, { method: "PUT", body: JSON.stringify({ pages: [{ ...page, updated_at: ex.updated_at }] }) })
    : await ghost(`/pages/`, { method: "POST", body: JSON.stringify({ pages: [page] }) });
  const p = out?.pages?.[0];
  return { ok: true, commit, page: p ? { id: p.id, url: String(p.url || "").replace("https://the-last-journal.ghost.io", SITE) } : null, cree: !ex };
}

// ---------------------------------------------------------------------------- serveur
Deno.serve(async (req) => {
  const origin = req.headers.get("origin") || "";
  const h = cors(origin);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
  if (req.method !== "POST") return json({ ok: false, why: "method" }, 405, h);
  let b: Record<string, unknown> = {};
  try { b = JSON.parse((await req.text()).slice(0, 8192) || "{}"); } catch { return json({ ok: false, why: "bad_json" }, 400, h); }
  const action = String(b.action || "etat");

  // pg_cron (sans origine) : passage idempotent qui ne fait que ce qui est dû
  if (action === "tick") {
    const { data: sec } = await db.from("wl_reglages").select("valeur").eq("cle", "vote_cron_secret").limit(1);
    const attendu = String(sec?.[0]?.valeur || "");
    if (!attendu || attendu.length < 32 || !egal(String(b.secret || ""), attendu)) return json({ ok: false, why: "unauthorized" }, 401, h);
    try { return json(await tick(), 200, h); } catch (e) { return json({ ok: false, why: String((e as Error)?.message || e).slice(0, 200) }, 500, h); }
  }
  if (!ORIGINES.includes(origin)) return json({ ok: false, why: "origin_not_allowed" }, 403, h);

  const email = await emailDuJeton(req);
  let m: Membre | null = null;
  if (email) { try { m = await membre(email); } catch (e) { console.warn("ghost", String(e)); if (action !== "etat") return json({ ok: false, why: "Ghost ne répond pas, réessayez dans un instant." }, 503, h); } }
  const equipe = !!email && !!EQUIPE[email];
  let role = !email ? "visiteur" : m?.premium ? "premium" : "gratuit";
  const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || req.headers.get("cf-connecting-ip") || "";
  const cleIp = "ip:" + (await sha("vote|" + ip)).slice(0, 24);

  try {
    // Tour visé : le tour courant ; un tour de test n'est accessible qu'à la rédaction
    let t: Tour;
    if (b.tour_id && equipe) {
      const { data } = await db.from("vote_tours").select("*").eq("id", Number(b.tour_id)).limit(1);
      if (!data || !data[0]) return json({ ok: false, why: "tour introuvable" }, 404, h);
      t = data[0] as Tour;
    } else t = await tourCourant();
    if (equipe && t.test && role !== "premium") role = "premium";

    if (action === "etat") {
      const voirTout = role !== "visiteur";
      const [lt, gg, av] = await Promise.all([lireTour(t, email, voirTout, false), gagnants(), role === "premium" ? Promise.resolve(null) : avantages()]);
      return json({ ok: true, role, equipe, serveur: new Date().toISOString(), themes: THEMES, ...lt, gagnants: gg, offre: av }, 200, h);
    }

    if (action === "proposer") {
      if (role !== "premium") return json({ ok: false, why: role === "visiteur" ? "connexion" : "premium" }, 403, h);
      if (phase(t) !== "propositions") return json({ ok: false, why: "Les propositions sont fermées pour ce tour : votez parmi les sujets." }, 409, h);
      const them = String(b.thematique || ""), titre = propre(b.titre, 140), detail = propre(b.detail, 600);
      if (!THEMES[them]) return json({ ok: false, why: "Choisissez d'abord une thématique." }, 400, h);
      if (titre.length < 8) return json({ ok: false, why: "Décrivez votre sujet en une phrase (8 caractères au moins)." }, 400, h);
      if (await limite("m:" + email, "proposer", 5, 60) || await limite(cleIp, "proposer", 15, 60)) return json({ ok: false, why: "Trop d'essais : réessayez dans une heure." }, 429, h);
      await journal("m:" + email, "proposer", titre); await journal(cleIp, "proposer");
      const mod = await moderer(them, titre, detail);
      if (!mod.ok) { await journal("m:" + email, "refus", titre + " — " + mod.motif); return json({ ok: false, why: mod.motif || "Ce sujet ne correspond pas à la ligne de Posthumain.", refus: true }, 422, h); }
      const { data: r, error } = await db.rpc("vote_proposer", { p_tour: t.id, p_membre: email, p_nom: m!.nom, p_statut: m!.statut, p_them: them, p_titre: titre, p_detail: detail });
      if (error) throw error;
      if (!r?.ok) return json({ ok: false, why: r?.why === "deja_propose" ? "Vous avez déjà proposé un sujet ce mois-ci." : "Les propositions viennent de se fermer : votez parmi les sujets." }, 409, h);
      if (r.ia) waitUntil(fusion(t.id));
      if (!t.test) await annoncer("🗳️ Nouvelle proposition (" + (THEMES[them] || them) + ") : « " + titre + " » — " + (m!.nom || email) + ". " + r.n + " proposition" + (r.n > 1 ? "s" : "") + " ce mois-ci" + (r.ia ? " : l'IA fusionne maintenant en 3 sujets." : "."), "🗳️ Nouvelle proposition", titre);
      return json({ ok: true, id: r.id, ia: !!r.ia, ...(await lireTour({ ...t, propositions_fermees_le: r.ia ? new Date().toISOString() : t.propositions_fermees_le, ia_etat: r.ia ? "en_cours" : t.ia_etat }, email, true, false)) }, 200, h);
    }

    if (action === "voter") {
      if (role !== "premium") return json({ ok: false, why: role === "visiteur" ? "connexion" : "premium" }, 403, h);
      const typ = b.type === "sujet" ? "sujet" : "proposition", id = Number(b.id);
      if (!Number.isFinite(id) || id <= 0) return json({ ok: false, why: "Vote invalide." }, 400, h);
      if (await limite("m:" + email, "voter", 40, 60)) return json({ ok: false, why: "Trop de changements de vote : réessayez plus tard." }, 429, h);
      await journal("m:" + email, "voter", typ + ":" + id);
      const { data: r, error } = await db.rpc("vote_voter", { p_tour: t.id, p_membre: email, p_type: typ, p_cible: id });
      if (error) throw error;
      if (!r?.ok) return json({ ok: false, why: r?.why === "vote_ferme" ? "Le vote est clos." : r?.why === "non_retenue" ? "Cette proposition n'a pas été retenue parmi les 3 sujets : choisissez l'un d'eux." : "Ce choix n'est plus disponible." }, 409, h);
      return json({ ok: true, ...(await lireTour(t, email, true, false)) }, 200, h);
    }

    // ------------------------------------------------ rédaction (contrôle serveur : adresses de l'équipe uniquement)
    if (!equipe) return json({ ok: false, why: "réservé à la rédaction" }, 403, h);
    if (action === "redaction_etat") {
      const [{ data: votes }, { data: tours }, { data: refus }] = await Promise.all([
        db.from("vote_votes").select("membre,cible_type,cible_id,updated_at").eq("tour_id", t.id).order("updated_at", { ascending: false }).limit(500),
        db.from("vote_tours").select("id,mois,statut,fin_vote,gagnant_titre,gagnant_votes,airtable_id,airtable_erreur,article,test").order("fin_vote", { ascending: false }).limit(15),
        db.from("vote_journal").select("cle,detail,created_at").eq("action", "refus").order("created_at", { ascending: false }).limit(30),
      ]);
      return json({ ok: true, role, equipe, themes: THEMES, ...(await lireTour(t, email, true, true)), ia_justification: t.ia_justification, ia_erreur: t.ia_erreur, ia_essais: t.ia_essais, config: { airtable: !!(airtableCle()), ghost: !!env("GHOST_ADMIN_API_KEY"), anthropic: !!env("ANTHROPIC_API_KEY"), push: !!env("WEBPUSHR_KEY") }, votes, tours, refus: (refus || []).map((r: { cle: string; detail: string; created_at: string }) => ({ membre: r.cle.replace(/^m:/, ""), detail: r.detail, le: r.created_at })) }, 200, h);
    }
    if (action === "ecarter" || action === "retablir") {
      const table = b.type === "sujet" ? "vote_sujets" : "vote_propositions";
      const statut = action === "ecarter" ? (b.type === "sujet" ? "ecarte" : "ecartee") : "active";
      const { data, error } = await db.from(table).update({ statut, motif: action === "ecarter" ? propre(b.motif, 200) || "écarté par la rédaction" : null }).eq("id", Number(b.id)).eq("tour_id", t.id).select();
      if (error || !data?.length) return json({ ok: false, why: "élément introuvable" }, 404, h);
      return json({ ok: true }, 200, h);
    }
    if (action === "relancer_ia") {
      const { data: ok } = await db.rpc("vote_reserver_ia", { p_tour: t.id, p_force: true });
      if (!ok) return json({ ok: false, why: "Il faut au moins 6 propositions actives, sur un tour encore ouvert." }, 409, h);
      waitUntil(fusion(t.id));
      return json({ ok: true, why: "L'IA fusionne les propositions (environ une minute)." }, 200, h);
    }
    if (action === "cloturer") {
      if (b.confirmer !== true) return json({ ok: false, why: "confirmation requise" }, 400, h);
      return json(await cloturer(t), 200, h);
    }
    if (action === "publier_page") return json(await publierPage(), 200, h);
    return json({ ok: false, why: "action inconnue" }, 400, h);
  } catch (e) {
    console.error("vote", action, String((e as Error)?.message || e));
    return json({ ok: false, why: "Erreur serveur, réessayez." }, 500, h);
  }
});
