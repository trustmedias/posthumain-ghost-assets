// Posthumain TV — référencement : données structurées (JSON-LD) des pages vidéo, de /tv et de /tv/home.
// Tout est écrit dans le « Code injection → head » des pages Ghost, entre deux marqueurs, sans toucher au reste.
import { ghost } from "./shared.ts";

export const SITE = "https://posthumain.com";
export const TAG_FILTER = "tag:hash-version-longue";
export const TV_PAGE_SLUG = "tv";
export const LANDING_SLUG = "tv-home";
export const LANDING_PATH = "/tv/home/";
const START = "<!-- ph-tv-seo:start -->";
const END = "<!-- ph-tv-seo:end -->";

export const THEME_LABELS: Record<string, string> = {
  ia: "Intelligence artificielle", energie: "Énergie & économie", vivant: "Santé & vivant",
  cerveau: "Cerveau", espace: "Espace", danger: "Cyber & risques",
};
export const SERIES_LABELS: Record<string, string> = {
  comment: "Comment ça marche", pourquoi: "Pourquoi…", etsi: "Et si…", cout: "Ce que ça coûte vraiment", futur: "Le futur",
};

export type Meta = {
  source: "youtube" | "bunny"; youtube: string; bunny: string; exclusive: boolean; until: string;
  theme: string; series: string; duration: number; was: string;
};

function attr(tag: string, name: string): string {
  const m = new RegExp(`data-${name}="([^"]*)"`).exec(tag);
  return m ? m[1] : "";
}
export function parseMeta(html: string): Meta {
  const tag = (/<div[^>]*class="ph-video-meta"[^>]*>/.exec(html || "") || [""])[0];
  const yt = attr(tag, "youtube") || ((/youtube(?:-nocookie)?\.com\/embed\/([A-Za-z0-9_-]{11})/.exec(html || "") || [])[1]) || "";
  const bn = attr(tag, "bunny");
  let dur = parseFloat(attr(tag, "duration")) || 0;
  if (dur && dur < 30) dur *= 60;
  const theme = attr(tag, "theme");
  const series = attr(tag, "series");
  return {
    source: attr(tag, "source") === "bunny" && /^\d+\/[A-Za-z0-9-]{8,}$/.test(bn) ? "bunny" : "youtube",
    youtube: yt, bunny: bn, exclusive: attr(tag, "exclusive") === "1", until: attr(tag, "until"),
    theme: THEME_LABELS[theme] ? theme : "ia", series: SERIES_LABELS[series] ? series : "",
    duration: Math.round(dur), was: attr(tag, "was"),
  };
}

export function isoDuration(sec: number): string {
  sec = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return "PT" + (h ? `${h}H` : "") + (m ? `${m}M` : "") + (s || (!h && !m) ? `${s}S` : "");
}

// JSON dans un <script> : on neutralise « < » pour qu'aucun texte ne puisse fermer la balise
function ldScript(obj: unknown): string {
  return `<script type="application/ld+json">${JSON.stringify(obj).replace(/</g, "\\u003c")}</script>`;
}
export function withSeoBlock(existing: string | null, block: string): string {
  const cur = existing || "";
  const re = new RegExp(`${START}[\\s\\S]*?${END}\\n?`, "g");
  const rest = cur.replace(re, "").trim();
  const mine = block ? `${START}\n${block}\n${END}` : "";
  return [mine, rest].filter(Boolean).join("\n");
}
export function seoBlockOf(existing: string | null): string {
  const m = new RegExp(`${START}\\n?([\\s\\S]*?)\\n?${END}`).exec(existing || "");
  return m ? m[1] : "";
}

export type Org = { name: string; url: string; logo: string | null };

export function describe(p: any): string {
  return String(p.meta_description || p.custom_excerpt || p.excerpt || "").replace(/\s+/g, " ").trim().slice(0, 300);
}

export function videoLd(p: any, meta: Meta, org: Org) {
  const thumbs = [p.feature_image, meta.youtube ? `https://i.ytimg.com/vi/${meta.youtube}/maxresdefault.jpg` : null]
    .filter(Boolean);
  const ld: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "VideoObject",
    name: p.title,
    description: describe(p) || p.title,
    thumbnailUrl: thumbs,
    uploadDate: p.published_at || p.created_at,
    url: p.url,
    inLanguage: "fr",
    genre: THEME_LABELS[meta.theme],
    keywords: [THEME_LABELS[meta.theme], meta.series ? SERIES_LABELS[meta.series] : null, "documentaire", "Posthumain TV"].filter(Boolean).join(", "),
    publisher: { "@type": "Organization", name: org.name, url: org.url, ...(org.logo ? { logo: { "@type": "ImageObject", url: org.logo } } : {}) },
  };
  if (meta.duration) ld.duration = isoDuration(meta.duration);
  if (meta.source === "youtube" && meta.youtube) {
    ld.embedUrl = `https://www.youtube.com/embed/${meta.youtube}`;
    ld.isAccessibleForFree = true;
  } else {
    ld.isAccessibleForFree = false;
    ld.requiresSubscription = true;
  }
  if (meta.series) ld.isPartOf = { "@type": "CreativeWorkSeries", name: SERIES_LABELS[meta.series] };
  return ld;
}

export function itemList(videos: Array<{ url: string; title: string }>) {
  return {
    "@type": "ItemList",
    numberOfItems: videos.length,
    itemListElement: videos.slice(0, 50).map((v, i) => ({ "@type": "ListItem", position: i + 1, url: v.url, name: v.title })),
  };
}

export const FAQ: Array<[string, string]> = [
  ["Qu'est-ce que Posthumain TV ?",
    "Posthumain TV réunit tous les documentaires de Posthumain sur l'intelligence artificielle, la tech, la science et le futur, rangés par thème et lisibles en plein écran sur téléphone, ordinateur ou télévision."],
  ["Qu'est-ce qu'une exclusivité Posthumain TV ?",
    "Chaque semaine, un documentaire de 12 à 14 minutes sort d'abord sur Posthumain TV, réservé aux abonnés, trois mois avant sa mise en ligne sur YouTube."],
  ["Peut-on regarder Posthumain TV sur sa télé ?",
    "Oui. Lancez la lecture sur votre téléphone puis envoyez-la sur la télévision avec Chromecast ou AirPlay, ou ouvrez posthumain.com/tv directement sur le navigateur de la télé."],
  ["Combien coûte Posthumain TV ?",
    "Posthumain TV est inclus dans l'abonnement Posthumain, sans engagement, avec les enquêtes premium du site."],
  ["Est-ce que je retrouve où j'en étais ?",
    "Oui. La lecture reprend là où vous vous êtes arrêté et votre liste est synchronisée entre tous vos appareils."],
];

export function landingLd(videos: Array<{ url: string; title: string }>, org: Org, description: string) {
  return [
    {
      "@context": "https://schema.org",
      "@type": "CollectionPage",
      name: "Posthumain TV",
      description,
      url: SITE + LANDING_PATH,
      inLanguage: "fr",
      isPartOf: { "@type": "WebSite", name: org.name, url: org.url },
      mainEntity: itemList(videos),
    },
    {
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: FAQ.map(([q, a]) => ({ "@type": "Question", name: q, acceptedAnswer: { "@type": "Answer", text: a } })),
    },
  ];
}

export function tvPageLd(videos: Array<{ url: string; title: string }>, org: Org, description: string) {
  return {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: "Posthumain TV — catalogue",
    description,
    url: SITE + "/tv/",
    inLanguage: "fr",
    isAccessibleForFree: false,
    isPartOf: { "@type": "WebSite", name: org.name, url: org.url },
    mainEntity: itemList(videos),
  };
}

export function blockFor(ld: unknown | unknown[], noindex = false): string {
  const parts: string[] = [];
  if (noindex) parts.push('<meta name="robots" content="noindex, follow">');
  for (const o of Array.isArray(ld) ? ld : [ld]) parts.push(ldScript(o));
  return parts.join("\n");
}

let orgCache: { v: Org; exp: number } | null = null;
export async function getOrg(): Promise<Org> {
  if (orgCache && orgCache.exp > Date.now()) return orgCache.v;
  let logo: string | null = null, name = "Posthumain";
  try {
    const s = (await ghost(`/site/`))?.site || {};
    logo = s.icon || s.logo || null;
    name = s.title || name;
  } catch { /* valeurs par défaut */ }
  const v = { name, url: SITE + "/", logo };
  orgCache = { v, exp: Date.now() + 3600_000 };
  return v;
}
