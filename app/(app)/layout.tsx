import type { ReactNode } from "react";
import { AppShell } from "../../src/components/AppShell.tsx";
import { getRuntime } from "../../src/server/runtime.ts";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const runtime = getRuntime();
  const signedIn = (await runtime.currentUserId()) !== null;
  return <AppShell mode={runtime.mode} emailDelivery={runtime.emailDelivery} signedIn={signedIn}>{children}</AppShell>;
}
