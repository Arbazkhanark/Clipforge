// app/layout.tsx
import type { ReactNode } from "react";
import "./globals.css";
import { getRuntime } from "../src/server/runtime.ts";
import { PublicSiteChrome } from "../src/components/PublicSiteChrome.tsx";
import { getPublicSiteOrigin } from "../src/lib/site-metadata.ts";
import { PublicFooter } from "../src/components/PublicFooter.tsx";
import { headers } from "next/headers.js";
import { isPlanLimitPreviewRequest, PLAN_LIMIT_PREVIEW_HEADER } from "../src/lib/ui/plan-limit-preview.ts";

export const metadata = {
  metadataBase: getPublicSiteOrigin(),
  title: { default: "ClipForge — short-form video workflow", template: "%s | ClipForge" },
  description: "Organize short-form videos, prepare branded edits, and manage publishing campaigns in one workspace.",
  applicationName: "ClipForge",
  openGraph: { siteName: "ClipForge", type: "website", title: "ClipForge — short-form video workflow", description: "Organize short-form videos, prepare branded edits, and manage publishing campaigns in one workspace." },
  twitter: { card: "summary", title: "ClipForge — short-form video workflow", description: "Organize short-form videos, prepare branded edits, and manage publishing campaigns in one workspace." },
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const requestHeaders = await headers();
  const isolatedPreviewRequest = isPlanLimitPreviewRequest(requestHeaders.get(PLAN_LIMIT_PREVIEW_HEADER));
  const signedIn = isolatedPreviewRequest ? false : (await getRuntime().currentUserId()) !== null;
  return (
    <html lang="en">
      <body>
        <a href="#main" className="skip-link">Skip to main content</a>
        {!isolatedPreviewRequest && <PublicSiteChrome signedIn={signedIn} />}
        <main id="main">{children}</main>
        {!isolatedPreviewRequest && <PublicFooter />}
      </body>
    </html>
  );
}
