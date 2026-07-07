/* =============================================================================
 * POSTHUMAIN — newsletter-popup.js
 * Popup d'inscription newsletter : convertit les visiteurs (réseaux sociaux)
 * en inscrits. Enregistre l'email dans Airtable via un webhook n8n ; le
 * workflow n8n d'inscription Ghost prend ensuite le relais (zéro friction,
 * pas de double confirmation email).
 * -----------------------------------------------------------------------------
 * Hébergement : GitHub → jsDelivr. Référencé en UNE ligne dans
 *   Ghost Admin → Settings → Code injection → Site Footer :
 *
 *   <script src="https://cdn.jsdelivr.net/gh/trustmedias/posthumain-ghost-assets@main/newsletter-popup.js" defer></script>
 *
 * Autonome : injecte son propre CSS, aucune dépendance.
 * Règles d'affichage :
 *   • déclenché après SCROLL_TRIGGER_PERCENT % de scroll (ou exit-intent desktop),
 *     et jamais avant MIN_TIME_ON_PAGE_MS sur la page ;
 *   • max 1 affichage tous les COOLDOWN_DAYS jours (localStorage) ;
 *   • plus jamais après inscription réussie, ni pour les membres Ghost connectés ;
 *   • ne s'affiche pas par-dessus le popup paywall (paywall-sources.js).
 * ========================================================================== */
(function () {
  "use strict";

  /* --- Réglages (modifiables) ---------------------------------------------- */
  var WEBHOOK_URL = "https://trustmedias.app.n8n.cloud/webhook/ph-newsletter-signup";
  var COOLDOWN_DAYS = 120;          /* jours avant de re-proposer après fermeture   */
  var SCROLL_TRIGGER_PERCENT = 15;  /* % de scroll qui déclenche (15–20 conseillé)  */
  var MIN_TIME_ON_PAGE_MS = 5000;   /* temps mini sur la page avant éligibilité     */
  var EXIT_INTENT = true;           /* déclencheur secondaire : souris qui sort en  */
                                    /* haut de la fenêtre (desktop uniquement)      */
  var EXCLUDED_PATHS = [];          /* préfixes de chemins à exclure, ex. "/merci"  */
  var STORAGE_KEY = "ph-nl-state";

  /* --- Garde-fous ----------------------------------------------------------- */
  if (window.top !== window.self) return;            /* pas dans un iframe (previews) */
  if (window.__phNlLoaded) return;                   /* pas deux fois                 */
  window.__phNlLoaded = true;

  var path = location.pathname;
  for (var i = 0; i < EXCLUDED_PATHS.length; i++) {
    if (path.indexOf(EXCLUDED_PATHS[i]) === 0) return;
  }

  /* --- État persistant (localStorage, avec repli mémoire) ------------------- */
  function readState() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}; }
    catch (e) { return window.__phNlMem || {}; }
  }
  function writeState(patch) {
    var s = readState();
    for (var k in patch) s[k] = patch[k];
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); }
    catch (e) { window.__phNlMem = s; }
  }
  function isEligible() {
    var s = readState();
    if (s.subscribed) return false;
    if (s.lastShownAt && Date.now() - s.lastShownAt < COOLDOWN_DAYS * 864e5) return false;
    return true;
  }

  /* --- Mémorisation des UTM (survivent à la navigation interne) ------------- */
  var UTM_KEY = "ph-nl-utm";
  (function captureUtm() {
    try {
      var q = new URLSearchParams(location.search);
      if (q.get("utm_source") || q.get("utm_medium") || q.get("utm_campaign")) {
        sessionStorage.setItem(UTM_KEY, JSON.stringify({
          utm_source: q.get("utm_source") || "",
          utm_medium: q.get("utm_medium") || "",
          utm_campaign: q.get("utm_campaign") || ""
        }));
      }
    } catch (e) {}
  })();
  function readUtm() {
    try { return JSON.parse(sessionStorage.getItem(UTM_KEY)) || {}; }
    catch (e) { return {}; }
  }

  /* --- CSS injecté une seule fois (mêmes tokens que paywall-sources.js) ----- */
  var CSS = [
    ".ph-nl-overlay{position:fixed;inset:0;z-index:99998;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(5,5,5,.78);backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px);opacity:0;visibility:hidden;transition:opacity .25s ease,visibility .25s ease}",
    ".ph-nl-overlay.is-open{opacity:1;visibility:visible}",
    ".ph-nl-card{position:relative;width:100%;max-width:460px;background:#0f0f0f;border:1px solid rgba(0,255,119,.28);border-radius:0;padding:40px 34px 30px;box-shadow:0 24px 70px rgba(0,0,0,.6),0 0 0 1px rgba(0,255,119,.06) inset;text-align:center;transform:translateY(16px) scale(.98);transition:transform .25s ease;font-family:inherit}",
    ".ph-nl-overlay.is-open .ph-nl-card{transform:translateY(0) scale(1)}",
    ".ph-nl-close{position:absolute;top:8px;right:8px;width:44px;height:44px;display:flex;align-items:center;justify-content:center;padding:0;line-height:1;background:none;border:none;cursor:pointer;color:#888;font-size:26px;border-radius:0;transition:color .15s,background .15s}",
    ".ph-nl-close:hover{color:#fff;background:rgba(255,255,255,.06)}",
    ".ph-nl-badge{display:inline-flex;align-items:center;gap:7px;margin-bottom:18px;padding:6px 13px;background:rgba(0,255,119,.10);border:1px solid rgba(0,255,119,.35);border-radius:0;color:#00ff77;font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase}",
    ".ph-nl-badge svg{width:13px;height:13px}",
    ".ph-nl-title{margin:0 0 10px;color:#fff;font-size:24px;line-height:1.22;font-weight:800}",
    ".ph-nl-title em{font-style:normal;color:#00ff77}",
    ".ph-nl-text{margin:0 0 24px;color:#b4b4b4;font-size:15px;line-height:1.55}",
    ".ph-nl-text b{color:#e8e8e8}",
    ".ph-nl-form{display:flex;flex-direction:column;gap:10px}",
    ".ph-nl-input{box-sizing:border-box;width:100%;padding:14px 16px;background:#060606;border:1px solid rgba(255,255,255,.16);border-radius:0;color:#fff;font-size:16px;font-family:inherit;transition:border-color .15s,box-shadow .15s}",
    ".ph-nl-input::placeholder{color:#6f6f6f}",
    ".ph-nl-input:focus{outline:none;border-color:rgba(0,255,119,.6);box-shadow:0 0 0 1px rgba(0,255,119,.35)}",
    ".ph-nl-input.is-invalid{border-color:rgba(255,95,86,.7)}",
    ".ph-nl-btn{display:block;width:100%;min-height:48px;padding:14px 20px;border-radius:0;cursor:pointer;font-size:15px;font-weight:700;font-family:inherit;border:1px solid transparent;background:#00ff77;color:#060606!important;transition:transform .12s ease,background .15s ease,opacity .15s ease}",
    ".ph-nl-btn:hover{background:#46ff9a}",
    ".ph-nl-btn:active{transform:translateY(1px)}",
    ".ph-nl-btn[disabled]{opacity:.55;cursor:default;transform:none}",
    ".ph-nl-error{margin:0;min-height:18px;color:#ff5f56;font-size:13px;line-height:1.4}",
    ".ph-nl-note{margin:16px 0 0;color:#8f8f8f;font-size:13px;line-height:1.5}",
    ".ph-nl-hp{position:absolute!important;left:-9999px!important;width:1px;height:1px;opacity:0;pointer-events:none}",
    ".ph-nl-success{display:none}",
    ".ph-nl-card.is-success .ph-nl-success{display:block}",
    ".ph-nl-card.is-success .ph-nl-main{display:none}",
    ".ph-nl-check{width:52px;height:52px;margin:6px auto 16px;color:#00ff77}",
    ".ph-nl-check svg{width:100%;height:100%}",
    "@media(max-width:480px){.ph-nl-overlay{padding:0;align-items:flex-end}.ph-nl-card{max-width:100%;border-left:none;border-right:none;border-bottom:none;padding:34px 22px calc(26px + env(safe-area-inset-bottom));transform:translateY(60px)}.ph-nl-title{font-size:21px}}",
    "@media(prefers-reduced-motion:reduce){.ph-nl-overlay,.ph-nl-card{transition:none}}"
  ].join("");

  var styleInjected = false;
  function injectCSS() {
    if (styleInjected) return;
    var s = document.createElement("style");
    s.id = "ph-nl-style";
    s.textContent = CSS;
    document.head.appendChild(s);
    styleInjected = true;
  }

  /* --- Modal (construite à la demande, réutilisée) --------------------------- */
  var overlay = null;
  var isOpen = false;

  function buildModal() {
    if (overlay) return overlay;
    injectCSS();
    overlay = document.createElement("div");
    overlay.className = "ph-nl-overlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", "Inscription à la newsletter Posthumain");
    overlay.innerHTML =
      '<div class="ph-nl-card">' +
        '<button type="button" class="ph-nl-close" aria-label="Fermer">&times;</button>' +
        '<div class="ph-nl-main">' +
          '<span class="ph-nl-badge">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z"/></svg>' +
            'Newsletter Posthumain' +
          '</span>' +
          '<h2 class="ph-nl-title">Comprenez le futur <em>avant les autres.</em></h2>' +
          '<p class="ph-nl-text">Chaque jour, nos enquêtes sur l&rsquo;IA, la longévité et l&rsquo;humain augmenté&nbsp;&mdash; dans votre boîte mail.</p>' +
          '<form class="ph-nl-form" novalidate>' +
            '<input class="ph-nl-input" type="email" name="email" placeholder="votre@email.com" autocomplete="email" inputmode="email" aria-label="Votre adresse email" required>' +
            '<input class="ph-nl-hp" type="text" name="website" tabindex="-1" autocomplete="off" aria-hidden="true">' +
            '<button class="ph-nl-btn" type="submit">Je m&rsquo;abonne</button>' +
            '<p class="ph-nl-error" role="alert" aria-live="polite"></p>' +
          '</form>' +
          '<p class="ph-nl-note">Zéro spam. Un clic pour partir.</p>' +
        '</div>' +
        '<div class="ph-nl-success">' +
          '<div class="ph-nl-check">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m8.5 12.5 2.5 2.5 5-6"/></svg>' +
          '</div>' +
          '<h2 class="ph-nl-title">Bienvenue à bord.</h2>' +
          '<p class="ph-nl-text">Vous y êtes. Rendez-vous très vite dans votre boîte mail.</p>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);

    overlay.addEventListener("click", function (e) {
      if (e.target === overlay || e.target.closest(".ph-nl-close")) closeModal();
    });
    overlay.querySelector(".ph-nl-form").addEventListener("submit", onSubmit);
    return overlay;
  }

  function openModal() {
    buildModal();
    isOpen = true;
    writeState({ lastShownAt: Date.now() });     /* compte comme "vu", même sans fermeture */
    document.documentElement.style.overflow = "hidden";
    overlay.offsetHeight; /* reflow → transition */
    overlay.classList.add("is-open");
    document.addEventListener("keydown", onKeydown, true);
    setTimeout(function () {
      var input = overlay.querySelector(".ph-nl-input");
      if (input) input.focus({ preventScroll: true });
    }, 280);
    if (window.plausible) window.plausible("Newsletter popup shown");
  }

  function closeModal() {
    if (!overlay || !isOpen) return;
    isOpen = false;
    overlay.classList.remove("is-open");
    document.documentElement.style.overflow = "";
    document.removeEventListener("keydown", onKeydown, true);
  }

  function onKeydown(e) {
    if (!isOpen) return;
    if (e.key === "Escape") { closeModal(); return; }
    /* piège à focus : Tab reste dans la carte */
    if (e.key === "Tab") {
      var focusables = overlay.querySelectorAll("button:not([disabled]), input:not(.ph-nl-hp)");
      if (!focusables.length) return;
      var first = focusables[0], last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }

  /* --- Soumission ------------------------------------------------------------ */
  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

  function onSubmit(e) {
    e.preventDefault();
    var form = e.target;
    var input = form.querySelector(".ph-nl-input");
    var btn = form.querySelector(".ph-nl-btn");
    var errorEl = form.querySelector(".ph-nl-error");
    var email = (input.value || "").trim().toLowerCase();

    input.classList.remove("is-invalid");
    errorEl.textContent = "";

    if (!EMAIL_RE.test(email)) {
      input.classList.add("is-invalid");
      errorEl.textContent = "Hmm, cette adresse ne semble pas valide.";
      input.focus();
      return;
    }

    btn.disabled = true;
    var btnLabel = btn.textContent;
    btn.textContent = "Inscription…";

    var utm = readUtm();
    var payload = {
      email: email,
      website: form.querySelector(".ph-nl-hp").value || "",  /* honeypot */
      page: location.href,
      referrer: document.referrer || "",
      utm_source: utm.utm_source || "",
      utm_medium: utm.utm_medium || "",
      utm_campaign: utm.utm_campaign || ""
    };

    var ctrl = ("AbortController" in window) ? new AbortController() : null;
    var timer = ctrl && setTimeout(function () { ctrl.abort(); }, 12000);

    fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: ctrl ? ctrl.signal : undefined
    }).then(function (res) {
      if (timer) clearTimeout(timer);
      if (!res.ok) throw new Error("HTTP " + res.status);
      writeState({ subscribed: true });
      overlay.querySelector(".ph-nl-card").classList.add("is-success");
      if (window.plausible) window.plausible("Newsletter signup");
      setTimeout(closeModal, 3500);
    }).catch(function () {
      if (timer) clearTimeout(timer);
      btn.disabled = false;
      btn.textContent = btnLabel;
      errorEl.textContent = "Petit souci de connexion. Réessayez dans un instant.";
    });
  }

  /* --- Membres Ghost : déjà connecté → pas de popup ---------------------------- *
   * Ghost répond 204 (vide) pour un visiteur ANONYME et 200 + JSON du membre
   * pour un membre connecté : seul un 200 avec un email compte comme membre.    */
  function checkNotMember() {
    return fetch("/members/api/member", { credentials: "same-origin" })
      .then(function (res) {
        if (!res.ok || res.status === 204) return true;   /* anonyme → afficher */
        return res.json().then(function (m) {
          return !(m && m.email);                          /* membre → masquer  */
        }).catch(function () { return true; });
      })
      .catch(function () { return true; });  /* en cas de doute, on affiche */
  }

  /* --- Déclencheurs ----------------------------------------------------------- */
  var armedAt = Date.now();
  var triggered = false;
  var pendingTimer = null;

  function tryTrigger() {
    if (triggered || isOpen) return;
    /* condition remplie trop tôt → re-vérifier quand le temps mini est écoulé */
    var remaining = MIN_TIME_ON_PAGE_MS - (Date.now() - armedAt);
    if (remaining > 0) {
      if (!pendingTimer) {
        pendingTimer = setTimeout(function () { pendingTimer = null; tryTrigger(); }, remaining + 50);
      }
      return;
    }
    if (!isEligible()) { teardown(); return; }
    /* ne pas s'empiler sur le popup paywall */
    var paywall = document.querySelector(".ph-srcm-overlay.is-open");
    if (paywall) return;
    triggered = true;
    checkNotMember().then(function (show) {
      if (show) openModal();
      teardown();
    });
  }

  function scrollPercent() {
    var doc = document.documentElement;
    var scrollable = (doc.scrollHeight - window.innerHeight);
    if (scrollable <= 0) return 0;
    return (window.pageYOffset || doc.scrollTop || 0) / scrollable * 100;
  }

  function onScroll() {
    if (scrollPercent() >= SCROLL_TRIGGER_PERCENT) tryTrigger();
  }

  function onMouseOut(e) {
    if (!EXIT_INTENT) return;
    if (e.clientY <= 0 && !e.relatedTarget) tryTrigger();
  }

  function teardown() {
    window.removeEventListener("scroll", onScroll);
    document.removeEventListener("mouseout", onMouseOut);
  }

  if (!isEligible()) return;
  window.addEventListener("scroll", onScroll, { passive: true });
  if (EXIT_INTENT && window.matchMedia && window.matchMedia("(pointer:fine)").matches) {
    document.addEventListener("mouseout", onMouseOut);
  }
})();
