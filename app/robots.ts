import type { MetadataRoute } from "next";
import { getPublicSiteOrigin } from "../src/lib/site-metadata.ts";

export default function robots(): MetadataRoute.Robots {
  const origin = getPublicSiteOrigin();
  return {
    rules: [{
      userAgent: "*",
      allow: "/",
      disallow: ["/admin/", "/api/", "/dashboard", "/media/", "/collections/", "/cycles/", "/editor/", "/instagram", "/login", "/register", "/forgot-password", "/reset-password", "/verify-email", "/shared/", "/dev/"],
    }],
    ...(origin ? { sitemap: new URL("/sitemap.xml", origin).toString() } : {}),
  };
}
