// app/(app)/layout.tsx
import type { ReactNode } from "react";
import { AppShell } from "../../src/components/AppShell.tsx";
import { getRuntime } from "../../src/server/runtime.ts";
import { isActiveTrial } from "../../src/lib/ui/trial-reminder.ts";
import { readGoogleOAuthConfig } from "../../src/server/auth/google-oauth.ts";

export const metadata = {
  robots: { index: false, follow: false, noarchive: true },
};

export default async function AppLayout({ children }: { children: ReactNode }) {
  const runtime = getRuntime();
  const userId = await runtime.currentUserId();
  const signedIn = userId !== null;
  let activeTrialEndsAt: number | null = null;
  if (userId) {
    try {
      const subscription = await runtime.repo.getRazorpaySubscriptionForOwner(userId);
      const nowUnix = Math.floor(Date.now() / 1000);
      if (subscription && isActiveTrial(subscription.status, subscription.trialEndsAt, nowUnix)) {
        activeTrialEndsAt = subscription.trialEndsAt;
      }
    } catch {
      // Trial presentation is optional; never let an unavailable read block the workspace.
    }
  }
  return (
    <AppShell
      mode={runtime.mode}
      signedIn={signedIn}
      googleConfigured={readGoogleOAuthConfig() !== null}
      activeTrialEndsAt={activeTrialEndsAt}
    >
      {children}
    </AppShell>
  );
}
