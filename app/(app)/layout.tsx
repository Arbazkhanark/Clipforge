import type { ReactNode } from "react";
import { AppShell } from "../../src/components/AppShell.tsx";
import { getRuntime } from "../../src/server/runtime.ts";

export default function AppLayout({ children }: { children: ReactNode }) {
  const runtime = getRuntime();
  return <AppShell mode={runtime.mode} emailDelivery={runtime.emailDelivery}>{children}</AppShell>;
}
