import type { MetadataRoute } from "next";
import { getPublicSiteOrigin } from "../src/lib/site-metadata.ts";

const INDEXABLE_PATHS = ["/", "/about", "/features", "/how-it-works", "/help", "/pricing"] as const;

export default function sitemap(): MetadataRoute.Sitemap {
  const origin = getPublicSiteOrigin();
  if (!origin) return [];
  return INDEXABLE_PATHS.map((path) => ({ url: new URL(path, origin).toString(), changeFrequency: path === "/" ? "weekly" : "monthly", priority: path === "/" ? 1 : path === "/pricing" ? 0.8 : 0.65 }));
}
