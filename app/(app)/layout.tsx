import type { ReactNode } from "react";
import { AppShell } from "../../src/components/AppShell.tsx";
import { getRuntime } from "../../src/server/runtime.ts";
import { readGoogleOAuthConfig } from "../../src/server/auth/google-oauth.ts";

export const metadata = { robots: { index: false, follow: false, noarchive: true } };

export default async function AppLayout({ children }: { children: ReactNode }) {
  const runtime = getRuntime();
  const signedIn = (await runtime.currentUserId()) !== null;
  return <AppShell mode={runtime.mode} emailDelivery={runtime.emailDelivery} signedIn={signedIn} googleConfigured={readGoogleOAuthConfig() !== null}>{children}</AppShell>;
}
