-- Writinglab — base de connaissances (23/10/2026) : instructions, documents et sites web par domaine (rédaction, service
-- client, marketing… : domaines déclarés dans shared/wl-catalogue.json). Accès uniquement par la fonction wl-kb (service role).
create table if not exists public.wl_kb_instructions (
  domaine text primary key,
  contenu text not null default '',
  maj_par text,
  updated_at timestamptz not null default now()
);
create table if not exists public.wl_kb_sources (
  id uuid primary key default gen_random_uuid(),
  domaine text not null,
  type text not null check (type in ('doc', 'site')),
  nom text not null,
  url text,
  chemin text,
  mime text,
  taille integer,
  mode text,
  statut text not null default 'non_extrait' check (statut in ('envoi', 'non_extrait', 'extraction', 'extrait', 'erreur')),
  erreur text,
  pages_lues jsonb,
  caracteres integer,
  extrait_le timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists wl_kb_sources_domaine on public.wl_kb_sources (domaine, created_at);
create table if not exists public.wl_kb_resumes (
  id bigserial primary key,
  source_id uuid not null references public.wl_kb_sources(id) on delete cascade,
  domaine text not null,
  ordre integer not null default 0,
  titre text not null default '',
  contenu text not null default '',
  mots_cles text not null default '',
  tokens integer not null default 0,
  modifie_main boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  recherche tsvector generated always as (to_tsvector('french', coalesce(titre, '') || ' ' || coalesce(mots_cles, '') || ' ' || coalesce(contenu, ''))) stored
);
create index if not exists wl_kb_resumes_domaine on public.wl_kb_resumes (domaine, source_id, ordre);
create index if not exists wl_kb_resumes_recherche on public.wl_kb_resumes using gin (recherche);
alter table public.wl_kb_instructions enable row level security;
alter table public.wl_kb_sources enable row level security;
alter table public.wl_kb_resumes enable row level security;
revoke all on public.wl_kb_instructions, public.wl_kb_sources, public.wl_kb_resumes from anon, authenticated;
revoke all on sequence public.wl_kb_resumes_id_seq from anon, authenticated;

-- Sections pertinentes d'un domaine pour une requête (recherche plein texte en français) : utilisée quand les résumés dépassent le budget.
create or replace function public.wl_kb_chercher(p_domaine text, p_requete text, p_limite integer default 12)
returns table (id bigint, source_id uuid, titre text, contenu text, tokens integer, rang real)
language sql stable security definer set search_path = public as $$
  select r.id, r.source_id, r.titre, r.contenu, r.tokens,
         ts_rank(r.recherche, websearch_to_tsquery('french', coalesce(p_requete, ''))) as rang
  from public.wl_kb_resumes r
  where r.domaine = p_domaine
  order by rang desc, r.ordre asc
  limit greatest(1, least(coalesce(p_limite, 12), 40));
$$;
revoke all on function public.wl_kb_chercher(text, text, integer) from public, anon, authenticated;
grant execute on function public.wl_kb_chercher(text, text, integer) to service_role;
