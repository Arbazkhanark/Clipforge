import { renderAdminUsersPage } from "../../../../src/components/admin/AdminUsersPages.tsx";

export default function AdminUsersPage({ searchParams = Promise.resolve({}) }: { searchParams?: Promise<Record<string, string | string[] | undefined>> } = {}) {
  return renderAdminUsersPage(searchParams);
}
