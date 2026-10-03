/* =============================================================================
 * POSTHUMAIN — cls-debug.js
 * Mesure le CLS (Cumulative Layout Shift) chez les vrais visiteurs avec la
 * bibliotheque officielle web-vitals (build attribution), et envoie les visites
 * avec CLS >= 0,1 vers un webhook n8n -> Airtable (table "CLS Debug").
 * -----------------------------------------------------------------------------
 * Reference en UNE ligne dans Ghost Admin -> Settings -> Code injection -> Site Footer :
 *
 *   <script type="module" src="https://cdn.jsdelivr.net/gh/trustmedias/posthumain-ghost-assets@main/cls-debug.js"></script>
 *
 * Temporaire : a retirer une fois la cause du CLS mobile trouvee et corrigee.
 * Max 5 envois par navigateur et par jour. Aucun affichage, aucune donnee perso.
 * ========================================================================== */
(async () => {
  try {
    const HOOK = 'https://trustmedias.app.n8n.cloud/webhook/ph-cls-debug';
    const DAY_KEY = 'ph-cls-' + new Date().toISOString().slice(0, 10);
    let sentToday = 0;
    try { sentToday = +localStorage.getItem(DAY_KEY) || 0; } catch (e) {}
    if (sentToday >= 5) return; // max 5 envois par navigateur et par jour

    const { onCLS } = await import('https://cdn.jsdelivr.net/npm/web-vitals@4/dist/web-vitals.attribution.js');

    const sel = (el) => {
      if (!el) return '';
      if (el.nodeType !== 1) el = el.parentElement;
      const out = [];
      for (let i = 0; el && el.nodeType === 1 && i < 3; i++, el = el.parentElement) {
        let s = el.tagName.toLowerCase();
        if (el.id) { out.unshift(s + '#' + el.id); break; }
        const c = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 2) : [];
        if (c.length) s += '.' + c.join('.');
        out.unshift(s);
      }
      return out.join('>');
    };

    const shifts = [];
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (e.hadRecentInput) continue;
        shifts.push({
          t: Math.round(e.startTime), v: e.value, sy: Math.round(scrollY),
          src: (e.sources || []).slice(0, 3).map((s) =>
            sel(s.node) + ' y' + Math.round(s.previousRect.y) + '/h' + Math.round(s.previousRect.height) +
            '>y' + Math.round(s.currentRect.y) + '/h' + Math.round(s.currentRect.height)).join(' ; ')
        });
      }
    }).observe({ type: 'layout-shift', buffered: true });

    const ua = (() => {
      const u = navigator.userAgent;
      const p = (u.match(/\(([^)]+)\)/) || [, ''])[1];
      const b = u.match(/(SamsungBrowser|Edg|OPR|CriOS|FxiOS|Firefox|Chrome)\/(\d+)/) || [, 'Safari', ''];
      return (p + ' | ' + b[1] + ' ' + b[2]).slice(0, 120);
    })();

    let sent = false;
    onCLS((m) => {
      if (sent || m.value < 0.1) return;
      sent = true;
      const a = m.attribution || {};
      const lst = Math.round(a.largestShiftTime || 0);
      const near = shifts.reduce((best, s) => (!best || Math.abs(s.t - lst) < Math.abs(best.t - lst)) ? s : best, null);
      const detail = shifts.slice().sort((x, y) => y.v - x.v).slice(0, 8).sort((x, y) => x.t - y.t)
        .map((s) => s.t + 'ms v=' + s.v.toFixed(3) + ' scroll=' + s.sy + ' | ' + s.src).join('\n');
      const c = navigator.connection || {};
      const body = new URLSearchParams({
        page: location.pathname,
        cls: m.value.toFixed(4),
        rating: m.rating || '',
        target: a.largestShiftTarget || '',
        lsv: (a.largestShiftValue || 0).toFixed(4),
        lst: String(lst),
        phase: a.loadState || '',
        sy: near ? String(near.sy) : '',
        detail: detail,
        vp: innerWidth + 'x' + innerHeight,
        ua: ua,
        net: c.effectiveType || '',
        nav: m.navigationType || '',
        ref: (document.referrer || '').slice(0, 200)
      });
      navigator.sendBeacon(HOOK, body);
      try { localStorage.setItem(DAY_KEY, String(sentToday + 1)); } catch (e) {}
    });
  } catch (e) {}
})();
