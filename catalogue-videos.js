/* =============================================================================
 * POSTHUMAIN — catalogue-videos.js
 * Page « Catalogue vidéo » (posthumain.com/catalogue-videos/), à la Netflix.
 * -----------------------------------------------------------------------------
 * MISE EN PLACE (une seule fois, dans Ghost) :
 *   - Page Ghost, slug « catalogue-videos », accès « Abonnés payants »
 *     (Ghost y inclut les membres complimentary).
 *   - Contenu de la page = une carte HTML :  <div id="ph-catalogue"></div>
 *     Ghost ne livre cette carte qu'aux abonnés payants : c'est elle qui ouvre la porte.
 *   - Code injection DE LA PAGE (Page settings → Code injection → Page footer) :
 *     <script src="https://cdn.jsdelivr.net/gh/trustmedias/posthumain-ghost-assets@main/catalogue-videos.js" defer></script>
 *
 * FONCTIONNEMENT :
 *   - Abonné (la carte #ph-catalogue est présente) → catalogue plein écran.
 *   - Sinon → écran d'abonnement plein écran (visiteur : inscription ; membre gratuit : passage au payant).
 *   - Catalogue = articles Ghost publiés portant le tag interne #version-longue (créés par l'usine
 *     motion design n8n), lus via la Content API publique. Rien à mettre à jour à la main.
 *   - Thème, série et durée : lus dans la carte cachée que l'usine ajoute à chaque page vidéo :
 *       <div class="ph-video-meta" data-youtube="ID" data-theme="ia" data-series="comment" data-duration="408" hidden></div>
 *     Sans cette carte (anciennes pages) : vidéo lue dans l'iframe YouTube, thème « ia » par défaut.
 *   - Lecteur YouTube intégré (youtube-nocookie) : reprise là où on s'est arrêté et épisode suivant,
 *     mémorisés sur l'appareil (localStorage).
 * ============================================================================= */
(function (run) {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
  else run();
})(function () {
  'use strict';
  if (window.__phCatalogue) return;
  window.__phCatalogue = true;

  // ---------------------------------------------------------------------------
  // Réglages
  var TAG_FILTER = 'tag:hash-version-longue';
  var CONTENT_API_FALLBACK = 'https://the-last-journal.ghost.io/ghost/api/content/';
  var PORTAL_SIGNUP = '#/portal/signup';          // visiteur non connecté (même logique que paywall-flow.js)
  var PORTAL_UPGRADE = '#/portal/account/plans';  // membre gratuit connecté
  var PORTAL_SIGNIN = '#/portal/signin';
  var THEME_ROWS_FROM = 6;   // rangées par thème seulement à partir de N vidéos (sinon doublons)
  var SERIES_ROWS_FROM = 10; // rangées par série à partir de N vidéos

  var THEMES = {
    ia: 'Intelligence artificielle',
    energie: 'Énergie & économie',
    vivant: 'Santé & vivant',
    cerveau: 'Cerveau',
    espace: 'Espace',
    danger: 'Cyber & risques'
  };
  var SERIES = {
    comment: 'Comment ça marche',
    pourquoi: 'Pourquoi…',
    etsi: 'Et si…',
    cout: 'Ce que ça coûte vraiment',
    futur: 'Le futur'
  };

  var host = document.getElementById('ph-catalogue');
  var isMember = !!host;

  // ---------------------------------------------------------------------------
  // Utilitaires
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function store(key, val) {
    try {
      if (val === undefined) return JSON.parse(localStorage.getItem(key) || 'null');
      localStorage.setItem(key, JSON.stringify(val));
    } catch (e) { return null; }
  }
  function sized(url, w) {
    // Images Ghost : version redimensionnée (le thème Source génère w600 / w1200)
    if (!url || !/\/content\/images\//.test(url) || /\/content\/images\/size\//.test(url)) return url || '';
    return url.replace('/content/images/', '/content/images/size/w' + w + '/');
  }
  function mmss(sec) {
    sec = Math.round(sec || 0);
    return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
  }
  function minutes(sec) { return sec ? Math.max(1, Math.round(sec / 60)) + ' min' : ''; }
  function svg(id) { return '<svg aria-hidden="true" focusable="false"><use href="#phc-' + id + '"></use></svg>'; }
  function $(s, root) { return (root || document).querySelector(s); }

  // ---------------------------------------------------------------------------
  // Styles (préfixés #phc pour ne rien casser du thème)
  var fonts = document.createElement('link');
  fonts.rel = 'stylesheet';
  fonts.href = 'https://fonts.googleapis.com/css2?family=Big+Shoulders+Display:wght@800;900&family=Instrument+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@500&display=swap';
  document.head.appendChild(fonts);

  var css = [
    '#phc{--bg:#06090a;--surface:#0f1517;--surface-2:#172023;--line:#22302f;--fg:#edf4f1;--muted:#8fa29b;--soft:#c5d3ce;--accent:#3dff8f;--accent-ink:#021409;--glow:rgba(61,255,143,.35);',
    '--display:"Big Shoulders Display","Arial Narrow",Impact,sans-serif;--body:"Instrument Sans",system-ui,-apple-system,"Segoe UI",sans-serif;--mono:"JetBrains Mono",ui-monospace,Menlo,Consolas,monospace;',
    '--gl:max(16px,env(safe-area-inset-left,0px));--gr:max(16px,env(safe-area-inset-right,0px));',
    'position:fixed;inset:0;z-index:3999990;background:var(--bg);color:var(--fg);font-family:var(--body);font-size:15px;line-height:1.5;overflow-y:auto;overflow-x:hidden;-webkit-overflow-scrolling:touch;-webkit-font-smoothing:antialiased;color-scheme:dark;text-align:left}',
    '@media (min-width:900px){#phc{--gl:max(48px,env(safe-area-inset-left,0px));--gr:max(48px,env(safe-area-inset-right,0px))}}',
    '#phc *,#phc *::before,#phc *::after{box-sizing:border-box}',
    '#phc [hidden]{display:none!important}',
    '#phc h1,#phc h2,#phc h3,#phc p,#phc ul{margin:0;padding:0;letter-spacing:normal;text-transform:none}',
    '#phc button{font:inherit;color:inherit;margin:0;letter-spacing:normal;text-transform:none;line-height:inherit;-webkit-appearance:none;appearance:none}',
    '#phc a{color:inherit}',
    '#phc img{max-width:100%}',
    '#phc :focus-visible{outline:2px solid var(--accent);outline-offset:3px}',
    '#phc svg{width:18px;height:18px;flex-shrink:0;fill:none;stroke:currentColor}',

    /* En-tête */
    '#phc .phc-top{position:sticky;top:0;z-index:20;display:flex;align-items:center;gap:20px;padding-block:calc(12px + env(safe-area-inset-top,0px)) 12px;padding-left:var(--gl);padding-right:var(--gr);background:linear-gradient(to bottom,rgba(6,9,10,.95),rgba(6,9,10,0));transition:background .25s}',
    '#phc .phc-top.solid{background:rgba(6,9,10,.97);box-shadow:0 1px 0 var(--line)}',
    '#phc .phc-brand{display:flex;align-items:center;gap:10px;text-decoration:none;flex-shrink:0}',
    '#phc .phc-brand svg{width:30px;height:30px;stroke:none;filter:drop-shadow(0 0 6px var(--glow))}',
    '#phc .phc-brand b{display:block;font-family:var(--mono);font-weight:500;font-size:13px;letter-spacing:.22em;line-height:1.2}',
    '#phc .phc-brand small{display:block;font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--accent);line-height:1.4}',
    '#phc .phc-nav{display:flex;gap:18px;font-size:14px;color:var(--muted)}',
    '#phc .phc-nav button{background:none;border:0;padding:4px 0;cursor:pointer}',
    '#phc .phc-nav button[aria-current="true"]{color:var(--fg);font-weight:600}',
    '#phc .phc-nav button:hover{color:var(--fg)}',
    '#phc .phc-spacer{flex:1}',
    '#phc .phc-site{font-size:13px;color:var(--muted);text-decoration:none;white-space:nowrap}',
    '#phc .phc-site:hover{color:var(--fg)}',
    '@media (max-width:720px){#phc .phc-nav{display:none}}',

    /* Héros */
    '#phc .phc-hero{position:relative;display:grid;grid-template-columns:minmax(0,1fr);margin-top:-64px}',
    '#phc .phc-hero-art{position:relative;aspect-ratio:16/9;overflow:hidden;background:var(--surface)}',
    '#phc .phc-hero-art img{width:100%;height:100%;object-fit:cover;display:block;animation:phc-drift 22s ease-in-out infinite alternate}',
    '#phc .phc-hero-art::after{content:"";position:absolute;inset:0;background:linear-gradient(to top,var(--bg) 0%,rgba(6,9,10,0) 45%)}',
    '@keyframes phc-drift{from{transform:scale(1.02)}to{transform:scale(1.08) translateX(-1.5%)}}',
    '#phc .phc-hero-copy{position:relative;z-index:2;margin-top:-28px;padding-left:var(--gl);padding-right:var(--gr);display:grid;gap:12px;align-content:end;min-width:0}',
    '#phc .phc-eyebrow{display:flex;gap:10px;align-items:center;font-family:var(--mono);font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted)}',
    '#phc .phc-new{color:var(--accent-ink);background:var(--accent);padding:3px 7px;border-radius:3px;box-shadow:0 0 14px var(--glow)}',
    '#phc .phc-hero h1{font-family:var(--display);font-weight:800;text-transform:uppercase;font-size:clamp(34px,8vw,64px);line-height:.95;color:var(--fg);text-wrap:balance;max-width:17ch}',
    '#phc .phc-meta{display:flex;flex-wrap:wrap;gap:6px 14px;font-size:13px;color:var(--muted);font-variant-numeric:tabular-nums}',
    '#phc .phc-meta .phc-dur{font-family:var(--mono);color:var(--fg)}',
    '#phc .phc-desc{max-width:52ch;color:var(--soft)}',
    '#phc .phc-actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:4px}',
    '#phc .phc-btn{display:inline-flex;align-items:center;gap:9px;border:0;border-radius:6px;padding:12px 20px;font-weight:700;font-size:15px;cursor:pointer;text-decoration:none;transition:transform .15s,background .15s;line-height:1.2}',
    '#phc .phc-btn:active{transform:scale(.97)}',
    '#phc .phc-play{background:var(--fg);color:var(--bg)}',
    '#phc .phc-play:hover{background:#fff}',
    '#phc .phc-play svg{fill:currentColor;stroke:none}',
    '#phc .phc-ghost{background:rgba(237,244,241,.12);color:var(--fg)}',
    '#phc .phc-ghost:hover{background:rgba(237,244,241,.2)}',
    '#phc .phc-ghost[aria-pressed="true"]{color:var(--accent)}',
    '@media (max-width:480px){#phc .phc-btn{padding:11px 15px;font-size:14px;gap:7px}#phc .phc-hide-sm{display:none}}',
    '@media (min-width:900px){',
    '#phc .phc-hero{grid-template-columns:minmax(0,5fr) minmax(0,7fr);align-items:center;min-height:clamp(460px,70vh,640px)}',
    '#phc .phc-hero-art{grid-column:2;grid-row:1;aspect-ratio:auto;height:100%;-webkit-mask-image:linear-gradient(to right,transparent 0%,#000 9%);mask-image:linear-gradient(to right,transparent 0%,#000 9%)}',
    '#phc .phc-hero-art::after{background:linear-gradient(to top,var(--bg) 0%,rgba(6,9,10,0) 30%)}',
    '#phc .phc-hero-copy{grid-column:1;grid-row:1;margin-top:64px;padding-right:0}',
    '}',

    /* Thèmes */
    '#phc .phc-chips{display:flex;gap:8px;overflow-x:auto;scrollbar-width:none;padding-block:22px 6px;padding-left:var(--gl);padding-right:var(--gr)}',
    '#phc .phc-chips::-webkit-scrollbar{display:none}',
    '#phc .phc-chip{flex-shrink:0;border:1px solid var(--line);background:transparent;border-radius:999px;padding:7px 14px;font-size:13px;font-weight:500;color:var(--muted);cursor:pointer}',
    '#phc .phc-chip[aria-pressed="true"]{background:var(--fg);color:var(--bg);border-color:var(--fg)}',

    /* Rangées */
    '#phc .phc-rows{display:grid;grid-template-columns:minmax(0,1fr);gap:26px;padding-block:14px calc(60px + env(safe-area-inset-bottom,0px))}',
    '#phc .phc-row{min-width:0}',
    '#phc .phc-row h2{margin:0 0 10px;font-family:var(--body);font-size:17px;font-weight:600;color:var(--fg);display:flex;align-items:baseline;gap:10px;padding-left:var(--gl);padding-right:var(--gr)}',
    '#phc .phc-row h2 span{font-size:12px;font-weight:400;color:var(--muted)}',
    '#phc .phc-track{display:flex;gap:12px;overflow-x:auto;scroll-snap-type:x mandatory;scroll-padding-left:var(--gl);scrollbar-width:none;padding-left:var(--gl);padding-right:var(--gr);padding-block:6px 10px}',
    '#phc .phc-track::-webkit-scrollbar{display:none}',
    '#phc .phc-card{position:relative;flex-shrink:0;width:clamp(236px,68vw,330px);scroll-snap-align:start;border:0;padding:0;background:none;cursor:pointer;text-align:left;display:grid;gap:8px;align-content:start}',
    '#phc .phc-thumb{position:relative;display:block;aspect-ratio:16/9;border-radius:6px;overflow:hidden;background:var(--surface);transition:transform .2s ease,box-shadow .2s ease}',
    '#phc .phc-thumb img{display:block;width:100%;height:100%;object-fit:cover}',
    '#phc .phc-card:hover .phc-thumb,#phc .phc-card:focus-visible .phc-thumb{transform:scale(1.04);box-shadow:0 10px 30px rgba(0,0,0,.6),0 0 0 2px var(--accent)}',
    '#phc .phc-card:focus-visible{outline:none}',
    '#phc .phc-cap{display:grid;gap:2px;padding-inline:2px}',
    '#phc .phc-t{font-size:13px;font-weight:600;line-height:1.3;color:var(--fg);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}',
    '#phc .phc-s{font-family:var(--mono);font-size:10.5px;color:var(--muted);font-variant-numeric:tabular-nums}',
    '#phc .phc-tag{position:absolute;top:8px;left:8px;font-family:var(--mono);font-size:9.5px;letter-spacing:.12em;text-transform:uppercase;background:var(--accent);color:var(--accent-ink);padding:2px 6px;border-radius:3px}',
    '#phc .phc-bar{position:absolute;left:0;right:0;bottom:0;height:3px;background:rgba(255,255,255,.18)}',
    '#phc .phc-bar i{display:block;height:100%;background:var(--accent);box-shadow:0 0 8px var(--glow)}',
    '#phc .phc-seen{position:absolute;top:8px;right:8px;width:22px;height:22px;border-radius:50%;background:rgba(0,0,0,.7);display:grid;place-items:center;color:var(--accent)}',
    '#phc .phc-seen svg{width:14px;height:14px}',
    '#phc .phc-soon{flex-shrink:0;width:clamp(236px,68vw,330px);aspect-ratio:16/9;align-self:start;border-radius:6px;border:1px dashed var(--line);background:repeating-linear-gradient(135deg,var(--surface) 0 10px,var(--surface-2) 10px 20px);display:grid;place-items:center;text-align:center;padding:14px}',
    '#phc .phc-soon b{display:block;font-family:var(--display);font-weight:800;font-size:22px;text-transform:uppercase;letter-spacing:.02em}',
    '#phc .phc-soon span{font-size:12px;color:var(--muted)}',
    '#phc .phc-empty{padding-left:var(--gl);padding-right:var(--gr);color:var(--muted);font-size:14px}',
    '#phc .phc-loading{min-height:60vh;display:grid;place-items:center;color:var(--muted);font-family:var(--mono);font-size:12px;letter-spacing:.14em;text-transform:uppercase}',

    /* Fiche */
    '#phc .phc-scrim{position:fixed;inset:0;z-index:40;background:rgba(0,0,0,.75);display:grid;place-items:end center;padding-top:env(safe-area-inset-top,0px)}',
    '@media (min-width:720px){#phc .phc-scrim{place-items:center}}',
    '#phc .phc-sheet{width:min(720px,100%);max-height:92vh;overflow:auto;background:var(--surface);border:1px solid var(--line);border-radius:14px 14px 0 0;padding-bottom:env(safe-area-inset-bottom,0px);animation:phc-rise .28s ease}',
    '@media (min-width:720px){#phc .phc-sheet{border-radius:12px}}',
    '@keyframes phc-rise{from{transform:translateY(24px);opacity:.4}to{transform:none;opacity:1}}',
    '#phc .phc-sheet-art{position:relative;aspect-ratio:16/9;overflow:hidden;background:#000}',
    '#phc .phc-sheet-art img{width:100%;height:100%;object-fit:cover;display:block}',
    '#phc .phc-sheet-art::after{content:"";position:absolute;inset:0;background:linear-gradient(to top,var(--surface),rgba(15,21,23,0) 50%)}',
    '#phc .phc-x{position:absolute;top:12px;right:12px;z-index:3;width:36px;height:36px;border-radius:50%;border:0;background:rgba(0,0,0,.7);cursor:pointer;display:grid;place-items:center}',
    '#phc .phc-sheet-body{display:grid;gap:12px;margin-top:-34px;position:relative;z-index:2;padding-block:0 26px;padding-left:max(20px,env(safe-area-inset-left,0px));padding-right:max(20px,env(safe-area-inset-right,0px))}',
    '#phc .phc-sheet h3{font-family:var(--display);font-weight:800;text-transform:uppercase;font-size:clamp(26px,5vw,38px);line-height:1;color:var(--fg);text-wrap:balance}',
    '#phc .phc-sheet p{color:var(--soft);max-width:60ch}',
    '#phc .phc-tv{display:flex;gap:12px;align-items:flex-start;background:var(--surface-2);border-radius:8px;padding:12px 14px;font-size:13px;color:var(--muted)}',
    '#phc .phc-tv svg{width:22px;height:22px;color:var(--accent)}',
    '#phc .phc-tv b{color:var(--fg);font-weight:600}',
    '#phc .phc-link{font-size:13px;color:var(--muted)}',

    /* Lecteur */
    '#phc .phc-player{position:fixed;inset:0;z-index:60;background:#000;display:grid;grid-template-rows:auto minmax(0,1fr);padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}',
    '#phc .phc-pbar{display:flex;align-items:center;gap:12px;padding-block:12px;padding-left:var(--gl);padding-right:var(--gr)}',
    '#phc .phc-pbar button{background:none;border:0;cursor:pointer;display:flex;align-items:center;gap:8px;font-weight:600;padding:6px 0}',
    '#phc .phc-pbar svg{width:22px;height:22px}',
    '#phc .phc-pt{color:var(--muted);font-size:13px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;min-width:0}',
    '#phc .phc-stage{display:grid;place-items:center;padding-left:var(--gl);padding-right:var(--gr);padding-block:0 16px;min-height:0}',
    '#phc .phc-screen{position:relative;width:min(100%,calc((100vh - 120px) * 16 / 9));aspect-ratio:16/9;background:#000;border-radius:4px;overflow:hidden}',
    '#phc .phc-screen iframe,#phc .phc-screen > div{position:absolute;inset:0;width:100%;height:100%;border:0}',
    '#phc .phc-next{position:absolute;right:16px;bottom:16px;z-index:3;display:flex;gap:12px;align-items:center;background:rgba(6,9,10,.92);border:1px solid var(--line);border-radius:10px;padding:10px;max-width:calc(100% - 32px)}',
    '#phc .phc-next img{width:120px;aspect-ratio:16/9;object-fit:cover;border-radius:4px}',
    '#phc .phc-next div{display:grid;gap:6px;min-width:0}',
    '#phc .phc-next small{font-family:var(--mono);font-size:10.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--accent)}',
    '#phc .phc-next strong{font-size:13px;line-height:1.3;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}',
    '#phc .phc-next .phc-row-btns{display:flex;gap:8px}',
    '#phc .phc-next .phc-btn{padding:7px 12px;font-size:13px}',
    '@media (max-width:560px){#phc .phc-next img{display:none}}',

    /* Écran d'abonnement */
    '#phc.phc-locked{overflow:hidden}',
    '#phc .phc-wall-bg{position:absolute;inset:-40px;display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:14px;padding:20px;filter:blur(10px) brightness(.38) saturate(.8);transform:rotate(-4deg) scale(1.15);pointer-events:none}',
    '#phc .phc-wall-bg img{width:100%;aspect-ratio:16/9;object-fit:cover;border-radius:6px}',
    '#phc .phc-wall{position:relative;z-index:2;min-height:100%;display:grid;place-items:center;padding-block:calc(28px + env(safe-area-inset-top,0px)) calc(28px + env(safe-area-inset-bottom,0px));padding-left:var(--gl);padding-right:var(--gr);background:radial-gradient(ellipse at 50% 30%,rgba(61,255,143,.10),rgba(6,9,10,.35) 65%)}',
    '#phc .phc-pw{width:min(480px,100%);display:grid;gap:16px;justify-items:center;text-align:center}',
    '#phc .phc-pw .phc-logo{width:64px;height:64px;stroke:none;filter:drop-shadow(0 0 14px var(--glow))}',
    '#phc .phc-kicker{font-family:var(--mono);font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:var(--accent)}',
    '#phc .phc-pw h1{font-family:var(--display);font-weight:900;text-transform:uppercase;font-size:clamp(40px,10vw,62px);line-height:.92;color:var(--fg);text-wrap:balance}',
    '#phc .phc-pw p{color:var(--soft);max-width:40ch}',
    '#phc .phc-pw ul{list-style:none;display:grid;gap:8px;text-align:left;width:100%;max-width:340px}',
    '#phc .phc-pw li{display:flex;gap:10px;align-items:flex-start;font-size:14px;color:var(--fg)}',
    '#phc .phc-pw li svg{color:var(--accent);margin-top:2px}',
    '#phc .phc-price{color:var(--muted);font-size:14px;font-variant-numeric:tabular-nums}',
    '#phc .phc-price b{font-family:var(--display);font-size:34px;color:var(--fg);font-weight:800}',
    '#phc .phc-sub{background:var(--accent);color:var(--accent-ink);width:100%;max-width:340px;justify-content:center;padding:15px 20px;font-size:16px;box-shadow:0 0 24px var(--glow)}',
    '#phc .phc-login{font-size:14px;color:var(--muted)}',
    '#phc .phc-login a{color:var(--fg);font-weight:600}',
    '#phc .phc-back{font-size:13px;color:var(--muted)}',
    '@media (prefers-reduced-motion:reduce){#phc *{animation:none!important;transition:none!important}}'
  ].join('\n');
  // Verrou de défilement de la page (seule règle posée dans le document)
  var lock = document.createElement('style');
  lock.textContent = 'html.phc-lock,html.phc-lock body{overflow:hidden!important}';
  document.head.appendChild(lock);

  var ICONS = '<svg width="0" height="0" style="position:absolute" aria-hidden="true">' +
    '<symbol id="phc-logo" viewBox="0 0 48 48"><circle cx="24" cy="24" r="17" fill="none" stroke="#3dff8f" stroke-width="4"/><line x1="24" y1="39" x2="24" y2="29" stroke="#3dff8f" stroke-width="4" stroke-linecap="round"/></symbol>' +
    '<symbol id="phc-play" viewBox="0 0 24 24"><path d="M7 4.5v15a1 1 0 0 0 1.5.86l12.4-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5z"/></symbol>' +
    '<symbol id="phc-plus" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" stroke-width="2.2" stroke-linecap="round"/></symbol>' +
    '<symbol id="phc-check" viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></symbol>' +
    '<symbol id="phc-info" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" stroke-width="2"/><path d="M12 11v6M12 7.5v.01" stroke-width="2.2" stroke-linecap="round"/></symbol>' +
    '<symbol id="phc-x" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" stroke-width="2.2" stroke-linecap="round"/></symbol>' +
    '<symbol id="phc-back" viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></symbol>' +
    '<symbol id="phc-tv" viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="12" rx="2" stroke-width="2"/><path d="M8 21h8" stroke-width="2" stroke-linecap="round"/></symbol>' +
    '</svg>';

  // ---------------------------------------------------------------------------
  // Conteneur plein écran
  // Shadow DOM : le CSS du site (boutons verts, police mono, !important…) ne déteint pas sur le catalogue
  var hostEl = document.createElement('div');
  hostEl.id = 'phc-host';
  hostEl.style.cssText = 'position:fixed;inset:0;z-index:3999990;';
  document.body.appendChild(hostEl);
  var scope = hostEl.attachShadow ? hostEl.attachShadow({ mode: 'open' }) : hostEl;
  var style = document.createElement('style');
  style.textContent = ':host{all:initial}\n' + css;
  scope.appendChild(style);
  var root = document.createElement('div');
  root.id = 'phc';
  root.innerHTML = ICONS + '<div class="phc-loading">Chargement du catalogue…</div>';
  scope.appendChild(root);
  function focused() { return (scope.activeElement !== undefined ? scope.activeElement : document.activeElement) || null; }
  document.documentElement.classList.add('phc-lock');

  // ---------------------------------------------------------------------------
  // Données : Content API Ghost
  function contentApi() {
    var s = document.querySelector('[data-sodo-search][data-key]');
    if (s) return { base: String(s.getAttribute('data-sodo-search') || '').replace(/\/?$/, '/') + 'ghost/api/content/', key: s.getAttribute('data-key') };
    var p = document.querySelector('script[data-key][data-api]');
    if (p) return { base: String(p.getAttribute('data-api')).replace(/\/?$/, '/'), key: p.getAttribute('data-key') };
    return { base: CONTENT_API_FALLBACK, key: '' };
  }
  function attr(tag, name) {
    var m = new RegExp('data-' + name + '="([^"]*)"').exec(tag);
    return m ? m[1] : '';
  }
  function parsePost(p) {
    var html = p.html || '';
    var metaTag = (/<div[^>]*class="ph-video-meta"[^>]*>/.exec(html) || [''])[0];
    var yt = attr(metaTag, 'youtube') || ((/youtube(?:-nocookie)?\.com\/embed\/([A-Za-z0-9_-]{11})/.exec(html) || [])[1]) || '';
    if (!yt) return null;
    var theme = attr(metaTag, 'theme');
    var dur = parseFloat(attr(metaTag, 'duration')) || 0;
    if (dur && dur < 30) dur = dur * 60; // durée donnée en minutes
    return {
      id: yt,
      postId: p.id,
      title: p.title,
      url: p.url,
      img: p.feature_image || ('https://i.ytimg.com/vi/' + yt + '/maxresdefault.jpg'),
      desc: p.custom_excerpt || p.excerpt || '',
      date: p.published_at,
      theme: THEMES[theme] ? theme : 'ia',
      series: SERIES[attr(metaTag, 'series')] ? attr(metaTag, 'series') : '',
      duration: Math.round(dur)
    };
  }
  function loadCatalogue() {
    var api = contentApi();
    if (!api.key) return Promise.reject(new Error('Clé Content API introuvable'));
    var url = api.base + 'posts/?key=' + encodeURIComponent(api.key) +
      '&filter=' + encodeURIComponent(TAG_FILTER) +
      '&fields=id,title,url,feature_image,custom_excerpt,excerpt,published_at,html&order=published_at%20desc&limit=100';
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error('Content API ' + r.status);
      return r.json();
    }).then(function (j) {
      var seen = {};
      return (j.posts || []).map(parsePost).filter(function (v) {
        if (!v || seen[v.id]) return false;
        seen[v.id] = 1;
        return true;
      });
    });
  }
  function loadPrice() {
    var api = contentApi();
    if (!api.key) return Promise.resolve('');
    return fetch(api.base + 'tiers/?key=' + encodeURIComponent(api.key) + '&include=monthly_price')
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var t = (j.tiers || []).filter(function (x) { return x.type === 'paid' && x.monthly_price; })[0];
        if (!t) return '';
        var amount = t.monthly_price / 100;
        var cur = String(t.currency || 'EUR').toUpperCase();
        return (amount % 1 ? amount.toFixed(2).replace('.', ',') : String(amount)) + ' ' + (cur === 'EUR' ? '€' : cur === 'CHF' ? 'CHF' : cur);
      })
      .catch(function () { return ''; });
  }

  // ===========================================================================
  // ÉCRAN D'ABONNEMENT (non-abonnés)
  // ===========================================================================
  if (!isMember) {
    root.classList.add('phc-locked');
    var paint = function (videos, price, memberStatus) {
      var signedIn = memberStatus === 'free';
      var bg = (videos || []).slice(0, 12);
      while (bg.length && bg.length < 12) bg = bg.concat(bg).slice(0, 12);
      root.innerHTML = ICONS +
        (bg.length ? '<div class="phc-wall-bg" aria-hidden="true">' + bg.map(function (v) { return '<img src="' + esc(sized(v.img, 600)) + '" alt="">'; }).join('') + '</div>' : '') +
        '<div class="phc-wall"><div class="phc-pw">' +
        '<svg class="phc-logo" aria-hidden="true"><use href="#phc-logo"></use></svg>' +
        '<div class="phc-kicker">Réservé aux abonnés</div>' +
        '<h1>Le catalogue vidéo Posthumain</h1>' +
        '<p>Tous nos documentaires sur l\'IA, la tech et le futur, rangés par thème. Lecture en plein écran, sur ton téléphone ou ta télé.</p>' +
        '<ul>' +
        '<li>' + svg('check') + 'Un nouveau documentaire de 7 minutes tous les deux jours</li>' +
        '<li>' + svg('check') + 'Reprise là où tu t\'es arrêté, épisode suivant automatique</li>' +
        '<li>' + svg('check') + 'Les enquêtes premium du site incluses</li>' +
        '</ul>' +
        (price ? '<div class="phc-price"><b>' + esc(price) + '</b> / mois · sans engagement</div>' : '') +
        '<a class="phc-btn phc-sub" href="' + (signedIn ? PORTAL_UPGRADE : PORTAL_SIGNUP) + '">' + (signedIn ? 'Passer à l\'abonnement' : 'S\'abonner') + '</a>' +
        (signedIn ? '' : '<div class="phc-login">Déjà abonné ? <a href="' + PORTAL_SIGNIN + '">Se connecter</a></div>') +
        '<a class="phc-back" href="/">Retour au site</a>' +
        '</div></div>';
    };
    paint([], '', '');
    var memberReq = fetch('/members/api/member/', { credentials: 'same-origin' })
      .then(function (r) { return r.status === 200 ? r.json() : null; })
      .then(function (m) { return m && m.status ? m.status : ''; })
      .catch(function () { return ''; });
    Promise.all([loadCatalogue().catch(function () { return []; }), loadPrice(), memberReq]).then(function (a) {
      paint(a[0], a[1], a[2]);
    });
    return;
  }

  // ===========================================================================
  // CATALOGUE (abonnés)
  // ===========================================================================
  var VIDEOS = [];
  var byId = {};
  var filter = 'all';
  var view = 'home';
  var progress = store('phc-progress') || {};
  var myList = store('phc-list') || [];

  function prog(id) { return progress[id] || null; }
  function ratio(id) {
    var p = prog(id);
    return p && p.d ? Math.min(1, p.t / p.d) : 0;
  }
  function isDone(id) { var p = prog(id); return !!(p && (p.done || ratio(id) >= 0.92)); }
  function inProgress(id) { var r = ratio(id); return r > 0.03 && !isDone(id); }
  function inList(id) { return myList.indexOf(id) !== -1; }
  function isNew(v) { return v.date && (Date.now() - new Date(v.date).getTime()) < 3 * 86400000; }

  function shell() {
    root.innerHTML = ICONS +
      '<header class="phc-top" id="phc-top">' +
      '<a class="phc-brand" href="/" aria-label="Posthumain, retour au site"><svg aria-hidden="true"><use href="#phc-logo"></use></svg><span><b>POSTHUMAIN</b><small>Catalogue vidéo</small></span></a>' +
      '<nav class="phc-nav" aria-label="Sections">' +
      '<button type="button" data-nav="home" aria-current="true">Accueil</button>' +
      '<button type="button" data-nav="all">Tous les documentaires</button>' +
      '<button type="button" data-nav="list">Ma liste</button>' +
      '</nav><span class="phc-spacer"></span>' +
      '<a class="phc-site" href="/">Retour au site</a>' +
      '</header>' +
      '<main id="phc-main"><section class="phc-hero" id="phc-hero"></section>' +
      '<div class="phc-chips" id="phc-chips" role="toolbar" aria-label="Thèmes"></div>' +
      '<div class="phc-rows" id="phc-rows"></div></main>' +
      '<div class="phc-scrim" id="phc-scrim" hidden></div>' +
      '<div class="phc-player" id="phc-player" hidden></div>';
    root.addEventListener('scroll', function () {
      var top = $('#phc-top', root);
      if (top) top.classList.toggle('solid', root.scrollTop > 40);
    }, { passive: true });
  }

  function metaLine(v) {
    var bits = [];
    if (v.duration) bits.push('<span class="phc-dur">' + mmss(v.duration) + '</span>');
    bits.push('<span>' + esc(THEMES[v.theme]) + '</span>');
    if (v.series) bits.push('<span>' + esc(SERIES[v.series]) + '</span>');
    bits.push('<span>Sous-titres YouTube</span>');
    return '<div class="phc-meta">' + bits.join('') + '</div>';
  }

  function renderHero() {
    var el = $('#phc-hero', root);
    if (!VIDEOS.length) { el.innerHTML = ''; return; }
    // le plus récent pas encore vu, sinon le plus récent
    var v = VIDEOS.filter(function (x) { return !isDone(x.id); })[0] || VIDEOS[0];
    var resume = inProgress(v.id);
    el.innerHTML =
      '<div class="phc-hero-art"><img src="' + esc(sized(v.img, 1200)) + '" alt="" data-full="' + esc(v.img) + '"></div>' +
      '<div class="phc-hero-copy">' +
      '<div class="phc-eyebrow">' + (isNew(v) ? '<span class="phc-new">Nouveau</span>' : '') + '<span>Documentaire</span></div>' +
      '<h1>' + esc(v.title) + '</h1>' + metaLine(v) +
      (v.desc ? '<p class="phc-desc">' + esc(v.desc) + '</p>' : '') +
      '<div class="phc-actions">' +
      '<button type="button" class="phc-btn phc-play" data-play="' + v.id + '">' + svg('play') + (resume ? 'Reprendre à ' + mmss(prog(v.id).t) : 'Lecture') + '</button>' +
      '<button type="button" class="phc-btn phc-ghost" data-list="' + v.id + '" aria-pressed="' + inList(v.id) + '">' + svg(inList(v.id) ? 'check' : 'plus') + 'Ma liste</button>' +
      '<button type="button" class="phc-btn phc-ghost" data-open="' + v.id + '" aria-label="Infos">' + svg('info') + '<span class="phc-hide-sm">Infos</span></button>' +
      '</div></div>';
  }

  function renderChips() {
    var present = Object.keys(THEMES).filter(function (t) { return VIDEOS.some(function (v) { return v.theme === t; }); });
    var el = $('#phc-chips', root);
    if (present.length < 2) { el.hidden = true; return; }
    el.hidden = false;
    el.innerHTML = ['all'].concat(present).map(function (t) {
      return '<button type="button" class="phc-chip" data-cat="' + t + '" aria-pressed="' + (t === filter) + '">' + (t === 'all' ? 'Tout' : esc(THEMES[t])) + '</button>';
    }).join('');
  }

  function card(v) {
    var r = ratio(v.id);
    var sub = [v.duration ? minutes(v.duration) : '', THEMES[v.theme]].filter(Boolean).join(' · ');
    return '<button type="button" class="phc-card" data-open="' + v.id + '" aria-label="' + esc(v.title) + '">' +
      '<span class="phc-thumb"><img src="' + esc(sized(v.img, 600)) + '" alt="" loading="lazy" data-full="' + esc(v.img) + '">' +
      (isNew(v) ? '<span class="phc-tag">Nouveau</span>' : '') +
      (isDone(v.id) ? '<span class="phc-seen" title="Déjà vu">' + svg('check') + '</span>' : '') +
      (r > 0.03 && !isDone(v.id) ? '<span class="phc-bar"><i style="width:' + Math.round(r * 100) + '%"></i></span>' : '') +
      '</span><span class="phc-cap"><span class="phc-t">' + esc(v.title) + '</span><span class="phc-s">' + esc(sub) + '</span></span></button>';
  }
  var SOON = '<div class="phc-soon" aria-hidden="true"><div><b>Prochain doc</b><span>Un nouveau documentaire tous les deux jours</span></div></div>';

  function row(title, items, note, extra) {
    if (!items.length && !extra) return '';
    return '<section class="phc-row"><h2>' + esc(title) + (note ? '<span>' + esc(note) + '</span>' : '') + '</h2>' +
      '<div class="phc-track">' + items.map(card).join('') + (extra || '') + '</div></section>';
  }

  function renderRows() {
    var el = $('#phc-rows', root);
    if (!VIDEOS.length) {
      el.innerHTML = '<p class="phc-empty">Le premier documentaire arrive très vite. Reviens dans quelques jours.</p>';
      return;
    }
    var pool = VIDEOS.filter(function (v) { return filter === 'all' || v.theme === filter; });
    var html = '';
    if (view === 'list') {
      var mine = VIDEOS.filter(function (v) { return inList(v.id); });
      html = mine.length ? row('Ma liste', mine) : '<p class="phc-empty">Ta liste est vide. Touche « Ma liste » sur un documentaire pour le retrouver ici.</p>';
    } else if (view === 'all') {
      html = row('Tous les documentaires', pool, pool.length + (pool.length > 1 ? ' vidéos' : ' vidéo'));
    } else if (filter !== 'all') {
      html = row(THEMES[filter], pool, pool.length + (pool.length > 1 ? ' vidéos' : ' vidéo'));
    } else {
      html += row('Reprendre', VIDEOS.filter(function (v) { return inProgress(v.id); }));
      html += row('Nouveautés', VIDEOS.slice(0, 12), '7 minutes pour comprendre', SOON);
      if (VIDEOS.length >= THEME_ROWS_FROM) {
        Object.keys(THEMES).forEach(function (t) {
          var items = VIDEOS.filter(function (v) { return v.theme === t; });
          if (items.length >= 2) html += row(THEMES[t], items);
        });
      }
      if (VIDEOS.length >= SERIES_ROWS_FROM) {
        Object.keys(SERIES).forEach(function (s) {
          var items = VIDEOS.filter(function (v) { return v.series === s; });
          if (items.length >= 2) html += row(SERIES[s], items);
        });
      }
      var unseen = VIDEOS.filter(function (v) { return !isDone(v.id) && !inProgress(v.id); });
      if (VIDEOS.length >= THEME_ROWS_FROM && unseen.length) html += row('Pas encore vus', unseen);
    }
    el.innerHTML = html;
  }

  function renderAll() { renderHero(); renderChips(); renderRows(); }

  // Images redimensionnées absentes → image d'origine
  root.addEventListener('error', function (e) {
    var img = e.target;
    if (img && img.tagName === 'IMG' && img.dataset.full && img.src !== img.dataset.full) img.src = img.dataset.full;
  }, true);

  // ---------------------------------------------------------------------------
  // Fiche détail
  var layers = []; // pile des calques ouverts (fiche, lecteur) pour le bouton retour
  function pushLayer(name) {
    // on ne compte un calque que si l'historique l'a bien enregistré (sinon « retour » quitterait la page)
    try { history.pushState({ phc: name }, ''); layers.push(name); } catch (e) {}
  }
  function openSheet(id) {
    var v = byId[id];
    if (!v) return;
    var more = VIDEOS.filter(function (o) { return o.id !== v.id && o.theme === v.theme; }).slice(0, 8);
    if (more.length < 3) more = more.concat(VIDEOS.filter(function (o) { return o.id !== v.id && more.indexOf(o) === -1; })).slice(0, 8);
    var resume = inProgress(v.id);
    var sc = $('#phc-scrim', root);
    sc.innerHTML = '<div class="phc-sheet" role="dialog" aria-modal="true" aria-label="' + esc(v.title) + '">' +
      '<div class="phc-sheet-art"><img src="' + esc(sized(v.img, 1200)) + '" alt="" data-full="' + esc(v.img) + '">' +
      '<button type="button" class="phc-x" data-close aria-label="Fermer">' + svg('x') + '</button></div>' +
      '<div class="phc-sheet-body"><h3>' + esc(v.title) + '</h3>' + metaLine(v) +
      (v.desc ? '<p>' + esc(v.desc) + '</p>' : '') +
      '<div class="phc-actions">' +
      '<button type="button" class="phc-btn phc-play" data-play="' + v.id + '">' + svg('play') + (resume ? 'Reprendre à ' + mmss(prog(v.id).t) : 'Lecture') + '</button>' +
      '<button type="button" class="phc-btn phc-ghost" data-list="' + v.id + '" aria-pressed="' + inList(v.id) + '">' + svg(inList(v.id) ? 'check' : 'plus') + 'Ma liste</button>' +
      '</div>' +
      '<div class="phc-tv">' + svg('tv') + '<div><b>Sur ta télé.</b> Lance la lecture sur ton téléphone, puis touche l\'icône Cast ou AirPlay du lecteur.</div></div>' +
      (v.url ? '<a class="phc-link" href="' + esc(v.url) + '">Chapitres et sources de ce documentaire</a>' : '') +
      '</div>' +
      (more.length ? '<div class="phc-row" style="padding-bottom:22px"><h2>À voir aussi</h2><div class="phc-track">' + more.map(card).join('') + '</div></div>' : '') +
      '</div>';
    if (sc.hidden) pushLayer('sheet');
    sc.hidden = false;
    var b = $('.phc-play', sc);
    if (b) b.focus({ preventScroll: true });
  }
  function closeSheet() {
    var sc = $('#phc-scrim', root);
    if (!sc || sc.hidden) return;
    sc.hidden = true;
    sc.innerHTML = '';
  }

  // ---------------------------------------------------------------------------
  // Lecteur YouTube (IFrame API) : reprise + épisode suivant
  var ytReady = null;
  var player = null;
  var ticker = null;
  var current = null;
  var nextTimer = null;
  function loadYT() {
    if (ytReady) return ytReady;
    ytReady = new Promise(function (resolve) {
      if (window.YT && window.YT.Player) return resolve();
      var prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = function () { if (typeof prev === 'function') prev(); resolve(); };
      var s = document.createElement('script');
      s.src = 'https://www.youtube.com/iframe_api';
      document.head.appendChild(s);
    });
    return ytReady;
  }
  function saveProgress(done) {
    if (!player || !current || typeof player.getCurrentTime !== 'function') return;
    var t = player.getCurrentTime() || 0;
    var d = player.getDuration() || (current.duration || 0);
    if (!d) return;
    progress[current.id] = { t: done ? d : Math.floor(t), d: Math.round(d), done: !!done || t / d >= 0.92, at: Date.now() };
    store('phc-progress', progress);
  }
  function nextAfter(v) {
    var i = VIDEOS.indexOf(v);
    var order = VIDEOS.slice(i + 1).concat(VIDEOS.slice(0, i));
    return order.filter(function (x) { return !isDone(x.id); })[0] || null;
  }
  function showNext(v) {
    var nx = nextAfter(v);
    var screen = $('.phc-screen', root);
    if (!nx || !screen) return;
    var n = 8;
    var box = document.createElement('div');
    box.className = 'phc-next';
    box.innerHTML = '<img src="' + esc(sized(nx.img, 600)) + '" alt="" data-full="' + esc(nx.img) + '"><div><small>À suivre dans <span>' + n + '</span> s</small><strong>' + esc(nx.title) + '</strong>' +
      '<div class="phc-row-btns"><button type="button" class="phc-btn phc-play" data-play="' + nx.id + '">' + svg('play') + 'Lecture</button>' +
      '<button type="button" class="phc-btn phc-ghost" data-cancel-next>Annuler</button></div></div>';
    screen.appendChild(box);
    var span = box.querySelector('small span');
    nextTimer = setInterval(function () {
      n -= 1;
      if (span) span.textContent = n;
      if (n <= 0) { clearInterval(nextTimer); nextTimer = null; play(nx.id, true); }
    }, 1000);
  }
  function cancelNext() {
    if (nextTimer) { clearInterval(nextTimer); nextTimer = null; }
    var b = $('.phc-next', root);
    if (b) b.remove();
  }
  function play(id, replace) {
    var v = byId[id];
    if (!v) return;
    cancelNext();
    if (player) saveProgress(false);
    stopPlayer(true);
    closeSheet();
    current = v;
    var start = inProgress(v.id) ? Math.max(0, prog(v.id).t - 3) : 0;
    var pl = $('#phc-player', root);
    pl.innerHTML = '<div class="phc-pbar"><button type="button" data-stop>' + svg('back') + 'Retour</button><span class="phc-pt">' + esc(v.title) + '</span></div>' +
      '<div class="phc-stage"><div class="phc-screen"><div class="phc-yt"></div></div></div>';
    if (pl.hidden && !replace) pushLayer('player');
    pl.hidden = false;
    var back = $('[data-stop]', pl);
    if (back) back.focus({ preventScroll: true });
    loadYT().then(function () {
      if (current !== v) return;
      var slot = $('.phc-yt', pl);
      if (!slot) return;
      player = new window.YT.Player(slot, {
        host: 'https://www.youtube-nocookie.com',
        videoId: v.id,
        playerVars: { autoplay: 1, rel: 0, playsinline: 1, modestbranding: 1, start: Math.floor(start), origin: location.origin },
        events: {
          onReady: function (e) { try { e.target.playVideo(); } catch (err) {} },
          onStateChange: function (e) {
            if (e.data === 1) { // lecture
              if (!ticker) ticker = setInterval(function () { saveProgress(false); }, 5000);
            } else {
              if (ticker) { clearInterval(ticker); ticker = null; }
              if (e.data === 2) saveProgress(false); // pause
              if (e.data === 0) { saveProgress(true); showNext(v); } // fin
            }
          }
        }
      });
    });
  }
  function stopPlayer(keepOpen) {
    if (ticker) { clearInterval(ticker); ticker = null; }
    cancelNext();
    if (player) {
      saveProgress(false);
      try { player.destroy(); } catch (e) {}
      player = null;
    }
    if (!keepOpen) {
      var pl = $('#phc-player', root);
      if (pl) { pl.hidden = true; pl.innerHTML = ''; }
      current = null;
      renderAll(); // met à jour « Reprendre », barres de progression, hero
    }
  }

  // Bouton retour du téléphone / navigateur : ferme d'abord le calque ouvert
  window.addEventListener('popstate', function () {
    var top = layers.pop();
    if (top === 'player') stopPlayer(false);
    else if (top === 'sheet') closeSheet();
  });
  function closeTop() {
    if (layers.length) { history.back(); return; }
    if (!$('#phc-player', root).hidden) stopPlayer(false);
    else closeSheet();
  }

  // ---------------------------------------------------------------------------
  // Événements
  root.addEventListener('click', function (e) {
    var t = e.target.closest('[data-play],[data-open],[data-list],[data-cat],[data-close],[data-stop],[data-nav],[data-cancel-next]');
    if (!t) {
      if (e.target.id === 'phc-scrim') closeTop();
      return;
    }
    if (t.hasAttribute('data-play')) {
      var pid = t.getAttribute('data-play');
      if (!$('#phc-scrim', root).hidden) {
        // la fiche est ouverte : on remplace son calque par le lecteur
        closeSheet();
        if (layers[layers.length - 1] === 'sheet') layers[layers.length - 1] = 'player';
        play(pid, true);
      } else {
        play(pid, !$('#phc-player', root).hidden);
      }
    } else if (t.hasAttribute('data-open')) {
      openSheet(t.getAttribute('data-open'));
    } else if (t.hasAttribute('data-list')) {
      var id = t.getAttribute('data-list');
      if (inList(id)) myList = myList.filter(function (x) { return x !== id; });
      else myList.push(id);
      store('phc-list', myList);
      var on = inList(id);
      root.querySelectorAll('[data-list="' + id + '"]').forEach(function (b) {
        b.setAttribute('aria-pressed', String(on));
        var u = b.querySelector('use');
        if (u) u.setAttribute('href', on ? '#phc-check' : '#phc-plus');
      });
      if (view === 'list') renderRows();
    } else if (t.hasAttribute('data-cat')) {
      filter = t.getAttribute('data-cat');
      view = 'home';
      setNav('home');
      renderChips();
      renderRows();
    } else if (t.hasAttribute('data-nav')) {
      view = t.getAttribute('data-nav');
      filter = 'all';
      setNav(view);
      renderChips();
      renderRows();
      var chips = $('#phc-chips', root);
      var target = chips && !chips.hidden ? chips : $('#phc-rows', root);
      if (view !== 'home' && target) root.scrollTo({ top: target.offsetTop - 70, behavior: 'smooth' });
    } else if (t.hasAttribute('data-close') || t.hasAttribute('data-stop')) {
      closeTop();
    } else if (t.hasAttribute('data-cancel-next')) {
      cancelNext();
    }
  });
  function setNav(v) {
    root.querySelectorAll('[data-nav]').forEach(function (b) { b.setAttribute('aria-current', String(b.getAttribute('data-nav') === v)); });
  }

  // Télécommande / clavier : flèches entre les cartes et les rangées, Échap pour fermer
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' || (e.key === 'Backspace' && !/INPUT|TEXTAREA/.test((focused() || {}).tagName || ''))) {
      if (!$('#phc-player', root).hidden || !$('#phc-scrim', root).hidden) { e.preventDefault(); closeTop(); }
      return;
    }
    var c = focused();
    if (!c || !c.classList || !c.classList.contains('phc-card')) return;
    var track = c.parentElement;
    var cards = Array.prototype.slice.call(track.querySelectorAll('.phc-card'));
    var i = cards.indexOf(c);
    var go = function (el) { if (el) { el.focus(); el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); e.preventDefault(); } };
    if (e.key === 'ArrowRight') go(cards[i + 1]);
    if (e.key === 'ArrowLeft') go(cards[i - 1]);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      var scope = c.closest('.phc-sheet') || $('#phc-rows', root);
      var tracks = Array.prototype.slice.call(scope.querySelectorAll('.phc-track'));
      var nt = tracks[tracks.indexOf(track) + (e.key === 'ArrowDown' ? 1 : -1)];
      if (nt) {
        var nc = nt.querySelectorAll('.phc-card');
        if (nc.length) { var el = nc[Math.min(i, nc.length - 1)]; el.focus(); el.scrollIntoView({ block: 'center', inline: 'nearest' }); e.preventDefault(); }
      }
    }
  });
  window.addEventListener('pagehide', function () { saveProgress(false); });

  // ---------------------------------------------------------------------------
  // Démarrage
  loadCatalogue().then(function (videos) {
    VIDEOS = videos;
    VIDEOS.forEach(function (v) { byId[v.id] = v; });
    shell();
    renderAll();
  }).catch(function (err) {
    root.innerHTML = ICONS + '<div class="phc-loading">Le catalogue n\'a pas pu se charger. Recharge la page dans un instant.</div>';
    if (window.console) console.warn('[catalogue-videos]', err);
  });
});
