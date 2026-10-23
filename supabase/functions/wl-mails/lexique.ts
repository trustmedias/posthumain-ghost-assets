// Writinglab — wl-mails : conversion Lexical (format des mails Ghost) ⇄ blocs éditables, et chaîne de l'automation de bienvenue.
// Module pur (aucun accès réseau), testé hors ligne : deno test supabase/functions/wl-mails/lexique_test.ts (formes réelles des mails Ghost).
// deno-lint-ignore no-explicit-any
type Any = any;
export const court = (s: unknown, n: number) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };
// ---------- Lexical ⇄ blocs (titres, paragraphes, listes, séparateurs, boutons ; le reste devient un bloc protégé) ----------
// Mise en forme dans le texte : **gras**, *italique*, [texte](https://lien), retour à la ligne = saut de ligne.
export const escMd = (s: string) => s.replace(/([\\*\[\]])/g, "\\$1");
export function inlineVersMd(nodes: Any[]): string {
  let out = "";
  for (const n of nodes || []) {
    if (n.type === "extended-text" || n.type === "text") {
      const f = Number(n.format || 0);
      if (f & ~3) throw new Error("format");
      const t = String(n.text || ""), m = t.match(/^(\s*)([\s\S]*?)(\s*)$/)!;
      if (!m[2]) { out += escMd(t); continue; }
      const mk = f === 3 ? "***" : f === 1 ? "**" : f === 2 ? "*" : "";
      out += m[1] + mk + escMd(m[2]) + mk + m[3];
    } else if (n.type === "link") {
      if (n.title || n.target || n.rel) throw new Error("lien");
      out += "[" + inlineVersMd(n.children || []) + "](" + String(n.url || "") + ")";
    } else if (n.type === "linebreak") out += "\n";
    else throw new Error("noeud");
  }
  return out;
}
export const texte = (t: string, f: number) => ({ detail: 0, format: f, mode: "normal", style: "", text: t, type: "extended-text", version: 1 });
export function mdVersInline(md: string): Any[] {
  const out: Any[] = []; let buf = "", fmt = 0;
  const flush = () => { if (buf) { const l = out[out.length - 1]; if (l && l.type === "extended-text" && l.format === fmt) l.text += buf; else out.push(texte(buf, fmt)); buf = ""; } };
  for (let i = 0; i < md.length; i++) {
    const c = md[i];
    if (c === "\\" && i + 1 < md.length) { buf += md[++i]; continue; }
    if (c === "\n") { flush(); out.push({ type: "linebreak", version: 1 }); continue; }
    if (c === "[") {
      let j = i + 1, prof = 0;
      for (; j < md.length; j++) { if (md[j] === "\\") { j++; continue; } if (md[j] === "[") prof++; else if (md[j] === "]") { if (!prof) break; prof--; } }
      const m = j < md.length ? md.slice(j + 1).match(/^\(([^()\s]+)\)/) : null;
      if (m) { flush(); out.push({ children: mdVersInline(md.slice(i + 1, j)).map((x) => (x.type === "extended-text" ? { ...x, format: x.format | fmt } : x)), direction: "ltr", format: "", indent: 0, type: "link", version: 1, rel: null, target: null, title: null, url: m[1] }); i = j + m[0].length; continue; }
    }
    if (c === "*") { let n = 1; while (md[i + n] === "*" && n < 3) n++; flush(); fmt ^= n === 3 ? 3 : n === 2 ? 1 : 2; i += n - 1; continue; }
    buf += c;
  }
  flush();
  return out;
}
export const blocBase = { direction: "ltr", format: "", indent: 0, version: 1 };
export function noeudVersBloc(n: Any): Any {
  try {
    if (n.type === "paragraph") return { t: "p", md: inlineVersMd(n.children) };
    if (n.type === "extended-heading" || n.type === "heading") return { t: "h", tag: ["h2", "h3", "h4"].includes(n.tag) ? n.tag : "h2", md: inlineVersMd(n.children) };
    if (n.type === "list") { if ((n.children || []).some((li: Any) => li.type !== "listitem" || (li.children || []).some((x: Any) => x.type === "list"))) throw new Error("liste"); return { t: n.listType === "number" ? "ol" : "ul", items: n.children.map((li: Any) => inlineVersMd(li.children)) }; }
    if (n.type === "horizontalrule") return { t: "hr" };
    if (n.type === "html" && /data-wl-bouton/.test(String(n.html || ""))) { const m = String(n.html).match(/<a href="([^"]+)"[^>]*>[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/); if (m) return { t: "bouton", url: deHtml(m[1]), label: deHtml(m[2]) }; }
  } catch (_) { /* bloc protégé */ }
  return { t: "raw", node: n, resume: court(texteDe(n), 140) || n.type };
}
export const deHtml = (s: string) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");
export function texteDe(n: Any): string { if (!n) return ""; if (typeof n.text === "string") return n.text; if (n.type === "html") return String(n.html || "").replace(/<[^>]+>/g, " "); return (n.children || []).map(texteDe).join(" "); }
export const ACCENT = "#e5322d", INK = "#15171a", BTN = "#00be59";
export const escH = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
export const fr = (h: string) => h.replace(/ ([!?:;»])/g, "&nbsp;$1").replace(/« /g, "«&nbsp;");
// Bouton HTML « bulletproof » du Grand Format (tableau + mso-text-raise : cliquable partout, Outlook classic compris), repris tel quel.
export function boutonHtml(label: string, url: string) {
  return '<table data-wl-bouton="1" role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;margin:0;width:auto;"><tr>'
    + '<td bgcolor="' + BTN + '" style="background-color:' + BTN + ';border-radius:4px;padding:0;border:0;">'
    + '<a href="' + escH(url) + '" style="display:inline-block;padding:12px 22px;background-color:' + BTN + ';border-radius:4px;color:#ffffff;font-size:16px;line-height:20px;font-weight:bold;text-decoration:none;border:0;mso-padding-alt:0;">'
    + '<!--[if mso]><i style="mso-font-width:150%;mso-text-raise:18pt" hidden>&emsp;</i><![endif]-->'
    + '<span style="mso-text-raise:9pt;">' + escH(label) + '</span>'
    + '<!--[if mso]><i style="mso-font-width:150%;" hidden>&emsp;&#8203;</i><![endif]-->'
    + '</a></td></tr></table>'
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;"><tr><td height="16" style="height:16px;line-height:16px;font-size:0;">&nbsp;</td></tr></table>';
}
export function mdVersHtml(md: string): string {
  const parts = mdVersInline(md);
  const run = (nodes: Any[]): string => nodes.map((x) => {
    if (x.type === "linebreak") return "<br>";
    if (x.type === "link") return '<a href="' + escH(x.url) + '" style="color:' + ACCENT + ';font-weight:700;text-decoration:underline;">' + run(x.children) + "</a>";
    let t = fr(escH(x.text)); if (x.format & 1) t = "<strong>" + t + "</strong>"; if (x.format & 2) t = "<em>" + t + "</em>"; return t;
  }).join("");
  return run(parts);
}
export const htmlNoeud = (h: string) => ({ type: "html", version: 1, html: h });
// mise en page « ghost » : nœuds Lexical natifs (comme aujourd'hui) ; « carte » : cartes HTML aux styles éprouvés du Grand Format
export function blocsVersLexical(blocs: Any[], miseEnPage: string): string {
  const carte = miseEnPage === "carte";
  const ch: Any[] = [];
  for (const b of blocs) {
    if (b.t === "raw") { ch.push(b.node); continue; }
    if (b.t === "bouton") { ch.push(htmlNoeud(boutonHtml(b.label, b.url))); continue; }
    if (carte) {
      if (b.t === "p") ch.push(htmlNoeud('<p style="margin:0 0 14px 0;font-size:17px;line-height:1.6;color:#3c4043;">' + mdVersHtml(b.md) + "</p>"));
      else if (b.t === "h") ch.push(htmlNoeud('<' + b.tag + ' style="margin:24px 0 10px 0;font-size:' + (b.tag === "h2" ? 22 : 19) + 'px;line-height:1.3;font-weight:800;color:' + INK + ';">' + mdVersHtml(b.md) + "</" + b.tag + ">"));
      else if (b.t === "ul" || b.t === "ol") ch.push(htmlNoeud("<" + b.t + ' style="margin:0 0 14px 0;padding:0 0 0 22px;font-size:17px;line-height:1.6;color:#3c4043;">' + b.items.map((it: string) => '<li style="margin:0 0 6px 0;">' + mdVersHtml(it) + "</li>").join("") + "</" + b.t + ">"));
      else if (b.t === "hr") ch.push(htmlNoeud('<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;"><tr><td style="padding:12px 0 22px 0;"><div style="border-top:1px solid #e3e3e3;font-size:0;line-height:0;">&nbsp;</div></td></tr></table>'));
      continue;
    }
    if (b.t === "p") ch.push({ children: mdVersInline(b.md), ...blocBase, type: "paragraph" });
    else if (b.t === "h") ch.push({ children: mdVersInline(b.md), ...blocBase, type: "extended-heading", tag: b.tag });
    else if (b.t === "ul" || b.t === "ol") ch.push({ children: b.items.map((it: string, i: number) => ({ children: mdVersInline(it), ...blocBase, type: "listitem", value: i + 1 })), ...blocBase, type: "list", listType: b.t === "ol" ? "number" : "bullet", start: 1, tag: b.t });
    else if (b.t === "hr") ch.push({ type: "horizontalrule", version: 1 });
  }
  return JSON.stringify({ root: { children: ch, ...blocBase, type: "root" } });
}
// Canonique pour comparer deux nœuds (textes voisins fusionnés, attributs de présentation ignorés)
export function canon(n: Any): Any {
  if (!n || typeof n !== "object") return n;
  const o: Any = { type: n.type === "text" ? "extended-text" : n.type === "heading" ? "extended-heading" : n.type };
  if (o.type === "extended-text") { o.text = n.text; o.format = Number(n.format || 0); return o; }
  for (const k of ["tag", "listType", "url", "html"]) if (n[k] != null) o[k] = n[k];
  if (n.children) { const ch: Any[] = []; for (const c of n.children.map(canon)) { const l = ch[ch.length - 1]; if (l && l.type === "extended-text" && c.type === "extended-text" && l.format === c.format) l.text += c.text; else ch.push(c); } o.children = ch; }
  return o;
}
export function lexicalVersBlocs(lexical: string): { blocs: Any[]; protege: number } {
  const root = JSON.parse(lexical).root; const blocs: Any[] = []; let protege = 0;
  for (const n of root.children || []) {
    let b = noeudVersBloc(n);
    if (b.t !== "raw" && b.t !== "bouton") {
      const re = JSON.parse(blocsVersLexical([b], "ghost")).root.children[0];
      if (JSON.stringify(canon(re)) !== JSON.stringify(canon(n))) b = { t: "raw", node: n, resume: court(texteDe(n), 140) || n.type };
    }
    if (b.t === "raw") protege++;
    blocs.push(b);
  }
  return { blocs, protege };
}
export const TYPES_LEX = new Set(["root", "paragraph", "extended-text", "text", "link", "linebreak", "horizontalrule", "extended-heading", "heading", "list", "listitem", "html", "button", "image", "callout", "quote", "extended-quote", "aside", "divider", "email-cta", "email", "codeblock", "code"]);
export function lexicalValide(lexical: string): string | null {
  let o: Any; try { o = JSON.parse(lexical); } catch { return "JSON illisible"; }
  if (!o || !o.root || o.root.type !== "root" || !Array.isArray(o.root.children)) return "la racine Lexical (root) est absente";
  if (!o.root.children.length) return "le mail est vide";
  if (lexical.length > 150000) return "contenu trop long";
  let mauvais = ""; const walk = (n: Any) => { if (!n || typeof n.type !== "string" || !TYPES_LEX.has(n.type)) { mauvais = String(n && n.type); return; } (n.children || []).forEach(walk); };
  walk(o.root); if (mauvais) return "type de bloc non pris en charge : " + mauvais;
  return null;
}
export function blocsValides(blocs: Any): string | null {
  if (!Array.isArray(blocs) || !blocs.length) return "aucun bloc";
  if (blocs.length > 60) return "trop de blocs (60 au plus)";
  for (const b of blocs) {
    if (!b || typeof b !== "object") return "bloc illisible";
    if (b.t === "p" || b.t === "h") { if (typeof b.md !== "string" || b.md.length > 4000) return "texte de bloc illisible ou trop long"; if (b.t === "h" && !["h2", "h3", "h4"].includes(b.tag)) b.tag = "h2"; }
    else if (b.t === "ul" || b.t === "ol") { if (!Array.isArray(b.items) || !b.items.length || b.items.some((x: Any) => typeof x !== "string" || x.length > 1500)) return "liste illisible"; }
    else if (b.t === "bouton") { if (!b.label || String(b.label).length > 60) return "texte de bouton manquant ou trop long"; if (!/^https:\/\/[^\s"<>]+$/.test(String(b.url || ""))) return "lien de bouton invalide (https:// obligatoire)"; }
    else if (b.t === "raw") { if (!b.node || typeof b.node.type !== "string") return "bloc protégé illisible"; }
    else if (b.t !== "hr") return "type de bloc inconnu : " + b.t;
  }
  // liens : on vérifie ceux que la conversion produira vraiment (https:// ou mailto: seulement)
  const liens = (ns: Any[]): string[] => ns.flatMap((x: Any) => (x.type === "link" ? [String(x.url), ...liens(x.children || [])] : []));
  for (const b of blocs) for (const s of [b.md, ...(b.items || [])]) if (typeof s === "string") for (const u of liens(mdVersInline(s))) if (!/^(https:\/\/|mailto:)[^\s"<>]+$/.test(u)) return "lien invalide : " + u;
  return null;
}

export function chaine(a: Any): Any[] {
  const par: Record<string, Any> = Object.fromEntries((a.actions || []).map((x: Any) => [x.id, x]));
  const cibles = new Set((a.edges || []).map((e: Any) => e.target_action_id));
  const suiv: Record<string, string> = Object.fromEntries((a.edges || []).map((e: Any) => [e.source_action_id, e.target_action_id]));
  let cur = (a.actions || []).find((x: Any) => !cibles.has(x.id)); const out: Any[] = []; const vu = new Set();
  while (cur && !vu.has(cur.id)) { vu.add(cur.id); out.push(cur); cur = par[suiv[cur.id]]; }
  return out;
}
export function nouvelId() { const b = new Uint8Array(12); crypto.getRandomValues(b); const ts = Math.floor(Date.now() / 1000); b[0] = ts >>> 24; b[1] = (ts >>> 16) & 255; b[2] = (ts >>> 8) & 255; b[3] = ts & 255; return [...b].map((x) => x.toString(16).padStart(2, "0")).join(""); }
// Reconstruit la chaîne de l'automation : attente → mail → attente → mail, d'après les réglages (activé, délai cumulé).
// Mails désactivés retirés de la chaîne (leur contenu reste dans l'historique et revient à la réactivation).
export function nouvelleChaine(a: Any, items: Any[]): { actions: Any[]; edges: Any[]; status: string } {
  const ch = chaine(a), waits = ch.filter((x) => x.type === "wait");
  const actifs = items.filter((i) => i.actif).sort((x, y) => x.jours - y.jours);
  if (!actifs.length) return { actions: a.actions, edges: a.edges, status: "inactive" };
  const actions: Any[] = [], edges: Any[] = []; let prev: string | null = null, jPrev = 0, wi = 0;
  for (const m of actifs) {
    const delta = m.jours - jPrev;
    if (delta > 0) { const w = waits[wi++]; const id = w ? w.id : nouvelId(); actions.push({ id, type: "wait", data: { wait_hours: delta * 24 } }); if (prev) edges.push({ source_action_id: prev, target_action_id: id }); prev = id; }
    const mid = m.action_id || nouvelId();
    actions.push({ id: mid, type: "send_email", data: { email_subject: m.sujet, email_lexical: m.lexical, email_design_setting_id: m.design } });
    if (prev) edges.push({ source_action_id: prev, target_action_id: mid }); prev = mid; jPrev = m.jours; m.action_id = mid;
  }
  return { actions, edges, status: "active" };
}
