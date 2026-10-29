import { CollectionsOverviewView } from "../../../src/components/CollectionViews.tsx";
import { ErrorState } from "../../../src/components/PageState.tsx";
import { loadPageData } from "../../../src/server/page-data.ts";
import { getCollectionsOverview } from "../../../src/server/queries.ts";

export const metadata = { title: "Collections" };
export const dynamic = "force-dynamic";

export default async function CollectionsPage() {
  const result = await loadPageData((ctx) => getCollectionsOverview(ctx));
  return result.ok ? <CollectionsOverviewView {...result.data} /> : <ErrorState error={result.error} />;
}
