/* =============================================================================
 * POSTHUMAIN — posthumain-tv.js
 * Posthumain TV (posthumain.com/tv/) : le catalogue des documentaires, à la Netflix.
 * -----------------------------------------------------------------------------
 * MISE EN PLACE (une seule fois, dans Ghost) :
 *   - Page Ghost « Posthumain TV », slug « tv », accès « Abonnés payants »
 *     (Ghost y inclut les membres complimentary).
 *   - Contenu de la page = une carte HTML :  <div id="ph-catalogue"></div>
 *     Ghost ne livre cette carte qu'aux abonnés payants : c'est elle qui ouvre la porte.
 *   - Code injection DE LA PAGE (Page settings → Code injection → Page footer) :
 *     <script src="https://cdn.jsdelivr.net/gh/trustmedias/posthumain-ghost-assets@<COMMIT>/posthumain-tv.js" defer></script>
 *     Version FIGÉE par hash de commit (le cache jsDelivr de @main peut servir l'ancienne version des heures) :
 *     après chaque modification de ce fichier, mettre le nouveau hash dans le Code injection de la page /tv.
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
 *     mémorisés sur l'appareil (localStorage), comme « Ma liste », ET synchronisés entre appareils via la
 *     fonction Supabase tv-state (projet PosthumanOS jfmzhndapfmvdhphuwfm, table tv_member_state), authentifiée
 *     par le jeton d'identité Ghost (/members/api/session). Si la synchro échoue, tout reste local.
 *   - ÉTIQUETTES : « VIDÉO YT » (YT en rouge) sur les vidéos YouTube, « POSTHUMAIN TV » sur les exclusivités.
 *   - EXCLUSIVITÉS POSTHUMAIN TV (Bunny Stream) : l'usine appelle la fonction Supabase tv-video (action create),
 *     qui envoie le MP4 chez Bunny et crée la page Ghost réservée aux abonnés, avec la fiche :
 *       <div class="ph-video-meta" data-source="bunny" data-bunny="ID_BIBLIOTHEQUE/GUID_VIDEO" data-exclusive="1"
 *            data-until="AAAA-MM-JJ" data-theme="ia" data-series="comment" data-duration="780" hidden></div>
 *     placée AVANT le séparateur abonnés (la Content API ne livre que la partie publique d'une page payante).
 *     Lecture : lien d'embed signé demandé à la fonction tv-play (abonné payant/complimentary vérifié côté serveur),
 *     puis lecteur Bunny + player.js (reprise, épisode suivant). Après 3 mois, tv-video (promote) bascule la page
 *     sur YouTube ; sa fiche porte data-was="bn-GUID" et la progression / « Ma liste » suivent l'ancien identifiant.
 *   - Lien direct vers un documentaire : /tv/?v=<id> (id YouTube, ou bn-<GUID> pour une exclusivité).
 *     Doc complet : projet Claude « Posthumain TV — Bunny Stream : mise en service ».
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
  // Lecteur Bunny Stream : bibliothèque player.js documentée par Bunny (événements, reprise)
  var SYNC_URL = 'https://jfmzhndapfmvdhphuwfm.supabase.co/functions/v1/tv-state';
  var PLAY_URL = 'https://jfmzhndapfmvdhphuwfm.supabase.co/functions/v1/tv-play'; // lien Bunny signé (abonnés)
  var BUNNY_PLAYERJS = 'https://assets.mediadelivery.net/playerjs/player-0.1.0.min.js';
  // Réglages modifiables depuis le menu Admin (injectés dans la page /tv : window.PH_TV_CONFIG)
  var CFG = window.PH_TV_CONFIG || {};
  var THEME_ROWS_FROM = +CFG.theme_rows_from || 6;   // rangées par thème seulement à partir de N vidéos (sinon doublons)
  var SERIES_ROWS_FROM = +CFG.series_rows_from || 10; // rangées par série à partir de N vidéos
  var HERO_PIN = String(CFG.hero_pin || '');          // vidéo forcée en grand format (sinon automatique)
  var SOON_TITLE = String(CFG.soon_title || 'Prochain doc');
  var SOON_TEXT = String(CFG.soon_text || 'Un nouveau documentaire tous les deux jours');
  var ADMIN_URL = 'https://jfmzhndapfmvdhphuwfm.supabase.co/functions/v1/tv-admin';
  var ADMIN_EMAILS = ['jonathan.paiano@outlook.com']; // affichage du menu seulement : le serveur revérifie
  var GHOST_ADMIN = 'https://the-last-journal.ghost.io/ghost/#/editor/post/';

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
  // Étiquette de source : « POSTHUMAIN TV » (exclusivité hébergée chez nous) ou « VIDÉO YT » (YouTube)
  function srcBadge(v) {
    return v.source === 'bunny'
      ? '<span class="phc-src phc-src-tv" title="Exclusivité Posthumain TV"><svg aria-hidden="true"><use href="#phc-logo"></use></svg>Posthumain <b>TV</b></span>'
      : '<span class="phc-src phc-src-yt" title="Vidéo publiée sur YouTube">Vidéo <i>YT</i></span>';
  }
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
    '#phc .phc-brand small{display:block;font-size:11px;font-weight:700;letter-spacing:.3em;text-transform:uppercase;color:var(--accent);line-height:1.4}',
    '#phc .phc-nav{display:flex;gap:18px;font-size:14px;color:var(--muted)}',
    '#phc .phc-nav button{background:none;border:0;padding:4px 0;cursor:pointer}',
    '#phc .phc-nav button[aria-current="true"]{color:var(--fg);font-weight:600}',
    '#phc .phc-nav button:hover{color:var(--fg)}',
    '#phc .phc-spacer{flex:1}',
    '#phc .phc-site{font-size:13px;color:var(--muted);text-decoration:none;white-space:nowrap}',
    '#phc .phc-site:hover{color:var(--fg)}',
    '@media (max-width:720px){#phc .phc-nav{display:none}}',
    /* Barre d'onglets en bas (mobile) : Accueil / Tous / Ma liste */
    '#phc .phc-tabs{display:none}',
    '@media (max-width:720px){#phc .phc-tabs{position:fixed;left:0;right:0;bottom:0;z-index:30;display:grid;grid-template-columns:repeat(3,1fr);padding-bottom:env(safe-area-inset-bottom,0px);padding-left:env(safe-area-inset-left,0px);padding-right:env(safe-area-inset-right,0px);background:rgba(6,9,10,.97);border-top:1px solid var(--line);backdrop-filter:blur(10px)}',
    '#phc .phc-tabs button{background:none;border:0;padding:9px 4px 8px;display:grid;justify-items:center;gap:3px;font-size:11px;font-weight:600;color:var(--muted);cursor:pointer}',
    '#phc .phc-tabs svg{width:22px;height:22px}',
    '#phc .phc-tabs button[aria-current="true"]{color:var(--accent)}',
    '#phc .phc-rows{padding-bottom:calc(96px + env(safe-area-inset-bottom,0px))}',
    '#phc .phc-site{display:none}}',

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
    '#phc .phc-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,260px),1fr));gap:20px 12px;padding-left:var(--gl);padding-right:var(--gr);padding-top:6px}',
    '#phc .phc-grid .phc-card{width:auto}',
    '#phc .phc-row h2{margin:0 0 10px;font-family:var(--body);font-size:17px;font-weight:600;color:var(--fg);display:flex;flex-wrap:wrap;align-items:baseline;gap:2px 10px;padding-left:var(--gl);padding-right:var(--gr)}',
    '#phc .phc-row h2 span{font-size:12px;font-weight:400;color:var(--muted)}',
    '#phc .phc-track{display:flex;gap:12px;overflow-x:auto;scroll-snap-type:x mandatory;scroll-padding-left:var(--gl);scrollbar-width:none;padding-left:var(--gl);padding-right:var(--gr);padding-block:6px 10px}',
    '#phc .phc-track::-webkit-scrollbar{display:none}',
    '#phc .phc-card{position:relative;flex-shrink:0;width:clamp(236px,68vw,330px);scroll-snap-align:start;border:0;padding:0;background:none;cursor:pointer;text-align:left;display:grid;gap:8px;align-content:start}',
    '#phc .phc-thumb{position:relative;display:block;aspect-ratio:16/9;border-radius:6px;overflow:hidden;background:var(--surface);transition:transform .2s ease,box-shadow .2s ease}',
    '#phc .phc-thumb img{display:block;width:100%;height:100%;object-fit:cover}',
    '#phc .phc-card:hover .phc-thumb,#phc .phc-card:focus-visible .phc-thumb{transform:scale(1.04);box-shadow:0 10px 30px rgba(0,0,0,.6),0 0 0 2px var(--accent)}',
    '#phc .phc-card:focus-visible{outline:none}',
    '#phc a.phc-card{text-decoration:none;color:inherit}',
    '#phc .phc-cap{display:grid;gap:2px;padding-inline:2px}',
    '#phc .phc-t{font-size:13px;font-weight:600;line-height:1.3;color:var(--fg);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}',
    '#phc .phc-s{font-family:var(--mono);font-size:10.5px;color:var(--muted);font-variant-numeric:tabular-nums}',
    '#phc .phc-badges{position:absolute;top:8px;left:8px;right:36px;display:flex;flex-wrap:wrap;gap:5px;align-items:center;pointer-events:none}',
    '#phc .phc-tag{font-family:var(--mono);font-size:9.5px;line-height:1.5;letter-spacing:.12em;text-transform:uppercase;background:var(--accent);color:var(--accent-ink);padding:2px 6px;border-radius:3px}',
    /* Étiquettes de source : VIDÉO YT (YouTube) / POSTHUMAIN TV (exclusivités Bunny) */
    '#phc .phc-src{display:inline-flex;align-items:center;gap:5px;font-family:var(--mono);font-size:9.5px;font-weight:500;line-height:1.5;letter-spacing:.12em;text-transform:uppercase;white-space:nowrap;padding:2px 6px;border-radius:3px;background:rgba(6,9,10,.84);color:#fff;-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px)}',
    '#phc .phc-src-yt i{font-style:normal;font-family:var(--body);font-weight:800;font-size:10px;letter-spacing:.02em;line-height:1.3;background:#ff0033;color:#fff;border-radius:3px;padding:0 4px}',
    '#phc .phc-src-tv{border:1px solid var(--accent);box-shadow:0 0 12px var(--glow);padding:1px 6px}',
    '#phc .phc-src-tv svg{width:11px;height:11px;stroke:none}',
    '#phc .phc-src-tv b{color:var(--accent);font-weight:500}',
    '#phc .phc-eyebrow .phc-src,#phc .phc-sheet-body .phc-src{font-size:11px}',
    '#phc .phc-sheet-body .phc-src-yt i{font-size:11.5px}',
    '#phc .phc-msg{position:absolute;inset:0;display:grid;place-content:center;justify-items:center;gap:10px;padding:20px;text-align:center;color:var(--soft);font-size:14px}',
    '#phc .phc-msg b{color:var(--fg);font-size:16px}',
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
    '#phc .phc-player{position:fixed;inset:0;z-index:60;background:#000;display:flex;flex-direction:column;width:100%;max-width:100vw;overflow:hidden;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}',
    '#phc .phc-pbar{flex:0 0 auto;display:flex;align-items:center;gap:12px;min-width:0;width:100%;padding-block:12px;padding-left:var(--gl);padding-right:var(--gr)}',
    '#phc .phc-pbar button{background:none;border:0;cursor:pointer;display:flex;align-items:center;gap:8px;font-weight:600;padding:6px 0}',
    '#phc .phc-pbar svg{width:22px;height:22px}',
    '#phc .phc-pt{color:var(--muted);font-size:13px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;min-width:0}',
    '#phc .phc-stage{flex:1 1 auto;display:flex;align-items:center;justify-content:center;min-width:0;width:100%;padding-left:var(--gl);padding-right:var(--gr);padding-block:0 16px;min-height:0}',
    '#phc .phc-screen{position:relative;flex:0 1 auto;width:100%;max-width:calc((100vh - 120px) * 16 / 9);aspect-ratio:16/9;background:#000;border-radius:4px;overflow:hidden}',
    '@supports (height:100dvh){#phc .phc-screen{max-width:calc((100dvh - 120px) * 16 / 9)}}',
    '@media (max-width:720px){#phc .phc-stage{padding-left:0;padding-right:0}#phc .phc-screen{border-radius:0}}',
    /* lecteur ou fiche ouverts : le catalogue derrière ne défile plus */
    '#phc.phc-noscroll{overflow:hidden;touch-action:none}',
    '#phc .phc-player,#phc .phc-scrim,#phc .phc-sheet{overscroll-behavior:contain;touch-action:auto}',
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

    /* Page d'accueil /tv/home */
    '#phc .phl-hero{position:relative;min-height:min(92vh,760px);display:grid;grid-template-columns:minmax(0,1fr);align-items:end;overflow:hidden;padding-block:calc(110px + env(safe-area-inset-top,0px)) 56px;padding-left:var(--gl);padding-right:var(--gr)}',
    '#phc .phl-mosaic{position:absolute;inset:-60px -40px;display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px;transform:rotate(-6deg) scale(1.12);filter:saturate(.85) brightness(.5);animation:phl-pan 60s linear infinite alternate;pointer-events:none}',
    '#phc .phl-mosaic img{width:100%;aspect-ratio:16/9;object-fit:cover;border-radius:6px}',
    '@keyframes phl-pan{from{transform:rotate(-6deg) scale(1.12) translateY(0)}to{transform:rotate(-6deg) scale(1.12) translateY(-12%)}}',
    '#phc .phl-hero::after{content:"";position:absolute;inset:0;background:linear-gradient(to top,var(--bg) 8%,rgba(6,9,10,.82) 45%,rgba(6,9,10,.35)),radial-gradient(ellipse at 20% 80%,rgba(61,255,143,.16),transparent 60%)}',
    '#phc .phl-copy{position:relative;z-index:2;display:grid;gap:18px;max-width:760px;min-width:0}',
    '#phc .phl-copy .phc-eyebrow{flex-wrap:wrap;row-gap:6px}',
    '#phc .phl-copy h1{font-family:var(--display);font-weight:900;text-transform:uppercase;font-size:clamp(36px,10vw,104px);line-height:.9;color:var(--fg);text-wrap:balance;hyphens:none}',
    '#phc .phl-copy h1 em{font-style:normal;color:var(--accent);text-shadow:0 0 30px var(--glow)}',
    '#phc .phl-lead{font-size:clamp(16px,2.2vw,19px);color:var(--soft);max-width:56ch}',
    '#phc .phl-ctas{display:flex;flex-wrap:wrap;gap:10px;align-items:center}',
    '#phc .phl-ctas .phc-sub{width:auto;max-width:none}',
    '#phc .phl-small{font-size:13px;color:var(--muted)}',
    '#phc .phl-small a{color:var(--fg);font-weight:600}',
    '#phc .phl-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:1px;background:var(--line);border-block:1px solid var(--line)}',
    '#phc .phl-stats div{background:var(--bg);padding:18px var(--gr) 18px var(--gl);display:grid;gap:2px}',
    '#phc .phl-stats b{font-family:var(--display);font-weight:800;font-size:clamp(28px,5vw,40px);line-height:1;color:var(--fg)}',
    '#phc .phl-stats span{font-size:12.5px;color:var(--muted)}',
    '#phc .phl-sec{padding-block:44px 0}',
    '#phc .phl-sec > h2,#phc .phl-h{font-family:var(--display);font-weight:800;text-transform:uppercase;font-size:clamp(26px,4.4vw,40px);line-height:1;color:var(--fg);padding-left:var(--gl);padding-right:var(--gr);margin-bottom:6px}',
    '#phc .phl-sub{color:var(--muted);font-size:14px;padding-left:var(--gl);padding-right:var(--gr);margin-bottom:14px}',
    '#phc .phl-rank{position:relative;display:flex;align-items:flex-start;flex-shrink:0;scroll-snap-align:start;gap:0;cursor:pointer;border:0;background:none;padding:0;text-align:left}',
    '#phc .phl-rank > b{font-family:var(--display);font-weight:900;font-size:clamp(92px,30vw,150px);line-height:.82;color:var(--bg);-webkit-text-stroke:2px var(--accent);margin-right:-12px;position:relative;z-index:1;letter-spacing:-.04em;min-width:.5em}',
    '#phc .phl-rank .phc-card{width:clamp(200px,56vw,280px)}',
    '#phc .phl-feats{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,230px),1fr));gap:12px;padding-left:var(--gl);padding-right:var(--gr)}',
    '#phc .phl-feat{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:18px;display:grid;gap:8px;align-content:start}',
    '#phc .phl-feat svg{width:26px;height:26px;color:var(--accent)}',
    '#phc .phl-feat b{color:var(--fg);font-size:16px}',
    '#phc .phl-feat p{color:var(--muted);font-size:14px}',
    '#phc .phl-themes{display:flex;flex-wrap:wrap;gap:8px;padding-left:var(--gl);padding-right:var(--gr)}',
    '#phc .phl-themes a{display:inline-flex;gap:8px;align-items:center;border:1px solid var(--line);border-radius:999px;padding:8px 14px;font-size:14px;color:var(--soft);text-decoration:none}',
    '#phc .phl-themes a span{font-family:var(--mono);font-size:11px;color:var(--accent)}',
    '#phc .phl-faq{display:grid;gap:8px;padding-left:var(--gl);padding-right:var(--gr);max-width:860px}',
    '#phc .phl-faq details{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:0 16px}',
    '#phc .phl-faq summary{cursor:pointer;list-style:none;display:flex;justify-content:space-between;gap:12px;align-items:center;padding:15px 0;font-weight:600;color:var(--fg)}',
    '#phc .phl-faq summary::-webkit-details-marker{display:none}',
    '#phc .phl-faq details[open] summary svg{transform:rotate(180deg)}',
    '#phc .phl-faq p{color:var(--soft);padding-bottom:16px;font-size:14.5px}',
    '#phc .phl-final{margin:56px var(--gr) 0 var(--gl);border-radius:16px;padding:36px clamp(20px,5vw,48px);background:radial-gradient(ellipse at 15% 20%,rgba(61,255,143,.18),transparent 55%),var(--surface);border:1px solid var(--line);display:grid;gap:14px;justify-items:start}',
    '#phc .phl-final h2{font-family:var(--display);font-weight:900;text-transform:uppercase;font-size:clamp(30px,6vw,56px);line-height:.92;color:var(--fg)}',
    '#phc .phl-foot{padding:40px var(--gr) calc(40px + env(safe-area-inset-bottom,0px)) var(--gl);color:var(--muted);font-size:13px;display:flex;flex-wrap:wrap;gap:14px}',
    '#phc .phl-foot a{color:var(--soft)}',

    /* Menu Admin */
    '#phc .phc-adm-btn{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--accent);background:rgba(61,255,143,.08);color:var(--accent);border-radius:999px;padding:6px 12px;font-size:12px;font-weight:700;cursor:pointer;letter-spacing:.04em}',
    '#phc .phc-adm-btn svg{width:15px;height:15px}',
    '#phc .phc-adm{position:fixed;inset:0;z-index:70;background:var(--bg);display:flex;flex-direction:column;overscroll-behavior:contain}',
    '#phc .phc-adm-top{display:flex;align-items:center;gap:12px;padding:calc(10px + env(safe-area-inset-top,0px)) var(--gr) 10px var(--gl);border-bottom:1px solid var(--line)}',
    '#phc .phc-adm-top b{font-family:var(--mono);font-size:12px;letter-spacing:.2em;color:var(--accent)}',
    '#phc .phc-adm-top button{margin-left:auto;background:none;border:0;cursor:pointer;color:var(--fg);display:flex}',
    '#phc .phc-adm-tabs{display:flex;gap:6px;overflow-x:auto;scrollbar-width:none;padding:10px var(--gr) 10px var(--gl);border-bottom:1px solid var(--line)}',
    '#phc .phc-adm-tabs::-webkit-scrollbar{display:none}',
    '#phc .phc-adm-tabs button{flex-shrink:0;border:1px solid var(--line);background:none;border-radius:999px;padding:7px 13px;font-size:13px;color:var(--muted);cursor:pointer}',
    '#phc .phc-adm-tabs button[aria-current="true"]{background:var(--fg);color:var(--bg);border-color:var(--fg)}',
    '#phc .phc-adm-body{flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:18px var(--gr) calc(40px + env(safe-area-inset-bottom,0px)) var(--gl);display:grid;gap:14px;align-content:start}',
    '#phc .phc-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}',
    '#phc .phc-kpi{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:14px;display:grid;gap:4px}',
    '#phc .phc-kpi b{font-family:var(--display);font-size:30px;font-weight:800;line-height:1;color:var(--fg);font-variant-numeric:tabular-nums}',
    '#phc .phc-kpi span{font-size:12px;color:var(--muted)}',
    '#phc .phc-kpi.ok b{color:var(--accent)}',
    '#phc .phc-kpi.bad b{color:#ff6b6b}',
    '#phc .phc-box{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:14px;display:grid;gap:10px}',
    '#phc .phc-box h3{font-size:15px;font-weight:700;color:var(--fg)}',
    '#phc .phc-box p,#phc .phc-box li{font-size:13.5px;color:var(--soft)}',
    '#phc .phc-box ul{list-style:none;display:grid;gap:6px}',
    '#phc .phc-vrow{display:grid;grid-template-columns:96px minmax(0,1fr);gap:12px;align-items:start}',
    '#phc .phc-vrow img{width:96px;aspect-ratio:16/9;object-fit:cover;border-radius:4px;background:var(--surface-2)}',
    '#phc .phc-vrow .t{font-weight:600;color:var(--fg);font-size:14px;line-height:1.3}',
    '#phc .phc-vrow .m{font-family:var(--mono);font-size:11px;color:var(--muted);margin-top:4px}',
    '#phc .phc-score{display:inline-block;font-family:var(--mono);font-size:11px;padding:1px 7px;border-radius:999px;margin-right:6px}',
    '#phc .phc-score.hi{background:rgba(61,255,143,.15);color:var(--accent)}',
    '#phc .phc-score.mid{background:rgba(255,196,0,.15);color:#ffc400}',
    '#phc .phc-score.lo{background:rgba(255,107,107,.15);color:#ff6b6b}',
    '#phc .phc-issues li{font-size:12.5px;color:var(--soft);padding-left:14px;position:relative}',
    '#phc .phc-issues li::before{content:"";position:absolute;left:0;top:.6em;width:6px;height:6px;border-radius:50%;background:#ffc400}',
    '#phc .phc-field{display:grid;gap:5px}',
    '#phc .phc-field label{font-size:12px;color:var(--muted);display:flex;justify-content:space-between;gap:8px}',
    '#phc .phc-field input,#phc .phc-field textarea,#phc .phc-field select{font:inherit;font-size:14px;color:var(--fg);background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:9px 11px;width:100%}',
    '#phc .phc-field textarea{min-height:76px;resize:vertical}',
    '#phc .phc-field .warn{color:#ffc400}',
    '#phc .phc-row2{display:flex;flex-wrap:wrap;gap:8px;align-items:center}',
    '#phc .phc-mini{font-size:13px;padding:8px 14px}',
    '#phc .phc-toast{position:fixed;left:50%;bottom:calc(24px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);z-index:80;background:var(--fg);color:var(--bg);font-weight:600;font-size:14px;padding:10px 16px;border-radius:999px;box-shadow:0 8px 30px rgba(0,0,0,.5)}',
    '#phc .phc-switch{display:flex;gap:10px;align-items:center;font-size:14px;color:var(--fg);cursor:pointer}',
    '#phc .phc-switch input{width:20px;height:20px;accent-color:var(--accent)}',
    '#phc .phc-tag-st{font-family:var(--mono);font-size:10.5px;text-transform:uppercase;letter-spacing:.1em;padding:2px 6px;border-radius:3px;background:var(--surface-2);color:var(--soft)}',
    '#phc .phc-tag-st.live{background:rgba(61,255,143,.15);color:var(--accent)}',
    '#phc .phc-tag-st.error{background:rgba(255,107,107,.15);color:#ff6b6b}',
    '@media (prefers-reduced-motion:reduce){#phc *{animation:none!important;transition:none!important}}'
  ].join('\n');
  // Verrou de défilement de la page (seule règle posée dans le document)
  var lock = document.createElement('style');
  lock.textContent = 'html.phc-lock,html.phc-lock body{overflow:hidden!important}';
  document.head.appendChild(lock);

  var ICONS = '<svg width="0" height="0" style="position:absolute" aria-hidden="true">' +
    // Logo Posthumain, tracé exact relevé sur le logo d'origine (superposition 96 %) : anneau + barre à sommet plat
    '<symbol id="phc-logo" viewBox="0 0 100 100"><circle cx="50" cy="50" r="45.43" fill="none" stroke="#39FF71" stroke-width="9.14"/><rect x="45.86" y="69.31" width="8.28" height="22.5" fill="#39FF71" stroke="none"/></symbol>' +
    '<symbol id="phc-gear" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3.2" stroke-width="2"/><path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7" stroke-width="2" stroke-linecap="round"/></symbol>' +
    '<symbol id="phc-down" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></symbol>' +
    '<symbol id="phc-play" viewBox="0 0 24 24"><path d="M7 4.5v15a1 1 0 0 0 1.5.86l12.4-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5z"/></symbol>' +
    '<symbol id="phc-plus" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" stroke-width="2.2" stroke-linecap="round"/></symbol>' +
    '<symbol id="phc-check" viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></symbol>' +
    '<symbol id="phc-info" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" stroke-width="2"/><path d="M12 11v6M12 7.5v.01" stroke-width="2.2" stroke-linecap="round"/></symbol>' +
    '<symbol id="phc-x" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" stroke-width="2.2" stroke-linecap="round"/></symbol>' +
    '<symbol id="phc-back" viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></symbol>' +
    '<symbol id="phc-home" viewBox="0 0 24 24"><path d="M4 11l8-7 8 7v9a1 1 0 0 1-1 1h-5v-6h-4v6H5a1 1 0 0 1-1-1z" stroke-width="2" stroke-linejoin="round"/></symbol>' +
    '<symbol id="phc-grid" viewBox="0 0 24 24"><rect x="3" y="3" width="7.5" height="7.5" rx="1.5" stroke-width="2"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5" stroke-width="2"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5" stroke-width="2"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.5" stroke-width="2"/></symbol>' +
    '<symbol id="phc-bookmark" viewBox="0 0 24 24"><path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4.5L5 21V4a1 1 0 0 1 1-1z" stroke-width="2" stroke-linejoin="round"/></symbol>' +
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
  root.innerHTML = ICONS + '<div class="phc-loading">Chargement de Posthumain TV…</div>';
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
    // Vidéo hébergée chez Bunny Stream : data-source="bunny" data-bunny="ID_BIBLIOTHEQUE/GUID_VIDEO"
    var bn = /^(\d+)\/([A-Za-z0-9-]{8,})$/.exec(attr(metaTag, 'bunny'));
    var source = attr(metaTag, 'source') === 'bunny' && bn ? 'bunny' : 'youtube';
    if (source === 'youtube' && !yt) return null;
    var theme = attr(metaTag, 'theme');
    var dur = parseFloat(attr(metaTag, 'duration')) || 0;
    if (dur && dur < 30) dur = dur * 60; // durée donnée en minutes
    return {
      id: source === 'bunny' ? 'bn-' + bn[2] : yt,
      source: source,
      yt: yt,
      bunnyLib: bn ? bn[1] : '',
      bunnyId: bn ? bn[2] : '',
      exclusive: attr(metaTag, 'exclusive') === '1',
      was: attr(metaTag, 'was'), // ancien identifiant (exclusivité passée sur YouTube)
      postId: p.id,
      title: p.title,
      url: p.url,
      img: p.feature_image || (yt ? 'https://i.ytimg.com/vi/' + yt + '/maxresdefault.jpg' : ''),
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

  var FAQ = [
    ['Qu\'est-ce que Posthumain TV ?', 'Posthumain TV réunit tous les documentaires de Posthumain sur l\'intelligence artificielle, la tech, la science et le futur, rangés par thème et lisibles en plein écran sur téléphone, ordinateur ou télévision.'],
    ['Qu\'est-ce qu\'une exclusivité Posthumain TV ?', 'Chaque semaine, un documentaire de 12 à 14 minutes sort d\'abord sur Posthumain TV, réservé aux abonnés, trois mois avant sa mise en ligne sur YouTube.'],
    ['Peut-on regarder Posthumain TV sur sa télé ?', 'Oui. Lancez la lecture sur votre téléphone puis envoyez-la sur la télévision avec Chromecast ou AirPlay, ou ouvrez posthumain.com/tv directement sur le navigateur de la télé.'],
    ['Combien coûte Posthumain TV ?', 'Posthumain TV est inclus dans l\'abonnement Posthumain, sans engagement, avec les enquêtes premium du site.'],
    ['Est-ce que je retrouve où j\'en étais ?', 'Oui. La lecture reprend là où vous vous êtes arrêté et votre liste est synchronisée entre tous vos appareils.']
  ];

  function renderLanding() {
    root.innerHTML = ICONS + '<div class="phc-loading">Posthumain TV…</div>';
    var memberReq = fetch('/members/api/member/', { credentials: 'same-origin' })
      .then(function (r) { return r.status === 200 ? r.json() : null; })
      .catch(function () { return null; });
    var topReq = fetch(ADMIN_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'top' }) })
      .then(function (r) { return r.ok ? r.json() : {}; })
      .then(function (j) { return j.top || []; })
      .catch(function () { return []; });
    Promise.all([loadCatalogue().catch(function () { return []; }), loadPrice(), memberReq, topReq]).then(function (a) {
      paintLanding(a[0], a[1], a[2], a[3]);
    });
  }

  function paintLanding(videos, price, member, top) {
    var status = member && member.status;
    var paid = status === 'paid' || status === 'comped';
    var byKey = {};
    videos.forEach(function (v) { byKey[v.id] = v; if (v.was) byKey[v.was] = v; });
    function href(v) { return paid ? '/tv/?v=' + encodeURIComponent(v.id) : (v.url || '/tv/'); }
    function lcard(v) {
      var sub = [v.duration ? minutes(v.duration) : '', THEMES[v.theme]].filter(Boolean).join(' · ');
      return '<a class="phc-card" href="' + esc(href(v)) + '">' +
        '<span class="phc-thumb"><img src="' + esc(sized(v.img, 600)) + '" alt="" loading="lazy" data-full="' + esc(v.img) + '">' +
        '<span class="phc-badges">' + srcBadge(v) + '</span></span>' +
        '<span class="phc-cap"><span class="phc-t">' + esc(v.title) + '</span><span class="phc-s">' + esc(sub) + '</span></span></a>';
    }
    function lrow(title, sub, items, id) {
      if (!items.length) return '';
      return '<section class="phl-sec"' + (id ? ' id="' + id + '"' : '') + '><h2>' + esc(title) + '</h2>' + (sub ? '<p class="phl-sub">' + esc(sub) + '</p>' : '') +
        '<div class="phc-track">' + items.map(lcard).join('') + '</div></section>';
    }
    var cta = paid
      ? '<a class="phc-btn phc-sub" href="/tv/">' + svg('play') + 'Ouvrir Posthumain TV</a>'
      : status === 'free'
        ? '<a class="phc-btn phc-sub" href="' + PORTAL_UPGRADE + '">Passer à l\'abonnement' + (price ? ' · ' + esc(price) + '/mois' : '') + '</a>'
        : '<a class="phc-btn phc-sub" href="' + PORTAL_SIGNUP + '">S\'abonner' + (price ? ' · ' + esc(price) + '/mois' : '') + '</a>';
    var under = paid ? '<span class="phl-small">Ton abonnement inclut tout le catalogue et les exclusivités.</span>'
      : status === 'free' ? '<span class="phl-small">Tu es connecté avec un compte gratuit.</span>'
      : '<span class="phl-small">Déjà abonné ? <a href="' + PORTAL_SIGNIN + '">Se connecter</a></span>';

    // « Les plus regardés » : audience réelle de Posthumain TV, complétée par les nouveautés
    var ranked = [];
    top.forEach(function (t) { var v = byKey[t.id]; if (v && ranked.indexOf(v) === -1) ranked.push(v); });
    var realTop = ranked.length >= 3;
    videos.forEach(function (v) { if (ranked.length < 10 && ranked.indexOf(v) === -1) ranked.push(v); });
    ranked = ranked.slice(0, 10);
    var excl = videos.filter(function (v) { return v.source === 'bunny'; });
    var themesPresent = Object.keys(THEMES).filter(function (t) { return videos.some(function (v) { return v.theme === t; }); });
    var totalMin = Math.round(videos.reduce(function (s, v) { return s + (v.duration || 0); }, 0) / 60);
    var mosaic = videos.slice(0, 18);
    while (mosaic.length && mosaic.length < 18) mosaic = mosaic.concat(mosaic).slice(0, 18);

    root.innerHTML = ICONS +
      '<header class="phc-top" id="phc-top">' +
      '<a class="phc-brand" href="/" aria-label="Posthumain, retour au site"><svg aria-hidden="true"><use href="#phc-logo"></use></svg><span><b>POSTHUMAIN</b><small>TV</small></span></a>' +
      '<span class="phc-spacer"></span>' +
      (paid ? '<a class="phc-btn phc-ghost phc-mini" href="/tv/">Ouvrir le catalogue</a>' : '<a class="phc-btn phc-ghost phc-mini" href="' + (status === 'free' ? PORTAL_UPGRADE : PORTAL_SIGNUP) + '">S\'abonner</a>') +
      '</header>' +
      '<section class="phl-hero">' +
      (mosaic.length ? '<div class="phl-mosaic" aria-hidden="true">' + mosaic.map(function (v) { return '<img src="' + esc(sized(v.img, 600)) + '" alt="">'; }).join('') + '</div>' : '') +
      '<div class="phl-copy">' +
      '<div class="phc-eyebrow"><span class="phc-new">Posthumain TV</span><span>Documentaires · IA, tech, science</span></div>' +
      '<h1>Le futur,<br><em>en documentaires.</em></h1>' +
      '<p class="phl-lead">Tous nos documentaires sur l\'intelligence artificielle, la tech et la science, rangés par thème, en plein écran sur ton téléphone, ton ordinateur ou ta télé. Et chaque semaine, un docu exclusif, trois mois avant YouTube.</p>' +
      '<div class="phl-ctas">' + cta + '<a class="phc-btn phc-ghost" href="#phl-top">Voir ce qu\'il y a dedans</a></div>' + under +
      '</div></section>' +
      '<div class="phl-stats">' +
      '<div><b>' + videos.length + '</b><span>documentaires</span></div>' +
      (totalMin ? '<div><b>' + (totalMin >= 120 ? Math.round(totalMin / 60) + ' h' : totalMin + ' min') + '</b><span>de vidéo</span></div>' : '') +
      '<div><b>' + themesPresent.length + '</b><span>thèmes</span></div>' +
      '<div><b>1/sem.</b><span>exclusivité, 3 mois avant YouTube</span></div>' +
      '</div>' +
      (ranked.length ? '<section class="phl-sec" id="phl-top"><h2>' + (realTop ? 'Les plus regardés' : 'À ne pas manquer') + '</h2>' +
        '<p class="phl-sub">' + (realTop ? 'Ce que les abonnés regardent en ce moment' : 'Nos documentaires du moment') + '</p>' +
        '<div class="phc-track">' + ranked.map(function (v, i) { return '<div class="phl-rank"><b aria-hidden="true">' + (i + 1) + '</b>' + lcard(v) + '</div>'; }).join('') + '</div></section>' : '') +
      lrow('Exclusivités Posthumain TV', 'En avant-première pour les abonnés, trois mois avant YouTube', excl) +
      lrow('Nouveautés', 'Un nouveau documentaire tous les deux jours', videos.slice(0, 12), 'phl-new') +
      '<section class="phl-sec"><h2>Pensé pour regarder</h2><p class="phl-sub">Comme une plateforme de streaming, mais pour comprendre le monde qui vient</p><div class="phl-feats">' +
      '<div class="phl-feat">' + svg('tv') + '<b>Sur ta télé</b><p>Chromecast ou AirPlay depuis ton téléphone, ou directement dans le navigateur de la télé.</p></div>' +
      '<div class="phl-feat">' + svg('bookmark') + '<b>Ma liste, partout</b><p>Ta liste et ta progression te suivent sur tous tes appareils. Tu reprends là où tu t\'es arrêté.</p></div>' +
      '<div class="phl-feat">' + svg('logo') + '<b>Exclusivités</b><p>Un documentaire de 12 à 14 minutes chaque semaine, réservé aux abonnés pendant trois mois.</p></div>' +
      '<div class="phl-feat">' + svg('grid') + '<b>Rangé par thème</b><p>IA, énergie, santé, cerveau, espace, cyber : tout est classé, rien à chercher.</p></div>' +
      '</div></section>' +
      (themesPresent.length ? '<section class="phl-sec"><h2>Les thèmes</h2><div class="phl-themes">' + themesPresent.map(function (t) {
        var n = videos.filter(function (v) { return v.theme === t; }).length;
        return '<a href="' + (paid ? '/tv/' : '#phl-new') + '">' + esc(THEMES[t]) + '<span>' + n + '</span></a>';
      }).join('') + '</div></section>' : '') +
      '<section class="phl-sec"><h2>Questions fréquentes</h2><div class="phl-faq">' + FAQ.map(function (f) {
        return '<details><summary>' + esc(f[0]) + svg('down') + '</summary><p>' + esc(f[1]) + '</p></details>';
      }).join('') + '</div></section>' +
      '<section class="phl-final"><h2>Prêt à regarder&nbsp;?</h2><p class="phl-lead">' +
      (price ? 'Tout le catalogue, les exclusivités et les enquêtes premium pour ' + esc(price) + ' par mois, sans engagement.' : 'Tout le catalogue, les exclusivités et les enquêtes premium, sans engagement.') + '</p>' + cta + '</section>' +
      '<footer class="phl-foot"><a href="/">Retour à Posthumain</a><a href="/videos/">Toutes les vidéos</a><span>© Posthumain</span></footer>';
    root.addEventListener('scroll', function () {
      var t = $('#phc-top', root);
      if (t) t.classList.toggle('solid', root.scrollTop > 40);
    }, { passive: true });
    root.addEventListener('click', function (e) {
      var a = e.target.closest && e.target.closest('a[href^="#phl-"]');
      if (!a) return;
      e.preventDefault();
      var el = $(a.getAttribute('href'), root);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    root.addEventListener('error', function (e) {
      var img = e.target;
      if (img && img.tagName === 'IMG' && img.dataset.full && img.src !== img.dataset.full) img.src = img.dataset.full;
    }, true);
  }

  // ===========================================================================
  // PAGE D'ACCUEIL /tv/home (publique : présentation, plus regardés, exclusivités, FAQ)
  // Page Ghost « tv-home » servie à /tv/home/ (routes.yaml), carte HTML <div id="ph-tv-landing"></div>
  // précédée d'un texte statique (titre, présentation, FAQ) lisible par Google.
  // ===========================================================================
  if (document.getElementById('ph-tv-landing')) {
    renderLanding();
    return;
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
        '<h1>Posthumain TV</h1>' +
        '<p>Tous nos documentaires sur l\'IA, la tech et le futur, rangés par thème. Lecture en plein écran, sur ton téléphone ou ta télé.</p>' +
        '<ul>' +
        ((videos || []).some(function (v) { return v.source === 'bunny'; })
          ? '<li>' + svg('check') + 'Des documentaires exclusifs Posthumain TV, en avant-première 3 mois avant YouTube</li>' : '') +
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
  var listAt = store('phc-list-at') || 0;

  // ---------------------------------------------------------------------------
  // Synchro entre appareils (« Ma liste » + « Reprendre ») : fonction Supabase tv-state (projet PosthumanOS),
  // authentifiée par le jeton d'identité Ghost du membre connecté. En cas d'échec : stockage local seul, sans blocage.
  var tokenCache = null;
  var pushTimer = null;
  var lastPush = 0;
  function ghostToken() {
    if (tokenCache && tokenCache.exp > Date.now()) return Promise.resolve(tokenCache.t);
    return fetch('/members/api/session', { credentials: 'same-origin' })
      .then(function (r) { return r.status === 200 ? r.text() : ''; })
      .then(function (tk) {
        tk = String(tk || '').trim().replace(/^"|"$/g, '');
        tokenCache = tk ? { t: tk, exp: Date.now() + 8 * 60000 } : null;
        return tk;
      })
      .catch(function () { return ''; });
  }
  function syncCall(method, body, token, keepalive) {
    var headers = { Authorization: 'Bearer ' + token };
    if (body) headers['Content-Type'] = 'application/json';
    return fetch(SYNC_URL, { method: method, headers: headers, body: body ? JSON.stringify(body) : undefined, keepalive: !!keepalive })
      .then(function (r) { if (!r.ok) throw new Error('tv-state ' + r.status); return r.json(); });
  }
  function applyRemote(s) {
    if (!s || typeof s !== 'object') return false;
    var changed = false;
    var rp = s.progress || {};
    Object.keys(rp).forEach(function (k) {
      var p = rp[k];
      if (p && (!progress[k] || (p.at || 0) > (progress[k].at || 0))) { progress[k] = p; changed = true; }
    });
    if (changed) store('phc-progress', progress);
    if ((s.list_at || 0) > listAt && Array.isArray(s.list)) {
      myList = s.list.slice();
      listAt = s.list_at;
      store('phc-list', myList);
      store('phc-list-at', listAt);
      changed = true;
    }
    return changed;
  }
  function pushNow(keepalive) {
    clearTimeout(pushTimer); pushTimer = null;
    lastPush = Date.now();
    var body = { list: myList, list_at: listAt, progress: progress };
    if (keepalive) { // fermeture de page : pas le temps d'aller chercher un jeton
      if (tokenCache && tokenCache.exp > Date.now()) syncCall('POST', body, tokenCache.t, true).catch(function () {});
      return;
    }
    ghostToken().then(function (tk) { if (tk) return syncCall('POST', body, tk).then(applyRemote); }).catch(function () {});
  }
  // liste : envoi rapide ; progression : au plus toutes les 30 s pendant la lecture
  function schedulePush(soon) {
    var wait = soon ? 1500 : Math.max(0, 30000 - (Date.now() - lastPush));
    if (pushTimer && !soon) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(function () { pushNow(false); }, wait);
  }
  function initialSync() {
    ghostToken().then(function (tk) {
      if (!tk) return;
      return syncCall('GET', null, tk).then(function (s) {
        var changed = applyRemote(s);
        if (changed) migrateLegacy();
        if (changed && $('#phc-player', root) && $('#phc-player', root).hidden) renderAll();
        pushNow(false); // remonte ce que cet appareil avait de plus récent
      });
    }).catch(function () {});
  }

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
      '<a class="phc-brand" href="/" aria-label="Posthumain, retour au site"><svg aria-hidden="true"><use href="#phc-logo"></use></svg><span><b>POSTHUMAIN</b><small>TV</small></span></a>' +
      '<nav class="phc-nav" aria-label="Sections">' +
      '<button type="button" data-nav="home" aria-current="true">Accueil</button>' +
      '<button type="button" data-nav="all">Tous les documentaires</button>' +
      '<button type="button" data-nav="list">Ma liste</button>' +
      '</nav><span class="phc-spacer"></span>' +
      '<span id="phc-adm-slot"></span>' +
      '<a class="phc-site" href="/">Retour au site</a>' +
      '</header>' +
      '<main id="phc-main"><section class="phc-hero" id="phc-hero"></section>' +
      '<div class="phc-chips" id="phc-chips" role="toolbar" aria-label="Thèmes"></div>' +
      '<div class="phc-rows" id="phc-rows"></div></main>' +
      '<nav class="phc-tabs" aria-label="Sections">' +
      '<button type="button" data-nav="home" aria-current="true">' + svg('home') + 'Accueil</button>' +
      '<button type="button" data-nav="all">' + svg('grid') + 'Tous</button>' +
      '<button type="button" data-nav="list">' + svg('bookmark') + 'Ma liste</button>' +
      '</nav>' +
      '<div class="phc-scrim" id="phc-scrim" hidden></div>' +
      '<div class="phc-player" id="phc-player" hidden></div>' +
      '<div class="phc-adm" id="phc-adm" hidden></div>';
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
    if (v.source === 'youtube') bits.push('<span>Sous-titres YouTube</span>');
    return '<div class="phc-meta">' + bits.join('') + '</div>';
  }

  function renderHero() {
    var el = $('#phc-hero', root);
    if (!VIDEOS.length) { el.innerHTML = ''; return; }
    // une exclusivité de moins de 7 jours pas encore vue ; sinon le plus récent pas encore vu ; sinon le plus récent
    var v = (HERO_PIN && byId[HERO_PIN]) || VIDEOS.filter(function (x) { return x.source === 'bunny' && !isDone(x.id) && x.date && Date.now() - new Date(x.date).getTime() < 7 * 86400000; })[0] ||
      VIDEOS.filter(function (x) { return !isDone(x.id); })[0] || VIDEOS[0];
    var resume = inProgress(v.id);
    el.innerHTML =
      '<div class="phc-hero-art"><img src="' + esc(sized(v.img, 1200)) + '" alt="" data-full="' + esc(v.img) + '"></div>' +
      '<div class="phc-hero-copy">' +
      '<div class="phc-eyebrow">' + srcBadge(v) + (isNew(v) ? '<span class="phc-new">Nouveau</span>' : '') + '<span>Documentaire</span></div>' +
      '<h1>' + esc(v.title) + '</h1>' + metaLine(v) +
      (v.desc ? '<p class="phc-desc">' + esc(v.desc) + '</p>' : '') +
      '<div class="phc-actions">' +
      '<button type="button" class="phc-btn phc-play" data-play="' + esc(v.id) + '">' + svg('play') + (resume ? 'Reprendre à ' + mmss(prog(v.id).t) : 'Lecture') + '</button>' +
      '<button type="button" class="phc-btn phc-ghost" data-list="' + esc(v.id) + '" aria-pressed="' + inList(v.id) + '">' + svg(inList(v.id) ? 'check' : 'plus') + 'Ma liste</button>' +
      '<button type="button" class="phc-btn phc-ghost" data-open="' + esc(v.id) + '" aria-label="Infos">' + svg('info') + '<span class="phc-hide-sm">Infos</span></button>' +
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
    return '<button type="button" class="phc-card" data-open="' + esc(v.id) + '" aria-label="' + esc(v.title) + '">' +
      '<span class="phc-thumb"><img src="' + esc(sized(v.img, 600)) + '" alt="" loading="lazy" data-full="' + esc(v.img) + '">' +
      '<span class="phc-badges">' + srcBadge(v) + (isNew(v) ? '<span class="phc-tag">Nouveau</span>' : '') + '</span>' +
      (isDone(v.id) ? '<span class="phc-seen" title="Déjà vu">' + svg('check') + '</span>' : '') +
      (r > 0.03 && !isDone(v.id) ? '<span class="phc-bar"><i style="width:' + Math.round(r * 100) + '%"></i></span>' : '') +
      '</span><span class="phc-cap"><span class="phc-t">' + esc(v.title) + '</span><span class="phc-s">' + esc(sub) + '</span></span></button>';
  }
  var SOON = '<div class="phc-soon" aria-hidden="true"><div><b>' + esc(SOON_TITLE) + '</b><span>' + esc(SOON_TEXT) + '</span></div></div>';

  function row(title, items, note, extra) {
    if (!items.length && !extra) return '';
    return '<section class="phc-row"><h2>' + esc(title) + (note ? '<span>' + esc(note) + '</span>' : '') + '</h2>' +
      '<div class="phc-track">' + items.map(card).join('') + (extra || '') + '</div></section>';
  }

  function grid(title, items, note) {
    return '<section class="phc-row"><h2>' + esc(title) + (note ? '<span>' + esc(note) + '</span>' : '') + '</h2>' +
      '<div class="phc-grid">' + items.map(card).join('') + '</div></section>';
  }
  function count(n) { return n + (n > 1 ? ' vidéos' : ' vidéo'); }

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
      html = mine.length ? grid('Ma liste', mine, count(mine.length)) : '<section class="phc-row"><h2>Ma liste</h2><p class="phc-empty">Ta liste est vide. Touche « Ma liste » sur un documentaire pour le retrouver ici.</p></section>';
    } else if (view === 'all') {
      html = grid(filter === 'all' ? 'Tous les documentaires' : THEMES[filter], pool, count(pool.length));
    } else if (filter !== 'all') {
      html = row(THEMES[filter], pool, pool.length + (pool.length > 1 ? ' vidéos' : ' vidéo'));
    } else {
      html += row('Reprendre', VIDEOS.filter(function (v) { return inProgress(v.id); }));
      html += row('Exclusivités Posthumain TV', VIDEOS.filter(function (v) { return v.source === 'bunny'; }), 'en avant-première, 3 mois avant YouTube');
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

  function renderAll() {
    renderHero(); renderChips(); renderRows();
    var hero = $('#phc-hero', root);
    if (hero) hero.hidden = view !== 'home';
    var chips = $('#phc-chips', root);
    if (chips && view === 'list') chips.hidden = true;
  }

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
  function syncScrollLock() {
    var adm = $('#phc-adm', root);
    var open = !$('#phc-player', root).hidden || !$('#phc-scrim', root).hidden || (adm && !adm.hidden);
    root.classList.toggle('phc-noscroll', open);
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
      '<div class="phc-sheet-body"><div>' + srcBadge(v) + '</div><h3>' + esc(v.title) + '</h3>' + metaLine(v) +
      (v.desc ? '<p>' + esc(v.desc) + '</p>' : '') +
      '<div class="phc-actions">' +
      '<button type="button" class="phc-btn phc-play" data-play="' + esc(v.id) + '">' + svg('play') + (resume ? 'Reprendre à ' + mmss(prog(v.id).t) : 'Lecture') + '</button>' +
      '<button type="button" class="phc-btn phc-ghost" data-list="' + esc(v.id) + '" aria-pressed="' + inList(v.id) + '">' + svg(inList(v.id) ? 'check' : 'plus') + 'Ma liste</button>' +
      '</div>' +
      '<div class="phc-tv">' + svg('tv') + '<div><b>Sur ta télé.</b> Lance la lecture sur ton téléphone, puis touche l\'icône Cast ou AirPlay du lecteur.</div></div>' +
      (v.url ? '<a class="phc-link" href="' + esc(v.url) + '">Chapitres et sources de ce documentaire</a>' : '') +
      '</div>' +
      (more.length ? '<div class="phc-row" style="padding-bottom:22px"><h2>À voir aussi</h2><div class="phc-track">' + more.map(card).join('') + '</div></div>' : '') +
      '</div>';
    if (sc.hidden) pushLayer('sheet');
    sc.hidden = false;
    syncScrollLock();
    var b = $('.phc-play', sc);
    if (b) b.focus({ preventScroll: true });
  }
  function closeSheet() {
    var sc = $('#phc-scrim', root);
    if (!sc || sc.hidden) return;
    sc.hidden = true;
    sc.innerHTML = '';
    syncScrollLock();
  }

  // ---------------------------------------------------------------------------
  // Lecteurs : YouTube (IFrame API) ou Bunny Stream (player.js) — reprise + épisode suivant
  // Les deux lecteurs alimentent la même position « pos » ; saveProgress() ne connaît qu'elle.
  var ytReady = null;
  var pjReady = null;
  var player = null;      // lecteur YouTube
  var bunny = null;       // lecteur Bunny (player.js)
  var ticker = null;
  var current = null;
  var nextTimer = null;
  var pos = { t: 0, d: 0 };
  var lastSave = 0;
  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error('script ' + src)); };
      document.head.appendChild(s);
    });
  }
  function loadYT() {
    if (ytReady) return ytReady;
    ytReady = new Promise(function (resolve) {
      if (window.YT && window.YT.Player) return resolve();
      var prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = function () { if (typeof prev === 'function') prev(); resolve(); };
      loadScript('https://www.youtube.com/iframe_api').catch(function () {});
    });
    return ytReady;
  }
  function loadPlayerJs() {
    if (pjReady) return pjReady;
    pjReady = window.playerjs ? Promise.resolve() : loadScript(BUNNY_PLAYERJS);
    return pjReady;
  }
  function readPos() {
    if (player && typeof player.getCurrentTime === 'function') {
      try { pos = { t: player.getCurrentTime() || 0, d: player.getDuration() || pos.d }; } catch (e) {}
    }
    return pos;
  }
  function saveProgress(done) {
    if (!current) return;
    var p = readPos();
    var d = p.d || current.duration || 0;
    if (!d || (!done && !p.t)) return;
    progress[current.id] = { t: done ? Math.round(d) : Math.floor(p.t), d: Math.round(d), done: !!done || p.t / d >= 0.92, at: Date.now() };
    store('phc-progress', progress);
    schedulePush(!!done);
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
      '<div class="phc-row-btns"><button type="button" class="phc-btn phc-play" data-play="' + esc(nx.id) + '">' + svg('play') + 'Lecture</button>' +
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
  function onEnded(v) {
    if (current !== v) return;
    saveProgress(true);
    showNext(v);
  }
  function startYouTube(v, start, pl) {
    loadYT().then(function () {
      if (current !== v) return;
      var slot = $('.phc-yt', pl);
      if (!slot) return;
      player = new window.YT.Player(slot, {
        host: 'https://www.youtube-nocookie.com',
        videoId: v.yt,
        playerVars: { autoplay: 1, rel: 0, playsinline: 1, modestbranding: 1, start: Math.floor(start), origin: location.origin },
        events: {
          onReady: function (e) { try { e.target.playVideo(); } catch (err) {} },
          onStateChange: function (e) {
            if (e.data === 1) { // lecture
              if (!ticker) ticker = setInterval(function () { saveProgress(false); }, 5000);
            } else {
              if (ticker) { clearInterval(ticker); ticker = null; }
              if (e.data === 2) saveProgress(false); // pause
              if (e.data === 0) onEnded(v); // fin
            }
          }
        }
      });
    });
  }
  var PLAY_ERRORS = {
    not_subscriber: 'Ton abonnement n\'apparaît pas comme actif sur ce compte. Reconnecte-toi ou vérifie ton abonnement.',
    not_available: 'Ce documentaire n\'est plus disponible ici. Recharge la page.',
    unauthorized: 'Ta session a expiré. Recharge la page pour te reconnecter.'
  };
  function bunnyFailed(v, pl, code) {
    var slot = $('.phc-yt', pl);
    if (!slot || current !== v) return;
    slot.innerHTML = '<div class="phc-msg"><b>Lecture impossible pour le moment</b><span>' +
      esc(PLAY_ERRORS[code] || 'Le serveur vidéo ne répond pas. Réessaie dans un instant.') + '</span>' +
      '<button type="button" class="phc-btn phc-ghost" data-play="' + esc(v.id) + '">Réessayer</button></div>';
  }
  function startBunny(v, start, pl) {
    // Exclusivité Posthumain TV (Bunny Stream) : la bibliothèque n'accepte que des liens signés,
    // demandés à tv-play (abonné vérifié côté serveur), puis lecteur Bunny + player.js.
    var slot = $('.phc-yt', pl);
    if (!slot) return;
    slot.innerHTML = '<div class="phc-msg">Chargement…</div>';
    ghostToken().then(function (tk) {
      if (!tk) throw new Error('unauthorized');
      return fetch(PLAY_URL, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + tk, 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: v.id })
      }).then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          if (!r.ok || !j.url) throw new Error(j.error || 'http_' + r.status);
          return j.url;
        });
      });
    }).then(function (src) {
      if (current !== v) return;
      mountBunny(v, start, pl, src);
    }).catch(function (err) { bunnyFailed(v, pl, err && err.message); });
  }
  function mountBunny(v, start, pl, src) {
    var slot = $('.phc-yt', pl);
    if (!slot) return;
    var ifr = document.createElement('iframe');
    ifr.src = src;
    ifr.setAttribute('allow', 'accelerometer; gyroscope; autoplay; encrypted-media; picture-in-picture; fullscreen');
    ifr.setAttribute('allowfullscreen', '');
    ifr.setAttribute('title', v.title);
    slot.replaceWith(ifr);
    loadPlayerJs().then(function () {
      if (current !== v || !window.playerjs) return;
      bunny = new window.playerjs.Player(ifr);
      bunny.on('ready', function () {
        if (start) { try { bunny.setCurrentTime(start); } catch (e) {} }
        try { bunny.play(); } catch (e) {}
        bunny.on('timeupdate', function (d) {
          if (!d) return;
          pos = { t: d.seconds || 0, d: d.duration || pos.d };
          if (Date.now() - lastSave > 5000) { lastSave = Date.now(); saveProgress(false); }
        });
        bunny.on('pause', function () { saveProgress(false); });
        bunny.on('ended', function () { onEnded(v); });
      });
    }).catch(function () { /* lecture sans reprise si player.js ne charge pas */ });
  }
  function play(id, replace) {
    var v = byId[id];
    if (!v) return;
    cancelNext();
    stopPlayer(true);
    closeSheet();
    current = v;
    pos = { t: 0, d: v.duration || 0 };
    var start = inProgress(v.id) ? Math.max(0, prog(v.id).t - 3) : 0;
    var pl = $('#phc-player', root);
    pl.innerHTML = '<div class="phc-pbar"><button type="button" data-stop>' + svg('back') + 'Retour</button><span class="phc-pt">' + esc(v.title) + '</span></div>' +
      '<div class="phc-stage"><div class="phc-screen"><div class="phc-yt"></div></div></div>';
    if (pl.hidden && !replace) pushLayer('player');
    pl.hidden = false;
    syncScrollLock();
    var back = $('[data-stop]', pl);
    if (back) back.focus({ preventScroll: true });
    if (v.source === 'bunny') startBunny(v, start, pl);
    else startYouTube(v, start, pl);
  }
  function stopPlayer(keepOpen) {
    if (ticker) { clearInterval(ticker); ticker = null; }
    cancelNext();
    if (current) { saveProgress(false); if (!keepOpen) pushNow(false); }
    if (player) {
      try { player.destroy(); } catch (e) {}
      player = null;
    }
    bunny = null; // l'iframe disparaît avec le contenu du lecteur
    if (!keepOpen) {
      var pl = $('#phc-player', root);
      if (pl) { pl.hidden = true; pl.innerHTML = ''; }
      current = null;
      syncScrollLock();
      renderAll(); // met à jour « Reprendre », barres de progression, hero
    }
  }

  // Bouton retour du téléphone / navigateur : ferme d'abord le calque ouvert
  window.addEventListener('popstate', function () {
    var top = layers.pop();
    if (top === 'player') stopPlayer(false);
    else if (top === 'sheet') closeSheet();
    else if (top === 'admin') closeAdmin();
  });
  function closeTop() {
    if (layers.length) { history.back(); return; }
    if (!$('#phc-adm', root).hidden) closeAdmin();
    else if (!$('#phc-player', root).hidden) stopPlayer(false);
    else closeSheet();
  }

  // ---------------------------------------------------------------------------
  // Menu Admin (réservé à l'admin : le bouton n'apparaît que pour lui, et la fonction tv-admin
  // revérifie son identité à chaque appel avec le jeton Ghost)
  var ADM = null;
  var admTab = 'apercu';
  function adminCall(action, extra) {
    return ghostToken().then(function (tk) {
      if (!tk) throw new Error('Session expirée : recharge la page');
      var body = { action: action };
      Object.keys(extra || {}).forEach(function (k) { body[k] = extra[k]; });
      return fetch(ADMIN_URL, { method: 'POST', headers: { Authorization: 'Bearer ' + tk, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        .then(function (r) {
          return r.json().catch(function () { return {}; }).then(function (j) {
            if (!r.ok || j.error) throw new Error(j.detail || j.error || 'HTTP ' + r.status);
            return j;
          });
        });
    });
  }
  function initAdmin() {
    fetch('/members/api/member/', { credentials: 'same-origin' })
      .then(function (r) { return r.status === 200 ? r.json() : null; })
      .then(function (m) {
        if (!m || ADMIN_EMAILS.indexOf(String(m.email || '').toLowerCase()) === -1) return;
        var slot = $('#phc-adm-slot', root);
        if (slot) slot.innerHTML = '<button type="button" class="phc-adm-btn" data-admin>' + svg('gear') + 'Admin</button>';
      }).catch(function () {});
  }
  function toast(msg) {
    var t = document.createElement('div');
    t.className = 'phc-toast';
    t.textContent = msg;
    root.appendChild(t);
    setTimeout(function () { t.remove(); }, 2600);
  }
  function openAdmin() {
    var el = $('#phc-adm', root);
    if (el.hidden) pushLayer('admin');
    el.hidden = false;
    syncScrollLock();
    paintAdmin('<p class="phc-empty">Chargement…</p>');
    loadAdmin();
  }
  function closeAdmin() {
    var el = $('#phc-adm', root);
    if (!el || el.hidden) return;
    el.hidden = true;
    el.innerHTML = '';
    syncScrollLock();
  }
  function loadAdmin() {
    return adminCall('overview').then(function (j) { ADM = j; paintAdmin(); })
      .catch(function (e) { paintAdmin('<div class="phc-box"><h3>Impossible de charger</h3><p>' + esc(e.message) + '</p></div>'); });
  }
  var ADM_TABS = [['apercu', 'Aperçu'], ['videos', 'Vidéos & SEO'], ['exclus', 'Exclusivités'], ['pages', 'Pages /tv'], ['reglages', 'Réglages']];
  function paintAdmin(override) {
    var el = $('#phc-adm', root);
    if (!el || el.hidden) return;
    el.innerHTML = '<div class="phc-adm-top"><svg aria-hidden="true" style="width:24px;height:24px;stroke:none"><use href="#phc-logo"></use></svg><b>ADMIN · POSTHUMAIN TV</b>' +
      '<button type="button" data-adm-close aria-label="Fermer">' + svg('x') + '</button></div>' +
      '<div class="phc-adm-tabs" role="tablist">' + ADM_TABS.map(function (t) {
        return '<button type="button" data-adm-tab="' + t[0] + '" aria-current="' + (t[0] === admTab) + '">' + t[1] + '</button>';
      }).join('') + '</div>' +
      '<div class="phc-adm-body">' + (override || admView()) + '</div>';
  }
  function scoreTag(s) { return '<span class="phc-score ' + (s >= 85 ? 'hi' : s >= 55 ? 'mid' : 'lo') + '">SEO ' + s + '</span>'; }
  function counter(id, val, min, max) {
    var n = String(val || '').length;
    return '<span data-count-for="' + id + '" data-min="' + min + '" data-max="' + max + '" class="' + (n && (n < min || n > max) ? 'warn' : '') + '">' + n + ' car.</span>';
  }
  function fmtDate(s) { try { return new Date(s).toLocaleDateString('fr-CH', { day: 'numeric', month: 'short', year: 'numeric' }); } catch (e) { return ''; } }
  function admView() {
    var a = ADM;
    if (!a) return '';
    var vids = a.videos || [];
    var au = a.audience || { started: {}, finished: {}, listed: {} };
    var hl = a.health || {};
    if (admTab === 'apercu') {
      var pub = vids.filter(function (v) { return v.status === 'published'; });
      var ex = a.exclusives || [];
      var avg = vids.length ? Math.round(vids.reduce(function (s, v) { return s + v.seo.score; }, 0) / vids.length) : 0;
      var topIds = Object.keys(au.started || {}).sort(function (x, y) { return au.started[y] - au.started[x]; }).slice(0, 8);
      var byVid = {};
      vids.forEach(function (v) { byVid[v.video_id] = v; });
      return '<div class="phc-kpis">' +
        '<div class="phc-kpi"><b>' + pub.length + '</b><span>vidéos publiées (' + vids.length + ' au total)</span></div>' +
        '<div class="phc-kpi"><b>' + ex.filter(function (x) { return x.status === 'live'; }).length + '</b><span>exclusivités en ligne · ' + ex.filter(function (x) { return x.status === 'encoding' || x.status === 'fetching'; }).length + ' en préparation</span></div>' +
        '<div class="phc-kpi"><b>' + (au.members || 0) + '</b><span>abonnés ont utilisé Posthumain TV</span></div>' +
        '<div class="phc-kpi ' + (avg >= 85 ? 'ok' : avg < 55 ? 'bad' : '') + '"><b>' + avg + '</b><span>score SEO moyen</span></div>' +
        '<div class="phc-kpi ' + (hl.bunny && hl.bunny.ok ? 'ok' : 'bad') + '"><b>' + (hl.bunny && hl.bunny.ok ? 'OK' : '!') + '</b><span>Bunny Stream' + (hl.bunny && hl.bunny.ok ? ' · ' + hl.bunny.videos + ' vidéo(s) stockée(s)' : ' : ' + esc((hl.bunny && hl.bunny.error) || 'non configuré')) + '</span></div>' +
        '<div class="phc-kpi ' + (a.indexable ? 'ok' : '') + '"><b>' + (a.indexable ? 'Oui' : 'Non') + '</b><span>/tv et /tv/home visibles dans Google</span></div>' +
        '</div>' +
        '<div class="phc-box"><h3>Les plus regardés sur Posthumain TV</h3>' + (topIds.length ? '<ul>' + topIds.map(function (id) {
          var v = byVid[id] || byId[id];
          return '<li>' + esc(v ? v.title : id) + ' — <b>' + au.started[id] + '</b> spectateur(s), ' + (au.finished[id] || 0) + ' jusqu\'au bout, ' + (au.listed[id] || 0) + ' en « Ma liste »</li>';
        }).join('') + '</ul>' : '<p>Pas encore de données : elles apparaissent dès que des abonnés regardent.</p>') + '</div>' +
        '<div class="phc-row2"><button type="button" class="phc-btn phc-ghost phc-mini" data-adm-refresh>Actualiser</button>' +
        '<a class="phc-btn phc-ghost phc-mini" href="/tv/home/">Voir la page d\'accueil /tv/home</a></div>';
    }
    if (admTab === 'videos') {
      if (!vids.length) return '<p class="phc-empty">Aucune vidéo.</p>';
      return '<p class="phc-empty" style="padding:0">Titre et description affichés par Google. Les données structurées vidéo (durée, vignette, date) sont ajoutées automatiquement toutes les heures.</p>' +
        vids.map(function (v) {
          var tId = 'mt-' + v.id, dId = 'md-' + v.id;
          return '<div class="phc-box"><div class="phc-vrow"><img src="' + esc(sized(v.feature_image || '', 600)) + '" alt=""><div>' +
            '<div class="t">' + esc(v.title) + '</div>' +
            '<div class="m">' + scoreTag(v.seo.score) + (v.source === 'bunny' ? 'POSTHUMAIN TV' : 'VIDÉO YT') + ' · ' + esc({ published: 'publiée', draft: 'brouillon', scheduled: 'programmée' }[v.status] || v.status) + (v.duration ? ' · ' + mmss(v.duration) : '') + ' · ' + esc(v.theme_label || '') +
            ' · ' + (au.started[v.video_id] || 0) + ' spect.</div></div></div>' +
            (v.seo.issues.length ? '<ul class="phc-issues">' + v.seo.issues.map(function (i) { return '<li>' + esc(i) + '</li>'; }).join('') + '</ul>' : '<p>Rien à signaler.</p>') +
            '<div class="phc-field"><label for="' + tId + '">Titre pour Google (vide = titre de la page) ' + counter(tId, v.meta_title || v.title, 30, 60) + '</label>' +
            '<input id="' + tId + '" data-count="' + tId + '" value="' + esc(v.meta_title) + '" placeholder="' + esc(v.title) + '"></div>' +
            '<div class="phc-field"><label for="' + dId + '">Description pour Google (vide = extrait) ' + counter(dId, v.meta_description || v.custom_excerpt, 120, 155) + '</label>' +
            '<textarea id="' + dId + '" data-count="' + dId + '" placeholder="' + esc(v.custom_excerpt) + '">' + esc(v.meta_description) + '</textarea></div>' +
            '<div class="phc-row2"><button type="button" class="phc-btn phc-play phc-mini" data-adm-save-video="' + esc(v.id) + '">Enregistrer</button>' +
            (v.url ? '<a class="phc-btn phc-ghost phc-mini" href="' + esc(v.url) + '">Voir la page</a>' : '') +
            '<a class="phc-btn phc-ghost phc-mini" href="' + GHOST_ADMIN + esc(v.id) + '">Ouvrir dans Ghost</a></div></div>';
        }).join('');
    }
    if (admTab === 'exclus') {
      var rows = a.exclusives || [];
      return '<div class="phc-box"><h3>Exclusivités Bunny</h3><p>Bibliothèque ' + esc(hl.bunny_library || '?') + ' · clés ' + (hl.bunny_keys ? 'OK' : 'manquantes') + ' · signature webhook ' + (hl.webhook_signature ? 'vérifiée' : 'non vérifiée') + '</p>' +
        '<div class="phc-row2"><button type="button" class="phc-btn phc-ghost phc-mini" data-adm-sync>Relancer la synchro</button></div></div>' +
        (rows.length ? rows.map(function (r) {
          return '<div class="phc-box"><div class="phc-row2"><span class="phc-tag-st ' + esc(r.status) + '">' + esc(r.status) + '</span><b style="color:var(--fg)">' + esc(r.title) + '</b></div>' +
            '<p>' + (r.status === 'encoding' ? 'Encodage ' + (r.encode_progress || 0) + ' % · ' : '') +
            (r.published_at ? 'Publié le ' + fmtDate(r.published_at) + ' · ' : 'Reçu le ' + fmtDate(r.created_at) + ' · ') +
            (r.exclusive_until ? 'exclusif jusqu\'au ' + fmtDate(r.exclusive_until) : '') + (r.youtube_id ? ' · sur YouTube : ' + esc(r.youtube_id) : '') + '</p>' +
            (r.error ? '<p style="color:#ff6b6b">' + esc(r.error) + '</p>' : '') +
            (r.ghost_url ? '<div class="phc-row2"><a class="phc-btn phc-ghost phc-mini" href="' + esc(r.ghost_url) + '">Page</a>' + (r.bunny_guid ? '<a class="phc-btn phc-ghost phc-mini" href="/tv/?v=bn-' + esc(r.bunny_guid) + '">Dans /tv</a>' : '') + '</div>' : '') + '</div>';
        }).join('') : '<p class="phc-empty" style="padding:0">Aucune exclusivité reçue pour l\'instant.</p>');
    }
    if (admTab === 'pages') {
      var pg = a.pages || {};
      var pageBox = function (key, label, p) {
        if (!p) return '<div class="phc-box"><h3>' + label + '</h3><p>Page introuvable.</p></div>';
        var tId = 'pt-' + key, dId = 'pd-' + key;
        return '<div class="phc-box"><h3>' + label + '</h3><p>' + esc(p.url) + ' · ' + (p.seo_block ? 'données structurées OK' : 'données structurées à venir') + '</p>' +
          '<div class="phc-field"><label for="' + tId + '">Titre pour Google ' + counter(tId, p.meta_title || p.title, 30, 60) + '</label><input id="' + tId + '" data-count="' + tId + '" value="' + esc(p.meta_title) + '" placeholder="' + esc(p.title) + '"></div>' +
          '<div class="phc-field"><label for="' + dId + '">Description pour Google ' + counter(dId, p.meta_description, 120, 155) + '</label><textarea id="' + dId + '" data-count="' + dId + '">' + esc(p.meta_description) + '</textarea></div>' +
          '<div class="phc-row2"><button type="button" class="phc-btn phc-play phc-mini" data-adm-save-page="' + key + '">Enregistrer</button><a class="phc-btn phc-ghost phc-mini" href="' + esc(p.url) + '">Voir</a></div></div>';
      };
      return '<div class="phc-box"><h3>Visibilité dans Google</h3>' +
        '<label class="phc-switch"><input type="checkbox" data-adm-index' + (a.indexable ? ' checked' : '') + '> Indexer /tv et /tv/home dans Google</label>' +
        '<p>Désactivé = les deux pages portent « noindex » : Google ne les affiche pas (Posthumain TV reste discret). Les pages vidéo, elles, restent toujours indexables.</p></div>' +
        pageBox('landing', 'Page d\'accueil /tv/home', pg.landing) + pageBox('tv', 'Catalogue /tv', pg.tv) +
        '<div class="phc-row2"><button type="button" class="phc-btn phc-ghost phc-mini" data-adm-seo>Recalculer les données structurées maintenant</button></div>';
    }
    if (admTab === 'reglages') {
      var c = a.catalog || {};
      return '<div class="phc-box"><h3>Catalogue /tv</h3>' +
        '<div class="phc-field"><label for="st-hero">Vidéo en grand format (vide = automatique)</label><select id="st-hero"><option value="">Automatique (exclusivité récente, sinon la plus récente non vue)</option>' +
        vids.filter(function (v) { return v.status === 'published' && v.video_id; }).map(function (v) {
          return '<option value="' + esc(v.video_id) + '"' + (c.hero_pin === v.video_id ? ' selected' : '') + '>' + esc(v.title) + '</option>';
        }).join('') + '</select></div>' +
        '<div class="phc-field"><label for="st-theme">Rangées par thème à partir de N vidéos</label><input id="st-theme" type="number" min="1" max="50" value="' + esc(c.theme_rows_from) + '"></div>' +
        '<div class="phc-field"><label for="st-series">Rangées par série à partir de N vidéos</label><input id="st-series" type="number" min="1" max="50" value="' + esc(c.series_rows_from) + '"></div>' +
        '<div class="phc-field"><label for="st-soon-t">Carte « à venir » : titre</label><input id="st-soon-t" value="' + esc(c.soon_title) + '"></div>' +
        '<div class="phc-field"><label for="st-soon">Carte « à venir » : texte</label><input id="st-soon" value="' + esc(c.soon_text) + '"></div>' +
        '<div class="phc-row2"><button type="button" class="phc-btn phc-play phc-mini" data-adm-settings>Enregistrer</button></div>' +
        '<p>Les réglages s\'appliquent au prochain chargement de /tv.</p></div>';
    }
    return '';
  }
  function admBusy(btn, p, okMsg) {
    if (btn) { btn.disabled = true; btn.style.opacity = '.6'; }
    return p.then(function () { toast(okMsg); return loadAdmin(); })
      .catch(function (e) { toast('Erreur : ' + e.message); if (btn) { btn.disabled = false; btn.style.opacity = ''; } });
  }
  function valOf(id) { var e = root.querySelector('#' + id); return e ? e.value : ''; }
  root.addEventListener('input', function (e) {
    var id = e.target && e.target.getAttribute && e.target.getAttribute('data-count');
    if (!id) return;
    var c = root.querySelector('[data-count-for="' + id + '"]');
    if (!c) return;
    var n = e.target.value.length;
    c.textContent = n + ' car.';
    c.className = n && (n < +c.getAttribute('data-min') || n > +c.getAttribute('data-max')) ? 'warn' : '';
  });
  root.addEventListener('click', function (e) {
    var t = e.target.closest && e.target.closest('[data-admin],[data-adm-close],[data-adm-tab],[data-adm-refresh],[data-adm-save-video],[data-adm-save-page],[data-adm-index],[data-adm-seo],[data-adm-sync],[data-adm-settings]');
    if (!t) return;
    if (t.hasAttribute('data-admin')) openAdmin();
    else if (t.hasAttribute('data-adm-close')) closeTop();
    else if (t.hasAttribute('data-adm-tab')) { admTab = t.getAttribute('data-adm-tab'); paintAdmin(); }
    else if (t.hasAttribute('data-adm-refresh')) admBusy(t, Promise.resolve(), 'Actualisé');
    else if (t.hasAttribute('data-adm-save-video')) {
      var id = t.getAttribute('data-adm-save-video');
      admBusy(t, adminCall('video_update', { post_id: id, meta_title: valOf('mt-' + id), meta_description: valOf('md-' + id) }), 'Vidéo enregistrée');
    } else if (t.hasAttribute('data-adm-save-page')) {
      var k = t.getAttribute('data-adm-save-page');
      admBusy(t, adminCall('page_update', { page: k, meta_title: valOf('pt-' + k), meta_description: valOf('pd-' + k) }), 'Page enregistrée');
    } else if (t.hasAttribute('data-adm-index')) {
      admBusy(null, adminCall('indexing', { indexable: !!t.checked }), t.checked ? 'Pages visibles dans Google' : 'Pages masquées de Google');
    } else if (t.hasAttribute('data-adm-seo')) admBusy(t, adminCall('seo_apply'), 'Données structurées à jour');
    else if (t.hasAttribute('data-adm-sync')) admBusy(t, adminCall('exclusives_sync'), 'Synchro relancée');
    else if (t.hasAttribute('data-adm-settings')) {
      admBusy(t, adminCall('settings', { catalog: {
        hero_pin: valOf('st-hero'), theme_rows_from: valOf('st-theme'), series_rows_from: valOf('st-series'),
        soon_title: valOf('st-soon-t'), soon_text: valOf('st-soon')
      } }), 'Réglages enregistrés');
    }
  });

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
      listAt = Date.now();
      store('phc-list', myList);
      store('phc-list-at', listAt);
      schedulePush(true);
      var on = inList(id);
      root.querySelectorAll('[data-list="' + id + '"]').forEach(function (b) {
        b.setAttribute('aria-pressed', String(on));
        var u = b.querySelector('use');
        if (u) u.setAttribute('href', on ? '#phc-check' : '#phc-plus');
      });
      if (view === 'list') renderRows();
    } else if (t.hasAttribute('data-cat')) {
      filter = t.getAttribute('data-cat');
      if (view !== 'all') { view = 'home'; setNav('home'); }
      renderAll();
    } else if (t.hasAttribute('data-nav')) {
      view = t.getAttribute('data-nav');
      filter = 'all';
      setNav(view);
      renderAll();
      root.scrollTop = 0;
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
      if (!$('#phc-player', root).hidden || !$('#phc-scrim', root).hidden || !$('#phc-adm', root).hidden) { e.preventDefault(); closeTop(); }
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
  window.addEventListener('pagehide', function () { saveProgress(false); pushNow(true); });
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') { saveProgress(false); pushNow(true); } });

  // ---------------------------------------------------------------------------
  // Démarrage
  // Exclusivité passée sur YouTube : sa progression et sa place dans « Ma liste » suivent le nouvel identifiant
  var legacy = {};
  function migrateLegacy() {
    var moved = false;
    VIDEOS.forEach(function (v) {
      if (!v.was) return;
      legacy[v.was] = v.id;
      if (progress[v.was]) {
        if (!progress[v.id] || (progress[v.was].at || 0) > (progress[v.id].at || 0)) progress[v.id] = progress[v.was];
        delete progress[v.was];
        moved = true;
      }
      var i = myList.indexOf(v.was);
      if (i !== -1) {
        if (myList.indexOf(v.id) === -1) myList[i] = v.id; else myList.splice(i, 1);
        listAt = Date.now();
        moved = true;
      }
    });
    if (moved) {
      store('phc-progress', progress); store('phc-list', myList); store('phc-list-at', listAt);
      schedulePush(true);
    }
    return moved;
  }
  // Lien direct : /tv/?v=<id> ouvre la fiche du documentaire
  function openFromUrl() {
    var want = '';
    try { want = new URLSearchParams(location.search).get('v') || ''; } catch (e) {}
    if (!want) want = decodeURIComponent((/[#&]v=([^&]+)/.exec(location.hash) || [])[1] || '');
    if (!want) return;
    try { history.replaceState(history.state, '', location.pathname); } catch (e) {}
    if (!byId[want] && legacy[want]) want = legacy[want];
    if (byId[want]) openSheet(want);
  }

  loadCatalogue().then(function (videos) {
    VIDEOS = videos;
    VIDEOS.forEach(function (v) { byId[v.id] = v; });
    migrateLegacy();
    shell();
    renderAll();
    openFromUrl();
    initialSync();
    initAdmin();
  }).catch(function (err) {
    root.innerHTML = ICONS + '<div class="phc-loading">Posthumain TV n\'a pas pu se charger. Recharge la page dans un instant.</div>';
    if (window.console) console.warn('[posthumain-tv]', err);
  });
});
