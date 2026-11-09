import { renderAdminInstagramAccountPage } from "../../../../../src/components/admin/AdminInstagramPages.tsx";

export default async function AdminInstagramAccountPage({ params }: { params: Promise<{ accountId: string }> }) {
  const { accountId } = await params;
  return renderAdminInstagramAccountPage(accountId);
}
