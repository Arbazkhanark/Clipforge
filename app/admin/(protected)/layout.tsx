import type { ReactNode } from "react";
import { requireAdminPage } from "../../../src/server/admin/page-authorization.ts";

export default async function ProtectedAdminLayout({ children }: { children: ReactNode }) {
  await requireAdminPage();
  return children;
}
