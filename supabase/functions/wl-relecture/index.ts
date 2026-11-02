// Writinglab — wl-relecture : « Le Correcteur » (24/10/2026). Reprend dans le lab la relecture du lundi de Jonathan (tâche planifiée
// « Correction des articles Posthumain du lundi » avec le skill posthumain-revision:revise-article) : correction complète, puis audit
// de chaque source, puis audit de chaque graphique. Rien n'est écrit dans Ghost sans validation : le rédacteur en chef voit chaque
// correction (avant / après, raison, source) et pousse celles qu'il garde (une par une, tout l'article, ou plusieurs articles d'un coup).
//
// Chaîne :
//  - lancer { post_id } (rédacteur en chef) ou relecture automatique (réglage relecture_auto : jours, heure ; brouillons créés le jour
//    même, dans les 4 heures qui suivent l'heure réglée) → article Ghost lu en Lexical et découpé en blocs (blocs.ts) → une requête
//    Claude (claude-opus-5-5, effort élevé, web_search + web_fetch, graphiques joints en images) envoyée en TRAITEMENT PAR LOT
//    (Message Batches : moitié prix, aucune limite de durée pour la fonction).
//  - tic (pg_cron toutes les 2 minutes, secret relecture_cron_secret de wl_reglages) : lit les lots terminés, reprend un tour
//    interrompu (pause_turn), enregistre le résultat (statut « prete ») et prévient le rédacteur en chef (notification).
//  - valider { id, corrections, insertions, titre, extrait, meta_title, meta_description } : applique les corrections choisies au
//    Lexical ACTUEL du brouillon (un bloc modifié entre-temps n'est pas écrasé) et l'enregistre dans Ghost (statut inchangé : brouillon).
//    Aucun HTML n'est envoyé à Ghost : les encarts d'abonnement, cartes d'amorce, vidéo et graphiques repartent tels quels.
// Graphiques (24/10/2026, demande de Jonathan) : un graphique jugé « faute » est refait AUTOMATIQUEMENT (skill generate-charts de
// l'Usine, skill_01LUtaUvooE33Y3ptMEGKduQ, exécution de code, traitement par lot) ; une « imprécision » propose un bouton « Faire refaire ».
// L'image refaite est téléversée dans Ghost puis proposée en avant / après : elle ne remplace l'image d'origine (même carte, même
// place) qu'après validation. État dans la colonne graphes.
// Le texte du skill (SKILL.md + references/revision-guide.md, dépôt privé trustmedias/claude-posthumain-article-corrector) et les
// consignes du lundi sont dans wl_reglages (relecture_skill, relecture_guide, relecture_lundi, relecture_skill_version) : jamais dans
// ce dépôt public. Ils sont recopiés AUTOMATIQUEMENT à chaque fusion sur main du dépôt du skill (GitHub Action, action skill_maj).
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { parEmail, type Membre } from "./equipe.ts";
import { contexteKb } from "./kb.ts";
import { blocsPayants, extraitGuide, marquerCoupure, messageConversion, normaliserCoupure, OUTIL_CONVERSION, poserCoupure, raisonRefus, systemeConversion } from "./premium.ts";
import { appliquer, blocPourIA, type Bloc, court, dimensionsImage, extraireBlocs, normaliserCorrections, remplacerImage } from "./blocs.ts";

const env = (k: string) => (Deno.env.get(k) || "").trim();
const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const SITE = "https://posthumain.com";
const ORIGINES = ["https://posthumain.com", "https://www.posthumain.com"];
const MODELE = "claude-opus-5-5";
const TARIF_LOT = { in: 2.5, out: 12.5, cw: 3.125, cr: 0.25, web: 0.01 }; // USD (moitié du tarif Opus en traitement par lot), recherche web 10 $ / 1000
const ghostUrl = () => (env("GHOST_ADMIN_API_URL") || "https://the-last-journal.ghost.io").replace(/\/+$/g, "");
const txt = (v: unknown, max: number) => String(v ?? "").slice(0, max);

function cors(req: Request) {
  const o = req.headers.get("origin") || "";
  return { "Access-Control-Allow-Origin": ORIGINES.includes(o) ? o : ORIGINES[0], "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "content-type", "Vary": "Origin" };
}
const b64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), (c) => c.charCodeAt(0));
const b64uEnc = (b: Uint8Array | string) => btoa(typeof b === "string" ? b : String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
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

// ---------- Ghost Admin ----------
async function ghostToken() {
  const [id, secret] = env("GHOST_ADMIN_API_KEY").split(":");
  if (!id || !secret) throw new Error("clé Admin Ghost absente des secrets Supabase (GHOST_ADMIN_API_KEY)");
  const now = Math.floor(Date.now() / 1000);
  const head = b64uEnc(JSON.stringify({ alg: "HS256", typ: "JWT", kid: id })), body = b64uEnc(JSON.stringify({ iat: now, exp: now + 300, aud: "/admin/" }));
  const k = await crypto.subtle.importKey("raw", Uint8Array.from(secret.match(/.{2}/g)!.map((h) => parseInt(h, 16))), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return head + "." + body + "." + b64uEnc(new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(head + "." + body))));
}
// deno-lint-ignore no-explicit-any
async function ghost(path: string, method = "GET", body?: unknown): Promise<any> {
  const r = await fetch(ghostUrl() + "/ghost/api/admin/" + path, { method, signal: AbortSignal.timeout(20000), headers: { Authorization: "Ghost " + (await ghostToken()), "Accept-Version": "v5.0", ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error("Ghost " + r.status + " " + String(j?.errors?.[0]?.message || j?.errors?.[0]?.context || "").slice(0, 200)), { statut: r.status });
  return j;
}
const CHAMPS = "id,uuid,title,slug,status,visibility,updated_at,created_at,custom_excerpt,meta_title,meta_description,og_title,twitter_title,url,email_only,feature_image";
// deno-lint-ignore no-explicit-any
async function lirePost(id: string): Promise<any> {
  if (!/^[a-f0-9]{24}$/.test(id)) throw new Error("identifiant d’article invalide");
  const p = (await ghost(`posts/${id}/?formats=lexical&include=tags,authors&fields=${CHAMPS},lexical`)).posts?.[0];
  if (!p) throw new Error("article introuvable dans Ghost");
  return p;
}
const minuitZurich = () => {
  const now = new Date();
  const d = new Intl.DateTimeFormat("fr-CA", { timeZone: "Europe/Zurich", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const off = (new Date(now.toLocaleString("en-US", { timeZone: "Europe/Zurich" })).getTime() - new Date(now.toLocaleString("en-US", { timeZone: "UTC" })).getTime()) / 60000;
  return new Date(Date.parse(d + "T00:00:00Z") - off * 60000).toISOString();
};
const zurich = () => { const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Zurich", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date()).map((x) => [x.type, x.value])); return { jour: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday), min: Number(p.hour) * 60 + Number(p.minute) }; };

// ---------- Réglages, notifications ----------
async function reglage(cle: string) { const { data } = await db.from("wl_reglages").select("valeur").eq("cle", cle).limit(1); return String((data && data[0] && data[0].valeur) || ""); }
async function ecrireReglage(cle: string, valeur: string) { await db.from("wl_reglages").upsert({ cle, valeur, updated_at: new Date().toISOString() }, { onConflict: "cle" }); }
type Auto = { actif: boolean; jours: number[]; heure: string };
async function lireAuto(): Promise<Auto> {
  let o: Partial<Auto> = {}; try { o = JSON.parse(await reglage("relecture_auto") || "{}"); } catch { o = {}; }
  const jours = (Array.isArray(o.jours) ? o.jours : [1]).map(Number).filter((x) => x >= 0 && x <= 6);
  return { actif: o.actif !== false, jours: [...new Set(jours)].sort(), heure: /^\d{2}:\d{2}$/.test(String(o.heure)) ? String(o.heure) : "13:00" };
}
async function chefsIds(): Promise<string[]> {
  const { data } = await db.from("wl_equipe").select("id").eq("role", "chef").eq("actif", true);
  const l = (data || []).map((x: { id: string }) => String(x.id)); return l.length ? l : ["jonathan"];
}
async function pushChefs(title: string, message: string) {
  try {
    await fetch(env("SUPABASE_URL") + "/functions/v1/wl-db", { method: "POST", signal: AbortSignal.timeout(15000), headers: { "Content-Type": "application/json", "x-tv-secret": env("TV_ADMIN_SECRET") },
      body: JSON.stringify({ action: "push", to: await chefsIds(), title, message, ancre: "correcteur" }) });
  } catch (_) { /* notification facultative */ }
}

// ---------- Le Correcteur (prompt, outil de rendu) ----------
const OUTIL = {
  name: "rendre_relecture",
  description: "Rendu final de la relecture (un seul appel, à la toute fin, après la correction, l'audit des sources et l'audit des graphiques).",
  input_schema: { type: "object", required: ["resume", "corrections"], properties: {
    resume: { type: "string", description: "Bilan en 2 ou 3 phrases pour le rédacteur en chef (sur téléphone) : l'état de l'article et l'essentiel de ce qui change." },
    type_article: { type: "string", enum: ["actu", "premium"] },
    titre: { type: "object", properties: { nouveau: { type: "string", description: "Titre retenu (même angle que l'original ; vide si l'original est déjà le meilleur)." }, autres: { type: "array", items: { type: "string" }, description: "Deux autres propositions de titre." }, raison: { type: "string" } } },
    extrait: { type: "object", properties: { nouveau: { type: "string" }, raison: { type: "string" } }, description: "Sous-titre (custom_excerpt) ; vide si inchangé." },
    meta_title: { type: "object", properties: { nouveau: { type: "string" }, raison: { type: "string" } } },
    meta_description: { type: "object", properties: { nouveau: { type: "string", description: "155 caractères au plus." }, raison: { type: "string" } } },
    corrections: { type: "array", description: "Un élément par bloc modifié (toutes les corrections du bloc fusionnées), dans l'ordre de l'article.", items: { type: "object", required: ["bloc", "resume", "categories"], properties: {
      bloc: { type: "integer" }, md: { type: "string", description: "Texte COMPLET du bloc après correction (paragraphe, intertitre, citation)." },
      items: { type: "array", items: { type: "string" }, description: "Pour une liste : toutes les puces après correction." },
      html: { type: "string", description: "Pour la carte des sources uniquement : l'<ol> complète corrigée." },
      categories: { type: "array", items: { type: "string", enum: ["redaction", "anti_ia", "fact_check", "vulgarisation", "putaclic", "sommaire", "premium", "sources", "hors_france", "vitrine"] } },
      resume: { type: "string", description: "Ce qui change et pourquoi, en une phrase." }, details: { type: "array", items: { type: "string" }, description: "Chaque changement du bloc s'il y en a plusieurs (« avant » → « après » : raison)." },
      sources: { type: "array", items: { type: "string" }, description: "URL qui justifient une correction factuelle." } } } },
    insertions: { type: "array", items: { type: "object", required: ["apres", "blocs", "resume"], properties: { apres: { type: "integer", description: "Numéro du bloc après lequel insérer." },
      blocs: { type: "array", items: { type: "object", properties: { t: { type: "string", enum: ["p", "h2", "h3", "ul", "ol"] }, md: { type: "string" }, items: { type: "array", items: { type: "string" } } } } },
      categories: { type: "array", items: { type: "string" } }, resume: { type: "string" }, details: { type: "array", items: { type: "string" } } } } },
    sources_audit: { type: "array", description: "Une ligne par source de la liste (et par source ajoutée).", items: { type: "object", properties: { n: { type: "integer" }, url: { type: "string" },
      verdict: { type: "string", enum: ["ok", "corrigee", "remplacee", "ajoutee", "retiree", "inaccessible"] }, note: { type: "string", description: "La page soutient-elle la phrase, ce qu'elle dit de plus ou de contraire, titre et date exacts, ce qui a été fait." } } } },
    graphiques: { type: "array", items: { type: "object", properties: { bloc: { type: "integer" }, verdict: { type: "string", enum: ["juste", "imprecision", "faute", "non_verifie"] }, note: { type: "string" }, a_refaire: { type: "boolean", description: "Vrai seulement pour une vraie faute (chiffre ou unité faux, source qui ne dit pas ce chiffre, graphique aberrant ou trompeur, contradiction avec le texte)." },
      refaire: { type: "object", description: "Pour tout graphique qui n'est pas « juste » : les données corrigées et sourcées du graphique refait.", properties: { titre: { type: "string" }, type: { type: "string", enum: ["barres", "barres_horizontales", "barres_groupees", "courbe"] }, unite: { type: "string" },
        series: { type: "array", items: { type: "object", properties: { nom: { type: "string" }, points: { type: "array", items: { type: "object", properties: { label: { type: "string" }, valeur: { type: "number" } } } } } } },
        source: { type: "string", description: "Source exacte des chiffres (nom et URL)." }, legende: { type: "string", description: "Légende sous le graphique, avec la source." }, changement: { type: "string", description: "Ce qui change par rapport au graphique d'origine." } } } } } },
    suggestions: { type: "array", items: { type: "string" }, description: "Ce que tu changerais dans un bloc protégé (phrase d'amorce premium, place de la coupure, og_title…) ou ce qui ne se corrige pas ici." },
    a_verifier: { type: "array", items: { type: "string" }, description: "Ce qui demande l'intervention du rédacteur en chef." },
    preservation: { type: "string", description: "Mini-rapport chiffré de l'étape 8 du skill (gras, liens, intertitres, sources, tics IA, cadratins, vulgarisation…)." },
  } },
};
function systeme(skill: string, guide: string, lundi: string, kb: string) {
  return [
    "Tu es « Le Correcteur » du Writinglab de Posthumain (média francophone sur abonnement : IA, tech, science ; Ghost CMS ; posthumain.com). Tu remplaces la relecture que Jonathan Paiano, le rédacteur en chef, faisait chaque lundi : corriger le brouillon, PUIS auditer toutes ses sources, PUIS auditer tous ses graphiques. Personne n'est là pour te répondre : ne pose aucune question, fais tout le travail et rends-le avec l'outil « rendre_relecture ».",
    "=== CONTRAT DU LAB (prime sur les étapes 1, 9 et 10 du skill, sur ses outils Ghost et sur card_visibility) ===\n" + [
      "Tu n'as AUCUN outil Ghost. L'article t'est donné en BLOCS numérotés [i]. Tu ne rends QUE ce qui change, en un seul appel à « rendre_relecture » à la toute fin. Jamais l'article complet, jamais de HTML (sauf la carte des sources).",
      "Un bloc corrigé = un élément de « corrections » avec le texte COMPLET du bloc après correction (toutes ses corrections fusionnées), dans la même mise en forme : **gras**, *italique*, [texte](url), \\[ et \\] pour des crochets littéraux. Les appels de source s'écrivent \\[[N](#source-N)\\]. Une liste se rend dans « items » (toutes les puces). La carte des sources (bloc « sources ») se rend dans « html » : l'<ol> complète corrigée, chaque <li id=\"source-N\"> gardant sa forme, href = URL exacte de l'article, texte du lien = nom du domaine.",
      "Les blocs 🔒 sont protégés et recopiés à l'identique par le lab (encarts d'abonnement, cartes d'amorce premium, encart vidéo, images et graphiques, coupure paywall, séparateurs, cartes HTML) : tu n'as rien à préserver toi-même pour eux et tu ne peux pas les modifier. Ce que tu y changerais (phrase d'amorce premium, place de la coupure, graphique à refaire, og_title) va dans « suggestions » ou « graphiques ».",
      "Un bloc à créer (ex. le sommaire « **Dans cet article :** » + sa liste, s'il manque) va dans « insertions » (« apres » = numéro du bloc qui le précède). Pas de suppression de bloc, pas de changement de type de bloc. Si le sommaire existe, corrige ses blocs.",
      "Titre, sous-titre (custom_excerpt), meta_title, meta_description : champs dédiés, vides s'ils ne changent pas. La vitrine suit le contenu. Donne aussi deux autres propositions de titre.",
      "Chaque correction a un « resume » d'une phrase (ce qui change et pourquoi), des « details » s'il y a plusieurs changements dans le bloc, ses « categories » et, pour un fait corrigé, l'URL de la source qui le justifie. Le rédacteur en chef valide chaque correction une par une sur son téléphone : ne touche pas un bloc sans raison, mais corrige vraiment tout ce qui doit l'être.",
      "La visibilité de l'article (premium ou non) et son statut ne changent jamais. Un article est premium seulement si sa visibilité est paid ou tiers.",
    ].map((x) => "- " + x).join("\n"),
    "=== MÉTHODE : LA RELECTURE DU LUNDI ===\n1. Correction complète selon le skill revise-article ci-dessous (toutes ses passes, y compris la passe premium si l'article est premium, et sa vérification de préservation pour le texte que tu rends).\n2. Audit complet des sources, puis 3. audit des graphiques, selon les consignes de Jonathan plus bas. Outils : web_search et web_fetch. Ouvre CHAQUE URL de la liste des sources avec web_fetch. Une page qui refuse le serveur (403, anti-robot) est « inaccessible » (lien sans doute valide), jamais déclarée morte. Les graphiques te sont joints en images après l'article ; un graphique dont l'image manque est « non_verifie ».",
    "=== SKILL posthumain-revision:revise-article (SKILL.md) ===\n" + skill,
    "=== SKILL : references/revision-guide.md ===\n" + guide,
    "=== CONSIGNES DE JONATHAN (relecture du lundi ; elles priment sur le skill quand elles le contredisent) ===\n" + lundi,
    kb ? kb + "\n(Base de connaissances de la rédaction : appuie-toi dessus sans la recopier.)" : "",
  ].filter(Boolean).join("\n\n");
}
const w1000 = (u: string) => u.replace(/\/content\/images\/(?!size\/)/, "/content/images/size/w1000/");
async function imageB64(src: string): Promise<{ media_type: string; data: string } | null> {
  for (const u of [w1000(src), src]) {
    try {
      const r = await fetch(u, { signal: AbortSignal.timeout(15000) });
      if (!r.ok) continue;
      const mt = (r.headers.get("content-type") || "").split(";")[0].trim();
      if (!/^image\/(jpeg|png|gif|webp)$/.test(mt)) continue;
      const b = new Uint8Array(await r.arrayBuffer());
      if (b.length > 4.5e6) continue;
      let s = ""; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
      return { media_type: mt, data: btoa(s) };
    } catch (_) { /* image suivante */ }
  }
  return null;
}
// deno-lint-ignore no-explicit-any
async function messageInitial(p: any, blocs: Bloc[]) {
  const tags = (p.tags || []).map((t: { name: string }) => t.name).filter(Boolean);
  const entete = ["Article à relire (" + (p.status === "published" || p.statut === "published" ? "article DÉJÀ PUBLIÉ : les corrections validées partiront en ligne" : "brouillon Ghost") + ") :", "Titre : " + (p.title || ""), "Sous-titre (custom_excerpt) : " + (p.custom_excerpt || "(vide)"), "meta_title : " + (p.meta_title || "(vide)"), "meta_description : " + (p.meta_description || "(vide)"),
    "og_title / twitter_title : " + [p.og_title, p.twitter_title].filter(Boolean).join(" / ") || "(vides)", "Visibilité : " + p.visibility + (["paid", "tiers"].includes(p.visibility) ? " → ARTICLE PREMIUM" : " → article non premium"),
    "Tags : " + tags.join(", "), "Créé le : " + p.created_at, "Date du jour : " + new Date().toISOString().slice(0, 10), "", "BLOCS DE L'ARTICLE :"].join("\n");
  // deno-lint-ignore no-explicit-any
  const contenu: any[] = [{ type: "text", text: entete + "\n" + blocs.map(blocPourIA).join("\n\n") }];
  const figs = blocs.filter((b) => b.t === "protege" && b.src && (b.genre === "graphique" || b.genre === "image")).sort((a, b) => (a.genre === "graphique" ? 0 : 1) - (b.genre === "graphique" ? 0 : 1)).slice(0, 8);
  for (const f of figs) {
    const img = await imageB64(String(f.src));
    contenu.push({ type: "text", text: (f.genre === "graphique" ? "GRAPHIQUE" : "IMAGE") + " du bloc [" + f.i + "]" + (f.legende ? " — légende : « " + f.legende + " »" : "") + (img ? "" : " — image inaccessible depuis le serveur : à marquer non_verifie") });
    if (img) contenu.push({ type: "image", source: { type: "base64", ...img } });
  }
  contenu.push({ type: "text", text: "Fais la relecture complète (correction, audit de chaque source, audit de chaque graphique), puis appelle « rendre_relecture » une seule fois." });
  contenu[contenu.length - 1].cache_control = { type: "ephemeral" };
  return contenu;
}
async function paramsRequete(systemeTxt: string, messages: unknown[]) {
  return { model: MODELE, max_tokens: 48000, thinking: { type: "adaptive" }, output_config: { effort: "high" },
    system: [{ type: "text", text: systemeTxt, cache_control: { type: "ephemeral" } }],
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 15 }, { type: "web_fetch_20250910", name: "web_fetch", max_uses: 35, max_content_tokens: 8000 }, OUTIL],
    tool_choice: { type: "auto" }, messages };
}
const anthropic = (path: string, init: RequestInit = {}, betas = "web-fetch-2025-09-10") => fetch("https://api.anthropic.com/v1/" + path, { ...init, signal: AbortSignal.timeout(60000),
  headers: { "x-api-key": env("ANTHROPIC_API_KEY"), "anthropic-version": "2023-06-01", "anthropic-beta": betas, "content-type": "application/json", ...(init.headers || {}) } });
const BETAS_GRAPHIQUE = "code-execution-2025-08-25,skills-2025-10-02,files-api-2025-04-14";
const SKILL_GRAPHIQUES = "skill_01LUtaUvooE33Y3ptMEGKduQ"; // generate-charts (Skills API, version la plus récente : celle de l'Usine)
async function soumettre(id: number, tour: number, params: unknown): Promise<string> {
  if (!env("ANTHROPIC_API_KEY")) throw new Error("clé Anthropic absente");
  const r = await anthropic("messages/batches", { method: "POST", body: JSON.stringify({ requests: [{ custom_id: "rl-" + id + "-" + tour, params }] }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.id) throw new Error("envoi au Correcteur refusé (" + r.status + ") : " + court(j?.error?.message, 200));
  return String(j.id);
}
// 27/10/2026 — RELAIS DIRECT (n8n). Le traitement par lot n'a aucun délai garanti (relectures restées plus de 4 h dans la file le 26/10)
// et Supabase coupe toute tâche de fond à 150 s (mesuré le 27/10) : un appel direct long ne peut donc pas tourner ici. Les appels directs
// (tour de relecture dont le lot traîne, refonte de graphique) sont confiés au workflow n8n « Posthumain — Writinglab Correcteur (relais
// direct) », qui appelle Anthropic (jusqu'à 15 min) puis renvoie le résultat à cette fonction (action direct_resultat, même secret que le tic).
const ATTENTE_LOT_MS = 20 * 60e3;   // 🎛️ attente maximale d'un lot avant de passer en direct
const DIRECT_MAX_MS = 20 * 60e3;    // 🎛️ au-delà, un appel direct sans retour est déclaré interrompu
const RELAIS = "https://trustmedias.app.n8n.cloud/webhook/wl-correcteur-5682680b3cc91aca96d9eccf";
async function relais(ref: Record<string, unknown>, params: unknown, betas = "web-fetch-2025-09-10") {
  const secret = await reglage("relecture_cron_secret");
  const r = await fetch(RELAIS, { method: "POST", signal: AbortSignal.timeout(20000), headers: { "content-type": "application/json" },
    body: JSON.stringify({ ref, params, betas, secret, retour: env("SUPABASE_URL").replace(/\/+$/g, "") + "/functions/v1/wl-relecture" }) });
  if (!r.ok) throw new Error("relais n8n injoignable (" + r.status + ")");
}
// Retour du relais : même traitement qu'un lot terminé (relecture) ou qu'une refonte terminée (graphique).
// deno-lint-ignore no-explicit-any
async function recevoirDirect(b: any) {
  // deno-lint-ignore no-explicit-any
  const ref: any = b.ref || {}, msg: any = b.message || {};
  const ok = Number(b.statut) >= 200 && Number(b.statut) < 300 && Array.isArray(msg.content);
  const why = "Correcteur (direct) : " + (b.erreur ? court(b.erreur, 200) : "refusé (" + b.statut + ") " + court(msg?.error?.message || "", 200));
  const id = Number(ref.id);
  if (ref.genre === "graphique") {
    const k = Number(ref.k);
    const { data } = await db.from("wl_relectures").select("id,titre,statut,resultat,graphes,lance_par,meta").eq("id", id).limit(1);
    const row = data && data[0];
    // deno-lint-ignore no-explicit-any
    const g = row && (row.graphes || []).find((x: any) => x.k === k);
    if (!g || g.statut !== "en_cours") return { ok: true, ignore: true };
    if (!ok) { await majGraphe(id, k, { statut: "erreur", erreur: why }); return { ok: true, r: "erreur" }; }
    try { const u = msg.usage || {}; await db.from("wl_couts").insert({ membre: row.lance_par || null, usage: "relecture_graphique", modele: String(msg.model || MODELE), tokens_in: Number(u.input_tokens || 0) + Number(u.cache_read_input_tokens || 0), tokens_out: Number(u.output_tokens || 0), cout_eur: Math.round(coutDe(u) * 2 * 1e4) / 1e4 }); } catch (_) { /* facultatif */ }
    const tour = Number(ref.tour) || 0, nom = String(ref.nom || g.nom || "");
    if (msg.stop_reason === "pause_turn" && tour < 3) {
      // tour interrompu (exécution de code longue) : on reprend dans le même conteneur
      const contenus = (Array.isArray(ref.contenus) ? ref.contenus : []).concat([msg.content]);
      const p = await paramsGraphique(row, (row.resultat?.graphiques || [])[k], k, nom);
      p.messages = p.messages.concat(contenus.map((c: unknown) => ({ role: "assistant", content: c })));
      if (msg.container?.id) p.container = { id: msg.container.id, skills: p.container.skills };
      await relais({ ...ref, tour: tour + 1, contenus }, p, BETAS_GRAPHIQUE);
      await majGraphe(id, k, { lance: new Date().toISOString() });
      return { ok: true, r: "relancé" };
    }
    return { ok: true, r: await recevoirGraphique(row, k, nom, msg) };
  }
  const { data } = await db.from("wl_relectures").select("*").eq("id", id).limit(1);
  const row = data && data[0];
  if (!row || row.statut !== "en_cours" || row.batch_id !== ref.bid) return { ok: true, ignore: true };   // écartée ou déjà relancée entre-temps
  if (!ok) { await db.from("wl_relectures").update({ statut: "erreur", erreur: why, updated_at: new Date().toISOString() }).eq("id", id); return { ok: true, r: "erreur" }; }
  return { ok: true, r: await terminer(row, msg) };
}
async function texteSkill() {
  const [skill, guide, lundi] = await Promise.all([reglage("relecture_skill"), reglage("relecture_guide"), reglage("relecture_lundi")]);
  if (!skill || !guide) throw new Error("le texte du skill de relecture n’est pas encore enregistré (réglages relecture_skill / relecture_guide)");
  return { skill, guide, lundi };
}

// ---------- Conversion en actu premium (02/11/2026, demande de Jonathan ; premium.ts) ----------
// Même chaîne que la relecture (lot à moitié prix, relais direct passé ATTENTE_LOT_MS, validation du rédacteur en chef), autre mission :
// la section finale enrichie avec les sources déjà citées (2 recherches web au plus), la coupure et la phrase d'amorce. Opus 5.5,
// effort moyen (règle de Jonathan du 24/10 pour tout ce qui demande de bien comprendre un long article).
// deno-lint-ignore no-explicit-any
const estConv = (row: any) => row?.meta?.mode === "actu_premium";
async function paramsConversion(titre: string, messages: unknown[]) {
  const guide = await reglage("relecture_guide");
  const kb = (await contexteKb(db, "redaction", titre).catch(() => ({ texte: "" }))).texte;
  return { model: MODELE, max_tokens: 24000, thinking: { type: "adaptive" }, output_config: { effort: "medium" },
    system: [{ type: "text", text: systemeConversion(extraitGuide(guide), kb), cache_control: { type: "ephemeral" } }],
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 2 }, { type: "web_fetch_20250910", name: "web_fetch", max_uses: 6, max_content_tokens: 6000 }, OUTIL_CONVERSION],
    tool_choice: { type: "auto" }, messages };
}
// Paramètres d'un tour (premier, suivant, ou relais direct) selon la mission de la ligne.
// deno-lint-ignore no-explicit-any
async function paramsPour(row: any, messages: unknown[]) {
  if (estConv(row)) return await paramsConversion(String(row.titre || ""), messages);
  const s = await texteSkill();
  const kb = (await contexteKb(db, "redaction", String(row.titre || "")).catch(() => ({ texte: "" }))).texte;
  return await paramsRequete(systeme(s.skill, s.guide, s.lundi, kb), messages);
}
// deno-lint-ignore no-explicit-any
async function messagesDepart(row: any) {
  const m = row.meta || {};
  if (estConv(row)) return [{ role: "user", content: messageConversion({ title: m.titre, custom_excerpt: m.extrait, tags: m.tags || [], status: m.statut }, row.blocs) }];
  return [{ role: "user", content: await messageInitial({ ...m, title: m.titre, custom_excerpt: m.extrait, visibility: m.visibilite, tags: [], created_at: row.created_at }, row.blocs) }];
}
async function lancerConversion(postId: string, qui: string, essai = false) {
  const { data: lignes } = await db.from("wl_relectures").select("id,statut,meta").eq("post_id", postId).in("statut", ["en_cours", "prete"]).order("created_at", { ascending: false }).limit(10);
  const enCours = (lignes || []).filter((r: { meta?: { mode?: string } }) => r.meta?.mode === "actu_premium");
  if (enCours[0]) return { ok: true, id: enCours[0].id, deja: enCours[0].statut };
  const p = await lirePost(postId);
  const refus = raisonRefus(p);
  if (refus) throw new Error(refus);
  const blocs = extraireBlocs(p.lexical);
  if (blocs.filter((b) => b.t !== "protege").length < 6) throw new Error("article trop court pour une actu premium");
  const meta = { mode: "actu_premium", titre: p.title || "", extrait: p.custom_excerpt || "", visibilite: p.visibility, statut: p.status,
    tags: (p.tags || []).map((t: { id: string; name: string; slug: string }) => ({ id: t.id, name: t.name, slug: t.slug })), image: p.feature_image || "",
    editeur: ghostUrl() + "/ghost/#/editor/post/" + p.id, apercu: p.uuid ? SITE + "/p/" + p.uuid + "/" : "", ...(essai ? { essai: true } : {}) };
  const { data: row, error } = await db.from("wl_relectures").insert({ post_id: p.id, titre: p.title || "", statut: "en_cours", auto: false, lance_par: qui, post_maj: p.updated_at, blocs, meta }).select("id").limit(1);
  if (error || !row || !row[0]) throw new Error("enregistrement impossible : " + (error && error.message));
  const id = Number(row[0].id);
  try {
    const batch = await soumettre(id, 0, await paramsConversion(p.title || "", [{ role: "user", content: messageConversion(p, blocs) }]));
    await db.from("wl_relectures").update({ batch_id: batch, updated_at: new Date().toISOString() }).eq("id", id);
  } catch (e) {
    await db.from("wl_relectures").update({ statut: "erreur", erreur: court((e as Error).message, 400), updated_at: new Date().toISOString() }).eq("id", id);
    throw e;
  }
  return { ok: true, id };
}
// deno-lint-ignore no-explicit-any
async function terminerConversion(row: any, o: any, contenu: any[], msg: any, cout: number, now: string) {
  const blocs: Bloc[] = row.blocs || [];
  const n = normaliserCorrections(o, blocs);
  for (const x of [...n.corrections, ...n.insertions]) if (!x.categories.length) x.categories = ["premium"];   // rangées sous « 💎 Premium » dans l'écran de validation
  const c = normaliserCoupure(o.coupure, blocs);
  const echec = async (why: string) => { await db.from("wl_relectures").update({ statut: "erreur", erreur: "Conversion : " + why + " (relancez-la)", cout_eur: cout, suite: null, updated_at: now }).eq("id", row.id); return "erreur"; };
  if ("erreur" in c) return await echec(c.erreur);
  if (blocsPayants(blocs, c.apres, n.insertions) < 2) return await echec("la partie payante serait vide ou presque");
  const cor = n.corrections.find((x: { bloc: number }) => x.bloc === c.apres);
  const resultat = { mode: "actu_premium", resume: court(o.resume, 800), corrections: n.corrections, insertions: n.insertions, rejets: n.rejets,
    coupure: { ...c, tension: cor ? (cor.md || "") : ((blocs.find((b) => b.i === c.apres) || {}).md || "") },
    // deno-lint-ignore no-explicit-any
    a_verifier: (Array.isArray(o.a_verifier) ? o.a_verifier : []).map((x: any) => court(x, 600)).filter(Boolean).slice(0, 10),
    stats: { tours: row.tours + 1, recherches: Number(msg.usage?.server_tool_use?.web_search_requests || 0), pages: contenu.filter((x) => x.type === "server_tool_use" && x.name === "web_fetch").length } };
  await db.from("wl_relectures").update({ statut: "prete", resultat, cout_eur: cout, suite: null, erreur: null, updated_at: now }).eq("id", row.id);
  if (!row.meta?.essai) await pushChefs("💎 Actu premium prête", "« " + court(row.titre, 90) + " » : section finale enrichie et coupure à valider.");
  return "prête";
}
// Radar (Airtable) : la ligne de l'article passe ActuPremium, pour que le batch du soir et les règles de push le traitent en actu premium.
async function airtableActuPremium(postId: string, ancre: string): Promise<string> {
  const key = env("AIRTABLE_TOKEN") || env("POSTHUMAIN_AIRTABLE_TOKEN") || env("AIRTABLE_API_KEY") || env("AIRTABLE_PAT");
  if (!key) return "clé Airtable absente";
  const base = env("AIRTABLE_BASE") || "appPc2y4ts9tVZCjQ";
  try {
    const r = await fetch(`https://api.airtable.com/v0/${base}/Radar?maxRecords=1&filterByFormula=${encodeURIComponent(`{GhostPostId}='${postId.replace(/[^a-f0-9]/g, "")}'`)}`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15000) });
    const j = await r.json().catch(() => ({}));
    const rec = (j.records || [])[0];
    if (!rec) return "ligne du Radar introuvable";
    const u = await fetch(`https://api.airtable.com/v0/${base}/Radar/${rec.id}`, { method: "PATCH", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify({ fields: { ActuPremium: true, PaywallAnchor: ancre } }), signal: AbortSignal.timeout(15000) });
    return u.ok ? "ok" : "Airtable " + u.status;
  } catch (e) { return court((e as Error).message, 120); }
}
// deno-lint-ignore no-explicit-any
async function validerConversion(row: any, b: any, me: Membre) {
  const R = row.resultat || {};
  if (!R.coupure) throw new Error("conversion sans coupure");
  const tout = b.tout === true;
  const cIdx: number[] = tout ? (R.corrections || []).map((_: unknown, k: number) => k) : (Array.isArray(b.corrections) ? b.corrections : []).map(Number).filter((k: number) => R.corrections && R.corrections[k]);
  const iIdx: number[] = tout ? (R.insertions || []).map((_: unknown, k: number) => k) : (Array.isArray(b.insertions) ? b.insertions : []).map(Number).filter((k: number) => R.insertions && R.insertions[k]);
  const corrections = cIdx.map((k) => R.corrections[k]), insertions = iIdx.map((k) => R.insertions[k]);
  for (let essai = 0; essai < 2; essai++) {
    const p = await lirePost(row.post_id);
    const refus = raisonRefus(p);
    if (refus) throw new Error(refus);
    const lex = JSON.parse(p.lexical);
    marquerCoupure(lex, row.blocs || [], R.coupure.apres);
    const a = appliquer(lex, row.blocs || [], corrections, insertions);
    poserCoupure(a.lexical, String(R.coupure.amorce || ""));
    // deno-lint-ignore no-explicit-any
    const tags: any[] = (p.tags || []).map((t: { id: string }) => ({ id: t.id }));
    tags.push({ name: "actu-premium", slug: "actu-premium" });
    try {
      await ghost(`posts/${p.id}/`, "PUT", { posts: [{ lexical: JSON.stringify(a.lexical), visibility: "paid", tags, updated_at: p.updated_at }] });
    } catch (e) { if ((e as { statut?: number }).statut === 409 && essai === 0) continue; throw e; }
    const airtable = await airtableActuPremium(p.id, "Converti depuis le Writinglab le " + new Date().toISOString().slice(0, 10) + " : coupure dans la section finale, après « " + court(String(R.coupure.tension || "").replace(/\*+/g, ""), 160) + " » ; amorce : « " + court(R.coupure.amorce, 200) + " »");
    const appliquees = { corrections: a.appliquees.map((k) => cIdx[k]), insertions: a.inserees.map((k) => iIdx[k]),
      conflits: a.conflits.map((c) => ({ ...c, ref: (c.ref[0] === "c" ? "c" + cIdx[Number(c.ref.slice(1))] : "i" + iIdx[Number(c.ref.slice(1))]) })), premium: true, airtable };
    await db.from("wl_relectures").update({ statut: "validee", appliquees, validee_le: new Date().toISOString(), validee_par: me.id, updated_at: new Date().toISOString() }).eq("id", row.id);
    return { ok: true, id: row.id, appliquees };
  }
  throw new Error("Ghost a refusé l’enregistrement (article modifié au même moment) : réessayez");
}

// ---------- Lancer une relecture ----------
async function lancer(postId: string, qui: string, auto = false, essai = false) {
  // deno-lint-ignore no-explicit-any
  const { data: enCours0 } = await db.from("wl_relectures").select("id,statut,meta").eq("post_id", postId).in("statut", ["en_cours", "prete"]).order("created_at", { ascending: false }).limit(10);
  const enCours = (enCours0 || []).filter((r: { meta?: { mode?: string } }) => r.meta?.mode !== "actu_premium");   // une conversion en actu premium n'empêche pas une relecture
  if (enCours[0]) return { ok: true, id: enCours[0].id, deja: enCours[0].statut };
  const p = await lirePost(postId);
  // 25/10/2026 (Jonathan) : un article publié se relit sur demande (bouton) ; la relecture AUTOMATIQUE ne prend que les brouillons du jour.
  if (p.status === "published" && auto) throw new Error("article déjà publié : la relecture automatique ne prend que les brouillons");
  const blocs = extraireBlocs(p.lexical);
  if (blocs.filter((b) => b.t !== "protege").length < 3) throw new Error("article trop court ou illisible pour une relecture");
  const s = await texteSkill();
  const kb = (await contexteKb(db, "redaction", String(p.title || "")).catch(() => ({ texte: "" }))).texte;
  const messages = [{ role: "user", content: await messageInitial(p, blocs) }];
  const meta = { titre: p.title || "", extrait: p.custom_excerpt || "", meta_title: p.meta_title || "", meta_description: p.meta_description || "", visibilite: p.visibility, statut: p.status,
    og_title: p.og_title || "", twitter_title: p.twitter_title || "", image: p.feature_image || "", editeur: ghostUrl() + "/ghost/#/editor/post/" + p.id, apercu: p.uuid ? SITE + "/p/" + p.uuid + "/" : "", skill: await reglage("relecture_skill_version"), ...(essai ? { essai: true } : {}) };
  const { data: row, error } = await db.from("wl_relectures").insert({ post_id: p.id, titre: p.title || "", statut: "en_cours", auto, lance_par: qui, post_maj: p.updated_at, blocs, meta }).select("id").limit(1);
  if (error || !row || !row[0]) throw new Error("enregistrement impossible : " + (error && error.message));
  const id = Number(row[0].id);
  try {
    const batch = await soumettre(id, 0, await paramsRequete(systeme(s.skill, s.guide, s.lundi, kb), messages));
    await db.from("wl_relectures").update({ batch_id: batch, updated_at: new Date().toISOString() }).eq("id", id);
  } catch (e) {
    await db.from("wl_relectures").update({ statut: "erreur", erreur: court((e as Error).message, 400), updated_at: new Date().toISOString() }).eq("id", id);
    throw e;
  }
  return { ok: true, id };
}

// ---------- Suivi des lots (tic) ----------
// deno-lint-ignore no-explicit-any
function coutDe(u: any, direct = false) {
  if (!u) return 0;
  if (direct) return Math.round(coutDe(u) * 2 * 1e4) / 1e4; // appel direct : plein tarif (le lot est à moitié prix)
  const usd = (Number(u.input_tokens || 0) * TARIF_LOT.in + Number(u.output_tokens || 0) * TARIF_LOT.out + Number(u.cache_creation_input_tokens || 0) * TARIF_LOT.cw + Number(u.cache_read_input_tokens || 0) * TARIF_LOT.cr) / 1e6 + Number(u.server_tool_use?.web_search_requests || 0) * TARIF_LOT.web;
  return Math.round(usd * 0.92 * 1e4) / 1e4;
}
// deno-lint-ignore no-explicit-any
async function terminer(row: any, msg: any) {
  const now = new Date().toISOString();
  const dir = !!row.meta?.direct;
  const cout = Math.round(((Number(row.cout_eur) || 0) + coutDe(msg.usage, dir)) * 1e4) / 1e4;
  try { const u = msg.usage || {}; await db.from("wl_couts").insert({ membre: row.lance_par || null, usage: estConv(row) ? "actu_premium" : "relecture", modele: String(msg.model || MODELE), tokens_in: Number(u.input_tokens || 0) + Number(u.cache_read_input_tokens || 0) + Number(u.cache_creation_input_tokens || 0), tokens_out: Number(u.output_tokens || 0), cout_eur: coutDe(u, dir) }); } catch (_) { /* facultatif */ }
  // deno-lint-ignore no-explicit-any
  const contenu: any[] = Array.isArray(msg.content) ? msg.content : [];
  const nomOutil = estConv(row) ? "rendre_conversion" : "rendre_relecture";
  const outil = contenu.find((c) => c.type === "tool_use" && c.name === nomOutil);
  const suite = row.suite && Array.isArray(row.suite.messages) ? row.suite.messages : null;
  // tour interrompu (boucle d'outils serveur) ou réponse sans l'outil de rendu : on relance, 6 tours au plus
  if (!outil && (msg.stop_reason === "pause_turn" || msg.stop_reason === "end_turn") && row.tours < 6) {
    const base = suite || await messagesDepart(row);
    const messages = base.concat([{ role: "assistant", content: contenu }]).concat(msg.stop_reason === "end_turn" ? [{ role: "user", content: "Rends maintenant le résultat complet avec l’outil « " + nomOutil + " » (un seul appel)." }] : []);
    const params = await paramsPour(row, messages);
    if (dir) {   // une fois passée en direct, la relecture y reste jusqu'au bout
      const bid = "direct:" + Date.now();
      await relais({ genre: "relecture", id: row.id, bid }, params);
      await db.from("wl_relectures").update({ batch_id: bid, tours: row.tours + 1, suite: { messages }, cout_eur: cout, updated_at: now }).eq("id", row.id);
      return "relancé (direct)";
    }
    const batch = await soumettre(row.id, row.tours + 1, params);
    await db.from("wl_relectures").update({ batch_id: batch, tours: row.tours + 1, suite: { messages }, cout_eur: cout, updated_at: now }).eq("id", row.id);
    return "relancé";
  }
  if (!outil) {
    await db.from("wl_relectures").update({ statut: "erreur", erreur: msg.stop_reason === "max_tokens" ? "réponse trop longue (max_tokens) : relancez la relecture" : "le Correcteur n’a pas rendu de résultat (" + msg.stop_reason + ")", cout_eur: cout, suite: null, updated_at: now }).eq("id", row.id);
    return "erreur";
  }
  if (estConv(row)) return await terminerConversion(row, outil.input || {}, contenu, msg, cout, now);
  // deno-lint-ignore no-explicit-any
  const o: any = outil.input || {}, m = row.meta || {};
  const n = normaliserCorrections(o, row.blocs || []);
  const champ = (v: unknown, avant: string, max: number) => { const x = court(v && typeof v === "object" ? (v as { nouveau?: string }).nouveau : "", max); return x && x !== avant ? { avant, nouveau: x, raison: court((v as { raison?: string }).raison, 400) } : null; };
  // deno-lint-ignore no-explicit-any
  const liste = (v: any, n2: number, max: number) => (Array.isArray(v) ? v : []).map((x) => court(x, max)).filter(Boolean).slice(0, n2);
  const nbFetch = contenu.filter((c) => c.type === "server_tool_use" && c.name === "web_fetch").length;
  const resultat = {
    resume: court(o.resume, 800), type_article: o.type_article === "premium" ? "premium" : "actu",
    titre: champ(o.titre, m.titre || "", 200), titres_autres: liste(o.titre && o.titre.autres, 3, 200), titre_raison: court(o.titre && o.titre.raison, 400),
    extrait: champ(o.extrait, m.extrait || "", 300), meta_title: champ(o.meta_title, m.meta_title || "", 300), meta_description: champ(o.meta_description, m.meta_description || "", 300),
    corrections: n.corrections, insertions: n.insertions, rejets: n.rejets,
    // deno-lint-ignore no-explicit-any
    sources_audit: (Array.isArray(o.sources_audit) ? o.sources_audit : []).slice(0, 40).map((x: any) => ({ n: Number(x?.n) || 0, url: court(x?.url, 600), verdict: court(x?.verdict, 20), note: court(x?.note, 700) })),
    // deno-lint-ignore no-explicit-any
    graphiques: (Array.isArray(o.graphiques) ? o.graphiques : []).slice(0, 12).map((x: any) => ({ bloc: Number(x?.bloc), verdict: court(x?.verdict, 20), note: court(x?.note, 700), a_refaire: x?.a_refaire === true, src: ((row.blocs || []).find((b: Bloc) => b.i === Number(x?.bloc)) || {}).src || "", refaire: specGraphique(x?.refaire) })),
    suggestions: liste(o.suggestions, 12, 600), a_verifier: liste(o.a_verifier, 12, 600), preservation: court(o.preservation, 1200),
    stats: { tours: row.tours + 1, recherches: Number(msg.usage?.server_tool_use?.web_search_requests || 0), pages: nbFetch },
  };
  await db.from("wl_relectures").update({ statut: "prete", resultat, cout_eur: cout, suite: null, erreur: null, updated_at: now }).eq("id", row.id);
  // vraie faute → graphique refait tout de suite (jamais bloquant pour la relecture)
  for (let k = 0; k < resultat.graphiques.length; k++) { const g = resultat.graphiques[k]; if (g.a_refaire && g.refaire && g.src) { try { await lancerGraphique(row.id, k); } catch (_) { /* le bouton reste disponible */ } } }
  const nb = n.corrections.length + n.insertions.length + (resultat.titre ? 1 : 0) + (resultat.extrait ? 1 : 0);
  const fautes = resultat.graphiques.filter((g: { a_refaire: boolean }) => g.a_refaire).length;
  if (!row.meta?.essai) await pushChefs("🖍️ Relecture prête", "« " + court(row.titre, 90) + " » : " + nb + " correction" + (nb > 1 ? "s" : "") + " à valider" + (fautes ? " · " + fautes + " graphique" + (fautes > 1 ? "s" : "") + " à refaire" : "") + ".");
  return "prête";
}
async function suivreLots() {
  const { data } = await db.from("wl_relectures").select("*").eq("statut", "en_cours").order("created_at").limit(10);
  const res: string[] = [];
  for (const row of data || []) {
    try {
      if (!row.batch_id) { if (Date.now() - Date.parse(row.created_at) > 10 * 60e3) await db.from("wl_relectures").update({ statut: "erreur", erreur: "envoi au Correcteur interrompu" }).eq("id", row.id); continue; }
      const depuis = Date.now() - Date.parse(row.updated_at || row.created_at);   // updated_at = heure du dernier envoi (lot ou relais)
      if (String(row.batch_id).startsWith("direct:")) {
        if (depuis > DIRECT_MAX_MS) await db.from("wl_relectures").update({ statut: "erreur", erreur: "relecture directe sans réponse depuis 20 min : relancez-la", updated_at: new Date().toISOString() }).eq("id", row.id).eq("batch_id", row.batch_id);
        else res.push(row.id + " : direct depuis " + Math.round(depuis / 60e3) + " min");
        continue;
      }
      const r = await anthropic("messages/batches/" + row.batch_id); const b = await r.json().catch(() => ({}));
      if (!r.ok) { res.push(row.id + " : lot illisible " + r.status); continue; }
      if (b.processing_status !== "ended") {
        // Lot trop lent (aucun délai garanti par Anthropic) : passé ATTENTE_LOT_MS, ce tour et les suivants partent en direct par le relais.
        if (depuis > ATTENTE_LOT_MS) {
          const messages = row.suite && Array.isArray(row.suite.messages) ? row.suite.messages : await messagesDepart(row);
          const bid = "direct:" + Date.now();
          await relais({ genre: "relecture", id: row.id, bid }, await paramsPour(row, messages));
          await db.from("wl_relectures").update({ batch_id: bid, meta: { ...(row.meta || {}), direct: true, lot_abandonne: row.batch_id }, updated_at: new Date().toISOString() }).eq("id", row.id);
          anthropic("messages/batches/" + row.batch_id + "/cancel", { method: "POST" }).catch(() => null);
          res.push(row.id + " : lot en file depuis " + Math.round(depuis / 60e3) + " min, passé en direct");
        } else res.push(row.id + " : lot " + b.processing_status + " depuis " + Math.round(depuis / 60e3) + " min");
        continue;
      }
      const rr = await anthropic("messages/batches/" + row.batch_id + "/results");
      const lignes = (await rr.text()).split("\n").filter((x) => x.trim());
      // deno-lint-ignore no-explicit-any
      let item: any = null; for (const l of lignes) { try { const o = JSON.parse(l); if (String(o.custom_id || "").startsWith("rl-" + row.id + "-")) item = o; } catch (_) { /* ligne suivante */ } }
      if (!item || item.result?.type !== "succeeded") {
        const why = item ? (item.result?.type === "errored" ? court(item.result?.error?.error?.message || item.result?.error?.message || "erreur", 300) : item.result?.type) : "résultat absent";
        await db.from("wl_relectures").update({ statut: "erreur", erreur: "Correcteur : " + why, updated_at: new Date().toISOString() }).eq("id", row.id);
        res.push(row.id + " : erreur"); continue;
      }
      res.push(row.id + " : " + await terminer(row, item.result.message));
    } catch (e) { res.push(row.id + " : " + court((e as Error).message, 200)); }
  }
  return res;
}
// Relecture automatique : les jours réglés, dans les 4 heures qui suivent l'heure réglée, chaque brouillon créé le jour même
// (hors vidéos et posts « e-mail seulement ») qui n'a pas encore de relecture aujourd'hui.
async function relectureAuto() {
  const a = await lireAuto(); if (!a.actif) return "désactivée";
  const z = zurich(), [hh, mm] = a.heure.split(":").map(Number), debut = hh * 60 + mm;
  if (!a.jours.includes(z.jour) || z.min < debut || z.min > debut + 240) return "hors créneau";
  const minuit = minuitZurich();
  const r = await ghost(`posts/?filter=${encodeURIComponent(`status:draft+created_at:>'${minuit.slice(0, 19).replace("T", " ")}'`)}&limit=20&fields=id,title,email_only&include=tags`);
  // deno-lint-ignore no-explicit-any
  const posts = (r.posts || []).filter((p: any) => !p.email_only && !(p.tags || []).some((t: any) => ["videos", "hash-version-longue"].includes(String(t.slug))));
  if (!posts.length) return "aucun brouillon du jour";
  const { data: deja0 } = await db.from("wl_relectures").select("post_id,meta").gte("created_at", minuit).in("post_id", posts.map((p: { id: string }) => p.id));
  const deja = (deja0 || []).filter((r: { meta?: { mode?: string } }) => r.meta?.mode !== "actu_premium");
  const faits = new Set((deja || []).map((x: { post_id: string }) => x.post_id));
  const lances: string[] = [];
  for (const p of posts) { if (faits.has(p.id)) continue; try { await lancer(p.id, "auto", true); lances.push(court(p.title, 60)); } catch (e) { lances.push(court(p.title, 40) + " : " + court((e as Error).message, 120)); } }
  return lances.length ? "lancées : " + lances.join(" ; ") : "déjà relus";
}

// ---------- Graphiques refaits ----------
// deno-lint-ignore no-explicit-any
function specGraphique(r: any) {
  if (!r || typeof r !== "object") return null;
  // deno-lint-ignore no-explicit-any
  const series = (Array.isArray(r.series) ? r.series : []).slice(0, 6).map((s: any) => ({ nom: court(s?.nom, 80), points: (Array.isArray(s?.points) ? s.points : []).slice(0, 24).map((p: any) => ({ label: court(p?.label, 60), valeur: Number(p?.valeur) })).filter((p: { label: string; valeur: number }) => p.label && Number.isFinite(p.valeur)) })).filter((s: { points: unknown[] }) => s.points.length);
  const nb = series.reduce((a: number, s: { points: unknown[] }) => a + s.points.length, 0);
  if (nb < 2) return null; // un graphique est une relation : au moins deux valeurs
  return { titre: court(r.titre, 160), type: ["barres", "barres_horizontales", "barres_groupees", "courbe"].includes(String(r.type)) ? String(r.type) : "barres", unite: court(r.unite, 40), series, source: court(r.source, 400), legende: court(r.legende, 500), changement: court(r.changement, 400) };
}
const slugDe = (t: string) => String(t || "graphique").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "graphique";
// deno-lint-ignore no-explicit-any
async function majGraphe(id: number, k: number, patch: Record<string, unknown>): Promise<any[]> {
  const { data } = await db.from("wl_relectures").select("graphes").eq("id", id).limit(1);
  // deno-lint-ignore no-explicit-any
  const l: any[] = Array.isArray(data?.[0]?.graphes) ? data![0].graphes : [];
  const i = l.findIndex((g) => g.k === k);
  const g = { ...(i >= 0 ? l[i] : { k }), ...patch, maj: new Date().toISOString() };
  if (i >= 0) l[i] = g; else l.push(g);
  await db.from("wl_relectures").update({ graphes: l, updated_at: new Date().toISOString() }).eq("id", id);
  return l;
}
async function lancerGraphique(id: number, k: number) {
  const { data } = await db.from("wl_relectures").select("id,titre,statut,resultat,graphes").eq("id", id).limit(1);
  const row = data && data[0]; if (!row) throw new Error("relecture introuvable");
  const g = (row.resultat?.graphiques || [])[k];
  if (!g || !g.src) throw new Error("graphique introuvable");
  if (!g.refaire) throw new Error("le Correcteur n’a pas fourni de données corrigées pour ce graphique : relancez la relecture");
  const deja = (row.graphes || []).find((x: { k: number; statut: string }) => x.k === k);
  if (deja && ["en_cours", "pret"].includes(deja.statut)) return { ok: true, deja: deja.statut };
  const nom = "chart-" + slugDe(row.titre) + "-" + (k + 1) + "-corrige.jpg";
  const params = await paramsGraphique(row, g, k, nom);
  // Appel DIRECT (24/10/2026) : en traitement par lot, un graphique a attendu 6 heures. Depuis le 27/10 il passe par le relais n8n
  // (une tâche de fond Supabase est coupée à 150 s) ; le tic la déclare en erreur si elle n'a pas abouti au bout de 20 minutes.
  await majGraphe(id, k, { statut: "en_cours", batch_id: null, nom, src_avant: g.src, legende: g.refaire.legende || "", alt: g.refaire.titre || "", erreur: null, lance: new Date().toISOString() });
  try { await relais({ genre: "graphique", id, k, nom, tour: 0 }, params, BETAS_GRAPHIQUE); }
  catch (e) { await majGraphe(id, k, { statut: "erreur", erreur: court((e as Error).message, 200) }); }
  return { ok: true };
}
// Requête de refonte d'un graphique (reconstruite à l'identique pour chaque tour repris par le relais).
// deno-lint-ignore no-explicit-any
async function paramsGraphique(row: any, g: any, k: number, nom: string): Promise<any> {
  const img = await imageB64(g.src);
  // deno-lint-ignore no-explicit-any
  const contenu: any[] = [{ type: "text", text: [
    "Refais un graphique d'article Posthumain (« " + court(row.titre, 160) + " ») avec le skill generate-charts : lis son SKILL.md et ses références, et applique sa charte (palette Posthumain, accents français corrects, lisible sur téléphone, largeur normale).",
    "Données à tracer, déjà vérifiées et sourcées par le Correcteur : n'en change aucune valeur, n'en ajoute aucune.\n" + JSON.stringify(g.refaire, null, 1),
    "Problème du graphique d'origine : " + (g.note || "(non précisé)") + (g.refaire.changement ? "\nCe qui doit changer : " + g.refaire.changement : ""),
    img ? "Le graphique d'origine est joint : garde son propos et son style, corrige seulement ce qui est faux." : "",
    "Rends UN SEUL fichier image JPEG nommé " + nom + " (rien d'autre), puis réponds en une phrase.",
  ].filter(Boolean).join("\n\n") }];
  if (img) contenu.push({ type: "image", source: { type: "base64", ...img } });
  const params = { model: MODELE, max_tokens: 16000, thinking: { type: "adaptive" }, output_config: { effort: "medium" }, container: { skills: [{ type: "custom", skill_id: SKILL_GRAPHIQUES, version: "latest" }] },
    tools: [{ type: "code_execution_20250825", name: "code_execution" }], messages: [{ role: "user", content: contenu }] };
  return params;
}
// deno-lint-ignore no-explicit-any
async function recevoirGraphique(row: any, k: number, nom: string, msg: any) {
  const ids = fichiers(msg?.content);
  if (!ids.length) { await majGraphe(row.id, k, { statut: "erreur", erreur: "aucune image produite (" + (msg?.stop_reason || "?") + ")" }); return "erreur"; }
  const fid = ids[ids.length - 1];
  const fr = await anthropic("files/" + fid + "/content", {}, BETAS_GRAPHIQUE);
  if (!fr.ok) { await majGraphe(row.id, k, { statut: "erreur", erreur: "image illisible (" + fr.status + ")" }); return "erreur"; }
  const bytes = new Uint8Array(await fr.arrayBuffer());
  const dim = dimensionsImage(bytes);
  if (!dim) { await majGraphe(row.id, k, { statut: "erreur", erreur: "le fichier produit n’est pas une image JPEG ou PNG" }); return "erreur"; }
  const png = bytes[0] === 0x89;
  const src = await ghostTeleverser(bytes, png ? String(nom).replace(/\.jpg$/, ".png") : nom, png ? "image/png" : "image/jpeg");
  await majGraphe(row.id, k, { statut: "pret", src, largeur: dim.largeur, hauteur: dim.hauteur, erreur: null });
  anthropic("files/" + fid, { method: "DELETE" }, BETAS_GRAPHIQUE).catch(() => null);
  const { data } = await db.from("wl_relectures").select("meta").eq("id", row.id).limit(1);
  if (!data?.[0]?.meta?.essai) await pushChefs("🎨 Graphique refait", "« " + court(row.titre, 90) + " » : le graphique corrigé est prêt à valider.");
  return "prêt";
}
// deno-lint-ignore no-explicit-any
function fichiers(o: any, out: string[] = []): string[] { if (!o || typeof o !== "object") return out; if (typeof o.file_id === "string") out.push(o.file_id); for (const v of Array.isArray(o) ? o : Object.values(o)) fichiers(v, out); return out; }
async function ghostTeleverser(bytes: Uint8Array, nom: string, mime: string): Promise<string> {
  const fd = new FormData(); fd.append("file", new Blob([bytes], { type: mime }), nom); fd.append("purpose", "image"); fd.append("ref", nom);
  const r = await fetch(ghostUrl() + "/ghost/api/admin/images/upload/", { method: "POST", signal: AbortSignal.timeout(30000), headers: { Authorization: "Ghost " + (await ghostToken()), "Accept-Version": "v5.0" }, body: fd });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.images?.[0]?.url) throw new Error("téléversement Ghost refusé (" + r.status + ")");
  return String(j.images[0].url);
}
// Refontes en cours : appel direct (pas de batch_id) déclaré en erreur après 15 minutes ; anciens lots encore suivis jusqu'à leur fin.
async function suivreGraphiques() {
  const { data, error } = await db.from("wl_relectures").select("id,titre,graphes,lance_par,meta").neq("graphes", "[]").order("updated_at", { ascending: false }).limit(30);
  const res: string[] = error ? ["graphiques illisibles : " + court(error.message, 160)] : [];
  for (const row of data || []) for (const g of (row.graphes || []).filter((x: { statut: string }) => x.statut === "en_cours")) {
    try {
      if (!g.batch_id) {
        if (Date.now() - Date.parse(g.lance || g.maj) > DIRECT_MAX_MS) { await majGraphe(row.id, g.k, { statut: "erreur", erreur: "refonte interrompue : relancez-la" }); res.push("g" + row.id + "." + g.k + " : interrompue"); }
        continue;
      }
      const r = await anthropic("messages/batches/" + g.batch_id, {}, BETAS_GRAPHIQUE); const b = await r.json().catch(() => ({}));
      if (!r.ok) { res.push("g" + row.id + "." + g.k + " : lot illisible " + r.status); continue; }
      if (b.processing_status !== "ended") { res.push("g" + row.id + "." + g.k + " : lot " + b.processing_status); if (Date.now() - Date.parse(g.lance || g.maj) > 26 * 3600e3) await majGraphe(row.id, g.k, { statut: "erreur", erreur: "refonte expirée" }); continue; }
      const t = await (await anthropic("messages/batches/" + g.batch_id + "/results", {}, BETAS_GRAPHIQUE)).text();
      // deno-lint-ignore no-explicit-any
      let item: any = null; for (const l of t.split("\n").filter((x) => x.trim())) { try { const o = JSON.parse(l); if (o.custom_id === "gr-" + row.id + "-" + g.k) item = o; } catch (_) { /* ligne suivante */ } }
      if (!item || item.result?.type !== "succeeded") { await majGraphe(row.id, g.k, { statut: "erreur", erreur: "refonte : " + court(item?.result?.error?.error?.message || item?.result?.type || "résultat absent", 200) }); continue; }
      res.push("g" + row.id + "." + g.k + " : " + await recevoirGraphique(row, g.k, g.nom, item.result.message));
    } catch (e) { res.push("g" + row.id + "." + g.k + " : " + court((e as Error).message, 160)); }
  }
  return res;
}
// Applique dans le Lexical les graphiques refaits choisis (statut « pret ») ; renvoie les k appliqués.
// deno-lint-ignore no-explicit-any
function graphiquesDans(lex: any, graphes: any[], ks: number[]): number[] {
  const faits: number[] = [];
  for (const g of graphes || []) if (g.statut === "pret" && ks.includes(g.k) && remplacerImage(lex, g.src_avant, { src: g.src, largeur: g.largeur, hauteur: g.hauteur, legende: g.legende, alt: g.alt })) faits.push(g.k);
  return faits;
}

// ---------- Valider : appliquer dans Ghost ----------
// deno-lint-ignore no-explicit-any
async function valider(b: any, me: Membre) {
  const { data } = await db.from("wl_relectures").select("*").eq("id", Number(b.id)).limit(1);
  const row = data && data[0];
  if (!row) throw new Error("relecture introuvable");
  if (row.statut !== "prete") throw new Error(row.statut === "validee" ? "déjà validée" : "cette relecture n’est pas prête (" + row.statut + ")");
  if (estConv(row)) return await validerConversion(row, b, me);
  const R = row.resultat || {};
  const tout = b.tout === true;
  const cIdx: number[] = tout ? (R.corrections || []).map((_: unknown, k: number) => k) : (Array.isArray(b.corrections) ? b.corrections : []).map(Number).filter((k: number) => R.corrections && R.corrections[k]);
  const iIdx: number[] = tout ? (R.insertions || []).map((_: unknown, k: number) => k) : (Array.isArray(b.insertions) ? b.insertions : []).map(Number).filter((k: number) => R.insertions && R.insertions[k]);
  const corrections = cIdx.map((k) => R.corrections[k]), insertions = iIdx.map((k) => R.insertions[k]);
  for (let essai = 0; essai < 2; essai++) {
    const p = await lirePost(row.post_id);
    // article publié : les corrections validées partent en ligne (statut inchangé)
    // deno-lint-ignore no-explicit-any
    const maj: any = { updated_at: p.updated_at };
    let res = { appliquees: [] as number[], inserees: [] as number[], conflits: [] as { ref: string; raison: string }[] };
    const gKs: number[] = tout ? (row.graphes || []).filter((g: { statut: string }) => g.statut === "pret").map((g: { k: number }) => g.k) : (Array.isArray(b.graphiques) ? b.graphiques : []).map(Number);
    let lex = null, gFaits: number[] = [];
    if (corrections.length || insertions.length) { const a = appliquer(p.lexical, row.blocs || [], corrections, insertions); lex = a.lexical; res = a; }
    if (gKs.length) { lex = lex || JSON.parse(p.lexical); gFaits = graphiquesDans(lex, row.graphes || [], gKs); }
    if (lex) maj.lexical = JSON.stringify(lex);
    const titre = typeof b.titre === "string" ? court(b.titre, 255) : (tout && R.titre ? R.titre.nouveau : "");
    if (titre && titre !== p.title) maj.title = titre;
    if ((tout || b.extrait) && R.extrait) maj.custom_excerpt = court(R.extrait.nouveau, 300);
    if ((tout || b.meta_title) && R.meta_title) maj.meta_title = court(R.meta_title.nouveau, 300);
    if ((tout || b.meta_description) && R.meta_description) maj.meta_description = court(R.meta_description.nouveau, 500);
    if (Object.keys(maj).length === 1) throw new Error("aucune correction choisie");
    try {
      await ghost(`posts/${p.id}/`, "PUT", { posts: [maj] });
    } catch (e) { if ((e as { statut?: number }).statut === 409 && essai === 0) continue; throw e; }
    const appliquees = { corrections: res.appliquees.map((k) => cIdx[k]), insertions: res.inserees.map((k) => iIdx[k]), conflits: res.conflits.map((c) => ({ ...c, ref: (c.ref[0] === "c" ? "c" + cIdx[Number(c.ref.slice(1))] : "i" + iIdx[Number(c.ref.slice(1))]) })),
      titre: maj.title || null, extrait: !!maj.custom_excerpt, meta_title: !!maj.meta_title, meta_description: !!maj.meta_description, graphiques: gFaits };
    if (gFaits.length) await db.from("wl_relectures").update({ graphes: (row.graphes || []).map((g: { k: number }) => (gFaits.includes(g.k) ? { ...g, statut: "applique" } : g)) }).eq("id", row.id);
    await db.from("wl_relectures").update({ statut: "validee", appliquees, validee_le: new Date().toISOString(), validee_par: me.id, updated_at: new Date().toISOString() }).eq("id", row.id);
    return { ok: true, id: row.id, appliquees };
  }
  throw new Error("Ghost a refusé l’enregistrement (article modifié au même moment) : réessayez");
}

// ---------- Liste pour la page ----------
// deno-lint-ignore no-explicit-any
function resumeLigne(r: any) {
  const R = r.resultat || {};
  return { id: r.id, post_id: r.post_id, titre: r.titre, mode: r.meta?.mode || "relecture", statut: r.statut, auto: r.auto, erreur: r.erreur, cree: r.created_at, maj: r.updated_at, validee_le: r.validee_le, cout_eur: r.cout_eur,
    image: r.meta?.image || "", editeur: r.meta?.editeur || "", apercu: r.meta?.apercu || "", visibilite: r.meta?.visibilite || "",
    nb: (R.corrections || []).length + (R.insertions || []).length + (R.titre ? 1 : 0) + (R.extrait ? 1 : 0) + (R.meta_title ? 1 : 0) + (R.meta_description ? 1 : 0),
    graphiques_a_refaire: (R.graphiques || []).filter((g: { a_refaire: boolean }) => g.a_refaire).length, resume: R.resume || "", appliquees: r.appliquees || null,
    graphes: (r.graphes || []).map((g: { k: number; statut: string }) => ({ k: g.k, statut: g.statut })) };
}

Deno.serve(async (req) => {
  const h = { ...cors(req), "Content-Type": "application/json", "Cache-Control": "no-store" };
  if (req.method === "OPTIONS") return new Response(null, { headers: h });
  const out = (v: unknown, s = 200) => new Response(JSON.stringify(v), { status: s, headers: h });
  if (req.method !== "POST") return out({ ok: false, why: "method" }, 405);
  // deno-lint-ignore no-explicit-any
  let b: any; try { b = await req.json(); } catch { return out({ ok: false, why: "bad_json" }, 400); }
  try {
    // pg_cron : suivi des lots + relecture automatique ; diagnostics (secret du réglage relecture_cron_secret)
    if (["tic", "diag_blocs", "diag_outils", "essai", "essai_conversion", "direct_resultat"].includes(b.action)) {
      const s = await reglage("relecture_cron_secret");
      if (!s || String(b.secret || "") !== s) return out({ ok: false, why: "unauthorized" }, 401);
      if (b.action === "direct_resultat") return out(await recevoirDirect(b));
      if (b.action === "tic") { const lots = (await suivreLots()).concat(await suivreGraphiques()); let auto = ""; try { auto = await relectureAuto(); } catch (e) { auto = "erreur : " + court((e as Error).message, 200); } return out({ ok: true, lots, auto }); }
      // essai de bout en bout sur un article (même publié) : lecture seule, sans notification ; « valider » refuse un article publié
      if (b.action === "essai") return out(await lancer(String(b.post_id || ""), "essai", false, true));
      if (b.action === "essai_conversion") return out(await lancerConversion(String(b.post_id || ""), "essai", true));
      if (b.action === "diag_blocs") { const p = await lirePost(String(b.post_id || "")); const bl = extraireBlocs(p.lexical); return out({ ok: true, titre: p.title, visibilite: p.visibility, n: bl.length, types: bl.map((x) => x.t + (x.genre ? ":" + x.genre : "")), texte: bl.map(blocPourIA).join("\n").slice(0, 20000), noeuds: JSON.parse(p.lexical).root.children.map((n: { type: string }) => n.type) }); }
      // vérifie que le modèle et les outils serveur sont acceptés (petite requête, Haiku)
      const r = await anthropic("messages", { method: "POST", body: JSON.stringify({ model: "claude-haiku-5-5", max_tokens: 50, tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 1 }, { type: "web_fetch_20250910", name: "web_fetch", max_uses: 1, max_content_tokens: 1000 }, OUTIL], messages: [{ role: "user", content: "Réponds seulement OK, sans outil." }] }) });
      const j = await r.json().catch(() => ({}));
      const r2 = await anthropic("messages/count_tokens", { method: "POST", body: JSON.stringify({ model: MODELE, thinking: { type: "adaptive" }, messages: [{ role: "user", content: "x" }] }) });
      return out({ ok: r.ok, statut: r.status, reponse: court(JSON.stringify(j).slice(0, 400), 400), opus: r2.status, opus_reponse: court(await r2.text(), 300) });
    }
    // GitHub Action du dépôt du skill (claude-posthumain-article-corrector) : à chaque fusion sur main, recopie SKILL.md et
    // references/revision-guide.md ici (secret relecture_skill_secret de wl_reglages = secret GitHub WRITINGLAB_SKILL_SECRET).
    // GitHub reste la seule source du skill : on ne modifie jamais ces réglages à la main.
    if (b.action === "skill_maj") {
      const s = await reglage("relecture_skill_secret");
      if (!s || String(b.secret || "") !== s) return out({ ok: false, why: "unauthorized" }, 401);
      const skill = String(b.skill || ""), guide = String(b.guide || "");
      if (skill.length < 2000 || guide.length < 2000 || !/^---\s*\nname:\s*revise-article/m.test(skill)) return out({ ok: false, why: "skill incomplet : rien n’a été remplacé" }, 400);
      await ecrireReglage("relecture_skill", skill.slice(0, 200000));
      await ecrireReglage("relecture_guide", guide.slice(0, 400000));
      await ecrireReglage("relecture_skill_version", court(b.version || "", 200));
      return out({ ok: true, skill: skill.length, guide: guide.length, version: court(b.version || "", 200) });
    }
    const me = await membre(String(b.token || "")).catch(() => null);
    if (!me) return out({ ok: false, why: "accès réservé à l’équipe" }, 401);
    if (!me.chef) return out({ ok: false, why: "réservé au rédacteur en chef" }, 403);
    if (b.action === "liste") {
      const { data } = await db.from("wl_relectures").select("id,post_id,titre,statut,auto,erreur,created_at,updated_at,validee_le,cout_eur,meta,resultat,appliquees,graphes").order("created_at", { ascending: false }).limit(40);
      return out({ ok: true, relectures: (data || []).map(resumeLigne), auto: await lireAuto(), skill: await reglage("relecture_skill_version") });
    }
    if (b.action === "detail") {
      const { data } = await db.from("wl_relectures").select("id,post_id,titre,statut,auto,erreur,created_at,validee_le,cout_eur,meta,blocs,resultat,appliquees,graphes").eq("id", Number(b.id)).limit(1);
      if (!data || !data[0]) return out({ ok: false, why: "relecture introuvable" }, 404);
      return out({ ok: true, relecture: data[0] });
    }
    if (b.action === "lancer") return out(await lancer(String(b.post_id || ""), me.id));
    if (b.action === "convertir") return out(await lancerConversion(String(b.post_id || ""), me.id));
    if (b.action === "valider") return out(await valider(b, me));
    if (b.action === "refaire_graphique") return out(await lancerGraphique(Number(b.id), Number(b.k)));
    // graphique refait poussé seul (la relecture a déjà été validée, ou l'on ne veut que lui)
    if (b.action === "appliquer_graphique") {
      const { data } = await db.from("wl_relectures").select("id,post_id,graphes").eq("id", Number(b.id)).limit(1);
      const row = data && data[0]; if (!row) return out({ ok: false, why: "relecture introuvable" }, 404);
      const k = Number(b.k), g = (row.graphes || []).find((x: { k: number }) => x.k === k);
      if (!g || g.statut !== "pret") return out({ ok: false, why: "ce graphique refait n’est pas prêt" });
      for (let essai = 0; essai < 2; essai++) {
        const p = await lirePost(row.post_id);
        const lex = JSON.parse(p.lexical);
        if (!graphiquesDans(lex, row.graphes, [k]).length) return out({ ok: false, why: "le graphique d’origine n’est plus dans l’article (déjà remplacé ou supprimé)" });
        try { await ghost(`posts/${p.id}/`, "PUT", { posts: [{ lexical: JSON.stringify(lex), updated_at: p.updated_at }] }); }
        catch (e) { if ((e as { statut?: number }).statut === 409 && essai === 0) continue; throw e; }
        await db.from("wl_relectures").update({ graphes: row.graphes.map((x: { k: number }) => (x.k === k ? { ...x, statut: "applique" } : x)) }).eq("id", row.id);
        return out({ ok: true });
      }
      return out({ ok: false, why: "Ghost a refusé l’enregistrement : réessayez" });
    }
    if (b.action === "ecarter") {
      const { error } = await db.from("wl_relectures").update({ statut: "ecartee", updated_at: new Date().toISOString() }).eq("id", Number(b.id)).in("statut", ["prete", "erreur", "en_cours"]);
      if (error) return out({ ok: false, why: error.message });
      return out({ ok: true });
    }
    if (b.action === "reglage") {
      const jours = (Array.isArray(b.jours) ? b.jours : []).map(Number).filter((x: number) => Number.isInteger(x) && x >= 0 && x <= 6);
      const heure = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(b.heure)) ? String(b.heure) : "13:00";
      const v: Auto = { actif: b.actif === true, jours: [...new Set(jours)].sort() as number[], heure };
      await ecrireReglage("relecture_auto", JSON.stringify(v));
      return out({ ok: true, auto: v });
    }
    return out({ ok: false, why: "action inconnue" }, 400);
  } catch (e) {
    return out({ ok: false, why: court((e as Error)?.message || e, 300) });
  }
});
