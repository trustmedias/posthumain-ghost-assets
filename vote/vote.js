/* Posthumain — page /vote : « Votez pour une de nos prochaines enquêtes premium ».
   Tout passe par la fonction Supabase « vote » (aucune exécution n8n). Identité vérifiée côté serveur
   (jeton membre Ghost + statut lu dans Ghost) : cette page n'affiche que ce que le serveur autorise. */
(function () {
  'use strict';
  var API = 'https://jfmzhndapfmvdhphuwfm.supabase.co/functions/v1/vote';
  if (document.getElementById('phv-app')) return;
  // ---------------------------------------------------------------- coquille : application plein écran, styles isolés (Shadow DOM)
  // Le thème Ghost et son Code injection ne peuvent plus rien imposer ici ; le voile posé par vote/head.html cache la page article.
  var ICI = (document.currentScript && document.currentScript.src) || '';
  var CSS = ICI ? ICI.replace(/vote\.js(\?.*)?$/, 'vote.css') : 'https://cdn.jsdelivr.net/gh/trustmedias/posthumain-ghost-assets@main/vote/vote.css';
  var host = document.createElement('div');
  host.id = 'phv-app';
  document.body.appendChild(host);
  var sh = host.attachShadow({ mode: 'open' });
  var MODE = window.PHTheme ? window.PHTheme.get() : (document.documentElement.classList.contains('white-mode') ? 'light' : 'dark');
  host.setAttribute('data-mode', MODE);
  sh.innerHTML = '<style>:host{all:initial;position:fixed;inset:0;z-index:3999000;display:block;overflow:hidden;' +
    'background:#0f0f0f;color:#e6ebe7;font:16px/1.55 Inter,system-ui,-apple-system,sans-serif;visibility:visible}:host([data-mode="light"]){background:#f4f6f3;color:#1a1f1c}' +
    '.phv-coque{position:absolute;inset:0;overflow:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;opacity:0;transition:opacity .2s}.phv-coque.pret{opacity:1}</style>' +
    '<link rel="stylesheet" href="' + CSS + '">' +
    '<div class="phv-coque"><header class="phv-app-barre">' +
    '<a class="phv-marque" href="/" aria-label="Retour sur posthumain.com"><span class="phv-marque-nom">posthumain</span><span class="phv-marque-chemin">/vote</span></a>' +
    '<div class="phv-app-actions"><span id="phv-app-compte"></span>' +
    '<button type="button" class="phv-mode" data-act="mode"></button></div></header>' +
    '<div class="phv-page"><div id="phv" class="phv"><div class="phv-gris">Chargement du vote…</div></div></div></div>';
  var coque = sh.querySelector('.phv-coque'), root = sh.getElementById('phv');
  var lien = sh.querySelector('link');
  // 27/10/2026 (CLS) : la page ne s'affiche qu'une fois sa feuille ET ses polices prêtes. Avant, elle apparaissait au bout de
  // 2,5 s même sans feuille, puis tout se réarrangeait à l'arrivée des styles et de Fira Mono (gros décalages sur mobile).
  var montre = false, attentes = [];
  var montrer = function () { if (montre) return; montre = true; coque.classList.add('pret'); attentes.splice(0).forEach(function (f) { try { f(); } catch (e) { /* rien */ } }); };
  var quandVisible = function (f) { if (montre) f(); else attentes.push(f); };
  var feuille = new Promise(function (ok) { lien.addEventListener('load', ok); lien.addEventListener('error', ok); });
  feuille.then(function () {
    var polices = document.fonts && document.fonts.load ? Promise.all([document.fonts.load('600 20px "Fira Mono"'), document.fonts.load('16px Inter')]).catch(function () {}) : Promise.resolve();
    return Promise.race([polices, new Promise(function (ok) { setTimeout(ok, 1200); })]);
  }).then(montrer);
  setTimeout(montrer, 8000); // secours : réseau très lent
  var SOLEIL = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="12" cy="12" r="4.2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
  var LUNE = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M20 14.6A8.2 8.2 0 0 1 9.4 4a8.2 8.2 0 1 0 10.6 10.6z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>';
  function majMode(m) {
    MODE = m; host.setAttribute('data-mode', m);
    var b = sh.querySelector('.phv-mode'); if (!b) return;
    b.innerHTML = m === 'light' ? LUNE : SOLEIL;
    b.setAttribute('aria-label', m === 'light' ? 'Passer en mode sombre' : 'Passer en mode clair');
    b.title = b.getAttribute('aria-label');
  }
  majMode(MODE);
  if (window.PHTheme) window.PHTheme.onChange(majMode);
  // liens Portal (connexion, inscription, abonnement) : Portal écoute l'ancre #/portal/… de l'adresse
  sh.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a[data-portal]'); if (!a) return;
    e.preventDefault(); fermerFenetre(); location.hash = '#/portal/' + a.getAttribute('data-portal');
  });
  coque.querySelector('.phv-app-barre').addEventListener('click', function (e) {
    var b = e.target.closest('[data-act]'); if (!b) return;
    var act = b.getAttribute('data-act');
    if (act === 'mode') { if (window.PHTheme) window.PHTheme.toggle(); else majMode(MODE === 'light' ? 'dark' : 'light'); }
    else if (act === 'passer-premium') fenetre((S.d && S.d.role) || 'visiteur');
    else if (act === 'aller-redaction') { location.hash = '#redaction'; if (S.d && S.d.equipe) chargerRedaction().then(function () { var r = root.querySelector('#redaction'); if (r) r.scrollIntoView({ behavior: 'smooth', block: 'start' }); }); }
  });
  function majCompte() {
    var z = sh.getElementById('phv-app-compte'); if (!z) return;
    var d = S.d || {}, role = d.role || '', h = '';
    if (d.equipe) h += '<button type="button" class="phv-app-lien" data-act="aller-redaction">Rédaction</button>';
    if (role === 'premium') h += '<a class="phv-app-statut" href="#/portal/account" data-portal="account" title="Mon compte">Premium</a>';
    else if (role === 'gratuit') h += '<button type="button" class="phv-app-btn" data-act="passer-premium">Passer premium</button><a class="phv-app-lien" href="#/portal/account" data-portal="account">Mon compte</a>';
    else if (role === 'visiteur') h += '<a class="phv-app-btn" href="#/portal/signin" data-portal="signin">Se connecter</a>';
    z.innerHTML = h;
  }

  var REDUIT = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var q = new URLSearchParams(location.search);
  var S = {
    d: null, red: null, theme: '', filtre: '', occupe: false, alerte: null, premier: true, decalage: 0,
    titre: '', detail: '', tourId: /^\d+$/.test(q.get('tour') || '') ? Number(q.get('tour')) : null, minuterie: null, sondage: null
  };

  // ---------------------------------------------------------------- outils
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function pl(n, un, plusieurs) { return n + ' ' + (n > 1 ? (plusieurs || un + 's') : un); }
  var MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
  function dateTxt(iso, avecHeure) {
    var d = new Date(iso); if (isNaN(d)) return '';
    var p = new Intl.DateTimeFormat('fr-CH', { timeZone: 'Europe/Zurich', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d);
    var g = function (t) { var x = p.find(function (y) { return y.type === t; }); return x ? x.value : ''; };
    return Number(g('day')) + (g('day') === '1' ? 'er' : '') + ' ' + MOIS[Number(g('month')) - 1] + (avecHeure ? ' à ' + Number(g('hour')) + ' h' + (g('minute') !== '00' ? ' ' + g('minute') : '') : '');
  }
  function maintenant() { return Date.now() + S.decalage; }

  // ---------------------------------------------------------------- jeton membre Ghost (2 min)
  var jeton = { v: null, t: 0 };
  function lireJeton(force) {
    if (!force && jeton.t && Date.now() - jeton.t < 120000) return Promise.resolve(jeton.v);
    return fetch('/members/api/session', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.text() : ''; })
      .catch(function () { return ''; })
      .then(function (t) { jeton = { v: t && t.split('.').length === 3 ? t : null, t: Date.now() }; return jeton.v; });
  }
  function api(action, corps) {
    return lireJeton(false).then(function (t) {
      var b = Object.assign({ action: action }, corps || {});
      if (S.tourId) b.tour_id = S.tourId;
      var h = { 'Content-Type': 'application/json' };
      if (t) h.Authorization = 'Bearer ' + t;
      return fetch(API, { method: 'POST', headers: h, body: JSON.stringify(b) }).then(function (r) {
        return r.json().catch(function () { return { ok: false, why: 'Réponse illisible du serveur.' }; }).then(function (j) { j._statut = r.status; return j; });
      });
    }).catch(function () { return { ok: false, why: 'Connexion impossible : vérifiez votre réseau et réessayez.' }; });
  }

  // ---------------------------------------------------------------- chargement
  function charger(silencieux) {
    return api('etat').then(function (r) {
      if (!r || !r.ok) { if (!silencieux) { S.alerte = { ko: true, t: (r && r.why) || 'Le vote ne répond pas.' }; rendre(); } return; }
      if (r.serveur) S.decalage = Date.parse(r.serveur) - Date.now();
      // relecture silencieuse (toutes les 25 s) : on ne redessine que si quelque chose a vraiment changé (sinon décalages inutiles)
      var avant = silencieux && S.d ? JSON.stringify(Object.assign({}, S.d, { serveur: 0 })) : null;
      fusionner(r);
      if (avant && avant === JSON.stringify(Object.assign({}, S.d, { serveur: 0 })) && !(r.equipe && location.hash === '#redaction')) return;
      if (r.equipe && (location.hash === '#redaction' || S.tourId)) chargerRedaction();
      else rendre();
    });
  }
  function fusionner(r) {
    var garde = S.d || {};
    S.d = Object.assign({}, garde, r);
    // Aperçu réservé à la rédaction : ?apercu=gratuit ou ?apercu=visiteur montre la page comme ces lecteurs la voient
    // (affichage seulement : le serveur continue de décider qui peut proposer ou voter).
    var ap = q.get('apercu');
    if (S.d.equipe && (ap === 'gratuit' || ap === 'visiteur')) S.d.role = ap;
  }
  function chargerRedaction() {
    return api('redaction_etat').then(function (r) { if (r && r.ok) S.red = r; rendre(); });
  }
  function sonder() {
    clearTimeout(S.sondage);
    var enFusion = S.d && S.d.tour && S.d.tour.ia_etat === 'en_cours';
    S.sondage = setTimeout(function () {
      var a = sh.activeElement;
      var saisie = a && root.contains(a) && /^(TEXTAREA|INPUT)$/.test(a.tagName);
      if (document.visibilityState === 'visible' && !saisie && !S.occupe && !sh.querySelector('.phv-fond')) charger(true).then(sonder); else sonder();
    }, enFusion ? 6000 : 25000);
  }
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible' && S.d) charger(true); });

  // ---------------------------------------------------------------- rendu
  function phaseCible(t) {
    if (t.phase === 'propositions') return { quand: t.fin_propositions, quoi: 'Propositions ouvertes encore', suite: 'Puis vote jusqu’au ' + dateTxt(t.fin_vote) + '.' };
    if (t.phase === 'vote') return { quand: t.fin_vote, quoi: 'Vote ouvert encore', suite: 'Clôture le ' + dateTxt(t.fin_vote, true) + ' (heure suisse).' };
    return null;
  }
  function blocs(ms) {
    ms = Math.max(0, ms);
    var s = Math.floor(ms / 1000), j = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60), se = s % 60;
    var z = function (n) { return (n < 10 ? '0' : '') + n; };
    return [[String(j), j > 1 ? 'jours' : 'jour'], [z(h), 'heures'], [z(m), 'minutes'], [z(se), 'secondes']];
  }

  function rendre() {
    var d = S.d;
    if (!d || !d.tour) {
      root.innerHTML = '<div class="phv-surtitre">Vote du mois</div><h1 class="phv-titre">Le sujet d’une de nos prochaines enquêtes premium, c’est vous qui le choisissez.</h1>' +
        (S.alerte ? '<div class="phv-alerte ko">' + esc(S.alerte.t) + '</div>' : '<div class="phv-gris">Chargement du vote…</div>');
      majCompte();
      return;
    }
    var t = d.tour, role = d.role, cible = phaseCible(t), h = '<div class="phv-grille"><aside class="phv-rail">';
    h += '<div class="phv-surtitre">Vote de ' + esc(t.mois_txt) + (t.test ? ' (tour de test)' : '') + '</div>';
    h += '<h1 class="phv-titre phv-dec">Choisissez le sujet d’une de nos prochaines enquêtes</h1>';
    h += '<div class="phv-chapo">Les abonnés premium proposent et votent. Le sujet gagnant devient une enquête de la rédaction.</div>';

    // compte à rebours
    if (cible) {
      var ms = Date.parse(cible.quand) - maintenant();
      h += '<section class="phv-horloge' + (ms < 864e5 ? ' urgent' : '') + '" aria-live="off"><div class="phv-horloge-quoi"><strong>' + esc(cible.quoi) + '</strong></div>' +
        '<div class="phv-chiffres" data-cible="' + esc(cible.quand) + '" role="timer" aria-label="Temps restant">' +
        blocs(ms).map(function (b, i) { return '<div class="phv-bloc"><b class="' + (S.premier && !REDUIT ? 'phv-dec' : '') + '" data-i="' + i + '">' + b[0] + '</b><span>' + b[1] + '</span></div>'; }).join('') +
        '</div><div class="phv-horloge-suite">' + esc(cible.suite) + '</div></section>';
    } else {
      h += '<section class="phv-horloge"><div class="phv-horloge-quoi"><strong>Vote clos</strong></div><div class="phv-horloge-suite">Le prochain tour ouvre le 1er du mois.</div></section>';
    }

    // étapes
    var e1 = t.phase === 'propositions' ? 'actif' : 'fait', e2 = t.phase === 'vote' ? 'actif' : (t.phase === 'resultat' ? 'fait' : ''), e3 = t.phase === 'resultat' ? 'actif' : '';
    var fermeTot = t.propositions_fermees_le && Date.parse(t.propositions_fermees_le) < Date.parse(t.fin_propositions);
    h += '<ol class="phv-etapes" aria-label="Déroulé du tour">' +
      '<li class="phv-etape ' + e1 + '"><b>1. Propositions</b>' + (fermeTot ? 'fermées le ' + esc(dateTxt(t.propositions_fermees_le)) : 'jusqu’au ' + esc(dateTxt(t.fin_propositions))) + '</li>' +
      '<li class="phv-etape ' + e2 + '"><b>2. Vote</b>jusqu’au ' + esc(dateTxt(t.fin_vote)) + '</li>' +
      '<li class="phv-etape ' + e3 + '"><b>3. Enquête</b>rédigée dans la foulée</li></ol>';

    h += '</aside><main class="phv-principal">';
    if (S.alerte) h += '<div class="phv-toast ' + (S.alerte.ko ? 'ko' : 'ok') + '" role="status">' + esc(S.alerte.t) + '</div>';
    h += zoneParticipation(d);
    h += tableau(d);
    h += gagnants(d);
    h += '<details class="phv-regles"><summary>Comment ça marche ?</summary><ul>' +
      '<li><strong>Qui ?</strong> Les abonnés premium : une proposition et un vote par mois, vote modifiable jusqu’à la clôture.</li>' +
      '<li><strong>Les 3 sujets.</strong> À la 6e proposition, l’IA regroupe les idées proches en 3 sujets. Les votes déjà donnés suivent.</li>' +
      '<li><strong>Le gagnant.</strong> Le sujet le plus voté devient une enquête premium, affichée ici une fois publiée.</li>' +
      '<li><strong>Anonymat.</strong> Les propositions s’affichent sans nom ; seule la rédaction sait qui a proposé quoi.</li></ul></details>';
    if (d.equipe) h += redaction();
    h += '</main></div>';
    root.innerHTML = h;
    majCompte();
    lierEvenements();
    if (S.premier) { S.premier = false; quandVisible(function () { if (!REDUIT) decoder(); requestAnimationFrame(function () { remplirBarres(); }); }); } else remplirBarres(true);
    if (S.alerte) { clearTimeout(S.alerteT); S.alerteT = setTimeout(function () { S.alerte = null; var a = root.querySelector('.phv-toast'); if (a) a.remove(); }, S.alerte.ko ? 9000 : 5000); }
    demarrerHorloge();
  }

  function zoneParticipation(d) {
    var t = d.tour, role = d.role, me = d.me || {}, h = '<section class="phv-zone" id="participer">';
    if (t.phase === 'propositions') {
      if (role === 'premium' && me.proposition_id) {
        h += '<h2 class="phv-h2">Votre proposition est en lice</h2><div class="phv-h2-sous">Votre vote lui est attribué ; vous pouvez le donner à un autre sujet.</div>';
      } else {
        h += '<h2 class="phv-h2">Proposez un sujet</h2><div class="phv-h2-sous">Une thématique, puis votre idée en une phrase.</div>';
        h += '<div class="phv-themes" role="group" aria-label="Thématique">' + Object.keys(d.themes || {}).map(function (k) {
          return '<button type="button" class="phv-chip" data-act="theme" data-k="' + esc(k) + '" aria-pressed="' + (S.theme === k) + '">' + esc(d.themes[k]) + '</button>';
        }).join('') + '</div>';
        h += '<div class="phv-form' + (S.theme ? '' : ' phv-cache') + '">' +
          '<label class="phv-cache" for="phv-titre">Votre sujet</label><textarea id="phv-titre" class="phv-champ" rows="2" maxlength="140" placeholder="Ex. : Les implants cérébraux vont-ils un jour lire nos pensées ?">' + esc(S.titre) + '</textarea>' +
          '<div class="phv-compte" id="phv-compte">' + S.titre.length + ' / 140</div>' +
          '<label class="phv-cache" for="phv-detail">Précisions</label><textarea id="phv-detail" class="phv-champ" rows="3" maxlength="600" placeholder="Facultatif : ce que vous aimeriez savoir, un lien, une piste…">' + esc(S.detail) + '</textarea>' +
          '<div class="phv-actions"><button type="button" class="phv-btn" data-act="proposer"' + (S.occupe ? ' disabled' : '') + '>' + (S.occupe ? 'Envoi…' : 'Proposer ce sujet') + '</button>' +
          '<span class="phv-note">Une par mois.</span></div></div>';
      }
    }
    if (t.ia_etat === 'en_cours') h += '<div class="phv-fusion"><i></i>L’IA regroupe les propositions en 3 sujets…</div>';
    if (role === 'visiteur') h += '<div class="phv-alerte"><a href="#/portal/signin" data-portal="signin">Connectez-vous</a> pour lire les propositions.</div>';
    return h + '</section>';
  }

  function tableau(d) {
    var t = d.tour, props = d.propositions || [], sujets = (d.sujets || []).filter(function (s) { return s.statut === 'active'; });
    var monVote = d.me && d.me.vote, voile = d.role === 'visiteur';
    var peutVoter = t.phase !== 'resultat';
    var h = '<section class="phv-zone" aria-label="Sujets en lice">';
    function boutonVote(type, id) {
      if (!peutVoter) return '';
      var mien = monVote && ((monVote.type === type && monVote.id === id) || (type === 'sujet' && monVote.type === 'proposition' && sujetDe(monVote.id) === id));
      return '<button type="button" class="phv-vote" data-act="voter" data-type="' + type + '" data-id="' + id + '" aria-pressed="' + !!mien + '">' + (mien ? 'Mon vote' : 'Voter') + '</button>';
    }
    function sujetDe(pid) { var p = props.find(function (x) { return x.id === pid; }); return p ? p.sujet_id : null; }
    function ligne(type, x, total, titre, desc, meta, extra) {
      var mien = monVote && ((monVote.type === type && monVote.id === x.id) || (type === 'sujet' && monVote.type === 'proposition' && sujetDe(monVote.id) === x.id));
      var pct = total ? Math.round(100 * x.votes / total) : 0;
      return '<div class="phv-ligne' + (mien ? ' mien' : '') + (voile ? ' voile' : '') + (x.statut === 'non_retenue' ? ' non-retenue' : '') + '">' +
        '<div class="phv-barre" data-w="' + pct + '"></div>' +
        '<div class="phv-ligne-texte"><div class="phv-ligne-titre">' + (titre ? esc(titre) : 'Proposition réservée aux membres connectés') + '</div>' +
        (desc ? '<div class="phv-ligne-desc">' + esc(desc) + '</div>' : '') + '<div class="phv-ligne-meta">' + meta + '</div>' + (extra || '') + '</div>' +
        '<div class="phv-ligne-droite"><div class="phv-votes" aria-label="' + pl(x.votes, 'vote') + '">' + x.votes + '<small>' + (x.votes > 1 ? 'votes' : 'vote') + ' · ' + pct + ' %</small></div>' + (x.statut === 'non_retenue' ? '' : boutonVote(type, x.id)) + '</div></div>';
    }
    var themeTxt = function (k) { return esc((d.themes || {})[k] || k || ''); };
    if (t.ia_etat === 'fait' && sujets.length) {
      var tot = sujets.reduce(function (a, s) { return a + s.votes; }, 0);
      h += '<h2 class="phv-h2">' + (t.phase === 'resultat' ? 'Les 3 sujets du vote' : 'Votez parmi les 3 sujets') + '</h2><div class="phv-h2-sous">' + pl(tot, 'vote') + (t.phase === 'resultat' ? '' : ' · les votes donnés avant comptent toujours') + '</div><div class="phv-tableau">';
      sujets.forEach(function (s) {
        var src = props.filter(function (p) { return p.sujet_id === s.id; });
        var extra = src.length && !voile ? '<details class="phv-details"><summary>' + pl(src.length, 'proposition') + ' d’abonnés à l’origine</summary><ul class="phv-sources">' + src.map(function (p) { return '<li>' + esc(p.titre) + '</li>'; }).join('') + '</ul></details>' : '';
        h += ligne('sujet', s, tot, s.titre, s.description, '<span class="tag">' + themeTxt(s.thematique) + '</span>', extra);
      });
      h += '</div>';
      var nr = props.filter(function (p) { return p.statut === 'non_retenue'; });
      if (nr.length && !voile) h += '<details class="phv-details"><summary>' + pl(nr.length, 'proposition non retenue', 'propositions non retenues') + '</summary><div class="phv-tableau">' + nr.map(function (p) { return ligne('proposition', p, 0, p.titre, p.detail, '<span class="tag">' + themeTxt(p.thematique) + '</span>'); }).join('') + '</div></details>';
    } else {
      var actives = props.filter(function (p) { return p.statut === 'active'; });
      var themes = {}; actives.forEach(function (p) { themes[p.thematique] = (themes[p.thematique] || 0) + 1; });
      var vis = S.filtre ? actives.filter(function (p) { return p.thematique === S.filtre; }) : actives;
      var tot2 = actives.reduce(function (a, p) { return a + p.votes; }, 0);
      h += '<h2 class="phv-h2">' + (t.phase === 'vote' ? 'Votez pour votre sujet préféré' : 'Les propositions') + '</h2><div class="phv-h2-sous">' + pl(actives.length, 'proposition') + ' · ' + pl(tot2, 'vote') + (t.phase === 'vote' ? ' · vote modifiable jusqu’à la clôture' : '') + '</div>';
      if (Object.keys(themes).length > 1) h += '<div class="phv-themes" role="group" aria-label="Filtrer par thématique"><button type="button" class="phv-chip" data-act="filtre" data-k="" aria-pressed="' + !S.filtre + '">Toutes</button>' +
        Object.keys(themes).map(function (k) { return '<button type="button" class="phv-chip" data-act="filtre" data-k="' + esc(k) + '" aria-pressed="' + (S.filtre === k) + '">' + themeTxt(k) + '<small>' + themes[k] + '</small></button>'; }).join('') + '</div>';
      h += '<div class="phv-tableau">';
      if (!vis.length) h += '<div class="phv-vide">' + (t.phase === 'propositions' ? 'Aucune proposition pour l’instant. La première idée donne le ton du mois.' : 'Aucune proposition ce mois-ci.') + '</div>';
      vis.sort(function (a, b) { return b.votes - a.votes || a.id - b.id; }).forEach(function (p) {
        h += ligne('proposition', p, tot2, p.titre, p.detail, '<span class="tag">' + themeTxt(p.thematique) + '</span>' + (p.mienne ? ' · votre proposition' : ''));
      });
      h += '</div>';
    }
    return h + '</section>';
  }

  function gagnants(d) {
    var g = d.gagnants || [];
    var h = '<section class="phv-zone" aria-label="Enquêtes choisies par les abonnés"><h2 class="phv-h2">Choisis par vous</h2>';
    var publies = g.filter(function (x) { return x.article && x.article.url; });
    if (!publies.length) {
      var dernier = g[0];
      return h + '<div class="phv-h2-sous">' + (dernier ? 'Choisi en ' + esc(dernier.mois_txt) + ' : « ' + esc(dernier.titre) + ' ». Bientôt publié ici.' : 'Les enquêtes choisies par les abonnés apparaîtront ici.') + '</div></section>';
    }
    h += '<div class="phv-gagnants">' + publies.slice(0, 6).map(function (x) {
      var a = x.article;
      return '<a class="phv-gagnant" href="' + esc(a.url) + '"><figure>' + (a.image ? '<img src="' + esc(a.image) + '" alt="" loading="lazy">' : '') + '</figure><h3>' + esc(a.title || x.titre) + '</h3><div>Vote de ' + esc(x.mois_txt) + ', ' + pl(x.votes || 0, 'vote') + '</div></a>';
    }).join('') + '</div>';
    return h + '</section>';
  }

  // ---------------------------------------------------------------- vue rédaction (contrôlée côté serveur)
  function redaction() {
    var r = S.red;
    var h = '<section class="phv-red" id="redaction"><h2>Vue rédaction</h2>';
    if (!r) return h + '<div class="phv-note">Visible par la rédaction seulement. <button type="button" class="phv-btn petit secondaire" data-act="red-charger">Ouvrir le suivi</button></div></section>';
    var c = r.config || {};
    if (!c.airtable) h += '<div class="phv-alerte ko">Le secret Supabase AIRTABLE_TOKEN manque : à la clôture, le gagnant ne pourra pas être envoyé à l’Usine (il faudra l’imposer à la main).</div>';
    var t = r.tour, props = r.propositions || [], sujets = r.sujets || [];
    var votesPar = {}; (r.votes || []).forEach(function (v) { var k = v.cible_type + ':' + v.cible_id; votesPar[k] = (votesPar[k] || 0) + 1; });
    h += '<div class="phv-note">Tour ' + esc(t.mois_txt) + (t.test ? ' (test)' : '') + ' · phase ' + esc(t.phase) + ' · IA : ' + esc(t.ia_etat) + (r.ia_essais ? ' (' + r.ia_essais + ' essai' + (r.ia_essais > 1 ? 's' : '') + ')' : '') + ' · ' + pl((r.votes || []).length, 'votant') + '</div>';
    if (r.ia_erreur) h += '<div class="phv-alerte ko">Dernière erreur de l’IA : ' + esc(r.ia_erreur) + '</div>';
    h += '<div class="phv-red-grille">';
    h += '<div class="phv-red-scroll"><table><thead><tr><th>Proposition</th><th>Auteur</th><th>Votes</th><th></th></tr></thead><tbody>' + (props.length ? props.map(function (p) {
      return '<tr class="' + (p.statut === 'ecartee' ? 'ecartee' : '') + '"><td><b>' + esc(p.titre) + '</b>' + (p.detail ? '<br><span class="phv-gris">' + esc(p.detail) + '</span>' : '') + '<br><span class="phv-gris">' + esc((r.themes || {})[p.thematique] || p.thematique) + ' · ' + esc(p.statut) + (p.sujet_id ? ' → sujet ' + p.sujet_id : '') + (p.motif ? ' · ' + esc(p.motif) : '') + '</span></td>' +
        '<td>' + esc(p.membre_nom || '') + '<br><span class="phv-gris">' + esc(p.membre) + '<br>' + esc(p.membre_statut || '') + ' · ' + esc(dateTxt(p.created_at, true)) + '</span></td><td>' + p.votes + '</td>' +
        '<td>' + (p.statut === 'ecartee' ? '<button type="button" class="phv-btn petit secondaire" data-act="retablir" data-type="proposition" data-id="' + p.id + '">Rétablir</button>' : '<button type="button" class="phv-btn petit danger" data-act="ecarter" data-type="proposition" data-id="' + p.id + '">Écarter</button>') + '</td></tr>';
    }).join('') : '<tr><td colspan="4" class="phv-gris">Aucune proposition.</td></tr>') + '</tbody></table></div>';
    if (sujets.length) h += '<div class="phv-red-scroll"><table><thead><tr><th>Sujet (IA)</th><th>Votes</th><th></th></tr></thead><tbody>' + sujets.map(function (s) {
      return '<tr class="' + (s.statut === 'ecarte' ? 'ecartee' : '') + '"><td><b>' + esc(s.titre) + '</b><br><span class="phv-gris">' + esc(s.description || '') + '</span></td><td>' + s.votes + '</td><td>' +
        (s.statut === 'ecarte' ? '<button type="button" class="phv-btn petit secondaire" data-act="retablir" data-type="sujet" data-id="' + s.id + '">Rétablir</button>' : '<button type="button" class="phv-btn petit danger" data-act="ecarter" data-type="sujet" data-id="' + s.id + '">Écarter</button>') + '</td></tr>';
    }).join('') + '</tbody></table></div>';
    if (r.ia_justification) h += '<div><div class="phv-note">Ce que l’IA a fait :</div><pre>' + esc(r.ia_justification) + '</pre></div>';
    if ((r.refus || []).length) h += '<details class="phv-details"><summary>Propositions refusées par la modération (' + r.refus.length + ')</summary><div class="phv-red-scroll"><table><tbody>' + r.refus.map(function (x) { return '<tr><td>' + esc(x.detail) + '</td><td class="phv-gris">' + esc(x.membre) + '<br>' + esc(dateTxt(x.le, true)) + '</td></tr>'; }).join('') + '</tbody></table></div></details>';
    if ((r.tours || []).length) h += '<details class="phv-details"><summary>Tours (' + r.tours.length + ')</summary><div class="phv-red-scroll"><table><tbody>' + r.tours.map(function (x) {
      return '<tr><td>' + esc(x.mois) + (x.test ? ' (test, <a href="?tour=' + x.id + '#redaction">ouvrir</a>)' : '') + '</td><td>' + esc(x.statut) + '</td><td>' + esc(x.gagnant_titre || '') + (x.gagnant_votes != null ? ' (' + x.gagnant_votes + ')' : '') + (x.airtable_erreur ? '<br><span class="phv-gris">Airtable : ' + esc(x.airtable_erreur) + '</span>' : '') + '</td></tr>';
    }).join('') + '</tbody></table></div></details>';
    h += '<div class="phv-actions"><button type="button" class="phv-btn petit secondaire" data-act="red-charger">Actualiser</button>' +
      '<button type="button" class="phv-btn petit secondaire" data-act="relancer-ia">Relancer l’IA</button>' +
      '<button type="button" class="phv-btn petit secondaire" data-act="publier-page">Republier la page</button>' +
      '<button type="button" class="phv-btn petit danger" data-act="cloturer">Clôturer ce tour maintenant</button></div>';
    return h + '</div></section>';
  }

  // ---------------------------------------------------------------- fenêtre « passer premium » / « connexion »
  function fenetre(role) {
    fermerFenetre();
    var d = S.d || {}, offre = (d.offre && d.offre[0]) || null;
    var av = (offre && offre.avantages && offre.avantages.length) ? offre.avantages.slice(0, 6) : ['Toutes les enquêtes premium en entier'];
    // 23/10/2026 : Posthumain TV n'est pas encore officiellement en ligne : aucun avantage ni lien TV pour l'instant
    av = av.filter(function (a) { return !/\btv\b|documentaire/i.test(String(a)); });
    if (!av.length) av = ['Toutes les enquêtes premium en entier'];
    av.push('Une voix dans le choix de nos prochaines enquêtes : proposer un sujet et voter');
    var prix = offre && offre.mensuel ? 'Dès ' + (offre.mensuel / 100).toFixed(2).replace('.', ',').replace(',00', '') + ' ' + (offre.devise === 'EUR' ? '€' : offre.devise) + ' par mois' + (offre.annuel ? ', ou ' + (offre.annuel / 100).toFixed(2).replace('.', ',').replace(',00', '') + ' ' + (offre.devise === 'EUR' ? '€' : offre.devise) + ' par an' : '') + '. Sans engagement.' : 'Sans engagement.';
    var visiteur = role === 'visiteur';
    var f = document.createElement('div');
    f.className = 'phv phv-fond'; f.setAttribute('role', 'dialog'); f.setAttribute('aria-modal', 'true'); f.setAttribute('aria-labelledby', 'phv-f-titre');
    f.innerHTML = '<div class="phv-fenetre"><button type="button" class="phv-fermer" aria-label="Fermer">✕</button>' +
      '<h2 id="phv-f-titre">' + (visiteur ? 'Votez pour une de nos prochaines enquêtes premium' : 'Le vote est réservé aux abonnés premium') + '</h2>' +
      '<div class="phv-h2-sous">' + (visiteur ? 'Proposer et voter est réservé aux abonnés premium. Créez votre compte, puis passez premium pour faire entendre votre voix.' : 'Débloquez le vote et tout ce que la rédaction réserve à ses abonnés.') + '</div>' +
      '<ul class="phv-avantages">' + av.map(function (a) { return '<li>' + esc(a) + '</li>'; }).join('') + '</ul>' +
      '<div class="phv-prix">' + esc(prix) + '</div>' +
      (visiteur ? '<a class="phv-btn" href="#/portal/signup" data-portal="signup">Créer mon compte</a><a class="phv-lien" href="#/portal/signin" data-portal="signin">J’ai déjà un compte : me connecter</a>'
        : '<a class="phv-btn" href="#/portal/account/plans" data-portal="account/plans">Passer premium</a>') + '</div>';
    coque.appendChild(f);
    var prec = sh.activeElement;
    f.addEventListener('click', function (e) { if (e.target === f || e.target.closest('.phv-fermer')) { fermerFenetre(); if (prec && prec.focus) prec.focus(); } else if (e.target.closest('[data-portal]')) fermerFenetre(); });
    f.addEventListener('keydown', function (e) { if (e.key === 'Escape') { fermerFenetre(); if (prec && prec.focus) prec.focus(); } });
    var b = f.querySelector('.phv-btn'); if (b) b.focus();
  }
  function fermerFenetre() { var f = sh.querySelector('.phv-fond'); if (f) f.remove(); }

  // ---------------------------------------------------------------- actions
  function lierEvenements() {
    var ti = root.querySelector('#phv-titre'), de = root.querySelector('#phv-detail');
    if (ti) ti.addEventListener('input', function () { S.titre = ti.value; var c = root.querySelector('#phv-compte'); if (c) c.textContent = ti.value.length + ' / 140'; });
    if (de) de.addEventListener('input', function () { S.detail = de.value; });
  }
  root.addEventListener('click', function (e) {
    var b = e.target.closest('[data-act]'); if (!b || !root.contains(b)) return;
    var act = b.getAttribute('data-act'), d = S.d || {};
    if (act === 'theme') { S.theme = b.getAttribute('data-k'); rendre(); var x = root.querySelector('#phv-titre'); if (x) x.focus(); return; }
    if (act === 'filtre') { S.filtre = b.getAttribute('data-k'); rendre(); return; }
    if (act === 'red-charger') { chargerRedaction(); return; }
    if (S.occupe) return;
    if (act === 'proposer') {
      if (d.role !== 'premium') { fenetre(d.role); return; }
      if (!S.theme) { S.alerte = { ko: true, t: 'Choisissez d’abord une thématique.' }; rendre(); return; }
      if (S.titre.trim().length < 8) { S.alerte = { ko: true, t: 'Décrivez votre sujet en une phrase (8 caractères au moins).' }; rendre(); return; }
      S.occupe = true; S.alerte = null; rendre();
      api('proposer', { thematique: S.theme, titre: S.titre, detail: S.detail }).then(function (r) {
        S.occupe = false;
        if (r && r.ok) { S.titre = ''; S.detail = ''; S.theme = ''; fusionner(r); S.alerte = { t: r.ia ? 'Merci ! C’était la 6e proposition : l’IA forme maintenant les 3 sujets du vote.' : 'Merci ! Votre proposition est en ligne, et votre vote lui est attribué.' }; }
        else if (r && (r.why === 'premium' || r.why === 'connexion')) { fenetre(r.why === 'connexion' ? 'visiteur' : 'gratuit'); }
        else S.alerte = { ko: true, t: (r && r.why) || 'Envoi impossible.' };
        rendre();
      });
      return;
    }
    if (act === 'voter') {
      if (d.role !== 'premium') { fenetre(d.role); return; }
      if (b.getAttribute('aria-pressed') === 'true') return;
      S.occupe = true; b.textContent = '…';
      api('voter', { type: b.getAttribute('data-type'), id: Number(b.getAttribute('data-id')) }).then(function (r) {
        S.occupe = false;
        if (r && r.ok) { fusionner(r); S.alerte = { t: 'Vote enregistré. Vous pouvez le changer jusqu’à la clôture.' }; }
        else if (r && (r.why === 'premium' || r.why === 'connexion')) fenetre(r.why === 'connexion' ? 'visiteur' : 'gratuit');
        else S.alerte = { ko: true, t: (r && r.why) || 'Vote impossible.' };
        rendre();
      });
      return;
    }
    if (act === 'ecarter' || act === 'retablir') {
      var motif = act === 'ecarter' ? window.prompt('Motif (visible par la rédaction seulement) :', 'hors ligne éditoriale') : '';
      if (motif === null) return;
      S.occupe = true;
      api(act, { type: b.getAttribute('data-type'), id: Number(b.getAttribute('data-id')), motif: motif }).then(function (r) { S.occupe = false; S.alerte = r && r.ok ? { t: act === 'ecarter' ? 'Écarté.' : 'Rétabli.' } : { ko: true, t: (r && r.why) || 'Impossible.' }; charger(true); });
      return;
    }
    if (act === 'relancer-ia') {
      S.occupe = true;
      api('relancer_ia').then(function (r) { S.occupe = false; S.alerte = { ko: !(r && r.ok), t: (r && r.why) || (r && r.ok ? 'L’IA travaille.' : 'Impossible.') }; charger(true).then(sonder); });
      return;
    }
    if (act === 'publier-page') {
      S.occupe = true;
      api('publier_page').then(function (r) { S.occupe = false; S.alerte = r && r.ok ? { t: 'Page republiée (version ' + r.commit + '). Rechargez pour la voir.' } : { ko: true, t: (r && r.why) || 'Publication impossible.' }; rendre(); });
      return;
    }
    if (act === 'cloturer') {
      if (!window.confirm('Clôturer ce tour maintenant ? Le gagnant sera désigné' + ((S.red && S.red.tour && S.red.tour.test) ? ' (tour de test : rien n’est envoyé à l’Usine).' : ' et envoyé à l’Usine. C’est irréversible.'))) return;
      S.occupe = true;
      api('cloturer', { confirmer: true }).then(function (r) { S.occupe = false; S.alerte = r && r.ok ? { t: 'Tour clos. Gagnant : ' + ((r.gagnant && r.gagnant.titre) || 'aucun') + (r.airtable_erreur ? ' (Airtable : ' + r.airtable_erreur + ')' : '') } : { ko: true, t: (r && r.why) || 'Clôture impossible.' }; charger(true); });
    }
  });

  // ---------------------------------------------------------------- compte à rebours (seule mise à jour à la seconde)
  function demarrerHorloge() {
    clearInterval(S.minuterie);
    var el = root.querySelector('.phv-chiffres'); if (!el) return;
    var cible = Date.parse(el.getAttribute('data-cible'));
    S.minuterie = setInterval(function () {
      var reste = cible - maintenant();
      if (reste <= 0) { clearInterval(S.minuterie); setTimeout(function () { charger(true); }, 2500); }
      var b = blocs(reste), cases = el.querySelectorAll('b');
      for (var i = 0; i < cases.length; i++) if (!cases[i].classList.contains('phv-dec-en-cours') && cases[i].textContent !== b[i][0]) cases[i].textContent = b[i][0];
      var sec = el.closest('.phv-horloge'); if (sec) sec.classList.toggle('urgent', reste < 864e5);
    }, 1000);
  }

  // ---------------------------------------------------------------- l'unique effet « terminal » : décodage au chargement
  // 27/10/2026 (CLS) : uniquement des lettres et chiffres latins (même largeur en police à chasse fixe, aucune coupure de ligne en
  // plus) ; seuls les lettres et chiffres sont brouillés, la ponctuation et les espaces restent en place ; la hauteur est verrouillée
  // le temps de l'effet. Avant, les katakana (deux fois plus larges) faisaient changer les retours à la ligne à chaque image.
  var GLYPHES = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789';
  function decoder() {
    var els = root.querySelectorAll('.phv-dec');
    Array.prototype.forEach.call(els, function (el, n) {
      var final = el.textContent, debut = performance.now() + n * 40, duree = el.tagName === 'B' ? 700 : 1100;
      el.classList.add('phv-dec-en-cours');
      var r0 = el.getBoundingClientRect(); el.style.minHeight = r0.height + 'px'; if (el.tagName === 'B') el.style.minWidth = r0.width + 'px';
      (function pas(maint) {
        var p = Math.min(1, Math.max(0, (maint - debut) / duree)), fixe = Math.floor(final.length * p), s = '';
        for (var i = 0; i < final.length; i++) {
          var c = final[i];
          s += (i < fixe || !/[0-9A-Za-zÀ-ÿ]/.test(c)) ? c : GLYPHES[(Math.random() * GLYPHES.length) | 0];
        }
        el.textContent = s;
        if (p < 1) requestAnimationFrame(pas); else { el.textContent = final; el.classList.remove('phv-dec-en-cours'); el.style.minHeight = ''; el.style.minWidth = ''; }
      })(performance.now());
    });
  }
  function remplirBarres(direct) {
    var bs = root.querySelectorAll('.phv-barre');
    Array.prototype.forEach.call(bs, function (b) { b.style.width = (b.getAttribute('data-w') || 0) + '%'; if (direct) b.style.transition = 'none'; });
  }

  window.addEventListener('hashchange', function () { if (location.hash === '#redaction' && S.d && S.d.equipe) chargerRedaction(); });
  charger(false).then(sonder);
})();
