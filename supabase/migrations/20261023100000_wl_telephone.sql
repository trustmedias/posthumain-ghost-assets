-- Writinglab — téléphone des bureaux et réponses par téléphone (23/10/2026).
-- wl_tel : fil de conversation de chaque membre avec chaque poste IA (☎️). wl_appels : appels / notes d'appel enregistrés comme réponse d'une fiche.
create table if not exists public.wl_tel (
  id bigint generated always as identity primary key,
  membre text not null,            -- membre de l'équipe (wl_equipe.id) qui appelle
  poste text not null,             -- fenêtre : secretaire | assistant | mk | sc | compta
  de text not null,                -- « moi » (le membre) ou le poste qui répond
  transmis_par text,               -- poste qui a transmis la requête (une seule transmission)
  mode text,                       -- faire | transmettre | question
  texte text not null default '',
  action jsonb,                    -- action proposée { type, params, fait?, resultat? }
  created_at timestamptz not null default now()
);
create index if not exists wl_tel_fil on public.wl_tel (membre, poste, created_at desc);
alter table public.wl_tel enable row level security;
revoke all on public.wl_tel from anon, authenticated;

create table if not exists public.wl_appels (
  id bigint generated always as identity primary key,
  fiche_id text not null,
  membre text not null,
  source text not null check (source in ('appel', 'notes')),  -- appel écouté (consentement) ou notes collées / dictées
  consentement boolean not null default false,
  transcription text,
  resume text,
  reponses jsonb,
  created_at timestamptz not null default now()
);
create index if not exists wl_appels_fiche on public.wl_appels (fiche_id);
alter table public.wl_appels enable row level security;
revoke all on public.wl_appels from anon, authenticated;
