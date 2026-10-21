/* WRITINGLAB — la rédaction de Posthumain, vue de haut (20/10/2026, demande de Jonathan).
   Même principe que le Videolab (un bureau où chaque agent IA est un employé, ses fiches flottent au-dessus de sa tête),
   mais un outil à part : il ne touche à rien du Videolab.
   Servi par le webhook n8n « Posthumain — Writinglab (la rédaction) » après vérification du compte membre Ghost.
   Toutes les actions passent par ce seul webhook (champ « mode »). Aucun secret ici.
   Employés : la journaliste, l'Assistant (questions, contacts), la Secrétaire (mails relus et validés avant envoi),
   le Courrier (suivi des réponses), le Marbre (les brouillons Ghost) et le bureau du rédacteur en chef. */
(function () {
  'use strict';
  var TZ = 'Europe/Zurich';

  // ---------- outils ----------
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function nl(s) { return esc(s).replace(/\n/g, '<br>'); }
  function pl(n) { return n > 1 ? 's' : ''; }
  var fTime = new Intl.DateTimeFormat('fr-CH', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
  var fDay = new Intl.DateTimeFormat('fr-CH', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' });
  function hm(d) { return fTime.format(new Date(d)); }
  function day(d) { return fDay.format(new Date(d)); }
  function when(d) {
    if (!d) return '';
    var t = new Date(d).getTime(), s = Math.round((Date.now() - t) / 1000);
    if (isNaN(t)) return '';
    if (s < 0) return day(d) + ' ' + hm(d);
    if (s < 60) return 'à l’instant';
    if (s < 3600) return 'il y a ' + Math.round(s / 60) + ' min';
    if (s < 86400) return 'il y a ' + Math.round(s / 3600) + ' h';
    if (s < 7 * 86400) return 'il y a ' + Math.round(s / 86400) + ' j';
    return day(d);
  }
  var LS = {
    get: function (k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { if (v == null) window.localStorage.removeItem(k); else window.localStorage.setItem(k, v); } catch (e) { /* stockage indisponible */ } }
  };
  function uid() { return Math.random().toString(36).slice(2, 9); }

  // ---------- état ----------
  var S = {
    data: null, call: null, root: null, tab: LS.get('wl-tab') || 'bureau', art: LS.get('wl-article') || '',
    busy: {}, last: 0, panel: null,
    contact: null, contacts: null, qs: [], angle: '', echeance: '', consigneSec: '', reformule: null,
    libre: { nom: '', email: '', role: '', institution: '', langue: 'fr', consigne: '', echeance: '' },
    doc: null, cit: null, colle: false
  };

  function D() { return S.data || { me: {}, equipe: [], articles: [], fiches: [], messages: [], courrier: [], campagnes: [], prospects: [] }; }
  function prospect(id) { return (D().prospects || []).filter(function (x) { return x.prospect_id === id; })[0] || null; }
  function campagne(id) { return (D().campagnes || []).filter(function (x) { return x.campagne_id === id; })[0] || null; }
  function mails(boite, tous) { return (D().courrier || []).filter(function (m) { return m.boite === boite && (tous || m.statut !== 'répondu'); }); }
  function mail(id) { return (D().courrier || []).filter(function (m) { return m.mail_id === id; })[0] || null; }
  var JULIEN = { sc: { boite: 'subs', nom: 'Julien · Service client', adr: 'subs@posthumain.com', emoji: '🎧' }, mk: { boite: 'redaction', nom: 'Julien · Marketing', adr: 'redaction@posthumain.com', emoji: '📣' } };
  // Articles du plus récent (dernière modification dans Ghost) au plus ancien : en haut du Marbre, à gauche dans l'onglet Articles.
  function artsRecents() { return D().articles.slice().sort(function (x, y) { return String(y.maj || '').localeCompare(String(x.maj || '')); }); }
  function art(id) { return D().articles.filter(function (a) { return a.id === id; })[0] || null; }
  function fiche(id) { return D().fiches.filter(function (f) { return f.fiche_id === id; })[0] || null; }
  function by(st) { return D().fiches.filter(function (f) { return f.statut === st; }); }
  function relancable(f) { return f.statut === 'envoyé' && f.envoye_le && Date.now() - new Date(f.envoye_le).getTime() > 3 * 864e5; }
  function membre(id) { return (D().equipe || []).filter(function (w) { return w.id === id; })[0] || { nom: id || '?' }; }
  var STATUTS = { 'brouillon': ['🟠', 'à valider', 'a'], 'envoyé': ['📨', 'envoyé', 'b'], 'a répondu': ['📬', 'a répondu', 'g'], 'inséré': ['✅', 'cité dans l’article', 'g'], 'archivé': ['🗄️', 'archivé', ''] };
  function tagStatut(f) { var s = STATUTS[f.statut] || ['·', f.statut, '']; return '<span class="tag ' + s[2] + '">' + s[0] + ' ' + esc(s[1]) + '</span>'; }

  // brouillon de l'assistant, gardé par article dans ce navigateur (on ne perd rien en fermant la page)
  function saveDraft() { if (S.art) LS.set('wl-brouillon-' + S.art, JSON.stringify({ contact: S.contact, contacts: S.contacts, qs: S.qs, angle: S.angle, echeance: S.echeance, consigneSec: S.consigneSec })); }
  function loadDraft() {
    var d = null; try { d = JSON.parse(LS.get('wl-brouillon-' + S.art) || 'null'); } catch (e) { d = null; }
    S.contact = (d && d.contact) || null; S.contacts = (d && d.contacts) || null; S.qs = (d && d.qs) || []; S.angle = (d && d.angle) || '';
    S.echeance = (d && d.echeance) || ''; S.consigneSec = (d && d.consigneSec) || ''; S.reformule = null;
  }

  // ---------- appels au webhook (un seul : le champ « mode » dit ce qu'on demande) ----------
  // chaque bouton cliqué montre qu'il travaille (roue + barre en haut) jusqu'à la réponse du webhook
  S.pending = {}; S.nVisible = 0;
  function markBusy() {
    if (!S.root) return;
    var w = S.root.id === 'wl' ? S.root : (S.root.querySelector('#wl') || S.root);
    if (w) w.classList.toggle('wl-loading', S.nVisible > 0);
    var bs = S.root.querySelectorAll('[data-act]');
    for (var k = 0; k < bs.length; k++) {
      var b = bs[k], key = b.getAttribute('data-act') + '|' + (b.getAttribute('data-id') || '');
      if (S.pending[key]) { b.classList.add('ld'); if (b.tagName === 'BUTTON') b.disabled = true; b.setAttribute('aria-busy', 'true'); }
      else if (b.classList.contains('ld')) { b.classList.remove('ld'); b.removeAttribute('aria-busy'); if (b.tagName === 'BUTTON' && !b.hasAttribute('data-off')) b.disabled = false; }
    }
  }
  function api(mode, data) {
    var key = S.clicking || null, visible = !!key || mode !== 'etat';
    S.clicking = null;
    if (key) S.pending[key] = (S.pending[key] || 0) + 1;
    if (visible) S.nVisible++;
    markBusy();
    var done = function () { if (key && !--S.pending[key]) delete S.pending[key]; if (visible) S.nVisible--; markBusy(); };
    return S.call({ mode: mode, data: JSON.stringify(data || {}) }).then(function (r) {
      done();
      if (!r || r.ok === false) throw new Error((r && r.why) || 'le Writinglab ne répond pas');
      return r;
    }, function (e) { done(); throw new Error((e && (e.why || e.message)) || 'connexion perdue, réessayez'); });
  }
  // un employé au travail : sa lampe s'allume et une bulle dit ce qu'il fait
  function work(who, label, p) {
    S.busy[who] = label; paintFloor(); paintPanel();
    return p.then(function (r) { delete S.busy[who]; paintFloor(); paintPanel(); return r; },
      function (e) { delete S.busy[who]; paintFloor(); paintPanel(); toast('⚠️ ' + e.message, true); throw e; });
  }
  function refresh(silent) {
    S.last = Date.now();
    return api('etat').then(function (d) {
      // nouveaux mails arrivés sur subs@ / redaction@ depuis la dernière fois : le Courrier les porte au bureau de Julien
      if (S.data && S.data.courrier) {
        var vus = {}; S.data.courrier.forEach(function (m) { vus[m.mail_id] = 1; });
        var neufs = (d.courrier || []).filter(function (m) { return !vus[m.mail_id]; });
        if (neufs.length) { S.arrivees = neufs.map(function (m) { return m.boite; }); S.busy.courrier = 'trie ' + neufs.length + ' mail' + pl(neufs.length);
          setTimeout(function () { S.arrivees = null; delete S.busy.courrier; paintFloor(); }, 3600);
          toast('📬 ' + neufs.length + ' nouveau' + (neufs.length > 1 ? 'x' : '') + ' mail' + pl(neufs.length) + ' pour Julien'); }
      }
      S.data = d; render();
    }, function (e) { if (!silent) toast('⚠️ ' + e.message, true); });
  }

  // ---------- styles ----------
  var CSS = "\
#wl .ld{position:relative!important;color:transparent!important;pointer-events:none!important;opacity:.85}\
#wl .ld::after{content:'';position:absolute;left:50%;top:50%;width:16px;height:16px;margin:-8px 0 0 -8px;border-radius:50%;border:2.5px solid rgba(0,255,119,.25);border-top-color:#00ff77;animation:wlspin .7s linear infinite}\
#wl .paper .ld::after{border-color:rgba(0,0,0,.18);border-top-color:#1f6b45}\
@keyframes wlspin{to{transform:rotate(360deg)}}\
#wl.wl-loading .top::after{content:'';position:absolute;left:0;right:0;bottom:-1px;height:2px;background:linear-gradient(90deg,transparent,#00ff77,transparent);background-size:40% 100%;background-repeat:no-repeat;animation:wlbar 1.1s ease-in-out infinite}\
@keyframes wlbar{from{background-position:-40% 0}to{background-position:140% 0}}\
#wl{position:fixed;inset:0;z-index:2147483000;overflow:auto;-webkit-overflow-scrolling:touch;background:radial-gradient(1200px 700px at 25% -10%,#2a1d0f 0%,#0b0a08 55%) fixed,#0b0a08;color:#f3ece0;font-family:Inter,system-ui,-apple-system,Segoe UI,sans-serif;font-size:15px;line-height:1.45;-webkit-text-size-adjust:100%;text-size-adjust:100%}\
#wl *{box-sizing:border-box}#wl a{color:#3dffa0;text-decoration:none}#wl a:hover{text-decoration:underline}\
#wl .top{position:sticky;top:0;z-index:5;display:flex;align-items:center;gap:14px;padding:12px 18px;background:rgba(11,10,8,.85);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);border-bottom:1px solid rgba(255,190,90,.14)}\
#wl .logo{font-family:'JetBrains Mono',ui-monospace,monospace;font-weight:800;letter-spacing:.22em;font-size:15px;color:#00ff77;text-shadow:0 0 18px rgba(0,255,119,.45);white-space:nowrap}\
#wl .logo small{display:block;letter-spacing:.06em;font-weight:500;color:rgba(243,236,224,.55);font-size:11px;font-family:Inter,sans-serif;text-shadow:none}\
#wl .clock{font-family:'JetBrains Mono',monospace;font-size:20px;font-weight:700}\
#wl .chips{display:flex;gap:8px;flex-wrap:wrap;flex:1;justify-content:flex-end}\
#wl .chip{cursor:pointer;display:inline-flex;align-items:center;gap:7px;padding:5px 10px;border-radius:999px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.09);font-size:12.5px;white-space:nowrap;color:#f3ece0}\
#wl .chip{flex:none}#wl .chip.art{display:inline-block;max-width:min(340px,70vw);overflow:hidden;text-overflow:ellipsis;border-color:rgba(255,190,90,.35);background:rgba(255,190,90,.08)}\
#wl .chip.hot{border-color:rgba(0,255,119,.5);background:rgba(0,255,119,.1);color:#c9ffe0}\
#wl .chip.warn{border-color:rgba(255,176,32,.5);background:rgba(255,176,32,.1);color:#ffe0a3}\
#wl .btn{cursor:pointer;border:1px solid rgba(61,255,160,.35);background:rgba(0,255,119,.08);color:#bfffdc;border-radius:10px;padding:8px 12px;font:inherit;font-size:14px;line-height:1.2}\
#wl .btn:hover{background:rgba(0,255,119,.16)}#wl .btn[disabled]{opacity:.45;cursor:not-allowed}\
#wl .btn.go{background:#00ff77;color:#05170d;border-color:#00ff77;font-weight:800}#wl .btn.go:hover{background:#3dffa0}\
#wl .btn.amber{border-color:rgba(255,176,32,.5);background:rgba(255,176,32,.12);color:#ffe0a3}\
#wl .btn.red{border-color:rgba(255,61,90,.45);background:rgba(255,61,90,.1);color:#ffb3c0}\
#wl .btn.small{padding:5px 9px;font-size:12.5px;border-radius:8px}\
#wl .led{width:9px;height:9px;border-radius:50%;background:#3a4440;flex:none;display:inline-block}\
#wl .led.on{background:#00ff77;box-shadow:0 0 10px #00ff77;animation:wlpulse 1.4s ease-in-out infinite}#wl .led.slot{background:#ffb020;box-shadow:0 0 8px rgba(255,176,32,.8)}#wl .led.err{background:#ff3d5a;box-shadow:0 0 10px #ff3d5a}\
@keyframes wlpulse{50%{opacity:.45}}\
#wl .tabs{display:flex;gap:4px;padding:10px 18px 0;overflow-x:auto;scrollbar-width:none}#wl .tabs::-webkit-scrollbar{display:none}\
#wl .tab{cursor:pointer;padding:9px 14px;border-radius:10px 10px 0 0;color:rgba(243,236,224,.6);font-weight:600;font-size:14px;white-space:nowrap;border:1px solid transparent;border-bottom:none}\
#wl .tab.sel{color:#f3ece0;background:rgba(255,255,255,.04);border-color:rgba(255,255,255,.09)}\
#wl .tab .n{display:inline-block;min-width:18px;padding:0 5px;margin-left:6px;border-radius:9px;background:#00ff77;color:#05170d;font-size:11px;font-weight:800;text-align:center}\
#wl .wrap{padding:0 18px 60px}\
#wl .floor{position:relative;border:1px solid rgba(255,255,255,.09);border-radius:0 14px 14px 14px;background:rgba(255,255,255,.02);overflow-x:auto;overflow-y:hidden;-webkit-overflow-scrolling:touch}\
#wl .floor svg{display:block;width:100%;min-width:980px;height:auto}\
#wl .hint{font-size:12.5px;color:rgba(243,236,224,.5);margin:8px 2px 0}\
#wl .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:10px;margin-top:14px}\
#wl .card{cursor:pointer;border:1px solid rgba(255,255,255,.09);background:linear-gradient(180deg,rgba(255,255,255,.04),rgba(255,255,255,.015));border-radius:14px;padding:12px 13px;transition:border-color .2s,transform .2s}\
#wl .card:hover{border-color:rgba(61,255,160,.45);transform:translateY(-1px)}\
#wl .card .h{display:flex;align-items:center;gap:9px;font-weight:700}\
#wl .card .em{font-size:22px;width:34px;height:34px;display:grid;place-items:center;border-radius:10px;background:rgba(255,255,255,.05)}\
#wl .card .s{font-size:12.5px;color:rgba(243,236,224,.62);margin-top:6px}\
#wl h3{font-size:12.5px;letter-spacing:.14em;text-transform:uppercase;color:rgba(243,236,224,.5);margin:22px 0 10px;font-weight:700}\
#wl .tag{display:inline-block;font-size:11.5px;padding:2px 7px;border-radius:6px;background:rgba(255,255,255,.07);color:rgba(243,236,224,.8);margin-right:5px;white-space:nowrap}\
#wl .tag.g{background:rgba(0,255,119,.13);color:#7dffb8}#wl .tag.a{background:rgba(255,176,32,.15);color:#ffd27a}#wl .tag.b{background:rgba(90,160,255,.16);color:#a9cdff}#wl .tag.r{background:rgba(255,61,90,.14);color:#ff8c9e}\
#wl .muted{color:rgba(243,236,224,.55);font-size:13px}\
#wl .box{border:1px solid rgba(255,255,255,.09);border-radius:12px;padding:12px;background:rgba(255,255,255,.025);margin-bottom:12px}\
#wl .box.warn{border-color:rgba(255,176,32,.4);background:rgba(255,176,32,.06)}\
#wl .row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}\
#wl .panelbg{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:8;opacity:0;pointer-events:none;transition:opacity .25s}#wl .panelbg.open{opacity:1;pointer-events:auto}\
#wl .panel{position:fixed;top:0;right:0;bottom:0;width:min(560px,100vw);z-index:9;background:#0f0d0a;border-left:1px solid rgba(255,190,90,.2);box-shadow:-30px 0 60px rgba(0,0,0,.5);transform:translateX(105%);transition:transform .3s cubic-bezier(.2,.8,.2,1);overflow-y:auto;-webkit-overflow-scrolling:touch}\
#wl .panel.open{transform:none}\
#wl button.clsr-h{position:fixed;right:0;top:42%;z-index:6;display:flex;flex-direction:column;align-items:center;gap:6px;padding:12px 7px;border:1px solid rgba(255,190,90,.35);border-right:none;border-radius:12px 0 0 12px;background:#17130e!important;color:#f3ece0!important;cursor:pointer;box-shadow:-8px 0 24px rgba(0,0,0,.4)!important;font-weight:500;text-transform:none}\
#wl .clsr-h .lb{writing-mode:vertical-rl;transform:rotate(180deg);font-size:12.5px;letter-spacing:.06em}#wl .clsr-h .ic{font-size:18px}\
#wl .clsr-h .n{min-width:20px;padding:1px 6px;border-radius:999px;background:rgba(255,190,90,.18);font-size:11.5px;text-align:center}\
#wl .clsr-h.open{opacity:0;pointer-events:none}\
#wl .clsr-bg{position:fixed;inset:0;z-index:6;background:rgba(0,0,0,.4);opacity:0;pointer-events:none;transition:opacity .25s}#wl .clsr-bg.open{opacity:1;pointer-events:auto}\
#wl .clsr{position:fixed;top:0;right:0;bottom:0;width:min(400px,92vw);z-index:7;background:#0f0d0a;border-left:1px solid rgba(255,190,90,.25);box-shadow:-30px 0 60px rgba(0,0,0,.5);transform:translateX(105%);transition:transform .3s cubic-bezier(.2,.8,.2,1);display:flex;flex-direction:column}\
#wl .clsr.open{transform:none}\
#wl .btn.mic.on{border-color:rgba(255,80,80,.7)!important;color:#ffd0d0!important;animation:wlmic 1.2s ease-in-out infinite}@keyframes wlmic{0%,100%{box-shadow:0 0 0 0 rgba(255,80,80,.5)}50%{box-shadow:0 0 0 6px rgba(255,80,80,0)}}\
#wl .clsr-top{display:flex;align-items:center;justify-content:space-between;padding:16px 18px;border-bottom:1px solid rgba(255,255,255,.08)}#wl .clsr-top .x{cursor:pointer;font-size:18px;padding:4px 8px}\
#wl .clsr-body{flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:14px 18px 40px}\
#wl .clsr-cats{display:flex;flex-wrap:wrap;gap:6px}\
#wl .ph2{position:sticky;top:0;background:linear-gradient(180deg,#17120c 75%,rgba(23,18,12,0));padding:18px 18px 14px;display:flex;gap:12px;align-items:center;z-index:2}\
#wl .ph2 .em{font-size:30px;width:52px;height:52px;border-radius:14px;display:grid;place-items:center;background:rgba(255,190,90,.08);border:1px solid rgba(255,190,90,.25);flex:none}\
#wl .ph2 .nm{font-size:19px;font-weight:800;line-height:1.2}#wl .ph2 .st{font-size:12.5px;color:rgba(243,236,224,.65);display:flex;align-items:center;gap:7px;margin-top:4px}\
#wl .ph2 .x{margin-left:auto;cursor:pointer;font-size:22px;color:rgba(243,236,224,.6);padding:4px 8px}\
#wl .pb{padding:0 18px 60px}\
#wl label.f{display:block;font-size:12.5px;color:rgba(243,236,224,.6);margin:10px 0 4px}\
#wl input.in,#wl textarea.in,#wl select.in{width:100%;background:#16120d;color:#f3ece0;border:1px solid #3a3020;border-radius:10px;padding:10px 11px;font:16px Inter,system-ui,sans-serif}\
#wl textarea.in{min-height:72px;resize:vertical;line-height:1.45}#wl input.in:focus,#wl textarea.in:focus,#wl select.in:focus{outline:none;border-color:#00ff77;box-shadow:0 0 0 3px rgba(0,255,119,.15)}\
#wl .two{display:grid;grid-template-columns:1fr 1fr;gap:8px}\
#wl .q{border:1px solid rgba(255,255,255,.09);border-radius:12px;padding:10px;margin-bottom:8px;background:rgba(255,255,255,.02)}\
#wl .q.keep{border-color:rgba(0,255,119,.45);background:rgba(0,255,119,.05)}\
#wl .q .why{font-size:12.5px;color:rgba(243,236,224,.55);margin:6px 2px 8px;font-style:italic}\
#wl .q textarea.in{min-height:54px}\
#wl .ct{border:1px solid rgba(255,255,255,.09);border-radius:12px;padding:11px;margin-bottom:8px;background:rgba(255,255,255,.02)}\
#wl .ct b{font-size:15px}#wl .ct .w{font-size:12.5px;color:rgba(243,236,224,.6);margin-top:4px}\
#wl .dos{display:flex;flex-direction:column;gap:8px}\
#wl .dcard{cursor:pointer;border-radius:12px;padding:10px 12px;background:linear-gradient(180deg,#f7f1e3,#ebe2cc);color:#1f1a12;box-shadow:0 8px 22px rgba(0,0,0,.35);transition:transform .2s;position:relative}\
#wl .dcard:hover{transform:translateY(-2px) rotate(-.4deg)}\
#wl .dcard .k{font-size:11px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:#5a5243}\
#wl .dcard .ti{font-weight:800;font-size:14.5px;line-height:1.25;margin-top:4px;color:#1f1a12}\
#wl .dcard .su{font-size:12.5px;color:#5f5646;margin-top:3px}\
#wl .dcard.a{background:linear-gradient(180deg,#fff4dc,#f6e2b8)}#wl .dcard.b{background:linear-gradient(180deg,#eef4ff,#d9e5f6)}#wl .dcard.g{background:linear-gradient(180deg,#eafff2,#cdf1db);box-shadow:0 0 0 2px rgba(0,255,119,.5),0 8px 22px rgba(0,0,0,.35)}\
#wl .kan{display:grid;grid-template-columns:repeat(4,minmax(220px,1fr));gap:12px;overflow-x:auto;padding-bottom:10px}\
#wl .col{background:rgba(255,255,255,.025);border:1px solid rgba(255,255,255,.08);border-radius:14px;padding:10px;min-height:120px}\
#wl .col h4{margin:2px 2px 10px;font-size:13px;display:flex;gap:8px;align-items:center}\
#wl .arts{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px;margin-top:14px}\
#wl .ar{cursor:pointer;border-radius:14px;overflow:hidden;border:1px solid rgba(255,255,255,.09);background:#14110c;transition:border-color .2s}\
#wl .ar:hover,#wl .ar.sel{border-color:rgba(255,190,90,.6)}#wl .ar.sel{box-shadow:0 0 0 2px rgba(255,190,90,.45)}\
#wl .ar .ph{aspect-ratio:16/8;background:linear-gradient(135deg,#2a1d0f,#0e0b08);display:grid;place-items:center;font-size:30px;overflow:hidden}\
#wl .ar .ph img{width:100%;height:100%;object-fit:cover;display:block}\
#wl .ar .b{padding:10px 12px}#wl .ar .b .ti{font-weight:700;line-height:1.3}#wl .ar .b .me{font-size:12.5px;color:rgba(243,236,224,.55);margin-top:5px}\
#wl .chat{display:flex;flex-direction:column;gap:8px;max-width:760px}\
#wl .bub{max-width:82%;padding:9px 12px;border-radius:14px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.08);white-space:pre-wrap;word-wrap:break-word}\
#wl .bub.me{align-self:flex-end;background:rgba(0,255,119,.1);border-color:rgba(0,255,119,.3)}\
#wl .bub .who{font-size:11.5px;color:rgba(243,236,224,.55);margin-bottom:3px;white-space:normal}\
#wl .composer{position:sticky;bottom:0;padding:12px 0;background:linear-gradient(0deg,#0b0a08 70%,rgba(11,10,8,0));max-width:760px}\
#wl .feed .it{display:flex;gap:10px;padding:8px 6px;border-bottom:1px solid rgba(255,255,255,.05);font-size:13.5px}\
#wl .feed .it .t{font-family:'JetBrains Mono',monospace;font-size:11.5px;color:rgba(243,236,224,.45);min-width:78px;padding-top:2px}\
#wl .doc{position:fixed;inset:0;z-index:12;background:rgba(5,4,3,.86);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);display:none;overflow-y:auto;-webkit-overflow-scrolling:touch}#wl .doc.open{display:block}\
#wl .dtop{position:sticky;top:0;z-index:3;display:flex;align-items:center;gap:10px;padding:10px 14px;background:rgba(11,10,8,.92);border-bottom:1px solid rgba(255,190,90,.18)}\
#wl .dtop .em{font-size:24px}#wl .dtop .nm{font-weight:800;font-size:15px;line-height:1.2}#wl .dtop .st{font-size:12px;color:rgba(243,236,224,.6)}\
#wl .dtop .x{margin-left:auto;cursor:pointer;font-size:24px;color:rgba(243,236,224,.75);padding:2px 10px}\
#wl .paper{max-width:820px;margin:14px auto 80px;background:#f8f4ea;color:#1f1a12;border-radius:6px;box-shadow:0 30px 80px rgba(0,0,0,.6);padding:34px 42px 40px;font-family:Georgia,'Iowan Old Style','Times New Roman',serif;font-size:17px;line-height:1.6}\
#wl .paper *{text-shadow:none!important;letter-spacing:normal}\
#wl .paper .kick{font-family:Inter,sans-serif;font-size:11.5px;font-weight:800;letter-spacing:.16em;text-transform:uppercase;color:#7a6e58}\
#wl .paper h1{font-size:26px;line-height:1.2;margin:8px 0 6px;font-weight:700;color:#1f1a12!important;-webkit-text-fill-color:#1f1a12!important;font-family:Georgia,serif!important;text-transform:none!important;background:none!important}\
#wl .paper h1::before,#wl .paper h1::after,#wl .paper h2::before,#wl .paper h2::after{content:none!important}\
#wl .paper h2{font-family:Inter,sans-serif!important;font-size:12.5px;letter-spacing:.14em!important;text-transform:uppercase;color:#0a7a45!important;-webkit-text-fill-color:#0a7a45!important;margin:26px 0 8px;padding-top:14px;border-top:1px solid #ddd3bd;font-weight:800}\
#wl .paper p,#wl .paper li,#wl .paper .txt{color:#1f1a12!important;-webkit-text-fill-color:#1f1a12!important}\
#wl .paper .meta{font-family:Inter,sans-serif;font-size:13.5px;color:#5e5544;margin-bottom:16px}\
#wl .paper .txt{white-space:pre-wrap;word-wrap:break-word;font-size:16.5px}\
#wl .paper .lead{font-family:Inter,sans-serif;font-size:14px;background:#efe6d0;border-radius:8px;padding:10px 12px;margin:10px 0 14px;color:#3c3426}\
#wl .paper .warn{font-family:Inter,sans-serif;font-size:14px;background:#fff1d6;border-left:4px solid #e0a020;border-radius:0 8px 8px 0;padding:10px 12px;margin:10px 0;color:#4a3c1c}\
#wl .paper input.pin,#wl .paper textarea.pin{width:100%;background:#fff;color:#1f1a12;border:1px solid #d4c8ad;border-radius:8px;padding:10px 11px;font:16px Inter,system-ui,sans-serif;-webkit-text-fill-color:#1f1a12}\
#wl .paper textarea.pin{min-height:120px;resize:vertical;line-height:1.5}#wl .paper textarea.pin.big{min-height:380px;font:16px Georgia,'Iowan Old Style',serif}\
#wl .paper input.pin.sub{font-weight:700;font-size:18px}\
#wl .paper label{display:block;font-family:Inter,sans-serif;font-size:12.5px;color:#6b604b;margin:12px 0 4px;font-weight:700}\
#wl .paper .acts{display:flex;flex-wrap:wrap;gap:8px;margin:18px 0 6px}\
#wl .paper .acts button,#wl .paper button.pb2{cursor:pointer;font:700 14px Inter,system-ui,sans-serif!important;text-transform:none!important;letter-spacing:normal!important;box-shadow:none!important;padding:10px 14px!important;border-radius:10px!important;border:1px solid #cbbf9f!important;background:#fff!important;color:#1f1a12!important;-webkit-text-fill-color:#1f1a12!important}\
#wl .paper .acts button.go{background:#0a7a45!important;border-color:#0a7a45!important;color:#fff!important;-webkit-text-fill-color:#fff!important}\
#wl .paper .acts button.red{color:#a3122a!important;-webkit-text-fill-color:#a3122a!important;border-color:#e6b8c0!important}\
#wl .paper .acts button[disabled]{opacity:.45;cursor:not-allowed}\
#wl .paper .tl{font-family:Inter,sans-serif;font-size:13px;color:#5e5544;margin:0;padding:0;list-style:none}\
#wl .paper .tl li{padding:4px 0;border-bottom:1px dashed #e2d8c2;color:#5e5544!important;-webkit-text-fill-color:#5e5544!important}\
#wl .paper .prop{border:1px solid #d9ccb0;border-radius:10px;padding:12px;margin:10px 0;background:#fffdf7}\
#wl .paper .prop.sel{border-color:#0a7a45;box-shadow:0 0 0 2px rgba(10,122,69,.25)}\
#wl .paper .prop .ou{font-family:Inter,sans-serif;font-size:12.5px;color:#6b604b;margin-top:6px}\
#wl .paper .blk{cursor:pointer;font-family:Inter,sans-serif;font-size:13.5px;padding:8px 10px;border-radius:8px;border:1px solid transparent;color:#2c2618;display:flex;gap:10px}\
#wl .paper .blk:hover{background:#efe6d0}#wl .paper .blk.sel{border-color:#0a7a45;background:#e6f5ec}\
#wl .paper .blk .kd{flex:none;min-width:86px;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.06em;color:#8a7d62;padding-top:2px}\
#wl .paper .blk.h .tx{font-weight:800}#wl .paper .blk .tx{color:#2c2618!important;-webkit-text-fill-color:#2c2618!important}\
#wl .paper .ins{font-family:Inter,sans-serif;font-size:13px;color:#0a7a45;font-weight:800;padding:4px 10px}\
#wl .paper details summary{cursor:pointer;font-family:Inter,sans-serif;font-weight:700;font-size:14px;color:#0a7a45;padding:6px 0}\
#wl .paper a{color:#0a7a45!important;-webkit-text-fill-color:#0a7a45!important;text-decoration:underline}\
#wl .paper .tag{background:#efe6d0;color:#4a4130}#wl .paper .tag.g{background:#d9f3e3;color:#0a6a3c}#wl .paper .tag.a{background:#ffefcc;color:#8a5a00}#wl .paper .tag.b{background:#dde9fb;color:#1f4f8a}\
#wl .toast{position:fixed;left:50%;bottom:22px;transform:translateX(-50%) translateY(30px);z-index:20;background:#16120d;border:1px solid rgba(0,255,119,.4);color:#e8fff2;padding:11px 16px;border-radius:12px;box-shadow:0 14px 40px rgba(0,0,0,.5);opacity:0;pointer-events:none;transition:all .25s;max-width:92vw;font-size:14px}\
#wl .toast.on{opacity:1;transform:translateX(-50%) translateY(0)}#wl .toast.bad{border-color:rgba(255,61,90,.55);color:#ffd1d9}\
#wl .ag{cursor:pointer}#wl .ag:hover .deskTop{stroke:#ffbe5a;stroke-width:2.5}\
#wl .ag.on .bob{animation:wlbob 1.1s ease-in-out infinite}@keyframes wlbob{50%{transform:translateY(-2px)}}\
#wl .ag.on .scr{animation:wlscr 2.2s linear infinite}@keyframes wlscr{50%{opacity:.7}}\
#wl .ag .ledsvg.on{animation:wlpulse 1.2s ease-in-out infinite}\
#wl .cable{fill:none;stroke-linecap:round;stroke-linejoin:round}\
#wl .cable.live{stroke-dasharray:10 14;animation:wlflow 1.1s linear infinite}@keyframes wlflow{to{stroke-dashoffset:-24}}\
#wl .lbl{font-family:Inter,sans-serif;font-size:15px;font-weight:700;fill:#f3ece0}\
#wl .lbl2{font-family:Inter,sans-serif;font-size:12px;fill:rgba(243,236,224,.55)}\
#wl .roomname{font-family:'JetBrains Mono',monospace;font-size:13px;letter-spacing:.18em;fill:rgba(243,236,224,.32);text-transform:uppercase}\
#wl .pile{cursor:pointer}#wl .pile .fl{animation:wlfloat 3.2s ease-in-out infinite}@keyframes wlfloat{50%{transform:translateY(-4px)}}\
#wl .pile:hover .paperS{stroke:#00ff77;stroke-width:2}\
#wl .bulle{animation:wlfloat 2.4s ease-in-out infinite}\
#wl .here{animation:wlpulse 1.8s ease-in-out infinite}\
#wl input,#wl textarea,#wl select,#wl button{font-family:Inter,system-ui,-apple-system,sans-serif!important;letter-spacing:normal!important;text-transform:none!important;text-shadow:none!important;box-shadow:none;outline:none}\
#wl input.in,#wl textarea.in,#wl select.in{background:#16120d!important;color:#f3ece0!important;-webkit-text-fill-color:#f3ece0!important;border:1px solid #3a3020!important;border-radius:10px!important;padding:10px 11px!important;font-size:16px!important;line-height:1.45!important;width:100%!important;height:auto!important;min-height:0;margin:0!important}\
#wl textarea.in{min-height:72px!important}#wl .q textarea.in{min-height:54px!important}\
#wl input.in:focus,#wl textarea.in:focus,#wl select.in:focus{border-color:#00ff77!important;box-shadow:0 0 0 3px rgba(0,255,119,.15)!important}\
#wl .paper input.pin,#wl .paper textarea.pin{background:#fff!important;color:#1f1a12!important;-webkit-text-fill-color:#1f1a12!important;border:1px solid #d4c8ad!important;border-radius:8px!important;padding:10px 11px!important;font-size:16px!important;line-height:1.5!important;width:100%!important;height:auto!important;margin:0!important;box-shadow:none!important}\
#wl .paper textarea.pin{min-height:120px!important}#wl .paper textarea.pin.big{min-height:380px!important;font-family:Georgia,'Iowan Old Style',serif!important}\
#wl .paper input.pin.sub{font-weight:700!important;font-size:18px!important}\
#wl .paper input.pin:focus,#wl .paper textarea.pin:focus{border-color:#0a7a45!important;box-shadow:0 0 0 3px rgba(10,122,69,.18)!important}\
#wl .paper b,#wl .paper strong,#wl .paper .meta,#wl .paper label,#wl .paper .lead,#wl .paper .warn{-webkit-text-fill-color:currentColor!important;text-shadow:none!important}\
#wl .paper b,#wl .paper strong{color:inherit!important}#wl .paper .meta{color:#5e5544!important}#wl .paper label{color:#6b604b!important}\
#wl .paper .lead{color:#3c3426!important}#wl .paper .warn{color:#4a3c1c!important}#wl .paper .kick{color:#7a6e58!important;-webkit-text-fill-color:#7a6e58!important}\
#wl b,#wl strong{text-shadow:none}#wl .btn{font-family:Inter,system-ui,sans-serif!important;text-transform:none!important;letter-spacing:normal!important}\
#wl input[type=checkbox]{-webkit-appearance:checkbox!important;appearance:auto!important;width:18px!important;height:18px!important;min-height:0!important;padding:0!important;margin:0!important;background:none!important;border:none!important;accent-color:#00ff77;flex:none}\
#wl .btn{background:rgba(0,255,119,.08)!important;color:#bfffdc!important;-webkit-text-fill-color:#bfffdc!important;border:1px solid rgba(61,255,160,.35)!important;border-radius:10px!important;padding:8px 12px!important;font-size:14px!important;font-weight:600!important;line-height:1.2!important;width:auto!important;height:auto!important;min-height:0!important;margin:0!important;box-shadow:none!important}\
#wl .btn:hover{background:rgba(0,255,119,.16)!important}\
#wl .btn.go{background:#00ff77!important;color:#05170d!important;-webkit-text-fill-color:#05170d!important;border-color:#00ff77!important;font-weight:800!important}\
#wl .btn.amber{background:rgba(255,176,32,.12)!important;color:#ffe0a3!important;-webkit-text-fill-color:#ffe0a3!important;border-color:rgba(255,176,32,.5)!important}\
#wl .btn.red{background:rgba(255,61,90,.1)!important;color:#ffb3c0!important;-webkit-text-fill-color:#ffb3c0!important;border-color:rgba(255,61,90,.45)!important}\
#wl .btn.small{padding:5px 9px!important;font-size:12.5px!important;border-radius:8px!important}\
@media (max-width:720px){#wl{font-size:14.5px}#wl .top{flex-wrap:wrap;gap:8px;padding:10px 12px}#wl .chips{order:3;justify-content:flex-start;flex-basis:100%;flex-wrap:nowrap;overflow-x:auto;scrollbar-width:none}#wl .chips::-webkit-scrollbar{display:none}#wl .clock{order:2;font-size:17px;margin-left:auto}#wl .wrap{padding:0 10px 60px}#wl .tabs{padding:8px 10px 0}#wl .panel{width:100vw;top:6vh;border-radius:18px 18px 0 0;border-left:none;border-top:1px solid rgba(255,190,90,.3);transform:translateY(105%)}#wl .panel.open{transform:none}#wl .floor svg{min-width:900px}#wl .paper{margin:10px 8px 60px;padding:22px 16px 28px;font-size:16.5px}#wl .paper h1{font-size:22px}#wl .two{grid-template-columns:1fr}#wl .kan{grid-template-columns:repeat(4,82vw)}#wl button.clsr-h{top:auto;bottom:150px;padding:10px 6px}#wl .clsr-h .lb{display:none}#wl .clsr{width:100vw;top:8vh;border-left:none;border-top:1px solid rgba(255,190,90,.3);border-radius:18px 18px 0 0;transform:translateY(105%)}#wl .clsr.open{transform:none}}\
";

  // ---------- le plan de la rédaction (SVG, 1600 × 1000) ----------
  var ROOMS = [
    { key: 'redac', name: 'Salle de rédaction', x: 30, y: 30, w: 760, h: 410, floor: '#16110b' },
    { key: 'secr', name: 'Secrétariat', x: 810, y: 30, w: 360, h: 410, floor: '#0b1216' },
    { key: 'biblio', name: 'Bibliothèque', x: 1190, y: 30, w: 380, h: 410, floor: '#120e19' },
    { key: 'chef', name: 'Bureau du rédacteur en chef', x: 30, y: 500, w: 560, h: 470, floor: '#0f140c' },
    { key: 'courrier', name: 'Salle du courrier', x: 610, y: 500, w: 560, h: 470, floor: '#0c0f16' },
    { key: 'marbre', name: 'Le marbre · Ghost', x: 1190, y: 500, w: 380, h: 470, floor: '#0a0d0b' }
  ];
  var ROOMS2 = [
    { key: 'sc', name: 'Service client · subs@', x: 30, y: 1030, w: 760, h: 300, floor: '#0c1414' },
    { key: 'mk', name: 'Marketing · redaction@', x: 810, y: 1030, w: 760, h: 300, floor: '#16100c' }
  ];
  function rooms() { return D().me && D().me.chef ? ROOMS.concat(ROOMS2) : ROOMS; }
  function people() {
    var eq = D().equipe || [];
    var js = eq.filter(function (w) { return w.role !== 'chef'; }).slice(0, 3);
    var chef = eq.filter(function (w) { return w.role === 'chef'; })[0] || { id: 'chef', nom: 'Le rédacteur en chef', titre: 'Rédacteur en chef' };
    var xs = js.length === 3 ? [170, 410, 650] : js.length === 2 ? [260, 560] : [410];
    var list = [];
    if (!js.length) list.push({ key: 'j:vide', kind: 'journaliste', vide: true, nom: 'Poste de la journaliste', titre: 'à attribuer', emoji: '✍️', hue: 330, x: 410, y: 215 });
    js.forEach(function (w, i) { list.push({ key: 'j:' + w.id, id: w.id, kind: 'journaliste', nom: w.nom, titre: w.titre, emoji: '✍️', hue: [330, 300, 15][i], x: xs[i], y: 215 }); });
    list.push({ key: 'secretaire', kind: 'secretaire', nom: 'La Secrétaire', titre: 'Rédige, fait valider, envoie', emoji: '📮', hue: 200, x: 990, y: 215 });
    list.push({ key: 'assistant', kind: 'assistant', nom: 'L’Assistant', titre: 'Questions et contacts', emoji: '🧠', hue: 265, x: 1380, y: 215 });
    list.push({ key: 'chef', id: chef.id, kind: 'chef', nom: chef.nom, titre: chef.titre || 'Rédacteur en chef', emoji: '🧐', hue: 40, x: 310, y: 735 });
    list.push({ key: 'courrier', kind: 'courrier', nom: 'Le Courrier', titre: 'Suit les réponses', emoji: '📬', x: 890, y: 735, device: true });
    list.push({ key: 'marbre', kind: 'marbre', nom: 'Le Marbre', titre: 'Les brouillons Ghost', emoji: '📰', x: 1380, y: 735, device: true });
    if (D().me && D().me.chef) {
      list.push({ key: 'sc', kind: 'sc', nom: JULIEN.sc.nom, titre: JULIEN.sc.adr, emoji: JULIEN.sc.emoji, hue: 175, x: 410, y: 1160 });
      list.push({ key: 'mk', kind: 'mk', nom: JULIEN.mk.nom, titre: JULIEN.mk.adr, emoji: JULIEN.mk.emoji, hue: 20, x: 1190, y: 1160 });
    }
    return list;
  }
  function P(key) { return people().filter(function (p) { return p.key === key; })[0]; }
  function isMe(p) { return !!p.id && p.id === D().me.id; }
  function stOf(p) {
    var b = S.busy[p.kind];
    if (b) return { s: 'on', why: b };
    if (p.kind === 'secretaire') { var n = by('brouillon').length; return n ? { s: 'slot', why: n + ' mail' + pl(n) + ' à valider' } : { s: 'off', why: 'prête à écrire' }; }
    if (p.kind === 'assistant') { var k = S.qs.filter(function (q) { return q.garde; }).length; return S.art ? (k ? { s: 'slot', why: k + ' question' + pl(k) + ' retenue' + pl(k) } : { s: 'off', why: 'prêt à aider' }) : { s: 'off', why: 'choisissez un article' }; }
    if (p.kind === 'courrier') { var r = by('a répondu').length, e = by('envoyé').length; return r ? { s: 'on', why: r + ' réponse' + pl(r) + ' à traiter' } : e ? { s: 'slot', why: e + ' en attente de réponse' } : { s: 'off', why: 'aucun courrier en cours' }; }
    if (p.kind === 'sc' || p.kind === 'mk') {
      var ms = mails(JULIEN[p.kind].boite), nd = ms.filter(function (m) { return m.categorie === 'demande' && !m.brouillon_corps; }).length, nb = ms.filter(function (m) { return m.brouillon_corps; }).length, nv = ms.filter(function (m) { return m.categorie === 'verifier'; }).length;
      return nd ? { s: 'on', why: nd + ' demande' + pl(nd) + ' à traiter' } : nb ? { s: 'slot', why: nb + ' réponse' + pl(nb) + ' à valider' } : nv ? { s: 'slot', why: nv + ' mail' + pl(nv) + ' à vérifier' } : { s: 'off', why: 'boîte à jour' };
    }
    if (p.kind === 'marbre') { var a = D().articles.length; return { s: a ? 'slot' : 'off', why: a + ' brouillon' + pl(a) + ' sur le marbre' }; }
    if (p.vide) return { s: 'off', why: 'poste à attribuer' };
    if (isMe(p)) return { s: 'on', why: 'vous êtes ici' };
    return { s: 'off', why: p.titre || '' };
  }
  function personSVG(p, st) {
    var hair = 'hsl(' + p.hue + ',55%,' + (st === 'off' ? 30 : 44) + '%)';
    var shirt = 'hsl(' + p.hue + ',35%,' + (st === 'off' ? 19 : 27) + '%)';
    return '<g class="bob">' +
      '<ellipse cx="0" cy="50" rx="27" ry="14" fill="' + shirt + '" stroke="rgba(0,0,0,.5)"/>' +
      '<circle cx="-12" cy="42" r="2.6" fill="#c9a286"/><circle cx="12" cy="42" r="2.6" fill="#c9a286"/>' +
      '<ellipse cx="0" cy="33" rx="6.5" ry="3.6" fill="#d9b49a"/>' +
      '<circle cx="0" cy="43" r="12.5" fill="' + hair + '"/>' +
      '<path d="M-8 35.5 q8 -3.5 16 0" fill="none" stroke="rgba(255,255,255,.18)" stroke-width="1.5"/>' +
      '<ellipse cx="-20" cy="36" rx="5" ry="7" fill="' + shirt + '" transform="rotate(-25 -20 36)"/>' +
      '<ellipse cx="20" cy="36" rx="5" ry="7" fill="' + shirt + '" transform="rotate(25 20 36)"/></g>';
  }
  function colOf(st) { return st === 'on' ? '#00ff77' : st === 'slot' ? '#ffb020' : st === 'err' ? '#ff3d5a' : '#1f2a24'; }
  function deskSVG(p) {
    var o = stOf(p), st = o.s, scr = colOf(st), glow = st !== 'off';
    var big = p.kind === 'chef';
    var w = big ? 170 : 132, h = big ? 64 : 54;
    var deco = '';
    if (p.kind === 'secretaire') deco = '<rect x="30" y="-20" width="26" height="18" rx="2" fill="#5a4a2e" stroke="rgba(255,255,255,.2)"/><rect x="33" y="-17" width="20" height="3" fill="#f3e6c6"/><rect x="33" y="-12" width="20" height="3" fill="#f3e6c6"/>';
    else if (p.kind === 'assistant') deco = '<rect x="-58" y="-20" width="8" height="26" fill="#7a3b2a"/><rect x="-49" y="-20" width="7" height="26" fill="#2a5a7a"/><rect x="-41" y="-20" width="8" height="26" fill="#3b7a2a"/>';
    else if (p.kind === 'chef') deco = '<rect x="-70" y="-24" width="40" height="14" rx="3" fill="#b8913e"/><text x="-50" y="-13.5" text-anchor="middle" font-size="8.5" font-weight="800" fill="#1f1a12">CHEF</text><circle cx="62" cy="-8" r="7" fill="#4a3426"/><circle cx="62" cy="-8" r="4" fill="#2a1a10"/>';
    else deco = '<circle cx="46" cy="-6" r="6" fill="#4a3426"/><circle cx="46" cy="-6" r="3.5" fill="#2a1a10"/>';
    return '<g class="ag ' + st + '" data-ag="' + esc(p.key) + '" transform="translate(' + p.x + ',' + p.y + ')">' +
      '<rect x="-100" y="-70" width="200" height="200" rx="14" fill="transparent"/>' +
      (glow ? '<ellipse cx="0" cy="0" rx="' + (big ? 100 : 80) + '" ry="60" fill="url(#halo-' + st + ')"/>' : '') +
      (p.vide ? '' : '<circle cx="0" cy="52" r="23" fill="#221c15" stroke="rgba(255,255,255,.08)"/>' + personSVG(p, st)) +
      '<rect class="deskTop" x="' + (-w / 2) + '" y="-30" width="' + w + '" height="' + h + '" rx="7" fill="' + (big ? 'url(#wood)' : '#2c261d') + '" stroke="rgba(255,255,255,.14)"/>' +
      '<rect x="' + (-w / 2 + 6) + '" y="-24" width="' + (w - 12) + '" height="' + (h - 12) + '" rx="5" fill="' + (big ? 'rgba(0,0,0,.18)' : '#221d16') + '"/>' +
      '<rect class="scr" x="-36" y="-26" width="72" height="9" rx="2.5" fill="' + scr + '" ' + (glow ? 'filter="url(#glow)"' : '') + '/>' +
      (glow ? '<path d="M-34 -17 L34 -17 L52 22 L-52 22 Z" fill="' + scr + '" opacity=".07"/>' : '') +
      '<rect x="-24" y="2" width="48" height="10" rx="2" fill="#3e372b"/>' + deco +
      '<circle class="ledsvg ' + st + '" cx="' + (w / 2 - 8) + '" cy="-24" r="5" fill="' + (st === 'off' ? '#3a4440' : scr) + '" ' + (st !== 'off' ? 'filter="url(#glow)"' : '') + '/>' +
      '<g transform="translate(' + (-w / 2 + 2) + ',-46)"><circle r="17" fill="#15110c" stroke="rgba(255,190,90,.4)"/><text x="0" y="6" text-anchor="middle" font-size="18">' + p.emoji + '</text></g>' +
      '<text class="lbl" x="0" y="96" text-anchor="middle">' + esc(p.nom) + '</text>' +
      '<text class="lbl2" x="0" y="113" text-anchor="middle">' + esc(o.why) + '</text>' +
      (isMe(p) ? '<g class="here" transform="translate(0,140)"><rect x="-46" y="-12" width="92" height="22" rx="11" fill="#00ff77"/><text y="4" text-anchor="middle" font-size="11.5" font-weight="800" fill="#05170d">VOUS ÊTES ICI</text></g>' : '') +
      '</g>';
  }
  function deviceSVG(p) {
    var o = stOf(p), st = o.s, col = colOf(st), s = '';
    if (p.kind === 'courrier') {
      s += '<rect x="-110" y="-60" width="220" height="110" rx="8" fill="url(#wood)" stroke="rgba(255,255,255,.14)"/>';
      var rep = by('a répondu').length, att = by('envoyé').length, k = 0;
      for (var r = 0; r < 3; r++) for (var c = 0; c < 6; c++) {
        var x = -100 + c * 34, y = -52 + r * 33, fill = '#1b150f';
        var env = k < rep ? '#7dffb8' : k < rep + att ? '#a9cdff' : '';
        s += '<rect x="' + x + '" y="' + y + '" width="30" height="28" rx="2" fill="' + fill + '" stroke="rgba(0,0,0,.6)"/>';
        if (env) s += '<rect x="' + (x + 4) + '" y="' + (y + 7) + '" width="22" height="14" rx="1.5" fill="' + env + '"' + (k < rep ? ' filter="url(#glow)"' : '') + '/><path d="M' + (x + 4) + ' ' + (y + 7) + ' l11 8 l11 -8" stroke="rgba(0,0,0,.45)" fill="none"/>';
        k++;
      }
    } else {
      s += '<rect x="-110" y="-55" width="220" height="100" rx="8" fill="#2b2b2b" stroke="rgba(255,255,255,.16)"/><rect x="-100" y="-45" width="200" height="80" rx="4" fill="#3a3a3a"/>';
      var n = Math.min(D().articles.length, 6);
      for (var i = 0; i < n; i++) s += '<rect x="' + (-92 + i * 31) + '" y="-38" width="26" height="34" rx="2" fill="#f3ead6" transform="rotate(' + ((i % 3) - 1) * 4 + ' ' + (-79 + i * 31) + ' -21)"/><rect x="' + (-88 + i * 31) + '" y="-32" width="18" height="3" fill="#9a8f78"/><rect x="' + (-88 + i * 31) + '" y="-26" width="14" height="3" fill="#bdb29a"/>';
      s += '<rect x="-60" y="10" width="120" height="16" rx="3" fill="#1d1d1d"/><text x="0" y="22" text-anchor="middle" font-size="10" font-weight="800" fill="#00ff77" font-family="monospace">GHOST</text>';
    }
    return '<g class="ag ' + st + '" data-ag="' + p.key + '" transform="translate(' + p.x + ',' + p.y + ')">' +
      '<rect x="-120" y="-80" width="240" height="210" fill="transparent"/>' +
      (st !== 'off' ? '<ellipse cx="0" cy="0" rx="130" ry="80" fill="url(#halo-' + st + ')"/>' : '') + s +
      '<circle class="ledsvg ' + st + '" cx="104" cy="-66" r="5" fill="' + (st === 'off' ? '#3a4440' : col) + '" ' + (st !== 'off' ? 'filter="url(#glow)"' : '') + '/>' +
      '<g transform="translate(-112,-72)"><circle r="17" fill="#15110c" stroke="rgba(255,190,90,.4)"/><text x="0" y="6" text-anchor="middle" font-size="18">' + p.emoji + '</text></g>' +
      '<text class="lbl" x="0" y="80" text-anchor="middle">' + esc(p.nom) + '</text><text class="lbl2" x="0" y="97" text-anchor="middle">' + esc(o.why) + '</text></g>';
  }
  // fiches qui flottent au-dessus de chaque employé : ce qui l'attend (cliquer ouvre son bureau)
  function pileOf(p) {
    var me = D().me;
    if (p.kind === 'secretaire') return by('brouillon').map(function () { return 'a'; });
    if (p.kind === 'courrier') return by('a répondu').map(function () { return 'g'; }).concat(by('envoyé').map(function () { return 'b'; }));
    if (p.kind === 'assistant') return S.qs.filter(function (q) { return q.garde; }).map(function () { return 'n'; });
    if (p.kind === 'journaliste' && !p.vide) return D().fiches.filter(function (f) { return f.redacteur === p.id && f.statut === 'a répondu'; }).map(function () { return 'g'; });
    if (p.kind === 'chef' && me.chef) return by('inséré').map(function () { return 'w'; });
    if (p.kind === 'sc' || p.kind === 'mk') return mails(JULIEN[p.kind].boite).map(function (m) { return m.brouillon_corps ? 'a' : m.categorie === 'demande' ? 'g' : 'n'; });
    if (p.kind === 'marbre') return D().articles.filter(function (a) { return a.id === S.art; }).map(function () { return 'w'; });
    return [];
  }
  function pilesSVG() {
    var s = '';
    people().forEach(function (p) {
      var cs = pileOf(p); if (!cs.length) return;
      var n = Math.min(cs.length, 3), y = p.device ? p.y - 118 : p.y - 82;
      var g = '<g class="pile" data-ag="' + esc(p.key) + '" transform="translate(' + p.x + ',' + y + ') scale(1.25)"><g class="fl"><rect x="-62" y="-30" width="124" height="52" fill="transparent"/>';
      for (var k = 0; k < n; k++) {
        var c = cs[k], off = (k - (n - 1) / 2) * 30, rot = (k - (n - 1) / 2) * 11;
        var col = c === 'a' ? '#fff0cc' : c === 'b' ? '#e3edff' : c === 'g' ? '#e2ffef' : c === 'n' ? '#fff7b0' : '#f6f2e7';
        g += '<g transform="translate(' + off + ',0) rotate(' + rot + ')"><rect class="paperS" x="-19" y="-24" width="38" height="46" rx="3" fill="' + col + '" stroke="rgba(0,0,0,.35)" filter="url(#glow)"/>';
        if (c === 'b' || c === 'g') g += '<rect x="-14" y="-12" width="28" height="18" rx="2" fill="' + (c === 'g' ? '#3fd88a' : '#6f9fe0') + '"/><path d="M-14 -12 l14 10 l14 -10" stroke="rgba(0,0,0,.4)" fill="none"/>';
        else g += '<rect x="-13" y="-17" width="26" height="3" fill="#9aa39d"/><rect x="-13" y="-10" width="22" height="3" fill="#b9c0bb"/><rect x="-13" y="-3" width="24" height="3" fill="#b9c0bb"/><rect x="-13" y="4" width="16" height="3" fill="' + (c === 'a' ? '#e0a020' : '#b9c0bb') + '"/>';
        g += '</g>';
      }
      var badge = cs[0] === 'g' ? '#00ff77' : cs[0] === 'a' ? '#ffb020' : cs[0] === 'b' ? '#7fb2ff' : '#00ff77';
      g += '</g><g transform="translate(' + (n * 15 + 14) + ',-24)"><circle r="11" fill="' + badge + '" filter="url(#glow)"/><text y="4.5" text-anchor="middle" font-size="13" font-weight="800" fill="#05170d">' + cs.length + '</text></g></g>';
      s += g;
    });
    return s;
  }
  function bullesSVG() {
    var s = '';
    people().forEach(function (p) {
      var b = S.busy[p.kind]; if (!b) return;
      var y = p.device ? p.y - 120 : p.y - 120, w = Math.min(260, 24 + b.length * 7.2);
      s += '<g class="bulle" transform="translate(' + p.x + ',' + y + ')"><rect x="' + (-w / 2) + '" y="-18" width="' + w + '" height="30" rx="15" fill="#f8f4ea" stroke="#00ff77" stroke-width="2"/><path d="M-6 12 l6 9 l6 -9z" fill="#f8f4ea"/><text y="2" text-anchor="middle" font-size="13" font-weight="700" fill="#1f1a12">' + esc(b) + ' …</text></g>';
    });
    return s;
  }
  function cable(a, b, live) {
    if (!a || !b) return '';
    var C = 470, top = function (p) { return p.y < C; };
    var sx = a.x, sy = top(a) ? a.y + 120 : a.y - 80, ex = b.x, ey = top(b) ? b.y + 120 : b.y - 80;
    var d;
    if (top(a) === top(b)) { var yy = top(a) ? C - 2 : C + 2; d = 'M' + sx + ' ' + sy + ' V' + (yy + (top(a) ? -10 : 10)) + ' Q' + sx + ' ' + yy + ' ' + (sx + (ex > sx ? 10 : -10)) + ' ' + yy + ' H' + (ex + (ex > sx ? -10 : 10)) + ' Q' + ex + ' ' + yy + ' ' + ex + ' ' + (yy + (top(b) ? -10 : 10)) + ' V' + ey; }
    else d = 'M' + sx + ' ' + sy + ' V' + C + ' H' + ex + ' V' + ey;
    var s = '<path class="cable" d="' + d + '" stroke="rgba(0,0,0,.6)" stroke-width="7"/>';
    s += '<path class="cable' + (live ? ' live' : '') + '" d="' + d + '" stroke="' + (live ? '#00ff77' : 'rgba(255,190,90,.18)') + '" stroke-width="' + (live ? 3 : 2) + '"' + (live ? ' filter="url(#glow)"' : '') + '/>';
    if (live) s += '<circle r="5" fill="#d8ffe9" filter="url(#glow)"><animateMotion dur="2.6s" repeatCount="indefinite" path="' + d + '"/></circle>';
    return s;
  }
  function officeSVG() {
    var defs = '<defs><filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="3" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>' +
      '<radialGradient id="halo-on"><stop offset="0" stop-color="#00ff77" stop-opacity=".22"/><stop offset="1" stop-color="#00ff77" stop-opacity="0"/></radialGradient>' +
      '<radialGradient id="halo-slot"><stop offset="0" stop-color="#ffb020" stop-opacity=".16"/><stop offset="1" stop-color="#ffb020" stop-opacity="0"/></radialGradient>' +
      '<radialGradient id="halo-err"><stop offset="0" stop-color="#ff3d5a" stop-opacity=".2"/><stop offset="1" stop-color="#ff3d5a" stop-opacity="0"/></radialGradient>' +
      '<pattern id="tiles" width="40" height="40" patternUnits="userSpaceOnUse"><path d="M40 0H0V40" fill="none" stroke="rgba(255,255,255,.035)"/></pattern>' +
      '<pattern id="parquet" width="60" height="20" patternUnits="userSpaceOnUse"><path d="M0 20H60M30 0V20" fill="none" stroke="rgba(255,190,90,.05)"/></pattern>' +
      '<linearGradient id="wood" x1="0" x2="1"><stop offset="0" stop-color="#3a2c1d"/><stop offset="1" stop-color="#2a2016"/></linearGradient></defs>';
    var HH = D().me && D().me.chef ? 1350 : 1000;
    var s = '<svg viewBox="0 0 1600 ' + HH + '" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="La rédaction de Posthumain vue de haut">' + defs + '<rect width="1600" height="' + HH + '" fill="#0a0806"/>';
    if (HH > 1000) s += '<rect x="20" y="982" width="1560" height="40" fill="#100d09"/><rect x="20" y="982" width="1560" height="40" fill="url(#tiles)"/><text class="roomname" x="40" y="1007" style="font-size:11px">couloir · les bureaux de Julien</text>';
    s += '<rect x="20" y="448" width="1560" height="44" fill="#100d09"/><rect x="20" y="448" width="1560" height="44" fill="url(#tiles)"/><text class="roomname" x="40" y="475" style="font-size:11px">couloir · le chemin du courrier</text>';
    rooms().forEach(function (r) {
      s += '<rect x="' + r.x + '" y="' + r.y + '" width="' + r.w + '" height="' + r.h + '" rx="10" fill="' + r.floor + '"/>';
      s += '<rect x="' + r.x + '" y="' + r.y + '" width="' + r.w + '" height="' + r.h + '" rx="10" fill="url(#' + (r.key === 'redac' || r.key === 'chef' ? 'parquet' : 'tiles') + ')"/>';
      s += '<rect x="' + r.x + '" y="' + r.y + '" width="' + r.w + '" height="' + r.h + '" rx="10" fill="none" stroke="rgba(243,236,224,.16)" stroke-width="5"/>';
      s += '<text class="roomname" x="' + (r.x + 16) + '" y="' + (r.y + 26) + '">' + esc(r.name) + '</text>';
    });
    [[410, 440], [990, 440], [1380, 440], [310, 500], [890, 500], [1380, 500]].forEach(function (p) { s += '<rect x="' + (p[0] - 34) + '" y="' + (p[1] - 4) + '" width="68" height="8" fill="#0a0806"/>'; });
    // décor : étagères de la bibliothèque, tableau de liège de la rédaction, fauteuils du chef
    s += '<g transform="translate(1210,60)">';
    for (var i = 0; i < 9; i++) s += '<rect x="' + (i * 38) + '" y="0" width="34" height="14" rx="2" fill="hsl(' + (i * 37) + ',35%,32%)"/>';
    s += '</g><g transform="translate(60,62)"><rect width="200" height="60" rx="6" fill="#5a4426" stroke="rgba(0,0,0,.4)"/>';
    var arts = artsRecents().slice(0, 5);
    arts.forEach(function (a, j) { s += '<rect x="' + (8 + j * 38) + '" y="' + (8 + (j % 2) * 6) + '" width="32" height="38" fill="' + (a.id === S.art ? '#fff7b0' : '#f3ead6') + '" transform="rotate(' + ((j % 3) - 1) * 4 + ' ' + (24 + j * 38) + ' 27)"/><circle cx="' + (24 + j * 38) + '" cy="' + (11 + (j % 2) * 6) + '" r="2.5" fill="#d42a44"/>'; });
    s += '<text x="100" y="76" text-anchor="middle" class="lbl2">tableau des sujets</text></g>';
    s += '<g transform="translate(120,880)"><rect width="70" height="56" rx="18" fill="#3a2a1c"/><rect x="250" width="70" height="56" rx="18" fill="#3a2a1c"/><text x="160" y="40" text-anchor="middle" font-size="26">🪴</text></g>';
    var pp = people(), J = pp.filter(function (p) { return p.kind === 'journaliste'; });
    var sec = P('secretaire'), asst = P('assistant'), cour = P('courrier'), mar = P('marbre'), chef = P('chef');
    var envoyes = by('envoyé').length, reps = by('a répondu').length;
    J.forEach(function (j) {
      s += cable(j, asst, !!S.busy.assistant);
      s += cable(asst, sec, !!S.busy.secretaire);
      s += cable(j, mar, false);
    });
    s += cable(sec, cour, envoyes > 0 || !!S.busy.secretaire);
    J.forEach(function (j) { s += cable(cour, j, reps > 0); });
    s += cable(chef, mar, false);
    var jsc = P('sc'), jmk = P('mk'), arr = S.arrivees || [];
    if (jsc && jmk) {
      var pth = function (to) { return 'M' + cour.x + ' ' + (cour.y + 70) + ' V1006 H' + to.x + ' V' + (to.y - 80); };
      [[jsc, 'subs'], [jmk, 'redaction']].forEach(function (d) {
        var live = arr.indexOf(d[1]) >= 0, path = pth(d[0]);
        s += '<path class="cable" d="' + path + '" stroke="rgba(0,0,0,.6)" stroke-width="7" fill="none"/><path class="cable' + (live ? ' live' : '') + '" d="' + path + '" fill="none" stroke="' + (live ? '#00ff77' : 'rgba(255,190,90,.18)') + '" stroke-width="' + (live ? 3 : 2) + '"' + (live ? ' filter="url(#glow)"' : '') + '/>';
        if (live) s += '<g filter="url(#glow)"><rect x="-16" y="-11" width="32" height="22" rx="3" fill="#e2ffef" stroke="#00ff77" stroke-width="2"/><path d="M-16 -11 l16 12 l16 -12" stroke="#1d6b45" stroke-width="2" fill="none"/><animateMotion dur="2.8s" fill="freeze" path="' + path + '"/></g>';
      });
    }
    pp.forEach(function (p) { s += p.device ? deviceSVG(p) : deskSVG(p); });
    s += pilesSVG() + bullesSVG() + '</svg>';
    return s;
  }

  // ---------- haut de page ----------
  var fClock = new Intl.DateTimeFormat('fr-CH', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
  function unread() {
    var seen = LS.get('wl-vu') || '', me = D().me.id;
    return D().messages.filter(function (m) { return m.auteur !== me && String(m.le) > seen; }).length;
  }
  function header() {
    var a = art(S.art), v = by('brouillon').length, r = by('a répondu').length, e = by('envoyé').length;
    return '<div class="logo">WRITINGLAB<small>La rédaction de Posthumain</small></div>' +
      '<div class="chips">' +
      '<span class="chip art" data-act="articles" title="Changer d’article">📰 ' + (a ? esc(a.titre) : 'Choisir l’article en cours') + '</span>' +
      (v ? '<span class="chip warn" data-act="open-ag" data-ag="secretaire">🟠 ' + v + ' à valider</span>' : '') +
      (r ? '<span class="chip hot" data-act="open-ag" data-ag="courrier">📬 ' + r + ' réponse' + pl(r) + '</span>' : '') +
      (e ? '<span class="chip" data-act="open-ag" data-ag="courrier">⏳ ' + e + ' en attente</span>' : '') +
      '<span class="chip" data-act="refresh" title="Recharger">↻</span>' +
      '<span class="chip" data-act="open-aide" title="Configurer son adresse @posthumain.com dans Outlook" style="opacity:.6">✉︎ ?</span></div>' +
      '<div class="clock">' + fClock.format(new Date()) + '</div>';
  }
  function tabs() {
    var u = unread();
    return [['bureau', '🏢 Rédaction'], ['articles', '📰 Articles'], ['suivi', '✉️ Suivi'], ['interphone', '📞 Interphone' + (u ? '<span class="n">' + u + '</span>' : '')]]
      .map(function (t) { return '<div class="tab' + (S.tab === t[0] ? ' sel' : '') + '" data-tab="' + t[0] + '">' + t[1] + '</div>'; }).join('');
  }

  // ---------- onglets ----------
  function viewBureau() {
    var cards = people().map(function (p) {
      var o = stOf(p), n = pileOf(p).length;
      return '<div class="card" data-act="open-ag" data-ag="' + esc(p.key) + '"><div class="h"><span class="em">' + p.emoji + '</span><span style="flex:1">' + esc(p.nom) + (n ? ' <span class="tag ' + (o.s === 'on' ? 'g' : 'a') + '">' + n + '</span>' : '') + '</span><span class="led ' + o.s + '"></span></div><div class="s">' + esc(o.why) + '</div></div>';
    }).join('');
    return '<div class="floor">' + officeSVG() + '</div><div class="hint">Touchez un employé ou les fiches au-dessus de sa tête. Vert : au travail ou réponse arrivée · orange : quelque chose vous attend.</div><div class="grid">' + cards + '</div>';
  }
  function artCard(a) {
    var n = D().fiches.filter(function (f) { return f.article_id === a.id; }).length;
    return '<div class="ar' + (a.id === S.art ? ' sel' : '') + '" data-act="pick-art" data-id="' + esc(a.id) + '"><div class="ph">' + (a.image ? '<img loading="lazy" alt="" src="' + esc(a.image) + '">' : '📰') + '</div><div class="b"><div class="ti">' + esc(a.titre) + '</div><div class="me">' +
      '<span class="tag ' + (a.statut === 'scheduled' ? 'b' : 'a') + '">' + (a.statut === 'scheduled' ? 'programmé' : 'brouillon') + '</span>' + (a.mien ? '<span class="tag g">le vôtre</span>' : '') + (n ? '<span class="tag">' + n + ' contact' + pl(n) + '</span>' : '') +
      '<br>' + esc((a.auteurs || []).join(', ')) + ' · modifié ' + esc(when(a.maj)) + ' · <a href="' + esc(a.editeur) + '" target="_blank" rel="noopener" data-stop="1">ouvrir dans Ghost</a></div></div></div>';
  }
  function viewArticles() {
    var as = artsRecents();
    if (D().ghost && D().ghost !== 'ok') return '<div class="box warn" style="margin-top:14px">⚠️ ' + esc(D().ghost) + '</div>';
    return '<p class="muted" style="margin-top:14px">L’article en cours guide l’Assistant (questions, chercheurs à contacter) et reçoit les citations. Brouillons et articles programmés de Ghost :</p><div class="arts">' + (as.map(artCard).join('') || '<div class="muted">Aucun brouillon dans Ghost.</div>') + '</div>';
  }
  function dcard(f, extra) {
    var s = STATUTS[f.statut] || ['·', f.statut, ''];
    return '<div class="dcard ' + s[2] + '" data-act="' + (f.statut === 'brouillon' ? 'open-valid' : 'open-fiche') + '" data-id="' + esc(f.fiche_id) + '"><div class="k">' + s[0] + ' ' + esc(s[1]) + (D().me.chef && f.redacteur !== D().me.id ? ' · ' + esc(membre(f.redacteur).nom) : '') + '</div>' +
      '<div class="ti">' + esc(f.contact.nom || '(sans nom)') + '</div><div class="su">' + esc([f.contact.role, f.contact.institution].filter(Boolean).join(', ')) + '</div>' +
      '<div class="su">📰 ' + esc(f.article_titre || 'sans article') + '</div>' + (extra || '') + '</div>';
  }
  function viewSuivi() {
    var cols = [['brouillon', '🟠 À valider'], ['envoyé', '📨 Envoyés'], ['a répondu', '📬 Réponses'], ['inséré', '✅ Cités']];
    var vide = !D().fiches.length;
    var intro = '<p class="muted" style="margin-top:14px">Le parcours des demandes d’interview' + (D().me.chef ? ' de toute la rédaction' : '') + ' : mail rédigé par la Secrétaire → envoyé → réponse reçue → citation insérée dans l’article. Les fiches archivées n’apparaissent plus ici.</p>' +
      (vide ? '<div class="box" style="margin-top:6px">Aucune demande en cours pour l’instant. Pour en lancer une : choisissez un article, puis demandez à l’Assistant qui interroger.<div class="row" style="margin-top:10px"><button class="btn" data-act="open-ag" data-ag="assistant">🧠 Préparer une interview</button><button class="btn small" data-act="open-ag" data-ag="secretaire">📮 Écrire à quelqu’un</button></div></div>' : '');
    return intro + '<div class="kan" style="margin-top:14px">' + cols.map(function (c) {
      var fs = by(c[0]);
      return '<div class="col"><h4>' + c[1] + ' <span class="tag">' + fs.length + '</span></h4><div class="dos">' + (fs.map(function (f) {
        var x = c[0] === 'envoyé' ? '<div class="su">envoyé ' + esc(when(f.envoye_le)) + (relancable(f) ? ' · <b>relance possible</b>' : '') + '</div>' : c[0] === 'a répondu' ? '<div class="su">réponse ' + esc(when(f.reponse_le)) + '</div>' : '';
        return dcard(f, x);
      }).join('') || '<div class="muted">Rien ici.</div>') + '</div></div>';
    }).join('') + '</div>';
  }
  var CATS = [['factures', '🧾 Factures'], ['documents', '📄 Documents'], ['images', '🖼️ Images'], ['contrats', '✍️ Contrats'], ['articles', '📰 Articles'], ['autres', '📦 Autres']];
  function catNom(c) { var x = CATS.filter(function (k) { return k[0] === c; })[0]; return x ? x[1] : '📦 Autres'; }
  function taille(n) { return n > 1048576 ? (n / 1048576).toFixed(1) + ' Mo' : Math.max(1, Math.round(n / 1024)) + ' Ko'; }
  function fichierHTML(f) {
    var img = /^image\//.test(f.type) && f.url;
    return '<a class="pj" href="' + esc(f.url || '#') + '" target="_blank" rel="noopener" data-stop="1" style="display:flex;gap:10px;align-items:center;margin-top:6px;padding:8px 10px;border-radius:10px;background:rgba(255,255,255,.06);border:1px solid rgba(255,190,90,.2);text-decoration:none">' +
      (img ? '<img src="' + esc(f.url) + '" alt="" style="width:46px;height:46px;object-fit:cover;border-radius:6px">' : '<span style="font-size:24px">📎</span>') +
      '<span style="min-width:0"><b style="display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#f3ece0">' + esc(f.nom) + '</b><span class="muted">' + esc(catNom(f.categorie)) + ' · ' + taille(f.taille) + (f.url ? '' : ' · lien expiré, ↻') + '</span></span></a>';
  }
  function piecesHTML(list) {
    if (!list || !list.length) return '';
    return '<div style="margin:8px 0 14px">' + list.map(function (f) {
      return '<a href="' + esc(f.url || '#') + '" target="_blank" rel="noopener" data-stop="1" style="display:inline-flex;gap:6px;align-items:center;margin:4px 6px 4px 0;padding:6px 10px;border-radius:999px;border:1px solid #cfc4ad;background:#f6f1e4;color:#1f1a12;text-decoration:none;font-size:15px">📎 ' + esc(f.nom) + ' <span style="opacity:.6">' + taille(f.taille || 0) + '</span></a>';
    }).join('') + '</div>';
  }
  // pièces à joindre à un mail qui part (gardées par mail dans S.pjs, envoyées en base64 avec « Valider et envoyer »)
  function pjWidget(key) {
    var l = (S.pjs && S.pjs[key]) || [];
    return '<div class="pjw" data-pjw="' + esc(key) + '" style="margin:6px 0 2px"><label>Pièces jointes</label>' +
      l.map(function (f, k) { return '<span style="display:inline-flex;gap:6px;align-items:center;margin:4px 6px 4px 0;padding:6px 10px;border-radius:999px;border:1px solid #cfc4ad;background:#f6f1e4;font-size:15px">📎 ' + esc(f.nom) + ' <span style="opacity:.6">' + taille(f.taille) + '</span> <a href="#" data-act="pjs-del" data-id="' + esc(key) + '" data-i="' + k + '" style="color:#b0342b">✕</a></span>'; }).join('') +
      '<button type="button" data-act="pjs-add" data-id="' + esc(key) + '">📎 Joindre un fichier</button></div>';
  }
  function pjsData(key) { return ((S.pjs && S.pjs[key]) || []).map(function (f) { return { nom: f.nom, type: f.type, data: f.data }; }); }
  function viewInterphone() {
    var me = D().me.id, ms = D().messages, fc = S.filtreCat || '';
    var fichiers = ms.filter(function (m) { return m.fichier; });
    var list = ms.map(function (m) {
      return '<div class="bub' + (m.auteur === me ? ' me' : '') + '"><div class="who">' + esc(m.nom) + ' · ' + esc(when(m.le)) + (m.article_titre ? ' · 📰 ' + esc(m.article_titre) : '') + '</div>' + (m.texte ? esc(m.texte).replace(/\n/g, '<br>') : '') + (m.fichier ? fichierHTML(m.fichier) : '') + '</div>';
    }).join('');
    var a = art(S.art);
    return '<p class="muted" style="margin-top:14px">Les messages et fichiers entre la rédaction et le rédacteur en chef. Entrée pour envoyer, Maj + Entrée pour aller à la ligne. Les fichiers échangés sont rangés dans le classeur, à droite.</p>' + classeurHTML(fichiers) +
      '<div class="chat">' + (list || '<div class="muted">Pas encore de message.</div>') + '</div>' +
      '<div class="composer"><textarea class="in" id="wl-msg" placeholder="' + (S.dicte ? '🎙️ Je vous écoute…' : 'Votre message…') + '" rows="3">' + esc(S.msgDraft || '') + '</textarea>' +
      '<div id="wl-pj-zone">' + pjZone() + '</div>' +
      '<div class="row" style="margin-top:8px;gap:8px;flex-wrap:wrap"><input type="file" id="wl-pj" style="display:none"><button class="btn" data-act="pj-choisir" type="button">📎 Joindre un fichier</button>' +
      (SR ? '<button class="btn mic' + (S.dicte ? ' on' : '') + '" data-act="dicter" type="button" title="Dicter le message (le texte s’écrit dans le champ, vous relisez puis envoyez)">' + (S.dicte ? '⏹️ Arrêter' : '🎙️ Dicter') + '</button>' : '') +
      (a ? '<label class="muted" style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="wl-msg-art"> lié à « ' + esc(a.titre.slice(0, 60)) + ' »</label>' : '') +
      '<span style="flex:1"></span><button class="btn go" data-act="send-msg">Envoyer</button></div></div>';
  }
  // Classeur : tiroir replié sur le bord droit (poignée), ouvert par-dessus le fil sans rien pousser ; plein écran sur mobile.
  function classeurBody(fichiers) {
    fichiers = fichiers || D().messages.filter(function (m) { return m.fichier; });
    var fc = S.filtreCat || '';
    if (!fichiers.length) return '<p class="muted">Aucun fichier pour l’instant. Les pièces jointes envoyées dans l’interphone (factures, documents, images…) se rangent ici par catégorie.</p>';
    var l = fichiers.filter(function (m) { return !fc || m.fichier.categorie === fc; }).slice().reverse();
    return '<div class="clsr-cats"><span class="chip' + (fc ? '' : ' art') + '" data-act="filtre-cat" data-id="">Tout (' + fichiers.length + ')</span>' +
      CATS.map(function (c) { var n = fichiers.filter(function (m) { return m.fichier.categorie === c[0]; }).length; return n ? '<span class="chip' + (fc === c[0] ? ' art' : '') + '" data-act="filtre-cat" data-id="' + c[0] + '">' + c[1] + ' (' + n + ')</span>' : ''; }).join('') + '</div>' +
      (l.map(function (m) { return '<div style="margin-top:12px"><span class="muted">' + esc(m.nom) + ' · ' + esc(when(m.le)) + '</span>' + fichierHTML(m.fichier) + '</div>'; }).join('') || '<p class="muted">Rien dans cette catégorie.</p>');
  }
  function classeurHTML(fichiers) {
    var o = S.clsr ? ' open' : '';
    return '<button type="button" class="clsr-h' + o + '" data-act="clsr" aria-label="Ouvrir le classeur"><span class="ic">🗂️</span><span class="lb">Classeur</span>' + (fichiers.length ? '<span class="n">' + fichiers.length + '</span>' : '') + '</button>' +
      '<div class="clsr-bg' + o + '" data-act="clsr"></div><aside class="clsr' + o + '" aria-label="Classeur"><div class="clsr-top"><b>🗂️ Classeur</b><span class="x" data-act="clsr" role="button" aria-label="Fermer">✕</span></div><div class="clsr-body">' + classeurBody(fichiers) + '</div></aside>';
  }
  function majClasseur() {
    var r = S.root; if (!r) return;
    ['.clsr', '.clsr-bg', '.clsr-h'].forEach(function (q) { var e = r.querySelector(q); if (e) e.classList.toggle('open', !!S.clsr); });
    var b = r.querySelector('.clsr-body'); if (b) b.innerHTML = classeurBody();
  }
  // Dictée (Interphone) : reconnaissance vocale du navigateur (Chrome, Edge, Safari macOS/iOS), en français.
  // Le texte s'écrit dans le champ au fil de la voix ; on relit, puis Entrée ou « Envoyer ». Rien ne part tout seul.
  var SR = window.SpeechRecognition || window.webkitSpeechRecognition || null;
  function majMic() {
    var b = S.root && S.root.querySelector('[data-act="dicter"]'); if (b) { b.classList.toggle('on', !!S.dicte); b.textContent = S.dicte ? '⏹️ Arrêter' : '🎙️ Dicter'; }
    var ta = S.root && S.root.querySelector('#wl-msg'); if (ta) ta.placeholder = S.dicte ? '🎙️ Je vous écoute…' : 'Votre message…';
  }
  function startDictee() {
    if (!SR) { toast('La dictée n’est pas disponible dans ce navigateur.', true); return; }
    var ta = S.root.querySelector('#wl-msg'); if (!ta) return;
    var base = ta.value ? ta.value.replace(/\s*$/, ' ') : '', fini = '';
    var rec = new SR(); rec.lang = 'fr-FR'; rec.continuous = true; rec.interimResults = true;
    rec.onresult = function (ev) {
      var interim = '';
      for (var i = ev.resultIndex; i < ev.results.length; i++) { var t = ev.results[i][0].transcript; if (ev.results[i].isFinal) fini += t; else interim += t; }
      var txt = (base + fini + interim).replace(/^\s+/, '');
      var el = S.root.querySelector('#wl-msg'); if (el) { el.value = txt; el.scrollTop = el.scrollHeight; }
      S.msgDraft = (base + fini).replace(/^\s+/, '');
    };
    rec.onerror = function (ev) { if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') toast('Autorisez le micro pour posthumain.com dans le navigateur.', true); else if (ev.error !== 'no-speech' && ev.error !== 'aborted') toast('Dictée interrompue (' + ev.error + ').', true); };
    rec.onend = function () { S.rec = null; S.dicte = false; majMic(); var el = S.root.querySelector('#wl-msg'); if (el) { S.msgDraft = el.value; el.focus(); } };
    try { rec.start(); } catch (e) { toast('Impossible de lancer la dictée.', true); return; }
    S.rec = rec; S.dicte = true; majMic();
  }
  function stopDictee() { S.dicte = false; if (S.rec) { try { S.rec.stop(); } catch (e) {} } majMic(); }
  function pjZone() {
    if (!S.pj) return '';
    return '<div class="box" style="margin-top:8px;display:flex;gap:10px;align-items:center;flex-wrap:wrap"><span>📎 <b>' + esc(S.pj.nom) + '</b> <span class="muted">' + taille(S.pj.taille) + '</span></span>' +
      '<select class="in" id="wl-pj-cat" style="width:auto;flex:0 0 auto">' + CATS.map(function (c) { return '<option value="' + c[0] + '"' + (S.pj.categorie === c[0] ? ' selected' : '') + '>' + c[1] + '</option>'; }).join('') + '</select>' +
      '<button class="btn small" data-act="pj-retirer" type="button">✕ Retirer</button></div>';
  }
  function devinerCat(f) {
    var n = (f.name || '').toLowerCase();
    if (/factur|invoice|re[cç]u|receipt|note.?de.?frais/.test(n)) return 'factures';
    if (/contrat|contract|devis/.test(n)) return 'contrats';
    if (/^image\//.test(f.type)) return 'images';
    if (/pdf|word|document|text/.test(f.type)) return 'documents';
    return 'autres';
  }
  function majPj() { var z = S.root.querySelector('#wl-pj-zone'); if (z) z.innerHTML = pjZone(); }


  // ---------- panneaux (le bureau de chaque employé) ----------
  function openPanel(key) { S.panel = key; paintPanel(); var r = S.root; r.querySelector('.panel').classList.add('open'); r.querySelector('.panelbg').classList.add('open'); r.querySelector('.panel').scrollTop = 0; }
  function closePanel() { S.panel = null; S.reformule = null; S.root.querySelector('.panel').classList.remove('open'); S.root.querySelector('.panelbg').classList.remove('open'); }
  function head(emoji, nom, st) { return '<div class="ph2"><span class="em">' + emoji + '</span><div><div class="nm">' + esc(nom) + '</div><div class="st">' + (st || '') + '</div></div><span class="x" data-act="close-panel">✕</span></div>'; }
  function paintPanel() {
    if (!S.panel || !S.root) return;
    var el = S.root.querySelector('.panel');
    var keep = el.scrollTop, ae = document.activeElement;
    if (ae && el.contains(ae) && (ae.tagName === 'TEXTAREA' || ae.tagName === 'INPUT')) return; // on ne repeint pas sous les doigts de la journaliste
    var k = S.panel, h = '';
    if (k === 'secretaire') h = panelSecretaire();
    else if (k === 'assistant') h = panelAssistant();
    else if (k === 'courrier') h = panelCourrier();
    else if (k === 'marbre' || k === 'articles') h = panelArticles();
    else if (k === 'chef') h = panelChef();
    else if (k === 'sc' || k === 'mk') h = panelJulien(k);
    else if (k.indexOf('j:') === 0) h = panelJournaliste(k.slice(2));
    el.innerHTML = h; el.scrollTop = keep; markBusy();
  }
  function mcard(m) {
    var t = m.statut === 'répondu' ? ['✅', 'répondu', 'g'] : m.brouillon_corps ? ['🟠', 'réponse à valider', 'a'] : m.categorie === 'demande' ? ['📩', 'demande', 'g'] : ['❔', 'à vérifier', ''];
    return '<div class="dcard ' + t[2] + '" data-act="open-mail" data-id="' + esc(m.mail_id) + '"><div class="k">' + t[0] + ' ' + t[1] + (m.abonne === 'oui' ? ' · abonné' : m.abonne === 'gratuit' ? ' · membre gratuit' : '') + '</div>' +
      '<div class="ti">' + esc(m.sujet || '(sans objet)') + '</div><div class="su">' + esc(m.de_nom) + ' · ' + esc(when(m.recu_le)) + '</div></div>';
  }
  function panelJulien(k) {
    var J = JULIEN[k], ms = mails(J.boite), faits = mails(J.boite, true).filter(function (m) { return m.statut === 'répondu'; }).slice(0, 8);
    var dem = ms.filter(function (m) { return m.categorie === 'demande'; }), ver = ms.filter(function (m) { return m.categorie !== 'demande'; });
    var h = head(J.emoji, J.nom, J.adr + (S.busy[k] ? ' · ' + esc(S.busy[k]) + '…' : ''));
    h += '<div class="pb"><p class="muted">Le Courrier trie seul les mails qui arrivent (sans IA) : notifications, newsletters et réponses automatiques sont écartées. Julien ne rédige une réponse que quand vous le lui demandez, et rien ne part sans votre validation.</p>';
    h += '<h4>📩 Demandes (' + dem.length + ')</h4><div class="dos">' + (dem.map(mcard).join('') || '<div class="muted">Aucune demande en attente.</div>') + '</div>';
    h += '<h4 style="margin-top:16px">❔ À vérifier (' + ver.length + ')</h4><div class="dos">' + (ver.map(mcard).join('') || '<div class="muted">Rien à vérifier.</div>') + '</div>';
    if (faits.length) h += '<h4 style="margin-top:16px">✅ Répondu récemment</h4><div class="dos">' + faits.map(mcard).join('') + '</div>';
    if (k === 'mk') h += prospection();
    return h + '</div>';
  }
  // ---------- Prospection (bureau Marketing) ----------
  var OFFRES = [['article', '📰 Article de partenariat'], ['newsletter', '✉️ Encart newsletter'], ['video', '🎬 Vidéo'], ['pack', '📦 Pack visibilité'], ['abonnements', '👥 Abonnements équipes'], ['tv', '📺 Posthumain TV']];
  var PST = { a_contacter: ['🔎', 'à contacter', ''], brouillon: ['🟠', 'mail à valider', 'a'], contacte: ['📨', 'contacté', ''], relance: ['🔁', 'relancé', ''], repondu: ['💬', 'a répondu', 'g'], client: ['🤝', 'client', 'g'], refus: ['⛔', 'ne plus contacter', ''] };
  function offreNom(o) { var f = OFFRES.filter(function (x) { return x[0] === o; })[0]; return f ? f[1] : o; }
  function pcard(x) {
    var t = PST[x.statut] || ['•', x.statut, ''];
    return '<div class="dcard ' + t[2] + '" data-act="open-prospect" data-id="' + esc(x.prospect_id) + '"><div class="k">' + t[0] + ' ' + esc(t[1]) + (x.email ? '' : ' · adresse à trouver') + '</div>' +
      '<div class="ti">' + esc(x.entreprise) + '</div><div class="su">' + esc([x.contact_nom, x.secteur, x.pays].filter(Boolean).join(' · ')) + '</div></div>';
  }
  function prospection() {
    var cs = D().campagnes || [], ps = D().prospects || [], busy = !!S.busy.mk;
    var h = '<h3 style="margin-top:22px">🎯 Prospection</h3><p class="muted">Julien cherche des entreprises qui ont une vraie raison d’acheter l’une de nos offres, trouve la bonne personne et une adresse publiée officiellement (jamais devinée), puis rédige un mail court et personnalisé. Rien ne part sans votre « Valider et envoyer » ; une seule relance au plus, et un STOP retire l’adresse pour toujours.</p>';
    if (S.newCamp) {
      var nc = S.newCamp;
      h += '<div class="box"><label class="f">Nom de la campagne</label><input class="in" data-nc="nom" value="' + esc(nc.nom) + '" placeholder="ex. Start-up IA romandes — automne">' +
        '<label class="f">Offres à vendre</label><div style="display:flex;flex-wrap:wrap;gap:6px 14px;margin:4px 0 6px">' + OFFRES.map(function (o) {
          return '<label class="muted" style="display:flex;gap:6px;align-items:center"><input type="checkbox" data-nco="' + o[0] + '"' + (nc.offres.indexOf(o[0]) >= 0 ? ' checked' : '') + '> ' + o[1] + '</label>'; }).join('') + '</div>' +
        '<label class="f">Cible</label><textarea class="in" data-nc="cible" rows="3" placeholder="ex. start-up et PME tech qui lancent un produit IA grand public, écoles d’ingénieurs, agences de communication…">' + esc(nc.cible) + '</textarea>' +
        '<label class="f">Zone</label><input class="in" data-nc="zone" value="' + esc(nc.zone) + '" placeholder="Suisse romande, France, Belgique">' +
        '<div class="row" style="margin-top:10px"><button class="btn go" data-act="camp-create">✅ Créer la campagne</button><button class="btn small" data-act="camp-cancel">Annuler</button></div></div>';
    } else h += '<div class="row"><button class="btn" data-act="camp-new">＋ Nouvelle campagne</button></div>';
    if (!cs.length && !S.newCamp) h += '<p class="muted">Aucune campagne pour l’instant.</p>';
    cs.forEach(function (c) {
      var l = ps.filter(function (x) { return x.campagne_id === c.campagne_id; });
      var n = function (st) { return l.filter(function (x) { return x.statut === st; }).length; };
      var open = S.campOpen === c.campagne_id || cs.length === 1;
      h += '<div class="box" style="margin-top:12px"><div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start;cursor:pointer" data-act="camp-toggle" data-id="' + esc(c.campagne_id) + '"><div><b>' + esc(c.nom) + '</b><div class="muted">' + c.offres.map(offreNom).map(esc).join(' · ') + (c.zone ? ' — ' + esc(c.zone) : '') + '</div></div>' +
        '<div class="muted" style="white-space:nowrap">' + l.length + ' prospect' + pl(l.length) + (n('repondu') ? ' · 💬 ' + n('repondu') : '') + (n('client') ? ' · 🤝 ' + n('client') : '') + '</div></div>';
      if (open) {
        if (c.cible) h += '<div class="muted" style="margin-top:6px">Cible : ' + esc(c.cible) + '</div>';
        h += '<div class="row" style="margin-top:10px"><button class="btn" data-act="p-chercher" data-id="' + esc(c.campagne_id) + '"' + (busy ? ' disabled' : '') + '>🔎 Chercher des prospects</button></div><p class="muted">La recherche prend une à deux minutes : Julien vérifie chaque entreprise sur le web.</p>';
        ['repondu', 'brouillon', 'a_contacter', 'contacte', 'relance', 'client', 'refus'].forEach(function (st) {
          var g = l.filter(function (x) { return x.statut === st; }); if (!g.length) return;
          h += '<h4 style="margin-top:12px">' + PST[st][0] + ' ' + esc(PST[st][1]) + ' (' + g.length + ')</h4><div class="dos">' + g.map(pcard).join('') + '</div>';
        });
      }
      h += '</div>';
    });
    return h;
  }
  function docProspect(x) {
    var c = campagne(x.campagne_id), busy = !!S.busy.mk, t = PST[x.statut] || ['•', x.statut];
    var ed = (S.pEdit && S.pEdit[x.prospect_id]) || { sujet: x.mail_sujet || '', corps: x.mail_corps || '', email: x.email || '' };
    var h = '<div class="dtop"><span class="em">🎯</span><div><div class="nm">' + esc(x.entreprise) + '</div><div class="st">' + t[0] + ' ' + esc(t[1]) + (c ? ' · ' + esc(c.nom) : '') + '</div></div><span class="x" data-act="close-doc">✕</span></div>';
    h += '<div class="paper"><div class="kick">Prospect · ' + esc([x.secteur, x.pays].filter(Boolean).join(' · ')) + '</div>' +
      '<div class="meta">' + (x.site ? '🌐 <a href="' + esc(/^https?:/.test(x.site) ? x.site : 'https://' + x.site) + '" target="_blank" rel="noopener" data-stop="1">' + esc(x.site) + '</a><br>' : '') +
      '👤 ' + esc([x.contact_nom, x.contact_role].filter(Boolean).join(', ') || 'contact à préciser') + '<br>' +
      '✉️ ' + (x.email ? esc(x.email) + (x.source_email ? ' · <a href="' + esc(x.source_email) + '" target="_blank" rel="noopener" data-stop="1">où elle est publiée</a>' : '') : 'aucune adresse publiée trouvée : saisissez-en une si vous la connaissez') + '</div>' +
      (x.pourquoi ? '<div style="border-left:3px solid #d8cfbd;padding:6px 12px;margin:10px 0 14px"><b>Pourquoi maintenant :</b> ' + esc(x.pourquoi) + '</div>' : '');
    if (x.envoye_le) h += '<p class="muted">Premier mail envoyé ' + esc(when(x.envoye_le)) + (x.relance_le ? ' · relancé ' + esc(when(x.relance_le)) : '') + '.</p>';
    if (x.statut === 'refus') return h + '<div class="lead">⛔ Ce prospect ne sera plus contacté.</div></div>';
    var fini = x.statut === 'client' || x.statut === 'relance' || x.statut === 'repondu';
    var relance = x.statut === 'contacte';
    if (!fini) {
      h += '<label>Consigne pour Julien (facultatif)</label><input class="pin" id="wl-p-consigne" placeholder="ex. insister sur la vidéo, mentionner leur levée de fonds, ton plus formel…">' +
        '<div class="acts"><button data-act="p-rediger" data-id="' + esc(x.prospect_id) + '"' + (busy ? ' disabled' : '') + '>🤖 ' + (relance ? 'Rédiger la relance' : ed.corps ? 'Autre proposition' : 'Rédiger le mail') + '</button></div>' +
        '<label>Adresse</label><input class="pin" id="wl-p-email" value="' + esc(ed.email) + '" inputmode="email" autocomplete="off">' +
        '<label>Objet</label><input class="pin sub" id="wl-p-sujet" value="' + esc(ed.sujet) + '">' +
        '<label>Message</label><textarea class="pin big" id="wl-p-corps" placeholder="Demandez une proposition à Julien ou écrivez le mail.">' + esc(ed.corps) + '</textarea>' +
        '<div class="acts"><button class="go" data-act="p-envoyer" data-id="' + esc(x.prospect_id) + '"' + (busy ? ' disabled' : '') + '>✅ Valider et envoyer' + (relance ? ' la relance' : '') + '</button>' +
        '<button data-act="p-garder" data-id="' + esc(x.prospect_id) + '">💾 Garder</button></div>';
    } else if (x.mail_corps) h += '<label>Dernier mail</label><div><b>' + esc(x.mail_sujet) + '</b></div><div style="white-space:pre-wrap">' + esc(x.mail_corps) + '</div>';
    h += '<div class="acts">' + (x.statut !== 'client' ? '<button data-act="p-statut" data-st="client" data-id="' + esc(x.prospect_id) + '">🤝 Devenu client</button>' : '') +
      (x.statut === 'contacte' || x.statut === 'relance' ? '<button data-act="p-statut" data-st="repondu" data-id="' + esc(x.prospect_id) + '">💬 A répondu</button>' : '') +
      '<button class="red" data-act="p-stop" data-id="' + esc(x.prospect_id) + '">⛔ Ne plus contacter</button></div>' +
      '<p class="lead">Le mail part de redaction@posthumain.com, signé Julien, avec la ligne « répondez STOP ». Les réponses arrivent dans ce bureau et ce prospect passe tout seul en « a répondu ».</p>';
    var hi = (x.historique || []).slice().reverse().slice(0, 8);
    if (hi.length) h += '<label>Historique</label><div class="muted">' + hi.map(function (e) { return esc(when(e.t)) + ' — ' + esc(e.e); }).join('<br>') + '</div>';
    return h + '</div>';
  }
  function docMail(m) {
    var J = m.boite === 'subs' ? JULIEN.sc : JULIEN.mk;
    var ed = (S.mEdit && S.mEdit[m.mail_id]) || { sujet: m.brouillon_sujet || ('Re: ' + (m.sujet || '')), corps: m.brouillon_corps || '' };
    var fait = m.statut === 'répondu', busy = !!S.busy[m.boite === 'subs' ? 'sc' : 'mk'];
    var h = '<div class="dtop"><span class="em">' + J.emoji + '</span><div><div class="nm">' + esc(m.sujet || '(sans objet)') + '</div><div class="st">' + esc(J.nom) + ' · reçu ' + esc(when(m.recu_le)) + '</div></div><span class="x" data-act="close-doc">✕</span></div>';
    h += '<div class="paper"><div class="kick">' + (m.categorie === 'demande' ? 'Demande' : 'À vérifier') + ' · ' + esc(m.motif || '') + '</div>' +
      '<div class="meta">De : <b>' + esc(m.de_nom) + '</b> &lt;' + esc(m.de_email) + '&gt;' + (m.abonne === 'oui' ? ' <span class="tag g">abonné payant</span>' : m.abonne === 'gratuit' ? ' <span class="tag">membre gratuit</span>' : '') + '</div>' +
      '<div style="white-space:pre-wrap;border-left:3px solid #d8cfbd;padding:6px 12px;margin:10px 0 18px;max-height:340px;overflow:auto">' + esc(m.texte || '(message vide)') + '</div>' + piecesHTML(m.pieces) +
      (m.membre_id ? '<div class="acts" style="margin-top:0"><a class="btn" href="https://the-last-journal.ghost.io/ghost/#/members/' + esc(m.membre_id) + '" target="_blank" rel="noopener" data-stop="1" style="text-decoration:none">👤 Ouvrir le membre dans Ghost</a></div>' : '<p class="muted" style="margin:0 0 12px">Aucun compte Posthumain à cette adresse.</p>');
    if (fait) return h + '<div class="lead">✅ Réponse envoyée ' + esc(when(m.envoye_le)) + '.</div><label>Objet</label><div>' + esc(m.brouillon_sujet) + '</div><label>Message</label><div style="white-space:pre-wrap">' + esc(m.brouillon_corps) + '</div></div>';
    h += '<label>Consigne pour Julien (facultatif)</label><input class="pin" id="wl-m-consigne" placeholder="ex. proposer de résilier pour lui, ton plus chaleureux…">' +
      '<div class="acts"><button data-act="m-propose" data-id="' + esc(m.mail_id) + '"' + (busy ? ' disabled' : '') + '>🤖 ' + (ed.corps ? 'Autre proposition' : 'Proposer une réponse') + '</button></div>' +
      '<label>Objet</label><input class="pin sub" id="wl-m-sujet" value="' + esc(ed.sujet) + '">' +
      '<label>Réponse</label><textarea class="pin big" id="wl-m-corps" placeholder="Écrivez la réponse ou demandez une proposition à Julien.">' + esc(ed.corps) + '</textarea>' + pjWidget('m:' + m.mail_id) +
      '<div class="acts"><button class="go" data-act="m-send" data-id="' + esc(m.mail_id) + '"' + (busy ? ' disabled' : '') + '>✅ Valider et envoyer</button>' +
      '<button data-act="m-save" data-id="' + esc(m.mail_id) + '">💾 Garder</button>' +
      (m.categorie !== 'demande' ? '<button data-act="m-demande" data-id="' + esc(m.mail_id) + '">📩 C’est une vraie demande</button>' : '') +
      '<button class="red" data-act="m-archive" data-id="' + esc(m.mail_id) + '">🗄️ Archiver</button></div>' +
      '<p class="lead">La réponse part de ' + esc(J.adr) + ', seulement quand vous cliquez sur « Valider et envoyer ».</p></div>';
    return h;
  }
  function artBox() {
    var a = art(S.art);
    return a ? '<div class="box"><div class="muted">Article en cours</div><b>' + esc(a.titre) + '</b><div class="row" style="margin-top:8px"><button class="btn small" data-act="articles">Changer</button><a class="btn small" href="' + esc(a.editeur) + '" target="_blank" rel="noopener">Ouvrir dans Ghost</a></div></div>'
      : '<div class="box warn">Choisissez d’abord l’article sur lequel vous travaillez.<div style="margin-top:8px"><button class="btn amber" data-act="articles">📰 Choisir un article</button></div></div>';
  }
  function contactForm(prefix, c) {
    c = c || {};
    return '<div class="two"><div><label class="f">Nom</label><input class="in" data-' + prefix + '="nom" value="' + esc(c.nom) + '" autocomplete="off"></div>' +
      '<div><label class="f">Adresse e-mail</label><input class="in" type="email" data-' + prefix + '="email" value="' + esc(c.email) + '" autocomplete="off" inputmode="email"></div></div>' +
      '<div class="two"><div><label class="f">Fonction</label><input class="in" data-' + prefix + '="role" value="' + esc(c.role) + '"></div>' +
      '<div><label class="f">Institution</label><input class="in" data-' + prefix + '="institution" value="' + esc(c.institution) + '"></div></div>' +
      '<label class="f">Langue du mail</label><select class="in" data-' + prefix + '="langue"><option value="fr"' + (c.langue !== 'en' ? ' selected' : '') + '>Français</option><option value="en"' + (c.langue === 'en' ? ' selected' : '') + '>Anglais</option></select>';
  }
  function panelAssistant() {
    var p = P('assistant'), o = stOf(p), h = head('🧠', 'L’Assistant', '<span class="led ' + o.s + '"></span>' + esc(o.why));
    h += '<div class="pb"><p class="muted">Il lit l’article en cours, vous propose qui interroger et quelles questions poser. Vous gardez, faites reformuler ou retirez chaque question, puis il passe le tout à la Secrétaire.</p>' + artBox();
    if (!S.art) return h + '</div>';
    var busy = !!S.busy.assistant;
    h += '<h3>1 · Qui interroger ?</h3>';
    if (S.contact) h += '<div class="box">' + contactForm('c', S.contact) + '<div class="row" style="margin-top:10px"><button class="btn small" data-act="contact-clear">Changer de personne</button></div></div>';
    else h += '<div class="row"><button class="btn" data-act="find-contacts"' + (busy ? ' disabled' : '') + '>🔎 Trouver les chercheurs de l’article</button><button class="btn small" data-act="contact-new">＋ Saisir un contact</button></div><p class="muted">La recherche prend une trentaine de secondes : l’Assistant vérifie sur le web qui a mené les travaux cités, et ne donne une adresse que si elle est publiée officiellement.</p>';
    if (S.contacts && S.contacts.length && !S.contact) {
      h += S.contacts.map(function (c, i) {
        return '<div class="ct"><b>' + esc(c.nom) + '</b> <span class="tag">' + esc(c.langue === 'en' ? 'anglais' : 'français') + '</span><div class="w">' + esc([c.role, c.institution].filter(Boolean).join(', ')) + '</div>' +
          '<div class="w">' + esc(c.pourquoi || '') + '</div>' +
          '<div class="w">' + (c.email ? '✉️ ' + esc(c.email) + (c.source_email ? ' · <a href="' + esc(c.source_email) + '" target="_blank" rel="noopener">source</a>' : '') : '✉️ adresse non publiée · ' + esc(c.ou_trouver || '')) + '</div>' +
          '<div class="row" style="margin-top:8px"><button class="btn small go" data-act="contact-pick" data-i="' + i + '">Choisir</button></div></div>';
      }).join('');
    }
    h += '<h3>2 · Les questions</h3><label class="f">Angle ou ce que vous voulez obtenir (facultatif)</label><input class="in" data-s="angle" value="' + esc(S.angle) + '" placeholder="ex. ce que ça change concrètement pour les patients">' +
      '<div class="row" style="margin-top:10px"><button class="btn" data-act="propose-q"' + (busy ? ' disabled' : '') + '>💡 Proposer des questions</button><button class="btn small" data-act="q-add">＋ Ma question</button></div>';
    h += '<div style="margin-top:10px">' + S.qs.map(function (q, i) {
      var r = S.reformule === i;
      return '<div class="q' + (q.garde ? ' keep' : '') + '"><textarea class="in" data-qi="' + i + '" rows="2">' + esc(q.q) + '</textarea>' + (q.pourquoi ? '<div class="why">' + esc(q.pourquoi) + '</div>' : '') +
        '<div class="row"><button class="btn small ' + (q.garde ? 'go' : '') + '" data-act="q-keep" data-i="' + i + '">' + (q.garde ? '✓ Gardée' : 'Garder') + '</button>' +
        '<button class="btn small" data-act="q-ref" data-i="' + i + '"' + (busy ? ' disabled' : '') + '>↻ Reformuler</button><button class="btn small red" data-act="q-del" data-i="' + i + '">✕</button></div>' +
        (r ? '<div style="margin-top:8px"><input class="in" id="wl-ref" placeholder="Comment ? (ex. plus simple, plus concret, en anglais…)"><div class="row" style="margin-top:6px"><button class="btn small go" data-act="q-ref-go" data-i="' + i + '">Reformuler</button><button class="btn small" data-act="q-ref-x">Annuler</button></div></div>' : '') + '</div>';
    }).join('') + '</div>';
    var kept = S.qs.filter(function (q) { return q.garde && String(q.q).trim(); }).length;
    var ok = S.contact && String(S.contact.nom || '').trim() && kept;
    h += '<h3>3 · Passer à la Secrétaire</h3><label class="f">Échéance à indiquer (facultatif)</label><input class="in" data-s="echeance" value="' + esc(S.echeance) + '" placeholder="ex. avant jeudi 18 h">' +
      '<label class="f">Un mot pour la Secrétaire (facultatif)</label><input class="in" data-s="consigneSec" value="' + esc(S.consigneSec) + '" placeholder="ex. rappeler qu’on a déjà cité son étude">' +
      '<div style="margin-top:12px"><button class="btn go" data-act="to-secretaire"' + (ok && !S.busy.secretaire ? '' : ' disabled') + '>📮 Envoyer à la Secrétaire (' + kept + ' question' + pl(kept) + ')</button></div>' +
      (ok ? '' : '<p class="muted">Il faut un contact (au moins son nom) et au moins une question gardée.</p>') + '<p class="muted">La Secrétaire rédige le mail ; il ne partira qu’après votre relecture et votre clic sur « Valider et envoyer ».</p></div>';
    return h;
  }
  function panelSecretaire() {
    var p = P('secretaire'), o = stOf(p), me = D().me;
    var h = head('📮', 'La Secrétaire', '<span class="led ' + o.s + '"></span>' + esc(o.why));
    h += '<div class="pb"><p class="muted">Elle rédige vos mails, vous les fait relire, puis les envoie depuis votre adresse Posthumain. Rien ne part sans votre validation.</p>';
    if (!me.branchee) h += '<div class="box warn">Votre boîte mail n’est pas encore branchée au Writinglab : vous pouvez préparer et relire vos mails, l’envoi sera possible dès qu’elle le sera.</div>';
    var v = by('brouillon');
    h += '<h3>Mails à valider (' + v.length + ')</h3><div class="dos">' + (v.map(function (f) { return dcard(f, '<div class="su">✉️ ' + esc(f.mail_sujet) + '</div>'); }).join('') || '<div class="muted">Aucun mail en attente de validation.</div>') + '</div>';
    h += '<h3>Écrire à quelqu’un</h3><p class="muted">Pour une demande directe (sans passer par l’Assistant) : dites ce que vous voulez, elle rédige.</p>' + contactForm('l', S.libre) +
      '<label class="f">Ce que vous voulez lui dire ou lui demander</label><textarea class="in" data-l="consigne" rows="4" placeholder="ex. lui demander s’il accepterait un appel de 15 minutes cette semaine sur son étude">' + esc(S.libre.consigne) + '</textarea>' +
      '<label class="f">Échéance (facultatif)</label><input class="in" data-l="echeance" value="' + esc(S.libre.echeance) + '">' +
      '<label class="muted" style="display:flex;gap:6px;align-items:center;margin-top:10px"><input type="checkbox" id="wl-libre-art"' + (S.art ? ' checked' : ' disabled') + '> lier à l’article en cours</label>' +
      '<div style="margin-top:12px"><button class="btn go" data-act="libre"' + (S.busy.secretaire ? ' disabled' : '') + '>✍️ Rédiger le mail</button></div></div>';
    return h;
  }
  function panelCourrier() {
    var p = P('courrier'), o = stOf(p);
    var h = head('📬', 'Le Courrier', '<span class="led ' + o.s + '"></span>' + esc(o.why));
    h += '<div class="pb"><p class="muted">Il surveille les quatre boîtes en continu et range chaque réponse dans la bonne fiche dès qu’elle arrive.</p><button class="btn" data-act="relever">↻ Actualiser</button>';
    var r = by('a répondu'), e = by('envoyé'), c = by('inséré');
    h += '<h3>Réponses à traiter (' + r.length + ')</h3><div class="dos">' + (r.map(function (f) { return dcard(f, '<div class="su">reçue ' + esc(when(f.reponse_le)) + '</div>'); }).join('') || '<div class="muted">Pas de nouvelle réponse.</div>') + '</div>';
    h += '<h3>En attente de réponse (' + e.length + ')</h3><div class="dos">' + (e.map(function (f) { return dcard(f, '<div class="su">envoyé ' + esc(when(f.envoye_le)) + (relancable(f) ? ' · <b>relance possible</b>' : '') + '</div>'); }).join('') || '<div class="muted">Rien en attente.</div>') + '</div>';
    if (c.length) h += '<h3>Déjà cités (' + c.length + ')</h3><div class="dos">' + c.slice(0, 8).map(function (f) { return dcard(f); }).join('') + '</div>';
    return h + '</div>';
  }
  function panelArticles() {
    var h = head('📰', 'Le Marbre', 'Les brouillons et articles programmés de Ghost');
    var as = artsRecents();
    return h + '<div class="pb"><p class="muted">Choisissez l’article sur lequel vous travaillez : l’Assistant s’en sert et les citations y seront insérées.</p><div class="arts" style="grid-template-columns:1fr">' + (as.map(artCard).join('') || '<div class="muted">Aucun brouillon.</div>') + '</div></div>';
  }
  function events() {
    var out = [];
    D().fiches.forEach(function (f) { (f.historique || []).forEach(function (e) { out.push({ t: e.t, e: e.e, par: e.par, f: f }); }); });
    return out.sort(function (a, b) { return String(b.t).localeCompare(String(a.t)); });
  }
  function panelJournaliste(id) {
    var w = membre(id), mine = id === D().me.id;
    var fs = D().fiches.filter(function (f) { return f.redacteur === id; });
    var h = head('✍️', mine ? 'Votre bureau' : w.nom, esc(w.titre || 'Journaliste'));
    h += '<div class="pb">' + (mine ? artBox() + '<div class="row"><button class="btn" data-act="open-ag" data-ag="assistant">🧠 Préparer une interview</button><button class="btn" data-act="open-ag" data-ag="secretaire">📮 Écrire à quelqu’un</button></div>' : '');
    ['a répondu', 'brouillon', 'envoyé', 'inséré'].forEach(function (st) {
      var l = fs.filter(function (f) { return f.statut === st; }); if (!l.length) return;
      h += '<h3>' + STATUTS[st][0] + ' ' + esc(STATUTS[st][1]) + ' (' + l.length + ')</h3><div class="dos">' + l.map(function (f) { return dcard(f); }).join('') + '</div>';
    });
    if (!fs.length) h += '<p class="muted" style="margin-top:14px">Aucune fiche de contact pour l’instant.</p>';
    return h + '</div>';
  }
  function panelChef() {
    var me = D().me, h = head('🧐', 'Bureau du rédacteur en chef', me.chef ? 'Votre bureau' : esc(P('chef').nom));
    if (!me.chef) return h + '<div class="pb"><p class="muted">Pour lui écrire, passez par l’interphone.</p><button class="btn" data-act="tab" data-tab="interphone">📞 Interphone</button></div>';
    h += '<div class="pb"><p class="muted">Toute la rédaction d’un coup d’œil : qui a écrit à qui, ce qui attend une validation, ce qui a été cité.</p>';
    var eq = (D().equipe || []).filter(function (w) { return w.role !== 'chef'; });
    h += '<h3>L’équipe</h3>' + ((eq.length ? eq : []).map(function (w) {
      var fs = D().fiches.filter(function (f) { return f.redacteur === w.id; });
      var c = function (st) { return fs.filter(function (f) { return f.statut === st; }).length; };
      return '<div class="card" data-act="open-ag" data-ag="j:' + esc(w.id) + '"><div class="h"><span class="em">✍️</span><span style="flex:1">' + esc(w.nom) + '</span>' + (w.branchee ? '<span class="tag g">boîte branchée</span>' : '<span class="tag a">boîte à brancher</span>') + '</div><div class="s">🟠 ' + c('brouillon') + ' à valider · 📨 ' + c('envoyé') + ' envoyés · 📬 ' + c('a répondu') + ' réponses · ✅ ' + c('inséré') + ' cités</div></div>';
    }).join('') || '<div class="box warn">Aucune journaliste n’a encore accès au lab : ajoutez son adresse de membre Ghost dans le nœud « Accès » du workflow.</div>');
    var mf = D().fiches.filter(function (f) { return f.redacteur === me.id; });
    if (mf.length) h += '<h3>Vos propres fiches (' + mf.length + ')</h3><div class="dos">' + mf.slice(0, 10).map(function (f) { return dcard(f); }).join('') + '</div>';
    var ev = events().slice(0, 25);
    h += '<h3>Ce qui s’est passé</h3><div class="feed">' + (ev.map(function (e) { return '<div class="it" data-act="open-fiche" data-id="' + esc(e.f.fiche_id) + '" style="cursor:pointer"><span class="t">' + esc(when(e.t)) + '</span><span>' + esc(e.e) + ' · <b>' + esc(e.f.contact.nom) + '</b> · ' + esc(e.par === 'courrier' ? 'courrier' : membre(e.par).nom) + '</span></div>'; }).join('') || '<div class="muted">Rien pour l’instant.</div>') + '</div>';
    h += '<div style="margin-top:14px"><button class="btn" data-act="tab" data-tab="interphone">📞 Interphone</button></div>';
    return h + '</div>';
  }

  // ---------- documents (feuille de papier plein écran) ----------
  function openDoc(kind, id) { S.doc = { kind: kind, id: id }; paintDoc(); S.root.querySelector('.doc').classList.add('open'); S.root.querySelector('.doc').scrollTop = 0; }
  function closeDoc() { S.doc = null; S.cit = null; S.colle = false; S.root.querySelector('.doc').classList.remove('open'); }
  function paintDoc() {
    if (!S.doc) return;
    setTimeout(markBusy, 0);
    var el = S.root.querySelector('.doc'), keep = el.scrollTop, ae = document.activeElement;
    if (ae && el.contains(ae) && (ae.tagName === 'TEXTAREA' || ae.tagName === 'INPUT')) return; // jamais sous les doigts
    if (S.doc.kind === 'aide') { el.innerHTML = docAide(); el.scrollTop = keep; return; }
    if (S.doc.kind === 'prospect') { var px = prospect(S.doc.id); el.innerHTML = px ? docProspect(px) : '<div class="dtop"><span class="nm">Prospect introuvable</span><span class="x" data-act="close-doc">✕</span></div>'; el.scrollTop = keep; markBusy(); return; }
    if (S.doc.kind === 'mail') { var mm = mail(S.doc.id); el.innerHTML = mm ? docMail(mm) : '<div class="dtop"><span class="nm">Mail introuvable</span><span class="x" data-act="close-doc">✕</span></div>'; el.scrollTop = keep; return; }
    var f = fiche(S.doc.id);
    if (!f) { el.innerHTML = '<div class="dtop"><span class="nm">Fiche introuvable</span><span class="x" data-act="close-doc">✕</span></div>'; return; }
    el.innerHTML = S.doc.kind === 'valid' && f.statut === 'brouillon' ? docValidation(f) : docFiche(f);
    el.scrollTop = keep;
  }
  function docAide() {
    var row = function (a, b) { return '<tr><td style="padding:4px 12px 4px 0;opacity:.7">' + a + '</td><td style="padding:4px 0"><b>' + b + '</b></td></tr>'; };
    return '<div class="dtop"><span class="em">✉︎</span><div><div class="nm">Votre adresse Posthumain dans Outlook</div><div class="st">notice · Infomaniak</div></div><span class="x" data-act="close-doc">✕</span></div>' +
      '<div class="paper"><div class="kick">À faire une seule fois par appareil</div>' +
      '<p>Votre adresse <b>prenom.nom@posthumain.com</b> est hébergée chez Infomaniak. Jonathan vous donne le mot de passe. Vous pouvez aussi lire vos mails sans rien installer sur <b>mail.infomaniak.com</b>.</p>' +
      '<label>Réglages à saisir si Outlook les demande</label><table style="font-size:16px;border-collapse:collapse;margin:6px 0 14px">' +
      row('Type de compte', 'IMAP') + row('Adresse e-mail et nom d’utilisateur', 'votre adresse complète') + row('Mot de passe', 'celui donné par Jonathan') +
      row('Serveur entrant (IMAP)', 'mail.infomaniak.com · port 993 · SSL/TLS') + row('Serveur sortant (SMTP)', 'mail.infomaniak.com · port 465 · SSL/TLS') + row('Authentification SMTP', 'oui, mêmes identifiants') + '</table>' +
      '<label>Outlook sur ordinateur (Windows ou Mac)</label><ol style="margin:6px 0 14px 20px;line-height:1.6"><li>Ouvrez Outlook, puis <b>Paramètres → Comptes → Ajouter un compte</b> (Mac : <b>Outlook → Paramètres → Comptes → +</b>).</li><li>Tapez votre adresse @posthumain.com, puis <b>Continuer</b>.</li><li>Si Outlook propose un fournisseur, choisissez <b>IMAP</b> (ou « Configuration avancée »).</li><li>Saisissez le mot de passe et les serveurs du tableau ci-dessus, puis <b>Continuer</b>.</li></ol>' +
      '<label>Outlook sur iPhone ou Android</label><ol style="margin:6px 0 14px 20px;line-height:1.6"><li>Ouvrez l’app Outlook, touchez votre photo en haut à gauche, puis la roue <b>Paramètres → Ajouter un compte mail</b>.</li><li>Tapez votre adresse @posthumain.com.</li><li>Choisissez <b>IMAP</b>, activez <b>Paramètres avancés</b>, puis remplissez avec le tableau.</li><li>Touchez la coche ✓ en haut à droite.</li></ol>' +
      '<label>Si ça ne marche pas</label><ul style="margin:6px 0 14px 20px;line-height:1.6"><li>« Mot de passe incorrect » : vérifiez les majuscules ; demandez-en un nouveau à Jonathan.</li><li>Les mails ne partent pas : vérifiez le port <b>465</b> et que l’authentification SMTP est activée.</li><li>Outlook.com (navigateur) ne gère pas bien ces adresses : utilisez mail.infomaniak.com ou l’app.</li></ul>' +
      '<p class="lead">Le Writinglab envoie et relève vos mails de son côté : configurer Outlook sert seulement à lire et écrire vous-même hors du lab.</p></div>';
  }
  function docValidation(f) {
    var w = membre(f.redacteur), branchee = !!w.branchee;
    var okMail = /^[^\s@<>]+@[^\s@<>]+\.[a-z]{2,}$/i.test(f.contact.email || '');
    var ed = (S.vEdit && S.vEdit[f.fiche_id]) || { sujet: f.mail_sujet, corps: f.mail_corps };
    var h = '<div class="dtop"><span class="em">📮</span><div><div class="nm">Mail à valider</div><div class="st">rédigé par la Secrétaire · ' + esc(when(f.maj)) + '</div></div><span class="x" data-act="close-doc">✕</span></div>';
    h += '<div class="paper"><div class="kick">Relisez, corrigez si besoin, puis validez</div>' +
      '<div class="meta">À : <b>' + esc(f.contact.nom) + '</b> ' + (okMail ? '&lt;' + esc(f.contact.email) + '&gt;' : '<span class="tag a">adresse manquante</span>') + '<br>📰 ' + esc(f.article_titre || 'sans article') + ' · ' + (f.langue === 'en' ? 'en anglais' : 'en français') + '</div>';
    if (!okMail) h += '<div class="warn">Il manque l’adresse e-mail du contact.<label>Adresse e-mail</label><input class="pin" id="wl-v-email" type="email" inputmode="email" placeholder="prenom.nom@universite.edu"><div class="acts"><button data-act="v-email" data-id="' + esc(f.fiche_id) + '">Enregistrer l’adresse</button></div></div>';
    h += '<label>Objet</label><input class="pin sub" id="wl-v-sujet" value="' + esc(ed.sujet) + '">' +
      '<label>Message</label><textarea class="pin big" id="wl-v-corps">' + esc(ed.corps) + '</textarea>' +
      pjWidget('v:' + f.fiche_id) +
      (branchee ? '' : '<div class="warn">La boîte mail de ' + esc(w.nom || 'cette personne') + ' n’est pas encore branchée : vous pouvez enregistrer, l’envoi viendra plus tard.</div>') +
      '<div class="acts"><button class="go" data-act="v-send" data-id="' + esc(f.fiche_id) + '"' + (okMail && branchee && !S.busy.secretaire ? '' : ' disabled') + '>✅ Valider et envoyer</button>' +
      '<button data-act="v-save" data-id="' + esc(f.fiche_id) + '">💾 Garder mes corrections</button>' +
      '<button data-act="v-redo" data-id="' + esc(f.fiche_id) + '"' + (S.busy.secretaire ? ' disabled' : '') + '>✏️ Autre version</button>' +
      '<button class="red" data-act="archive" data-id="' + esc(f.fiche_id) + '">🗄️ Abandonner</button></div>' +
      '<div id="wl-v-redo" style="display:none"><label>Que faut-il changer ?</label><input class="pin" id="wl-v-consigne" placeholder="ex. plus court, plus chaleureux, ajouter que…"><div class="acts"><button class="go" data-act="v-redo-go" data-id="' + esc(f.fiche_id) + '">Demander la nouvelle version</button></div></div>' +
      '<p class="lead">Le mail part de l’adresse Posthumain de ' + esc(w.nom || 'la rédaction') + ', seulement quand vous cliquez sur « Valider et envoyer ». Les réponses arriveront dans le Courrier.</p></div>';
    return h;
  }
  function docFiche(f) {
    var w = membre(f.redacteur);
    var h = '<div class="dtop"><span class="em">🗂️</span><div><div class="nm">' + esc(f.contact.nom) + '</div><div class="st">' + esc((STATUTS[f.statut] || ['', f.statut])[1]) + ' · fiche de ' + esc(w.nom) + '</div></div><span class="x" data-act="close-doc">✕</span></div>';
    h += '<div class="paper"><div class="kick">Fiche contact ' + tagStatut(f) + '</div><h1>' + esc(f.contact.nom) + '</h1>' +
      '<div class="meta">' + esc([f.contact.role, f.contact.institution].filter(Boolean).join(', ')) + (f.contact.email ? '<br>✉️ ' + esc(f.contact.email) : '') + '<br>📰 ' + esc(f.article_titre || 'sans article') + '</div>';
    if (f.statut === 'brouillon') h += '<div class="acts"><button class="go" data-act="open-valid" data-id="' + esc(f.fiche_id) + '">📮 Relire le mail à valider</button></div>';
    // la réponse et son insertion dans l'article
    if (f.reponse) {
      h += '<h2>Sa réponse' + (f.reponse_le ? ' · ' + esc(when(f.reponse_le)) : '') + '</h2><div class="txt">' + esc(f.reponse) + '</div>' + piecesHTML(f.pieces);
      if (f.statut === 'inséré') h += '<div class="lead">✅ Cité dans l’article :<br>' + nl(f.citation) + '</div>';
      if (f.article_id) h += citationBlock(f);
      else h += '<p class="lead">Cette fiche n’est liée à aucun article : rattachez-la depuis l’Assistant pour pouvoir insérer la réponse.</p>';
    } else if (f.statut === 'envoyé') {
      h += '<h2>Réponse</h2><p class="lead">Pas encore de réponse (mail envoyé ' + esc(when(f.envoye_le)) + '). Le Courrier la rangera ici dès qu’elle arrive.</p>' +
        '<div class="acts">' + (relancable(f) ? '<button data-act="relance" data-id="' + esc(f.fiche_id) + '"' + (S.busy.secretaire ? ' disabled' : '') + '>🔁 Faire préparer une relance</button>' : '') +
        '<button data-act="colle" data-id="' + esc(f.fiche_id) + '">📝 Réponse reçue ailleurs (téléphone, autre adresse)</button></div>';
    }
    if (S.colle) h += '<label>Collez ou résumez la réponse</label><textarea class="pin" id="wl-colle"></textarea><div class="acts"><button class="go" data-act="colle-go" data-id="' + esc(f.fiche_id) + '">Enregistrer la réponse</button></div>';
    if (f.questions && f.questions.length) h += '<h2>Questions posées</h2><ol>' + f.questions.map(function (q) { return '<li>' + esc(q) + '</li>'; }).join('') + '</ol>';
    if (f.mail_corps && f.statut !== 'brouillon') h += '<details><summary>Le mail envoyé · ' + esc(f.mail_sujet) + '</summary><div class="txt" style="font-size:15px">' + esc(f.mail_corps) + '</div></details>';
    h += '<h2>Historique</h2><ul class="tl">' + (f.historique || []).slice().reverse().map(function (e) { return '<li>' + esc(day(e.t) + ' ' + hm(e.t)) + ' — ' + esc(e.e) + (e.par && e.par !== 'courrier' ? ' (' + esc(membre(e.par).nom) + ')' : '') + '</li>'; }).join('') + '</ul>';
    h += '<div class="acts"><button class="red" data-act="archive" data-id="' + esc(f.fiche_id) + '">🗄️ Archiver la fiche</button></div></div>';
    return h;
  }
  function citationBlock(f) {
    var c = S.cit && S.cit.fid === f.fiche_id ? S.cit : null, busy = !!S.busy.assistant;
    var h = '<h2>Dans l’article</h2>';
    if (!c || !c.props) return h + '<p class="lead">L’Assistant choisit le passage le plus fort, le met en forme (et le traduit si besoin), puis vous choisissez où l’insérer dans le brouillon.</p><div class="acts"><button class="go" data-act="cit" data-id="' + esc(f.fiche_id) + '"' + (busy ? ' disabled' : '') + '>✨ Insérer la réponse mise en forme dans l’article</button></div>';
    h += '<p class="lead">1 · Choisissez une proposition (vous pouvez la corriger).</p>';
    h += c.props.map(function (p, i) {
      return '<div class="prop' + (c.choix === i ? ' sel' : '') + '"><label>Phrase d’introduction (facultative)</label><textarea class="pin" style="min-height:60px" data-cp="' + i + ':intro">' + esc(p.intro || '') + '</textarea>' +
        '<label>Citation</label><textarea class="pin" style="min-height:90px" data-cp="' + i + ':citation">' + esc(p.citation || '') + '</textarea>' +
        '<label>Attribution</label><input class="pin" data-cp="' + i + ':attribution" value="' + esc(p.attribution || '') + '">' +
        (p.note || p.ou ? '<div class="ou">' + esc([p.note, p.ou ? 'à placer : ' + p.ou : ''].filter(Boolean).join(' · ')) + '</div>' : '') +
        '<div class="acts"><button class="' + (c.choix === i ? 'go' : '') + '" data-act="cit-choix" data-i="' + i + '">' + (c.choix === i ? '✓ Choisie' : 'Choisir celle-ci') + '</button></div></div>';
    }).join('');
    h += '<div class="acts"><button data-act="cit" data-id="' + esc(f.fiche_id) + '"' + (busy ? ' disabled' : '') + '>↻ D’autres propositions</button></div>';
    if (c.choix == null) return h;
    h += '<p class="lead">2 · Touchez le bloc de l’article <b>après</b> lequel la citation doit apparaître.</p>';
    if (!c.plan) return h + '<div class="acts"><button class="go" data-act="plan" data-id="' + esc(f.fiche_id) + '"' + (S.busy.marbre ? ' disabled' : '') + '>📍 Afficher le plan de l’article</button></div>';
    h += '<div class="blk' + (c.index === -1 ? ' sel' : '') + '" data-act="cit-at" data-i="-1"><span class="kd">début</span><span class="tx">Tout en haut de l’article</span></div>';
    h += c.plan.blocs.map(function (b) {
      return '<div class="blk' + (b.kind === 'titre' ? ' h' : '') + (c.index === b.i ? ' sel' : '') + '" data-act="cit-at" data-i="' + b.i + '"><span class="kd">' + esc(b.kind) + '</span><span class="tx">' + esc(b.texte || '—') + '</span></div>' + (c.index === b.i ? '<div class="ins">⤷ la citation viendra ici</div>' : '');
    }).join('');
    h += '<div class="acts"><button class="go" data-act="inserer" data-id="' + esc(f.fiche_id) + '"' + (c.index == null || S.busy.marbre ? ' disabled' : '') + '>✅ Insérer dans le brouillon</button></div>';
    if (c.done) h += '<p class="lead">✅ Inséré. <a href="' + esc(c.done) + '" target="_blank" rel="noopener">Ouvrir le brouillon dans Ghost</a></p>';
    return h;
  }

  // ---------- actions ----------
  function toast(t, bad) {
    var el = S.root && S.root.querySelector('.toast'); if (!el) return;
    el.textContent = t; el.className = 'toast on' + (bad ? ' bad' : '');
    clearTimeout(S.toastT); S.toastT = setTimeout(function () { el.className = 'toast' + (bad ? ' bad' : ''); }, bad ? 6000 : 3500);
  }
  function pickArt(id) {
    S.art = id; LS.set('wl-article', id); loadDraft();
    var a = art(id); toast('📰 Article en cours : ' + (a ? a.titre : ''));
    render();
    if (S.panel === 'articles' || S.panel === 'marbre') openPanel('assistant');
  }
  function val(id) { var e = S.root.querySelector('#' + id); return e ? e.value : ''; }
  function act(name, t) {
    var id = t.getAttribute('data-id'), i = Number(t.getAttribute('data-i'));
    if (t.classList && t.classList.contains('ld')) return; // déjà en cours : pas de double clic
    S.clicking = name + '|' + (id || '');
    setTimeout(function () { S.clicking = null; }, 0);
    switch (name) {
      case 'refresh': refresh(); break;
      case 'tab': S.tab = t.getAttribute('data-tab'); S.clsr = false; LS.set('wl-tab', S.tab); closePanel(); render(); break;
      case 'articles': openPanel('articles'); break;
      case 'pick-art': pickArt(id); break;
      case 'open-ag': openPanel(t.getAttribute('data-ag').replace(/^j:vide$/, 'chef')); break;
      case 'close-panel': closePanel(); break;
      case 'close-doc': closeDoc(); break;
      case 'open-valid': openDoc('valid', id); break;
      case 'open-fiche': openDoc('fiche', id); break;
      case 'open-aide': openDoc('aide', ''); break;
      case 'open-mail': openDoc('mail', id); break;
      case 'open-prospect': openDoc('prospect', id); break;
      case 'camp-new': S.newCamp = { nom: '', offres: [], cible: '', zone: 'Suisse romande, France, Belgique' }; paintPanel(); break;
      case 'camp-cancel': S.newCamp = null; paintPanel(); break;
      case 'camp-toggle': S.campOpen = S.campOpen === id ? null : id; paintPanel(); break;
      case 'camp-create':
        var nc = S.newCamp; if (!nc) break;
        if (!String(nc.nom).trim() || !nc.offres.length) { toast('Donnez un nom et cochez au moins une offre.', true); break; }
        work('mk', 'ouvre la campagne', api('prospect', { op: 'campagne', nom: nc.nom, offres: nc.offres, cible: nc.cible, zone: nc.zone })).then(function () { S.newCamp = null; toast('🎯 Campagne créée.'); return refresh(true); });
        break;
      case 'p-chercher':
        S.campOpen = id;
        work('mk', 'cherche des prospects', api('prospect', { op: 'chercher', campagne_id: id })).then(function (r) { toast('🔎 ' + (r.resume || 'recherche terminée')); return refresh(true); });
        break;
      case 'p-rediger':
        work('mk', 'rédige le mail', api('prospect', { op: 'rediger', prospect_id: id, consigne: val('wl-p-consigne') })).then(function () { if (S.pEdit) delete S.pEdit[id]; if (document.activeElement) document.activeElement.blur(); return refresh(true); }).then(function () { paintDoc(); toast('🤖 Mail prêt : relisez-le.'); });
        break;
      case 'p-garder':
        api('prospect', { op: 'maj', prospect_id: id, sujet: val('wl-p-sujet'), corps: val('wl-p-corps'), email: val('wl-p-email').trim() }).then(function () { if (S.pEdit) delete S.pEdit[id]; toast('💾 Gardé.'); return refresh(true); }, function (e) { toast('⚠️ ' + e.message, true); });
        break;
      case 'p-envoyer':
        var px1 = prospect(id), pe = val('wl-p-email').trim(), ps1 = val('wl-p-sujet').trim(), pc = val('wl-p-corps').trim();
        if (!px1 || !pe || !ps1 || !pc) { toast('Adresse, objet ou message vide.', true); break; }
        if (!window.confirm('Envoyer ce mail à ' + pe + ' (' + px1.entreprise + ') depuis redaction@posthumain.com ?')) break;
        work('mk', 'envoie le mail', api('prospect', { op: 'envoyer', prospect_id: id, valide: '1', email: pe, sujet: ps1, corps: pc })).then(function () { if (S.pEdit) delete S.pEdit[id]; toast('📨 Mail envoyé.'); return refresh(true); }).then(function () { paintDoc(); });
        break;
      case 'p-statut':
        api('prospect', { op: 'maj', prospect_id: id, statut: t.getAttribute('data-st') }).then(function () { toast('✓ Mis à jour.'); return refresh(true); }).then(function () { paintDoc(); }, function (e) { toast('⚠️ ' + e.message, true); });
        break;
      case 'p-stop':
        if (!window.confirm('Ne plus jamais contacter cette entreprise (et cette adresse) ?')) break;
        api('prospect', { op: 'stop', prospect_id: id }).then(function () { toast('⛔ Retiré.'); return refresh(true); }).then(function () { paintDoc(); }, function (e) { toast('⚠️ ' + e.message, true); });
        break;
      case 'm-propose':
        var mp = mail(id); if (!mp) break;
        work(mp.boite === 'subs' ? 'sc' : 'mk', 'rédige une réponse', api('proposer', { mail_id: id, consigne: val('wl-m-consigne') })).then(function () { if (S.mEdit) delete S.mEdit[id]; if (document.activeElement) document.activeElement.blur(); return refresh(true); }).then(function () { paintDoc(); toast('🤖 Proposition prête : relisez-la.'); });
        break;
      case 'm-save':
        api('classer', { mail_id: id, sujet: val('wl-m-sujet'), corps: val('wl-m-corps') }).then(function () { if (S.mEdit) delete S.mEdit[id]; toast('💾 Réponse gardée.'); return refresh(true); }, function (e) { toast('⚠️ ' + e.message, true); });
        break;
      case 'm-demande':
        api('classer', { mail_id: id, categorie: 'demande' }).then(function () { toast('📩 Classé en demande.'); return refresh(true); }, function (e) { toast('⚠️ ' + e.message, true); });
        break;
      case 'm-archive':
        if (!window.confirm('Archiver ce mail ? Il disparaîtra du bureau de Julien.')) break;
        api('classer', { mail_id: id, statut: 'archivé' }).then(function () { closeDoc(); toast('🗄️ Archivé.'); return refresh(true); }, function (e) { toast('⚠️ ' + e.message, true); });
        break;
      case 'm-send':
        var ms1 = mail(id), su = val('wl-m-sujet').trim(), co = val('wl-m-corps').trim();
        if (!ms1 || !su || !co) { toast('Objet ou réponse vide.', true); break; }
        if (!window.confirm('Envoyer cette réponse à ' + ms1.de_email + ' ?')) break;
        work(ms1.boite === 'subs' ? 'sc' : 'mk', 'envoie la réponse', api('repondre', { mail_id: id, valide: '1', sujet: su, corps: co, pieces: pjsData('m:' + id) })).then(function () { if (S.mEdit) delete S.mEdit[id]; if (S.pjs) delete S.pjs['m:' + id]; closeDoc(); toast('📨 Réponse envoyée.'); return refresh(true); });
        break;
      // l'Assistant
      case 'find-contacts':
        work('assistant', 'cherche les chercheurs', api('contacts', { article_id: S.art })).then(function (r) { S.contacts = r.contacts || []; saveDraft(); paintPanel(); if (!S.contacts.length) toast('Personne de sûr trouvé : saisissez un contact.'); });
        break;
      case 'contact-pick': var c = S.contacts[i]; S.contact = { nom: c.nom || '', email: c.email || '', role: c.role || '', institution: c.institution || '', langue: c.langue === 'en' ? 'en' : 'fr' }; saveDraft(); paintPanel(); break;
      case 'contact-new': S.contact = { nom: '', email: '', role: '', institution: '', langue: 'fr' }; saveDraft(); paintPanel(); break;
      case 'contact-clear': S.contact = null; saveDraft(); paintPanel(); break;
      case 'propose-q':
        work('assistant', 'prépare les questions', api('questions', { article_id: S.art, contact: S.contact, angle: S.angle })).then(function (r) {
          var nouv = (r.questions || []).map(function (q) { return { q: q.q, pourquoi: q.pourquoi, garde: false, k: uid() }; });
          S.qs = S.qs.filter(function (q) { return q.garde; }).concat(nouv); saveDraft(); paintPanel(); paintFloor();
        });
        break;
      case 'q-add': S.qs.push({ q: '', pourquoi: '', garde: true, k: uid() }); saveDraft(); paintPanel(); var ta = S.root.querySelector('[data-qi="' + (S.qs.length - 1) + '"]'); if (ta) ta.focus(); break;
      case 'q-keep': S.qs[i].garde = !S.qs[i].garde; saveDraft(); paintPanel(); paintFloor(); break;
      case 'q-del': S.qs.splice(i, 1); S.reformule = null; saveDraft(); paintPanel(); paintFloor(); break;
      case 'q-ref': S.reformule = i; paintPanel(); var ri = S.root.querySelector('#wl-ref'); if (ri) ri.focus(); break;
      case 'q-ref-x': S.reformule = null; paintPanel(); break;
      case 'q-ref-go':
        var cons = val('wl-ref'), q0 = S.qs[i]; S.reformule = null;
        work('assistant', 'reformule', api('reformuler', { article_id: S.art, article_titre: (art(S.art) || {}).titre, question: q0.q, consigne: cons, langue: S.contact && S.contact.langue })).then(function (r) {
          var k = S.qs.indexOf(q0); if (k >= 0) { S.qs[k].q = r.q || q0.q; S.qs[k].pourquoi = r.pourquoi || q0.pourquoi; } saveDraft(); paintPanel();
        });
        break;
      case 'to-secretaire':
        var kept = S.qs.filter(function (q) { return q.garde && String(q.q).trim(); }).map(function (q) { return q.q.trim(); });
        work('secretaire', 'rédige le mail', api('rediger', { article_id: S.art, contact: S.contact, questions: kept, type: 'interview', echeance: S.echeance, consigne: S.consigneSec })).then(function (r) {
          S.contact = null; S.qs = []; S.echeance = ''; S.consigneSec = ''; saveDraft(); closePanel();
          return refresh(true).then(function () { openDoc('valid', r.fiche_id); toast('📮 La Secrétaire a rédigé le mail : relisez-le.'); });
        });
        break;
      // la Secrétaire
      case 'libre':
        var L = S.libre, lie = S.root.querySelector('#wl-libre-art');
        if (!String(L.nom).trim()) { toast('Il manque le nom du destinataire.', true); break; }
        if (!String(L.consigne).trim()) { toast('Dites ce que vous voulez lui écrire.', true); break; }
        work('secretaire', 'rédige le mail', api('rediger', { article_id: lie && lie.checked ? S.art : '', contact: L, type: 'libre', consigne: L.consigne, echeance: L.echeance })).then(function (r) {
          S.libre = { nom: '', email: '', role: '', institution: '', langue: 'fr', consigne: '', echeance: '' }; closePanel();
          return refresh(true).then(function () { openDoc('valid', r.fiche_id); toast('📮 Mail rédigé : relisez-le.'); });
        });
        break;
      case 'v-email':
        var em = val('wl-v-email').trim(), f0 = fiche(id);
        if (!/^[^\s@<>]+@[^\s@<>]+\.[a-z]{2,}$/i.test(em)) { toast('Adresse e-mail invalide.', true); break; }
        api('maj', { fiche_id: id, contact: { nom: f0.contact.nom, email: em, role: f0.contact.role, institution: f0.contact.institution }, mail_sujet: val('wl-v-sujet'), mail_corps: val('wl-v-corps') }).then(function () { return refresh(true); }).then(function () { paintDoc(); toast('Adresse enregistrée.'); }, function (e) { toast('⚠️ ' + e.message, true); });
        break;
      case 'v-save':
        api('maj', { fiche_id: id, mail_sujet: val('wl-v-sujet'), mail_corps: val('wl-v-corps') }).then(function () { forget(id); return refresh(true); }).then(function () { toast('💾 Corrections gardées.'); }, function (e) { toast('⚠️ ' + e.message, true); });
        break;
      case 'v-redo': var box = S.root.querySelector('#wl-v-redo'); if (box) { box.style.display = 'block'; var vc = S.root.querySelector('#wl-v-consigne'); if (vc) vc.focus(); } break;
      case 'v-redo-go':
        work('secretaire', 'réécrit le mail', api('rediger', { fiche_id: id, article_id: (fiche(id) || {}).article_id || '', type: (fiche(id) || {}).questions && fiche(id).questions.length ? 'interview' : 'libre', consigne: val('wl-v-consigne') })).then(function () { forget(id); if (document.activeElement) document.activeElement.blur(); return refresh(true); }).then(function () { paintDoc(); toast('✏️ Nouvelle version prête.'); });
        break;
      case 'v-send':
        var f1 = fiche(id), sujet = val('wl-v-sujet').trim(), corps = val('wl-v-corps').trim();
        if (!sujet || !corps) { toast('Objet ou message vide.', true); break; }
        if (!window.confirm('Envoyer ce mail à ' + f1.contact.nom + ' (' + f1.contact.email + ') ?')) break;
        work('secretaire', 'envoie le mail', api('envoyer', { fiche_id: id, valide: '1', sujet: sujet, corps: corps, pieces: pjsData('v:' + id) })).then(function () {
          forget(id); if (S.pjs) delete S.pjs['v:' + id]; closeDoc(); toast('📨 Mail envoyé à ' + f1.contact.nom + '.'); return refresh(true);
        });
        break;
      case 'archive':
        if (!window.confirm('Archiver cette fiche ? Elle disparaîtra du lab.')) break;
        api('maj', { fiche_id: id, statut: 'archivé' }).then(function () { closeDoc(); toast('🗄️ Fiche archivée.'); return refresh(true); }, function (e) { toast('⚠️ ' + e.message, true); });
        break;
      // le Courrier
      case 'relever':
        refresh(true).then(function () { toast('📬 Les boîtes sont relevées en continu : tout nouveau mail arrive ici tout seul.'); });
        break;
      case 'relance':
        work('secretaire', 'prépare la relance', api('rediger', { fiche_id: id, article_id: (fiche(id) || {}).article_id || '', type: 'relance' })).then(function () { return refresh(true); }).then(function () { openDoc('valid', id); toast('🔁 Relance prête : relisez-la.'); });
        break;
      case 'colle': S.colle = !S.colle; paintDoc(); break;
      case 'colle-go':
        var txt = val('wl-colle').trim(); if (!txt) break;
        api('maj', { fiche_id: id, reponse: txt }).then(function () { S.colle = false; return refresh(true); }).then(function () { paintDoc(); toast('Réponse enregistrée.'); }, function (e) { toast('⚠️ ' + e.message, true); });
        break;
      // la citation dans l'article
      case 'cit':
        S.cit = { fid: id, props: null, choix: null, plan: null, index: null, done: '' }; paintDoc();
        work('assistant', 'met la réponse en forme', api('citation', { fiche_id: id, article_id: (fiche(id) || {}).article_id || '' })).then(function (r) {
          if (S.cit && S.cit.fid === id) { S.cit.props = r.propositions || []; S.cit.choix = S.cit.props.length === 1 ? 0 : null; } paintDoc();
        }, function () { S.cit = null; paintDoc(); });
        break;
      case 'cit-choix': if (S.cit) { S.cit.choix = i; paintDoc(); } break;
      case 'plan':
        work('marbre', 'ouvre le brouillon', api('paragraphes', { article_id: (fiche(id) || {}).article_id || '' })).then(function (r) { if (S.cit) { S.cit.plan = r; } paintDoc(); });
        break;
      case 'cit-at': if (S.cit) { S.cit.index = i; paintDoc(); } break;
      case 'inserer':
        var C = S.cit, pr = C && C.props[C.choix];
        if (!pr || C.index == null) break;
        if (!window.confirm('Insérer cette citation dans le brouillon Ghost ?')) break;
        work('marbre', 'insère la citation', api('inserer', { fiche_id: id, index: C.index, intro: pr.intro || '', citation: pr.citation || '', attribution: pr.attribution || '' })).then(function (r) {
          if (S.cit) S.cit.done = r.editeur; toast('✅ Citation insérée dans l’article.'); return refresh(true);
        }).then(function () { paintDoc(); });
        break;
      // interphone
      case 'dicter': if (S.dicte) stopDictee(); else startDictee(); break;
      case 'send-msg':
        if (S.dicte) stopDictee();
        var m = val('wl-msg').trim(), pj = S.pj; if (!m && !pj) break;
        var lien = S.root.querySelector('#wl-msg-art'), a = art(S.art), cs = S.root.querySelector('#wl-pj-cat');
        if (pj && cs) pj.categorie = cs.value;
        api('ecrire', { texte: m, article_id: lien && lien.checked && a ? a.id : '', article_titre: lien && lien.checked && a ? a.titre : '',
          fichier: pj ? { nom: pj.nom, type: pj.type, data: pj.data } : null, categorie: pj ? pj.categorie : '' }).then(function () {
          var ta = S.root.querySelector('#wl-msg'); if (ta) { ta.value = ''; ta.blur(); } S.msgDraft = ''; S.pj = null; majPj(); if (pj) toast('📎 Fichier rangé dans « ' + catNom(pj.categorie) + ' ».'); return refresh(true);
        }, function (e) { toast('⚠️ ' + e.message, true); });
        break;
      case 'pjs-add': S.pjsKey = id; var pin = S.root.querySelector('#wl-pjs-input'); if (pin) pin.click(); break;
      case 'pjs-del': if (S.pjs && S.pjs[id]) { S.pjs[id].splice(i, 1); paintDoc(); } break;
      case 'pj-choisir': var inp = S.root.querySelector('#wl-pj'); if (inp) inp.click(); break;
      case 'pj-retirer': S.pj = null; majPj(); break;
      case 'filtre-cat': S.filtreCat = id || ''; majClasseur(); break;
      case 'clsr': S.clsr = !S.clsr; majClasseur(); break;
    }
  }
  function onInput(e) {
    var t = e.target, k;
    if (t.id === 'wl-msg') { S.msgDraft = t.value; return; }
    if ((k = t.getAttribute('data-c')) && S.contact) { S.contact[k] = t.value; saveDraft(); }
    else if ((k = t.getAttribute('data-l'))) { S.libre[k] = t.value; }
    else if ((k = t.getAttribute('data-s'))) { S[k] = t.value; saveDraft(); }
    else if (t.hasAttribute('data-qi')) { var q = S.qs[Number(t.getAttribute('data-qi'))]; if (q) { q.q = t.value; saveDraft(); } }
    else if ((k = t.getAttribute('data-cp')) && S.cit && S.cit.props) { var pp = k.split(':'), pr = S.cit.props[Number(pp[0])]; if (pr) pr[pp[1]] = t.value; }
    else if ((k = t.getAttribute('data-nc')) && S.newCamp) { S.newCamp[k] = t.value; }
    else if ((k = t.getAttribute('data-nco')) && S.newCamp) { var oo = S.newCamp.offres.filter(function (x) { return x !== k; }); if (t.checked) oo.push(k); S.newCamp.offres = oo; }
    else if (/^wl-p-(sujet|corps|email)$/.test(t.id) && S.doc) { S.pEdit = S.pEdit || {}; S.pEdit[S.doc.id] = { sujet: val('wl-p-sujet'), corps: val('wl-p-corps'), email: val('wl-p-email') }; }
    else if ((t.id === 'wl-m-sujet' || t.id === 'wl-m-corps') && S.doc) { S.mEdit = S.mEdit || {}; S.mEdit[S.doc.id] = { sujet: val('wl-m-sujet'), corps: val('wl-m-corps') }; }
    else if ((t.id === 'wl-v-sujet' || t.id === 'wl-v-corps') && S.doc) {
      // corrections de la journaliste dans le mail à valider : gardées même si la page se rafraîchit
      S.vEdit = S.vEdit || {};
      S.vEdit[S.doc.id] = { sujet: val('wl-v-sujet'), corps: val('wl-v-corps') };
    }
  }
  function forget(id) { if (S.vEdit) delete S.vEdit[id]; }

  // ---------- rendu ----------
  function paintFloor() { var f = S.root && S.root.querySelector('.floor'); if (f) f.innerHTML = officeSVG(); }
  function render() {
    var r = S.root; if (!r) return;
    r.querySelector('.top').innerHTML = header();
    r.querySelector('.tabs').innerHTML = tabs();
    var w = r.querySelector('.wrap');
    var ae = document.activeElement, composing = ae && w.contains(ae) && ae.id === 'wl-msg';
    if (!composing) w.innerHTML = S.tab === 'articles' ? viewArticles() : S.tab === 'suivi' ? viewSuivi() : S.tab === 'interphone' ? viewInterphone() : viewBureau();
    if (S.tab === 'interphone') { var ms = D().messages; if (ms.length) LS.set('wl-vu', String(ms[ms.length - 1].le)); r.querySelector('.tabs').innerHTML = tabs(); }
    paintPanel(); paintDoc(); markBusy();
  }

  window.WRITINGLAB_START = function (o) {
    S.call = o.call;
    var host = o.root;
    host.innerHTML = '';
    var font = document.createElement('link'); font.rel = 'stylesheet';
    font.href = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@500;700;800&display=swap';
    document.head.appendChild(font);
    var st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
    var r = document.createElement('div'); r.id = 'wl';
    r.innerHTML = '<div class="top"></div><div class="tabs"></div><div class="wrap"><div class="boot muted" style="padding:80px 0;text-align:center">📰 La rédaction arrive…</div></div><div class="panelbg"></div><div class="panel"></div><div class="doc"></div><div class="toast"></div>';
    document.body.appendChild(r);
    document.documentElement.style.overflow = 'hidden';
    S.root = r;
    if (S.art) loadDraft();
    r.addEventListener('click', function (e) {
      var t = e.target;
      if (t.closest('[data-stop]')) { e.stopPropagation(); return; }
      if (t.classList.contains('panelbg')) { closePanel(); return; }
      var tb = t.closest('[data-tab]'); if (tb && tb.classList.contains('tab')) { S.tab = tb.getAttribute('data-tab'); LS.set('wl-tab', S.tab); render(); return; }
      var a = t.closest('[data-act]'); if (a) { e.preventDefault(); act(a.getAttribute('data-act'), a); return; }
      var ag = t.closest('[data-ag]'); if (ag) { var k = ag.getAttribute('data-ag'); openPanel(k === 'j:vide' ? 'chef' : k); }
    });
    r.addEventListener('input', onInput);
    r.addEventListener('change', onInput);
    r.addEventListener('keydown', function (e) {
      if (e.target && e.target.id === 'wl-msg' && e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); var b = r.querySelector('[data-act="send-msg"]'); if (b) b.click(); }
    });
    var pjsIn = document.createElement('input'); pjsIn.type = 'file'; pjsIn.id = 'wl-pjs-input'; pjsIn.multiple = true; pjsIn.style.display = 'none'; r.appendChild(pjsIn);
    pjsIn.addEventListener('change', function () {
      var key = S.pjsKey, fs = Array.prototype.slice.call(pjsIn.files || []); pjsIn.value = '';
      if (!key) return;
      S.pjs = S.pjs || {}; S.pjs[key] = S.pjs[key] || [];
      fs.forEach(function (f) {
        if (S.pjs[key].length >= 5) { toast('5 pièces jointes au plus.', true); return; }
        if (f.size > 8 * 1024 * 1024) { toast(f.name + ' : 8 Mo au plus.', true); return; }
        var rd = new FileReader();
        rd.onload = function () { S.pjs[key].push({ nom: f.name, type: f.type || 'application/octet-stream', taille: f.size, data: String(rd.result).split(',')[1] || '' }); paintDoc(); };
        rd.readAsDataURL(f);
      });
    });
    r.addEventListener('change', function (e) {
      if (!e.target || e.target.id !== 'wl-pj' || !e.target.files || !e.target.files[0]) return;
      var f = e.target.files[0]; e.target.value = '';
      if (f.size > 10 * 1024 * 1024) { toast('Fichier trop lourd : 10 Mo au plus.', true); return; }
      var rd = new FileReader();
      rd.onload = function () { S.pj = { nom: f.name, type: f.type || 'application/octet-stream', taille: f.size, categorie: devinerCat(f), data: String(rd.result).split(',')[1] || '' }; majPj(); };
      rd.readAsDataURL(f);
    });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') { if (S.clsr) { S.clsr = false; majClasseur(); } else if (S.doc) closeDoc(); else closePanel(); } });
    // Retour sur l'onglet : une seule relecture si la page n'a rien reçu depuis 5 minutes.
    document.addEventListener('visibilitychange', function () { if (!document.hidden && Date.now() - S.last > 300000) refresh(true); });
    // Temps réel : Supabase sonne (table wl_signal, sans aucune donnée) dès qu'un mail, une fiche ou un message change ;
    // la page relit alors l'état. Plus de relecture périodique quand le temps réel est branché (chaque relecture = une exécution n8n) ;
    // filet de sécurité seulement s'il est coupé : une relecture toutes les 10 minutes.
    S.rtOk = false;
    setInterval(function () { if (!S.rtOk && !document.hidden && S.data && Date.now() - S.last > 590000) refresh(true); }, 600000);
    (function sonnette() {
      var sc = document.createElement('script');
      sc.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js';
      sc.onload = function () {
        try {
          var sb = window.supabase.createClient('https://jfmzhndapfmvdhphuwfm.supabase.co', 'sb_publishable_3NOP0qHNmvDay5ak1P__XA_ALCUH7du', { auth: { persistSession: false } });
          var t = null;
          sb.channel('writinglab').on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'wl_signal' }, function () {
            clearTimeout(t); t = setTimeout(function () { refresh(true); }, 1500); // plusieurs changements d'affilée = une seule relecture
          }).subscribe(function (st) { S.rtOk = st === 'SUBSCRIBED'; });
        } catch (e) { /* pas de temps réel : la relecture toutes les 10 minutes prend le relais */ }
      };
      document.head.appendChild(sc);
    })();
    setInterval(function () { if (!document.hidden && S.data) { var tp = r.querySelector('.top'); if (tp) tp.innerHTML = header(); } }, 30000);
    refresh().then(function () {
      if (S.art && !art(S.art) && D().articles.length) { /* l'article en cours a été publié ou supprimé */ S.art = ''; LS.set('wl-article', null); render(); }
    });
  };
})();
