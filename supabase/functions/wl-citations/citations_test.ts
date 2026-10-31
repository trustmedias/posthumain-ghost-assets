// Tests hors ligne : deno test supabase/functions/wl-citations/citations_test.ts
import { assertEquals } from "jsr:@std/assert@1";
import { bilanValidation, echeanceDe, envoiDe, mailRelecture, passage, propsPropres } from "./citations.ts";

const demande = "2026-10-31T10:00:00Z";
const c = { etat: "a_valider", demandee_le: demande, envoyee_le: null, echeance: echeanceDe(new Date(demande)).toISOString() };
const hist = [{ t: "2026-10-31T11:00:00Z", e: "suite envoyée" }];

Deno.test("la date d'envoi vient de la première « suite envoyée » après la demande", () => {
  assertEquals(envoiDe(c, hist), "2026-10-31T11:00:00Z");
  assertEquals(envoiDe(c, [{ t: "2026-10-30T11:00:00Z", e: "suite envoyée" }]), null);
});
Deno.test("auto-validée 7 jours après l'envoi sans réponse, pas avant", () => {
  assertEquals(bilanValidation(c, { reponse_le: null }, hist, new Date("2026-11-07T10:00:00Z"))?.patch.etat, undefined);
  const r = bilanValidation(c, { reponse_le: "2026-10-30T10:00:00Z" }, hist, new Date("2026-11-08T10:00:00Z"));
  assertEquals(r?.patch.etat, "auto_validees");
  assertEquals(r?.patch.validation_mode, "auto_non_reponse");
});
Deno.test("pas d'auto-validation si le contact a répondu après l'envoi", () => {
  assertEquals(bilanValidation(c, { reponse_le: "2026-11-02T10:00:00Z" }, hist, new Date("2026-11-20T10:00:00Z"))?.patch.etat, undefined);
});
Deno.test("pas d'auto-validation tant que la demande n'est pas partie", () => {
  assertEquals(bilanValidation(c, {}, [], new Date("2026-12-01T10:00:00Z")), null);
});
Deno.test("propositions nettoyées et passages recopiés à l'identique dans le mail", () => {
  const p = propsPropres([{ apres: 3, texte: "X le confirme : « a ».", encart: true, encart_citation: "« a »" }, { apres: 5, intro: "Intro :", citation: "« b »", attribution: "Y" }, {}]);
  assertEquals(p.length, 2);
  const m = mailRelecture({ nom: "X", titre: "T", en: false, passages: p.map(passage), echeance: new Date(c.echeance) });
  assertEquals(m.includes("X le confirme : « a »."), true);
  assertEquals(m.includes("« b »"), true);
});
