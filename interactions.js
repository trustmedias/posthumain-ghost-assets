/* =============================================================================
 * POSTHUMAIN — interactions.js
 * Fonctions interactives des articles (web uniquement, l'email reste en texte).
 * -----------------------------------------------------------------------------
 * Chargé en UNE ligne dans Ghost Admin → Settings → Code injection → Site Footer :
 *   <script src="https://cdn.jsdelivr.net/gh/trustmedias/posthumain-ghost-assets@main/interactions.js" defer></script>
 *
 * Autonome : injecte son propre CSS, aucune dépendance.
 *
 * 1. ENCARTS PROMPT  —  <div class="ph-prompt" data-ph-prompt="Libellé">…</div>
 *    Dans l'article (carte HTML Ghost), le prompt est écrit en TEXTE simple avec
 *    des styles inline : c'est ce que reçoit l'email (pas de bloc code en email).
 *    Sur le site, ce script le transforme en encart « terminal » avec bouton
 *    Copier → Copié. Les [CROCHETS] à remplacer sont surlignés.
 *    Format attendu (écrit par l'usine n8n / les skills) :
 *      <!--kg-card-begin: html-->
 *      <div class="ph-prompt" data-ph-prompt="Prompt · Caution non rendue" style="…">
 *        <p data-ph-label style="…"><strong>Prompt à copier</strong></p>
 *        <p style="…">Tu es…<br>Ligne 2…</p>
 *      </div>
 *      <!--kg-card-end: html-->
 *
 * 2. BLOCS CODE  —  toute carte code Ghost (<pre><code>) reçoit le même habillage
 *    terminal + bouton Copier (le langage s'affiche en libellé). Exclus : schémas
 *    en caractères de dessin, blocs au « langage » libre, et tout ce qui est dans
 *    un élément [data-ph-nocopy].
 *
 * 3. ANCIENS ARTICLES  —  les paragraphes « <strong>Demande à copier</strong> :
 *    <em>« … »</em> » (format utilisé jusqu'au 15/10/2026) sont aussi convertis,
 *    sans retoucher les articles dans Ghost.
 *
 * 4. ÉTIQUETTE « VIDÉO »  —  sur TOUTES les pages (accueil, catégories, « latest »,
 *    articles liés…), chaque carte d'article qui mène à une page Vidéos
 *    (lien /videos/…, versions longues YouTube) reçoit une pastille rouge
 *    « ▶ VIDÉO » en haut à droite de sa miniature, pour qu'on ne la prenne pas
 *    pour un article. Pur CSS (pseudo-élément en position absolue) : aucun
 *    décalage de mise en page, marche aussi pour les cartes chargées ensuite.
 *
 * Copie : API Clipboard, sinon repli textarea + execCommand (iOS ancien,
 * navigateurs intégrés Facebook / Instagram), sinon le texte est sélectionné
 * et le bouton invite à copier à la main. Un évènement « ph:copy » est émis
 * sur document à chaque copie (pour une future mesure d'usage).
 * ========================================================================== */
(function () {
  "use strict";

  if (window.__phInteractions) return;
  window.__phInteractions = true;

  var ROOT_SELECTOR = ".gh-content, .post-content, .article-content";
  var COPIED_MS = 2200;

  /* --- CSS ------------------------------------------------------------------ */
  var CSS = [
    ".ph-term{position:relative;margin:2em 0;background:#0b0f0d;border:1px solid rgba(0,255,119,.28);border-radius:6px;overflow:hidden;box-shadow:0 10px 30px rgba(0,0,0,.35);color:#e6efe9;font-size:16px;line-height:1.6;max-width:100%;box-sizing:border-box}",
    ".ph-term *{box-sizing:border-box}",
    ".ph-term-head{display:flex;align-items:center;gap:10px;min-height:46px;padding:0 6px 0 14px;background:#131915;border-bottom:1px solid rgba(0,255,119,.16)}",
    ".ph-term-dots{display:flex;gap:6px;flex:0 0 auto}",
    ".ph-term-dots i{display:block;width:10px;height:10px;border-radius:50%;background:#2a332e}",
    ".ph-term-dots i:first-child{background:#00ff77;opacity:.85}",
    ".ph-term-label{flex:1 1 auto;min-width:0;padding:9px 0;line-height:1.35;white-space:normal;overflow-wrap:anywhere;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,\"Liberation Mono\",monospace;font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#00ff77}",
    ".ph-term-copy{flex:0 0 auto;display:inline-flex!important;align-items:center;justify-content:center;gap:7px;min-width:44px;min-height:36px!important;height:auto!important;margin:5px 0!important;padding:0 12px!important;background:rgba(0,255,119,.10)!important;border:1px solid rgba(0,255,119,.4)!important;border-radius:4px!important;box-shadow:none!important;color:#00ff77!important;font:700 12.5px/1 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace!important;letter-spacing:.06em!important;text-transform:uppercase!important;cursor:pointer;-webkit-tap-highlight-color:transparent;touch-action:manipulation;transition:background .15s,color .15s,border-color .15s}",
    ".ph-term-copy:hover{background:rgba(0,255,119,.2)!important}",
    ".ph-term-copy:focus-visible{outline:2px solid #00ff77;outline-offset:2px}",
    ".ph-term-copy svg{width:15px;height:15px;flex:0 0 auto}",
    ".ph-term-copy .ph-ic-ok{display:none}",
    ".ph-term-copy.is-copied,.ph-term-copy.is-copied:hover{background:#00ff77!important;border-color:#00ff77!important;color:#060606!important;transition:none!important}",
    ".ph-term-copy.is-copied .ph-ic-copy{display:none}",
    ".ph-term-copy.is-copied .ph-ic-ok{display:block}",
    ".ph-term-copy.is-manual{background:transparent!important;color:#e6efe9!important;border-color:rgba(255,255,255,.3)!important}",
    ".ph-term-body{margin:0;padding:16px 18px 18px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,\"Liberation Mono\",monospace;font-size:14.5px;line-height:1.65;color:#e6efe9;white-space:normal;overflow-wrap:anywhere;word-break:normal}",
    ".ph-term-body p{margin:0 0 .9em!important;padding:0!important;font:inherit!important;color:inherit!important;background:none!important;border:0!important}",
    ".ph-term-body p:last-child{margin-bottom:0!important}",
    ".ph-term-body strong,.ph-term-body b{color:#fff}",
    ".ph-term-body ul,.ph-term-body ol{margin:0 0 .9em;padding-left:1.4em}",
    ".ph-term-body li{margin:0 0 .25em;font:inherit}",
    ".ph-term--prompt .ph-term-body>:first-child::before{content:\"> \";color:#00ff77;font-weight:700}",
    ".ph-term-ph{color:#ffd166;background:rgba(255,209,102,.10);border-radius:3px;padding:0 2px}",
    ".ph-term pre{margin:0!important;padding:16px 18px!important;background:transparent!important;border:0!important;border-radius:0!important;max-width:100%;overflow-x:auto;-webkit-overflow-scrolling:touch;font-size:14px!important;line-height:1.6!important;color:#e6efe9!important}",
    ".ph-term pre code{background:transparent!important;padding:0!important;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,\"Liberation Mono\",monospace!important;font-size:inherit!important;color:inherit!important;white-space:pre}",
    ".ph-term-live{position:absolute!important;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}",
    "@media(max-width:600px){.ph-term{margin:1.6em 0;border-radius:4px}.ph-term-body{padding:14px 14px 16px;font-size:14px}.ph-term pre{padding:14px!important;font-size:13px!important}.ph-term-copy{min-height:40px}.ph-term-label{font-size:11px}}",
    "@media(prefers-reduced-motion:reduce){.ph-term-copy{transition:none}}",
    "@media print{.ph-term{box-shadow:none;background:#fff;color:#000;border-color:#999}.ph-term-head{display:none}.ph-term-body,.ph-term pre{color:#000!important}}"
  ].join("");

  var ICON_COPY = '<svg class="ph-ic-copy" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/></svg>';
  var ICON_OK = '<svg class="ph-ic-ok" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';

  function injectCSS() {
    if (document.getElementById("ph-interactions-style")) return;
    var s = document.createElement("style");
    s.id = "ph-interactions-style";
    s.textContent = CSS;
    (document.head || document.documentElement).appendChild(s);
  }

  /* --- Copie fiable --------------------------------------------------------- */
  function legacyCopy(text) {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    // 16px : évite le zoom iOS ; hors écran mais sélectionnable
    ta.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;padding:0;border:0;opacity:0;font-size:16px;";
    document.body.appendChild(ta);
    var ok = false;
    try {
      ta.focus({ preventScroll: true });
    } catch (e) { ta.focus(); }
    ta.select();
    try { ta.setSelectionRange(0, text.length); } catch (e) {}
    try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    return ok;
  }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).then(
        function () { return true; },
        function () { return legacyCopy(text); }
      );
    }
    return Promise.resolve(legacyCopy(text));
  }

  function selectNode(node) {
    try {
      var sel = window.getSelection();
      var r = document.createRange();
      r.selectNodeContents(node);
      sel.removeAllRanges();
      sel.addRange(r);
    } catch (e) {}
  }

  /* --- Texte à copier ------------------------------------------------------- */
  function textOf(el) {
    // innerText respecte <br> et paragraphes ; repli textContent si non rendu
    var t = (typeof el.innerText === "string" && el.innerText) ? el.innerText : el.textContent;
    return t
      .replace(/ /g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  /* --- Surlignage des [CROCHETS] ------------------------------------------- */
  function highlightPlaceholders(root) {
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null, false);
    var nodes = [];
    var n;
    while ((n = walker.nextNode())) {
      if (/\[[^\]\n]{1,80}\]/.test(n.nodeValue)) nodes.push(n);
    }
    nodes.forEach(function (node) {
      var frag = document.createDocumentFragment();
      var parts = node.nodeValue.split(/(\[[^\]\n]{1,80}\])/);
      parts.forEach(function (p) {
        if (!p) return;
        if (/^\[[^\]\n]{1,80}\]$/.test(p)) {
          var sp = document.createElement("span");
          sp.className = "ph-term-ph";
          sp.textContent = p;
          frag.appendChild(sp);
        } else {
          frag.appendChild(document.createTextNode(p));
        }
      });
      node.parentNode.replaceChild(frag, node);
    });
  }

  /* --- Construction d'un encart --------------------------------------------- */
  var liveRegion = null;
  function announce(msg) {
    if (!liveRegion) {
      liveRegion = document.createElement("div");
      liveRegion.className = "ph-term-live";
      liveRegion.setAttribute("aria-live", "polite");
      document.body.appendChild(liveRegion);
    }
    liveRegion.textContent = "";
    setTimeout(function () { liveRegion.textContent = msg; }, 30);
  }

  function makeShell(label, kind) {
    var box = document.createElement("div");
    box.className = "ph-term ph-term--" + kind;
    box.setAttribute("data-ph-enhanced", "1");

    var head = document.createElement("div");
    head.className = "ph-term-head";
    head.innerHTML = '<span class="ph-term-dots" aria-hidden="true"><i></i><i></i><i></i></span>';

    var lab = document.createElement("span");
    lab.className = "ph-term-label";
    lab.textContent = label;
    head.appendChild(lab);

    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ph-term-copy";
    btn.setAttribute("aria-label", kind === "code" ? "Copier le code" : "Copier le prompt");
    btn.innerHTML = ICON_COPY + ICON_OK + '<span class="ph-term-copy-txt">Copier</span>';
    head.appendChild(btn);

    box.appendChild(head);
    return { box: box, btn: btn };
  }

  function wireCopy(btn, target, kind) {
    var timer = null;
    var txt = btn.querySelector(".ph-term-copy-txt");
    function reset() {
      btn.classList.remove("is-copied", "is-manual");
      txt.textContent = "Copier";
    }
    btn.addEventListener("click", function () {
      var text = textOf(target);
      copyText(text).then(function (ok) {
        clearTimeout(timer);
        if (ok) {
          btn.classList.remove("is-manual");
          btn.classList.add("is-copied");
          txt.textContent = "Copié";
          announce(kind === "code" ? "Code copié" : "Prompt copié");
          try {
            document.dispatchEvent(new CustomEvent("ph:copy", { detail: { kind: kind, length: text.length, label: btn.parentNode.querySelector(".ph-term-label").textContent } }));
          } catch (e) {}
        } else {
          selectNode(target);
          btn.classList.add("is-manual");
          txt.textContent = "Texte sélectionné";
          announce("Texte sélectionné, utilisez Copier");
        }
        timer = setTimeout(reset, COPIED_MS);
      });
    });
  }

  /* 1. Encarts prompt écrits par l'usine ------------------------------------ */
  function enhancePrompt(el) {
    if (el.getAttribute("data-ph-enhanced")) return;
    var label = (el.getAttribute("data-ph-prompt") || "").trim() || "Prompt à copier";
    var shell = makeShell(label, "prompt");

    var body = document.createElement("div");
    body.className = "ph-term-body";
    Array.prototype.slice.call(el.childNodes).forEach(function (c) {
      if (c.nodeType === 1 && c.hasAttribute("data-ph-label")) return; // libellé email
      if (c.nodeType === 1) c.removeAttribute("style");
      if (c.nodeType === 1) Array.prototype.forEach.call(c.querySelectorAll("[style]"), function (x) { x.removeAttribute("style"); });
      body.appendChild(c);
    });
    highlightPlaceholders(body);
    shell.box.appendChild(body);
    wireCopy(shell.btn, body, "prompt");
    el.parentNode.replaceChild(shell.box, el);
  }

  /* 2. Cartes code Ghost ---------------------------------------------------- */
  function enhanceCode(pre) {
    if (pre.closest(".ph-term") || pre.closest("[data-ph-nocopy]")) return;
    var code = pre.querySelector("code") || pre;
    // Pas de bouton Copier sur ce qui n'est pas du code : schéma en caractères de dessin
    // (┌─┐…) ou bloc dont le « langage » est un libellé libre (ex. « Schéma simplifié »).
    var raw = ((code.className || "").match(/language-(\S+)/) || [])[1] || "";
    if (/[\u2500-\u259F]/.test(pre.textContent) || (raw && !/^[\w+#.-]+$/.test(raw))) return;
    var lang = raw;
    var label = lang ? (lang === "prompt" || lang === "text" || lang === "plaintext" ? "Prompt à copier" : lang) : "Code";
    var shell = makeShell(label, "code");
    var host = pre.parentNode && pre.parentNode.classList && pre.parentNode.classList.contains("kg-code-card") ? pre.parentNode : pre;
    host.parentNode.insertBefore(shell.box, host);
    shell.box.appendChild(pre);
    if (host !== pre) {
      // carte Ghost avec légende éventuelle : on la garde sous l'encart
      var cap = host.querySelector("figcaption");
      if (cap) shell.box.parentNode.insertBefore(cap, shell.box.nextSibling);
      host.parentNode.removeChild(host);
    }
    wireCopy(shell.btn, code, "code");
  }

  /* 3. Ancien format « <strong>Demande à copier</strong> : <em>« … »</em> » -- */
  var LEGACY_LABEL = /(demande|prompt|cadre|requ[eê]te|commande|message|consigne)[^]{0,40}(à copier|à coller)\s*:?\s*$/i;
  function enhanceLegacy(p) {
    if (p.closest(".ph-term")) return;
    var first = p.firstElementChild;
    if (!first || !/^(STRONG|B)$/.test(first.tagName)) return;
    // le <strong> doit ouvrir le paragraphe
    var before = "";
    for (var n = p.firstChild; n && n !== first; n = n.nextSibling) before += n.textContent;
    if (before.trim()) return;
    var labelTxt = first.textContent.trim();
    if (!LEGACY_LABEL.test(labelTxt)) return;
    var em = p.querySelector("em, i");
    if (!em) return;
    var promptTxt = em.textContent.trim().replace(/^[«"“]\s*/, "").replace(/\s*[»"”]$/, "");
    if (promptTxt.length < 40) return;

    // texte d'intro entre le libellé et le prompt (« en début de conversation : »)
    var intro = "";
    for (var k = first.nextSibling; k && k !== em; k = k.nextSibling) intro += k.textContent;
    intro = intro.replace(/^\s*:?\s*/, "").replace(/\s*:?\s*$/, "").trim();
    var after = "";
    for (var a = em.nextSibling; a; a = a.nextSibling) after += a.textContent;
    after = after.trim();

    var label = labelTxt.replace(/\s*:?\s*$/, "");
    var shell = makeShell(intro ? label + " · " + intro : label, "prompt");
    var body = document.createElement("div");
    body.className = "ph-term-body";
    var bp = document.createElement("p");
    bp.textContent = promptTxt;
    body.appendChild(bp);
    highlightPlaceholders(body);
    shell.box.appendChild(body);
    wireCopy(shell.btn, body, "prompt");

    p.parentNode.insertBefore(shell.box, p);
    if (after) {
      var ap = document.createElement("p");
      ap.textContent = after;
      shell.box.parentNode.insertBefore(ap, shell.box.nextSibling);
    }
    p.parentNode.removeChild(p);
  }

  /* --- 4. Étiquette « VIDÉO » sur les cartes (toutes les pages) ------------- */
  var VIDEO_BADGE_CSS = [
    "a.gh-card-link[href*=\"/videos/\"] .gh-card-image{position:relative}",
    "a.gh-card-link[href*=\"/videos/\"] .gh-card-image::after{content:\"\\25B6\\FE0E\\00A0\\00A0VID\\00C9O\";position:absolute;top:8px;right:8px;z-index:2;padding:5px 8px 4px 7px;border-radius:4px;background:#ff0033;color:#fff;font:700 11px/1 \"Fira Mono\",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:.08em;text-transform:uppercase;box-shadow:0 2px 10px rgba(0,0,0,.45);pointer-events:none;white-space:nowrap}",
    "@media(max-width:600px){a.gh-card-link[href*=\"/videos/\"] .gh-card-image::after{top:6px;right:6px;padding:4px 6px 3px 5px;font-size:10px}}",
    "@media print{a.gh-card-link[href*=\"/videos/\"] .gh-card-image::after{display:none}}"
  ].join("");
  function injectVideoBadge() {
    if (document.getElementById("ph-video-badge-style")) return;
    var s = document.createElement("style");
    s.id = "ph-video-badge-style";
    s.textContent = VIDEO_BADGE_CSS;
    (document.head || document.documentElement).appendChild(s);
  }
  try { injectVideoBadge(); } catch (e) {}

  /* --- Lancement ------------------------------------------------------------ */
  function run() {
    var roots = document.querySelectorAll(ROOT_SELECTOR);
    if (!roots.length) return;
    var any = false;
    Array.prototype.forEach.call(roots, function (root) {
      var prompts = root.querySelectorAll(".ph-prompt, [data-ph-prompt]");
      var pres = root.querySelectorAll("pre");
      var paras = root.querySelectorAll("p > strong:first-child, p > b:first-child");
      if (prompts.length || pres.length || paras.length) any = true;
      if (!any) return;
      injectCSS();
      Array.prototype.forEach.call(prompts, function (el) { try { enhancePrompt(el); } catch (e) {} });
      Array.prototype.forEach.call(pres, function (el) { try { enhanceCode(el); } catch (e) {} });
      Array.prototype.forEach.call(paras, function (s) { try { enhanceLegacy(s.parentNode); } catch (e) {} });
    });
  }

  window.PHInteractions = { refresh: run };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run);
  else run();
})();
