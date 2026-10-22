/* Posthumain — mode clair / sombre partagé (shared/theme-mode.js).
   Le site garde UN réglage : le cookie « tlj_theme » (white | dark, posé par le bouton lune du thème)
   et la classe « white-mode » sur <html>. Sans cookie, le site est sombre.
   Ce module lit et pilote ce même réglage pour les pages-applications (vote, labs…), et prévient
   quand il change : bouton du site, autre onglet (événement storage), retour sur l'onglet.
   API : PHTheme.get() → 'light' | 'dark' ; PHTheme.set(mode) ; PHTheme.toggle() ; PHTheme.onChange(fn) → désabonnement. */
(function () {
  'use strict';
  if (window.PHTheme) return;
  var CLE = 'tlj_theme', SYNC = 'ph_theme_sync', html = document.documentElement, abonnes = [], dernier = null;

  function lireCookie() {
    try { var m = document.cookie.match(/(?:^|;\s*)tlj_theme=(white|dark)/); return m ? m[1] : ''; } catch (e) { return ''; }
  }
  function get() {
    var c = lireCookie();
    if (c) return c === 'white' ? 'light' : 'dark';
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
  try { new MutationObserver(function () { prevenir(); }).observe(html, { attributes: true, attributeFilter: ['class'] }); } catch (e) { /* vieux navigateur */ }
  // autre onglet
  window.addEventListener('storage', function (e) { if (e.key === SYNC) { appliquer(get()); prevenir(); } });
  // retour sur l'onglet (le cookie a pu changer ailleurs sans événement)
  function revoir() { appliquer(get()); prevenir(); }
  window.addEventListener('focus', revoir);
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') revoir(); });

  window.PHTheme = { get: get, set: set, toggle: function () { set(get() === 'light' ? 'dark' : 'light'); }, onChange: onChange };
})();
