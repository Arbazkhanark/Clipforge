import { CyclesOverviewView } from "../../../src/components/CycleViews.tsx";
import { ErrorState } from "../../../src/components/PageState.tsx";
import { loadPageData } from "../../../src/server/page-data.ts";
import { getCyclesOverview } from "../../../src/server/queries.ts";

export const metadata = { title: "Publishing cycles" };
export const dynamic = "force-dynamic";

export default async function CyclesPage() {
  const result = await loadPageData((ctx) => getCyclesOverview(ctx));
  return result.ok ? <CyclesOverviewView cycles={result.data} /> : <ErrorState error={result.error} />;
}
