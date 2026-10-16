// Posthumain TV — outils communs aux fonctions tv-video et tv-play (projet Supabase PosthumanOS).
// Bunny Stream (API vidéo + jeton d'embed signé), Ghost Admin API (JWT HS256), jeton d'identité membre Ghost.
import { createRemoteJWKSet, jwtVerify } from "npm:jose@5.9.6";

export const env = (k: string) => (Deno.env.get(k) || "").trim();

export const THEMES = ["ia", "energie", "vivant", "cerveau", "espace", "danger"];
export const SERIES = ["comment", "pourquoi", "etsi", "cout", "futur"];
export const EXCLUSIVE_TAG = "#posthumain-tv";
export const LONG_TAG = "#version-longue";
export const SITE = "https://posthumain.com";

// ---------------------------------------------------------------------------
// Petits outils
const enc = new TextEncoder();
function hex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
export async function sha256hex(s: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));
}
async function hmac(keyBytes: Uint8Array, msg: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", k, enc.encode(msg));
}
export async function hmacHex(key: string, msg: string): Promise<string> {
  return hex(await hmac(enc.encode(key), msg));
}
export function safeEqual(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
export function escHtml(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Bunny Stream
export function bunnyConfig() {
  return {
    lib: env("BUNNY_STREAM_LIBRARY_ID"),
    key: env("BUNNY_STREAM_API_KEY"),
    tokenKey: env("BUNNY_STREAM_TOKEN_KEY"),
    readOnlyKey: env("BUNNY_STREAM_READONLY_KEY"),
    embedHost: env("BUNNY_STREAM_EMBED_HOST") || "iframe.mediadelivery.net",
  };
}

export async function bunny(path: string, init: RequestInit = {}): Promise<any> {
  const { lib, key } = bunnyConfig();
  if (!lib || !key) throw new Error("bunny_not_configured");
  const headers: Record<string, string> = { AccessKey: key, Accept: "application/json" };
  if (init.body) headers["Content-Type"] = "application/json";
  const res = await fetch(`https://video.bunnycdn.com/library/${lib}${path}`, {
    ...init,
    headers: { ...headers, ...(init.headers as Record<string, string> || {}) },
  });
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) throw new Error(`bunny ${res.status} ${path.split("?")[0]}: ${String(text).slice(0, 200)}`);
  return data;
}

// Lien d'embed signé (« Embed view token authentication » de la bibliothèque) :
// token = SHA256_HEX(clé_token + guid + expiration_unix_secondes)
export async function signedEmbed(guid: string, ttlSec = 6 * 3600) {
  const { lib, tokenKey, embedHost } = bunnyConfig();
  const params = new URLSearchParams({ autoplay: "true", preload: "true", responsive: "true" });
  let expires = 0;
  if (tokenKey) {
    expires = Math.floor(Date.now() / 1000) + ttlSec;
    params.set("token", await sha256hex(tokenKey + guid + expires));
    params.set("expires", String(expires));
  }
  return { url: `https://${embedHost}/embed/${lib}/${guid}?${params}`, expires, signed: !!tokenKey };
}

// ---------------------------------------------------------------------------
// Ghost Admin API (secrets déjà présents dans le projet : GHOST_ADMIN_API_URL, GHOST_ADMIN_API_KEY)
function ghostConfig() {
  const url = env("GHOST_ADMIN_API_URL").replace(/\/+$/g, "");
  const [id, secret] = env("GHOST_ADMIN_API_KEY").split(":");
  if (!url || !id || !secret) throw new Error("ghost_not_configured");
  return { url, id, secret };
}
function b64url(input: ArrayBuffer | string): string {
  const bytes = typeof input === "string" ? enc.encode(input) : new Uint8Array(input);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/=+$/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
async function ghostJwt(): Promise<string> {
  const { id, secret } = ghostConfig();
  const iat = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: "HS256", kid: id, typ: "JWT" }));
  const body = b64url(JSON.stringify({ iat, exp: iat + 300, aud: "/admin/" }));
  const keyBytes = new Uint8Array(secret.match(/.{2}/g)!.map((h) => parseInt(h, 16)));
  return `${head}.${body}.${b64url(await hmac(keyBytes, `${head}.${body}`))}`;
}

export async function ghost(path: string, init: RequestInit = {}): Promise<any> {
  const { url } = ghostConfig();
  const headers: Record<string, string> = { Authorization: `Ghost ${await ghostJwt()}`, "Accept-Version": "v5.0" };
  if (init.body && typeof init.body === "string") headers["Content-Type"] = "application/json";
  const res = await fetch(`${url}/ghost/api/admin${path}`, { ...init, headers: { ...headers, ...(init.headers as Record<string, string> || {}) } });
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) throw new Error(`ghost ${res.status} ${path.split("?")[0]}: ${String(text).slice(0, 300)}`);
  return data;
}

// Téléverse une image distante dans Ghost (les URL de l'usine peuvent expirer) → URL Ghost durable.
export async function ghostUploadImage(srcUrl: string, baseName: string): Promise<string> {
  const r = await fetch(srcUrl);
  if (!r.ok) throw new Error(`image ${r.status}`);
  const type = (r.headers.get("content-type") || "image/jpeg").split(";")[0];
  const ext = type.includes("png") ? "png" : type.includes("webp") ? "webp" : "jpg";
  const blob = new Blob([await r.arrayBuffer()], { type });
  const fd = new FormData();
  fd.append("file", blob, `${baseName}.${ext}`);
  fd.append("purpose", "image");
  const out = await ghost("/images/upload/", { method: "POST", body: fd });
  const u = out?.images?.[0]?.url;
  if (!u) throw new Error("ghost_upload_no_url");
  return u;
}

// Abonné payant ou complimentary ? (statut Ghost du membre)
const paidCache = new Map<string, { ok: boolean; exp: number }>();
export async function memberIsPaid(email: string): Promise<boolean> {
  const c = paidCache.get(email);
  if (c && c.exp > Date.now()) return c.ok;
  const filter = encodeURIComponent(`email:'${email.replace(/'/g, "\\'")}'`);
  const out = await ghost(`/members/?filter=${filter}&limit=1&fields=id,email,status`);
  const m = out?.members?.[0];
  const ok = !!m && (m.status === "paid" || m.status === "comped");
  paidCache.set(email, { ok, exp: Date.now() + (ok ? 10 : 2) * 60_000 });
  return ok;
}

// ---------------------------------------------------------------------------
// Jeton d'identité du membre connecté (posthumain.com/members/api/session), signé par Ghost
const JWKS = createRemoteJWKSet(new URL(`${SITE}/members/.well-known/jwks.json`));
const ISSUER_HOSTS = ["posthumain.com", "www.posthumain.com", "the-last-journal.ghost.io"];
export async function memberEmail(req: Request): Promise<string | null> {
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!token || token.length > 4096) return null;
  try {
    const { payload } = await jwtVerify(token, JWKS, { algorithms: ["RS512", "RS256"] });
    let host = "";
    try { host = new URL(String(payload.iss || "")).hostname; } catch { /* iss invalide */ }
    if (!ISSUER_HOSTS.includes(host)) return null;
    const email = String(payload.sub || "").trim().toLowerCase();
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 320 ? email : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Contenu de la page Ghost d'un documentaire
export type VideoRow = {
  key: string;
  ref: string | null;
  bunny_guid: string | null;
  bunny_library_id: string | null;
  status: string;
  title: string;
  slug: string | null;
  excerpt: string | null;
  description: string | null;
  body_html: string | null;
  source_url: string;
  thumbnail_url: string | null;
  feature_image: string | null;
  theme: string;
  series: string;
  duration: number | null;
  exclusive_days: number;
  ghost_post_id: string | null;
  ghost_url: string | null;
  publish_at: string | null;
  published_at: string | null;
  exclusive_until: string | null;
  youtube_id: string | null;
  attempts: number;
  created_at: string;
};

// Fiche cachée lue par posthumain-tv.js (thème, série, durée, source)
export function metaCard(o: {
  source: "bunny" | "youtube"; lib?: string | null; guid?: string | null; youtube?: string | null;
  theme: string; series: string; duration?: number | null; until?: string | null; was?: string | null;
}): string {
  const a: string[] = ['class="ph-video-meta"'];
  if (o.source === "bunny") {
    a.push('data-source="bunny"', `data-bunny="${escHtml(`${o.lib}/${o.guid}`)}"`, 'data-exclusive="1"');
    if (o.until) a.push(`data-until="${escHtml(o.until.slice(0, 10))}"`);
  } else {
    a.push(`data-youtube="${escHtml(o.youtube || "")}"`);
    if (o.was) a.push(`data-was="${escHtml(o.was)}"`);
  }
  a.push(`data-theme="${escHtml(o.theme)}"`, `data-series="${escHtml(o.series || "")}"`, `data-duration="${Math.round(o.duration || 0)}"`);
  return `<div ${a.join(" ")} hidden></div>`;
}

export function paragraphs(text: string | null): string {
  return String(text || "").split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)
    .map((p) => `<p>${escHtml(p).replace(/\n/g, "<br>")}</p>`).join("");
}

// Document Lexical Ghost : cartes HTML + séparateur « public / abonnés » (paywall)
export function lexical(blocks: Array<string | "paywall">): string {
  return JSON.stringify({
    root: {
      children: blocks.map((b) => (b === "paywall" ? { type: "paywall", version: 1 } : { type: "html", version: 1, html: b })),
      direction: null, format: "", indent: 0, type: "root", version: 1,
    },
  });
}

export function exclusiveLexical(row: VideoRow): string {
  const id = `bn-${row.bunny_guid}`;
  const teaser =
    (row.excerpt ? `<p>${escHtml(row.excerpt)}</p>` : "") +
    `<p><strong>Exclusivité Posthumain TV.</strong> Ce documentaire est réservé aux abonnés.</p>` +
    metaCard({ source: "bunny", lib: row.bunny_library_id, guid: row.bunny_guid, theme: row.theme, series: row.series, duration: row.duration, until: row.exclusive_until });
  const members =
    `<div class="kg-card kg-button-card kg-align-center"><a href="/tv/?v=${encodeURIComponent(id)}" class="kg-btn kg-btn-accent">▶ Regarder sur Posthumain TV</a></div>` +
    paragraphs(row.description) + (row.body_html || "");
  return lexical([teaser, "paywall", members]);
}

export function promotedLexical(row: VideoRow, youtubeId: string): string {
  const embed =
    `<figure class="kg-card kg-embed-card"><iframe width="560" height="315" src="https://www.youtube.com/embed/${escHtml(youtubeId)}?feature=oembed" ` +
    `frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" ` +
    `referrerpolicy="strict-origin-when-cross-origin" allowfullscreen title="${escHtml(row.title)}"></iframe></figure>`;
  return lexical([
    (row.excerpt ? `<p>${escHtml(row.excerpt)}</p>` : "") + embed +
      metaCard({ source: "youtube", youtube: youtubeId, theme: row.theme, series: row.series, duration: row.duration, was: `bn-${row.bunny_guid}` }) +
      paragraphs(row.description) + (row.body_html || ""),
  ]);
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { ...headers, "Content-Type": "application/json" } });
}
