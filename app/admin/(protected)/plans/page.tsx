import { renderAdminPlansPage } from "../../../../src/components/admin/AdminPlansPage.tsx";

type SearchParams = Record<string, string | string[] | undefined>;
export default function AdminPlansPage({ searchParams = Promise.resolve({}) }: { searchParams?: Promise<SearchParams> } = {}) {
  return renderAdminPlansPage(searchParams);
}
