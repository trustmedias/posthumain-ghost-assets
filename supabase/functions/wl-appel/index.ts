// Writinglab — wl-appel (28/10/2026) : enregistrement AUDIO des interviews par téléphone, sans jamais perdre l'audio.
// Demande de Jonathan : un appel peut durer 40 minutes ou plus ; si quelque chose coupe (page fermée, réseau, ordinateur en veille,
// micro débranché), l'audio enregistré jusque-là doit être gardé, avec une note qui dit que ça a coupé, et retranscrit quand même.
//
// Principe : la page enregistre l'appel par TRANCHES de 5 minutes (chaque tranche est un fichier audio autonome, lisible seul) et
// envoie chaque tranche par MORCEAUX de 20 secondes pendant l'appel. Ici :
//  - chaque morceau est rangé tout de suite dans le bucket privé « writinglab » (appels/<session>/<tranche>/<morceau>.part) ;
//  - quand une tranche est complète (dernier morceau reçu, ou tranche interrompue reconstituée), ses morceaux sont assemblés en un
//    fichier (appels/<session>/<tranche>.<ext>), puis retranscrits en tâche de fond : ElevenLabs Scribe v2 (mots horodatés, voix
//    séparées), repli Gemini 2.5 Flash. Une tranche de 5 minutes se traite en quelques secondes : aucun gros traitement à la fin,
//    donc aucune limite de durée de l'appel côté serveur (ni délai de 150 s, ni taille de fichier, ni jetons de sortie).
//  - coupure : la page la signale (« fermer » avec un motif) ; sinon, une session sans nouvelles depuis 3 minutes est déclarée
//    coupée à la lecture suivante de son état, sa tranche en cours est reconstituée à partir des morceaux reçus et retranscrite.
//  - les tranches restées « à transcrire » (tâche de fond interrompue) ou en erreur sont relancées à chaque lecture de l'état
//    (3 essais au plus), et le membre peut relancer une tranche à la main.
// Accès : jeton du membre Ghost vérifié (comme wl-tel) ; une journaliste ne voit que les appels de ses fiches, le chef tous.
// Actions : ouvrir · morceau · fermer · etat · retranscrire.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { parEmail, type Membre } from "./equipe.ts";

const env = (k: string) => (Deno.env.get(k) || "").trim();
const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const SITE = "https://posthumain.com";
const ORIGINES = ["https://posthumain.com", "https://www.posthumain.com"];
const BUCKET = "writinglab";
const SILENCE_COUPURE_MS = 3 * 60 * 1000;   // session sans nouveau morceau depuis 3 min : la page a été fermée ou la connexion perdue
const BLOCAGE_MS = 3 * 60 * 1000;           // transcription « en cours » depuis plus de 3 min : la tâche de fond est morte, on relance
const MAX_ESSAIS = 3;
const MAX_MORCEAU = 6 * 1024 * 1024;        // un morceau de 20 s pèse ~80 Ko ; garde-fou large
const SCRIBE = "scribe_v2", GEMINI = "gemini-2.5-flash";
const USD_EUR = 0.92, SCRIBE_USD_HEURE = 0.4; // ordre de grandeur pour le suivi des coûts du lab

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
const court = (s: unknown, n: number) => { const t = String(s || "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };
const chrono = (ms: number) => { const s = Math.max(0, Math.round(ms / 1000)); return String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0"); };
const ext = (mime: string) => /ogg/.test(mime) ? "ogg" : /mp4|aac|m4a/.test(mime) ? "m4a" : /mpeg|mp3/.test(mime) ? "mp3" : /wav/.test(mime) ? "wav" : "webm";
const mimeOk = (m: unknown) => { const v = String(m || "").toLowerCase(); return /^audio\/(webm|ogg|mp4|mpeg|aac|wav|x-m4a)(;.*)?$/.test(v) ? v.slice(0, 80) : "audio/webm"; };
// deno-lint-ignore no-explicit-any
function enFond(p: Promise<any>) { try { (globalThis as any).EdgeRuntime?.waitUntil(p.catch((e) => console.log("wl-appel fond", String(e)))); } catch (_) { p.catch(() => {}); } }

// ---------- Assemblage d'une tranche à partir de ses morceaux ----------
// deno-lint-ignore no-explicit-any
async function assembler(s: any, n: number): Promise<{ chemin: string; taille: number } | null> {
  const dir = "appels/" + s.id + "/" + n;
  const { data: l, error } = await db.storage.from(BUCKET).list(dir, { limit: 1000, sortBy: { column: "name", order: "asc" } });
  if (error) throw new Error("liste des morceaux : " + error.message);
  const noms = (l || []).map((x) => x.name).filter((x) => /\.part$/.test(x)).sort();
  if (!noms.length) return null;
  const blocs: Uint8Array[] = [];
  for (let i = 0; i < noms.length; i += 8) {
    const lot = await Promise.all(noms.slice(i, i + 8).map(async (nm) => {
      const { data, error: e } = await db.storage.from(BUCKET).download(dir + "/" + nm);
      if (e || !data) throw new Error("morceau " + nm + " illisible");
      return new Uint8Array(await data.arrayBuffer());
    }));
    blocs.push(...lot);
  }
  const taille = blocs.reduce((a, b) => a + b.length, 0);
  const tout = new Uint8Array(taille); let o = 0; for (const b of blocs) { tout.set(b, o); o += b.length; }
  const chemin = "appels/" + s.id + "/tranche-" + String(n).padStart(3, "0") + "." + ext(String(s.mime || ""));
  const up = await db.storage.from(BUCKET).upload(chemin, tout, { contentType: mimeOk(s.mime), upsert: true });
  if (up.error) throw new Error("fichier de la tranche : " + up.error.message);
  return { chemin, taille };
}

// ---------- Transcription d'une tranche ----------
const LANGUE: Record<string, string> = { fr: "fr", en: "en", de: "de", it: "it" };
// deno-lint-ignore no-explicit-any
async function scribe(audio: Uint8Array, mime: string, lang: string): Promise<any[]> {
  const key = env("ELEVENLABS_API_KEY"); if (!key) throw new Error("clé ElevenLabs absente");
  const fd = new FormData();
  fd.append("file", new Blob([audio], { type: mime.split(";")[0] }), "tranche." + ext(mime));
  fd.append("model_id", SCRIBE);
  if (LANGUE[lang]) fd.append("language_code", LANGUE[lang]);
  fd.append("diarize", "true");
  fd.append("timestamps_granularity", "word");
  const r = await fetch("https://api.elevenlabs.io/v1/speech-to-text", { method: "POST", headers: { "xi-api-key": key }, body: fd, signal: AbortSignal.timeout(110000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("ElevenLabs " + r.status + " : " + court(j?.detail?.message || j?.detail || j?.message || "", 160));
  // jetons : [début ms, fin ms, voix, texte] (les espaces sont des jetons à part chez Scribe)
  // deno-lint-ignore no-explicit-any
  const mots = (Array.isArray(j.words) ? j.words : []).filter((w: any) => w && (w.type === "word" || w.type === "spacing"))
    // deno-lint-ignore no-explicit-any
    .map((w: any) => [Math.round(Number(w.start || 0) * 1000), Math.round(Number(w.end || 0) * 1000), String(w.speaker_id || ""), String(w.text || "")]);
  if (!mots.length && String(j.text || "").trim()) return [[0, 0, "", String(j.text).trim()]];
  return mots;
}
async function gemini(audio: Uint8Array, mime: string, lang: string): Promise<string> {
  const key = env("GEMINI_API_KEY"); if (!key) throw new Error("clé Gemini absente");
  let bin = ""; for (let i = 0; i < audio.length; i += 0x8000) bin += String.fromCharCode(...audio.subarray(i, i + 0x8000));
  const consigne = (lang === "en" ? "This is part of a phone interview (a journalist and an expert). " : "Ceci est une partie d'une interview par téléphone (une journaliste et un expert). ") +
    "Transcris fidèlement et intégralement ce qui est dit, dans la langue parlée, sans résumer ni corriger le fond. Va à la ligne et commence par « — » à chaque changement de voix. " +
    "Écris [inaudible] pour un passage incompréhensible. Réponds uniquement par la transcription.";
  const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" + GEMINI + ":generateContent?key=" + key, {
    method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(110000),
    body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: consigne }, { inline_data: { mime_type: mime.split(";")[0], data: btoa(bin) } }] }],
      generationConfig: { temperature: 0, maxOutputTokens: 16000, thinkingConfig: { thinkingBudget: 0 } } }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("Gemini " + r.status + " : " + court(j?.error?.message || "", 160));
  // deno-lint-ignore no-explicit-any
  const t = ((j.candidates || [])[0]?.content?.parts || []).map((p: any) => p.text || "").join("").trim();
  if (!t) throw new Error("Gemini : transcription vide (" + ((j.candidates || [])[0]?.finishReason || "?") + ")");
  return t;
}
// Une tranche : assemblage si besoin, puis transcription. Jamais d'exception vers l'appelant : l'erreur est écrite dans la tranche.
// deno-lint-ignore no-explicit-any
async function traiterTranche(s: any, n: number) {
  const { data: t0 } = await db.from("wl_appel_tranches").select("*").eq("session_id", s.id).eq("n", n).limit(1);
  // deno-lint-ignore no-explicit-any
  const t: any = t0 && t0[0]; if (!t) return;
  const maj = (v: Record<string, unknown>) => db.from("wl_appel_tranches").update({ ...v, updated_at: new Date().toISOString() }).eq("session_id", s.id).eq("n", n);
  // verrou : une seule transcription à la fois par tranche (dernier morceau + relance de surveillance peuvent arriver ensemble)
  const vieux = new Date(Date.now() - BLOCAGE_MS).toISOString();
  const { data: lk } = await db.from("wl_appel_tranches").update({ statut: "transcription", essais: Number(t.essais || 0) + 1, erreur: null, updated_at: new Date().toISOString() })
    .eq("session_id", s.id).eq("n", n).or("statut.in.(a_transcrire,erreur),and(statut.eq.transcription,updated_at.lt." + vieux + ")").select("n");
  if (!lk || !lk.length) return;
  try {
    let chemin = t.chemin, taille = t.taille;
    if (!chemin) {
      const a = await assembler(s, n);
      if (!a) { await maj({ statut: "vide", erreur: "aucun morceau audio reçu pour cette tranche" }); return; }
      chemin = a.chemin; taille = a.taille;
      await maj({ chemin, taille });
    }
    const { data: f, error } = await db.storage.from(BUCKET).download(chemin);
    if (error || !f) throw new Error("fichier de la tranche illisible");
    const audio = new Uint8Array(await f.arrayBuffer()), mime = mimeOk(s.mime);
    if (audio.length < 2000) { await maj({ statut: "vide", erreur: "tranche trop courte (moins d'une seconde d'audio)" }); return; }
    let moteur = SCRIBE, mots: unknown[] | null = null, texte = "", note = "";
    try { mots = await scribe(audio, mime, s.lang); }
    catch (e) { note = String((e as Error)?.message || e); moteur = GEMINI; texte = await gemini(audio, mime, s.lang); }
    if (mots) texte = texteDeMots(mots as Jeton[], Number(t.debut_ms || 0), null, null).texte;
    await maj({ statut: "ok", moteur, mots: mots || null, texte: texte.slice(0, 200000), erreur: note ? "repli Gemini (" + court(note, 140) + ")" : null });
    try { // suivi des coûts du lab (ordre de grandeur)
      const h = Math.max(0, Number(t.fin_ms || 0) - Number(t.debut_ms || 0)) / 3600e3;
      if (moteur === SCRIBE && h > 0) await db.from("wl_couts").insert({ membre: s.membre, usage: "telephone", modele: SCRIBE, tokens_in: 0, tokens_out: 0, cout_eur: Math.round(h * SCRIBE_USD_HEURE * USD_EUR * 1e5) / 1e5 });
    } catch (_) { /* facultatif */ }
  } catch (e) {
    await maj({ statut: "erreur", erreur: court((e as Error)?.message || e, 300) });
  }
}

// ---------- Texte horodaté ----------
type Jeton = [number, number, string, string];
// Jetons d'une tranche → lignes « [mm:ss] Voix 1 : … ». bornes [de, a[ en ms depuis le début de l'appel (null = sans borne).
// voix : correspondance voix locale → étiquette commune (complétée au fil des tranches).
function texteDeMots(mots: Jeton[], debut: number, de: number | null, a: number | null, voix: Record<string, string> = {}, compte = { n: 0 }, libres: string[] = []) {
  const lignes: string[] = []; let cur = "", spk: string | null = null, t0 = 0;
  const pousser = () => { const x = cur.replace(/\s+/g, " ").trim(); if (x) lignes.push("[" + chrono(t0) + "] " + (spk !== null && spk !== "" ? (voix[spk] || spk) + " : " : "") + x); cur = ""; };
  for (const m of mots) {
    const abs = debut + Number(m[0] || 0);
    if (de !== null && abs < de) continue;
    if (a !== null && abs >= a) continue;
    const sp = String(m[2] || "");
    if (sp && !voix[sp]) voix[sp] = libres.shift() || "Voix " + (++compte.n);
    if (sp !== "" && sp !== spk && /\S/.test(m[3])) { pousser(); spk = sp; t0 = abs; }
    if (!cur) t0 = abs;
    cur += m[3];
  }
  pousser();
  return { texte: lignes.join("\n"), voix };
}
// Transcription complète de l'appel : tranches dans l'ordre ; le chevauchement de 2 s entre deux tranches est retiré grâce aux
// mots horodatés (frontière = 1 s avant la fin de la tranche précédente) ; les voix sont rapprochées d'une tranche à l'autre par
// les mots prononcés dans le chevauchement (sinon, ordre d'apparition). Les trous (tranche vide, en erreur, pas encore prête) sont signalés.
// deno-lint-ignore no-explicit-any
function transcriptionComplete(tranches: any[]) {
  const l = tranches.slice().sort((x, y) => x.n - y.n), out: string[] = [], trous: string[] = [];
  const compte = { n: 0 }; let voixPrec: Record<string, string> = {};
  for (let i = 0; i < l.length; i++) {
    const t = l[i], p = i > 0 ? l[i - 1] : null, s = i + 1 < l.length ? l[i + 1] : null;
    const debut = Number(t.debut_ms || 0), fin = Number(t.fin_ms || debut);
    const plage = "[" + chrono(debut) + "–" + chrono(fin) + "]";
    if (t.statut !== "ok") {
      trous.push(plage + " " + (t.statut === "vide" ? "sans audio" : t.statut === "erreur" ? "non retranscrite (" + court(t.erreur, 80) + ")" : "transcription en cours"));
      out.push(plage + " ⚠️ " + (t.statut === "erreur" ? "partie non retranscrite" : t.statut === "vide" ? "partie sans audio" : "partie pas encore retranscrite"));
      voixPrec = {}; continue;
    }
    const mots: Jeton[] | null = Array.isArray(t.mots) ? t.mots : null;
    if (!mots) { out.push(String(t.texte || "").trim()); voixPrec = {}; continue; }
    const de = p && p.statut === "ok" && Array.isArray(p.mots) && p.fin_ms ? Number(p.fin_ms) - 1000 : null;
    const a = s && s.statut === "ok" && Array.isArray(s.mots) && t.fin_ms ? Number(t.fin_ms) - 1000 : null;
    // rapprochement des voix par le chevauchement : même mot, même instant (± 600 ms) dans les deux tranches
    const voix: Record<string, string> = {};
    if (p && Array.isArray(p.mots) && Object.keys(voixPrec).length) {
      const pd = Number(p.debut_ms || 0), votes: Record<string, Record<string, number>> = {};
      for (const m of mots) {
        const abs = debut + m[0]; if (!m[2] || !/\w/.test(m[3]) || abs > Number(p.fin_ms || 0)) continue;
        const q = (p.mots as Jeton[]).find((x) => x[2] && x[3].trim().toLowerCase() === m[3].trim().toLowerCase() && Math.abs(pd + x[0] - abs) < 600);
        if (q && voixPrec[q[2]]) { votes[m[2]] = votes[m[2]] || {}; votes[m[2]][voixPrec[q[2]]] = (votes[m[2]][voixPrec[q[2]]] || 0) + 1; }
      }
      for (const [loc, v] of Object.entries(votes)) { const best = Object.entries(v).sort((x, y) => y[1] - x[1])[0]; if (best && !Object.values(voix).includes(best[0])) voix[loc] = best[0]; }
    }
    // voix non reconnues dans le chevauchement : elles reprennent les étiquettes de la tranche précédente encore libres
    const libres = [...new Set(Object.values(voixPrec))].filter((x) => !Object.values(voix).includes(x));
    const r = texteDeMots(mots, debut, de, a, voix, compte, libres);
    voixPrec = r.voix;
    if (r.texte) out.push(r.texte);
  }
  return { texte: out.join("\n"), trous };
}

// ---------- Session ----------
// deno-lint-ignore no-explicit-any
async function sessionDe(me: Membre, id: string): Promise<any> {
  const { data } = await db.from("wl_appel_sessions").select("*").eq("id", id).limit(1);
  const s = data && data[0];
  if (!s) return null;
  if (!me.chef && s.membre !== me.id) {
    const { data: f } = await db.from("wl_fiches").select("redacteur").eq("fiche_id", s.fiche_id).limit(1);
    if (!f || !f[0] || f[0].redacteur !== me.id) return null;
  }
  return s;
}
// Coupure détectée côté serveur, et relance des tranches en attente (au plus 2 tâches de fond par lecture).
// deno-lint-ignore no-explicit-any
async function surveiller(s: any) {
  const maintenant = Date.now();
  if (s.statut === "en_cours" && maintenant - Date.parse(s.derniere_activite) > SILENCE_COUPURE_MS) {
    const motif = "L’enregistrement s’est interrompu vers " + chrono(Number(s.duree_ms || 0)) + " (la page a été fermée, l’ordinateur s’est mis en veille ou la connexion a été perdue). L’audio reçu jusque-là est conservé.";
    await db.from("wl_appel_sessions").update({ statut: "coupe", coupure: motif, updated_at: new Date().toISOString() }).eq("id", s.id).eq("statut", "en_cours");
    await db.from("wl_appel_tranches").update({ complete: true, statut: "a_transcrire", updated_at: new Date().toISOString() }).eq("session_id", s.id).eq("complete", false).gt("morceaux", 0);
    s.statut = "coupe"; s.coupure = motif;
  }
  const { data: ts } = await db.from("wl_appel_tranches").select("n,statut,complete,essais,updated_at").eq("session_id", s.id).order("n");
  const relancer = (ts || []).filter((t) => t.complete && (t.statut === "a_transcrire" || (t.statut === "transcription" && maintenant - Date.parse(t.updated_at) > BLOCAGE_MS) || (t.statut === "erreur" && Number(t.essais || 0) < MAX_ESSAIS)))
    .slice(0, 2);
  if (relancer.length) enFond((async () => { for (const t of relancer) await traiterTranche(s, t.n); })());
}
// deno-lint-ignore no-explicit-any
async function etatDe(s: any) {
  const { data: ts } = await db.from("wl_appel_tranches").select("n,debut_ms,fin_ms,morceaux,complete,chemin,taille,statut,moteur,texte,mots,erreur,essais").eq("session_id", s.id).order("n");
  const l = ts || [];
  const chemins = l.filter((t) => t.chemin).map((t) => t.chemin as string);
  const urls: Record<string, string> = {};
  if (chemins.length) { const { data } = await db.storage.from(BUCKET).createSignedUrls(chemins, 6 * 3600); for (const d of data || []) if (d.path && d.signedUrl) urls[d.path] = d.signedUrl; }
  const tc = transcriptionComplete(l);
  const prets = l.filter((t) => t.statut === "ok" || t.statut === "vide").length;
  return {
    session: { id: s.id, fiche_id: s.fiche_id, membre: s.membre, lang: s.lang, statut: s.statut, coupure: s.coupure || "", duree_ms: Number(s.duree_ms || 0), cree: s.created_at },
    tranches: l.map((t) => ({ n: t.n, debut_ms: Number(t.debut_ms || 0), fin_ms: Number(t.fin_ms || 0), statut: t.statut, moteur: t.moteur || "", erreur: t.erreur || "", essais: t.essais || 0, audio: t.chemin ? urls[t.chemin] || "" : "", taille: Number(t.taille || 0) })),
    transcription: tc.texte, trous: tc.trous, pretes: prets, total: l.length,
    terminee: s.statut !== "en_cours" && l.every((t) => t.statut === "ok" || t.statut === "vide" || (t.statut === "erreur" && Number(t.essais || 0) >= MAX_ESSAIS)),
  };
}

Deno.serve(async (req) => {
  const h = { ...cors(req), "Content-Type": "application/json", "Cache-Control": "no-store" };
  if (req.method === "OPTIONS") return new Response(null, { headers: h });
  const out = (v: unknown, st = 200) => new Response(JSON.stringify(v), { status: st, headers: h });
  if (req.method !== "POST") return out({ ok: false, why: "method" }, 405);
  // deno-lint-ignore no-explicit-any
  let b: any; try { b = await req.json(); } catch { return out({ ok: false, why: "bad_json" }, 400); }
  try {
    const me = await membre(String(b.token || "")).catch(() => null);
    if (!me) return out({ ok: false, why: "accès réservé à l’équipe" }, 401);

    if (b.action === "ouvrir") {
      let q = db.from("wl_fiches").select("fiche_id,redacteur,statut,langue").eq("fiche_id", String(b.fiche_id || "")).limit(1); if (!me.chef) q = q.eq("redacteur", me.id);
      const { data: f0 } = await q; const f = f0 && f0[0];
      if (!f) return out({ ok: false, why: "fiche introuvable (ou pas la vôtre)" }, 404);
      if (b.consentement !== true) return out({ ok: false, why: "accord de la personne requis avant d’enregistrer l’appel" });
      const lang = String(b.lang || f.langue || "fr").slice(0, 2).toLowerCase();
      const { data, error } = await db.from("wl_appel_sessions").insert({ fiche_id: f.fiche_id, membre: me.id, lang: LANGUE[lang] ? lang : "fr", consentement: true, mime: mimeOk(b.mime) }).select("id");
      if (error || !data || !data[0]) return out({ ok: false, why: "session impossible" }, 500);
      return out({ ok: true, session_id: data[0].id, tranche_ms: 5 * 60 * 1000, morceau_ms: 20 * 1000 });
    }

    const s = b.session_id ? await sessionDe(me, String(b.session_id)) : null;

    if (b.action === "morceau") {
      if (!s) return out({ ok: false, why: "session introuvable" }, 404);
      const n = Math.max(0, Math.floor(Number(b.n) || 0)), k = Math.max(0, Math.floor(Number(b.k) || 0));
      let bytes: Uint8Array;
      try { bytes = Uint8Array.from(atob(String(b.data || "")), (c) => c.charCodeAt(0)); } catch { return out({ ok: false, why: "morceau illisible" }, 400); }
      if (!bytes.length && !b.dernier) return out({ ok: true, vide: true });
      if (bytes.length > MAX_MORCEAU) return out({ ok: false, why: "morceau trop gros" }, 413);
      if (bytes.length) {
        // upsert : un morceau renvoyé après une coupure réseau remplace le même, sans doublon
        const up = await db.storage.from(BUCKET).upload("appels/" + s.id + "/" + n + "/" + String(k).padStart(5, "0") + ".part", bytes, { contentType: "application/octet-stream", upsert: true });
        if (up.error) return out({ ok: false, why: "rangement du morceau impossible : " + court(up.error.message, 120) }, 500);
      }
      const debut = Math.max(0, Math.floor(Number(b.debut_ms) || 0)), fin = Math.max(debut, Math.floor(Number(b.fin_ms) || 0));
      const { data: t0 } = await db.from("wl_appel_tranches").select("morceaux,fin_ms,complete,chemin").eq("session_id", s.id).eq("n", n).limit(1);
      const t = t0 && t0[0];
      const dernier = b.dernier === true;
      const row = { session_id: s.id, n, debut_ms: debut, fin_ms: Math.max(fin, Number((t && t.fin_ms) || 0)), morceaux: Math.max(k + 1, Number((t && t.morceaux) || 0)),
        complete: dernier || !!(t && t.complete), updated_at: new Date().toISOString(), ...(dernier ? { statut: "a_transcrire", chemin: null } : {}) };
      const { error } = await db.from("wl_appel_tranches").upsert(row, { onConflict: "session_id,n" });
      if (error) return out({ ok: false, why: "tranche : " + court(error.message, 120) }, 500);
      await db.from("wl_appel_sessions").update({ derniere_activite: new Date().toISOString(), duree_ms: Math.max(Number(s.duree_ms || 0), fin), updated_at: new Date().toISOString(), ...(s.statut === "coupe" ? { statut: "en_cours", coupure: "Interruption vers " + chrono(Number(s.duree_ms || 0)) + ", puis l’enregistrement a repris." } : {}) }).eq("id", s.id);
      if (dernier) enFond(traiterTranche(s, n));
      return out({ ok: true });
    }

    if (b.action === "fermer") {
      if (!s) return out({ ok: false, why: "session introuvable" }, 404);
      const coupure = String(b.coupure || "").trim().slice(0, 500);
      const duree = Math.max(Number(s.duree_ms || 0), Math.floor(Number(b.duree_ms) || 0));
      await db.from("wl_appel_sessions").update({ statut: coupure ? "coupe" : "termine", coupure: coupure || (s.statut === "coupe" ? s.coupure : null), duree_ms: duree, derniere_activite: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", s.id);
      // tranches interrompues (dernier morceau jamais arrivé) : reconstituées à partir de ce qui est arrivé
      await db.from("wl_appel_tranches").update({ complete: true, statut: "a_transcrire", updated_at: new Date().toISOString() }).eq("session_id", s.id).eq("complete", false).gt("morceaux", 0);
      const s2 = await sessionDe(me, s.id);
      await surveiller(s2);
      return out({ ok: true, ...(await etatDe(s2)) });
    }

    if (b.action === "etat") {
      if (s) { await surveiller(s); const s2 = await sessionDe(me, s.id); return out({ ok: true, ...(await etatDe(s2)) }); }
      // sans session : les appels enregistrés pour une fiche (reprise après une coupure, réécoute)
      const fid = String(b.fiche_id || "");
      let q = db.from("wl_appel_sessions").select("*").eq("fiche_id", fid).order("created_at", { ascending: false }).limit(10);
      if (!me.chef) q = q.eq("membre", me.id);
      const { data: ss } = await q;
      const l = [];
      for (const x of ss || []) { await surveiller(x); const x2 = await sessionDe(me, x.id); if (x2) { const e = await etatDe(x2); l.push({ ...e.session, pretes: e.pretes, total: e.total, terminee: e.terminee, trous: e.trous.length }); } }
      return out({ ok: true, appels: l });
    }

    if (b.action === "retranscrire") {
      if (!s) return out({ ok: false, why: "session introuvable" }, 404);
      const n = Math.max(0, Math.floor(Number(b.n) || 0));
      await db.from("wl_appel_tranches").update({ essais: 0, statut: "a_transcrire", updated_at: new Date().toISOString() }).eq("session_id", s.id).eq("n", n);
      await traiterTranche(s, n); // une tranche de 5 min : quelques secondes, on attend le résultat
      return out({ ok: true, ...(await etatDe(s)) });
    }

    return out({ ok: false, why: "action inconnue" }, 400);
  } catch (e) {
    return out({ ok: false, why: court((e as Error)?.message || e, 200) });
  }
});
