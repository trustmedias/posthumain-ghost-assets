// Writinglab — wl-relecture : l'article Ghost (Lexical) découpé en BLOCS numérotés pour le Correcteur, puis les corrections validées
// réappliquées dans le Lexical (24/10/2026). Module pur (aucun accès réseau), testé hors ligne : deno test supabase/functions/wl-relecture/blocs_test.ts
//
// Principe de sécurité : seuls les blocs de TEXTE (paragraphes, intertitres, listes, citations) et la carte HTML de la liste des sources
// sont modifiables. Tout le reste (encarts d'abonnement kg-gated-block, cartes d'amorce premium data-ph-teaser-*, encart vidéo, images et
// graphiques, coupure paywall, cartes HTML diverses) est un bloc PROTÉGÉ : il n'est jamais réécrit, son nœud Lexical repart tel quel
// (visibilité web/email comprise). On n'envoie jamais de HTML à Ghost : uniquement le Lexical, modifié bloc par bloc.
// Mise en forme dans le texte : **gras**, *italique*, [texte](https://lien), \[ \] pour des crochets littéraux, retour à la ligne = saut.
// deno-lint-ignore-file no-explicit-any
type Any = any;

export type Bloc = { i: number; t: string; md?: string; items?: string[]; html?: string; genre?: string; resume?: string; src?: string; legende?: string };

export const court = (s: unknown, n: number) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };
export const escMd = (s: string) => s.replace(/([\\*\[\]])/g, "\\$1");
const TEXTES = ["extended-text", "text"];

// Liens : on garde leurs attributs (rel, target, title) par URL pour les restituer à la reconstruction.
export function inlineVersMd(nodes: Any[], liens?: Record<string, Any>): string {
  let out = "";
  for (const n of nodes || []) {
    if (TEXTES.includes(n.type)) {
      const f = Number(n.format || 0);
      if (f & ~3) throw new Error("format"); // souligné, barré, code, exposant… : bloc protégé
      const t = String(n.text || ""), m = t.match(/^(\s*)([\s\S]*?)(\s*)$/)!;
      if (!m[2]) { out += escMd(t); continue; }
      const mk = f === 3 ? "***" : f === 1 ? "**" : f === 2 ? "*" : "";
      out += m[1] + mk + escMd(m[2]) + mk + m[3];
    } else if (n.type === "link" || n.type === "autolink") {
      const url = String(n.url || "");
      if (!url || /[()\s]/.test(url)) throw new Error("lien");
      if (liens) liens[url] = { rel: n.rel ?? null, target: n.target ?? null, title: n.title ?? null };
      out += "[" + inlineVersMd(n.children || [], liens) + "](" + url + ")";
    } else if (n.type === "linebreak") out += "\n";
    else throw new Error("noeud");
  }
  return out;
}
const texte = (t: string, f: number, type = "extended-text") => ({ detail: 0, format: f, mode: "normal", style: "", text: t, type, version: 1 });
export function mdVersInline(md: string, liens: Record<string, Any> = {}, typeTexte = "extended-text"): Any[] {
  const out: Any[] = []; let buf = "", fmt = 0;
  const flush = () => { if (buf) { const l = out[out.length - 1]; if (l && TEXTES.includes(l.type) && l.format === fmt) l.text += buf; else out.push(texte(buf, fmt, typeTexte)); buf = ""; } };
  for (let i = 0; i < md.length; i++) {
    const c = md[i];
    if (c === "\\" && i + 1 < md.length) { buf += md[++i]; continue; }
    if (c === "\n") { flush(); out.push({ type: "linebreak", version: 1 }); continue; }
    if (c === "[") {
      let j = i + 1, prof = 0;
      for (; j < md.length; j++) { if (md[j] === "\\") { j++; continue; } if (md[j] === "[") prof++; else if (md[j] === "]") { if (!prof) break; prof--; } }
      const m = j < md.length ? md.slice(j + 1).match(/^\(([^()\s]+)\)/) : null;
      if (m) {
        flush();
        const a = liens[m[1]] || {};
        out.push({ children: mdVersInline(md.slice(i + 1, j), liens, typeTexte).map((x) => (TEXTES.includes(x.type) ? { ...x, format: x.format | fmt } : x)), direction: "ltr", format: "", indent: 0, type: "link", version: 1, rel: a.rel ?? null, target: a.target ?? null, title: a.title ?? null, url: m[1] });
        i = j + m[0].length; continue;
      }
    }
    if (c === "*") { let n = 1; while (md[i + n] === "*" && n < 3) n++; flush(); fmt ^= n === 3 ? 3 : n === 2 ? 1 : 2; i += n - 1; continue; }
    buf += c;
  }
  flush();
  return out;
}
export const deHtml = (s: string) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");
export function texteDe(n: Any): string {
  if (!n) return "";
  if (typeof n.text === "string") return n.text;
  if (n.type === "html") return deHtml(String(n.html || "").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<!--[\s\S]*?-->/g, " ").replace(/<[^>]+>/g, " "));
  if (n.type === "image") return [n.alt, String(n.caption || "").replace(/<[^>]+>/g, " ")].filter(Boolean).join(" · ");
  return (n.children || []).map(texteDe).join(" ");
}
const typeTexteDe = (n: Any): string => { for (const c of n.children || []) { if (TEXTES.includes(c.type)) return c.type; const t = typeTexteDe(c); if (t) return t; } return ""; };

// Carte HTML de la liste des sources : seule carte HTML modifiable (jamais un encart d'abonnement, d'amorce ou de vidéo).
export const estCarteSources = (h: string) => /id=["']source-\d+/.test(h) && !/kg-gated|ph-web|ph-mail|ph-outlook|data-ph-teaser|ph-video|data-ph-premium/i.test(h);
function genreHtml(h: string): string {
  if (/data-ph-teaser-full/.test(h)) return "carte d'amorce premium (phrase entière, data-ph-teaser-full)";
  if (/data-ph-teaser-cut/.test(h)) return "carte d'amorce premium (phrase coupée pour l'e-mail, data-ph-teaser-cut)";
  if (/ph-video-meta/.test(h)) return "métadonnées vidéo (cachées)";
  if (/ph-video/.test(h)) return "encart vidéo YouTube";
  if (/kg-gated|ph-web|ph-mail|ph-outlook|data-ph-premium|portal\/signup|s-abonner/i.test(h)) return "encart d'abonnement (CTA)";
  return "carte HTML";
}

export function noeudVersBloc(n: Any, i: number): Bloc {
  try {
    if (n.type === "paragraph") return { i, t: "p", md: inlineVersMd(n.children) };
    if (n.type === "extended-heading" || n.type === "heading") { if (!["h2", "h3", "h4"].includes(n.tag)) throw new Error("titre"); return { i, t: n.tag, md: inlineVersMd(n.children) }; }
    if (n.type === "list") {
      if ((n.children || []).some((li: Any) => li.type !== "listitem" || (li.children || []).some((x: Any) => x.type === "list"))) throw new Error("liste");
      return { i, t: n.listType === "number" ? "ol" : "ul", items: n.children.map((li: Any) => inlineVersMd(li.children)) };
    }
    if (n.type === "quote" || n.type === "extended-quote") return { i, t: "quote", md: inlineVersMd(n.children) };
    if (n.type === "html" && estCarteSources(String(n.html || ""))) return { i, t: "sources", html: String(n.html || "") };
  } catch (_) { /* bloc protégé */ }
  if (n.type === "html") { const h = String(n.html || ""); const g = genreHtml(h); return { i, t: "protege", genre: g, resume: court(texteDe(n), g.startsWith("carte d'amorce") ? 1200 : 500) }; }
  if (n.type === "image") {
    const src = String(n.src || ""), cap = court(texteDe({ type: "html", html: String(n.caption || "") }), 400);
    return { i, t: "protege", genre: /\/chart-|graphique|chart/i.test(src + " " + (n.alt || "")) ? "graphique" : "image", src, legende: cap, resume: court(n.alt || cap, 300) };
  }
  if (n.type === "paywall") return { i, t: "protege", genre: "coupure paywall (<!--members-only-->)", resume: "" };
  if (n.type === "horizontalrule") return { i, t: "protege", genre: "séparateur", resume: "" };
  if (n.type === "paragraph") return { i, t: "protege", genre: "paragraphe à mise en forme spéciale (non modifiable ici)", resume: court(texteDe(n), 800) };
  return { i, t: "protege", genre: String(n.type || "bloc"), resume: court(texteDe(n), 400) };
}
export function lireLexical(lex: unknown): Any { const o = typeof lex === "string" ? JSON.parse(lex || "{}") : lex; if (!o || !o.root || !Array.isArray(o.root.children)) throw new Error("article sans contenu Lexical"); return o; }
export function extraireBlocs(lex: unknown): Bloc[] { return lireLexical(lex).root.children.map((n: Any, i: number) => noeudVersBloc(n, i)); }
export const signature = (b: Bloc) => b.t + "\u0001" + (b.md ?? "") + "\u0001" + (b.items || []).join("\u0002") + "\u0001" + (b.html ?? "");
export const editable = (b: Bloc) => b.t !== "protege";

// Texte lisible d'un bloc pour le Correcteur.
export function blocPourIA(b: Bloc): string {
  if (b.t === "protege") return "[" + b.i + "] 🔒 " + b.genre + (b.src ? " · image : " + b.src : "") + (b.legende ? " · légende : « " + b.legende + " »" : "") + (b.resume ? " · contenu : « " + b.resume + " »" : "");
  if (b.t === "sources") return "[" + b.i + "] (sources, carte HTML modifiable) " + b.html;
  if (b.t === "ul" || b.t === "ol") return "[" + b.i + "] (" + b.t + ")\n" + (b.items || []).map((x, k) => (b.t === "ol" ? (k + 1) + ". " : "- ") + x).join("\n");
  return "[" + b.i + "] (" + b.t + ") " + b.md;
}

// ---------- Corrections proposées : contrôle de forme ----------
export type Correction = { bloc: number; md?: string; items?: string[]; html?: string; categories: string[]; resume: string; details: string[]; sources: string[]; alertes?: string[] };
export type Insertion = { apres: number; blocs: { t: string; md?: string; items?: string[] }[]; categories: string[]; resume: string; details: string[] };
const CATS = ["redaction", "anti_ia", "fact_check", "vulgarisation", "putaclic", "sommaire", "premium", "sources", "hors_france", "vitrine"];
const nbGras = (s: string) => (String(s || "").match(/\*\*[^*]+\*\*/g) || []).length + (String(s || "").match(/\*\*\*[^*]+\*\*\*/g) || []).length;
const urls = (s: string) => Array.from(String(s || "").matchAll(/https?:\/\/[^\s"'<>)\]]+/g)).map((m) => m[0]);
export function normaliserCorrections(raw: Any, blocs: Bloc[]): { corrections: Correction[]; insertions: Insertion[]; rejets: string[] } {
  const parI: Record<number, Bloc> = {}; for (const b of blocs) parI[b.i] = b;
  const rejets: string[] = [], vus = new Set<number>(), corrections: Correction[] = [];
  const cats = (v: Any) => (Array.isArray(v) ? v : [v]).map((x) => String(x || "").toLowerCase().replace(/[^a-z_]/g, "")).filter((x) => CATS.includes(x)).slice(0, 4);
  const txts = (v: Any, n: number, m: number) => (Array.isArray(v) ? v : v ? [v] : []).map((x) => court(x, m)).filter(Boolean).slice(0, n);
  for (const c of Array.isArray(raw?.corrections) ? raw.corrections : []) {
    const i = Number(c?.bloc), b = parI[i];
    if (!b) { rejets.push("bloc " + c?.bloc + " inexistant"); continue; }
    if (!editable(b)) { rejets.push("bloc " + i + " protégé (" + b.genre + ") : correction ignorée"); continue; }
    if (vus.has(i)) { rejets.push("bloc " + i + " corrigé deux fois : seule la première correction est gardée"); continue; }
    const out: Correction = { bloc: i, categories: cats(c.categories), resume: court(c.resume, 300), details: txts(c.details, 12, 400), sources: txts(c.sources, 6, 600).filter((u) => /^https?:\/\//.test(u)), alertes: [] };
    if (b.t === "ul" || b.t === "ol") {
      const it = (Array.isArray(c.items) ? c.items : []).map((x: Any) => String(x ?? "").trim()).filter(Boolean).slice(0, 40);
      if (!it.length) { rejets.push("bloc " + i + " : liste vide"); continue; }
      if (it.join("\u0002") === (b.items || []).join("\u0002")) continue;
      out.items = it;
      if (nbGras(it.join(" ")) < nbGras((b.items || []).join(" "))) out.alertes!.push("gras en moins dans cette liste");
    } else if (b.t === "sources") {
      const h = String(c.html || "").trim();
      if (!h || !/<ol[\s>]/i.test(h) || !/id=["']source-\d+/.test(h) || !estCarteSources(h)) { rejets.push("bloc " + i + " : liste de sources invalide (une <ol> avec des <li id=\"source-N\"> est attendue)"); continue; }
      if (h === b.html) continue;
      out.html = h;
      const racines = urls(h).filter((u) => /^https?:\/\/[^/]+\/?$/.test(u)); if (racines.length) out.alertes!.push("lien vers une page d'accueil : " + racines.join(", "));
    } else {
      const md = String(c.md ?? "").trim();
      if (!md) { rejets.push("bloc " + i + " : texte vide"); continue; }
      if (md === b.md) continue;
      out.md = md;
      if (nbGras(md) < nbGras(b.md || "")) out.alertes!.push("gras en moins dans ce bloc");
    }
    const neuf = out.md || (out.items || []).join(" ") || "";
    if (/—/.test(neuf) && !/—/.test(b.md || (b.items || []).join(" "))) out.alertes!.push("tiret cadratin « — » introduit");
    if (!out.alertes!.length) delete out.alertes;
    vus.add(i); corrections.push(out);
  }
  const insertions: Insertion[] = [];
  for (const x of Array.isArray(raw?.insertions) ? raw.insertions : []) {
    const a = Number(x?.apres);
    if (!parI[a] && a !== -1) { rejets.push("insertion après le bloc " + x?.apres + " : bloc inexistant"); continue; }
    const bs = (Array.isArray(x.blocs) ? x.blocs : []).map((y: Any) => {
      const t = ["p", "h2", "h3", "ul", "ol"].includes(String(y?.t)) ? String(y.t) : "";
      if (!t) return null;
      if (t === "ul" || t === "ol") { const it = (Array.isArray(y.items) ? y.items : []).map((z: Any) => String(z ?? "").trim()).filter(Boolean).slice(0, 30); return it.length ? { t, items: it } : null; }
      const md = String(y.md ?? "").trim(); return md ? { t, md } : null;
    }).filter(Boolean).slice(0, 6);
    if (!bs.length) { rejets.push("insertion vide ignorée"); continue; }
    insertions.push({ apres: a, blocs: bs, categories: cats(x.categories), resume: court(x.resume, 300), details: txts(x.details, 8, 400) });
  }
  return { corrections, insertions: insertions.slice(0, 6), rejets };
}

// ---------- Application dans le Lexical ACTUEL de Ghost ----------
// Chaque bloc corrigé est retrouvé par son contenu d'origine (signature) : si l'article a été modifié entre-temps, une correction
// dont le bloc a changé n'est pas appliquée (conflit signalé), les autres passent. Les blocs protégés ne sont jamais touchés.
function nouveauNoeud(b: { t: string; md?: string; items?: string[] }, modele: Record<string, Any>, typeTexte: string): Any {
  const base = { direction: "ltr", format: "", indent: 0, version: 1 };
  if (b.t === "ul" || b.t === "ol") {
    const ml = modele.list || {}, mli = modele.listitem || {};
    return { ...base, ...pick(ml, ["direction", "format", "indent", "version"]), type: "list", listType: b.t === "ol" ? "number" : "bullet", start: 1, tag: b.t,
      children: (b.items || []).map((x, k) => ({ ...base, ...pick(mli, ["direction", "format", "indent", "version"]), type: "listitem", value: k + 1, children: mdVersInline(x, {}, typeTexte) })) };
  }
  if (b.t === "h2" || b.t === "h3") return { ...base, type: (modele.heading && modele.heading.type) || "extended-heading", tag: b.t, children: mdVersInline(b.md || "", {}, typeTexte) };
  return { ...base, ...pick(modele.paragraph || {}, ["direction", "format", "indent", "version"]), type: "paragraph", children: mdVersInline(b.md || "", {}, typeTexte) };
}
const pick = (o: Any, ks: string[]) => { const r: Any = {}; for (const k of ks) if (o && o[k] !== undefined) r[k] = o[k]; return r; };
const liensDe = (n: Any) => { const l: Record<string, Any> = {}; try { if (n.type === "list") for (const li of n.children || []) inlineVersMd(li.children, l); else inlineVersMd(n.children || [], l); } catch (_) { /* rien */ } return l; };

export function appliquer(lexActuel: unknown, avant: Bloc[], corrections: Correction[], insertions: Insertion[]): { lexical: Any; appliquees: number[]; inserees: number[]; conflits: { ref: string; raison: string }[] } {
  const lex = lireLexical(JSON.parse(JSON.stringify(typeof lexActuel === "string" ? JSON.parse(lexActuel) : lexActuel)));
  const enfants: Any[] = lex.root.children;
  const actuels = enfants.map((n: Any, i: number) => noeudVersBloc(n, i));
  const parSig: Record<string, number[]> = {};
  actuels.forEach((b) => { const s = signature(b); (parSig[s] = parSig[s] || []).push(b.i); });
  const parI: Record<number, Bloc> = {}; for (const b of avant) parI[b.i] = b;
  const retrouver = (b: Bloc | undefined): number => {
    if (!b) return -1;
    const l = parSig[signature(b)] || [];
    if (l.length === 1) return l[0];
    if (l.length > 1) return l.includes(b.i) ? b.i : l[0];
    return -1;
  };
  // modèles de nœuds (pour les insertions) et type des nœuds texte, pris dans l'article lui-même
  const modele: Record<string, Any> = {};
  for (const n of enfants) {
    if (n.type === "paragraph" && !modele.paragraph) modele.paragraph = n;
    if ((n.type === "extended-heading" || n.type === "heading") && !modele.heading) modele.heading = n;
    if (n.type === "list" && !modele.list) { modele.list = n; modele.listitem = (n.children || [])[0]; }
  }
  const typeTexte = enfants.map(typeTexteDe).find(Boolean) || "extended-text";
  const ops: { pos: number; ordre: number; seq: number; f: () => void }[] = [];
  const appliquees: number[] = [], inserees: number[] = [], conflits: { ref: string; raison: string }[] = [];
  corrections.forEach((c, k) => {
    const b = parI[c.bloc], pos = retrouver(b);
    if (pos < 0) { conflits.push({ ref: "c" + k, raison: "le passage a été modifié dans Ghost depuis la relecture" }); return; }
    const n = enfants[pos];
    ops.push({ pos, ordre: 1, seq: k, f: () => {
      const l = liensDe(n), tt = typeTexteDe(n) || typeTexte;
      if (c.html !== undefined) n.html = c.html;
      else if (c.items) {
        const mli = (n.children || [])[0] || {};
        n.children = c.items.map((x, j) => ({ direction: mli.direction || "ltr", format: mli.format || "", indent: mli.indent || 0, version: mli.version || 1, type: "listitem", value: j + 1, children: mdVersInline(x, l, tt) }));
      } else n.children = mdVersInline(c.md || "", l, tt);
    } });
    appliquees.push(k);
  });
  insertions.forEach((x, k) => {
    const pos = x.apres === -1 ? -1 : retrouver(parI[x.apres]);
    if (x.apres !== -1 && pos < 0) { conflits.push({ ref: "i" + k, raison: "le bloc d'ancrage a été modifié dans Ghost depuis la relecture" }); return; }
    ops.push({ pos, ordre: 0, seq: k, f: () => { enfants.splice(pos + 1, 0, ...x.blocs.map((b) => nouveauNoeud(b, modele, typeTexte))); } });
    inserees.push(k);
  });
  // de la fin vers le début (les positions restent justes) ; à position égale, la correction du bloc avant l'insertion qui le suit
  ops.sort((a, b) => b.pos - a.pos || a.ordre - b.ordre || b.seq - a.seq).forEach((o) => o.f());
  return { lexical: lex, appliquees, inserees, conflits };
}

// ---------- Graphique refait : on remplace l'image d'origine (même place, même carte) ----------
const escH = (s: string) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export function remplacerImage(lex: Any, srcAvant: string, n: { src: string; largeur?: number; hauteur?: number; legende?: string; alt?: string }): boolean {
  const enfants: Any[] = lireLexical(lex).root.children;
  const img = enfants.find((x) => x.type === "image" && String(x.src || "") === srcAvant);
  if (!img) return false;
  img.src = n.src;
  if (n.largeur && n.hauteur) { img.width = n.largeur; img.height = n.hauteur; }
  if (n.legende) img.caption = '<span style="white-space: pre-wrap;">' + escH(n.legende) + "</span>";
  if (n.alt) img.alt = n.alt;
  return true;
}
// Dimensions d'une image JPEG ou PNG (en-tête seulement).
export function dimensionsImage(b: Uint8Array): { largeur: number; hauteur: number } | null {
  if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50) return { largeur: (b[16] << 24 | b[17] << 16 | b[18] << 8 | b[19]) >>> 0, hauteur: (b[20] << 24 | b[21] << 16 | b[22] << 8 | b[23]) >>> 0 };
  if (b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    const m = b[i + 1], len = b[i + 2] << 8 | b[i + 3];
    if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return { largeur: b[i + 7] << 8 | b[i + 8], hauteur: b[i + 5] << 8 | b[i + 6] };
    i += 2 + len;
  }
  return null;
}
