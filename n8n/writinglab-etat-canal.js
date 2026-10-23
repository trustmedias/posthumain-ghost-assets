// Writinglab — canal de chaque réponse pour la page (23/10/2026) : « Reçue par » dans la fiche (pré-rempli, modifiable).
const J = (s, d) => { try { const v = JSON.parse(s); return v == null ? d : v; } catch (e) { return d; } };
// Canal de la réponse (23/10/2026) : choix fait à la main dans la fiche, sinon déduit des preuves ; jamais deviné.
// email = réponse arrivée par le fil du mail (relève) ou réponse vérifiée par les en-têtes ; telephone = marqueur « reçue par téléphone ».
const canalDe = (r) => {
  r = r || {};
  const h = J(r.historique, []), rep = String(r.reponse || '');
  let pv = r.reponse_preuve; if (typeof pv === 'string') pv = J(pv, null);
  const tel = !!(pv && pv.lien === 'telephone') || (Array.isArray(h) && h.some((e) => /réponse reçue par téléphone/i.test(String((e && e.e) || '')))) || /📞 (Réponse reçue par téléphone|Answer received by phone)/.test(rep);
  const mail = ((r.reponse_verifiee === true || r.reponse_verifiee === 'true') && !(pv && pv.lien === 'telephone')) || (Array.isArray(h) && h.some((e) => e && e.par === 'courrier' && /réponse reçue/i.test(String(e.e || ''))));
  const choix = String(r.reponse_canal || '');
  if (choix) return choix === 'email' && tel ? 'email+telephone' : choix;
  return tel && mail ? 'email+telephone' : tel ? 'telephone' : mail ? 'email' : rep ? 'non_precise' : '';
};
const it = $input.first().json;
if (!it || !Array.isArray(it.fiches)) return [{ json: it }];
const rows = {}; for (const i of $('Fiches — toutes').all()) { const r = i.json; if (r && r.fiche_id) rows[r.fiche_id] = r; }
it.fiches = it.fiches.map((f) => { const r = rows[f.fiche_id] || {}; return Object.assign(f, { canal: canalDe(r), canal_choisi: String(r.reponse_canal || '') }); });
return [{ json: it }];
