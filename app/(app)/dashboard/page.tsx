import { DashboardView } from "../../../src/components/DashboardView.tsx";
import { ErrorState } from "../../../src/components/PageState.tsx";
import { loadPageData } from "../../../src/server/page-data.ts";
import { getDashboardData } from "../../../src/server/queries.ts";

export const metadata = { title: "Dashboard" };
export const dynamic = "force-dynamic"; // per-user data: never pre-rendered or cached

export default async function DashboardPage() {
  const result = await loadPageData((ctx) => getDashboardData(ctx));
  return result.ok ? <DashboardView data={result.data} /> : <ErrorState error={result.error} />;
}
