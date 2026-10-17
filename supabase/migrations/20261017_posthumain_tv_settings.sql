-- Posthumain TV : réglages du menu admin + synchro SEO horaire
create table if not exists public.tv_settings (
  key text primary key,
  value jsonb,
  updated_at timestamptz not null default now()
);
alter table public.tv_settings enable row level security;
revoke all on table public.tv_settings from anon, authenticated;
insert into public.tv_settings (key, value) values ('indexable', 'false'::jsonb) on conflict (key) do nothing;

select cron.unschedule('posthumain-tv-seo') where exists (select 1 from cron.job where jobname = 'posthumain-tv-seo');
select cron.schedule('posthumain-tv-seo', '7 * * * *', $cron$
  select net.http_post(
    url := 'https://jfmzhndapfmvdhphuwfm.supabase.co/functions/v1/tv-admin',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{"action": "seo_sync"}'::jsonb
  );
$cron$);
