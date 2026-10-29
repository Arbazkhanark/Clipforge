import { CycleDetailView } from "../../../../src/components/CycleViews.tsx";
import { ErrorState } from "../../../../src/components/PageState.tsx";
import { loadPageData } from "../../../../src/server/page-data.ts";
import { getCycleDetail } from "../../../../src/server/queries.ts";

export const metadata = { title: "Publishing cycle" };
export const dynamic = "force-dynamic";

export default async function CyclePage(props: { params: Promise<{ cycleId: string }> | { cycleId: string } }) {
  const { cycleId } = await props.params;
  const result = await loadPageData((ctx) => getCycleDetail(ctx, cycleId));
  return result.ok ? <CycleDetailView detail={result.data} timeZone="Asia/Kolkata" /> : <ErrorState error={result.error} />;
}
