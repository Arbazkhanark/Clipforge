type PublicPageMetadataInput = { title: string; description: string; path: string; indexable?: boolean };

/** Canonical origins are configured by the deployment; never guess the production hostname. */
export function getPublicSiteOrigin(): URL | undefined {
  const configured = process.env.NEXT_PUBLIC_SITE_URL;
  if (!configured) return undefined;
  try {
    const url = new URL(configured);
    if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") return undefined;
    return url;
  } catch { return undefined; }
}

export function publicPageMetadata({ title, description, path, indexable = true }: PublicPageMetadataInput) {
  const origin = getPublicSiteOrigin();
  const canonical = origin ? new URL(path, origin) : undefined;
  return {
    title,
    description,
    ...(canonical ? { alternates: { canonical }, openGraph: { title, description, type: "website" as const, url: canonical, siteName: "ClipForge" } } : { openGraph: { title, description, type: "website" as const, siteName: "ClipForge" } }),
    twitter: { card: "summary" as const, title, description },
    ...(indexable ? {} : { robots: { index: false, follow: false } }),
  };
}
