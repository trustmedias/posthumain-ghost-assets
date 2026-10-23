/* Posthumain — démarrage commun des labs (shared/lab-boot.js), 22/10/2026.
   Chargé par page.html de chaque lab (Writinglab, Videolab), AVANT l'application :
   1) l'écran de chargement : le plan du lab se dessine pièce par pièce et chaque employé rejoint son bureau, jusqu'au
      premier affichage complet (window.PH_LOADER.fin(), alias WL_LOADER / VL_LOADER) ;
   2) les appels au webhook n8n du lab avec le jeton du membre Ghost (gardé 2 min, redemandé si le serveur dit qu'il a expiré) ;
   3) le téléchargement de l'application (webhook, champ « app ») puis son lancement.
   Les briques communes de l'application elle-même (boutons, confirmations, toasts, thème…) sont dans shared/lab-core.js,
   envoyé par le webhook avec l'application.

   PHLabBoot.lancer({
     prefixe: 'wl',                         // ids et classes de l'écran de chargement : #wl-loader, .wll-*
     nom: 'WRITINGLAB', sous: 'La rédaction de Posthumain',
     api: 'https://…/webhook/writinglab', appParams: { mode: 'app' }, demarrer: 'WRITINGLAB_START', racine: 'wl-root',
     plan: { couloir: [x, y, w, h], pieces: [[x, y, w, h, 'NOM'], …], gens: [[x, y, '✍️'], …] },   // dans un repère 520 × 260
     etapes: ['Les lumières s’allument…', …], pret: 'La rédaction est prête.',
     reserve: '🔒 Cet espace est réservé à la rédaction.', panne: '⚠️ La rédaction ne répond pas. Réessayez dans un instant.',
     couleurs: { … }                        // facultatif : voir DEF ci-dessous (sombre) et DEFC (clair)
   }); */
(function () {
  'use strict';
  if (window.PHLabBoot) return;
  var L = window.PHLab = window.PHLab || {};

  // ---------- jeton du membre Ghost (partagé ensuite avec shared/lab-core.js) ----------
  var J = { t: '', at: 0, p: null };
  L.jeton = function () {
    if (J.t && Date.now() - J.at < 120000) return Promise.resolve(J.t);
    if (J.p) return J.p;
    J.p = fetch('/members/api/session', { credentials: 'same-origin' }).then(function (r) { return r.ok ? r.text() : ''; })
      .then(function (t) { J.p = null; if (t) { J.t = t; J.at = Date.now(); } return t; }, function () { J.p = null; return ''; });
    return J.p;
  };
  L.jetonPerime = function () { J.at = 0; };

  // couleurs de l'écran de chargement (valeurs du Writinglab par défaut)
  var DEF = { fond: 'radial-gradient(900px 520px at 30% -10%,#2a1d0f 0%,#0b0a08 60%) #0b0a08', fondUni: '#0b0a08', texte: '#f3ece0', texteRgb: '243,236,224',
    couloir: '#14100b', piece: 'rgba(255,190,90,.035)', bordPiece: 'rgba(255,190,90,.38)', perso: '#2a2116', bureau: '#3a2c1d' };
  var DEFC = { fond: 'radial-gradient(900px 520px at 30% -10%,#efe6d6 0%,#f6f2ea 60%) #f6f2ea', fondUni: '#f6f2ea', couloir: '#e7e0d3', piece: 'rgba(150,100,30,.06)', bordPiece: 'rgba(150,100,30,.5)',
    perso: '#f1eadc', bureau: '#d8ccb6' };

  function css(p, c, k) {
    var L1 = '#' + p + '-loader', l = '.' + p + 'l', B = '.' + p + '-boot', K = p + 'l';
    return '#' + p + '-root{min-height:70vh}' +
      L1 + '{position:fixed;inset:0;z-index:3999400;display:flex;align-items:center;justify-content:center;padding:24px;background:' + c.fond + ';color:' + c.texte + ';font:15px/1.5 Inter,system-ui,-apple-system,sans-serif;transition:opacity .55s ease,visibility .55s}' +
      L1 + '.fin{opacity:0;visibility:hidden}' +
      l + '-in{width:min(780px,100%);text-align:center}' +
      l + "-logo{font:800 17px ui-monospace,'JetBrains Mono',monospace;letter-spacing:.24em;color:#00ff77;text-shadow:0 0 18px rgba(0,255,119,.45);margin-bottom:18px}" +
      l + '-logo small{display:block;margin-top:4px;font:500 12px Inter,system-ui,sans-serif;letter-spacing:.06em;color:rgba(' + c.texteRgb + ',.55);text-shadow:none}' +
      l + '-plan{width:100%;height:auto;overflow:visible}' +
      l + '-plan .cor{fill:' + c.couloir + ';opacity:0;animation:' + K + 'fade .5s .1s forwards}' +
      l + '-plan .rm rect{fill:' + c.piece + ';stroke:' + c.bordPiece + ';stroke-width:1.2;stroke-dasharray:100;stroke-dashoffset:100;animation:' + K + 'draw .9s var(--d) ease-out forwards}' +
      l + '-plan .rm text{font:600 6.5px ui-monospace,monospace;letter-spacing:.12em;fill:rgba(' + c.texteRgb + ',.45);opacity:0;animation:' + K + 'fade .4s calc(var(--d) + .5s) forwards}' +
      l + '-plan .pp{transform:translate(260px,130px) scale(.4);opacity:0;animation:' + K + 'walk .85s var(--d) cubic-bezier(.3,.7,.2,1) forwards}' +
      l + '-plan .pp circle{fill:' + c.perso + ';stroke:rgba(0,255,119,.55);stroke-width:1}' +
      l + '-plan .pp text{font-size:14px;text-anchor:middle}' +
      l + '-plan .pp .dk{fill:' + c.bureau + ';opacity:0;animation:' + K + 'fade .3s calc(var(--d) + .6s) forwards}' +
      l + '-plan .pp .on{fill:#00ff77;stroke:none;opacity:0;animation:' + K + 'fade .3s calc(var(--d) + .8s) forwards,' + K + 'pulse 1.6s calc(var(--d) + 1.1s) ease-in-out infinite}' +
      l + '-bar{margin:20px auto 10px;width:min(320px,80%);height:3px;border-radius:3px;background:rgba(255,255,255,.08);overflow:hidden}' +
      l + '-bar i{display:block;height:100%;width:0;background:linear-gradient(90deg,#00b856,#00ff77);box-shadow:0 0 12px rgba(0,255,119,.6);animation:' + K + 'prog 3.4s cubic-bezier(.2,.6,.3,1) forwards}' +
      L1 + '.pret ' + l + '-bar i{width:100%!important;animation:none;transition:width .3s}' +
      l + '-txt{min-height:1.5em;color:rgba(' + c.texteRgb + ',.7);font-size:14px;transition:opacity .25s}' +
      '@keyframes ' + K + 'draw{to{stroke-dashoffset:0}}@keyframes ' + K + 'fade{to{opacity:1}}' +
      '@keyframes ' + K + 'walk{0%{opacity:0;transform:translate(260px,130px) scale(.4)}25%{opacity:1}100%{opacity:1;transform:translate(var(--x),var(--y)) scale(1)}}' +
      '@keyframes ' + K + 'pulse{50%{opacity:.35}}@keyframes ' + K + 'prog{0%{width:0}60%{width:72%}100%{width:90%}}' +
      '@media (prefers-reduced-motion:reduce){' + l + '-plan *{animation-duration:.01s!important;animation-delay:0s!important}}' +
      B + '{position:fixed;inset:0;z-index:3999500;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:14px;text-align:center;padding:24px;background:' + c.fondUni + ';color:rgba(' + c.texteRgb + ',.75);font:16px/1.5 system-ui,-apple-system,sans-serif}' +
      B + ' b{color:#00ff77;letter-spacing:.2em;font-family:ui-monospace,monospace}' +
      B + ' a{display:inline-block;margin-top:6px;padding:10px 18px;border-radius:12px;background:rgba(0,255,119,.12);border:1px solid rgba(0,255,119,.45);color:#bfffdc;text-decoration:none}' +
      // mode clair
      'html.ph-clair ' + L1 + '{background:' + k.fond + ';color:#1f1a12}' +
      'html.ph-clair ' + l + '-logo{color:#0a7a45;text-shadow:none}html.ph-clair ' + l + '-logo small{color:rgba(31,26,18,.6)}' +
      'html.ph-clair ' + l + '-plan .cor{fill:' + k.couloir + '}' +
      'html.ph-clair ' + l + '-plan .rm rect{fill:' + k.piece + ';stroke:' + k.bordPiece + '}' +
      'html.ph-clair ' + l + '-plan .rm text{fill:rgba(31,26,18,.55)}' +
      'html.ph-clair ' + l + '-plan .pp circle{fill:' + k.perso + ';stroke:rgba(10,122,69,.6)}' +
      'html.ph-clair ' + l + '-plan .pp .dk{fill:' + k.bureau + '}html.ph-clair ' + l + '-plan .pp .on{fill:#0a9a55}' +
      'html.ph-clair ' + l + '-bar{background:rgba(31,26,18,.1)}html.ph-clair ' + l + '-bar i{background:linear-gradient(90deg,#0a7a45,#0fb565);box-shadow:none}' +
      'html.ph-clair ' + l + '-txt{color:rgba(31,26,18,.7)}' +
      'html.ph-clair ' + B + '{background:' + k.fondUni + ';color:rgba(31,26,18,.75)}html.ph-clair ' + B + ' b{color:#0a7a45}' +
      'html.ph-clair ' + B + ' a{background:rgba(10,122,69,.1);border-color:rgba(10,122,69,.45);color:#0a5a33}';
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]; }); }
  function planSVG(pl) {
    var s = '<rect class="cor" x="' + pl.couloir[0] + '" y="' + pl.couloir[1] + '" width="' + pl.couloir[2] + '" height="' + pl.couloir[3] + '" rx="3"/>';
    pl.pieces.forEach(function (r, i) {
      s += '<g class="rm" style="--d:' + (i * 0.08).toFixed(2) + 's"><rect pathLength="100" x="' + r[0] + '" y="' + r[1] + '" width="' + r[2] + '" height="' + r[3] + '" rx="6"/><text x="' + (r[0] + 7) + '" y="' + (r[1] + 13) + '">' + esc(r[4]) + '</text></g>';
    });
    pl.gens.forEach(function (g, i) {
      s += '<g class="pp" style="--x:' + g[0] + 'px;--y:' + g[1] + 'px;--d:' + (0.9 + i * 0.22).toFixed(2) + 's"><rect class="dk" x="-20" y="6" width="40" height="11" rx="2"/><circle r="14"/><text y="5">' + g[2] + '</text><circle class="on" cx="12" cy="-11" r="3.5"/></g>';
    });
    return s;
  }

  function lancer(o) {
    var p = o.prefixe, c = {}, k = {}, x;
    for (x in DEF) c[x] = DEF[x]; for (x in (o.couleurs || {})) c[x] = o.couleurs[x];
    for (x in DEFC) k[x] = DEFC[x]; for (x in (o.couleursClair || {})) k[x] = o.couleursClair[x];
    var st = document.createElement('style'); st.id = p + '-boot-css'; st.textContent = css(p, c, k); document.head.appendChild(st);
    var root = document.getElementById(o.racine);
    // écran de chargement unique : le lab se dessine et chacun rejoint son bureau, jusqu'au premier affichage complet
    var Ld = document.createElement('div'); Ld.id = p + '-loader'; Ld.setAttribute('role', 'status'); Ld.setAttribute('aria-live', 'polite');
    Ld.innerHTML = '<div class="' + p + 'l-in"><div class="' + p + 'l-logo">' + esc(o.nom) + '<small>' + esc(o.sous) + '</small></div>' +
      '<svg class="' + p + 'l-plan" viewBox="0 0 520 260" aria-hidden="true">' + planSVG(o.plan) + '</svg>' +
      '<div class="' + p + 'l-bar"><i></i></div><div class="' + p + 'l-txt" id="' + p + 'l-txt">' + esc(o.etapes[0]) + '</div></div>';
    if (root && root.parentNode) root.parentNode.insertBefore(Ld, root); else document.body.appendChild(Ld);
    var T = Ld.querySelector('#' + p + 'l-txt'), n = 0, fini = false;
    var tick = setInterval(function () { n = Math.min(n + 1, o.etapes.length - 1); T.style.opacity = 0; setTimeout(function () { T.textContent = o.etapes[n]; T.style.opacity = 1; }, 220); }, 950);
    var LOADER = {
      etape: function (t) { if (T) T.textContent = t; },
      fin: function () {
        if (fini) return; fini = true;
        clearInterval(tick); if (T) T.textContent = o.pret; Ld.classList.add('pret');
        setTimeout(function () { Ld.classList.add('fin'); }, 350); setTimeout(function () { if (Ld.parentNode) Ld.parentNode.removeChild(Ld); }, 1000);
      }
    };
    window.PH_LOADER = LOADER; window[p.toUpperCase() + '_LOADER'] = LOADER;
    function msg(html) { LOADER.fin(); root.innerHTML = '<div class="' + p + '-boot"><b>' + esc(o.nom) + '</b>' + html + '</div>'; }

    // appel du webhook du lab : le jeton est gardé 2 min ; si le serveur le trouve expiré, on en redemande un et on réessaie une fois
    function call(params, deja) {
      return L.jeton().then(function (t) {
        if (!t) throw { why: 'non connecté' };
        var body = new URLSearchParams(); body.set('token', t);
        Object.keys(params || {}).forEach(function (kk) { body.set(kk, params[kk]); });
        return fetch(o.api, { method: 'POST', body: body }).then(function (r) {
          return r.json().catch(function () { return { ok: false, why: 'réponse illisible (' + r.status + ')' }; });
        });
      }).then(function (r) {
        if (!deja && r && r.ok === false && /jeton expiré|signature fausse|jeton illisible/.test(String(r.why || ''))) { L.jetonPerime(); return call(params, true); }
        return r;
      });
    }
    L.appel = call;
    call(o.appParams).then(function (res) {
      if (!res || !res.ok) { msg(res && res.why === 'accès réservé' ? '<div>' + esc(o.reserve) + '</div>' : '<div>⚠️ ' + esc((res && res.why) || 'indisponible') + '</div>'); return; }
      var s = document.createElement('script'); s.textContent = res.app; document.body.appendChild(s);
      if (typeof window[o.demarrer] !== 'function') { msg('<div>⚠️ L’application n’a pas pu démarrer. Réessayez dans un instant.</div>'); return; }
      window[o.demarrer]({ root: root, call: call });
    }).catch(function (e) {
      // 23/10/2026 : l'écran « Se connecter » passe SOUS la fenêtre de connexion de Ghost (Portal, z-index 3999999) : avant, il
      // la recouvrait (z-index maximal) et le bouton semblait ne rien faire. Le clic force aussi l'ouverture de Portal par le hash.
      if (e && e.why === 'non connecté') {
        msg('<div>' + esc(o.reserve) + '</div><a href="#/portal/signin" data-portal="signin">Se connecter</a>');
        var a = root.querySelector('a[data-portal]');
        if (a) a.addEventListener('click', function (ev) {
          ev.preventDefault();
          if (location.hash === '#/portal/signin') { history.replaceState(null, '', location.pathname + location.search); }
          setTimeout(function () { location.hash = '#/portal/signin'; }, 0);
        });
      }
      else msg('<div>' + esc(o.panne) + '</div>');
    });
  }
  window.PHLabBoot = { lancer: lancer };
})();
