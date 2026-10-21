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
    data: null, call: null, root: null, portee: LS.get('wl-portee') || '', tab: LS.get('wl-tab') || 'bureau', art: LS.get('wl-article') || '',
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
  // Enquêtes premium (brouillons payants) sans aucune fiche de contact : la rédaction doit lancer les interviews.
  function premium(a) { return ['paid', 'tiers', 'members'].indexOf(String(a.visibilite || '')) >= 0; }
  function aInterviewer() { return artsRecents().filter(function (a) { return premium(a) && !D().fiches.some(function (f) { return f.article_id === a.id; }); }); }
  function art(id) { return D().articles.filter(function (a) { return a.id === id; })[0] || null; }
  function fiche(id) { return D().fiches.filter(function (f) { return f.fiche_id === id; })[0] || null; }
  // Portée (rédacteur en chef) : « Mes fiches » ou « Toute la rédaction ». Valisoa ne reçoit de toute façon que les siennes.
  function portee() { return S.portee || (D().me.chef ? 'tous' : 'moi'); }
  function vues() { var me = D().me; return D().fiches.filter(function (f) { return portee() !== 'moi' || f.redacteur === me.id; }); }
  // Lecture pour tous, actions pour le propriétaire de la fiche (ou le rédacteur en chef) : le serveur applique la même règle.
  function peut(f) { var me = D().me; return !!(me.chef || (f && f.redacteur === me.id)); }
  function lectureSeule(qui) { return '<div class="box" style="margin:10px 0;border-color:rgba(120,170,255,.35)">👁️ Lecture seule' + (qui ? ' : ' + esc(qui) : '') + '. Vous pouvez tout consulter ; seules les actions vous sont réservées selon votre rôle.</div>'; }
  function by(st) { return vues().filter(function (f) { return f.statut === st; }); }
  // Origine d'une fiche : préparation express, Assistant (questions choisies) ou message direct à la Secrétaire.
  function origine(f) {
    if ((f.historique || []).some(function (e) { return /^préparé en express/.test(String(e.e || '')); })) return ['⚡', 'Express'];
    return f.questions && f.questions.length ? ['🧠', 'Assistant'] : ['✍️', 'Message direct'];
  }
  function qui(f) { return f.redacteur === D().me.id ? 'vous' : membre(f.redacteur).nom; }
  // Questions telles qu'elles partent dans le mail (lignes numérotées « 1. … ») : traduites si le chercheur ne parle pas français.
  function questionsEnvoyees(f) {
    var out = [], n = 1;
    String(f.mail_corps || '').split('\n').forEach(function (l) { var m = l.match(/^\s*(\d{1,2})[.)]\s+(.+)$/); if (m && Number(m[1]) === n) { out.push(m[2].trim()); n++; } });
    return out;
  }
  // Dossiers : les fiches regroupées par article, du plus récemment touché au plus ancien.
  function dossiers(list) {
    var m = {}, ordre = [];
    list.forEach(function (f) { var k = f.article_id || '—'; if (!m[k]) { m[k] = { id: f.article_id || '', titre: f.article_titre || 'Sans article', fiches: [], maj: '' }; ordre.push(k); } m[k].fiches.push(f); if (String(f.maj) > m[k].maj) m[k].maj = String(f.maj); });
    return ordre.map(function (k) { return m[k]; }).sort(function (a, b) { return b.maj.localeCompare(a.maj); });
  }
  function avancement(fs) {
    var c = function (st) { return fs.filter(function (f) { return f.statut === st; }).length; };
    return '<span class="av"><b class="' + (c('brouillon') ? 'a' : '') + '">🟠 ' + c('brouillon') + ' à valider</b><b>📨 ' + c('envoyé') + ' envoyé' + pl(c('envoyé')) + '</b><b class="' + (c('a répondu') ? 'g' : '') + '">📬 ' + c('a répondu') + ' réponse' + pl(c('a répondu')) + '</b><b>✅ ' + c('inséré') + ' cité' + pl(c('inséré')) + '</b></span>';
  }
  function origines(fs) {
    var x = fs.filter(function (f) { return origine(f)[1] === 'Express'; }).length, a = fs.length - x;
    return [x ? x + ' ⚡ express' : '', a ? a + ' 🧠 assistant / direct' : ''].filter(Boolean).join(' · ');
  }
  function porteeHTML() {
    var moi = portee() === 'moi';
    return '<div class="row" style="gap:6px;margin:4px 0 10px"><span class="chip' + (moi ? ' art' : '') + '" data-act="portee" data-id="moi">👤 Mes fiches</span><span class="chip' + (moi ? '' : ' art') + '" data-act="portee" data-id="tous">👥 Toute la rédaction</span></div>';
  }
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
      var premier = !S.data;
      S.data = d; render(); chargerPieces();
      if (premier && window.WL_LOADER) setTimeout(window.WL_LOADER.fin, 250); // l'écran de chargement s'efface quand la rédaction est en place
    }, function (e) { if (window.WL_LOADER) window.WL_LOADER.fin(); if (!silent) toast('⚠️ ' + e.message, true); });
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
#wl .floor svg{display:block;width:100%;min-width:1180px;height:auto}#wl .case,#wl .tableau{cursor:pointer}#wl .case:hover rect:first-child{fill:rgba(255,190,90,.12)}#wl .tip{position:fixed;z-index:65;pointer-events:none;max-width:300px;padding:10px 12px;border-radius:12px;background:#f8f4ea;color:#1f1a12;font-size:13px;line-height:1.4;box-shadow:0 12px 40px rgba(0,0,0,.5);opacity:0;transition:opacity .12s}#wl .tip.on{opacity:1}#wl .tip b{display:block;font-size:13.5px;margin-bottom:3px;color:#1f1a12!important;font-weight:700}#wl .tip span{display:block;color:#5c5444!important}#wl .tip span.go{color:#1f6b45!important;font-weight:600}\
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
#wl textarea.wl-mef{opacity:.45;cursor:progress;background-image:linear-gradient(90deg,rgba(255,255,255,0) 0%,rgba(255,255,255,.07) 50%,rgba(255,255,255,0) 100%)!important;background-size:200% 100%!important;animation:wlmef 1.2s linear infinite}@keyframes wlmef{from{background-position:200% 0}to{background-position:-200% 0}}\
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
#wl .dossier{margin:10px 0 14px;padding:10px 12px;border:1px solid rgba(255,255,255,.08);border-radius:14px;background:rgba(255,255,255,.025);transition:box-shadow .4s}#wl .dossier.flash{box-shadow:0 0 0 2px rgba(0,255,119,.6)}#wl .panel .dossier .dh{cursor:pointer}#wl .dossier .dh{display:flex;flex-wrap:wrap;gap:6px 12px;align-items:baseline;justify-content:space-between;margin-bottom:6px}#wl .av{display:inline-flex;flex-wrap:wrap;gap:6px}#wl .av b{font-weight:500;font-size:11.5px;padding:2px 8px;border-radius:999px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.08);white-space:nowrap}#wl .av b.a{border-color:rgba(255,176,32,.5);color:#ffe0a3}#wl .av b.g{border-color:rgba(0,255,119,.5);color:#c9ffe0}\
#wl .lb{display:grid;gap:6px;margin:6px 0 14px}#wl .lb div{display:flex;justify-content:space-between;padding:10px 12px;border-radius:12px;background:#f3ead6;border:1px solid #d8cfbd}#wl .pc{padding:10px 0;border-top:1px solid #e3dac8}#wl .parc{display:flex;flex-wrap:wrap;align-items:center;gap:4px;margin:8px 0 12px}#wl .parc .pa{font-size:12.5px;padding:4px 9px;border-radius:999px;border:1px dashed #b9ae98;color:#8a806e}#wl .parc .pa.on{border-style:solid;border-color:#1f8a52;background:#e5f6ea;color:#14532d;font-weight:600}#wl .parc i{width:14px;height:1px;background:#b9ae98}\
#wl .fete{position:fixed;left:50%;top:38%;z-index:70;transform:translate(-50%,-50%);text-align:center;padding:24px 34px;border-radius:22px;background:#14110c;border:1px solid rgba(255,200,80,.6);box-shadow:0 0 0 6px rgba(255,200,80,.08),0 30px 80px rgba(0,0,0,.6);animation:wlfete .5s cubic-bezier(.2,1.4,.4,1)}#wl .fete.out{opacity:0;transition:opacity .5s}#wl .fete-c{font-size:54px;animation:wlspin2 1.2s ease-in-out}#wl .fete-t{font-weight:800;font-size:22px;color:#ffd77a;margin-top:6px}#wl .fete-s{font-size:13.5px;color:rgba(243,236,224,.7);margin-top:4px}@keyframes wlfete{from{transform:translate(-50%,-50%) scale(.6);opacity:0}}@keyframes wlspin2{0%{transform:rotateY(0)}100%{transform:rotateY(720deg)}}\
#wl .cz-t{margin:20px 0 6px;font:700 15px Inter,system-ui,sans-serif!important;color:#f3ece0;letter-spacing:normal!important;text-transform:none!important}#wl .dot-off{display:inline-block;width:7px;height:7px;border-radius:50%;background:#ff6b5a;margin-left:4px;vertical-align:top}#wl .set{margin:14px 0;padding:14px 16px;border-radius:16px;background:rgba(255,255,255,.035);border:1px solid rgba(255,255,255,.09)}#wl .set.hot{border-color:rgba(255,176,32,.55);background:rgba(255,176,32,.07)}#wl .set-h{display:flex;justify-content:space-between;align-items:center;gap:14px}#wl .set-s{font-size:13px;color:rgba(243,236,224,.6);margin-top:3px;line-height:1.5}#wl button.sw{flex:0 0 auto;width:46px;height:26px;border-radius:99px;background:#3a3328!important;border:1px solid rgba(255,255,255,.15)!important;position:relative;padding:0!important;cursor:pointer;transition:background .2s}#wl button.sw i{position:absolute;top:2px;left:2px;width:20px;height:20px;border-radius:50%;background:#d8cfbf;transition:left .2s}#wl button.sw.on{background:#18b45f!important}#wl button.sw.on i{left:22px;background:#fff}#wl .seg{display:inline-flex;margin:12px 0 8px;border:1px solid rgba(255,255,255,.14);border-radius:10px;overflow:hidden}#wl .seg button{background:transparent!important;color:rgba(243,236,224,.7)!important;border:0!important;padding:7px 14px!important;font-size:13.5px!important;cursor:pointer}#wl .seg button.on{background:rgba(0,255,119,.14)!important;color:#9fffc8!important;font-weight:600}#wl .tb{display:flex;gap:4px;margin-bottom:6px}#wl .tb button{background:rgba(255,255,255,.06)!important;color:#f3ece0!important;border:1px solid rgba(255,255,255,.12)!important;border-radius:7px;min-width:34px;height:30px;padding:0 8px!important;cursor:pointer;font-size:14px!important}#wl .sig-ed{min-height:96px;background:#fff;color:#1f1a12;border-radius:10px;padding:12px 14px;font:14.5px/1.55 Arial,Helvetica,sans-serif;outline:none;border:2px solid transparent}#wl .sig-ed:focus{border-color:#00ff77}#wl .sig-ed b,#wl .sig-ed i,#wl .sig-ed u,#wl .sigprev b,#wl .sigprev i,#wl .sigprev u,#wl .cit b{color:inherit!important;background:none!important}#wl .sig-ed a,#wl .sigprev a{color:#1a5fd0!important}#wl .tb button{min-width:38px!important;height:32px!important}#wl .sigprev{margin-top:8px;padding:10px 12px;border-left:3px solid #d4c8ad;background:#faf6ec;color:#444;font:14px/1.5 Arial,Helvetica,sans-serif;border-radius:0 8px 8px 0}#wl .sigprev .kd,#wl .cit .kd{display:inline-block;font:600 11px Inter,sans-serif;letter-spacing:.04em;text-transform:uppercase;color:#8a7d63;margin-bottom:4px}#wl .cit{margin:10px 0;border:1px solid #e0d5bd;border-radius:12px;background:#fffdf8;overflow:hidden}#wl .cit.done{border-color:#9fd9b4;background:#f3fbf5}#wl .cit.skip{opacity:.55}#wl .cit-h{display:flex;align-items:center;gap:10px;padding:11px 14px;cursor:pointer}#wl .cit-n{flex:0 0 auto;width:26px;height:26px;border-radius:50%;background:#1f1a12;color:#fff;font:700 13px/26px Inter,sans-serif;text-align:center}#wl .cit-t{flex:1;font-size:14.5px;line-height:1.4;color:#1f1a12}#wl .cit-t small{display:block;color:#8a7d63;font-size:12.5px;margin-top:2px}#wl .cit-c{color:#8a7d63}#wl .cit-b{padding:0 14px 14px}#wl .cit .ctx{color:#a59a84;font-size:14px;line-height:1.55;padding:6px 0}#wl .cit .neo{margin:6px 0;padding:10px 14px;border-left:4px solid #18b45f;background:#effaf3;border-radius:0 10px 10px 0;color:#1f1a12;font-size:15px;line-height:1.6}#wl .cit .neo p{margin:0 0 8px}#wl .cit .neo blockquote{margin:0;padding:0 0 0 12px;border-left:2px solid #c9bfa8;font-style:italic}#wl .cit .neo em{font-style:normal;color:#6b604c;font-size:14px}#wl .cit-meta{font-size:13px;color:#6b604c;margin:6px 0 4px;line-height:1.5}#wl .chapo{margin:18px 0 6px;padding:14px 16px;border-radius:14px;background:linear-gradient(180deg,#fff7df,#fffdf6);border:1px solid #ecd8a2}#wl .ch-t{font-weight:700;font-size:15.5px;color:#1f1a12}#wl .ch-s{font-size:13.5px;color:#6b604c;margin-top:4px;line-height:1.5}#wl .chapo mark{background:#c9f2d7;color:#0f3d22;padding:1px 3px;border-radius:3px}#wl label.chk{display:flex;gap:8px;align-items:baseline;margin:7px 0;font-size:14px;cursor:pointer}#wl label.chk input{transform:translateY(2px)}#wl .cit-ed summary{cursor:pointer;font-size:13.5px;color:#6b604c;margin:6px 0}\
#wl .caisse{margin:12px 0;padding:14px 16px;border-radius:16px;background:radial-gradient(120% 140% at 0% 0%,rgba(255,200,80,.16),rgba(255,200,80,.03) 60%);border:1px solid rgba(255,200,80,.35)}#wl .cz-h{display:flex;justify-content:space-between;gap:8px;align-items:center;font-size:13.5px}#wl .cz-n{font-size:34px;font-weight:800;color:#ffd77a;margin-top:6px;display:flex;align-items:baseline;gap:10px}#wl .cz-n small{font-size:15px;font-weight:600;color:rgba(243,236,224,.75)}#wl .cz-s{font-size:12.5px;color:rgba(243,236,224,.58)}#wl .cz-l{padding:10px 12px;margin:8px 0;border-radius:12px;background:rgba(255,255,255,.035);border:1px solid rgba(255,255,255,.08)}#wl .cz-d{margin-top:14px;padding:10px 12px;border-radius:12px;background:rgba(255,255,255,.025);border:1px solid rgba(255,255,255,.07);font-size:13.5px}#wl .fa-ed{margin-top:10px;padding:10px 12px;border-radius:12px;background:rgba(255,255,255,.04);border:1px dashed rgba(255,255,255,.18)}#wl .fa-ed label{display:block;font-size:12.5px;color:rgba(243,236,224,.6);margin:8px 0 4px}#wl .cz-d summary{cursor:pointer;font-weight:600}#wl .cz-d p{color:rgba(243,236,224,.75);line-height:1.6}\
#wl .cfm-bg{position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(5,4,3,.62);backdrop-filter:blur(3px);opacity:0;transition:opacity .18s}#wl .cfm-bg.on{opacity:1}#wl .cfm{width:min(440px,100%);background:#14110c;border:1px solid rgba(0,255,119,.35);border-radius:18px;padding:22px 22px 18px;box-shadow:0 30px 80px rgba(0,0,0,.6);transform:translateY(8px) scale(.98);transition:transform .18s}#wl .cfm-bg.on .cfm{transform:none}#wl .cfm.danger{border-color:rgba(255,80,80,.45)}#wl .cfm-ic{font-size:26px;margin-bottom:8px}#wl .cfm-t{font-weight:700;font-size:16.5px;line-height:1.35}#wl .cfm-d{margin-top:10px;font-size:13.5px;line-height:1.55;color:rgba(243,236,224,.7)}#wl .cfm-a{display:flex;justify-content:flex-end;gap:8px;margin-top:18px}\
#wl .bub.bot{background:rgba(255,190,90,.08);border-color:rgba(255,190,90,.35);border-left:3px solid rgba(255,190,90,.8)}#wl .bub.bot .who{color:#ffcf8a;font-weight:600}\
#wl .box.iv{margin:14px 0 4px;border-color:rgba(0,255,119,.35);background:rgba(0,255,119,.05)}#wl .ivl{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-top:10px;padding-top:10px;border-top:1px solid rgba(255,255,255,.07)}#wl .ivl span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\
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
#wl .lbl{font-family:Inter,sans-serif;font-size:17px;font-weight:700;fill:#f3ece0}\
#wl .lbl2{font-family:Inter,sans-serif;font-size:13.5px;fill:rgba(243,236,224,.66)}\
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
@media (max-width:720px){#wl{font-size:14.5px}#wl .top{flex-wrap:wrap;gap:8px;padding:10px 12px}#wl .chips{order:3;justify-content:flex-start;flex-basis:100%;flex-wrap:nowrap;overflow-x:auto;scrollbar-width:none}#wl .chips::-webkit-scrollbar{display:none}#wl .clock{order:2;font-size:17px;margin-left:auto}#wl .wrap{padding:0 10px 60px}#wl .tabs{padding:8px 10px 0}#wl .panel{width:100vw;top:6vh;border-radius:18px 18px 0 0;border-left:none;border-top:1px solid rgba(255,190,90,.3);transform:translateY(105%)}#wl .panel.open{transform:none}#wl .floor svg{min-width:1500px}#wl .paper{margin:10px 8px 60px;padding:22px 16px 28px;font-size:16.5px}#wl .paper h1{font-size:22px}#wl .two{grid-template-columns:1fr}#wl .kan{grid-template-columns:repeat(4,82vw)}#wl button.clsr-h{top:auto;bottom:150px;padding:10px 6px}#wl .clsr-h .lb{display:none}#wl .clsr{width:100vw;top:8vh;border-left:none;border-top:1px solid rgba(255,190,90,.3);border-radius:18px 18px 0 0;transform:translateY(105%)}#wl .clsr.open{transform:none}}\
";

  // ---------- le plan de la rédaction (SVG, 1600 × 1000) ----------
  // Plan en largeur (21/10/2026) : 4 pièces par rangée, 2 rangées → beaucoup moins haut, tout le monde voit tous les bureaux.
  var PLAN_W = 2760, PLAN_H = 1000;
  var ROOMS = [
    { key: 'redac', name: 'Salle de rédaction', x: 30, y: 30, w: 560, h: 410, floor: '#16110b' },
    { key: 'secr', name: 'Secrétariat', x: 610, y: 30, w: 760, h: 410, floor: '#0b1216' },
    { key: 'biblio', name: 'Bibliothèque', x: 1390, y: 30, w: 380, h: 410, floor: '#120e19' },
    { key: 'sc', name: 'Service client · subs@', x: 1790, y: 30, w: 560, h: 410, floor: '#0c1414' },
    { key: 'chef', name: 'Bureau du rédacteur en chef', x: 30, y: 500, w: 560, h: 470, floor: '#0f140c' },
    { key: 'courrier', name: 'Salle du courrier', x: 610, y: 500, w: 560, h: 470, floor: '#0c0f16' },
    { key: 'marbre', name: 'Le marbre · Ghost', x: 1190, y: 500, w: 580, h: 470, floor: '#0a0d0b' },
    { key: 'mk', name: 'Marketing · redaction@', x: 1790, y: 500, w: 560, h: 470, floor: '#16100c' },
    { key: 'compta', name: 'Arrière-salle · comptabilité', x: 2370, y: 30, w: 360, h: 940, floor: '#110d07' }
  ];
  function rooms() { return ROOMS; }
  function people() {
    var eq = D().equipe || [];
    var js = eq.filter(function (w) { return w.role !== 'chef'; }).slice(0, 3);
    var chef = eq.filter(function (w) { return w.role === 'chef'; })[0] || { id: 'chef', nom: 'Le rédacteur en chef', titre: 'Rédacteur en chef' };
    var xs = js.length === 3 ? [130, 310, 490] : js.length === 2 ? [190, 430] : [310];
    var list = [];
    if (!js.length) list.push({ key: 'j:vide', kind: 'journaliste', vide: true, nom: 'Poste de la journaliste', titre: 'à attribuer', emoji: '✍️', hue: 330, x: 310, y: 215 });
    js.forEach(function (w, i) { list.push({ key: 'j:' + w.id, id: w.id, kind: 'journaliste', nom: w.nom, titre: w.titre, emoji: '✍️', hue: [330, 300, 15][i], x: xs[i], y: 215 }); });
    list.push({ key: 'secretaire', kind: 'secretaire', nom: 'La Secrétaire', titre: 'Rédige, fait valider, envoie', emoji: '📮', hue: 200, x: 1255, y: 215 });
    list.push({ key: 'assistant', kind: 'assistant', nom: 'L’Assistant', titre: 'Questions et contacts', emoji: '🧠', hue: 265, x: 1580, y: 215 });
    list.push({ key: 'chef', id: chef.id, kind: 'chef', nom: chef.nom, titre: chef.titre || 'Rédacteur en chef', emoji: '🧐', hue: 40, x: 310, y: 735 });
    list.push({ key: 'courrier', kind: 'courrier', nom: 'Le Courrier', titre: 'Suit les réponses', emoji: '📬', x: 890, y: 735, device: true });
    list.push({ key: 'marbre', kind: 'marbre', nom: 'Le Marbre', titre: 'Les brouillons Ghost', emoji: '📰', x: 1480, y: 735, device: true });
    list.push({ key: 'sc', kind: 'sc', nom: JULIEN.sc.nom, titre: JULIEN.sc.adr, emoji: JULIEN.sc.emoji, hue: 175, x: 2070, y: 215 });
    list.push({ key: 'mk', kind: 'mk', nom: JULIEN.mk.nom, titre: JULIEN.mk.adr, emoji: JULIEN.mk.emoji, hue: 20, x: 2070, y: 735 });
    list.push({ key: 'compta', kind: 'compta', nom: 'Le Comptable', titre: 'Les pièces de la rédaction', emoji: '🧮', hue: 45, x: 2550, y: 230 });
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
    if (p.kind === 'compta') {
      var R = S.pieces || {}, me0 = D().me, af = (R.conversions || []).filter(function (c) { return c.statut === 'a_facturer' && (me0.chef || c.membre === me0.id); }).length;
      var av = me0.chef ? (R.pieces || []).filter(function (x) { return x.statut === 'a_verifier'; }).length : 0;
      var dm = me0.chef ? Object.keys(R.demandes || {}).filter(function (k) { return R.demandes[k] === R.mois && ((R.soldes || {})[k] || 0) > 0; }).length : 0;
      return dm ? { s: 'on', why: dm + ' demande' + pl(dm) + ' de paiement' } : af ? { s: 'slot', why: af + ' montant' + pl(af) + ' à facturer' } : av ? { s: 'slot', why: av + ' à vérifier' } : { s: 'off', why: 'compte les pièces' };
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
    else if (p.kind === 'compta') deco = '<rect x="-60" y="-22" width="22" height="28" rx="3" fill="#2d2a24" stroke="rgba(255,255,255,.25)"/><rect x="-57" y="-19" width="16" height="6" fill="#9fe8b4"/><rect x="-57" y="-10" width="4" height="4" fill="#ccc"/><rect x="-51" y="-10" width="4" height="4" fill="#ccc"/><rect x="-45" y="-10" width="4" height="4" fill="#ffb020"/><rect x="34" y="-20" width="24" height="18" rx="2" fill="#5b1f1f"/><rect x="37" y="-17" width="18" height="2" fill="#e8c27a"/>';
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
      '<text class="lbl2" x="0" y="116" text-anchor="middle">' + esc(o.why) + '</text>' +
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
      '<text class="lbl" x="0" y="80" text-anchor="middle">' + esc(p.nom) + '</text><text class="lbl2" x="0" y="100" text-anchor="middle">' + esc(o.why) + '</text></g>';
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
  // Étagère du Secrétariat : une case par enquête (dossier), 4 cases par rayon. Survol = infobulle (titre + avancement), clic = le dossier.
  // Arrière-salle : sur la table du Comptable, une caisse par journaliste avec son solde de pièces ; animation quand il en distribue.
  // Qui gagne des pièces : les rédactrices, plus le rédacteur en chef s'il a activé le « mode récompense (test) » dans ses Paramètres.
  function testRec() { return !!(S.pieces && S.pieces.recompense_test); }
  function gagnants() { return (D().equipe || []).filter(function (w) { return w.role !== 'chef' || testRec(); }); }
  function caissesSVG() {
    var js = gagnants().slice(0, 3);
    var so = (S.pieces && S.pieces.soldes) || {}, X0 = 2550, Y0 = 600;
    var s = '<g class="compta-deco"><rect x="2400" y="860" width="80" height="90" rx="6" fill="#262626" stroke="rgba(255,255,255,.18)" stroke-width="2"/><circle cx="2440" cy="905" r="16" fill="none" stroke="#9a8a6a" stroke-width="3"/><rect x="2437" y="889" width="6" height="12" fill="#9a8a6a"/><text class="lbl2" x="2440" y="965" text-anchor="middle">coffre</text></g>';
    s += '<rect x="' + (X0 - 150) + '" y="' + (Y0 - 50) + '" width="300" height="150" rx="10" fill="url(#wood)" stroke="rgba(255,255,255,.14)"/><text class="lbl2" x="' + X0 + '" y="' + (Y0 + 125) + '" text-anchor="middle">table des caisses</text>';
    var xs = js.length === 3 ? [-95, 0, 95] : js.length === 2 ? [-60, 60] : [0];
    js.forEach(function (w, i) {
      var n = so[w.id] || 0, x = X0 + xs[i], anim = S.caisseAnim && S.caisseAnim[w.id];
      var tas = '';
      for (var k = 0; k < Math.min(6, Math.ceil(n / 5)); k++) tas += '<ellipse cx="' + (x - 14 + (k % 3) * 14) + '" cy="' + (Y0 + 2 - Math.floor(k / 3) * 7) + '" rx="8" ry="4" fill="#ffd25a" stroke="#a87a14"/>';
      s += '<g class="case" data-act="pieces" data-tip="' + esc('Caisse de ' + w.nom + '|🪙 ' + n + ' pièces à convertir|' + (n ? '≈ ' + eurTxt(n * Number((S.pieces || {}).taux || 0)) : 'vide pour l’instant')) + '" data-tip-act="Cliquer pour voir le Comptable">' +
        '<rect x="' + (x - 34) + '" y="' + (Y0 - 18) + '" width="68" height="44" rx="5" fill="#3d2b17" stroke="#c99a3a" stroke-width="2"/>' + tas +
        '<rect x="' + (x - 34) + '" y="' + (Y0 + 8) + '" width="68" height="18" rx="3" fill="#2a1d10"/><text x="' + x + '" y="' + (Y0 + 21) + '" text-anchor="middle" font-size="12" font-weight="800" fill="#ffd77a">🪙 ' + n + '</text>' +
        '<text class="lbl2" x="' + x + '" y="' + (Y0 + 44) + '" text-anchor="middle">' + esc(w.nom.split(' ')[0]) + '</text>';
      if (anim) for (var c = 0; c < 5; c++) s += '<g><ellipse cx="0" cy="0" rx="8" ry="4" fill="#ffd25a" stroke="#a87a14"><animateMotion dur="' + (0.9 + c * 0.15) + 's" begin="' + (c * 0.18) + 's" fill="freeze" path="M' + 2550 + ' ' + 300 + ' Q' + ((2550 + x) / 2) + ' ' + 360 + ' ' + x + ' ' + (Y0 - 6) + '"/></ellipse></g>';
      s += '</g>';
    });
    return s;
  }
  function eurTxt(n) { return (Math.round(n * 100) / 100).toFixed(2).replace('.', ',') + ' €'; }
  function etagereSVG() {
    var actifs = vues().filter(function (f) { return f.statut !== 'inséré'; });
    var ivs = aInterviewer().map(function (a) { return { iv: a }; });
    var ds = ivs.concat(dossiers(actifs)), X = 720, Y = 64, CW = 62, CH = 78, cols = 4, rows = 4, max = cols * rows;
    var s = '<g class="etagere"><rect x="' + (X - 8) + '" y="' + (Y - 8) + '" width="' + (cols * CW + 16) + '" height="' + (rows * CH + 16) + '" rx="6" fill="#2b2015" stroke="rgba(255,190,90,.25)" stroke-width="2"/>';
    for (var r = 0; r < rows; r++) s += '<rect x="' + (X - 8) + '" y="' + (Y + r * CH + CH - 6) + '" width="' + (cols * CW + 16) + '" height="6" fill="#4a3624"/>';
    s += '<text class="lbl2" x="' + (X + cols * CW / 2) + '" y="' + (Y + rows * CH + 30) + '" text-anchor="middle">étagère des dossiers' + (ds.length ? ' · ' + ds.length + ' enquête' + pl(ds.length) : ' · vide') + (ivs.length ? ' · 🎙️ ' + ivs.length + ' à interviewer' : '') + '</text>';
    ds.slice(0, max).forEach(function (d, i) {
      var cx = X + (i % cols) * CW, cy = Y + Math.floor(i / cols) * CH;
      if (d.iv) { // enquête premium sans demande d'interview : case au micro, clic = préparer les interviews
        s += '<g class="case" data-act="express" data-id="' + esc(d.iv.id) + '" data-tip="' + esc(d.iv.titre + '|🎙️ interviews pas encore préparées|aucune demande pour l’instant') + '" data-tip-act="Cliquer pour préparer les interviews" transform="translate(' + cx + ',' + cy + ')"><rect x="2" y="4" width="' + (CW - 4) + '" height="' + (CH - 12) + '" rx="4" fill="rgba(255,176,32,.08)" stroke="rgba(255,176,32,.55)" stroke-dasharray="4 3"/>' +
          '<g transform="translate(' + (CW / 2) + ',' + (CH / 2 - 4) + ')"><rect x="-7" y="-18" width="14" height="22" rx="7" fill="#d9d2c3" stroke="#6b5f4a"/><path d="M-11 -2 a11 11 0 0 0 22 0" fill="none" stroke="#d9d2c3" stroke-width="2.5"/><rect x="-1.5" y="9" width="3" height="7" fill="#d9d2c3"/><rect x="-7" y="15" width="14" height="3" rx="1.5" fill="#d9d2c3"/></g>' +
          '<g transform="translate(' + (CW - 14) + ',14)"><circle r="10" fill="#ffb020" filter="url(#glow)"/><text y="4" text-anchor="middle" font-size="11" font-weight="800" fill="#2a1a00">!</text></g></g>';
        return;
      }
      var c = function (st) { return d.fiches.filter(function (f) { return f.statut === st; }).length; };
      var col = c('a répondu') ? '#3fd88a' : c('brouillon') ? '#ffb020' : '#7fb2ff';
      var tip = d.titre + '|' + [c('brouillon') ? c('brouillon') + ' à valider' : '', c('envoyé') ? c('envoyé') + ' envoyé' + pl(c('envoyé')) : '', c('a répondu') ? c('a répondu') + ' réponse' + pl(c('a répondu')) : ''].filter(Boolean).join(' · ') + '|' + d.fiches.map(function (f) { return f.contact.nom; }).join(', ');
      if (i === max - 1 && ds.length > max) { s += '<g class="case" data-act="open-ag" data-ag="secretaire" data-tip="' + esc('+' + (ds.length - max + 1) + ' autres dossiers|ouvrir la Secrétaire|') + '" transform="translate(' + cx + ',' + cy + ')"><rect x="4" y="8" width="' + (CW - 8) + '" height="' + (CH - 18) + '" rx="4" fill="#3a2c1d"/><text x="' + (CW / 2) + '" y="' + (CH / 2 + 4) + '" text-anchor="middle" font-size="16" font-weight="800" fill="#ffcf8a">+' + (ds.length - max + 1) + '</text></g>'; return; }
      s += '<g class="case" data-act="dossier-sec" data-id=""' + esc(d.id || 'sans') + '" data-tip="' + esc(tip) + '" transform="translate(' + cx + ',' + cy + ')"><rect x="2" y="4" width="' + (CW - 4) + '" height="' + (CH - 12) + '" rx="4" fill="transparent"/>';
      var n = Math.min(d.fiches.length, 4);
      for (var k = 0; k < n; k++) s += '<rect x="' + (10 + k * 9) + '" y="' + (16 + (k % 2) * 3) + '" width="16" height="' + (CH - 34) + '" rx="2" fill="' + ['#e8d9b8', '#d9c8a2', '#efe3c8', '#cdbb94'][k] + '" stroke="rgba(0,0,0,.35)"/>';
      s += '<g transform="translate(' + (CW - 14) + ',14)"><circle r="10" fill="' + col + '" filter="url(#glow)"/><text y="4" text-anchor="middle" font-size="11.5" font-weight="800" fill="#05170d">' + d.fiches.length + '</text></g></g>';
    });
    return s + '</g>';
  }
  function pilesSVG() {
    var s = '';
    people().forEach(function (p) {
      var cs = pileOf(p); if (!cs.length) return;
      var n = Math.min(cs.length, 3), y = p.device ? p.y - 118 : p.y - 82, vert = p.kind === 'secretaire';
      var g = '<g class="pile" data-ag="' + esc(p.key) + '" transform="translate(' + (vert ? p.x - 100 : p.x) + ',' + (vert ? p.y - 10 : y) + ') scale(' + (vert ? 1.05 : 1.25) + ')"><g class="fl"><rect x="-62" y="-30" width="124" height="52" fill="transparent"/>';
      for (var k = 0; k < n; k++) {
        var c = cs[k], off = vert ? 0 : (k - (n - 1) / 2) * 30, rot = vert ? (k - (n - 1) / 2) * 4 : (k - (n - 1) / 2) * 11;
        if (vert) off = 'V' + ((k - (n - 1) / 2) * 34);
        var col = c === 'a' ? '#fff0cc' : c === 'b' ? '#e3edff' : c === 'g' ? '#e2ffef' : c === 'n' ? '#fff7b0' : '#f6f2e7';
        g += '<g transform="translate(' + (String(off).charAt(0) === 'V' ? '0,' + String(off).slice(1) : off + ',0') + ') rotate(' + rot + ')"><rect class="paperS" x="-19" y="-24" width="38" height="46" rx="3" fill="' + col + '" stroke="rgba(0,0,0,.35)" filter="url(#glow)"/>';
        if (c === 'b' || c === 'g') g += '<rect x="-14" y="-12" width="28" height="18" rx="2" fill="' + (c === 'g' ? '#3fd88a' : '#6f9fe0') + '"/><path d="M-14 -12 l14 10 l14 -10" stroke="rgba(0,0,0,.4)" fill="none"/>';
        else g += '<rect x="-13" y="-17" width="26" height="3" fill="#9aa39d"/><rect x="-13" y="-10" width="22" height="3" fill="#b9c0bb"/><rect x="-13" y="-3" width="24" height="3" fill="#b9c0bb"/><rect x="-13" y="4" width="16" height="3" fill="' + (c === 'a' ? '#e0a020' : '#b9c0bb') + '"/>';
        g += '</g>';
      }
      var badge = cs[0] === 'g' ? '#00ff77' : cs[0] === 'a' ? '#ffb020' : cs[0] === 'b' ? '#7fb2ff' : '#00ff77';
      g += '</g><g transform="translate(' + (vert ? 26 : n * 15 + 14) + ',' + (vert ? -(n * 17 + 14) : -24) + ')"><circle r="11" fill="' + badge + '" filter="url(#glow)"/><text y="4.5" text-anchor="middle" font-size="13" font-weight="800" fill="#05170d">' + cs.length + '</text></g></g>';
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
    var HH = PLAN_H, WW = PLAN_W;
    var s = '<svg viewBox="0 0 ' + WW + ' ' + HH + '" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="La rédaction de Posthumain vue de haut">' + defs + '<rect width="' + WW + '" height="' + HH + '" fill="#0a0806"/>';
    s += '<rect x="20" y="448" width="2340" height="44" fill="#100d09"/><rect x="20" y="448" width="2340" height="44" fill="url(#tiles)"/><text class="roomname" x="40" y="475" style="font-size:11px">couloir · le chemin du courrier</text>';
    rooms().forEach(function (r) {
      s += '<rect x="' + r.x + '" y="' + r.y + '" width="' + r.w + '" height="' + r.h + '" rx="10" fill="' + r.floor + '"/>';
      s += '<rect x="' + r.x + '" y="' + r.y + '" width="' + r.w + '" height="' + r.h + '" rx="10" fill="url(#' + (r.key === 'redac' || r.key === 'chef' ? 'parquet' : 'tiles') + ')"/>';
      s += '<rect x="' + r.x + '" y="' + r.y + '" width="' + r.w + '" height="' + r.h + '" rx="10" fill="none" stroke="rgba(243,236,224,.16)" stroke-width="5"/>';
      s += '<text class="roomname" x="' + (r.x + 16) + '" y="' + (r.y + 26) + '">' + esc(r.name) + '</text>';
    });
    [[310, 440], [1090, 440], [1580, 440], [2070, 440], [310, 500], [890, 500], [1480, 500], [2070, 500]].forEach(function (p) { s += '<rect x="' + (p[0] - 34) + '" y="' + (p[1] - 4) + '" width="68" height="8" fill="#0a0806"/>'; });
    s += '<rect x="2364" y="452" width="12" height="36" fill="#0a0806"/>'; // porte dérobée de l'arrière-salle
    // décor : étagères de la bibliothèque, tableau de liège de la rédaction, fauteuils du chef
    s += '<g transform="translate(1410,60)">';
    for (var i = 0; i < 9; i++) s += '<rect x="' + (i * 38) + '" y="0" width="34" height="14" rx="2" fill="hsl(' + (i * 37) + ',35%,32%)"/>';
    s += '</g><g class="tableau" data-act="articles" transform="translate(60,62)"><title>Tableau des sujets : les brouillons Ghost (touchez pour choisir l’article en cours)</title><rect width="200" height="60" rx="6" fill="#5a4426" stroke="rgba(0,0,0,.4)"/>';
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
      var pth = function (to) { return to.y < 470 ? 'M' + cour.x + ' ' + (cour.y - 80) + ' V466 H' + to.x + ' V' + (to.y + 120) : 'M' + cour.x + ' ' + (cour.y - 80) + ' V478 H' + to.x + ' V' + (to.y - 80); };
      [[jsc, 'subs'], [jmk, 'redaction']].forEach(function (d) {
        var live = arr.indexOf(d[1]) >= 0, path = pth(d[0]);
        s += '<path class="cable" d="' + path + '" stroke="rgba(0,0,0,.6)" stroke-width="7" fill="none"/><path class="cable' + (live ? ' live' : '') + '" d="' + path + '" fill="none" stroke="' + (live ? '#00ff77' : 'rgba(255,190,90,.18)') + '" stroke-width="' + (live ? 3 : 2) + '"' + (live ? ' filter="url(#glow)"' : '') + '/>';
        if (live) s += '<g filter="url(#glow)"><rect x="-16" y="-11" width="32" height="22" rx="3" fill="#e2ffef" stroke="#00ff77" stroke-width="2"/><path d="M-16 -11 l16 12 l16 -12" stroke="#1d6b45" stroke-width="2" fill="none"/><animateMotion dur="2.8s" fill="freeze" path="' + path + '"/></g>';
      });
    }
    s += etagereSVG() + caissesSVG();
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
  function pieceChip() {
    var me = D().me, av = ((S.pieces && S.pieces.pieces) || []).filter(function (p) { return p.statut === 'a_verifier'; }).length;
    if (!S.pieces) return '';
    var af = ((S.pieces && S.pieces.conversions) || []).filter(function (c) { return c.statut === 'a_facturer' && (me.chef || c.membre === me.id); }).length;
    var so = ((S.pieces && S.pieces.soldes) || {})[me.id] || 0;
    return '<span class="chip' + ((av && me.chef) || (af && !me.chef) ? ' warn' : '') + '" data-act="pieces" title="Les pièces de la rédaction">🪙 ' + (me.chef ? (av ? av + ' à vérifier' : af ? af + ' à facturer' : 'pièces') : so + (af ? ' · 💶 à facturer' : '')) + '</span>';
  }
  function header() {
    var a = art(S.art), v = by('brouillon').length, r = by('a répondu').length, e = by('envoyé').length;
    return '<div class="logo">WRITINGLAB<small>La rédaction de Posthumain</small></div>' +
      '<div class="chips">' +
      '<span class="chip art" data-act="articles" title="Changer d’article">📰 ' + (a ? esc(a.titre) : 'Choisir l’article en cours') + '</span>' +
      pieceChip() +
      (aInterviewer().length ? '<span class="chip hot" data-act="a-interviewer">🎙️ ' + aInterviewer().length + ' à interviewer</span>' : '') +
      (v ? '<span class="chip warn" data-act="open-ag" data-ag="secretaire">🟠 ' + v + ' à valider</span>' : '') +
      (r ? '<span class="chip hot" data-act="open-ag" data-ag="courrier">📬 ' + r + ' réponse' + pl(r) + '</span>' : '') +
      (e ? '<span class="chip" data-act="open-ag" data-ag="courrier">⏳ ' + e + ' en attente</span>' : '') +
      '<span class="chip" data-act="parametres" title="Paramètres (notifications, signature, dictée)">⚙️' + (S.pushOk ? '' : '<span class="dot-off"></span>') + '</span>' +
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
  function bandeauInterviews() {
    var l = aInterviewer(); if (!l.length) return '';
    return '<div class="box iv"><div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:center"><b>🎙️ ' + l.length + ' enquête' + pl(l.length) + ' attend' + (l.length > 1 ? 'ent' : '') + ' ses interviews</b><button class="btn small" data-act="a-interviewer">Voir la file</button></div>' +
      l.slice(0, 3).map(function (a) { return '<div class="ivl"><span>' + esc(a.titre) + '</span><button class="btn small go" data-act="express" data-id="' + esc(a.id) + '"' + (S.busy.assistant ? ' disabled' : '') + '>⚡ Préparer les interviews</button></div>'; }).join('') + '</div>';
  }
  function artCard(a) {
    var n = D().fiches.filter(function (f) { return f.article_id === a.id; }).length;
    return '<div class="ar' + (a.id === S.art ? ' sel' : '') + '" data-act="pick-art" data-id="' + esc(a.id) + '"><div class="ph">' + (a.image ? '<img loading="lazy" alt="" src="' + esc(a.image) + '">' : '📰') + '</div><div class="b"><div class="ti">' + esc(a.titre) + '</div><div class="me">' +
      (a.statut === 'published' ? '<span class="tag g">publié ' + esc(when(a.publie_le)) + '</span>' : '<span class="tag ' + (a.statut === 'scheduled' ? 'b' : 'a') + '">' + (a.statut === 'scheduled' ? 'programmé' : 'brouillon') + '</span>') + (premium(a) ? '<span class="tag">premium</span>' : '') + (premium(a) && !n ? '<span class="tag g">🎙️ interviews à lancer</span>' : '') + (a.mien ? '<span class="tag g">le vôtre</span>' : '') + (n ? '<span class="tag">' + n + ' contact' + pl(n) + '</span>' : '') +
      '<br>' + esc((a.auteurs || []).join(', ')) + ' · modifié ' + esc(when(a.maj)) + ' · <a href="' + esc(a.editeur) + '" target="_blank" rel="noopener" data-stop="1">ouvrir dans Ghost</a>' + (premium(a) && !n ? '<div style="margin-top:8px"><button class="btn small go" data-act="express" data-id="' + esc(a.id) + '"' + (S.busy.assistant ? ' disabled' : '') + '>⚡ Préparer les interviews</button></div>' : '') + '</div></div></div>';
  }
  function viewArticles() {
    var as = artsRecents();
    if (D().ghost && D().ghost !== 'ok') return '<div class="box warn" style="margin-top:14px">⚠️ ' + esc(D().ghost) + '</div>';
    var iv = aInterviewer();
    return (iv.length ? '<h3 id="a-interviewer" style="margin-top:16px">🎙️ À interviewer (' + iv.length + ')</h3><p class="muted">Enquêtes premium sans aucune demande d’interview. « Préparer les interviews » : l’Assistant trouve 2 ou 3 chercheurs (adresses publiées uniquement), écrit les questions, et la Secrétaire prépare les mails. Vous n’avez plus qu’à les relire et les valider (1 à 2 minutes de préparation).</p><div class="arts">' + iv.map(artCard).join('') + '</div><h3 style="margin-top:22px">📰 Tous les brouillons</h3>' : '') +
      '<p class="muted" style="margin-top:14px">L’article en cours guide l’Assistant (questions, chercheurs à contacter) et reçoit les citations. Brouillons et articles programmés de Ghost :</p><div class="arts">' + (as.map(artCard).join('') || '<div class="muted">Aucun brouillon dans Ghost.</div>') + '</div>';
  }
  function dcard(f, extra) {
    var s = STATUTS[f.statut] || ['·', f.statut, ''];
    var og = origine(f);
    return '<div class="dcard ' + s[2] + '" data-act="' + (f.statut === 'brouillon' ? 'open-valid' : 'open-fiche') + '" data-id="' + esc(f.fiche_id) + '"><div class="k">' + s[0] + ' ' + esc(s[1]) + ' · ' + og[0] + ' ' + og[1] + (D().me.chef ? ' · ' + esc(qui(f)) : '') + '</div>' +
      '<div class="ti">' + esc(f.contact.nom || '(sans nom)') + '</div><div class="su">' + esc([f.contact.role, f.contact.institution].filter(Boolean).join(', ')) + '</div>' +
      '<div class="su">📰 ' + esc(f.article_titre || 'sans article') + '</div>' + (extra || '') + '</div>';
  }
  function viewSuivi() {
    var cols = [['brouillon', '🟠 À valider'], ['envoyé', '📨 Envoyés'], ['a répondu', '📬 Réponses'], ['inséré', '✅ Cités']];
    var vide = !vues().length;
    var intro = '<p class="muted" style="margin-top:14px">Le parcours des demandes d’interview' + (D().me.chef ? ' de toute la rédaction' : '') + ' : mail rédigé par la Secrétaire → envoyé → réponse reçue → citation insérée dans l’article. Les fiches archivées n’apparaissent plus ici.</p>' +
      (vide ? '<div class="box" style="margin-top:6px">Aucune demande en cours pour l’instant. Pour en lancer une : choisissez un article, puis demandez à l’Assistant qui interroger.<div class="row" style="margin-top:10px"><button class="btn" data-act="open-ag" data-ag="assistant">🧠 Préparer une interview</button><button class="btn small" data-act="open-ag" data-ag="secretaire">📮 Écrire à quelqu’un</button></div></div>' : '');
    var ds = dossiers(vues());
    var dosHTML = ds.length ? '<h3 style="margin-top:14px">🗂️ Dossiers par enquête</h3>' + ds.map(function (d) {
      return '<div class="dossier" id="dossier-' + esc(d.id || 'sans') + '"><div class="dh"><b>📰 ' + esc(d.titre) + '</b>' + avancement(d.fiches) + '</div><div class="muted" style="font-size:12.5px">' + esc(d.fiches.map(function (f) { return f.contact.nom; }).join(' · ')) + ' — ' + origines(d.fiches) + (d.id && art(d.id) ? ' · <a href="#" data-act="pick-art" data-id="' + esc(d.id) + '">en faire l’article en cours</a>' : '') + '</div></div>';
    }).join('') + '<h3 style="margin-top:18px">Par étape</h3>' : '';
    return intro + porteeHTML() + dosHTML + '<div class="kan" style="margin-top:14px">' + cols.map(function (c) {
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
      var bot = !D().equipe.some(function (w) { return w.id === m.auteur; });
      var btns = m.auteur === 'compta' ? '<div class="row" style="margin-top:8px">' + (/^\s*(🧾|💸)/.test(m.texte || '') || /facture/i.test((m.texte || '').slice(0, 40)) ? '<button class="btn small" data-act="voir-facture">🧾 Voir la facture</button>' : '<button class="btn small" data-act="pieces">🪙 Ouvrir les pièces</button>') + '</div>' : bot && m.article_id ? '<div class="row" style="margin-top:8px;gap:6px;flex-wrap:wrap">' + (art(m.article_id) ? '<button class="btn small" data-act="pick-art" data-id="' + esc(m.article_id) + '">📰 Ouvrir l’enquête</button>' : '') +
        (art(m.article_id) && !D().fiches.some(function (f) { return f.article_id === m.article_id; }) ? '<button class="btn small go" data-act="express" data-id="' + esc(m.article_id) + '">⚡ Préparer les interviews</button>' : (D().fiches.some(function (f) { return f.article_id === m.article_id; }) ? '<span class="muted">✓ interviews lancées</span>' : '')) + '</div>' : '';
      return '<div class="bub' + (m.auteur === me ? ' me' : '') + (bot ? ' bot' : '') + '"><div class="who">' + esc(m.nom) + ' · ' + esc(when(m.le)) + (m.article_titre && !bot ? ' · 📰 ' + esc(m.article_titre) : '') + '</div>' + (m.texte ? esc(m.texte).replace(/\n/g, '<br>') : '') + (m.fichier ? fichierHTML(m.fichier) : '') + btns + '</div>';
    }).join('');
    var a = art(S.art);
    return '<p class="muted" style="margin-top:14px">Les messages et fichiers entre la rédaction et le rédacteur en chef. Entrée pour envoyer, Maj + Entrée pour aller à la ligne. Les fichiers échangés sont rangés dans le classeur, à droite.</p>' + classeurHTML(fichiers) +
      '<div class="chat">' + (list || '<div class="muted">Pas encore de message.</div>') + '</div>' +
      '<div class="composer"><textarea class="in' + (S.miseEnForme ? ' wl-mef" disabled' : '"') + ' id="wl-msg" placeholder="' + (S.dicte ? '🎙️ Je vous écoute…' : 'Votre message…') + '" rows="3">' + esc(S.msgDraft || '') + '</textarea>' +
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
  S.miseEnForme = false;
  var SR = window.SpeechRecognition || window.webkitSpeechRecognition || null;
  function majMic() {
    var b = S.root && S.root.querySelector('[data-act="dicter"]'); if (b) { b.classList.toggle('on', !!S.dicte); b.textContent = S.dicte ? '⏹️ Arrêter' : '🎙️ Dicter'; }
    var ta = S.root && S.root.querySelector('#wl-msg'); if (ta) ta.placeholder = S.dicte ? '🎙️ Je vous écoute…' : 'Votre message…';
  }
  function startDictee() {
    if (!SR) { toast('La dictée n’est pas disponible dans ce navigateur.', true); return; }
    var ta = S.root.querySelector('#wl-msg'); if (!ta) return;
    var base = ta.value ? ta.value.replace(/\s*$/, ' ') : '', fini = '', enCours = '', fait = false;
    var rec = new SR(); rec.lang = LS.get('wl-dictee-lang') || 'fr-FR'; rec.continuous = true; rec.interimResults = true;
    rec.onresult = function (ev) {
      var interim = '';
      if (fait) return;
      for (var i = ev.resultIndex; i < ev.results.length; i++) { var t = ev.results[i][0].transcript; if (ev.results[i].isFinal) fini += t; else interim += t; }
      enCours = interim;
      var txt = (base + fini + interim).replace(/^\s+/, '');
      var el = S.root.querySelector('#wl-msg'); if (el) { el.value = txt; el.scrollTop = el.scrollHeight; }
      S.msgDraft = (base + fini).replace(/^\s+/, '');
    };
    rec.onerror = function (ev) { if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') toast('Autorisez le micro pour posthumain.com dans le navigateur.', true); else if (ev.error !== 'no-speech' && ev.error !== 'aborted') toast('Dictée interrompue (' + ev.error + ').', true); };
    // Fin de dictée : on garde aussi le dernier morceau encore « provisoire » (sinon les derniers mots se perdent).
    var terminer = function () {
      if (fait) return; fait = true; clearTimeout(S.recGarde);
      S.rec = null; S.dicte = false; majMic();
      var dit = (fini + ' ' + enCours).replace(/\s+/g, ' ').trim();
      var el = S.root.querySelector('#wl-msg');
      if (el) { el.value = (base + dit).replace(/^\s+/, ''); S.msgDraft = el.value; }
      if (dit && LS.get('wl-mef') !== '0') miseEnForme(base, dit); else { verrou(false); if (el) el.focus(); }
    };
    rec.onend = terminer;
    rec.terminer = terminer;
    try { rec.start(); } catch (e) { toast('Impossible de lancer la dictée.', true); return; }
    S.rec = rec; S.dicte = true; majMic();
  }
  // Après la dictée : le texte dicté repasse par Claude Haiku (ponctuation, majuscules, mots mal reconnus).
  // Pendant ce temps le champ est grisé et verrouillé ; en cas d'échec, le texte brut reste tel quel.
  function verrou(on) {
    S.miseEnForme = on;
    var el = S.root && S.root.querySelector('#wl-msg'), b = S.root && S.root.querySelector('[data-act="send-msg"]'), m = S.root && S.root.querySelector('[data-act="dicter"]');
    if (el) { el.disabled = on; el.classList.toggle('wl-mef', on); }
    if (b) b.disabled = on; if (m) m.disabled = on;
  }
  function miseEnForme(base, dit) {
    verrou(true);
    var fin = function (txt) {
      verrou(false);
      var el = S.root.querySelector('#wl-msg'); if (!el) return;
      if (txt) { el.value = (base + txt).replace(/^\s+/, ''); S.msgDraft = el.value; }
      el.focus(); el.setSelectionRange(el.value.length, el.value.length);
    };
    var garde = setTimeout(function () { fin(''); }, 12000); // jamais plus de 12 s de champ bloqué
    pushApi({ action: 'dictee', texte: dit }).then(function (r) { clearTimeout(garde); if (S.miseEnForme) fin(r && r.ok ? r.texte : ''); }, function () { clearTimeout(garde); if (S.miseEnForme) fin(''); });
  }
  // Clic sur « arrêter » : le champ se grise TOUT DE SUITE, puis le texte part à la mise en forme dès que le navigateur rend la main
  // (au plus 1,2 s d'attente : au-delà on prend ce qui est déjà écrit).
  function stopDictee() {
    S.dicte = false; var rec = S.rec;
    if (rec) { verrou(true); try { rec.stop(); } catch (e) {} S.recGarde = setTimeout(function () { try { rec.abort(); } catch (e) {} if (rec.terminer) rec.terminer(); }, 1200); }
    majMic();
  }
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
  function closePanel() { S.dosFocus = null; S.panel = null; S.reformule = null; S.root.querySelector('.panel').classList.remove('open'); S.root.querySelector('.panelbg').classList.remove('open'); }
  function head(emoji, nom, st) { return '<div class="ph2"><span class="em">' + emoji + '</span><div><div class="nm">' + esc(nom) + '</div><div class="st">' + (st || '') + '</div></div><span class="x" data-act="close-panel">✕</span></div>'; }
  function paintPanel() {
    if (!S.panel || !S.root) return;
    var el = S.root.querySelector('.panel');
    var keep = el.scrollTop, ae = document.activeElement;
    if (ae && el.contains(ae) && (ae.tagName === 'TEXTAREA' || ae.tagName === 'INPUT' || ae.isContentEditable)) return; // on ne repeint pas sous les doigts de la journaliste
    var k = S.panel, h = '';
    if (k === 'secretaire') h = panelSecretaire();
    else if (k === 'assistant') h = panelAssistant();
    else if (k === 'courrier') h = panelCourrier();
    else if (k === 'marbre' || k === 'articles') h = panelArticles();
    else if (k === 'chef') h = panelChef();
    else if (k === 'sc' || k === 'mk') h = panelJulien(k);
    else if (k === 'compta') h = panelCompta();
    else if (k === 'parametres') h = panelParams();
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
    h += '<div class="pb">' + (D().me.chef ? '' : lectureSeule('les bureaux de Julien sont pilotés par le rédacteur en chef')) + '<p class="muted">Le Courrier trie seul les mails qui arrivent (sans IA) : notifications, newsletters et réponses automatiques sont écartées. Julien ne rédige une réponse que quand vous le lui demandez, et rien ne part sans votre validation.</p>';
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
    if (!D().me.chef) {}
    else if (S.newCamp) {
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
        if (D().me.chef) h += '<div class="row" style="margin-top:10px"><button class="btn" data-act="p-chercher" data-id="' + esc(c.campagne_id) + '"' + (busy ? ' disabled' : '') + '>🔎 Chercher des prospects</button></div><p class="muted">La recherche prend une à deux minutes : Julien vérifie chaque entreprise sur le web.</p>';
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
    if (!D().me.chef) return h + (x.mail_corps ? '<label>Mail</label><div><b>' + esc(x.mail_sujet) + '</b></div><div style="white-space:pre-wrap">' + esc(x.mail_corps) + '</div>' : '') + lectureSeule('') + '</div>';
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
    if (!D().me.chef) return h + lectureSeule('') + '</div>';
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
    var deja = D().fiches.filter(function (f) { return f.article_id === S.art; });
    if (deja.length) h += '<div class="box" style="border-color:rgba(255,190,90,.45)"><b>Déjà lancé pour cet article : ' + deja.length + ' demande' + pl(deja.length) + '</b> (' + origines(deja) + ')<div style="margin:6px 0">' + avancement(deja) + '</div><div class="muted">' + esc(deja.map(function (f) { return f.contact.nom + ' (' + qui(f) + ')'; }).join(' · ')) + '</div>' +
      '<div class="row" style="margin-top:8px"><button class="btn small" data-act="dossier" data-id="' + esc(S.art) + '">🗂️ Voir le dossier</button></div><p class="muted" style="margin:8px 0 0">Vous pouvez quand même ajouter une personne ci-dessous.</p></div>';
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
    var v = by('brouillon'), actifs = vues().filter(function (f) { return f.statut !== 'inséré'; }), ds = dossiers(actifs);
    S.dosOuvert = S.dosOuvert || {};
    h += '<h3>Dossiers en cours (' + ds.length + ') · ' + v.length + ' mail' + pl(v.length) + ' à valider</h3>' + porteeHTML() +
      (ds.length > 1 ? '<div class="row" style="gap:6px;margin:-4px 0 8px"><span class="chip" data-act="dos-tout" data-id="1">▾ Tout déplier</span><span class="chip" data-act="dos-tout" data-id="0">▸ Tout replier</span></div>' : '') +
      (ds.map(function (d) {
        var k = d.id || 'sans', nb = d.fiches.filter(function (f) { return f.statut === 'brouillon'; }).length;
        var ouvert = S.dosFocus ? S.dosFocus === k : (k in S.dosOuvert ? S.dosOuvert[k] : nb > 0);
        var tri = d.fiches.slice().sort(function (a, b) { return (a.statut === 'brouillon' ? 0 : 1) - (b.statut === 'brouillon' ? 0 : 1); });
        return '<div class="dossier' + (ouvert ? ' open' : '') + (S.dosFocus === k ? ' flash' : '') + '" id="sdos-' + esc(k) + '"><div class="dh" data-act="dos-toggle" data-id="' + esc(k) + '"><b>' + (ouvert ? '▾' : '▸') + ' 📰 ' + esc(d.titre) + '</b>' + avancement(d.fiches) + '</div>' +
          (ouvert ? '<div class="dos">' + tri.map(function (f) { return dcard(f, f.statut === 'brouillon' ? '<div class="su">✉️ ' + esc(f.mail_sujet) + '</div>' : ''); }).join('') + '</div>' + (d.id && art(d.id) ? '<div class="row" style="margin-top:6px"><button class="btn small" data-act="pick-art" data-id="' + esc(d.id) + '">📰 En faire l’article en cours</button></div>' : '') : '') + '</div>';
      }).join('') || '<div class="muted">Aucun dossier en cours.</div>');
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
    if (S.doc.kind === 'pieces') { el.innerHTML = docPieces(); el.scrollTop = keep; markBusy(); return; }
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
    if (!peut(f)) return docFiche(f);
    var w = membre(f.redacteur), branchee = !!w.branchee;
    var okMail = /^[^\s@<>]+@[^\s@<>]+\.[a-z]{2,}$/i.test(f.contact.email || '');
    var ed = (S.vEdit && S.vEdit[f.fiche_id]) || { sujet: f.mail_sujet, corps: f.mail_corps };
    var og = origine(f);
    var h = '<div class="dtop"><span class="em">📮</span><div><div class="nm">Mail à valider</div><div class="st">' + og[0] + ' ' + (og[1] === 'Express' ? 'préparé en express' : og[1] === 'Assistant' ? 'questions de l’Assistant, mail de la Secrétaire' : 'rédigé par la Secrétaire') + ' · lancé par ' + esc(qui(f)) + ' · ' + esc(when(f.maj)) + '</div></div><span class="x" data-act="close-doc">✕</span></div>';
    h += '<div class="paper"><div class="kick">Relisez, corrigez si besoin, puis validez</div>' +
      '<div class="meta">À : <b>' + esc(f.contact.nom) + '</b> ' + (okMail ? '&lt;' + esc(f.contact.email) + '&gt;' : '<span class="tag a">adresse manquante</span>') + '<br>📰 ' + esc(f.article_titre || 'sans article') + ' · ' + (f.langue === 'en' ? 'en anglais' : 'en français') + '</div>';
    if (!okMail) h += '<div class="warn">Il manque l’adresse e-mail du contact.<label>Adresse e-mail</label><input class="pin" id="wl-v-email" type="email" inputmode="email" placeholder="prenom.nom@universite.edu"><div class="acts"><button data-act="v-email" data-id="' + esc(f.fiche_id) + '">Enregistrer l’adresse</button></div></div>';
    h += '<label>Objet</label><input class="pin sub" id="wl-v-sujet" value="' + esc(ed.sujet) + '">' +
      '<label>Message</label><textarea class="pin big" id="wl-v-corps">' + esc(ed.corps) + '</textarea>' + sigApercu(f) +
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
    var rw = peut(f);
    h += '<div class="paper"><div class="kick">Fiche contact ' + tagStatut(f) + ' · ' + origine(f).join(' ') + ' · lancée par ' + esc(qui(f)) + '</div><h1>' + esc(f.contact.nom) + '</h1>' + parcoursHTML(f) + (rw ? '' : lectureSeule('fiche de ' + membre(f.redacteur).nom)) +
      '<div class="meta">' + esc([f.contact.role, f.contact.institution].filter(Boolean).join(', ')) + (f.contact.email ? '<br>✉️ ' + esc(f.contact.email) : '') + '<br>📰 ' + esc(f.article_titre || 'sans article') + '</div>';
    if (f.statut === 'brouillon' && rw) h += '<div class="acts"><button class="go" data-act="open-valid" data-id="' + esc(f.fiche_id) + '">📮 Relire le mail à valider</button></div>';
    // la réponse et son insertion dans l'article
    if (f.reponse) {
      h += '<h2>Sa réponse' + (f.reponse_le ? ' · ' + esc(when(f.reponse_le)) : '') + '</h2><div class="txt">' + esc(f.reponse) + '</div>' + piecesHTML(f.pieces);
      if (f.statut === 'inséré') h += '<div class="lead">✅ Cité dans l’article :<br>' + nl(f.citation) + '</div>';
      if (f.article_id && rw) h += citationBlock(f);
      else h += '<p class="lead">Cette fiche n’est liée à aucun article : rattachez-la depuis l’Assistant pour pouvoir insérer la réponse.</p>';
    } else if (f.statut === 'envoyé' && rw) {
      h += '<h2>Réponse</h2><p class="lead">Pas encore de réponse (mail envoyé ' + esc(when(f.envoye_le)) + '). Le Courrier la rangera ici dès qu’elle arrive.</p>' +
        '<div class="acts">' + (relancable(f) ? '<button data-act="relance" data-id="' + esc(f.fiche_id) + '"' + (S.busy.secretaire ? ' disabled' : '') + '>🔁 Faire préparer une relance</button>' : '') +
        '<button data-act="colle" data-id="' + esc(f.fiche_id) + '">📝 Réponse reçue ailleurs (téléphone, autre adresse)</button></div>';
    }
    if (S.colle) h += '<label>Collez ou résumez la réponse</label><textarea class="pin" id="wl-colle"></textarea><div class="acts"><button class="go" data-act="colle-go" data-id="' + esc(f.fiche_id) + '">Enregistrer la réponse</button></div>';
    var qe = questionsEnvoyees(f), qo = f.questions || [];
    var traduites = qe.length && qo.length && qe.join('|') !== qo.join('|');
    if (qe.length || qo.length) h += '<h2>Questions ' + (f.statut === 'brouillon' ? 'prévues' : 'posées') + (traduites ? ' <span class="tag">' + (f.langue === 'en' ? 'en anglais, telles qu’envoyées' : 'telles qu’envoyées') + '</span>' : '') + '</h2><ol>' + (qe.length ? qe : qo).map(function (q) { return '<li>' + esc(q) + '</li>'; }).join('') + '</ol>' +
      (traduites ? '<details><summary>Version choisie dans le lab</summary><ol>' + qo.map(function (q) { return '<li>' + esc(q) + '</li>'; }).join('') + '</ol></details>' : '');
    if (f.mail_corps && f.statut !== 'brouillon') h += '<details><summary>Le mail envoyé · ' + esc(f.mail_sujet) + '</summary><div class="txt" style="font-size:15px">' + esc(f.mail_corps) + '</div></details>';
    h += '<h2>Historique</h2><ul class="tl">' + (f.historique || []).slice().reverse().map(function (e) { return '<li>' + esc(day(e.t) + ' ' + hm(e.t)) + ' — ' + esc(e.e) + (e.par && e.par !== 'courrier' ? ' (' + esc(membre(e.par).nom) + ')' : '') + '</li>'; }).join('') + '</ul>';
    if (rw) h += '<div class="acts"><button class="red" data-act="archive" data-id="' + esc(f.fiche_id) + '">🗄️ Archiver la fiche</button></div>';
    h += '</div>';
    return h;
  }
  // Citations (21/10/2026) : l'Assistant (Opus) propose 1 à 5 extraits, chacun à sa place dans l'article (après un paragraphe simple,
  // jamais dans une carte, un encart HTML, une vidéo ou le paywall). Chaque proposition se montre en contexte : paragraphe d'avant (pâle),
  // le bloc tel qu'il apparaîtra, paragraphe d'après (pâle). On insère une à une, ou tout d'un coup.
  function sigApercu(f) {
    var sg = S.sigs && S.sigs[f.redacteur]; if (!sg) return '';
    var lg = f.langue === 'en' ? 'en' : 'fr';
    return '<div class="sigprev"><div class="kd">Signature ajoutée à l’envoi · ' + (lg === 'en' ? 'English' : 'français') + '</div>' + (sg[lg] || '') + '</div>';
  }
  function citationBlock(f) {
    var c = S.cit && S.cit.fid === f.fiche_id ? S.cit : null, busy = !!S.busy.assistant;
    var h = '<h2>Dans l’article</h2>';
    if (!c || !c.ins) return h + '<p class="lead">L’Assistant lit l’article, choisit les passages les plus forts de la réponse, corrige l’orthographe et la ponctuation sans toucher aux propos (et traduit si besoin), puis propose l’endroit idéal pour chacun.</p>' +
      '<div class="acts"><button class="go" data-act="cit" data-id="' + esc(f.fiche_id) + '"' + (busy ? ' disabled' : '') + '>✨ Proposer les emplacements dans l’article</button></div>' + chapoBlock(f);
    var reste = c.ins.filter(function (x, k) { return !c.fait[k] && !c.skip[k]; }).length;
    h += '<p class="lead">' + c.ins.length + ' extrait' + pl(c.ins.length) + ' proposé' + pl(c.ins.length) + ', chacun à sa place. Dépliez pour voir le passage tel qu’il apparaîtra, ajustez si besoin, puis insérez.</p>';
    var cut = function (t, n, fin) { t = String(t || ''); return t.length <= n ? t : fin ? '… ' + t.slice(-n) : t.slice(0, n) + ' …'; };
    h += c.ins.map(function (x, k) {
      var ouvert = !!c.open[k], fait = !!c.fait[k], skip = !!c.skip[k];
      var hd = '<div class="cit-h" data-act="cit-tog" data-i="' + k + '"><span class="cit-n">' + (k + 1) + '</span><span class="cit-t">' + esc(cut(x.citation.replace(/^«\s*|\s*»$/g, ''), 70)) + '<small>après « ' + esc(cut(x.avant, 60)) + ' »</small></span>' +
        (fait ? '<span class="tag g">✅ insérée</span>' : skip ? '<span class="tag">écartée</span>' : '') + '<span class="cit-c">' + (ouvert ? '▾' : '▸') + '</span></div>';
      if (!ouvert) return '<div class="cit' + (fait ? ' done' : '') + (skip ? ' skip' : '') + '">' + hd + '</div>';
      var corps = '<div class="ctx">' + esc(cut(x.avant, 260, true)) + '</div>' +
        '<div class="neo">' + (x.intro ? '<p>' + esc(x.intro) + '</p>' : '') + '<blockquote>' + esc(x.citation) + (x.attribution ? '<br><em>— ' + esc(x.attribution.replace(/^[—–-]\s*/, '')) + '</em>' : '') + '</blockquote></div>' +
        (x.ensuite ? '<div class="ctx">' + (x.ensuite_type && x.ensuite_type !== 'paragraphe' ? '<span class="kd">' + esc(x.ensuite_type) + '</span> ' : '') + esc(cut(x.ensuite, 220)) + '</div>' : '<div class="ctx">— fin de l’article —</div>') +
        '<div class="cit-meta">' + (x.note ? '✍️ ' + esc(x.note) : '✍️ texte repris tel quel') + (x.pourquoi ? '<br>📍 ' + esc(x.pourquoi) : '') + '</div>';
      if (!fait) corps += '<details class="cit-ed"><summary>Modifier le texte</summary><label>Phrase d’introduction (facultative)</label><textarea class="pin" style="min-height:60px" data-cp="' + k + ':intro">' + esc(x.intro || '') + '</textarea>' +
        '<label>Citation</label><textarea class="pin" style="min-height:90px" data-cp="' + k + ':citation">' + esc(x.citation || '') + '</textarea>' +
        '<label>Attribution</label><input class="pin" data-cp="' + k + ':attribution" value="' + esc(x.attribution || '') + '"><div class="acts"><button data-act="cit-maj" data-i="' + k + '">Voir le résultat</button></div></details>' +
        '<div class="acts"><button class="go" data-act="cit-one" data-id="' + esc(f.fiche_id) + '" data-i="' + k + '"' + (S.busy.marbre ? ' disabled' : '') + '>✅ Insérer celle-ci</button><button data-act="cit-skip" data-i="' + k + '">' + (skip ? '↺ Reprendre' : 'Écarter') + '</button></div>';
      return '<div class="cit open' + (fait ? ' done' : '') + (skip ? ' skip' : '') + '">' + hd + '<div class="cit-b">' + corps + '</div></div>';
    }).join('');
    h += '<div class="acts">' + (reste ? '<button class="go" data-act="cit-all" data-id="' + esc(f.fiche_id) + '"' + (S.busy.marbre ? ' disabled' : '') + '>✅ Tout insérer (' + reste + ')</button>' : '') +
      '<button data-act="cit" data-id="' + esc(f.fiche_id) + '"' + (busy ? ' disabled' : '') + '>↻ Autres propositions</button></div>';
    if (c.done) h += '<p class="lead">✅ Inséré. <a href="' + esc(c.done) + '" target="_blank" rel="noopener">Ouvrir l’article dans Ghost</a></p>';
    return h + chapoBlock(f);
  }
  // Une fois au moins une citation insérée : proposer d'évoquer les experts interviewés dès le début de l'article (partie gratuite),
  // pour montrer le sérieux de l'enquête et donner envie de lire (et de s'abonner). On ajoute une phrase, on ne réécrit rien.
  function expertsCites(aid) {
    return D().fiches.filter(function (x) { return x.article_id === aid && x.statut === 'inséré'; }).map(function (x) { return { nom: x.contact.nom, role: x.contact.role, institution: x.contact.institution }; });
  }
  function chapoBlock(f) {
    var ex = expertsCites(f.article_id), ch = S.chapo && S.chapo.aid === f.article_id ? S.chapo : null;
    if (!ex.length) return '';
    var h = '<div class="chapo"><div class="ch-t">💡 Mettre en avant les interviews dès le début</div><div class="ch-s">' + esc(ex.map(function (x) { return x.nom; }).join(', ')) + ' ' + (ex.length > 1 ? 'sont cités' : 'est cité') + ' dans l’article. Le dire dans les premiers paragraphes (partie gratuite) montre le sérieux de l’enquête et donne envie de lire la suite.</div>';
    if (!ch || !ch.props) return h + '<div class="acts"><button class="go" data-act="chapo" data-id="' + esc(f.fiche_id) + '"' + (S.busy.assistant ? ' disabled' : '') + '>✨ Proposer une mention</button></div></div>';
    h += ch.props.map(function (x, k) {
      var fait = ch.fait[k];
      var bloc = x.mode === 'apres' ? '<div class="ctx">' + esc(x.avant) + '</div><div class="neo"><p>' + esc(x.texte) + '</p></div>' : '<div class="neo"><p>' + esc(x.avant) + ' <mark>' + esc(x.texte) + '</mark></p></div>';
      return '<div class="cit open' + (fait ? ' done' : '') + '"><div class="cit-b" style="padding-top:12px">' + bloc + (x.ensuite ? '<div class="ctx">' + esc(String(x.ensuite).slice(0, 200)) + ' …</div>' : '') +
        '<div class="cit-meta">' + (x.mode === 'apres' ? '➕ nouveau court paragraphe' : '➕ phrase ajoutée à la fin du paragraphe') + (x.pourquoi ? ' · ' + esc(x.pourquoi) : '') + '</div>' +
        '<details class="cit-ed"><summary>Modifier la phrase</summary><textarea class="pin" style="min-height:70px" data-ch="' + k + '">' + esc(x.texte) + '</textarea><div class="acts"><button data-act="cit-maj">Voir le résultat</button></div></details>' +
        '<div class="acts">' + (fait ? '<span class="tag g">✅ ajoutée à l’article</span>' : '<button class="go" data-act="chapo-ok" data-id="' + esc(f.fiche_id) + '" data-i="' + k + '"' + (S.busy.marbre ? ' disabled' : '') + '>✅ Ajouter à l’article</button>') + '</div></div></div>';
    }).join('');
    return h + '<div class="acts"><button data-act="chapo" data-id="' + esc(f.fiche_id) + '"' + (S.busy.assistant ? ' disabled' : '') + '>↻ Autre proposition</button></div></div>';
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
  // ---------- Pièces (récompenses des rédactrices, calculées côté Supabase sur preuves) ----------
  function chargerPieces() {
    if (typeof pushApi !== 'function') return;
    pushApi({ action: 'pieces' }).then(function (r) {
      if (!r || !r.ok) return;
      var avant = S.pieces, me = D().me.id;
      S.pieces = r;
      var vus = (LS.get('wl-pieces-vues') || '').split(',');
      var neuves = (r.pieces || []).filter(function (p) { return p.membre === me && p.statut === 'acquis' && vus.indexOf(String(p.id)) < 0; });
      if (avant && neuves.length) neuves.forEach(function (p) { fete(p); });
      var anc = {}; ((avant && avant.pieces) || []).forEach(function (p) { anc[p.id] = 1; });
      var nv = avant ? (r.pieces || []).filter(function (p) { return !anc[p.id] && p.statut === 'acquis'; }) : [];
      if (nv.length) { S.caisseAnim = {}; nv.forEach(function (p) { S.caisseAnim[p.membre] = 1; }); setTimeout(function () { S.caisseAnim = null; paintFloor(); }, 2600); }
      paintFloor(); if (S.panel === 'compta') paintPanel();
      LS.set('wl-pieces-vues', (r.pieces || []).filter(function (p) { return p.membre === me; }).map(function (p) { return p.id; }).join(','));
      var tp = S.root && S.root.querySelector('.top'); if (tp) tp.innerHTML = header();
      if (S.doc && (S.doc.kind === 'pieces' || S.doc.kind === 'fiche')) paintDoc();
    }).catch(function () {});
  }
  function totalPieces(id) { return ((S.pieces && S.pieces.totaux) || {})[id] || 0; }
  function pieceDe(fid) { return ((S.pieces && S.pieces.pieces) || []).filter(function (p) { return p.fiche_id === fid; })[0] || null; }
  function verifiee(fid) { return ((S.pieces && S.pieces.verifiees) || []).indexOf(fid) >= 0; }
  function fete(p) {
    var el = document.createElement('div'); el.className = 'fete';
    el.innerHTML = '<div class="fete-c">🪙</div><div class="fete-t">+' + p.montant + ' pièces</div><div class="fete-s">Parcours complet avec ' + esc(p.contact || 'votre contact') + '</div>';
    S.root.appendChild(el); setTimeout(function () { el.classList.add('out'); }, 2600); setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 3200);
  }
  var PST2 = { acquis: ['🪙', 'acquises', 'g'], a_verifier: ['🔍', 'à vérifier par le rédacteur en chef', 'a'], annule: ['✖️', 'annulées', ''], manque: ['⏳', 'créneau manqué', ''] };
  // ---------- Paramètres (21/10/2026) : notifications, signature des mails FR/EN (gras, italique, liens), dictée, mode récompense (chef) ----------
  var WEBMAILS = [['Gmail', ['gmail.com', 'googlemail.com']], ['Outlook / Hotmail / Live', ['outlook.com', 'hotmail.com', 'hotmail.fr', 'live.com', 'live.fr', 'msn.com']], ['Yahoo', ['yahoo.com', 'yahoo.fr']], ['iCloud', ['icloud.com', 'me.com']],
    ['Proton', ['proton.me', 'protonmail.com']], ['GMX / Web.de', ['gmx.com', 'gmx.fr', 'gmx.ch', 'gmx.de', 'web.de']], ['Fournisseurs français (Orange, Free, SFR, La Poste, Wanadoo)', ['orange.fr', 'free.fr', 'sfr.fr', 'laposte.net', 'wanadoo.fr']],
    ['Bluewin (Suisse)', ['bluewin.ch']], ['Autres (AOL, Mail.com, Yandex, Tutanota, Zoho)', ['aol.com', 'mail.com', 'yandex.com', 'tutanota.com', 'zoho.com']]];
  function majTop() { var tp = S.root && S.root.querySelector('.top'); if (tp) tp.innerHTML = header(); }
  function chargerParams() {
    return pushApi({ action: 'parametres' }).then(function (r) {
      if (!r || !r.ok) return;
      S.params = r; S.sigDraft = S.sigDraft || { fr: r.signature.fr, en: r.signature.en };
      return pushApi({ action: 'signatures' }).then(function (x) { if (x && x.ok) S.sigs = x.signatures; if (S.panel === 'parametres') paintPanel(); if (S.doc) paintDoc(); });
    }).catch(function () {});
  }
  function sw(act, on, off) { return '<button type="button" class="sw' + (on ? ' on' : '') + '" data-act="' + act + '"' + (off ? ' disabled' : '') + ' aria-pressed="' + (on ? 'true' : 'false') + '"><i></i></button>'; }
  function sigLire() { var e = S.root.querySelector('#wl-sig'); if (e && S.sigDraft) S.sigDraft[S.sigLang || 'fr'] = e.innerHTML; }
  function panelParams() {
    var me = D().me, P = S.params, lg = S.sigLang || 'fr';
    var h = head('⚙️', 'Paramètres', esc(me.nom) + ' · ' + esc(me.titre || '')) + '<div class="pb">';
    if (!P) { chargerParams(); return h + '<p class="muted">Chargement…</p></div>'; }
    var push = !!S.pushOk, perm = (typeof Notification !== 'undefined') ? Notification.permission : 'default';
    h += '<div class="set"><div class="set-h"><div><b>🔔 Notifications sur ce navigateur</b><div class="set-s">' + (push ? 'Actives : messages de l’Interphone, réponses des chercheurs, pièces.' : perm === 'denied' ? 'Bloquées par le navigateur : autorisez les notifications pour posthumain.com dans les réglages du site, puis réactivez ici.' : 'Désactivées.') + '</div></div>' + sw('set-push', push) + '</div>' +
      (push ? '<button class="btn small" data-act="push">Envoyer une notification de test</button>' : '') + '</div>';
    var d = S.sigDraft || { fr: '', en: '' };
    h += '<div class="set"><div class="set-h"><div><b>✍️ Signature des mails</b><div class="set-s">Ajoutée automatiquement en bas de chaque mail, dans la langue du mail.</div></div></div>' +
      '<div class="seg"><button class="' + (lg === 'fr' ? 'on' : '') + '" data-act="sig-lang" data-id="fr">Français</button><button class="' + (lg === 'en' ? 'on' : '') + '" data-act="sig-lang" data-id="en">English</button></div>' +
      '<div class="tb"><button data-act="sig-cmd" data-id="bold" title="Gras"><b>B</b></button><button data-act="sig-cmd" data-id="italic" title="Italique"><i>I</i></button><button data-act="sig-cmd" data-id="underline" title="Souligné"><u>U</u></button><button data-act="sig-cmd" data-id="link" title="Lien">🔗</button><button data-act="sig-cmd" data-id="removeFormat" title="Effacer la mise en forme">⌫</button></div>' +
      '<div class="sig-ed" id="wl-sig" contenteditable="true" spellcheck="true">' + (d[lg] || '') + '</div>' +
      '<div class="row" style="gap:8px;margin-top:10px;flex-wrap:wrap"><button class="btn go" data-act="sig-save">Enregistrer les deux signatures</button><button class="btn small" data-act="sig-reset">Rétablir la signature par défaut</button></div></div>';
    var dl = LS.get('wl-dictee-lang') || 'fr-FR', mef = LS.get('wl-mef') !== '0';
    h += '<div class="set"><div class="set-h"><div><b>🎙️ Dictée</b><div class="set-s">Langue reconnue par le micro de l’Interphone.</div></div>' +
      '<select class="in" id="wl-dl" style="width:auto"><option value="fr-FR"' + (dl === 'fr-FR' ? ' selected' : '') + '>Français</option><option value="en-US"' + (dl === 'en-US' ? ' selected' : '') + '>English</option></select></div>' +
      '<div class="set-h" style="margin-top:12px"><div><b>Mise en forme automatique</b><div class="set-s">Ponctuation et majuscules corrigées après la dictée (le champ se grise une à deux secondes).</div></div>' + sw('set-mef', mef) + '</div></div>';
    if (me.chef) {
      var FR = S.factures || {};
      h += '<div class="set"><b>🧾 Tarifs des factures</b><div class="set-s" style="margin:4px 0 10px">Appliqués à la prochaine facture générée (les factures déjà émises gardent leur tarif, sauf ajustement).</div>' +
        '<div class="row" style="gap:10px;flex-wrap:wrap;align-items:center">Enquête premium <input class="in" id="wl-tp" value="' + String(FR.tarif_premium != null ? FR.tarif_premium : '').replace('.', ',') + '" inputmode="decimal" style="width:80px"> € · Article standard <input class="in" id="wl-ts" value="' + String(FR.tarif_standard != null ? FR.tarif_standard : '').replace('.', ',') + '" inputmode="decimal" style="width:80px"> € <button class="btn small" data-act="fa-tarifs">Enregistrer</button></div></div>';
      if (!S.factures) chargerFactures();
    }
    if (me.chef) {
      var wm = P.webmails || [];
      h += '<div class="set"><b>🛡️ Contrôle des pièces</b><div class="set-s" style="margin:4px 0 10px">Réponses venant de ces messageries gratuites : pièces mises « à vérifier » (vous validez). Tout est décoché par défaut, car beaucoup de gens sérieux ont une adresse Gmail ou Outlook.</div>' +
        WEBMAILS.map(function (g, k) { var on = g[1].every(function (d) { return wm.indexOf(d) >= 0; }); return '<label class="chk"><input type="checkbox" data-wm="' + k + '"' + (on ? ' checked' : '') + '> ' + esc(g[0]) + ' <span class="set-s">' + esc(g[1].join(', ')) + '</span></label>'; }).join('') + '</div>';
    }
    if (me.chef) h += '<div class="set' + (P.recompense ? ' hot' : '') + '"><div class="set-h"><div><b>🧪 Mode récompense (test)</b><div class="set-s">Vous gagnez des pièces comme une rédactrice (votre caisse apparaît chez le Comptable) : comptabiliser, demander le paiement, cocher la facture, tout fonctionne pour vous-même et les notifications vous arrivent.</div></div>' + sw('set-rec', !!P.recompense) + '</div></div>';
    var adr = ({ jonathan: 'jonathan.paiano@posthumain.com', valisoa: 'valisoa.rasolofo@posthumain.com' })[me.id] || '';
    h += '<div class="set"><b>👤 Compte</b><div class="set-s" style="margin-top:6px">' + esc(me.nom) + ' · ' + esc(me.titre || '') + (adr ? '<br>Mails envoyés depuis <b>' + esc(adr) + '</b>' : '') + '</div></div>';
    return h + '</div>';
  }
  function panelCompta() {
    var r = S.pieces || { pieces: [], totaux: {}, soldes: {}, conversions: [] }, me = D().me, tx = Number(r.taux || 0), o = stOf(P('compta'));
    var h = head('🧮', 'Le Comptable', '<span class="led ' + o.s + '"></span>' + esc(o.why)) + '<div class="pb">';
    if (!S.pieces) return h + '<p class="muted">Le Comptable ouvre ses registres…</p></div>';
    h += '<p class="muted">Chaque parcours complet (interview envoyée depuis le lab, réponse du chercheur, citation insérée dans l’article) rapporte des pièces, rangées dans la caisse de la journaliste.</p>';
    h += facturesHTML();
    gagnants().forEach(function (w) {
      var so = (r.soldes || {})[w.id] || 0, mien = w.id === me.id, demande = (r.demandes || {})[w.id] === r.mois;
      var peutDemander = mien && so > 0 && Number(r.jour) >= 25 && !demande;
      h += '<div class="caisse"><div class="cz-h"><span>Caisse de <b>' + esc(w.nom) + '</b></span>' + (demande && so ? '<span class="tag a">💶 paiement demandé</span>' : '') + '</div>' +
        '<div class="cz-n">🪙 ' + so + '<small>' + (so ? '≈ ' + eurTxt(so * tx) : 'vide') + '</small></div><div class="cz-s">' + totalPieces(w.id) + ' pièces gagnées depuis le début · ' + eurTxt(tx) + ' la pièce</div>' +
        '<div class="row" style="gap:8px;margin-top:10px;flex-wrap:wrap">' +
        (me.chef ? '<button class="btn go" data-act="pc-conv" data-id="' + esc(w.id) + '"' + (so ? '' : ' disabled data-off="1"') + '>📒 Comptabiliser' + (so ? ' ' + eurTxt(so * tx) : '') + '</button><button class="btn small" data-act="pc-raz" data-id="' + esc(w.id) + '"' + (so ? '' : ' disabled data-off="1"') + '>↺ Remettre à zéro</button>' : '') +
        (mien ? '<button class="btn go" data-act="pc-dem"' + (peutDemander ? '' : ' disabled data-off="1"') + '>💶 Demander le paiement</button>' : '') + '</div>' +
        (mien && !peutDemander ? '<div class="cz-s" style="margin-top:6px">' + (!so ? 'Ta caisse est vide pour l’instant.' : demande ? 'Demande envoyée ce mois-ci : Jonathan va comptabiliser.' : 'La demande de paiement s’ouvre le 25 de chaque mois.') + '</div>' : '') + '</div>';
    });
    var af = (r.conversions || []).filter(function (c) { return c.statut === 'a_facturer' && (me.chef || c.membre === me.id); });
    h += '<div class="cz-t">💶 À ajouter à la prochaine facture (' + af.length + ')</div>' + (af.map(function (c) {
      return '<div class="cz-l"><div><b>' + eurTxt(Number(c.montant)) + '</b> · ' + c.pieces + ' pièces · ' + esc(membre(c.membre).nom) + '<div class="cz-s">comptabilisé ' + esc(when(c.created_at)) + (c.note ? ' · ' + esc(c.note) : '') + '</div></div>' +
        '<div class="row" style="gap:6px;margin-top:8px"><input class="in" id="wl-fact-' + c.id + '" placeholder="n° ou date de facture (facultatif)" style="flex:1;min-width:150px"><button class="btn small go" data-act="pc-fact" data-id="' + c.id + '">☑️ Ajouté à la facture</button></div></div>';
    }).join('') || '<p class="muted">Rien à facturer.</p>') + (af.length ? '<p class="cz-s">Une fois cochée, la ligne est archivée et les pièces sont comptées définitivement.</p>' : '');
    var der = (r.pieces || []).filter(function (p) { return me.chef || p.membre === me.id; }).slice(0, 12);
    if (der.length) h += '<div class="cz-t">🪙 Dernières pièces</div>' + der.map(function (p) {
      var st = PST2[p.statut] || ['·', p.statut, ''];
      return '<div class="cz-l"><div><b>' + (p.montant ? '+' + p.montant : '0') + '</b> <span class="tag ' + st[2] + '">' + st[0] + ' ' + esc(st[1]) + '</span>' + (me.chef ? ' · ' + esc(membre(p.membre).nom) : '') + '<div class="cz-s">' + esc(p.contact || '') + ' — ' + esc(p.article_titre || '') + ' · ' + esc(when(p.created_at)) + (me.chef ? '<br>' + esc(p.motif || '') : '') + '</div></div>' +
        (me.chef && p.statut === 'a_verifier' ? '<div class="row" style="gap:6px;margin-top:6px"><button class="btn small go" data-act="pc-ok" data-id="' + p.id + '">✅ Valider</button><button class="btn small red" data-act="pc-annule" data-id="' + p.id + '">✖️ Annuler</button></div>' : '') + '</div>';
    }).join('');
    h += '<details class="cz-d"><summary>Barème</summary><p>Citation insérée avant la publication ou jusqu’à 2 jours après : <b>10 pièces</b><br>jusqu’à 4 jours : <b>5 pièces</b><br>jusqu’au 6e jour : <b>2 pièces</b><br>à partir du 7e jour : 0, ce sera pour la prochaine fois.</p></details>';
    if (me.chef && testRec()) h += '<div class="cz-l" style="border-color:rgba(255,176,32,.5)">🧪 <b>Mode récompense (test) actif</b> : vous gagnez aussi des pièces, avec votre propre caisse. Désactivable dans ⚙️ Paramètres.</div>';
    if (me.chef) h += '<details class="cz-d"><summary>Réglages et contrôles (visible par vous seul)</summary><p>Une pièce n’est accordée que si le mail est parti du lab, que la réponse arrive dans le fil de ce mail depuis l’adresse du chercheur (en-têtes vérifiés côté serveur), et que la citation est insérée depuis le lab. Une seule récompense par fiche ; webmail gratuit, adresse de l’équipe ou réponse très courte → « à vérifier ».</p>' +
      '<div class="row" style="gap:8px;align-items:center">Valeur d’une pièce : <input class="in" id="wl-taux" value="' + String(tx).replace('.', ',') + '" style="width:90px" inputmode="decimal"> € <button class="btn small" data-act="pc-taux">Enregistrer</button></div></details>';
    var arch = (r.conversions || []).filter(function (c) { return c.statut !== 'a_facturer' && (me.chef || c.membre === me.id); });
    if (arch.length) h += '<details class="cz-d"><summary>Archives (' + arch.length + ')</summary>' + arch.map(function (c) {
      return '<div class="cz-l"><b>' + (c.type === 'conversion' ? eurTxt(Number(c.montant)) : '↺ remis à zéro') + '</b> · ' + c.pieces + ' pièces · ' + esc(membre(c.membre).nom) + '<div class="cz-s">' + (c.statut === 'facture' ? '✅ ajouté à la facture ' + esc(when(c.facture_le)) + (c.facture_note ? ' · ' + esc(c.facture_note) : '') : 'remis à zéro ' + esc(when(c.created_at))) + '</div></div>';
    }).join('') + '</details>';
    return h + '</div>';
  }
  function docPieces() {
    var r = S.pieces || { pieces: [], totaux: {} }, me = D().me;
    var h = '<div class="dtop"><span class="em">🪙</span><div><div class="nm">Les pièces de la rédaction</div><div class="st">1 parcours complet et prouvé = des pièces</div></div><span class="x" data-act="close-doc">✕</span></div><div class="paper">';
    var tx = Number(r.taux || 0), e2 = function (n) { return (Math.round(n * 100) / 100).toFixed(2).replace('.', ',') + ' €'; };
    h += '<div class="kick">Les rédactrices</div><div class="lb">' + gagnants().map(function (w) {
      var so = ((r.soldes || {})[w.id]) || 0;
      return '<div style="flex-wrap:wrap;gap:8px"><span><b>' + esc(w.nom) + '</b><br><span class="muted" style="font-size:13px">' + totalPieces(w.id) + ' pièces gagnées au total</span></span><span style="text-align:right"><b>🪙 ' + so + '</b> à convertir<br><span class="muted" style="font-size:13px">soit ' + e2(so * tx) + '</span></span>' +
        (me.chef && so ? '<span class="acts" style="width:100%;margin:6px 0 0"><button class="go" data-act="pc-conv" data-id="' + esc(w.id) + '">💶 Convertir en ' + e2(so * tx) + ' (prochaine facture)</button><button data-act="pc-raz" data-id="' + esc(w.id) + '">↺ Remettre à zéro</button></span>' : '') + '</div>';
    }).join('') + '</div>';
    if (me.chef) h += '<div class="row" style="gap:8px;align-items:center;margin:-4px 0 14px;font-size:14px">Valeur d’une pièce : <input class="pin" id="wl-taux" value="' + String(tx).replace('.', ',') + '" style="width:90px;margin:0" inputmode="decimal"> € <button class="btn small" data-act="pc-taux">Enregistrer</button></div>';
    var cs = r.conversions || [];
    if (cs.length) {
      var conf = cs.filter(function (c) { return c.statut === 'facture'; }).reduce(function (a, c) { return a + Number(c.montant); }, 0), att = cs.filter(function (c) { return c.statut === 'a_facturer'; }).reduce(function (a, c) { return a + Number(c.montant); }, 0);
      h += '<h2>Comptabilité</h2><p class="muted" style="font-size:14px">' + e2(att) + ' à ajouter à une facture · ' + e2(conf) + ' déjà ajoutés aux factures</p>' + cs.map(function (c) {
        var mine = c.membre === me.id;
        var st = c.statut === 'a_facturer' ? '<span class="tag a">💶 à ajouter à la prochaine facture</span>' : c.statut === 'facture' ? '<span class="tag g">✅ ajouté à la facture ' + esc(when(c.facture_le)) + (c.facture_note ? ' · ' + esc(c.facture_note) : '') + '</span>' : '<span class="tag">↺ remis à zéro</span>';
        return '<div class="pc"><div><b>' + (c.type === 'conversion' ? e2(Number(c.montant)) : '—') + '</b> · ' + c.pieces + ' pièces' + (c.type === 'conversion' ? ' à ' + e2(Number(c.taux)) : '') + ' · ' + esc(membre(c.membre).nom) + ' · ' + esc(when(c.created_at)) + '</div><div style="margin-top:4px">' + st + '</div>' + (c.note ? '<div class="muted" style="font-size:13px">Note : ' + esc(c.note) + '</div>' : '') +
          (c.statut === 'a_facturer' && (mine || me.chef) ? '<div class="row" style="gap:6px;margin-top:8px;align-items:center"><input class="pin" id="wl-fact-' + c.id + '" placeholder="n° ou date de la facture (facultatif)" style="flex:1;min-width:160px;margin:0"><button class="btn small go" data-act="pc-fact" data-id="' + c.id + '">✅ ' + (mine ? 'Je l’ai ajouté à ma facture' : 'Marquer comme facturé') + '</button></div>' : '') + '</div>';
      }).join('');
    }
    h += '<details' + ((r.pieces || []).length ? '' : ' open') + '><summary>Comment on gagne des pièces</summary><ol style="font-size:15px">' +
      '<li>La demande d’interview part <b>depuis le lab</b> (pas d’un autre logiciel).</li>' +
      '<li>Le chercheur <b>répond à ce mail</b> : le Courrier le reconnaît grâce aux en-têtes techniques du fil, impossibles à imiter. Une réponse collée à la main ne compte pas.</li>' +
      '<li>Sa citation est <b>insérée dans l’article depuis le lab</b>, et Ghost l’accepte.</li></ol>' +
      '<p style="font-size:15px"><b>Barème :</b> avant publication ou jusqu’à 2 jours après → <b>10 pièces</b> · jusqu’à 4 jours → <b>5</b> · jusqu’au 6e jour → <b>2</b> · à partir du 7e jour → 0 (la semaine est passée, ce sera pour la prochaine).</p>' +
      '<p class="muted" style="font-size:13.5px">Contrôles : une seule récompense par fiche ; une adresse de messagerie gratuite (gmail…), une adresse de l’équipe ou une réponse très courte passent en « à vérifier » par le rédacteur en chef.</p></details>';
    h += '<h2>Historique</h2>' + ((r.pieces || []).map(function (p) {
      var st = PST2[p.statut] || ['·', p.statut, ''];
      return '<div class="pc"><div><b>' + (p.montant ? '+' + p.montant : '0') + '</b> <span class="tag ' + st[2] + '">' + st[0] + ' ' + esc(st[1]) + '</span> · ' + esc(membre(p.membre).nom) + '</div>' +
        '<div class="muted" style="font-size:13.5px">' + esc(p.contact || '') + ' — ' + esc(p.article_titre || '') + '<br>' + esc(p.motif || '') + ' · ' + esc(when(p.created_at)) + '</div>' +
        (me.chef && (p.statut === 'a_verifier' || p.statut === 'acquis') ? '<div class="acts" style="margin-top:6px">' + (p.statut === 'a_verifier' ? '<button class="go" data-act="pc-ok" data-id="' + p.id + '">✅ Valider</button>' : '') + '<button class="red" data-act="pc-annule" data-id="' + p.id + '">✖️ Annuler</button></div>' : '') + '</div>';
    }).join('') || '<p class="muted">Pas encore de pièces : le premier parcours complet arrive bientôt.</p>');
    return h + '</div>';
  }
  function parcoursHTML(f) {
    var w = membre(f.redacteur), chefFiche = w.role === 'chef' && !testRec(), p = pieceDe(f.fiche_id), v = verifiee(f.fiche_id);
    var et = function (on, txt) { return '<span class="pa' + (on ? ' on' : '') + '">' + txt + '</span>'; };
    return '<div class="parc">' + et(!!f.envoye_le, '✉️ envoyée') + '<i></i>' + et(!!f.reponse, f.reponse ? (v || !D().me.chef ? '📬 réponse reçue' : '📝 réponse saisie à la main') : '📬 réponse') + '<i></i>' + et(f.statut === 'inséré', '✅ citée') +
      (chefFiche ? '' : '<i></i>' + et(p && p.statut === 'acquis', p ? (PST2[p.statut] || ['🪙'])[0] + ' ' + (p.montant || 0) + ' pièces' : '🪙 pièces')) + '</div>' +
      (D().me.chef && !chefFiche && f.reponse && !v ? '<p class="muted" style="margin:4px 0 0;font-size:13px">Cette réponse n’a pas été reçue par le fil du mail envoyé depuis le lab : elle ne rapporte pas de pièces.</p>' : '');
  }

  // Fenêtre de confirmation au style du lab (remplace window.confirm) : titre = première ligne, détail = la suite.
  // Rouge si l'action supprime / archive / abandonne. Entrée = confirmer, Échap ou clic à côté = annuler.
  function confirmer(msg) {
    return new Promise(function (resolve) {
      var parts = String(msg).split('\n\n'), titre = parts.shift(), detail = parts.join('\n\n');
      var danger = /archiv|abandon|ne plus|supprim/i.test(titre);
      var ok = /^Envoyer/i.test(titre) ? 'Envoyer' : /^Insérer/i.test(titre) ? 'Insérer' : /^Lancer/i.test(titre) ? 'Lancer' : /^Préparer/i.test(titre) ? 'Préparer' : /archiv/i.test(titre) ? 'Archiver' : danger ? 'Confirmer' : 'Confirmer';
      var bg = document.createElement('div'); bg.className = 'cfm-bg';
      bg.innerHTML = '<div class="cfm' + (danger ? ' danger' : '') + '" role="dialog" aria-modal="true"><div class="cfm-ic">' + (danger ? '⚠️' : '✅') + '</div><div class="cfm-t">' + esc(titre) + '</div>' + (detail ? '<div class="cfm-d">' + esc(detail).replace(/\n/g, '<br>') + '</div>' : '') +
        '<div class="cfm-a"><button type="button" class="btn" data-cfm="0">Annuler</button><button type="button" class="btn ' + (danger ? 'red' : 'go') + '" data-cfm="1">' + ok + '</button></div></div>';
      var fin = function (v) { document.removeEventListener('keydown', kd, true); bg.classList.remove('on'); setTimeout(function () { if (bg.parentNode) bg.parentNode.removeChild(bg); }, 180); resolve(v); };
      var kd = function (e) { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); fin(false); } else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); fin(true); } };
      bg.addEventListener('click', function (e) { var b = e.target.closest('[data-cfm]'); if (b) { e.stopPropagation(); fin(b.getAttribute('data-cfm') === '1'); } else if (e.target === bg) fin(false); });
      document.addEventListener('keydown', kd, true);
      S.root.appendChild(bg); requestAnimationFrame(function () { bg.classList.add('on'); var b = bg.querySelector('[data-cfm="1"]'); if (b) b.focus(); });
    });
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
        var ck0 = S.clicking; confirmer('Envoyer ce mail à ' + pe + ' (' + px1.entreprise + ') depuis redaction@posthumain.com ?').then(function (ok) { if (!ok) return; S.clicking = ck0; setTimeout(function () { S.clicking = null; }, 0);
          work('mk', 'envoie le mail', api('prospect', { op: 'envoyer', prospect_id: id, valide: '1', email: pe, sujet: ps1, corps: pc })).then(function () { if (S.pEdit) delete S.pEdit[id]; toast('📨 Mail envoyé.'); return refresh(true); }).then(function () { paintDoc(); });
        });
        break;
      case 'p-statut':
        api('prospect', { op: 'maj', prospect_id: id, statut: t.getAttribute('data-st') }).then(function () { toast('✓ Mis à jour.'); return refresh(true); }).then(function () { paintDoc(); }, function (e) { toast('⚠️ ' + e.message, true); });
        break;
      case 'p-stop':
        var ck1 = S.clicking; confirmer('Ne plus jamais contacter cette entreprise (et cette adresse) ?').then(function (ok) { if (!ok) return; S.clicking = ck1; setTimeout(function () { S.clicking = null; }, 0);
          api('prospect', { op: 'stop', prospect_id: id }).then(function () { toast('⛔ Retiré.'); return refresh(true); }).then(function () { paintDoc(); }, function (e) { toast('⚠️ ' + e.message, true); });
        });
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
        var ck2 = S.clicking; confirmer('Archiver ce mail ? Il disparaîtra du bureau de Julien.').then(function (ok) { if (!ok) return; S.clicking = ck2; setTimeout(function () { S.clicking = null; }, 0);
          api('classer', { mail_id: id, statut: 'archivé' }).then(function () { closeDoc(); toast('🗄️ Archivé.'); return refresh(true); }, function (e) { toast('⚠️ ' + e.message, true); });
        });
        break;
      case 'm-send':
        var ms1 = mail(id), su = val('wl-m-sujet').trim(), co = val('wl-m-corps').trim();
        if (!ms1 || !su || !co) { toast('Objet ou réponse vide.', true); break; }
        var ck3 = S.clicking; confirmer('Envoyer cette réponse à ' + ms1.de_email + ' ?').then(function (ok) { if (!ok) return; S.clicking = ck3; setTimeout(function () { S.clicking = null; }, 0);
          work(ms1.boite === 'subs' ? 'sc' : 'mk', 'envoie la réponse', api('repondre', { mail_id: id, valide: '1', sujet: su, corps: co, pieces: pjsData('m:' + id) })).then(function () { if (S.mEdit) delete S.mEdit[id]; if (S.pjs) delete S.pjs['m:' + id]; closeDoc(); toast('📨 Réponse envoyée.'); return refresh(true); });
        });
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
        var ck4 = S.clicking; confirmer('Envoyer ce mail à ' + f1.contact.nom + ' (' + f1.contact.email + ') ?').then(function (ok) { if (!ok) return; S.clicking = ck4; setTimeout(function () { S.clicking = null; }, 0);
          work('secretaire', 'envoie le mail', api('envoyer', { fiche_id: id, valide: '1', sujet: sujet, corps: corps, pieces: pjsData('v:' + id) })).then(function () {
            forget(id); if (S.pjs) delete S.pjs['v:' + id]; closeDoc(); toast('📨 Mail envoyé à ' + f1.contact.nom + '.'); return refresh(true);
          });
        });
        break;
      case 'archive':
        var ck5 = S.clicking; confirmer('Archiver cette fiche ? Elle disparaîtra du lab.').then(function (ok) { if (!ok) return; S.clicking = ck5; setTimeout(function () { S.clicking = null; }, 0);
          api('maj', { fiche_id: id, statut: 'archivé' }).then(function () { closeDoc(); toast('🗄️ Fiche archivée.'); return refresh(true); }, function (e) { toast('⚠️ ' + e.message, true); });
        });
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
        S.cit = { fid: id, ins: null, open: {}, fait: {}, skip: {}, done: '' }; paintDoc();
        work('assistant', 'place les citations dans l’article', api('citation', { fiche_id: id, article_id: (fiche(id) || {}).article_id || '' })).then(function (r) {
          if (S.cit && S.cit.fid === id) { S.cit.ins = r.insertions || []; S.cit.open = { 0: true }; } paintDoc();
        }, function () { S.cit = null; paintDoc(); });
        break;
      case 'chapo':
        var fc = fiche(id); if (!fc) break;
        S.chapo = { aid: fc.article_id, props: null, fait: {} }; paintDoc();
        work('assistant', 'cherche où évoquer les experts', api('chapo', { article_id: fc.article_id, experts: expertsCites(fc.article_id) })).then(function (r) {
          if (S.chapo && S.chapo.aid === fc.article_id) S.chapo.props = r.propositions || []; paintDoc();
        }, function () { S.chapo = null; paintDoc(); });
        break;
      case 'chapo-ok':
        var CH = S.chapo, xp = CH && CH.props && CH.props[i]; if (!xp) break;
        var ckH = S.clicking; confirmer('Ajouter cette mention au début de l’article ?\n\n« ' + xp.texte + ' »').then(function (ok) { if (!ok) return; S.clicking = ckH; setTimeout(function () { S.clicking = null; }, 0);
          work('marbre', 'ajoute la mention', api('inserer', { fiche_id: id, chapo: { index: xp.apres, ancre: xp.ancre, texte: xp.texte, mode: xp.mode } })).then(function () {
            CH.fait[i] = true; toast('✅ Mention ajoutée au début de l’article.'); paintDoc();
          });
        });
        break;
      case 'cit-tog': if (S.cit) { S.cit.open[i] = !S.cit.open[i]; paintDoc(); } break;
      case 'cit-maj': paintDoc(); break;
      case 'cit-skip': if (S.cit) { S.cit.skip[i] = !S.cit.skip[i]; if (S.cit.skip[i]) S.cit.open[i] = false; paintDoc(); } break;
      case 'cit-one': case 'cit-all':
        var C = S.cit; if (!C || !C.ins) break;
        var ks = name === 'cit-one' ? [i] : C.ins.map(function (x, k) { return k; }).filter(function (k) { return !C.fait[k] && !C.skip[k]; });
        if (!ks.length) break;
        var items = ks.map(function (k) { var x = C.ins[k]; return { index: x.apres, ancre: x.ancre, intro: x.intro || '', citation: x.citation || '', attribution: x.attribution || '' }; });
        var ckC = S.clicking; confirmer(ks.length > 1 ? 'Insérer les ' + ks.length + ' citations dans l’article ?\n\nChacune est placée après son paragraphe ; les encarts, cartes et le paywall ne sont pas touchés.' : 'Insérer cette citation dans l’article ?').then(function (ok) { if (!ok) return; S.clicking = ckC; setTimeout(function () { S.clicking = null; }, 0);
          work('marbre', ks.length > 1 ? 'insère les citations' : 'insère la citation', api('inserer', { fiche_id: id, items: items })).then(function (r) {
            ks.forEach(function (k) { C.fait[k] = true; C.open[k] = false; });
            var suiv = C.ins.findIndex(function (x, k) { return !C.fait[k] && !C.skip[k]; }); if (suiv >= 0) C.open[suiv] = true;
            C.done = r.editeur; toast(ks.length > 1 ? '✅ ' + ks.length + ' citations insérées.' : '✅ Citation insérée dans l’article.'); return refresh(true);
          }).then(function () { paintDoc(); });
        });
        break;
      // interphone
      case 'pieces': masquerTip(); closeDoc(); openPanel('compta'); break;
      case 'parametres': closeDoc(); openPanel('parametres'); break;
      case 'voir-facture': closeDoc(); openPanel('compta'); chargerFactures().then(function () { var e = S.root.querySelector('#wl-factures'); if (e) e.scrollIntoView({ behavior: 'smooth', block: 'start' }); }); break;
      case 'fa-tarifs':
        factApi({ action: 'tarifs', premium: val('wl-tp'), standard: val('wl-ts') }).then(function (r) { if (!r || !r.ok) { toast('⚠️ ' + ((r && r.why) || 'tarifs invalides'), true); return; } toast('🧾 Tarifs enregistrés : ' + eurTxt(r.tarif_premium) + ' / ' + eurTxt(r.tarif_standard)); chargerFactures(); });
        break;
      case 'fa-edit': S.faEdit = Number(id) || null; paintPanel(); break;
      case 'fa-regen':
        var fid3 = Number(id), corps3 = { action: 'ajuster', id: fid3, premium_qte: val('fa-pq'), tarif_premium: val('fa-pp'), standard_qte: val('fa-sq'), tarif_standard: val('fa-sp'), interview: val('fa-iv') };
        var ck3 = S.clicking; confirmer('Régénérer la facture avec ces valeurs ?\n\nLe PDF est refait et la rédactrice est prévenue.').then(function (ok) { if (!ok) return; S.clicking = ck3;
          factApi(corps3).then(function (r) { if (!r || !r.ok) { toast('⚠️ ' + ((r && r.why) || 'impossible'), true); return; } S.faEdit = null; toast('🧾 Facture régénérée : ' + eurTxt(Number(r.facture.total))); chargerFactures(); });
        });
        break;
      case 'fa-payer':
        var fid4 = Number(id), f4 = ((S.factures || {}).factures || []).filter(function (x) { return x.id === fid4; })[0];
        var ck4 = S.clicking; confirmer('Marquer cette facture comme payée ?\n\n' + (f4 ? moisTxt(f4.mois) + ' : ' + eurTxt(Number(f4.total)) + '. ' : '') + 'La rédactrice est prévenue du paiement. Une facture payée ne se modifie plus.').then(function (ok) { if (!ok) return; S.clicking = ck4;
          factApi({ action: 'payer', id: fid4 }).then(function (r) { if (!r || !r.ok) { toast('⚠️ ' + ((r && r.why) || 'impossible'), true); return; } toast('💸 Facture marquée payée.'); chargerFactures(); });
        });
        break;
      case 'fa-lancer':
        toast('⚡ Comptage des articles du mois dans Ghost…');
        factApi({ action: 'lancer' }).then(function (r) { if (!r || !r.ok) { toast('⚠️ ' + ((r && r.why) || 'impossible'), true); return; } toast('🧾 Facture du mois générée.'); chargerFactures(); });
        break;
      case 'fa-zip':
        var an5 = val('wl-fa-an'); toast('⬇️ Préparation du ZIP ' + an5 + '…');
        factApi({ action: 'zip', annee: an5 }).then(function (r) { if (!r || !r.ok) { toast('⚠️ ' + ((r && r.why) || 'impossible'), true); return; } toast('⬇️ ' + r.nombre + ' facture' + pl(r.nombre) + ' dans le ZIP.'); window.open(r.url, '_blank'); });
        break;
      case 'set-push':
        if (S.pushOk) {
          LS.set('wl-push-off', '1'); LS.set('wl-push-sid', ''); S.pushOk = false; paintPanel(); majTop();
          pushApi({ action: 'unregister' }).then(function () { toast('🔕 Notifications désactivées sur ce navigateur.'); });
        } else {
          LS.set('wl-push-off', '');
          var go = function () { reglerPush(true); setTimeout(function () { paintPanel(); majTop(); }, 2500); };
          if (typeof Notification !== 'undefined' && Notification.permission === 'default' && Notification.requestPermission) Notification.requestPermission().then(go, go);
          else if (typeof Notification !== 'undefined' && Notification.permission === 'denied') toast('Le navigateur bloque les notifications de posthumain.com : autorisez-les dans les réglages du site (cadenas à gauche de l’adresse), puis réessayez.', true);
          else go();
        }
        break;
      case 'sig-lang': sigLire(); S.sigLang = id; paintPanel(); break;
      case 'sig-cmd':
        var ed = S.root.querySelector('#wl-sig'); if (!ed) break; ed.focus();
        if (id === 'link') { var u = window.prompt('Adresse du lien (https://…)', 'https://'); if (u && /^(https?:\/\/|mailto:)/i.test(u)) document.execCommand('createLink', false, u); }
        else document.execCommand(id, false, null);
        sigLire(); break;
      case 'sig-reset': if (S.params) { S.sigDraft[S.sigLang || 'fr'] = S.params.defaut[S.sigLang || 'fr']; paintPanel(); } break;
      case 'sig-save':
        sigLire();
        pushApi({ action: 'parametres_set', fr: S.sigDraft.fr, en: S.sigDraft.en }).then(function (r) {
          if (!r || !r.ok) { toast('⚠️ ' + ((r && r.why) || 'enregistrement impossible'), true); return; }
          S.sigDraft = { fr: r.signature.fr, en: r.signature.en }; S.params.signature = r.signature; toast('✍️ Signatures enregistrées.'); chargerParams();
        });
        break;
      case 'set-mef': LS.set('wl-mef', LS.get('wl-mef') === '0' ? '1' : '0'); paintPanel(); break;
      case 'set-rec':
        var nv = !(S.params && S.params.recompense);
        pushApi({ action: 'parametres_set', recompense: nv }).then(function (r) {
          if (!r || !r.ok) { toast('⚠️ ' + ((r && r.why) || 'impossible'), true); return; }
          S.params.recompense = nv; toast(nv ? '🧪 Mode récompense activé : vos citations rapportent des pièces.' : 'Mode récompense désactivé.'); chargerPieces(); paintPanel();
        });
        break;
      case 'pc-dem':
        var ck6 = S.clicking; confirmer('Demander le paiement de tes pièces ?\n\nJonathan reçoit ta demande et comptabilise le montant pour ta prochaine facture.').then(function (ok) { if (!ok) return; S.clicking = ck6;
          pushApi({ action: 'demande_paiement' }).then(function (r) { if (!r || !r.ok) { toast('⚠️ ' + ((r && r.why) || 'impossible'), true); return; } toast('💶 Demande envoyée à Jonathan.'); chargerPieces(); });
        });
        break;
      case 'pc-taux':
        pushApi({ action: 'taux', taux: val('wl-taux') }).then(function (r) { if (!r || !r.ok) { toast('⚠️ ' + ((r && r.why) || 'taux invalide'), true); return; } toast('Valeur d’une pièce : ' + String(r.taux).replace('.', ',') + ' €'); chargerPieces(); });
        break;
      case 'pc-conv': case 'pc-raz':
        var cm = id, conv = name === 'pc-conv', so2 = ((S.pieces && S.pieces.soldes) || {})[cm] || 0, eu = (Math.round(so2 * Number((S.pieces || {}).taux || 0) * 100) / 100).toFixed(2).replace('.', ',') + ' €';
        var ck8 = S.clicking; confirmer(conv ? 'Convertir les ' + so2 + ' pièces de ' + membre(cm).nom + ' en ' + eu + ' ?\n\nElle reçoit un message dans l’Interphone pour ajouter ce montant à sa prochaine facture, puis le coche chez le Comptable une fois ajouté.' : 'Remettre à zéro les ' + so2 + ' pièces de ' + membre(cm).nom + ' sans les convertir ?\n\nLes pièces restent dans l’historique, marquées « remises à zéro ».').then(function (ok) { if (!ok) return; S.clicking = ck8;
          pushApi({ action: conv ? 'convertir' : 'remise_a_zero', membre: cm }).then(function (r) { if (!r || !r.ok) { toast('⚠️ ' + ((r && r.why) || 'impossible'), true); return; } toast(conv ? '💶 Converti : ' + eu + ' à facturer.' : '↺ Solde remis à zéro.'); chargerPieces(); refresh(true); });
        });
        break;
      case 'pc-fact':
        var fid2 = id, fnote = val('wl-fact-' + id);
        var ck7 = S.clicking; confirmer('Ce montant est bien ajouté à la facture ?\n\nUne fois coché, c’est définitif : la ligne est archivée et les pièces sont comptées pour de bon. Pas de retour en arrière.').then(function (ok) { if (!ok) return; S.clicking = ck7;
          pushApi({ action: 'facturee', id: fid2, note: fnote }).then(function (r) { if (!r || !r.ok) { toast('⚠️ ' + ((r && r.why) || 'impossible'), true); return; } toast('✅ Noté : ajouté à la facture.'); chargerPieces(); refresh(true); });
        });
        break;
      case 'pc-ok': case 'pc-annule':
        var pcSt = name === 'pc-ok' ? 'acquis' : 'annule', pcId = id;
        var ck9 = S.clicking; confirmer(pcSt === 'acquis' ? 'Valider ces pièces ?' : 'Annuler ces pièces ?').then(function (ok) { if (!ok) return; S.clicking = ck9;
          pushApi({ action: 'pieces_decision', id: pcId, statut: pcSt }).then(function (r) { if (!r || !r.ok) { toast('⚠️ ' + ((r && r.why) || 'impossible'), true); return; } toast(pcSt === 'acquis' ? '🪙 Pièces validées.' : '✖️ Pièces annulées.'); chargerPieces(); });
        });
        break;
      case 'dos-toggle': S.dosFocus = null; S.dosOuvert = S.dosOuvert || {}; var dEl = S.root.querySelector('#sdos-' + id); S.dosOuvert[id] = !(dEl && dEl.classList.contains('open')); paintPanel(); break;
      case 'dos-tout': S.dosFocus = null; S.dosOuvert = {}; dossiers(vues().filter(function (f) { return f.statut !== 'inséré'; })).forEach(function (d) { S.dosOuvert[d.id || 'sans'] = id === '1'; }); paintPanel(); break;
      case 'dossier-sec': S.dosFocus = id; masquerTip(); openPanel('secretaire'); setTimeout(function () { var d = S.root.querySelector('#sdos-' + id); if (d) d.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 80); break;
      case 'portee': S.portee = id === 'moi' ? 'moi' : 'tous'; LS.set('wl-portee', S.portee); render(); break;
      case 'dossier': S.tab = 'suivi'; LS.set('wl-tab', S.tab); closePanel(); closeDoc(); render(); setTimeout(function () { var d = S.root.querySelector('#dossier-' + (id || 'sans')); if (d) { d.scrollIntoView({ behavior: 'smooth', block: 'center' }); d.classList.add('flash'); } }, 60); break;
      case 'a-interviewer': S.tab = 'articles'; LS.set('wl-tab', S.tab); closePanel(); closeDoc(); render(); setTimeout(function () { var h = S.root.querySelector('#a-interviewer'); if (h) h.scrollIntoView({ behavior: 'smooth' }); }, 60); break;
      case 'express':
        var ax = art(id); if (!ax) { toast('Enquête introuvable dans Ghost.', true); break; }
        var ck7 = S.clicking; confirmer('Préparer les interviews pour « ' + ax.titre + ' » ?\n\nL’Assistant cherche 2 ou 3 chercheurs (adresses publiées uniquement), écrit les questions, et la Secrétaire prépare les mails. Rien ne part sans votre validation. Compter 1 à 2 minutes.').then(function (ok) { if (!ok) return; S.clicking = ck7; setTimeout(function () { S.clicking = null; }, 0);
          S.art = id; LS.set('wl-article', id);
          work('assistant', 'prépare les interviews express', api('contacts', { article_id: id, express: true })).then(function (r) {
            toast('⚡ ' + (r.n || 0) + ' mail' + pl(r.n || 0) + ' prêt' + pl(r.n || 0) + ' : relisez-les chez la Secrétaire.');
            return refresh(true);
          }).then(function () { openPanel('secretaire'); });
        });
        break;
      case 'push': reglerPush(true); break;
      case 'dicter': if (S.dicte) stopDictee(); else startDictee(); break;
      case 'send-msg':
        if (S.miseEnForme) break;
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
    else if ((k = t.getAttribute('data-cp')) && S.cit && S.cit.ins) { var pp = k.split(':'), pr = S.cit.ins[Number(pp[0])]; if (pr) pr[pp[1]] = t.value; }
    else if ((k = t.getAttribute('data-ch')) != null && S.chapo && S.chapo.props) { var xc = S.chapo.props[Number(k)]; if (xc) xc.texte = t.value; }
    else if (t.id === 'wl-dl') LS.set('wl-dictee-lang', t.value);
    else if (t.getAttribute && t.getAttribute('data-wm') != null && S.params && e.type === 'change') {
      var lst = []; S.root.querySelectorAll('[data-wm]').forEach(function (c) { if (c.checked) lst = lst.concat(WEBMAILS[Number(c.getAttribute('data-wm'))][1]); });
      pushApi({ action: 'parametres_set', webmails: lst }).then(function (r) { if (r && r.ok) { S.params.webmails = r.webmails; toast('🛡️ Contrôle des pièces mis à jour.'); } else toast('⚠️ ' + ((r && r.why) || 'impossible'), true); });
    }
    else if (t.id === 'wl-sig') sigLire();
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

  // Notifications push (Webpushr, déjà installé sur posthumain.com) : le lab enregistre l'identifiant d'abonné de ce navigateur
  // auprès de Supabase (fonction wl-push, contrôle du jeton membre Ghost). Les pushs ne visent que l'équipe, jamais les lecteurs.
  var PUSH = 'https://jfmzhndapfmvdhphuwfm.supabase.co/functions/v1/wl-push';
  function pushApi(body) {
    return fetch('/members/api/session', { credentials: 'same-origin' }).then(function (r) { return r.ok ? r.text() : ''; }).then(function (t) {
      body.token = t;
      return fetch(PUSH, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(function (r) { return r.json(); });
    });
  }
  var FACT = 'https://jfmzhndapfmvdhphuwfm.supabase.co/functions/v1/wl-facture';
  function factApi(body) {
    return fetch('/members/api/session', { credentials: 'same-origin' }).then(function (r) { return r.ok ? r.text() : ''; }).then(function (t) {
      body.token = t; return fetch(FACT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(function (r) { return r.json(); });
    });
  }
  function chargerFactures() { return factApi({ action: 'liste' }).then(function (r) { if (r && r.ok) { S.factures = r; if (S.panel === 'compta' || S.panel === 'parametres') paintPanel(); } }).catch(function () {}); }
  var MOISN = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
  function moisTxt(m) { var p = String(m).split('-'); return (MOISN[Number(p[1]) - 1] || '') + ' ' + p[0]; }
  function facturesHTML() {
    var R = S.factures, me = D().me;
    if (!R) { chargerFactures(); return '<div class="cz-t">🧾 Factures</div><p class="muted">Chargement…</p>'; }
    var fs = R.factures || [], an = new Date().getFullYear();
    var h = '<div class="cz-t" id="wl-factures">🧾 Factures</div><p class="cz-s">Générées automatiquement le dernier jour du mois à 23 h : enquêtes premium et articles standards publiés dans le mois (autrice, co-autrice ou relecture d’un article de Julien), plus les interviews comptabilisées.</p>';
    if (me.chef) h += '<div class="row" style="gap:8px;flex-wrap:wrap;margin:8px 0 4px"><button class="btn small" data-act="fa-lancer">⚡ Générer la facture du mois en cours</button>' +
      '<select class="in" id="wl-fa-an" style="width:auto;flex:0 0 auto">' + [an, an - 1].map(function (y) { return '<option>' + y + '</option>'; }).join('') + '</select><button class="btn small" data-act="fa-zip">⬇️ Télécharger l’année (ZIP)</button></div>';
    if (!fs.length) return h + '<p class="muted">Aucune facture pour l’instant : la première sera générée à la fin du mois.</p>';
    return h + fs.map(function (f) {
      var paye = f.statut === 'payee', ed = S.faEdit === f.id, d = f.details || {};
      var lg = (f.lignes || []).map(function (l) { return esc(l.libelle) + (l.qte != null ? ' × ' + l.qte : '') + ' : ' + eurTxt(Number(l.total)); }).join('<br>');
      var x = '<div class="cz-l"><div class="cz-h"><span><b>' + esc(moisTxt(f.mois)) + '</b>' + (me.chef ? ' · ' + esc(membre(f.membre).nom) : '') + '</span>' + (paye ? '<span class="tag g">✅ payée ' + esc(when(f.payee_le)) + '</span>' : '<span class="tag a">à payer</span>') + '</div>' +
        '<div class="cz-n" style="font-size:24px">' + eurTxt(Number(f.total)) + '<small>N° ' + esc(f.numero) + '</small></div><div class="cz-s" style="margin-top:4px">' + lg + '</div>' +
        '<div class="row" style="gap:6px;margin-top:10px;flex-wrap:wrap">' + (f.url ? '<a class="btn small" href="' + esc(f.url) + '" target="_blank" rel="noopener" data-stop="1">📄 Ouvrir le PDF</a>' : '') +
        (me.chef && !paye ? '<button class="btn small go" data-act="fa-payer" data-id="' + f.id + '">💸 Marquer comme payée</button><button class="btn small" data-act="fa-edit" data-id="' + f.id + '">✏️ Ajuster</button>' : '') + '</div>';
      if (ed) {
        var q = function (l) { var k = (f.lignes || []).filter(function (z) { return z.libelle === l; })[0]; return k || {}; };
        x += '<div class="fa-ed"><label>Enquêtes premium</label><div class="row" style="gap:6px"><input class="in" id="fa-pq" value="' + (q('Posthumain (premium)').qte || 0) + '" inputmode="numeric" style="width:80px"> × <input class="in" id="fa-pp" value="' + String(q('Posthumain (premium)').pu || 0).replace('.', ',') + '" inputmode="decimal" style="width:90px"> €</div>' +
          '<label>Articles standards</label><div class="row" style="gap:6px"><input class="in" id="fa-sq" value="' + (q('Articles standards').qte || 0) + '" inputmode="numeric" style="width:80px"> × <input class="in" id="fa-sp" value="' + String(q('Articles standards').pu || 0).replace('.', ',') + '" inputmode="decimal" style="width:90px"> €</div>' +
          '<label>Interviews (montant)</label><div class="row" style="gap:6px"><input class="in" id="fa-iv" value="' + String(q('Interviews').total || 0).replace('.', ',') + '" inputmode="decimal" style="width:110px"> €</div>' +
          '<div class="row" style="gap:6px;margin-top:10px"><button class="btn small go" data-act="fa-regen" data-id="' + f.id + '">↻ Régénérer la facture</button><button class="btn small" data-act="fa-edit" data-id="0">Annuler</button></div></div>';
      }
      var arts = (d.premium || []).map(function (a) { return ['premium', a]; }).concat((d.standard || []).map(function (a) { return ['standard', a]; }));
      if (arts.length) x += '<details class="cz-d" style="margin-top:10px"><summary>Articles comptés (' + arts.length + ')</summary>' + arts.map(function (z) { return '<div class="cz-s" style="margin:4px 0">' + (z[0] === 'premium' ? '⭐ ' : '📰 ') + esc(z[1].titre) + ' <i>(' + esc(z[1].role) + ')</i></div>'; }).join('') + '</details>';
      return x + '</div>';
    }).join('');
  }
  function sidWebpushr(cb) {
    var n = 0;
    (function essai() {
      if (typeof window.webpushr === 'function') { try { window.webpushr('fetch_id', function (sid) { cb(sid || null); }); } catch (e) { cb(null); } return; }
      if (++n > 20) { cb(null); return; }
      setTimeout(essai, 500);
    })();
  }
  function reglerPush(clic) {
    sidWebpushr(function (sid) {
      if (!sid) {
        S.pushOk = false; var tp = S.root && S.root.querySelector('.top'); if (tp) tp.innerHTML = header();
        if (clic) toast('🔕 Ce navigateur n’est pas abonné aux notifications Posthumain : acceptez la demande de notifications du site (ou la cloche Webpushr en bas de page), puis réactivez-les dans ⚙️ Paramètres.', true);
        return;
      }
      var deja = LS.get('wl-push-sid') === String(sid);
      (deja && !clic ? Promise.resolve({ ok: true }) : pushApi({ action: 'register', sid: String(sid) })).then(function (r) {
        if (!r || !r.ok) { if (clic) toast('⚠️ ' + ((r && r.why) || 'enregistrement impossible'), true); return; }
        LS.set('wl-push-sid', String(sid)); S.pushOk = true;
        var tp = S.root && S.root.querySelector('.top'); if (tp) tp.innerHTML = header();
        if (clic) pushApi({ action: 'test' }).then(function (t) { toast(t && t.ok ? '🔔 Notifications actives : une notification de test arrive.' : '⚠️ ' + ((t && t.why) || 'test impossible'), !(t && t.ok)); });
      }).catch(function () { if (clic) toast('⚠️ Réseau indisponible.', true); });
    });
  }
  // Clic sur une notification : la page s'ouvre sur la bonne pièce (#interphone, #suivi, #a-interviewer, #sc, #mk).
  function suivreAncre() {
    var h = (location.hash || '').slice(1); if (!h || !S.root) return;
    if (h === 'interphone' || h === 'suivi' || h === 'articles') { S.tab = h; render(); }
    else if (h === 'a-interviewer') act('a-interviewer', document.body);
    else if (h === 'sc' || h === 'mk') { S.tab = 'bureau'; render(); openPanel(h); }
    else if (h === 'factures' || h === 'pieces') { S.tab = 'bureau'; render(); openPanel('compta'); }
    else return;
    try { history.replaceState(null, '', location.pathname); } catch (e) {}
  }
  // Infobulle des cases de l'étagère (et de tout élément data-tip="titre|ligne|ligne"), placée près de la souris sans sortir de l'écran.
  function masquerTip() { var t = S.root && S.root.querySelector('.tip'); if (t) t.classList.remove('on'); }
  function suivreTip(e) {
    var el = e.target && e.target.closest && e.target.closest('[data-tip]'), t = S.root.querySelector('.tip');
    if (!el) { if (t) t.classList.remove('on'); return; }
    if (!t) { t = document.createElement('div'); t.className = 'tip'; S.root.appendChild(t); }
    var parts = String(el.getAttribute('data-tip')).split('|');
    var html = '<b>' + esc(parts[0]) + '</b>' + parts.slice(1).filter(Boolean).map(function (x) { return '<span>' + esc(x) + '</span>'; }).join('') + '<span class="go" style="margin-top:4px">' + (el.getAttribute('data-tip-act') || 'Cliquer pour ouvrir le dossier') + '</span>';
    if (t.innerHTML !== html) t.innerHTML = html;
    var w = t.offsetWidth || 260, h = t.offsetHeight || 80, x = e.clientX + 16, y = e.clientY + 16;
    if (x + w > window.innerWidth - 8) x = e.clientX - w - 16;
    if (y + h > window.innerHeight - 8) y = e.clientY - h - 16;
    t.style.left = Math.max(8, x) + 'px'; t.style.top = Math.max(8, y) + 'px'; t.classList.add('on');
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
    r.innerHTML = '<div class="top"></div><div class="tabs"></div><div class="wrap"></div><div class="panelbg"></div><div class="panel"></div><div class="doc"></div><div class="toast"></div>';
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
    r.addEventListener('mousedown', function (e) { if (e.target.closest && e.target.closest('[data-act="sig-cmd"]')) e.preventDefault(); }); // garder la sélection dans l'éditeur de signature
    r.addEventListener('mousemove', suivreTip); r.addEventListener('mouseleave', masquerTip);
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
      suivreAncre(); if (LS.get('wl-push-off') !== '1') reglerPush(false); chargerParams();
    });
    window.addEventListener('hashchange', suivreAncre);
  };
})();
