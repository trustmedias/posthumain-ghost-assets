#!/usr/bin/env node
// Writinglab — catalogue unique des postes et capacités (shared/wl-catalogue.json).
//   node scripts/wl-catalogue.mjs --ecrire   recopie le catalogue dans writinglab/app.js (entre les marqueurs) et dans
//                                            supabase/functions/wl-tel/catalogue.ts (module importé au déploiement)
//   node scripts/wl-catalogue.mjs            vérifie tout ; code de sortie 1 au moindre oubli (utilisé par la GitHub Action)
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const R = join(dirname(fileURLToPath(import.meta.url)), "..");
const F = {
  cat: join(R, "shared/wl-catalogue.json"),
  app: join(R, "writinglab/app.js"),
  tel: join(R, "supabase/functions/wl-tel/index.ts"),
  telCat: join(R, "supabase/functions/wl-tel/catalogue.ts"),
};
const lire = (f) => readFileSync(f, "utf8");
const cat = JSON.parse(lire(F.cat));
const compact = JSON.stringify(cat);
const MARQ = /\/\*CATALOGUE-DEBUT\*\/[\s\S]*?\/\*CATALOGUE-FIN\*\//;
const moduleTel = "// GÉNÉRÉ par scripts/wl-catalogue.mjs depuis shared/wl-catalogue.json : ne pas modifier à la main.\n" +
  "// deno-lint-ignore-file\nexport const CATALOGUE: any = " + JSON.stringify(cat) + ";\n";

if (process.argv.includes("--ecrire")) {
  const app = lire(F.app);
  if (!MARQ.test(app)) { console.error("Marqueurs /*CATALOGUE-DEBUT*/ … /*CATALOGUE-FIN*/ introuvables dans writinglab/app.js"); process.exit(1); }
  writeFileSync(F.app, app.replace(MARQ, () => "/*CATALOGUE-DEBUT*/" + compact + "/*CATALOGUE-FIN*/"));
  writeFileSync(F.telCat, moduleTel);
  console.log("Catalogue recopié dans writinglab/app.js et supabase/functions/wl-tel/catalogue.ts. Lancez maintenant : node scripts/wl-catalogue.mjs");
  process.exit(0);
}

const err = [];
const ko = (m) => err.push(m);
const TYPES_PARAM = ["article", "fiche", "mail", "contact", "liste", "qr", "texte", "choix", "cible"];
const MODES = ["brouillon", "immediat", "clic"];
const DROITS = ["chef", "journaliste", "tous"];
const CONTEXTES = ["fiches", "courrier", "pieces"];

// --- postes ---
const postes = Array.isArray(cat.postes) ? cat.postes : (ko("« postes » doit être une liste"), []);
const caps = Array.isArray(cat.capacites) ? cat.capacites : (ko("« capacites » doit être une liste"), []);
const ids = new Set();
for (const p of postes) {
  const n = "poste « " + (p.id || "?") + " »";
  for (const k of ["id", "nom", "emoji", "couleur", "acces", "role", "aide", "aiguillage"]) if (!p[k] || typeof p[k] !== "string") ko(n + " : champ obligatoire « " + k + " » manquant" + (k === "aide" ? " (phrase pour les humains, affichée par le bouton ⓘ)" : k === "aiguillage" ? " (ce qu'on transmet à ce poste, pour l'aiguillage des autres IA)" : ""));
  if (!Array.isArray(p.exemples) || p.exemples.length < 2 || p.exemples.some((x) => typeof x !== "string" || !x.trim())) ko(n + " : « exemples » = au moins 2 phrases à dire au ☎️ (aide ⓘ)");
  if (p.id && !/^[a-z][a-z0-9_]{1,30}$/.test(p.id)) ko(n + " : id en minuscules sans espace (a-z, 0-9, _)");
  if (ids.has(p.id)) ko(n + " : id en double"); ids.add(p.id);
  if (p.acces && !["chef", "tous"].includes(p.acces)) ko(n + " : acces = « chef » ou « tous »");
  if (!Array.isArray(p.contexte)) ko(n + " : « contexte » doit être une liste (fiches, courrier, pieces), éventuellement vide");
  else for (const c of p.contexte) if (!CONTEXTES.includes(c)) ko(n + " : contexte inconnu « " + c + " »");
  if (!Array.isArray(p.capacites) || !p.capacites.length) ko(n + " : au moins une capacité");
  if (p.plan != null && (typeof p.plan.x !== "number" || typeof p.plan.y !== "number")) ko(n + " : plan = { x, y, teinte? } ou null");
  if (p.contexte && p.contexte.includes("courrier") && !(p.mail && p.mail.boite && p.mail.role)) ko(n + " : contexte « courrier » sans mail { boite, adresse, role }");
}
// --- capacités ---
const app = lire(F.app), tel = lire(F.tel);
const pageExec = (() => { const m = /var PAGE_EXEC = \{([\s\S]*?)\n  \};/.exec(app); return m ? [...m[1].matchAll(/^\s{4}([a-zA-Z_]+): function/gm)].map((x) => x[1]) : []; })();
const telActions = [...tel.matchAll(/b\.action === "([a-z_]+)"/g)].map((x) => x[1]);
const apiModes = [...new Set([...app.matchAll(/\bapi\('([a-z_]+)'/g)].map((x) => x[1]))];
const couverts = new Set();
const capIds = new Set();
for (const c of caps) {
  const n = "capacité « " + (c.id || "?") + " »";
  if (!c.id) ko(n + " : id manquant"); if (capIds.has(c.id)) ko(n + " : id en double"); capIds.add(c.id);
  if (!c.description) ko(n + " : description (pour l'IA) manquante");
  for (const k of ["nom", "aide", "fournir"]) if (!c[k] || typeof c[k] !== "string") ko(n + " : « " + k + " » manquant (aide ⓘ pour les humains" + (k === "fournir" ? " : ce qu'il faut fournir" : "") + ")");
  if (!Array.isArray(c.exemples) || c.exemples.length < 2 || c.exemples.some((x) => typeof x !== "string" || !x.trim())) ko(n + " : « exemples » = au moins 2 phrases à dire au ☎️ (aide ⓘ)");
  if (!Array.isArray(c.postes) || !c.postes.length) ko(n + " : « postes » (qui la porte) manquant");
  else for (const pid of c.postes) {
    const p = postes.find((x) => x.id === pid);
    if (!p) ko(n + " : poste inexistant « " + pid + " »");
    else if (!(p.capacites || []).includes(c.id)) ko(n + " : le poste « " + pid + " » ne la liste pas dans ses capacités");
  }
  if (!DROITS.includes(c.droits)) ko(n + " : droits = chef | journaliste | tous");
  if (!MODES.includes(c.mode)) ko(n + " : mode = brouillon | immediat | clic");
  if (!c.params || typeof c.params !== "object") ko(n + " : « params » (schéma) manquant");
  else for (const [k, d] of Object.entries(c.params)) {
    if (!d || !TYPES_PARAM.includes(d.type)) ko(n + " : paramètre « " + k + " » de type inconnu (" + (d && d.type) + ")");
    if (d && d.type === "choix" && !Array.isArray(d.valeurs)) ko(n + " : paramètre « " + k + " » (choix) sans « valeurs »");
  }
  const E = c.executeur || {};
  if (E.type === "api") { if (!apiModes.includes(E.mode)) ko(n + " : exécuteur api('" + E.mode + "') introuvable dans writinglab/app.js"); couverts.add(E.mode); }
  else if (E.type === "tel") { for (const k of ["action", "envoi", "ecarter", "lister"]) if ((k === "action" || E[k]) && !telActions.includes(E[k])) ko(n + " : exécuteur wl-tel (" + k + ") « " + E[k] + " » introuvable dans supabase/functions/wl-tel/index.ts"); }
  else if (E.type === "page") { if (!pageExec.includes(E.fonction)) ko(n + " : exécuteur de page « " + E.fonction + " » absent de PAGE_EXEC (writinglab/app.js)"); }
  else ko(n + " : exécuteur de type inconnu (api | tel | page)");
  for (const x of E.couvre || []) couverts.add(x);
  if (E.suite && !caps.find((x) => x.id === E.suite.capacite)) ko(n + " : « suite » vers une capacité inexistante « " + E.suite.capacite + " »");
  if (!c.carte || !c.carte.titre || !c.carte.bouton) ko(n + " : « carte » { titre, bouton } manquante (affichage au téléphone)");
}
for (const p of postes) for (const id of p.capacites || []) if (!capIds.has(id)) ko("poste « " + p.id + " » : capacité inexistante « " + id + " »");
// --- aiguillage : le poste qui écrit aux contacts d'interview existe et n'est pas un poste « courrier » ---
const ag = cat.aiguillage || {};
if (!ag.contacts_interview) ko("« aiguillage.contacts_interview » manquant (poste qui écrit aux contacts d'interview)");
else { const pc = postes.find((x) => x.id === ag.contacts_interview); if (!pc) ko("aiguillage.contacts_interview : poste inexistant « " + ag.contacts_interview + " »"); else if (pc.mail) ko("aiguillage.contacts_interview : « " + pc.id + " » est un poste de courrier"); }
// --- stations et bureaux humains du plan (aide ⓘ) ---
const STATIONS_PLAN = ["chef", "journaliste", "courrier", "marbre", "radar", "votes"];
const stations = Array.isArray(cat.stations) ? cat.stations : (ko("« stations » doit être une liste (bureaux humains et stations du plan, pour l'aide ⓘ)"), []);
for (const st of stations) {
  const n = "station « " + (st.id || "?") + " »";
  for (const k of ["id", "nom", "emoji", "aide"]) if (!st[k] || typeof st[k] !== "string") ko(n + " : champ obligatoire « " + k + " » manquant");
  if (!Array.isArray(st.actions) || !st.actions.length) ko(n + " : « actions » (ce que fait son panneau) manquantes");
  if (postes.some((p) => p.id === st.id)) ko(n + " : même id qu'un poste IA");
}
for (const id of STATIONS_PLAN) if (!stations.some((x) => x.id === id)) ko("station du plan « " + id + " » sans aide dans « stations »");
// --- visite guidée (onboarding) : ordre des bureaux (postes ou stations existants) et étapes de navigation complètes ---
const ob = cat.onboarding;
if (!ob || typeof ob !== "object") ko("« onboarding » (visite guidée des journalistes) manquant");
else {
  if (!ob.version || typeof ob.version !== "string") ko("onboarding : « version » manquante");
  for (const id of ob.ordre || []) if (!postes.some((p) => p.id === id) && !stations.some((x) => x.id === id)) ko("onboarding : « " + id + " » dans « ordre » n'est ni un poste ni une station");
  for (const n of ob.navigation || []) for (const k of ["id", "emoji", "titre", "texte", "cible"]) if (!n[k] || typeof n[k] !== "string") ko("onboarding : étape « " + (n.id || "?") + " » sans « " + k + " »");
}
// --- chaque action de la page est une capacité ou une exception déclarée ---
const interne = Object.keys(cat.interne || {}).filter((k) => !k.startsWith("_"));
for (const m of apiModes) if (!couverts.has(m) && !interne.includes(m)) ko("api('" + m + "') (writinglab/app.js) n'est ni l'exécuteur d'une capacité, ni dans « interne » avec sa raison");
for (const m of interne) if (!apiModes.includes(m)) ko("« interne » liste api('" + m + "') qui n'existe plus dans writinglab/app.js : retirez-le");
// --- chaque action de wl-tel est l'exécuteur d'une capacité ou une exception déclarée (interne_tel) ---
const execTel = new Set(); for (const c of caps) { const E = c.executeur || {}; if (E.type === "tel") for (const k of ["action", "envoi", "ecarter", "lister"]) if (E[k]) execTel.add(E[k]); }
const interneTel = Object.keys(cat.interne_tel || {}).filter((k) => !k.startsWith("_"));
for (const a of new Set(telActions)) if (!execTel.has(a) && !interneTel.includes(a)) ko("wl-tel : action « " + a + " » ni exécuteur d'une capacité, ni dans « interne_tel » avec sa raison");
for (const a of interneTel) if (!telActions.includes(a)) ko("« interne_tel » liste « " + a + " » qui n'existe plus dans wl-tel : retirez-le");
// --- aucun poste codé en dur côté serveur ---
if (/const POSTES: Record<string, Poste> = \{\s*\n\s*secretaire/.test(tel)) ko("wl-tel : POSTES encore codés en dur (doivent venir de catalogue.ts)");
// --- copies à jour ---
const m = MARQ.exec(app);
if (!m) ko("writinglab/app.js : marqueurs du catalogue introuvables");
else if (m[0] !== "/*CATALOGUE-DEBUT*/" + compact + "/*CATALOGUE-FIN*/") ko("writinglab/app.js : copie du catalogue périmée → node scripts/wl-catalogue.mjs --ecrire");
let telCat = ""; try { telCat = lire(F.telCat); } catch { /* absent */ }
if (telCat !== moduleTel) ko("supabase/functions/wl-tel/catalogue.ts : copie périmée ou absente → node scripts/wl-catalogue.mjs --ecrire (puis redéployer wl-tel)");

if (err.length) { console.error("✗ Catalogue du Writinglab : " + err.length + " problème(s)\n- " + err.join("\n- ")); process.exit(1); }
console.log("✓ Catalogue du Writinglab : " + postes.length + " postes, " + caps.length + " capacités, " + apiModes.length + " actions de la page vérifiées (" + interne.length + " internes), copies à jour.");
