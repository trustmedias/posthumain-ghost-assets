// Tests hors ligne de wl-mails/lexique.ts : deno test supabase/functions/wl-mails/lexique_test.ts
// (aucun accès réseau ; reproduit la forme réelle des mails de l'automation Ghost et de sa chaîne d'actions)
import { blocsValides, blocsVersLexical, canon, chaine, lexicalValide, lexicalVersBlocs, mdVersInline, nouvelleChaine } from "./lexique.ts";

// deno-lint-ignore no-explicit-any
type Any = any;
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const eq = (a: unknown, b: unknown, m: string) => { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) throw new Error(m + "\n  obtenu  : " + x + "\n  attendu : " + y); };

const t = (text: string, format = 0) => ({ detail: 0, format, mode: "normal", style: "", text, type: "extended-text", version: 1 });
const base = { direction: "ltr", format: "", indent: 0, version: 1 };
const lien = (url: string, ...children: Any[]) => ({ children, ...base, type: "link", version: 1, rel: null, target: null, title: null, url });
const para = (...children: Any[]) => ({ children, ...base, type: "paragraph" });
const VRAI = JSON.stringify({ root: { children: [
  para(t("Bienvenue sur Posthumain ! Merci de vous être abonné.")),
  para(t("Vous pouvez consulter "), lien("https://posthumain.com/", t("tous les contenus")), t(" et "), t("le gras", 1), t(", l'"), t("italique", 2), t(" ou "), t("les deux", 3), t(".")),
  para(t("Ligne 1"), { type: "linebreak", version: 1 }, t("Ligne 2 avec * étoile [crochet] et \\ barre")),
  { type: "horizontalrule", version: 1 },
  { children: [t("Intertitre")], ...base, type: "extended-heading", tag: "h3" },
  { children: [{ children: [t("un")], ...base, type: "listitem", value: 1 }, { children: [t("deux "), t("gras", 1)], ...base, type: "listitem", value: 2 }], ...base, type: "list", listType: "bullet", start: 1, tag: "ul" },
  { type: "image", version: 1, src: "https://posthumain.com/x.png" },
], ...base, type: "root" } });

Deno.test("aller-retour Lexical → blocs → Lexical sans perte (mise en page Ghost)", () => {
  const { blocs, protege } = lexicalVersBlocs(VRAI);
  eq(protege, 1, "seule l'image devient un bloc protégé");
  eq(blocs.map((b: Any) => b.t), ["p", "p", "p", "hr", "h", "ul", "raw"], "types de blocs");
  eq(blocs[1].md, "Vous pouvez consulter [tous les contenus](https://posthumain.com/) et **le gras**, l'*italique* ou ***les deux***.", "mini-balisage");
  eq(blocs[2].md, "Ligne 1\nLigne 2 avec \\* étoile \\[crochet\\] et \\\\ barre", "échappements");
  const re = blocsVersLexical(blocs, "ghost");
  eq(canon(JSON.parse(re).root), canon(JSON.parse(VRAI).root), "le contenu revient à l'identique");
  ok(!lexicalValide(re), "Lexical valide");
});

Deno.test("texte modifié dans l'éditeur → Lexical attendu", () => {
  const n = mdVersInline("Lisez **[notre enquête](https://posthumain.com/e/)** maintenant");
  eq(n.map((x: Any) => x.type), ["extended-text", "link", "extended-text"], "nœuds");
  eq(n[1].children[0].format, 1, "le gras englobe le lien");
  eq(n[1].url, "https://posthumain.com/e/", "url");
});

Deno.test("mise en page proposée « carte » : cartes HTML, bouton bulletproof, blocs protégés intacts", () => {
  const { blocs } = lexicalVersBlocs(VRAI);
  blocs.push({ t: "bouton", label: "Découvrir Premium", url: "https://posthumain.com/#/portal/signup" });
  const lex = JSON.parse(blocsVersLexical(blocs, "carte"));
  const ch = lex.root.children;
  ok(ch.slice(0, 6).every((n: Any) => n.type === "html"), "blocs éditables rendus en cartes HTML");
  eq(ch[6].type, "image", "bloc protégé recopié tel quel");
  ok(/mso-text-raise/.test(ch[7].html) && /data-wl-bouton/.test(ch[7].html), "bouton du Grand Format (Outlook)");
  ok(/&nbsp;!/.test(ch[0].html), "espace insécable avant « ! »");
  const back = lexicalVersBlocs(JSON.stringify(lex));
  eq(back.blocs[7], { t: "bouton", url: "https://posthumain.com/#/portal/signup", label: "Découvrir Premium" }, "le bouton se relit en bloc bouton");
});

Deno.test("validation des blocs", () => {
  ok(blocsValides([{ t: "p", md: "x [a](javascript:alert`1`)" }]), "lien javascript refusé");
  eq(mdVersInline("[a](javascript:alert(1))").map((x: Any) => x.type), ["extended-text"], "lien avec parenthèses : reste du texte");
  ok(blocsValides([{ t: "bouton", label: "x", url: "http://a.b" }]), "bouton http refusé");
  ok(!blocsValides([{ t: "p", md: "ok [a](https://posthumain.com/)" }, { t: "hr" }]), "blocs corrects acceptés");
  ok(blocsValides([]), "mail vide refusé");
});

Deno.test("mise en page « carte » : un paragraphe qui n'est qu'un lien devient le bouton du Grand Format", () => {
  const lex = JSON.parse(blocsVersLexical([{ t: "p", md: "[**Lire l'enquête →**](https://posthumain.com/e/)" }, { t: "p", md: "Voir [ici](https://posthumain.com/x/) et ailleurs" }], "carte"));
  ok(/data-wl-bouton/.test(lex.root.children[0].html) && />Lire l&#39;enquête →<|>Lire l'enquête →</.test(lex.root.children[0].html), "bouton avec le texte du lien");
  ok(!/data-wl-bouton/.test(lex.root.children[1].html), "un lien dans une phrase reste un lien");
  const back = lexicalVersBlocs(JSON.stringify(lex));
  eq(back.blocs[0], { t: "bouton", url: "https://posthumain.com/e/", label: "Lire l'enquête →" }, "relu comme bouton");
});

// Chaîne réelle de l'automation « Free member welcome flow » (23/10/2026) : attente 24 h → mail 1 → attente 168 h → mail 2
const W1 = "6a3be58303d66a6735fd5c08", M1 = "6a3be51b07db2c00017282ae", W2 = "6a3d42691c00d35ab500d9d8", M2 = "6a3d42721c00d35ab500d9d9";
const AUTO = { status: "active", actions: [
  { id: M1, type: "send_email", data: { email_subject: "Bienvenue sur Posthumain", email_lexical: "L1", email_design_setting_id: "D" } },
  { id: W1, type: "wait", data: { wait_hours: 24 } },
  { id: W2, type: "wait", data: { wait_hours: 168 } },
  { id: M2, type: "send_email", data: { email_subject: "40 métiers", email_lexical: "L2", email_design_setting_id: "D" } },
], edges: [{ source_action_id: W1, target_action_id: M1 }, { source_action_id: M1, target_action_id: W2 }, { source_action_id: W2, target_action_id: M2 }] };
const items = (a1: boolean, j1: number, a2: boolean, j2: number) => [
  { type: "bienvenue_1", actif: a1, jours: j1, action_id: M1, sujet: "Bienvenue sur Posthumain", lexical: "L1", design: "D" },
  { type: "bienvenue_2", actif: a2, jours: j2, action_id: M2, sujet: "40 métiers", lexical: "L2", design: "D" },
];
const sig = (r: Any) => chaine({ actions: r.actions, edges: r.edges }).map((x: Any) => (x.type === "wait" ? "w" + x.data.wait_hours : x.id === M1 ? "M1" : x.id === M2 ? "M2" : "M?")).join(" ") + " /" + r.status;

Deno.test("chaîne : réglages actuels (J+1, J+8) → automation inchangée", () => {
  const r = nouvelleChaine(AUTO, items(true, 1, true, 8));
  eq(sig(r), "w24 M1 w168 M2 /active", "même chaîne");
  eq(r.actions.map((x: Any) => x.id), [W1, M1, W2, M2], "mêmes identifiants Ghost (aucune action recréée)");
});
Deno.test("chaîne : délais modifiés (J+2, J+5)", () => eq(sig(nouvelleChaine(AUTO, items(true, 2, true, 5))), "w48 M1 w72 M2 /active", "délais cumulés"));
Deno.test("chaîne : mail 1 désactivé → mail 2 seul à J+8", () => eq(sig(nouvelleChaine(AUTO, items(false, 1, true, 8))), "w192 M2 /active", "mail 2 seul"));
Deno.test("chaîne : mail 2 désactivé → mail 1 seul", () => eq(sig(nouvelleChaine(AUTO, items(true, 1, false, 8))), "w24 M1 /active", "mail 1 seul"));
Deno.test("chaîne : les deux désactivés → automation en pause, actions conservées", () => {
  const r = nouvelleChaine(AUTO, items(false, 1, false, 8));
  eq(r.status, "inactive", "pause");
  eq(r.actions, AUTO.actions, "actions conservées");
});
Deno.test("chaîne : ordre inversé (mail 2 avant mail 1)", () => eq(sig(nouvelleChaine(AUTO, items(true, 9, true, 3))), "w72 M2 w144 M1 /active", "ordre par délai"));
Deno.test("chaîne : un mail réactivé hors chaîne reçoit un nouvel identifiant", () => {
  const its = items(true, 1, true, 8); its[1].action_id = null as unknown as string;
  const r = nouvelleChaine(AUTO, its);
  ok(/^[0-9a-f]{24}$/.test(String(its[1].action_id)) && its[1].action_id !== M2, "identifiant Ghost de 24 hexadécimaux");
  eq(r.actions.length, 4, "4 actions");
});
