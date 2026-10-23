// Writinglab — équipe : source unique = table wl_equipe (Supabase), lue avec un cache mémoire de 60 s (23/10/2026).
// Copiée telle quelle à côté de chaque fonction qui en a besoin (wl-db, wl-push, wl-facture, wl-radar, wl-consent, vote) :
// la déployer avec la fonction (fichier « equipe.ts »). Gestion : Paramètres → Équipe (fonction wl-consent, rédacteur en chef).
// Membre inactif (actif=false) : refusé partout (parEmail). Membre de test (test=true) : fonctionne normalement.
// Si la table est injoignable : dernière liste connue, sinon repli MINIMAL sur le rédacteur en chef seul (jamais enfermé dehors).
export type Membre = { email: string; id: string; nom: string; titre: string; role: string; boite: string | null; signature: string; signature_en: string; actif: boolean; test: boolean; chef: boolean };
const SECOURS: Membre[] = [{ email: "jonathan.paiano@outlook.com", id: "jonathan", nom: "Jonathan Paiano", titre: "Rédacteur en chef", role: "chef", boite: "jonathan",
  signature: "Jonathan Paiano\nRédacteur en chef, Posthumain\nhttps://posthumain.com", signature_en: "Jonathan Paiano\nEditor-in-Chief, Posthumain\nhttps://posthumain.com", actif: true, test: false, chef: true }];
let cache: { at: number; liste: Membre[] } | null = null;
// deno-lint-ignore no-explicit-any
const norm = (r: any): Membre => ({ email: String(r.email || "").toLowerCase(), id: String(r.id || ""), nom: String(r.nom || ""), titre: String(r.titre || ""), role: String(r.role || "journaliste"),
  boite: r.boite ? String(r.boite) : null, signature: String(r.signature || ""), signature_en: String(r.signature_en || ""), actif: r.actif !== false, test: !!r.test, chef: r.role === "chef" });
// deno-lint-ignore no-explicit-any
export async function equipe(db: any, frais = false): Promise<Membre[]> {
  if (!frais && cache && Date.now() - cache.at < 60000) return cache.liste;
  try {
    const { data, error } = await db.from("wl_equipe").select("email,id,nom,titre,role,boite,signature,signature_en,actif,test").order("created_at");
    if (error || !data || !data.length) throw new Error(error?.message || "équipe vide");
    cache = { at: Date.now(), liste: data.map(norm) };
    return cache.liste;
  } catch (_) { return cache ? cache.liste : SECOURS; }
}
export function viderCacheEquipe() { cache = null; }
// deno-lint-ignore no-explicit-any
export async function parEmail(db: any, email: string): Promise<Membre | null> { const e = String(email || "").toLowerCase().trim(); return (await equipe(db)).find((m) => m.email === e && m.actif) || null; }
// deno-lint-ignore no-explicit-any
export async function parId(db: any, id: string, inactifsAussi = false): Promise<Membre | null> { return (await equipe(db)).find((m) => m.id === id && (inactifsAussi || m.actif)) || null; }
// deno-lint-ignore no-explicit-any
export async function chefs(db: any): Promise<string[]> { const l = (await equipe(db)).filter((m) => m.chef && m.actif).map((m) => m.id); return l.length ? l : ["jonathan"]; }
// deno-lint-ignore no-explicit-any
export async function noms(db: any): Promise<Record<string, string>> { const o: Record<string, string> = {}; for (const m of await equipe(db)) o[m.id] = m.nom; return o; }
