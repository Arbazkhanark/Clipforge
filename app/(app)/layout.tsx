import type { ReactNode } from "react";
import { AppShell } from "../../src/components/AppShell.tsx";
import { getRuntime } from "../../src/server/runtime.ts";

export default function AppLayout({ children }: { children: ReactNode }) {
  return <AppShell mode={getRuntime().mode}>{children}</AppShell>;
}
