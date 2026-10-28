-- Writinglab — enregistrement audio des interviews par téléphone (28/10/2026, demande de Jonathan).
-- Un appel = une session ; l'audio est enregistré par TRANCHES de 5 minutes (fichiers autonomes, lisibles seuls), chaque tranche
-- envoyée par MORCEAUX de 20 s pendant l'appel : si la page, le réseau ou l'ordinateur coupe, tout ce qui est arrivé est gardé
-- et la tranche en cours se reconstitue à partir de ses morceaux. Chaque tranche est retranscrite dès qu'elle est complète
-- (ElevenLabs Scribe, repli Gemini), donc un appel de 40 minutes ne fait jamais un seul gros traitement à la fin.
create table if not exists public.wl_appel_sessions (
  id uuid primary key default gen_random_uuid(),
  fiche_id text not null,
  membre text not null,
  lang text not null default 'fr',
  consentement boolean not null default false,
  statut text not null default 'en_cours' check (statut in ('en_cours', 'termine', 'coupe')),
  coupure text,                                  -- pourquoi et quand l'enregistrement s'est arrêté (si « coupe »)
  duree_ms bigint not null default 0,            -- durée connue de l'enregistrement
  mime text,
  derniere_activite timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists wl_appel_sessions_fiche on public.wl_appel_sessions (fiche_id, created_at desc);
alter table public.wl_appel_sessions enable row level security;
revoke all on public.wl_appel_sessions from anon, authenticated;

create table if not exists public.wl_appel_tranches (
  session_id uuid not null references public.wl_appel_sessions(id) on delete cascade,
  n int not null,                                -- numéro de la tranche (0, 1, 2…)
  debut_ms bigint not null default 0,            -- début de la tranche depuis le début de l'appel
  fin_ms bigint,                                 -- fin connue (dernier morceau reçu)
  morceaux int not null default 0,               -- morceaux reçus
  complete boolean not null default false,       -- dernier morceau reçu (ou tranche reconstituée après coupure)
  chemin text,                                   -- fichier audio assemblé (bucket writinglab)
  taille bigint,
  statut text not null default 'enregistrement' check (statut in ('enregistrement', 'a_transcrire', 'transcription', 'ok', 'erreur', 'vide')),
  moteur text,                                   -- scribe_v2 | gemini
  texte text,                                    -- transcription horodatée de la tranche
  mots jsonb,                                    -- mots horodatés (pour retirer le chevauchement entre tranches)
  erreur text,
  essais int not null default 0,
  updated_at timestamptz not null default now(),
  primary key (session_id, n)
);
alter table public.wl_appel_tranches enable row level security;
revoke all on public.wl_appel_tranches from anon, authenticated;

alter table public.wl_appels add column if not exists session_id uuid;
