// Banc d'essai local : tv-video + tv-play avec Bunny, Ghost et PostgREST simulés.
import { SignJWT, exportJWK, generateKeyPair, jwtVerify } from "npm:jose@5.9.6";

const SUPA = "https://supa.test";
const GHOST = "https://ghost.test";
const GHOST_KEY_ID = "abc123";
const GHOST_SECRET = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";
const env: Record<string, string> = {
  SUPABASE_URL: SUPA, SUPABASE_SERVICE_ROLE_KEY: "service",
  GHOST_ADMIN_API_URL: GHOST, GHOST_ADMIN_API_KEY: `${GHOST_KEY_ID}:${GHOST_SECRET}`,
  BUNNY_STREAM_LIBRARY_ID: "4242", BUNNY_STREAM_API_KEY: "bunny-key", BUNNY_STREAM_TOKEN_KEY: "tok-key",
  TV_ADMIN_SECRET: "s3cret",
};
Deno.env.get = ((k: string) => env[k]) as any;

// --- PostgREST en mémoire --------------------------------------------------
const table: any[] = [];
function matches(row: any, params: URLSearchParams) {
  for (const [k, v] of params) {
    if (["select", "order", "limit", "on_conflict"].includes(k)) continue;
    const [op, ...rest] = v.split(".");
    const val = rest.join(".");
    const cell = row[k];
    if (op === "eq" && String(cell) !== val) return false;
    if (op === "in" && !val.replace(/[()]/g, "").split(",").includes(String(cell))) return false;
    if (op === "lt" && !(Number(cell) < Number(val))) return false;
    if (op === "lte" && !(cell != null && new Date(cell) <= new Date(val))) return false;
  }
  return true;
}
function rest(req: Request, url: URL, body: string) {
  const p = url.searchParams;
  if (req.method === "GET") {
    let rows = table.filter((r) => matches(r, p));
    const ord = p.get("order");
    if (ord) { const [c, dir] = ord.split("."); rows.sort((a, b) => (a[c] > b[c] ? 1 : -1) * (dir === "desc" ? -1 : 1)); }
    if (p.get("limit")) rows = rows.slice(0, Number(p.get("limit")));
    return Response.json(rows.map((r) => ({ ...r })));
  }
  if (req.method === "POST") {
    const obj = JSON.parse(body);
    for (const o of Array.isArray(obj) ? obj : [obj]) {
      if (o.ref && table.some((r) => r.ref === o.ref)) return Response.json({ message: "dup" }, { status: 409 });
      table.push({ attempts: 0, created_at: new Date().toISOString(), status: "fetching", exclusive_days: 90, theme: "ia", series: "", ...o });
    }
    return new Response(null, { status: 201 });
  }
  if (req.method === "PATCH") {
    const patch = JSON.parse(body);
    table.filter((r) => matches(r, p)).forEach((r) => Object.assign(r, patch));
    return new Response(null, { status: 204 });
  }
  return new Response("?", { status: 400 });
}

// --- Bunny simulé ----------------------------------------------------------
const bunnyVideos: any[] = [];
const bunnyCalls: string[] = [];
function bunnyApi(req: Request, url: URL, body: string) {
  if (req.headers.get("AccessKey") !== "bunny-key") return new Response("no", { status: 401 });
  const path = url.pathname.replace("/library/4242", "");
  bunnyCalls.push(`${req.method} ${path}${url.search}`);
  if (req.method === "POST" && path === "/videos/fetch") {
    const b = JSON.parse(body);
    bunnyVideos.unshift({ guid: crypto.randomUUID(), title: b.title, status: 1, length: 0, encodeProgress: 0 });
    return Response.json({ success: true, message: "OK", statusCode: 200 });
  }
  if (req.method === "GET" && path === "/videos") return Response.json({ items: bunnyVideos });
  const m = /^\/videos\/([^/]+)(\/thumbnail)?$/.exec(path);
  if (m) {
    const v = bunnyVideos.find((x) => x.guid === m[1]);
    if (!v) return new Response("nf", { status: 404 });
    if (req.method === "GET") return Response.json(v);
    if (req.method === "DELETE") { bunnyVideos.splice(bunnyVideos.indexOf(v), 1); return Response.json({ success: true }); }
    if (m[2]) return Response.json({ success: true });
  }
  return new Response("?", { status: 400 });
}

// --- Ghost simulé ----------------------------------------------------------
const posts: Record<string, any> = {};
const members: Record<string, string> = { "abo@test.ch": "paid", "gratuit@test.ch": "free", "offert@test.ch": "comped" };
const secretBytes = new Uint8Array(GHOST_SECRET.match(/.{2}/g)!.map((h) => parseInt(h, 16)));
async function ghostApi(req: Request, url: URL, body: any) {
  const auth = req.headers.get("Authorization") || "";
  try {
    const { protectedHeader, payload } = await jwtVerify(auth.replace(/^Ghost /, ""), secretBytes, { audience: "/admin/" });
    if (protectedHeader.kid !== GHOST_KEY_ID) throw new Error("kid");
    if (!payload.exp) throw new Error("exp");
  } catch (e) { return Response.json({ errors: [{ message: "bad jwt " + e }] }, { status: 401 }); }
  const path = url.pathname.replace("/ghost/api/admin", "");
  if (path === "/images/upload/") return Response.json({ images: [{ url: "https://posthumain.com/content/images/2026/10/cover.jpg" }] });
  if (path === "/members/") {
    const email = /email:'([^']+)'/.exec(url.searchParams.get("filter") || "")?.[1] || "";
    return Response.json({ members: members[email] ? [{ id: "m1", email, status: members[email] }] : [] });
  }
  if (path === "/posts/" && req.method === "POST") {
    const p = JSON.parse(body).posts[0];
    const id = "post" + (Object.keys(posts).length + 1);
    posts[id] = { ...p, id, url: `https://posthumain.com/${id}/`, updated_at: "2026-10-17T00:00:00.000Z", tags: p.tags.map((t: any, i: number) => ({ id: "t" + i, name: t.name })) };
    return Response.json({ posts: [posts[id]] }, { status: 201 });
  }
  const m = /^\/posts\/([^/]+)\/$/.exec(path);
  if (m && posts[m[1]]) {
    if (req.method === "GET") return Response.json({ posts: [posts[m[1]]] });
    if (req.method === "PUT") {
      const p = JSON.parse(body).posts[0];
      if (p.updated_at !== posts[m[1]].updated_at) return Response.json({ errors: [{ message: "conflict" }] }, { status: 409 });
      if (p.tags) p.tags = p.tags.map((t: any) => posts[m[1]].tags.find((x: any) => x.id === t.id));
      Object.assign(posts[m[1]], p, { updated_at: new Date(Date.now() + Math.random() * 1000).toISOString() });
      return Response.json({ posts: [posts[m[1]]] });
    }
  }
  return new Response("?", { status: 404 });
}

// --- Membre Ghost (JWKS) ---------------------------------------------------
const { publicKey, privateKey } = await generateKeyPair("RS512");
const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS512", use: "sig" };
const memberToken = (email: string, iss = "https://posthumain.com/members/api") =>
  new SignJWT({}).setProtectedHeader({ alg: "RS512", kid: "k1" }).setSubject(email).setIssuer(iss).setIssuedAt().setExpirationTime("10m").sign(privateKey);

// --- fetch global ----------------------------------------------------------
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const req = new Request(input, init);
  const url = new URL(req.url);
  const body = req.method === "GET" || req.method === "HEAD" ? "" : (url.hostname === "ghost.test" && url.pathname.endsWith("/images/upload/")) ? "" : await req.text();
  if (url.origin === SUPA) return rest(req, url, body);
  if (url.hostname === "video.bunnycdn.com") return bunnyApi(req, url, body);
  if (url.origin === GHOST) return ghostApi(req, url, body);
  if (url.hostname === "cdn.usine.test") return new Response(new Uint8Array([255, 216, 255]), { headers: { "content-type": "image/jpeg" } });
  if (url.href === "https://posthumain.com/members/.well-known/jwks.json") return Response.json({ keys: [jwk] });
  return realFetch(input, init);
}) as any;

// --- Charger les deux fonctions -------------------------------------------
const handlers: any[] = [];
(Deno as any).serve = (h: any) => { handlers.push(h); return {} as any; };
const BASE = new URL("../functions", import.meta.url).pathname;
await import(`${BASE}/tv-video/index.ts`);
await import(`${BASE}/tv-play/index.ts`);
const [tvVideo, tvPlay] = handlers;

let fails = 0;
function check(name: string, ok: unknown, extra?: unknown) {
  console.log((ok ? "  OK  " : "  ÉCHEC ") + name + (ok ? "" : "  → " + JSON.stringify(extra)));
  if (!ok) fails++;
}
async function call(body: any, opts: { secret?: string; query?: string } = {}) {
  const h: Record<string, string> = { "content-type": "application/json" };
  if (opts.secret !== undefined) h["x-tv-secret"] = opts.secret;
  const r: Response = await tvVideo(new Request(`https://x.test/functions/v1/tv-video${opts.query || ""}`, { method: "POST", headers: h, body: JSON.stringify(body) }));
  return { status: r.status, j: await r.json() };
}
async function play(id: string, token: string | null, origin = "https://posthumain.com") {
  const h: Record<string, string> = { "content-type": "application/json", origin };
  if (token) h.authorization = "Bearer " + token;
  const r: Response = await tvPlay(new Request("https://x.test/functions/v1/tv-play", { method: "POST", headers: h, body: JSON.stringify({ id }) }));
  return { status: r.status, j: await r.json(), cors: r.headers.get("access-control-allow-origin") };
}

console.log("1. Sécurité");
check("create sans secret → 401", (await call({ action: "create" })).status === 401);
check("create mauvais secret → 401", (await call({ action: "create" }, { secret: "x" })).status === 401);
check("champs manquants → 400", (await call({ action: "create", title: "x" }, { secret: "s3cret" })).status === 400);
check("URL http refusée → 400", (await call({ action: "create", title: "x", video_url: "http://a.b/c.mp4" }, { secret: "s3cret" })).status === 400);

console.log("2. Arrivée d'un docu");
const c = await call({
  action: "create", ref: "docu-2026-10-18", title: "Le grand docu", excerpt: "Accroche courte.", description: "Paragraphe un.\n\nParagraphe deux.",
  body_html: "<h2>Sources</h2><ul><li>x</li></ul>", video_url: "https://cdn.usine.test/docu.mp4", thumbnail_url: "https://cdn.usine.test/cover.jpg",
  theme: "cerveau", series: "pourquoi",
}, { secret: "s3cret" });
check("create → 200 + encodage", c.status === 200 && c.j.video.status === "encoding", c);
const guid = c.j.video.guid;
check("GUID retrouvé chez Bunny", !!guid && bunnyVideos[0].guid === guid);
check("titre Bunny marqué [clé]", bunnyVideos[0].title.includes(`[${c.j.video.key}]`));
const post = posts[c.j.video.ghost_post_id];
check("page Ghost en brouillon, réservée aux payants", post && post.status === "draft" && post.visibility === "paid", post);
check("tags Vidéos + #version-longue + #posthumain-tv", post.tags.map((t: any) => t.name).join("|") === "Vidéos|#version-longue|#posthumain-tv");
check("couverture copiée dans Ghost", post.feature_image === "https://posthumain.com/content/images/2026/10/cover.jpg");
const lx = JSON.parse(post.lexical).root.children;
check("lexical : carte publique, paywall, carte abonnés", lx.length === 3 && lx[0].type === "html" && lx[1].type === "paywall" && lx[2].type === "html", lx);
check("fiche cachée bunny dans la partie publique", lx[0].html.includes(`data-bunny="4242/${guid}"`) && lx[0].html.includes('data-exclusive="1"') && lx[0].html.includes('data-theme="cerveau"'));
check("bouton vers /tv/?v=bn-GUID", lx[2].html.includes(`/tv/?v=bn-${guid}`) && lx[2].html.includes("<h2>Sources</h2>"));
check("doublon (même ref) → renvoie l'existant", (await call({ action: "create", ref: "docu-2026-10-18", title: "x", video_url: "https://cdn.usine.test/d.mp4" }, { secret: "s3cret" })).j.duplicate === true);
check("une seule vidéo chez Bunny", bunnyVideos.length === 1);

console.log("3. Lecture avant la fin de l'encodage");
const tAbo = await memberToken("abo@test.ch");
check("pas encore en ligne → 404", (await play("bn-" + guid, tAbo)).status === 404);

console.log("4. Fin de l'encodage (webhook) → publication");
check("sync sans changement → encoding", (await call({ action: "sync" })).j.sync[c.j.video.key] === "encoding");
bunnyVideos[0].status = 4; bunnyVideos[0].length = 781;
const hook = await call({ VideoLibraryId: 4242, VideoGuid: guid, Status: 3 }, { query: "?hook=bunny" });
check("webhook → live", hook.j.sync[c.j.video.key] === "live", hook);
check("page Ghost publiée", post.status === "published" && !!post.published_at, post.status);
const lx2 = JSON.parse(post.lexical).root.children;
check("durée réelle + date de fin d'exclu dans la fiche", lx2[0].html.includes('data-duration="781"') && /data-until="\d{4}-\d{2}-\d{2}"/.test(lx2[0].html));
check("miniature Bunny = couverture", bunnyCalls.some((x) => x.startsWith(`POST /videos/${guid}/thumbnail?thumbnailUrl=`)));
const st = await call({ action: "status", guid }, { secret: "s3cret" });
const until = new Date(st.j.video.exclusive_until).getTime();
check("exclusivité = 90 jours", Math.abs(until - Date.now() - 90 * 86400000) < 120000, st.j.video);

console.log("5. tv-play");
const p1 = await play("bn-" + guid, tAbo);
const exp = Number(new URL(p1.j.url).searchParams.get("expires"));
const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("tok-key" + guid + exp));
const tok = Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
check("abonné payant → lien signé correct", p1.status === 200 && p1.j.url.startsWith(`https://iframe.mediadelivery.net/embed/4242/${guid}?`) && new URL(p1.j.url).searchParams.get("token") === tok, p1);
check("CORS posthumain.com", p1.cors === "https://posthumain.com");
check("complimentary → OK", (await play("bn-" + guid, await memberToken("offert@test.ch"))).status === 200);
check("membre gratuit → 403", (await play("bn-" + guid, await memberToken("gratuit@test.ch"))).status === 403);
check("inconnu → 403", (await play("bn-" + guid, await memberToken("personne@test.ch"))).status === 403);
check("sans jeton → 401", (await play("bn-" + guid, null)).status === 401);
check("jeton d'un autre émetteur → 401", (await play("bn-" + guid, await memberToken("abo@test.ch", "https://evil.test/"))).status === 401);
check("autre site → 403", (await play("bn-" + guid, tAbo, "https://evil.test")).status === 403);
check("GUID inconnu → 404", (await play("bn-00000000-0000", tAbo)).status === 404);

console.log("6. Fin des 3 mois");
check("due (aujourd'hui) → rien", (await call({ action: "due" }, { secret: "s3cret" })).j.videos.length === 0);
const c2 = await call({ action: "create", title: "Docu court", video_url: "https://cdn.usine.test/d2.mp4", exclusive_days: 1, publish_at: "2026-10-01T00:00:00Z" }, { secret: "s3cret" });
bunnyVideos[0].status = 4; bunnyVideos[0].length = 700;
await call({ action: "sync" });
const due = await call({ action: "due", days_ahead: 2 }, { secret: "s3cret" });
check("due (dans 2 jours) → le docu de 1 jour", due.j.videos.length === 1 && due.j.videos[0].guid === c2.j.video.guid, due.j);
const pr = await call({ action: "promote", guid, youtube_id: "dQw4w9WgXcQ" }, { secret: "s3cret" });
check("promote → OK + Bunny supprimé", pr.status === 200 && pr.j.bunny_deleted && !bunnyVideos.some((v) => v.guid === guid), pr);
check("page devenue publique", post.visibility === "public");
check("#posthumain-tv retiré, autres tags gardés", post.tags.map((t: any) => t.name).join("|") === "Vidéos|#version-longue", post.tags);
const lx3 = JSON.parse(post.lexical).root.children;
check("fiche YouTube + ancien id + vignette play (pas d'iframe)", lx3.length === 1 && lx3[0].html.includes('data-youtube="dQw4w9WgXcQ"') && lx3[0].html.includes(`data-was="bn-${guid}"`) && lx3[0].html.includes('class="ph-yt-thumb"') && lx3[0].html.includes("youtube.com/watch?v=dQw4w9WgXcQ") && lx3[0].html.includes("posthumain-bouton-play") && !lx3[0].html.includes("<iframe") && !lx3[0].html.includes("data-bunny"));
check("plus lisible sur Bunny via tv-play → 404", (await play("bn-" + guid, tAbo)).status === 404);
check("promote rejoué → déjà fait", (await call({ action: "promote", guid, youtube_id: "dQw4w9WgXcQ" }, { secret: "s3cret" })).j.already === true);

console.log(fails ? `\n${fails} ÉCHEC(S)` : "\nTout est bon.");
Deno.exit(fails ? 1 : 0);
