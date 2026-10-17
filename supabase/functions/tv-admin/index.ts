// Posthumain TV — tv-admin : menu d'administration (réservé à l'admin) + référencement automatique.
//
// Réservé à l'admin (jeton d'identité Ghost du membre connecté, e-mail dans TV_ADMIN_EMAILS,
// par défaut jonathan.paiano@outlook.com) — POST { action, ... } :
//   overview                       → santé, réglages, pages /tv et /tv/home, audit SEO de chaque vidéo, exclusivités, audience
//   video_update  { post_id, meta_title, meta_description }
//   page_update   { page: "tv" | "landing", meta_title, meta_description }
//   indexing      { indexable: bool }   → /tv et /tv/home indexables ou non par Google (noindex)
//   settings      { catalog: {...} }    → réglages du catalogue, injectés dans la page /tv (window.PH_TV_CONFIG)
//   seo_apply                          → recalcule tout de suite les données structurées
//   exclusives_sync                    → relance la synchro des exclusivités Bunny
// Public (sans données personnelles) :
//   top                                → vidéos les plus regardées (nombre de spectateurs agrégé), pour la page /tv/home
//   seo_sync                           → idempotent, appelé toutes les heures par pg_cron
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { bunny, bunnyConfig, env, ghost, json, memberEmail } from "./shared.ts";
import {
  blockFor, describe, getOrg, landingLd, LANDING_SLUG, parseMeta, seoBlockOf, SERIES_LABELS, TAG_FILTER, THEME_LABELS,
  tvPageLd, TV_PAGE_SLUG, videoLd, withSeoBlock,
} from "./seo.ts";

const ORIGINS = ["https://posthumain.com", "https://www.posthumain.com"];
const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const ADMINS = (env("TV_ADMIN_EMAILS") || "jonathan.paiano@outlook.com").toLowerCase().split(/[,\s]+/).filter(Boolean);

const CATALOG_DEFAULTS = {
  theme_rows_from: 6, series_rows_from: 10, hero_pin: "",
  soon_title: "Prochain doc", soon_text: "Un nouveau documentaire tous les deux jours",
};

function cors(origin: string): Record<string, string> {
  const h: Record<string, string> = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
  if (ORIGINS.includes(origin)) h["Access-Control-Allow-Origin"] = origin;
  return h;
}

// ---------------------------------------------------------------------------
// Réglages (table tv_settings)
async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const { data } = await db.from("tv_settings").select("value").eq("key", key).maybeSingle();
  return data?.value === undefined || data?.value === null ? fallback : { ...(fallback as any), ...(data.value as any) };
}
async function getIndexable(): Promise<boolean> {
  const { data } = await db.from("tv_settings").select("value").eq("key", "indexable").maybeSingle();
  return data?.value === true;
}
async function setSetting(key: string, value: unknown) {
  const { error } = await db.from("tv_settings").upsert({ key, value, updated_at: new Date().toISOString() });
  if (error) throw new Error(`settings: ${error.message}`);
}

// ---------------------------------------------------------------------------
// Ghost
async function videoPosts(): Promise<any[]> {
  const out = await ghost(`/posts/?filter=${encodeURIComponent(TAG_FILTER)}&limit=all&formats=html,plaintext&include=tags&order=published_at%20desc`);
  return out?.posts || [];
}
async function pageBySlug(slug: string): Promise<any | null> {
  try { return (await ghost(`/pages/slug/${slug}/?formats=html`))?.pages?.[0] || null; } catch { return null; }
}
async function putPost(kind: "posts" | "pages", id: string, fields: Record<string, unknown>) {
  const cur = (await ghost(`/${kind}/${id}/?fields=id,updated_at`))?.[kind]?.[0];
  if (!cur) throw new Error("introuvable");
  return (await ghost(`/${kind}/${id}/`, { method: "PUT", body: JSON.stringify({ [kind]: [{ ...fields, updated_at: cur.updated_at }] }) }))?.[kind]?.[0];
}

// ---------------------------------------------------------------------------
// Référencement
async function seoSync(onlyPostId?: string) {
  const [org, indexable, posts, tvPage, landing] = await Promise.all([getOrg(), getIndexable(), videoPosts(), pageBySlug(TV_PAGE_SLUG), pageBySlug(LANDING_SLUG)]);
  let updated = 0;
  for (const p of posts) {
    if (onlyPostId && p.id !== onlyPostId) continue;
    const block = blockFor(videoLd(p, parseMeta(p.html), org));
    if (seoBlockOf(p.codeinjection_head) !== block) {
      await putPost("posts", p.id, { codeinjection_head: withSeoBlock(p.codeinjection_head, block) });
      updated++;
    }
  }
  const listed = posts.filter((p) => p.status === "published").map((p) => ({ url: p.url, title: p.title }));
  const pages: Record<string, string> = {};
  for (const [pg, ld] of [
    [tvPage, tvPage && tvPageLd(listed, org, describe(tvPage))],
    [landing, landing && landingLd(listed, org, describe(landing))],
  ] as Array<[any, unknown]>) {
    if (!pg) continue;
    const block = blockFor(ld, !indexable);
    if (seoBlockOf(pg.codeinjection_head) !== block) {
      await putPost("pages", pg.id, { codeinjection_head: withSeoBlock(pg.codeinjection_head, block) });
      pages[pg.slug] = "mis à jour";
    } else pages[pg.slug] = "à jour";
  }
  return { videos: posts.length, updated, pages, indexable };
}

function audit(p: any) {
  const meta = parseMeta(p.html);
  const title = p.meta_title || p.title || "";
  const desc = p.meta_description || p.custom_excerpt || "";
  const words = String(p.plaintext || "").split(/\s+/).filter(Boolean).length;
  const issues: string[] = [];
  if (title.length > 60) issues.push(`Titre long pour Google (${title.length} car., ~60 max) : définir un titre SEO plus court`);
  if (!desc) issues.push("Pas de description : Google en inventera une");
  else if (desc.length < 70) issues.push(`Description courte (${desc.length} car., viser 120-155)`);
  else if (desc.length > 160) issues.push(`Description longue (${desc.length} car., coupée après ~155)`);
  if (!p.feature_image) issues.push("Pas d'image à la une (vignette Google / réseaux)");
  if (words < 150) issues.push(`Texte très court (${words} mots) : ajouter un résumé ou la transcription aide Google à comprendre la vidéo`);
  if (!meta.duration) issues.push("Durée inconnue dans la fiche vidéo");
  if (!seoBlockOf(p.codeinjection_head)) issues.push("Données structurées vidéo absentes (ajoutées à la prochaine synchro)");
  const score = Math.max(0, 100 - issues.length * 15);
  return {
    id: p.id, title: p.title, slug: p.slug, url: p.url, status: p.status, visibility: p.visibility,
    published_at: p.published_at, feature_image: p.feature_image,
    meta_title: p.meta_title || "", meta_description: p.meta_description || "", custom_excerpt: p.custom_excerpt || "",
    source: meta.source, video_id: meta.source === "bunny" ? `bn-${meta.bunny.split("/")[1]}` : meta.youtube,
    theme: meta.theme, theme_label: THEME_LABELS[meta.theme], series: meta.series, series_label: SERIES_LABELS[meta.series] || "",
    duration: meta.duration, exclusive_until: meta.until || null, words, seo: { score, issues },
  };
}

// Audience : combien de membres ont lancé / fini chaque vidéo (table tv_member_state, agrégé)
async function audience() {
  const { data } = await db.from("tv_member_state").select("progress, list");
  const started: Record<string, number> = {}, finished: Record<string, number> = {}, listed: Record<string, number> = {};
  for (const row of data || []) {
    for (const [id, p] of Object.entries((row.progress || {}) as Record<string, any>)) {
      started[id] = (started[id] || 0) + 1;
      if (p?.done) finished[id] = (finished[id] || 0) + 1;
    }
    for (const id of (row.list || []) as string[]) listed[id] = (listed[id] || 0) + 1;
  }
  return { members: (data || []).length, started, finished, listed };
}

async function health() {
  const c = bunnyConfig();
  const out: Record<string, unknown> = { bunny_library: c.lib || null, bunny_keys: !!(c.key && c.tokenKey), webhook_signature: !!c.readOnlyKey };
  try { const l = await bunny(`/videos?page=1&itemsPerPage=1`); out.bunny = { ok: true, videos: Number(l?.totalItems ?? 0) }; }
  catch (e) { out.bunny = { ok: false, error: String(e).slice(0, 120) }; }
  return out;
}

function pageInfo(p: any | null) {
  if (!p) return null;
  return {
    id: p.id, slug: p.slug, url: p.url, status: p.status, visibility: p.visibility,
    meta_title: p.meta_title || "", meta_description: p.meta_description || "", title: p.title,
    og_image: p.og_image || p.feature_image || null, seo_block: !!seoBlockOf(p.codeinjection_head),
  };
}

// Réglages du catalogue → injectés dans la page /tv, avant le script (window.PH_TV_CONFIG)
const CFG_RE = /<!-- ph-tv-config:start -->[\s\S]*?<!-- ph-tv-config:end -->\n?/g;
async function writeCatalogConfig(catalog: Record<string, unknown>) {
  const p = await pageBySlug(TV_PAGE_SLUG);
  if (!p) throw new Error("page /tv introuvable");
  const cfg = `<!-- ph-tv-config:start --><script>window.PH_TV_CONFIG=${JSON.stringify(catalog).replace(/</g, "\\u003c")};</script><!-- ph-tv-config:end -->`;
  const foot = cfg + "\n" + String(p.codeinjection_foot || "").replace(CFG_RE, "").trim();
  await putPost("pages", p.id, { codeinjection_foot: foot });
}

function clean(s: unknown, max: number): string {
  return typeof s === "string" ? s.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

// ---------------------------------------------------------------------------
Deno.serve(async (req) => {
  const origin = req.headers.get("origin") || "";
  const h = cors(origin);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405, h);
  let b: any = {};
  try { b = JSON.parse((await req.text()).slice(0, 100_000) || "{}"); } catch { return json({ error: "bad_json" }, 400, h); }

  try {
    // --- public
    if (b.action === "seo_sync") return json({ ok: true, ...(await seoSync()) }, 200, h);
    if (b.action === "top") {
      const a = await audience();
      const top = Object.entries(a.started).sort((x, y) => y[1] - x[1]).slice(0, 12).map(([id, n]) => ({ id, viewers: n }));
      return json({ ok: true, top }, 200, { ...h, "Cache-Control": "public, max-age=600" });
    }

    // --- admin
    if (!ORIGINS.includes(origin)) return json({ error: "origin_not_allowed" }, 403, h);
    const email = await memberEmail(req);
    if (!email || !ADMINS.includes(email)) return json({ error: "forbidden" }, 403, h);

    switch (b.action) {
      case "overview": {
        const [posts, tv, landing, indexable, catalog, aud, hl, ex] = await Promise.all([
          videoPosts(), pageBySlug(TV_PAGE_SLUG), pageBySlug(LANDING_SLUG), getIndexable(),
          getSetting("catalog", CATALOG_DEFAULTS), audience(), health(),
          db.from("tv_videos").select("key, ref, status, title, bunny_guid, ghost_url, duration, encode_progress, published_at, exclusive_until, youtube_id, error, created_at").order("created_at", { ascending: false }).limit(30),
        ]);
        return json({
          ok: true, admin: email, indexable, catalog, health: hl, audience: aud,
          pages: { tv: pageInfo(tv), landing: pageInfo(landing) },
          videos: posts.map(audit), exclusives: ex.data || [],
        }, 200, h);
      }
      case "video_update": {
        const id = clean(b.post_id, 40);
        if (!id) return json({ error: "post_id" }, 400, h);
        await putPost("posts", id, { meta_title: clean(b.meta_title, 300) || null, meta_description: clean(b.meta_description, 500) || null });
        await seoSync(id);
        return json({ ok: true }, 200, h);
      }
      case "page_update": {
        const slug = b.page === "landing" ? LANDING_SLUG : TV_PAGE_SLUG;
        const p = await pageBySlug(slug);
        if (!p) return json({ error: "page_introuvable" }, 404, h);
        const md = clean(b.meta_description, 500);
        await putPost("pages", p.id, {
          meta_title: clean(b.meta_title, 300) || null, meta_description: md || null,
          og_description: md || null, twitter_description: md || null,
        });
        return json({ ok: true, ...(await seoSync("-")) }, 200, h);
      }
      case "indexing": {
        await setSetting("indexable", b.indexable === true);
        return json({ ok: true, ...(await seoSync("-")) }, 200, h);
      }
      case "settings": {
        const c = b.catalog || {};
        const catalog = {
          theme_rows_from: Math.min(50, Math.max(1, Math.round(Number(c.theme_rows_from) || CATALOG_DEFAULTS.theme_rows_from))),
          series_rows_from: Math.min(50, Math.max(1, Math.round(Number(c.series_rows_from) || CATALOG_DEFAULTS.series_rows_from))),
          hero_pin: clean(c.hero_pin, 64),
          soon_title: clean(c.soon_title, 40) || CATALOG_DEFAULTS.soon_title,
          soon_text: clean(c.soon_text, 120) || CATALOG_DEFAULTS.soon_text,
        };
        await setSetting("catalog", catalog);
        await writeCatalogConfig(catalog);
        return json({ ok: true, catalog }, 200, h);
      }
      case "seo_apply": return json({ ok: true, ...(await seoSync()) }, 200, h);
      case "exclusives_sync": {
        const r = await fetch(`${env("SUPABASE_URL")}/functions/v1/tv-video`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "sync" }),
        });
        return json({ ok: r.ok, result: await r.json().catch(() => null) }, 200, h);
      }
      default:
        return json({ error: "action_inconnue" }, 400, h);
    }
  } catch (e) {
    console.error("tv-admin", String(e));
    return json({ error: "internal", detail: String(e).slice(0, 300) }, 500, h);
  }
});
