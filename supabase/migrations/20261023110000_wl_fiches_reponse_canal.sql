-- Canal de la réponse choisi à la main dans la fiche (23/10/2026) : « Reçue par : e-mail / téléphone / en personne ».
-- Vide = déduit automatiquement (fil du mail, marqueur « reçue par téléphone ») ou « non précisé ».
alter table public.wl_fiches add column if not exists reponse_canal text check (reponse_canal in ('email', 'telephone', 'email+telephone', 'personne'));
