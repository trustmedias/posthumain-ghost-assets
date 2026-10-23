// Writinglab — canal de la réponse dans le texte inséré (23/10/2026, consigne de Jonathan, 10:35).
// citation : le canal est précisé UNE seule fois par personne, à sa première citation dans l'article (et, si elle a répondu par les deux
// canaux, à la première citation venant du second canal) ; jamais répété ensuite ; jamais affirmé s'il n'est pas précisé.
// chapo (mention des experts en début d'article) : le canal n'est JAMAIS précisé (« Nous avons posé la question à X et Y. »).
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
if (!it || !it.ok || !it.body || !Array.isArray(it.body.messages) || !['citation', 'chapo'].includes(it.mode)) return [{ json: it }];
const msg = it.body.messages[0], u = String(msg.content || ''), k = u.lastIndexOf('JSON :');
const inserer = (t) => { msg.content = k > 0 ? u.slice(0, k) + t + '\n' + u.slice(k) : u + t; };
if (it.mode === 'chapo') {
  inserer('\nCANAL : ne précise JAMAIS comment les experts ont été interrogés (ni téléphone, ni e-mail, ni entretien) : par exemple « Nous avons posé la question à X et Y. » ou « Pour cet article, Posthumain a interrogé X. »');
  return [{ json: it }];
}
let f = null; try { f = $('Fiche — lire').first().json; } catch (e) { f = null; }
let post = null; try { const g = $('Ghost — article').first().json; post = g && Array.isArray(g.posts) ? g.posts[0] : null; } catch (e) { post = null; }
const c = canalDe(f);
// Déjà cité ? Fiche déjà insérée, ou son nom de famille présent dans l'article ; canal déjà mentionné dans la citation insérée.
const nom = String((f && f.contact_nom) || '').trim(), famille = nom.split(/\s+/).filter((w) => w.length > 2).pop() || '';
let texteArt = ''; try { const lx = JSON.parse((post && post.lexical) || '{}'); const t = (n) => n ? (typeof n.text === 'string' ? n.text : '') + (Array.isArray(n.children) ? n.children.map(t).join(' ') : '') : ''; texteArt = t(lx.root); } catch (e) { texteArt = ''; }
const cit = String((f && f.citation) || '');
const deja = !!(f && f.statut === 'inséré') || (!!famille && texteArt.toLowerCase().includes(famille.toLowerCase()));
const dit = (re) => re.test(cit) || (famille && new RegExp(famille.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[^.]{0,160}' + re.source + '|' + re.source + '[^.]{0,160}' + famille.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(texteArt));
const telDit = dit(/t[ée]l[ée]phon|appel/i), mailDit = dit(/e-?mail|courriel|par écrit|réponse écrite/i);
const NOMS = { email: 'par e-mail (réponse écrite)', telephone: 'par téléphone (propos recueillis lors d’un entretien téléphonique)', 'email+telephone': 'par e-mail ET par téléphone', personne: 'de vive voix, en personne', non_precise: 'non précisé' };
let t = '\nCANAL DE LA RÉPONSE : ' + (NOMS[c] || NOMS.non_precise) + '.\n';
if (!c || c === 'non_precise') t += 'Le canal n’est pas précisé : n’affirme RIEN sur la façon dont la réponse a été obtenue (ni téléphone, ni e-mail, ni entretien) ; attribue simplement (« explique X », « selon X »).';
else {
  const restant = c === 'email+telephone' ? [!mailDit && 'e-mail', !telDit && 'téléphone'].filter(Boolean) : (deja && ((c === 'telephone' && telDit) || (c === 'email' && mailDit) || (c === 'personne' && /personne|rencontr/i.test(cit)))) ? [] : [c === 'email' ? 'e-mail' : c === 'telephone' ? 'téléphone' : 'en personne'];
  t += 'Règle : comme dans un article de presse, le canal se précise UNE SEULE FOIS par personne, juste avant ou juste après sa PREMIÈRE citation dans l’article, puis on ne le répète plus. '
    + (deja ? nom + ' est DÉJÀ cité(e) dans l’article' + (restant.length ? ', mais le canal « ' + restant.join(' » et « ') + ' » n’y a pas encore été précisé.' : ' et son canal y est déjà précisé : n’en parle plus du tout dans ces nouveaux extraits.') + ' ' : '')
    + (restant.length ? 'Précise le canal « ' + restant.join(' » puis « ') + ' » une seule fois, à la première citation (dans l’ordre de l’article) qui vient de ce canal ; les autres extraits n’en parlent pas. ' : '')
    + (c === 'email+telephone' ? 'La réponse contient les deux canaux : les passages placés après un en-tête « 📞 Réponse reçue par téléphone » (ou « Answer received by phone ») ont été dits au téléphone ; le reste a été écrit par e-mail. ' : '')
    + (!restant.length ? '' : 'Tournures sobres et variées, à adapter (ne recopie pas mot pour mot, ne reprends pas une tournure déjà présente dans l’article) : « …, nous a répondu X dans un e-mail adressé à Posthumain », « …, explique X dans le cadre d’un entretien téléphonique », « joint par téléphone, X précise que… », « interrogée par courriel, X souligne… », « dans sa réponse écrite à Posthumain ». ')
    + 'Ajoute dans chaque insertion les champs "canal" (« email », « telephone » ou « personne » : le canal d’OÙ vient cet extrait) et "canal_precise" (true seulement si ce texte mentionne le canal).';
}
inserer(t);
return [{ json: it }];
