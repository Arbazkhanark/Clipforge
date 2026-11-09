import { renderAdminAuditDetailsPage } from "../../../../../src/components/admin/AdminAuditPages.tsx";

export default async function AdminAuditEventPage({ params }: { params: Promise<{ auditId: string }> }) {
  const { auditId } = await params;
  return renderAdminAuditDetailsPage(auditId);
}
