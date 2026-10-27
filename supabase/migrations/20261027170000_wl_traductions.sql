-- Writinglab — traductions des mails pour l'équipe (27/10/2026).
-- Une ligne par texte traduit (clé = empreinte du texte, calculée de la même façon par la page et par wl-push).
-- Lue et écrite uniquement par la fonction wl-push (service role). Aucune IA du lab ne lit cette table :
-- les traductions ne servent qu'aux humains (Jonathan, les journalistes) ; les postes travaillent sur l'original.
create table if not exists public.wl_traductions (
  cle text primary key,
  traduction text,                       -- null si le texte était déjà en français
  langue_source text,
  deja_francais boolean not null default false,
  longueur int,
  modele text,
  cout_eur numeric,
  cree_par text,
  created_at timestamptz not null default now()
);
alter table public.wl_traductions enable row level security;  -- aucune politique : accès uniquement par les fonctions
revoke all on public.wl_traductions from anon, authenticated;
