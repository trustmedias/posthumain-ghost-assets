// Writinglab — boîtes mail ajoutées depuis le lab (23/10/2026) : rôles (bureaux) et fournisseurs. Copié à côté de wl-boites.
// Un rôle = le bureau qui reçoit et traite le courrier de la boîte. « tri » = le profil de tri déjà utilisé pour les boîtes historiques :
// redaction (partenariats, sponsorisés : comme redaction@) ou subs (abonnements, paiements : comme subs@).
// Pour ajouter un bureau plus tard : une ligne ici (actif:true) + son branchement dans la page.
export type Role = { id: string; nom: string; bureau: string; actif: boolean; tri?: "redaction" | "subs"; detail: string };
export const ROLES: Role[] = [
  { id: "mk", nom: "Marketing — Julien", bureau: "mk", actif: true, tri: "redaction", detail: "partenariats, articles sponsorisés, publicité (comme redaction@)" },
  { id: "sc", nom: "Service client — Julien", bureau: "sc", actif: true, tri: "subs", detail: "abonnements, paiements, accès au compte (comme subs@)" },
  { id: "compta", nom: "Le Comptable", bureau: "compta", actif: false, detail: "factures fournisseurs, relevés" },
  { id: "redaction", nom: "Rédaction (journaliste)", bureau: "journaliste", actif: false, detail: "interviews et réponses des chercheurs" },
];
export const role = (id: string) => ROLES.find((r) => r.id === id) || null;

// Serveurs pré-remplis. Sources : Infomaniak (réglages déjà utilisés par wl-mail pour les boîtes @posthumain.com) ;
// OVHcloud, guides officiels « MX Plan / Zimbra Starter » et « Zimbra — configurer son compte » (imap.mail.ovh.net:993 SSL,
// smtp.mail.ovh.net:465 SSL) et « Email Pro » (pro?.mail.ovh.net, IMAP 993 SSL, SMTP 587 STARTTLS).
// Le port 587 est refusé par l'hébergement des fonctions Supabase (seuls 465 et 993 passent) : Email Pro / Exchange en mode avancé.
export const FOURNISSEURS: Record<string, { nom: string; offres: Record<string, { nom: string; imap_host: string; imap_port: number; smtp_host: string; smtp_port: number; note?: string; numero?: boolean }> }> = {
  infomaniak: { nom: "Infomaniak", offres: { mail: { nom: "Service Mail", imap_host: "mail.infomaniak.com", imap_port: 993, smtp_host: "mail.infomaniak.com", smtp_port: 465 } } },
  ovh: { nom: "OVHcloud", offres: {
    mxplan: { nom: "MX Plan / Zimbra (le plus courant)", imap_host: "imap.mail.ovh.net", imap_port: 993, smtp_host: "smtp.mail.ovh.net", smtp_port: 465 },
    emailpro: { nom: "Email Pro", imap_host: "pro1.mail.ovh.net", imap_port: 993, smtp_host: "pro1.mail.ovh.net", smtp_port: 465, numero: true,
      note: "Le numéro de serveur (pro1, pro2…) figure dans l’espace client OVHcloud, onglet « Informations générales ». OVH annonce le SMTP sur le port 587, refusé par l’hébergement du lab : le test dira si le port 465 est accepté." },
  } },
};
export const PORTS_IMAP = [993, 143];
export const PORTS_SMTP = [465, 587];
export const idDe = (adresse: string) => ("x-" + adresse.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")).slice(0, 60);
