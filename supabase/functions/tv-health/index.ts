// Posthumain TV — tv-health : contrôle de configuration (aucune valeur secrète renvoyée, seulement oui/non).
// GET https://jfmzhndapfmvdhphuwfm.supabase.co/functions/v1/tv-health
import { bunny, bunnyConfig, env, ghost, json } from "./shared.ts";

Deno.serve(async () => {
  const c = bunnyConfig();
  const out: Record<string, unknown> = {
    library_id: c.lib || null,
    api_key_set: !!c.key,
    token_key_set: !!c.tokenKey,
    readonly_key_set: !!c.readOnlyKey,
    admin_secret_set: env("TV_ADMIN_SECRET").length >= 16,
  };
  try {
    const list = await bunny(`/videos?page=1&itemsPerPage=10`);
    out.bunny_api = { ok: true, videos: Number(list?.totalItems ?? (list?.items || []).length) };
  } catch (e) {
    out.bunny_api = { ok: false, error: String(e).slice(0, 160) };
  }
  try {
    const s = await ghost(`/site/`);
    out.ghost_admin = { ok: true, site: s?.site?.title || null };
  } catch (e) {
    out.ghost_admin = { ok: false, error: String(e).slice(0, 160) };
  }
  return json(out, 200, { "Access-Control-Allow-Origin": "*" });
});
