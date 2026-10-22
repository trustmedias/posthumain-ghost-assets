/* Posthumain — page /vote : « Votez pour la prochaine enquête premium ».
   Tout passe par la fonction Supabase « vote » (aucune exécution n8n). Identité vérifiée côté serveur
   (jeton membre Ghost + statut lu dans Ghost) : cette page n'affiche que ce que le serveur autorise. */
(function () {
  'use strict';
  var API = 'https://jfmzhndapfmvdhphuwfm.supabase.co/functions/v1/vote';
  var root = document.getElementById('phv');
  if (!root || root.getAttribute('data-pret')) return;
  root.setAttribute('data-pret', '1');

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
      fusionner(r);
      if (r.equipe && (location.hash === '#redaction' || S.tourId)) chargerRedaction();
      else rendre();
    });
  }
  function fusionner(r) {
    var garde = S.d || {};
    S.d = Object.assign({}, garde, r);
  }
  function chargerRedaction() {
    return api('redaction_etat').then(function (r) { if (r && r.ok) S.red = r; rendre(); });
  }
  function sonder() {
    clearTimeout(S.sondage);
    var enFusion = S.d && S.d.tour && S.d.tour.ia_etat === 'en_cours';
    S.sondage = setTimeout(function () {
      var a = document.activeElement;
      var saisie = a && root.contains(a) && /^(TEXTAREA|INPUT)$/.test(a.tagName);
      if (document.visibilityState === 'visible' && !saisie && !S.occupe && !document.querySelector('.phv-fond')) charger(true).then(sonder); else sonder();
    }, enFusion ? 6000 : 25000);
  }
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible' && S.d) charger(true); });

  // ---------------------------------------------------------------- rendu
  function phaseCible(t) {
    if (t.phase === 'propositions') return { quand: t.fin_propositions, quoi: 'Propositions ouvertes encore', suite: 'Ensuite, vote jusqu’au ' + dateTxt(t.fin_vote, true) + '.' };
    if (t.phase === 'vote') return { quand: t.fin_vote, quoi: 'Vote ouvert encore', suite: 'Clôture le ' + dateTxt(t.fin_vote, true) + ' (heure suisse). Le sujet le plus voté devient une enquête premium.' };
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
      root.innerHTML = '<p class="phv-surtitre">Vote du mois</p><h1 class="phv-titre">Le sujet de la prochaine enquête premium, c’est vous qui le choisissez.</h1>' +
        (S.alerte ? '<p class="phv-alerte ko">' + esc(S.alerte.t) + '</p>' : '<p class="phv-gris">Chargement du vote…</p>');
      return;
    }
    var t = d.tour, role = d.role, cible = phaseCible(t), h = '';
    h += '<p class="phv-surtitre">Vote de ' + esc(t.mois_txt) + (t.test ? ' (tour de test)' : '') + '</p>';
    h += '<h1 class="phv-titre phv-dec">Le sujet de la prochaine enquête premium, c’est vous qui le choisissez.</h1>';
    h += '<p class="phv-chapo">Chaque mois, les abonnés premium proposent des sujets et votent. Le plus demandé devient une enquête de la rédaction, publiée pour tous les abonnés.</p>';

    // compte à rebours
    if (cible) {
      var ms = Date.parse(cible.quand) - maintenant();
      h += '<section class="phv-horloge' + (ms < 864e5 ? ' urgent' : '') + '" aria-live="off"><p class="phv-horloge-quoi"><strong>' + esc(cible.quoi) + '</strong></p>' +
        '<div class="phv-chiffres" data-cible="' + esc(cible.quand) + '" role="timer" aria-label="Temps restant">' +
        blocs(ms).map(function (b, i) { return '<div class="phv-bloc"><b class="' + (S.premier && !REDUIT ? 'phv-dec' : '') + '" data-i="' + i + '">' + b[0] + '</b><span>' + b[1] + '</span></div>'; }).join('') +
        '</div><p class="phv-horloge-suite">' + esc(cible.suite) + '</p></section>';
    } else {
      h += '<section class="phv-horloge"><p class="phv-horloge-quoi"><strong>Vote clos</strong></p><p class="phv-horloge-suite">Le prochain tour ouvre le 1er du mois.</p></section>';
    }

    // étapes
    var e1 = t.phase === 'propositions' ? 'actif' : 'fait', e2 = t.phase === 'vote' ? 'actif' : (t.phase === 'resultat' ? 'fait' : ''), e3 = t.phase === 'resultat' ? 'actif' : '';
    var fermeTot = t.propositions_fermees_le && Date.parse(t.propositions_fermees_le) < Date.parse(t.fin_propositions);
    h += '<ol class="phv-etapes" aria-label="Déroulé du tour">' +
      '<li class="phv-etape ' + e1 + '"><b>1. Propositions</b>' + (fermeTot ? 'fermées le ' + esc(dateTxt(t.propositions_fermees_le)) : 'jusqu’au ' + esc(dateTxt(t.fin_propositions))) + '</li>' +
      '<li class="phv-etape ' + e2 + '"><b>2. Vote</b>jusqu’au ' + esc(dateTxt(t.fin_vote)) + '</li>' +
      '<li class="phv-etape ' + e3 + '"><b>3. Enquête</b>rédigée dans la foulée</li></ol>';

    if (S.alerte) h += '<p class="phv-alerte ' + (S.alerte.ko ? 'ko' : 'ok') + '" role="status">' + esc(S.alerte.t) + '</p>';

    h += zoneParticipation(d);
    h += tableau(d);
    h += gagnants(d);
    h += '<section class="phv-regles" aria-label="Règles du vote">' +
      '<p><strong>Qui participe ?</strong> Les abonnés premium : une proposition et un vote par mois, vote modifiable jusqu’à la clôture.</p>' +
      '<p><strong>Comment sont choisis les 3 sujets ?</strong> Les 5 premières propositions entrent telles quelles. À la 6e, l’IA de la rédaction regroupe les idées proches et formule les 3 sujets du vote. Les votes déjà donnés suivent leur proposition.</p>' +
      '<p><strong>Et ensuite ?</strong> Le sujet qui a reçu le plus de votes depuis le début du tour devient une enquête premium. Elle apparaît ici une fois publiée.</p>' +
      '<p><strong>Confidentialité :</strong> les propositions sont affichées sans nom. Seule la rédaction sait qui a proposé quoi.</p></section>';
    if (d.equipe) h += redaction();
    root.innerHTML = h;
    lierEvenements();
    if (S.premier) { S.premier = false; if (!REDUIT) decoder(); requestAnimationFrame(function () { remplirBarres(); }); } else remplirBarres(true);
    demarrerHorloge();
  }

  function zoneParticipation(d) {
    var t = d.tour, role = d.role, me = d.me || {}, h = '<section class="phv-zone" id="participer">';
    if (t.phase === 'propositions') {
      if (role === 'premium' && me.proposition_id) {
        h += '<h2 class="phv-h2">Votre proposition est en lice</h2><p class="phv-h2-sous">' + (t.n_propositions < 6 ? 'Encore ' + pl(6 - t.n_propositions, 'proposition') + ' avant que l’IA forme les 3 sujets du vote. ' : '') + 'Vous pouvez voter pour n’importe quel sujet, y compris le vôtre (c’est le cas par défaut).</p>';
      } else {
        h += '<h2 class="phv-h2">Proposez un sujet</h2><p class="phv-h2-sous">Choisissez une thématique, puis dites en une phrase sur quoi la rédaction devrait enquêter.</p>';
        h += '<div class="phv-themes" role="group" aria-label="Thématique">' + Object.keys(d.themes || {}).map(function (k) {
          return '<button type="button" class="phv-chip" data-act="theme" data-k="' + esc(k) + '" aria-pressed="' + (S.theme === k) + '">' + esc(d.themes[k]) + '</button>';
        }).join('') + '</div>';
        h += '<div class="phv-form' + (S.theme ? '' : ' phv-cache') + '">' +
          '<label class="phv-cache" for="phv-titre">Votre sujet</label><textarea id="phv-titre" class="phv-champ" rows="2" maxlength="140" placeholder="Ex. : Les implants cérébraux vont-ils un jour lire nos pensées ?">' + esc(S.titre) + '</textarea>' +
          '<div class="phv-compte" id="phv-compte">' + S.titre.length + ' / 140</div>' +
          '<label class="phv-cache" for="phv-detail">Précisions</label><textarea id="phv-detail" class="phv-champ" rows="3" maxlength="600" placeholder="Facultatif : ce que vous aimeriez savoir, un lien, une piste…">' + esc(S.detail) + '</textarea>' +
          '<div class="phv-actions"><button type="button" class="phv-btn" data-act="proposer"' + (S.occupe ? ' disabled' : '') + '>' + (S.occupe ? 'Envoi…' : 'Proposer ce sujet') + '</button>' +
          '<span class="phv-note">Une proposition par abonné et par mois.</span></div></div>';
      }
    } else if (t.phase === 'vote') {
      h += '<h2 class="phv-h2">' + (t.ia_etat === 'fait' ? 'Votez parmi les 3 sujets' : 'Votez pour votre sujet préféré') + '</h2>';
      h += '<p class="phv-h2-sous">' + (t.ia_etat === 'fait' ? 'L’IA a regroupé les propositions des abonnés en 3 sujets. Chaque vote compte depuis le début du tour.' : 'Les propositions sont fermées. Un vote par abonné premium, modifiable jusqu’à la clôture.') + '</p>';
    } else {
      h += '<h2 class="phv-h2">Résultat du vote</h2>';
    }
    if (t.ia_etat === 'en_cours') h += '<p class="phv-fusion"><i></i>L’IA regroupe les propositions en 3 sujets. La page se met à jour toute seule.</p>';
    if (role === 'visiteur') h += '<p class="phv-alerte">Les propositions sont réservées aux membres. <a href="#/portal/signin" data-portal="signin">Connectez-vous</a> ou <a href="#/portal/signup" data-portal="signup">créez un compte gratuit</a> pour les lire.</p>';
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
        '<div class="phv-ligne-texte"><p class="phv-ligne-titre">' + (titre ? esc(titre) : 'Proposition réservée aux membres connectés') + '</p>' +
        (desc ? '<p class="phv-ligne-desc">' + esc(desc) + '</p>' : '') + '<p class="phv-ligne-meta">' + meta + '</p>' + (extra || '') + '</div>' +
        '<div class="phv-ligne-droite"><p class="phv-votes" aria-label="' + pl(x.votes, 'vote') + '">' + x.votes + '<small>' + (x.votes > 1 ? 'votes' : 'vote') + ' · ' + pct + ' %</small></p>' + (x.statut === 'non_retenue' ? '' : boutonVote(type, x.id)) + '</div></div>';
    }
    var themeTxt = function (k) { return esc((d.themes || {})[k] || k || ''); };
    if (t.ia_etat === 'fait' && sujets.length) {
      var tot = sujets.reduce(function (a, s) { return a + s.votes; }, 0);
      h += '<h2 class="phv-h2">' + (t.phase === 'resultat' ? 'Les 3 sujets' : 'Les 3 sujets du vote') + '</h2><p class="phv-h2-sous">' + pl(tot, 'vote') + ' au total</p><div class="phv-tableau">';
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
      h += '<h2 class="phv-h2">Les propositions</h2><p class="phv-h2-sous">' + pl(actives.length, 'proposition') + (t.phase === 'propositions' ? ' sur 5 avant le regroupement par l’IA' : '') + ' · ' + pl(tot2, 'vote') + '</p>';
      if (Object.keys(themes).length > 1) h += '<div class="phv-themes" role="group" aria-label="Filtrer par thématique"><button type="button" class="phv-chip" data-act="filtre" data-k="" aria-pressed="' + !S.filtre + '">Toutes</button>' +
        Object.keys(themes).map(function (k) { return '<button type="button" class="phv-chip" data-act="filtre" data-k="' + esc(k) + '" aria-pressed="' + (S.filtre === k) + '">' + themeTxt(k) + '<small>' + themes[k] + '</small></button>'; }).join('') + '</div>';
      h += '<div class="phv-tableau">';
      if (!vis.length) h += '<p class="phv-vide">' + (t.phase === 'propositions' ? 'Aucune proposition pour l’instant. La première idée donne le ton du mois.' : 'Aucune proposition ce mois-ci.') + '</p>';
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
      return h + '<p class="phv-h2-sous">' + (dernier ? 'Sujet choisi en ' + esc(dernier.mois_txt) + ' : « ' + esc(dernier.titre) + ' ». L’enquête apparaîtra ici dès sa publication.' : 'Les enquêtes choisies par les abonnés apparaîtront ici dès leur publication.') + '</p></section>';
    }
    h += '<div class="phv-gagnants">' + publies.slice(0, 6).map(function (x) {
      var a = x.article;
      return '<a class="phv-gagnant" href="' + esc(a.url) + '"><figure>' + (a.image ? '<img src="' + esc(a.image) + '" alt="" loading="lazy">' : '') + '</figure><h3>' + esc(a.title || x.titre) + '</h3><p>Vote de ' + esc(x.mois_txt) + ', ' + pl(x.votes || 0, 'vote') + '</p></a>';
    }).join('') + '</div>';
    return h + '</section>';
  }

  // ---------------------------------------------------------------- vue rédaction (contrôlée côté serveur)
  function redaction() {
    var r = S.red;
    var h = '<section class="phv-red" id="redaction"><h2>Vue rédaction</h2>';
    if (!r) return h + '<p class="phv-note">Visible par la rédaction seulement. <button type="button" class="phv-btn petit secondaire" data-act="red-charger">Ouvrir le suivi</button></p></section>';
    var c = r.config || {};
    if (!c.airtable) h += '<p class="phv-alerte ko">Le secret Supabase AIRTABLE_TOKEN manque : à la clôture, le gagnant ne pourra pas être envoyé à l’Usine (il faudra l’imposer à la main).</p>';
    var t = r.tour, props = r.propositions || [], sujets = r.sujets || [];
    var votesPar = {}; (r.votes || []).forEach(function (v) { var k = v.cible_type + ':' + v.cible_id; votesPar[k] = (votesPar[k] || 0) + 1; });
    h += '<p class="phv-note">Tour ' + esc(t.mois_txt) + (t.test ? ' (test)' : '') + ' · phase ' + esc(t.phase) + ' · IA : ' + esc(t.ia_etat) + (r.ia_essais ? ' (' + r.ia_essais + ' essai' + (r.ia_essais > 1 ? 's' : '') + ')' : '') + ' · ' + pl((r.votes || []).length, 'votant') + '</p>';
    if (r.ia_erreur) h += '<p class="phv-alerte ko">Dernière erreur de l’IA : ' + esc(r.ia_erreur) + '</p>';
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
    if (r.ia_justification) h += '<div><p class="phv-note">Ce que l’IA a fait :</p><pre>' + esc(r.ia_justification) + '</pre></div>';
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
    var texte = av.join(' ').toLowerCase();
    if (texte.indexOf('tv') < 0 && texte.indexOf('documentaire') < 0) av.push('Posthumain TV : les documentaires en exclusivité, trois mois avant YouTube');
    av.push('Une voix dans le choix de l’enquête du mois : proposer un sujet et voter');
    var prix = offre && offre.mensuel ? 'Dès ' + (offre.mensuel / 100).toFixed(2).replace('.', ',').replace(',00', '') + ' ' + (offre.devise === 'EUR' ? '€' : offre.devise) + ' par mois' + (offre.annuel ? ', ou ' + (offre.annuel / 100).toFixed(2).replace('.', ',').replace(',00', '') + ' ' + (offre.devise === 'EUR' ? '€' : offre.devise) + ' par an' : '') + '. Sans engagement.' : 'Sans engagement.';
    var visiteur = role === 'visiteur';
    var f = document.createElement('div');
    f.className = 'phv-fond'; f.setAttribute('role', 'dialog'); f.setAttribute('aria-modal', 'true'); f.setAttribute('aria-labelledby', 'phv-f-titre');
    f.innerHTML = '<div class="phv-fenetre"><button type="button" class="phv-fermer" aria-label="Fermer">✕</button>' +
      '<h2 id="phv-f-titre">' + (visiteur ? 'Votez pour la prochaine enquête premium' : 'Le vote est réservé aux abonnés premium') + '</h2>' +
      '<p class="phv-h2-sous">' + (visiteur ? 'Proposer et voter est réservé aux abonnés premium. Créez votre compte, puis passez premium pour faire entendre votre voix.' : 'Débloquez le vote et tout ce que la rédaction réserve à ses abonnés.') + '</p>' +
      '<ul class="phv-avantages">' + av.map(function (a) { return '<li>' + esc(a) + '</li>'; }).join('') + '</ul>' +
      '<p class="phv-prix">' + esc(prix) + '</p>' +
      (visiteur ? '<a class="phv-btn" href="#/portal/signup" data-portal="signup">Créer mon compte</a><a class="phv-lien" href="#/portal/signin" data-portal="signin">J’ai déjà un compte : me connecter</a>'
        : '<a class="phv-btn" href="#/portal/account/plans" data-portal="account/plans">Passer premium</a><a class="phv-lien" href="/tv/">Découvrir Posthumain TV</a>') + '</div>';
    document.body.appendChild(f);
    var prec = document.activeElement;
    f.addEventListener('click', function (e) { if (e.target === f || e.target.closest('.phv-fermer')) { fermerFenetre(); if (prec && prec.focus) prec.focus(); } else if (e.target.closest('[data-portal]')) fermerFenetre(); });
    f.addEventListener('keydown', function (e) { if (e.key === 'Escape') { fermerFenetre(); if (prec && prec.focus) prec.focus(); } });
    var b = f.querySelector('.phv-btn'); if (b) b.focus();
  }
  function fermerFenetre() { var f = document.querySelector('.phv-fond'); if (f) f.remove(); }

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
  var GLYPHES = '01アイウエオカキクケコサシスセソ#%&$@<>/\\=+';
  function decoder() {
    var els = root.querySelectorAll('.phv-dec');
    Array.prototype.forEach.call(els, function (el, n) {
      var final = el.textContent, debut = performance.now() + n * 40, duree = el.tagName === 'B' ? 700 : 1100;
      el.classList.add('phv-dec-en-cours');
      (function pas(maint) {
        var p = Math.min(1, Math.max(0, (maint - debut) / duree)), fixe = Math.floor(final.length * p), s = '';
        for (var i = 0; i < final.length; i++) {
          var c = final[i];
          s += (i < fixe || c === ' ' || c === '’' || c === ',' || c === '.') ? c : GLYPHES[(Math.random() * GLYPHES.length) | 0];
        }
        el.textContent = s;
        if (p < 1) requestAnimationFrame(pas); else { el.textContent = final; el.classList.remove('phv-dec-en-cours'); }
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
