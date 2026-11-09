import { AdminOffersClient } from "../../../../src/components/admin/AdminOffersClient.tsx";
import { requireAdminPage } from "../../../../src/server/admin/page-authorization.ts";

export default async function AdminOffersPage() {
  await requireAdminPage();
  return <AdminOffersClient />;
}
