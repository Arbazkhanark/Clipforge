import { renderAdminUserDetailsPage } from "../../../../../src/components/admin/AdminUsersPages.tsx";

export default async function AdminUserDetailsPage({ params }: { params: Promise<{ userId: string }> }) {
  const { userId } = await params;
  return renderAdminUserDetailsPage(userId);
}
