// Tests hors ligne du découpage en blocs et de l'application des corrections (wl-relecture/blocs.ts).
// deno test supabase/functions/wl-relecture/blocs_test.ts
import { appliquer, extraireBlocs, normaliserCorrections } from "./blocs.ts";

const t = (text: string, format = 0) => ({ detail: 0, format, mode: "normal", style: "", text, type: "extended-text", version: 1 });
const p = (...children: unknown[]) => ({ children, direction: "ltr", format: "", indent: 0, type: "paragraph", version: 1 });
const lien = (url: string, txt: string) => ({ children: [t(txt)], direction: "ltr", format: "", indent: 0, type: "link", version: 1, rel: "noreferrer", target: "_blank", title: null, url });
const CTA = '<div class="kg-card kg-cta-card"><a href="#/portal/signup/monthly">S\'abonner</a></div>';
const FOOT = '<style>.ph-web-complex{}</style><!--[if mso]><table></table><![endif]--><div class="ph-web-complex" data-ph-premium-auto>Abonnez-vous</div>';
const SOURCES = '<ol><li id="source-1"><a href="https://techcrunch.com/2026/10/01/x">techcrunch.com</a> — Article</li><li id="source-2"><a href="https://www.cnbc.com/y">cnbc.com</a></li></ol>';
const LEX = { root: { children: [
  p(t("OpenAI a annoncé "), t("un nouveau modèle", 1), t(" mardi.")),
  { children: [t("Pourquoi c'est important")], direction: "ltr", format: "", indent: 0, type: "extended-heading", version: 1, tag: "h2" },
  p(t("Selon la société, il est "), t("deux fois", 1), t(" plus rapide "), t("["), lien("#source-1", "1"), t("].")),
  { type: "html", version: 1, html: CTA, visibility: { web: { nonMember: true, memberSegment: "status:free" }, email: { memberSegment: "status:free" } } },
  { children: [{ children: [t("Point un")], direction: "ltr", format: "", indent: 0, type: "listitem", version: 1, value: 1 }, { children: [t("Point deux")], direction: "ltr", format: "", indent: 0, type: "listitem", version: 1, value: 2 }], direction: "ltr", format: "", indent: 0, type: "list", version: 1, listType: "bullet", start: 1, tag: "ul" },
  { type: "image", version: 1, src: "https://posthumain.com/content/images/2026/10/chart-x-1.jpg", alt: "Graphique", caption: "<span>Source : CNBC</span>", width: 2000, height: 1200, cardWidth: "regular" },
  p(t("Texte "), t("souligné", 8)),
  { type: "html", version: 1, html: FOOT },
  { type: "horizontalrule", version: 1 },
  p(t("Sources principales", 1)),
  { type: "html", version: 1, html: SOURCES },
], direction: "ltr", format: "", indent: 0, type: "root", version: 1 } };

function egal(a: unknown, b: unknown, msg: string) { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) throw new Error(msg + "\n attendu : " + y + "\n obtenu  : " + x); }

Deno.test("découpage : texte modifiable, encarts et images protégés, sources modifiables", () => {
  const b = extraireBlocs(LEX);
  egal(b.map((x) => x.t), ["p", "h2", "p", "protege", "ul", "protege", "protege", "protege", "protege", "p", "sources"], "types");
  egal(b[0].md, "OpenAI a annoncé **un nouveau modèle** mardi.", "gras");
  egal(b[2].md, "Selon la société, il est **deux fois** plus rapide \\[[1](#source-1)\\].", "appel de source");
  egal(b[3].genre, "encart d'abonnement (CTA)", "CTA protégé");
  egal(b[5].genre, "graphique", "graphique");
  egal(b[6].genre, "paragraphe à mise en forme spéciale (non modifiable ici)", "souligné protégé");
  egal(b[7].genre, "encart d'abonnement (CTA)", "footer protégé");
});

Deno.test("corrections : appliquées bloc par bloc, encarts intacts (visibilité comprise), liens restitués", () => {
  const avant = extraireBlocs(LEX);
  const raw = { corrections: [
    { bloc: 0, md: "OpenAI a dévoilé **un nouveau modèle** mardi 21 octobre.", categories: ["redaction"], resume: "date précisée" },
    { bloc: 2, md: "D'après la société, il est **deux fois** plus rapide \\[[1](#source-1)\\].", categories: ["redaction"], resume: "tournure" },
    { bloc: 3, md: "pirate", categories: ["redaction"], resume: "ne doit pas passer" },
    { bloc: 4, items: ["Premier point", "Deuxième point", "Troisième"], categories: ["sommaire"], resume: "liste" },
    { bloc: 10, html: SOURCES.replace("https://www.cnbc.com/y", "https://www.reuters.com/z").replace("cnbc.com<", "reuters.com<"), categories: ["sources"], resume: "source remplacée" },
  ], insertions: [{ apres: 0, blocs: [{ t: "p", md: "**Dans cet article :**" }, { t: "ul", items: ["Pourquoi c'est important"] }], categories: ["sommaire"], resume: "sommaire" }] };
  const n = normaliserCorrections(raw, avant);
  egal(n.corrections.map((c) => c.bloc), [0, 2, 4, 10], "le bloc protégé est rejeté");
  egal(n.rejets.length, 1, "un rejet");
  const r = appliquer(LEX, avant, n.corrections, n.insertions);
  egal(r.conflits, [], "aucun conflit");
  const apres = extraireBlocs(r.lexical);
  egal(apres.length, 13, "deux blocs insérés");
  egal(apres[0].md, "OpenAI a dévoilé **un nouveau modèle** mardi 21 octobre.", "bloc 0");
  egal(apres[1].md, "**Dans cet article :**", "sommaire inséré après le bloc 0");
  egal(apres[2].items, ["Pourquoi c'est important"], "liste du sommaire");
  egal(apres[4].md, "D'après la société, il est **deux fois** plus rapide \\[[1](#source-1)\\].", "bloc 2");
  const l = r.lexical.root.children[4].children.find((x: { type: string }) => x.type === "link");
  egal([l.url, l.rel, l.target], ["#source-1", "noreferrer", "_blank"], "attributs du lien gardés");
  egal(r.lexical.root.children[5], LEX.root.children[3], "CTA identique, visibilité comprise");
  egal(r.lexical.root.children[9], LEX.root.children[7], "footer identique");
  egal(apres[6].items, ["Premier point", "Deuxième point", "Troisième"], "liste corrigée");
  egal(r.lexical.root.children[12].html.includes("reuters.com/z"), true, "sources corrigées");
});

Deno.test("conflit : un bloc modifié dans Ghost entre-temps n'est pas écrasé", () => {
  const avant = extraireBlocs(LEX);
  const modifie = JSON.parse(JSON.stringify(LEX));
  modifie.root.children[0].children[2].text = " mercredi."; // la journaliste a corrigé entre-temps
  modifie.root.children.splice(1, 0, p(t("Nouveau paragraphe ajouté par la journaliste.")));
  const n = normaliserCorrections({ corrections: [
    { bloc: 0, md: "OpenAI a dévoilé **un nouveau modèle** mardi.", categories: ["redaction"], resume: "x" },
    { bloc: 2, md: "Selon elle, il est **deux fois** plus rapide \\[[1](#source-1)\\].", categories: ["redaction"], resume: "y" },
  ] }, avant);
  const r = appliquer(modifie, avant, n.corrections, n.insertions);
  egal(r.conflits.length, 1, "le bloc 0 est en conflit");
  egal(r.appliquees, [1], "le bloc 2 (décalé d'une place) est retrouvé et corrigé");
  egal(extraireBlocs(r.lexical)[3].md, "Selon elle, il est **deux fois** plus rapide \\[[1](#source-1)\\].", "corrigé à sa nouvelle place");
  egal(extraireBlocs(r.lexical)[0].md, "OpenAI a annoncé **un nouveau modèle** mercredi.", "le texte de la journaliste est intact");
});

Deno.test("alertes : gras perdu et cadratin introduit", () => {
  const avant = extraireBlocs(LEX);
  const n = normaliserCorrections({ corrections: [{ bloc: 0, md: "OpenAI a annoncé un nouveau modèle — mardi.", categories: ["redaction"], resume: "x" }] }, avant);
  egal(n.corrections[0].alertes, ["gras en moins dans ce bloc", "tiret cadratin « — » introduit"], "alertes");
});

Deno.test("graphique refait : l'image est remplacée à sa place, le reste ne bouge pas", async () => {
  const { remplacerImage, dimensionsImage } = await import("./blocs.ts");
  const lex = JSON.parse(JSON.stringify(LEX));
  const ok = remplacerImage(lex, "https://posthumain.com/content/images/2026/10/chart-x-1.jpg", { src: "https://posthumain.com/content/images/2026/10/chart-x-1-corrige.jpg", largeur: 1600, hauteur: 1000, legende: "Source : CNBC (corrigé) & co" });
  egal(ok, true, "trouvée");
  egal([lex.root.children[5].src, lex.root.children[5].width, lex.root.children[5].caption], ["https://posthumain.com/content/images/2026/10/chart-x-1-corrige.jpg", 1600, '<span style="white-space: pre-wrap;">Source : CNBC (corrigé) &amp; co</span>'], "remplacée");
  egal(lex.root.children[3], LEX.root.children[3], "CTA intact");
  egal(remplacerImage(lex, "https://autre.jpg", { src: "x" }), false, "image absente");
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 6, 64, 0, 0, 3, 232, 8, 2]);
  egal(dimensionsImage(png), { largeur: 1600, hauteur: 1000 }, "dimensions PNG");
  const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 17, 8, 3, 232, 6, 64, 3]);
  egal(dimensionsImage(jpg), { largeur: 1600, hauteur: 1000 }, "dimensions JPEG");
});
