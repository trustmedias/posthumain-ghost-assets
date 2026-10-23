/* Posthumain — briques communes des labs (shared/lab-core.js), 22/10/2026.
   Writinglab et Videolab partagent ici tout ce qui ne dépend pas de leur métier : échappement et liens sûrs, jeton du membre
   Ghost, appels aux fonctions Supabase, boutons « occupés » (anti double-clic), fenêtre de confirmation, toasts, mode
   clair/sombre, défilement conservé, retour sur l'onglet, et la porte de couloir qui mène d'un lab à l'autre.
   Une amélioration faite ici profite aux deux labs.

   Comment il arrive dans la page : le webhook n8n de chaque lab renvoie son application en la faisant précéder de ce
   fichier, lu sur la branche main (aucune exécution n8n de plus, toujours à jour, pas de version à épingler).
   Les styles sont fournis en morceaux (PHLab.cssParts) que chaque lab insère à leur place dans sa propre feuille : ils
   passent ainsi par sa feuille claire dérivée (PHTheme.deriverClair) comme le reste.

   API (window.PHLab) :
     esc(s), url(u)                         échappement HTML ; lien http(s) seulement, sinon « # »
     jeton() / jetonPerime()                jeton du membre Ghost, gardé 2 min (une requête de moins par appel)
     supa(url, body)                        appel d'une fonction Supabase ; ne rejette jamais ({ ok:false, why } en cas de coupure)
     occupe(opts)                           boutons qui travaillent : roue, aria-busy, désactivés, barre en haut du lab
     confirmer(root, msg, opts)             fenêtre de confirmation (Promise<boolean>) ; Échap = annuler, Entrée = valider
     toast(root, texte, mauvais)            message en bas d'écran
     theme(opts)                            mode clair/sombre du lab, branché sur shared/theme-mode.js
     lireDefilement / remettreDefilement    garder le défilement horizontal (plan, tableaux) d'un rendu à l'autre
     auRetour(fn, delai)                    relecture au retour sur l'onglet, seulement si la page n'a rien reçu depuis « delai »
     porteSVG(opts)                         flèche de couloir façon RPG (lien vers l'autre lab), à placer dans le plan SVG
     infobulle(opts)                        infobulle des éléments data-tip="titre|ligne|ligne" (data-tip-act : la ligne d'action)
     dictee(opts)                           dictée vocale dans un champ (texte provisoire gardé à l'arrêt, erreurs claires,
                                            mise en forme facultative avec champ grisé pendant ce temps)
     cssParts(R, pal)                       styles partagés : { occupe, confirmer, toast, porte, tip } */
(function () {
  'use strict';
  var L = window.PHLab = window.PHLab || {};
  if (L.core) return;
  L.core = 1;

  // ---------- texte et liens ----------
  L.esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  // liens venus des données (sources trouvées par l'IA, mails…) : http(s) seulement, jamais « javascript: »
  L.url = function (u) { u = String(u || '').trim(); return /^https?:\/\//i.test(u) ? L.esc(u) : '#'; };

  // ---------- jeton du membre Ghost (partagé avec shared/lab-boot.js s'il l'a déjà défini) ----------
  if (!L.jeton) {
    var J = { t: '', at: 0, p: null };
    L.jeton = function () {
      if (J.t && Date.now() - J.at < 120000) return Promise.resolve(J.t);
      if (J.p) return J.p;
      J.p = fetch('/members/api/session', { credentials: 'same-origin' }).then(function (r) { return r.ok ? r.text() : ''; })
        .then(function (t) { J.p = null; if (t) { J.t = t; J.at = Date.now(); } return t; }, function () { J.p = null; return ''; });
      return J.p;
    };
    L.jetonPerime = function () { J.at = 0; };
  }

  // ---------- fonctions Supabase ----------
  // une coupure réseau revient comme { ok:false } : chaque appelant affiche son message au lieu de rester muet
  L.supa = function (url, body) {
    return L.jeton().then(function (t) {
      body = body || {}; body.token = t;
      return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(function (r) {
        if (r.status === 401) L.jetonPerime(); // jeton expiré : on en redemande un au prochain appel
        return r.json().catch(function () { return { ok: false, why: 'réponse illisible (' + r.status + ')' }; });
      });
    }).then(function (r) { return r; }, function () { return { ok: false, why: 'connexion perdue, réessayez' }; });
  };

  // ---------- boutons « occupés » ----------
  // opts : root() → racine du lab ; sel : éléments suivis ; cle(el) → clé d'un élément ; classe : classe de chargement de la
  // racine (barre en haut) ; desactiver : désactiver les <button> occupés (sauf data-off).
  // Repris du Videolab (meilleur) : un garde en phase de capture refuse tout clic sur un élément encore occupé (même s'il a été
  // redessiné entre-temps), et tant qu'un appel est en cours, les éléments redessinés (panneau, fiche…) retrouvent leur roue.
  L.occupe = function (opts) {
    var pend = {}, nVis = 0, nCles = 0, garde = false, obs = null;
    function brancher() {
      var r = opts.root(); if (!r) return;
      if (!garde) {
        garde = true;
        r.addEventListener('click', function (e) {
          var n = e.target && e.target.closest && e.target.closest(opts.sel);
          if (n && n.classList.contains('ld')) { e.stopPropagation(); e.preventDefault(); } // déjà en cours : pas de double clic
        }, true);
      }
      if (!obs && window.MutationObserver) {
        obs = new MutationObserver(function () { if (nCles) peindre(); });
        obs.observe(r, { childList: true, subtree: true });
      }
    }
    function peindre() {
      var r = opts.root(); if (!r) return;
      if (opts.classe) r.classList.toggle(opts.classe, nVis > 0);
      var ns = r.querySelectorAll(opts.sel);
      for (var k = 0; k < ns.length; k++) {
        var b = ns[k], on = !!pend[opts.cle(b)];
        if (on) { b.classList.add('ld'); if (opts.desactiver && b.tagName === 'BUTTON') b.disabled = true; b.setAttribute('aria-busy', 'true'); }
        else if (b.classList.contains('ld')) { b.classList.remove('ld'); b.removeAttribute('aria-busy'); if (opts.desactiver && b.tagName === 'BUTTON' && !b.hasAttribute('data-off')) b.disabled = false; }
      }
    }
    return {
      debut: function (cle, visible) { brancher(); if (cle) { pend[cle] = (pend[cle] || 0) + 1; nCles++; } if (visible) nVis++; peindre(); },
      fin: function (cle, visible) { if (cle) { nCles--; if (!--pend[cle]) delete pend[cle]; } if (visible) nVis--; peindre(); },
      peindre: peindre,
      enCours: function () { return nVis > 0; }
    };
  };

  // ---------- fenêtre de confirmation ----------
  // msg : « Titre\n\nDétail ». opts.ok : libellé du bouton (sinon deviné : Envoyer, Insérer, Lancer, Préparer, Archiver, Confirmer) ;
  // opts.danger : forcer l'alerte rouge (sinon devinée : archiver, abandonner, ne plus, supprimer).
  L.confirmer = function (root, msg, opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var parts = String(msg).split('\n\n'), titre = parts.shift(), detail = parts.join('\n\n');
      var danger = opts.danger != null ? !!opts.danger : /archiv|abandon|ne plus|supprim/i.test(titre);
      var ok = opts.ok || (/^Envoyer/i.test(titre) ? 'Envoyer' : /^Insérer/i.test(titre) ? 'Insérer' : /^Lancer/i.test(titre) ? 'Lancer' : /^Préparer/i.test(titre) ? 'Préparer' : /archiv/i.test(titre) ? 'Archiver' : 'Confirmer');
      L.masquerInfobulles();
      var bg = document.createElement('div'); bg.className = 'cfm-bg';
      bg.innerHTML = '<div class="cfm' + (danger ? ' danger' : '') + '" role="dialog" aria-modal="true"><div class="cfm-ic">' + (danger ? '⚠️' : '✅') + '</div><div class="cfm-t">' + L.esc(titre) + '</div>' + (detail ? '<div class="cfm-d">' + L.esc(detail).replace(/\n/g, '<br>') + '</div>' : '') +
        '<div class="cfm-a"><button type="button" class="btn" data-cfm="0">Annuler</button><button type="button" class="btn ' + (danger ? 'red' : 'go') + '" data-cfm="1">' + L.esc(ok) + '</button></div></div>';
      var fin = function (v) { document.removeEventListener('keydown', kd, true); bg.classList.remove('on'); setTimeout(function () { if (bg.parentNode) bg.parentNode.removeChild(bg); }, 180); resolve(v); };
      var kd = function (e) { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); fin(false); } else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); fin(true); } };
      bg.addEventListener('click', function (e) { var b = e.target.closest('[data-cfm]'); if (b) { e.stopPropagation(); fin(b.getAttribute('data-cfm') === '1'); } else if (e.target === bg) fin(false); });
      document.addEventListener('keydown', kd, true);
      root.appendChild(bg); requestAnimationFrame(function () { bg.classList.add('on'); var b = bg.querySelector('[data-cfm="1"]'); if (b) b.focus(); });
    });
  };

  // ---------- toasts ----------
  L.toast = function (root, t, bad) {
    if (!root) return;
    var el = root.querySelector('.toast');
    if (!el) { el = document.createElement('div'); el.className = 'toast'; el.setAttribute('role', 'status'); el.setAttribute('aria-live', 'polite'); root.appendChild(el); }
    el.textContent = t; el.className = 'toast on' + (bad ? ' bad' : '');
    clearTimeout(el._phlT); el._phlT = setTimeout(function () { el.className = 'toast' + (bad ? ' bad' : ''); }, bad ? 6000 : 3500);
  };

  // ---------- mode clair / sombre ----------
  // Même réglage que tout posthumain.com (cookie tlj_theme, piloté par shared/theme-mode.js). opts : root() ; classe (ex.
  // « wl-clair ») ; feuille : id de la feuille claire dérivée ; change() : appelé quand le mode change (repeindre la barre…).
  L.theme = function (opts) {
    function clair() {
      if (window.PHTheme) return PHTheme.get() === 'light';
      try { return /(?:^|;\s*)tlj_theme=white/.test(document.cookie); } catch (e) { return false; }
    }
    function dispo() { return !!document.getElementById(opts.feuille); }
    function appliquer() { var r = opts.root(); if (r) r.classList.toggle(opts.classe, clair() && dispo()); }
    function basculer() {
      if (window.PHTheme) PHTheme.toggle();
      else { try { document.cookie = 'tlj_theme=' + (clair() ? 'dark' : 'white') + '; path=/; max-age=31536000; SameSite=Strict'; } catch (e) { /* cookies bloqués */ } }
      appliquer(); try { if (opts.change) opts.change(); } catch (e) { /* rien */ }
    }
    function brancher() { appliquer(); if (window.PHTheme) PHTheme.onChange(function () { appliquer(); try { if (opts.change) opts.change(); } catch (e) { /* rien */ } }); }
    return { clair: clair, dispo: dispo, appliquer: appliquer, basculer: basculer, brancher: brancher };
  };

  // ---------- défilement ----------
  L.lireDefilement = function (w, sels) { var o = {}; (sels || []).forEach(function (q) { var e = w.querySelector(q); if (e) o[q] = e.scrollLeft; }); return o; };
  L.remettreDefilement = function (w, o) { Object.keys(o || {}).forEach(function (q) { var e = w.querySelector(q); if (e && o[q]) e.scrollLeft = o[q]; }); };

  // ---------- retour sur l'onglet ----------
  // fn() n'est appelée au retour sur l'onglet que si derniere() (date du dernier chargement, en ms) a plus de « delai » ms :
  // chaque relecture coûte une exécution n8n.
  L.auRetour = function (fn, derniere, delai) {
    document.addEventListener('visibilitychange', function () { if (!document.hidden && Date.now() - (derniere() || 0) > delai) fn(); });
  };

  // ---------- porte de couloir (navigation d'un lab à l'autre, façon RPG) ----------
  // opts : x, y (pointe de la flèche, dans les coordonnées du plan), dir ('droite' | 'gauche'), href, titre (« Aller au Videolab »),
  // sous (petite ligne), taille (échelle). Un vrai lien <a> dans le SVG : clic, Entrée au clavier, clic molette.
  L.porteSVG = function (o) {
    // dessinée autour de la pointe (0,0) puis placée et mise à l'échelle du plan (taille : 1 = plan d'environ 1600 de large)
    var g = o.dir === 'gauche' ? -1 : 1, k = o.taille || 1;
    var fl = 'M' + (-g * 46) + ' -13 L' + (-g * 18) + ' -13 L' + (-g * 18) + ' -24 L0 0 L' + (-g * 18) + ' 24 L' + (-g * 18) + ' 13 L' + (-g * 46) + ' 13 Z';
    var tx = -g * 58, anc = g > 0 ? 'end' : 'start';
    return '<a class="phl-porte" href="' + L.esc(o.href) + '" aria-label="' + L.esc(o.titre) + '"><title>' + L.esc(o.titre) + '</title>' +
      '<g transform="translate(' + o.x + ' ' + o.y + ') scale(' + k + ')">' +
      '<rect class="phl-porte-zone" x="' + (g > 0 ? -250 : -10) + '" y="-30" width="260" height="60" rx="10"/>' +
      '<g class="phl-porte-fl"><path class="phl-porte-halo" d="' + fl + '"/><path class="phl-porte-f" d="' + fl + '"/></g>' +
      '<text class="phl-porte-t" x="' + tx + '" y="1" text-anchor="' + anc + '">' + L.esc(o.titre) + '</text>' +
      (o.sous ? '<text class="phl-porte-s" x="' + tx + '" y="16" text-anchor="' + anc + '">' + L.esc(o.sous) + '</text>' : '') + '</g></a>';
  };

  // ---------- infobulle ----------
  // Éléments data-tip="titre|ligne|ligne" (+ data-tip-act : ligne d'action en vert). Placée près de la souris sans sortir de l'écran.
  // opts : root() ; defaut : ligne d'action par défaut ; bloque() facultatif (true = pas d'infobulle). Retourne { suivre(e), masquer() }
  // à brancher sur mousemove / mouseleave.
  // 23/10/2026 : une infobulle ne reste jamais collée ni au-dessus d'une fenêtre.
  //  - Elle disparaît au toucher, au défilement, à Échap et à chaque clic (le clic ouvre souvent une fenêtre) ; après un toucher
  //    (souris émulée par l'écran tactile), elle s'efface seule au bout de 2 s.
  //  - Elle ne s'affiche pas tant qu'une fenêtre modale ([aria-modal="true"]) est ouverte, sauf sur un élément de cette fenêtre.
  //  - Empilement : l'infobulle passe AU-DESSUS de tout (tipZ, 2147483100) : comme elle n'apparaît que sur un élément de la
  //    fenêtre ouverte (jamais derrière une fenêtre), elle doit être lisible devant le voile flouté de cette fenêtre.
  L.masquerInfobulles = function () { var l = document.querySelectorAll('.tip.on'); for (var i = 0; i < l.length; i++) l[i].classList.remove('on'); };
  L.infobulle = function (opts) {
    var tactile = 0, minuteur = null;
    function masquer() { clearTimeout(minuteur); var r = opts.root(), t = r && r.querySelector('.tip'); if (t) t.classList.remove('on'); }
    function fenetreSans(el) {
      var r = opts.root(), l = r ? r.querySelectorAll('[aria-modal="true"]') : [];
      for (var i = 0; i < l.length; i++) if (l[i].getClientRects().length && !l[i].contains(el)) return true;
      return false;
    }
    document.addEventListener('touchstart', function () { tactile = Date.now(); masquer(); }, { capture: true, passive: true });
    window.addEventListener('scroll', masquer, { capture: true, passive: true });
    document.addEventListener('click', masquer, true);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') masquer(); }, true);
    function suivre(e) {
      var r = opts.root(); if (!r) return;
      var el = e.target && e.target.closest && e.target.closest('[data-tip]'), t = r.querySelector('.tip');
      if (!el || (opts.bloque && opts.bloque()) || fenetreSans(el)) { if (t) t.classList.remove('on'); return; }
      if (!t) { t = document.createElement('div'); t.className = 'tip'; r.appendChild(t); }
      var parts = String(el.getAttribute('data-tip')).split('|');
      var html = '<b>' + L.esc(parts[0]) + '</b>' + parts.slice(1).filter(Boolean).map(function (x) { return '<span>' + L.esc(x) + '</span>'; }).join('') + '<span class="go" style="margin-top:4px">' + (el.getAttribute('data-tip-act') || opts.defaut || '') + '</span>';
      if (t.innerHTML !== html) t.innerHTML = html;
      var w = t.offsetWidth || 260, h = t.offsetHeight || 80, x = e.clientX + 16, y = e.clientY + 16;
      if (x + w > window.innerWidth - 8) x = e.clientX - w - 16;
      if (y + h > window.innerHeight - 8) y = e.clientY - h - 16;
      t.style.left = Math.max(8, x) + 'px'; t.style.top = Math.max(8, y) + 'px'; t.classList.add('on');
      clearTimeout(minuteur); if (Date.now() - tactile < 1500) minuteur = setTimeout(masquer, 2000);
    }
    return { suivre: suivre, masquer: masquer };
  };

  // ---------- dictée vocale ----------
  // Reprise du Writinglab (la plus complète) : à l'arrêt, le dernier morceau encore « provisoire » est gardé (sinon les derniers
  // mots se perdent), le champ se grise tout de suite, erreurs de micro expliquées, puis mise en forme facultative (ex. Claude
  // Haiku) avec un garde de 12 s ; en cas d'échec, le texte brut reste. Rien ne part tout seul : on relit puis on envoie.
  // opts : champ() → <textarea> ; lang() ; brouillon(txt) : garder le brouillon ; etat(on) : la dictée démarre / s'arrête ;
  // verrou(on) : griser le champ pendant la mise en forme ; toast(t, mauvais) ; miseEnForme(dit) → Promise<texte|''> (facultatif) ;
  // formaterActif() → faux pour sauter la mise en forme (réglage).
  L.dictee = function (o) {
    var SR = window.SpeechRecognition || window.webkitSpeechRecognition || null;
    var st = { rec: null, actif: false, mef: false, garde: null };
    var dire = function (t, bad) { if (o.toast) o.toast(t, bad); };
    function verrou(on) { st.mef = on; if (o.verrou) o.verrou(on); }
    function etat(on) { st.actif = on; if (o.etat) o.etat(on); }
    function formater(base, dit) {
      verrou(true);
      var fin = function (txt) {
        verrou(false);
        var el = o.champ(); if (!el) return;
        if (txt) { el.value = (base + txt).replace(/^\s+/, ''); if (o.brouillon) o.brouillon(el.value); }
        el.focus(); el.setSelectionRange(el.value.length, el.value.length);
      };
      var garde = setTimeout(function () { fin(''); }, 12000); // jamais plus de 12 s de champ bloqué
      Promise.resolve().then(function () { return o.miseEnForme(dit); }).then(function (t) { clearTimeout(garde); if (st.mef) fin(t || ''); }, function () { clearTimeout(garde); if (st.mef) fin(''); });
    }
    function demarrer() {
      if (!SR) { dire('La dictée n’est pas disponible dans ce navigateur.', true); return; }
      var ta = o.champ(); if (!ta) return;
      var base = ta.value ? ta.value.replace(/\s*$/, ' ') : '', fini = '', enCours = '', fait = false;
      var rec = new SR(); rec.lang = (o.lang && o.lang()) || 'fr-FR'; rec.continuous = true; rec.interimResults = true;
      rec.onresult = function (ev) {
        var interim = '';
        if (fait) return;
        for (var i = ev.resultIndex; i < ev.results.length; i++) { var t = ev.results[i][0].transcript; if (ev.results[i].isFinal) fini += t; else interim += t; }
        enCours = interim;
        var txt = (base + fini + interim).replace(/^\s+/, '');
        var el = o.champ(); if (el) { el.value = txt; el.scrollTop = el.scrollHeight; }
        if (o.brouillon) o.brouillon((base + fini).replace(/^\s+/, ''));
      };
      rec.onerror = function (ev) { if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') dire('Autorisez le micro pour posthumain.com dans le navigateur.', true); else if (ev.error !== 'no-speech' && ev.error !== 'aborted') dire('Dictée interrompue (' + ev.error + ').', true); };
      var terminer = function () {
        if (fait) return; fait = true; clearTimeout(st.garde);
        st.rec = null; etat(false);
        var dit = (fini + ' ' + enCours).replace(/\s+/g, ' ').trim();
        var el = o.champ();
        if (el) { el.value = (base + dit).replace(/^\s+/, ''); if (o.brouillon) o.brouillon(el.value); }
        if (dit && o.miseEnForme && (!o.formaterActif || o.formaterActif())) formater(base, dit); else { verrou(false); if (el) el.focus(); }
      };
      rec.onend = terminer;
      rec.terminer = terminer;
      try { rec.start(); } catch (e) { dire('Impossible de lancer la dictée.', true); return; }
      st.rec = rec; etat(true);
    }
    // arrêt : le champ se grise TOUT DE SUITE, puis le texte part dès que le navigateur rend la main (au plus 1,2 s d'attente)
    function arreter() {
      var rec = st.rec; etat(false);
      if (rec) { verrou(true); try { rec.stop(); } catch (e) {} st.garde = setTimeout(function () { try { rec.abort(); } catch (e) {} if (rec.terminer) rec.terminer(); }, 1200); }
    }
    return { dispo: !!SR, demarrer: demarrer, arreter: arreter, basculer: function () { if (st.actif) arreter(); else demarrer(); },
      actif: function () { return st.actif; }, enMiseEnForme: function () { return st.mef; } };
  };

  // ---------- styles partagés ----------
  // R : racine du lab (« #wl ») ; pal : couleurs du lab. Chaque morceau est inséré à sa place dans la feuille du lab, ce qui
  // garde l'ordre des règles (et donc le rendu) exactement identique, et le fait passer par sa feuille claire dérivée.
  L.cssParts = function (R, p) {
    p = p || {};
    var acc = p.acc || '#00ff77', rgb = p.accRgb || '0,255,119', tx = p.txtRgb || '243,236,224', pre = p.prefixe || 'wl';
    var occupe = R + ' .ld{position:relative!important;color:transparent!important;pointer-events:none!important' + (p.ldOpacite ? ';opacity:' + p.ldOpacite : '') + '}' +
      R + " .ld::after{content:'';position:absolute;left:50%;top:50%;width:16px;height:16px;margin:-8px 0 0 -8px;border-radius:50%;border:2.5px solid rgba(" + rgb + ',.25);border-top-color:' + acc + ';animation:' + pre + 'spin .7s linear infinite}' +
      (p.ldPapier ? R + ' .paper .ld::after{border-color:rgba(0,0,0,.18);border-top-color:' + p.ldPapier + '}' : '') +
      '@keyframes ' + pre + 'spin{to{transform:rotate(360deg)}}' +
      R + '.' + pre + "-loading .top::after{content:'';position:absolute;left:0;right:0;bottom:-1px;height:2px;background:linear-gradient(90deg,transparent," + acc + ',transparent);background-size:40% 100%;background-repeat:no-repeat;animation:' + pre + 'bar 1.1s ease-in-out infinite}' +
      '@keyframes ' + pre + 'bar{from{background-position:-40% 0}to{background-position:140% 0}}';
    var confirmer = R + ' .cfm-bg{position:fixed;inset:0;z-index:' + (p.cfmZ || 70) + ';display:flex;align-items:center;justify-content:center;padding:16px;background:' + (p.voile || 'rgba(5,4,3,.62)') + ';backdrop-filter:blur(3px);opacity:0;transition:opacity .18s}' + R + ' .cfm-bg.on{opacity:1}' +
      R + ' .cfm{width:min(440px,100%);background:' + (p.fondCarte || '#14110c') + ';border:1px solid rgba(' + rgb + ',.35);border-radius:18px;padding:22px 22px 18px;box-shadow:0 30px 80px rgba(0,0,0,.6);transform:translateY(8px) scale(.98);transition:transform .18s}' + R + ' .cfm-bg.on .cfm{transform:none}' +
      R + ' .cfm.danger{border-color:rgba(255,80,80,.45)}' + R + ' .cfm-ic{font-size:26px;margin-bottom:8px}' + R + ' .cfm-t{font-weight:700;font-size:16.5px;line-height:1.35}' +
      R + ' .cfm-d{margin-top:10px;font-size:13.5px;line-height:1.55;color:rgba(' + tx + ',.7)}' + R + ' .cfm-a{display:flex;justify-content:flex-end;gap:8px;margin-top:18px}' +
      // boutons de la fenêtre protégés du thème du site (« .gh-btn, button » en vert majuscule !important) quand le lab ne le
      // fait pas déjà pour ses .btn (le Videolab : son « Annuler » ressemblait à « Confirmer »)
      (p.cfmBoutons ? R + ' .cfm-a .btn{font:600 14px Inter,system-ui,sans-serif!important;text-transform:none!important;letter-spacing:normal!important;box-shadow:none!important;text-shadow:none!important;border-radius:10px!important;padding:8px 14px!important;border:1px solid rgba(' + rgb + ',.35)!important;background:rgba(' + rgb + ',.08)!important;color:' + (p.txtBtn || '#bfffdc') + '!important;-webkit-text-fill-color:currentColor!important;cursor:pointer}' +
        R + ' .cfm-a .btn.go{background:' + acc + '!important;color:#04130b!important;border-color:' + acc + '!important;font-weight:700!important}' +
        R + ' .cfm-a .btn.red{background:rgba(255,61,90,.12)!important;color:#ffb3c0!important;border-color:rgba(255,61,90,.45)!important}' : '');
    var toast = R + ' .toast{position:fixed;left:50%;bottom:22px;transform:translateX(-50%) translateY(30px);z-index:' + (p.toastZ || 20) + ';background:' + (p.fondToast || '#16120d') + ';border:1px solid rgba(' + rgb + ',.4);color:' + (p.txtToast || '#e8fff2') + ';padding:11px 16px;border-radius:12px;box-shadow:0 14px 40px rgba(0,0,0,.5);opacity:0;pointer-events:none;transition:all .25s;max-width:92vw;font-size:14px}' +
      R + ' .toast.on{opacity:1;transform:translateX(-50%) translateY(0)}' + R + ' .toast.bad{border-color:rgba(255,61,90,.55);color:#ffd1d9}';
    var porte = R + ' .phl-porte{cursor:pointer;outline:none}' + R + ' .phl-porte-zone{fill:transparent;stroke:transparent;stroke-width:2;transition:fill .2s,stroke .2s}' +
      R + ' .phl-porte:hover .phl-porte-zone,' + R + ' .phl-porte:focus-visible .phl-porte-zone{fill:rgba(' + rgb + ',.07);stroke:rgba(' + rgb + ',.35)}' +
      R + ' .phl-porte-f{fill:' + acc + ';stroke:rgba(0,0,0,.35);stroke-width:1.5}' + R + ' .phl-porte-halo{fill:' + acc + ';opacity:.35;transform-box:fill-box;transform-origin:center;animation:phlporte 1.6s ease-in-out infinite}' +
      R + ' .phl-porte-fl{animation:phlpousse 1.6s ease-in-out infinite}' +
      R + ' .phl-porte-t{font:800 15px ui-monospace,"JetBrains Mono",monospace;letter-spacing:.06em;fill:' + acc + '}' + R + ' .phl-porte-s{font:600 10.5px Inter,system-ui,sans-serif;fill:rgba(' + tx + ',.6)}' +
      '@keyframes phlporte{0%,100%{opacity:.15;transform:scale(1)}50%{opacity:.55;transform:scale(1.35)}}@keyframes phlpousse{0%,100%{transform:translateX(0)}50%{transform:translateX(' + (p.porteDir === 'gauche' ? -5 : 5) + 'px)}}' +
      '@media (prefers-reduced-motion:reduce){' + R + ' .phl-porte-halo,' + R + ' .phl-porte-fl{animation:none}}' +
      // mode clair (racine « #wl.wl-clair », « #vl.vl-clair ») : vert profond lisible sur le papier
      R + '.' + pre + '-clair .phl-porte-t{fill:#0a7a45}' + R + '.' + pre + '-clair .phl-porte-s{fill:rgba(31,26,18,.62)}' +
      R + '.' + pre + '-clair .phl-porte-f,' + R + '.' + pre + '-clair .phl-porte-halo{fill:#0fb565}' + R + '.' + pre + '-clair .phl-porte-f{stroke:rgba(10,60,30,.35)}';
    var tip = R + ' .tip{position:fixed;z-index:' + (p.tipZ || 2147483100) + ';pointer-events:none;max-width:300px;padding:10px 12px;border-radius:12px;background:' + (p.fondTip || '#f8f4ea') + ';color:' + (p.encreTip || '#1f1a12') + ';font-size:13px;line-height:1.4;box-shadow:0 12px 40px rgba(0,0,0,.5);opacity:0;transition:opacity .12s}' + R + ' .tip.on{opacity:1}' +
      R + ' .tip b{display:block;font-size:13.5px;margin-bottom:3px;color:' + (p.encreTip || '#1f1a12') + '!important;font-weight:700}' + R + ' .tip span{display:block;color:' + (p.douxTip || '#5c5444') + '!important}' + R + ' .tip span.go{color:' + (p.goTip || '#1f6b45') + '!important;font-weight:600}';
    return { occupe: occupe, confirmer: confirmer, toast: toast, porte: porte, tip: tip };
  };
})();
