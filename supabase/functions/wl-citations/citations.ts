// Writinglab — propositions de citations gardées par fiche et leur validation par le contact (31/10/2026, demande de Jonathan et Valisoa).
// Avant : les propositions vivaient dans la page et disparaissaient à la fermeture. Désormais chaque fiche garde ses propositions
// (table wl_citations) et leur validation :
//   proposees    → l'Assistant a proposé ; rien n'est encore demandé au contact ;
//   a_valider    → relecture demandée au contact (mail préparé dans le fil de la fiche, ou « déjà envoyé » par la journaliste) ;
//   validees     → le contact a validé (confirmé par la journaliste) ;
//   auto_validees→ aucune réponse du contact 7 jours après l'ENVOI de la demande (et au plus tôt à la date annoncée dans le mail) :
//                  validation automatique, tracée dans l'historique de la fiche (« auto-validées par non-réponse »).
// Insérer sans attendre reste possible (court-circuit), tracé lui aussi à l'insertion.
// Fonctions pures (testées hors ligne : deno test supabase/functions/wl-citations/citations_test.ts).

export const CIT_JOURS = 7;
const J = 864e5;

// deno-lint-ignore no-explicit-any
const txt = (v: any, n: number) => String(v == null ? "" : v).slice(0, n);

// Une proposition : nouveau format (texte = paragraphe inséré, citation entre « » dans la phrase ; encart facultatif, un seul par
// article) ou ancien format (intro + citation + attribution), gardé pour les propositions faites avant le 31/10/2026.
// deno-lint-ignore no-explicit-any
export function propPropre(x: any) {
  if (!x || typeof x !== "object") return null;
  const apres = Math.round(Number(x.apres));
  const p = {
    apres: Number.isFinite(apres) ? apres : -1, ancre: txt(x.ancre, 200), avant: txt(x.avant, 3000), ensuite: txt(x.ensuite, 1500), ensuite_type: txt(x.ensuite_type, 40),
    texte: txt(x.texte, 4000), encart: x.encart === true, encart_citation: txt(x.encart_citation, 600),
    intro: txt(x.intro, 1200), citation: txt(x.citation, 3000), attribution: txt(x.attribution, 300),
    note: txt(x.note, 300), pourquoi: txt(x.pourquoi, 400), canal: txt(x.canal, 20),
    fait: x.fait === true, fait_le: txt(x.fait_le, 40), skip: x.skip === true,
  };
  if (!p.texte && !p.citation) return null;
  return p;
}
// deno-lint-ignore no-explicit-any
export function propsPropres(l: any): any[] { return (Array.isArray(l) ? l : []).map(propPropre).filter(Boolean).slice(0, 8); }

// Le passage tel qu'il apparaîtra dans l'article (pour le mail de relecture et l'historique).
// deno-lint-ignore no-explicit-any
export function passage(x: any): string {
  if (x.texte) return x.texte; // l'exergue reprend une phrase du paragraphe : rien de plus à faire relire
  return [x.intro, x.citation, x.attribution ? "— " + x.attribution.replace(/^[—–-]\s*/, "") : ""].filter(Boolean).join("\n");
}

// Date lisible dans la langue du contact (heure de Zurich).
export function dateLongue(d: Date, en: boolean) {
  return d.toLocaleDateString(en ? "en-GB" : "fr-CH", { weekday: "long", day: "numeric", month: "long", timeZone: "Europe/Zurich" });
}
// Échéance annoncée : 7 jours plus tard, en fin de journée (heure de Zurich, ~23:59).
export function echeanceDe(depuis: Date) {
  const d = new Date(depuis.getTime() + CIT_JOURS * J);
  const jour = d.toLocaleDateString("en-CA", { timeZone: "Europe/Zurich" }); // AAAA-MM-JJ
  return new Date(jour + "T22:59:00Z"); // 23:59 en hiver (UTC+1), 00:59 le lendemain en été : jamais avant la date annoncée
}

// Mail de demande de relecture : texte fixe (les passages sont recopiés à l'identique, jamais reformulés par une IA).
// deno-lint-ignore no-explicit-any
export function mailRelecture(o: { nom: string; titre: string; en: boolean; passages: string[]; echeance: Date }) {
  const date = dateLongue(o.echeance, o.en);
  const liste = o.passages.map((p, i) => "Passage " + (i + 1) + (o.en ? ":" : " :") + "\n" + p).join("\n\n");
  if (o.en) {
    return "Dear " + (o.nom || "Sir or Madam") + ",\n\nThank you again for your answers. For your review, here are the passages we plan to publish in our article “" + o.titre +
      "”, exactly as they will appear (in French, translated from your answers):\n\n" + liste +
      "\n\nPlease let us know of any correction by " + date + ". If we do not hear from you by then, we will assume these passages are fine with you. " +
      "Should you notice anything after publication, we will of course correct it.\n\nBest regards,";
  }
  return "Bonjour " + (o.nom || "Madame, Monsieur") + ",\n\nMerci encore pour vos réponses. Voici, pour relecture, les passages que nous prévoyons de publier dans notre article « " + o.titre +
    " », tels qu’ils apparaîtront :\n\n" + liste +
    "\n\nN’hésitez pas à nous signaler toute correction d’ici le " + date + ". Sans retour de votre part à cette date, nous considérerons que ces passages vous conviennent. " +
    "Si vous remarquez quoi que ce soit après la publication, nous le corrigerons bien sûr volontiers.\n\nBien cordialement,";
}

// Date d'envoi réelle de la demande : celle fixée à la main (« déjà envoyée »), sinon la première « suite envoyée » de l'historique
// après la préparation du mail de relecture.
// deno-lint-ignore no-explicit-any
export function envoiDe(c: any, hist: any[]): string | null {
  if (c.envoyee_le) return String(c.envoyee_le);
  if (!c.demandee_le) return null;
  const d = String(new Date(c.demandee_le).toISOString());
  const ev = (Array.isArray(hist) ? hist : []).filter((e) => e && e.e === "suite envoyée" && String(e.t || "") >= d).map((e) => String(e.t)).sort()[0];
  return ev || null;
}

// Où en est la validation à l'instant « now » ? Ne modifie rien : renvoie le changement à enregistrer (ou null).
// deno-lint-ignore no-explicit-any
export function bilanValidation(c: any, f: any, hist: any[], now: Date) {
  if (!c || c.etat !== "a_valider") return null;
  const env = envoiDe(c, hist);
  // deno-lint-ignore no-explicit-any
  const patch: any = {};
  if (env && !c.envoyee_le) patch.envoyee_le = env;
  if (!env) return Object.keys(patch).length ? { patch } : null;
  const e0 = new Date(env).getTime();
  const auto = Math.max(e0 + CIT_JOURS * J, c.echeance ? new Date(c.echeance).getTime() : 0);
  const repondu = !!(f && f.reponse_le && new Date(f.reponse_le).getTime() > e0);
  if (!repondu && now.getTime() >= auto) {
    patch.etat = "auto_validees"; patch.validee_le = new Date(auto).toISOString(); patch.validation_mode = "auto_non_reponse"; patch.validee_par = "auto";
    return { patch, auto: true, envoyee_le: env };
  }
  return Object.keys(patch).length ? { patch } : null;
}
