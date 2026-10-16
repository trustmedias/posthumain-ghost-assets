// Posthumain TV — tv-video : arrivée des documentaires exclusifs chez Bunny Stream et cycle de vie.
//
// Appelé par l'usine (n8n) avec l'en-tête  x-tv-secret: <TV_ADMIN_SECRET>  et un corps JSON { action, ... } :
//   create   { video_url, title, excerpt?, description?, body_html?, thumbnail_url?, theme?, series?,
//              publish_at?, exclusive_days?, slug?, ref? }
//            → Bunny va chercher le MP4, une page Ghost réservée aux abonnés est créée en brouillon,
//              puis publiée automatiquement quand Bunny a fini l'encodage (webhook + rattrapage toutes les 10 min).
//   status   { guid? | key? | ref? }          → état d'un docu (ou des 20 derniers)
//   due      { days_ahead? }                  → exclusivités arrivées (ou arrivant) au bout de leurs 3 mois
//   promote  { guid, youtube_id, keep_bunny? } → bascule YouTube : page Ghost publique avec la vidéo YouTube,
//              étiquette #posthumain-tv retirée, vidéo supprimée de Bunny ; le catalogue /tv suit tout seul.
// Sans secret :
//   sync                                      → fait avancer les docus en cours (appelé par pg_cron)
//   POST ?hook=bunny                          → webhook Bunny (signature vérifiée si BUNNY_STREAM_READONLY_KEY)
// L'état de Bunny est toujours relu par l'API avant d'agir : un faux webhook ne peut rien publier de travers.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import {
  bunny, bunnyConfig, env, ghost, ghostUploadImage, hmacHex, json, safeEqual, sleep,
  exclusiveLexical, promotedLexical, THEMES, SERIES, EXCLUSIVE_TAG, LONG_TAG, VideoRow,
} from "./shared.ts";

const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const DAY = 86_400_000;

function str(v: unknown, max: number): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}
function httpsUrl(v: unknown): string {
  const s = str(v, 2000);
  try { return new URL(s).protocol === "https:" ? s : ""; } catch { return ""; }
}

async function update(key: string, patch: Partial<VideoRow> & Record<string, unknown>) {
  const { error } = await db.from("tv_videos").update({ ...patch, updated_at: new Date().toISOString() }).eq("key", key);
  if (error) throw new Error(`db_update: ${error.message}`);
}
async function rowBy(col: string, val: string): Promise<VideoRow | null> {
  const { data } = await db.from("tv_videos").select("*").eq(col, val).maybeSingle();
  return (data as VideoRow) || null;
}
function publicRow(r: VideoRow) {
  return {
    key: r.key, ref: r.ref, guid: r.bunny_guid, status: r.status, title: r.title, duration: r.duration,
    ghost_post_id: r.ghost_post_id, ghost_url: r.ghost_url,
    tv_url: r.bunny_guid ? `https://posthumain.com/tv/?v=bn-${r.bunny_guid}` : null,
    publish_at: r.publish_at, published_at: r.published_at, exclusive_until: r.exclusive_until,
    youtube_id: r.youtube_id, error: (r as any).error || null,
  };
}

// Bunny ne renvoie pas le GUID quand il va chercher une URL : on le retrouve par la marque [clé] du titre.
async function findGuid(key: string): Promise<string | null> {
  const list = await bunny(`/videos?page=1&itemsPerPage=100&orderBy=date`);
  const hit = (list?.items || []).find((v: any) => typeof v?.title === "string" && v.title.includes(`[${key}]`));
  return hit?.guid || null;
}

async function ensureGhostDraft(row: VideoRow): Promise<VideoRow> {
  if (row.ghost_post_id || !row.bunny_guid) return row;
  const post: Record<string, unknown> = {
    title: row.title,
    status: "draft",
    visibility: "paid",
    lexical: exclusiveLexical(row),
    custom_excerpt: row.excerpt ? row.excerpt.slice(0, 300) : null,
    feature_image: row.feature_image || null,
    tags: [{ name: "Vidéos" }, { name: LONG_TAG }, { name: EXCLUSIVE_TAG }],
  };
  if (row.slug) post.slug = row.slug;
  const out = await ghost("/posts/", { method: "POST", body: JSON.stringify({ posts: [post] }) });
  const p = out?.posts?.[0];
  if (!p?.id) throw new Error("ghost_create_failed");
  await update(row.key, { ghost_post_id: p.id, ghost_url: p.url || null });
  return { ...row, ghost_post_id: p.id, ghost_url: p.url || null };
}

async function finalize(row: VideoRow, length: number) {
  const now = Date.now();
  const at = row.publish_at && new Date(row.publish_at).getTime() > now + 60_000 ? new Date(row.publish_at) : new Date(now);
  const until = new Date(at.getTime() + (row.exclusive_days || 90) * DAY).toISOString();
  const ready: VideoRow = { ...row, duration: length, exclusive_until: until };
  const cur = (await ghost(`/posts/${row.ghost_post_id}/?fields=id,updated_at,status`))?.posts?.[0];
  if (!cur) throw new Error("ghost_post_missing");
  const scheduled = at.getTime() > now + 60_000;
  const out = await ghost(`/posts/${row.ghost_post_id}/`, {
    method: "PUT",
    body: JSON.stringify({ posts: [{
      updated_at: cur.updated_at,
      lexical: exclusiveLexical(ready),
      status: cur.status === "published" ? "published" : scheduled ? "scheduled" : "published",
      published_at: at.toISOString(),
    }] }),
  });
  const p = out?.posts?.[0];
  // Miniature Bunny = image de la page (sinon Bunny prend une image au hasard dans la vidéo)
  if (row.feature_image && row.bunny_guid) {
    try {
      await bunny(`/videos/${row.bunny_guid}/thumbnail?thumbnailUrl=${encodeURIComponent(row.feature_image)}`, { method: "POST" });
    } catch (e) { console.warn("thumbnail", String(e)); }
  }
  await update(row.key, {
    status: "live", duration: length, exclusive_until: until, published_at: at.toISOString(),
    ghost_url: p?.url || row.ghost_url, error: null,
  });
}

// Fait avancer un docu d'une étape : GUID → page brouillon → encodage terminé → publication.
async function advance(row: VideoRow): Promise<string> {
  try {
    if (!row.bunny_guid) {
      const guid = await findGuid(row.key);
      if (!guid) {
        if (Date.now() - new Date(row.created_at).getTime() > 3 * 3600_000) {
          await update(row.key, { status: "error", error: "Bunny n'a jamais reçu la vidéo (URL source inaccessible ?)" });
          return "error";
        }
        return "fetching";
      }
      await update(row.key, { bunny_guid: guid, bunny_library_id: bunnyConfig().lib, status: "encoding" });
      row = { ...row, bunny_guid: guid, bunny_library_id: bunnyConfig().lib, status: "encoding" };
    }
    row = await ensureGhostDraft(row);
    const v = await bunny(`/videos/${row.bunny_guid}`);
    if (v?.status === 4 && Number(v.length) > 0) {
      await finalize(row, Math.round(Number(v.length)));
      return "live";
    }
    if (v?.status === 5 || v?.status === 6) {
      await update(row.key, { status: "error", error: `Encodage Bunny en échec (statut ${v.status})` });
      return "error";
    }
    await update(row.key, { status: "encoding", encode_progress: Number(v?.encodeProgress) || 0 });
    return "encoding";
  } catch (e) {
    await update(row.key, { attempts: (row.attempts || 0) + 1, error: String(e).slice(0, 500) }).catch(() => {});
    return "retry";
  }
}

async function runSync() {
  const { data } = await db.from("tv_videos").select("*").in("status", ["fetching", "encoding"])
    .lt("attempts", 50).order("created_at", { ascending: true }).limit(10);
  const res: Record<string, string> = {};
  for (const r of (data || []) as VideoRow[]) res[r.key] = await advance(r);
  return res;
}

// ---------------------------------------------------------------------------
async function actionCreate(b: any) {
  const title = str(b.title, 180);
  const video_url = httpsUrl(b.video_url);
  if (!title || !video_url) return json({ error: "title_et_video_url_https_requis" }, 400);
  const ref = str(b.ref, 120) || null;
  if (ref) {
    const existing = await rowBy("ref", ref);
    if (existing) return json({ ok: true, duplicate: true, video: publicRow(existing) });
  }
  const { lib } = bunnyConfig();
  if (!lib) return json({ error: "bunny_not_configured" }, 503);
  const days = Number.isFinite(Number(b.exclusive_days)) ? Math.min(365, Math.max(1, Math.round(Number(b.exclusive_days)))) : 90;
  let publishAt: string | null = null;
  if (b.publish_at) {
    const t = new Date(String(b.publish_at));
    if (isNaN(t.getTime())) return json({ error: "publish_at_invalide" }, 400);
    publishAt = t.toISOString();
  }
  const key = "ph" + crypto.randomUUID().replace(/-/g, "").slice(0, 10);
  const row: Partial<VideoRow> & Record<string, unknown> = {
    key, ref, status: "fetching", title,
    slug: str(b.slug, 180).toLowerCase().replace(/[^a-z0-9-]/g, "") || null,
    excerpt: str(b.excerpt, 300) || null,
    description: str(b.description, 8000) || null,
    body_html: typeof b.body_html === "string" ? b.body_html.slice(0, 200_000) : null,
    source_url: video_url,
    thumbnail_url: httpsUrl(b.thumbnail_url) || null,
    theme: THEMES.includes(b.theme) ? b.theme : "ia",
    series: SERIES.includes(b.series) ? b.series : "",
    exclusive_days: days,
    publish_at: publishAt,
    bunny_library_id: lib,
  };
  // Couverture : copiée dans Ghost tout de suite (les liens de l'usine peuvent expirer)
  if (row.thumbnail_url) {
    try { row.feature_image = await ghostUploadImage(row.thumbnail_url as string, `posthumain-tv-${key}`); }
    catch (e) { row.feature_image = row.thumbnail_url; console.warn("cover", String(e)); }
  }
  const { error } = await db.from("tv_videos").insert(row);
  if (error) return json({ error: `db_insert: ${error.message}` }, 500);

  try {
    const r = await bunny(`/videos/fetch`, { method: "POST", body: JSON.stringify({ url: video_url, title: `${title} [${key}]` }) });
    if (r && r.success === false) throw new Error(r.message || "fetch_refused");
  } catch (e) {
    await update(key, { status: "error", error: `Bunny fetch: ${String(e).slice(0, 400)}` });
    return json({ error: "bunny_fetch_failed", detail: String(e).slice(0, 400), key }, 502);
  }
  // Le GUID apparaît en général en quelques secondes ; sinon la synchro le retrouvera.
  let state = "fetching";
  for (let i = 0; i < 4 && state === "fetching"; i++) {
    await sleep(1500);
    state = await advance((await rowBy("key", key))!);
  }
  return json({ ok: true, video: publicRow((await rowBy("key", key))!) });
}

async function actionPromote(b: any) {
  const guid = str(b.guid, 64).replace(/^bn-/, "");
  const yt = str(b.youtube_id, 11);
  if (!guid || !/^[A-Za-z0-9_-]{11}$/.test(yt)) return json({ error: "guid_et_youtube_id_requis" }, 400);
  const row = await rowBy("bunny_guid", guid);
  if (!row) return json({ error: "inconnu" }, 404);
  if (row.status === "promoted") return json({ ok: true, already: true, video: publicRow(row) });
  if (!row.ghost_post_id) return json({ error: "pas_de_page_ghost" }, 409);
  const cur = (await ghost(`/posts/${row.ghost_post_id}/?include=tags&fields=id,updated_at`))?.posts?.[0];
  if (!cur) return json({ error: "page_ghost_introuvable" }, 404);
  const tags = (cur.tags || []).filter((t: any) => t.name !== EXCLUSIVE_TAG).map((t: any) => ({ id: t.id }));
  await ghost(`/posts/${row.ghost_post_id}/`, {
    method: "PUT",
    body: JSON.stringify({ posts: [{ updated_at: cur.updated_at, lexical: promotedLexical(row, yt), visibility: "public", tags }] }),
  });
  let bunnyDeleted = false;
  if (!b.keep_bunny) {
    try { await bunny(`/videos/${guid}`, { method: "DELETE" }); bunnyDeleted = true; }
    catch (e) { console.warn("bunny delete", String(e)); }
  }
  await update(row.key, { status: "promoted", youtube_id: yt, promoted_at: new Date().toISOString(), error: null });
  return json({ ok: true, bunny_deleted: bunnyDeleted, video: publicRow((await rowBy("key", row.key))!) });
}

async function actionDue(b: any) {
  const ahead = Math.max(0, Math.min(60, Number(b.days_ahead) || 0));
  const { data } = await db.from("tv_videos").select("*").eq("status", "live")
    .lte("exclusive_until", new Date(Date.now() + ahead * DAY).toISOString()).order("exclusive_until");
  return json({
    ok: true,
    videos: ((data || []) as VideoRow[]).map((r) => ({
      ...publicRow(r), excerpt: r.excerpt, description: r.description, theme: r.theme, series: r.series,
      source_url: r.source_url, feature_image: r.feature_image,
    })),
  });
}

async function actionStatus(b: any) {
  const guid = str(b.guid, 64).replace(/^bn-/, ""), key = str(b.key, 40), ref = str(b.ref, 120);
  const r = guid ? await rowBy("bunny_guid", guid) : key ? await rowBy("key", key) : ref ? await rowBy("ref", ref) : null;
  if (guid || key || ref) return r ? json({ ok: true, video: publicRow(r) }) : json({ error: "inconnu" }, 404);
  const { data } = await db.from("tv_videos").select("*").order("created_at", { ascending: false }).limit(20);
  return json({ ok: true, videos: ((data || []) as VideoRow[]).map(publicRow) });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const url = new URL(req.url);
  const raw = await req.text();
  if (raw.length > 400_000) return json({ error: "too_large" }, 413);

  // Webhook Bunny : simple signal, on relit l'état chez Bunny avant d'agir
  if (url.searchParams.get("hook") === "bunny") {
    const ro = bunnyConfig().readOnlyKey;
    if (ro) {
      const sig = (req.headers.get("x-bunnystream-signature") || "").toLowerCase();
      if (!safeEqual(await hmacHex(ro, raw), sig)) return json({ error: "bad_signature" }, 401);
    }
    return json({ ok: true, sync: await runSync() });
  }

  let b: any;
  try { b = JSON.parse(raw || "{}"); } catch { return json({ error: "bad_json" }, 400); }
  if (b?.action === "sync") return json({ ok: true, sync: await runSync() });

  const secret = env("TV_ADMIN_SECRET");
  if (!secret || !safeEqual(req.headers.get("x-tv-secret") || "", secret)) return json({ error: "unauthorized" }, 401);
  try {
    switch (b?.action) {
      case "create": return await actionCreate(b);
      case "promote": return await actionPromote(b);
      case "due": return await actionDue(b);
      case "status": return await actionStatus(b);
      default: return json({ error: "action_inconnue", actions: ["create", "status", "due", "promote", "sync"] }, 400);
    }
  } catch (e) {
    return json({ error: "internal", detail: String(e).slice(0, 500) }, 500);
  }
});
