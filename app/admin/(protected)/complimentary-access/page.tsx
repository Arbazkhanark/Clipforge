import { AdminShell } from "../../../../src/components/admin/AdminShell.tsx";
import { ComplimentaryAccessAdmin } from "../../../../src/components/admin/ComplimentaryAccessAdmin.tsx";
import { requireAdminPage } from "../../../../src/server/admin/page-authorization.ts";

export default async function ComplimentaryAccessPage() {
  await requireAdminPage();
  return <AdminShell activeSection="complimentary-access">
    <div className="admin-page-heading"><div><p className="admin-eyebrow">CLIPFORGE ADMIN</p><h1>Complimentary access</h1><p>Manage permanent plan access independently from subscriptions and payments.</p></div></div>
    <ComplimentaryAccessAdmin />
  </AdminShell>;
}
