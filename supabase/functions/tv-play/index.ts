// Posthumain TV — tv-play : lien de lecture signé (Bunny Stream) pour un abonné payant ou complimentary.
// Appelé par posthumain-tv.js : POST { id: "bn-<GUID>" } avec  Authorization: Bearer <jeton d'identité Ghost>.
// Contrôles : jeton signé par Ghost (JWKS) → e-mail → statut du membre dans Ghost (paid / comped)
//             → la vidéo est bien une exclusivité en ligne → lien d'embed signé, valable 6 h.
// La bibliothèque Bunny a « Embed view token authentication » activé : sans ce lien signé, la vidéo ne se lit pas.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { env, json, memberEmail, memberIsPaid, signedEmbed } from "./shared.ts";

const ALLOWED_ORIGINS = ["https://posthumain.com", "https://www.posthumain.com"];
const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });

function cors(origin: string): Record<string, string> {
  const h: Record<string, string> = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
  if (ALLOWED_ORIGINS.includes(origin)) h["Access-Control-Allow-Origin"] = origin;
  return h;
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin") || "";
  const h = cors(origin);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
  if (!ALLOWED_ORIGINS.includes(origin)) return json({ error: "origin_not_allowed" }, 403, h);
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405, h);

  let body: any = {};
  try { body = JSON.parse((await req.text()).slice(0, 4096) || "{}"); } catch { return json({ error: "bad_json" }, 400, h); }
  const guid = String(body?.id || "").replace(/^bn-/, "");
  if (!/^[A-Za-z0-9-]{8,64}$/.test(guid)) return json({ error: "bad_id" }, 400, h);

  const email = await memberEmail(req);
  if (!email) return json({ error: "unauthorized" }, 401, h);
  let paid = false;
  try { paid = await memberIsPaid(email); } catch (e) {
    console.warn("ghost member", String(e));
    return json({ error: "ghost_unavailable" }, 503, h);
  }
  if (!paid) return json({ error: "not_subscriber" }, 403, h);

  const { data: row } = await db.from("tv_videos").select("status, bunny_guid").eq("bunny_guid", guid).maybeSingle();
  if (!row || row.status !== "live") return json({ error: "not_available" }, 404, h);

  const e = await signedEmbed(guid);
  return json({ url: e.url, expires: e.expires }, 200, { ...h, "Cache-Control": "no-store" });
});
