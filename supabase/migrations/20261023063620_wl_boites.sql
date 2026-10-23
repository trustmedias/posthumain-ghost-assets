-- Writinglab — boîtes mail ajoutées depuis le lab (23/10/2026). Les 4 boîtes historiques (@posthumain.com, secrets WL_SMTP_*) n'y sont PAS.
create table if not exists public.wl_boites (
  id text primary key,                         -- « x-info-trustmedias-com » (valeur de wl_courrier.boite pour cette boîte)
  adresse text not null unique,
  fournisseur text not null check (fournisseur in ('infomaniak', 'ovh', 'autre')),
  offre text,                                  -- ovh : mxplan | emailpro | exchange ; avancé : réglages corrigés à la main
  imap_host text not null, imap_port int not null default 993,
  smtp_host text not null, smtp_port int not null default 465,
  identifiant text,                            -- identifiant de connexion (par défaut : l'adresse)
  secret_id uuid,                              -- mot de passe dans Supabase Vault (jamais en clair ici)
  role text not null default 'aucun',          -- bureau : mk, sc (actifs) ; compta… (bientôt)
  nom_affiche text,                            -- nom de l'expéditeur (« Trust Medias »)
  actif boolean not null default true,
  statut text not null default 'nouveau' check (statut in ('nouveau', 'ok', 'erreur')),
  derniere_releve timestamptz, derniere_erreur text, erreur_depuis timestamptz, dernier_test timestamptz,
  uid_validity bigint, dernier_uid bigint, releve_verrou timestamptz,
  cree_par text, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
alter table public.wl_boites enable row level security;  -- aucune politique : accès uniquement par les fonctions (service role)
revoke all on public.wl_boites from anon, authenticated;

-- Mot de passe : Supabase Vault, via des fonctions réservées au service role (edge functions wl-boites et wl-mail).
create or replace function public.wl_boite_secret_ecrire(p_secret_id uuid, p_nom text, p_mdp text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v uuid;
begin
  if p_mdp is null or length(p_mdp) = 0 then raise exception 'mot de passe vide'; end if;
  if p_secret_id is null then
    v := vault.create_secret(p_mdp, p_nom, 'Writinglab — mot de passe de boîte mail');
  else
    perform vault.update_secret(p_secret_id, p_mdp);
    v := p_secret_id;
  end if;
  return v;
end $$;
create or replace function public.wl_boite_secret_lire(p_secret_id uuid)
returns text language sql security definer set search_path = '' stable as $$
  select decrypted_secret from vault.decrypted_secrets where id = p_secret_id
$$;
create or replace function public.wl_boite_secret_supprimer(p_secret_id uuid)
returns void language sql security definer set search_path = '' as $$
  delete from vault.secrets where id = p_secret_id
$$;
revoke all on function public.wl_boite_secret_ecrire(uuid, text, text) from public, anon, authenticated;
revoke all on function public.wl_boite_secret_lire(uuid) from public, anon, authenticated;
revoke all on function public.wl_boite_secret_supprimer(uuid) from public, anon, authenticated;
grant execute on function public.wl_boite_secret_ecrire(uuid, text, text) to service_role;
grant execute on function public.wl_boite_secret_lire(uuid) to service_role;
grant execute on function public.wl_boite_secret_supprimer(uuid) to service_role;

-- Relève par la fonction wl-boites toutes les 2 minutes, seulement s'il existe une boîte active (aucune exécution n8n).
insert into public.wl_reglages (cle, valeur, updated_at)
values ('boites_cron_secret', replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), now())
on conflict (cle) do nothing;
select cron.schedule('writinglab-boites-releve', '*/2 * * * *', $c$
  select net.http_post(
    url := 'https://jfmzhndapfmvdhphuwfm.supabase.co/functions/v1/wl-boites',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := jsonb_build_object('action', 'relever', 'secret', (select valeur from public.wl_reglages where cle = 'boites_cron_secret'))
  ) where exists (select 1 from public.wl_boites where actif and secret_id is not null);
$c$);
