// Tests hors ligne de la conversion en actu premium : deno test supabase/functions/wl-relecture/premium_test.ts
import { assert, assertEquals } from "jsr:@std/assert@1";
import { appliquer, extraireBlocs } from "./blocs.ts";
import { amorceCoupee, blocsPayants, extraitGuide, marquerCoupure, noeudsCoupure, normaliserCoupure, poserCoupure, raisonRefus } from "./premium.ts";

const T = (text: string) => ({ detail: 0, format: 0, mode: "normal", style: "", text, type: "extended-text", version: 1 });
const P = (text: string) => ({ children: [T(text)], direction: "ltr", format: "", indent: 0, type: "paragraph", version: 1 });
const H = (text: string, tag = "h2") => ({ children: [T(text)], direction: "ltr", format: "", indent: 0, type: "extended-heading", tag, version: 1 });
const CTA = { type: "html", version: 1, html: '<div class="ph-web-complex"><a href="#/portal/signup/monthly">S’abonner</a></div>' };
const SRC = { type: "html", version: 1, html: '<!--kg-card-begin: html--><ol><li id="source-1"><a href="https://exemple.org/a">exemple.org</a></li></ol><!--kg-card-end: html-->' };
function article() {
  return { root: { type: "root", version: 1, children: [
    P("Intro de l’actu."), P("Deuxième paragraphe."), CTA, H("Le contexte"), P("Contexte détaillé."), P("Encore du contexte."),
    H("La stratégie Posthumain"), P("Ce que ça change pour vous, et la vraie question : faut-il agir maintenant ?"), P("Premier conseil."), P("Deuxième conseil."), H("Sources", "h3"), SRC,
  ] } };
}

Deno.test("raisonRefus : brouillon public convertible ; publié, premium, déjà coupé refusés", () => {
  const lex = JSON.stringify(article());
  assertEquals(raisonRefus({ status: "draft", visibility: "public", tags: [], lexical: lex }), null);
  assertEquals(raisonRefus({ status: "scheduled", visibility: "public", tags: [], lexical: lex }), null);
  assert(raisonRefus({ status: "published", visibility: "public", tags: [], lexical: lex })!.includes("déjà publié"));
  assert(raisonRefus({ status: "draft", visibility: "paid", tags: [], lexical: lex })!.includes("payants"));
  assert(raisonRefus({ status: "draft", visibility: "public", tags: [{ slug: "actu-premium" }], lexical: lex })!.includes("premium"));
  const a = article(); a.root.children.splice(3, 0, { type: "paywall", version: 1 } as never);
  assert(raisonRefus({ status: "draft", visibility: "public", tags: [], lexical: JSON.stringify(a) })!.includes("coupure"));
});

Deno.test("normaliserCoupure : paragraphe, assez bas, une seule phrase, sans parler du paywall", () => {
  const blocs = extraireBlocs(article());
  const ok = normaliserCoupure({ apres: 7, amorce: "Le premier réflexe tient en une vérification de trente secondes, que presque personne ne fait avant d’acheter." }, blocs);
  assert(!("erreur" in ok));
  assert("erreur" in normaliserCoupure({ apres: 6, amorce: "Une phrase d’amorce suffisamment longue pour passer le contrôle." }, blocs)); // intertitre
  assert("erreur" in normaliserCoupure({ apres: 1, amorce: "Une phrase d’amorce suffisamment longue pour passer le contrôle." }, blocs)); // trop haut
  assert("erreur" in normaliserCoupure({ apres: 7, amorce: "Première phrase assez longue ici. Puis une seconde phrase en plus." }, blocs));
  assert("erreur" in normaliserCoupure({ apres: 7, amorce: "La suite, réservée aux abonnés, détaille les trois démarches à faire." }, blocs));
});

Deno.test("amorceCoupee : même début, coupée en plein mot, avec …", () => {
  const s = "Le premier contrôle se fait depuis votre navigateur, avec un outil gratuit, et il révèle ce que le petit cadenas ne montre jamais.";
  const c = amorceCoupee(s);
  assert(c.endsWith("…"));
  assert(s.startsWith(c.slice(0, -1)));
  assert(c.length < s.length * 0.95 && c.length > s.length * 0.6);
});

Deno.test("coupure posée après le paragraphe de tension ; réécritures appliquées ; insertions après la coupure = payantes", () => {
  const lex = article(), blocs = extraireBlocs(lex);
  const corrections = [{ bloc: 8, md: "Premier conseil, **détaillé** avec un chiffre [1].", categories: ["premium"], resume: "x", details: [], sources: [] }];
  const insertions = [{ apres: 7, blocs: [{ t: "h3", md: "Si vous êtes épargnant" }, { t: "p", md: "Conseil payant nouveau." }], categories: ["premium"], resume: "y", details: [] }];
  const L = JSON.parse(JSON.stringify(lex));
  marquerCoupure(L, blocs, 7);
  const a = appliquer(L, blocs, corrections, insertions);
  assertEquals(a.conflits.length, 0);
  poserCoupure(a.lexical, "Le premier réflexe tient en une vérification de trente secondes, que presque personne ne fait.");
  const k = a.lexical.root.children;
  const types = k.map((n: { type: string; html?: string }) => n.type === "html" ? (String(n.html).includes("teaser-full") ? "full" : String(n.html).includes("teaser-cut") ? "cut" : "html") : n.type);
  const i = types.indexOf("paywall");
  assertEquals(types.slice(i - 2, i + 1), ["full", "cut", "paywall"]);
  assertEquals(k[i - 3].children[0].text, "Ce que ça change pour vous, et la vraie question : faut-il agir maintenant ?"); // tension juste avant
  assertEquals(k[i + 1].tag, "h3"); // insertion → après la coupure
  assert(!JSON.stringify(a.lexical).includes("__ph_coupure"));
  assert(JSON.stringify(a.lexical).includes("détaillé"));
  assertEquals(k[i - 2].visibility.email.memberSegment, "status:-free");
  assertEquals(k[i - 1].visibility.email.memberSegment, "status:free");
  assertEquals(k[i - 1].visibility.web.nonMember, false);
});

Deno.test("blocsPayants : au moins deux blocs de texte après la coupure", () => {
  const blocs = extraireBlocs(article());
  assertEquals(blocsPayants(blocs, 7, []), 3); // 2 paragraphes + intertitre Sources (avant la carte)
  assertEquals(blocsPayants(blocs, 9, []), 1);
  assertEquals(blocsPayants(blocs, 9, [{ apres: 9, blocs: [{}, {}] }]), 3);
});

Deno.test("noeudsCoupure : texte échappé", () => {
  const n = noeudsCoupure("Un <test> & co, assez long pour être une vraie phrase d’amorce.");
  assert(n[0].html.includes("&lt;test&gt; &amp; co"));
});

Deno.test("extraitGuide : garde 2, 4bis, 8, 9 (sans 9.5) et 10", () => {
  const g = "# Guide\n## 0. Préservation\nA\n## 2. Passe anti-IA\nB\n## 3. Fact\nC\n## 4. Vulgarisation\nD\n### 4bis. Lecteurs hors de France\nE\n## 8. Ton\nF\n## 9. Premium\nG\n### 9.5 Verrouillage\nOUTIL\n### 9.6 Interdits\nH\n## 10. Section finale\nI\n## 11. CTA\nJ";
  const x = extraitGuide(g);
  for (const k of ["B", "E", "F", "G", "H", "I"]) assert(x.includes(k), k);
  for (const k of ["Préservation", "Fact", "OUTIL", "CTA"]) assert(!x.includes(k), k);
});
