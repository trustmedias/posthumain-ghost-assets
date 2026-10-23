/* WRITINGLAB — la rédaction de Posthumain, vue de haut (20/10/2026, demande de Jonathan).
   Même principe que le Videolab (un bureau où chaque agent IA est un employé, ses fiches flottent au-dessus de sa tête),
   mais un outil à part : il ne touche à rien du Videolab.
   Servi par le webhook n8n « Posthumain — Writinglab (la rédaction) » après vérification du compte membre Ghost.
   Toutes les actions passent par ce seul webhook (champ « mode »). Aucun secret ici.
   Employés : la journaliste, l'Assistant (questions, contacts), la Secrétaire (mails relus et validés avant envoi),
   le Courrier (suivi des réponses), le Marbre (les brouillons Ghost) et le bureau du rédacteur en chef. */
(function () {
  'use strict';
  var TZ = 'Europe/Zurich';
  // Briques communes avec le Videolab (shared/lab-core.js, envoyé par le webhook avec cette application) : échappement, liens sûrs,
  // jeton Ghost, appels Supabase, boutons occupés, confirmations, toasts, mode clair/sombre, défilement, porte de couloir.
  var PHL = window.PHLab;
  if (!PHL || !PHL.core) { window.WRITINGLAB_START = function (o) { if (window.WL_LOADER) window.WL_LOADER.fin(); o.root.innerHTML = '<div class="wl-boot"><b>WRITINGLAB</b><div>⚠️ Module partagé introuvable. Rechargez la page dans un instant.</div></div>'; }; return; }

  // ---------- outils ----------
  var esc = PHL.esc;
  function nl(s) { return esc(s).replace(/\n/g, '<br>'); }
  // Liens venus de l'extérieur (sources trouvées par l'IA sur le web) : seulement http(s), jamais « javascript: ».
  var url = PHL.url;
  function pl(n) { return n > 1 ? 's' : ''; }
  var fTime = new Intl.DateTimeFormat('fr-CH', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
  var fDay = new Intl.DateTimeFormat('fr-CH', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' });
  function hm(d) { return fTime.format(new Date(d)); }
  function day(d) { return fDay.format(new Date(d)); }
  function when(d) {
    if (!d) return '';
    var t = new Date(d).getTime(), s = Math.round((Date.now() - t) / 1000);
    if (isNaN(t)) return '';
    if (s < 0) return day(d) + ' ' + hm(d);
    if (s < 60) return 'à l’instant';
    if (s < 3600) return 'il y a ' + Math.round(s / 60) + ' min';
    if (s < 86400) return 'il y a ' + Math.round(s / 3600) + ' h';
    if (s < 7 * 86400) return 'il y a ' + Math.round(s / 86400) + ' j';
    return day(d);
  }
  var LS = {
    get: function (k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { if (v == null) window.localStorage.removeItem(k); else window.localStorage.setItem(k, v); } catch (e) { /* stockage indisponible */ } }
  };
  function uid() { return Math.random().toString(36).slice(2, 9); }

  // ---------- état ----------
  var S = {
    data: null, call: null, root: null, portee: LS.get('wl-portee') || '', tab: LS.get('wl-tab') || 'bureau', art: LS.get('wl-article') || '',
    busy: {}, last: 0, panel: null,
    contact: null, contacts: null, qs: [], angle: '', echeance: '', consigneSec: '', reformule: null,
    libre: { nom: '', email: '', role: '', institution: '', langue: 'fr', consigne: '', echeance: '' },
    doc: null, cit: null, colle: false
  };

  function D() { return S.data || { me: {}, equipe: [], articles: [], fiches: [], messages: [], courrier: [], campagnes: [], prospects: [] }; }
  function prospect(id) { return (D().prospects || []).filter(function (x) { return x.prospect_id === id; })[0] || null; }
  function campagne(id) { return (D().campagnes || []).filter(function (x) { return x.campagne_id === id; })[0] || null; }
  function mails(boite, tous) { return (D().courrier || []).filter(function (m) { return m.boite === boite && (tous || m.statut !== 'répondu'); }); }
  function mail(id) { return (D().courrier || []).filter(function (m) { return m.mail_id === id; })[0] || null; }
  var JULIEN = { sc: { boite: 'subs', nom: 'Julien · Service client', adr: 'subs@posthumain.com', emoji: '🎧' }, mk: { boite: 'redaction', nom: 'Julien · Marketing', adr: 'redaction@posthumain.com', emoji: '📣' } };
  // Boîtes mail ajoutées depuis le lab (23/10/2026, table wl_boites) : leur courrier (boite « x-… ») va au bureau de leur rôle (mk / sc).
  function boitesLab() { return D().boites || []; }
  function boiteLab(id) { return boitesLab().filter(function (b) { return b.id === id; })[0] || null; }
  function bureauDe(boite) { if (boite === 'subs') return 'sc'; if (boite === 'redaction') return 'mk'; var b = boiteLab(boite); return b && (b.role === 'mk' || b.role === 'sc') ? b.role : null; }
  function mailsBureau(k, tous) { return (D().courrier || []).filter(function (m) { return bureauDe(m.boite) === k && (tous || m.statut !== 'répondu'); }); }
  function adressesBureau(k) { return [JULIEN[k].adr].concat(boitesLab().filter(function (b) { return b.role === k && b.actif !== false; }).map(function (b) { return b.adresse; })); }
  // Articles du plus récent (dernière modification dans Ghost) au plus ancien : en haut du Marbre, à gauche dans l'onglet Articles.
  function artsRecents() { return D().articles.slice().sort(function (x, y) { return String(y.maj || '').localeCompare(String(x.maj || '')); }); }
  // Enquêtes premium (brouillons payants) sans aucune fiche de contact : la rédaction doit lancer les interviews.
  function premium(a) { return ['paid', 'tiers', 'members'].indexOf(String(a.visibilite || '')) >= 0; }
  function aInterviewer() { return artsRecents().filter(function (a) { return premium(a) && !D().fiches.some(function (f) { return f.article_id === a.id; }); }); }
  function art(id) { return D().articles.filter(function (a) { return a.id === id; })[0] || null; }
  function fiche(id) { return D().fiches.filter(function (f) { return f.fiche_id === id; })[0] || null; }
  // Portée (rédacteur en chef) : « Mes fiches » ou « Toute la rédaction ». Valisoa ne reçoit de toute façon que les siennes.
  function portee() { return S.portee || (D().me.chef ? 'tous' : 'moi'); }
  function vues() { var me = D().me; return D().fiches.filter(function (f) { return portee() !== 'moi' || f.redacteur === me.id; }); }
  // Lecture pour tous, actions pour le propriétaire de la fiche (ou le rédacteur en chef) : le serveur applique la même règle.
  function peut(f) { var me = D().me; return !!(me.chef || (f && f.redacteur === me.id)); }
  function lectureSeule(qui) { return '<div class="box" style="margin:10px 0;border-color:rgba(120,170,255,.35)">👁️ Lecture seule' + (qui ? ' : ' + esc(qui) : '') + '. Vous pouvez tout consulter ; seules les actions vous sont réservées selon votre rôle.</div>'; }
  function by(st) { return vues().filter(function (f) { return f.statut === st; }); }
  // Origine d'une fiche : préparation express, Assistant (questions choisies) ou message direct à la Secrétaire.
  function origine(f) {
    if ((f.historique || []).some(function (e) { return /^préparé en express/.test(String(e.e || '')); })) return ['⚡', 'Express'];
    return f.questions && f.questions.length ? ['🧠', 'Assistant'] : ['✍️', 'Message direct'];
  }
  function qui(f) { return f.redacteur === D().me.id ? 'vous' : membre(f.redacteur).nom; }
  // Questions telles qu'elles partent dans le mail (lignes numérotées « 1. … ») : traduites si le chercheur ne parle pas français.
  function questionsEnvoyees(f) {
    var out = [], n = 1;
    String(f.mail_corps || '').split('\n').forEach(function (l) { var m = l.match(/^\s*(\d{1,2})[.)]\s+(.+)$/); if (m && Number(m[1]) === n) { out.push(m[2].trim()); n++; } });
    return out;
  }
  // Dossiers : les fiches regroupées par article, du plus récemment touché au plus ancien.
  function dossiers(list) {
    var m = {}, ordre = [];
    list.forEach(function (f) { var k = f.article_id || '—'; if (!m[k]) { m[k] = { id: f.article_id || '', titre: f.article_titre || 'Sans article', fiches: [], maj: '' }; ordre.push(k); } m[k].fiches.push(f); if (String(f.maj) > m[k].maj) m[k].maj = String(f.maj); });
    return ordre.map(function (k) { return m[k]; }).sort(function (a, b) { return b.maj.localeCompare(a.maj); });
  }
  function avancement(fs) {
    var c = function (st) { return fs.filter(function (f) { return f.statut === st; }).length; };
    return '<span class="av"><b class="' + (c('brouillon') ? 'a' : '') + '">🟠 ' + c('brouillon') + ' à valider</b><b>📨 ' + c('envoyé') + ' envoyé' + pl(c('envoyé')) + '</b><b class="' + (c('a répondu') ? 'g' : '') + '">📬 ' + c('a répondu') + ' réponse' + pl(c('a répondu')) + '</b><b>✅ ' + c('inséré') + ' cité' + pl(c('inséré')) + '</b>' + (c('rebond') ? '<b class="r">✉️ ' + c('rebond') + ' adresse' + pl(c('rebond')) + ' invalide' + pl(c('rebond')) + '</b>' : '') + '</span>';
  }
  function origines(fs) {
    var x = fs.filter(function (f) { return origine(f)[1] === 'Express'; }).length, a = fs.length - x;
    return [x ? x + ' ⚡ express' : '', a ? a + ' 🧠 assistant / direct' : ''].filter(Boolean).join(' · ');
  }
  function porteeHTML() {
    var moi = portee() === 'moi';
    return '<div class="row" style="gap:6px;margin:4px 0 10px"><span class="chip' + (moi ? ' art' : '') + '" data-act="portee" data-id="moi">👤 Mes fiches</span><span class="chip' + (moi ? '' : ' art') + '" data-act="portee" data-id="tous">👥 Toute la rédaction</span></div>';
  }
  function relancable(f) { var base = f.attente ? f.attente.le : f.envoye_le; return f.statut === 'envoyé' && !!base && Date.now() - new Date(base).getTime() > 3 * 864e5; }
  // Équipe (23/10/2026) : un membre désactivé garde son nom dans l'historique, suivi de « (inactif) ».
  function membre(id) { var w = (D().equipe || []).filter(function (x) { return x.id === id; })[0]; if (!w) return { nom: id || '?' }; return w.actif === false ? Object.assign({}, w, { nom: w.nom + ' (inactif)' }) : w; }
  var STATUTS = { 'brouillon': ['🟠', 'à valider', 'a'], 'envoyé': ['📨', 'envoyé', 'b'], 'a répondu': ['📬', 'a répondu', 'g'], 'inséré': ['✅', 'cité dans l’article', 'g'], 'rebond': ['✉️', 'adresse invalide', 'r'], 'envoi_en_cours': ['⏳', 'envoi en cours…', 'a'], 'relance_en_cours': ['⏳', 'relance en cours…', 'b'], 'archivé': ['🗄️', 'archivé', ''] };
  // Relances : quand un chercheur ne répond pas, les coulisses préparent une relance (dans le même fil) à valider ici.
  // Rebond : le serveur du chercheur a refusé le mail (adresse invalide) → la fiche passe en « adresse invalide ».
  function estRebond(f) { return !!f && (f.statut === 'rebond' || !!f.rebond); }
  function relancePrete(f) {
    return !!(f && String(f.relance_corps || '').trim() && f.statut === 'envoyé' && !estRebond(f) && !f.reponse &&
      (!f.relance_envoyee_le || new Date(f.relance_prete_le || 0) > new Date(f.relance_envoyee_le)));
  }
  function relancesPretes() { return vues().filter(relancePrete); }
  function relanceInfo(f) { var n = Number(f.relances) || 0; return n ? 'relancé ' + n + ' fois' + (f.relance_envoyee_le ? ' · dernière relance ' + when(f.relance_envoyee_le) : '') : ''; }
  // Anti-doublon : les autres fiches (toute la rédaction) adressées au même e-mail.
  function dejaContacte(email, sauf) {
    var e = String(email || '').trim().toLowerCase(); if (!e) return [];
    return (D().fiches || []).filter(function (x) { return x.fiche_id !== sauf && String((x.contact && x.contact.email) || '').trim().toLowerCase() === e; });
  }
  function dejaHTML(list, panneau) {
    if (!list.length) return '';
    return '<div class="' + (panneau ? 'box warn' : 'warn') + '" style="margin:8px 0">⚠️ <b>Déjà contacté</b> par la rédaction :<br>' + list.slice(0, 4).map(function (x) {
      return (x.envoye_le ? 'le ' + esc(day(x.envoye_le)) : 'mail pas encore envoyé') + ' pour « ' + esc(x.article_titre || 'sans article') + ' » (' + esc((STATUTS[x.statut] || ['', x.statut])[1]) + ', ' + esc(qui(x)) + ')';
    }).join('<br>') + '<br><span style="opacity:.8">Vous pouvez continuer, mais évitez de le solliciter deux fois pour le même sujet.</span></div>';
  }
  // Recherche (Suivi, Courrier) : nom, e-mail, fonction, institution, article, objet du mail.
  function norm(x) { return String(x || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, ''); }
  function cherche(f, q) {
    q = norm(q).trim(); if (!q) return true;
    var c = f.contact || {}, hay = norm([c.nom, c.email, c.role, c.institution, f.article_titre, f.mail_sujet, f.relance_sujet].join(' '));
    return q.split(/\s+/).every(function (m) { return hay.indexOf(m) >= 0; });
  }
  // 23/10/2026 : l'affichage suit le DERNIER échange. Une fiche « a répondu » à laquelle nous avons répondu dans le fil (suite
  // envoyée) ou marquée traitée APRÈS la dernière réponse du contact s'affiche « 📨 en attente de réponse » (bleu) et se range
  // avec les envois en attente. Le statut réel (« a répondu », preuve, pièces) ne change pas : il reste dans f.statut_reel.
  // Si le contact répond encore, la relève met reponse_le à jour et la fiche repasse en vert d'elle-même.
  function attenteDe(f) {
    if (!f || f.statut !== 'a répondu' || !f.reponse_le) return null;
    var t = '', type = '';
    (f.historique || []).forEach(function (e) { if (e && (e.e === 'suite envoyée' || e.e === 'réponse marquée traitée') && String(e.t || '') > t) { t = String(e.t); type = e.e === 'suite envoyée' ? 'suite' : 'traitee'; } });
    return t && new Date(t) > new Date(f.reponse_le) ? { type: type, le: t } : null;
  }
  function normaliserFiches(d) { (d && d.fiches || []).forEach(function (f) { var a = attenteDe(f); if (a) { f.statut_reel = f.statut; f.statut = 'envoyé'; f.attente = a; } }); return d; }
  function stLib(f) { return f.attente ? ['📨', 'en attente de réponse', 'b'] : (STATUTS[f.statut] || ['·', f.statut, '']); }
  function envoiTxt(f) { return f.attente ? (f.attente.type === 'suite' ? 'suite envoyée ' : 'réponse traitée ') + when(f.attente.le) : 'envoyé ' + when(f.envoye_le); }
  function tagStatut(f) { var s = stLib(f); return '<span class="tag ' + s[2] + '">' + s[0] + ' ' + esc(s[1]) + '</span>'; }

  // brouillon de l'assistant, gardé par article dans ce navigateur (on ne perd rien en fermant la page)
  function saveDraft() { if (S.art) LS.set('wl-brouillon-' + S.art, JSON.stringify({ contact: S.contact, contacts: S.contacts, qs: S.qs, angle: S.angle, echeance: S.echeance, consigneSec: S.consigneSec })); }
  function loadDraft() {
    var d = null; try { d = JSON.parse(LS.get('wl-brouillon-' + S.art) || 'null'); } catch (e) { d = null; }
    S.contact = (d && d.contact) || null; S.contacts = (d && d.contacts) || null; S.qs = (d && d.qs) || []; S.angle = (d && d.angle) || '';
    S.echeance = (d && d.echeance) || ''; S.consigneSec = (d && d.consigneSec) || ''; S.reformule = null;
  }

  // ---------- appels au webhook (un seul : le champ « mode » dit ce qu'on demande) ----------
  // chaque bouton cliqué montre qu'il travaille (roue + barre en haut) jusqu'à la réponse du webhook
  var OCC = PHL.occupe({ root: function () { return S.root; }, sel: '[data-act]', classe: 'wl-loading', desactiver: true,
    cle: function (b) { return b.getAttribute('data-act') + '|' + (b.getAttribute('data-id') || ''); } });
  function markBusy() { if (S.root) OCC.peindre(); }
  function api(mode, data) {
    var key = S.clicking || null, visible = !!key || mode !== 'etat';
    S.clicking = null;
    OCC.debut(key, visible);
    var done = function () { OCC.fin(key, visible); };
    return S.call({ mode: mode, data: JSON.stringify(data || {}) }).then(function (r) {
      done();
      if (!r || r.ok === false) throw new Error((r && r.why) || 'le Writinglab ne répond pas');
      return r;
    }, function (e) { done(); throw new Error((e && (e.why || e.message)) || 'connexion perdue, réessayez'); });
  }
  // un employé au travail : sa lampe s'allume et une bulle dit ce qu'il fait
  function work(who, label, p) {
    S.busy[who] = label; paintFloor(); paintPanel();
    return p.then(function (r) { delete S.busy[who]; paintFloor(); paintPanel(); return r; },
      function (e) { delete S.busy[who]; paintFloor(); paintPanel(); toast('⚠️ ' + e.message, true); throw e; });
  }
  function refresh(silent) {
    S.last = Date.now();
    return api('etat').then(function (d) {
      // nouveaux mails arrivés sur subs@ / redaction@ depuis la dernière fois : le Courrier les porte au bureau de Julien
      if (S.data && S.data.courrier) {
        var vus = {}; S.data.courrier.forEach(function (m) { vus[m.mail_id] = 1; });
        var neufs = (d.courrier || []).filter(function (m) { return !vus[m.mail_id]; });
        if (neufs.length) { S.arrivees = neufs.map(function (m) { return m.boite; }); S.busy.courrier = 'trie ' + neufs.length + ' mail' + pl(neufs.length);
          setTimeout(function () { S.arrivees = null; delete S.busy.courrier; paintFloor(); }, 3600);
          toast('📬 ' + neufs.length + ' nouveau' + (neufs.length > 1 ? 'x' : '') + ' mail' + pl(neufs.length) + ' pour Julien'); }
      }
      var premier = !S.data;
      S.data = normaliserFiches(d); render(); chargerPieces();
      if (premier) consVerifier(); // engagement de confidentialité : écran bloquant tant que le serveur n'a pas confirmé la signature
      if (premier && window.WL_LOADER) setTimeout(window.WL_LOADER.fin, 250); // l'écran de chargement s'efface quand la rédaction est en place
    }, function (e) { if (window.WL_LOADER) window.WL_LOADER.fin(); if (!silent) toast('⚠️ ' + e.message, true); });
  }

  // ---------- styles ----------
  var PHL_CSS = PHL.cssParts('#wl', { prefixe: 'wl', acc: '#00ff77', accRgb: '0,255,119', txtRgb: '243,236,224', ldOpacite: '.85', ldPapier: '#1f6b45',
    voile: 'rgba(5,4,3,.62)', fondCarte: '#14110c', fondToast: '#16120d', txtToast: '#e8fff2', toastZ: 20 });
  var CSS = "" + PHL_CSS.occupe + "\
#wl{position:fixed;inset:0;z-index:2147483000;overflow:auto;-webkit-overflow-scrolling:touch;background:radial-gradient(1200px 700px at 25% -10%,#2a1d0f 0%,#0b0a08 55%) fixed,#0b0a08;color:#f3ece0;font-family:Inter,system-ui,-apple-system,Segoe UI,sans-serif;font-size:15px;line-height:1.45;-webkit-text-size-adjust:100%;text-size-adjust:100%}\
#wl *{box-sizing:border-box}#wl a{color:#3dffa0;text-decoration:none}#wl a:hover{text-decoration:underline}\
#wl .top{position:sticky;top:0;z-index:5;display:flex;align-items:center;gap:14px;padding:12px 18px;background:rgba(11,10,8,.85);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);border-bottom:1px solid rgba(255,190,90,.14)}\
#wl .logo{font-family:'JetBrains Mono',ui-monospace,monospace;font-weight:800;letter-spacing:.22em;font-size:15px;color:#00ff77;text-shadow:0 0 18px rgba(0,255,119,.45);white-space:nowrap}\
#wl .logo small{display:block;letter-spacing:.06em;font-weight:500;color:rgba(243,236,224,.55);font-size:11px;font-family:Inter,sans-serif;text-shadow:none}\
#wl .clock{font-family:'JetBrains Mono',monospace;font-size:20px;font-weight:700}\
#wl .chips{display:flex;gap:8px;flex-wrap:wrap;flex:1;justify-content:flex-end}\
#wl .chip{cursor:pointer;display:inline-flex;align-items:center;gap:7px;padding:5px 10px;border-radius:999px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.09);font-size:12.5px;white-space:nowrap;color:#f3ece0}\
#wl .chip{flex:none}#wl .chip.art{display:inline-block;max-width:min(340px,70vw);overflow:hidden;text-overflow:ellipsis;border-color:rgba(255,190,90,.35);background:rgba(255,190,90,.08)}\
#wl .chip.hot{border-color:rgba(0,255,119,.5);background:rgba(0,255,119,.1);color:#c9ffe0}\
#wl .chip.warn{border-color:rgba(255,176,32,.5);background:rgba(255,176,32,.1);color:#ffe0a3}\
#wl .btn{cursor:pointer;border:1px solid rgba(61,255,160,.35);background:rgba(0,255,119,.08);color:#bfffdc;border-radius:10px;padding:8px 12px;font:inherit;font-size:14px;line-height:1.2}\
#wl .btn:hover{background:rgba(0,255,119,.16)}#wl .btn[disabled]{opacity:.45;cursor:not-allowed}\
#wl .btn.go{background:#00ff77;color:#05170d;border-color:#00ff77;font-weight:800}#wl .btn.go:hover{background:#3dffa0}\
#wl .btn.amber{border-color:rgba(255,176,32,.5);background:rgba(255,176,32,.12);color:#ffe0a3}\
#wl .btn.red{border-color:rgba(255,61,90,.45);background:rgba(255,61,90,.1);color:#ffb3c0}\
#wl .btn.small{padding:5px 9px;font-size:12.5px;border-radius:8px}\
#wl .led{width:9px;height:9px;border-radius:50%;background:#3a4440;flex:none;display:inline-block}\
#wl .led.on{background:#00ff77;box-shadow:0 0 10px #00ff77;animation:wlpulse 1.4s ease-in-out infinite}#wl .led.slot{background:#ffb020;box-shadow:0 0 8px rgba(255,176,32,.8)}#wl .led.err{background:#ff3d5a;box-shadow:0 0 10px #ff3d5a}\
@keyframes wlpulse{50%{opacity:.45}}\
#wl .tabs{display:flex;gap:4px;padding:10px 18px 0;overflow-x:auto;scrollbar-width:none}#wl .tabs::-webkit-scrollbar{display:none}\
#wl .tab{cursor:pointer;padding:9px 14px;border-radius:10px 10px 0 0;color:rgba(243,236,224,.6);font-weight:600;font-size:14px;white-space:nowrap;border:1px solid transparent;border-bottom:none}\
#wl .tab.sel{color:#f3ece0;background:rgba(255,255,255,.04);border-color:rgba(255,255,255,.09)}\
#wl .tab .n{display:inline-block;min-width:18px;padding:0 5px;margin-left:6px;border-radius:9px;background:#00ff77;color:#05170d;font-size:11px;font-weight:800;text-align:center}\
#wl .wrap{padding:0 18px 60px}\
#wl .floor{position:relative;border:1px solid rgba(255,255,255,.09);border-radius:0 14px 14px 14px;background:rgba(255,255,255,.02);overflow-x:auto;overflow-y:hidden;-webkit-overflow-scrolling:touch}\
#wl .floor svg{display:block;width:100%;min-width:1180px;height:auto}#wl .case,#wl .tableau{cursor:pointer}#wl .case:hover rect:first-child{fill:rgba(255,190,90,.12)}" + (PHL_CSS.tip || "") + "\
#wl .hint{font-size:12.5px;color:rgba(243,236,224,.5);margin:8px 2px 0}\
#wl .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:10px;margin-top:14px}\
#wl .card{cursor:pointer;border:1px solid rgba(255,255,255,.09);background:linear-gradient(180deg,rgba(255,255,255,.04),rgba(255,255,255,.015));border-radius:14px;padding:12px 13px;transition:border-color .2s,transform .2s}\
#wl .card:hover{border-color:rgba(61,255,160,.45);transform:translateY(-1px)}\
#wl .card .h{display:flex;align-items:center;gap:9px;font-weight:700}\
#wl .card .em{font-size:22px;width:34px;height:34px;display:grid;place-items:center;border-radius:10px;background:rgba(255,255,255,.05)}\
#wl .card .s{font-size:12.5px;color:rgba(243,236,224,.62);margin-top:6px}\
#wl h3{font-size:12.5px;letter-spacing:.14em;text-transform:uppercase;color:rgba(243,236,224,.5);margin:22px 0 10px;font-weight:700}\
#wl .tag{display:inline-block;font-size:11.5px;padding:2px 7px;border-radius:6px;background:rgba(255,255,255,.07);color:rgba(243,236,224,.8);margin-right:5px;white-space:nowrap}\
#wl .tag.g{background:rgba(0,255,119,.13);color:#7dffb8}#wl .tag.a{background:rgba(255,176,32,.15);color:#ffd27a}#wl .tag.b{background:rgba(90,160,255,.16);color:#a9cdff}#wl .tag.r{background:rgba(255,61,90,.14);color:#ff8c9e}\
#wl .muted{color:rgba(243,236,224,.55);font-size:13px}\
#wl .box{border:1px solid rgba(255,255,255,.09);border-radius:12px;padding:12px;background:rgba(255,255,255,.025);margin-bottom:12px}\
#wl .box.warn{border-color:rgba(255,176,32,.4);background:rgba(255,176,32,.06)}\
#wl .row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}\
#wl .panelbg{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:8;opacity:0;pointer-events:none;transition:opacity .25s}#wl .panelbg.open{opacity:1;pointer-events:auto}\
#wl .panel{position:fixed;top:0;right:0;bottom:0;width:min(560px,100vw);z-index:9;background:#0f0d0a;border-left:1px solid rgba(255,190,90,.2);box-shadow:-30px 0 60px rgba(0,0,0,.5);transform:translateX(105%);transition:transform .3s cubic-bezier(.2,.8,.2,1);overflow-y:auto;-webkit-overflow-scrolling:touch}\
#wl .panel.open{transform:none}\
#wl button.clsr-h{position:fixed;right:0;top:42%;z-index:6;display:flex;flex-direction:column;align-items:center;gap:6px;padding:12px 7px;border:1px solid rgba(255,190,90,.35);border-right:none;border-radius:12px 0 0 12px;background:#17130e!important;color:#f3ece0!important;cursor:pointer;box-shadow:-8px 0 24px rgba(0,0,0,.4)!important;font-weight:500;text-transform:none}\
#wl .clsr-h .lb{writing-mode:vertical-rl;transform:rotate(180deg);font-size:12.5px;letter-spacing:.06em}#wl .clsr-h .ic{font-size:18px}\
#wl .clsr-h .n{min-width:20px;padding:1px 6px;border-radius:999px;background:rgba(255,190,90,.18);font-size:11.5px;text-align:center}\
#wl .clsr-h.open{opacity:0;pointer-events:none}\
#wl .clsr-bg{position:fixed;inset:0;z-index:6;background:rgba(0,0,0,.4);opacity:0;pointer-events:none;transition:opacity .25s}#wl .clsr-bg.open{opacity:1;pointer-events:auto}\
#wl .clsr{position:fixed;top:0;right:0;bottom:0;width:min(400px,92vw);z-index:7;background:#0f0d0a;border-left:1px solid rgba(255,190,90,.25);box-shadow:-30px 0 60px rgba(0,0,0,.5);transform:translateX(105%);transition:transform .3s cubic-bezier(.2,.8,.2,1);display:flex;flex-direction:column}\
#wl .clsr.open{transform:none}\
#wl textarea.wl-mef{opacity:.45;cursor:progress;background-image:linear-gradient(90deg,rgba(255,255,255,0) 0%,rgba(255,255,255,.07) 50%,rgba(255,255,255,0) 100%)!important;background-size:200% 100%!important;animation:wlmef 1.2s linear infinite}@keyframes wlmef{from{background-position:200% 0}to{background-position:-200% 0}}\
#wl .btn.mic.on{border-color:rgba(255,80,80,.7)!important;color:#ffd0d0!important;animation:wlmic 1.2s ease-in-out infinite}@keyframes wlmic{0%,100%{box-shadow:0 0 0 0 rgba(255,80,80,.5)}50%{box-shadow:0 0 0 6px rgba(255,80,80,0)}}\
#wl .clsr-top{display:flex;align-items:center;justify-content:space-between;padding:16px 18px;border-bottom:1px solid rgba(255,255,255,.08)}#wl .clsr-top .x{cursor:pointer;font-size:18px;padding:4px 8px}\
#wl .clsr-body{flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:14px 18px 40px}\
#wl .clsr-cats{display:flex;flex-wrap:wrap;gap:6px}\
#wl .ph2{position:sticky;top:0;background:linear-gradient(180deg,#17120c 75%,rgba(23,18,12,0));padding:18px 18px 14px;display:flex;gap:12px;align-items:center;z-index:2}\
#wl .ph2 .em{font-size:30px;width:52px;height:52px;border-radius:14px;display:grid;place-items:center;background:rgba(255,190,90,.08);border:1px solid rgba(255,190,90,.25);flex:none}\
#wl .ph2 .nm{font-size:19px;font-weight:800;line-height:1.2}#wl .ph2 .st{font-size:12.5px;color:rgba(243,236,224,.65);display:flex;align-items:center;gap:7px;margin-top:4px}\
#wl .ph2 .x{margin-left:auto;cursor:pointer;font-size:22px;color:rgba(243,236,224,.6);padding:4px 8px}\
#wl .pb{padding:0 18px 60px}\
#wl label.f{display:block;font-size:12.5px;color:rgba(243,236,224,.6);margin:10px 0 4px}\
#wl input.in,#wl textarea.in,#wl select.in{width:100%;background:#16120d;color:#f3ece0;border:1px solid #3a3020;border-radius:10px;padding:10px 11px;font:16px Inter,system-ui,sans-serif}\
#wl textarea.in{min-height:72px;resize:vertical;line-height:1.45}#wl input.in:focus,#wl textarea.in:focus,#wl select.in:focus{outline:none;border-color:#00ff77;box-shadow:0 0 0 3px rgba(0,255,119,.15)}\
#wl .two{display:grid;grid-template-columns:1fr 1fr;gap:8px}\
#wl .q{border:1px solid rgba(255,255,255,.09);border-radius:12px;padding:10px;margin-bottom:8px;background:rgba(255,255,255,.02)}\
#wl .q.keep{border-color:rgba(0,255,119,.45);background:rgba(0,255,119,.05)}\
#wl .q .why{font-size:12.5px;color:rgba(243,236,224,.55);margin:6px 2px 8px;font-style:italic}\
#wl .q textarea.in{min-height:54px}\
#wl .ct{border:1px solid rgba(255,255,255,.09);border-radius:12px;padding:11px;margin-bottom:8px;background:rgba(255,255,255,.02)}\
#wl .ct b{font-size:15px}#wl .ct .w{font-size:12.5px;color:rgba(243,236,224,.6);margin-top:4px}\
#wl .dos{display:flex;flex-direction:column;gap:8px}\
#wl .dcard{cursor:pointer;border-radius:12px;padding:10px 12px;background:linear-gradient(180deg,#f7f1e3,#ebe2cc);color:#1f1a12;box-shadow:0 8px 22px rgba(0,0,0,.35);transition:transform .2s;position:relative}\
#wl .dcard:hover{transform:translateY(-2px) rotate(-.4deg)}\
#wl .dcard .k{font-size:11px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:#5a5243}\
#wl .dcard .ti{font-weight:800;font-size:14.5px;line-height:1.25;margin-top:4px;color:#1f1a12}\
#wl .dcard .su{font-size:12.5px;color:#5f5646;margin-top:3px}\
#wl .dcard.a{background:linear-gradient(180deg,#fff4dc,#f6e2b8)}#wl .dcard.b{background:linear-gradient(180deg,#eef4ff,#d9e5f6)}#wl .dcard.g{background:linear-gradient(180deg,#eafff2,#cdf1db);box-shadow:0 0 0 2px rgba(0,255,119,.5),0 8px 22px rgba(0,0,0,.35)}\
#wl .kan{display:grid;grid-template-columns:repeat(4,minmax(220px,1fr));gap:12px;overflow-x:auto;padding-bottom:10px}\
#wl .col{background:rgba(255,255,255,.025);border:1px solid rgba(255,255,255,.08);border-radius:14px;padding:10px;min-height:120px}\
#wl .col h4{margin:2px 2px 10px;font-size:13px;display:flex;gap:8px;align-items:center}\
#wl .arts{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px;margin-top:14px}\
#wl .ar{cursor:pointer;border-radius:14px;overflow:hidden;border:1px solid rgba(255,255,255,.09);background:#14110c;transition:border-color .2s}\
#wl .ar:hover,#wl .ar.sel{border-color:rgba(255,190,90,.6)}#wl .ar.sel{box-shadow:0 0 0 2px rgba(255,190,90,.45)}\
#wl .ar .ph{aspect-ratio:16/8;background:linear-gradient(135deg,#2a1d0f,#0e0b08);display:grid;place-items:center;font-size:30px;overflow:hidden}\
#wl .ar .ph img{width:100%;height:100%;object-fit:cover;display:block}\
#wl .ar .b{padding:10px 12px}#wl .ar .b .ti{font-weight:700;line-height:1.3}#wl .ar .b .me{font-size:12.5px;color:rgba(243,236,224,.55);margin-top:5px}\
#wl .chat{display:flex;flex-direction:column;gap:8px;max-width:760px}\
#wl .bub{max-width:82%;padding:9px 12px;border-radius:14px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.08);white-space:pre-wrap;word-wrap:break-word}\
#wl .bub.me{align-self:flex-end;background:rgba(0,255,119,.1);border-color:rgba(0,255,119,.3)}\
#wl .dossier{margin:10px 0 14px;padding:10px 12px;border:1px solid rgba(255,255,255,.08);border-radius:14px;background:rgba(255,255,255,.025);transition:box-shadow .4s}#wl .dossier.flash{box-shadow:0 0 0 2px rgba(0,255,119,.6)}#wl .panel .dossier .dh{cursor:pointer}#wl .dossier .dh{display:flex;flex-wrap:wrap;gap:6px 12px;align-items:baseline;justify-content:space-between;margin-bottom:6px}#wl .av{display:inline-flex;flex-wrap:wrap;gap:6px}#wl .av b{font-weight:500;font-size:11.5px;padding:2px 8px;border-radius:999px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.08);white-space:nowrap}#wl .av b.a{border-color:rgba(255,176,32,.5);color:#ffe0a3}#wl .av b.g{border-color:rgba(0,255,119,.5);color:#c9ffe0}\
#wl .lb{display:grid;gap:6px;margin:6px 0 14px}#wl .lb div{display:flex;justify-content:space-between;padding:10px 12px;border-radius:12px;background:#f3ead6;border:1px solid #d8cfbd}#wl .pc{padding:10px 0;border-top:1px solid #e3dac8}#wl .parc{display:flex;flex-wrap:wrap;align-items:center;gap:4px;margin:8px 0 12px}#wl .parc .pa{font-size:12.5px;padding:4px 9px;border-radius:999px;border:1px dashed #b9ae98;color:#8a806e}#wl .parc .pa.on{border-style:solid;border-color:#1f8a52;background:#e5f6ea;color:#14532d;font-weight:600}#wl .parc i{width:14px;height:1px;background:#b9ae98}\
#wl .fete{position:fixed;left:50%;top:38%;z-index:70;transform:translate(-50%,-50%);text-align:center;padding:24px 34px;border-radius:22px;background:#14110c;border:1px solid rgba(255,200,80,.6);box-shadow:0 0 0 6px rgba(255,200,80,.08),0 30px 80px rgba(0,0,0,.6);animation:wlfete .5s cubic-bezier(.2,1.4,.4,1)}#wl .fete.out{opacity:0;transition:opacity .5s}#wl .fete-c{font-size:54px;animation:wlspin2 1.2s ease-in-out}#wl .fete-t{font-weight:800;font-size:22px;color:#ffd77a;margin-top:6px}#wl .fete-s{font-size:13.5px;color:rgba(243,236,224,.7);margin-top:4px}@keyframes wlfete{from{transform:translate(-50%,-50%) scale(.6);opacity:0}}@keyframes wlspin2{0%{transform:rotateY(0)}100%{transform:rotateY(720deg)}}\
#wl .mb-al{margin:8px 0;padding:10px 12px;border-radius:10px;background:rgba(255,107,90,.10);border:1px solid rgba(255,107,90,.45);font-size:13.5px;line-height:1.5}#wl .mb-ul{margin:4px 0 2px 18px;padding:0;font-size:13px;line-height:1.5}#wl .mb-ul li{margin:2px 0;word-break:break-word}#wl .mb-k{font-weight:700;font-size:13px;margin:10px 0 2px}#wl .mb-src{white-space:pre-wrap;font-size:12.5px;line-height:1.5;color:rgba(243,236,224,.8);word-break:break-word}#wl .mb-src a,#wl .mb-ul a{color:#9fffc8!important}#wl .pubwrap{display:inline-flex;align-items:center;flex-wrap:wrap;gap:6px 12px;max-width:100%}#wl label.pubchk{display:inline-flex!important;align-items:center;gap:6px;margin:0!important;padding:0!important;font:500 12.5px/1.2 Inter,system-ui,sans-serif!important;opacity:.85;cursor:pointer;user-select:none;white-space:nowrap;text-transform:none!important;letter-spacing:normal!important;color:inherit}#wl label.pubchk:hover{opacity:1}#wl label.pubchk input{width:16px;height:16px;margin:0!important;accent-color:#18b45f;cursor:pointer;flex:0 0 auto}#wl label.cfm-pub{display:flex!important;justify-content:center;margin:2px 0 14px!important;font-size:13.5px!important}#wl .ctabs{display:flex;margin:4px 0 14px}#wl .dcard.r{background:linear-gradient(180deg,#ffeef0,#f6d3d8)}#wl .av b.r{border-color:rgba(255,61,90,.55);color:#ffb3bf}#wl .qbox{position:relative;margin:12px 0 4px}#wl .qbox input{width:100%;box-sizing:border-box;padding-left:38px!important}#wl .qbox:before{content:'🔎';position:absolute;left:12px;top:50%;transform:translateY(-50%);font-size:15px;opacity:.7;pointer-events:none}#wl .relance{margin:16px 0;padding:14px 16px;border-radius:14px;background:#fff7e6;border:1px solid #f0d49a}#wl .relance h2{margin-top:0!important}#wl .rebond{margin:14px 0;padding:12px 14px;border-radius:12px;background:#fff0f2;border:1px solid #f2b8c1;color:#5a1622;font-size:15px;line-height:1.5}#wl .kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin:10px 0}#wl .kpi{padding:12px 14px;border-radius:14px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.09)}#wl .kpi b{display:block;font-size:22px;color:#f3ece0;font-variant-numeric:tabular-nums}#wl .kpi span{font-size:12.5px;color:rgba(243,236,224,.6)}#wl .bars{display:flex;flex-direction:column;gap:6px;margin:8px 0}#wl .bar{display:grid;grid-template-columns:96px 1fr 70px;gap:8px;align-items:center;font-size:13px}#wl .bar i{display:block;height:10px;border-radius:5px;background:linear-gradient(90deg,#18b45f,#00ff77);min-width:2px}#wl .bar em{font-style:normal;text-align:right;color:rgba(243,236,224,.75);font-variant-numeric:tabular-nums}#wl .bar .lb{color:rgba(243,236,224,.75);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}#wl .ctabs button{flex:1;padding:10px 14px!important;font-size:14.5px!important}#wl .rd-h{display:flex;gap:10px;align-items:flex-start}#wl .rd-n{flex:0 0 auto;width:26px;height:26px;border-radius:50%;background:rgba(0,255,119,.14);color:#9fffc8;font:700 13px/26px Inter,sans-serif;text-align:center}#wl .rd-t{font-weight:700;font-size:15px;line-height:1.35;color:#f3ece0}#wl .rd-a{margin-top:6px;font-size:13.5px;line-height:1.5;color:rgba(243,236,224,.72);white-space:pre-wrap}#wl .rd-vote{border-color:rgba(0,255,119,.55)!important;background:rgba(0,255,119,.06)!important}#wl .mb-img{width:100%;max-height:170px;object-fit:cover;border-radius:10px;margin-bottom:8px;display:block}#wl .mb-soc{width:100%;max-width:320px;border-radius:10px;margin:8px 0;display:block}#wl .cz-t{margin:20px 0 6px;font:700 15px Inter,system-ui,sans-serif!important;color:#f3ece0;letter-spacing:normal!important;text-transform:none!important}#wl .dot-off{display:inline-block;width:7px;height:7px;border-radius:50%;background:#ff6b5a;margin-left:4px;vertical-align:top}#wl .set{margin:14px 0;padding:14px 16px;border-radius:16px;background:rgba(255,255,255,.035);border:1px solid rgba(255,255,255,.09)}#wl .set.hot{border-color:rgba(255,176,32,.55);background:rgba(255,176,32,.07)}#wl .set-h{display:flex;justify-content:space-between;align-items:center;gap:14px}#wl .set-s{font-size:13px;color:rgba(243,236,224,.6);margin-top:3px;line-height:1.5}#wl button.sw{flex:0 0 auto;width:46px;height:26px;border-radius:99px;background:#3a3328!important;border:1px solid rgba(255,255,255,.15)!important;position:relative;padding:0!important;cursor:pointer;transition:background .2s}#wl button.sw i{position:absolute;top:2px;left:2px;width:20px;height:20px;border-radius:50%;background:#d8cfbf;transition:left .2s}#wl button.sw.on{background:#18b45f!important}#wl button.sw.on i{left:22px;background:#fff}#wl .seg{display:inline-flex;margin:12px 0 8px;border:1px solid rgba(255,255,255,.14);border-radius:10px;overflow:hidden}#wl .seg button{background:transparent!important;color:rgba(243,236,224,.7)!important;border:0!important;padding:7px 14px!important;font-size:13.5px!important;cursor:pointer}#wl .seg button.on{background:rgba(0,255,119,.14)!important;color:#9fffc8!important;font-weight:600}#wl .tb{display:flex;gap:4px;margin-bottom:6px}#wl .tb button{background:rgba(255,255,255,.06)!important;color:#f3ece0!important;border:1px solid rgba(255,255,255,.12)!important;border-radius:7px;min-width:34px;height:30px;padding:0 8px!important;cursor:pointer;font-size:14px!important}#wl .sig-ed{min-height:96px;background:#fff;color:#1f1a12;border-radius:10px;padding:12px 14px;font:14.5px/1.55 Arial,Helvetica,sans-serif;outline:none;border:2px solid transparent}#wl .sig-ed:focus{border-color:#00ff77}#wl .sig-ed b,#wl .sig-ed i,#wl .sig-ed u,#wl .sigprev b,#wl .sigprev i,#wl .sigprev u,#wl .cit b{color:inherit!important;background:none!important}#wl .sig-ed a,#wl .sigprev a{color:#1a5fd0!important}#wl .tb button{min-width:38px!important;height:32px!important}#wl .sigprev{margin-top:8px;padding:10px 12px;border-left:3px solid #d4c8ad;background:#faf6ec;color:#444;font:14px/1.5 Arial,Helvetica,sans-serif;border-radius:0 8px 8px 0}#wl .sigprev .kd,#wl .cit .kd{display:inline-block;font:600 11px Inter,sans-serif;letter-spacing:.04em;text-transform:uppercase;color:#8a7d63;margin-bottom:4px}#wl .sigprev .kd{display:block}#wl .cit{margin:10px 0;border:1px solid #e0d5bd;border-radius:12px;background:#fffdf8;overflow:hidden}#wl .cit.done{border-color:#9fd9b4;background:#f3fbf5}#wl .cit.skip{opacity:.55}#wl .cit-h{display:flex;align-items:center;gap:10px;padding:11px 14px;cursor:pointer}#wl .cit-n{flex:0 0 auto;width:26px;height:26px;border-radius:50%;background:#1f1a12;color:#fff;font:700 13px/26px Inter,sans-serif;text-align:center}#wl .cit-t{flex:1;font-size:14.5px;line-height:1.4;color:#1f1a12}#wl .cit-t small{display:block;color:#8a7d63;font-size:12.5px;margin-top:2px}#wl .cit-c{color:#8a7d63}#wl .cit-b{padding:0 14px 14px}#wl .cit .ctx{color:#a59a84;font-size:14px;line-height:1.55;padding:6px 0}#wl .cit .neo{margin:6px 0;padding:10px 14px;border-left:4px solid #18b45f;background:#effaf3;border-radius:0 10px 10px 0;color:#1f1a12;font-size:15px;line-height:1.6}#wl .cit .neo p{margin:0 0 8px}#wl .cit .neo blockquote{margin:0;padding:0 0 0 12px;border-left:2px solid #c9bfa8;font-style:italic}#wl .cit .neo em{font-style:normal;color:#6b604c;font-size:14px}#wl .cit-meta{font-size:13px;color:#6b604c;margin:6px 0 4px;line-height:1.5}#wl .chapo{margin:18px 0 6px;padding:14px 16px;border-radius:14px;background:linear-gradient(180deg,#fff7df,#fffdf6);border:1px solid #ecd8a2}#wl .ch-t{font-weight:700;font-size:15.5px;color:#1f1a12}#wl .ch-s{font-size:13.5px;color:#6b604c;margin-top:4px;line-height:1.5}#wl .chapo mark{background:#c9f2d7;color:#0f3d22;padding:1px 3px;border-radius:3px}#wl label.chk{display:flex;gap:8px;align-items:baseline;margin:7px 0;font-size:14px;cursor:pointer}#wl label.chk input{transform:translateY(2px)}#wl .cit-ed summary{cursor:pointer;font-size:13.5px;color:#6b604c;margin:6px 0}\
#wl .caisse{margin:12px 0;padding:14px 16px;border-radius:16px;background:radial-gradient(120% 140% at 0% 0%,rgba(255,200,80,.16),rgba(255,200,80,.03) 60%);border:1px solid rgba(255,200,80,.35)}#wl .cz-h{display:flex;justify-content:space-between;gap:8px;align-items:center;font-size:13.5px}#wl .cz-n{font-size:34px;font-weight:800;color:#ffd77a;margin-top:6px;display:flex;align-items:baseline;gap:10px}#wl .cz-n small{font-size:15px;font-weight:600;color:rgba(243,236,224,.75)}#wl .cz-s{font-size:12.5px;color:rgba(243,236,224,.58)}#wl .cz-l{padding:10px 12px;margin:8px 0;border-radius:12px;background:rgba(255,255,255,.035);border:1px solid rgba(255,255,255,.08)}#wl .cz-d{margin-top:14px;padding:10px 12px;border-radius:12px;background:rgba(255,255,255,.025);border:1px solid rgba(255,255,255,.07);font-size:13.5px}#wl .fa-ed{margin-top:10px;padding:10px 12px;border-radius:12px;background:rgba(255,255,255,.04);border:1px dashed rgba(255,255,255,.18)}#wl .fa-ed label{display:block;font-size:12.5px;color:rgba(243,236,224,.6);margin:8px 0 4px}#wl .cz-d summary{cursor:pointer;font-weight:600}#wl .cz-d p{color:rgba(243,236,224,.75);line-height:1.6}\
" + PHL_CSS.confirmer + "\
#wl .bub.bot{background:rgba(255,190,90,.08);border-color:rgba(255,190,90,.35);border-left:3px solid rgba(255,190,90,.8)}#wl .bub.bot .who{color:#ffcf8a;font-weight:600}\
#wl .box.iv{margin:14px 0 4px;border-color:rgba(0,255,119,.35);background:rgba(0,255,119,.05)}#wl .ivl{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-top:10px;padding-top:10px;border-top:1px solid rgba(255,255,255,.07)}#wl .ivl span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\
#wl .bub .who{font-size:11.5px;color:rgba(243,236,224,.55);margin-bottom:3px;white-space:normal}\
#wl .composer{position:sticky;bottom:0;padding:12px 0;background:linear-gradient(0deg,#0b0a08 70%,rgba(11,10,8,0));max-width:760px}\
#wl .feed .it{display:flex;gap:10px;padding:8px 6px;border-bottom:1px solid rgba(255,255,255,.05);font-size:13.5px}\
#wl .feed .it .t{font-family:'JetBrains Mono',monospace;font-size:11.5px;color:rgba(243,236,224,.45);min-width:78px;padding-top:2px}\
#wl .doc{position:fixed;inset:0;z-index:12;background:rgba(5,4,3,.86);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);display:none;overflow-y:auto;-webkit-overflow-scrolling:touch}#wl .doc.open{display:block}\
#wl .prep{max-width:760px;margin:16px auto 80px;padding:20px 22px 22px;background:#14110c;border:1px solid rgba(0,255,119,.22);border-radius:18px;box-shadow:0 30px 80px rgba(0,0,0,.55),inset 0 1px 0 rgba(0,255,119,.08)}#wl .dtop .pp-x{margin-left:auto;flex:0 0 auto}#wl .pp-k{display:flex;align-items:center;gap:8px;font:700 11.5px 'JetBrains Mono',ui-monospace,monospace;letter-spacing:.18em;text-transform:uppercase;color:#00ff77}#wl .pp-dot{width:8px;height:8px;border-radius:50%;background:#00ff77;box-shadow:0 0 10px #00ff77;animation:wlPpPulse 1.1s ease-in-out infinite}#wl .pp-ti{margin:6px 0 14px;font-weight:800;font-size:19px;line-height:1.3;color:#f3ece0}#wl .pp-pg{margin:4px 0 12px}#wl .pp-bar{position:relative;height:8px;border-radius:99px;background:rgba(255,255,255,.07);overflow:hidden}#wl .pp-bar i{position:absolute;left:0;top:0;bottom:0;border-radius:99px;background:linear-gradient(90deg,#18b45f,#00ff77);transition:width 1s linear}#wl .pp-pg.on .pp-bar i:after{content:'';position:absolute;inset:0;background:linear-gradient(90deg,transparent,rgba(255,255,255,.55),transparent);animation:wlPpScan 1.6s linear infinite}#wl .pp-meta{display:flex;justify-content:space-between;margin-top:6px;font:12px 'JetBrains Mono',ui-monospace,monospace;color:rgba(243,236,224,.6)}#wl .pp-el{color:#9fffc8;font-weight:700}#wl .pp-log{list-style:none;margin:8px 0 6px;padding:0;display:flex;flex-direction:column;gap:2px}#wl .pp-log li{display:grid;grid-template-columns:46px 26px 1fr;align-items:baseline;gap:6px;padding:7px 10px;border-radius:10px;transition:background .3s,opacity .3s}#wl .pp-log li.wait{opacity:.38}#wl .pp-log li.run{background:rgba(0,255,119,.07);box-shadow:inset 2px 0 0 #00ff77}#wl .pp-log li.ok .pp-lt:after{content:' ✓';color:#3dffa0;font-weight:800}#wl .pp-log li.ko{background:rgba(255,61,90,.1);box-shadow:inset 2px 0 0 #ff3d5a}#wl .pp-log li.run .pp-lt:after{content:'';display:inline-block;width:7px;height:14px;margin-left:6px;vertical-align:-2px;background:#00ff77;animation:wlPpCaret 1s steps(2) infinite}#wl .pp-s{font:11.5px 'JetBrains Mono',ui-monospace,monospace;color:rgba(243,236,224,.45)}#wl .pp-ic{font-size:15px}#wl .pp-l{font-size:14.5px;line-height:1.4;color:#f3ece0}#wl .pp-l small{display:block;font-size:12.5px;color:rgba(243,236,224,.55)}#wl .pp-long{margin:6px 0;padding:9px 12px;border-radius:10px;background:rgba(255,176,32,.08);border:1px solid rgba(255,176,32,.35);font-size:13.5px;line-height:1.5;color:#ffe0a3}#wl .prep p.muted{font-size:13px!important;line-height:1.5!important}#wl .pp-n{font-size:13px;margin:8px 0 0}#wl .pp-det summary{cursor:pointer;font-size:13px;color:rgba(243,236,224,.6);margin:2px 0 4px}#wl .pp-fin{margin:10px 0 4px;padding:10px 12px;border-radius:12px;background:rgba(0,255,119,.08);border:1px solid rgba(0,255,119,.35);color:#c9ffe0;font-size:14.5px;line-height:1.5}#wl .pp-h{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;margin:18px 0 4px}#wl .pp-h>b{font-size:16px;color:#f3ece0}#wl .pp-c.in{animation:wlPpIn .55s cubic-bezier(.2,.8,.2,1) both}#wl .dcard:focus-visible{outline:2px solid #00ff77;outline-offset:2px}@keyframes wlPpIn{from{opacity:0;transform:translateY(14px) scale(.97);filter:blur(3px)}to{opacity:1;transform:none;filter:none}}@keyframes wlPpScan{from{transform:translateX(-100%)}to{transform:translateX(100%)}}@keyframes wlPpPulse{50%{opacity:.35}}@keyframes wlPpCaret{50%{opacity:0}}@media (max-width:720px){#wl .prep{margin:10px 8px 60px;padding:16px 14px 18px;border-radius:16px}#wl .pp-ti{font-size:17px}#wl .pp-log li{grid-template-columns:40px 22px 1fr;padding:7px 6px}}@media (prefers-reduced-motion:reduce){#wl .pp-c.in,#wl .pp-dot,#wl .pp-pg.on .pp-bar i:after,#wl .pp-log li.run .pp-lt:after{animation:none}}\
#wl .qbox input,#wl .qbox input.in{padding-left:40px!important}#wl .qbox:before{left:13px!important;line-height:1;z-index:1}#wl .nom-l{color:inherit!important;text-decoration:none;border-bottom:1px dotted currentColor;cursor:pointer}#wl .nom-l:hover{text-decoration:none;border-bottom-style:solid}#wl .nom-i{display:inline-block;margin-left:4px;font:700 10px/1 Inter,sans-serif;opacity:.6;vertical-align:2px;border-bottom:0}#wl .nom-i.li{padding:2px 3px;border-radius:3px;background:#0a66c2;color:#fff!important;opacity:.9}#wl .nom-l.nom-q .nom-i{font-size:10px}#wl .src-l{font-size:12.5px;color:#3dffa0!important;margin-left:6px;white-space:nowrap}#wl .paper .src-l,#wl .dcard .src-l{color:#0a7a45!important}#wl .src-w{margin:-6px 0 10px;font-family:Inter,sans-serif}#wl .pp-att{display:inline-block;animation:wlPpPulse 2.4s ease-in-out infinite}#wl .pp-log.r li{grid-template-columns:26px 1fr}#wl .pp-cts{display:flex;flex-direction:column;gap:8px;margin:8px 0 4px}#wl .pp-ct{padding:10px 12px;border-radius:12px;background:rgba(255,255,255,.035);border:1px solid rgba(255,255,255,.09);border-left:3px solid rgba(0,255,119,.5);animation:wlPpIn .45s cubic-bezier(.2,.8,.2,1) both}#wl .pp-ct.ok{border-left-color:#3dffa0}#wl .pp-ct.ko{border-left-color:#ff3d5a;background:rgba(255,61,90,.06)}#wl .pp-ct.deja{border-left-color:#7fb2ff;opacity:.8}#wl .pp-ct-h{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 10px}#wl .pp-ct-h b{font-size:15px;color:#f3ece0}#wl .pp-ct-h>span{font-size:13px;color:rgba(243,236,224,.62)}#wl .pp-ct-m{font-size:12.5px;color:rgba(243,236,224,.6);margin-top:3px;word-break:break-word}#wl .pp-ct-s{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}#wl .pp-ct-s span{font-size:12.5px;padding:3px 9px;border-radius:99px;border:1px solid rgba(255,255,255,.12);color:rgba(243,236,224,.5)}#wl .pp-ct-s span.run{border-color:rgba(0,255,119,.55);color:#9fffc8;background:rgba(0,255,119,.08);animation:wlPpPulse 1.6s ease-in-out infinite}#wl .pp-ct-s span.ok{border-color:rgba(61,255,160,.4);color:#c9ffe0}#wl .pp-ct-s span.ok:before{content:'✓ ';font-weight:800}#wl .pp-ct-s span.ko{border-color:rgba(255,61,90,.5);color:#ffb3c0}#wl .pp-ct-e{margin-top:8px;font-size:13px;color:#ffb3c0;display:flex;flex-wrap:wrap;align-items:center;gap:8px}#wl .enqs{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:10px;margin:8px 0}#wl .enq{padding:12px 14px;border-radius:14px;background:#14110c;border:1px solid rgba(255,255,255,.09);display:flex;flex-direction:column;gap:7px;min-width:0}#wl .enq.flash{border-color:rgba(0,255,119,.6)}#wl .enq-t{font-weight:700;font-size:15px;line-height:1.35;color:#f3ece0!important}#wl .enq-t:hover{text-decoration:underline}#wl .enq>.tag{align-self:flex-start}#wl .eb{display:flex;gap:3px;height:8px}#wl .eb i{flex:1;border-radius:3px;background:#d9e5f6}#wl .eb i.a{background:#f6c56b}#wl .eb i.b{background:#8fb3ea}#wl .eb i.g{background:#4fdc8e}#wl .eb i.c{background:#18b45f}#wl .eb i.r{background:#ff7f8f}#wl .enq-l{font-size:13px;color:rgba(243,236,224,.75)}#wl .enq-n{font-size:13px;color:rgba(243,236,224,.85);line-height:1.6}#wl .enq-n .sep{margin:0 6px;opacity:.4}#wl .enq-a{gap:6px;margin-top:2px}#wl .seg.arts-seg{display:flex;flex-wrap:wrap;margin:4px 0 2px}#wl .seg.arts-seg button{flex:1 1 auto;white-space:nowrap}#wl .seg .n{display:inline-block;min-width:20px;margin-left:4px;padding:0 6px;border-radius:99px;background:rgba(255,255,255,.08);font-size:12px}@media (max-width:720px){#wl .enqs{grid-template-columns:1fr}#wl .seg.arts-seg button{padding:7px 8px!important;font-size:12.5px!important}}\
#wl .mb-h{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:6px 12px}#wl label.mb-chk{display:inline-flex!important;align-items:center;gap:6px;margin:0!important;font:500 12.5px Inter,system-ui,sans-serif!important;text-transform:none!important;letter-spacing:normal!important;color:rgba(243,236,224,.75);cursor:pointer}#wl label.mb-chk input{width:15px;height:15px;margin:0!important;accent-color:#18b45f}#wl .als{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:6px;margin:6px 0 10px}#wl .al{display:flex;align-items:center;gap:10px;padding:7px 9px;border-radius:10px;background:rgba(255,255,255,.035);border:1px solid rgba(255,255,255,.08);cursor:pointer;min-width:0}#wl .al:hover{border-color:rgba(0,255,119,.35)}#wl .al.sel{border-color:rgba(255,190,90,.6);background:rgba(255,190,90,.07)}#wl .al-v{flex:0 0 auto;width:44px;height:44px;border-radius:7px;object-fit:cover;display:block}#wl .al-v0{display:flex;align-items:center;justify-content:center;background:rgba(255,255,255,.05);font-size:18px}#wl .al-c{flex:1;min-width:0}#wl .al-t{font-weight:650;font-size:13.5px;line-height:1.3;color:#f3ece0;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}#wl .al-m{display:flex;flex-wrap:wrap;align-items:center;gap:4px;margin-top:3px}#wl .al-m .tag{font-size:10.5px!important;padding:1px 6px!important}#wl .al-d{font-size:11.5px;color:rgba(243,236,224,.5);margin-left:2px}#wl .al-a{flex:0 0 auto;display:flex;align-items:center;gap:4px}#wl .al-i{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:8px;border:1px solid rgba(255,255,255,.12);text-decoration:none!important;font-size:14px}#wl .al-i:hover{border-color:rgba(0,255,119,.45)}#wl .btn.small.al-b{min-width:30px;height:30px;padding:0 7px!important;font-size:12.5px!important;white-space:nowrap}@media (max-width:720px){#wl .als{grid-template-columns:1fr}}\
#wl.wl-verrou>.top,#wl.wl-verrou>.tabs,#wl.wl-verrou>.wrap,#wl.wl-verrou>.panel,#wl.wl-verrou>.panelbg,#wl.wl-verrou>.doc{filter:blur(18px) saturate(.6);pointer-events:none;user-select:none}#wl .cs-bg{position:fixed;inset:0;z-index:90;overflow-y:auto;-webkit-overflow-scrolling:touch;background:rgba(5,4,3,.78);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);padding:16px}#wl .cs{max-width:720px;margin:12px auto 40px;padding:26px 26px 22px;border-radius:18px;background:#14110c;border:1px solid rgba(0,255,119,.25);box-shadow:0 30px 90px rgba(0,0,0,.6)}#wl .cs-k{font:700 11px 'JetBrains Mono',ui-monospace,monospace;letter-spacing:.16em;text-transform:uppercase;color:#00ff77}#wl .cs-t{margin:8px 0 2px!important;font:800 24px/1.2 Inter,system-ui,sans-serif!important;color:#f3ece0!important;letter-spacing:normal!important;text-transform:none!important}#wl .cs-v{font:12.5px 'JetBrains Mono',ui-monospace,monospace;color:rgba(243,236,224,.6)}#wl .cs-x{margin:16px 0;padding:16px 18px;border-radius:12px;background:#1b1711;border:1px solid rgba(243,236,224,.14);color:#efe6d6;max-height:46vh;overflow:auto;font:15px/1.6 Georgia,'Iowan Old Style',serif}#wl .cs-x p,#wl .cs-x li,#wl .cs-x ol{color:#efe6d6!important;text-shadow:none!important}#wl .cs-x p{margin:0 0 10px}#wl .cs-h{margin:14px 0 4px!important;font:700 13px Inter,sans-serif!important;letter-spacing:.06em!important;text-transform:uppercase!important;color:#9fe8b4!important;text-shadow:none!important}#wl .cs-ol{margin:0 0 6px;padding-left:26px}#wl .cs-ol li{margin:3px 0}#wl .cs-who{font-size:13.5px;color:rgba(243,236,224,.75);margin:6px 0 10px}#wl label.cs-chk{display:flex!important;gap:10px;align-items:flex-start;margin:10px 0!important;padding:12px 14px!important;border-radius:12px;border:1px solid rgba(0,255,119,.35);background:rgba(0,255,119,.06);font:600 15px/1.4 Inter,sans-serif!important;color:#f3ece0!important;text-transform:none!important;letter-spacing:normal!important;cursor:pointer}#wl label.cs-chk input{width:20px;height:20px;margin:0!important;flex:0 0 auto;accent-color:#18b45f}#wl .cs-l{display:block;margin:14px 0 6px!important;font:600 13px Inter,sans-serif!important;color:rgba(243,236,224,.85)!important;text-transform:none!important;letter-spacing:normal!important}#wl input.cs-in{width:100%!important;box-sizing:border-box;padding:12px 14px!important;border-radius:10px!important;border:1px solid #3a3020!important;background:#16120d!important;color:#f3ece0!important;-webkit-text-fill-color:#f3ece0!important;font:17px Inter,sans-serif!important}#wl input:-webkit-autofill,#wl input:-webkit-autofill:hover,#wl input:-webkit-autofill:focus,#wl textarea:-webkit-autofill{-webkit-box-shadow:0 0 0 1000px #16120d inset!important;box-shadow:0 0 0 1000px #16120d inset!important;-webkit-text-fill-color:#f3ece0!important;caret-color:#f3ece0!important;transition:background-color 9999s}#wl .cs-pad{position:relative;border-radius:12px;background:#fff;border:2px dashed #c9bfa8;overflow:hidden}#wl .cs-pad canvas{display:block;width:100%;height:180px;touch-action:none;cursor:crosshair}#wl .cs-ligne{position:absolute;left:18px;right:18px;bottom:42px;border-bottom:1px solid #d8cdb5;pointer-events:none}#wl .btn.cs-eff{position:absolute;right:8px;top:8px;background:#f3ece0!important;color:#1f1a12!important;-webkit-text-fill-color:#1f1a12!important;border-color:#d8cdb5!important}#wl .cs-err{min-height:20px;margin:10px 0 4px;color:#ff9aa8;font-size:13.5px}#wl .btn.cs-go{display:block;width:100%!important;box-sizing:border-box;padding:14px!important;font-size:16px!important;margin-top:6px}#wl .btn.cs-go[disabled]{opacity:.4}#wl .cs-pied{margin:12px 0 0;font-size:12px;line-height:1.5;color:rgba(243,236,224,.55)}#wl .cs-ap{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px;margin:-8px -8px 16px;padding:10px 12px;border-radius:12px;background:rgba(255,176,32,.12);border:1px solid rgba(255,176,32,.5);color:#ffe0a3;font-size:13.5px}#wl .cs-fait{text-align:center}#wl .cs-ok-ic{font-size:44px;margin:14px 0 4px}#wl .cs-date{font-size:17px;color:#f3ece0;margin:10px 0 4px}#wl .cs-j{margin:12px 0 4px;padding-top:10px;border-top:1px solid rgba(255,255,255,.08)}#wl .cs-jn{font-weight:700;margin-bottom:6px}#wl .cs-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:6px 0;padding:8px;border-radius:10px;background:rgba(255,255,255,.035)}#wl .cs-sigmini{width:120px;height:40px;object-fit:contain;background:#fff;border-radius:6px;border:1px solid #d8cdb5}#wl .tag.eq-test{background:rgba(255,176,32,.18)!important;color:#ffc861!important;border-color:rgba(255,176,32,.55)!important;font-weight:800;letter-spacing:.06em}#wl .eq-m{margin:10px 0;padding:12px;border-radius:12px;background:rgba(255,255,255,.035);border:1px solid rgba(255,255,255,.08)}#wl .eq-m.off{opacity:.62}#wl .eq-h{display:flex;gap:10px;align-items:flex-start;flex-wrap:wrap}#wl .eq-b{gap:6px;flex-wrap:wrap;margin:0}#wl .eq-f{margin-top:12px;padding-top:12px;border-top:1px solid rgba(255,255,255,.08)}#wl .eq-ft{font-weight:800;margin-bottom:4px}#wl .eq-f label{display:block;margin:10px 0 4px;font-size:13px;font-weight:600}#wl .eq-f .in{width:100%;box-sizing:border-box}#wl .eq-f textarea.in{min-height:66px;font:14px/1.45 Inter,system-ui,sans-serif;resize:vertical}#wl .eq-2{display:grid;grid-template-columns:1fr 1fr;gap:10px}#wl .eq-f label.eq-chk{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:12px}#wl .eq-f label.eq-chk input{width:18px;height:18px;margin:0}#wl #wl-equipe>.eq-f{padding:12px;border-radius:12px;background:rgba(0,255,119,.05);border:1px solid rgba(0,255,119,.25)}#wl .bx-m{margin:10px 0;padding:12px;border-radius:12px;background:rgba(255,255,255,.035);border:1px solid rgba(255,255,255,.08)}#wl .bx-m.off{opacity:.62}#wl .bx-m.sys{background:rgba(255,255,255,.02);border-style:dashed}#wl .bx-h{display:flex;gap:10px;align-items:flex-start;flex-wrap:wrap}#wl .bx-i{min-width:0;flex:1 1 260px}#wl .tel{position:fixed;right:16px;bottom:16px;width:min(430px,calc(100vw - 32px));max-height:min(680px,calc(100vh - 90px));z-index:15;display:none;flex-direction:column;background:#120f0b;border:1px solid rgba(0,255,119,.35);border-radius:18px;box-shadow:0 24px 70px rgba(0,0,0,.6);overflow:hidden}#wl .tel.open{display:flex}#wl .tel-h{display:flex;align-items:center;gap:10px;padding:12px 14px;border-bottom:1px solid rgba(255,255,255,.08)}#wl .tel-h .em{font-size:22px}#wl .tel-h .nm{font-weight:700}#wl .tel-h .st{font-size:12px;color:rgba(243,236,224,.6)}#wl .tel-h .x{cursor:pointer;font-size:18px;padding:4px 8px}#wl .tel-fil{flex:1 1 auto;overflow-y:auto;padding:12px;max-width:none;min-height:120px}#wl .tel-fil .bub{max-width:94%}#wl .tel-c{padding:10px 12px 12px;border-top:1px solid rgba(255,255,255,.08)}#wl .tel-c textarea{width:100%;resize:vertical;min-height:52px}#wl .tel-a{margin-top:8px;padding:8px 10px;border-radius:10px;background:rgba(0,0,0,.22);border:1px solid rgba(255,255,255,.1);white-space:normal}#wl .tel-a ol,#wl .tel-a ul{margin:6px 0 4px 18px;padding:0}#wl .tel-a p{margin:6px 0}#wl .tel-ab{gap:6px;margin-top:6px;flex-wrap:wrap;align-items:center}#wl .bub.tel-tr{border-style:dashed}#wl .tel-att{opacity:.75;font-style:italic}#wl .tel-vide{padding:6px 2px;line-height:1.5}#wl .tel-b{margin-left:auto;font-size:16px!important;padding:4px 9px!important}#wl .tel-svg{cursor:pointer}#wl .tel-svg:hover circle{stroke:#00ff77}#wl .info-svg{cursor:pointer;opacity:.45;transition:opacity .15s}#wl .info-svg:hover,#wl .info-svg:focus,#wl .ag:hover .info-svg{opacity:1}#wl .info-svg:focus{outline:none}#wl .info-svg:focus circle+circle{stroke:#00ff77;stroke-width:2}@media (hover:none){#wl .info-svg{opacity:.7}}#wl .if-bg{position:fixed;inset:0;z-index:80;display:flex;align-items:flex-start;justify-content:center;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:24px 16px;background:rgba(5,4,3,.72);opacity:0;transition:opacity .15s}#wl .if-bg.on{opacity:1}#wl .if{position:relative;width:min(640px,100%);margin:auto 0;padding:22px 22px 18px;border-radius:18px;background:#120f0b;border:1px solid rgba(0,255,119,.35);box-shadow:0 24px 70px rgba(0,0,0,.6);color:#f3ece0;outline:none;box-sizing:border-box}#wl .if-x{position:absolute;top:10px;right:10px;width:40px;height:40px;padding:0!important;border-radius:10px!important;border:1px solid rgba(255,255,255,.14)!important;background:transparent!important;color:#f3ece0!important;font-size:18px!important;line-height:1!important;cursor:pointer;box-shadow:none!important}#wl .if-h{display:flex;gap:12px;align-items:center;padding-right:44px}#wl .if-em{font-size:34px;line-height:1}#wl .if-k0{font:700 11px 'JetBrains Mono',ui-monospace,monospace;letter-spacing:.16em;text-transform:uppercase;color:#00ff77}#wl .if h2{margin:2px 0 0!important;font:800 22px/1.2 Inter,system-ui,sans-serif!important;color:#f3ece0!important;letter-spacing:normal!important;text-transform:none!important}#wl .if-s{font-size:13px;color:rgba(243,236,224,.6)}#wl .if-r{margin:14px 0 8px;font-size:16px;line-height:1.55}#wl .if-t2{margin:18px 0 8px!important;font:700 13px Inter,sans-serif!important;letter-spacing:.06em!important;text-transform:uppercase!important;color:rgba(243,236,224,.7)!important}#wl .if-k{margin:10px 0 3px;font-weight:700;font-size:12.5px;color:rgba(243,236,224,.7)}#wl .if-ex{margin:2px 0 6px 18px;padding:0;font-size:14.5px;line-height:1.5}#wl .if-ex li{margin:3px 0;font-style:italic}#wl .if-c{margin:8px 0;border:1px solid rgba(255,255,255,.1);border-radius:12px;background:rgba(255,255,255,.035)}#wl .if-c summary{cursor:pointer;padding:12px 14px;font-weight:700;font-size:15px;line-height:1.35}#wl .if-c[open] summary{border-bottom:1px solid rgba(255,255,255,.08)}#wl .if-cb{padding:4px 14px 12px;font-size:14.5px;line-height:1.5}#wl .if-cb p{margin:4px 0}#wl .if-tr{margin:4px 0 6px 18px;padding:0;font-size:14.5px;line-height:1.5}#wl .if-tr li{margin:4px 0}#wl .if-n{margin:8px 0;padding:9px 11px;border-radius:10px;background:rgba(255,176,32,.12);border:1px solid rgba(255,176,32,.38);font-size:14px;line-height:1.45}#wl .if-a{display:flex;flex-wrap:wrap;gap:8px;margin-top:16px}#wl .if-tabs{display:flex;gap:6px;overflow-x:auto;-webkit-overflow-scrolling:touch;margin:14px -4px 4px;padding:2px 4px 6px;scrollbar-width:thin}#wl .if-tab{flex:0 0 auto;min-height:40px;padding:8px 14px!important;border-radius:999px!important;border:1px solid rgba(255,255,255,.16)!important;background:rgba(255,255,255,.04)!important;color:#f3ece0!important;font:600 14px Inter,system-ui,sans-serif!important;cursor:pointer;white-space:nowrap;box-shadow:none!important;text-transform:none!important;letter-spacing:normal!important}#wl .if-tab.on{border-color:#00ff77!important;background:rgba(0,255,119,.12)!important;color:#c9ffe0!important}#wl .if-panel{margin-top:8px;padding-top:10px;border-top:1px solid rgba(255,255,255,.08)}#wl .if-h2{display:flex;gap:10px;align-items:center;font-size:17px}#wl .if-h2 .if-em{font-size:26px}@media (max-width:560px){#wl .if-bg{padding:0;align-items:flex-start}#wl .if{border-radius:18px 18px 0 0;margin:auto 0 0;padding:18px 16px 22px;min-height:60vh}#wl .if-x{position:sticky;top:8px;float:right;margin:-8px -6px 0 8px;z-index:2;background:#120f0b!important}#wl .if-a .btn{flex:1 1 100%}}#wl .ap{margin:16px 0;padding:14px 16px;border-radius:14px;border:1px solid rgba(10,122,69,.35);background:rgba(10,122,69,.06)}#wl .ap-h{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}#wl .ap-h .x{cursor:pointer;padding:2px 8px}#wl .ap-aide{margin:8px 0;padding:9px 11px;border-radius:10px;background:rgba(255,176,32,.12);border:1px solid rgba(255,176,32,.38);font-size:14px;line-height:1.45}#wl .ap-aide ul{margin:6px 0 0 18px;padding:0}#wl .ap-s{font-size:12.5px;opacity:.75;line-height:1.45}#wl .ap-ok{display:flex;gap:10px;align-items:flex-start;margin:10px 0;cursor:pointer}#wl .ap-ok input{margin-top:4px;width:18px;height:18px;flex:0 0 auto}#wl .ap-live-h{display:flex;align-items:center;gap:6px;margin-bottom:6px}#wl .ap-rec{width:10px;height:10px;border-radius:50%;background:#ff3d5a;animation:wlmic 1.2s ease-in-out infinite}#wl .ap-live{min-height:120px;max-height:300px;overflow-y:auto;white-space:pre-wrap;padding:10px 12px;border-radius:10px;background:rgba(0,0,0,.05);border:1px solid rgba(0,0,0,.14);font-size:15px;line-height:1.5}#wl .ap-int{opacity:.55}#wl .autres-postes{display:flex;flex-wrap:wrap;gap:6px 8px;align-items:center;margin:10px 0 0}#wl .canal-l{display:flex;flex-wrap:wrap;gap:6px 10px;align-items:center;margin:6px 0 10px;font-size:14px}#wl .canal-l select{padding:4px 8px;border-radius:8px;border:1px solid rgba(0,0,0,.25);background:#fffdf7;color:#1f1a12;font:14px Inter,system-ui,sans-serif}#wl .ap-lang{display:flex;gap:8px;align-items:center;margin-top:6px;opacity:1}#wl .ap-lang select{padding:4px 8px;border-radius:8px;border:1px solid rgba(0,0,0,.25);background:#fffdf7;color:#1f1a12;font:14px Inter,system-ui,sans-serif}@media (max-width:720px){#wl .tel{right:0;left:0;bottom:0;width:100vw;max-height:88vh;border-radius:18px 18px 0 0}}#wl .bx-b{gap:6px;flex-wrap:wrap;margin:0}#wl .bx-err{margin-top:6px;padding:8px 10px;border-radius:8px;background:rgba(255,80,100,.1);border:1px solid rgba(255,80,100,.35);font-size:13px;color:#ffb3bf}#wl .tag.bx-sys{background:rgba(127,178,255,.14)!important;color:#a9c8ff!important;border-color:rgba(127,178,255,.45)!important}#wl .bx-t{margin:16px 0 4px;font-weight:800;font-size:13px;letter-spacing:.06em;text-transform:uppercase;opacity:.75}#wl .bx-f{margin-top:10px;padding-top:10px;border-top:1px solid rgba(255,255,255,.08)}#wl .bx-f label,#wl .bx-w label{display:block;margin:10px 0 4px;font-size:13px;font-weight:600}#wl .bx-f .in,#wl .bx-w .in{width:100%;box-sizing:border-box}#wl .bx-w{margin:10px 0;padding:14px;border-radius:14px;background:rgba(0,255,119,.05);border:1px solid rgba(0,255,119,.28)}#wl .bx-steps{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px}#wl .bx-steps span{font-size:12px;font-weight:700;padding:4px 10px;border-radius:999px;border:1px solid rgba(255,255,255,.14);opacity:.6}#wl .bx-steps span.on{opacity:1;border-color:#00ff77;color:#00ff77}#wl .bx-steps span.ok{opacity:.9;color:#7fe0a8}#wl .bx-choix{display:flex;gap:8px;flex-wrap:wrap}#wl .bx-c{padding:9px 14px;border-radius:10px;border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.04);color:inherit;font:600 14px Inter,system-ui,sans-serif;cursor:pointer}#wl .bx-c.on{border-color:#00ff77;background:rgba(0,255,119,.12);color:#c9ffe0}#wl .bx-note{margin-top:6px;padding:8px 10px;border-radius:8px;background:rgba(255,176,32,.1);border:1px solid rgba(255,176,32,.35)}#wl .bx-av{margin-top:12px}#wl .bx-av summary{cursor:pointer;font-weight:600;font-size:13px}#wl .bx-2{display:grid;grid-template-columns:1fr 110px;gap:10px}#wl .bx-nav{gap:8px;justify-content:space-between;margin-top:14px;flex-wrap:wrap}#wl .bx-adr{font-size:13px;opacity:.75;margin:6px 0 10px;word-break:break-all}#wl .bx-r{margin:8px 0;padding:10px 12px;border-radius:10px;border:1px solid rgba(255,255,255,.12);font-size:14px}#wl .bx-r div{margin-top:4px;font-size:13.5px;opacity:.9}#wl .bx-r.ok{border-color:rgba(0,255,119,.4);background:rgba(0,255,119,.07)}#wl .bx-r.ko{border-color:rgba(255,80,100,.45);background:rgba(255,80,100,.08)}#wl .bx-r.enc{opacity:.75}#wl .bx-roles{display:grid;grid-template-columns:1fr 1fr;gap:8px}#wl .bx-role{text-align:left;padding:10px 12px;border-radius:12px;border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.04);color:inherit;font:14px Inter,system-ui,sans-serif;cursor:pointer}#wl .bx-role>span:not(.tag){display:block;margin-top:4px;font-size:12.5px;opacity:.75}#wl .bx-role>.tag{margin-left:6px;font-size:11px;vertical-align:1px}#wl .bx-role.on{border-color:#00ff77;background:rgba(0,255,119,.12)}#wl .bx-role.bientot{opacity:.45;cursor:not-allowed}#wl table.bx-recap{width:100%;border-collapse:collapse;margin:6px 0 10px;font-size:14px}#wl table.bx-recap td{padding:7px 8px;border-top:1px solid rgba(255,255,255,.08);vertical-align:top;word-break:break-word}#wl table.bx-recap td:first-child{width:34%;opacity:.7}@media (max-width:560px){#wl .bx-roles{grid-template-columns:1fr}#wl .bx-h>div:first-child{flex:1 1 100%!important}#wl .eq-2{grid-template-columns:1fr}#wl .eq-h>div:first-child{flex:1 1 100%!important}}@media (max-width:720px){#wl .cs-bg{padding:8px}#wl .cs{padding:18px 16px 16px;margin:6px auto 30px;border-radius:16px}#wl .cs-t{font-size:20px!important}#wl .cs-x{max-height:42vh;font-size:14.5px;padding:12px 14px}}\
#wl .dtop{position:sticky;top:0;z-index:3;display:flex;align-items:center;gap:10px;padding:10px 14px;background:rgba(11,10,8,.92);border-bottom:1px solid rgba(255,190,90,.18)}\
#wl .dtop .em{font-size:24px}#wl .dtop .nm{font-weight:800;font-size:15px;line-height:1.2}#wl .dtop .st{font-size:12px;color:rgba(243,236,224,.6)}\
#wl .dtop .x{margin-left:auto;cursor:pointer;font-size:24px;color:rgba(243,236,224,.75);padding:2px 10px}\
#wl .paper{max-width:820px;margin:14px auto 80px;background:#f8f4ea;color:#1f1a12;border-radius:6px;box-shadow:0 30px 80px rgba(0,0,0,.6);padding:34px 42px 40px;font-family:Georgia,'Iowan Old Style','Times New Roman',serif;font-size:17px;line-height:1.6}\
#wl .paper *{text-shadow:none!important;letter-spacing:normal}\
#wl .paper .kick{font-family:Inter,sans-serif;font-size:11.5px;font-weight:800;letter-spacing:.16em;text-transform:uppercase;color:#7a6e58}\
#wl .paper h1{font-size:26px;line-height:1.2;margin:8px 0 6px;font-weight:700;color:#1f1a12!important;-webkit-text-fill-color:#1f1a12!important;font-family:Georgia,serif!important;text-transform:none!important;background:none!important}\
#wl .paper h1::before,#wl .paper h1::after,#wl .paper h2::before,#wl .paper h2::after{content:none!important}\
#wl .paper h2{font-family:Inter,sans-serif!important;font-size:12.5px;letter-spacing:.14em!important;text-transform:uppercase;color:#0a7a45!important;-webkit-text-fill-color:#0a7a45!important;margin:26px 0 8px;padding-top:14px;border-top:1px solid #ddd3bd;font-weight:800}\
#wl .paper p,#wl .paper li,#wl .paper .txt{color:#1f1a12!important;-webkit-text-fill-color:#1f1a12!important}\
#wl .paper .meta{font-family:Inter,sans-serif;font-size:13.5px;color:#5e5544;margin-bottom:16px}\
#wl .paper .txt{white-space:pre-wrap;word-wrap:break-word;font-size:16.5px}\
#wl .paper .lead{font-family:Inter,sans-serif;font-size:14px;background:#efe6d0;border-radius:8px;padding:10px 12px;margin:10px 0 14px;color:#3c3426}\
#wl .paper .warn{font-family:Inter,sans-serif;font-size:14px;background:#fff1d6;border-left:4px solid #e0a020;border-radius:0 8px 8px 0;padding:10px 12px;margin:10px 0;color:#4a3c1c}\
#wl .paper input.pin,#wl .paper textarea.pin{width:100%;background:#fff;color:#1f1a12;border:1px solid #d4c8ad;border-radius:8px;padding:10px 11px;font:16px Inter,system-ui,sans-serif;-webkit-text-fill-color:#1f1a12}\
#wl .paper textarea.pin{min-height:120px;resize:vertical;line-height:1.5}#wl .paper textarea.pin.big{min-height:380px;font:16px Georgia,'Iowan Old Style',serif}\
#wl .paper input.pin.sub{font-weight:700;font-size:18px}\
#wl .paper label{display:block;font-family:Inter,sans-serif;font-size:12.5px;color:#6b604b;margin:12px 0 4px;font-weight:700}\
#wl .paper .acts{display:flex;flex-wrap:wrap;gap:8px;margin:18px 0 6px}\
#wl .paper .acts button,#wl .paper button.pb2{cursor:pointer;font:700 14px Inter,system-ui,sans-serif!important;text-transform:none!important;letter-spacing:normal!important;box-shadow:none!important;padding:10px 14px!important;border-radius:10px!important;border:1px solid #cbbf9f!important;background:#fff!important;color:#1f1a12!important;-webkit-text-fill-color:#1f1a12!important}\
#wl .paper .acts button.go{background:#0a7a45!important;border-color:#0a7a45!important;color:#fff!important;-webkit-text-fill-color:#fff!important}\
#wl .paper .acts button.red{color:#a3122a!important;-webkit-text-fill-color:#a3122a!important;border-color:#e6b8c0!important}\
#wl .paper .acts button[disabled]{opacity:.45;cursor:not-allowed}\
#wl .paper .tl{font-family:Inter,sans-serif;font-size:13px;color:#5e5544;margin:0;padding:0;list-style:none}\
#wl .paper .tl li{padding:4px 0;border-bottom:1px dashed #e2d8c2;color:#5e5544!important;-webkit-text-fill-color:#5e5544!important}\
#wl .paper .prop{border:1px solid #d9ccb0;border-radius:10px;padding:12px;margin:10px 0;background:#fffdf7}\
#wl .paper .prop.sel{border-color:#0a7a45;box-shadow:0 0 0 2px rgba(10,122,69,.25)}\
#wl .paper .prop .ou{font-family:Inter,sans-serif;font-size:12.5px;color:#6b604b;margin-top:6px}\
#wl .paper .blk{cursor:pointer;font-family:Inter,sans-serif;font-size:13.5px;padding:8px 10px;border-radius:8px;border:1px solid transparent;color:#2c2618;display:flex;gap:10px}\
#wl .paper .blk:hover{background:#efe6d0}#wl .paper .blk.sel{border-color:#0a7a45;background:#e6f5ec}\
#wl .paper .blk .kd{flex:none;min-width:86px;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.06em;color:#8a7d62;padding-top:2px}\
#wl .paper .blk.h .tx{font-weight:800}#wl .paper .blk .tx{color:#2c2618!important;-webkit-text-fill-color:#2c2618!important}\
#wl .paper .ins{font-family:Inter,sans-serif;font-size:13px;color:#0a7a45;font-weight:800;padding:4px 10px}\
#wl .paper details summary{cursor:pointer;font-family:Inter,sans-serif;font-weight:700;font-size:14px;color:#0a7a45;padding:6px 0}\
#wl .paper a{color:#0a7a45!important;-webkit-text-fill-color:#0a7a45!important;text-decoration:underline}\
#wl .paper .tag{background:#efe6d0;color:#4a4130}#wl .paper .tag.g{background:#d9f3e3;color:#0a6a3c}#wl .paper .tag.a{background:#ffefcc;color:#8a5a00}#wl .paper .tag.b{background:#dde9fb;color:#1f4f8a}\
" + PHL_CSS.toast + "\
#wl .ag{cursor:pointer}#wl .ag:hover .deskTop{stroke:#ffbe5a;stroke-width:2.5}\
#wl .ag.on .bob{animation:wlbob 1.1s ease-in-out infinite}@keyframes wlbob{50%{transform:translateY(-2px)}}\
#wl .ag.on .scr{animation:wlscr 2.2s linear infinite}@keyframes wlscr{50%{opacity:.7}}\
#wl .ag .ledsvg.on{animation:wlpulse 1.2s ease-in-out infinite}\
#wl .cable{fill:none;stroke-linecap:round;stroke-linejoin:round}\
#wl .cable.live{stroke-dasharray:10 14;animation:wlflow 1.1s linear infinite}@keyframes wlflow{to{stroke-dashoffset:-24}}\
#wl .lbl{font-family:Inter,sans-serif;font-size:17px;font-weight:700;fill:#f3ece0}\
#wl .lbl2{font-family:Inter,sans-serif;font-size:13.5px;fill:rgba(243,236,224,.66)}\
#wl .roomname{font-family:'JetBrains Mono',monospace;font-size:13px;letter-spacing:.18em;fill:rgba(243,236,224,.32);text-transform:uppercase}\
#wl .pile{cursor:pointer}#wl .pile .fl{animation:wlfloat 3.2s ease-in-out infinite}@keyframes wlfloat{50%{transform:translateY(-4px)}}\
#wl .pile:hover .paperS{stroke:#00ff77;stroke-width:2}\
#wl .bulle{animation:wlfloat 2.4s ease-in-out infinite}\
#wl .here{animation:wlpulse 1.8s ease-in-out infinite}\
#wl input,#wl textarea,#wl select,#wl button{font-family:Inter,system-ui,-apple-system,sans-serif!important;letter-spacing:normal!important;text-transform:none!important;text-shadow:none!important;box-shadow:none;outline:none}\
#wl input.in,#wl textarea.in,#wl select.in{background:#16120d!important;color:#f3ece0!important;-webkit-text-fill-color:#f3ece0!important;border:1px solid #3a3020!important;border-radius:10px!important;padding:10px 11px!important;font-size:16px!important;line-height:1.45!important;width:100%!important;height:auto!important;min-height:0;margin:0!important}\
#wl textarea.in{min-height:72px!important}#wl .q textarea.in{min-height:54px!important}\
#wl input.in:focus,#wl textarea.in:focus,#wl select.in:focus{border-color:#00ff77!important;box-shadow:0 0 0 3px rgba(0,255,119,.15)!important}\
#wl .paper input.pin,#wl .paper textarea.pin{background:#fff!important;color:#1f1a12!important;-webkit-text-fill-color:#1f1a12!important;border:1px solid #d4c8ad!important;border-radius:8px!important;padding:10px 11px!important;font-size:16px!important;line-height:1.5!important;width:100%!important;height:auto!important;margin:0!important;box-shadow:none!important}\
#wl .paper textarea.pin{min-height:120px!important}#wl .paper textarea.pin.big{min-height:380px!important;font-family:Georgia,'Iowan Old Style',serif!important}\
#wl .paper input.pin.sub{font-weight:700!important;font-size:18px!important}\
#wl .paper input.pin:focus,#wl .paper textarea.pin:focus{border-color:#0a7a45!important;box-shadow:0 0 0 3px rgba(10,122,69,.18)!important}\
#wl .paper b,#wl .paper strong,#wl .paper .meta,#wl .paper label,#wl .paper .lead,#wl .paper .warn{-webkit-text-fill-color:currentColor!important;text-shadow:none!important}\
#wl .paper b,#wl .paper strong{color:inherit!important}#wl .paper .meta{color:#5e5544!important}#wl .paper label{color:#6b604b!important}\
#wl .paper .lead{color:#3c3426!important}#wl .paper .warn{color:#4a3c1c!important}#wl .paper .kick{color:#7a6e58!important;-webkit-text-fill-color:#7a6e58!important}\
#wl b,#wl strong{text-shadow:none}#wl .btn{font-family:Inter,system-ui,sans-serif!important;text-transform:none!important;letter-spacing:normal!important}\
#wl input[type=checkbox]{-webkit-appearance:checkbox!important;appearance:auto!important;width:18px!important;height:18px!important;min-height:0!important;padding:0!important;margin:0!important;background:none!important;border:none!important;accent-color:#00ff77;flex:none}\
#wl .btn{background:rgba(0,255,119,.08)!important;color:#bfffdc!important;-webkit-text-fill-color:#bfffdc!important;border:1px solid rgba(61,255,160,.35)!important;border-radius:10px!important;padding:8px 12px!important;font-size:14px!important;font-weight:600!important;line-height:1.2!important;width:auto!important;height:auto!important;min-height:0!important;margin:0!important;box-shadow:none!important}\
#wl .btn:hover{background:rgba(0,255,119,.16)!important}\
#wl .btn.go{background:#00ff77!important;color:#05170d!important;-webkit-text-fill-color:#05170d!important;border-color:#00ff77!important;font-weight:800!important}\
#wl .btn.amber{background:rgba(255,176,32,.12)!important;color:#ffe0a3!important;-webkit-text-fill-color:#ffe0a3!important;border-color:rgba(255,176,32,.5)!important}\
#wl .btn.red{background:rgba(255,61,90,.1)!important;color:#ffb3c0!important;-webkit-text-fill-color:#ffb3c0!important;border-color:rgba(255,61,90,.45)!important}\
#wl .btn.small{padding:5px 9px!important;font-size:12.5px!important;border-radius:8px!important}\
@media (max-width:720px){#wl{font-size:14.5px}#wl .top{flex-wrap:wrap;gap:8px;padding:10px 12px}#wl .chips{order:3;justify-content:flex-start;flex-basis:100%;flex-wrap:nowrap;overflow-x:auto;scrollbar-width:none}#wl .chips::-webkit-scrollbar{display:none}#wl .clock{order:2;font-size:17px;margin-left:auto}#wl .wrap{padding:0 10px 60px}#wl .tabs{padding:8px 10px 0}#wl .panel{width:100vw;top:6vh;border-radius:18px 18px 0 0;border-left:none;border-top:1px solid rgba(255,190,90,.3);transform:translateY(105%)}#wl .panel.open{transform:none}#wl .floor svg{min-width:1100px}#wl .paper{margin:10px 8px 60px;padding:22px 16px 28px;font-size:16.5px}#wl .paper h1{font-size:22px}#wl .two{grid-template-columns:1fr}#wl .kan{grid-template-columns:repeat(4,82vw)}#wl button.clsr-h{top:auto;bottom:150px;padding:10px 6px}#wl .clsr-h .lb{display:none}#wl .clsr{width:100vw;top:8vh;border-left:none;border-top:1px solid rgba(255,190,90,.3);border-radius:18px 18px 0 0;transform:translateY(105%)}#wl .clsr.open{transform:none}}\
#wl .panel,#wl .doc,#wl .clsr,#wl .cs-bg,#wl .wrap,#wl .tel{overflow-wrap:anywhere;word-break:break-word}#wl .panel,#wl .doc,#wl .clsr,#wl .cs-bg{overflow-x:hidden;max-width:100%}#wl .panel pre,#wl .doc pre,#wl .clsr pre{white-space:pre-wrap}#wl .dtop>div,#wl .ph2>div,#wl .tl li,#wl .feed .it>span,#wl .dcard,#wl .pp-ct-h>*{min-width:0}#wl a.src-l.h-l{white-space:nowrap}\
";
  CSS += PHL_CSS.porte; // porte de couloir vers l'autre lab (shared/lab-core.js)
  CSS += "#wl .ob-voile{position:fixed;inset:0;z-index:3998900;background:transparent;cursor:default}#wl .ob-voile.plein{background:rgba(5,4,3,.72)}#wl .ob-trou{position:fixed;z-index:3998910;left:50%;top:50%;width:0;height:0;border-radius:14px;pointer-events:none;opacity:0;box-shadow:0 0 0 200vmax rgba(5,4,3,.72);transition:left .35s cubic-bezier(.2,.8,.2,1),top .35s cubic-bezier(.2,.8,.2,1),width .35s cubic-bezier(.2,.8,.2,1),height .35s cubic-bezier(.2,.8,.2,1),opacity .2s}#wl .ob-trou.on{opacity:1;outline:2px solid #00ff77;outline-offset:2px;animation:wlObHalo 1.6s ease-in-out infinite}@keyframes wlObHalo{0%,100%{outline-color:rgba(0,255,119,.95);filter:drop-shadow(0 0 0 rgba(0,255,119,0))}50%{outline-color:rgba(0,255,119,.45);filter:drop-shadow(0 0 14px rgba(0,255,119,.45))}}#wl .ob-carte{position:fixed;z-index:3998950;right:20px;bottom:20px;width:min(400px,calc(100vw - 32px));max-height:min(72vh,620px);overflow-y:auto;-webkit-overflow-scrolling:touch;padding:16px 18px 14px;border-radius:18px;background:#14110c;border:1px solid rgba(0,255,119,.4);box-shadow:0 24px 70px rgba(0,0,0,.65),0 0 0 6px rgba(0,255,119,.06);color:#f3ece0;outline:none;box-sizing:border-box;animation:wlObIn .35s cubic-bezier(.2,.8,.2,1)}#wl .ob-carte.haut{bottom:auto;top:20px}@keyframes wlObIn{from{opacity:0;transform:translateY(16px) scale(.98)}}#wl .ob-tete{display:flex;align-items:center;gap:10px}#wl .ob-em{font-size:30px;line-height:1}#wl .ob-n{font:700 12px 'JetBrains Mono',ui-monospace,monospace;letter-spacing:.12em;color:#00ff77}#wl .ob-ap{font-size:11px;font-weight:700;padding:2px 8px;border-radius:999px;background:rgba(255,176,32,.16);color:#ffc861;border:1px solid rgba(255,176,32,.45)}#wl button.ob-x{margin-left:auto;width:34px;height:34px;padding:0!important;border-radius:10px!important;border:1px solid rgba(255,255,255,.14)!important;background:transparent!important;color:#f3ece0!important;font-size:16px!important;line-height:1!important;cursor:pointer;box-shadow:none!important}#wl .ob-barre{position:relative;height:5px;margin:10px 0 12px;border-radius:99px;background:rgba(255,255,255,.08);overflow:hidden}#wl .ob-barre i{position:absolute;left:0;top:0;bottom:0;border-radius:99px;background:linear-gradient(90deg,#18b45f,#00ff77);transition:width .35s ease}#wl h2.ob-t{margin:0 0 6px!important;font:800 19px/1.25 Inter,system-ui,sans-serif!important;color:#f3ece0!important;letter-spacing:normal!important;text-transform:none!important;text-shadow:none!important}#wl .ob-c{font-size:15px;line-height:1.55}#wl .ob-c p{margin:0 0 8px!important;color:#e9e1d2!important;font-size:15px!important;line-height:1.55!important;text-shadow:none!important}#wl ul.ob-ul{margin:4px 0 8px 18px!important;padding:0!important}#wl ul.ob-ul li{margin:3px 0!important;color:#e9e1d2!important;font-size:14.5px!important;line-height:1.45!important}#wl ul.ob-ul li b{color:#f3ece0!important}#wl .ob-c p.ob-ex{padding:8px 10px;border-radius:10px;background:rgba(0,255,119,.07);border:1px solid rgba(0,255,119,.25);font-size:14px!important;font-style:italic}#wl .ob-c p.ob-note{padding:8px 10px;border-radius:10px;background:rgba(255,176,32,.1);border:1px solid rgba(255,176,32,.35);font-size:14px!important}#wl .ob-b{display:flex;align-items:center;gap:8px;margin-top:12px;flex-wrap:wrap}#wl .ob-sp{flex:1}#wl button.ob-btn{min-height:40px;padding:8px 14px!important;border-radius:12px!important;border:1px solid rgba(255,255,255,.18)!important;background:rgba(255,255,255,.05)!important;color:#f3ece0!important;font:700 14px Inter,system-ui,sans-serif!important;cursor:pointer;box-shadow:none!important;text-transform:none!important;letter-spacing:normal!important}#wl button.ob-btn.ob-go{background:#00ff77!important;border-color:#00ff77!important;color:#05170d!important}#wl button.ob-lien{padding:6px 4px!important;border:none!important;background:transparent!important;color:rgba(243,236,224,.6)!important;font:600 13.5px Inter,system-ui,sans-serif!important;text-decoration:underline;cursor:pointer;box-shadow:none!important}#wl .ob-conf{margin-top:12px;padding:10px 12px;border-radius:12px;background:rgba(255,176,32,.1);border:1px solid rgba(255,176,32,.38);font-size:14px;line-height:1.45}#wl .ob-carte .ob-b{position:sticky;bottom:-14px;margin-bottom:-14px;padding:10px 0 14px;background:inherit}@media (max-width:640px){#wl .ob-carte{left:10px;right:10px;bottom:10px;width:auto;max-height:56vh;padding:14px 14px 12px}#wl .ob-d{display:none}#wl h2.ob-t{font-size:17px!important}#wl .ob-c p,#wl ul.ob-ul li{font-size:14px!important}}@media (prefers-reduced-motion:reduce){#wl .ob-trou,#wl .ob-trou.on,#wl .ob-carte,#wl .ob-barre i{transition:none;animation:none}}"; // visite guidée (onboarding), bloc ob- : voir obDemarrer
  // Mode clair (22/10/2026) : la feuille claire est DÉRIVÉE de la feuille sombre ci-dessus par PHTheme.deriverClair
  // (shared/theme-mode.js) et ne s'applique que sous « #wl.wl-clair » : le mode sombre reste identique.
  // Ici, les seuls compléments écrits à la main : sols du plan (attributs SVG) et textes forcés par le thème du site.
  var CSS_CLAIR_MAIN = "#wl.wl-clair .floor svg rect[fill=\"#0a0806\"]{fill:#ddd5c6}\n#wl.wl-clair .floor svg rect[fill=\"#100d09\"]{fill:#e9e2d5}\n#wl.wl-clair .floor svg rect[fill=\"#16110b\"]{fill:#f7f0e4}\n#wl.wl-clair .floor svg rect[fill=\"#0b1216\"]{fill:#ebf2f6}\n#wl.wl-clair .floor svg rect[fill=\"#120e19\"]{fill:#f1ecf7}\n#wl.wl-clair .floor svg rect[fill=\"#0c1414\"]{fill:#e9f4f3}\n#wl.wl-clair .floor svg rect[fill=\"#0f140c\"]{fill:#eff5e9}\n#wl.wl-clair .floor svg rect[fill=\"#0c0f16\"]{fill:#ebeef7}\n#wl.wl-clair .floor svg rect[fill=\"#0a0d0b\"]{fill:#eef2ef}\n#wl.wl-clair .floor svg rect[fill=\"#16100c\"]{fill:#f8efe7}\n#wl.wl-clair .floor svg rect[fill=\"#110d07\"]{fill:#f5efe3}\n#wl.wl-clair .floor svg rect[fill=\"#08120f\"]{fill:#e7f4ef}\n#wl.wl-clair .floor svg rect[stroke=\"rgba(243,236,224,.16)\"]{stroke:rgba(31,26,18,.2)}\n#wl.wl-clair .floor svg path[stroke=\"rgba(0,0,0,.6)\"]{stroke:rgba(60,45,20,.1)}\n#wl.wl-clair .floor svg path[stroke=\"rgba(255,190,90,.18)\"]{stroke:rgba(150,100,30,.38)}\n#wl.wl-clair .floor svg pattern path[stroke=\"rgba(255,255,255,.035)\"]{stroke:rgba(31,26,18,.06)}\n#wl.wl-clair .floor svg pattern path[stroke=\"rgba(255,190,90,.05)\"]{stroke:rgba(150,100,30,.12)}\n#wl.wl-clair .tip,#wl.wl-clair .paper{box-shadow:0 12px 40px rgba(60,45,20,.22)}\n#wl.wl-clair p:not([class]),#wl.wl-clair li:not([class]),#wl.wl-clair b:not([class]),#wl.wl-clair strong:not([class]),#wl.wl-clair em:not([class]),#wl.wl-clair i:not([class]){color:inherit!important;-webkit-text-fill-color:currentColor!important;text-shadow:none!important}\n#wl.wl-clair h1:not([class]),#wl.wl-clair h2:not([class]),#wl.wl-clair h3:not([class]),#wl.wl-clair h4:not([class]),#wl.wl-clair h5:not([class]){color:rgba(31,26,18,.82)!important;-webkit-text-fill-color:currentColor!important;text-shadow:none!important}\n#wl.wl-clair a:not(.btn):not(.chip){color:#0a7a45!important;-webkit-text-fill-color:currentColor!important;text-shadow:none!important}\n#wl.wl-clair p.muted,#wl.wl-clair p.hint,#wl.wl-clair p.cz-s{color:rgba(31,26,18,.68)!important;-webkit-text-fill-color:currentColor!important}";
  CSS_CLAIR_MAIN += "\n#wl.wl-clair .ob-trou{box-shadow:0 0 0 200vmax rgba(24,18,10,.58)!important;outline-color:#0a7a45!important}#wl.wl-clair .ob-voile.plein{background:rgba(24,18,10,.58)!important}#wl.wl-clair .ob-carte{box-shadow:0 24px 70px rgba(40,30,15,.35),0 0 0 6px rgba(10,122,69,.08)!important}"; // visite guidée : le projecteur reste sombre en mode clair

  // ---------- le plan de la rédaction (SVG, 1600 × 1000) ----------
  // Plan en largeur (21/10/2026) : 4 pièces par rangée, 2 rangées → beaucoup moins haut, tout le monde voit tous les bureaux.
  // Plan sur TROIS rangées (23/10/2026) : sur deux rangées de 3200 de large, tout devenait minuscule sur un portable.
  // Rangée 1 = l'écriture (rédaction, secrétariat, bibliothèque) ; rangée 2 = ce qui en sort (courrier, marbre, décisions) ;
  // rangée 3 = l'arrière (chef, service client, marketing, comptabilité). Deux couloirs : y 390 et y 760 (CORR).
  // v2 (23/10) : rangées resserrées à ce dont elles ont besoin (étagère à 80 %) et toile moins large -> plan moins haut, tout plus grand.
  var PLAN_W = 1700, PLAN_H = 1150, CORR = [390, 760];
  var ROOMS = [
    { key: 'redac', name: 'Salle de rédaction', x: 30, y: 30, w: 560, h: 330, floor: '#16110b' },
    { key: 'secr', name: 'Secrétariat', x: 610, y: 30, w: 620, h: 330, floor: '#0b1216' },
    { key: 'biblio', name: 'Bibliothèque', x: 1250, y: 30, w: 420, h: 330, floor: '#120e19' },
    { key: 'courrier', name: 'Salle du courrier', x: 30, y: 420, w: 440, h: 310, floor: '#0c0f16' },
    { key: 'marbre', name: 'Le marbre · Ghost', x: 490, y: 420, w: 440, h: 310, floor: '#0a0d0b' },
    { key: 'decisions', name: 'Salle des décisions · Usine', x: 950, y: 420, w: 720, h: 310, floor: '#08120f' },
    { key: 'chef', name: 'Bureau du rédacteur en chef', x: 30, y: 790, w: 440, h: 330, floor: '#0f140c' },
    { key: 'sc', name: 'Service client · subs@', x: 490, y: 790, w: 280, h: 330, floor: '#0c1414' },
    { key: 'mk', name: 'Marketing · redaction@', x: 790, y: 790, w: 280, h: 330, floor: '#16100c' },
    { key: 'compta', name: 'Arrière-salle · comptabilité', x: 1090, y: 790, w: 580, h: 330, floor: '#110d07' }
  ];
  function rooms() { return ROOMS; }
  function people() {
    var eq = D().equipe || [];
    // 23/10/2026 : un bureau par journaliste ACTIVE (3 postes au plus) ; inactive = plus de bureau ; aucune = « poste à attribuer ».
    var js = eq.filter(function (w) { return w.role !== 'chef' && w.actif !== false; }).slice(0, 3);
    var chef = eq.filter(function (w) { return w.role === 'chef' && w.actif !== false; })[0] || { id: 'chef', nom: 'Le rédacteur en chef', titre: 'Rédacteur en chef' };
    var xs = js.length === 3 ? [130, 310, 490] : js.length === 2 ? [190, 430] : [310];
    var list = [];
    if (!js.length) list.push({ key: 'j:vide', kind: 'journaliste', vide: true, nom: 'Poste de la journaliste', titre: 'à attribuer', emoji: '✍️', hue: 330, x: 310, y: 215 });
    js.forEach(function (w, i) { list.push({ key: 'j:' + w.id, id: w.id, kind: 'journaliste', nom: w.nom, titre: w.titre, test: !!w.test, emoji: '✍️', hue: [330, 300, 15][i], x: xs[i], y: 215 }); });
    list.push({ key: 'chef', id: chef.id, kind: 'chef', nom: chef.nom, titre: chef.titre || 'Rédacteur en chef', emoji: '🧐', hue: 40, x: 250, y: 950 });
    list.push({ key: 'courrier', kind: 'courrier', nom: 'Le Courrier', titre: 'Suit les réponses', emoji: '📬', x: 330, y: 590, device: true });
    list.push({ key: 'marbre', kind: 'marbre', nom: 'Le Marbre', titre: 'Les brouillons Ghost', emoji: '📰', x: 770, y: 590, device: true });
    // Postes du catalogue (shared/wl-catalogue.json) qui ont un emplacement : leur bureau, automatiquement.
    (CAT.postes || []).forEach(function (P) { if (P.plan) list.push({ key: P.id, kind: P.id, nom: P.nom, titre: P.titre || '', emoji: P.emoji, hue: P.plan.teinte == null ? 210 : P.plan.teinte, x: P.plan.x, y: P.plan.y, catalogue: true }); });
    // Salle des décisions (22/10/2026) : ce que Telegram montrait et permettait de commander, en propre. Chaque poste = une entrée
    // de DECISIONS (plus bas) ; la future « Décisions vidéo » s'ajoute ici avec sa propre clé, sans toucher au reste.
    list.push({ key: 'radar', kind: 'radar', nom: 'Le Radar', titre: 'Les sujets du jour', emoji: '📡', x: 1130, y: 590, device: true });
    list.push({ key: 'votes', kind: 'votes', nom: 'Votes du public', titre: 'posthumain.com/vote', emoji: '🗳️', x: 1470, y: 590, device: true });
    return list;
  }
  function P(key) { return people().filter(function (p) { return p.key === key; })[0]; }
  function isMe(p) { return !!p.id && p.id === D().me.id; }
  function stOf(p) {
    var b = S.busy[p.kind];
    if (b) return { s: 'on', why: b };
    if (p.kind === 'secretaire') { var n = by('brouillon').length, nr = relancesPretes().length; return n || nr ? { s: 'slot', why: [n ? n + ' mail' + pl(n) + ' à valider' : '', nr ? nr + ' relance' + pl(nr) + ' prête' + pl(nr) : ''].filter(Boolean).join(' · ') } : { s: 'off', why: 'prête à écrire' }; }
    if (p.kind === 'assistant') { var k = S.qs.filter(function (q) { return q.garde; }).length; return S.art ? (k ? { s: 'slot', why: k + ' question' + pl(k) + ' retenue' + pl(k) } : { s: 'off', why: 'prêt à aider' }) : { s: 'off', why: 'choisissez un article' }; }
    if (p.kind === 'courrier') { var r = by('a répondu').length, e = by('envoyé').length; return r ? { s: 'on', why: r + ' réponse' + pl(r) + ' à traiter' } : e ? { s: 'slot', why: e + ' en attente de réponse' } : { s: 'off', why: 'aucun courrier en cours' }; }
    if (p.kind === 'sc' || p.kind === 'mk') {
      var ms = mailsBureau(p.kind), nd = ms.filter(function (m) { return m.categorie === 'demande' && !m.brouillon_corps; }).length, nb = ms.filter(function (m) { return m.brouillon_corps; }).length, nv = ms.filter(function (m) { return m.categorie === 'verifier'; }).length;
      return nd ? { s: 'on', why: nd + ' demande' + pl(nd) + ' à traiter' } : nb ? { s: 'slot', why: nb + ' réponse' + pl(nb) + ' à valider' } : nv ? { s: 'slot', why: nv + ' mail' + pl(nv) + ' à vérifier' } : { s: 'off', why: 'boîte à jour' };
    }
    if (p.kind === 'compta') {
      var R = S.pieces || {}, me0 = D().me, af = (R.conversions || []).filter(function (c) { return c.statut === 'a_facturer' && (me0.chef || c.membre === me0.id); }).length;
      var av = me0.chef ? (R.pieces || []).filter(function (x) { return x.statut === 'a_verifier'; }).length : 0;
      var dm = me0.chef ? Object.keys(R.demandes || {}).filter(function (k) { return R.demandes[k] === R.mois && ((R.soldes || {})[k] || 0) > 0; }).length : 0;
      return dm ? { s: 'on', why: dm + ' demande' + pl(dm) + ' de paiement' } : af ? { s: 'slot', why: af + ' montant' + pl(af) + ' à facturer' } : av ? { s: 'slot', why: av + ' à vérifier' } : { s: 'off', why: 'compte les pièces' };
    }
    if (p.kind === 'radar') {
      var RD = S.radar;
      if (!RD) return { s: 'off', why: 'ouvrir pour voir les sujets' };
      if (!RD.ok) return { s: 'err', why: 'à configurer' };
      var nv = (RD.votes || []).filter(function (v) { return v.statut === 'new'; }).length, nf = (RD.file || []).length;
      return nv ? { s: 'on', why: '🗳️ sujet voté en tête' } : nf ? { s: 'slot', why: nf + ' sujet' + pl(nf) + ' en file' } : { s: 'off', why: (RD.sujets || []).length + ' sujet' + pl((RD.sujets || []).length) + ' notés' };
    }
    if (p.kind === 'votes') return { s: 'off', why: 'la salle des votes' };
    if (p.kind === 'marbre') { var a = D().articles.filter(function (x) { return x.statut !== 'published'; }).length, au = S.marbre && S.marbre.ok ? (S.marbre.brouillons || []).filter(function (x) { return x.statut === 'drafted'; }).length : 0;
      if (au) return { s: 'on', why: au + ' brouillon' + pl(au) + ' de l’Usine à approuver' }; return { s: a ? 'slot' : 'off', why: a + ' brouillon' + pl(a) + ' sur le marbre' }; }
    if (p.vide) return { s: 'off', why: 'poste à attribuer' };
    if (isMe(p)) return { s: 'on', why: 'vous êtes ici' };
    return { s: 'off', why: p.titre || '' };
  }
  function personSVG(p, st) {
    var hair = 'hsl(' + p.hue + ',55%,' + (st === 'off' ? 30 : 44) + '%)';
    var shirt = 'hsl(' + p.hue + ',35%,' + (st === 'off' ? 19 : 27) + '%)';
    return '<g class="bob">' +
      '<ellipse cx="0" cy="50" rx="27" ry="14" fill="' + shirt + '" stroke="rgba(0,0,0,.5)"/>' +
      '<circle cx="-12" cy="42" r="2.6" fill="#c9a286"/><circle cx="12" cy="42" r="2.6" fill="#c9a286"/>' +
      '<ellipse cx="0" cy="33" rx="6.5" ry="3.6" fill="#d9b49a"/>' +
      '<circle cx="0" cy="43" r="12.5" fill="' + hair + '"/>' +
      '<path d="M-8 35.5 q8 -3.5 16 0" fill="none" stroke="rgba(255,255,255,.18)" stroke-width="1.5"/>' +
      '<ellipse cx="-20" cy="36" rx="5" ry="7" fill="' + shirt + '" transform="rotate(-25 -20 36)"/>' +
      '<ellipse cx="20" cy="36" rx="5" ry="7" fill="' + shirt + '" transform="rotate(25 20 36)"/></g>';
  }
  // ⓘ « Qui fait quoi » (23/10/2026) : UN bouton par salle, dans le coin supérieur droit de la pièce (aligné sur la plaque du nom),
  // calculé depuis la géométrie des salles (ROOMS) et les bureaux qu'elles contiennent (catalogue, stations) : rien n'est placé au pixel.
  // Décor fixe dessiné sur le plan (mêmes coordonnées que tableauSVG / étagères / coffre / table des caisses) : à éviter pour le ⓘ.
  var DECOR_OBST = [[60, 62, 200, 80], [1270, 66, 342, 14], [1590, 808, 64, 70], [1350, 915, 300, 150]];
  // Obstacles du plan pour le ⓘ : bureaux (avec emoji, ☎️, voyant), appareils, piles de documents, décor fixe.
  function obstaclesPlan() {
    var o = DECOR_OBST.slice();
    people().forEach(function (p) {
      if (p.device) o.push([p.x - 125, p.y - 90, 250, 150]);
      else { var w = p.kind === 'chef' ? 170 : 132; o.push([p.x - w / 2 - 20, p.y - 66, w + 52, 196]); }
      if (p.kind !== 'secretaire') o.push([p.x - 80, (p.device ? p.y - 118 : p.y - 82) - 40, 160, 72]);
    });
    return o;
  }
  // Coin supérieur droit de la salle, sur la ligne de la plaque ; si la place est prise (plaque trop longue, décor, bureau),
  // on glisse vers la gauche sur la même ligne, puis sur la ligne juste en dessous. Calculé, jamais placé au pixel par salle.
  function infoPos(r) {
    var R = 27, ob = obstaclesPlan(), fin = r.x + 10 + plaqueL(r) + 6;
    var libre = function (x, y) { return ob.every(function (b) { var nx = Math.max(b[0], Math.min(x, b[0] + b[2])), ny = Math.max(b[1], Math.min(y, b[1] + b[3])); return (nx - x) * (nx - x) + (ny - y) * (ny - y) >= R * R; }); };
    var lignes = [r.y + 22, r.y + 60];
    for (var l = 0; l < lignes.length; l++) for (var x = r.x + r.w - 30; x - 25 >= r.x + 10; x -= 18) {
      if (l === 0 && x - 25 < fin) break;
      if (libre(x, lignes[l])) return { x: x, y: lignes[l] };
    }
    return { x: r.x + r.w - 30, y: r.y + 22 };
  }
  function plaqueL(r) { return Math.round(r.name.length * 10.2 + 12); }
  function salleDe(p) { return ROOMS.filter(function (r) { return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h; })[0] || null; }
  function membresSalle(r) { return people().filter(function (p) { return salleDe(p) === r && infoSujet(p.key); }); }
  function infoSallesSVG() {
    return ROOMS.map(function (r) {
      var m = membresSalle(r); if (!m.length) return '';
      // même ligne que la plaque du nom ; si la plaque est trop longue pour la salle (salle étroite), juste en dessous, au bord droit
      var ip = infoPos(r), cx = ip.x, cy = ip.y;
      return '<g class="info-svg" data-act="info" data-id="' + esc('salle:' + r.key) + '" transform="translate(' + cx + ',' + cy + ')" role="button" tabindex="0" aria-label="' + esc('Qui fait quoi : ' + r.name) + '" data-tip="' + esc('ⓘ Qui fait quoi|' + r.name + ' : ' + m.map(function (p) { return p.nom; }).join(', ') + '|') + '">' +
        '<circle class="info-hit" r="25" fill="transparent"/><circle r="11" fill="#15110c" stroke="rgba(243,236,224,.5)"/><text x="0" y="4.5" text-anchor="middle" font-size="13" font-weight="700" font-style="italic" font-family="Georgia,serif" fill="#f3ece0">i</text></g>';
    }).join('');
  }
  function colOf(st) { return st === 'on' ? '#00ff77' : st === 'slot' ? '#ffb020' : st === 'err' ? '#ff3d5a' : '#1f2a24'; }
  function deskSVG(p) {
    var o = stOf(p), st = o.s, scr = colOf(st), glow = st !== 'off';
    var big = p.kind === 'chef';
    var w = big ? 170 : 132, h = big ? 64 : 54;
    var deco = '';
    if (p.kind === 'secretaire') deco = '<rect x="30" y="-20" width="26" height="18" rx="2" fill="#5a4a2e" stroke="rgba(255,255,255,.2)"/><rect x="33" y="-17" width="20" height="3" fill="#f3e6c6"/><rect x="33" y="-12" width="20" height="3" fill="#f3e6c6"/>';
    else if (p.kind === 'compta') deco = '<rect x="-60" y="-22" width="22" height="28" rx="3" fill="#2d2a24" stroke="rgba(255,255,255,.25)"/><rect x="-57" y="-19" width="16" height="6" fill="#9fe8b4"/><rect x="-57" y="-10" width="4" height="4" fill="#ccc"/><rect x="-51" y="-10" width="4" height="4" fill="#ccc"/><rect x="-45" y="-10" width="4" height="4" fill="#ffb020"/><rect x="34" y="-20" width="24" height="18" rx="2" fill="#5b1f1f"/><rect x="37" y="-17" width="18" height="2" fill="#e8c27a"/>';
    else if (p.kind === 'assistant') deco = '<rect x="-58" y="-20" width="8" height="26" fill="#7a3b2a"/><rect x="-49" y="-20" width="7" height="26" fill="#2a5a7a"/><rect x="-41" y="-20" width="8" height="26" fill="#3b7a2a"/>';
    else if (p.kind === 'chef') deco = '<rect x="-70" y="-24" width="40" height="14" rx="3" fill="#b8913e"/><text x="-50" y="-13.5" text-anchor="middle" font-size="8.5" font-weight="800" fill="#1f1a12">CHEF</text><circle cx="62" cy="-8" r="7" fill="#4a3426"/><circle cx="62" cy="-8" r="4" fill="#2a1a10"/>';
    else deco = '<circle cx="46" cy="-6" r="6" fill="#4a3426"/><circle cx="46" cy="-6" r="3.5" fill="#2a1a10"/>' + (p.test ? '<g class="testtag"><rect x="-62" y="-24" width="40" height="14" rx="3" fill="#ffb020"/><text x="-42" y="-13.5" text-anchor="middle" font-size="8.5" font-weight="800" fill="#1f1a12">TEST</text></g>' : '');
    return '<g class="ag ' + st + '" data-ag="' + esc(p.key) + '" transform="translate(' + p.x + ',' + p.y + ')">' +
      '<rect x="-100" y="-70" width="200" height="200" rx="14" fill="transparent"/>' +
      (glow ? '<ellipse cx="0" cy="0" rx="' + (big ? 100 : 80) + '" ry="60" fill="url(#halo-' + st + ')"/>' : '') +
      (p.vide ? '' : '<circle cx="0" cy="52" r="23" fill="#221c15" stroke="rgba(255,255,255,.08)"/>') +
      '<rect class="deskTop" x="' + (-w / 2) + '" y="-30" width="' + w + '" height="' + h + '" rx="7" fill="' + (big ? 'url(#wood)' : '#2c261d') + '" stroke="rgba(255,255,255,.14)"/>' +
      '<rect x="' + (-w / 2 + 6) + '" y="-24" width="' + (w - 12) + '" height="' + (h - 12) + '" rx="5" fill="' + (big ? 'rgba(0,0,0,.18)' : '#221d16') + '"/>' +
      '<rect class="scr" x="-36" y="-26" width="72" height="9" rx="2.5" fill="' + scr + '" ' + (glow ? 'filter="url(#glow)"' : '') + '/>' +
      (glow ? '<path d="M-34 -17 L34 -17 L52 22 L-52 22 Z" fill="' + scr + '" opacity=".07"/>' : '') +
      '<rect x="-24" y="2" width="48" height="10" rx="2" fill="#3e372b"/>' + deco +
      // 23/10/2026 : la personne est dessinée APRÈS le bureau (au-dessus) : avec son léger flottement, elle passait sous le plateau
      (p.vide ? '' : personSVG(p, st)) +
      '<circle class="ledsvg ' + st + '" cx="' + (w / 2 - 8) + '" cy="-24" r="5" fill="' + (st === 'off' ? '#3a4440' : scr) + '" ' + (st !== 'off' ? 'filter="url(#glow)"' : '') + '/>' +
      '<g transform="translate(' + (-w / 2 + 2) + ',-46)"><circle r="17" fill="#15110c" stroke="rgba(255,190,90,.4)"/><text x="0" y="6" text-anchor="middle" font-size="18">' + p.emoji + '</text></g>' +
      (TEL_POSTES[p.kind] && telPeut(p.kind) ? '<g class="tel-svg" data-act="tel" data-id="' + p.kind + '" transform="translate(' + (w / 2 - 2) + ',-46)" data-tip="' + esc('☎️ Appeler ' + TEL_POSTES[p.kind].nom + '|une requête libre, écrite ou dictée|') + '"><circle r="15" fill="#15110c" stroke="rgba(0,255,119,.55)"/><text x="0" y="5.5" text-anchor="middle" font-size="15">☎️</text></g>' : '') +
      '<text class="lbl" x="0" y="96" text-anchor="middle">' + esc(p.nom) + '</text>' +
      '<text class="lbl2" x="0" y="116" text-anchor="middle">' + esc(o.why) + '</text>' +
      (isMe(p) ? '<g class="here" transform="translate(0,140)"><rect x="-46" y="-12" width="92" height="22" rx="11" fill="#00ff77"/><text y="4" text-anchor="middle" font-size="11.5" font-weight="800" fill="#05170d">VOUS ÊTES ICI</text></g>' : '') +
      '</g>';
  }
  function deviceSVG(p) {
    var o = stOf(p), st = o.s, col = colOf(st), s = '';
    if (p.kind === 'courrier') {
      s += '<rect x="-110" y="-60" width="220" height="110" rx="8" fill="url(#wood)" stroke="rgba(255,255,255,.14)"/>';
      var rep = by('a répondu').length, att = by('envoyé').length, k = 0;
      for (var r = 0; r < 3; r++) for (var c = 0; c < 6; c++) {
        var x = -100 + c * 34, y = -52 + r * 33, fill = '#1b150f';
        var env = k < rep ? '#7dffb8' : k < rep + att ? '#a9cdff' : '';
        s += '<rect x="' + x + '" y="' + y + '" width="30" height="28" rx="2" fill="' + fill + '" stroke="rgba(0,0,0,.6)"/>';
        if (env) s += '<rect x="' + (x + 4) + '" y="' + (y + 7) + '" width="22" height="14" rx="1.5" fill="' + env + '"' + (k < rep ? ' filter="url(#glow)"' : '') + '/><path d="M' + (x + 4) + ' ' + (y + 7) + ' l11 8 l11 -8" stroke="rgba(0,0,0,.45)" fill="none"/>';
        k++;
      }
    } else if (p.kind === 'radar') {
      s += '<rect x="-110" y="-60" width="220" height="110" rx="10" fill="#101a16" stroke="rgba(0,255,119,.25)"/>' +
        '<circle cx="0" cy="-5" r="46" fill="#06100c" stroke="rgba(0,255,119,.35)"/><circle cx="0" cy="-5" r="30" fill="none" stroke="rgba(0,255,119,.18)"/><circle cx="0" cy="-5" r="14" fill="none" stroke="rgba(0,255,119,.18)"/>' +
        '<path d="M0 -5 L0 -51 A46 46 0 0 1 40 -28 Z" fill="rgba(0,255,119,.18)"><animateTransform attributeName="transform" type="rotate" from="0 0 -5" to="360 0 -5" dur="6s" repeatCount="indefinite"/></path>';
      var pts = Math.min(((S.radar || {}).sujets || []).length, 7);
      for (var j = 0; j < pts; j++) { var an = j * 2.3, rr = 12 + (j * 9) % 32; s += '<circle cx="' + (Math.cos(an) * rr).toFixed(1) + '" cy="' + (-5 + Math.sin(an) * rr).toFixed(1) + '" r="3" fill="#7dffb8" filter="url(#glow)"/>'; }
    } else if (p.kind === 'votes') {
      s += '<rect x="-70" y="-30" width="140" height="80" rx="8" fill="#1d2a24" stroke="rgba(0,255,119,.3)"/><rect x="-40" y="-36" width="80" height="8" rx="3" fill="#0a0f0c" stroke="rgba(0,255,119,.4)"/>' +
        '<rect x="-14" y="-62" width="28" height="34" rx="2" fill="#f3ead6" transform="rotate(-6 0 -45)"/><text x="0" y="22" text-anchor="middle" font-size="12" font-weight="800" fill="#00ff77" font-family="monospace">VOTE</text>';
    } else {
      s += '<rect x="-110" y="-55" width="220" height="100" rx="8" fill="#2b2b2b" stroke="rgba(255,255,255,.16)"/><rect x="-100" y="-45" width="200" height="80" rx="4" fill="#3a3a3a"/>';
      var n = Math.min(D().articles.length, 6);
      for (var i = 0; i < n; i++) s += '<rect x="' + (-92 + i * 31) + '" y="-38" width="26" height="34" rx="2" fill="#f3ead6" transform="rotate(' + ((i % 3) - 1) * 4 + ' ' + (-79 + i * 31) + ' -21)"/><rect x="' + (-88 + i * 31) + '" y="-32" width="18" height="3" fill="#9a8f78"/><rect x="' + (-88 + i * 31) + '" y="-26" width="14" height="3" fill="#bdb29a"/>';
      s += '<rect x="-60" y="10" width="120" height="16" rx="3" fill="#1d1d1d"/><text x="0" y="22" text-anchor="middle" font-size="10" font-weight="800" fill="#00ff77" font-family="monospace">GHOST</text>';
    }
    return '<g class="ag ' + st + '" data-ag="' + p.key + '" transform="translate(' + p.x + ',' + p.y + ')">' +
      '<rect x="-120" y="-80" width="240" height="210" fill="transparent"/>' +
      (st !== 'off' ? '<ellipse cx="0" cy="0" rx="130" ry="80" fill="url(#halo-' + st + ')"/>' : '') + s +
      '<circle class="ledsvg ' + st + '" cx="104" cy="-66" r="5" fill="' + (st === 'off' ? '#3a4440' : col) + '" ' + (st !== 'off' ? 'filter="url(#glow)"' : '') + '/>' +
      '<g transform="translate(-112,-72)"><circle r="17" fill="#15110c" stroke="rgba(255,190,90,.4)"/><text x="0" y="6" text-anchor="middle" font-size="18">' + p.emoji + '</text></g>' +
      '<text class="lbl" x="0" y="80" text-anchor="middle">' + esc(p.nom) + '</text><text class="lbl2" x="0" y="100" text-anchor="middle">' + esc(o.why) + '</text></g>';
  }
  // fiches qui flottent au-dessus de chaque employé : ce qui l'attend (cliquer ouvre son bureau)
  function pileOf(p) {
    var me = D().me;
    if (p.kind === 'secretaire') return by('brouillon').concat(relancesPretes()).map(function () { return 'a'; });
    if (p.kind === 'courrier') return by('a répondu').map(function () { return 'g'; }).concat(by('envoyé').map(function () { return 'b'; }));
    if (p.kind === 'assistant') return S.qs.filter(function (q) { return q.garde; }).map(function () { return 'n'; });
    if (p.kind === 'journaliste' && !p.vide) return D().fiches.filter(function (f) { return f.redacteur === p.id && f.statut === 'a répondu'; }).map(function () { return 'g'; });
    if (p.kind === 'chef' && me.chef) return by('inséré').map(function () { return 'w'; });
    if (p.kind === 'sc' || p.kind === 'mk') return mailsBureau(p.kind).map(function (m) { return m.brouillon_corps ? 'a' : m.categorie === 'demande' ? 'g' : 'n'; });
    if (p.kind === 'marbre') return D().articles.filter(function (a) { return a.id === S.art; }).map(function () { return 'w'; });
    return [];
  }
  // Étagère du Secrétariat : une case par enquête (dossier), 4 cases par rayon. Survol = infobulle (titre + avancement), clic = le dossier.
  // Arrière-salle : sur la table du Comptable, une caisse par journaliste avec son solde de pièces ; animation quand il en distribue.
  // Qui gagne des pièces : les rédactrices, plus le rédacteur en chef s'il a activé le « mode récompense (test) » dans ses Paramètres.
  function testRec() { return !!(S.pieces && S.pieces.recompense_test); }
  function gagnants() { var so = (S.pieces && S.pieces.soldes) || {}; return (D().equipe || []).filter(function (w) { return (w.role !== 'chef' || testRec()) && (w.actif !== false || (so[w.id] || 0) > 0); }); }
  function estTestM(id) { return !!membre(id).test; }
  function tagTest(id) { return estTestM(id) ? ' <span class="tag eq-test">TEST</span>' : ''; }
  function caissesSVG() {
    var js = gagnants().slice(0, 3);
    var so = (S.pieces && S.pieces.soldes) || {}, X0 = 1500, Y0 = 965, cp = P('compta') || { x: 1230, y: 950 };
    var s = '<g class="compta-deco"><rect x="1590" y="808" width="64" height="70" rx="6" fill="#262626" stroke="rgba(255,255,255,.18)" stroke-width="2"/><circle cx="1622" cy="843" r="13" fill="none" stroke="#9a8a6a" stroke-width="3"/><rect x="1619.5" y="830" width="5" height="10" fill="#9a8a6a"/><text class="lbl2" x="1622" y="894" text-anchor="middle">coffre</text></g>';
    s += '<rect x="' + (X0 - 150) + '" y="' + (Y0 - 50) + '" width="300" height="150" rx="10" fill="url(#wood)" stroke="rgba(255,255,255,.14)"/><text class="lbl2" x="' + X0 + '" y="' + (Y0 + 125) + '" text-anchor="middle">table des caisses</text>';
    var xs = js.length === 3 ? [-95, 0, 95] : js.length === 2 ? [-60, 60] : [0];
    js.forEach(function (w, i) {
      var n = so[w.id] || 0, x = X0 + xs[i], anim = S.caisseAnim && S.caisseAnim[w.id];
      var tas = '';
      for (var k = 0; k < Math.min(6, Math.ceil(n / 5)); k++) tas += '<ellipse cx="' + (x - 14 + (k % 3) * 14) + '" cy="' + (Y0 + 2 - Math.floor(k / 3) * 7) + '" rx="8" ry="4" fill="#ffd25a" stroke="#a87a14"/>';
      s += '<g class="case" data-act="pieces" data-tip="' + esc('Caisse de ' + w.nom + '|🪙 ' + n + ' pièces à convertir|' + (n ? '≈ ' + eurTxt(n * Number((S.pieces || {}).taux || 0)) : 'vide pour l’instant')) + '" data-tip-act="Cliquer pour voir le Comptable">' +
        '<rect x="' + (x - 34) + '" y="' + (Y0 - 18) + '" width="68" height="44" rx="5" fill="#3d2b17" stroke="#c99a3a" stroke-width="2"/>' + tas +
        '<rect x="' + (x - 34) + '" y="' + (Y0 + 8) + '" width="68" height="18" rx="3" fill="#2a1d10"/><text x="' + x + '" y="' + (Y0 + 21) + '" text-anchor="middle" font-size="12" font-weight="800" fill="#ffd77a">🪙 ' + n + '</text>' +
        '<text class="lbl2" x="' + x + '" y="' + (Y0 + 44) + '" text-anchor="middle" style="fill:#f3e6c6">' + esc(w.nom.split(' ')[0]) + '</text>';
      if (anim) for (var c = 0; c < 5; c++) s += '<g><ellipse cx="0" cy="0" rx="8" ry="4" fill="#ffd25a" stroke="#a87a14"><animateMotion dur="' + (0.9 + c * 0.15) + 's" begin="' + (c * 0.18) + 's" fill="freeze" path="M' + cp.x + ' ' + (cp.y + 70) + ' Q' + ((cp.x + x) / 2) + ' ' + (cp.y + 130) + ' ' + x + ' ' + (Y0 - 6) + '"/></ellipse></g>';
      s += '</g>';
    });
    return s;
  }
  function eurTxt(n) { return (Math.round(n * 100) / 100).toFixed(2).replace('.', ',') + ' €'; }
  function etagereSVG() {
    var actifs = vues().filter(function (f) { return f.statut !== 'inséré'; });
    var ivs = aInterviewer().map(function (a) { return { iv: a }; });
    var ds = ivs.concat(dossiers(actifs)), X = 720, Y = 64, CW = 62, CH = 78, cols = 4, rows = 4, max = cols * rows;
    var K = 0.8; // étagère à 80 % (23/10) : cases, montants et zones cliquables réduits ensemble ; le libellé reste à taille normale
    var s = '<g class="etagere" transform="translate(' + X + ' ' + Y + ') scale(' + K + ') translate(' + (-X) + ' ' + (-Y) + ')"><rect x="' + (X - 8) + '" y="' + (Y - 8) + '" width="' + (cols * CW + 16) + '" height="' + (rows * CH + 16) + '" rx="6" fill="#2b2015" stroke="rgba(255,190,90,.25)" stroke-width="2"/>';
    for (var r = 0; r < rows; r++) s += '<rect x="' + (X - 8) + '" y="' + (Y + r * CH + CH - 6) + '" width="' + (cols * CW + 16) + '" height="6" fill="#4a3624"/>';
    var lbl = '<text class="lbl2" x="' + (X + cols * CW * K / 2) + '" y="' + (Y + rows * CH * K + 24) + '" text-anchor="middle">étagère des dossiers' + (ds.length ? ' · ' + ds.length + ' enquête' + pl(ds.length) : ' · vide') + (ivs.length ? ' · 🎙️ ' + ivs.length + ' à interviewer' : '') + '</text>';
    ds.slice(0, max).forEach(function (d, i) {
      var cx = X + (i % cols) * CW, cy = Y + Math.floor(i / cols) * CH;
      if (d.iv) { // enquête premium sans demande d'interview : case au micro, clic = préparer les interviews
        var pv = prepEtat(d.iv.id), prepVa = enCours(pv);
        s += '<g class="case" data-act="' + (prepVa ? 'voir-mails' : 'express') + '" data-id="' + esc(d.iv.id) + '" data-tip="' + esc(d.iv.titre + (prepVa ? '|⏳ préparation des interviews en cours|les mails arrivent dans 1 à 2 minutes' : '|🎙️ interviews pas encore préparées|aucune demande pour l’instant')) + '" data-tip-act="' + (prepVa ? 'Cliquer pour suivre la préparation' : 'Cliquer pour préparer les interviews') + '" transform="translate(' + cx + ',' + cy + ')"><rect x="2" y="4" width="' + (CW - 4) + '" height="' + (CH - 12) + '" rx="4" fill="rgba(255,176,32,.08)" stroke="rgba(255,176,32,.55)" stroke-dasharray="4 3"/>' +
          '<g transform="translate(' + (CW / 2) + ',' + (CH / 2 - 4) + ')"><rect x="-7" y="-18" width="14" height="22" rx="7" fill="#d9d2c3" stroke="#6b5f4a"/><path d="M-11 -2 a11 11 0 0 0 22 0" fill="none" stroke="#d9d2c3" stroke-width="2.5"/><rect x="-1.5" y="9" width="3" height="7" fill="#d9d2c3"/><rect x="-7" y="15" width="14" height="3" rx="1.5" fill="#d9d2c3"/></g>' +
          '<g transform="translate(' + (CW - 14) + ',14)"><circle r="10" fill="#ffb020" filter="url(#glow)"/><text y="4" text-anchor="middle" font-size="11" font-weight="800" fill="#2a1a00">!</text></g></g>';
        return;
      }
      var c = function (st) { return d.fiches.filter(function (f) { return f.statut === st; }).length; };
      var nrel = d.fiches.filter(relancePrete).length, nreb = d.fiches.filter(estRebond).length;
      var col = c('a répondu') ? '#3fd88a' : c('brouillon') || nrel ? '#ffb020' : nreb ? '#ff6b7f' : '#7fb2ff';
      var tip = d.titre + '|' + [c('brouillon') ? c('brouillon') + ' à valider' : '', nrel ? '⏰ ' + nrel + ' relance' + pl(nrel) + ' prête' + pl(nrel) : '', c('envoyé') ? c('envoyé') + ' envoyé' + pl(c('envoyé')) : '', c('a répondu') ? c('a répondu') + ' réponse' + pl(c('a répondu')) : '', nreb ? '✉️ ' + nreb + ' adresse' + pl(nreb) + ' invalide' + pl(nreb) : ''].filter(Boolean).join(' · ') + '|' + d.fiches.map(function (f) { return f.contact.nom; }).join(', ');
      if (i === max - 1 && ds.length > max) { s += '<g class="case" data-act="open-ag" data-ag="secretaire" data-tip="' + esc('+' + (ds.length - max + 1) + ' autres dossiers|ouvrir la Secrétaire|') + '" transform="translate(' + cx + ',' + cy + ')"><rect x="4" y="8" width="' + (CW - 8) + '" height="' + (CH - 18) + '" rx="4" fill="#3a2c1d"/><text x="' + (CW / 2) + '" y="' + (CH / 2 + 4) + '" text-anchor="middle" font-size="16" font-weight="800" fill="#ffcf8a">+' + (ds.length - max + 1) + '</text></g>'; return; }
      s += '<g class="case" data-act="dossier-sec" data-id="' + esc(d.id || 'sans') + '" data-tip="' + esc(tip) + '" transform="translate(' + cx + ',' + cy + ')"><rect x="2" y="4" width="' + (CW - 4) + '" height="' + (CH - 12) + '" rx="4" fill="transparent"/>';
      var n = Math.min(d.fiches.length, 4);
      for (var k = 0; k < n; k++) s += '<rect x="' + (10 + k * 9) + '" y="' + (16 + (k % 2) * 3) + '" width="16" height="' + (CH - 34) + '" rx="2" fill="' + ['#e8d9b8', '#d9c8a2', '#efe3c8', '#cdbb94'][k] + '" stroke="rgba(0,0,0,.35)"/>';
      s += '<g transform="translate(' + (CW - 14) + ',14)"><circle r="10" fill="' + col + '" filter="url(#glow)"/><text y="4" text-anchor="middle" font-size="11.5" font-weight="800" fill="#05170d">' + d.fiches.length + '</text></g>' +
        (nrel ? '<text x="12" y="' + (CH - 12) + '" font-size="15">⏰</text>' : '') + '</g>';
    });
    return s + '</g>' + lbl;
  }
  function pilesSVG() {
    var s = '';
    people().forEach(function (p) {
      var cs = pileOf(p); if (!cs.length) return;
      var n = Math.min(cs.length, 3), y = p.device ? p.y - 118 : p.y - 82, vert = p.kind === 'secretaire';
      var g = '<g class="pile" data-ag="' + esc(p.key) + '" transform="translate(' + (vert ? p.x - 100 : p.x) + ',' + (vert ? p.y - 10 : y) + ') scale(' + (vert ? 1.05 : 1.25) + ')"><g class="fl"><rect x="-62" y="-30" width="124" height="52" fill="transparent"/>';
      for (var k = 0; k < n; k++) {
        var c = cs[k], off = vert ? 0 : (k - (n - 1) / 2) * 30, rot = vert ? (k - (n - 1) / 2) * 4 : (k - (n - 1) / 2) * 11;
        if (vert) off = 'V' + ((k - (n - 1) / 2) * 34);
        var col = c === 'a' ? '#fff0cc' : c === 'b' ? '#e3edff' : c === 'g' ? '#e2ffef' : c === 'n' ? '#fff7b0' : '#f6f2e7';
        g += '<g transform="translate(' + (String(off).charAt(0) === 'V' ? '0,' + String(off).slice(1) : off + ',0') + ') rotate(' + rot + ')"><rect class="paperS" x="-19" y="-24" width="38" height="46" rx="3" fill="' + col + '" stroke="rgba(0,0,0,.35)" filter="url(#glow)"/>';
        if (c === 'b' || c === 'g') g += '<rect x="-14" y="-12" width="28" height="18" rx="2" fill="' + (c === 'g' ? '#3fd88a' : '#6f9fe0') + '"/><path d="M-14 -12 l14 10 l14 -10" stroke="rgba(0,0,0,.4)" fill="none"/>';
        else g += '<rect x="-13" y="-17" width="26" height="3" fill="#9aa39d"/><rect x="-13" y="-10" width="22" height="3" fill="#b9c0bb"/><rect x="-13" y="-3" width="24" height="3" fill="#b9c0bb"/><rect x="-13" y="4" width="16" height="3" fill="' + (c === 'a' ? '#e0a020' : '#b9c0bb') + '"/>';
        g += '</g>';
      }
      var badge = cs[0] === 'g' ? '#00ff77' : cs[0] === 'a' ? '#ffb020' : cs[0] === 'b' ? '#7fb2ff' : '#00ff77';
      g += '</g><g transform="translate(' + (vert ? 26 : n * 15 + 14) + ',' + (vert ? -(n * 17 + 14) : -24) + ')"><circle r="11" fill="' + badge + '" filter="url(#glow)"/><text y="4.5" text-anchor="middle" font-size="13" font-weight="800" fill="#05170d">' + cs.length + '</text></g></g>';
      s += g;
    });
    return s;
  }
  function bullesSVG() {
    var s = '';
    people().forEach(function (p) {
      var b = S.busy[p.kind]; if (!b) return;
      var y = p.device ? p.y - 120 : p.y - 120, w = Math.min(260, 24 + b.length * 7.2), bx = p.x;
      // la bulle ne passe jamais sous le ⓘ de la salle (coin supérieur droit) : décalée vers la gauche si besoin
      var r = salleDe(p), ip = r && infoPos(r);
      if (ip && ip.y + 27 > y - 18 && ip.y - 27 < y + 21 && bx + w / 2 > ip.x - 27) bx = Math.max(r.x + w / 2 + 6, ip.x - 27 - w / 2);
      s += '<g class="bulle" transform="translate(' + bx + ',' + y + ')"><rect x="' + (-w / 2) + '" y="-18" width="' + w + '" height="30" rx="15" fill="#f8f4ea" stroke="#00ff77" stroke-width="2"/><path d="M-6 12 l6 9 l6 -9z" fill="#f8f4ea"/><text y="2" text-anchor="middle" font-size="13" font-weight="700" fill="#1f1a12">' + esc(b) + ' …</text></g>';
    });
    return s;
  }
  function rangee(p) { return p.y < CORR[0] ? 0 : p.y < CORR[1] ? 1 : 2; }
  function sortie(p, C) { return C > p.y ? p.y + 120 : p.y - 80; } // bord du poste côté couloir
  function cheminCable(a, b, voie) {
    // trois rangées : même rangée = par le couloir voisin (sous la rangée 1, au-dessus des rangées 2 et 3) ; sinon par le couloir entre les deux
    var ra = rangee(a), rb = rangee(b), C = (ra === rb ? CORR[Math.max(0, ra - 1)] : CORR[Math.min(ra, rb)]) + (voie || 0); // voie : décalage dans le couloir, pour que deux fils ne se confondent pas
    var sx = a.x, sy = sortie(a, C), ex = b.x, ey = sortie(b, C);
    if (ra === rb) { var dn = C > a.y, yy = dn ? C - 2 : C + 2; return 'M' + sx + ' ' + sy + ' V' + (yy + (dn ? -10 : 10)) + ' Q' + sx + ' ' + yy + ' ' + (sx + (ex > sx ? 10 : -10)) + ' ' + yy + ' H' + (ex + (ex > sx ? -10 : 10)) + ' Q' + ex + ' ' + yy + ' ' + ex + ' ' + (yy + (dn ? -10 : 10)) + ' V' + ey; }
    return 'M' + sx + ' ' + sy + ' V' + C + ' H' + ex + ' V' + ey;
  }
  function cable(a, b, live, voie) { return a && b ? trace(cheminCable(a, b, voie), live) : ''; }
  // Transmission au téléphone (23/10/2026) : quand un poste passe une requête à un autre, le chemin entre LES DEUX bureaux
  // s'allume (bleu) et une impulsion va de la source vers la destination pendant quelques secondes. Générique : n'importe quelle
  // paire de bureaux du plan (postes du catalogue compris), même routage par couloirs que les autres câbles.
  var TRANSIT_MS = 9000;
  function transmettreAnim(de, vers) {
    if (!de || !vers || de === vers) return;
    S.transits = (S.transits || []).filter(function (t) { return !(t.de === de && t.vers === vers); }).concat([{ de: de, vers: vers, fin: Date.now() + TRANSIT_MS }]);
    paintFloor(); clearTimeout(S.transitT); S.transitT = setTimeout(paintFloor, TRANSIT_MS + 200);
  }
  function transitsSVG() {
    var now = Date.now(), s = '';
    S.transits = (S.transits || []).filter(function (t) { return t.fin > now; });
    S.transits.forEach(function (t) {
      var a = P(t.de), b = P(t.vers); if (!a || !b) return;
      var d = cheminCable(a, b, 8);
      s += '<g class="transit" data-de="' + esc(t.de) + '" data-vers="' + esc(t.vers) + '"><path class="cable" d="' + d + '" stroke="rgba(0,0,0,.6)" stroke-width="8"/>' +
        '<path class="cable live" d="' + d + '" stroke="#3fd0ff" stroke-width="4" stroke-dasharray="10 8" filter="url(#glow)"><animate attributeName="stroke-dashoffset" from="36" to="0" dur=".7s" repeatCount="indefinite"/></path>' +
        '<g filter="url(#glow)"><circle r="9" fill="#e6f9ff" stroke="#3fd0ff" stroke-width="2.5"/><text y="4" text-anchor="middle" font-size="10">☎️</text><animateMotion dur="1.8s" repeatCount="indefinite" path="' + d + '"/></g></g>';
    });
    return s;
  }
  function trace(d, live) {
    var s = '<path class="cable" d="' + d + '" stroke="rgba(0,0,0,.6)" stroke-width="7"/>';
    s += '<path class="cable' + (live ? ' live' : '') + '" d="' + d + '" stroke="' + (live ? '#00ff77' : 'rgba(255,190,90,.18)') + '" stroke-width="' + (live ? 3 : 2) + '"' + (live ? ' filter="url(#glow)"' : '') + '/>';
    if (live) s += '<circle r="5" fill="#d8ffe9" filter="url(#glow)"><animateMotion dur="2.6s" repeatCount="indefinite" path="' + d + '"/></circle>';
    return s;
  }
  function officeSVG() {
    var defs = '<defs><filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="3" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>' +
      '<radialGradient id="halo-on"><stop offset="0" stop-color="#00ff77" stop-opacity=".22"/><stop offset="1" stop-color="#00ff77" stop-opacity="0"/></radialGradient>' +
      '<radialGradient id="halo-slot"><stop offset="0" stop-color="#ffb020" stop-opacity=".16"/><stop offset="1" stop-color="#ffb020" stop-opacity="0"/></radialGradient>' +
      '<radialGradient id="halo-err"><stop offset="0" stop-color="#ff3d5a" stop-opacity=".2"/><stop offset="1" stop-color="#ff3d5a" stop-opacity="0"/></radialGradient>' +
      '<pattern id="tiles" width="40" height="40" patternUnits="userSpaceOnUse"><path d="M40 0H0V40" fill="none" stroke="rgba(255,255,255,.035)"/></pattern>' +
      '<pattern id="parquet" width="60" height="20" patternUnits="userSpaceOnUse"><path d="M0 20H60M30 0V20" fill="none" stroke="rgba(255,190,90,.05)"/></pattern>' +
      '<linearGradient id="wood" x1="0" x2="1"><stop offset="0" stop-color="#3a2c1d"/><stop offset="1" stop-color="#2a2016"/></linearGradient></defs>';
    var HH = PLAN_H, WW = PLAN_W;
    var s = '<svg viewBox="0 0 ' + WW + ' ' + HH + '" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="La rédaction de Posthumain vue de haut">' + defs + '<rect width="' + WW + '" height="' + HH + '" fill="#0a0806"/>';
    [[CORR[0], 'couloir · le chemin du courrier'], [CORR[1], 'couloir · arrière-salle']].forEach(function (c) {
      s += '<rect x="20" y="' + (c[0] - 22) + '" width="' + (WW - 40) + '" height="44" fill="#100d09"/><rect x="20" y="' + (c[0] - 22) + '" width="' + (WW - 40) + '" height="44" fill="url(#tiles)"/><text class="roomname" x="40" y="' + (c[0] - 9) + '" style="font-size:11px">' + esc(c[1]) + '</text>';
    });
    var plaques = '';
    rooms().forEach(function (r) {
      s += '<rect x="' + r.x + '" y="' + r.y + '" width="' + r.w + '" height="' + r.h + '" rx="10" fill="' + r.floor + '"/>';
      s += '<rect x="' + r.x + '" y="' + r.y + '" width="' + r.w + '" height="' + r.h + '" rx="10" fill="url(#' + (r.key === 'redac' || r.key === 'chef' ? 'parquet' : 'tiles') + ')"/>';
      s += '<rect x="' + r.x + '" y="' + r.y + '" width="' + r.w + '" height="' + r.h + '" rx="10" fill="none" stroke="rgba(243,236,224,.16)" stroke-width="5"/>';
      // nom de la salle sur une plaque de la couleur du sol, posée APRÈS les fils : un fil qui entre dans la salle passe dessous
      plaques += '<rect x="' + (r.x + 10) + '" y="' + (r.y + 12) + '" width="' + plaqueL(r) + '" height="19" rx="4" fill="' + r.floor + '"/><text class="roomname" x="' + (r.x + 16) + '" y="' + (r.y + 26) + '">' + esc(r.name) + '</text>';
    });
    [[310, 360], [920, 360], [1460, 360], [330, 420], [770, 420], [1130, 420], [1470, 420], [330, 730], [770, 730], [1300, 730], [250, 790], [630, 790], [930, 790], [1230, 790]].forEach(function (p) { s += '<rect x="' + (p[0] - 34) + '" y="' + (p[1] - 4) + '" width="68" height="8" fill="#0a0806"/>'; });
    // décor : étagères de la bibliothèque, tableau de liège de la rédaction, fauteuils du chef
    s += '<g transform="translate(1270,66)">';
    for (var i = 0; i < 9; i++) s += '<rect x="' + (i * 38) + '" y="0" width="34" height="14" rx="2" fill="hsl(' + (i * 37) + ',35%,32%)"/>';
    s += '</g><g class="tableau" data-act="articles" transform="translate(60,62)"><title>Tableau des sujets : les brouillons Ghost (touchez pour choisir l’article en cours)</title><rect width="200" height="60" rx="6" fill="#5a4426" stroke="rgba(0,0,0,.4)"/>';
    var arts = artsRecents().slice(0, 5);
    arts.forEach(function (a, j) { s += '<rect x="' + (8 + j * 38) + '" y="' + (8 + (j % 2) * 6) + '" width="32" height="38" fill="' + (a.id === S.art ? '#fff7b0' : '#f3ead6') + '" transform="rotate(' + ((j % 3) - 1) * 4 + ' ' + (24 + j * 38) + ' 27)"/><circle cx="' + (24 + j * 38) + '" cy="' + (11 + (j % 2) * 6) + '" r="2.5" fill="#d42a44"/>'; });
    s += '<text x="100" y="76" text-anchor="middle" class="lbl2">tableau des sujets</text></g>';
    s += '<g transform="translate(70,1040)"><rect width="70" height="56" rx="18" fill="#3a2a1c"/><rect x="300" width="70" height="56" rx="18" fill="#3a2a1c"/><text x="335" y="28" text-anchor="middle" dominant-baseline="central" font-size="26">🪴</text></g>';
    var pp = people(), J = pp.filter(function (p) { return p.kind === 'journaliste'; });
    var sec = P('secretaire'), asst = P('assistant'), cour = P('courrier'), mar = P('marbre'), chef = P('chef');
    // Câbles verts clignotants (23/10/2026) : seulement quand quelque chose se passe MAINTENANT (rédaction ou envoi en cours,
    // mail parti ou réponse arrivée il y a moins de 60 s). Une simple attente de réponse, ou une réponse pas encore traitée,
    // ne clignote plus : les compteurs sont déjà sur les bureaux. Repeint programmé à l'expiration pour éteindre le câble.
    var FRAIS = 60000, maintenant = Date.now(), prochain = 0;
    var frais = function (f, champ) { var t = f[champ] ? new Date(f[champ]).getTime() : 0, reste = t ? t + FRAIS - maintenant : -1; if (reste > 0 && (!prochain || reste < prochain)) prochain = reste; return reste > 0; };
    var envoisFrais = D().fiches.filter(function (f) { return frais(f, 'envoye_le') || frais(f, 'relance_envoyee_le'); }).length;
    var repsFraiches = D().fiches.filter(function (f) { return frais(f, 'reponse_le'); });
    clearTimeout(S.cableT); S.cableT = prochain ? setTimeout(paintFloor, prochain + 250) : null;
    J.forEach(function (j) {
      s += cable(j, asst, !!S.busy.assistant);
      s += cable(asst, sec, !!S.busy.secretaire);
      s += cable(j, mar, false);
    });
    s += cable(sec, cour, envoisFrais > 0 || !!S.busy.secretaire);
    var courActif = !!S.busy.courrier || !!(S.arrivees && S.arrivees.length);
    J.forEach(function (j) { s += cable(cour, j, courActif || repsFraiches.some(function (f) { return !j.id || f.redacteur === j.id; })); });
    // Salle des décisions, comptabilité (23/10/2026) : ces postes n'étaient reliés à rien. Même règle : vert = action EN COURS
    // (S.actif, posé par radarApi / factApi / pushApi le temps de l'appel), discret au repos. Voies décalées dans les couloirs.
    var A = S.actif || {}, rad = P('radar'), vot = P('votes'), cpt = P('compta');
    s += cable(chef, mar, !!A.usine);            // le chef approuve ou écarte un brouillon de l'Usine
    s += cable(vot, rad, !!A.vote, 14);          // le sujet gagnant du vote entre en tête du Radar (écarter / remettre)
    s += cable(rad, mar, !!A.usine, 14);         // approuver / écarter un brouillon met à jour son sujet du Radar
    s += cable(rad, chef, !!A.radar, -14);       // choisir, imposer, ordonner, retirer, relancer le Radar
    s += cable(cpt, chef, !!A.compta, 16);       // valider des pièces, générer / payer une facture, tarifs
    if (cpt) J.forEach(function (j) {            // la caisse et les factures de chaque journaliste : par le bord gauche du plan
      if (j.vide) return;
      s += trace('M' + cpt.x + ' ' + sortie(cpt, 760) + ' V734 H14 V410 H' + j.x + ' V' + sortie(j, 390), !!A.paie && j.id === D().me.id);
    });
    var jsc = P('sc'), jmk = P('mk'), arr = S.arrivees || [];
    if (jsc && jmk) {
      // deux voies côte à côte dans le couloir (subs@ un peu au-dessus, redaction@ un peu en dessous) pour que les fils ne se confondent pas
      var pth = function (to, voie) { var C = CORR[Math.min(rangee(cour), rangee(to))]; return 'M' + cour.x + ' ' + sortie(cour, C) + ' V' + (C + voie) + ' H' + to.x + ' V' + sortie(to, C); };
      [[jsc, 'subs', -6], [jmk, 'redaction', 6]].forEach(function (d) {
        var live = arr.some(function (b) { return bureauDe(b) === (d[1] === 'subs' ? 'sc' : 'mk'); }), path = pth(d[0], d[2]);
        s += '<path class="cable" d="' + path + '" stroke="rgba(0,0,0,.6)" stroke-width="7" fill="none"/><path class="cable' + (live ? ' live' : '') + '" d="' + path + '" fill="none" stroke="' + (live ? '#00ff77' : 'rgba(255,190,90,.18)') + '" stroke-width="' + (live ? 3 : 2) + '"' + (live ? ' filter="url(#glow)"' : '') + '/>';
        if (live) s += '<g filter="url(#glow)"><rect x="-16" y="-11" width="32" height="22" rx="3" fill="#e2ffef" stroke="#00ff77" stroke-width="2"/><path d="M-16 -11 l16 12 l16 -12" stroke="#1d6b45" stroke-width="2" fill="none"/><animateMotion dur="2.8s" fill="freeze" path="' + path + '"/></g>';
      });
    }
    s += transitsSVG();
    s += plaques + etagereSVG() + caissesSVG();
    pp.forEach(function (p) { s += p.device ? deviceSVG(p) : deskSVG(p); });
    // bout du couloir : la porte vers le Videolab (navigation d'un lab à l'autre, façon RPG)
    s += PHL.porteSVG({ x: WW - 30, y: CORR[1], dir: 'droite', taille: 1.25, href: '/videolab/', titre: 'Aller au Videolab' });
    s += pilesSVG() + bullesSVG() + infoSallesSVG() + '</svg>';
    return s;
  }

  // ---------- haut de page ----------
  var fClock = new Intl.DateTimeFormat('fr-CH', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
  function unread() {
    var seen = LS.get('wl-vu') || '', me = D().me.id;
    return D().messages.filter(function (m) { return m.auteur !== me && String(m.le) > seen; }).length;
  }
  function pieceChip() {
    var me = D().me, av = ((S.pieces && S.pieces.pieces) || []).filter(function (p) { return p.statut === 'a_verifier'; }).length;
    if (!S.pieces) return '';
    var af = ((S.pieces && S.pieces.conversions) || []).filter(function (c) { return c.statut === 'a_facturer' && (me.chef || c.membre === me.id); }).length;
    var so = ((S.pieces && S.pieces.soldes) || {})[me.id] || 0;
    return '<span class="chip' + ((av && me.chef) || (af && !me.chef) ? ' warn' : '') + '" data-act="pieces" title="Les pièces de la rédaction">🪙 ' + (me.chef ? (av ? av + ' à vérifier' : af ? af + ' à facturer' : 'pièces') : so + (af ? ' · 💶 à facturer' : '')) + '</span>';
  }
  function header() {
    var a = art(S.art), v = by('brouillon').length, r = by('a répondu').length, e = by('envoyé').length;
    return '<div class="logo">WRITINGLAB<small>La rédaction de Posthumain</small></div>' +
      '<div class="chips">' +
      '<span class="chip art" data-act="articles" title="Changer d’article">📰 ' + (a ? esc(a.titre) : 'Choisir l’article en cours') + '</span>' +
      pieceChip() +
      (aInterviewer().length ? '<span class="chip hot" data-act="a-interviewer">🎙️ ' + aInterviewer().length + ' à interviewer</span>' : '') +
      (v ? '<span class="chip warn" data-act="open-ag" data-ag="secretaire">🟠 ' + v + ' à valider</span>' : '') +
      (relancesPretes().length ? '<span class="chip warn" data-act="open-ag" data-ag="secretaire">⏰ ' + relancesPretes().length + ' relance' + pl(relancesPretes().length) + '</span>' : '') +
      (by('rebond').length ? '<span class="chip warn" data-act="open-ag" data-ag="courrier">✉️ ' + by('rebond').length + ' adresse' + pl(by('rebond').length) + ' invalide' + pl(by('rebond').length) + '</span>' : '') +
      (r ? '<span class="chip hot" data-act="open-ag" data-ag="courrier">📬 ' + r + ' réponse' + pl(r) + '</span>' : '') +
      (e ? '<span class="chip" data-act="open-ag" data-ag="courrier">⏳ ' + e + ' en attente</span>' : '') +
      (document.getElementById('wl-clair-css') ? '<span class="chip" data-act="theme" title="' + (modeClair() ? 'Passer en mode sombre' : 'Passer en mode clair') + '">' + (modeClair() ? '🌙' : '☀️') + '</span>' : '') +
      '<span class="chip" data-act="parametres" title="Paramètres (notifications, signature, dictée)">⚙️' + (S.pushOk ? '' : '<span class="dot-off"></span>') + '</span>' +
      '<span class="chip" data-act="refresh" title="Recharger">↻</span>' +
      '<span class="chip" data-act="open-aide" title="Configurer son adresse @posthumain.com dans Outlook" style="opacity:.6">✉︎ ?</span></div>' +
      '<div class="clock">' + fClock.format(new Date()) + '</div>';
  }
  function tabs() {
    var u = unread();
    return [['bureau', '🏢 Rédaction'], ['articles', '📰 Articles'], ['suivi', '✉️ Suivi'], ['interphone', '📞 Interphone' + (u ? '<span class="n">' + u + '</span>' : '')]]
      .map(function (t) { return '<div class="tab' + (S.tab === t[0] ? ' sel' : '') + '" data-tab="' + t[0] + '">' + t[1] + '</div>'; }).join('');
  }

  // ---------- onglets ----------
  function viewBureau() {
    var cards = people().map(function (p) {
      var o = stOf(p), n = pileOf(p).length;
      return '<div class="card" data-act="open-ag" data-ag="' + esc(p.key) + '"><div class="h"><span class="em">' + p.emoji + '</span><span style="flex:1">' + esc(p.nom) + (n ? ' <span class="tag ' + (o.s === 'on' ? 'g' : 'a') + '">' + n + '</span>' : '') + '</span><span class="led ' + o.s + '"></span></div><div class="s">' + esc(o.why) + '</div></div>';
    }).join('');
    return '<div class="floor">' + officeSVG() + '</div>' + autresPostesHTML() + '<div class="hint">Touchez un employé ou les fiches au-dessus de sa tête. Vert : au travail ou réponse arrivée · orange : quelque chose vous attend.</div><div class="grid">' + cards + '</div>';
  }
  function bandeauInterviews() {
    var l = aInterviewer(); if (!l.length) return '';
    return '<div class="box iv"><div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:center"><b>🎙️ ' + l.length + ' enquête' + pl(l.length) + ' attend' + (l.length > 1 ? 'ent' : '') + ' ses interviews</b><button class="btn small" data-act="a-interviewer">Voir la file</button></div>' +
      l.slice(0, 3).map(function (a) { return '<div class="ivl"><span>' + esc(a.titre) + '</span>' + btnMails(a.id) + '</div>'; }).join('') + '</div>';
  }
  function artCard(a) {
    var n = D().fiches.filter(function (f) { return f.article_id === a.id; }).length;
    return '<div class="ar' + (a.id === S.art ? ' sel' : '') + '" data-act="pick-art" data-id="' + esc(a.id) + '"><div class="ph">' + (a.image ? '<img loading="lazy" alt="" src="' + esc(a.image) + '">' : '📰') + '</div><div class="b"><div class="ti">' + esc(a.titre) + '</div><div class="me">' +
      (a.statut === 'published' ? '<span class="tag g">publié ' + esc(when(a.publie_le)) + '</span>' : '<span class="tag ' + (a.statut === 'scheduled' ? 'b' : 'a') + '">' + (a.statut === 'scheduled' ? 'programmé' : 'brouillon') + '</span>') + (premium(a) ? '<span class="tag">premium</span>' : '') + (premium(a) && !n ? '<span class="tag g">🎙️ interviews à lancer</span>' : '') + (a.mien ? '<span class="tag g">le vôtre</span>' : '') + (n ? '<span class="tag">' + n + ' contact' + pl(n) + '</span>' : '') +
      '<br>' + esc((a.auteurs || []).join(', ')) + ' · modifié ' + esc(when(a.maj)) + ' · <a href="' + esc(a.editeur) + '" target="_blank" rel="noopener" data-stop="1">ouvrir dans Ghost</a>' + (premium(a) || n || prepEtat(a.id) ? '<div style="margin-top:8px">' + btnMails(a.id) + '</div>' : '') + '</div></div></div>';
  }
  // Onglet Articles (23/10/2026) : « Tous les brouillons » listait aussi les publiés. Trois onglets compacts (brouillons, programmés,
  // publiés) et une recherche qui filtre les trois (titre, auteur).
  var ART_ST = [['draft', '📝 Brouillons'], ['scheduled', '🗓️ Programmés'], ['published', '✅ Publiés']];
  function artsFiltres() {
    var q = norm(S.qArt || '').trim();
    return artsRecents().filter(function (a) { return !q || q.split(/\s+/).every(function (m) { return norm(a.titre + ' ' + (a.auteurs || []).join(' ')).indexOf(m) >= 0; }); });
  }
  function artsRes() {
    var l = artsFiltres(), grp = function (st) { return l.filter(function (a) { return (st === 'draft' ? ['scheduled', 'published'].indexOf(a.statut) < 0 : a.statut === st); }); };
    var onglets = ART_ST.filter(function (x) { return x[0] !== 'scheduled' || grp('scheduled').length; });
    var plein = onglets.filter(function (x) { return grp(x[0]).length; })[0];
    var cur = onglets.some(function (x) { return x[0] === S.artTab; }) ? S.artTab : (grp('draft').length || !plein ? 'draft' : plein[0]), liste = grp(cur);
    return '<div class="seg arts-seg" role="tablist">' + onglets.map(function (x) { return '<button type="button" role="tab" aria-selected="' + (x[0] === cur) + '" class="' + (x[0] === cur ? 'on' : '') + '" data-act="art-tab" data-id="' + x[0] + '">' + x[1] + ' <span class="n">' + grp(x[0]).length + '</span></button>'; }).join('') + '</div>' +
      (String(S.qArt || '').trim() ? '<p class="muted" style="margin:2px 0 0">' + l.length + ' article' + pl(l.length) + ' trouvé' + pl(l.length) + ' pour « ' + esc(S.qArt) + ' »</p>' : '') +
      '<div class="arts">' + (liste.map(artCard).join('') || '<div class="muted">' + (String(S.qArt || '').trim() ? 'Aucun article ne correspond.' : cur === 'draft' ? 'Aucun brouillon dans Ghost.' : cur === 'scheduled' ? 'Rien de programmé.' : 'Aucun article publié récemment.') + '</div>') + '</div>';
  }
  function viewArticles() {
    if (D().ghost && D().ghost !== 'ok') return '<div class="box warn" style="margin-top:14px">⚠️ ' + esc(D().ghost) + '</div>';
    var iv = aInterviewer();
    return (iv.length ? '<h3 id="a-interviewer" style="margin-top:16px">🎙️ À interviewer (' + iv.length + ')</h3><p class="muted">Enquêtes premium sans aucune demande d’interview. « Préparer les interviews » : l’Assistant trouve 2 ou 3 chercheurs (adresses publiées uniquement), écrit les questions, et la Secrétaire prépare les mails. Vous n’avez plus qu’à les relire et les valider. Tout se suit en direct dans la fenêtre « Interviews ».</p><div class="arts">' + iv.map(artCard).join('') + '</div><h3 style="margin-top:22px">📰 Les articles de Ghost</h3>' : '<h3 style="margin-top:16px">📰 Les articles de Ghost</h3>') +
      '<p class="muted" style="margin-top:6px">L’article en cours guide l’Assistant (questions, chercheurs à contacter) et reçoit les citations.</p>' +
      '<div class="qbox"><input class="in" id="wl-qa" type="search" value="' + esc(S.qArt || '') + '" placeholder="Chercher un article (titre, auteur)…" autocomplete="off" enterkeyhint="search" aria-label="Chercher un article"></div><div id="wl-art-res">' + artsRes() + '</div>';
  }

  // ================= Fenêtre « Interviews » : préparation express suivie en direct (23/10/2026) =================
  // La page enchaîne les actions qui existent déjà, et montre chaque étape RÉELLE dès qu'elle aboutit :
  //   1. api('contacts') : l'Assistant cherche les chercheurs (recherche web) → leurs lignes apparaissent (nom, institution, adresse) ;
  //   2. pour chacun, api('questions') → « questions prêtes » ; 3. api('rediger', express) → la fiche « à valider » est créée, sa carte apparaît.
  // Les contacts avancent en parallèle (3 au plus) ; un échec n'arrête pas les autres (« Réessayer ce contact »).
  // Mêmes règles que l'ancienne express en un appel : 3 personnes au plus, d'abord celles dont l'adresse est publiée, adresse vérifiée,
  // case « Article publié », réponse sous 48 h, trace « préparé en express » (n8n : « Mail — statut de l'article », « Fiche — case publié »).
  // L'état est gardé dans ce navigateur : après un rechargement, ce qui était fini reste fini, ce qui était en route côté serveur
  // (un mail en rédaction) est attendu, le reste se reprend d'un clic, sans refaire les fiches déjà créées.
  var PREP_LS = 'wl-prep-v2', PREP_MAX = 3, PREP_GARDE = 1800000;
  var okMail = function (s) { return /^[^\s@<>]+@[^\s@<>]+\.[a-z]{2,}$/i.test(String(s || '').trim()); };
  function prepFiches(id) {
    var rang = function (f) { return f.statut === 'brouillon' ? 0 : relancePrete(f) ? 1 : f.statut === 'a répondu' ? 2 : estRebond(f) ? 3 : f.statut === 'envoyé' ? 4 : 5; };
    return D().fiches.filter(function (f) { return f.article_id === id && f.statut !== 'archivé'; }).sort(function (a, b) { return rang(a) - rang(b); });
  }
  function prepSauver() {
    var o = {}; Object.keys(S.preps || {}).forEach(function (k) { var p = S.preps[k]; o[k] = { t0: p.t0, publie: p.publie, etat: p.etat, why: p.why || '', fin: p.fin || 0, trouves: p.trouves || 0,
      contacts: (p.contacts || []).map(function (c) { return { nom: c.nom, profil_url: c.profil_url || '', role: c.role, institution: c.institution, email: c.email, source_email: c.source_email, ou_trouver: c.ou_trouver, langue: c.langue, pourquoi: c.pourquoi, deja: c.deja || '', etat: c.etat, why: c.why || '', questions: c.questions || null, fiche_id: c.fiche_id || '', t: c.t || 0 }; }) }; });
    LS.set(PREP_LS, Object.keys(o).length ? JSON.stringify(o) : null);
  }
  // Après un rechargement : rien ne tourne plus dans la page. Une recherche ou des questions en cours sont perdues (à reprendre) ;
  // un mail en rédaction continue côté n8n : on l'attend 3 minutes (sa fiche arrive par le temps réel), puis on propose de le refaire.
  function prepRelire() {
    if (S.preps) return; S.preps = {};
    var o = null; try { o = JSON.parse(LS.get(PREP_LS) || 'null'); } catch (e) { o = null; }
    Object.keys(o || {}).forEach(function (k) {
      var p = o[k]; if (!p || Date.now() - Number(p.t0) > PREP_GARDE) return;
      if (p.etat === 'contacts') { p.etat = 'ko'; p.why = 'la page a été rechargée pendant la recherche des chercheurs'; p.fin = Date.now(); }
      (p.contacts || []).forEach(function (c) { if (c.etat === 'questions' || c.etat === 'attente') { c.etat = 'ko'; c.why = 'interrompu par le rechargement de la page'; } else if (c.etat === 'mail') c.serveur = true; });
      S.preps[k] = p;
    });
    prepSauver();
  }
  function enCours(p) { return !!p && (p.etat === 'contacts' || p.etat === 'cours'); }
  // Rapproche les contacts de leurs fiches (temps réel), clôt la préparation quand chaque contact est fini.
  function prepEtat(id) {
    prepRelire();
    var p = S.preps[id]; if (!p) return null;
    var fs = S.data ? D().fiches.filter(function (f) { return f.article_id === id; }) : [];
    (p.contacts || []).forEach(function (c) {
      var f = fs.filter(function (x) { return (c.fiche_id && x.fiche_id === c.fiche_id) || (!c.fiche_id && c.etat === 'mail' && ((c.email && String(x.contact.email || '').toLowerCase() === c.email) || norm(x.contact.nom) === norm(c.nom))); })[0];
      if (f) { c.fiche_id = f.fiche_id; if (c.etat === 'mail' || c.etat === 'cree') c.etat = 'ok'; }
      if (c.etat === 'mail' && c.serveur && Date.now() - (c.t || 0) > 180000) { c.etat = 'ko'; c.serveur = false; c.why = 'le mail n’est pas arrivé après le rechargement de la page'; }
    });
    if (p.etat === 'cours' && !S.prepVif && (p.contacts || []).every(function (c) { return ['ok', 'ko', 'deja'].indexOf(c.etat) >= 0; })) { p.etat = 'ok'; p.fin = p.fin || Date.now(); prepSauver(); }
    return p;
  }
  function prepOcc() {
    // Lampes du plan : l'Assistant cherche / écrit les questions, la Secrétaire rédige.
    var cherche = 0, qs = 0, ml = 0;
    Object.keys(S.preps || {}).forEach(function (k) { var p = S.preps[k]; if (p.etat === 'contacts') cherche++; (p.contacts || []).forEach(function (c) { if (c.etat === 'questions') qs++; if (c.etat === 'mail' && !c.serveur) ml++; }); });
    S.prepOcc = S.prepOcc || {};
    var poser = function (k, v) { if (v) { S.busy[k] = v; S.prepOcc[k] = 1; } else if (S.prepOcc[k]) { delete S.busy[k]; delete S.prepOcc[k]; } };
    poser('assistant', cherche ? 'cherche les chercheurs' : qs ? 'écrit les questions (' + qs + ')' : '');
    poser('secretaire', ml ? 'rédige ' + ml + ' mail' + pl(ml) : '');
  }
  function prepMaj() { prepSauver(); prepOcc(); paintFloor(); if (S.doc && S.doc.kind === 'prep') paintDoc(); if (!S.doc || S.doc.kind !== 'prep') render(); }
  // Bouton des listes (Articles, file « à interviewer », Interphone) : préparer, suivre la préparation ou voir les mails.
  function btnMails(id) {
    var p = prepEtat(id), n = prepFiches(id).length;
    if (enCours(p)) return '<button class="btn small amber" data-act="voir-mails" data-id="' + esc(id) + '">⏳ Préparation en cours · voir</button>';
    if (n) return '<button class="btn small" data-act="voir-mails" data-id="' + esc(id) + '">📬 Voir les mails (' + n + ')</button>';
    if (p && p.etat === 'ko') return '<button class="btn small red" data-act="voir-mails" data-id="' + esc(id) + '">⚠️ Préparation interrompue · voir</button>';
    return '<button class="btn small go" data-act="express" data-id="' + esc(id) + '"' + (S.busy.assistant ? ' disabled' : '') + '>⚡ Préparer les interviews</button>';
  }
  // Même bouton en version icône pour les lignes compactes du Marbre.
  function btnMailsCourt(id) {
    var p = prepEtat(id), n = prepFiches(id).length, b = function (act, cls, ic, lib) { return '<button class="btn small al-b ' + cls + '" data-act="' + act + '" data-id="' + esc(id) + '" title="' + esc(lib) + '" aria-label="' + esc(lib) + '"' + (act === 'express' && S.busy.assistant ? ' disabled' : '') + '>' + ic + '</button>'; };
    if (enCours(p)) return b('voir-mails', 'amber', '⏳', 'Préparation des interviews en cours : voir');
    if (n) return b('voir-mails', '', '📬 ' + n, 'Voir les mails (' + n + ')');
    if (p && p.etat === 'ko') return b('voir-mails', 'red', '⚠️', 'Préparation interrompue : voir');
    return b('express', 'go', '⚡', 'Préparer les interviews');
  }
  function mmss(ms) { var s = Math.max(0, Math.floor(ms / 1000)); return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); }
  // Barre : 40 % pour la recherche (qui avance doucement pendant l'attente), puis questions et mail de chaque contact.
  function prepPct(p) {
    if (p.etat === 'ok') return 100;
    if (p.etat === 'contacts' || !(p.contacts || []).length) return Math.min(38, Math.round(38 * (1 - Math.exp(-(Date.now() - p.t0) / 40000))));
    var cs = p.contacts, part = 60 / cs.length, v = 40;
    cs.forEach(function (c) { v += ['ok', 'ko', 'deja'].indexOf(c.etat) >= 0 ? part : c.etat === 'mail' ? part * 0.5 : c.etat === 'questions' ? part * 0.15 : 0; });
    return Math.min(99, Math.round(v));
  }
  var PREP_ATTENTE = ['lit l’article', 'repère les études citées', 'cherche leurs auteurs', 'vérifie les pages des labos et des universités', 'cherche les adresses publiées'];
  function prepEtape(cls, ic, txt, sous, extra) { return '<li class="' + cls + '"><span class="pp-ic">' + ic + '</span><span class="pp-l"><span class="pp-lt">' + txt + '</span>' + (sous ? '<small>' + sous + '</small>' : '') + (extra || '') + '</span></li>'; }
  function prepLigneContact(id, c, k) {
    var st = function (e) { return c.etat === 'ko' ? (e === c.koA ? 'ko' : (e === 'q' && c.questions) ? 'ok' : 'wait') : e === 'q' ? (c.etat === 'questions' ? 'run' : c.etat === 'attente' ? 'wait' : 'ok') : (c.etat === 'mail' ? 'run' : ['ok', 'cree'].indexOf(c.etat) >= 0 ? 'ok' : 'wait'); };
    var adr = (c.email ? '✉️ ' + esc(c.email) : '🔍 adresse à trouver' + (c.ou_trouver ? ' : ' + esc(String(c.ou_trouver).slice(0, 120)) : '')) + (c.email ? sourceAdresse(c.source_email) : '');
    var h = '<div class="pp-ct ' + (c.etat === 'ok' ? 'ok' : c.etat === 'ko' ? 'ko' : c.etat === 'deja' ? 'deja' : 'run') + '"><div class="pp-ct-h"><b>' + nomLien(c.nom, c.profil_url, c.institution) + '</b><span>' + esc([c.role, c.institution].filter(Boolean).join(', ')) + '</span></div>' +
      '<div class="pp-ct-m">' + adr + (c.deja ? ' · <span class="tag a">déjà contacté : ' + esc(c.deja) + '</span>' : '') + '</div>';
    if (c.etat === 'deja') return h + '<div class="pp-ct-s"><span class="ok">✓ une fiche existe déjà pour cet article : pas de doublon</span></div></div>';
    h += '<div class="pp-ct-s"><span class="' + st('q') + '">❓ questions' + (c.questions ? ' (' + c.questions.length + ')' : '') + '</span><span class="' + st('m') + '">✍️ mail' + (c.serveur && c.etat === 'mail' ? ' (en route côté serveur)' : '') + '</span>' +
      (c.etat === 'ok' ? '<span class="ok">📮 à valider</span>' : '') + '</div>';
    if (c.etat === 'ko') h += '<div class="pp-ct-e">⚠️ ' + esc(c.why || 'erreur') + ' <button class="btn small" data-act="prep-retry" data-id="' + esc(id + '|' + k) + '">↻ Réessayer ce contact</button></div>';
    return h + '</div>';
  }
  function docPrep(id) {
    var a = art(id), p = prepEtat(id), fs = prepFiches(id), titre = (a && a.titre) || (fs[0] && fs[0].article_titre) || 'Enquête';
    var nb = fs.filter(function (f) { return f.statut === 'brouillon'; }).length, vivant = p && (enCours(p) || Date.now() - (p.fin || 0) < 900000 || p.etat === 'ko');
    var st = enCours(p) ? 'préparation express en cours' : fs.length ? fs.length + ' demande' + pl(fs.length) + ' d’interview' + (nb ? ' · ' + nb + ' à valider' : '') : p && p.etat === 'ko' ? 'préparation interrompue' : 'aucune demande pour l’instant';
    var h = '<div class="dtop"><span class="em">📬</span><div style="min-width:0"><div class="nm">Interviews</div><div class="st">' + esc(st) + '</div></div><span style="flex:1"></span><button type="button" class="btn small pp-x" data-act="close-doc" aria-label="Fermer la fenêtre">✕ Fermer</button></div>';
    h += '<div class="prep" role="dialog" aria-modal="true" aria-label="Interviews de l’article"><div class="pp-k">' + (enCours(p) ? '<i class="pp-dot"></i>' : '') + (vivant ? 'préparation des interviews' : 'interviews de l’article') + '</div><div class="pp-ti">' + esc(titre) + '</div>';
    if (vivant) {
      var fin = p.etat === 'ok' || p.etat === 'ko', cs = p.contacts || [], nOk = cs.filter(function (c) { return c.etat === 'ok'; }).length, nKo = cs.filter(function (c) { return c.etat === 'ko'; }).length;
      h += '<div class="pp-pg' + (enCours(p) ? ' on' : '') + '"><div class="pp-bar"><i style="width:' + prepPct(p) + '%"></i></div><div class="pp-meta"><span class="pp-el">' + mmss((fin ? (p.fin || Date.now()) : Date.now()) - p.t0) + '</span><span>' +
        (p.etat === 'ok' ? (nKo ? '✓ terminé · ' + nKo + ' à reprendre' : '✓ terminé') : p.etat === 'ko' ? '✕ interrompu' : p.etat === 'contacts' ? 'recherche : souvent 40 s à 1 min 30' : nOk + ' / ' + cs.length + ' mails prêts') + '</span></div></div><ol class="pp-log r">';
      var att = PREP_ATTENTE[Math.floor((Date.now() - p.t0) / 7000) % PREP_ATTENTE.length];
      h += prepEtape(p.etat === 'contacts' ? 'run' : cs.length ? 'ok' : 'ko', '🔎', 'Recherche des chercheurs', p.etat === 'contacts' ? '<span class="pp-att">L’Assistant ' + esc(att) + '…</span>' : cs.length ? esc(cs.length + ' retenu' + pl(cs.length) + (p.trouves > cs.length ? ' sur ' + p.trouves + ' trouvés' : '') + ' · d’abord les adresses publiées') : esc(p.why || 'personne de sûr trouvé'));
      h += '</ol>';
      if (cs.length) h += '<div class="pp-cts">' + cs.map(function (c, k) { return prepLigneContact(id, c, k); }).join('') + '</div>';
      if (p.etat === 'ko' && !cs.length) h += '<div class="box warn" style="margin:12px 0">⚠️ ' + esc(p.why || 'La recherche n’a pas abouti') + '.<div class="row" style="margin-top:10px"><button class="btn small go" data-act="express" data-id="' + esc(id) + '"' + (S.busy.assistant ? ' disabled' : '') + '>↻ Relancer la recherche</button></div></div>';
      if (nKo > 1 && !enCours(p)) h += '<div class="row" style="margin:8px 0"><button class="btn small" data-act="prep-retry" data-id="' + esc(id + '|*') + '">↻ Reprendre les ' + nKo + ' contacts interrompus</button></div>';
      if (enCours(p)) h += '<p class="muted pp-n">Vous pouvez fermer cette fenêtre : la préparation continue tant que cette page reste ouverte. « ⏳ Préparation en cours · voir », dans la liste des articles, la rouvre.</p>';
    }
    if (fs.length) {
      S.prepVu = S.prepVu || {}; var neuves = 0;
      h += '<div class="pp-h"><b>Les mails</b>' + avancement(fs) + '</div><p class="muted" style="margin:2px 0 10px">Touchez une carte pour relire, corriger et envoyer le mail. Une carte bleue est partie ; verte, le chercheur a répondu.</p><div class="dos pp-cards">' +
        fs.map(function (f) {
          var x = f.statut === 'brouillon' ? '<div class="su">✉️ ' + esc(f.mail_sujet) + '</div>' : f.statut === 'envoyé' ? '<div class="su">' + esc(envoiTxt(f)) + '</div>' : f.statut === 'a répondu' ? '<div class="su">réponse reçue ' + esc(when(f.reponse_le)) + '</div>' : '';
          var neuf = vivant && !S.prepVu[f.fiche_id]; if (neuf) neuves++;
          return '<div class="pp-c' + (neuf ? ' in' : '') + '" style="animation-delay:' + (neuf ? (neuves - 1) * 0.18 : 0).toFixed(2) + 's">' + dcard(f, x) + '</div>';
        }).join('') + '</div><div class="row" style="margin-top:12px;gap:8px"><button class="btn small" data-act="dossier-sec" data-id="' + esc(id) + '">📮 Ouvrir le dossier chez la Secrétaire</button></div>';
      setTimeout(function () { fs.forEach(function (f) { S.prepVu[f.fiche_id] = 1; }); }, 50);
    } else if (!p) {
      h += '<p class="muted" style="margin-top:14px">Aucune demande d’interview pour cet article.</p>' + (a ? '<div class="row"><button class="btn small go" data-act="express" data-id="' + esc(id) + '"' + (S.busy.assistant ? ' disabled' : '') + '>⚡ Préparer les interviews</button></div>' : '');
    }
    return h + '</div>';
  }
  // Chaque seconde pendant la recherche : chrono, barre et phrase d'attente mis à jour en place (rien ne saute à l'écran).
  function majPrep() {
    prepRelire();
    if (!Object.keys(S.preps).some(function (k) { return enCours(S.preps[k]); })) { clearInterval(S.prepTick); S.prepTick = null; }
    Object.keys(S.preps).forEach(function (k) { var p = S.preps[k]; if (p.etat === 'cours' && (p.contacts || []).some(function (c) { return c.serveur; })) { var av = JSON.stringify(p.contacts.map(function (c) { return c.etat; })); prepEtat(k); if (JSON.stringify(p.contacts.map(function (c) { return c.etat; })) !== av) prepMaj(); } });
    if (!S.doc || S.doc.kind !== 'prep' || document.hidden) return;
    var p = S.preps[S.doc.id], el = S.root.querySelector('.doc .prep'); if (!p || !el || !enCours(p)) return;
    var b = el.querySelector('.pp-bar i'), e = el.querySelector('.pp-el'), at = el.querySelector('.pp-att');
    if (b) b.style.width = prepPct(p) + '%'; if (e) e.textContent = mmss(Date.now() - p.t0);
    if (at) { var t = 'L’Assistant ' + PREP_ATTENTE[Math.floor((Date.now() - p.t0) / 7000) % PREP_ATTENTE.length] + '…'; if (at.textContent !== t) at.textContent = t; }
  }
  function prepTicker() { if (!S.prepTick) S.prepTick = setInterval(majPrep, 1000); }
  function voirMails(id) {
    if (!S.doc) S.prepOpener = document.activeElement;
    openDoc('prep', id);
    if (enCours(prepEtat(id))) prepTicker();
    setTimeout(function () { var x = S.root.querySelector('.doc .pp-x'); if (x) x.focus({ preventScroll: true }); }, 30);
  }
  // Un contact : questions (si pas déjà faites), puis le mail. Erreurs gardées sur la ligne du contact.
  function prepContact(id, p, c) {
    var contact = { nom: c.nom, email: c.email, role: c.role, institution: c.institution, langue: c.langue, pourquoi: c.pourquoi, source_email: c.source_email, ou_trouver: c.ou_trouver, profil_url: c.profil_url };
    var etape = function (q) {
      c.etat = 'mail'; c.t = Date.now(); c.serveur = false; prepMaj();
      return api('rediger', { article_id: id, contact: contact, questions: q, type: 'interview', publie: p.publie, express: true }).then(function (r) {
        c.fiche_id = r.fiche_id || ''; c.etat = 'ok'; prepMaj(); if (!S.rtOk) refresh(true);
      }, function (e) { c.etat = 'ko'; c.koA = 'm'; c.why = e.message; prepMaj(); });
    };
    if (c.questions && c.questions.length) return etape(c.questions);
    c.etat = 'questions'; c.why = ''; prepMaj();
    return api('questions', { article_id: id, contact: contact, nb: 5 }).then(function (r) {
      var q = (r.questions || []).map(function (x) { return String((x && x.q) || x || '').trim(); }).filter(Boolean).slice(0, 5);
      if (!q.length) throw new Error('aucune question proposée');
      c.questions = q; return etape(q);
    }, function (e) { c.etat = 'ko'; c.koA = 'q'; c.why = e.message; prepMaj(); });
  }
  function prepFile(id, p, liste) {
    var file = liste.slice(), actifs = 0;
    return new Promise(function (fini) {
      var suivant = function () {
        if (!file.length && !actifs) return fini();
        while (actifs < PREP_MAX && file.length) { actifs++; prepContact(id, p, file.shift()).then(function () { actifs--; suivant(); }); }
      };
      suivant();
    });
  }
  function prepConclure(id, p) {
    p.etat = 'ok'; p.fin = Date.now(); prepMaj();
    var ok = (p.contacts || []).filter(function (c) { return c.etat === 'ok'; }).length, ko = (p.contacts || []).filter(function (c) { return c.etat === 'ko'; }).length;
    if (!(S.doc && S.doc.kind === 'prep' && S.doc.id === id)) toast('⚡ ' + ok + ' mail' + pl(ok) + ' prêt' + pl(ok) + (ko ? ', ' + ko + ' à reprendre' : '') + ' : touchez « 📬 Voir les mails ».', !!ko && !ok);
  }
  function lancerPrep(id, publie) {
    prepRelire();
    var p = S.preps[id] = { t0: Date.now(), publie: publie !== false, etat: 'contacts', contacts: [] }; S.prepVif = (S.prepVif || 0) + 1;
    S.art = id; LS.set('wl-article', id); pubOubli('x:' + id);
    prepMaj(); voirMails(id); prepTicker();
    api('contacts', { article_id: id }).then(function (r) {
      var l = (r.contacts || []).filter(function (c) { return c && c.nom; });
      var avec = l.filter(function (c) { return okMail(c.email); }), sans = l.filter(function (c) { return !okMail(c.email); });
      var pick = (avec.length ? avec : sans).slice(0, 3), dejaIci = D().fiches.filter(function (f) { return f.article_id === id && f.statut !== 'archivé'; });
      p.trouves = l.length;
      p.contacts = pick.map(function (c) {
        var em = okMail(c.email) ? String(c.email).trim().toLowerCase() : '';
        var ici = dejaIci.filter(function (f) { return (em && String(f.contact.email || '').toLowerCase() === em) || norm(f.contact.nom) === norm(c.nom); })[0];
        var ail = em ? dejaContacte(em).filter(function (f) { return f.article_id !== id; })[0] : null;
        return { nom: String(c.nom).slice(0, 160), profil_url: /^https?:\/\//i.test(String(c.profil_url || '').trim()) ? String(c.profil_url).trim().slice(0, 500) : '', role: String(c.role || '').slice(0, 200), institution: String(c.institution || '').slice(0, 200), email: em, source_email: String(c.source_email || '').slice(0, 300),
          ou_trouver: String(c.ou_trouver || '').slice(0, 300), langue: c.langue === 'en' ? 'en' : 'fr', pourquoi: String(c.pourquoi || '').slice(0, 400),
          deja: ail ? (ail.envoye_le ? 'le ' + day(ail.envoye_le) + ' pour « ' + (ail.article_titre || 'un autre article') + ' »' : 'pour « ' + (ail.article_titre || 'un autre article') + ' »') : '',
          etat: ici ? 'deja' : 'attente', fiche_id: ici ? ici.fiche_id : '' };
      });
      if (!p.contacts.length) { p.etat = 'ko'; p.fin = Date.now(); p.why = 'personne de sûr trouvé pour cet article : passez par l’Assistant'; prepMaj(); return; }
      p.etat = 'cours'; prepMaj();
      return prepFile(id, p, p.contacts.filter(function (c) { return c.etat === 'attente'; })).then(function () { prepConclure(id, p); });
    }, function (e) { p.etat = 'ko'; p.fin = Date.now(); p.why = e.message; prepMaj(); }).then(function () { S.prepVif = Math.max(0, (S.prepVif || 1) - 1); prepMaj(); });
  }
  // « Réessayer ce contact » (ou « Reprendre » : tous ceux qui sont en échec). Les fiches déjà créées ne sont jamais refaites.
  function reprendrePrep(cle) {
    var x = String(cle).split('|'), id = x[0], p = prepEtat(id); if (!p) return;
    var liste = (p.contacts || []).filter(function (c, k) { return c.etat === 'ko' && (x[1] === '*' || String(k) === x[1]); });
    if (!liste.length) return;
    liste.forEach(function (c) { c.etat = 'attente'; c.why = ''; });
    p.etat = 'cours'; p.fin = 0; S.prepVif = (S.prepVif || 0) + 1; prepMaj(); prepTicker();
    prepFile(id, p, liste).then(function () { S.prepVif = Math.max(0, S.prepVif - 1); if ((p.contacts || []).every(function (c) { return c.etat !== 'attente' && c.etat !== 'questions' && c.etat !== 'mail'; })) prepConclure(id, p); });
  }
  // Nom du chercheur cliquable (23/10/2026) : la page de profil trouvée par la recherche (LinkedIn, labo, université…), gardée dans
  // l'historique de la fiche par n8n. Sans page enregistrée (fiches anciennes) : une recherche Google ciblée, marquée comme telle (🔎).
  // Le clic sur le nom n'ouvre pas la fiche (data-stop) ; liens http(s) seulement (PHL.url).
  function liensFiche(f) {
    var h = (f && f.historique) || [], pr = '', src = '';
    for (var i = h.length - 1; i >= 0; i--) { var e = h[i] || {}; if (!pr && e.profil) pr = e.profil; if (!src && e.source) src = e.source;
      if (!src) { var m = String(e.e || '').match(/\(adresse : (https?:\/\/[^\s)]+)\)/); if (m) src = m[1]; } }
    return { profil: pr, source: src };
  }
  function hote(u) { var m = String(u || '').match(/^https?:\/\/([^\/?#]+)/i); return m ? m[1].replace(/^www\./, '') : ''; }
  // Ligne d'historique (23/10/2026) : jamais d'URL brute (elle débordait sur iPhone). Chaque adresse web devient un lien court au nom
  // du site (« adresse trouvée sur researchgate.net ↗ ») ; conversion à l'affichage, rien ne change en base.
  function histTxt(s) {
    s = String(s || ''); var re = /(\(adresse : )?(https?:\/\/[^\s)<>"]+)(\))?/g, out = '', i = 0, m;
    while ((m = re.exec(s))) {
      out += esc(s.slice(i, m.index));
      var u = m[2].replace(/[.,;:!?]+$/, ''), reste = m[2].slice(u.length), h = hote(u) || 'lien';
      var a = '<a class="src-l h-l" href="' + url(u) + '" target="_blank" rel="noopener" data-stop="1" title="' + esc(h) + '">' + esc(h) + ' ↗</a>';
      out += m[1] ? '(adresse trouvée sur ' + a + esc(reste) + (m[3] ? ')' : '') : a + esc(reste) + (m[3] ? ')' : '');
      i = m.index + m[0].length;
    }
    return out + esc(s.slice(i));
  }
  function nomLien(nom, profil, institution) {
    if (!nom) return esc('(sans nom)');
    if (/^https?:\/\//i.test(String(profil || '').trim())) {
      var li = /linkedin\.com/i.test(profil);
      return '<a class="nom-l" href="' + url(profil) + '" target="_blank" rel="noopener" data-stop="1" data-tip="' + esc((li ? 'Profil LinkedIn' : 'Page trouvée par la recherche') + '|' + hote(profil) + '|') + '" data-tip-act="Ouvre dans un nouvel onglet">' + esc(nom) + '<span class="nom-i' + (li ? ' li' : '') + '">' + (li ? 'in' : '↗') + '</span></a>';
    }
    var q = 'https://www.google.com/search?q=' + encodeURIComponent('"' + nom + '"' + (institution ? ' ' + institution : ''));
    return '<a class="nom-l nom-q" href="' + url(q) + '" target="_blank" rel="noopener" data-stop="1" data-tip="' + esc('Recherche Google|« ' + nom + (institution ? ' » · ' + institution : ' »') + '|aucune page de profil enregistrée pour ce contact') + '" data-tip-act="Ouvre la recherche dans un nouvel onglet">' + esc(nom) + '<span class="nom-i">🔎</span></a>';
  }
  function nomFiche(f) { return nomLien(f.contact.nom, liensFiche(f).profil, f.contact.institution); }
  function sourceAdresse(src) { return /^https?:\/\//i.test(String(src || '')) ? ' <a class="src-l" href="' + url(src) + '" target="_blank" rel="noopener" data-stop="1">📧 adresse trouvée sur ' + esc(hote(src)) + '</a>' : ''; }
  function dcard(f, extra) {
    var s = stLib(f);
    var og = origine(f);
    return '<div class="dcard ' + s[2] + '" tabindex="0" role="button" data-act="' + (f.statut === 'brouillon' ? 'open-valid' : 'open-fiche') + '" data-id="' + esc(f.fiche_id) + '"><div class="k">' + s[0] + ' ' + esc(s[1]) + ' · ' + og[0] + ' ' + og[1] + (D().me.chef ? ' · ' + esc(qui(f)) : '') + '</div>' +
      '<div class="ti">' + nomFiche(f) + '</div><div class="su">' + esc([f.contact.role, f.contact.institution].filter(Boolean).join(', ')) + '</div>' +
      '<div class="su">📰 ' + esc(f.article_titre || 'sans article') + '</div>' + (extra || '') +
      (relancePrete(f) ? '<div class="su">⏰ <b>relance prête à valider</b></div>' : '') + (relanceInfo(f) ? '<div class="su">🔁 ' + esc(relanceInfo(f)) + '</div>' : '') +
      (estRebond(f) && f.statut !== 'rebond' ? '<div class="su"><b>✉️ adresse invalide</b></div>' : '') + '</div>';
  }
  function vuesQ() { return vues().filter(function (f) { return cherche(f, S.qSuivi); }); }
  function viewSuivi() {
    var vide = !vues().length;
    var intro = '<p class="muted" style="margin-top:14px">Le parcours des demandes d’interview' + (D().me.chef ? ' de toute la rédaction' : '') + ' : mail rédigé par la Secrétaire → envoyé → réponse reçue → citation insérée dans l’article. Les fiches archivées n’apparaissent plus ici.</p>' +
      (vide ? '<div class="box" style="margin-top:6px">Aucune demande en cours pour l’instant. Pour en lancer une : choisissez un article, puis demandez à l’Assistant qui interroger.<div class="row" style="margin-top:10px"><button class="btn" data-act="open-ag" data-ag="assistant">🧠 Préparer une interview</button><button class="btn small" data-act="open-ag" data-ag="secretaire">📮 Écrire à quelqu’un</button></div></div>' : '');
    var q = vide ? '' : '<div class="qbox"><input class="in" id="wl-q" type="search" value="' + esc(S.qSuivi || '') + '" placeholder="Chercher un chercheur, une institution, un article, un objet de mail…" autocomplete="off" enterkeyhint="search"></div>';
    return intro + porteeHTML() + q + '<div id="wl-suivi-res">' + suiviRes() + '</div>';
  }
  // Suivi « par enquête » (23/10/2026) : une carte compacte par article (titre → Ghost, barre segmentée aux couleurs des cartes de la
  // Secrétaire, ligne de progression, prochaine action). Triées par urgence (mails à valider, réponses à citer, relances, adresses
  // invalides), puis par date.
  function urgence(fs) {
    var c = function (st) { return fs.filter(function (f) { return f.statut === st; }).length; };
    return c('brouillon') * 100 + c('a répondu') * 60 + fs.filter(relancePrete).length * 40 + fs.filter(estRebond).length * 30 + c('envoyé');
  }
  function enquetes(ds) { return ds.slice().sort(function (a, b) { return (urgence(b.fiches) - urgence(a.fiches)) || b.maj.localeCompare(a.maj); }); }
  function carteEnquete(d) {
    var fs = d.fiches, c = function (st) { return fs.filter(function (f) { return f.statut === st; }).length; }, a = d.id && art(d.id);
    var ordre = ['inséré', 'a répondu', 'envoyé', 'brouillon', 'rebond'], tri = fs.slice().sort(function (x, y) { return ordre.indexOf(estRebond(x) ? 'rebond' : x.statut) - ordre.indexOf(estRebond(y) ? 'rebond' : y.statut); });
    var barre = '<div class="eb" aria-hidden="true">' + tri.map(function (f) { var k = estRebond(f) ? 'r' : (STATUTS[f.statut] || [, , ''])[2]; return '<i class="' + (f.statut === 'inséré' ? 'c' : k) + '"></i>'; }).join('') + '</div>';
    var parties = fs.filter(function (f) { return ['envoyé', 'a répondu', 'inséré'].indexOf(f.statut) >= 0; }).length;
    var ligne = [fs.length + ' contact' + pl(fs.length), parties ? parties + ' mail' + pl(parties) + ' parti' + pl(parties) : '', c('a répondu') + c('inséré') ? (c('a répondu') + c('inséré')) + ' réponse' + pl(c('a répondu') + c('inséré')) : '', c('inséré') ? c('inséré') + ' cité' + pl(c('inséré')) : ''].filter(Boolean).join(' · ');
    var nrel = fs.filter(relancePrete), nreb = fs.filter(estRebond), rep1 = fs.filter(function (f) { return f.statut === 'a répondu'; });
    var act = c('brouillon') ? '<button class="btn small go" data-act="voir-mails" data-id="' + esc(d.id) + '">🟠 Valider ' + c('brouillon') + ' mail' + pl(c('brouillon')) + '</button>'
      : rep1.length ? '<button class="btn small go" data-act="open-fiche" data-id="' + esc(rep1[0].fiche_id) + '">📬 Insérer la citation de ' + esc(rep1[0].contact.nom) + '</button>'
      : nrel.length ? '<button class="btn small amber" data-act="open-fiche" data-id="' + esc(nrel[0].fiche_id) + '">⏰ Relance prête : ' + esc(nrel[0].contact.nom) + '</button>'
      : nreb.length ? '<button class="btn small red" data-act="open-fiche" data-id="' + esc(nreb[0].fiche_id) + '">✉️ Adresse invalide : ' + esc(nreb[0].contact.nom) + '</button>' : '';
    var titre = a ? '<a class="enq-t" href="' + url(a.editeur) + '" target="_blank" rel="noopener" data-stop="1" data-tip="' + esc(a.titre + '|' + (a.statut === 'published' ? 'publié' : a.statut === 'scheduled' ? 'programmé' : 'brouillon') + ' · ouvrir dans Ghost|') + '">' + esc(a.titre) + ' <span class="nom-i">↗</span></a>' : '<span class="enq-t">' + esc(d.titre) + '</span>';
    return '<div class="enq" id="dossier-' + esc(d.id || 'sans') + '">' + titre + (a ? '<span class="tag ' + (a.statut === 'published' ? 'g' : a.statut === 'scheduled' ? 'b' : 'a') + '">' + (a.statut === 'published' ? 'publié' : a.statut === 'scheduled' ? 'programmé' : 'brouillon') + '</span>' : '') +
      barre + '<div class="enq-l">' + esc(ligne) + '</div><div class="enq-n">' + fs.map(function (f) { return nomFiche(f); }).join('<span class="sep">·</span>') + '</div>' +
      '<div class="row enq-a">' + act + (d.id ? '<button class="btn small" data-act="voir-mails" data-id="' + esc(d.id) + '">📬 Voir les mails</button>' : '') + '</div></div>';
  }
  function suiviRes() {
    var cols = [['brouillon', '🟠 À valider'], ['envoyé', '📨 Envoyés'], ['a répondu', '📬 Réponses'], ['inséré', '✅ Cités']];
    var list = vuesQ(), qq = String(S.qSuivi || '').trim();
    if (list.some(estRebond)) cols.push(['rebond', '✉️ Adresses invalides']);
    var bySt = function (st) { return list.filter(function (f) { return f.statut === st; }); };
    var ds = dossiers(list);
    var dosHTML = (qq ? '<p class="muted">' + list.length + ' fiche' + pl(list.length) + ' trouvée' + pl(list.length) + ' pour « ' + esc(qq) + ' »</p>' : '') +
      (ds.length ? '<h3 style="margin-top:14px">📰 Par enquête</h3><p class="muted" style="margin-top:0">Une carte par article : où en sont les demandes, et la prochaine chose à faire.</p><div class="enqs">' + enquetes(ds).map(carteEnquete).join('') + '</div><h3 style="margin-top:18px">Par étape</h3>' : '');
    return dosHTML + '<div class="kan" style="margin-top:14px">' + cols.map(function (c) {
      var fs = bySt(c[0]);
      return '<div class="col"><h4>' + c[1] + ' <span class="tag">' + fs.length + '</span></h4><div class="dos">' + (fs.map(function (f) {
        var x = c[0] === 'envoyé' ? '<div class="su">' + esc(envoiTxt(f)) + (relancable(f) && !relancePrete(f) ? ' · <b>relance possible</b>' : '') + '</div>' : c[0] === 'a répondu' ? '<div class="su">réponse ' + esc(when(f.reponse_le)) + '</div>' : c[0] === 'rebond' ? '<div class="su">' + esc(f.rebond_motif || 'le serveur du destinataire a refusé le mail') + '</div>' : '';
        return dcard(f, x);
      }).join('') || '<div class="muted">Rien ici.</div>') + '</div></div>';
    }).join('') + '</div>';
  }
  var CATS = [['factures', '🧾 Factures'], ['documents', '📄 Documents'], ['images', '🖼️ Images'], ['contrats', '✍️ Contrats'], ['articles', '📰 Articles'], ['autres', '📦 Autres']];
  function catNom(c) { var x = CATS.filter(function (k) { return k[0] === c; })[0]; return x ? x[1] : '📦 Autres'; }
  function taille(n) { return n > 1048576 ? (n / 1048576).toFixed(1) + ' Mo' : Math.max(1, Math.round(n / 1024)) + ' Ko'; }
  function fichierHTML(f) {
    var img = /^image\//.test(f.type) && f.url;
    return '<a class="pj" href="' + esc(f.url || '#') + '" target="_blank" rel="noopener" data-stop="1" style="display:flex;gap:10px;align-items:center;margin-top:6px;padding:8px 10px;border-radius:10px;background:rgba(255,255,255,.06);border:1px solid rgba(255,190,90,.2);text-decoration:none">' +
      (img ? '<img src="' + esc(f.url) + '" alt="" style="width:46px;height:46px;object-fit:cover;border-radius:6px">' : '<span style="font-size:24px">📎</span>') +
      '<span style="min-width:0"><b style="display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#f3ece0">' + esc(f.nom) + '</b><span class="muted">' + esc(catNom(f.categorie)) + ' · ' + taille(f.taille) + (f.url ? '' : ' · lien expiré, ↻') + '</span></span></a>';
  }
  function piecesHTML(list) {
    if (!list || !list.length) return '';
    return '<div style="margin:8px 0 14px">' + list.map(function (f) {
      return '<a href="' + esc(f.url || '#') + '" target="_blank" rel="noopener" data-stop="1" style="display:inline-flex;gap:6px;align-items:center;margin:4px 6px 4px 0;padding:6px 10px;border-radius:999px;border:1px solid #cfc4ad;background:#f6f1e4;color:#1f1a12;text-decoration:none;font-size:15px">📎 ' + esc(f.nom) + ' <span style="opacity:.6">' + taille(f.taille || 0) + '</span></a>';
    }).join('') + '</div>';
  }
  // pièces à joindre à un mail qui part (gardées par mail dans S.pjs, envoyées en base64 avec « Valider et envoyer »)
  function pjWidget(key) {
    var l = (S.pjs && S.pjs[key]) || [];
    return '<div class="pjw" data-pjw="' + esc(key) + '" style="margin:6px 0 2px"><label>Pièces jointes</label>' +
      l.map(function (f, k) { return '<span style="display:inline-flex;gap:6px;align-items:center;margin:4px 6px 4px 0;padding:6px 10px;border-radius:999px;border:1px solid #cfc4ad;background:#f6f1e4;font-size:15px">📎 ' + esc(f.nom) + ' <span style="opacity:.6">' + taille(f.taille) + '</span> <a href="#" data-act="pjs-del" data-id="' + esc(key) + '" data-i="' + k + '" style="color:#b0342b">✕</a></span>'; }).join('') +
      '<button type="button" data-act="pjs-add" data-id="' + esc(key) + '">📎 Joindre un fichier</button></div>';
  }
  function pjsData(key) { return ((S.pjs && S.pjs[key]) || []).map(function (f) { return { nom: f.nom, type: f.type, data: f.data }; }); }
  function viewInterphone() {
    var me = D().me.id, ms = D().messages, fc = S.filtreCat || '';
    var fichiers = ms.filter(function (m) { return m.fichier; });
    var list = ms.map(function (m) {
      var bot = !D().equipe.some(function (w) { return w.id === m.auteur; });
      var btns = m.auteur === 'compta' ? '<div class="row" style="margin-top:8px">' + (/^\s*(🧾|💸)/.test(m.texte || '') || /facture/i.test((m.texte || '').slice(0, 40)) ? '<button class="btn small" data-act="voir-facture">🧾 Voir la facture</button>' : '<button class="btn small" data-act="pieces">🪙 Ouvrir les pièces</button>') + '</div>' : bot && m.article_id ? '<div class="row" style="margin-top:8px;gap:6px;flex-wrap:wrap">' + (art(m.article_id) ? '<button class="btn small" data-act="pick-art" data-id="' + esc(m.article_id) + '">📰 Ouvrir l’enquête</button>' : '') +
        (art(m.article_id) || D().fiches.some(function (f) { return f.article_id === m.article_id; }) ? btnMails(m.article_id) : '') + '</div>' : '';
      return '<div class="bub' + (m.auteur === me ? ' me' : '') + (bot ? ' bot' : '') + '"><div class="who">' + esc(m.nom) + ' · ' + esc(when(m.le)) + (m.article_titre && !bot ? ' · 📰 ' + esc(m.article_titre) : '') + '</div>' + (m.texte ? esc(m.texte).replace(/\n/g, '<br>') : '') + (m.fichier ? fichierHTML(m.fichier) : '') + btns + '</div>';
    }).join('');
    var a = art(S.art);
    return '<p class="muted" style="margin-top:14px">Les messages et fichiers entre la rédaction et le rédacteur en chef. Entrée pour envoyer, Maj + Entrée pour aller à la ligne. Les fichiers échangés sont rangés dans le classeur, à droite.</p>' + classeurHTML(fichiers) +
      '<div class="chat">' + (list || '<div class="muted">Pas encore de message.</div>') + '</div>' +
      '<div class="composer"><textarea class="in' + (S.miseEnForme ? ' wl-mef" disabled' : '"') + ' id="wl-msg" placeholder="' + (S.dicte ? '🎙️ Je vous écoute…' : 'Votre message…') + '" rows="3">' + esc(S.msgDraft || '') + '</textarea>' +
      '<div id="wl-pj-zone">' + pjZone() + '</div>' +
      '<div class="row" style="margin-top:8px;gap:8px;flex-wrap:wrap"><input type="file" id="wl-pj" style="display:none"><button class="btn" data-act="pj-choisir" type="button">📎 Joindre un fichier</button>' +
      (SR ? '<button class="btn mic' + (S.dicte ? ' on' : '') + '" data-act="dicter" type="button" title="Dicter le message (le texte s’écrit dans le champ, vous relisez puis envoyez)">' + (S.dicte ? '⏹️ Arrêter' : '🎙️ Dicter') + '</button>' : '') +
      (a ? '<label class="muted" style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="wl-msg-art"> lié à « ' + esc(a.titre.slice(0, 60)) + ' »</label>' : '') +
      '<span style="flex:1"></span><button class="btn go" data-act="send-msg">Envoyer</button></div></div>';
  }
  // Classeur : tiroir replié sur le bord droit (poignée), ouvert par-dessus le fil sans rien pousser ; plein écran sur mobile.
  function classeurBody(fichiers) {
    fichiers = fichiers || D().messages.filter(function (m) { return m.fichier; });
    var fc = S.filtreCat || '';
    if (!fichiers.length) return '<p class="muted">Aucun fichier pour l’instant. Les pièces jointes envoyées dans l’interphone (factures, documents, images…) se rangent ici par catégorie.</p>';
    var l = fichiers.filter(function (m) { return !fc || m.fichier.categorie === fc; }).slice().reverse();
    return '<div class="clsr-cats"><span class="chip' + (fc ? '' : ' art') + '" data-act="filtre-cat" data-id="">Tout (' + fichiers.length + ')</span>' +
      CATS.map(function (c) { var n = fichiers.filter(function (m) { return m.fichier.categorie === c[0]; }).length; return n ? '<span class="chip' + (fc === c[0] ? ' art' : '') + '" data-act="filtre-cat" data-id="' + c[0] + '">' + c[1] + ' (' + n + ')</span>' : ''; }).join('') + '</div>' +
      (l.map(function (m) { return '<div style="margin-top:12px"><span class="muted">' + esc(m.nom) + ' · ' + esc(when(m.le)) + '</span>' + fichierHTML(m.fichier) + '</div>'; }).join('') || '<p class="muted">Rien dans cette catégorie.</p>');
  }
  function classeurHTML(fichiers) {
    var o = S.clsr ? ' open' : '';
    return '<button type="button" class="clsr-h' + o + '" data-act="clsr" aria-label="Ouvrir le classeur"><span class="ic">🗂️</span><span class="lb">Classeur</span>' + (fichiers.length ? '<span class="n">' + fichiers.length + '</span>' : '') + '</button>' +
      '<div class="clsr-bg' + o + '" data-act="clsr"></div><aside class="clsr' + o + '" aria-label="Classeur"><div class="clsr-top"><b>🗂️ Classeur</b><span class="x" data-act="clsr" role="button" aria-label="Fermer">✕</span></div><div class="clsr-body">' + classeurBody(fichiers) + '</div></aside>';
  }
  function majClasseur() {
    var r = S.root; if (!r) return;
    ['.clsr', '.clsr-bg', '.clsr-h'].forEach(function (q) { var e = r.querySelector(q); if (e) e.classList.toggle('open', !!S.clsr); });
    var b = r.querySelector('.clsr-body'); if (b) b.innerHTML = classeurBody();
  }
  // Dictée (Interphone) : reconnaissance vocale du navigateur (Chrome, Edge, Safari macOS/iOS), en français.
  // Le texte s'écrit dans le champ au fil de la voix ; on relit, puis Entrée ou « Envoyer ». Rien ne part tout seul.
  S.miseEnForme = false;
  var SR = window.SpeechRecognition || window.webkitSpeechRecognition || null;
  function majMic() {
    var b = S.root && S.root.querySelector('[data-act="dicter"]'); if (b) { b.classList.toggle('on', !!S.dicte); b.textContent = S.dicte ? '⏹️ Arrêter' : '🎙️ Dicter'; }
    var ta = S.root && S.root.querySelector('#wl-msg'); if (ta) ta.placeholder = S.dicte ? '🎙️ Je vous écoute…' : 'Votre message…';
  }
  // Pendant la mise en forme (Claude Haiku : ponctuation, majuscules, mots mal reconnus), le champ est grisé et verrouillé ;
  // en cas d'échec, le texte brut reste tel quel. Moteur de dictée commun aux deux labs : shared/lab-core.js (PHLab.dictee).
  function verrou(on) {
    S.miseEnForme = on;
    var el = S.root && S.root.querySelector('#wl-msg'), b = S.root && S.root.querySelector('[data-act="send-msg"]'), m = S.root && S.root.querySelector('[data-act="dicter"]');
    if (el) { el.disabled = on; el.classList.toggle('wl-mef', on); }
    if (b) b.disabled = on; if (m) m.disabled = on;
  }
  // (repli si un ancien lab-core.js est encore en cache quelques minutes : pas de dictée plutôt qu'une page cassée)
  var DICTEE = !PHL.dictee ? { dispo: false, demarrer: function () {}, arreter: function () {}, actif: function () { return false; } } : PHL.dictee({
    champ: function () { return S.root && S.root.querySelector('#wl-msg'); },
    lang: function () { return LS.get('wl-dictee-lang') || 'fr-FR'; },
    brouillon: function (t) { S.msgDraft = t; },
    etat: function (on) { S.dicte = on; majMic(); },
    verrou: verrou,
    toast: function (t, bad) { toast(t, bad); },
    formaterActif: function () { return LS.get('wl-mef') !== '0'; },
    miseEnForme: function (dit) { return pushApi({ action: 'dictee', texte: dit }).then(function (r) { return r && r.ok ? r.texte : ''; }); }
  });
  function startDictee() { DICTEE.demarrer(); }
  function stopDictee() { DICTEE.arreter(); }
  function pjZone() {
    if (!S.pj) return '';
    return '<div class="box" style="margin-top:8px;display:flex;gap:10px;align-items:center;flex-wrap:wrap"><span>📎 <b>' + esc(S.pj.nom) + '</b> <span class="muted">' + taille(S.pj.taille) + '</span></span>' +
      '<select class="in" id="wl-pj-cat" style="width:auto;flex:0 0 auto">' + CATS.map(function (c) { return '<option value="' + c[0] + '"' + (S.pj.categorie === c[0] ? ' selected' : '') + '>' + c[1] + '</option>'; }).join('') + '</select>' +
      '<button class="btn small" data-act="pj-retirer" type="button">✕ Retirer</button></div>';
  }
  function devinerCat(f) {
    var n = (f.name || '').toLowerCase();
    if (/factur|invoice|re[cç]u|receipt|note.?de.?frais/.test(n)) return 'factures';
    if (/contrat|contract|devis/.test(n)) return 'contrats';
    if (/^image\//.test(f.type)) return 'images';
    if (/pdf|word|document|text/.test(f.type)) return 'documents';
    return 'autres';
  }
  function majPj() { var z = S.root.querySelector('#wl-pj-zone'); if (z) z.innerHTML = pjZone(); }


  // ---------- panneaux (le bureau de chaque employé) ----------
  function openPanel(key) { masquerTip(); S.panel = key; if (DECISIONS[key] && DECISIONS[key].ouvrir) DECISIONS[key].ouvrir(); if (key === 'marbre') chargerMarbre(); paintPanel(); var r = S.root; r.querySelector('.panel').classList.add('open'); r.querySelector('.panelbg').classList.add('open'); r.querySelector('.panel').scrollTop = 0; }
  function closePanel() { S.dosFocus = null; S.panel = null; S.reformule = null; S.root.querySelector('.panel').classList.remove('open'); S.root.querySelector('.panelbg').classList.remove('open'); }
  function head(emoji, nom, st) { return '<div class="ph2"><span class="em">' + emoji + '</span><div><div class="nm">' + esc(nom) + '</div><div class="st">' + (st || '') + '</div></div><span class="x" data-act="close-panel">✕</span></div>'; }
  function paintPanel() {
    if (!S.panel || !S.root) return;
    var el = S.root.querySelector('.panel');
    var keep = el.scrollTop, ae = document.activeElement;
    if (ae && el.contains(ae) && (ae.tagName === 'TEXTAREA' || ae.tagName === 'INPUT' || ae.isContentEditable)) return; // on ne repeint pas sous les doigts de la journaliste
    var k = S.panel, h = '';
    if (k === 'secretaire') h = panelSecretaire();
    else if (k === 'assistant') h = panelAssistant();
    else if (k === 'courrier') h = panelCourrier();
    else if (k === 'marbre') h = panelMarbre();
    else if (k === 'articles') h = panelArticles();
    else if (DECISIONS[k]) h = DECISIONS[k].panel();
    else if (k === 'chef') h = panelChef();
    else if (k === 'sc' || k === 'mk') h = panelJulien(k);
    else if (k === 'compta') h = panelCompta();
    else if (k === 'parametres') h = panelParams();
    else if (k.indexOf('j:') === 0) h = panelJournaliste(k.slice(2));
    else if (catPoste(k)) h = panelPosteCatalogue(k);
    if (TEL_POSTES[k] && telPeut(k)) h = h.replace('<span class="x" data-act="close-panel">', telBouton(k) + '<span class="x" data-act="close-panel">'); // ☎️ du poste
    el.innerHTML = h; el.scrollTop = keep; markBusy();
  }
  function mcard(m) {
    var t = m.statut === 'répondu' ? ['✅', 'répondu', 'g'] : m.brouillon_corps ? ['🟠', 'réponse à valider', 'a'] : m.categorie === 'demande' ? ['📩', 'demande', 'g'] : ['❔', 'à vérifier', ''];
    var bxc = boiteLab(m.boite);
    return '<div class="dcard ' + t[2] + '" data-act="open-mail" data-id="' + esc(m.mail_id) + '"><div class="k">' + t[0] + ' ' + t[1] + (m.abonne === 'oui' ? ' · abonné' : m.abonne === 'gratuit' ? ' · membre gratuit' : '') + (bxc ? ' · ✉️ ' + esc(bxc.adresse) : '') + '</div>' +
      '<div class="ti">' + esc(m.sujet || '(sans objet)') + '</div><div class="su">' + esc(m.de_nom) + ' · ' + esc(when(m.recu_le)) + '</div></div>';
  }
  function panelJulien(k) {
    var J = JULIEN[k], ms = mailsBureau(k), faits = mailsBureau(k, true).filter(function (m) { return m.statut === 'répondu'; }).slice(0, 8);
    var dem = ms.filter(function (m) { return m.categorie === 'demande'; }), ver = ms.filter(function (m) { return m.categorie !== 'demande'; });
    var h = head(J.emoji, J.nom, esc(adressesBureau(k).join(' · ')) + (S.busy[k] ? ' · ' + esc(S.busy[k]) + '…' : ''));
    h += '<div class="pb">' + (D().me.chef ? '' : lectureSeule('les bureaux de Julien sont pilotés par le rédacteur en chef')) + '<p class="muted">Le Courrier trie seul les mails qui arrivent (sans IA) : notifications, newsletters et réponses automatiques sont écartées. Julien ne rédige une réponse que quand vous le lui demandez, et rien ne part sans votre validation.</p>';
    h += '<h4>📩 Demandes (' + dem.length + ')</h4><div class="dos">' + (dem.map(mcard).join('') || '<div class="muted">Aucune demande en attente.</div>') + '</div>';
    h += '<h4 style="margin-top:16px">❔ À vérifier (' + ver.length + ')</h4><div class="dos">' + (ver.map(mcard).join('') || '<div class="muted">Rien à vérifier.</div>') + '</div>';
    if (faits.length) h += '<h4 style="margin-top:16px">✅ Répondu récemment</h4><div class="dos">' + faits.map(mcard).join('') + '</div>';
    if (k === 'mk') h += prospection();
    return h + '</div>';
  }
  // ---------- Prospection (bureau Marketing) ----------
  var OFFRES = [['article', '📰 Article de partenariat'], ['newsletter', '✉️ Encart newsletter'], ['video', '🎬 Vidéo'], ['pack', '📦 Pack visibilité'], ['abonnements', '👥 Abonnements équipes'], ['tv', '📺 Posthumain TV']];
  var PST = { a_contacter: ['🔎', 'à contacter', ''], brouillon: ['🟠', 'mail à valider', 'a'], contacte: ['📨', 'contacté', ''], relance: ['🔁', 'relancé', ''], repondu: ['💬', 'a répondu', 'g'], client: ['🤝', 'client', 'g'], refus: ['⛔', 'ne plus contacter', ''] };
  function offreNom(o) { var f = OFFRES.filter(function (x) { return x[0] === o; })[0]; return f ? f[1] : o; }
  function pcard(x) {
    var t = PST[x.statut] || ['•', x.statut, ''];
    return '<div class="dcard ' + t[2] + '" data-act="open-prospect" data-id="' + esc(x.prospect_id) + '"><div class="k">' + t[0] + ' ' + esc(t[1]) + (x.email ? '' : ' · adresse à trouver') + '</div>' +
      '<div class="ti">' + esc(x.entreprise) + '</div><div class="su">' + esc([x.contact_nom, x.secteur, x.pays].filter(Boolean).join(' · ')) + '</div></div>';
  }
  function prospection() {
    var cs = D().campagnes || [], ps = D().prospects || [], busy = !!S.busy.mk;
    var h = '<h3 style="margin-top:22px">🎯 Prospection</h3><p class="muted">Julien cherche des entreprises qui ont une vraie raison d’acheter l’une de nos offres, trouve la bonne personne et une adresse publiée officiellement (jamais devinée), puis rédige un mail court et personnalisé. Rien ne part sans votre « Valider et envoyer » ; une seule relance au plus, et un STOP retire l’adresse pour toujours.</p>';
    if (!D().me.chef) {}
    else if (S.newCamp) {
      var nc = S.newCamp;
      h += '<div class="box"><label class="f">Nom de la campagne</label><input class="in" data-nc="nom" value="' + esc(nc.nom) + '" placeholder="ex. Start-up IA romandes — automne">' +
        '<label class="f">Offres à vendre</label><div style="display:flex;flex-wrap:wrap;gap:6px 14px;margin:4px 0 6px">' + OFFRES.map(function (o) {
          return '<label class="muted" style="display:flex;gap:6px;align-items:center"><input type="checkbox" data-nco="' + o[0] + '"' + (nc.offres.indexOf(o[0]) >= 0 ? ' checked' : '') + '> ' + o[1] + '</label>'; }).join('') + '</div>' +
        '<label class="f">Cible</label><textarea class="in" data-nc="cible" rows="3" placeholder="ex. start-up et PME tech qui lancent un produit IA grand public, écoles d’ingénieurs, agences de communication…">' + esc(nc.cible) + '</textarea>' +
        '<label class="f">Zone</label><input class="in" data-nc="zone" value="' + esc(nc.zone) + '" placeholder="Suisse romande, France, Belgique">' +
        '<div class="row" style="margin-top:10px"><button class="btn go" data-act="camp-create">✅ Créer la campagne</button><button class="btn small" data-act="camp-cancel">Annuler</button></div></div>';
    } else h += '<div class="row"><button class="btn" data-act="camp-new">＋ Nouvelle campagne</button></div>';
    if (!cs.length && !S.newCamp) h += '<p class="muted">Aucune campagne pour l’instant.</p>';
    cs.forEach(function (c) {
      var l = ps.filter(function (x) { return x.campagne_id === c.campagne_id; });
      var n = function (st) { return l.filter(function (x) { return x.statut === st; }).length; };
      var open = S.campOpen === c.campagne_id || cs.length === 1;
      h += '<div class="box" style="margin-top:12px"><div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start;cursor:pointer" data-act="camp-toggle" data-id="' + esc(c.campagne_id) + '"><div><b>' + esc(c.nom) + '</b><div class="muted">' + c.offres.map(offreNom).map(esc).join(' · ') + (c.zone ? ' — ' + esc(c.zone) : '') + '</div></div>' +
        '<div class="muted" style="white-space:nowrap">' + l.length + ' prospect' + pl(l.length) + (n('repondu') ? ' · 💬 ' + n('repondu') : '') + (n('client') ? ' · 🤝 ' + n('client') : '') + '</div></div>';
      if (open) {
        if (c.cible) h += '<div class="muted" style="margin-top:6px">Cible : ' + esc(c.cible) + '</div>';
        if (D().me.chef) h += '<div class="row" style="margin-top:10px"><button class="btn" data-act="p-chercher" data-id="' + esc(c.campagne_id) + '"' + (busy ? ' disabled' : '') + '>🔎 Chercher des prospects</button></div><p class="muted">La recherche prend une à deux minutes : Julien vérifie chaque entreprise sur le web.</p>';
        ['repondu', 'brouillon', 'a_contacter', 'contacte', 'relance', 'client', 'refus'].forEach(function (st) {
          var g = l.filter(function (x) { return x.statut === st; }); if (!g.length) return;
          h += '<h4 style="margin-top:12px">' + PST[st][0] + ' ' + esc(PST[st][1]) + ' (' + g.length + ')</h4><div class="dos">' + g.map(pcard).join('') + '</div>';
        });
      }
      h += '</div>';
    });
    return h;
  }
  function docProspect(x) {
    var c = campagne(x.campagne_id), busy = !!S.busy.mk, t = PST[x.statut] || ['•', x.statut];
    var ed = (S.pEdit && S.pEdit[x.prospect_id]) || { sujet: x.mail_sujet || '', corps: x.mail_corps || '', email: x.email || '' };
    var h = '<div class="dtop"><span class="em">🎯</span><div><div class="nm">' + esc(x.entreprise) + '</div><div class="st">' + t[0] + ' ' + esc(t[1]) + (c ? ' · ' + esc(c.nom) : '') + '</div></div><span class="x" data-act="close-doc">✕</span></div>';
    h += '<div class="paper"><div class="kick">Prospect · ' + esc([x.secteur, x.pays].filter(Boolean).join(' · ')) + '</div>' +
      '<div class="meta">' + (x.site ? '🌐 <a href="' + esc(/^https?:/.test(x.site) ? x.site : 'https://' + x.site) + '" target="_blank" rel="noopener" data-stop="1">' + esc(x.site) + '</a><br>' : '') +
      '👤 ' + esc([x.contact_nom, x.contact_role].filter(Boolean).join(', ') || 'contact à préciser') + '<br>' +
      '✉️ ' + (x.email ? esc(x.email) + (x.source_email ? ' · <a href="' + url(x.source_email) + '" target="_blank" rel="noopener" data-stop="1">où elle est publiée</a>' : '') : 'aucune adresse publiée trouvée : saisissez-en une si vous la connaissez') + '</div>' +
      (x.pourquoi ? '<div style="border-left:3px solid #d8cfbd;padding:6px 12px;margin:10px 0 14px"><b>Pourquoi maintenant :</b> ' + esc(x.pourquoi) + '</div>' : '');
    if (x.envoye_le) h += '<p class="muted">Premier mail envoyé ' + esc(when(x.envoye_le)) + (x.relance_le ? ' · relancé ' + esc(when(x.relance_le)) : '') + '.</p>';
    if (x.statut === 'refus') return h + '<div class="lead">⛔ Ce prospect ne sera plus contacté.</div></div>';
    if (!D().me.chef) return h + (x.mail_corps ? '<label>Mail</label><div><b>' + esc(x.mail_sujet) + '</b></div><div style="white-space:pre-wrap">' + esc(x.mail_corps) + '</div>' : '') + lectureSeule('') + '</div>';
    var fini = x.statut === 'client' || x.statut === 'relance' || x.statut === 'repondu';
    var relance = x.statut === 'contacte';
    if (!fini) {
      h += '<label>Consigne pour Julien (facultatif)</label><input class="pin" id="wl-p-consigne" placeholder="ex. insister sur la vidéo, mentionner leur levée de fonds, ton plus formel…">' +
        '<div class="acts"><button data-act="p-rediger" data-id="' + esc(x.prospect_id) + '"' + (busy ? ' disabled' : '') + '>🤖 ' + (relance ? 'Rédiger la relance' : ed.corps ? 'Autre proposition' : 'Rédiger le mail') + '</button></div>' +
        '<label>Adresse</label><input class="pin" id="wl-p-email" value="' + esc(ed.email) + '" inputmode="email" autocomplete="off">' +
        '<label>Objet</label><input class="pin sub" id="wl-p-sujet" value="' + esc(ed.sujet) + '">' +
        '<label>Message</label><textarea class="pin big" id="wl-p-corps" placeholder="Demandez une proposition à Julien ou écrivez le mail.">' + esc(ed.corps) + '</textarea>' +
        '<div class="acts"><button class="go" data-act="p-envoyer" data-id="' + esc(x.prospect_id) + '"' + (busy ? ' disabled' : '') + '>✅ Valider et envoyer' + (relance ? ' la relance' : '') + '</button>' +
        '<button data-act="p-garder" data-id="' + esc(x.prospect_id) + '">💾 Garder</button></div>';
    } else if (x.mail_corps) h += '<label>Dernier mail</label><div><b>' + esc(x.mail_sujet) + '</b></div><div style="white-space:pre-wrap">' + esc(x.mail_corps) + '</div>';
    h += '<div class="acts">' + (x.statut !== 'client' ? '<button data-act="p-statut" data-st="client" data-id="' + esc(x.prospect_id) + '">🤝 Devenu client</button>' : '') +
      (x.statut === 'contacte' || x.statut === 'relance' ? '<button data-act="p-statut" data-st="repondu" data-id="' + esc(x.prospect_id) + '">💬 A répondu</button>' : '') +
      '<button class="red" data-act="p-stop" data-id="' + esc(x.prospect_id) + '">⛔ Ne plus contacter</button></div>' +
      '<p class="lead">Le mail part de redaction@posthumain.com, signé Julien, avec la ligne « répondez STOP ». Les réponses arrivent dans ce bureau et ce prospect passe tout seul en « a répondu ».</p>';
    var hi = (x.historique || []).slice().reverse().slice(0, 8);
    if (hi.length) h += '<label>Historique</label><div class="muted">' + hi.map(function (e) { return esc(when(e.t)) + ' — ' + histTxt(e.e); }).join('<br>') + '</div>';
    return h + '</div>';
  }
  function docMail(m) {
    var bk = bureauDe(m.boite) || 'mk', J = JULIEN[bk], bxm = boiteLab(m.boite), adrM = bxm ? bxm.adresse : J.adr;
    var ed = (S.mEdit && S.mEdit[m.mail_id]) || { sujet: m.brouillon_sujet || ('Re: ' + (m.sujet || '')), corps: m.brouillon_corps || '' };
    var fait = m.statut === 'répondu', busy = !!S.busy[bk];
    var h = '<div class="dtop"><span class="em">' + J.emoji + '</span><div><div class="nm">' + esc(m.sujet || '(sans objet)') + '</div><div class="st">' + esc(J.nom) + ' · ' + esc(adrM) + ' · reçu ' + esc(when(m.recu_le)) + '</div></div><span class="x" data-act="close-doc">✕</span></div>';
    h += '<div class="paper"><div class="kick">' + (m.categorie === 'demande' ? 'Demande' : 'À vérifier') + ' · ' + esc(m.motif || '') + '</div>' +
      '<div class="meta">De : <b>' + esc(m.de_nom) + '</b> &lt;' + esc(m.de_email) + '&gt;' + (m.abonne === 'oui' ? ' <span class="tag g">abonné payant</span>' : m.abonne === 'gratuit' ? ' <span class="tag">membre gratuit</span>' : '') + '</div>' +
      '<div style="white-space:pre-wrap;border-left:3px solid #d8cfbd;padding:6px 12px;margin:10px 0 18px;max-height:340px;overflow:auto">' + esc(m.texte || '(message vide)') + '</div>' + piecesHTML(m.pieces) +
      (m.membre_id ? '<div class="acts" style="margin-top:0"><a class="btn" href="https://the-last-journal.ghost.io/ghost/#/members/' + esc(m.membre_id) + '" target="_blank" rel="noopener" data-stop="1" style="text-decoration:none">👤 Ouvrir le membre dans Ghost</a></div>' : '<p class="muted" style="margin:0 0 12px">Aucun compte Posthumain à cette adresse.</p>');
    if (fait) return h + '<div class="lead">✅ Réponse envoyée ' + esc(when(m.envoye_le)) + '.</div><label>Objet</label><div>' + esc(m.brouillon_sujet) + '</div><label>Message</label><div style="white-space:pre-wrap">' + esc(m.brouillon_corps) + '</div></div>';
    if (!D().me.chef) return h + lectureSeule('') + '</div>';
    h += '<label>Consigne pour Julien (facultatif)</label><input class="pin" id="wl-m-consigne" placeholder="ex. proposer de résilier pour lui, ton plus chaleureux…">' +
      '<div class="acts"><button data-act="m-propose" data-id="' + esc(m.mail_id) + '"' + (busy ? ' disabled' : '') + '>🤖 ' + (ed.corps ? 'Autre proposition' : 'Proposer une réponse') + '</button></div>' +
      '<label>Objet</label><input class="pin sub" id="wl-m-sujet" value="' + esc(ed.sujet) + '">' +
      '<label>Réponse</label><textarea class="pin big" id="wl-m-corps" placeholder="Écrivez la réponse ou demandez une proposition à Julien.">' + esc(ed.corps) + '</textarea>' + pjWidget('m:' + m.mail_id) +
      '<div class="acts"><button class="go" data-act="m-send" data-id="' + esc(m.mail_id) + '"' + (busy ? ' disabled' : '') + '>✅ Valider et envoyer</button>' +
      '<button data-act="m-save" data-id="' + esc(m.mail_id) + '">💾 Garder</button>' +
      (m.categorie !== 'demande' ? '<button data-act="m-demande" data-id="' + esc(m.mail_id) + '">📩 C’est une vraie demande</button>' : '') +
      '<button class="red" data-act="m-archive" data-id="' + esc(m.mail_id) + '">🗄️ Archiver</button></div>' +
      '<p class="lead">La réponse part de ' + esc(bxm && bxm.nom_affiche ? bxm.nom_affiche + ' <' + adrM + '>' : adrM) + ', seulement quand vous cliquez sur « Valider et envoyer ».</p></div>';
    return h;
  }
  function artBox() {
    var a = art(S.art);
    return a ? '<div class="box"><div class="muted">Article en cours</div><b>' + esc(a.titre) + '</b><div class="row" style="margin-top:8px"><button class="btn small" data-act="articles">Changer</button><a class="btn small" href="' + esc(a.editeur) + '" target="_blank" rel="noopener">Ouvrir dans Ghost</a></div></div>'
      : '<div class="box warn">Choisissez d’abord l’article sur lequel vous travaillez.<div style="margin-top:8px"><button class="btn amber" data-act="articles">📰 Choisir un article</button></div></div>';
  }
  function contactForm(prefix, c) {
    c = c || {};
    return '<div class="two"><div><label class="f">Nom</label><input class="in" data-' + prefix + '="nom" value="' + esc(c.nom) + '" autocomplete="off"></div>' +
      '<div><label class="f">Adresse e-mail</label><input class="in" type="email" data-' + prefix + '="email" value="' + esc(c.email) + '" autocomplete="off" inputmode="email"></div></div>' +
      '<div class="two"><div><label class="f">Fonction</label><input class="in" data-' + prefix + '="role" value="' + esc(c.role) + '"></div>' +
      '<div><label class="f">Institution</label><input class="in" data-' + prefix + '="institution" value="' + esc(c.institution) + '"></div></div>' +
      '<label class="f">Langue du mail</label><select class="in" data-' + prefix + '="langue"><option value="fr"' + (c.langue !== 'en' ? ' selected' : '') + '>Français</option><option value="en"' + (c.langue === 'en' ? ' selected' : '') + '>Anglais</option></select>';
  }
  function panelAssistant() {
    var p = P('assistant'), o = stOf(p), h = head('🧠', 'L’Assistant', '<span class="led ' + o.s + '"></span>' + esc(o.why));
    h += '<div class="pb"><p class="muted">Il lit l’article en cours, vous propose qui interroger et quelles questions poser. Vous gardez, faites reformuler ou retirez chaque question, puis il passe le tout à la Secrétaire.</p>' + artBox();
    if (!S.art) return h + '</div>';
    var busy = !!S.busy.assistant;
    var deja = D().fiches.filter(function (f) { return f.article_id === S.art; });
    if (deja.length) h += '<div class="box" style="border-color:rgba(255,190,90,.45)"><b>Déjà lancé pour cet article : ' + deja.length + ' demande' + pl(deja.length) + '</b> (' + origines(deja) + ')<div style="margin:6px 0">' + avancement(deja) + '</div><div class="muted">' + esc(deja.map(function (f) { return f.contact.nom + ' (' + qui(f) + ')'; }).join(' · ')) + '</div>' +
      '<div class="row" style="margin-top:8px"><button class="btn small" data-act="dossier" data-id="' + esc(S.art) + '">🗂️ Voir le dossier</button></div><p class="muted" style="margin:8px 0 0">Vous pouvez quand même ajouter une personne ci-dessous.</p></div>';
    h += '<h3>1 · Qui interroger ?</h3>';
    if (S.contact) h += dejaHTML(dejaContacte(S.contact.email), true) + '<div class="box">' + contactForm('c', S.contact) + '<div class="row" style="margin-top:10px"><button class="btn small" data-act="contact-clear">Changer de personne</button></div></div>';
    else h += '<div class="row"><button class="btn" data-act="find-contacts"' + (busy ? ' disabled' : '') + '>🔎 Trouver les chercheurs de l’article</button><button class="btn small" data-act="contact-new">＋ Saisir un contact</button></div><p class="muted">La recherche prend une trentaine de secondes : l’Assistant vérifie sur le web qui a mené les travaux cités, et ne donne une adresse que si elle est publiée officiellement.</p>';
    if (S.contacts && S.contacts.length && !S.contact) {
      h += S.contacts.map(function (c, i) {
        return '<div class="ct"><b>' + nomLien(c.nom, c.profil_url, c.institution) + '</b> <span class="tag">' + esc(c.langue === 'en' ? 'anglais' : 'français') + '</span><div class="w">' + esc([c.role, c.institution].filter(Boolean).join(', ')) + '</div>' +
          '<div class="w">' + esc(c.pourquoi || '') + '</div>' +
          '<div class="w">' + (c.email ? '✉️ ' + esc(c.email) + sourceAdresse(c.source_email) : '✉️ adresse non publiée · ' + esc(c.ou_trouver || '')) + '</div>' +
          (function (dj) { return dj.length ? '<div class="w" style="color:#ffd27a">⚠️ Déjà contacté ' + (dj[0].envoye_le ? 'le ' + esc(day(dj[0].envoye_le)) : '(mail non envoyé)') + ' pour « ' + esc(dj[0].article_titre || 'sans article') + ' »' + (dj.length > 1 ? ' et ' + (dj.length - 1) + ' autre' + pl(dj.length - 1) : '') + '</div>' : ''; })(dejaContacte(c.email)) +
          '<div class="row" style="margin-top:8px"><button class="btn small go" data-act="contact-pick" data-i="' + i + '">Choisir</button></div></div>';
      }).join('');
    }
    h += '<h3>2 · Les questions</h3><label class="f">Angle ou ce que vous voulez obtenir (facultatif)</label><input class="in" data-s="angle" value="' + esc(S.angle) + '" placeholder="ex. ce que ça change concrètement pour les patients">' +
      '<div class="row" style="margin-top:10px"><button class="btn" data-act="propose-q"' + (busy ? ' disabled' : '') + '>💡 Proposer des questions</button><button class="btn small" data-act="q-add">＋ Ma question</button></div>';
    h += '<div style="margin-top:10px">' + S.qs.map(function (q, i) {
      var r = S.reformule === i;
      return '<div class="q' + (q.garde ? ' keep' : '') + '"><textarea class="in" data-qi="' + i + '" rows="2">' + esc(q.q) + '</textarea>' + (q.pourquoi ? '<div class="why">' + esc(q.pourquoi) + '</div>' : '') +
        '<div class="row"><button class="btn small ' + (q.garde ? 'go' : '') + '" data-act="q-keep" data-i="' + i + '">' + (q.garde ? '✓ Gardée' : 'Garder') + '</button>' +
        '<button class="btn small" data-act="q-ref" data-i="' + i + '"' + (busy ? ' disabled' : '') + '>↻ Reformuler</button><button class="btn small red" data-act="q-del" data-i="' + i + '">✕</button></div>' +
        (r ? '<div style="margin-top:8px"><input class="in" id="wl-ref" placeholder="Comment ? (ex. plus simple, plus concret, en anglais…)"><div class="row" style="margin-top:6px"><button class="btn small go" data-act="q-ref-go" data-i="' + i + '">Reformuler</button><button class="btn small" data-act="q-ref-x">Annuler</button></div></div>' : '') + '</div>';
    }).join('') + '</div>';
    var kept = S.qs.filter(function (q) { return q.garde && String(q.q).trim(); }).length;
    var ok = S.contact && String(S.contact.nom || '').trim() && kept;
    h += '<h3>3 · Passer à la Secrétaire</h3><label class="f">Échéance à indiquer (facultatif)</label><input class="in" data-s="echeance" value="' + esc(S.echeance) + '" placeholder="ex. avant jeudi 18 h">' +
      '<label class="f">Un mot pour la Secrétaire (facultatif)</label><input class="in" data-s="consigneSec" value="' + esc(S.consigneSec) + '" placeholder="ex. rappeler qu’on a déjà cité son étude">' +
      '<div style="margin-top:12px">' + pubWrap('sec', '<button class="btn go" data-act="to-secretaire"' + (ok && !S.busy.secretaire ? '' : ' disabled') + '>📮 Envoyer à la Secrétaire (' + kept + ' question' + pl(kept) + ')</button>') + '</div>' +
      (ok ? '' : '<p class="muted">Il faut un contact (au moins son nom) et au moins une question gardée.</p>') + '<p class="muted">La Secrétaire rédige le mail ; il ne partira qu’après votre relecture et votre clic sur « Valider et envoyer ».</p></div>';
    return h;
  }
  function panelSecretaire() {
    var p = P('secretaire'), o = stOf(p), me = D().me;
    var h = head('📮', 'La Secrétaire', '<span class="led ' + o.s + '"></span>' + esc(o.why));
    h += '<div class="pb"><p class="muted">Elle rédige vos mails, vous les fait relire, puis les envoie depuis votre adresse Posthumain. Rien ne part sans votre validation.</p>';
    if (!me.branchee) h += '<div class="box warn">Votre boîte mail n’est pas encore branchée au Writinglab : vous pouvez préparer et relire vos mails, l’envoi sera possible dès qu’elle le sera.</div>';
    var v = by('brouillon'), actifs = vues().filter(function (f) { return f.statut !== 'inséré'; }), ds = dossiers(actifs), rp = relancesPretes();
    if (rp.length) h += '<h3>⏰ Relances prêtes (' + rp.length + ')</h3><p class="muted">Ces chercheurs n’ont pas répondu : une relance est prête, dans le même fil que le premier mail. Ouvrez la fiche pour la relire et l’envoyer.</p><div class="dos">' + rp.map(function (f) { return dcard(f, '<div class="su">envoyé ' + esc(when(f.envoye_le)) + '</div>'); }).join('') + '</div>';
    S.dosOuvert = S.dosOuvert || {};
    h += '<h3>Dossiers en cours (' + ds.length + ') · ' + v.length + ' mail' + pl(v.length) + ' à valider</h3>' + porteeHTML() +
      (ds.length > 1 ? '<div class="row" style="gap:6px;margin:-4px 0 8px"><span class="chip" data-act="dos-tout" data-id="1">▾ Tout déplier</span><span class="chip" data-act="dos-tout" data-id="0">▸ Tout replier</span></div>' : '') +
      (ds.map(function (d) {
        var k = d.id || 'sans', nb = d.fiches.filter(function (f) { return f.statut === 'brouillon'; }).length;
        var ouvert = S.dosFocus ? S.dosFocus === k : (k in S.dosOuvert ? S.dosOuvert[k] : nb > 0);
        var tri = d.fiches.slice().sort(function (a, b) { return (a.statut === 'brouillon' ? 0 : 1) - (b.statut === 'brouillon' ? 0 : 1); });
        return '<div class="dossier' + (ouvert ? ' open' : '') + (S.dosFocus === k ? ' flash' : '') + '" id="sdos-' + esc(k) + '"><div class="dh" data-act="dos-toggle" data-id="' + esc(k) + '"><b>' + (ouvert ? '▾' : '▸') + ' 📰 ' + esc(d.titre) + '</b>' + avancement(d.fiches) + '</div>' +
          (ouvert ? '<div class="dos">' + tri.map(function (f) { return dcard(f, f.statut === 'brouillon' ? '<div class="su">✉️ ' + esc(f.mail_sujet) + '</div>' : ''); }).join('') + '</div>' + (d.id && art(d.id) ? '<div class="row" style="margin-top:6px"><button class="btn small" data-act="pick-art" data-id="' + esc(d.id) + '">📰 En faire l’article en cours</button></div>' : '') : '') + '</div>';
      }).join('') || '<div class="muted">Aucun dossier en cours.</div>');
    h += '<h3>Écrire à quelqu’un</h3><p class="muted">Pour une demande directe (sans passer par l’Assistant) : dites ce que vous voulez, elle rédige.</p>' + contactForm('l', S.libre) + '<div id="wl-deja-l">' + dejaHTML(dejaContacte(S.libre && S.libre.email), true) + '</div>' +
      '<label class="f">Ce que vous voulez lui dire ou lui demander</label><textarea class="in" data-l="consigne" rows="4" placeholder="ex. lui demander s’il accepterait un appel de 15 minutes cette semaine sur son étude">' + esc(S.libre.consigne) + '</textarea>' +
      '<label class="f">Échéance (facultatif)</label><input class="in" data-l="echeance" value="' + esc(S.libre.echeance) + '">' +
      '<label class="muted" style="display:flex;gap:6px;align-items:center;margin-top:10px"><input type="checkbox" id="wl-libre-art"' + (S.art ? ' checked' : ' disabled') + '> lier à l’article en cours</label>' +
      '<div style="margin-top:12px">' + pubWrap('libre', '<button class="btn go" data-act="libre"' + (S.busy.secretaire ? ' disabled' : '') + '>✍️ Rédiger le mail</button>') + '</div></div>';
    return h;
  }
  function panelCourrier() {
    var p = P('courrier'), o = stOf(p);
    var h = head('📬', 'Le Courrier', '<span class="led ' + o.s + '"></span>' + esc(o.why));
    h += '<div class="pb"><p class="muted">Il surveille les quatre boîtes en continu et range chaque réponse dans la bonne fiche dès qu’elle arrive. Il repère aussi les adresses refusées.</p><button class="btn" data-act="relever">↻ Actualiser</button>' +
      '<div class="qbox"><input class="in" id="wl-qc" type="search" value="' + esc(S.qCour || '') + '" placeholder="Chercher un chercheur, une institution, un article…" autocomplete="off" enterkeyhint="search"></div>';
    return h + '<div id="wl-cour-res">' + courrierRes() + '</div></div>';
  }
  function courrierRes() {
    var l = vues().filter(function (f) { return cherche(f, S.qCour); }), st = function (x) { return l.filter(function (f) { return f.statut === x; }); };
    var r = st('a répondu'), e = st('envoyé'), c = st('inséré'), rb = l.filter(estRebond), h = '';
    if (String(S.qCour || '').trim()) h += '<p class="muted">' + l.length + ' fiche' + pl(l.length) + ' trouvée' + pl(l.length) + '</p>';
    h += '<h3>Réponses à traiter (' + r.length + ')</h3><div class="dos">' + (r.map(function (f) { return dcard(f, '<div class="su">reçue ' + esc(when(f.reponse_le)) + '</div>'); }).join('') || '<div class="muted">Pas de nouvelle réponse.</div>') + '</div>';
    if (rb.length) h += '<h3>✉️ Adresses invalides (' + rb.length + ')</h3><div class="dos">' + rb.map(function (f) { return dcard(f, '<div class="su">' + esc(f.rebond_motif || 'mail refusé par le serveur du destinataire') + (f.rebond_le ? ' · ' + esc(when(f.rebond_le)) : '') + '</div>'); }).join('') + '</div>';
    h += '<h3>En attente de réponse (' + e.length + ')</h3><div class="dos">' + (e.map(function (f) { return dcard(f, '<div class="su">' + esc(envoiTxt(f)) + (relancable(f) && !relancePrete(f) ? ' · <b>relance possible</b>' : '') + '</div>'); }).join('') || '<div class="muted">Rien en attente.</div>') + '</div>';
    if (c.length) h += '<h3>Déjà cités (' + c.length + ')</h3><div class="dos">' + c.slice(0, 8).map(function (f) { return dcard(f); }).join('') + '</div>';
    return h;
  }
  // ================= Salle des décisions (Radar, Marbre de l'Usine, Votes) — fonction Supabase wl-radar, zéro exécution n8n =================
  var RADAR_FN = 'https://jfmzhndapfmvdhphuwfm.supabase.co/functions/v1/wl-radar';
  function radarApi(body) {
    var a = body && body.action, k = ['approuver', 'ecarter_brouillon'].indexOf(a) >= 0 ? ['usine'] : ['ecarter', 'remettre'].indexOf(a) >= 0 ? ['radar', 'vote'] : ['choisir', 'decocher', 'ordre', 'imposer', 'relancer_radar'].indexOf(a) >= 0 ? ['radar'] : [];
    return actif(k, supa(RADAR_FN, body));
  }
  // Câbles du plan : une action en cours (le temps de l'appel) allume le fil correspondant, puis il s'éteint.
  function actif(cles, p) {
    if (!cles.length) return p;
    S.actif = S.actif || {}; cles.forEach(function (k) { S.actif[k] = (S.actif[k] || 0) + 1; }); paintFloor();
    var fin = function () { cles.forEach(function (k) { S.actif[k] = Math.max(0, (S.actif[k] || 0) - 1); }); paintFloor(); };
    return p.then(function (r) { fin(); return r; }, function (e) { fin(); throw e; });
  }
  var RD_TYPES = [['', 'type noté'], ['actu', 'Actu'], ['actu-premium', 'Actu-premium'], ['premium', 'Enquête premium']];
  function rdType(x) { return x.type === 'premium' ? ['💎', 'Enquête premium', 'b'] : x.actu_premium ? ['🔐', 'Actu-premium', 'a'] : ['📰', 'Actu', 'g']; }
  function chargerRadar() {
    if (S.radarLd) return S.radarLd;
    S.radarLd = radarApi({ action: 'radar' }).then(function (r) { S.radarLd = null; S.radar = r || { ok: false, why: 'réponse vide' }; if (S.panel === 'radar') paintPanel(); paintFloor(); }, function () { S.radarLd = null; });
    return S.radarLd;
  }
  function chargerMarbre() {
    if (S.marbreLd) return S.marbreLd;
    S.marbreLd = radarApi({ action: 'marbre' }).then(function (r) { S.marbreLd = null; S.marbre = r || { ok: false, why: 'réponse vide' }; if (S.panel === 'marbre') paintPanel(); paintFloor(); }, function () { S.marbreLd = null; });
    return S.marbreLd;
  }
  function rdSecret(why) {
    var w = String(why || '');
    if (/Airtable/i.test(w) && /absent/i.test(w)) return '<div class="cz-l" style="border-color:rgba(255,176,32,.5)">🔑 <b>Il manque le jeton Airtable dans Supabase.</b><div class="cz-s">Ajoutez le secret <b>AIRTABLE_TOKEN</b> (jeton personnel Airtable avec accès à la base Radar de l’Usine) dans Supabase PosthumanOS → Edge Functions → Secrets. La Salle du Radar et le bouton Approuver marchent dès qu’il est enregistré.</div></div>';
    if (/Ghost/i.test(w) && /absent/i.test(w)) return '<div class="cz-l" style="border-color:rgba(255,176,32,.5)">🔑 <b>Il manque la clé Admin Ghost dans Supabase</b> (secret GHOST_ADMIN_API_KEY).</div>';
    return '<p class="muted">⚠️ ' + esc(w || 'Impossible de joindre le Radar.') + '</p>';
  }
  function rdCarte(x, n, chef, enFile) {
    var t = rdType(x), lien = x.url && /^https?:\/\//i.test(x.url) && !x.vote ? '<a href="' + esc(x.url) + '" target="_blank" rel="noopener">source</a>' : '';
    var h = '<div class="cz-l rd-c' + (x.vote ? ' rd-vote' : '') + '"><div class="rd-h">' + (n ? '<span class="rd-n">' + n + '</span>' : '') + '<div style="flex:1"><div class="rd-t">' + esc(x.titre || '(sans titre)') + '</div>' +
      '<div class="cz-s">' + (x.vote ? '<span class="tag g">🗳️ Choisi par le public</span> <span class="tag b">enquête supplémentaire</span> ' : '') + '<span class="tag ' + t[2] + '">' + t[0] + ' ' + t[1] + '</span>' + (x.format && x.format !== 'actu' ? ' <span class="tag">' + esc(String(x.format).toUpperCase()) + '</span>' : '') +
      (x.score ? ' · score <b>' + x.score + '</b>' : '') + (x.source === 'EVERGREEN' ? ' · 💎 sujet de fond' : '') + (x.manuel ? ' · 🔒 hors IA' : '') + (lien ? ' · ' + lien : '') + (x.choisir && !enFile && !x.vote ? ' · <span class="tag g">✓ en file</span>' : '') + '</div></div></div>';
    if (x.angle) h += '<div class="rd-a">' + esc(x.angle) + '</div>';
    if (chef) {
      if (x.vote) h += '<div class="row" style="gap:6px;margin-top:8px">' + (x.statut === 'skipped' ? '<span class="cz-s">Écarté : il ne sera pas écrit.</span><button class="btn small" data-act="rd-remettre" data-id="' + esc(x.id) + '">↩️ Le remettre</button>' : '<span class="cz-s">Sans action de votre part, l’Usine l’écrit en plus du sujet du jour.</span><button class="btn small red" data-act="rd-ecarter" data-id="' + esc(x.id) + '">✖️ Ne pas l’écrire</button>') + '</div>';
      else if (enFile) h += '<div class="row" style="gap:6px;margin-top:8px"><button class="btn small" data-act="rd-up" data-id="' + esc(x.id) + '" aria-label="Monter">▲</button><button class="btn small" data-act="rd-down" data-id="' + esc(x.id) + '" aria-label="Descendre">▼</button><button class="btn small" data-act="rd-retirer" data-id="' + esc(x.id) + '">Retirer de la file</button></div>';
      else if (!x.choisir) h += '<div class="row" style="gap:6px;margin-top:8px;flex-wrap:wrap"><select class="in" id="rd-t-' + esc(x.id) + '" style="width:auto;flex:0 0 auto">' + RD_TYPES.map(function (o) { return '<option value="' + o[0] + '">' + o[1] + '</option>'; }).join('') + '</select><button class="btn small go" data-act="rd-choisir" data-id="' + esc(x.id) + '">✍️ Écrire celui-ci</button></div>';
    }
    return h + '</div>';
  }
  function panelRadar() {
    var R = S.radar, me = D().me, chef = !!me.chef;
    var h = head('📡', 'Le Radar', 'Sujets notés du jour · file de rédaction de l’Usine') + '<div class="pb">';
    h += '<div class="row" style="gap:8px;flex-wrap:wrap;margin-bottom:6px"><button class="btn small" data-act="rd-refresh">🔄 Actualiser</button>' + (chef ? '<button class="btn small" data-act="rd-relancer">📡 Relancer le Radar</button>' : '') + (R && R.at ? '<span class="cz-s" style="align-self:center">lu ' + esc(when(R.at)) + '</span>' : '') + '</div>';
    if (!chef) h += '<p class="cz-s">Lecture seule : seul le rédacteur en chef choisit les sujets.</p>';
    if (!R) return h + '<p class="muted">Le Radar se met en route…</p></div>';
    if (!R.ok) return h + rdSecret(R.why) + '</div>';
    var vs = R.votes || [], fl = (R.file || []).filter(function (x) { return !x.vote; }), sj = R.sujets || [];
    if (vs.length) h += '<div class="cz-t">🗳️ Le sujet choisi par le public</div>' + vs.map(function (x) { return rdCarte(x, 0, chef, false); }).join('');
    h += '<div class="cz-t">📋 File de rédaction (' + fl.length + ')</div>' + (fl.length ? '<p class="cz-s">Le n°1 part au prochain passage de l’Usine (8 h 30 ou 12 h), le n°2 au suivant.</p>' + fl.map(function (x, i) { return rdCarte(x, i + 1, chef, true); }).join('') : '<p class="muted">File vide : sans choix, l’Usine prend le sujet le mieux noté du jour.</p>');
    var libres = sj.filter(function (x) { return !x.choisir; });
    h += '<div class="cz-t">📰 Sujets notés du jour (' + sj.length + ')</div>' + (libres.length ? libres.map(function (x, i) { return rdCarte(x, i + 1, chef, false); }).join('') : '<p class="muted">Aucun autre sujet en attente aujourd’hui.</p>');
    if (chef) h += '<details class="cz-d"' + (S.rdImposer ? ' open' : '') + '><summary>✍️ Imposer un sujet</summary>' +
      '<label class="cz-s">Sujet</label><input class="in" id="rd-i-t" maxlength="300" placeholder="Ex. Neuralink : le premier implant visuel testé sur l’humain">' +
      '<label class="cz-s">Lien source (facultatif)</label><input class="in" id="rd-i-u" inputmode="url" placeholder="https://…">' +
      '<label class="cz-s">Angle imposé (facultatif)</label><textarea class="in" id="rd-i-a" rows="3" placeholder="Ce que l’article doit absolument traiter…"></textarea>' +
      '<div class="row" style="gap:8px;margin-top:8px;flex-wrap:wrap"><select class="in" id="rd-i-ty" style="width:auto;flex:0 0 auto"><option value="actu">Actu</option><option value="actu-premium">Actu-premium</option><option value="premium">Enquête premium</option></select><button class="btn go" data-act="rd-imposer">Mettre en file (prioritaire)</button></div></details>';
    return h + '</div>';
  }
  function panelMarbre() {
    var M = S.marbre, me = D().me, chef = !!me.chef;
    var h = head('📰', 'Le Marbre', 'Brouillons de l’Usine à approuver, puis tous les brouillons Ghost') + '<div class="pb">';
    h += '<div class="row" style="gap:8px;margin-bottom:6px"><button class="btn small" data-act="mb-refresh">🔄 Actualiser</button>' + (M && M.at ? '<span class="cz-s" style="align-self:center">lu ' + esc(when(M.at)) + '</span>' : '') + '</div>';
    if (!M) h += '<p class="muted">Lecture des brouillons de l’Usine…</p>';
    else if (!M.ok) h += rdSecret(M.why);
    else {
      if (M.airtable_absent) h += rdSecret('jeton Airtable absent') ;
      if (M.erreur_ghost) h += '<p class="muted">⚠️ Ghost : ' + esc(M.erreur_ghost) + '</p>';
      var bs = M.brouillons || [];
      h += '<div class="cz-t">🏭 Brouillons de l’Usine (' + bs.length + ')</div>' + (bs.length ? bs.map(function (x) {
        var p = x.post || {}, t = x.type ? rdType(x) : null, ap = x.statut === 'approved';
        return '<div class="cz-l mb-c">' + (p.image ? '<img class="mb-img" loading="lazy" alt="" src="' + esc(p.image) + '">' : '') + '<div class="rd-t">' + esc(p.titre || x.titre) + '</div>' +
          '<div class="cz-s">' + (t ? '<span class="tag ' + t[2] + '">' + t[0] + ' ' + t[1] + '</span> ' : '') + (ap ? '<span class="tag g">✅ approuvé · publié au batch de 18 h 30</span>' : x.statut === 'drafted' ? '<span class="tag a">à relire et approuver</span>' : '') + (x.ghost_supprime ? ' <span class="tag r">🗑️ post Ghost supprimé</span>' : '') +
          (p.statut === 'scheduled' ? ' <span class="tag b">programmé</span>' : '') + (p.visibilite && p.visibilite !== 'public' ? ' · ' + esc(p.visibilite) : '') + (p.lecture ? ' · ' + p.lecture + ' min' : '') + (p.maj ? ' · modifié ' + esc(when(p.maj)) : '') + '</div>' +
          (p.extrait ? '<div class="rd-a">' + esc(p.extrait) + '</div>' : '') +
          (x.couverture_ref && !(x.rapport && x.rapport.reference && x.rapport.reference.length) ? '<div class="cz-s">🖼️ Couverture faite d’après une photo de référence</div>' : '') +
          mbRapport(x.rapport) +
          (x.social && x.social.image ? '<details class="cz-d"><summary>📱 Visuel réseaux sociaux (' + esc(x.social.statut || '') + ')</summary><img class="mb-soc" loading="lazy" alt="" src="' + esc(x.social.image) + '"><div class="cz-s" style="white-space:pre-wrap">' + esc(x.social.legende || '') + (x.social.hashtags ? '\n' + esc(x.social.hashtags) : '') + '</div></details>' : '') +
          '<div class="row" style="gap:6px;margin-top:8px;flex-wrap:wrap">' + (p.editeur ? '<a class="btn small" href="' + esc(p.editeur) + '" target="_blank" rel="noopener">✏️ Relire dans Ghost</a>' : '') + (p.apercu ? '<a class="btn small" href="' + esc(p.apercu) + '" target="_blank" rel="noopener">👁️ Aperçu</a>' : '') +
          (chef && x.id && x.statut === 'drafted' && !x.ghost_supprime ? '<button class="btn small go" data-act="mb-approuver" data-id="' + esc(x.id) + '">✅ Approuver</button>' : '') +
          (chef && x.id && x.statut === 'drafted' ? '<button class="btn small" data-act="mb-ecarter" data-id="' + esc(x.id) + '" title="Ne pas publier ce brouillon (le post Ghost n’est pas supprimé)">🗑️ Écarter</button>' : '') + '</div></div>';
      }).join('') + (bs.some(function (x) { return !x.rapport; }) ? '<p class="cz-s">Les brouillons créés avant le 22/10/2026 n’ont pas de rapport détaillé : il est resté dans le message Telegram « Brouillon prêt ».</p>' : '') : '<p class="muted">Aucun brouillon de l’Usine en attente.</p>');
    }
    h += '<div id="wl-mb-listes">' + mbListes() + '</div>';
    return h + '</div>';
  }
  // Listes du Marbre (23/10/2026) : « 📝 Brouillons » (case « Inclure les brouillons de l'Usine », cochée par défaut ; décochée, on retire
  // SEULEMENT les posts écrits par l'Usine, quel que soit l'auteur des autres), « ✅ Publiés aujourd'hui », puis « 📚 Tous les articles »
  // avec recherche. Lignes compactes (vignette, titre sur 2 lignes, badges, date courte, actions en icônes).
  // Origine Usine : GhostPostId des sujets du Radar (wl-radar, usine_ids + brouillons en attente) ; c'est le seul signal fiable.
  function mbUsine() { var M = S.marbre || {}, o = {}; (M.usine_ids || []).forEach(function (x) { o[x] = 1; }); (M.brouillons || []).forEach(function (x) { if (x.ghost_id) o[x.ghost_id] = 1; }); return o; }
  function mbInclureUsine() { try { return localStorage.getItem('wl-mb-usine') !== '0'; } catch (e) { return true; } }
  function dateCourte(d) { if (!d) return ''; var t = new Date(d), j = new Date(); return t.toDateString() === j.toDateString() ? t.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : t.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }); }
  function artLigne(a, us) {
    var n = D().fiches.filter(function (f) { return f.article_id === a.id; }).length, st = a.statut === 'published' ? ['g', 'publié'] : a.statut === 'scheduled' ? ['b', 'programmé'] : ['a', 'brouillon'];
    var prim = premium(a) || n || prepEtat(a.id) ? btnMailsCourt(a.id) : '';
    return '<div class="al' + (a.id === S.art ? ' sel' : '') + '" data-act="pick-art" data-id="' + esc(a.id) + '" data-tip="' + esc(a.titre + '|touchez pour en faire l’article en cours|') + '">' +
      (a.image ? '<img class="al-v" loading="lazy" alt="" src="' + esc(a.image) + '">' : '<span class="al-v al-v0">📰</span>') +
      '<div class="al-c"><div class="al-t">' + esc(a.titre) + '</div><div class="al-m"><span class="tag ' + st[0] + '">' + st[1] + '</span>' + (us[a.id] ? '<span class="tag">🏭 Usine</span>' : '') + (premium(a) ? '<span class="tag">💎</span>' : '') +
      (n ? '<span class="tag">' + n + ' contact' + pl(n) + '</span>' : '') + '<span class="al-d">' + esc(dateCourte(a.statut === 'published' ? a.publie_le : a.maj)) + '</span></div></div>' +
      '<div class="al-a">' + prim + '<a class="al-i" href="' + url(a.editeur) + '" target="_blank" rel="noopener" data-stop="1" title="Ouvrir dans Ghost" aria-label="Ouvrir dans Ghost">✏️</a></div></div>';
  }
  function mbListes() {
    var M = S.marbre || {}, us = mbUsine(), inc = mbInclureUsine(), as = artsRecents();
    var brs = as.filter(function (a) { return a.statut !== 'published'; }), visibles = inc ? brs : brs.filter(function (a) { return !us[a.id]; });
    var nU = brs.filter(function (a) { return us[a.id]; }).length;
    var debut = new Date(); debut.setHours(0, 0, 0, 0);
    var pubs = as.filter(function (a) { return a.statut === 'published' && a.publie_le && new Date(a.publie_le) >= debut; });
    (M.publies || []).forEach(function (p) { if (!pubs.some(function (a) { return a.id === p.id; })) pubs.push({ id: p.id, titre: p.titre, statut: 'published', publie_le: p.publie_le, image: p.image, visibilite: p.visibilite, editeur: p.editeur || p.url, auteurs: [] }); });
    var q = norm(S.qMb || '').trim(), tous = as.filter(function (a) { return !q || q.split(/\s+/).every(function (m) { return norm(a.titre + ' ' + (a.auteurs || []).join(' ')).indexOf(m) >= 0; }); });
    return '<div class="cz-t mb-h"><span>📝 Brouillons (' + visibles.length + ')</span><label class="mb-chk" data-stop="1"><input type="checkbox" id="wl-mb-usine"' + (inc ? ' checked' : '') + '> Inclure les brouillons de l’Usine' + (nU ? ' (' + nU + ')' : '') + '</label></div>' +
      '<div class="als">' + (visibles.map(function (a) { return artLigne(a, us); }).join('') || '<div class="muted">' + (inc ? 'Aucun brouillon.' : 'Aucun brouillon hors Usine.') + '</div>') + '</div>' +
      '<div class="cz-t">✅ Publiés aujourd’hui (' + pubs.length + ')</div><div class="als">' + (pubs.map(function (a) { return artLigne(a, us); }).join('') || '<div class="muted">Rien de publié depuis minuit.</div>') + '</div>' +
      '<div class="cz-t">📚 Tous les articles (' + as.length + ')</div><div class="qbox"><input class="in" id="wl-qmb" type="search" value="' + esc(S.qMb || '') + '" placeholder="Chercher un article (titre, auteur)…" autocomplete="off" enterkeyhint="search" aria-label="Chercher un article"></div>' +
      '<div class="als" id="wl-mb-tous">' + (tous.map(function (a) { return artLigne(a, us); }).join('') || '<div class="muted">Aucun article ne correspond.</div>') + '</div>';
  }
  // Rapport détaillé du brouillon (enregistré par l'Usine depuis le 22/10/2026) : alertes en évidence, puis le reste replié.
  function mbLiens(t) { return esc(t).replace(/https?:\/\/[^\s<>"')]+/g, function (u) { return '<a href="' + u + '" target="_blank" rel="noopener">' + u + '</a>'; }); }
  function mbRapport(r) {
    if (!r) return '';
    var L = function (a) { return (a || []).filter(Boolean); }, li = function (a) { return '<ul class="mb-ul">' + a.map(function (x) { return '<li>' + mbLiens(x) + '</li>'; }).join('') + '</ul>'; };
    var al = L(r.alertes), gr = L(r.graphiques_non_places), cov = r.couverture && r.couverture.ok === false;
    var h = '';
    if (al.length || gr.length || cov) {
      h += '<div class="mb-al"><b>🚨 À vérifier avant d’approuver</b>' + li(al.concat(gr.map(function (g) { return 'Graphique non placé : ' + g; })).concat(cov ? ['Couverture manquante' + (r.couverture.cause ? ' (' + r.couverture.cause + ')' : '') + ' : à ajouter dans l’éditeur'] : [])) + '</div>';
    } else h += '<div class="cz-s">✅ Aucune alerte de rédaction</div>';
    var det = [];
    if (L(r.reference).length) det.push('<div class="mb-k">🖼️ Couverture</div>' + li(L(r.reference)));
    if (L(r.photos).length) det.push('<div class="mb-k">📷 Photos</div>' + li(L(r.photos)));
    if (L(r.video).length) det.push('<div class="mb-k">🎬 Encart vidéo</div>' + li(L(r.video)));
    if (L(r.mise_en_forme).length) det.push('<div class="mb-k">🧾 Mise en forme</div>' + li(L(r.mise_en_forme)));
    if (r.sources) det.push('<div class="mb-k">🔗 Contrôle des sources</div><div class="mb-src">' + mbLiens(r.sources) + '</div>');
    if (det.length) h += '<details class="cz-d"><summary>📋 Rapport de l’Usine</summary>' + det.join('') + '</details>';
    return h;
  }
  function panelVotes() {
    return head('🗳️', 'Votes du public', 'Le prochain sujet premium choisi par les abonnés') + '<div class="pb"><p>La salle des votes vit sur <b>posthumain.com/vote</b> : propositions, sujets fusionnés par l’IA, votes en direct et, pour la rédaction, qui a proposé quoi.</p>' +
      '<div class="row" style="margin-top:10px"><a class="btn go" href="https://posthumain.com/vote/#redaction" target="_blank" rel="noopener">Ouvrir la vue rédaction</a><a class="btn" href="https://posthumain.com/vote/" target="_blank" rel="noopener">Voir la page publique</a></div>' +
      '<p class="cz-s" style="margin-top:10px">Le sujet gagnant arrive en tête du Radar le lendemain de la clôture : vous pouvez l’y écarter.</p></div>';
  }
  // Registre des postes de décision : clé du plan → panneau (+ chargement à l'ouverture). « Décisions vidéo » viendra s'ajouter ici.
  var DECISIONS = {
    radar: { panel: panelRadar, ouvrir: function () { chargerRadar(); } },
    votes: { panel: panelVotes }
  };
  function rdAction(body, okMsg) {
    return radarApi(body).then(function (r) {
      if (!r || !r.ok) { toast('⚠️ ' + ((r && r.why) || 'impossible'), true); return r; }
      if (okMsg) toast(okMsg);
      if (r.file && S.radar && S.radar.ok) S.radar.file = r.file;
      chargerRadar();
      return r;
    });
  }
  function panelArticles() {
    var h = head('📰', 'Le Marbre', 'Les brouillons et articles programmés de Ghost');
    var as = artsRecents();
    return h + '<div class="pb"><p class="muted">Choisissez l’article sur lequel vous travaillez : l’Assistant s’en sert et les citations y seront insérées.</p><div class="arts" style="grid-template-columns:1fr">' + (as.map(artCard).join('') || '<div class="muted">Aucun brouillon.</div>') + '</div></div>';
  }
  function events() {
    var out = [];
    D().fiches.forEach(function (f) { (f.historique || []).forEach(function (e) { out.push({ t: e.t, e: e.e, par: e.par, f: f }); }); });
    return out.sort(function (a, b) { return String(b.t).localeCompare(String(a.t)); });
  }
  function panelJournaliste(id) {
    var w = membre(id), mine = id === D().me.id;
    var fs = D().fiches.filter(function (f) { return f.redacteur === id; });
    var h = head('✍️', mine ? 'Votre bureau' : w.nom, esc(w.titre || 'Journaliste'));
    h += '<div class="pb">' + (mine ? artBox() + '<div class="row"><button class="btn" data-act="open-ag" data-ag="assistant">🧠 Préparer une interview</button><button class="btn" data-act="open-ag" data-ag="secretaire">📮 Écrire à quelqu’un</button></div>' : '');
    ['a répondu', 'brouillon', 'envoyé', 'inséré'].forEach(function (st) {
      var l = fs.filter(function (f) { return f.statut === st; }); if (!l.length) return;
      h += '<h3>' + STATUTS[st][0] + ' ' + esc(STATUTS[st][1]) + ' (' + l.length + ')</h3><div class="dos">' + l.map(function (f) { return dcard(f); }).join('') + '</div>';
    });
    if (!fs.length) h += '<p class="muted" style="margin-top:14px">Aucune fiche de contact pour l’instant.</p>';
    return h + '</div>';
  }
  function panelChef() {
    var me = D().me, h = head('🧐', 'Bureau du rédacteur en chef', me.chef ? 'Votre bureau' : esc(P('chef').nom));
    if (!me.chef) return h + '<div class="pb"><p class="muted">Pour lui écrire, passez par l’interphone.</p><button class="btn" data-act="tab" data-tab="interphone">📞 Interphone</button></div>';
    h += '<div class="pb"><p class="muted">Toute la rédaction d’un coup d’œil : qui a écrit à qui, ce qui attend une validation, ce qui a été cité.</p><div class="row" style="margin:0 0 6px"><button class="btn go" data-act="bord">📊 Tableau de bord</button></div>';
    var eq = (D().equipe || []).filter(function (w) { return w.role !== 'chef' && w.actif !== false; });
    h += '<h3>L’équipe</h3>' + ((eq.length ? eq : []).map(function (w) {
      var fs = D().fiches.filter(function (f) { return f.redacteur === w.id; });
      var c = function (st) { return fs.filter(function (f) { return f.statut === st; }).length; };
      return '<div class="card" data-act="open-ag" data-ag="j:' + esc(w.id) + '"><div class="h"><span class="em">✍️</span><span style="flex:1">' + esc(w.nom) + tagTest(w.id) + '</span>' + (w.test ? '<span class="tag a">aucun envoi</span>' : w.branchee ? '<span class="tag g">boîte branchée</span>' : '<span class="tag a">boîte à brancher</span>') + '</div><div class="s">🟠 ' + c('brouillon') + ' à valider · 📨 ' + c('envoyé') + ' envoyés · 📬 ' + c('a répondu') + ' réponses · ✅ ' + c('inséré') + ' cités</div></div>';
    }).join('') || '<div class="box warn">Aucune journaliste n’a encore accès au lab : ajoutez-la dans ⚙️ Paramètres → 👥 Équipe.</div>');
    var mf = D().fiches.filter(function (f) { return f.redacteur === me.id; });
    if (mf.length) h += '<h3>Vos propres fiches (' + mf.length + ')</h3><div class="dos">' + mf.slice(0, 10).map(function (f) { return dcard(f); }).join('') + '</div>';
    var ev = events().slice(0, 25);
    h += '<h3>Ce qui s’est passé</h3><div class="feed">' + (ev.map(function (e) { return '<div class="it" data-act="open-fiche" data-id="' + esc(e.f.fiche_id) + '" style="cursor:pointer"><span class="t">' + esc(when(e.t)) + '</span><span>' + histTxt(e.e) + ' · <b>' + esc(e.f.contact.nom) + '</b> · ' + esc(e.par === 'courrier' ? 'courrier' : membre(e.par).nom) + '</span></div>'; }).join('') || '<div class="muted">Rien pour l’instant.</div>') + '</div>';
    h += '<div style="margin-top:14px"><button class="btn" data-act="tab" data-tab="interphone">📞 Interphone</button></div>';
    return h + '</div>';
  }

  // ---------- documents (feuille de papier plein écran) ----------
  function openDoc(kind, id) { masquerTip(); S.docRetour = S.doc && S.doc.kind === 'prep' && kind !== 'prep' ? { kind: 'prep', id: S.doc.id } : kind === 'prep' ? null : S.docRetour; S.doc = { kind: kind, id: id }; paintDoc(); S.root.querySelector('.doc').classList.add('open'); S.root.querySelector('.doc').scrollTop = 0; }
  function closeDoc() { if (S.appel) { S.appel.actif = false; clearInterval(S.appel.timer); try { if (S.appel.rec) S.appel.rec.stop(); } catch (e) {} S.appel = null; } S.doc = null; S.docRetour = null; S.cit = null; S.colle = false; S.root.querySelector('.doc').classList.remove('open'); }
  // Fermer (✕, Échap, après un envoi ou un archivage) : un mail ouvert depuis la fenêtre des interviews y revient.
  function fermerDoc() {
    var r = S.docRetour;
    if (r && S.doc && S.doc.kind !== 'prep') { S.cit = null; S.colle = false; openDoc(r.kind, r.id); setTimeout(function () { var x = S.root.querySelector('.doc .pp-x'); if (x) x.focus({ preventScroll: true }); }, 30); return; }
    var prep = S.doc && S.doc.kind === 'prep', o = S.prepOpener; closeDoc(); S.prepOpener = null;
    if (prep && o && o.isConnected && o.focus) o.focus({ preventScroll: true });
  }
  function paintDoc() {
    if (!S.doc) return;
    setTimeout(markBusy, 0);
    var el = S.root.querySelector('.doc'), keep = el.scrollTop, ae = document.activeElement;
    if (ae && el.contains(ae) && (ae.tagName === 'TEXTAREA' || ae.tagName === 'INPUT')) return; // jamais sous les doigts
    if (S.doc.kind === 'aide') { el.innerHTML = docAide(); el.scrollTop = keep; return; }
    if (S.doc.kind === 'prep') { el.innerHTML = docPrep(S.doc.id); el.scrollTop = keep; markBusy(); return; }
    if (S.doc.kind === 'pieces') { el.innerHTML = docPieces(); el.scrollTop = keep; markBusy(); return; }
    if (S.doc.kind === 'prospect') { var px = prospect(S.doc.id); el.innerHTML = px ? docProspect(px) : '<div class="dtop"><span class="nm">Prospect introuvable</span><span class="x" data-act="close-doc">✕</span></div>'; el.scrollTop = keep; markBusy(); return; }
    if (S.doc.kind === 'mail') { var mm = mail(S.doc.id); el.innerHTML = mm ? docMail(mm) : '<div class="dtop"><span class="nm">Mail introuvable</span><span class="x" data-act="close-doc">✕</span></div>'; el.scrollTop = keep; return; }
    var f = fiche(S.doc.id);
    if (!f) { el.innerHTML = '<div class="dtop"><span class="nm">Fiche introuvable</span><span class="x" data-act="close-doc">✕</span></div>'; return; }
    el.innerHTML = S.doc.kind === 'valid' && f.statut === 'brouillon' ? docValidation(f) : docFiche(f);
    el.scrollTop = keep;
  }
  function docAide() {
    var row = function (a, b) { return '<tr><td style="padding:4px 12px 4px 0;opacity:.7">' + a + '</td><td style="padding:4px 0"><b>' + b + '</b></td></tr>'; };
    return '<div class="dtop"><span class="em">✉︎</span><div><div class="nm">Votre adresse Posthumain dans Outlook</div><div class="st">notice · Infomaniak</div></div><span class="x" data-act="close-doc">✕</span></div>' +
      '<div class="paper"><div class="kick">À faire une seule fois par appareil</div>' +
      '<p>Votre adresse <b>prenom.nom@posthumain.com</b> est hébergée chez Infomaniak. Jonathan vous donne le mot de passe. Vous pouvez aussi lire vos mails sans rien installer sur <b>mail.infomaniak.com</b>.</p>' +
      '<label>Réglages à saisir si Outlook les demande</label><table style="font-size:16px;border-collapse:collapse;margin:6px 0 14px">' +
      row('Type de compte', 'IMAP') + row('Adresse e-mail et nom d’utilisateur', 'votre adresse complète') + row('Mot de passe', 'celui donné par Jonathan') +
      row('Serveur entrant (IMAP)', 'mail.infomaniak.com · port 993 · SSL/TLS') + row('Serveur sortant (SMTP)', 'mail.infomaniak.com · port 465 · SSL/TLS') + row('Authentification SMTP', 'oui, mêmes identifiants') + '</table>' +
      '<label>Outlook sur ordinateur (Windows ou Mac)</label><ol style="margin:6px 0 14px 20px;line-height:1.6"><li>Ouvrez Outlook, puis <b>Paramètres → Comptes → Ajouter un compte</b> (Mac : <b>Outlook → Paramètres → Comptes → +</b>).</li><li>Tapez votre adresse @posthumain.com, puis <b>Continuer</b>.</li><li>Si Outlook propose un fournisseur, choisissez <b>IMAP</b> (ou « Configuration avancée »).</li><li>Saisissez le mot de passe et les serveurs du tableau ci-dessus, puis <b>Continuer</b>.</li></ol>' +
      '<label>Outlook sur iPhone ou Android</label><ol style="margin:6px 0 14px 20px;line-height:1.6"><li>Ouvrez l’app Outlook, touchez votre photo en haut à gauche, puis la roue <b>Paramètres → Ajouter un compte mail</b>.</li><li>Tapez votre adresse @posthumain.com.</li><li>Choisissez <b>IMAP</b>, activez <b>Paramètres avancés</b>, puis remplissez avec le tableau.</li><li>Touchez la coche ✓ en haut à droite.</li></ol>' +
      '<label>Si ça ne marche pas</label><ul style="margin:6px 0 14px 20px;line-height:1.6"><li>« Mot de passe incorrect » : vérifiez les majuscules ; demandez-en un nouveau à Jonathan.</li><li>Les mails ne partent pas : vérifiez le port <b>465</b> et que l’authentification SMTP est activée.</li><li>Outlook.com (navigateur) ne gère pas bien ces adresses : utilisez mail.infomaniak.com ou l’app.</li></ul>' +
      '<p class="lead">Le Writinglab envoie et relève vos mails de son côté : configurer Outlook sert seulement à lire et écrire vous-même hors du lab.</p></div>';
  }
  function docValidation(f) {
    if (!peut(f)) return docFiche(f);
    var w = membre(f.redacteur), branchee = !!w.branchee;
    var okMail = /^[^\s@<>]+@[^\s@<>]+\.[a-z]{2,}$/i.test(f.contact.email || '');
    var ed = (S.vEdit && S.vEdit[f.fiche_id]) || { sujet: f.mail_sujet, corps: f.mail_corps };
    var og = origine(f);
    var h = '<div class="dtop"><span class="em">📮</span><div><div class="nm">Mail à valider</div><div class="st">' + og[0] + ' ' + (og[1] === 'Express' ? 'préparé en express' : og[1] === 'Assistant' ? 'questions de l’Assistant, mail de la Secrétaire' : 'rédigé par la Secrétaire') + ' · lancé par ' + esc(qui(f)) + ' · ' + esc(when(f.maj)) + '</div></div><span class="x" data-act="close-doc">✕</span></div>';
    h += '<div class="paper"><div class="kick">Relisez, corrigez si besoin, puis validez</div>' +
      '<div class="meta">À : <b>' + nomFiche(f) + '</b> ' + (okMail ? '&lt;' + esc(f.contact.email) + '&gt;' + sourceAdresse(liensFiche(f).source) : '<span class="tag a">adresse manquante</span>') + '<br>📰 ' + esc(f.article_titre || 'sans article') + ' · ' + (f.langue === 'en' ? 'en anglais' : 'en français') + '</div>';
    h += dejaHTML(dejaContacte(f.contact.email, f.fiche_id));
    if (!okMail) h += '<div class="warn">Il manque l’adresse e-mail du contact.<label>Adresse e-mail</label><input class="pin" id="wl-v-email" type="email" inputmode="email" placeholder="prenom.nom@universite.edu"><div class="acts"><button data-act="v-email" data-id="' + esc(f.fiche_id) + '">Enregistrer l’adresse</button></div></div>';
    h += '<label>Objet</label><input class="pin sub" id="wl-v-sujet" value="' + esc(ed.sujet) + '">' +
      '<label>Message</label><textarea class="pin big" id="wl-v-corps">' + esc(ed.corps) + '</textarea>' + sigApercu(f) +
      pjWidget('v:' + f.fiche_id) +
      (branchee ? '' : '<div class="warn">La boîte mail de ' + esc(w.nom || 'cette personne') + ' n’est pas encore branchée : vous pouvez enregistrer, l’envoi viendra plus tard.</div>') +
      '<div class="acts"><button class="go" data-act="v-send" data-id="' + esc(f.fiche_id) + '"' + (okMail && branchee && !S.busy.secretaire ? '' : ' disabled') + '>✅ Valider et envoyer</button>' +
      '<button data-act="v-save" data-id="' + esc(f.fiche_id) + '">💾 Garder mes corrections</button>' +
      '<button data-act="v-redo" data-id="' + esc(f.fiche_id) + '"' + (S.busy.secretaire ? ' disabled' : '') + '>✏️ Autre version</button>' +
      '<button class="red" data-act="archive" data-id="' + esc(f.fiche_id) + '">🗄️ Abandonner</button></div>' +
      '<div id="wl-v-redo" style="display:none"><label>Que faut-il changer ?</label><input class="pin" id="wl-v-consigne" placeholder="ex. plus court, plus chaleureux, ajouter que…"><div class="acts">' + pubWrap('v:' + f.fiche_id, '<button class="go" data-act="v-redo-go" data-id="' + esc(f.fiche_id) + '">Demander la nouvelle version</button>', pubFiche(f)) + '</div></div>' +
      '<p class="lead">Le mail part de l’adresse Posthumain de ' + esc(w.nom || 'la rédaction') + ', seulement quand vous cliquez sur « Valider et envoyer ». Les réponses arriveront dans le Courrier.</p></div>';
    return h;
  }
  // Canal de la réponse (23/10/2026) : déduit par n8n (fil du mail, marqueur « reçue par téléphone ») ou choisi ici ; sans indication,
  // « non précisé » et l'article n'en dira rien. Sert aux citations (le canal est précisé une fois, à la première citation de la personne).
  var CANAL_OPT = [['', 'non précisé'], ['email', '✉️ e-mail'], ['telephone', '📞 téléphone'], ['email+telephone', '✉️ e-mail et 📞 téléphone'], ['personne', '🤝 en personne']];
  function canalNom(c) { var o = CANAL_OPT.filter(function (x) { return x[0] === (c === 'non_precise' ? '' : c); })[0]; return o ? o[1] : 'non précisé'; }
  function canalHTML(f, rw) {
    var c = f.canal && f.canal !== 'non_precise' ? f.canal : '';
    if (!rw) return '<p class="canal-l">Reçue par : ' + esc(canalNom(c)) + '</p>';
    return '<label class="canal-l">Reçue par <select id="wl-canal" data-id="' + esc(f.fiche_id) + '">' + CANAL_OPT.map(function (o) { return '<option value="' + o[0] + '"' + (o[0] === c ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select>' +
      '<span class="ap-s">' + (f.canal_choisi ? 'choisi à la main' : c ? 'déduit automatiquement' : 'à préciser : sinon, l’article ne dira pas comment la réponse a été obtenue') + '</span></label>';
  }
  function canalChoisir(fid, c) {
    telApi({ action: 'canal', fiche_id: fid, canal: c }).then(function (r) {
      if (!r || !r.ok) { toast('⚠️ ' + ((r && r.why) || 'canal non enregistré'), true); return; }
      refresh(true).then(function () { paintDoc(); toast('Canal de la réponse : ' + canalNom(c) + '.'); });
    });
  }
  function docFiche(f) {
    var w = membre(f.redacteur);
    var h = '<div class="dtop"><span class="em">🗂️</span><div><div class="nm">' + esc(f.contact.nom) + '</div><div class="st">' + esc(stLib(f)[1]) + ' · fiche de ' + esc(w.nom) + '</div></div><span class="x" data-act="close-doc">✕</span></div>';
    var rw = peut(f);
    h += '<div class="paper"><div class="kick">Fiche contact ' + tagStatut(f) + ' · ' + origine(f).join(' ') + ' · lancée par ' + esc(qui(f)) + '</div><h1>' + nomFiche(f) + '</h1>' + (liensFiche(f).source ? '<div class="src-w">' + sourceAdresse(liensFiche(f).source) + '</div>' : '') + parcoursHTML(f) + (rw ? '' : lectureSeule('fiche de ' + membre(f.redacteur).nom)) +
      '<div class="meta">' + esc([f.contact.role, f.contact.institution].filter(Boolean).join(', ')) + (f.contact.email ? '<br>✉️ ' + esc(f.contact.email) : '') + '<br>📰 ' + esc(f.article_titre || 'sans article') + (relanceInfo(f) ? '<br>🔁 ' + esc(relanceInfo(f)) : '') + '</div>';
    if (estRebond(f)) h += '<div class="rebond">✉️ <b>Adresse invalide</b> : le mail n’a pas été distribué' + (f.rebond_le ? ' (' + esc(when(f.rebond_le)) + ')' : '') + '.' + (f.rebond_motif ? '<br><span style="opacity:.85">Motif : ' + esc(f.rebond_motif) + '</span>' : '') +
      '<br>Vérifiez l’adresse (page de l’institution, dernière publication), puis écrivez-lui à nouveau depuis la Secrétaire (« Écrire à quelqu’un ») avec la bonne adresse.</div>';
    h += dejaHTML(dejaContacte(f.contact.email, f.fiche_id));
    if (relancePrete(f) && rw) h += relanceBlock(f);
    if (f.statut === 'brouillon' && rw) h += '<div class="acts"><button class="go" data-act="open-valid" data-id="' + esc(f.fiche_id) + '">📮 Relire le mail à valider</button></div>';
    // la réponse et son insertion dans l'article
    if (f.reponse) {
      h += '<h2>Sa réponse' + (f.reponse_le ? ' · ' + esc(when(f.reponse_le)) : '') + '</h2>' + canalHTML(f, rw) + '<div class="txt">' + esc(f.reponse) + '</div>' + piecesHTML(f.pieces);
      if (f.statut === 'inséré') h += '<div class="lead">✅ Cité dans l’article :<br>' + nl(f.citation) + '</div>';
      if (f.article_id && rw) h += citationBlock(f);
      else h += '<p class="lead">Cette fiche n’est liée à aucun article : rattachez-la depuis l’Assistant pour pouvoir insérer la réponse.</p>';
    } else if (f.statut === 'envoyé' && rw) {
      h += '<h2>Réponse</h2><p class="lead">Pas encore de réponse (mail envoyé ' + esc(when(f.envoye_le)) + '). Le Courrier la rangera ici dès qu’elle arrive.</p>' +
        '<div class="acts">' + (relancable(f) && !relancePrete(f) ? '<button data-act="relance" data-id="' + esc(f.fiche_id) + '"' + (S.busy.secretaire ? ' disabled' : '') + '>🔁 Faire préparer une relance</button>' : '') +
        '<button data-act="ap-ouvrir" data-id="' + esc(f.fiche_id) + '">📞 Réponse par téléphone</button>' +
        '<button data-act="colle" data-id="' + esc(f.fiche_id) + '">📝 Réponse reçue ailleurs (autre adresse)</button></div>';
    }
    if (f.reponse && (f.statut === 'a répondu' || f.attente) && rw && !(S.appel && S.appel.fiche_id === f.fiche_id)) h += '<div class="acts"><button data-act="ap-ouvrir" data-id="' + esc(f.fiche_id) + '">📞 Compléter par une réponse au téléphone</button>' +
      (f.statut === 'a répondu' && capTraiter() ? '<button data-act="fiche-traitee" data-id="' + esc(f.fiche_id) + '" title="Réponse purement logistique, sans contenu à citer : la fiche passe « en attente de réponse »">✓ Marquer comme traitée</button>' : '') + '</div>';
    if (f.attente) h += '<p class="lead">📨 ' + esc(envoiTxt(f)) + ' : en attente de la réponse de ' + esc(f.contact.nom) + '. Sa réponse précédente reste ci-dessus (citations toujours possibles).</p>';
    h += suiteHTML(f, rw);
    h += appelHTML(f);
    if (S.colle) h += '<label>Collez ou résumez la réponse</label><textarea class="pin" id="wl-colle"></textarea><label class="canal-l">Reçue par <select id="wl-colle-canal">' + CANAL_OPT.map(function (o) { return '<option value="' + o[0] + '">' + o[1] + '</option>'; }).join('') + '</select></label><div class="acts"><button class="go" data-act="colle-go" data-id="' + esc(f.fiche_id) + '">Enregistrer la réponse</button></div>';
    var qe = questionsEnvoyees(f), qo = f.questions || [];
    var traduites = qe.length && qo.length && qe.join('|') !== qo.join('|');
    if (qe.length || qo.length) h += '<h2>Questions ' + (f.statut === 'brouillon' ? 'prévues' : 'posées') + (traduites ? ' <span class="tag">' + (f.langue === 'en' ? 'en anglais, telles qu’envoyées' : 'telles qu’envoyées') + '</span>' : '') + '</h2><ol>' + (qe.length ? qe : qo).map(function (q) { return '<li>' + esc(q) + '</li>'; }).join('') + '</ol>' +
      (traduites ? '<details><summary>Version choisie dans le lab</summary><ol>' + qo.map(function (q) { return '<li>' + esc(q) + '</li>'; }).join('') + '</ol></details>' : '');
    if (f.mail_corps && f.statut !== 'brouillon') h += '<details><summary>Le mail envoyé · ' + esc(f.mail_sujet) + '</summary><div class="txt" style="font-size:15px">' + esc(f.mail_corps) + '</div></details>';
    h += '<h2>Historique</h2><ul class="tl">' + (f.historique || []).slice().reverse().map(function (e) { return '<li>' + esc(day(e.t) + ' ' + hm(e.t)) + ' — ' + histTxt(e.e) + (e.par && e.par !== 'courrier' ? ' (' + esc(membre(e.par).nom) + ')' : '') + '</li>'; }).join('') + '</ul>';
    if (rw) h += '<div class="acts"><button class="red" data-act="archive" data-id="' + esc(f.fiche_id) + '">🗄️ Archiver la fiche</button></div>';
    h += '</div>';
    return h;
  }
  // Citations (21/10/2026) : l'Assistant (Opus) propose 1 à 5 extraits, chacun à sa place dans l'article (après un paragraphe simple,
  // jamais dans une carte, un encart HTML, une vidéo ou le paywall). Chaque proposition se montre en contexte : paragraphe d'avant (pâle),
  // le bloc tel qu'il apparaîtra, paragraphe d'après (pâle). On insère une à une, ou tout d'un coup.
  // Relance préparée par les coulisses : relue, corrigée si besoin, puis envoyée dans le fil du premier mail.
  function relanceBlock(f) {
    var w = membre(f.redacteur), ed = (S.rEdit && S.rEdit[f.fiche_id]) || { sujet: f.relance_sujet || (/^re\s*:/i.test(f.mail_sujet || '') ? f.mail_sujet : 'Re: ' + (f.mail_sujet || '')), corps: f.relance_corps || '' };
    return '<div class="relance"><h2>⏰ Relance prête</h2><p class="lead" style="margin-top:0">Pas de réponse depuis l’envoi (' + esc(when(f.envoye_le)) + '). La Secrétaire a préparé une relance courte, qui partira <b>dans le même fil</b> que le premier mail. Relisez, corrigez si besoin.</p>' +
      '<label>Objet</label><input class="pin sub" id="wl-r-sujet" value="' + esc(ed.sujet) + '"><label>Message</label><textarea class="pin big" id="wl-r-corps">' + esc(ed.corps) + '</textarea>' + sigApercu(f) +
      (w.branchee ? '' : '<div class="warn">La boîte mail de ' + esc(w.nom || 'cette personne') + ' n’est pas encore branchée : l’envoi n’est pas possible pour l’instant.</div>') +
      '<div class="acts"><button class="go" data-act="r-send" data-id="' + esc(f.fiche_id) + '"' + (w.branchee && !S.busy.secretaire ? '' : ' disabled') + '>📨 Envoyer la relance</button><button data-act="r-skip" data-id="' + esc(f.fiche_id) + '">Pas maintenant</button></div></div>';
  }
  // ✉️ Réponse dans le fil d'une fiche d'interview (capacité du catalogue dont l'exécuteur wl-tel est « suite_rediger ») :
  // la Secrétaire rédige un brouillon d'après la consigne du membre (écrite ou dictée) ; il s'affiche ici, partira dans le même fil
  // que les échanges après « Valider et envoyer ». Les noms des actions (rédiger, envoyer, écarter, lister) viennent du catalogue.
  function capTraiter() { return (CAT.interne_tel || {}).fiche_traitee ? 'fiche_traitee' : ''; }
  var SU_RELANCE = 'Relance courte et cordiale : rappeler notre dernier message, sans insister, et demander s’il a pu y donner suite.';
  function capSuite() { return (CAT.capacites || []).filter(function (c) { return c.executeur && c.executeur.type === 'tel' && c.executeur.envoi; })[0]; }
  function suitesCharger(force) {
    var c = capSuite(); if (!c || S.suitesLd || (!force && S.suites && Date.now() - S.suites.at < 20000)) return;
    S.suitesLd = true;
    telApi({ action: c.executeur.lister }).then(function (r) {
      S.suitesLd = false; S.suites = { at: Date.now(), l: (r && r.ok && r.suites) || {}, tel: (r && r.telephone) || '' };
      var ae = document.activeElement; if (ae && (ae.tagName === 'TEXTAREA' || ae.tagName === 'INPUT') && /^wl-su-/.test(ae.id || '')) return;
      if (S.doc && S.doc.kind === 'fiche') paintDoc();
    }, function () { S.suitesLd = false; });
  }
  function suiteHTML(f, rw) {
    var c = capSuite(); if (!c || !rw || !catDroit(c)) return '';
    if ((((c.params || {}).fiche_id || {}).statuts || []).indexOf(f.statut) < 0) return '';
    if (!S.suites) { suitesCharger(); return ''; }
    suitesCharger();
    var x = S.suites.l[f.fiche_id] || {}, env = x.envoyees || [], id = esc(f.fiche_id), w = membre(f.redacteur), busy = S.suiteBusy === f.fiche_id, h = '';
    if (env.length) h += '<details class="su-env"><summary>✉️ ' + env.length + ' réponse' + pl(env.length) + ' envoyée' + pl(env.length) + ' dans le fil</summary><ul class="mb-ul">' + env.slice().reverse().map(function (e) { return '<li>' + esc(when(e.le)) + ' · à ' + esc(e.a || '') + ' · « ' + esc(e.sujet || '') + ' »</li>'; }).join('') + '</ul></details>';
    if (x.corps && S.suOuvert !== f.fiche_id) {
      var ed = (S.suEdit || {})[f.fiche_id] || { sujet: x.sujet, corps: x.corps };
      return h + '<div class="relance suite"><h2>✉️ Réponse dans le fil, à valider</h2><p class="lead" style="margin-top:0">La Secrétaire a préparé cette réponse' + (x.prete_le ? ' (' + esc(when(x.prete_le)) + ')' : '') + '. Elle partira à <b>' + esc(x.a || f.contact.email || '') + '</b>, <b>dans le même fil</b> que vos échanges. Relisez, corrigez si besoin.</p>' +
        '<label>Objet</label><input class="pin sub" id="wl-su-sujet" value="' + esc(ed.sujet) + '"><label>Message</label><textarea class="pin big" id="wl-su-corps">' + esc(ed.corps) + '</textarea>' + sigApercu(f) +
        (w.branchee ? '' : '<div class="warn">La boîte mail de ' + esc(w.nom || 'cette personne') + ' n’est pas encore branchée : l’envoi n’est pas possible pour l’instant.</div>') +
        '<div class="acts"><button class="go" data-act="su-send" data-id="' + id + '"' + (w.branchee && !busy ? '' : ' disabled') + '>' + (busy ? '⏳ Envoi…' : '✅ Valider et envoyer') + '</button><button data-act="su-refaire" data-id="' + id + '"' + (busy ? ' disabled' : '') + '>✍️ Refaire</button><button data-act="su-skip" data-id="' + id + '"' + (busy ? ' disabled' : '') + '>🗑️ Écarter</button></div></div>';
    }
    if (S.suOuvert !== f.fiche_id) return h + '<div class="acts"><button data-act="su-ouvrir" data-id="' + id + '">✉️ Répondre dans le fil</button>' +
      (f.attente && relancable(f) ? '<button data-act="su-relance" data-id="' + id + '" title="Plus de 3 jours depuis notre dernier message : relance courte, dans le même fil">🔁 Relancer dans le fil</button>' : '') + '</div>';
    var d = (S.suDraft || {})[f.fiche_id] || { consigne: x.consigne || '', tel: '' };
    return h + '<div class="relance suite"><h2>✉️ Répondre dans le fil</h2><p class="lead" style="margin-top:0">Dites à la Secrétaire ce qu’il faut répondre à ' + esc(f.contact.nom) + ' : remercier, proposer un appel ou une autre formule, fixer un rendez-vous, demander une précision, donner votre numéro… Elle rédige un brouillon : rien ne part sans votre validation.</p>' +
      '<label for="wl-su-consigne">Ce qu’il faut lui dire</label><textarea class="pin" id="wl-su-consigne" rows="3" placeholder="' + (SU_DICTEE.actif() ? '🎙️ Je vous écoute…' : 'Ex. : le remercier, proposer un appel demain à 10 h, ou ses réponses par e-mail sous 48 h') + '">' + esc(d.consigne || '') + '</textarea>' +
      (SU_DICTEE.dispo ? '<div class="acts" style="margin-top:6px"><button type="button" data-act="su-dicter" class="' + (SU_DICTEE.actif() ? 'on' : '') + '">' + (SU_DICTEE.actif() ? '⏹️ Arrêter la dictée' : '🎙️ Dicter') + '</button></div>' : '') +
      '<label for="wl-su-tel">Numéro de téléphone à donner (facultatif)</label><input class="pin" id="wl-su-tel" inputmode="tel" autocomplete="off" value="' + esc(d.tel || '') + '" placeholder="' + (S.suites.tel ? 'votre numéro : ' + esc(S.suites.tel) : 'à renseigner dans Paramètres → Équipe, ou ici') + '">' +
      (S.suites.tel && !d.tel ? '<div class="acts" style="margin-top:6px"><button type="button" data-act="su-montel" data-id="' + id + '">📞 Insérer mon numéro</button></div>' : '') +
      '<div class="acts"><button class="go" data-act="su-rediger" data-id="' + id + '"' + (busy ? ' disabled' : '') + '>' + (busy ? '⏳ La Secrétaire rédige…' : '✍️ Faire rédiger la réponse') + '</button><button data-act="su-fermer" data-id="' + id + '">Annuler</button></div></div>';
  }
  function suiteRediger(fid) {
    var c = capSuite(), f = fiche(fid); if (!c || !f || S.suiteBusy) return;
    if (SU_DICTEE.actif()) SU_DICTEE.arreter();
    var consigne = val('wl-su-consigne').trim(), tel = val('wl-su-tel').trim();
    if (consigne.length < 3) { toast('Dites ce qu’il faut lui répondre (écrit ou dicté).', true); return; }
    S.suDraft = S.suDraft || {}; S.suDraft[fid] = { consigne: consigne, tel: tel }; S.suiteBusy = fid; paintDoc();
    var E = c.executeur;
    work(E.bureau || 'secretaire', E.libelle || 'rédige', telApi({ action: E.action, fiche_id: fid, consigne: consigne, telephone: tel }).then(function (r) { if (!r || !r.ok) throw new Error((r && r.why) || 'rédaction impossible'); return r; })).then(function (r) {
      S.suiteBusy = null; S.suOuvert = null; delete S.suDraft[fid]; if (S.suEdit) delete S.suEdit[fid];
      var x = S.suites.l[fid] = S.suites.l[fid] || { envoyees: [] }; x.sujet = r.sujet; x.corps = r.corps; x.a = r.a; x.consigne = consigne; x.prete_le = new Date().toISOString();
      paintDoc(); toast('✉️ Réponse prête : relisez-la avant de l’envoyer.'); refresh(true);
    }).catch(function () { S.suiteBusy = null; paintDoc(); });
  }
  function suiteEnvoyer(fid) {
    var c = capSuite(), f = fiche(fid), x = S.suites && S.suites.l[fid]; if (!c || !f || !x || S.suiteBusy) return;
    if (testBloque()) return;
    var su = val('wl-su-sujet').trim(), co = val('wl-su-corps').trim();
    if (!su || !co) { toast('Objet ou message vide.', true); return; }
    var ck = S.clicking; confirmer('Envoyer la réponse à ' + f.contact.nom + ' (' + (x.a || f.contact.email) + ') ?\nElle part dans le même fil que vos échanges.').then(function (ok) {
      if (!ok) return; S.clicking = ck; setTimeout(function () { S.clicking = null; }, 0);
      S.suiteBusy = fid; paintDoc();
      work(c.executeur.bureau || 'secretaire', 'envoie la réponse', telApi({ action: c.executeur.envoi, fiche_id: fid, sujet: su, corps: co, valide: true }).then(function (r) { if (!r || !r.ok) throw new Error((r && r.why) || 'envoi impossible'); return r; })).then(function (r) {
        S.suiteBusy = null; if (S.suEdit) delete S.suEdit[fid]; S.suites = null; toast('📨 Réponse envoyée à ' + f.contact.nom + ' (' + (r.a || '') + '), dans le fil.');
        return refresh(true).then(function () { paintDoc(); });
      }).catch(function () { S.suiteBusy = null; paintDoc(); });
    });
  }
  function sigApercu(f) {
    var sg = S.sigs && S.sigs[f.redacteur]; if (!sg) return '';
    var lg = f.langue === 'en' ? 'en' : 'fr';
    return '<div class="sigprev"><div class="kd">Signature ajoutée à l’envoi · ' + (lg === 'en' ? 'English' : 'français') + '</div>' + (sg[lg] || '') + '</div>';
  }
  function citationBlock(f) {
    var c = S.cit && S.cit.fid === f.fiche_id ? S.cit : null, busy = !!S.busy.assistant;
    var h = '<h2>Dans l’article</h2>';
    if (!c || !c.ins) return h + '<p class="lead">L’Assistant lit l’article, choisit les passages les plus forts de la réponse, corrige l’orthographe et la ponctuation sans toucher aux propos (et traduit si besoin), puis propose l’endroit idéal pour chacun.</p>' +
      '<div class="acts"><button class="go" data-act="cit" data-id="' + esc(f.fiche_id) + '"' + (busy ? ' disabled' : '') + '>✨ Proposer les emplacements dans l’article</button></div>' + chapoBlock(f);
    var reste = c.ins.filter(function (x, k) { return !c.fait[k] && !c.skip[k]; }).length;
    h += '<p class="lead">' + c.ins.length + ' extrait' + pl(c.ins.length) + ' proposé' + pl(c.ins.length) + ', chacun à sa place. Dépliez pour voir le passage tel qu’il apparaîtra, ajustez si besoin, puis insérez.</p>';
    var cut = function (t, n, fin) { t = String(t || ''); return t.length <= n ? t : fin ? '… ' + t.slice(-n) : t.slice(0, n) + ' …'; };
    h += c.ins.map(function (x, k) {
      var ouvert = !!c.open[k], fait = !!c.fait[k], skip = !!c.skip[k];
      var hd = '<div class="cit-h" data-act="cit-tog" data-i="' + k + '"><span class="cit-n">' + (k + 1) + '</span><span class="cit-t">' + esc(cut(x.citation.replace(/^«\s*|\s*»$/g, ''), 70)) + '<small>après « ' + esc(cut(x.avant, 60)) + ' »</small></span>' +
        (fait ? '<span class="tag g">✅ insérée</span>' : skip ? '<span class="tag">écartée</span>' : '') + '<span class="cit-c">' + (ouvert ? '▾' : '▸') + '</span></div>';
      if (!ouvert) return '<div class="cit' + (fait ? ' done' : '') + (skip ? ' skip' : '') + '">' + hd + '</div>';
      var corps = '<div class="ctx">' + esc(cut(x.avant, 260, true)) + '</div>' +
        '<div class="neo">' + (x.intro ? '<p>' + esc(x.intro) + '</p>' : '') + '<blockquote>' + esc(x.citation) + (x.attribution ? '<br><em>— ' + esc(x.attribution.replace(/^[—–-]\s*/, '')) + '</em>' : '') + '</blockquote></div>' +
        (x.ensuite ? '<div class="ctx">' + (x.ensuite_type && x.ensuite_type !== 'paragraphe' ? '<span class="kd">' + esc(x.ensuite_type) + '</span> ' : '') + esc(cut(x.ensuite, 220)) + '</div>' : '<div class="ctx">— fin de l’article —</div>') +
        '<div class="cit-meta">' + (x.note ? '✍️ ' + esc(x.note) : '✍️ texte repris tel quel') + (x.pourquoi ? '<br>📍 ' + esc(x.pourquoi) : '') + '</div>';
      if (!fait) corps += '<details class="cit-ed"><summary>Modifier le texte</summary><label>Phrase d’introduction (facultative)</label><textarea class="pin" style="min-height:60px" data-cp="' + k + ':intro">' + esc(x.intro || '') + '</textarea>' +
        '<label>Citation</label><textarea class="pin" style="min-height:90px" data-cp="' + k + ':citation">' + esc(x.citation || '') + '</textarea>' +
        '<label>Attribution</label><input class="pin" data-cp="' + k + ':attribution" value="' + esc(x.attribution || '') + '"><div class="acts"><button data-act="cit-maj" data-i="' + k + '">Voir le résultat</button></div></details>' +
        '<div class="acts"><button class="go" data-act="cit-one" data-id="' + esc(f.fiche_id) + '" data-i="' + k + '"' + (S.busy.marbre ? ' disabled' : '') + '>✅ Insérer celle-ci</button><button data-act="cit-skip" data-i="' + k + '">' + (skip ? '↺ Reprendre' : 'Écarter') + '</button></div>';
      return '<div class="cit open' + (fait ? ' done' : '') + (skip ? ' skip' : '') + '">' + hd + '<div class="cit-b">' + corps + '</div></div>';
    }).join('');
    h += '<div class="acts">' + (reste ? '<button class="go" data-act="cit-all" data-id="' + esc(f.fiche_id) + '"' + (S.busy.marbre ? ' disabled' : '') + '>✅ Tout insérer (' + reste + ')</button>' : '') +
      '<button data-act="cit" data-id="' + esc(f.fiche_id) + '"' + (busy ? ' disabled' : '') + '>↻ Autres propositions</button></div>';
    if (c.done) h += '<p class="lead">✅ Inséré. <a href="' + esc(c.done) + '" target="_blank" rel="noopener">Ouvrir l’article dans Ghost</a></p>';
    return h + chapoBlock(f);
  }
  // Une fois au moins une citation insérée : proposer d'évoquer les experts interviewés dès le début de l'article (partie gratuite),
  // pour montrer le sérieux de l'enquête et donner envie de lire (et de s'abonner). On ajoute une phrase, on ne réécrit rien.
  function expertsCites(aid) {
    return D().fiches.filter(function (x) { return x.article_id === aid && x.statut === 'inséré'; }).map(function (x) { return { nom: x.contact.nom, role: x.contact.role, institution: x.contact.institution }; });
  }
  function chapoBlock(f) {
    var ex = expertsCites(f.article_id), ch = S.chapo && S.chapo.aid === f.article_id ? S.chapo : null;
    if (!ex.length) return '';
    var h = '<div class="chapo"><div class="ch-t">💡 Mettre en avant les interviews dès le début</div><div class="ch-s">' + esc(ex.map(function (x) { return x.nom; }).join(', ')) + ' ' + (ex.length > 1 ? 'sont cités' : 'est cité') + ' dans l’article. Le dire dans les premiers paragraphes (partie gratuite) montre le sérieux de l’enquête et donne envie de lire la suite.</div>';
    if (!ch || !ch.props) return h + '<div class="acts"><button class="go" data-act="chapo" data-id="' + esc(f.fiche_id) + '"' + (S.busy.assistant ? ' disabled' : '') + '>✨ Proposer une mention</button></div></div>';
    h += ch.props.map(function (x, k) {
      var fait = ch.fait[k];
      var bloc = x.mode === 'apres' ? '<div class="ctx">' + esc(x.avant) + '</div><div class="neo"><p>' + esc(x.texte) + '</p></div>' : '<div class="neo"><p>' + esc(x.avant) + ' <mark>' + esc(x.texte) + '</mark></p></div>';
      return '<div class="cit open' + (fait ? ' done' : '') + '"><div class="cit-b" style="padding-top:12px">' + bloc + (x.ensuite ? '<div class="ctx">' + esc(String(x.ensuite).slice(0, 200)) + ' …</div>' : '') +
        '<div class="cit-meta">' + (x.mode === 'apres' ? '➕ nouveau court paragraphe' : '➕ phrase ajoutée à la fin du paragraphe') + (x.pourquoi ? ' · ' + esc(x.pourquoi) : '') + '</div>' +
        '<details class="cit-ed"><summary>Modifier la phrase</summary><textarea class="pin" style="min-height:70px" data-ch="' + k + '">' + esc(x.texte) + '</textarea><div class="acts"><button data-act="cit-maj">Voir le résultat</button></div></details>' +
        '<div class="acts">' + (fait ? '<span class="tag g">✅ ajoutée à l’article</span>' : '<button class="go" data-act="chapo-ok" data-id="' + esc(f.fiche_id) + '" data-i="' + k + '"' + (S.busy.marbre ? ' disabled' : '') + '>✅ Ajouter à l’article</button>') + '</div></div></div>';
    }).join('');
    return h + '<div class="acts"><button data-act="chapo" data-id="' + esc(f.fiche_id) + '"' + (S.busy.assistant ? ' disabled' : '') + '>↻ Autre proposition</button></div></div>';
  }

  // ---------- actions ----------
  function toast(t, bad) { PHL.toast(S.root, t, bad); }
  function pickArt(id) {
    S.art = id; LS.set('wl-article', id); loadDraft();
    var a = art(id); toast('📰 Article en cours : ' + (a ? a.titre : ''));
    render();
    if (S.panel === 'articles' || S.panel === 'marbre') openPanel('assistant');
  }
  // ---------- Pièces (récompenses des rédactrices, calculées côté Supabase sur preuves) ----------
  function chargerPieces() {
    if (typeof pushApi !== 'function') return;
    pushApi({ action: 'pieces' }).then(function (r) {
      if (!r || !r.ok) return;
      var avant = S.pieces, me = D().me.id;
      S.pieces = r;
      var vus = (LS.get('wl-pieces-vues') || '').split(',');
      var neuves = (r.pieces || []).filter(function (p) { return p.membre === me && p.statut === 'acquis' && vus.indexOf(String(p.id)) < 0; });
      if (avant && neuves.length) neuves.forEach(function (p) { fete(p); });
      var anc = {}; ((avant && avant.pieces) || []).forEach(function (p) { anc[p.id] = 1; });
      var nv = avant ? (r.pieces || []).filter(function (p) { return !anc[p.id] && p.statut === 'acquis'; }) : [];
      if (nv.length) { S.caisseAnim = {}; nv.forEach(function (p) { S.caisseAnim[p.membre] = 1; }); setTimeout(function () { S.caisseAnim = null; paintFloor(); }, 2600); }
      paintFloor(); if (S.panel === 'compta') paintPanel();
      LS.set('wl-pieces-vues', (r.pieces || []).filter(function (p) { return p.membre === me; }).map(function (p) { return p.id; }).join(','));
      var tp = S.root && S.root.querySelector('.top'); if (tp) tp.innerHTML = header();
      if (S.doc && (S.doc.kind === 'pieces' || S.doc.kind === 'fiche')) paintDoc();
    }).catch(function () {});
  }
  function totalPieces(id) { return ((S.pieces && S.pieces.totaux) || {})[id] || 0; }
  function pieceDe(fid) { return ((S.pieces && S.pieces.pieces) || []).filter(function (p) { return p.fiche_id === fid; })[0] || null; }
  function verifiee(fid) { return ((S.pieces && S.pieces.verifiees) || []).indexOf(fid) >= 0; }
  function fete(p) {
    var el = document.createElement('div'); el.className = 'fete';
    el.innerHTML = '<div class="fete-c">🪙</div><div class="fete-t">+' + p.montant + ' pièces</div><div class="fete-s">Parcours complet avec ' + esc(p.contact || 'votre contact') + '</div>';
    S.root.appendChild(el); setTimeout(function () { el.classList.add('out'); }, 2600); setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 3200);
  }
  var PST2 = { acquis: ['🪙', 'acquises', 'g'], a_verifier: ['🔍', 'à vérifier par le rédacteur en chef', 'a'], annule: ['✖️', 'annulées', ''], manque: ['⏳', 'créneau manqué', ''] };
  // ---------- Paramètres (21/10/2026) : notifications, signature des mails FR/EN (gras, italique, liens), dictée, mode récompense (chef) ----------
  var WEBMAILS = [['Gmail', ['gmail.com', 'googlemail.com']], ['Outlook / Hotmail / Live', ['outlook.com', 'hotmail.com', 'hotmail.fr', 'live.com', 'live.fr', 'msn.com']], ['Yahoo', ['yahoo.com', 'yahoo.fr']], ['iCloud', ['icloud.com', 'me.com']],
    ['Proton', ['proton.me', 'protonmail.com']], ['GMX / Web.de', ['gmx.com', 'gmx.fr', 'gmx.ch', 'gmx.de', 'web.de']], ['Fournisseurs français (Orange, Free, SFR, La Poste, Wanadoo)', ['orange.fr', 'free.fr', 'sfr.fr', 'laposte.net', 'wanadoo.fr']],
    ['Bluewin (Suisse)', ['bluewin.ch']], ['Autres (AOL, Mail.com, Yandex, Tutanota, Zoho)', ['aol.com', 'mail.com', 'yandex.com', 'tutanota.com', 'zoho.com']]];
  function majTop() { var tp = S.root && S.root.querySelector('.top'); if (tp) tp.innerHTML = header(); }
  // Mode clair / sombre : le même réglage que tout posthumain.com (cookie tlj_theme, piloté par shared/theme-mode.js).
  var THEME = PHL.theme({ root: function () { return S.root; }, classe: 'wl-clair', feuille: 'wl-clair-css', change: function () { try { if (S.data) majTop(); } catch (e) { /* rien */ } } });
  function modeClair() { return THEME.clair(); }
  function appliquerTheme() { THEME.appliquer(); }
  function basculerTheme() { THEME.basculer(); }
  function chargerParams() {
    if (S.paramP) return S.paramP;
    S.paramP = pushApi({ action: 'parametres' }).then(function (r) {
      S.paramP = null;
      if (!r || !r.ok) return;
      S.params = r; S.sigDraft = S.sigDraft || { fr: r.signature.fr, en: r.signature.en };
      return pushApi({ action: 'signatures' }).then(function (x) { if (x && x.ok) S.sigs = x.signatures; if (S.panel === 'parametres') paintPanel(); if (S.doc) paintDoc(); });
    }).catch(function () { S.paramP = null; });
    return S.paramP;
  }
  function sw(act, on, off) { return '<button type="button" class="sw' + (on ? ' on' : '') + '" data-act="' + act + '"' + (off ? ' disabled' : '') + ' aria-pressed="' + (on ? 'true' : 'false') + '"><i></i></button>'; }
  function sigLire() { var e = S.root.querySelector('#wl-sig'); if (e && S.sigDraft) S.sigDraft[S.sigLang || 'fr'] = e.innerHTML; }
  // ================= Engagement de confidentialité (23/10/2026) =================
  // À la première connexion de chaque journaliste : écran plein écran BLOQUANT (pas de fermeture, pas d'Échap, lab flou et inerte
  // derrière). Le serveur (fonction Supabase wl-consent, jeton du membre Ghost) fait foi : il dit si la personne doit signer, donne le
  // texte exact (version + SHA-256), revérifie tout à la signature et horodate avec SON horloge. Aucun drapeau dans le navigateur.
  // Le rédacteur en chef n'est pas concerné ; il consulte les engagements dans Paramètres et peut voir l'écran en aperçu (signature
  // d'essai « test-… », supprimable).
  var CONS_FN = 'https://jfmzhndapfmvdhphuwfm.supabase.co/functions/v1/wl-consent';
  function consApi(b) { return supa(CONS_FN, b); }
  // Horodatage du SERVEUR (signe_le) affiché à l'heure de Zurich : « 23/10/2026 à 03:52:14 ».
  function consDate(iso) {
    try { var f = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Zurich', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(iso)), g = function (t) { return (f.filter(function (x) { return x.type === t; })[0] || {}).value || ''; };
      return g('day') + '/' + g('month') + '/' + g('year') + ' à ' + g('hour') + ':' + g('minute') + ':' + g('second'); } catch (e) { return String(iso || ''); }
  }
  function consNorm(s) { return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[-‐‑’']/g, ' ').replace(/\s+/g, ' ').trim(); }
  // Texte de l'engagement → HTML (titres de parties, points numérotés, paragraphes). La 1re ligne (titre + version) est affichée à part.
  function consTexteHTML(texte) {
    var l = String(texte || '').split('\n').slice(1), h = '', ol = false;
    l.forEach(function (x) {
      var m = x.match(/^(\d{1,2})\.\s+(.*)$/);
      if (m) { if (!ol) { h += '<ol class="cs-ol">'; ol = true; } h += '<li value="' + m[1] + '">' + esc(m[2]) + '</li>'; return; }
      if (ol) { h += '</ol>'; ol = false; }
      if (!x.trim()) return;
      h += x.length < 40 && !/[.:]$/.test(x) ? '<h3 class="cs-h">' + esc(x) + '</h3>' : '<p>' + esc(x) + '</p>';
    });
    return h + (ol ? '</ol>' : '');
  }
  function consVerrou(on) {
    var r = S.root; if (!r) return;
    S.consBloque = !!on; r.classList.toggle('wl-verrou', !!on);
    Array.prototype.forEach.call(r.children, function (c) { if (!c.classList.contains('cs-bg')) { if (on) c.setAttribute('inert', ''); else c.removeAttribute('inert'); } });
    var bg = r.querySelector('.cs-bg');
    if (on && !bg) { bg = document.createElement('div'); bg.className = 'cs-bg'; bg.setAttribute('role', 'dialog'); bg.setAttribute('aria-modal', 'true'); bg.setAttribute('aria-label', 'Engagement de confidentialité'); r.appendChild(bg); }
    if (!on && bg) bg.parentNode.removeChild(bg);
    return bg;
  }
  function consPeindre(html) { var bg = consVerrou(true); bg.innerHTML = html; bg.scrollTop = 0; return bg; }
  // Au chargement : seulement pour les journalistes (le serveur confirme le rôle). Échec réseau = l'écran reste fermé (« Réessayer »).
  function consVerifier(essai) {
    if (D().me.chef) return;
    consPeindre('<div class="cs"><div class="cs-k">🔏 Posthumain · Writinglab</div><p class="muted" style="margin-top:14px">Vérification de votre engagement de confidentialité…</p></div>');
    consApi({ action: 'etat' }).then(function (e) {
      // jeton Ghost expiré ou réseau coupé : un nouvel essai automatique avec un jeton neuf avant d'afficher « Accès en attente »
      if ((!e || !e.ok) && !essai) { setTimeout(function () { consVerifier(true); }, 1200); return; }
      if (!e || !e.ok) { consPeindre('<div class="cs"><div class="cs-k">🔏 Posthumain · Writinglab</div><h1 class="cs-t">Accès en attente</h1><p class="cs-err">⚠️ ' + esc((e && e.why) || 'le serveur ne répond pas') + '.</p><p class="muted">Le Writinglab s’ouvrira dès que votre engagement de confidentialité aura pu être vérifié. Si cela persiste, prévenez Jonathan Paiano.</p><div class="row" style="margin-top:14px"><button type="button" class="btn go" data-cs="reessayer">↻ Réessayer</button></div></div>'); return; }
      if (!e.requis || e.signe) { consVerrou(false); obAuto(e); return; }
      S.consEtat = e; consFormulaire(false);
    });
  }
  function consFormulaire(apercu) {
    var e = S.consEtat; S.consApercu = !!apercu;
    var h = '<div class="cs">' + (apercu ? '<div class="cs-ap"><span>👁️ Aperçu, réservé au rédacteur en chef : la signature sera enregistrée comme <b>test</b>.</span><button type="button" class="btn small" data-cs="quitter">Quitter l’aperçu</button></div>' : '') +
      '<div class="cs-k">🔏 Posthumain · Writinglab · document interne</div><h1 class="cs-t">Engagement de confidentialité</h1><div class="cs-v">' + esc(e.titre) + '</div>' +
      '<div class="cs-x" tabindex="0" aria-label="Texte de l’engagement">' + consTexteHTML(e.texte) + '</div>' +
      '<div class="cs-who">Signataire : <b>' + esc(e.nom) + '</b>' + (e.email ? ' · ' + esc(e.email) : '') + '</div>' +
      '<label class="cs-chk"><input type="checkbox" id="cs-ok"> <span>J’ai lu et j’accepte sans réserve cet engagement de confidentialité</span></label>' +
      '<label class="cs-l" for="cs-nom">Vos prénom et nom</label><input class="cs-in" id="cs-nom" type="text" autocomplete="name" placeholder="Prénom Nom" spellcheck="false">' +
      '<div class="cs-l">Votre signature <span class="muted">(au doigt ou à la souris)</span></div><div class="cs-pad"><canvas id="cs-sig" aria-label="Zone de signature"></canvas><span class="cs-ligne"></span><button type="button" class="btn small cs-eff" data-cs="effacer">Effacer</button></div>' +
      '<p class="cs-err" id="cs-err" role="alert"></p><button type="button" class="btn go cs-go" id="cs-go" data-cs="signer" disabled>✍️ Signer et accéder au lab</button>' +
      '<p class="cs-pied">La date et l’heure de signature sont enregistrées par le serveur de Posthumain, avec votre nom, votre signature, l’empreinte du texte (' + esc(String(e.hash).slice(0, 12)) + '…), l’adresse IP et le navigateur.</p></div>';
    var bg = consPeindre(h);
    consPad(bg.querySelector('#cs-sig'));
    var maj = function () { consValide(); };
    S.consNomVu = false;
    bg.querySelector('#cs-ok').addEventListener('change', maj); bg.querySelector('#cs-nom').addEventListener('input', maj);
    bg.querySelector('#cs-nom').addEventListener('change', function () { S.consNomVu = true; maj(); });
  }
  // Pavé de signature : pointer events (doigt, stylet, souris), trait lissé, épaisseur ~2,6 px ; refus d'un pavé vide ou d'un point.
  function consPad(cv) {
    var dpr = Math.max(1, Math.min(2.5, window.devicePixelRatio || 1)), w = cv.clientWidth || 600, h = cv.clientHeight || 180;
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    var c = cv.getContext('2d'); c.setTransform(dpr, 0, 0, dpr, 0, 0); c.lineCap = 'round'; c.lineJoin = 'round'; c.lineWidth = 2.6; c.strokeStyle = '#14110c';
    S.consSig = { pts: 0, len: 0, cv: cv };
    var bas = false, last = null, pos = function (ev) { var r = cv.getBoundingClientRect(); return { x: ev.clientX - r.left, y: ev.clientY - r.top }; };
    cv.addEventListener('pointerdown', function (ev) { ev.preventDefault(); bas = true; try { cv.setPointerCapture(ev.pointerId); } catch (x) {} last = pos(ev); c.beginPath(); c.arc(last.x, last.y, 1.2, 0, Math.PI * 2); c.fillStyle = '#14110c'; c.fill(); S.consSig.pts++; });
    cv.addEventListener('pointermove', function (ev) {
      if (!bas) return; ev.preventDefault();
      var lot = ev.getCoalescedEvents ? ev.getCoalescedEvents() : []; if (!lot || !lot.length) lot = [ev]; // certains navigateurs renvoient une liste vide
      lot.forEach(function (pe) {
        var p = pos(pe), mx = (last.x + p.x) / 2, my = (last.y + p.y) / 2;
        c.beginPath(); c.moveTo(last.x, last.y); c.quadraticCurveTo(last.x, last.y, mx, my); c.lineTo(p.x, p.y); c.stroke();
        S.consSig.len += Math.hypot(p.x - last.x, p.y - last.y); S.consSig.pts++; last = p;
      });
    });
    var fin = function () { if (bas) { bas = false; consValide(); } };
    cv.addEventListener('pointerup', fin); cv.addEventListener('pointercancel', fin); cv.addEventListener('pointerleave', fin);
  }
  function consValide() {
    var bg = S.root.querySelector('.cs-bg'); if (!bg) return false;
    var e = S.consEtat, ok = bg.querySelector('#cs-ok'), nom = bg.querySelector('#cs-nom'), go = bg.querySelector('#cs-go'), err = bg.querySelector('#cs-err');
    if (!ok || !go) return false;
    var sig = S.consSig || { pts: 0, len: 0 }, nomOk = consNorm(nom.value) === consNorm(e.nom), sigOk = sig.pts >= 20 && sig.len >= 120;
    var v = ok.checked && nomOk && sigOk;
    go.disabled = !v;
    err.textContent = nom.value.trim().length > 3 && !nomOk && (S.consNomVu || consNorm(nom.value).length >= consNorm(e.nom).length) ? 'Le nom tapé ne correspond pas à celui de votre compte.' : (sig.pts && !sigOk ? 'Signature trop courte : signez avec votre signature habituelle.' : '');
    return v;
  }
  function consSigner() {
    if (!consValide()) return;
    var bg = S.root.querySelector('.cs-bg'), e = S.consEtat, go = bg.querySelector('#cs-go'), err = bg.querySelector('#cs-err');
    go.disabled = true; go.textContent = '⏳ Enregistrement de la signature…';
    var tz = ''; try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (x) {}
    consApi({ action: S.consApercu ? 'signer_test' : 'signer', version: e.version, hash: e.hash, accepte: bg.querySelector('#cs-ok').checked === true, nom: bg.querySelector('#cs-nom').value,
      signature: S.consSig.cv.toDataURL('image/png'), fuseau: tz, heure_locale: new Date().toString() }).then(function (r) {
      if (!r || !r.ok) { go.disabled = false; go.textContent = '✍️ Signer et accéder au lab'; err.textContent = '⚠️ ' + ((r && r.why) || 'le serveur ne répond pas, réessayez'); return; }
      var ap = S.consApercu;
      consPeindre('<div class="cs cs-fait">' + (ap ? '<div class="cs-ap"><span>👁️ Aperçu : signature de test enregistrée au nom « ' + esc(r.consentement.journaliste_id) + ' ».</span></div>' : '') +
        '<div class="cs-k">🔏 Posthumain · Writinglab</div><div class="cs-ok-ic">✅</div><h1 class="cs-t">Engagement signé</h1>' +
        '<p class="cs-date">Signé le <b>' + esc(consDate(r.consentement.signe_le)) + '</b> (heure de Zurich)</p>' +
        '<p class="muted">Horodatage enregistré par le serveur de Posthumain · ' + esc(r.consentement.texte_version) + ' · empreinte ' + esc(String(r.consentement.texte_hash).slice(0, 16)) + '…</p>' +
        (ap ? '<div class="row" style="justify-content:center;gap:8px;margin-top:16px"><button type="button" class="btn red" data-cs="suppr-test">🗑️ Supprimer la signature de test</button><button type="button" class="btn" data-cs="quitter">Quitter l’aperçu</button></div>'
          : '<button type="button" class="btn go cs-go" data-cs="entrer">Accéder au lab</button>') + '</div>');
      if (ap) S.consListe = null;
    });
  }
  function consApercu() {
    toast('👁️ Ouverture de l’aperçu…');
    consApi({ action: 'etat' }).then(function (e) { if (!e || !e.ok) { toast('⚠️ ' + ((e && e.why) || 'serveur injoignable'), true); return; } S.consEtat = e; closePanel(); consFormulaire(true); });
  }
  // ---------- Visite guidée (onboarding) des journalistes, 23/10/2026 ----------
  // Bloc autonome (préfixe ob-). Démarre après la signature de l'engagement (ou au chargement si elle a signé mais jamais vu la visite).
  // Étapes GÉNÉRÉES depuis le catalogue (CAT.onboarding.ordre + postes + stations + navigation) : un futur poste y apparaît seul.
  // Lecture seule : aucune action réelle. « Vue » enregistrée côté serveur (wl-consent, réglage onboarding_<membre>) + repli local.
  var OB = null;
  function obCat() { return (CAT && CAT.onboarding) || { version: 'v1', ordre: [], navigation: [] }; }
  function obCle() { return 'wl-onb-' + (D().me.id || ''); }
  function obAuto(e) {
    if (OB || !e || !e.requis || D().me.chef) return;
    var v = obCat().version || 'v1';
    if (e.onboarding === v || LS.get(obCle()) === v) return;
    setTimeout(function () { if (!OB && !S.consBloque) obDemarrer(false); }, 700);
  }
  function obMarquerVue() {
    var v = obCat().version || 'v1';
    LS.set(obCle(), v);
    try { var p = consApi({ action: 'onboarding', valeur: v }); if (p && p.catch) p.catch(function () {}); } catch (e) { /* repli local suffit */ }
  }
  function obListe(items) { return items.length ? '<ul class="ob-ul">' + items.map(function (x) { return '<li>' + x + '</li>'; }).join('') + '</ul>' : ''; }
  function obEtapes(commeJ) {
    var me = D().me, chef = !!me.chef && !commeJ, oc = obCat(), E = [];
    var prenom = String(me.nom || '').split(' ')[0];
    var st = {}, po = {}, ca = {};
    (CAT.stations || []).forEach(function (s) { st[s.id] = s; });
    (CAT.postes || []).forEach(function (p) { po[p.id] = p; });
    (CAT.capacites || []).forEach(function (c) { ca[c.id] = c; });
    var sel = function (k) { return '.floor g.ag[data-ag="' + k + '"]'; };
    E.push({ emoji: '👋', titre: 'Bienvenue au Writinglab' + (prenom && !commeJ ? ', ' + esc(prenom) : ''), cible: null,
      html: '<p>La rédaction virtuelle de Posthumain : des employés IA vous aident à trouver des chercheurs, à leur écrire, à suivre leurs réponses et à placer leurs citations dans vos articles.</p><p>Cette visite dure environ 5 minutes. Vous pouvez la passer et la refaire quand vous voulez depuis ⚙️ Paramètres.</p>' });
    E.push({ emoji: '🏢', titre: 'La rédaction vue de haut', cible: '.floor',
      html: '<p>Chaque pièce est un bureau. Touchez un employé pour ouvrir son panneau. Les fils lumineux montrent le travail en cours : ils s’allument en vert quand quelque chose se passe.</p><p>Vert : au travail ou réponse arrivée · orange : quelque chose vous attend.</p>' });
    var sj = chef ? (st.chef || {}) : (st.journaliste || {});
    var mien = chef ? 'chef' : (commeJ ? ((people().filter(function (p) { return p.kind === 'journaliste' && !p.vide; })[0] || {}).key || '') : 'j:' + me.id);
    E.push({ emoji: chef ? '🧐' : '✍️', titre: 'Votre bureau', cible: mien ? sel(mien) : null,
      html: '<p>' + esc(sj.aide || '') + '</p>' + obListe((sj.actions || []).slice(0, 4).map(esc)) });
    var ordre = (oc.ordre || []).slice(), reserves = [];
    (CAT.postes || []).forEach(function (p) { if (ordre.indexOf(p.id) < 0) ordre.push(p.id); }); // futurs postes : ajoutés tout seuls
    ordre.forEach(function (id) {
      var p = po[id], s = st[id];
      if (p) {
        if (p.acces === 'chef' && !chef) { reserves.push(p); return; }
        var cs = (p.capacites || []).map(function (c) { return ca[c]; }).filter(function (c) { return c && c.id !== 'ouvrir' && (chef || c.droits !== 'chef'); });
        E.push({ emoji: p.emoji, titre: p.nom, cible: sel(id),
          html: '<p>' + esc(p.aide || '') + '</p>' + obListe(cs.map(function (c) { return '<b>' + esc(c.nom) + '</b><span class="ob-d"> : ' + esc(c.aide || '') + '</span>'; })) +
            (p.exemples && p.exemples[0] ? '<p class="ob-ex">☎️ Au téléphone, par exemple : « ' + esc(p.exemples[0]) + ' »</p>' : '') });
      } else if (s) {
        var lect = !chef && (id === 'radar' || id === 'marbre');
        E.push({ emoji: s.emoji, titre: s.nom, cible: sel(id),
          html: '<p>' + esc(s.aide || '') + '</p>' + obListe((s.actions || []).slice(0, 4).map(esc)) +
            (lect ? '<p class="ob-note">👀 Pour vous, en lecture : les décisions sont prises par le rédacteur en chef.</p>' : '') });
      }
    });
    if (reserves.length) E.push({ emoji: '🧐', titre: 'Les postes du rédacteur en chef', cible: sel('chef'),
      html: '<p>' + reserves.map(function (p) { return p.emoji + ' ' + esc(p.nom); }).join(', ') + ' et le bureau du rédacteur en chef : vous les voyez sur le plan, mais ils sont réservés au rédacteur en chef.</p>' });
    (oc.navigation || []).forEach(function (n) { if (n.acces === 'chef' && !chef) return; E.push({ emoji: n.emoji, titre: n.titre, cible: n.cible, html: '<p>' + esc(n.texte) + '</p>' }); });
    E.push({ emoji: '🚀', titre: 'À vous de jouer !', cible: null,
      html: '<p>Pour commencer : onglet 📰 Articles, choisissez votre article et touchez « ⚡ Préparer les interviews ». Vous validez chaque mail avant l’envoi.</p><p>Une question ? Le ⓘ de chaque salle, ou l’Interphone.</p>' });
    return E;
  }
  function obEl(cls) { var d = document.createElement('div'); d.className = cls; return d; }
  function obDemarrer(commeJ) {
    obFermer();
    var r = S.root; if (!r || !D().me) return;
    try { if (S.tab !== 'bureau') { S.tab = 'bureau'; render(); } closePanel(); closeDoc(); if (S.clsr) { S.clsr = false; majClasseur(); } } catch (e) { /* rien */ }
    masquerTip();
    var etapes = obEtapes(commeJ).filter(function (s) { return !s.cible || r.querySelector(s.cible); });
    var voile = obEl('ob-voile'), trou = obEl('ob-trou'), carte = obEl('ob-carte');
    carte.setAttribute('role', 'dialog'); carte.setAttribute('aria-modal', 'true'); carte.setAttribute('aria-label', 'Visite guidée du Writinglab'); carte.tabIndex = -1;
    var inertes = [];
    Array.prototype.forEach.call(r.children, function (c) { if (!c.hasAttribute('inert')) { c.setAttribute('inert', ''); inertes.push(c); } });
    r.appendChild(voile); r.appendChild(trou); r.appendChild(carte);
    OB = { i: 0, e: etapes, voile: voile, trou: trou, carte: carte, inertes: inertes, commeJ: !!commeJ, raf: 0, t: 0, passer: false, el: null };
    OB.pos = function () { if (!OB) return; cancelAnimationFrame(OB.raf); OB.raf = requestAnimationFrame(obPlacer); };
    OB.key = function (e) {
      if (!OB) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (OB.passer) obFin(true); else { OB.passer = true; obCarte(); } }
      else if (e.key === 'ArrowRight' && !OB.passer) { e.preventDefault(); obAller(OB.i + 1); }
      else if (e.key === 'ArrowLeft' && !OB.passer) { e.preventDefault(); obAller(OB.i - 1); }
    };
    window.addEventListener('resize', OB.pos); window.addEventListener('scroll', OB.pos, true); document.addEventListener('keydown', OB.key, true);
    carte.addEventListener('click', obClic);
    voile.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); });
    obAller(0);
  }
  function obAller(i) {
    if (!OB) return;
    if (i >= OB.e.length) { obFin(false); return; }
    OB.i = Math.max(0, i); OB.passer = false;
    var s = OB.e[OB.i], el = s.cible ? S.root.querySelector(s.cible) : null;
    OB.el = el;
    var doux = !(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
    if (el) { try { el.scrollIntoView({ block: 'center', inline: 'center', behavior: doux ? 'smooth' : 'auto' }); } catch (e) { try { el.scrollIntoView(); } catch (x) {} } }
    obCarte(); obPlacer();
    clearTimeout(OB.t); OB.t = setTimeout(obPlacer, doux ? 450 : 60);
  }
  function obCarte() {
    if (!OB) return;
    var n = OB.e.length, s = OB.e[OB.i], c = OB.carte, dern = OB.i === n - 1;
    c.innerHTML = '<div class="ob-tete"><span class="ob-em">' + s.emoji + '</span><span class="ob-n">' + (OB.i + 1) + ' / ' + n + '</span>' +
      (OB.commeJ ? '<span class="ob-ap">apercu journaliste</span>' : '') + '<button type="button" class="ob-x" data-ob="passer" aria-label="Passer la visite">✕</button></div>' +
      '<div class="ob-barre"><i style="width:' + Math.round((OB.i + 1) / n * 100) + '%"></i></div>' +
      '<h2 class="ob-t">' + s.titre + '</h2><div class="ob-c">' + s.html + '</div>' +
      (OB.passer
        ? '<div class="ob-conf">Passer la visite ? Vous pourrez la refaire depuis ⚙️ Paramètres.<div class="ob-b"><button type="button" class="ob-btn" data-ob="rester">Continuer la visite</button><button type="button" class="ob-btn ob-go" data-ob="fin">Passer</button></div></div>'
        : '<div class="ob-b"><button type="button" class="ob-lien" data-ob="passer">Passer</button><span class="ob-sp"></span>' +
          (OB.i ? '<button type="button" class="ob-btn" data-ob="prec">← Précédent</button>' : '') +
          '<button type="button" class="ob-btn ob-go" data-ob="suiv">' + (dern ? 'Terminer ✓' : 'Suivant →') + '</button></div>');
    c.scrollTop = 0;
    var go = c.querySelector(OB.passer ? '[data-ob="rester"]' : '[data-ob="suiv"]'); if (go) try { go.focus({ preventScroll: true }); } catch (e) { go.focus(); }
  }
  function obClic(e) {
    var b = e.target.closest && e.target.closest('[data-ob]'); e.stopPropagation(); if (!b || !OB) return;
    var a = b.getAttribute('data-ob');
    if (a === 'suiv') obAller(OB.i + 1); else if (a === 'prec') obAller(OB.i - 1);
    else if (a === 'passer') { OB.passer = true; obCarte(); obPlacer(); } else if (a === 'rester') { OB.passer = false; obCarte(); obPlacer(); }
    else if (a === 'fin') obFin(true);
  }
  function obPlacer() {
    if (!OB) return;
    var el = OB.el, t = OB.trou, c = OB.carte, W = window.innerWidth, H = window.innerHeight;
    var r = el && el.getBoundingClientRect ? el.getBoundingClientRect() : null;
    if (r && r.width > 0 && r.height > 0) {
      var p = 8, x = Math.max(4, r.left - p), y = Math.max(4, r.top - p), x2 = Math.min(W - 4, r.right + p), y2 = Math.min(H - 4, r.bottom + p);
      t.style.left = x + 'px'; t.style.top = y + 'px'; t.style.width = Math.max(0, x2 - x) + 'px'; t.style.height = Math.max(0, y2 - y) + 'px';
      t.classList.add('on'); OB.voile.classList.remove('plein');
      var cw = c.offsetWidth || 380, ch = c.offsetHeight || 260, bas = H - ch - 16;
      c.classList.toggle('haut', W > 640 && r.bottom > bas && r.right > W - cw - 24 && r.top > ch + 24);
    } else { t.classList.remove('on'); OB.voile.classList.add('plein'); c.classList.remove('haut'); }
  }
  function obFin(passe) {
    if (!OB) return;
    var apercu = OB.commeJ, chef = !!D().me.chef;
    obFermer();
    if (!apercu && !chef) obMarquerVue();
    if (!passe) toast(apercu ? '🎓 Fin de l’apercu de la visite.' : '🎓 Visite terminée : bon travail !');
  }
  function obFermer() {
    if (!OB) return;
    var o = OB; OB = null;
    cancelAnimationFrame(o.raf); clearTimeout(o.t);
    window.removeEventListener('resize', o.pos); window.removeEventListener('scroll', o.pos, true); document.removeEventListener('keydown', o.key, true);
    o.carte.removeEventListener('click', obClic);
    [o.voile, o.trou, o.carte].forEach(function (n) { if (n.parentNode) n.parentNode.removeChild(n); });
    o.inertes.forEach(function (c) { c.removeAttribute('inert'); });
  }
  function consClic(t) {
    var a = t.getAttribute('data-cs');
    if (a === 'effacer') { var cv = S.consSig && S.consSig.cv; if (cv) { cv.getContext('2d').clearRect(0, 0, cv.width, cv.height); S.consSig.pts = 0; S.consSig.len = 0; consValide(); } }
    else if (a === 'signer') consSigner();
    else if (a === 'reessayer') consVerifier();
    else if (a === 'entrer') { consVerrou(false); obAuto(S.consEtat || { requis: true }); }
    else if (a === 'quitter' && S.consApercu) { S.consApercu = false; consVerrou(false); if (D().me.chef) openPanel('parametres'); }
    else if (a === 'suppr-test') consApi({ action: 'supprimer_test' }).then(function (r) { toast(r && r.ok ? '🗑️ ' + r.supprimes + ' signature' + pl(r.supprimes) + ' de test supprimée' + pl(r.supprimes) + '.' : '⚠️ ' + ((r && r.why) || 'impossible'), !(r && r.ok)); S.consListe = null; });
  }
  // ---------- Boîtes mail de la rédaction (23/10/2026) ----------
  // Rédacteur en chef : ajouter une adresse gérée par le système (Infomaniak, OVHcloud), la tester, l'assigner à un bureau.
  // Fonction wl-boites : le mot de passe part UNE fois vers le serveur (test, puis enregistrement), est rangé dans Supabase Vault
  // et n'est jamais renvoyé ; il ne reste ici qu'en mémoire le temps de l'assistant (jamais dans le stockage du navigateur).
  // Les 4 boîtes @posthumain.com historiques restent configurées comme avant (lecture seule ici, badge « système »).
  var BX_FN = 'https://jfmzhndapfmvdhphuwfm.supabase.co/functions/v1/wl-boites';
  function bxApi(b) { return supa(BX_FN, b); }
  function chargerBoites() {
    if (S.bxLd) return; S.bxLd = true;
    bxApi({ action: 'liste' }).then(function (r) { S.bxLd = false; S.bxListe = r || { ok: false, why: 'réponse vide' }; if (S.panel === 'parametres') paintPanel(); });
  }
  function bxFourn() { return (S.bxListe && S.bxListe.fournisseurs) || {}; }
  function bxRoles() { return (S.bxListe && S.bxListe.roles) || []; }
  function bxRoleNom(id) { var r = bxRoles().filter(function (x) { return x.id === id; })[0]; return r ? r.nom : (id || 'aucun rôle'); }
  function bxPreremplir() {
    var W = S.bxW; if (!W) return;
    var f = bxFourn()[W.fournisseur], o = f && f.offres[W.offre];
    if (!o) return;
    var n = String(W.numero || '1').replace(/\D/g, '') || '1', h = function (x) { return o.numero ? x.replace(/pro\d+\./, 'pro' + n + '.') : x; };
    W.imap_host = h(o.imap_host); W.imap_port = String(o.imap_port); W.smtp_host = h(o.smtp_host); W.smtp_port = String(o.smtp_port); W.test = null;
  }
  function bxCfg() { var W = S.bxW || {}; return { adresse: String(W.adresse || '').trim(), fournisseur: W.fournisseur, offre: W.offre, identifiant: String(W.identifiant || '').trim(), imap_host: String(W.imap_host || '').trim(), imap_port: Number(W.imap_port), smtp_host: String(W.smtp_host || '').trim(), smtp_port: Number(W.smtp_port), mdp: String(W.mdp || '') }; }
  function bxQuand(iso) { return iso ? when(iso) : '—'; }
  function bxEtat(b) {
    if (!b.actif) return '<span class="tag">⏸️ désactivée</span>';
    if (b.statut === 'erreur') return '<span class="tag r">⚠️ erreur depuis ' + esc(bxQuand(b.erreur_depuis)) + '</span>';
    if (b.statut === 'ok') return '<span class="tag g">✅ connectée</span>';
    return '<span class="tag a">⏳ en attente</span>';
  }
  function bxSection() {
    var L = S.bxListe;
    var h = '<div class="set" id="wl-boites"><div class="set-h"><div><b>✉️ Boîtes mail de la rédaction</b><div class="set-s">Ajoutez une adresse gérée par le lab et confiez-la à un bureau : le Courrier la relève toutes les 2 minutes et le bureau répond depuis elle.</div></div></div>' +
      '<div class="row" style="gap:8px;margin:10px 0 4px;flex-wrap:wrap">' + (S.bxW ? '' : '<button class="btn small go" data-act="bx-ajouter">➕ Ajouter une boîte</button>') + '<button class="btn small" data-act="bx-recharger">↻ Actualiser</button></div>';
    if (!L) { chargerBoites(); return h + '<p class="muted">Chargement…</p></div>'; }
    if (!L.ok) return h + '<p class="muted">⚠️ ' + esc(L.why || 'indisponible') + '</p></div>';
    if (S.bxW) h += bxAssistant();
    h += (L.boites || []).map(function (b) {
      var ed = S.bxEdit && S.bxEdit.id === b.id ? S.bxEdit.quoi : '';
      var f = bxFourn()[b.fournisseur], off = f && f.offres[b.offre];
      var x = '<div class="bx-m' + (b.actif ? '' : ' off') + '"><div class="bx-h"><div class="bx-i"><b>' + esc(b.adresse) + '</b> ' + bxEtat(b) +
        '<div class="set-s">🎯 ' + esc(bxRoleNom(b.role)) + (b.nom_affiche ? ' · expéditeur « ' + esc(b.nom_affiche) + ' »' : '') + '<br>' + esc((f ? f.nom : b.fournisseur) + (off ? ' · ' + off.nom : '')) + ' · ' + esc(b.imap_host) + ' / ' + esc(b.smtp_host) +
        '<br>Dernière relève : ' + esc(bxQuand(b.derniere_releve)) + ' · dernier test : ' + esc(bxQuand(b.dernier_test)) + '</div>' +
        (b.statut === 'erreur' && b.derniere_erreur ? '<div class="bx-err">' + esc(b.derniere_erreur) + '</div>' : '') + '</div>' +
        '<div class="row bx-b"><button class="btn small" data-act="bx-retester" data-id="' + esc(b.id) + '">🔄 Re-tester</button><button class="btn small" data-act="bx-mdp" data-id="' + esc(b.id) + '">🔑 Mot de passe</button><button class="btn small" data-act="bx-changer-role" data-id="' + esc(b.id) + '">🎯 Rôle</button>' +
        '<button class="btn small' + (b.actif ? ' red' : ' go') + '" data-act="bx-actif" data-id="' + esc(b.id) + '" data-on="' + (b.actif ? '0' : '1') + '">' + (b.actif ? '⏸️ Désactiver' : '▶️ Réactiver') + '</button>' + (b.actif ? '' : '<button class="btn small red" data-act="bx-supprimer" data-id="' + esc(b.id) + '">🗑️ Supprimer</button>') + '</div></div>';
      if (ed === 'mdp') x += '<div class="bx-f"><label for="bx-nmdp">Nouveau mot de passe de ' + esc(b.adresse) + '</label><input class="in" id="bx-nmdp" type="password" autocomplete="new-password" spellcheck="false"><div class="set-s">Il est d’abord testé (IMAP et SMTP, aucun mail envoyé) ; l’ancien reste en place s’il est refusé.</div><div class="row" style="gap:8px;margin-top:8px"><button class="btn go" data-act="bx-mdp-ok" data-id="' + esc(b.id) + '">Tester et enregistrer</button><button class="btn small" data-act="bx-mdp" data-id="' + esc(b.id) + '">Annuler</button></div></div>';
      if (ed === 'role') x += '<div class="bx-f"><label for="bx-nrole">Bureau</label><select class="in" id="bx-nrole">' + bxRoles().map(function (r) { return '<option value="' + esc(r.id) + '"' + (r.id === b.role ? ' selected' : '') + (r.actif ? '' : ' disabled') + '>' + esc(r.nom + (r.actif ? '' : ' — bientôt')) + '</option>'; }).join('') + '</select>' +
        '<label for="bx-nnom">Nom de l’expéditeur</label><input class="in" id="bx-nnom" value="' + esc(b.nom_affiche || '') + '" placeholder="ex. Trust Medias"><div class="row" style="gap:8px;margin-top:8px"><button class="btn go" data-act="bx-role-ok" data-id="' + esc(b.id) + '">Enregistrer</button><button class="btn small" data-act="bx-changer-role" data-id="' + esc(b.id) + '">Annuler</button></div></div>';
      return x + '</div>';
    }).join('');
    h += '<div class="bx-t">Boîtes système</div>' + (L.legacy || []).map(function (b) {
      return '<div class="bx-m sys"><div class="bx-h"><div class="bx-i"><b>' + esc(b.adresse) + '</b> <span class="tag bx-sys">système</span><div class="set-s">🎯 ' + esc(b.role) + '<br>' + esc(b.fournisseur) + ' · relève ' + esc(b.releve) + ' · envoi ' + esc(b.envoi) + (b.dernier_mail ? '<br>Dernier mail reçu : ' + esc(when(b.dernier_mail)) : '') + '</div></div></div></div>';
    }).join('') + '<div class="set-s" style="margin-top:6px">Les boîtes système restent configurées comme avant (secrets Supabase et relève n8n) : rien à refaire.</div>';
    return h + '</div>';
  }
  function bxAssistant() {
    var W = S.bxW, F = bxFourn(), et = W.etape;
    var pas = ['Adresse', 'Vérification', 'Rôle', 'Finaliser'];
    var h = '<div class="bx-w"><div class="bx-steps">' + pas.map(function (p, i) { return '<span class="' + (i + 1 === et ? 'on' : i + 1 < et ? 'ok' : '') + '">' + (i + 1 < et ? '✓' : i + 1) + ' · ' + p + '</span>'; }).join('') + '</div>';
    if (et === 1) {
      var f = F[W.fournisseur] || { offres: {} }, o = f.offres[W.offre] || {};
      h += '<label for="bx-adresse">Adresse e-mail</label><input class="in" id="bx-adresse" type="email" autocomplete="off" spellcheck="false" placeholder="ex. info@trustmedias.com" value="' + esc(W.adresse || '') + '">' +
        '<label>Fournisseur</label><div class="bx-choix">' + Object.keys(F).map(function (k) { return '<button type="button" class="bx-c' + (W.fournisseur === k ? ' on' : '') + '" data-act="bx-fourn" data-id="' + esc(k) + '">' + esc(F[k].nom) + '</button>'; }).join('') + '</div>';
      var offres = Object.keys(f.offres || {});
      if (offres.length > 1) h += '<label>Offre</label><div class="bx-choix">' + offres.map(function (k) { return '<button type="button" class="bx-c' + (W.offre === k ? ' on' : '') + '" data-act="bx-offre" data-id="' + esc(k) + '">' + esc(f.offres[k].nom) + '</button>'; }).join('') + '</div>';
      if (o.numero) h += '<label for="bx-numero">Numéro du serveur Email Pro (pro1, pro2…)</label><input class="in" id="bx-numero" inputmode="numeric" value="' + esc(W.numero || '1') + '" style="width:90px">';
      if (o.note) h += '<div class="set-s bx-note">' + esc(o.note) + '</div>';
      h += '<label for="bx-mdp">Mot de passe de la boîte</label><input class="in" id="bx-mdp" type="password" autocomplete="new-password" spellcheck="false" value="' + esc(W.mdp || '') + '">' +
        '<div class="set-s">Testé puis rangé chiffré dans le coffre Supabase (Vault). Il ne sera plus jamais affiché, ni ici ni ailleurs.</div>' +
        '<details class="bx-av"' + (W.avance ? ' open' : '') + '><summary>Réglages avancés (serveurs et ports)</summary><div class="bx-2"><div><label for="bx-imap_host">Serveur IMAP (réception)</label><input class="in" id="bx-imap_host" value="' + esc(W.imap_host || '') + '"></div><div><label for="bx-imap_port">Port</label><select class="in" id="bx-imap_port">' + ['993', '143'].map(function (p) { return '<option' + (String(W.imap_port) === p ? ' selected' : '') + '>' + p + '</option>'; }).join('') + '</select></div></div>' +
        '<div class="bx-2"><div><label for="bx-smtp_host">Serveur SMTP (envoi)</label><input class="in" id="bx-smtp_host" value="' + esc(W.smtp_host || '') + '"></div><div><label for="bx-smtp_port">Port</label><select class="in" id="bx-smtp_port">' + ['465', '587'].map(function (p) { return '<option' + (String(W.smtp_port) === p ? ' selected' : '') + '>' + p + '</option>'; }).join('') + '</select></div></div>' +
        '<label for="bx-identifiant">Identifiant de connexion (si différent de l’adresse)</label><input class="in" id="bx-identifiant" autocomplete="off" value="' + esc(W.identifiant || '') + '" placeholder="l’adresse e-mail"><div class="set-s">993 et 465 = connexion chiffrée SSL. Le port 587 est refusé par l’hébergement du lab.</div></details>' +
        '<div class="row bx-nav"><button class="btn small" data-act="bx-annuler">Annuler</button><button class="btn go" data-act="bx-tester">🔌 Vérifier la connexion →</button></div>';
    } else if (et === 2) {
      var T = W.test;
      var ligne = function (nom, r, okTxt) { return '<div class="bx-r ' + (!r ? 'enc' : r.ok ? 'ok' : 'ko') + '"><b>' + (!r ? '⏳' : r.ok ? '✅' : '❌') + ' ' + nom + '</b><div>' + esc(!r ? 'connexion en cours…' : r.ok ? okTxt : r.why) + '</div></div>'; };
      h += '<div class="bx-adr">' + esc(W.adresse) + ' · ' + esc(W.imap_host) + ' / ' + esc(W.smtp_host) + '</div>' +
        ligne('Réception (IMAP)', T && (T.imap || T.erreur), T && T.imap && T.imap.ok ? 'Connexion acceptée : ' + T.imap.dossiers + ' dossier' + pl(T.imap.dossiers) + ' lus' + (T.imap.envoyes ? ', dossier « Envoyés » trouvé.' : '.') : '') +
        ligne('Envoi (SMTP)', T && (T.smtp || T.erreur), 'Authentification acceptée (aucun mail envoyé).');
      h += '<div class="row bx-nav"><button class="btn small" data-act="bx-etape" data-id="1">← Corriger</button>' + (T && T.ok ? '<button class="btn go" data-act="bx-etape" data-id="3">Choisir le rôle →</button>' : T ? '<button class="btn" data-act="bx-tester">↻ Réessayer</button>' : '') + '</div>';
    } else if (et === 3) {
      h += '<label>À quel bureau confier cette boîte ?</label><div class="bx-roles">' + bxRoles().map(function (r) {
        return '<button type="button" class="bx-role' + (W.role === r.id ? ' on' : '') + (r.actif ? '' : ' bientot') + '"' + (r.actif ? ' data-act="bx-role" data-id="' + esc(r.id) + '"' : ' disabled') + '><b>' + esc(r.nom) + '</b>' + (r.actif ? '' : ' <span class="tag">bientôt</span>') + '<span>' + esc(r.detail || '') + '</span></button>';
      }).join('') + '</div>' +
        '<label for="bx-nom_affiche">Nom de l’expéditeur</label><input class="in" id="bx-nom_affiche" value="' + esc(W.nom_affiche || '') + '" placeholder="ex. Trust Medias"><div class="set-s">Ce que voit le destinataire : « ' + esc(W.nom_affiche || 'Trust Medias') + ' &lt;' + esc(W.adresse) + '&gt; ».</div>' +
        '<div class="row bx-nav"><button class="btn small" data-act="bx-etape" data-id="2">← Retour</button><button class="btn go" data-act="bx-etape" data-id="4"' + (W.role ? '' : ' disabled data-off="1"') + '>Récapitulatif →</button></div>';
    } else {
      var f4 = F[W.fournisseur] || { nom: W.fournisseur, offres: {} }, o4 = f4.offres[W.offre];
      var lignes = [['Adresse', W.adresse], ['Fournisseur', f4.nom + (o4 ? ' · ' + o4.nom : '')], ['Réception', W.imap_host + ':' + W.imap_port + ' (IMAP, SSL)'], ['Envoi', W.smtp_host + ':' + W.smtp_port + ' (SMTP, SSL)'], ['Bureau', bxRoleNom(W.role)], ['Expéditeur', (W.nom_affiche || '(adresse seule)') + ' <' + W.adresse + '>'], ['Mot de passe', 'vérifié · rangé chiffré dans le coffre (Vault)']];
      h += '<table class="bx-recap">' + lignes.map(function (l) { return '<tr><td>' + esc(l[0]) + '</td><td>' + esc(l[1]) + '</td></tr>'; }).join('') + '</table>' +
        '<div class="set-s">Après l’enregistrement, le Courrier relève la boîte toutes les 2 minutes (premier passage : les 3 derniers jours, 15 mails au plus) et range chaque demande chez ' + esc(bxRoleNom(W.role)) + '. Rien n’est supprimé ni marqué comme lu dans la boîte.</div>' +
        '<div class="row bx-nav"><button class="btn small" data-act="bx-etape" data-id="3">← Retour</button><button class="btn go" data-act="bx-enregistrer">✅ Enregistrer la boîte</button></div>';
    }
    return h + '</div>';
  }
  function bxTester() {
    var c = bxCfg();
    if (!/^[^\s@<>]+@[^\s@<>]+\.[a-z]{2,}$/i.test(c.adresse)) { toast('⚠️ Adresse e-mail invalide.', true); return; }
    if (!c.mdp) { toast('⚠️ Tapez le mot de passe de la boîte.', true); return; }
    var W = S.bxW; W.etape = 2; W.test = null; paintPanel();
    bxApi(Object.assign({ action: 'tester' }, c)).then(function (r) {
      if (!S.bxW) return;
      S.bxW.test = r && (r.imap || r.smtp) ? r : { ok: false, erreur: { ok: false, why: (r && r.why) || 'le serveur du lab ne répond pas' } };
      paintPanel();
    });
  }
  function bxEnregistrer() {
    var W = S.bxW; if (!W) return;
    var b = Object.assign({ action: 'enregistrer', role: W.role, nom_affiche: String(W.nom_affiche || '').trim() }, bxCfg());
    bxApi(b).then(function (r) {
      if (!r || !r.ok) { toast('⚠️ ' + ((r && r.why) || 'enregistrement impossible'), true); return; }
      toast('✉️ ' + W.adresse + ' enregistrée et confiée à ' + bxRoleNom(W.role) + '. Première relève dans 2 minutes au plus.');
      S.bxW = null; S.bxListe = null; paintPanel(); refresh(true);
    });
  }
  function bxAction(b, ok) {
    bxApi(b).then(function (r) {
      if (!r || !r.ok) { toast('⚠️ ' + ((r && r.why) || 'impossible'), true); return; }
      if (b.action === 'retester') { var T = r.test || {}; toast(T.ok ? '✅ Connexion vérifiée : réception et envoi acceptés.' : '⚠️ ' + [T.imap && !T.imap.ok ? T.imap.why : '', T.smtp && !T.smtp.ok ? T.smtp.why : ''].filter(Boolean).join(' '), !T.ok); }
      else if (ok) toast(ok);
      S.bxEdit = null; S.bxListe = null; paintPanel(); if (b.action === 'role') refresh(true);
    });
  }
  function bxActif(id, actif) {
    var b = ((S.bxListe || {}).boites || []).filter(function (x) { return x.id === id; })[0]; if (!b) return;
    var ck = S.clicking;
    confirmer(actif ? 'Réactiver ' + b.adresse + ' ?\n\nLe Courrier recommence à la relever et ' + bxRoleNom(b.role) + ' peut de nouveau répondre depuis elle.' : 'Désactiver ' + b.adresse + ' ?\n\nElle n’est plus relevée et plus aucune réponse ne part depuis elle. Son mot de passe reste dans le coffre et son courrier déjà reçu reste visible ; vous pourrez la réactiver.').then(function (ok) {
      if (!ok) return; S.clicking = ck;
      bxAction({ action: 'actif', id: id, actif: actif }, actif ? '▶️ ' + b.adresse + ' réactivée.' : '⏸️ ' + b.adresse + ' désactivée.');
    });
  }
  function bxSupprimer(id) {
    var b = ((S.bxListe || {}).boites || []).filter(function (x) { return x.id === id; })[0]; if (!b) return;
    var ck = S.clicking;
    confirmer('Supprimer ' + b.adresse + ' du lab ?\n\nSes réglages et son mot de passe (coffre Vault) sont effacés définitivement. Le courrier déjà reçu reste visible. La boîte elle-même, chez le fournisseur, n’est pas touchée.').then(function (ok) {
      if (!ok) return; S.clicking = ck;
      bxAction({ action: 'supprimer', id: id }, '🗑️ ' + b.adresse + ' supprimée du lab.');
    });
  }
  // ================= Catalogue unique (23/10/2026) =================
  // Les postes (employés IA) et leurs capacités sont déclarés UNE fois dans shared/wl-catalogue.json, recopié ci-dessous par
  // « node scripts/wl-catalogue.mjs --ecrire » (ne pas modifier à la main). Un poste déclaré obtient automatiquement : son ☎️ et sa
  // dictée, sa place dans l'aiguillage de wl-tel, son bureau sur le plan (s'il a un emplacement, sinon la liste « Autres postes »),
  // ses bulles d'activité, un panneau et ses droits. Une capacité s'exécute par son « exécuteur » (api, wl-tel ou fonction de page).
  var WL_CATALOGUE = /*CATALOGUE-DEBUT*/{"_lisezmoi":"CATALOGUE UNIQUE du Writinglab : les postes (employés IA) et leurs capacités. Source unique, lue par la page (copie intégrée dans writinglab/app.js) et par wl-tel (module généré supabase/functions/wl-tel/catalogue.ts). Après une modification : node scripts/wl-catalogue.mjs --ecrire (recopie) puis node scripts/wl-catalogue.mjs (test). Voir CONTRIBUTING-writinglab.md. Base de connaissances : « connaissances » liste les domaines (un onglet chacun dans Paramètres → Base de connaissances ; « defaut » = fiches GitHub writinglab/connaissances/ de pré-remplissage) ; chaque poste déclare le sien dans « connaissances » (ou null) et le reçoit au moment d'agir.","version":1,"postes":[{"id":"secretaire","connaissances":"redaction","nom":"La Secrétaire","emoji":"📮","couleur":"#4aa8d8","acces":"tous","titre":"Rédige, fait valider, envoie","role":"Tu rédiges TOUS les mails aux contacts d'interview (chercheurs, experts, toute personne qui a une fiche) : le premier mail de demande d'interview, les relances, et les réponses dans le fil d'une fiche (remercier, proposer un appel ou une autre formule, fixer un rendez-vous, demander une précision, donner notre numéro). Chaque mail arrive « à valider » dans la fiche : rien ne part sans le clic « Valider et envoyer » du membre. Tu suis aussi l'état des fiches (à valider, envoyé, a répondu, citée).","aide":"Elle écrit tous les mails aux personnes que vous interviewez : la demande d'interview, les relances et les réponses dans le fil. Chaque mail vous attend dans la fiche : rien ne part sans votre « Valider et envoyer ».","exemples":["Écris à Marie Dupont de l'EPFL pour lui demander une interview sur cet article.","Réponds à M. Schwab pour le remercier et lui proposer un appel demain à 10 h.","Donne notre numéro à Mme Martin pour qu'elle nous rappelle."],"aiguillage":"tout mail à écrire à un contact d'interview, un chercheur ou une personne qui a une fiche : premier mail, relance, réponse dans le fil (remercier, proposer un appel, fixer un rendez-vous, demander une précision, donner notre numéro)","contexte":["fiches"],"mail":null,"plan":{"x":1100,"y":215,"teinte":200},"capacites":["rediger_interview","suite_interview","ouvrir"]},{"id":"assistant","connaissances":"redaction","nom":"L’Assistant","emoji":"🧠","couleur":"#9a6bd8","acces":"tous","titre":"Questions et contacts","role":"Tu lis l'article en cours, tu proposes qui interroger (recherche des chercheurs et de leur adresse publiée) et quelles questions poser. Quand un contact a répondu (par mail, par téléphone, ou d'après les notes d'un membre), tu structures sa réponse : un résumé et la réponse à chaque question de la fiche, à enregistrer dans la fiche après validation. Tu proposes ensuite les citations à placer dans l'article (le membre valide chaque emplacement avant l'insertion dans Ghost).","aide":"Il cherche qui interroger, prépare les questions, met en forme les réponses reçues (par mail, au téléphone ou d'après vos notes) et propose où placer les citations dans l'article.","exemples":["Trouve-moi des chercheurs à interroger pour cet article.","Prépare des questions pour Jean Martin, sociologue à l'UNIL.","M. Schwab m'a répondu au téléphone : il pense que… Enregistre sa réponse dans sa fiche."],"aiguillage":"trouver qui interroger, préparer les questions, structurer la réponse d'un contact (reçue par mail, au téléphone ou d'après des notes) et proposer les citations dans l'article","contexte":["fiches"],"mail":null,"plan":{"x":1460,"y":215,"teinte":265},"capacites":["chercher_contacts","questions","reponse_fiche","citations","ouvrir"]},{"id":"mk","connaissances":"marketing","nom":"Julien · Marketing","emoji":"📣","couleur":"#e0763a","acces":"chef","titre":"redaction@posthumain.com","role":"Tu gères UNIQUEMENT le courrier de redaction@posthumain.com (et des boîtes confiées au Marketing), c'est-à-dire les mails présents dans « courrier » du contexte : partenariats, articles sponsorisés, publicité, presse. Tu rédiges une proposition de réponse à un mail reçu : elle reste en brouillon, le rédacteur en chef la relit et l'envoie lui-même (« Valider et envoyer »). Tu suis aussi les campagnes de prospection. Les contacts d'interview (personnes qui ont une fiche) ne sont jamais pour toi.","aide":"Julien traite le courrier de redaction@posthumain.com : partenariats, publicité, articles sponsorisés, presse, et la prospection. Il prépare des réponses que le rédacteur en chef relit et envoie.","exemples":["Réponds à l'agence qui propose un article sponsorisé : pas de sponsoring ce mois-ci.","Prépare une réponse polie au mail de partenariat reçu ce matin."],"aiguillage":"UNIQUEMENT un mail présent dans le Courrier de redaction@ (ou des boîtes du Marketing), une demande de partenariat, de publicité ou d'article sponsorisé, la prospection ; jamais un contact d'interview","contexte":["courrier"],"mail":{"boite":"redaction","adresse":"redaction@posthumain.com","role":"mk"},"plan":{"x":930,"y":950,"teinte":20},"capacites":["proposer_reponse","ouvrir"]},{"id":"sc","connaissances":"service_client","nom":"Julien · Service client","emoji":"🎧","couleur":"#2bb3a3","acces":"chef","titre":"subs@posthumain.com","role":"Tu gères UNIQUEMENT le courrier de subs@posthumain.com (et des boîtes confiées au Service client), c'est-à-dire les mails présents dans « courrier » du contexte : abonnements Ghost, paiements, accès au compte (lien magique), résiliation, remboursement, en t'appuyant sur les CGV de Posthumain. Tu rédiges une proposition de réponse à un mail reçu : elle reste en brouillon, le rédacteur en chef la relit et l'envoie lui-même. Les contacts d'interview (personnes qui ont une fiche) ne sont jamais pour toi.","aide":"Julien traite le courrier de subs@posthumain.com : abonnements, paiements, accès au compte, résiliations et remboursements, selon les CGV. Le rédacteur en chef relit et envoie.","exemples":["Réponds à l'abonnée qui n'arrive plus à se connecter : renvoie-lui le lien magique.","Prépare la réponse au client qui demande un remboursement."],"aiguillage":"UNIQUEMENT un mail présent dans le Courrier de subs@ (ou des boîtes du Service client) : abonnement, paiement, accès au compte, remboursement ; jamais un contact d'interview","contexte":["courrier"],"mail":{"boite":"subs","adresse":"subs@posthumain.com","role":"sc"},"plan":{"x":630,"y":950,"teinte":175},"capacites":["proposer_reponse","ouvrir"]},{"id":"compta","connaissances":null,"nom":"Le Comptable","emoji":"🧮","couleur":"#d8b24a","acces":"tous","titre":"Les pièces de la rédaction","role":"Tu tiens le registre des pièces (récompenses des journalistes) : soldes, pièces acquises ou « à vérifier » et leur motif, conversion en euros au taux réglé, demandes de paiement (à partir du 25 du mois), factures. Tu réponds aux questions à partir des chiffres fournis ; tu ne modifies rien toi-même : les décisions (valider, annuler, convertir) se prennent dans ton panneau.","aide":"Il tient le registre des pièces gagnées par les journalistes : soldes, pièces à vérifier, conversion en euros, demandes de paiement et factures. Il répond à vos questions ; les décisions se prennent dans son panneau.","exemples":["Combien de pièces ai-je ce mois-ci ?","Pourquoi cette pièce est-elle « à vérifier » ?","Quand puis-je demander mon paiement ?"],"aiguillage":"les pièces des journalistes : soldes, pièces à vérifier, conversion en euros, paiements, factures","contexte":["pieces"],"mail":null,"plan":{"x":1230,"y":950,"teinte":45},"capacites":["ouvrir"]}],"capacites":[{"id":"rediger_interview","nom":"✍️ Demande d'interview (premier mail)","postes":["secretaire"],"description":"la Secrétaire rédige le PREMIER mail d'interview à un contact qui n'a pas encore de fiche ; la fiche arrive « à valider ». Pour écrire à quelqu'un qui a déjà une fiche, utilise suite_interview. Paramètres : article_id, contact { nom, email, role, institution, langue: 'fr'|'en' }, questions [texte…] (3 à 6), consigne?","aide":"Rédige le premier mail de demande d'interview à un nouveau contact, à partir de l'article, du contact et des questions.","fournir":"l'article, le nom et l'adresse du contact, les questions (ou laissez l'Assistant les proposer)","exemples":["Écris à Marie Dupont (EPFL) pour une interview sur cet article, avec ces questions : …","Demande une interview en anglais à John Smith du MIT."],"params":{"article_id":{"type":"article","requis":true},"contact":{"type":"contact","requis":true},"questions":{"type":"liste","requis":true,"max":8,"long":600},"consigne":{"type":"texte","long":500}},"droits":"tous","mode":"brouillon","executeur":{"type":"api","mode":"rediger","bureau":"secretaire","libelle":"rédige le mail","donnees":{"article_id":"$p.article_id","contact":"$p.contact","questions":"$p.questions","type":"interview","consigne":"$p.consigne","publie":true},"rafraichir":true,"resultat":"mail rédigé, à valider dans la fiche","lien":{"act":"open-valid","id":"$r.fiche_id","libelle":"📮 Relire le mail à valider"}},"carte":{"titre":"✍️ Mail d’interview pour {p.contact.nom}","liste":"p.questions","bouton":"✍️ Faire rédiger le mail"}},{"id":"suite_interview","nom":"✉️ Réponse dans le fil d'une fiche","postes":["secretaire"],"description":"la Secrétaire rédige une réponse dans le FIL de la fiche d'interview d'un contact (après le premier mail ou après sa réponse : remercier, proposer un appel ou une autre formule, fixer un rendez-vous, demander une précision, donner notre numéro). Brouillon à valider dans la fiche, envoyé dans le même fil après « Valider et envoyer ». Paramètres : fiche_id, consigne (ce qu'il faut dire, fidèle à la demande du membre, sans rien ajouter), telephone? (le numéro à donner : seulement s'il faut le donner et qu'il est fourni par le membre ou présent dans moi.telephone)","aide":"Répond dans le fil d'une fiche d'interview : remercier, proposer un appel ou une autre formule, fixer un rendez-vous, demander une précision, donner votre numéro.","fournir":"le nom de la personne (elle doit avoir une fiche) et ce qu'il faut lui dire ; votre numéro si vous voulez le donner (ou renseignez-le dans Paramètres → Équipe)","exemples":["Réponds à M. Schwab : merci pour sa réponse, nous aimerions un entretien téléphonique, ou par mail sous 48 h.","Propose à Mme Martin un appel jeudi à 14 h et donne-lui notre numéro.","Demande à John Smith de préciser le chiffre qu'il cite."],"params":{"fiche_id":{"type":"fiche","requis":true,"statuts":["envoyé","a répondu","relance","inséré"]},"consigne":{"type":"texte","requis":true,"long":1500,"brut":true},"telephone":{"type":"texte","long":40}},"enrichir":{"contact":"fiche.contact"},"droits":"tous","mode":"brouillon","executeur":{"type":"tel","action":"suite_rediger","envoi":"suite_envoyer","ecarter":"suite_ecarter","lister":"suites","bureau":"secretaire","libelle":"rédige la réponse","donnees":{"fiche_id":"$p.fiche_id","consigne":"$p.consigne","telephone":"$p.telephone"},"rafraichir":true,"resultat":"réponse rédigée, à valider dans la fiche","lien":{"act":"open-fiche","id":"$p.fiche_id","libelle":"🗂️ Relire et envoyer dans la fiche"}},"carte":{"titre":"✉️ Réponse dans le fil à {p.contact}","texte":"Consigne : {p.consigne}","note":"Rien ne part sans votre « Valider et envoyer » dans la fiche : la réponse partira dans le même fil que vos échanges.","bouton":"✉️ Faire rédiger la réponse"}},{"id":"chercher_contacts","nom":"🔎 Chercher qui interroger","postes":["assistant"],"description":"recherche des chercheurs à interroger pour cet article. Paramètres : article_id","aide":"Cherche des chercheurs et des experts à interroger pour l'article en cours, avec une adresse publiée officiellement.","fournir":"l'article (ouvert ou nommé)","exemples":["Trouve des chercheurs à interroger pour cet article.","Qui pourrait commenter cette étude en Suisse romande ?"],"params":{"article_id":{"type":"article","requis":true}},"droits":"tous","mode":"immediat","executeur":{"type":"api","mode":"contacts","bureau":"assistant","libelle":"cherche les chercheurs","donnees":{"article_id":"$p.article_id"},"liste":{"chemin":"contacts","format":"{nom} · {institution} · {email}"},"resultat":"{n} chercheur(s) trouvé(s)","resultat_vide":"personne de sûr trouvé"},"carte":{"titre":"🔎 Chercheurs à interroger","bouton":"🔎 Chercher"}},{"id":"questions","nom":"❓ Préparer les questions","postes":["assistant"],"description":"propose des questions d'interview pour ce contact. Paramètres : article_id, contact { nom, role, institution, langue }, angle?","aide":"Propose des questions d'interview adaptées au contact et à l'article ; vous pouvez ensuite faire rédiger le mail.","fournir":"l'article et le contact (nom, rôle, institution)","exemples":["Prépare cinq questions pour Jean Martin, sociologue à l'UNIL.","Quelles questions poser à cette chercheuse sur l'angle éthique ?"],"params":{"article_id":{"type":"article","requis":true},"contact":{"type":"contact","requis":true},"angle":{"type":"texte","long":300}},"droits":"tous","mode":"immediat","executeur":{"type":"api","mode":"questions","bureau":"assistant","libelle":"prépare les questions","donnees":{"article_id":"$p.article_id","contact":"$p.contact","angle":"$p.angle"},"liste":{"chemin":"questions","format":"{q}"},"resultat":"{n} question(s) proposée(s)","suite":{"capacite":"rediger_interview","poste":"secretaire","texte":"Je rédige le mail avec ces questions.","libelle":"✍️ Faire rédiger le mail avec ces questions","params":{"article_id":"$p.article_id","contact":"$p.contact","questions":"$l.q","consigne":""}}},"carte":{"titre":"❓ Questions pour {p.contact.nom}","bouton":"❓ Proposer les questions"}},{"id":"reponse_fiche","nom":"📞 Enregistrer une réponse reçue au téléphone","postes":["assistant"],"description":"réponse structurée du contact à enregistrer dans SA fiche (marquée « reçue par téléphone » ; le membre valide d'un clic). N'invente rien : seulement ce que le membre a rapporté. Paramètres : fiche_id, resume, reponses [{ question, reponse }], citations? [texte…]","aide":"Met en forme ce qu'un contact a répondu (au téléphone ou d'après vos notes) : un résumé et la réponse à chaque question, enregistrés dans sa fiche après votre clic.","fournir":"le nom du contact (il doit avoir une fiche) et ce qu'il a dit","exemples":["M. Schwab m'a dit au téléphone que… Enregistre sa réponse.","Voici mes notes d'appel avec Mme Martin : …"],"params":{"fiche_id":{"type":"fiche","requis":true,"statuts":["envoyé","a répondu","relance","inséré"]},"resume":{"type":"texte","long":3000,"brut":true},"reponses":{"type":"qr","max":12},"citations":{"type":"liste","max":6,"long":600}},"au_moins_un":["reponses","resume"],"enrichir":{"contact":"fiche.contact"},"droits":"tous","mode":"clic","executeur":{"type":"tel","action":"appel_enregistrer","donnees":{"fiche_id":"$p.fiche_id","resume":"$p.resume","reponses":"$p.reponses","transcription":"$requete","source":"notes"},"rafraichir":true,"resultat":"réponse enregistrée dans la fiche (reçue par téléphone)","toast":"📞 Réponse enregistrée dans la fiche. Vous pouvez placer les citations.","lien":{"act":"open-fiche","id":"$p.fiche_id","libelle":"🗂️ Ouvrir la fiche"}},"carte":{"titre":"📞 Réponse de {p.contact} à enregistrer dans sa fiche","texte":"{p.resume}","liste":"p.reponses","format":"{question}\n{reponse}","note":"Elle sera marquée « reçue par téléphone » : pas de preuve par mail, les pièces éventuelles passent « à vérifier » au Comptable.","bouton":"✅ Enregistrer dans la fiche"}},{"id":"citations","nom":"✅ Placer les citations dans l'article","postes":["assistant"],"description":"ouvre la fiche (qui a déjà une réponse) et propose les emplacements des citations dans l'article. Paramètres : fiche_id","aide":"Ouvre la fiche d'un contact qui a répondu et propose où placer ses citations dans l'article ; vous validez chaque emplacement avant l'insertion dans Ghost.","fournir":"le nom du contact (sa fiche doit avoir une réponse)","exemples":["Place les citations de M. Schwab dans l'article.","Propose les citations de la réponse de Mme Martin."],"params":{"fiche_id":{"type":"fiche","requis":true,"avec_reponse":true}},"droits":"tous","mode":"clic","executeur":{"type":"page","fonction":"citations","couvre":["citation","inserer"],"resultat":"fiche ouverte"},"carte":{"titre":"✅ Citations à placer dans l’article","bouton":"✅ Ouvrir la fiche et proposer les emplacements"}},{"id":"proposer_reponse","nom":"✉️ Répondre à un mail du Courrier","postes":["mk","sc"],"description":"rédige la proposition de réponse à ce mail (brouillon à valider). Paramètres : mail_id, consigne","aide":"Rédige une proposition de réponse à un mail du Courrier (redaction@ ou subs@) ; le rédacteur en chef la relit et l'envoie.","fournir":"le mail concerné (expéditeur ou sujet) et ce qu'il faut répondre","exemples":["Réponds au mail de l'agence Média+ : pas de sponsoring ce mois-ci.","Prépare la réponse à l'abonné qui veut résilier."],"params":{"mail_id":{"type":"mail","requis":true},"consigne":{"type":"texte","long":800}},"enrichir":{"sujet":"mail.sujet"},"droits":"chef","mode":"brouillon","executeur":{"type":"api","mode":"proposer","bureau":"$bureau_mail","libelle":"rédige une réponse","donnees":{"mail_id":"$p.mail_id","consigne":"$p.consigne"},"pas_auto_si":"brouillon_mail","rafraichir":true,"resultat":"réponse rédigée, à relire avant envoi","lien":{"act":"open-mail","id":"$p.mail_id","libelle":"✉️ Relire et envoyer"}},"carte":{"titre":"✉️ Réponse à « {p.sujet} »","texte":"Consigne : {p.consigne}","bouton":"✉️ Rédiger la réponse"}},{"id":"ouvrir","nom":"↗ Ouvrir une fiche, un mail ou un panneau","postes":["secretaire","assistant","mk","sc","compta"],"description":"ouvre l'élément dans le lab (fiche_id, mail_id, ou poste pour un panneau). Paramètres : cible 'fiche'|'mail'|'panneau', id","aide":"Ouvre directement une fiche, un mail ou le panneau d'un poste.","fournir":"ce qu'il faut ouvrir","exemples":["Ouvre la fiche de M. Schwab.","Montre-moi le panneau du Comptable."],"params":{"cible":{"type":"choix","requis":true,"valeurs":["fiche","mail","panneau"]},"id":{"type":"cible","requis":true}},"droits":"tous","mode":"clic","executeur":{"type":"page","fonction":"ouvrir","resultat":"ouvert"},"carte":{"titre":"↗ Ouvrir","bouton":"↗ Ouvrir"}}],"interne":{"_pourquoi":"Actions de la page (api('…') vers le webhook n8n) qui ne sont PAS des capacités de poste : déclenchées par les boutons habituels du lab, avec validation humaine. Toute nouvelle action doit être une capacité ci-dessus ou figurer ici avec sa raison.","etat":"lecture de l'état du lab (chargement de la page)","envoyer":"envoi d'un mail d'interview validé : bouton « Valider et envoyer » seulement","repondre":"envoi d'une réponse de Julien validée : bouton « Valider et envoyer » seulement","relance_envoyer":"envoi d'une relance validée : bouton de la fiche seulement","relance_ignorer":"mise de côté d'une relance : bouton de la fiche","maj":"corrections d'une fiche (mail, contact, réponse collée, archivage) : formulaires de la fiche","classer":"classement d'un mail du Courrier : boutons du mail","ecrire":"message dans l'Interphone : composer de l'Interphone","reformuler":"reformulation d'une question : panneau de l'Assistant","prospect":"campagnes de prospection : panneau de Julien Marketing","chapo":"mention des experts en début d'article : bloc de la fiche après insertion","inserer":"insertion validée dans Ghost : après la proposition de citations","citation":"propositions de citations : déclenchées par la fiche ou la capacité « citations »"},"interne_tel":{"_pourquoi":"Actions de wl-tel appelées directement par la page (téléphone, fiche) qui ne sont pas l'exécuteur d'une capacité : chacune avec sa raison. Toute nouvelle action de wl-tel doit être un exécuteur (action, envoi, ecarter, lister) d'une capacité ou figurer ici, sinon le test échoue.","capacites":"ce que le serveur sait faire (import audio) et postes accessibles : ouverture du téléphone","historique":"fil du membre avec un poste : ouverture du téléphone","telephone":"requête libre au ☎️ d'un poste : Claude répond par une proposition (capacité du catalogue)","action_faite":"note sur le fil qu'une proposition a été exécutée","canal":"« Reçue par » choisi à la main dans la fiche","appel_traiter":"réponse par téléphone : structuration de la transcription (aucune écriture)","fiche_traitee":"« ✓ Marquer comme traitée » : réponse purement logistique, la fiche s'affiche en attente (statut réel inchangé)"},"aiguillage":{"_pourquoi":"Règles d'aiguillage générées dans la fiche de poste de chaque IA (wl-tel) et dans l'aide ⓘ. contacts_interview : le poste qui écrit à toute personne qui a une fiche d'interview ; un poste qui a une boîte de courrier (mail) ne reçoit jamais ces demandes (vérifié aussi par le serveur avant une transmission).","contacts_interview":"secretaire"},"stations":[{"id":"chef","nom":"Le rédacteur en chef","emoji":"🧐","aide":"Le bureau du rédacteur en chef : toute la rédaction d'un coup d'œil, l'équipe, et ses propres fiches.","actions":["📊 Tableau de bord : qui a écrit à qui, ce qui attend une validation, ce qui a été cité","Voir le bureau de chaque journaliste","📞 Interphone pour lui écrire","Paramètres : équipe, boîtes mail, signatures"]},{"id":"journaliste","nom":"Bureau d'une journaliste","emoji":"✍️","aide":"Le bureau d'une journaliste : ses fiches de contact, rangées par état (à valider, envoyé, a répondu, cité).","actions":["🧠 Préparer une interview (avec l'Assistant)","📮 Écrire à quelqu'un (avec la Secrétaire)","Ouvrir chaque fiche","📞 Interphone pour lui écrire"]},{"id":"courrier","nom":"Le Courrier","emoji":"📬","aide":"Il surveille les boîtes en continu et range chaque réponse d'un contact dans la bonne fiche dès qu'elle arrive. Il repère aussi les adresses refusées.","actions":["Réponses à traiter","✉️ Adresses invalides","En attente de réponse","Déjà cités","↻ Actualiser"]},{"id":"marbre","nom":"Le Marbre","emoji":"📰","aide":"Les brouillons Ghost préparés par l'Usine, en attente de votre décision.","actions":["✅ Approuver un brouillon","🗑️ Écarter un brouillon (le post Ghost n'est pas supprimé)","Choisir l'article en cours","🔄 Actualiser"]},{"id":"radar","nom":"Le Radar","emoji":"📡","aide":"Les sujets du jour repérés et notés par le Radar ; sans choix, l'Usine prend le sujet le mieux noté.","actions":["Choisir ou retirer des sujets de la file","Mettre un sujet en file (prioritaire)","📡 Relancer le Radar (rédacteur en chef)","🔄 Actualiser"],"acces":"tous"},{"id":"votes","nom":"Votes du public","emoji":"🗳️","aide":"Les sujets proposés et votés par le public sur posthumain.com/vote.","actions":["Voir les sujets votés","Écarter ou remettre un sujet"],"acces":"tous"}],"onboarding":{"_lisezmoi":"Visite guidée (onboarding) montrée à chaque journaliste après la signature de l'engagement. Les étapes des postes et des stations sont GÉNÉRÉES depuis « postes » et « stations » (aide, capacités, exemples) dans l'ordre ci-dessous ; un poste absent de « ordre » est ajouté automatiquement à la fin. « navigation » décrit le reste de l'interface (cible = sélecteur CSS dans la page). Changer « version » refait voir la visite à tout le monde.","version":"v1","ordre":["secretaire","assistant","courrier","marbre","radar","votes","compta"],"navigation":[{"id":"interphone","emoji":"📞","titre":"L'Interphone","texte":"La messagerie de la rédaction : écrivez au rédacteur en chef, partagez un fichier, dictez un message au micro. La Secrétaire y annonce aussi les nouvelles enquêtes.","cible":".tabs .tab[data-tab=\"interphone\"]"},{"id":"classeur","emoji":"🗂️","titre":"Le Classeur","texte":"Tous les fichiers échangés (PDF, images, documents), rangés par catégorie. Il s'ouvre sur le bord droit de l'écran.","cible":".clsr-h"},{"id":"suivi","emoji":"✉️","titre":"Le Suivi","texte":"Toutes vos interviews d'un coup d'œil : par enquête, avec la prochaine action à faire, et par étape (à valider, envoyé, a répondu, cité).","cible":".tabs .tab[data-tab=\"suivi\"]"},{"id":"articles","emoji":"📰","titre":"L'onglet Articles","texte":"Les brouillons et les articles publiés. Sur chaque article : « ⚡ Préparer les interviews », puis « 📬 Voir les mails » pour suivre les réponses.","cible":".tabs .tab[data-tab=\"articles\"]"},{"id":"telephones","emoji":"☎️","titre":"Le téléphone des bureaux","texte":"Chaque employé virtuel a un ☎️ sur son bureau. Écrivez ou dictez une demande libre, par exemple « Prépare des questions pour Marie Dupont de l'EPFL » : il s'en occupe ou la transmet au bon collègue. Rien ne part sans votre validation.","cible":".floor .tel-svg"},{"id":"info","emoji":"ⓘ","titre":"Qui fait quoi ?","texte":"Le petit ⓘ en haut à droite de chaque salle rappelle le rôle de chaque bureau, avec des exemples de demandes. Pratique quand on a un doute.","cible":".floor .info-svg"},{"id":"parametres","emoji":"⚙️","titre":"Vos Paramètres","texte":"Votre signature de mail (français et anglais), les notifications sur votre téléphone, la langue de la dictée. Et le bouton « 🎓 Refaire l’onboarding » pour revoir ce guide quand vous voulez.","cible":".top [data-act=\"parametres\"]"}]},"connaissances":[{"id":"redaction","nom":"Rédaction","emoji":"✍️","aide":"Ce que la Secrétaire et l'Assistant savent de Posthumain quand ils rédigent : ligne éditoriale, ton, règles d'écriture, informations utiles aux interviews.","defaut":["posthumain.md"]},{"id":"service_client","nom":"Service client","emoji":"🎧","aide":"Ce que Julien (service client) sait pour répondre aux abonnés : offres, prix, CGV, fonctionnement du compte Ghost.","defaut":["posthumain.md","offres.md","cgv.md"]},{"id":"marketing","nom":"Marketing","emoji":"📣","aide":"Ce que Julien (marketing) sait pour répondre aux marques et prospecter : offres partenaires, tarifs des articles sponsorisés, audience.","defaut":["posthumain.md","offres.md","annonceurs.md"]}]}/*CATALOGUE-FIN*/;
  var CAT = (window.WL_CATALOGUE_TEST && window.WL_CATALOGUE_TEST.postes) ? window.WL_CATALOGUE_TEST : WL_CATALOGUE; // le harnais peut substituer le sien
  function catPoste(id) { return (CAT.postes || []).filter(function (p) { return p.id === id; })[0] || null; }
  function catCap(id) { return (CAT.capacites || []).filter(function (c) { return c.id === id; })[0] || null; }
  function catDroit(c) { var me = D().me; return !c || c.droits === 'tous' || (c.droits === 'chef' ? !!me.chef : c.droits === 'journaliste' ? !me.chef : true); }
  function catChemin(o, ch) { return String(ch || '').split('.').reduce(function (a, k) { return a == null ? a : a[k]; }, o); }
  function catVal(x, C) {
    if (Array.isArray(x)) return x.map(function (v) { return catVal(v, C); });
    if (x && typeof x === 'object') { var o = {}; Object.keys(x).forEach(function (k) { o[k] = catVal(x[k], C); }); return o; }
    if (typeof x !== 'string' || x.charAt(0) !== '$') return x;
    if (x === '$requete') return C.requete || '';
    if (x === '$bureau_mail') return C.bureauMail;
    var m = /^\$(p|r|l)\.(.+)$/.exec(x); if (!m) return x;
    if (m[1] === 'l') return (C.l || []).map(function (it) { return catChemin(it, m[2]); });
    var v = catChemin(m[1] === 'p' ? C.p : C.r, m[2]); return v == null ? '' : v;
  }
  function catTexte(t, C) { return String(t || '').replace(/\{([a-z_.]+)\}/gi, function (_, k) { var v = k === 'n' ? C.n : catChemin({ p: C.p, r: C.r }, k); return v == null ? '' : (typeof v === 'object' ? '' : String(v)); }); }
  function catItem(fmt, it) {
    if (typeof it !== 'object' || !it) return String(it == null ? '' : it);
    return String(fmt || '').replace(/\{([a-z_.]+)\}/gi, function (_, k) { var v = catChemin(it, k); return v == null ? '' : String(v); })
      .split(' · ').map(function (x) { return x.trim(); }).filter(Boolean).join(' · ').trim();
  }
  // fonctions de page que les capacités peuvent déclencher (exécuteur « page »)
  var PAGE_EXEC = {
    ouvrir: function (p) { if (p.cible === 'fiche') openDoc('fiche', p.id); else if (p.cible === 'mail') openDoc('mail', p.id); else openPanel(p.id); return Promise.resolve({}); },
    citations: function (p) { openDoc('fiche', p.fiche_id); var g = document.createElement('span'); g.setAttribute('data-id', p.fiche_id); act('cit', g); return Promise.resolve({}); }
  };
  // ================= ☎️ Téléphone des bureaux (23/10/2026) =================
  // Chaque poste IA du catalogue a un téléphone : une requête libre, écrite ou dictée. Le poste (Claude, fonction wl-tel) répond par
  // une proposition structurée : faire (une capacité du catalogue, toujours validée par un humain avant tout envoi ou enregistrement),
  // transmettre (une seule fois, au bon poste, trace visible) ou question. Capacités en mode « brouillon » ou « immédiat » : lancées
  // tout de suite ; mode « clic » : attendent un clic. Fils gardés par poste et par membre (table wl_tel).
  var TEL_FN = 'https://jfmzhndapfmvdhphuwfm.supabase.co/functions/v1/wl-tel';
  var TEL_POSTES = {}; (CAT.postes || []).forEach(function (p) { TEL_POSTES[p.id] = { nom: p.nom, em: p.emoji, chef: p.acces === 'chef' }; });
  function telApi(b) { return supa(TEL_FN, b); }
  function telPeut(k) { var p = TEL_POSTES[k]; return !!p && (!p.chef || !!D().me.chef); }
  function telBouton(k) { return telPeut(k) ? '<button class="btn small tel-b" data-act="tel" data-id="' + k + '" title="Appeler ' + esc(TEL_POSTES[k].nom) + ' : une requête libre, écrite ou dictée">☎️</button>' : ''; }
  function telOuvrir(k) {
    masquerTip();
    if (!telPeut(k)) return;
    if (S.telP && S.telP.poste === k) { telPeindre(true); return; }
    S.telP = { poste: k, fil: null, envoi: false, brouillon: (S.telBr || {})[k] || '' };
    telPeindre(true);
    telApi({ action: 'historique', poste: k }).then(function (r) {
      if (!S.telP || S.telP.poste !== k) return;
      S.telP.fil = r && r.ok ? r.fil : []; if (r && !r.ok) toast('⚠️ ' + (r.why || 'téléphone indisponible'), true);
      telPeindre();
    });
  }
  function telFermer() { if (TEL_DICTEE.actif()) TEL_DICTEE.arreter(); S.telP = null; var el = S.root.querySelector('.tel'); if (el) { el.classList.remove('open'); el.innerHTML = ''; } }
  function telQui(de) { if (de === 'moi') return { em: '', nom: D().me.nom.split(' ')[0] }; var p = TEL_POSTES[de] || { em: '·', nom: de }; return { em: p.em, nom: p.nom }; }
  function telActionHTML(m) {
    var a = m.action; if (!a || a.type === 'transmission') return '';
    var c = catCap(a.type); if (!c) return '';
    var p = a.params || {}, L = (S.telLoc || {})[m.id] || {}, E = c.executeur || {}, K = c.carte || {}, C = { p: p, r: L.r || {}, n: (L.liste || []).length };
    var h = '<div class="tel-a"><b>' + esc(catTexte(K.titre || c.id, C)) + '</b>';
    if (K.texte && catTexte(K.texte, C).replace(/^[^:]*:\s*$/, '').trim()) h += '<p>' + esc(catTexte(K.texte, C)) + '</p>';
    var lst = L.liste || (K.liste ? catChemin({ p: p }, K.liste) : null);
    var fmt = L.liste ? (E.liste && E.liste.format) : K.format;
    if (Array.isArray(lst) && lst.length) h += '<ol>' + lst.map(function (it) { return '<li>' + esc(catItem(fmt, it)).replace(/\n/g, '<br>') + '</li>'; }).join('') + '</ol>';
    if (K.note) h += '<div class="set-s">' + esc(K.note) + '</div>';
    var fait = a.fait || L.fait;
    var st = L.enCours ? '<span class="tag a">⏳ en cours…</span>' : L.erreur ? '<span class="tag r">⚠️ ' + esc(L.erreur) + '</span>' : fait ? '<span class="tag g">✓ ' + esc(L.resultat || a.resultat || 'fait') + '</span>' : '';
    var btn = '';
    if (!L.enCours && catDroit(c)) {
      var lien = E.lien ? { act: E.lien.act, id: catVal(E.lien.id, C), libelle: E.lien.libelle } : null;
      if (fait && E.suite && L.liste && L.liste.length) btn = '<button class="btn small go" data-act="tel-suite" data-id="' + m.id + '">' + esc(E.suite.libelle) + '</button>';
      else if (fait && lien && lien.id) btn = '<button class="btn small' + (E.lien.act === 'open-fiche' ? '' : ' go') + '" data-act="' + esc(lien.act) + '" data-id="' + esc(lien.id) + '">' + esc(lien.libelle) + '</button>';
      else if (!fait || c.mode === 'clic' && E.type === 'page') btn = '<button class="btn small go" data-act="tel-exec" data-id="' + m.id + '">' + esc(K.bouton || 'Lancer') + '</button>';
    }
    return h + '<div class="row tel-ab">' + st + btn + '</div></div>';
  }
  function telFilHTML() {
    var T = S.telP; if (!T.fil) return '<div class="muted">Chargement…</div>';
    var l = T.fil.map(function (m) {
      var q = telQui(m.de), moi = m.de === 'moi';
      var transm = m.mode === 'transmettre' ? ' tel-tr' : '', par = m.transmis_par && m.transmis_par !== m.de ? ' · transmis par ' + esc(telQui(m.transmis_par).nom) : '';
      return '<div class="bub' + (moi ? ' me' : ' bot') + transm + '"><div class="who">' + (moi ? esc(q.nom) : q.em + ' ' + esc(q.nom)) + par + ' · ' + esc(when(m.created_at)) + (m.mode === 'question' ? ' · ❔ question' : '') + '</div>' + esc(m.texte || '') + telActionHTML(m) + '</div>';
    }).join('');
    if (T.envoi) l += '<div class="bub bot tel-att"><div class="who">' + TEL_POSTES[T.poste].em + ' ' + esc(TEL_POSTES[T.poste].nom) + '</div>… réfléchit</div>';
    return l || '<div class="muted tel-vide">Écrivez ou dictez votre requête, librement. Exemple : « Je vais appeler M. Schwab qui répond à notre interview ; voici ce qu’il a dit… prépare les réponses pour l’article. » ' + esc(TEL_POSTES[T.poste].nom) + ' s’en charge, vous pose une question, ou transmet au bon poste. Rien n’est envoyé sans votre validation.</div>';
  }
  function telPeindre(tout) {
    var T = S.telP, el = S.root && S.root.querySelector('.tel'); if (!el || !T) return;
    var P = TEL_POSTES[T.poste];
    if (tout || !el.querySelector('.tel-fil')) {
      el.innerHTML = '<div class="tel-h"><span class="em">☎️</span><div style="min-width:0;flex:1"><div class="nm">' + P.em + ' ' + esc(P.nom) + '</div><div class="st">Requête libre · rien ne part sans votre validation</div></div><span class="x" data-act="tel-fermer" title="Raccrocher">✕</span></div>' +
        '<div class="tel-fil chat"></div>' +
        '<div class="tel-c"><textarea class="in" id="wl-tel-msg" rows="2" placeholder="' + (TEL_DICTEE.actif() ? '🎙️ Je vous écoute…' : 'Votre requête…') + '">' + esc(T.brouillon || '') + '</textarea>' +
        '<div class="row" style="gap:8px;margin-top:6px">' + (TEL_DICTEE.dispo ? '<button class="btn small mic' + (TEL_DICTEE.actif() ? ' on' : '') + '" data-act="tel-dicter" type="button">' + (TEL_DICTEE.actif() ? '⏹️ Arrêter' : '🎙️ Dicter') + '</button>' : '') +
        '<span style="flex:1"></span><button class="btn go" data-act="tel-envoyer"' + (T.envoi ? ' disabled' : '') + '>Envoyer</button></div></div>';
      el.classList.add('open');
    }
    var f = el.querySelector('.tel-fil'); f.innerHTML = telFilHTML(); f.scrollTop = f.scrollHeight;
    var bt = el.querySelector('[data-act="tel-envoyer"]'); if (bt) bt.disabled = !!T.envoi;
  }
  function telArticles() { return (D().articles || []).slice(0, 20).map(function (a) { return { id: a.id, titre: a.titre, statut: a.statut }; }); }
  function telEnvoyer() {
    var T = S.telP; if (!T || T.envoi) return;
    if (TEL_DICTEE.actif()) TEL_DICTEE.arreter();
    var ta = S.root.querySelector('#wl-tel-msg'), txt = String((ta && ta.value) || '').trim(); if (!txt) { toast('Écrivez ou dictez votre requête.', true); return; }
    T.envoi = true; T.fil = (T.fil || []).concat([{ id: 'tmp', de: 'moi', texte: txt, created_at: new Date().toISOString() }]);
    T.brouillon = ''; if (S.telBr) delete S.telBr[T.poste]; if (ta) ta.value = ''; telPeindre();
    var k = T.poste;
    telApi({ action: 'telephone', poste: k, texte: txt, article_id: S.art || '', fiche_id: S.doc && S.doc.kind === 'fiche' ? S.doc.id : '', articles: telArticles() }).then(function (r) {
      if (!S.telP || S.telP.poste !== k) return;
      T.envoi = false;
      T.fil = (T.fil || []).filter(function (m) { return m.id !== 'tmp'; });
      if (!r || !r.ok) { T.fil.push({ id: 'err' + Date.now(), de: k, texte: '⚠️ ' + ((r && r.why) || 'pas de réponse, réessayez'), created_at: new Date().toISOString() }); T.brouillon = txt; telPeindre(true); return; }
      T.fil = T.fil.concat(r.fil || []); telPeindre();
      (r.fil || []).forEach(function (m) { if (m && m.action && m.action.type === 'transmission' && m.action.params) transmettreAnim(m.de, m.action.params.vers); });
      var der = (r.fil || [])[(r.fil || []).length - 1];
      var cd = der && der.action && catCap(der.action.type);
      if (cd && (cd.mode === 'brouillon' || cd.mode === 'immediat') && catDroit(cd) && !(cd.executeur && cd.executeur.pas_auto_si === 'brouillon_mail' && mailBrouillonExiste(der.action.params.mail_id))) telExec(der.id);
    });
  }
  function mailBrouillonExiste(id) { var m = (D().courrier || []).filter(function (x) { return x.mail_id === id; })[0]; return !!(m && m.brouillon_corps); }
  function telEntree(id) { var T = S.telP; return T && (T.fil || []).filter(function (m) { return String(m.id) === String(id); })[0]; }
  function telLoc(id) { S.telLoc = S.telLoc || {}; return (S.telLoc[id] = S.telLoc[id] || {}); }
  function telFait(id, resultat) { var L = telLoc(id); L.enCours = false; L.fait = true; L.resultat = resultat; telPeindre(); if (/^\d+$/.test(String(id))) telApi({ action: 'action_faite', id: id, resultat: resultat }); }
  function telEchec(id, e) { var L = telLoc(id); L.enCours = false; L.erreur = (e && e.message) || String(e || 'échec'); telPeindre(); }
  function telExec(id) {
    var m = telEntree(id); if (!m || !m.action) return;
    var c = catCap(m.action.type); if (!c || !catDroit(c)) return;
    var p = m.action.params || {}, L = telLoc(id), E = c.executeur || {};
    if (L.enCours) return; L.enCours = true; L.erreur = ''; telPeindre();
    var mm = p.mail_id ? (D().courrier || []).filter(function (x) { return x.mail_id === p.mail_id; })[0] : null;
    var C = { p: p, requete: (S.telP.fil || []).filter(function (x) { return x.de === 'moi'; }).map(function (x) { return x.texte; }).slice(-1)[0] || '', bureauMail: (mm && bureauDe(mm.boite)) || S.telP.poste };
    var donnees = catVal(E.donnees || {}, C), pr;
    if (E.type === 'api') pr = api(E.mode, donnees);
    else if (E.type === 'tel') pr = telApi(Object.assign({ action: E.action }, donnees)).then(function (r) { if (!r || !r.ok) throw new Error((r && r.why) || 'impossible'); return r; });
    else if (E.type === 'page' && PAGE_EXEC[E.fonction]) pr = PAGE_EXEC[E.fonction](p);
    else { L.enCours = false; telEchec(id, new Error('exécuteur inconnu')); return; }
    var bureau = catVal(E.bureau || '', C);
    if (bureau && E.type === 'api') pr = work(bureau, E.libelle || 'travaille', pr);
    pr.then(function (r) {
      L.r = r || {};
      if (E.liste) L.liste = (catChemin(r, E.liste.chemin) || []).filter(function (x) { return x && (typeof x !== 'object' || Object.keys(x).length); });
      var n = (L.liste || []).length, res = E.liste && !n && E.resultat_vide ? E.resultat_vide : catTexte(E.resultat || 'fait', { p: p, r: L.r, n: n }).replace(/\((s)\)/g, n > 1 ? 's' : '');
      return (E.rafraichir ? refresh(true) : Promise.resolve()).then(function () { telFait(id, res); if (E.toast) toast(E.toast); });
    }).catch(function (e) { telEchec(id, e); });
  }
  // « suite » d'une capacité (ex. questions → mail d'interview) : nouvelle proposition du poste désigné, exécutée comme les autres.
  function telSuite(id) {
    var m = telEntree(id), L = telLoc(id), c = m && catCap(m.action.type), su = c && c.executeur && c.executeur.suite; if (!su || !L.liste) return;
    var nouv = { id: 's' + id, de: su.poste || m.de, texte: su.texte || '', created_at: new Date().toISOString(), action: { type: su.capacite, params: catVal(su.params, { p: m.action.params || {}, l: L.liste }) } };
    S.telP.fil.push(nouv); telPeindre(); telExec(nouv.id);
  }
  // ---------- ⓘ Qui fait quoi : fenêtre générée depuis shared/wl-catalogue.json (rien codé en dur) ----------
  function infoSujet(k) {
    var P = catPoste(k); if (P) return (P.acces !== 'chef' || D().me.chef) ? { poste: P } : null;
    var sid = String(k || '').indexOf('j:') === 0 ? 'journaliste' : k, st = (CAT.stations || []).filter(function (x) { return x.id === sid; })[0];
    return st && (st.acces !== 'chef' || D().me.chef) ? { station: st } : null;
  }
  var INFO_MODE = { brouillon: 'un brouillon à valider : rien ne part sans votre clic', immediat: 'un résultat tout de suite, sans effet extérieur (rien n’est envoyé ni publié)', clic: 'une proposition qui attend votre clic' };
  var INFO_DROITS = { tous: 'toute la rédaction (journalistes et rédacteur en chef)', chef: 'réservé au rédacteur en chef', journaliste: 'les journalistes' };
  function infoCapHTML(c, P) {
    var chefSeul = c.droits === 'chef' || P.acces === 'chef', E = c.executeur || {};
    var res = INFO_MODE[c.mode] || '';
    if (E.resultat && !/[{}]/.test(E.resultat)) res += ' · ' + E.resultat;
    return '<details class="if-c"><summary><span>' + esc(c.nom || c.id) + '</span>' + (chefSeul && D().me.chef ? ' <span class="tag a">rédacteur en chef</span>' : '') + '</summary><div class="if-cb">' +
      '<p>' + esc(c.aide || '') + '</p>' +
      '<div class="if-k">À dire au ☎️, par exemple</div><ul class="if-ex">' + (c.exemples || []).map(function (x) { return '<li>« ' + esc(x) + ' »</li>'; }).join('') + '</ul>' +
      '<div class="if-k">Ce qu’il faut fournir</div><p>' + esc(c.fournir || '') + '</p>' +
      '<div class="if-k">Résultat</div><p>' + esc(res) + '</p>' +
      '<div class="if-k">Qui y a droit</div><p>' + esc(chefSeul ? INFO_DROITS.chef : (INFO_DROITS[c.droits] || c.droits)) + '</p></div></details>';
  }
  // Fenêtre d'une salle : un seul poste → sa fiche ; plusieurs → onglets en haut (un par bureau de la salle).
  function infoHTML(id) {
    var r = ROOMS.filter(function (x) { return 'salle:' + x.key === id; })[0], m = r ? membresSalle(r) : [];
    if (!r || !m.length) return '';
    var i = Math.min(Math.max(0, (S.info && S.info.onglet) || 0), m.length - 1);
    var h = '<button class="if-x" data-act="info-fermer" aria-label="Fermer">✕</button>';
    if (m.length === 1) return h + infoCorps(m[0].key, r.name, true);
    h += '<div class="if-h"><span class="if-em">ⓘ</span><div><div class="if-k0">Qui fait quoi</div><h2 id="if-t">' + esc(r.name) + '</h2><div class="if-s">' + m.length + ' bureaux dans cette salle</div></div></div>' +
      '<div class="if-tabs" role="tablist">' + m.map(function (p, j) { var I = infoSujet(p.key), em = I.poste ? I.poste.emoji : I.station.emoji; return '<button role="tab" aria-selected="' + (j === i) + '" class="if-tab' + (j === i ? ' on' : '') + '" data-act="info-onglet" data-id="' + j + '">' + esc(em + ' ' + (I.poste ? I.poste.nom : p.nom)) + '</button>'; }).join('') + '</div>' +
      '<div class="if-panel" role="tabpanel">' + infoCorps(m[i].key, '', false) + '</div>';
    return h;
  }
  function infoCorps(k, salle, titre) {
    var I = infoSujet(k); if (!I) return '';
    var h = '', T = function (em, nom, sous) { return titre ? '<div class="if-h"><span class="if-em">' + esc(em) + '</span><div><div class="if-k0">Qui fait quoi' + (salle ? ' · ' + esc(salle) : '') + '</div><h2 id="if-t">' + esc(nom) + '</h2>' + (sous ? '<div class="if-s">' + esc(sous) + '</div>' : '') + '</div></div>' : '<div class="if-h2"><span class="if-em">' + esc(em) + '</span><div><b>' + esc(nom) + '</b>' + (sous ? '<div class="if-s">' + esc(sous) + '</div>' : '') + '</div></div>'; };
    if (I.poste) {
      var P = I.poste, ci = catPoste((CAT.aiguillage || {}).contacts_interview);
      var caps = (P.capacites || []).map(catCap).filter(function (c) { return c && (catDroit(c) || D().me.chef); });
      h += T(P.emoji, P.nom, P.titre) +
        '<p class="if-r">' + esc(P.aide || P.role) + '</p>' +
        (P.exemples && P.exemples.length ? '<div class="if-k">Exemples de demandes au ☎️</div><ul class="if-ex">' + P.exemples.map(function (x) { return '<li>« ' + esc(x) + ' »</li>'; }).join('') + '</ul>' : '') +
        '<h3 class="if-t2">Ce qu’il sait faire</h3>' + caps.map(function (c) { return infoCapHTML(c, P); }).join('') +
        '<h3 class="if-t2">Ce que ce poste transmet à d’autres</h3><ul class="if-tr">' +
        (CAT.postes || []).filter(function (x) { return x.id !== P.id && (x.acces !== 'chef' || D().me.chef); }).map(function (x) { return '<li><b>' + esc(x.emoji + ' ' + x.nom) + '</b> : ' + esc(x.aiguillage || '') + '</li>'; }).join('') + '</ul>' +
        (ci && ci.id === P.id ? '<p class="if-n">Tout mail à une personne qui a une fiche d’interview passe par ce poste.</p>' : ci && P.mail ? '<p class="if-n">Un contact d’interview (une personne qui a une fiche) n’est jamais pour ce poste : il le renvoie à ' + esc(ci.emoji + ' ' + ci.nom) + '.</p>' : '') +
        '<div class="if-a">' + (telPeut(P.id) ? '<button class="btn go" data-act="info-tel" data-id="' + esc(P.id) + '">☎️ Appeler ce poste</button>' : '') + '<button class="btn" data-act="info-ouvrir" data-id="' + esc(P.id) + '">Ouvrir son bureau</button></div>';
    } else {
      var st = I.station, pp = P0(k), nom = pp && pp.nom && pp.nom !== st.nom && !pp.vide ? pp.nom + ' · ' + st.nom : st.nom;
      h += T(st.emoji, nom, '') +
        '<p class="if-r">' + esc(st.aide) + '</p><h3 class="if-t2">Ce que fait son panneau</h3><ul class="if-tr">' + (st.actions || []).map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>' +
        '<div class="if-a"><button class="btn go" data-act="info-ouvrir" data-id="' + esc(k) + '">Ouvrir le panneau</button></div>';
    }
    return h;
  }
  function P0(k) { return people().filter(function (p) { return p.key === k; })[0]; }
  function infoOuvrir(k) {
    var retour = S.info ? S.info.retour : document.activeElement;
    infoFermer(true);
    S.info = { k: k, onglet: 0, retour: retour }; masquerTip();
    var html = infoHTML(k); if (!html) { S.info = null; return; }
    var bg = document.createElement('div'); bg.className = 'if-bg';
    bg.innerHTML = '<div class="if" role="dialog" aria-modal="true" aria-labelledby="if-t" tabindex="-1">' + html + '</div>';
    S.info.bg = bg;
    S.root.appendChild(bg);
    requestAnimationFrame(function () { bg.classList.add('on'); var x = bg.querySelector('.if-x'); if (x) x.focus({ preventScroll: true }); });
    bg.addEventListener('keydown', function (e) {
      if (e.key !== 'Tab') return;
      var f = Array.prototype.slice.call(bg.querySelectorAll('button,summary,[href],[tabindex]:not([tabindex="-1"])')).filter(function (x) { return x.offsetParent !== null; });
      if (!f.length) return;
      var i = f.indexOf(document.activeElement);
      if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); } else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
    });
  }
  function infoOnglet(j) {
    var I = S.info; if (!I || !I.bg) return;
    I.onglet = Number(j) || 0;
    var d = I.bg.querySelector('.if'); d.innerHTML = infoHTML(I.k);
    var t = d.querySelector('.if-tab.on'); if (t) t.focus({ preventScroll: true });
  }
  function infoFermer(silencieux) {
    var I = S.info; if (!I) return; S.info = null;
    if (I.bg && I.bg.parentNode) I.bg.parentNode.removeChild(I.bg);
    if (!silencieux && I.retour && I.retour.focus && document.contains(I.retour)) { try { I.retour.focus({ preventScroll: true }); } catch (e) {} }
  }
  // Bureau générique d'un poste du catalogue qui n'a pas de panneau dédié : son rôle, ses capacités, son ☎️.
  function panelPosteCatalogue(k) {
    var P = catPoste(k); if (!P) return '';
    var h = head(P.emoji, P.nom, esc(P.titre || ''));
    h += '<div class="pb"><p class="muted">' + esc(P.role || '') + '</p><h3>Ce que ce poste sait faire</h3><ul>' + (P.capacites || []).map(function (id) { var c = catCap(id); return c ? '<li>' + esc(c.nom || id) + ' · <span class="muted">' + esc(c.aide || '') + '</span></li>' : ''; }).join('') + '</ul>' +
      (telPeut(k) ? '<div class="row"><button class="btn go" data-act="tel" data-id="' + esc(k) + '">☎️ Appeler ' + esc(P.nom) + '</button></div>' : '<p class="muted">Ce poste est réservé au rédacteur en chef.</p>') + '</div>';
    return h;
  }
  // Postes du catalogue sans emplacement sur le plan : accessibles depuis la liste « Autres postes ».
  function autresPostesHTML() {
    var l = (CAT.postes || []).filter(function (p) { return !p.plan && telPeut(p.id); }); if (!l.length) return '';
    return '<div class="autres-postes"><span class="muted">Autres postes :</span>' + l.map(function (p) { return '<button class="btn small" data-act="open-ag" data-ag="' + esc(p.id) + '">' + esc(p.emoji + ' ' + p.nom) + '</button>'; }).join('') + '</div>';
  }
  var TEL_DICTEE = !PHL.dictee ? { dispo: false, demarrer: function () {}, arreter: function () {}, actif: function () { return false; } } : PHL.dictee({
    champ: function () { return S.root && S.root.querySelector('#wl-tel-msg'); },
    lang: function () { return LS.get('wl-dictee-lang') || 'fr-FR'; },
    brouillon: function (t) { if (S.telP) S.telP.brouillon = t; },
    etat: function () { var b = S.root && S.root.querySelector('[data-act="tel-dicter"]'); if (b) { b.classList.toggle('on', TEL_DICTEE.actif()); b.textContent = TEL_DICTEE.actif() ? '⏹️ Arrêter' : '🎙️ Dicter'; } var ta = S.root && S.root.querySelector('#wl-tel-msg'); if (ta) ta.placeholder = TEL_DICTEE.actif() ? '🎙️ Je vous écoute…' : 'Votre requête…'; },
    verrou: function (on) { var ta = S.root && S.root.querySelector('#wl-tel-msg'); if (ta) { ta.disabled = on; ta.classList.toggle('wl-mef', on); } },
    toast: function (t, bad) { toast(t, bad); },
    formaterActif: function () { return LS.get('wl-mef') !== '0'; },
    miseEnForme: function (dit) { return pushApi({ action: 'dictee', texte: dit }).then(function (r) { return r && r.ok ? r.texte : ''; }); }
  });

  // ================= 📞 Réponse par téléphone dans une fiche (23/10/2026) =================
  // Écoute de l'appel par la reconnaissance vocale du navigateur (gratuite, en direct ; mode continu relancé automatiquement
  // quand Chrome coupe après une pause), SEULEMENT après la case « la personne a accepté » (art. 179ter CP). Repli : coller ou
  // dicter ses notes d'appel. Puis l'Assistant tire résumé + réponses par question (wl-tel appel_traiter), relues et corrigées,
  // et enregistrées comme réponse de la fiche « reçue par téléphone le … » (wl-tel appel_enregistrer ; pièces « à vérifier »).
  // iPhone : pendant un appel classique, le micro est réservé à l'appel (Safari ne l'a plus) → haut-parleur + lab sur l'ordinateur.
  var AP_SR = window.SpeechRecognition || window.webkitSpeechRecognition || null;
  var AP_IOS = /iPhone|iPad|iPod/.test(navigator.userAgent || '') || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  function apChrono(ms) { var s = Math.max(0, Math.round(ms / 1000)); return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); }
  function apOuvrir(fid) { var f = fiche(fid); if (!f) return; S.appel = { fiche_id: fid, etape: 'pret', consent: false, source: 'appel', texte: '', interim: '', lang: f.langue === 'en' ? 'en-US' : 'fr-FR', res: null, busy: false }; paintDoc(); setTimeout(function () { var x = S.root.querySelector('#wl-appel'); if (x) x.scrollIntoView({ block: 'start', behavior: 'smooth' }); }, 30); }
  function appelHTML(f) {
    var A = S.appel; if (!A || A.fiche_id !== f.fiche_id) return '';
    var h = '<div class="ap" id="wl-appel"><div class="ap-h"><b>📞 Réponse par téléphone</b><span class="x" data-act="ap-annuler" title="Fermer">✕</span></div>';
    if (A.etape === 'pret') {
      h += '<div class="ap-aide">📱 <b>Appelez sur haut-parleur et ouvrez cette fiche sur votre ordinateur</b> : pendant un appel téléphonique, l’iPhone réserve le micro à l’appel et la page ne peut pas l’écouter.' + (AP_IOS ? ' <b>Vous êtes sur iPhone ou iPad</b> : utilisez plutôt l’ordinateur pour écouter, ou notez la réponse après l’appel.' : '') + '</div>' +
        '<label class="ap-ok"><input type="checkbox" id="wl-ap-ok"' + (A.consent ? ' checked' : '') + '> <span><b>La personne a accepté que l’appel soit écouté et retranscrit.</b><br><span class="ap-s">Obligatoire avant d’écouter : en Suisse, écouter ou enregistrer une conversation sans l’accord de l’interlocuteur est interdit (art. 179ter du Code pénal).</span></span></label>' +
        (AP_SR ? '<label class="ap-s ap-lang">Langue de l’appel <select id="wl-ap-lang">' + [['fr-FR', 'français'], ['en-US', 'anglais'], ['de-CH', 'allemand'], ['it-CH', 'italien']].map(function (l) { return '<option value="' + l[0] + '"' + (A.lang === l[0] ? ' selected' : '') + '>' + l[1] + '</option>'; }).join('') + '</select></label>'
          : '<div class="ap-aide">La transcription en direct n’est pas disponible dans ce navigateur (elle marche dans Chrome ou Edge sur ordinateur). Vous pouvez coller ou dicter vos notes d’appel.</div>') +
        '<div class="acts">' + (AP_SR ? '<button class="go" data-act="ap-ecouter"' + (A.consent ? '' : ' disabled') + '>🎧 Écouter l’appel</button>' : '') + '<button data-act="ap-notes">📝 Coller ou dicter mes notes d’appel</button></div>';
    } else if (A.etape === 'ecoute') {
      h += '<div class="ap-live-h"><span class="ap-rec"></span> <b>Écoute en cours</b> · <span id="wl-ap-chrono">' + apChrono(Date.now() - A.debut) + '</span><span style="flex:1"></span><span class="ap-s">' + esc(A.lang) + '</span></div>' +
        '<div class="ap-live" id="wl-ap-live">' + esc(A.texte) + '<span class="ap-int">' + esc(A.interim ? ' ' + A.interim : '') + '</span>' + (A.texte || A.interim ? '' : '<span class="ap-s">La transcription s’affiche ici pendant que vous parlez…</span>') + '</div>' +
        '<div class="acts"><button class="go" data-act="ap-stop">⏹️ Terminer l’appel</button></div>';
    } else if (A.etape === 'relire') {
      h += '<label for="wl-ap-txt">' + (A.source === 'appel' ? 'Transcription de l’appel (' + apChrono((A.fin || 0) - (A.debut || 0)) + ') : relisez et corrigez si besoin' : 'Vos notes d’appel : collez-les, tapez-les ou dictez-les') + '</label>' +
        '<textarea class="pin" id="wl-ap-txt" rows="9">' + esc(A.texte) + '</textarea>' +
        '<div class="acts">' + (AP_DICTEE.dispo && A.source === 'notes' ? '<button data-act="ap-dicter" class="' + (AP_DICTEE.actif() ? 'on' : '') + '">' + (AP_DICTEE.actif() ? '⏹️ Arrêter la dictée' : '🎙️ Dicter mes notes') + '</button>' : '') +
        '<button class="go" data-act="ap-traiter"' + (A.busy ? ' disabled' : '') + '>' + (A.busy ? '⏳ L’Assistant travaille…' : '🧠 Envoyer pour traitement') + '</button></div>' +
        '<div class="ap-s">L’Assistant en tire un résumé et les réponses classées par question de la fiche. Vous relisez avant d’enregistrer.</div>';
    } else if (A.etape === 'traite' && A.res) {
      var R = A.res;
      h += '<label for="wl-ap-resume">Résumé</label><textarea class="pin" id="wl-ap-resume" rows="4">' + esc(R.resume) + '</textarea>' +
        R.reponses.map(function (x, i) { return '<label for="wl-ap-r-' + i + '">' + (i + 1) + '. ' + esc(x.question || 'Réponse') + '</label><textarea class="pin" id="wl-ap-r-' + i + '" rows="3" placeholder="(pas de réponse : laissée de côté)">' + esc(x.reponse) + '</textarea>'; }).join('') +
        (R.citations && R.citations.length ? '<div class="ap-aide"><b>Citations possibles</b> (vous les placerez ensuite avec « Proposer les emplacements dans l’article ») :<ul>' + R.citations.map(function (c) { return '<li>« ' + esc(c) + ' »</li>'; }).join('') + '</ul></div>' : '') +
        (R.manque ? '<div class="ap-s">⚠️ ' + esc(R.manque) + '</div>' : '') +
        '<div class="ap-s">Enregistrée comme réponse de la fiche, « reçue par téléphone le … ». Pas de preuve par mail : les pièces éventuelles passent « à vérifier » au Comptable (motif « réponse par téléphone »).</div>' +
        '<div class="acts"><button data-act="ap-retour">← Revenir au texte</button><button class="go" data-act="ap-enregistrer"' + (A.busy ? ' disabled' : '') + '>' + (A.busy ? '⏳ Enregistrement…' : '✅ Enregistrer comme réponse') + '</button></div>';
    }
    return h + '</div>';
  }
  function apLive() {
    var A = S.appel, el = S.root && S.root.querySelector('#wl-ap-live'); if (!A || !el) return;
    el.innerHTML = esc(A.texte) + '<span class="ap-int">' + esc(A.interim ? ' ' + A.interim : '') + '</span>'; el.scrollTop = el.scrollHeight;
  }
  function apEcouter() {
    var A = S.appel; if (!A || !AP_SR) return;
    if (!A.consent) { toast('Cochez d’abord l’accord de la personne.', true); return; }
    A.etape = 'ecoute'; A.source = 'appel'; A.debut = Date.now(); A.actif = true; A.dernier = 0; A.err = '';
    var lancer = function () {
      if (!A.actif || S.appel !== A) return;
      var rec = new AP_SR(); rec.lang = A.lang; rec.continuous = true; rec.interimResults = true;
      rec.onresult = function (ev) {
        var interim = '';
        for (var i = ev.resultIndex; i < ev.results.length; i++) {
          var t = ev.results[i][0].transcript;
          if (ev.results[i].isFinal) { t = t.trim(); if (t) { var now = Date.now(); A.texte += (A.texte ? (now - A.dernier > 2500 ? '\n' : ' ') : '') + t; A.dernier = now; } }
          else interim += t;
        }
        A.interim = interim.trim(); apLive();
      };
      rec.onerror = function (ev) { if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') { A.actif = false; toast('Autorisez le micro pour posthumain.com dans le navigateur.', true); apArreter(); } else if (ev.error === 'audio-capture') { A.actif = false; toast('Aucun micro disponible (pendant un appel sur ce téléphone, le micro est réservé à l’appel).', true); apArreter(); } };
      rec.onend = function () { if (A.actif && S.appel === A) setTimeout(lancer, 250); }; // Chrome coupe après une pause : on relance
      try { rec.start(); A.rec = rec; } catch (e) { setTimeout(lancer, 600); }
    };
    lancer();
    A.timer = setInterval(function () { var c = S.root && S.root.querySelector('#wl-ap-chrono'); if (c && S.appel === A) c.textContent = apChrono(Date.now() - A.debut); }, 1000);
    paintDoc();
  }
  function apArreter() {
    var A = S.appel; if (!A) return;
    A.actif = false; clearInterval(A.timer); try { if (A.rec) A.rec.stop(); } catch (e) { /* déjà arrêtée */ }
    if (A.interim) { A.texte += (A.texte ? ' ' : '') + A.interim; A.interim = ''; }
    A.fin = Date.now(); A.etape = 'relire'; paintDoc();
  }
  function apTraiter() {
    var A = S.appel; if (!A || A.busy) return;
    if (AP_DICTEE.actif()) AP_DICTEE.arreter();
    var ta = S.root.querySelector('#wl-ap-txt'); if (ta) A.texte = ta.value;
    if (String(A.texte || '').trim().length < 20) { toast('Le texte est trop court pour en tirer une réponse.', true); return; }
    A.busy = true; if (document.activeElement) document.activeElement.blur(); paintDoc();
    work('assistant', 'traite l’appel', telApi({ action: 'appel_traiter', fiche_id: A.fiche_id, transcription: A.texte }).then(function (r) { if (!r || !r.ok) throw new Error((r && r.why) || 'traitement impossible'); return r; })).then(function (r) {
      if (S.appel !== A) return; A.busy = false; A.res = { resume: r.resume || '', reponses: r.reponses || [], citations: r.citations || [], manque: r.manque || '' }; A.etape = 'traite'; paintDoc();
    }, function () { if (S.appel === A) { A.busy = false; paintDoc(); } });
  }
  function apEnregistrer() {
    var A = S.appel; if (!A || A.busy || !A.res) return;
    var v = function (id) { var e = S.root.querySelector('#' + id); return e ? e.value : null; };
    if (v('wl-ap-resume') !== null) A.res.resume = v('wl-ap-resume');
    A.res.reponses.forEach(function (x, i) { var t = v('wl-ap-r-' + i); if (t !== null) x.reponse = t; });
    A.busy = true; if (document.activeElement) document.activeElement.blur(); paintDoc();
    telApi({ action: 'appel_enregistrer', fiche_id: A.fiche_id, resume: A.res.resume, reponses: A.res.reponses, transcription: A.texte, source: A.source, consentement: A.source === 'appel' ? !!A.consent : undefined }).then(function (r) {
      if (S.appel !== A) return;
      A.busy = false;
      if (!r || !r.ok) { toast('⚠️ ' + ((r && r.why) || 'enregistrement impossible'), true); paintDoc(); return; }
      S.appel = null; refresh(true).then(function () { paintDoc(); toast('📞 Réponse enregistrée dans la fiche. Vous pouvez maintenant placer les citations.'); });
    });
  }
  var AP_DICTEE = !PHL.dictee ? { dispo: false, demarrer: function () {}, arreter: function () {}, actif: function () { return false; } } : PHL.dictee({
    champ: function () { return S.root && S.root.querySelector('#wl-ap-txt'); },
    lang: function () { return (S.appel && S.appel.lang) || 'fr-FR'; },
    brouillon: function (t) { if (S.appel) S.appel.texte = t; },
    etat: function () { var b = S.root && S.root.querySelector('[data-act="ap-dicter"]'); if (b) { b.classList.toggle('on', AP_DICTEE.actif()); b.textContent = AP_DICTEE.actif() ? '⏹️ Arrêter la dictée' : '🎙️ Dicter mes notes'; } },
    verrou: function (on) { var ta = S.root && S.root.querySelector('#wl-ap-txt'); if (ta) { ta.disabled = on; ta.classList.toggle('wl-mef', on); } },
    toast: function (t, bad) { toast(t, bad); },
    formaterActif: function () { return LS.get('wl-mef') !== '0'; },
    miseEnForme: function (dit) { return pushApi({ action: 'dictee', texte: dit }).then(function (r) { return r && r.ok ? r.texte : ''; }); }
  });
  var SU_DICTEE = !PHL.dictee ? { dispo: false, demarrer: function () {}, arreter: function () {}, actif: function () { return false; } } : PHL.dictee({
    champ: function () { return S.root && S.root.querySelector('#wl-su-consigne'); },
    lang: function () { return LS.get('wl-dictee-lang') || 'fr-FR'; },
    brouillon: function (t) { if (S.doc) { S.suDraft = S.suDraft || {}; S.suDraft[S.doc.id] = { consigne: t, tel: val('wl-su-tel') }; } },
    etat: function () { var b = S.root && S.root.querySelector('[data-act="su-dicter"]'); if (b) { b.classList.toggle('on', SU_DICTEE.actif()); b.textContent = SU_DICTEE.actif() ? '⏹️ Arrêter la dictée' : '🎙️ Dicter'; } },
    verrou: function (on) { var ta = S.root && S.root.querySelector('#wl-su-consigne'); if (ta) { ta.disabled = on; ta.classList.toggle('wl-mef', on); } },
    toast: function (t, bad) { toast(t, bad); },
    formaterActif: function () { return LS.get('wl-mef') !== '0'; },
    miseEnForme: function (dit) { return pushApi({ action: 'dictee', texte: dit }).then(function (r) { return r && r.ok ? r.texte : ''; }); }
  });
  // ---------- Équipe (23/10/2026) ----------
  // Source unique de l'accès au lab : table wl_equipe (Supabase), gérée ici par le rédacteur en chef via wl-consent
  // (equipe_liste / equipe_enregistrer / equipe_actif ; tout est revérifié côté serveur). n8n et toutes les fonctions la lisent
  // (cache d'une minute au plus). Pas de suppression : un membre se désactive (il perd l'accès et son bureau, son historique reste).
  var EQ_ROLES = { chef: 'Rédacteur en chef', journaliste: 'Journaliste' };
  function testBloque() { if (!D().me.test) return false; toast('🧪 Compte de test : l’envoi de mails est désactivé. Rien n’est parti.', true); return true; }
  function chargerEquipe() {
    if (S.eqLd) return; S.eqLd = true;
    consApi({ action: 'equipe_liste' }).then(function (r) { S.eqLd = false; S.eqListe = r || { ok: false, why: 'réponse vide' }; if (S.panel === 'parametres') paintPanel(); });
  }
  function eqJournActifs(sauf) { return ((S.eqListe || {}).membres || []).filter(function (m) { return m.actif && m.role !== 'chef' && m.email !== sauf; }).length; }
  function eqSection() {
    var L = S.eqListe;
    var h = '<div class="set" id="wl-equipe"><div class="set-h"><div><b>👥 Équipe</b><div class="set-s">Qui a accès au Writinglab. Une seule liste pour tout le lab : un changement s’applique partout en une minute au plus.</div></div></div>' +
      '<div class="row" style="gap:8px;margin:10px 0 4px;flex-wrap:wrap"><button class="btn small go" data-act="eq-nouveau">➕ Ajouter un membre</button><button class="btn small" data-act="eq-recharger">↻ Actualiser</button></div>';
    if (!L) { chargerEquipe(); return h + '<p class="muted">Chargement…</p></div>'; }
    if (!L.ok) return h + '<p class="muted">⚠️ ' + esc(L.why || 'indisponible') + '</p></div>';
    var ms = L.membres || [];
    if (S.eqEdit === '__nouveau') h += eqForm(null, L);
    h += ms.map(function (m) {
      var eng = m.engagement === null ? '' : m.engagement ? '<span class="tag g">🔏 engagement signé le ' + esc(m.engagement.signe_le_zurich) + '</span>' : '<span class="tag a">🔏 engagement pas encore signé</span>';
      return '<div class="eq-m' + (m.actif ? '' : ' off') + '"><div class="eq-h"><div style="min-width:0;flex:1"><b>' + esc(m.nom) + '</b>' + (m.test ? ' <span class="tag eq-test">TEST</span>' : '') + (m.actif ? ' <span class="tag g">actif</span>' : ' <span class="tag">inactif</span>') +
        '<div class="set-s">' + esc(EQ_ROLES[m.role] || m.role) + (m.titre && m.titre !== EQ_ROLES[m.role] ? ' · ' + esc(m.titre) : '') + '<br>' + esc(m.email) + '<br>Boîte d’envoi : ' + (m.boite ? '<b>' + esc(m.boite) + '</b>' : 'aucune (pas d’envoi de mails)') + (m.telephone ? '<br>📞 ' + esc(m.telephone) : '') + '</div>' + (eng ? '<div style="margin-top:6px">' + eng + '</div>' : '') + '</div>' +
        '<div class="row eq-b"><button class="btn small" data-act="eq-edit" data-id="' + esc(m.email) + '">' + (S.eqEdit === m.email ? '✕ Fermer' : '✏️ Modifier') + '</button>' +
        (m.id === D().me.id ? '' : '<button class="btn small' + (m.actif ? ' red' : ' go') + '" data-act="eq-actif" data-id="' + esc(m.email) + '" data-on="' + (m.actif ? '0' : '1') + '">' + (m.actif ? '⏸️ Désactiver' : '▶️ Réactiver') + '</button>') + '</div></div>' +
        (S.eqEdit === m.email ? eqForm(m, L) : '') + '</div>';
    }).join('');
    h += '<details class="cz-d"><summary>Comment ajouter quelqu’un</summary><p>1. « ➕ Ajouter un membre » : son adresse e-mail, son nom, son rôle, sa boîte d’envoi s’il en a une.<br>' +
      '2. La personne se connecte sur <b>posthumain.com</b> avec <b>cette adresse e-mail</b> : un simple compte membre gratuit suffit (aucun rôle dans l’administration Ghost). Si elle n’a pas encore de compte, elle s’inscrit gratuitement sur posthumain.com avec cette adresse.<br>' +
      '3. Elle ouvre <b>posthumain.com/writinglab</b> et signe l’engagement de confidentialité à sa première connexion.</p>' +
      '<p>Sur le plan, chaque journaliste active a son bureau (3 postes au plus) ; désactivée, elle perd son bureau et son accès, mais son historique reste visible avec la mention « (inactif) ». Un compte de test fonctionne normalement, sans jamais envoyer de mail, et reste hors des totaux du Comptable.</p></details>';
    return h + '</div>';
  }
  function eqForm(m, L) {
    var d = S.eqDraft || {}, v = function (k, def) { return d[k] != null ? d[k] : def; };
    var role = v('role', m ? m.role : 'journaliste'), boite = v('boite', m ? (m.boite || '') : ''), test = v('test', m ? !!m.test : false);
    var prises = {}; (L.membres || []).forEach(function (x) { if (x.actif && x.boite && (!m || x.email !== m.email)) prises[x.boite] = x.nom; });
    var opt = function (val, txt, on, off) { return '<option value="' + esc(val) + '"' + (on ? ' selected' : '') + (off ? ' disabled' : '') + '>' + esc(txt) + '</option>'; };
    return '<div class="eq-f">' + (m ? '' : '<div class="eq-ft">Nouveau membre</div>') +
      '<label for="eq-email">Adresse e-mail de son compte membre posthumain.com</label><input class="in" id="eq-email" type="email" autocomplete="off" spellcheck="false" placeholder="prenom.nom@exemple.com" value="' + esc(v('email', m ? m.email : '')) + '">' +
      '<label for="eq-nom">Prénom et nom</label><input class="in" id="eq-nom" autocomplete="off" value="' + esc(v('nom', m ? m.nom : '')) + '">' +
      '<label for="eq-titre">Titre</label><input class="in" id="eq-titre" autocomplete="off" placeholder="Journaliste" value="' + esc(v('titre', m ? m.titre : '')) + '">' +
      '<label for="eq-tel">Téléphone (facultatif)</label><input class="in" id="eq-tel" type="tel" inputmode="tel" autocomplete="off" placeholder="+41 …" value="' + esc(v('tel', m ? (m.telephone || '') : '')) + '"><div class="set-s">Donné aux contacts d’interview seulement quand vous le demandez (« donne-lui notre numéro »). Vide : la Secrétaire vous le demandera.</div>' +
      '<div class="eq-2"><div><label for="eq-role">Rôle</label><select class="in" id="eq-role">' + opt('journaliste', 'Journaliste', role !== 'chef') + opt('chef', 'Rédacteur en chef', role === 'chef') + '</select></div>' +
      '<div><label for="eq-boite">Boîte d’envoi</label><select class="in" id="eq-boite">' + opt('', 'Aucune (pas d’envoi de mails)', !boite) + (L.boites || []).map(function (b) { return opt(b, b + '@ (posthumain.com)' + (prises[b] ? ' — déjà à ' + prises[b] : ''), boite === b, !!prises[b]); }).join('') + '</select></div></div>' +
      '<label for="eq-sig">Modèle de signature (français)</label><textarea class="in" id="eq-sig" rows="3" placeholder="Laisser vide : prénom nom, titre, Posthumain, posthumain.com">' + esc(v('sig', m ? m.signature : '')) + '</textarea>' +
      '<label for="eq-sigen">Modèle de signature (anglais)</label><textarea class="in" id="eq-sigen" rows="3" placeholder="Laisser vide : prénom nom, Journalist, Posthumain, posthumain.com">' + esc(v('sigen', m ? m.signature_en : '')) + '</textarea>' +
      '<div class="set-s">Signature de départ de ses mails ; la personne peut ensuite la personnaliser dans ses propres Paramètres.</div>' +
      '<label class="chk eq-chk"><input type="checkbox" id="eq-test"' + (test ? ' checked' : '') + '> 🧪 Compte de test <span class="set-s">badge TEST, aucun envoi de mails, hors totaux du Comptable</span></label>' +
      '<div class="row" style="gap:8px;margin-top:12px;flex-wrap:wrap"><button class="btn go" data-act="eq-save" data-id="' + esc(m ? m.email : '') + '">' + (m ? '💾 Enregistrer' : '➕ Ajouter à l’équipe') + '</button><button class="btn small" data-act="eq-annuler">Annuler</button></div></div>';
  }
  var EQ_4E = 'Le plan n’a que 3 postes : ce membre aura accès au lab mais pas de bureau.';
  function eqEnregistrer(ancien) {
    var ms = (S.eqListe || {}).membres || [], cur = ms.filter(function (x) { return x.email === ancien; })[0];
    var tc = S.root.querySelector('#eq-test');
    var b = { action: 'equipe_enregistrer', ancien_email: ancien, email: val('eq-email').trim(), nom: val('eq-nom').trim(), titre: val('eq-titre').trim(), telephone: val('eq-tel').trim(), role: val('eq-role'), boite: val('eq-boite'), signature: val('eq-sig').trim(), signature_en: val('eq-sigen').trim(), test: !!(tc && tc.checked) };
    if (!/^[^\s@<>]+@[^\s@<>]+\.[a-z]{2,}$/i.test(b.email)) { toast('⚠️ Adresse e-mail invalide.', true); return; }
    if (b.nom.length < 3 || !/\s/.test(b.nom)) { toast('⚠️ Indiquez le prénom et le nom.', true); return; }
    var dejaPoste = cur && cur.actif && cur.role !== 'chef', quatrieme = b.role !== 'chef' && (!cur || cur.actif) && !dejaPoste && eqJournActifs(ancien) >= 3;
    var ck = S.clicking;
    var go = function () {
      S.clicking = ck;
      consApi(b).then(function (r) {
        if (!r || !r.ok) { toast('⚠️ ' + ((r && r.why) || 'enregistrement impossible'), true); return; }
        toast(r.cree ? '👥 ' + b.nom + ' ajouté' + (b.role === 'chef' ? '' : 'e') + ' à l’équipe : connexion sur posthumain.com avec ' + b.email + '.' : '💾 ' + b.nom + ' : modifications enregistrées.');
        S.eqEdit = null; S.eqDraft = null; S.eqListe = null; S.consListe = null; paintPanel(); refresh(true);
      });
    };
    if (quatrieme) confirmer(EQ_4E + '\n\nEnregistrer quand même ?').then(function (ok) { if (ok) go(); }); else go();
  }
  function eqActif(email, actif) {
    var ms = (S.eqListe || {}).membres || [], m = ms.filter(function (x) { return x.email === email; })[0];
    if (!m) return;
    var ck = S.clicking;
    var txt = actif ? 'Réactiver ' + m.nom + ' ?\n\nIl ou elle retrouve l’accès au Writinglab' + (m.role !== 'chef' ? ' et son bureau sur le plan.' : '.') + (m.role !== 'chef' && eqJournActifs(email) >= 3 ? '\n\n' + EQ_4E : '')
      : 'Désactiver ' + m.nom + ' ?\n\nIl ou elle perd immédiatement l’accès au Writinglab et son bureau sur le plan. Rien n’est supprimé : son historique reste visible avec la mention « (inactif) », et vous pourrez la réactiver.';
    confirmer(txt).then(function (ok) {
      if (!ok) return; S.clicking = ck;
      consApi({ action: 'equipe_actif', email: email, actif: actif }).then(function (r) {
        if (!r || !r.ok) { toast('⚠️ ' + ((r && r.why) || 'impossible'), true); return; }
        toast(actif ? '▶️ ' + m.nom + ' réactivé' + (m.role === 'chef' ? '' : 'e') + '.' : '⏸️ ' + m.nom + ' désactivé' + (m.role === 'chef' ? '' : 'e') + ' : plus d’accès au lab.');
        S.eqListe = null; S.consListe = null; paintPanel(); refresh(true);
      });
    });
  }
  // Paramètres (rédacteur en chef) : engagements signés, statut de chaque journaliste, certificat imprimable, aperçu de l'écran.
  function chargerConsentements() {
    if (S.consLd) return; S.consLd = true;
    consApi({ action: 'liste' }).then(function (r) { S.consLd = false; S.consListe = r || { ok: false, why: 'réponse vide' }; if (S.panel === 'parametres') paintPanel(); });
  }
  function consSection() {
    var L = S.consListe;
    var h = '<div class="set"><div class="set-h"><div><b>🔏 Engagements de confidentialité</b><div class="set-s">Signés par chaque journaliste à sa première connexion (horodatage du serveur).</div></div></div>' +
      '<div class="row" style="gap:8px;margin:10px 0 4px;flex-wrap:wrap"><button class="btn small" data-act="cons-apercu">👁️ Voir l’écran comme une journaliste</button><button class="btn small" data-act="cons-recharger">↻ Actualiser</button></div>';
    if (!L) { chargerConsentements(); return h + '<p class="muted">Chargement…</p></div>'; }
    if (!L.ok) return h + '<p class="muted">⚠️ ' + esc(L.why || 'indisponible') + '</p></div>';
    var cs = L.consentements || [], vrais = cs.filter(function (c) { return !c.test; }), tests = cs.filter(function (c) { return c.test; });
    var ligne = function (c) {
      return '<div class="cs-row"><img class="cs-sigmini" alt="Signature de ' + esc(c.nom_saisi) + '" src="' + (/^data:image\/png;base64,/.test(c.signature_png) ? c.signature_png : '') + '"><div style="min-width:0"><b>' + esc(c.nom_saisi) + '</b>' + (c.test ? ' <span class="tag a">test</span>' : '') +
        '<div class="set-s">signé le ' + esc(consDate(c.signe_le)) + ' (heure de Zurich) · ' + esc(c.texte_version) + (c.texte_version !== L.version && !c.test ? ' <span class="tag a">ancienne version</span>' : '') + '</div></div>' +
        '<button class="btn small" data-act="cons-cert" data-id="' + esc(c.id) + '">⬇️ Télécharger le certificat</button></div>';
    };
    h += (L.journalistes || []).map(function (j) {
      var s = vrais.filter(function (c) { return c.journaliste_id === j.id; });
      return '<div class="cs-j"><div class="cs-jn">✍️ ' + esc(j.nom) + (j.test ? ' <span class="tag eq-test">TEST</span>' : '') + (j.actif === false ? ' <span class="tag">inactif</span>' : '') + (s.some(function (c) { return c.texte_version === L.version; }) ? ' <span class="tag g">✓ signé (' + esc(L.version) + ')</span>' : ' <span class="tag a">⏳ pas encore signé' + (s.length ? ' en ' + esc(L.version) : '') + '</span>') + '</div>' + s.map(ligne).join('') + '</div>';
    }).join('');
    if (tests.length) h += '<div class="cs-j"><div class="cs-jn">🧪 Signatures de test (aperçu)</div>' + tests.map(ligne).join('') + '<button class="btn small red" data-act="cons-suppr-test" style="margin-top:6px">🗑️ Supprimer les signatures de test</button></div>';
    return h + '<div class="set-s" style="margin-top:8px">Texte en vigueur : ' + esc(L.titre) + ' · empreinte SHA-256 ' + esc(String(L.hash).slice(0, 16)) + '…</div></div>';
  }
  // Certificat : page imprimable (Imprimer → PDF) avec le texte complet, les parties, la signature et les preuves techniques.
  function consCertificat(id) {
    var L = S.consListe || {}, c = (L.consentements || []).filter(function (x) { return String(x.id) === String(id); })[0];
    if (!c) { toast('Certificat introuvable : actualisez.', true); return; }
    var e = function (s) { return esc(s == null ? '' : s); };
    var lignes = [['Signataire (nom saisi)', c.nom_saisi], ['Compte', c.journaliste_id + (c.email ? ' · ' + c.email : '')], ['Signé le (horloge du serveur)', consDate(c.signe_le) + ' — heure de Zurich'], ['Horodatage serveur (UTC)', new Date(c.signe_le).toISOString()],
      ['Version du texte', c.texte_version], ['Empreinte SHA-256 du texte', c.texte_hash], ['Adresse IP', c.ip || '—'], ['Navigateur', c.user_agent || '—'], ['Fuseau et heure déclarés par le navigateur (indicatif)', (c.fuseau || '—') + ' · ' + (c.heure_locale || '—')], ['Identifiant de l’enregistrement', '#' + c.id]];
    var html = '<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Certificat — ' + e(c.nom_saisi) + ' — ' + e(c.texte_version) + '</title><style>' +
      'body{font:15px/1.55 Georgia,serif;color:#1f1a12;max-width:780px;margin:30px auto;padding:0 20px}h1{font:800 22px Inter,Arial,sans-serif;margin:0 0 4px}.k{font:700 11px Arial,sans-serif;letter-spacing:.14em;text-transform:uppercase;color:#6b604c}' +
      '.x{border:1px solid #d8cdb5;border-radius:8px;padding:14px 18px;background:#fbf8f1}.x h3{font:700 14px Arial,sans-serif;margin:14px 0 4px}table{width:100%;border-collapse:collapse;font:13px Arial,sans-serif;margin-top:14px}td{border-top:1px solid #e4dccb;padding:6px 8px;vertical-align:top;word-break:break-word}td:first-child{width:38%;color:#6b604c}' +
      '.sig{border:1px solid #d8cdb5;border-radius:8px;background:#fff;padding:8px;margin-top:8px;max-width:420px}.sig img{width:100%;display:block}.np{margin:18px 0}@media print{.np{display:none}body{margin:0}}</style></head><body>' +
      '<div class="np"><button onclick="print()">🖨️ Imprimer / enregistrer en PDF</button></div><div class="k">Posthumain · Writinglab · certificat de signature</div><h1>' + e(L.titre || c.texte_version) + '</h1>' +
      '<p><b>Parties :</b> ' + e(L.editeur || 'Trust Medias') + ', éditrice de Posthumain (posthumain.com), représentée par Jonathan Paiano ; et ' + e(c.nom_saisi) + (c.email ? ' (' + e(c.email) + ')' : '') + ', signataire.</p>' +
      (c.texte_version === L.version || c.texte_version === 'TEST-' + L.version ? '<div class="x">' + consTexteHTML(L.texte) + '</div>' : '<p><i>Texte signé : version ' + e(c.texte_version) + ' (empreinte ci-dessous).</i></p>') +
      '<h3 style="font:700 14px Arial,sans-serif;margin-top:18px">Signature</h3><div class="sig"><img alt="Signature" src="' + (/^data:image\/png;base64,/.test(c.signature_png) ? c.signature_png : '') + '"></div>' +
      '<table>' + lignes.map(function (l) { return '<tr><td>' + e(l[0]) + '</td><td>' + e(l[1]) + '</td></tr>'; }).join('') + '</table>' +
      '<p style="font:12px Arial,sans-serif;color:#6b604c;margin-top:14px">L’horodatage est celui du serveur de Posthumain (base de données Supabase), jamais celui du navigateur de la signataire. L’empreinte SHA-256 permet de vérifier que le texte signé est exactement celui reproduit ci-dessus.</p></body></html>';
    var u = URL.createObjectURL(new Blob([html], { type: 'text/html' })), a = document.createElement('a');
    a.href = u; a.download = 'Engagement-confidentialite-' + String(c.nom_saisi).replace(/[^\w-]+/g, '_') + '-' + c.texte_version + '.html'; document.body.appendChild(a); a.click(); a.remove();
    window.open(u, '_blank', 'noopener'); setTimeout(function () { URL.revokeObjectURL(u); }, 60000);
  }
  function panelParams() {
    var me = D().me, P = S.params, lg = S.sigLang || 'fr';
    var h = head('⚙️', 'Paramètres', esc(me.nom) + ' · ' + esc(me.titre || '')) + '<div class="pb">';
    if (!P) { chargerParams(); return h + '<p class="muted">Chargement…</p></div>'; }
    var push = !!S.pushOk, perm = (typeof Notification !== 'undefined') ? Notification.permission : 'default';
    h += '<div class="set"><div class="set-h"><div><b>🔔 Notifications sur ce navigateur</b><div class="set-s">' + (push ? 'Actives : messages de l’Interphone, réponses des chercheurs, pièces.' : perm === 'denied' ? 'Bloquées par le navigateur : autorisez les notifications pour posthumain.com dans les réglages du site, puis réactivez ici.' : 'Désactivées.') + '</div></div>' + sw('set-push', push) + '</div>' +
      (push ? '<button class="btn small" data-act="push">Envoyer une notification de test</button>' : '') + '</div>';
    var d = S.sigDraft || { fr: '', en: '' };
    h += '<div class="set"><div class="set-h"><div><b>✍️ Signature des mails</b><div class="set-s">Ajoutée automatiquement en bas de chaque mail, dans la langue du mail.</div></div></div>' +
      '<div class="seg"><button class="' + (lg === 'fr' ? 'on' : '') + '" data-act="sig-lang" data-id="fr">Français</button><button class="' + (lg === 'en' ? 'on' : '') + '" data-act="sig-lang" data-id="en">English</button></div>' +
      '<div class="tb"><button data-act="sig-cmd" data-id="bold" title="Gras"><b>B</b></button><button data-act="sig-cmd" data-id="italic" title="Italique"><i>I</i></button><button data-act="sig-cmd" data-id="underline" title="Souligné"><u>U</u></button><button data-act="sig-cmd" data-id="link" title="Lien">🔗</button><button data-act="sig-cmd" data-id="removeFormat" title="Effacer la mise en forme">⌫</button></div>' +
      '<div class="sig-ed" id="wl-sig" contenteditable="true" spellcheck="true">' + (d[lg] || '') + '</div>' +
      '<div class="row" style="gap:8px;margin-top:10px;flex-wrap:wrap"><button class="btn go" data-act="sig-save">Enregistrer les deux signatures</button><button class="btn small" data-act="sig-reset">Rétablir la signature par défaut</button></div></div>';
    var dl = LS.get('wl-dictee-lang') || 'fr-FR', mef = LS.get('wl-mef') !== '0';
    h += '<div class="set"><div class="set-h"><div><b>🎙️ Dictée</b><div class="set-s">Langue reconnue par le micro de l’Interphone.</div></div>' +
      '<select class="in" id="wl-dl" style="width:auto"><option value="fr-FR"' + (dl === 'fr-FR' ? ' selected' : '') + '>Français</option><option value="en-US"' + (dl === 'en-US' ? ' selected' : '') + '>English</option></select></div>' +
      '<div class="set-h" style="margin-top:12px"><div><b>Mise en forme automatique</b><div class="set-s">Ponctuation et majuscules corrigées après la dictée (le champ se grise une à deux secondes).</div></div>' + sw('set-mef', mef) + '</div></div>';
    if (me.chef) {
      var FR = S.factures || {};
      h += '<div class="set"><b>🧾 Tarifs des factures</b><div class="set-s" style="margin:4px 0 10px">Appliqués à la prochaine facture générée (les factures déjà émises gardent leur tarif, sauf ajustement).</div>' +
        '<div class="row" style="gap:10px;flex-wrap:wrap;align-items:center">Enquête premium <input class="in" id="wl-tp" value="' + String(FR.tarif_premium != null ? FR.tarif_premium : '').replace('.', ',') + '" inputmode="decimal" style="width:80px"> € · Article standard <input class="in" id="wl-ts" value="' + String(FR.tarif_standard != null ? FR.tarif_standard : '').replace('.', ',') + '" inputmode="decimal" style="width:80px"> € <button class="btn small" data-act="fa-tarifs">Enregistrer</button></div></div>';
      if (!S.factures) chargerFactures();
    }
    if (me.chef) {
      var wm = P.webmails || [];
      h += '<div class="set"><b>🛡️ Contrôle des pièces</b><div class="set-s" style="margin:4px 0 10px">Réponses venant de ces messageries gratuites : pièces mises « à vérifier » (vous validez). Tout est décoché par défaut, car beaucoup de gens sérieux ont une adresse Gmail ou Outlook.</div>' +
        WEBMAILS.map(function (g, k) { var on = g[1].every(function (d) { return wm.indexOf(d) >= 0; }); return '<label class="chk"><input type="checkbox" data-wm="' + k + '"' + (on ? ' checked' : '') + '> ' + esc(g[0]) + ' <span class="set-s">' + esc(g[1].join(', ')) + '</span></label>'; }).join('') + '</div>';
    }
    if (me.chef) h += '<div class="set' + (P.recompense ? ' hot' : '') + '"><div class="set-h"><div><b>🧪 Mode récompense (test)</b><div class="set-s">Vous gagnez des pièces comme une rédactrice (votre caisse apparaît chez le Comptable) : comptabiliser, demander le paiement, cocher la facture, tout fonctionne pour vous-même et les notifications vous arrivent.</div></div>' + sw('set-rec', !!P.recompense) + '</div></div>';
    if (me.chef) h += eqSection();
    if (me.chef) h += bxSection();
    if (me.chef) h += consSection();
    var adr = ({ jonathan: 'jonathan.paiano@posthumain.com', valisoa: 'valisoa.rasolofo@posthumain.com' })[me.id] || '';
    h += '<div class="set"><b>👤 Compte</b><div class="set-s" style="margin-top:6px">' + esc(me.nom) + ' · ' + esc(me.titre || '') + (adr ? '<br>Mails envoyés depuis <b>' + esc(adr) + '</b>' : '') + '</div>' +
      '<div class="row" style="margin-top:10px;gap:8px;flex-wrap:wrap"><button class="btn small" data-act="ob-refaire">🎓 Refaire l’onboarding</button>' +
      (me.chef ? '<button class="btn small" data-act="ob-journaliste">🎓 Voir l’onboarding comme une journaliste</button>' : '') +
      '<button class="btn small" data-act="deconnexion">🚪 Se déconnecter</button></div></div>';
    return h + '</div>';
  }
  // Tableau de bord du rédacteur en chef : tout est calculé ici depuis les fiches, sauf le coût IA (compté par les coulisses).
  var MOISC = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
  function moisDe(d) { var p = new Intl.DateTimeFormat('fr-CA', { timeZone: TZ, year: 'numeric', month: '2-digit' }).format(new Date(d)); return p.slice(0, 7); }
  function moisNom(m) { var x = String(m || '').split('-'); return x.length === 2 ? MOISC[Number(x[1]) - 1] + ' ' + x[0].slice(2) : m; }
  function derniersMois(n) { var out = [], d = new Date(); for (var i = n - 1; i >= 0; i--) { var x = new Date(d.getFullYear(), d.getMonth() - i, 15); out.push(x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0')); } return out; }
  function dateCitation(f) {
    var e = (f.historique || []).filter(function (x) { return /cit|insér/i.test(String(x.e || '')); }).pop();
    return e ? e.t : f.maj;
  }
  function chargerCouts() {
    if (S.coutsP) return S.coutsP;
    var fin = function (r) { S.coutsP = null; S.couts = r && r.ok ? r : { ok: false, why: (r && r.why) || 'indisponible' }; if (S.panel === 'compta') paintPanel(); };
    S.coutsP = S.call({ mode: 'couts', data: '{}' }).then(function (r) { if (r && r.ok) return r; return pushApi({ action: 'couts' }); }, function () { return pushApi({ action: 'couts' }); }).then(fin, function () { fin(null); });
    return S.coutsP;
  }
  function barres(rows, fmt) {
    var mx = Math.max.apply(null, rows.map(function (r) { return r[1]; }).concat([0.0001]));
    return '<div class="bars">' + rows.map(function (r) { return '<div class="bar"><span class="lb">' + esc(r[0]) + '</span><span><i style="width:' + Math.round(100 * r[1] / mx) + '%"></i></span><em>' + esc(fmt(r[1])) + '</em></div>'; }).join('') + '</div>';
  }
  function bordHTML() {
    var fs = (D().fiches || []).filter(function (f) { return !estTestM(f.redacteur); }), mc = moisDe(Date.now()); // comptes de test hors totaux (23/10/2026)
    var env = fs.filter(function (f) { return f.envoye_le; }), envM = env.filter(function (f) { return moisDe(f.envoye_le) === mc; });
    var rep = env.filter(function (f) { return f.reponse_le; });
    var delais = rep.map(function (f) { return new Date(f.reponse_le) - new Date(f.envoye_le); }).filter(function (x) { return x > 0; });
    var moy = delais.length ? delais.reduce(function (a, b) { return a + b; }, 0) / delais.length : 0;
    var delaiTxt = !delais.length ? '—' : moy < 864e5 ? Math.max(1, Math.round(moy / 36e5)) + ' h' : (moy / 864e5).toFixed(1).replace('.', ',') + ' j';
    var cites = fs.filter(function (f) { return f.statut === 'inséré'; });
    var nRel = fs.reduce(function (a, f) { return a + (Number(f.relances) || 0); }, 0), nReb = fs.filter(estRebond).length;
    var kpi = function (v, l) { return '<div class="kpi"><b>' + v + '</b><span>' + l + '</span></div>'; };
    var h = '<p class="muted">Vue d’ensemble des demandes d’interview de toute la rédaction (fiches non archivées).</p><div class="kpis">' +
      kpi(envM.length, 'demandes envoyées en ' + moisNom(mc) + ' · ' + env.length + ' au total') +
      kpi(env.length ? Math.round(100 * rep.length / env.length) + ' %' : '—', 'taux de réponse (' + rep.length + '/' + env.length + ')') +
      kpi(delaiTxt, 'délai moyen de réponse') +
      kpi(cites.length, 'citations insérées') +
      kpi(nRel, 'relance' + pl(nRel) + ' envoyée' + pl(nRel)) +
      kpi(nReb, 'adresse' + pl(nReb) + ' invalide' + pl(nReb)) + '</div>';
    var ms = derniersMois(6);
    h += '<div class="cz-t">✅ Citations insérées par mois</div>' + barres(ms.map(function (m) { return [moisNom(m), cites.filter(function (f) { return moisDe(dateCitation(f)) === m; }).length]; }), function (v) { return String(v); });
    var parArt = {}; cites.forEach(function (f) { var k = f.article_titre || 'Sans article'; parArt[k] = (parArt[k] || 0) + 1; });
    var ta = Object.keys(parArt).map(function (k) { return [k, parArt[k]]; }).sort(function (a, b) { return b[1] - a[1]; }).slice(0, 6);
    if (ta.length) h += '<div class="cz-t">📰 Citations par article</div>' + barres(ta, function (v) { return String(v); });
    var parW = {}; env.forEach(function (f) { var k = membre(f.redacteur).nom; parW[k] = parW[k] || [0, 0]; parW[k][0]++; if (f.reponse_le) parW[k][1]++; });
    var tw = Object.keys(parW);
    if (tw.length > 1) h += '<div class="cz-t">👥 Par journaliste</div><div class="bars">' + tw.map(function (k) { return '<div class="bar"><span class="lb">' + esc(k) + '</span><span class="muted" style="font-size:13px">' + parW[k][0] + ' envoyée' + pl(parW[k][0]) + ' · ' + parW[k][1] + ' réponse' + pl(parW[k][1]) + '</span><em>' + Math.round(100 * parW[k][1] / parW[k][0]) + ' %</em></div>'; }).join('') + '</div>';
    // coût IA
    var C = S.couts;
    h += '<div class="cz-t">🤖 Coût IA</div>';
    if (!C) { chargerCouts(); h += '<p class="muted">Calcul en cours…</p>'; }
    else if (!C.ok) h += '<p class="muted">Le compteur de coût n’est pas encore disponible (' + esc(C.why || 'indisponible') + ').</p>';
    else {
      var eu = function (v) { return (Math.round(Number(v || 0) * 100) / 100).toFixed(2).replace('.', ',') + ' €'; };
      var U = C.par_usage || {}, noms = { preparation: '🧠 Préparation', dictee: '🎙️ Dictée', citations: '✅ Citations', prospection: '🔎 Prospection', telephone: '☎️ Téléphone', autre: '· Autre' };
      h += '<div class="kpis">' + kpi(eu(C.total_eur), 'ce mois-ci' + (C.mois ? ' (' + esc(moisNom(C.mois)) + ')' : '')) + '</div>';
      var ru = Object.keys(noms).filter(function (k) { return Number(U[k]) > 0; }).map(function (k) { return [noms[k], Number(U[k])]; });
      if (ru.length) h += barres(ru, eu);
      var pm = (C.par_mois || []).slice(-6);
      if (pm.length) h += '<div class="cz-s" style="margin-top:10px">6 derniers mois</div>' + barres(pm.map(function (x) { return [moisNom(x.mois), Number(x.total_eur) || 0]; }), eu);
    }
    return h;
  }
  function panelCompta() {
    var r = S.pieces || { pieces: [], totaux: {}, soldes: {}, conversions: [] }, me = D().me, tx = Number(r.taux || 0), o = stOf(P('compta'));
    var h = head('🧮', 'Le Comptable', '<span class="led ' + o.s + '"></span>' + esc(o.why)) + '<div class="pb">';
    // Deux onglets : les pièces (caisses, à facturer, barème) et les factures mensuelles.
    var ct = S.ctab === 'factures' ? 'factures' : S.ctab === 'bord' && me.chef ? 'bord' : 'pieces';
    var nf = ((S.factures || {}).factures || []).filter(function (f) { return f.statut !== 'payee'; }).length;
    h += '<div class="seg ctabs"><button data-act="ct-tab" data-id="pieces" class="' + (ct === 'pieces' ? 'on' : '') + '">🪙 Pièces</button><button data-act="ct-tab" data-id="factures" class="' + (ct === 'factures' ? 'on' : '') + '">🧾 Factures' + (nf ? ' · ' + nf : '') + '</button>' +
      (me.chef ? '<button data-act="ct-tab" data-id="bord" class="' + (ct === 'bord' ? 'on' : '') + '">📊 Tableau de bord</button>' : '') + '</div>';
    if (ct === 'factures') return h + facturesHTML() + '</div>';
    if (ct === 'bord') return h + bordHTML() + '</div>';
    if (!S.pieces) return h + '<p class="muted">Le Comptable ouvre ses registres…</p></div>';
    h += '<p class="muted">Chaque parcours complet (interview envoyée depuis le lab, réponse du chercheur, citation insérée dans l’article) rapporte des pièces, rangées dans la caisse de la journaliste.</p>';
    gagnants().forEach(function (w) {
      var so = (r.soldes || {})[w.id] || 0, mien = w.id === me.id, demande = (r.demandes || {})[w.id] === r.mois;
      var peutDemander = mien && so > 0 && Number(r.jour) >= 25 && !demande;
      h += '<div class="caisse"><div class="cz-h"><span>Caisse de <b>' + esc(membre(w.id).nom) + '</b>' + tagTest(w.id) + '</span>' + (demande && so ? '<span class="tag a">💶 paiement demandé</span>' : '') + '</div>' + (w.test ? '<div class="cz-s">🧪 Compte de test : ses pièces et factures ne comptent pas dans les totaux.</div>' : '') +
        '<div class="cz-n">🪙 ' + so + '<small>' + (so ? '≈ ' + eurTxt(so * tx) : 'vide') + '</small></div><div class="cz-s">' + totalPieces(w.id) + ' pièces gagnées depuis le début · ' + eurTxt(tx) + ' la pièce</div>' +
        '<div class="row" style="gap:8px;margin-top:10px;flex-wrap:wrap">' +
        (me.chef ? '<button class="btn go" data-act="pc-conv" data-id="' + esc(w.id) + '"' + (so ? '' : ' disabled data-off="1"') + '>📒 Comptabiliser' + (so ? ' ' + eurTxt(so * tx) : '') + '</button><button class="btn small" data-act="pc-raz" data-id="' + esc(w.id) + '"' + (so ? '' : ' disabled data-off="1"') + '>↺ Remettre à zéro</button>' : '') +
        (mien ? '<button class="btn go" data-act="pc-dem"' + (peutDemander ? '' : ' disabled data-off="1"') + '>💶 Demander le paiement</button>' : '') + '</div>' +
        (mien && !peutDemander ? '<div class="cz-s" style="margin-top:6px">' + (!so ? 'Ta caisse est vide pour l’instant.' : demande ? 'Demande envoyée ce mois-ci : Jonathan va comptabiliser.' : 'La demande de paiement s’ouvre le 25 de chaque mois.') + '</div>' : '') + '</div>';
    });
    var af = (r.conversions || []).filter(function (c) { return c.statut === 'a_facturer' && (me.chef || c.membre === me.id); });
    h += '<div class="cz-t">💶 À ajouter à la prochaine facture (' + af.length + ')</div>' + (af.map(function (c) {
      return '<div class="cz-l"><div><b>' + eurTxt(Number(c.montant)) + '</b> · ' + c.pieces + ' pièces · ' + esc(membre(c.membre).nom) + '<div class="cz-s">comptabilisé ' + esc(when(c.created_at)) + (c.note ? ' · ' + esc(c.note) : '') + '</div></div>' +
        '<div class="row" style="gap:6px;margin-top:8px"><input class="in" id="wl-fact-' + c.id + '" placeholder="n° ou date de facture (facultatif)" style="flex:1;min-width:150px"><button class="btn small go" data-act="pc-fact" data-id="' + c.id + '">☑️ Ajouté à la facture</button></div></div>';
    }).join('') || '<p class="muted">Rien à facturer.</p>') + (af.length ? '<p class="cz-s">Une fois cochée, la ligne est archivée et les pièces sont comptées définitivement.</p>' : '');
    var der = (r.pieces || []).filter(function (p) { return me.chef || p.membre === me.id; }).slice(0, 12);
    if (der.length) h += '<div class="cz-t">🪙 Dernières pièces</div>' + der.map(function (p) {
      var st = PST2[p.statut] || ['·', p.statut, ''];
      return '<div class="cz-l"><div><b>' + (p.montant ? '+' + p.montant : '0') + '</b> <span class="tag ' + st[2] + '">' + st[0] + ' ' + esc(st[1]) + '</span>' + (me.chef ? ' · ' + esc(membre(p.membre).nom) : '') + '<div class="cz-s">' + esc(p.contact || '') + ' — ' + esc(p.article_titre || '') + ' · ' + esc(when(p.created_at)) + (me.chef ? '<br>' + esc(p.motif || '') : '') + '</div></div>' +
        (me.chef && p.statut === 'a_verifier' ? '<div class="row" style="gap:6px;margin-top:6px"><button class="btn small go" data-act="pc-ok" data-id="' + p.id + '">✅ Valider</button><button class="btn small red" data-act="pc-annule" data-id="' + p.id + '">✖️ Annuler</button></div>' : '') + '</div>';
    }).join('');
    h += '<details class="cz-d"><summary>Barème</summary><p>Citation insérée avant la publication ou jusqu’à 2 jours après : <b>10 pièces</b><br>jusqu’à 4 jours : <b>5 pièces</b><br>jusqu’au 6e jour : <b>2 pièces</b><br>à partir du 7e jour : 0, ce sera pour la prochaine fois.</p></details>';
    if (me.chef && testRec()) h += '<div class="cz-l" style="border-color:rgba(255,176,32,.5)">🧪 <b>Mode récompense (test) actif</b> : vous gagnez aussi des pièces, avec votre propre caisse. Désactivable dans ⚙️ Paramètres.</div>';
    if (me.chef) h += '<details class="cz-d"><summary>Réglages et contrôles (visible par vous seul)</summary><p>Une pièce n’est accordée que si le mail est parti du lab, que la réponse arrive dans le fil de ce mail (en-têtes vérifiés côté serveur ; depuis une autre adresse que celle du chercheur et hors de son domaine : « à vérifier »), et que la citation est insérée depuis le lab. Une seule récompense par fiche ; webmail gratuit, adresse de l’équipe ou réponse très courte → « à vérifier ».</p>' +
      '<div class="row" style="gap:8px;align-items:center">Valeur d’une pièce : <input class="in" id="wl-taux" value="' + String(tx).replace('.', ',') + '" style="width:90px" inputmode="decimal"> € <button class="btn small" data-act="pc-taux">Enregistrer</button></div></details>';
    var arch = (r.conversions || []).filter(function (c) { return c.statut !== 'a_facturer' && (me.chef || c.membre === me.id); });
    if (arch.length) h += '<details class="cz-d"><summary>Archives (' + arch.length + ')</summary>' + arch.map(function (c) {
      return '<div class="cz-l"><b>' + (c.type === 'conversion' ? eurTxt(Number(c.montant)) : '↺ remis à zéro') + '</b> · ' + c.pieces + ' pièces · ' + esc(membre(c.membre).nom) + '<div class="cz-s">' + (c.statut === 'facture' ? '✅ ajouté à la facture ' + esc(when(c.facture_le)) + (c.facture_note ? ' · ' + esc(c.facture_note) : '') : 'remis à zéro ' + esc(when(c.created_at))) + '</div></div>';
    }).join('') + '</details>';
    return h + '</div>';
  }
  function docPieces() {
    var r = S.pieces || { pieces: [], totaux: {} }, me = D().me;
    var h = '<div class="dtop"><span class="em">🪙</span><div><div class="nm">Les pièces de la rédaction</div><div class="st">1 parcours complet et prouvé = des pièces</div></div><span class="x" data-act="close-doc">✕</span></div><div class="paper">';
    var tx = Number(r.taux || 0), e2 = function (n) { return (Math.round(n * 100) / 100).toFixed(2).replace('.', ',') + ' €'; };
    h += '<div class="kick">Les rédactrices</div><div class="lb">' + gagnants().map(function (w) {
      var so = ((r.soldes || {})[w.id]) || 0;
      return '<div style="flex-wrap:wrap;gap:8px"><span><b>' + esc(w.nom) + '</b><br><span class="muted" style="font-size:13px">' + totalPieces(w.id) + ' pièces gagnées au total</span></span><span style="text-align:right"><b>🪙 ' + so + '</b> à convertir<br><span class="muted" style="font-size:13px">soit ' + e2(so * tx) + '</span></span>' +
        (me.chef && so ? '<span class="acts" style="width:100%;margin:6px 0 0"><button class="go" data-act="pc-conv" data-id="' + esc(w.id) + '">💶 Convertir en ' + e2(so * tx) + ' (prochaine facture)</button><button data-act="pc-raz" data-id="' + esc(w.id) + '">↺ Remettre à zéro</button></span>' : '') + '</div>';
    }).join('') + '</div>';
    if (me.chef) h += '<div class="row" style="gap:8px;align-items:center;margin:-4px 0 14px;font-size:14px">Valeur d’une pièce : <input class="pin" id="wl-taux" value="' + String(tx).replace('.', ',') + '" style="width:90px;margin:0" inputmode="decimal"> € <button class="btn small" data-act="pc-taux">Enregistrer</button></div>';
    var cs = r.conversions || [];
    if (cs.length) {
      var conf = cs.filter(function (c) { return c.statut === 'facture'; }).reduce(function (a, c) { return a + Number(c.montant); }, 0), att = cs.filter(function (c) { return c.statut === 'a_facturer'; }).reduce(function (a, c) { return a + Number(c.montant); }, 0);
      h += '<h2>Comptabilité</h2><p class="muted" style="font-size:14px">' + e2(att) + ' à ajouter à une facture · ' + e2(conf) + ' déjà ajoutés aux factures</p>' + cs.map(function (c) {
        var mine = c.membre === me.id;
        var st = c.statut === 'a_facturer' ? '<span class="tag a">💶 à ajouter à la prochaine facture</span>' : c.statut === 'facture' ? '<span class="tag g">✅ ajouté à la facture ' + esc(when(c.facture_le)) + (c.facture_note ? ' · ' + esc(c.facture_note) : '') + '</span>' : '<span class="tag">↺ remis à zéro</span>';
        return '<div class="pc"><div><b>' + (c.type === 'conversion' ? e2(Number(c.montant)) : '—') + '</b> · ' + c.pieces + ' pièces' + (c.type === 'conversion' ? ' à ' + e2(Number(c.taux)) : '') + ' · ' + esc(membre(c.membre).nom) + ' · ' + esc(when(c.created_at)) + '</div><div style="margin-top:4px">' + st + '</div>' + (c.note ? '<div class="muted" style="font-size:13px">Note : ' + esc(c.note) + '</div>' : '') +
          (c.statut === 'a_facturer' && (mine || me.chef) ? '<div class="row" style="gap:6px;margin-top:8px;align-items:center"><input class="pin" id="wl-fact-' + c.id + '" placeholder="n° ou date de la facture (facultatif)" style="flex:1;min-width:160px;margin:0"><button class="btn small go" data-act="pc-fact" data-id="' + c.id + '">✅ ' + (mine ? 'Je l’ai ajouté à ma facture' : 'Marquer comme facturé') + '</button></div>' : '') + '</div>';
      }).join('');
    }
    h += '<details' + ((r.pieces || []).length ? '' : ' open') + '><summary>Comment on gagne des pièces</summary><ol style="font-size:15px">' +
      '<li>La demande d’interview part <b>depuis le lab</b> (pas d’un autre logiciel).</li>' +
      '<li>Le chercheur <b>répond à ce mail</b> : le Courrier le reconnaît grâce aux en-têtes techniques du fil, impossibles à imiter. Une réponse collée à la main ne compte pas.</li>' +
      '<li>Sa citation est <b>insérée dans l’article depuis le lab</b>, et Ghost l’accepte.</li></ol>' +
      '<p style="font-size:15px"><b>Barème :</b> avant publication ou jusqu’à 2 jours après → <b>10 pièces</b> · jusqu’à 4 jours → <b>5</b> · jusqu’au 6e jour → <b>2</b> · à partir du 7e jour → 0 (la semaine est passée, ce sera pour la prochaine).</p>' +
      '<p class="muted" style="font-size:13.5px">Contrôles : une seule récompense par fiche ; une adresse de messagerie gratuite (gmail…), une adresse de l’équipe ou une réponse très courte passent en « à vérifier » par le rédacteur en chef.</p></details>';
    h += '<h2>Historique</h2>' + ((r.pieces || []).map(function (p) {
      var st = PST2[p.statut] || ['·', p.statut, ''];
      return '<div class="pc"><div><b>' + (p.montant ? '+' + p.montant : '0') + '</b> <span class="tag ' + st[2] + '">' + st[0] + ' ' + esc(st[1]) + '</span> · ' + esc(membre(p.membre).nom) + '</div>' +
        '<div class="muted" style="font-size:13.5px">' + esc(p.contact || '') + ' — ' + esc(p.article_titre || '') + '<br>' + esc(p.motif || '') + ' · ' + esc(when(p.created_at)) + '</div>' +
        (me.chef && (p.statut === 'a_verifier' || p.statut === 'acquis') ? '<div class="acts" style="margin-top:6px">' + (p.statut === 'a_verifier' ? '<button class="go" data-act="pc-ok" data-id="' + p.id + '">✅ Valider</button>' : '') + '<button class="red" data-act="pc-annule" data-id="' + p.id + '">✖️ Annuler</button></div>' : '') + '</div>';
    }).join('') || '<p class="muted">Pas encore de pièces : le premier parcours complet arrive bientôt.</p>');
    return h + '</div>';
  }
  function parcoursHTML(f) {
    var w = membre(f.redacteur), chefFiche = w.role === 'chef' && !testRec(), p = pieceDe(f.fiche_id), v = verifiee(f.fiche_id);
    var et = function (on, txt) { return '<span class="pa' + (on ? ' on' : '') + '">' + txt + '</span>'; };
    // 23/10/2026 : message exact selon le vrai cas. Preuve = en-têtes du fil (notre Message-ID), pas l'adresse seule.
    var pv = ((S.pieces && S.pieces.preuves) || {})[f.fiche_id] || null;
    var parCourrier = (f.historique || []).some(function (e) { return e && e.par === 'courrier' && /réponse reçue/.test(String(e.e || '')); });
    var tel = !!(f.reponse && pv && pv.lien === 'telephone');
    var etiq = !f.reponse ? '📬 réponse' : tel ? '📞 réponse par téléphone' : v || !D().me.chef ? '📬 réponse reçue' : parCourrier ? '📬 réponse hors du fil' : '📝 réponse saisie à la main';
    var note = '';
    if (tel) note = 'Réponse reçue par téléphone' + (chefFiche ? '.' : ' : pas de preuve par mail, les pièces éventuelles passent « à vérifier » au Comptable.');
    else if (f.reponse && v && pv && pv.lien === 'meme_domaine') note = 'Réponse reçue dans le fil, depuis ' + pv.de + ' (autre adresse du même domaine que le contact).';
    else if (f.reponse && v && pv && pv.lien === 'autre_adresse') note = 'Réponse reçue dans le fil, depuis ' + pv.de + ' : une autre adresse que celle du contact' + (chefFiche ? '.' : ', les pièces passent « à vérifier » au Comptable.');
    else if (f.reponse && !v && D().me.chef && !chefFiche) note = parCourrier ? 'Réponse reçue hors du fil (sans référence à notre mail) : pas de pièces automatiques.' : 'Réponse ajoutée à la main : pas de pièces automatiques.';
    return '<div class="parc">' + et(!!f.envoye_le, '✉️ envoyée') + '<i></i>' + et(!!f.reponse, etiq) + '<i></i>' + et(f.statut === 'inséré', '✅ citée') +
      (chefFiche ? '' : '<i></i>' + et(p && p.statut === 'acquis', p ? (PST2[p.statut] || ['🪙'])[0] + ' ' + (p.montant || 0) + ' pièces' : '🪙 pièces')) + '</div>' +
      (note ? '<p class="muted" style="margin:4px 0 0;font-size:13px">' + esc(note) + '</p>' : '');
  }

  // Fenêtre de confirmation au style du lab (remplace window.confirm) : titre = première ligne, détail = la suite.
  // Rouge si l'action supprime / archive / abandonne. Entrée = confirmer, Échap ou clic à côté = annuler.
  function confirmer(msg) { return PHL.confirmer(S.root, msg); }
  // ---------- Case « Article publié » (22/10/2026) ----------
  // À côté de chaque bouton qui fait rédiger un mail au chercheur. Cochée par défaut : le mail dit que l'article EST publié
  // (avec son lien s'il est déjà en ligne dans Ghost ; sans lien si c'est encore un brouillon, il le sera le temps que la personne
  // lise et réponde). Décochée : « je prépare un article sur… ». L'état est gardé pendant les rafraîchissements, remis à « cochée »
  // après chaque rédaction.
  var PUB_TIP = 'Article publié|Cochée (par défaut) : le mail dit que l’article est publié et propose d’y ajouter ses réponses — avec le lien s’il est déjà en ligne.|Décochée : le mail parle d’un article en préparation.';
  function pubEtat(k, def) { S.pub = S.pub || {}; return S.pub[k] != null ? S.pub[k] : (def != null ? def : true); }
  function pubBox(k, def) { return '<label class="pubchk" data-stop="1" data-tip="' + esc(PUB_TIP) + '" data-tip-act="Survolez, puis cochez ou décochez"><input type="checkbox" class="pub-in" data-pub="' + esc(k) + '"' + (pubEtat(k, def) ? ' checked' : '') + '><span>Article publié</span></label>'; }
  function pubWrap(k, btn, def) { return '<span class="pubwrap">' + btn + pubBox(k, def) + '</span>'; }
  function pubDe(t, k, def) { var w = t && t.closest && t.closest('.pubwrap'), c = w && w.querySelector('.pub-in'); return c ? !!c.checked : pubEtat(k, def); }
  function pubOubli(k) { if (S.pub) delete S.pub[k]; }
  // Dernier choix mémorisé dans la fiche (historique), pour réécrire un mail dans le même sens.
  function pubFiche(f) { var h = (f && f.historique) || []; for (var j = h.length - 1; j >= 0; j--) if (h[j] && typeof h[j].publie === 'boolean') return h[j].publie; return true; }
  // Confirmation de la préparation express, avec la case (la case peut aussi venir de l'étagère, où il n'y a pas de bouton).
  function confirmerPub(msg, def) {
    return new Promise(function (resolve) {
      var parts = String(msg).split('\n\n'), titre = parts.shift(), detail = parts.join('\n\n');
      masquerTip(); var bg = document.createElement('div'); bg.className = 'cfm-bg';
      bg.innerHTML = '<div class="cfm" role="dialog" aria-modal="true"><div class="cfm-ic">✅</div><div class="cfm-t">' + esc(titre) + '</div>' + (detail ? '<div class="cfm-d">' + esc(detail).replace(/\n/g, '<br>') + '</div>' : '') +
        '<label class="pubchk cfm-pub" data-stop="1" data-tip="' + esc(PUB_TIP) + '" data-tip-act="Survolez, puis cochez ou décochez"><input type="checkbox" class="pub-cfm"' + (def ? ' checked' : '') + '><span>Article publié</span></label>' +
        '<div class="cfm-a"><button type="button" class="btn" data-cfm="0">Annuler</button><button type="button" class="btn go" data-cfm="1">Préparer</button></div></div>';
      var fin = function (v) { document.removeEventListener('keydown', kd, true); var c = bg.querySelector('.pub-cfm'), pub = c ? !!c.checked : !!def; bg.classList.remove('on'); setTimeout(function () { if (bg.parentNode) bg.parentNode.removeChild(bg); }, 180); resolve({ ok: v, publie: pub }); };
      var kd = function (e) { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); fin(false); } else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); fin(true); } };
      bg.addEventListener('click', function (e) { var b = e.target.closest('[data-cfm]'); if (b) { e.stopPropagation(); fin(b.getAttribute('data-cfm') === '1'); } else if (e.target === bg) fin(false); });
      document.addEventListener('keydown', kd, true);
      S.root.appendChild(bg); requestAnimationFrame(function () { bg.classList.add('on'); var b = bg.querySelector('[data-cfm="1"]'); if (b) b.focus(); });
    });
  }
  function val(id) { var e = S.root.querySelector('#' + id); return e ? e.value : ''; }
  function act(name, t) {
    var id = t.getAttribute('data-id'), i = Number(t.getAttribute('data-i'));
    if (t.classList && t.classList.contains('ld')) return; // déjà en cours : pas de double clic
    S.clicking = name + '|' + (id || '');
    setTimeout(function () { S.clicking = null; }, 0);
    switch (name) {
      case 'refresh': refresh(); break;
      case 'tab': S.tab = t.getAttribute('data-tab'); S.clsr = false; LS.set('wl-tab', S.tab); closePanel(); render(); break;
      case 'articles': openPanel('articles'); break;
      case 'pick-art': pickArt(id); break;
      case 'open-ag': openPanel(t.getAttribute('data-ag').replace(/^j:vide$/, 'chef')); break;
      case 'rd-refresh': S.radar = S.radar && S.radar.ok ? S.radar : null; chargerRadar(); break;
      case 'mb-refresh': chargerMarbre(); break;
      case 'rd-choisir': rdAction({ action: 'choisir', id: id, type: val('rd-t-' + id) }, '✍️ Sujet mis en file : il part au prochain passage de l’Usine.'); break;
      case 'rd-retirer': rdAction({ action: 'decocher', id: id }, 'Retiré de la file.'); break;
      case 'rd-up': case 'rd-down':
        var fl7 = ((S.radar || {}).file || []).filter(function (x) { return !x.vote; }).map(function (x) { return x.id; }), all7 = ((S.radar || {}).file || []).map(function (x) { return x.id; });
        var i7 = fl7.indexOf(id), j7 = name === 'rd-up' ? i7 - 1 : i7 + 1;
        if (i7 < 0 || j7 < 0 || j7 >= fl7.length) break;
        var tmp7 = fl7[i7]; fl7[i7] = fl7[j7]; fl7[j7] = tmp7;
        var ordre7 = all7.filter(function (x) { return fl7.indexOf(x) < 0; }).concat(fl7); // un sujet voté éventuellement coché reste devant
        rdAction({ action: 'ordre', ids: ordre7 }); break;
      case 'rd-imposer':
        var ti8 = val('rd-i-t').trim(), u8 = val('rd-i-u').trim(), a8 = val('rd-i-a').trim(), ty8 = val('rd-i-ty');
        if (ti8.length < 6) { toast('⚠️ Donnez un sujet un peu plus précis.', true); break; }
        S.rdImposer = true;
        rdAction({ action: 'imposer', titre: ti8, url: u8, angle: a8, type: ty8, enquete: ty8 === 'premium' }, '✍️ Sujet imposé : il part en priorité au prochain passage de l’Usine.').then(function (r) { if (r && r.ok) { S.rdImposer = false; ['rd-i-t', 'rd-i-u', 'rd-i-a'].forEach(function (k) { var e = S.root.querySelector('#' + k); if (e) e.value = ''; }); } });
        break;
      case 'rd-ecarter':
        var ck9 = S.clicking; confirmer('Ne pas écrire le sujet choisi par le public ?\n\nIl est retiré de la file de l’Usine. Vous pourrez le remettre tant qu’il n’est pas rédigé.').then(function (ok) { if (!ok) return; S.clicking = ck9; rdAction({ action: 'ecarter', id: id }, 'Sujet du public écarté.'); });
        break;
      case 'rd-remettre': rdAction({ action: 'remettre', id: id }, '↩️ Sujet du public remis en file.'); break;
      case 'rd-relancer':
        var ck10 = S.clicking; confirmer('Lancer un nouveau Radar maintenant ?\n\nL’Usine rassemble les flux et note de nouveaux sujets (quelques minutes). Les sujets du jour non choisis sont archivés.').then(function (ok) { if (!ok) return; S.clicking = ck10;
          radarApi({ action: 'relancer_radar' }).then(function (r) { if (!r || !r.ok) { toast('⚠️ ' + ((r && r.why) || 'impossible'), true); return; } toast('📡 ' + (r.why || 'Radar relancé.')); setTimeout(function () { S.radar = null; chargerRadar(); }, 240000); });
        });
        break;
      case 'mb-approuver':
        var b11 = ((S.marbre || {}).brouillons || []).filter(function (x) { return x.id === id; })[0], ck11 = S.clicking;
        confirmer('Approuver ce brouillon ?\n\n' + (b11 ? '« ' + ((b11.post || {}).titre || b11.titre) + ' »\n\n' : '') + 'Il sera publié au batch du soir (vers 18 h 30), comme avec le lien Approuver de Telegram.').then(function (ok) { if (!ok) return; S.clicking = ck11;
          radarApi({ action: 'approuver', id: id }).then(function (r) { if (!r || !r.ok) { toast('⚠️ ' + ((r && r.why) || 'impossible'), true); return; } toast('✅ Approuvé : publication au batch de 18 h 30.'); chargerMarbre(); });
        });
        break;
      case 'mb-ecarter':
        // 22/10/2026 : écarte un brouillon de l'Usine (Airtable → skipped) ; le post Ghost n'est jamais touché.
        var b12 = ((S.marbre || {}).brouillons || []).filter(function (x) { return x.id === id; })[0], ck12 = S.clicking;
        confirmer('Écarter ce brouillon ?\n\n' + (b12 ? '« ' + ((b12.post || {}).titre || b12.titre) + ' »\n\n' : '') + 'Il ne sera pas publié. Le post Ghost n’est pas supprimé.').then(function (ok) { if (!ok) return; S.clicking = ck12;
          radarApi({ action: 'ecarter_brouillon', id: id }).then(function (r) { if (!r || !r.ok) { toast('⚠️ ' + ((r && r.why) || 'impossible'), true); return; }
            if (S.marbre && S.marbre.brouillons) S.marbre.brouillons = S.marbre.brouillons.filter(function (x) { return x.id !== id; });
            if (S.panel === 'marbre') paintPanel(); toast('🗑️ Brouillon écarté : il ne sera pas publié.'); chargerMarbre(); });
        });
        break;
      case 'close-panel': closePanel(); break;
      case 'close-doc': fermerDoc(); break;
      case 'voir-mails': masquerTip(); voirMails(id); break;
      case 'cons-apercu': consApercu(); break;
      case 'bx-ajouter': S.bxW = { etape: 1, fournisseur: 'ovh', offre: 'mxplan', numero: '1' }; bxPreremplir(); paintPanel(); break;
      case 'bx-annuler': S.bxW = null; paintPanel(); break;
      case 'bx-fourn': if (S.bxW) { S.bxW.fournisseur = id; S.bxW.offre = id === 'ovh' ? 'mxplan' : 'mail'; bxPreremplir(); paintPanel(); } break;
      case 'bx-offre': if (S.bxW) { S.bxW.offre = id; bxPreremplir(); paintPanel(); } break;
      case 'bx-tester': bxTester(); break;
      case 'bx-etape': if (S.bxW) { S.bxW.etape = Number(id); paintPanel(); } break;
      case 'bx-role': if (S.bxW) { S.bxW.role = id; paintPanel(); } break;
      case 'bx-enregistrer': bxEnregistrer(); break;
      case 'bx-recharger': S.bxListe = null; paintPanel(); break;
      case 'bx-retester': bxAction({ action: 'retester', id: id }, null); break;
      case 'bx-mdp': S.bxEdit = S.bxEdit && S.bxEdit.id === id && S.bxEdit.quoi === 'mdp' ? null : { id: id, quoi: 'mdp' }; paintPanel(); break;
      case 'bx-changer-role': S.bxEdit = S.bxEdit && S.bxEdit.id === id && S.bxEdit.quoi === 'role' ? null : { id: id, quoi: 'role' }; paintPanel(); break;
      case 'bx-mdp-ok': bxAction({ action: 'mot_de_passe', id: id, mdp: val('bx-nmdp') }, '🔑 Nouveau mot de passe vérifié et rangé dans le coffre.'); break;
      case 'bx-role-ok': bxAction({ action: 'role', id: id, role: val('bx-nrole'), nom_affiche: val('bx-nnom').trim() }, '🎯 Rôle enregistré.'); break;
      case 'bx-actif': bxActif(id, t.getAttribute('data-on') === '1'); break;
      case 'bx-supprimer': bxSupprimer(id); break;
      case 'eq-nouveau': S.eqEdit = '__nouveau'; S.eqDraft = {}; paintPanel(); var ne = S.root.querySelector('#eq-email'); if (ne) ne.focus(); break;
      case 'eq-edit': S.eqEdit = S.eqEdit === id ? null : id; S.eqDraft = {}; paintPanel(); break;
      case 'eq-annuler': S.eqEdit = null; S.eqDraft = null; paintPanel(); break;
      case 'eq-recharger': S.eqListe = null; paintPanel(); break;
      case 'eq-save': eqEnregistrer(id || ''); break;
      case 'eq-actif': eqActif(id, t.getAttribute('data-on') === '1'); break;
      case 'cons-recharger': S.consListe = null; paintPanel(); break;
      case 'cons-cert': consCertificat(id); break;
      case 'cons-suppr-test': consApi({ action: 'supprimer_test' }).then(function (r) { toast(r && r.ok ? '🗑️ ' + r.supprimes + ' signature' + pl(r.supprimes) + ' de test supprimée' + pl(r.supprimes) + '.' : '⚠️ ' + ((r && r.why) || 'impossible'), !(r && r.ok)); S.consListe = null; paintPanel(); }); break;
      case 'art-tab': S.artTab = id; var ra2 = S.root.querySelector('#wl-art-res'); if (ra2) { ra2.innerHTML = artsRes(); markBusy(); } break;
      case 'prep-retry': reprendrePrep(id); break;
      case 'open-valid': openDoc('valid', id); break;
      case 'tel': telOuvrir(id); break;
      case 'info': infoOuvrir(id); break;
      case 'info-fermer': infoFermer(); break;
      case 'info-onglet': infoOnglet(id); break;
      case 'info-tel': infoFermer(true); telOuvrir(id); break;
      case 'info-ouvrir': infoFermer(true); openPanel(id === 'j:vide' ? 'chef' : id); break;
      case 'tel-fermer': telFermer(); break;
      case 'tel-envoyer': telEnvoyer(); break;
      case 'tel-dicter': if (TEL_DICTEE.actif()) TEL_DICTEE.arreter(); else TEL_DICTEE.demarrer(); break;
      case 'tel-exec': telExec(id); break;
      case 'tel-suite': telSuite(id); break;
      case 'ap-ouvrir': apOuvrir(id); break;
      case 'ap-annuler': if (S.appel && S.appel.actif) { S.appel.actif = false; clearInterval(S.appel.timer); try { S.appel.rec.stop(); } catch (e) {} } if (AP_DICTEE.actif()) AP_DICTEE.arreter(); S.appel = null; paintDoc(); break;
      case 'ap-ecouter': apEcouter(); break;
      case 'ap-stop': apArreter(); break;
      case 'ap-notes': if (S.appel) { S.appel.source = 'notes'; S.appel.etape = 'relire'; paintDoc(); setTimeout(function () { var x = S.root.querySelector('#wl-ap-txt'); if (x) x.focus(); }, 30); } break;
      case 'ap-dicter': if (AP_DICTEE.actif()) AP_DICTEE.arreter(); else AP_DICTEE.demarrer(); break;
      case 'ap-traiter': apTraiter(); break;
      case 'ap-retour': if (S.appel) { S.appel.etape = 'relire'; paintDoc(); } break;
      case 'ap-enregistrer': apEnregistrer(); break;
      case 'open-fiche': openDoc('fiche', id); break;
      case 'open-aide': openDoc('aide', ''); break;
      case 'open-mail': openDoc('mail', id); break;
      case 'open-prospect': openDoc('prospect', id); break;
      case 'camp-new': S.newCamp = { nom: '', offres: [], cible: '', zone: 'Suisse romande, France, Belgique' }; paintPanel(); break;
      case 'camp-cancel': S.newCamp = null; paintPanel(); break;
      case 'camp-toggle': S.campOpen = S.campOpen === id ? null : id; paintPanel(); break;
      case 'camp-create':
        var nc = S.newCamp; if (!nc) break;
        if (!String(nc.nom).trim() || !nc.offres.length) { toast('Donnez un nom et cochez au moins une offre.', true); break; }
        work('mk', 'ouvre la campagne', api('prospect', { op: 'campagne', nom: nc.nom, offres: nc.offres, cible: nc.cible, zone: nc.zone })).then(function () { S.newCamp = null; toast('🎯 Campagne créée.'); return refresh(true); });
        break;
      case 'p-chercher':
        S.campOpen = id;
        work('mk', 'cherche des prospects', api('prospect', { op: 'chercher', campagne_id: id })).then(function (r) { toast('🔎 ' + (r.resume || 'recherche terminée')); return refresh(true); });
        break;
      case 'p-rediger':
        work('mk', 'rédige le mail', api('prospect', { op: 'rediger', prospect_id: id, consigne: val('wl-p-consigne') })).then(function () { if (S.pEdit) delete S.pEdit[id]; if (document.activeElement) document.activeElement.blur(); return refresh(true); }).then(function () { paintDoc(); toast('🤖 Mail prêt : relisez-le.'); });
        break;
      case 'p-garder':
        api('prospect', { op: 'maj', prospect_id: id, sujet: val('wl-p-sujet'), corps: val('wl-p-corps'), email: val('wl-p-email').trim() }).then(function () { if (S.pEdit) delete S.pEdit[id]; toast('💾 Gardé.'); return refresh(true); }, function (e) { toast('⚠️ ' + e.message, true); });
        break;
      case 'p-envoyer':
        var px1 = prospect(id), pe = val('wl-p-email').trim(), ps1 = val('wl-p-sujet').trim(), pc = val('wl-p-corps').trim();
        if (!px1 || !pe || !ps1 || !pc) { toast('Adresse, objet ou message vide.', true); break; }
        var ck0 = S.clicking; confirmer('Envoyer ce mail à ' + pe + ' (' + px1.entreprise + ') depuis redaction@posthumain.com ?').then(function (ok) { if (!ok) return; S.clicking = ck0; setTimeout(function () { S.clicking = null; }, 0);
          work('mk', 'envoie le mail', api('prospect', { op: 'envoyer', prospect_id: id, valide: '1', email: pe, sujet: ps1, corps: pc })).then(function () { if (S.pEdit) delete S.pEdit[id]; toast('📨 Mail envoyé.'); return refresh(true); }).then(function () { paintDoc(); });
        });
        break;
      case 'p-statut':
        api('prospect', { op: 'maj', prospect_id: id, statut: t.getAttribute('data-st') }).then(function () { toast('✓ Mis à jour.'); return refresh(true); }).then(function () { paintDoc(); }, function (e) { toast('⚠️ ' + e.message, true); });
        break;
      case 'p-stop':
        var ck1 = S.clicking; confirmer('Ne plus jamais contacter cette entreprise (et cette adresse) ?').then(function (ok) { if (!ok) return; S.clicking = ck1; setTimeout(function () { S.clicking = null; }, 0);
          api('prospect', { op: 'stop', prospect_id: id }).then(function () { toast('⛔ Retiré.'); return refresh(true); }).then(function () { paintDoc(); }, function (e) { toast('⚠️ ' + e.message, true); });
        });
        break;
      case 'm-propose':
        var mp = mail(id); if (!mp) break;
        work(bureauDe(mp.boite) || 'mk', 'rédige une réponse', api('proposer', { mail_id: id, consigne: val('wl-m-consigne') })).then(function () { if (S.mEdit) delete S.mEdit[id]; if (document.activeElement) document.activeElement.blur(); return refresh(true); }).then(function () { paintDoc(); toast('🤖 Proposition prête : relisez-la.'); });
        break;
      case 'm-save':
        api('classer', { mail_id: id, sujet: val('wl-m-sujet'), corps: val('wl-m-corps') }).then(function () { if (S.mEdit) delete S.mEdit[id]; toast('💾 Réponse gardée.'); return refresh(true); }, function (e) { toast('⚠️ ' + e.message, true); });
        break;
      case 'm-demande':
        api('classer', { mail_id: id, categorie: 'demande' }).then(function () { toast('📩 Classé en demande.'); return refresh(true); }, function (e) { toast('⚠️ ' + e.message, true); });
        break;
      case 'm-archive':
        var ck2 = S.clicking; confirmer('Archiver ce mail ? Il disparaîtra du bureau de Julien.').then(function (ok) { if (!ok) return; S.clicking = ck2; setTimeout(function () { S.clicking = null; }, 0);
          api('classer', { mail_id: id, statut: 'archivé' }).then(function () { closeDoc(); toast('🗄️ Archivé.'); return refresh(true); }, function (e) { toast('⚠️ ' + e.message, true); });
        });
        break;
      case 'm-send':
        var ms1 = mail(id), su = val('wl-m-sujet').trim(), co = val('wl-m-corps').trim();
        if (!ms1 || !su || !co) { toast('Objet ou réponse vide.', true); break; }
        var ck3 = S.clicking; confirmer('Envoyer cette réponse à ' + ms1.de_email + ' ?').then(function (ok) { if (!ok) return; S.clicking = ck3; setTimeout(function () { S.clicking = null; }, 0);
          work(bureauDe(ms1.boite) || 'mk', 'envoie la réponse', api('repondre', { mail_id: id, valide: '1', sujet: su, corps: co, pieces: pjsData('m:' + id) })).then(function () { if (S.mEdit) delete S.mEdit[id]; if (S.pjs) delete S.pjs['m:' + id]; closeDoc(); toast('📨 Réponse envoyée.'); return refresh(true); });
        });
        break;
      // l'Assistant
      case 'find-contacts':
        work('assistant', 'cherche les chercheurs', api('contacts', { article_id: S.art })).then(function (r) { S.contacts = r.contacts || []; saveDraft(); paintPanel(); if (!S.contacts.length) toast('Personne de sûr trouvé : saisissez un contact.'); });
        break;
      case 'contact-pick': var c = S.contacts[i]; S.contact = { nom: c.nom || '', email: c.email || '', role: c.role || '', institution: c.institution || '', langue: c.langue === 'en' ? 'en' : 'fr', profil_url: c.profil_url || '', source_email: c.source_email || '', pourquoi: c.pourquoi || '', ou_trouver: c.ou_trouver || '' }; saveDraft(); paintPanel(); break;
      case 'contact-new': S.contact = { nom: '', email: '', role: '', institution: '', langue: 'fr' }; saveDraft(); paintPanel(); break;
      case 'contact-clear': S.contact = null; saveDraft(); paintPanel(); break;
      case 'propose-q':
        work('assistant', 'prépare les questions', api('questions', { article_id: S.art, contact: S.contact, angle: S.angle })).then(function (r) {
          var nouv = (r.questions || []).map(function (q) { return { q: q.q, pourquoi: q.pourquoi, garde: false, k: uid() }; });
          S.qs = S.qs.filter(function (q) { return q.garde; }).concat(nouv); saveDraft(); paintPanel(); paintFloor();
        });
        break;
      case 'q-add': S.qs.push({ q: '', pourquoi: '', garde: true, k: uid() }); saveDraft(); paintPanel(); var ta = S.root.querySelector('[data-qi="' + (S.qs.length - 1) + '"]'); if (ta) ta.focus(); break;
      case 'q-keep': S.qs[i].garde = !S.qs[i].garde; saveDraft(); paintPanel(); paintFloor(); break;
      case 'q-del': S.qs.splice(i, 1); S.reformule = null; saveDraft(); paintPanel(); paintFloor(); break;
      case 'q-ref': S.reformule = i; paintPanel(); var ri = S.root.querySelector('#wl-ref'); if (ri) ri.focus(); break;
      case 'q-ref-x': S.reformule = null; paintPanel(); break;
      case 'q-ref-go':
        var cons = val('wl-ref'), q0 = S.qs[i]; S.reformule = null;
        work('assistant', 'reformule', api('reformuler', { article_id: S.art, article_titre: (art(S.art) || {}).titre, question: q0.q, consigne: cons, langue: S.contact && S.contact.langue })).then(function (r) {
          var k = S.qs.indexOf(q0); if (k >= 0) { S.qs[k].q = r.q || q0.q; S.qs[k].pourquoi = r.pourquoi || q0.pourquoi; } saveDraft(); paintPanel();
        });
        break;
      case 'to-secretaire':
        var kept = S.qs.filter(function (q) { return q.garde && String(q.q).trim(); }).map(function (q) { return q.q.trim(); });
        work('secretaire', 'rédige le mail', api('rediger', { article_id: S.art, contact: S.contact, questions: kept, type: 'interview', echeance: S.echeance, consigne: S.consigneSec, publie: pubDe(t, 'sec') })).then(function (r) {
          pubOubli('sec'); S.contact = null; S.qs = []; S.echeance = ''; S.consigneSec = ''; saveDraft(); closePanel();
          return refresh(true).then(function () { openDoc('valid', r.fiche_id); toast('📮 La Secrétaire a rédigé le mail : relisez-le.'); });
        });
        break;
      // la Secrétaire
      case 'libre':
        var L = S.libre, lie = S.root.querySelector('#wl-libre-art');
        if (!String(L.nom).trim()) { toast('Il manque le nom du destinataire.', true); break; }
        if (!String(L.consigne).trim()) { toast('Dites ce que vous voulez lui écrire.', true); break; }
        work('secretaire', 'rédige le mail', api('rediger', { article_id: lie && lie.checked ? S.art : '', contact: L, type: 'libre', consigne: L.consigne, echeance: L.echeance, publie: pubDe(t, 'libre') })).then(function (r) {
          pubOubli('libre'); S.libre = { nom: '', email: '', role: '', institution: '', langue: 'fr', consigne: '', echeance: '' }; closePanel();
          return refresh(true).then(function () { openDoc('valid', r.fiche_id); toast('📮 Mail rédigé : relisez-le.'); });
        });
        break;
      case 'v-email':
        var em = val('wl-v-email').trim(), f0 = fiche(id);
        if (!/^[^\s@<>]+@[^\s@<>]+\.[a-z]{2,}$/i.test(em)) { toast('Adresse e-mail invalide.', true); break; }
        api('maj', { fiche_id: id, contact: { nom: f0.contact.nom, email: em, role: f0.contact.role, institution: f0.contact.institution }, mail_sujet: val('wl-v-sujet'), mail_corps: val('wl-v-corps') }).then(function () { return refresh(true); }).then(function () { paintDoc(); toast('Adresse enregistrée.'); }, function (e) { toast('⚠️ ' + e.message, true); });
        break;
      case 'v-save':
        api('maj', { fiche_id: id, mail_sujet: val('wl-v-sujet'), mail_corps: val('wl-v-corps') }).then(function () { forget(id); return refresh(true); }).then(function () { toast('💾 Corrections gardées.'); }, function (e) { toast('⚠️ ' + e.message, true); });
        break;
      case 'v-redo': var box = S.root.querySelector('#wl-v-redo'); if (box) { box.style.display = 'block'; var vc = S.root.querySelector('#wl-v-consigne'); if (vc) vc.focus(); } break;
      case 'v-redo-go':
        work('secretaire', 'réécrit le mail', api('rediger', { fiche_id: id, article_id: (fiche(id) || {}).article_id || '', type: (fiche(id) || {}).questions && fiche(id).questions.length ? 'interview' : 'libre', consigne: val('wl-v-consigne'), publie: pubDe(t, 'v:' + id, pubFiche(fiche(id))) })).then(function () { forget(id); pubOubli('v:' + id); if (document.activeElement) document.activeElement.blur(); return refresh(true); }).then(function () { paintDoc(); toast('✏️ Nouvelle version prête.'); });
        break;
      case 'v-send':
        if (testBloque()) break;
        var f1 = fiche(id), sujet = val('wl-v-sujet').trim(), corps = val('wl-v-corps').trim();
        if (!sujet || !corps) { toast('Objet ou message vide.', true); break; }
        var ck4 = S.clicking; confirmer('Envoyer ce mail à ' + f1.contact.nom + ' (' + f1.contact.email + ') ?').then(function (ok) { if (!ok) return; S.clicking = ck4; setTimeout(function () { S.clicking = null; }, 0);
          work('secretaire', 'envoie le mail', api('envoyer', { fiche_id: id, valide: '1', sujet: sujet, corps: corps, pieces: pjsData('v:' + id) })).then(function () {
            forget(id); if (S.pjs) delete S.pjs['v:' + id]; fermerDoc(); toast('📨 Mail envoyé à ' + f1.contact.nom + '.'); return refresh(true);
          });
        });
        break;
      case 'archive':
        var ck5 = S.clicking; confirmer('Archiver cette fiche ? Elle disparaîtra du lab.').then(function (ok) { if (!ok) return; S.clicking = ck5; setTimeout(function () { S.clicking = null; }, 0);
          api('maj', { fiche_id: id, statut: 'archivé' }).then(function () { fermerDoc(); toast('🗄️ Fiche archivée.'); return refresh(true); }, function (e) { toast('⚠️ ' + e.message, true); });
        });
        break;
      // le Courrier
      case 'relever':
        refresh(true).then(function () { toast('📬 Les boîtes sont relevées en continu : tout nouveau mail arrive ici tout seul.'); });
        break;
      case 'relance':
        work('secretaire', 'prépare la relance', api('rediger', { fiche_id: id, article_id: (fiche(id) || {}).article_id || '', type: 'relance' })).then(function () { return refresh(true); }).then(function () { openDoc('valid', id); toast('🔁 Relance prête : relisez-la.'); });
        break;
      case 'r-send':
        if (testBloque()) break;
        var fr = fiche(id), rs = val('wl-r-sujet').trim(), rc = val('wl-r-corps').trim();
        if (!fr) break;
        if (!rs || !rc) { toast('Objet ou message vide.', true); break; }
        var ckr = S.clicking; confirmer('Envoyer la relance à ' + fr.contact.nom + ' (' + fr.contact.email + ') ?\nElle part dans le même fil que le premier mail.').then(function (ok) { if (!ok) return; S.clicking = ckr; setTimeout(function () { S.clicking = null; }, 0);
          work('secretaire', 'envoie la relance', api('relance_envoyer', { fiche_id: id, sujet: rs, corps: rc })).then(function () {
            if (S.rEdit) delete S.rEdit[id]; toast('📨 Relance envoyée à ' + fr.contact.nom + '.'); return refresh(true);
          }).catch(function () {});
        });
        break;
      case 'su-ouvrir': S.suOuvert = id; paintDoc(); setTimeout(function () { var t = S.root.querySelector('#wl-su-consigne'); if (t) t.focus(); }, 30); break;
      case 'su-refaire': S.suOuvert = id; paintDoc(); break;
      case 'su-relance': S.suDraft = S.suDraft || {}; S.suDraft[id] = { consigne: SU_RELANCE, tel: '' }; S.suOuvert = id; paintDoc(); break;
      case 'fiche-traitee':
        if (capTraiter()) telApi({ action: capTraiter(), fiche_id: id }).then(function (r) { if (!r || !r.ok) { toast('⚠️ ' + ((r && r.why) || 'impossible'), true); return; } return refresh(true).then(function () { paintDoc(); toast('✓ Réponse marquée comme traitée : la fiche attend la suite du contact.'); }); });
        break;
      case 'su-fermer': if (SU_DICTEE.actif()) SU_DICTEE.arreter(); S.suOuvert = null; paintDoc(); break;
      case 'su-dicter': if (SU_DICTEE.actif()) SU_DICTEE.arreter(); else SU_DICTEE.demarrer(); break;
      case 'su-montel': S.suDraft = S.suDraft || {}; S.suDraft[id] = { consigne: val('wl-su-consigne'), tel: (S.suites && S.suites.tel) || '' }; paintDoc(); break;
      case 'su-rediger': suiteRediger(id); break;
      case 'su-send': suiteEnvoyer(id); break;
      case 'su-skip':
        if (capSuite()) telApi({ action: capSuite().executeur.ecarter, fiche_id: id }).then(function (r) { if (!r || !r.ok) { toast('⚠️ ' + ((r && r.why) || 'impossible'), true); return; } if (S.suites && S.suites.l[id]) S.suites.l[id].corps = ''; if (S.suEdit) delete S.suEdit[id]; paintDoc(); toast('🗑️ Réponse écartée.'); });
        break;
      case 'r-skip':
        api('relance_ignorer', { fiche_id: id }).then(function () { if (S.rEdit) delete S.rEdit[id]; return refresh(true); }).then(function () { toast('⏰ Relance mise de côté.'); }, function (e) { toast('⚠️ ' + e.message, true); });
        break;
      case 'colle': S.colle = !S.colle; paintDoc(); break;
      case 'colle-go':
        var txt = val('wl-colle').trim(); if (!txt) break;
        var cc = val('wl-colle-canal');
        api('maj', { fiche_id: id, reponse: txt }).then(function () { S.colle = false; return cc ? telApi({ action: 'canal', fiche_id: id, canal: cc }) : null; }).then(function () { return refresh(true); }).then(function () { paintDoc(); toast('Réponse enregistrée.'); }, function (e) { toast('⚠️ ' + e.message, true); });
        break;
      // la citation dans l'article
      case 'cit':
        S.cit = { fid: id, ins: null, open: {}, fait: {}, skip: {}, done: '' }; paintDoc();
        work('assistant', 'place les citations dans l’article', api('citation', { fiche_id: id, article_id: (fiche(id) || {}).article_id || '' })).then(function (r) {
          if (S.cit && S.cit.fid === id) { S.cit.ins = r.insertions || []; S.cit.open = { 0: true }; } paintDoc();
        }, function () { S.cit = null; paintDoc(); });
        break;
      case 'chapo':
        var fc = fiche(id); if (!fc) break;
        S.chapo = { aid: fc.article_id, props: null, fait: {} }; paintDoc();
        work('assistant', 'cherche où évoquer les experts', api('chapo', { article_id: fc.article_id, experts: expertsCites(fc.article_id) })).then(function (r) {
          if (S.chapo && S.chapo.aid === fc.article_id) S.chapo.props = r.propositions || []; paintDoc();
        }, function () { S.chapo = null; paintDoc(); });
        break;
      case 'chapo-ok':
        var CH = S.chapo, xp = CH && CH.props && CH.props[i]; if (!xp) break;
        var ckH = S.clicking; confirmer('Ajouter cette mention au début de l’article ?\n\n« ' + xp.texte + ' »').then(function (ok) { if (!ok) return; S.clicking = ckH; setTimeout(function () { S.clicking = null; }, 0);
          work('marbre', 'ajoute la mention', api('inserer', { fiche_id: id, chapo: { index: xp.apres, ancre: xp.ancre, texte: xp.texte, mode: xp.mode } })).then(function () {
            CH.fait[i] = true; toast('✅ Mention ajoutée au début de l’article.'); paintDoc();
          });
        });
        break;
      case 'cit-tog': if (S.cit) { S.cit.open[i] = !S.cit.open[i]; paintDoc(); } break;
      case 'cit-maj': paintDoc(); break;
      case 'cit-skip': if (S.cit) { S.cit.skip[i] = !S.cit.skip[i]; if (S.cit.skip[i]) S.cit.open[i] = false; paintDoc(); } break;
      case 'cit-one': case 'cit-all':
        var C = S.cit; if (!C || !C.ins) break;
        var ks = name === 'cit-one' ? [i] : C.ins.map(function (x, k) { return k; }).filter(function (k) { return !C.fait[k] && !C.skip[k]; });
        if (!ks.length) break;
        var items = ks.map(function (k) { var x = C.ins[k]; return { index: x.apres, ancre: x.ancre, intro: x.intro || '', citation: x.citation || '', attribution: x.attribution || '' }; });
        var ckC = S.clicking; confirmer(ks.length > 1 ? 'Insérer les ' + ks.length + ' citations dans l’article ?\n\nChacune est placée après son paragraphe ; les encarts, cartes et le paywall ne sont pas touchés.' : 'Insérer cette citation dans l’article ?').then(function (ok) { if (!ok) return; S.clicking = ckC; setTimeout(function () { S.clicking = null; }, 0);
          work('marbre', ks.length > 1 ? 'insère les citations' : 'insère la citation', api('inserer', { fiche_id: id, items: items })).then(function (r) {
            ks.forEach(function (k) { C.fait[k] = true; C.open[k] = false; });
            var suiv = C.ins.findIndex(function (x, k) { return !C.fait[k] && !C.skip[k]; }); if (suiv >= 0) C.open[suiv] = true;
            C.done = r.editeur; toast(ks.length > 1 ? '✅ ' + ks.length + ' citations insérées.' : '✅ Citation insérée dans l’article.'); return refresh(true);
          }).then(function () { paintDoc(); });
        });
        break;
      // interphone
      case 'pieces': masquerTip(); closeDoc(); S.ctab = 'pieces'; openPanel('compta'); break;
      case 'bord': masquerTip(); closeDoc(); S.ctab = 'bord'; openPanel('compta'); chargerCouts(); break;
      case 'ct-tab': var ctv = t.getAttribute('data-id'); S.ctab = ctv === 'factures' || ctv === 'bord' ? ctv : 'pieces'; if (S.ctab === 'factures') chargerFactures(); if (S.ctab === 'bord') chargerCouts(); paintPanel(); break;
      case 'parametres': closeDoc(); openPanel('parametres'); break;
      case 'theme': basculerTheme(); break;
      case 'voir-facture': masquerTip(); closeDoc(); S.ctab = 'factures'; openPanel('compta'); chargerFactures(); break;
      case 'fa-tarifs':
        factApi({ action: 'tarifs', premium: val('wl-tp'), standard: val('wl-ts') }).then(function (r) { if (!r || !r.ok) { toast('⚠️ ' + ((r && r.why) || 'tarifs invalides'), true); return; } toast('🧾 Tarifs enregistrés : ' + eurTxt(r.tarif_premium) + ' / ' + eurTxt(r.tarif_standard)); chargerFactures(); });
        break;
      case 'fa-edit': S.faEdit = Number(id) || null; paintPanel(); break;
      case 'fa-regen':
        var fid3 = Number(id), corps3 = { action: 'ajuster', id: fid3, premium_qte: val('fa-pq'), tarif_premium: val('fa-pp'), standard_qte: val('fa-sq'), tarif_standard: val('fa-sp'), interview: val('fa-iv') };
        var ck3 = S.clicking; confirmer('Régénérer la facture avec ces valeurs ?\n\nLe PDF est refait et la rédactrice est prévenue.').then(function (ok) { if (!ok) return; S.clicking = ck3;
          factApi(corps3).then(function (r) { if (!r || !r.ok) { toast('⚠️ ' + ((r && r.why) || 'impossible'), true); return; } S.faEdit = null; toast('🧾 Facture régénérée : ' + eurTxt(Number(r.facture.total))); chargerFactures(); });
        });
        break;
      case 'fa-payer':
        var fid4 = Number(id), f4 = ((S.factures || {}).factures || []).filter(function (x) { return x.id === fid4; })[0];
        var ck4 = S.clicking; confirmer('Marquer cette facture comme payée ?\n\n' + (f4 ? moisTxt(f4.mois) + ' : ' + eurTxt(Number(f4.total)) + '. ' : '') + 'La rédactrice est prévenue du paiement. Une facture payée ne se modifie plus.').then(function (ok) { if (!ok) return; S.clicking = ck4;
          factApi({ action: 'payer', id: fid4 }).then(function (r) { if (!r || !r.ok) { toast('⚠️ ' + ((r && r.why) || 'impossible'), true); return; } toast('💸 Facture marquée payée.'); chargerFactures(); });
        });
        break;
      case 'fa-lancer':
        toast('⚡ Comptage des articles du mois dans Ghost…');
        factApi({ action: 'lancer' }).then(function (r) { if (!r || !r.ok) { toast('⚠️ ' + ((r && r.why) || 'impossible'), true); return; } toast('🧾 Facture du mois générée.'); chargerFactures(); });
        break;
      case 'fa-zip':
        var an5 = val('wl-fa-an'); toast('⬇️ Préparation du ZIP ' + an5 + '…');
        factApi({ action: 'zip', annee: an5 }).then(function (r) { if (!r || !r.ok) { toast('⚠️ ' + ((r && r.why) || 'impossible'), true); return; } toast('⬇️ ' + r.nombre + ' facture' + pl(r.nombre) + ' dans le ZIP.'); window.open(r.url, '_blank'); });
        break;
      case 'set-push':
        if (S.pushOk) {
          LS.set('wl-push-off', '1'); LS.set('wl-push-sid', ''); S.pushOk = false; paintPanel(); majTop();
          pushApi({ action: 'unregister' }).then(function () { toast('🔕 Notifications désactivées sur ce navigateur.'); });
        } else {
          LS.set('wl-push-off', '');
          var go = function () { reglerPush(true); setTimeout(function () { paintPanel(); majTop(); }, 2500); };
          if (typeof Notification !== 'undefined' && Notification.permission === 'default' && Notification.requestPermission) Notification.requestPermission().then(go, go);
          else if (typeof Notification !== 'undefined' && Notification.permission === 'denied') toast('Le navigateur bloque les notifications de posthumain.com : autorisez-les dans les réglages du site (cadenas à gauche de l’adresse), puis réessayez.', true);
          else go();
        }
        break;
      case 'sig-lang': sigLire(); S.sigLang = id; paintPanel(); break;
      case 'sig-cmd':
        var ed = S.root.querySelector('#wl-sig'); if (!ed) break; ed.focus();
        if (id === 'link') { var u = window.prompt('Adresse du lien (https://…)', 'https://'); if (u && /^(https?:\/\/|mailto:)/i.test(u)) document.execCommand('createLink', false, u); }
        else document.execCommand(id, false, null);
        sigLire(); break;
      case 'sig-reset': if (S.params) { S.sigDraft[S.sigLang || 'fr'] = S.params.defaut[S.sigLang || 'fr']; paintPanel(); } break;
      case 'sig-save':
        sigLire();
        pushApi({ action: 'parametres_set', fr: S.sigDraft.fr, en: S.sigDraft.en }).then(function (r) {
          if (!r || !r.ok) { toast('⚠️ ' + ((r && r.why) || 'enregistrement impossible'), true); return; }
          S.sigDraft = { fr: r.signature.fr, en: r.signature.en }; S.params.signature = r.signature; toast('✍️ Signatures enregistrées.'); chargerParams();
        });
        break;
      case 'set-mef': LS.set('wl-mef', LS.get('wl-mef') === '0' ? '1' : '0'); paintPanel(); break;
      case 'set-rec':
        var nv = !(S.params && S.params.recompense);
        pushApi({ action: 'parametres_set', recompense: nv }).then(function (r) {
          if (!r || !r.ok) { toast('⚠️ ' + ((r && r.why) || 'impossible'), true); return; }
          S.params.recompense = nv; toast(nv ? '🧪 Mode récompense activé : vos citations rapportent des pièces.' : 'Mode récompense désactivé.'); chargerPieces(); paintPanel();
        });
        break;
      case 'pc-dem':
        var ck6 = S.clicking; confirmer('Demander le paiement de tes pièces ?\n\nJonathan reçoit ta demande et comptabilise le montant pour ta prochaine facture.').then(function (ok) { if (!ok) return; S.clicking = ck6;
          pushApi({ action: 'demande_paiement' }).then(function (r) { if (!r || !r.ok) { toast('⚠️ ' + ((r && r.why) || 'impossible'), true); return; } toast('💶 Demande envoyée à Jonathan.'); chargerPieces(); });
        });
        break;
      case 'pc-taux':
        pushApi({ action: 'taux', taux: val('wl-taux') }).then(function (r) { if (!r || !r.ok) { toast('⚠️ ' + ((r && r.why) || 'taux invalide'), true); return; } toast('Valeur d’une pièce : ' + String(r.taux).replace('.', ',') + ' €'); chargerPieces(); });
        break;
      case 'pc-conv': case 'pc-raz':
        var cm = id, conv = name === 'pc-conv', so2 = ((S.pieces && S.pieces.soldes) || {})[cm] || 0, eu = (Math.round(so2 * Number((S.pieces || {}).taux || 0) * 100) / 100).toFixed(2).replace('.', ',') + ' €';
        var ck8 = S.clicking; confirmer(conv ? 'Convertir les ' + so2 + ' pièces de ' + membre(cm).nom + ' en ' + eu + ' ?\n\nElle reçoit un message dans l’Interphone pour ajouter ce montant à sa prochaine facture, puis le coche chez le Comptable une fois ajouté.' : 'Remettre à zéro les ' + so2 + ' pièces de ' + membre(cm).nom + ' sans les convertir ?\n\nLes pièces restent dans l’historique, marquées « remises à zéro ».').then(function (ok) { if (!ok) return; S.clicking = ck8;
          pushApi({ action: conv ? 'convertir' : 'remise_a_zero', membre: cm }).then(function (r) { if (!r || !r.ok) { toast('⚠️ ' + ((r && r.why) || 'impossible'), true); return; } toast(conv ? '💶 Converti : ' + eu + ' à facturer.' : '↺ Solde remis à zéro.'); chargerPieces(); refresh(true); });
        });
        break;
      case 'pc-fact':
        var fid2 = id, fnote = val('wl-fact-' + id);
        var ck7 = S.clicking; confirmer('Ce montant est bien ajouté à la facture ?\n\nUne fois coché, c’est définitif : la ligne est archivée et les pièces sont comptées pour de bon. Pas de retour en arrière.').then(function (ok) { if (!ok) return; S.clicking = ck7;
          pushApi({ action: 'facturee', id: fid2, note: fnote }).then(function (r) { if (!r || !r.ok) { toast('⚠️ ' + ((r && r.why) || 'impossible'), true); return; } toast('✅ Noté : ajouté à la facture.'); chargerPieces(); refresh(true); });
        });
        break;
      case 'pc-ok': case 'pc-annule':
        var pcSt = name === 'pc-ok' ? 'acquis' : 'annule', pcId = id;
        var ck9 = S.clicking; confirmer(pcSt === 'acquis' ? 'Valider ces pièces ?' : 'Annuler ces pièces ?').then(function (ok) { if (!ok) return; S.clicking = ck9;
          pushApi({ action: 'pieces_decision', id: pcId, statut: pcSt }).then(function (r) { if (!r || !r.ok) { toast('⚠️ ' + ((r && r.why) || 'impossible'), true); return; } toast(pcSt === 'acquis' ? '🪙 Pièces validées.' : '✖️ Pièces annulées.'); chargerPieces(); });
        });
        break;
      case 'dos-toggle': S.dosFocus = null; S.dosOuvert = S.dosOuvert || {}; var dEl = S.root.querySelector('#sdos-' + id); S.dosOuvert[id] = !(dEl && dEl.classList.contains('open')); paintPanel(); break;
      case 'dos-tout': S.dosFocus = null; S.dosOuvert = {}; dossiers(vues().filter(function (f) { return f.statut !== 'inséré'; })).forEach(function (d) { S.dosOuvert[d.id || 'sans'] = id === '1'; }); paintPanel(); break;
      case 'dossier-sec': S.dosFocus = id; masquerTip(); if (S.doc) closeDoc(); openPanel('secretaire'); setTimeout(function () { var d = S.root.querySelector('#sdos-' + id); if (d) d.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 80); break;
      case 'portee': S.portee = id === 'moi' ? 'moi' : 'tous'; LS.set('wl-portee', S.portee); render(); break;
      case 'dossier': S.tab = 'suivi'; LS.set('wl-tab', S.tab); closePanel(); closeDoc(); render(); setTimeout(function () { var d = S.root.querySelector('#dossier-' + (id || 'sans')); if (d) { d.scrollIntoView({ behavior: 'smooth', block: 'center' }); d.classList.add('flash'); } }, 60); break;
      case 'a-interviewer': S.tab = 'articles'; LS.set('wl-tab', S.tab); closePanel(); closeDoc(); render(); setTimeout(function () { var h = S.root.querySelector('#a-interviewer'); if (h) h.scrollIntoView({ behavior: 'smooth' }); }, 60); break;
      case 'express':
        var ax = art(id); if (!ax) { toast('Enquête introuvable dans Ghost.', true); break; }
        var ck7 = S.clicking, pub7 = true; // case « Article publié » : dans la confirmation uniquement (23/10/2026)
        var pe7 = prepEtat(id); if (enCours(pe7)) { voirMails(id); break; } // déjà en route : on suit la préparation
        confirmerPub('Préparer les interviews pour « ' + ax.titre + ' » ?\n\nL’Assistant cherche 2 ou 3 chercheurs (adresses publiées uniquement), écrit les questions, et la Secrétaire prépare les mails. Rien ne part sans votre validation. Compter 1 à 2 minutes.', pub7).then(function (rc) { if (!rc.ok) return; S.clicking = ck7; setTimeout(function () { S.clicking = null; }, 0);
          lancerPrep(id, rc.publie); // fenêtre de préparation : étapes en direct, puis les cartes des mails
        });
        break;
      case 'push': reglerPush(true); break;
      case 'dicter': if (S.dicte) stopDictee(); else startDictee(); break;
      // 23/10/2026 : déconnexion du compte membre posthumain.com (session Ghost), puis retour à l'écran « Se connecter » du lab
      case 'ob-refaire': closePanel(); obDemarrer(false); break;
      case 'ob-journaliste': closePanel(); obDemarrer(true); break;
      case 'deconnexion':
        confirmer('Se déconnecter du Writinglab ?\n\nVous vous déconnectez aussi de posthumain.com sur cet appareil.').then(function (ok) {
          if (!ok) return;
          fetch('/members/api/session', { method: 'DELETE', credentials: 'same-origin' }).catch(function () {}).then(function () {
            try { sessionStorage.clear(); } catch (e) {}
            location.reload();
          });
        });
        break;
      case 'send-msg':
        if (S.miseEnForme) break;
        // pendant la dictée, « Envoyer » arrête d'abord la dictée (le texte est mis en forme) : on relit, puis on envoie.
        // Avant, le message partait à moitié dicté et le texte mis en forme revenait ensuite dans le champ.
        if (S.dicte) { stopDictee(); toast('Dictée arrêtée : relisez, puis envoyez.'); break; }
        var m = val('wl-msg').trim(), pj = S.pj; if (!m && !pj) break;
        var lien = S.root.querySelector('#wl-msg-art'), a = art(S.art), cs = S.root.querySelector('#wl-pj-cat');
        if (pj && cs) pj.categorie = cs.value;
        api('ecrire', { texte: m, article_id: lien && lien.checked && a ? a.id : '', article_titre: lien && lien.checked && a ? a.titre : '',
          fichier: pj ? { nom: pj.nom, type: pj.type, data: pj.data } : null, categorie: pj ? pj.categorie : '' }).then(function () {
          var ta = S.root.querySelector('#wl-msg'); if (ta) { ta.value = ''; ta.blur(); } S.msgDraft = ''; S.pj = null; majPj(); if (pj) toast('📎 Fichier rangé dans « ' + catNom(pj.categorie) + ' ».'); return refresh(true);
        }, function (e) { toast('⚠️ ' + e.message, true); });
        break;
      case 'pjs-add': S.pjsKey = id; var pin = S.root.querySelector('#wl-pjs-input'); if (pin) pin.click(); break;
      case 'pjs-del': if (S.pjs && S.pjs[id]) { S.pjs[id].splice(i, 1); paintDoc(); } break;
      case 'pj-choisir': var inp = S.root.querySelector('#wl-pj'); if (inp) inp.click(); break;
      case 'pj-retirer': S.pj = null; majPj(); break;
      case 'filtre-cat': S.filtreCat = id || ''; majClasseur(); break;
      case 'clsr': S.clsr = !S.clsr; majClasseur(); break;
    }
  }
  function onInput(e) {
    var t = e.target, k;
    if (t.id && /^bx-/.test(t.id) && S.bxW) { var kb = t.id.slice(3); S.bxW[kb] = t.value; if (kb === 'numero') { bxPreremplir(); var ih = S.root.querySelector('#bx-imap_host'), sh = S.root.querySelector('#bx-smtp_host'); if (ih) ih.value = S.bxW.imap_host; if (sh) sh.value = S.bxW.smtp_host; } if (kb === 'mdp' || kb === 'adresse') { S.bxW.test = null; } return; }
    if (t.id && /^eq-/.test(t.id)) { S.eqDraft = S.eqDraft || {}; S.eqDraft[t.id.slice(3)] = t.type === 'checkbox' ? !!t.checked : t.value; return; }
    if (t.classList && t.classList.contains('pub-in')) { S.pub = S.pub || {}; S.pub[t.getAttribute('data-pub')] = !!t.checked; return; }
    if (t.id === 'wl-msg') { S.msgDraft = t.value; return; }
    if (t.id === 'wl-tel-msg') { if (S.telP) { S.telP.brouillon = t.value; S.telBr = S.telBr || {}; S.telBr[S.telP.poste] = t.value; } return; }
    if (t.id === 'wl-ap-ok') { if (S.appel) { S.appel.consent = !!t.checked; var be = S.root.querySelector('[data-act="ap-ecouter"]'); if (be) be.disabled = !t.checked; } return; }
    if (t.id === 'wl-canal') { if (e.type === 'change') canalChoisir(t.getAttribute('data-id'), t.value); return; }
    if (t.id === 'wl-ap-lang') { if (S.appel) S.appel.lang = t.value; return; }
    if (t.id === 'wl-ap-txt') { if (S.appel) S.appel.texte = t.value; return; }
    if (t.id === 'wl-mb-usine') { try { localStorage.setItem('wl-mb-usine', t.checked ? '1' : '0'); } catch (e) {} var lm = S.root.querySelector('#wl-mb-listes'); if (lm) { lm.innerHTML = mbListes(); markBusy(); } return; }
    if (t.id === 'wl-qmb') { S.qMb = t.value; var tm = S.root.querySelector('#wl-mb-tous'); if (tm) { var tmp = document.createElement('div'); tmp.innerHTML = mbListes(); var nt = tmp.querySelector('#wl-mb-tous'); if (nt) tm.innerHTML = nt.innerHTML; markBusy(); } return; }
    if (t.id === 'wl-qa') { S.qArt = t.value; var ra = S.root.querySelector('#wl-art-res'); if (ra) { ra.innerHTML = artsRes(); markBusy(); } return; }
    if (t.id === 'wl-q') { S.qSuivi = t.value; var rq = S.root.querySelector('#wl-suivi-res'); if (rq) { rq.innerHTML = suiviRes(); markBusy(); } return; }
    if (t.id === 'wl-qc') { S.qCour = t.value; var rc2 = S.root.querySelector('#wl-cour-res'); if (rc2) { rc2.innerHTML = courrierRes(); markBusy(); } return; }
    if ((t.id === 'wl-su-sujet' || t.id === 'wl-su-corps') && S.doc) { S.suEdit = S.suEdit || {}; S.suEdit[S.doc.id] = { sujet: val('wl-su-sujet'), corps: val('wl-su-corps') }; return; }
    if ((t.id === 'wl-su-consigne' || t.id === 'wl-su-tel') && S.doc) { S.suDraft = S.suDraft || {}; S.suDraft[S.doc.id] = { consigne: val('wl-su-consigne'), tel: val('wl-su-tel') }; return; }
    if ((t.id === 'wl-r-sujet' || t.id === 'wl-r-corps') && S.doc) { S.rEdit = S.rEdit || {}; S.rEdit[S.doc.id] = { sujet: val('wl-r-sujet'), corps: val('wl-r-corps') }; return; }
    if ((k = t.getAttribute('data-c')) && S.contact) { S.contact[k] = t.value; saveDraft(); }
    else if ((k = t.getAttribute('data-l'))) { S.libre[k] = t.value; if (k === 'email') { var dl = S.root.querySelector('#wl-deja-l'); if (dl) dl.innerHTML = dejaHTML(dejaContacte(t.value), true); } }
    else if ((k = t.getAttribute('data-s'))) { S[k] = t.value; saveDraft(); }
    else if (t.hasAttribute('data-qi')) { var q = S.qs[Number(t.getAttribute('data-qi'))]; if (q) { q.q = t.value; saveDraft(); } }
    else if ((k = t.getAttribute('data-cp')) && S.cit && S.cit.ins) { var pp = k.split(':'), pr = S.cit.ins[Number(pp[0])]; if (pr) pr[pp[1]] = t.value; }
    else if ((k = t.getAttribute('data-ch')) != null && S.chapo && S.chapo.props) { var xc = S.chapo.props[Number(k)]; if (xc) xc.texte = t.value; }
    else if (t.id === 'wl-dl') LS.set('wl-dictee-lang', t.value);
    else if (t.getAttribute && t.getAttribute('data-wm') != null && S.params && e.type === 'change') {
      var lst = []; S.root.querySelectorAll('[data-wm]').forEach(function (c) { if (c.checked) lst = lst.concat(WEBMAILS[Number(c.getAttribute('data-wm'))][1]); });
      pushApi({ action: 'parametres_set', webmails: lst }).then(function (r) { if (r && r.ok) { S.params.webmails = r.webmails; toast('🛡️ Contrôle des pièces mis à jour.'); } else toast('⚠️ ' + ((r && r.why) || 'impossible'), true); });
    }
    else if (t.id === 'wl-sig') sigLire();
    else if ((k = t.getAttribute('data-nc')) && S.newCamp) { S.newCamp[k] = t.value; }
    else if ((k = t.getAttribute('data-nco')) && S.newCamp) { var oo = S.newCamp.offres.filter(function (x) { return x !== k; }); if (t.checked) oo.push(k); S.newCamp.offres = oo; }
    else if (/^wl-p-(sujet|corps|email)$/.test(t.id) && S.doc) { S.pEdit = S.pEdit || {}; S.pEdit[S.doc.id] = { sujet: val('wl-p-sujet'), corps: val('wl-p-corps'), email: val('wl-p-email') }; }
    else if ((t.id === 'wl-m-sujet' || t.id === 'wl-m-corps') && S.doc) { S.mEdit = S.mEdit || {}; S.mEdit[S.doc.id] = { sujet: val('wl-m-sujet'), corps: val('wl-m-corps') }; }
    else if ((t.id === 'wl-v-sujet' || t.id === 'wl-v-corps') && S.doc) {
      // corrections de la journaliste dans le mail à valider : gardées même si la page se rafraîchit
      S.vEdit = S.vEdit || {};
      S.vEdit[S.doc.id] = { sujet: val('wl-v-sujet'), corps: val('wl-v-corps') };
    }
  }
  function forget(id) { if (S.vEdit) delete S.vEdit[id]; }

  // ---------- rendu ----------
  function paintFloor() { var f = S.root && S.root.querySelector('.floor'); if (f) f.innerHTML = officeSVG(); }
  function render() {
    var r = S.root; if (!r) return;
    r.querySelector('.top').innerHTML = header();
    r.querySelector('.tabs').innerHTML = tabs();
    var w = r.querySelector('.wrap');
    var ae = document.activeElement, composing = ae && w.contains(ae) && ae.id === 'wl-msg';
    var gx = PHL.lireDefilement(w, ['.floor', '.kan']);
    var qf = ae && w.contains(ae) && (ae.id === 'wl-q' || ae.id === 'wl-qa') ? { id: ae.id, a: ae.selectionStart, b: ae.selectionEnd } : null;
    if (!composing) w.innerHTML = S.tab === 'articles' ? viewArticles() : S.tab === 'suivi' ? viewSuivi() : S.tab === 'interphone' ? viewInterphone() : viewBureau();
    if (qf) { var nq = w.querySelector('#' + qf.id); if (nq) { nq.focus({ preventScroll: true }); try { nq.setSelectionRange(qf.a, qf.b); } catch (e) {} } }
    PHL.remettreDefilement(w, gx);
    if (S.tab === 'interphone') { var ms = D().messages; if (ms.length) LS.set('wl-vu', String(ms[ms.length - 1].le)); r.querySelector('.tabs').innerHTML = tabs(); }
    paintPanel(); paintDoc(); markBusy();
  }

  // Notifications push (Webpushr, déjà installé sur posthumain.com) : le lab enregistre l'identifiant d'abonné de ce navigateur
  // auprès de Supabase (fonction wl-push, contrôle du jeton membre Ghost). Les pushs ne visent que l'équipe, jamais les lecteurs.
  var PUSH = 'https://jfmzhndapfmvdhphuwfm.supabase.co/functions/v1/wl-push';
  // Appel d'une fonction Supabase (jeton Ghost gardé 2 min, coupure réseau = { ok:false } : shared/lab-core.js). Le bouton cliqué
  // (S.clicking) montre qu'il travaille et ne peut pas être recliqué avant la réponse.
  function supa(url, body) {
    var key = S.clicking || null; S.clicking = null;
    if (key) OCC.debut(key, false);
    return PHL.supa(url, body).then(function (r) { if (key) OCC.fin(key, false); return r; });
  }
  function pushApi(body) { var a = body && body.action; return actif(a === 'pieces_decision' ? ['compta'] : a === 'demande_paiement' ? ['paie', 'compta'] : a === 'facturee' ? ['paie'] : [], supa(PUSH, body)); }
  var FACT = 'https://jfmzhndapfmvdhphuwfm.supabase.co/functions/v1/wl-facture';
  function factApi(body) { var a = body && body.action; return actif(a && a !== 'liste' && a !== 'zip' ? ['compta'] : [], supa(FACT, body)); }
  function chargerFactures() {
    if (S.factP) return S.factP;
    S.factP = factApi({ action: 'liste' }).then(function (r) { S.factP = null; if (r && r.ok) { S.factures = r; if (S.panel === 'compta' || S.panel === 'parametres') paintPanel(); } }, function () { S.factP = null; });
    return S.factP;
  }
  var MOISN = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
  function moisTxt(m) { var p = String(m).split('-'); return (MOISN[Number(p[1]) - 1] || '') + ' ' + p[0]; }
  function facturesHTML() {
    var R = S.factures, me = D().me;
    if (!R) { chargerFactures(); return '<div class="cz-t">🧾 Factures</div><p class="muted">Chargement…</p>'; }
    var fs = R.factures || [], an = new Date().getFullYear();
    var h = '<div class="cz-t" id="wl-factures">🧾 Factures</div><p class="cz-s">Générées automatiquement le dernier jour du mois à 23 h : enquêtes premium et articles standards publiés dans le mois (autrice, co-autrice ou relecture d’un article de Julien), plus les interviews comptabilisées.</p>';
    if (me.chef) h += '<div class="row" style="gap:8px;flex-wrap:wrap;margin:8px 0 4px"><button class="btn small" data-act="fa-lancer">⚡ Générer la facture du mois en cours</button>' +
      (function () { // années réellement facturées uniquement (plus récente d'abord) ; rien à télécharger tant qu'il n'y a pas de facture
        var ans = fs.map(function (f) { return Number(String(f.mois || '').slice(0, 4)); }).filter(function (y, i, t) { return y && t.indexOf(y) === i; }).sort(function (a, b) { return b - a; });
        if (!ans.length) return '';
        return (ans.length > 1 ? '<select class="in" id="wl-fa-an" style="width:auto;flex:0 0 auto">' + ans.map(function (y) { return '<option>' + y + '</option>'; }).join('') + '</select>' : '<input type="hidden" id="wl-fa-an" value="' + ans[0] + '">') +
          '<button class="btn small" data-act="fa-zip">⬇️ Télécharger ' + (ans.length > 1 ? 'l’année' : ans[0]) + ' (ZIP)</button>';
      })() + '</div>';
    if (!fs.length) return h + '<p class="muted">Aucune facture pour l’instant : la première sera générée à la fin du mois.</p>';
    return h + fs.map(function (f) {
      var paye = f.statut === 'payee', ed = S.faEdit === f.id, d = f.details || {};
      var lg = (f.lignes || []).map(function (l) { return esc(l.libelle) + (l.qte != null ? ' × ' + l.qte : '') + ' : ' + eurTxt(Number(l.total)); }).join('<br>');
      var x = '<div class="cz-l"><div class="cz-h"><span><b>' + esc(moisTxt(f.mois)) + '</b>' + (me.chef ? ' · ' + esc(f.nom || membre(f.membre).nom) : '') + (f.test ? ' <span class="tag eq-test">TEST · hors totaux</span>' : '') + '</span>' + (paye ? '<span class="tag g">✅ payée ' + esc(when(f.payee_le)) + '</span>' : '<span class="tag a">à payer</span>') + '</div>' +
        '<div class="cz-n" style="font-size:24px">' + eurTxt(Number(f.total)) + '<small>N° ' + esc(f.numero) + '</small></div><div class="cz-s" style="margin-top:4px">' + lg + '</div>' +
        '<div class="row" style="gap:6px;margin-top:10px;flex-wrap:wrap">' + (f.url ? '<a class="btn small" href="' + esc(f.url) + '" target="_blank" rel="noopener" data-stop="1">📄 Ouvrir le PDF</a>' : '') +
        (me.chef && !paye ? '<button class="btn small go" data-act="fa-payer" data-id="' + f.id + '">💸 Marquer comme payée</button><button class="btn small" data-act="fa-edit" data-id="' + f.id + '">✏️ Ajuster</button>' : '') + '</div>';
      if (ed) {
        var q = function (l) { var k = (f.lignes || []).filter(function (z) { return z.libelle === l; })[0]; return k || {}; };
        x += '<div class="fa-ed"><label>Enquêtes premium</label><div class="row" style="gap:6px"><input class="in" id="fa-pq" value="' + ((q('Enquêtes premium').libelle ? q('Enquêtes premium') : q('Posthumain (premium)')).qte || 0) + '" inputmode="numeric" style="width:80px"> × <input class="in" id="fa-pp" value="' + String((q('Enquêtes premium').libelle ? q('Enquêtes premium') : q('Posthumain (premium)')).pu || 0).replace('.', ',') + '" inputmode="decimal" style="width:90px"> €</div>' +
          '<label>Articles standards</label><div class="row" style="gap:6px"><input class="in" id="fa-sq" value="' + (q('Articles standards').qte || 0) + '" inputmode="numeric" style="width:80px"> × <input class="in" id="fa-sp" value="' + String(q('Articles standards').pu || 0).replace('.', ',') + '" inputmode="decimal" style="width:90px"> €</div>' +
          '<label>Interviews (montant)</label><div class="row" style="gap:6px"><input class="in" id="fa-iv" value="' + String(q('Interviews').total || 0).replace('.', ',') + '" inputmode="decimal" style="width:110px"> €</div>' +
          '<div class="row" style="gap:6px;margin-top:10px"><button class="btn small go" data-act="fa-regen" data-id="' + f.id + '">↻ Régénérer la facture</button><button class="btn small" data-act="fa-edit" data-id="0">Annuler</button></div></div>';
      }
      var arts = (d.premium || []).map(function (a) { return ['premium', a]; }).concat((d.standard || []).map(function (a) { return ['standard', a]; }));
      if (arts.length) x += '<details class="cz-d" style="margin-top:10px"><summary>Articles comptés (' + arts.length + ')</summary>' + arts.map(function (z) { return '<div class="cz-s" style="margin:4px 0">' + (z[0] === 'premium' ? '⭐ ' : '📰 ') + esc(z[1].titre) + ' <i>(' + esc(z[1].role) + ')</i></div>'; }).join('') + '</details>';
      return x + '</div>';
    }).join('');
  }
  function sidWebpushr(cb) {
    var n = 0;
    (function essai() {
      if (typeof window.webpushr === 'function') { try { window.webpushr('fetch_id', function (sid) { cb(sid || null); }); } catch (e) { cb(null); } return; }
      if (++n > 20) { cb(null); return; }
      setTimeout(essai, 500);
    })();
  }
  function reglerPush(clic) {
    sidWebpushr(function (sid) {
      if (!sid) {
        S.pushOk = false; var tp = S.root && S.root.querySelector('.top'); if (tp) tp.innerHTML = header();
        if (clic) toast('🔕 Ce navigateur n’est pas abonné aux notifications Posthumain : acceptez la demande de notifications du site (ou la cloche Webpushr en bas de page), puis réactivez-les dans ⚙️ Paramètres.', true);
        return;
      }
      var deja = LS.get('wl-push-sid') === String(sid);
      (deja && !clic ? Promise.resolve({ ok: true }) : pushApi({ action: 'register', sid: String(sid) })).then(function (r) {
        if (!r || !r.ok) { if (clic) toast('⚠️ ' + ((r && r.why) || 'enregistrement impossible'), true); return; }
        LS.set('wl-push-sid', String(sid)); S.pushOk = true;
        var tp = S.root && S.root.querySelector('.top'); if (tp) tp.innerHTML = header();
        if (clic) pushApi({ action: 'test' }).then(function (t) { toast(t && t.ok ? '🔔 Notifications actives : une notification de test arrive.' : '⚠️ ' + ((t && t.why) || 'test impossible'), !(t && t.ok)); });
      }).catch(function () { if (clic) toast('⚠️ Réseau indisponible.', true); });
    });
  }
  // Clic sur une notification : la page s'ouvre sur la bonne pièce (#interphone, #suivi, #a-interviewer, #sc, #mk).
  function suivreAncre() {
    var h = (location.hash || '').slice(1); if (!h || !S.root) return;
    if (h === 'interphone' || h === 'suivi' || h === 'articles') { S.tab = h; render(); }
    else if (h === 'a-interviewer') act('a-interviewer', document.body);
    else if (h === 'sc' || h === 'mk') { S.tab = 'bureau'; render(); openPanel(h); }
    else if (h === 'radar' || h === 'marbre' || h === 'votes') { S.tab = 'bureau'; render(); openPanel(h); }
    else if (h === 'factures' || h === 'pieces' || h === 'tableau') { S.tab = 'bureau'; S.ctab = h === 'tableau' ? 'bord' : h; render(); openPanel('compta'); }
    else return;
    try { history.replaceState(null, '', location.pathname); } catch (e) {}
  }
  // Infobulle des cases de l'étagère (et de tout élément data-tip="titre|ligne|ligne") : module commun shared/lab-core.js.
  var TIP = PHL.infobulle ? PHL.infobulle({ root: function () { return S.root; }, defaut: 'Cliquer pour ouvrir le dossier' }) : { suivre: function () {}, masquer: function () {} };
  function masquerTip() { TIP.masquer(); if (PHL.masquerInfobulles) PHL.masquerInfobulles(); }
  function suivreTip(e) { TIP.suivre(e); }
  window.WRITINGLAB_START = function (o) {
    S.call = o.call;
    var host = o.root;
    host.innerHTML = '';
    var font = document.createElement('link'); font.rel = 'stylesheet';
    font.href = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@500;700;800&display=swap';
    document.head.appendChild(font);
    var st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
    try { if (window.PHTheme && PHTheme.deriverClair) { var stc = document.createElement('style'); stc.id = 'wl-clair-css'; stc.textContent = PHTheme.deriverClair(CSS, '#wl', '#wl.wl-clair') + '\n' + CSS_CLAIR_MAIN; document.head.appendChild(stc); } } catch (e) { /* pas de mode clair : le lab reste sombre */ }
    var r = document.createElement('div'); r.id = 'wl';
    r.innerHTML = '<div class="top"></div><div class="tabs"></div><div class="wrap"></div><div class="panelbg"></div><div class="panel"></div><div class="doc"></div><div class="tel" role="dialog" aria-label="Téléphone du bureau"></div><div class="toast"></div>';
    document.body.appendChild(r);
    document.documentElement.style.overflow = 'hidden';
    S.root = r;
    THEME.brancher();
    if (S.art) loadDraft();
    r.addEventListener('click', function (e) {
      var t = e.target;
      var cs = t.closest && t.closest('[data-cs]'); if (cs) { e.preventDefault(); consClic(cs); return; }
      if (S.consBloque && !t.closest('.cs-bg')) return;
      if (t.closest('[data-stop]')) { e.stopPropagation(); return; }
      if (t.classList.contains('panelbg')) { closePanel(); return; }
      if (t.classList.contains('if-bg')) { infoFermer(); return; }
      var tb = t.closest('[data-tab]'); if (tb && tb.classList.contains('tab')) { S.tab = tb.getAttribute('data-tab'); LS.set('wl-tab', S.tab); render(); return; }
      var a = t.closest('[data-act]'); if (a) { e.preventDefault(); act(a.getAttribute('data-act'), a); return; }
      var ag = t.closest('[data-ag]'); if (ag) { var k = ag.getAttribute('data-ag'); openPanel(k === 'j:vide' ? 'chef' : k); }
    });
    r.addEventListener('input', onInput);
    r.addEventListener('mousedown', function (e) { if (e.target.closest && e.target.closest('[data-act="sig-cmd"]')) e.preventDefault(); }); // garder la sélection dans l'éditeur de signature
    r.addEventListener('mousemove', suivreTip); r.addEventListener('mouseleave', masquerTip);
    r.addEventListener('change', onInput);
    r.addEventListener('keydown', function (e) {
      if ((e.key === 'Enter' || e.key === ' ') && e.target && e.target.matches && e.target.matches('.info-svg')) { e.preventDefault(); infoOuvrir(e.target.getAttribute('data-id')); return; }
      if ((e.key === 'Enter' || e.key === ' ') && e.target && e.target.matches && e.target.matches('.dcard[data-act]')) { e.preventDefault(); act(e.target.getAttribute('data-act'), e.target); return; }
      if (e.target && e.target.id === 'wl-msg' && e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); var b = r.querySelector('[data-act="send-msg"]'); if (b) b.click(); }
      if (e.target && e.target.id === 'wl-tel-msg' && e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); telEnvoyer(); }
    });
    var pjsIn = document.createElement('input'); pjsIn.type = 'file'; pjsIn.id = 'wl-pjs-input'; pjsIn.multiple = true; pjsIn.style.display = 'none'; r.appendChild(pjsIn);
    pjsIn.addEventListener('change', function () {
      var key = S.pjsKey, fs = Array.prototype.slice.call(pjsIn.files || []); pjsIn.value = '';
      if (!key) return;
      S.pjs = S.pjs || {}; S.pjs[key] = S.pjs[key] || [];
      fs.forEach(function (f) {
        if (S.pjs[key].length >= 5) { toast('5 pièces jointes au plus.', true); return; }
        if (f.size > 8 * 1024 * 1024) { toast(f.name + ' : 8 Mo au plus.', true); return; }
        var rd = new FileReader();
        rd.onload = function () { S.pjs[key].push({ nom: f.name, type: f.type || 'application/octet-stream', taille: f.size, data: String(rd.result).split(',')[1] || '' }); paintDoc(); };
        rd.readAsDataURL(f);
      });
    });
    r.addEventListener('change', function (e) {
      if (!e.target || e.target.id !== 'wl-pj' || !e.target.files || !e.target.files[0]) return;
      var f = e.target.files[0]; e.target.value = '';
      if (f.size > 10 * 1024 * 1024) { toast('Fichier trop lourd : 10 Mo au plus.', true); return; }
      var rd = new FileReader();
      rd.onload = function () { S.pj = { nom: f.name, type: f.type || 'application/octet-stream', taille: f.size, categorie: devinerCat(f), data: String(rd.result).split(',')[1] || '' }; majPj(); };
      rd.readAsDataURL(f);
    });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && S.consBloque) { e.preventDefault(); return; } if (e.key === 'Escape' && S.info) { e.preventDefault(); infoFermer(); return; } if (e.key === 'Escape') { if (S.clsr) { S.clsr = false; majClasseur(); } else if (S.doc) fermerDoc(); else closePanel(); } });
    // Retour sur l'onglet : une seule relecture si la page n'a rien reçu depuis 5 minutes.
    document.addEventListener('visibilitychange', function () { if (!document.hidden && (S.rtAttente || Date.now() - S.last > 300000)) { S.rtAttente = false; refresh(true); } });
    // Temps réel : Supabase sonne (table wl_signal, sans aucune donnée) dès qu'un mail, une fiche ou un message change ;
    // la page relit alors l'état. Plus de relecture périodique quand le temps réel est branché (chaque relecture = une exécution n8n) ;
    // filet de sécurité seulement s'il est coupé : une relecture toutes les 10 minutes.
    S.rtOk = false;
    setInterval(function () { if (!S.rtOk && !document.hidden && S.data && Date.now() - S.last > 590000) refresh(true); }, 600000);
    (function sonnette() {
      var sc = document.createElement('script');
      sc.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js';
      sc.onload = function () {
        try {
          var sb = window.supabase.createClient('https://jfmzhndapfmvdhphuwfm.supabase.co', 'sb_publishable_3NOP0qHNmvDay5ak1P__XA_ALCUH7du', { auth: { persistSession: false } });
          var t = null;
          sb.channel('writinglab').on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'wl_signal' }, function () {
            if (document.hidden) { S.rtAttente = true; return; } // onglet caché : relecture au retour sur l'onglet
            clearTimeout(t); t = setTimeout(function () { refresh(true); }, 1500); // plusieurs changements d'affilée = une seule relecture
          }).subscribe(function (st) { S.rtOk = st === 'SUBSCRIBED'; });
        } catch (e) { /* pas de temps réel : la relecture toutes les 10 minutes prend le relais */ }
      };
      document.head.appendChild(sc);
    })();
    setInterval(function () { if (!document.hidden && S.data) { var tp = r.querySelector('.top'); if (tp) tp.innerHTML = header(); } }, 30000);
    refresh().then(function () {
      if (S.art && !art(S.art) && D().articles.length) { /* l'article en cours a été publié ou supprimé */ S.art = ''; LS.set('wl-article', null); render(); }
      suivreAncre(); if (LS.get('wl-push-off') !== '1') reglerPush(false); chargerParams();
    });
    window.addEventListener('hashchange', suivreAncre);
  };
})();
