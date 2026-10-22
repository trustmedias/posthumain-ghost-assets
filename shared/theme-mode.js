/* Posthumain — mode clair / sombre partagé (shared/theme-mode.js).
   Le site garde UN réglage : le cookie « tlj_theme » (white | dark, posé par le bouton lune du thème)
   et la classe « white-mode » sur <html>. Sans cookie, le site est sombre.
   Ce module lit et pilote ce même réglage pour les pages-applications (vote, labs…), et prévient
   quand il change : bouton du site, autre onglet (événement storage), retour sur l'onglet.
   API : PHTheme.get() → 'light' | 'dark' ; PHTheme.set(mode) ; PHTheme.toggle() ; PHTheme.onChange(fn) → désabonnement.
   Pour les labs (22/10/2026) :
   - PHTheme.isoler() : la page est une application qui a ses propres couleurs. Le thème du site, en mode clair, force
     « html.white-mode body * { fond blanc ; texte noir !important } », ce qui casse ces applications : une fois isolée,
     la page n'a plus jamais la classe « white-mode » ; le mode clair y est signalé par « ph-clair » sur <html>.
     Le réglage (cookie) reste le même que sur tout le site.
   - PHTheme.deriverClair(css, racine, racineClaire) : fabrique, à partir de la feuille sombre d'une application, une
     feuille « claire » qui ne s'applique que sous racineClaire (ex. « #wl.wl-clair »). La feuille sombre n'est jamais
     modifiée : le mode sombre reste identique au pixel près. */
(function () {
  'use strict';
  if (window.PHTheme) return;
  var CLE = 'tlj_theme', SYNC = 'ph_theme_sync', html = document.documentElement, abonnes = [], dernier = null, isole = false;

  function lireCookie() {
    try { var m = document.cookie.match(/(?:^|;\s*)tlj_theme=(white|dark)/); return m ? m[1] : ''; } catch (e) { return ''; }
  }
  function get() {
    var c = lireCookie();
    if (c) return c === 'white' ? 'light' : 'dark';
    if (isole) return html.classList.contains('ph-clair') ? 'light' : 'dark';
    return html.classList.contains('white-mode') ? 'light' : 'dark'; // défaut du site : sombre
  }
  // icônes du bouton lune/soleil du thème, s'il est présent sur la page
  function iconesSite(clair) {
    try {
      var b = document.querySelector('.tlj-toggle'); if (!b) return;
      var lune = b.querySelector('.icon-moon'), soleil = b.querySelector('.icon-sun');
      if (lune) lune.style.display = clair ? 'none' : 'block';
      if (soleil) soleil.style.display = clair ? 'block' : 'none';
    } catch (e) { /* rien */ }
  }
  function appliquer(mode) {
    var clair = mode === 'light';
    if (isole) {
      if (html.classList.contains('white-mode')) html.classList.remove('white-mode');
      if (html.classList.contains('ph-clair') !== clair) html.classList.toggle('ph-clair', clair);
      return;
    }
    if (html.classList.contains('white-mode') !== clair) html.classList.toggle('white-mode', clair);
    iconesSite(clair);
  }
  function prevenir() {
    var m = get(); if (m === dernier) return; dernier = m;
    abonnes.slice().forEach(function (fn) { try { fn(m); } catch (e) { /* abonné fautif */ } });
  }
  function set(mode) {
    var clair = mode === 'light';
    try { document.cookie = CLE + '=' + (clair ? 'white' : 'dark') + '; path=/; max-age=' + (365 * 86400) + '; SameSite=Strict'; } catch (e) { /* cookies bloqués */ }
    try { localStorage.setItem(SYNC, (clair ? 'light' : 'dark') + ':' + Date.now()); } catch (e) { /* stockage bloqué */ }
    appliquer(clair ? 'light' : 'dark');
    prevenir();
  }
  function onChange(fn) {
    abonnes.push(fn);
    return function () { abonnes = abonnes.filter(function (x) { return x !== fn; }); };
  }

  // état initial : la classe suit le cookie (comme le script du thème)
  appliquer(get()); dernier = get();
  // bouton lune du thème : il change la classe de <html> puis le cookie
  try {
    new MutationObserver(function () {
      // page isolée : si le thème du site remet « white-mode », on l'enlève (le mode reste lu dans le cookie)
      if (isole && html.classList.contains('white-mode')) { appliquer(get()); }
      prevenir();
    }).observe(html, { attributes: true, attributeFilter: ['class'] });
  } catch (e) { /* vieux navigateur */ }
  // autre onglet
  window.addEventListener('storage', function (e) { if (e.key === SYNC) { appliquer(get()); prevenir(); } });
  // retour sur l'onglet (le cookie a pu changer ailleurs sans événement)
  function revoir() { appliquer(get()); prevenir(); }
  window.addEventListener('focus', revoir);
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') revoir(); });


  // ---------- feuille claire dérivée de la feuille sombre d'une application ----------
  // Palette claire Posthumain : papier chaud, encre brune, vert profond pour les accents (le vert néon reste pour les
  // aplats, avec un texte sombre dessus). Les blocs déjà clairs en mode sombre (fiches papier, infobulles…) sont laissés tels quels.
  function rgba(t) {
    t = t.trim().toLowerCase(); var m;
    if (t[0] === '#') {
      var h = t.slice(1); if (h.length === 3 || h.length === 4) h = h.split('').map(function (c) { return c + c; }).join('');
      if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/.test(h)) return null;
      return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1];
    }
    if ((m = t.match(/^rgba?\(([^)]*)\)$/))) {
      var p = m[1].split(/[\s,\/]+/).filter(Boolean).map(parseFloat);
      if (p.length < 3) return null; return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
    }
    if (t === 'white') return [255, 255, 255, 1]; if (t === 'black') return [0, 0, 0, 1];
    return null;
  }
  function hsl(c) {
    var r = c[0] / 255, g = c[1] / 255, b = c[2] / 255, mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, h = 0, s = 0, d = mx - mn;
    if (d) { s = l > .5 ? d / (2 - mx - mn) : d / (mx + mn); h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; h *= 60; }
    return [h, s, l];
  }
  function deHsl(h, s, l, a) {
    var q = l < .5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
    function f(t) { t = (t + 360) % 360 / 360; if (t < 1 / 6) return p + (q - p) * 6 * t; if (t < .5) return q; if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6; return p; }
    var r = s ? f(h + 120) : l, g = s ? f(h) : l, b = s ? f(h - 120) : l;
    return ecrire([Math.round(r * 255), Math.round(g * 255), Math.round(b * 255), a]);
  }
  function ecrire(c) {
    var a = Math.round(Math.max(0, Math.min(1, c[3])) * 1000) / 1000;
    return a >= 1 ? '#' + c.slice(0, 3).map(function (x) { return ('0' + Math.max(0, Math.min(255, x)).toString(16)).slice(-2); }).join('') : 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a + ')';
  }
  // familles de teintes vives : [teinte min, teinte max, encre (texte), base des aplats/bordures]
  var FAMILLES = [
    [120, 175, [10, 122, 69], [10, 122, 69]],   // vert néon → vert profond
    [25, 55, [138, 86, 0], [176, 108, 0]],      // ambre
    [56, 70, [120, 96, 0], [150, 120, 0]],      // jaune
    [190, 250, [31, 95, 168], [31, 95, 168]],   // bleu
    [250, 320, [102, 58, 170], [102, 58, 170]], // violet
    [330, 380, [179, 36, 60], [200, 30, 60]]    // rouge / rose
  ];
  function famille(h) { for (var i = 0; i < FAMILLES.length; i++) { var f = FAMILLES[i], hh = h < 20 && f[1] > 360 ? h + 360 : h; if (hh >= f[0] && hh <= f[1]) return f; } return null; }
  function convertir(tok, role) {
    var c = rgba(tok); if (!c) return tok;
    var a = c[3], t = hsl(c), h = t[0], s = t[1], l = t[2], f = s > .45 && l > .25 && l < .92 ? famille(h) : null;
    if (f) { // couleur vive
      if (role === 'texte') return ecrire(f[2].concat(a < 1 ? Math.max(a, .85) : 1));
      if (role === 'fond') return a > .6 ? tok : ecrire(f[3].concat(Math.min(1, a * 1.15)));
      if (role === 'ombre') return ecrire(f[3].concat(Math.min(.35, a * .5)));
      return ecrire(f[3].concat(Math.min(1, Math.max(a * 1.1, .28)))); // bordure
    }
    if (c[0] + c[1] + c[2] === 0 || (l < .06 && role === 'ombre')) { // noir : ombres et voiles
      return ecrire([60, 45, 20, role === 'fond' ? a * .5 : a * .35]);
    }
    if (l > .78) { // blancs / crème : textes clairs et voiles blancs → encre
      if (role === 'texte') return ecrire([31, 26, 18, Math.min(1, .3 + .68 * a)]);
      if (role === 'fond') return ecrire([31, 26, 18, Math.min(.5, a * .9)]);
      if (role === 'ombre') return ecrire([60, 45, 20, a * .3]);
      return ecrire([31, 26, 18, Math.min(.32, Math.max(a * 1.4, .1))]);
    }
    if (l < .3) { // fonds sombres → papier (même teinte, saturation adoucie)
      if (role === 'texte') return tok;
      if (role === 'bordure') return ecrire([31, 26, 18, .14 * (a < 1 ? Math.max(a, .5) : 1)]);
      return deHsl(h, Math.min(.32, s * .6 + .1), Math.min(.985, .972 - l * .5), a);
    }
    // tons moyens
    if (role === 'texte') return deHsl(h, s * .7, Math.max(.2, Math.min(.42, 1 - l - .12)), a);
    if (role === 'fond') return deHsl(h, s * .5, Math.min(.95, 1 - l * .45), a);
    return ecrire([31, 26, 18, .16]);
  }
  var JETONS = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|\b(?:white|black)\b/g;
  function roleDe(prop, val) {
    if (/^(color|-webkit-text-fill-color|caret-color)$/.test(prop)) return 'texte';
    if (/shadow/.test(prop)) return 'ombre';
    if (/^(border|outline|stroke)/.test(prop) || prop === 'column-rule-color') return 'bordure';
    if (prop === 'fill') { var c = (val.match(JETONS) || [])[0], k = c && rgba(c); return k && hsl(k)[2] > .7 ? 'texte' : 'fond'; }
    if (/^background/.test(prop) || prop === 'stop-color') return 'fond';
    return null;
  }
  function fondClair(decls) {
    return decls.some(function (d) {
      if (!/^background(-color)?$/.test(d.p)) return false;
      var c = (d.v.match(JETONS) || []).map(rgba).filter(Boolean)[0];
      return !!c && c[3] > .6 && hsl(c)[2] > .8;
    });
  }
  function estPapier(decls) { // bloc déjà clair en mode sombre : on n'y touche pas
    return decls.some(function (d) {
      var c = (d.v.match(JETONS) || []).map(rgba).filter(Boolean)[0]; if (!c) return false;
      var l = hsl(c)[2];
      if (/^background(-color)?$/.test(d.p) && c[3] > .6 && l > .8) return true;
      if (d.p === 'color' && c[3] > .6 && l < .3) return true;
      return false;
    });
  }
  function deriverClair(css, racine, racineClaire) {
    var re = racine.replace(/[.*+?^${}()|[\]\\#]/g, '\\$&'), papiers = {};
    var reSel = new RegExp(re + '(?![\\w-])', 'g');
    function regle(sel, corps) {
      if (sel.indexOf(racine) < 0) return '';
      var decls = corps.split(';').map(function (x) { var k = x.indexOf(':'); return k < 0 ? null : { p: x.slice(0, k).trim().toLowerCase(), v: x.slice(k + 1).trim() }; }).filter(Boolean);
      // bloc déjà clair (ou aplat néon à texte sombre) : recopié tel quel sous la racine claire, pour que la cascade
      // reste la même qu'en sombre (sinon une règle claire plus générale passerait devant lui)
      var garder = estPapier(decls);
      if (garder && fondClair(decls)) sel.split(',').forEach(function (x) { var dern = x.trim().split(/\s+|>|\+|~/).filter(Boolean).pop() || ''; (dern.match(/\.[\w-]+/g) || []).forEach(function (c) { papiers[c] = 1; }); });
      if (!garder) garder = Object.keys(papiers).some(function (c) { return sel.split(',').some(function (x) { return new RegExp('\\' + c + '(?![\\w-])[^\\s,]*\\s+\\S').test(x.trim()); }); });
      var res = [];
      decls.forEach(function (d) {
        var role = roleDe(d.p, d.v); if (!role) return;
        var imp = /!important\s*$/.test(d.v), v = d.v.replace(/!important\s*$/, '').trim(), nv;
        if (garder) { if (JETONS.test(v) || /^(color|background|fill|stroke)/.test(d.p)) res.push(d.p + ':' + v + (imp ? '!important' : '')); JETONS.lastIndex = 0; return; }
        if (d.p === 'text-shadow') nv = /none/.test(v) ? v : 'none';
        else nv = v.replace(JETONS, function (t) { return convertir(t, role); });
        if (nv !== v) res.push(d.p + ':' + nv + (imp ? '!important' : ''));
      });
      if (!res.length) return '';
      var s2 = sel.split(',').map(function (x) { return x.replace(reSel, racineClaire); }).join(',');
      return s2 + '{' + res.join(';') + '}';
    }
    function bloc(txt) { // règles simples, @media récursif, @keyframes ignorés
      var o = [], j = 0, m = txt.length;
      while (j < m) {
        var a = txt.indexOf('{', j); if (a < 0) break;
        var tete = txt.slice(j, a).trim();
        if (tete[0] === '@') {
          var prof = 1, k = a + 1; while (k < m && prof) { if (txt[k] === '{') prof++; else if (txt[k] === '}') prof--; k++; }
          if (/^@media|^@supports/.test(tete)) { var inn = bloc(txt.slice(a + 1, k - 1)); if (inn) o.push(tete + '{' + inn + '}'); }
          j = k; continue;
        }
        var b = txt.indexOf('}', a); if (b < 0) break;
        var r = regle(tete, txt.slice(a + 1, b)); if (r) o.push(r);
        j = b + 1;
      }
      return o.join('\n');
    }
    return bloc(css);
  }

  function isoler() { isole = true; appliquer(get()); dernier = get(); }
  window.PHTheme = { get: get, set: set, toggle: function () { set(get() === 'light' ? 'dark' : 'light'); }, onChange: onChange, isoler: isoler, deriverClair: deriverClair };
})();
