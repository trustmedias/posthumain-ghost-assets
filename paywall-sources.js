/* =============================================================================
 * POSTHUMAIN — paywall-sources.js
 * Popup "Sources verrouillées" : transforme le clic mort sur un appel de note
 * d'une enquête premium (non-abonné) en point de conversion abonnement.
 * -----------------------------------------------------------------------------
 * Hébergement : GitHub → jsDelivr. Référencé en UNE ligne dans
 *   Ghost Admin → Settings → Code injection → Site Footer :
 *
 *   <script src="https://cdn.jsdelivr.net/gh/USER/REPO@v1.0.0/paywall-sources.js" defer></script>
 *
 * Autonome : injecte son propre CSS, aucune dépendance.
 * Détection d'accès : présence/absence de #source-N dans le DOM.
 *   • cible présente  → article gratuit ou abonné → saut d'ancre natif.
 *   • cible absente   → contenu derrière le paywall → popup de conversion.
 * ========================================================================== */
(function () {
  "use strict";

  /* --- Réglages (modifiables) ---------------------------------------------- */
  var SIGNUP_URL = "#/portal/signup";
  var SIGNIN_URL = "#/portal/signin";

  /* --- CSS injecté une seule fois ------------------------------------------ */
  var CSS = [
    ".ph-srcm-overlay{position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(5,5,5,.78);backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px);opacity:0;visibility:hidden;transition:opacity .22s ease,visibility .22s ease}",
    ".ph-srcm-overlay.is-open{opacity:1;visibility:visible}",
    ".ph-srcm-card{position:relative;width:100%;max-width:440px;background:#0f0f0f;border:1px solid rgba(0,255,119,.28);border-radius:0;padding:38px 32px 32px;box-shadow:0 24px 70px rgba(0,0,0,.6),0 0 0 1px rgba(0,255,119,.06) inset;text-align:center;transform:translateY(14px) scale(.98);transition:transform .22s ease;font-family:inherit}",
    ".ph-srcm-overlay.is-open .ph-srcm-card{transform:translateY(0) scale(1)}",
    ".ph-srcm-close{position:absolute;top:12px;right:14px;width:34px;height:34px;display:flex;align-items:center;justify-content:center;padding:0;line-height:1;background:none;border:none;cursor:pointer;color:#888;font-size:24px;border-radius:0;transition:color .15s,background .15s}",
    ".ph-srcm-close:hover{color:#fff;background:rgba(255,255,255,.06)}",
    ".ph-srcm-badge{display:inline-flex;align-items:center;gap:7px;margin-bottom:18px;padding:6px 13px;background:rgba(0,255,119,.10);border:1px solid rgba(0,255,119,.35);border-radius:0;color:#00ff77;font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase}",
    ".ph-srcm-badge svg{width:13px;height:13px}",
    ".ph-srcm-title{margin:0 0 10px;color:#fff;font-size:22px;line-height:1.25;font-weight:800}",
    ".ph-srcm-text{margin:0 0 26px;color:#b4b4b4;font-size:15px;line-height:1.55}",
    ".ph-srcm-text b{color:#e8e8e8}",
    ".ph-srcm-btn{display:block;width:100%;padding:14px 20px;margin-top:10px;border-radius:0;cursor:pointer;font-size:15px;font-weight:700;font-family:inherit;text-decoration:none;border:1px solid transparent;transition:transform .12s ease,background .15s ease,border-color .15s ease}",
    ".ph-srcm-btn:active{transform:translateY(1px)}",
    ".ph-srcm-btn--primary{background:#00ff77;color:#060606!important}",
    ".ph-srcm-btn--primary:hover{background:#46ff9a}",
    ".ph-srcm-btn--ghost{background:transparent;color:#cfcfcf;border-color:rgba(255,255,255,.16)}",
    ".ph-srcm-btn--ghost:hover{color:#fff;border-color:rgba(255,255,255,.32)}",
    ".ph-srcm-btn--ghost b{color:#fff}",
    "@media(max-width:480px){.ph-srcm-card{padding:34px 22px 26px}.ph-srcm-title{font-size:20px}}"
  ].join("");

  var styleInjected = false;
  function injectCSS() {
    if (styleInjected) return;
    var s = document.createElement("style");
    s.id = "ph-srcm-style";
    s.textContent = CSS;
    document.head.appendChild(s);
    styleInjected = true;
  }

  /* --- Modal (construite à la demande, réutilisée) ------------------------- */
  var overlay = null;

  function buildModal() {
    if (overlay) return overlay;
    injectCSS();
    overlay = document.createElement("div");
    overlay.className = "ph-srcm-overlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", "Sources réservées aux abonnés");
    overlay.innerHTML =
      '<div class="ph-srcm-card">' +
        '<button class="ph-srcm-close" aria-label="Fermer">&times;</button>' +
        '<span class="ph-srcm-badge">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>' +
          'Sources verrouillées' +
        '</span>' +
        '<h2 class="ph-srcm-title">La source est réservée aux abonnés</h2>' +
        '<p class="ph-srcm-text">Cette enquête est <b>intégralement sourcée</b>. Les références citées dans le texte font partie du dossier réservé aux abonnés Posthumain.</p>' +
        '<a class="ph-srcm-btn ph-srcm-btn--primary" href="' + SIGNUP_URL + '">Débloquer les sources &mdash; S’abonner</a>' +
        '<a class="ph-srcm-btn ph-srcm-btn--ghost" href="' + SIGNIN_URL + '">Déjà abonné&nbsp;? <b>Se connecter</b></a>' +
      '</div>';
    document.body.appendChild(overlay);

    overlay.addEventListener("click", function (e) {
      if (e.target === overlay || e.target.classList.contains("ph-srcm-close")) {
        closeModal();
      }
    });
    return overlay;
  }

  function openModal() {
    buildModal();
    overlay.offsetHeight; /* reflow → transition */
    overlay.classList.add("is-open");
    document.addEventListener("keydown", onKeydown);
    /* hook analytics optionnel : if (window.plausible) window.plausible('Source paywall hit'); */
  }

  function closeModal() {
    if (!overlay) return;
    overlay.classList.remove("is-open");
    document.removeEventListener("keydown", onKeydown);
  }

  function onKeydown(e) {
    if (e.key === "Escape") closeModal();
  }

  /* --- Interception des clics sur les appels de note ----------------------- *
   * FIX : les appels de note réels sont rendus `[<a href="#source-N">N</a>]`
   * (cf. style-guide.md). L'ancien sélecteur `a[data-ph-source]` ne matchait
   * donc AUCUN lien → le popup ne s'ouvrait jamais. On cible désormais le lien
   * par son href `#source-N`, et on lit N depuis le href (fallback sur
   * data-ph-source pour rester compatible si l'attribut existe).
   * --------------------------------------------------------------------------*/
  document.addEventListener("click", function (e) {
    if (!e.target.closest) return;

    var link = e.target.closest('a[href^="#source-"], a[data-ph-source]');
    if (!link) return;

    /* Numéro de la source : depuis le href, sinon depuis data-ph-source. */
    var n = null;
    var href = link.getAttribute("href") || "";
    var m = href.match(/^#source-(\w+)$/);
    if (m) {
      n = m[1];
    } else if (link.hasAttribute("data-ph-source")) {
      n = link.getAttribute("data-ph-source");
    }
    if (!n) return;

    /* Cible présente (article gratuit / abonné) → laisser le saut d'ancre natif. */
    if (document.getElementById("source-" + n)) return;

    /* Cible absente (contenu derrière le paywall) → popup de conversion. */
    e.preventDefault();
    openModal();
  }, false);
})();
