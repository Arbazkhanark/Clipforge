import { renderAdminInstagramAccountsPage } from "../../../../src/components/admin/AdminInstagramPages.tsx";

export default function AdminInstagramPage({ searchParams = Promise.resolve({}) }: { searchParams?: Promise<Record<string, string | string[] | undefined>> } = {}) {
  return renderAdminInstagramAccountsPage(searchParams);
}
