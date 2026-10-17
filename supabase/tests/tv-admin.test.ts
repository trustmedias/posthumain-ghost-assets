// Banc d'essai local de tv-admin : Ghost, PostgREST, Bunny et JWKS simulés.
import { SignJWT, exportJWK, generateKeyPair } from "npm:jose@5.9.6";

const SUPA = "https://supa.test", GHOST = "https://ghost.test";
const env: Record<string, string> = {
  SUPABASE_URL: SUPA, SUPABASE_SERVICE_ROLE_KEY: "s", GHOST_ADMIN_API_URL: GHOST,
  GHOST_ADMIN_API_KEY: "abc:" + "ab".repeat(32), BUNNY_STREAM_LIBRARY_ID: "782049", BUNNY_STREAM_API_KEY: "k", BUNNY_STREAM_TOKEN_KEY: "t",
};
Deno.env.get = ((k: string) => env[k]) as any;

const tables: Record<string, any[]> = {
  tv_settings: [{ key: "indexable", value: false }],
  tv_member_state: [
    { progress: { ZSuYlUcFcg0: { done: true }, hyACWY9Xp00: {} }, list: ["ZSuYlUcFcg0"] },
    { progress: { ZSuYlUcFcg0: {} }, list: [] },
  ],
  tv_videos: [],
};
function rest(req: Request, url: URL, body: string) {
  const t = url.pathname.split("/").pop()!;
  const rows = tables[t] || (tables[t] = []);
  const eq = [...url.searchParams].find(([k, v]) => v.startsWith("eq."));
  if (req.method === "GET") return Response.json(eq ? rows.filter((r) => String(r[eq[0]]) === eq[1].slice(3)) : rows);
  if (req.method === "POST") {
    const o = JSON.parse(body);
    const i = rows.findIndex((r) => r.key === o.key);
    if (i >= 0) rows[i] = { ...rows[i], ...o }; else rows.push(o);
    return new Response(null, { status: 201 });
  }
  return new Response(null, { status: 204 });
}

const meta = (yt: string, dur: number) => `<p>x</p><div class="ph-video-meta" data-youtube="${yt}" data-theme="energie" data-series="pourquoi" data-duration="${dur}" hidden></div>`;
const posts: any[] = [
  { id: "p1", title: "Pourquoi l'IA dévore autant d'électricité (et Google le nucléaire)", slug: "a", url: "https://posthumain.com/videos/a/", status: "published", visibility: "public", published_at: "2026-10-16T17:49:56.000Z", feature_image: "https://posthumain.com/content/images/a.jpg", custom_excerpt: "Ce que consomme vraiment une IA, et pourquoi les géants de la tech se tournent vers le nucléaire.", html: meta("ZSuYlUcFcg0", 444), plaintext: "court", codeinjection_head: "<style>.x{}</style>", updated_at: "u1" },
  { id: "p2", title: "Exclu", slug: "b", url: "https://posthumain.com/videos/b/", status: "published", visibility: "paid", published_at: "2026-10-17T10:00:00.000Z", feature_image: null, custom_excerpt: "", html: '<div class="ph-video-meta" data-source="bunny" data-bunny="782049/aaaaaaaa-bbbb" data-exclusive="1" data-until="2027-01-15" data-theme="cerveau" data-series="" data-duration="781" hidden></div>', plaintext: "", codeinjection_head: null, updated_at: "u2" },
];
const pages: any[] = [
  { id: "tv1", slug: "tv", title: "Posthumain TV", url: "https://posthumain.com/tv/", status: "published", visibility: "paid", meta_description: "Catalogue", codeinjection_head: null, codeinjection_foot: '<script src="https://cdn.jsdelivr.net/gh/x@abc/posthumain-tv.js" defer></script>', updated_at: "u3" },
  { id: "lp1", slug: "tv-home", title: "Posthumain TV", url: "https://posthumain.com/tv/home/", status: "published", visibility: "public", meta_description: "Landing", codeinjection_head: null, updated_at: "u4" },
];
let puts = 0;
async function ghostApi(req: Request, url: URL, body: string) {
  const path = url.pathname.replace("/ghost/api/admin", "");
  if (path === "/site/") return Response.json({ site: { title: "Posthumain", icon: "https://posthumain.com/icon.png" } });
  if (path === "/posts/" && req.method === "GET") return Response.json({ posts });
  let m = /^\/pages\/slug\/([^/]+)\/$/.exec(path);
  if (m) { const p = pages.find((x) => x.slug === m![1]); return p ? Response.json({ pages: [p] }) : new Response("nf", { status: 404 }); }
  m = /^\/(posts|pages)\/([^/]+)\/$/.exec(path);
  if (m) {
    const list = m[1] === "posts" ? posts : pages;
    const p = list.find((x) => x.id === m![2]);
    if (req.method === "GET") return Response.json({ [m[1]]: [p] });
    const inc = JSON.parse(body)[m[1]][0];
    if (inc.updated_at !== p.updated_at) return new Response("conflict", { status: 409 });
    Object.assign(p, inc, { updated_at: "u" + Math.random() });
    puts++;
    return Response.json({ [m[1]]: [p] });
  }
  return new Response("?", { status: 404 });
}

const { publicKey, privateKey } = await generateKeyPair("RS512");
const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS512" };
const tok = (email: string) => new SignJWT({}).setProtectedHeader({ alg: "RS512", kid: "k1" }).setSubject(email).setIssuer("https://posthumain.com/members/api").setExpirationTime("5m").sign(privateKey);

const real = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const req = new Request(input, init);
  const url = new URL(req.url);
  const body = ["GET", "HEAD"].includes(req.method) ? "" : await req.text();
  if (url.origin === SUPA && url.pathname.startsWith("/rest/")) return rest(req, url, body);
  if (url.origin === SUPA) return Response.json({ ok: true, sync: {} });
  if (url.origin === GHOST) return ghostApi(req, url, body);
  if (url.hostname === "video.bunnycdn.com") return Response.json({ items: [], totalItems: 0 });
  if (url.href.endsWith("/jwks.json")) return Response.json({ keys: [jwk] });
  return real(input, init);
}) as any;

let handler: any;
(Deno as any).serve = (h: any) => { handler = h; return {}; };
await import(new URL("../functions/tv-admin/index.ts", import.meta.url).href);

let fails = 0;
const check = (n: string, ok: unknown, x?: unknown) => { console.log((ok ? "  OK  " : "  ÉCHEC ") + n + (ok ? "" : "  → " + JSON.stringify(x))); if (!ok) fails++; };
async function call(body: any, email?: string, origin = "https://posthumain.com") {
  const hd: Record<string, string> = { "content-type": "application/json", origin };
  if (email) hd.authorization = "Bearer " + await tok(email);
  const r: Response = await handler(new Request("https://x/tv-admin", { method: "POST", headers: hd, body: JSON.stringify(body) }));
  return { s: r.status, j: await r.json() };
}

console.log("Accès");
check("overview sans jeton → 403", (await call({ action: "overview" })).s === 403);
check("overview autre membre → 403", (await call({ action: "overview" }, "abo@test.ch")).s === 403);
const ov = await call({ action: "overview" }, "jonathan.paiano@outlook.com");
check("overview admin → 200", ov.s === 200, ov.j);
check("audit : titre long + texte court signalés", ov.j.videos[0].seo.issues.some((i: string) => i.startsWith("Titre long")) && ov.j.videos[0].seo.issues.some((i: string) => i.startsWith("Texte très court")), ov.j.videos[0].seo);
check("audit : exclusivité reconnue", ov.j.videos[1].source === "bunny" && ov.j.videos[1].video_id === "bn-aaaaaaaa-bbbb");
check("audience agrégée", ov.j.audience.started.ZSuYlUcFcg0 === 2 && ov.j.audience.finished.ZSuYlUcFcg0 === 1);

console.log("SEO");
const s1 = await call({ action: "seo_sync" });
check("seo_sync public → 2 vidéos mises à jour", s1.j.updated === 2, s1.j);
const ld = JSON.parse(/<script type="application\/ld\+json">(.*?)<\/script>/.exec(posts[0].codeinjection_head)![1]);
check("VideoObject complet", ld["@type"] === "VideoObject" && ld.duration === "PT7M24S" && ld.embedUrl === "https://www.youtube.com/embed/ZSuYlUcFcg0" && ld.uploadDate && ld.thumbnailUrl.length === 2, ld);
check("code injection existant conservé", posts[0].codeinjection_head.includes("<style>.x{}</style>"));
const ld2 = JSON.parse(/<script type="application\/ld\+json">(.*?)<\/script>/.exec(posts[1].codeinjection_head)![1]);
check("exclusivité : réservée aux abonnés, pas d'embed", ld2.isAccessibleForFree === false && !ld2.embedUrl && ld2.duration === "PT13M1S");
check("/tv et /tv/home en noindex", pages[0].codeinjection_head.includes("noindex") && pages[1].codeinjection_head.includes("noindex"));
check("/tv/home : FAQPage + liste des vidéos", pages[1].codeinjection_head.includes('"FAQPage"') && pages[1].codeinjection_head.includes('"ItemList"'));
const before = puts;
const s2 = await call({ action: "seo_sync" });
check("deuxième synchro : rien à réécrire", s2.j.updated === 0 && puts === before, s2.j);

console.log("Réglages");
const ix = await call({ action: "indexing", indexable: true }, "jonathan.paiano@outlook.com");
check("indexation activée → noindex retiré", ix.j.indexable === true && !pages[0].codeinjection_head.includes("noindex") && !pages[1].codeinjection_head.includes("noindex"), ix.j);
const st = await call({ action: "settings", catalog: { theme_rows_from: 3, series_rows_from: 999, hero_pin: "ZSuYlUcFcg0", soon_text: "Un docu exclusif chaque dimanche" } }, "jonathan.paiano@outlook.com");
check("réglages bornés", st.j.catalog.theme_rows_from === 3 && st.j.catalog.series_rows_from === 50, st.j);
check("config injectée avant le script /tv", /^<!-- ph-tv-config:start --><script>window\.PH_TV_CONFIG=.*hero_pin.*<!-- ph-tv-config:end -->\n<script src=/.test(pages[0].codeinjection_foot), pages[0].codeinjection_foot);
await call({ action: "settings", catalog: { theme_rows_from: 4 } }, "jonathan.paiano@outlook.com");
check("réglages réécrits sans doublon", (pages[0].codeinjection_foot.match(/ph-tv-config:start/g) || []).length === 1);
const vu = await call({ action: "video_update", post_id: "p1", meta_title: "L'IA et l'électricité : pourquoi Google mise sur le nucléaire", meta_description: "Une IA consomme beaucoup d'électricité. Ce documentaire de 7 minutes explique pourquoi, et pourquoi Google, Microsoft et Amazon se tournent vers le nucléaire." }, "jonathan.paiano@outlook.com");
check("édition méta vidéo", vu.s === 200 && posts[0].meta_title.startsWith("L'IA et") && posts[0].codeinjection_head.includes("Une IA consomme beaucoup"), vu.j);
const top = await call({ action: "top" }, undefined, "");
check("top public", top.j.top[0].id === "ZSuYlUcFcg0" && top.j.top[0].viewers === 2, top.j);

console.log(fails ? `\n${fails} ÉCHEC(S)` : "\nTout est bon.");
Deno.exit(fails ? 1 : 0);
