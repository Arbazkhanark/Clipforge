import { renderAdminBillingPage } from "../../../../src/components/admin/AdminBillingPages.tsx";

type SearchParams = Record<string, string | string[] | undefined>;
export default function AdminBillingPage({ searchParams = Promise.resolve({}) }: { searchParams?: Promise<SearchParams> } = {}) { return renderAdminBillingPage(searchParams); }
