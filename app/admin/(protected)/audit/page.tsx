import { renderAdminAuditPage } from "../../../../src/components/admin/AdminAuditPages.tsx";

type SearchParams = Record<string, string | string[] | undefined>;

export default function AdminAuditPage({ searchParams }: { searchParams: Promise<SearchParams> }) { return renderAdminAuditPage(searchParams); }
