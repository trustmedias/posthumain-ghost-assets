-- Writinglab (23/10/2026) : réponse dans le fil d'une fiche d'interview (capacité suite_interview) + téléphone du membre.
alter table public.wl_equipe add column if not exists telephone text;
alter table public.wl_fiches
  add column if not exists suite_sujet text,
  add column if not exists suite_corps text,
  add column if not exists suite_consigne text,
  add column if not exists suite_a text,
  add column if not exists suite_prete_le timestamptz,
  add column if not exists suite_verrou timestamptz,
  add column if not exists suites jsonb not null default '[]'::jsonb;
comment on column public.wl_fiches.suite_corps is 'Brouillon de réponse dans le fil (capacité suite_interview), à valider dans la fiche avant envoi';
comment on column public.wl_fiches.suites is 'Réponses envoyées dans le fil après la réponse du contact : [{le, a, sujet, message_id, par}]';
comment on column public.wl_equipe.telephone is 'Numéro donné aux contacts quand le membre le demande (facultatif)';
