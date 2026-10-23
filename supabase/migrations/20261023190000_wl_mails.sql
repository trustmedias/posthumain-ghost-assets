-- Writinglab — éditeur des mails marketing (23/10/2026) : historique des versions de chaque type de mail.
-- Les réglages par type (activé, jour, fréquence, délai, conservation) vivent dans wl_reglages (clé « mails:<type> »).
create table if not exists public.wl_mails_versions (
  id bigserial primary key,
  type text not null,
  contenu jsonb not null,          -- { sujet, blocs, mise_en_page } (bienvenue) ou { emplacements } (Grand Format)
  lexical text,                    -- lexical réellement écrit dans Ghost (bienvenue), pour détecter une modification faite dans Ghost
  note text,
  auteur text,
  created_at timestamptz not null default now()
);
create index if not exists wl_mails_versions_type_idx on public.wl_mails_versions (type, created_at desc);
alter table public.wl_mails_versions enable row level security;
revoke all on public.wl_mails_versions from anon, authenticated;
