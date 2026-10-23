// Writinglab — base de connaissances : récupération PAR DOMAINE au moment où un poste agit (23/10/2026).
// Copiée telle quelle à côté des fonctions qui en ont besoin (wl-kb, wl-tel) : la déployer avec elles (fichier « kb.ts »).
// Budget : les Instructions du domaine sont toujours incluses ; les résumés (documents, sites) entrent en entier s'ils tiennent
// sous BUDGET jetons ; au-delà, seules les sections les plus pertinentes pour la requête en cours (recherche plein texte
// Postgres en français, fonction wl_kb_chercher). Cache mémoire de 60 s par domaine. Jamais bloquant : erreur = texte vide.
export const BUDGET = 3000; // jetons estimés pour les résumés d'un domaine (les Instructions s'ajoutent)
export const jetons = (s: string) => Math.ceil(String(s || "").length / 3.6);
type Sec = { id: number; source_id: string; titre: string; contenu: string; tokens: number; source: string };
let cache: Record<string, { at: number; instructions: string; sections: Sec[] }> = {};
export function viderCacheKb(domaine?: string) { if (domaine) delete cache[domaine]; else cache = {}; }
// deno-lint-ignore no-explicit-any
async function charger(db: any, domaine: string) {
  const c = cache[domaine];
  if (c && Date.now() - c.at < 60000) return c;
  const [{ data: ins }, { data: res }, { data: src }] = await Promise.all([
    db.from("wl_kb_instructions").select("contenu").eq("domaine", domaine).limit(1),
    db.from("wl_kb_resumes").select("id,source_id,titre,contenu,tokens,ordre").eq("domaine", domaine).order("source_id").order("ordre").limit(400),
    db.from("wl_kb_sources").select("id,nom,url,type,extrait_le").eq("domaine", domaine).limit(400),
  ]);
  // deno-lint-ignore no-explicit-any
  const nomSrc: Record<string, string> = Object.fromEntries((src || []).map((s: any) => [s.id, (s.type === "site" ? "site " : "document ") + (s.nom || s.url || "") + (s.extrait_le ? " (extrait le " + String(s.extrait_le).slice(0, 10) + ")" : "")]));
  // deno-lint-ignore no-explicit-any
  const sections: Sec[] = (res || []).map((r: any) => ({ id: r.id, source_id: r.source_id, titre: r.titre, contenu: r.contenu, tokens: r.tokens || 0, source: nomSrc[r.source_id] || "source" }));
  const v = { at: Date.now(), instructions: String((ins && ins[0] && ins[0].contenu) || ""), sections };
  cache[domaine] = v;
  return v;
}
// Texte à ajouter au prompt d'un poste : « === BASE DE CONNAISSANCES (domaine) === … ». Vide si rien n'est renseigné.
// deno-lint-ignore no-explicit-any
export async function contexteKb(db: any, domaine: string | null | undefined, requete = ""): Promise<{ texte: string; tokens: number; selection: boolean; sources: string[] }> {
  const vide = { texte: "", tokens: 0, selection: false, sources: [] as string[] };
  if (!domaine) return vide;
  try {
    const k = await charger(db, domaine);
    let secs = k.sections, selection = false;
    const total = secs.reduce((a, s) => a + (s.tokens || jetons(s.contenu)), 0);
    if (total > BUDGET) {
      selection = true;
      const { data } = await db.rpc("wl_kb_chercher", { p_domaine: domaine, p_requete: String(requete || "").slice(0, 600), p_limite: 30 });
      const parId: Record<number, Sec> = Object.fromEntries(secs.map((s) => [s.id, s]));
      // deno-lint-ignore no-explicit-any
      const ord = ((data || []) as any[]).map((r) => parId[r.id]).filter(Boolean);
      const out: Sec[] = []; let n = 0;
      for (const s of ord) { const t = s.tokens || jetons(s.contenu); if (n + t > BUDGET) continue; out.push(s); n += t; }
      secs = out;
    }
    const parties: string[] = [];
    if (k.instructions.trim()) parties.push(k.instructions.trim());
    const groupes: Record<string, Sec[]> = {};
    for (const s of secs) (groupes[s.source] = groupes[s.source] || []).push(s);
    for (const [src, l] of Object.entries(groupes)) parties.push("--- D'après " + src + " ---\n" + l.map((s) => (s.titre ? "• " + s.titre + " : " : "• ") + s.contenu).join("\n"));
    if (!parties.length) return vide;
    const texte = "=== BASE DE CONNAISSANCES (" + domaine + ") ===\n" + (selection ? "(extraits les plus pertinents pour cette demande)\n" : "") + parties.join("\n\n");
    return { texte, tokens: jetons(texte), selection, sources: Object.keys(groupes) };
  } catch (_) { return vide; }
}
