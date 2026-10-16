-- Posthumain TV : documentaires exclusifs hébergés chez Bunny Stream (3 mois en exclusivité, puis YouTube).
-- Écrite uniquement par les fonctions tv-video / tv-play (service role). Aucun accès client.
create table if not exists public.tv_videos (
  key text primary key,                      -- identifiant interne « ph… » (aussi marqué dans le titre Bunny)
  ref text unique,                           -- identifiant fourni par l'usine (anti-doublon si n8n réessaie)
  bunny_guid text unique,
  bunny_library_id text,
  status text not null default 'fetching'
    check (status in ('fetching', 'encoding', 'live', 'promoted', 'error')),
  title text not null,
  slug text,
  excerpt text,
  description text,
  body_html text,
  source_url text not null,
  thumbnail_url text,
  feature_image text,
  theme text not null default 'ia',
  series text not null default '',
  duration integer,
  encode_progress integer,
  exclusive_days integer not null default 90 check (exclusive_days between 1 and 365),
  ghost_post_id text,
  ghost_url text,
  publish_at timestamptz,
  published_at timestamptz,
  exclusive_until timestamptz,
  youtube_id text,
  promoted_at timestamptz,
  error text,
  attempts integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists tv_videos_status_idx on public.tv_videos (status, exclusive_until);
alter table public.tv_videos enable row level security;
revoke all on table public.tv_videos from anon, authenticated;

-- Rattrapage toutes les 10 minutes (si un webhook Bunny se perd) — seulement s'il y a un docu en cours.
create extension if not exists pg_cron;
select cron.unschedule('posthumain-tv-sync') where exists (select 1 from cron.job where jobname = 'posthumain-tv-sync');
select cron.schedule(
  'posthumain-tv-sync',
  '*/10 * * * *',
  $cron$
  select net.http_post(
    url := 'https://jfmzhndapfmvdhphuwfm.supabase.co/functions/v1/tv-video',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{"action": "sync"}'::jsonb
  )
  where exists (select 1 from public.tv_videos where status in ('fetching', 'encoding'));
  $cron$
);
