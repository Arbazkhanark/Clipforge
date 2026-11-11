// app/(app)/collections
import { CollectionsOverviewView } from "../../../src/components/CollectionViews.tsx";
import { ErrorState } from "../../../src/components/PageState.tsx";
import { FlashMessage } from "../../../src/components/FlashMessage.tsx";
import { parseFlash } from "../../../src/server/flash.ts";
import { loadPageData } from "../../../src/server/page-data.ts";
import { getCollectionsOverview } from "../../../src/server/queries.ts";
import { requireCustomerPage } from "../../../src/server/auth/customer-page.ts";

export const metadata = { title: "Collections" };
export const dynamic = "force-dynamic";

type Search = { notice?: string; error?: string; q?: string; sort?: string };

export default async function CollectionsPage(props: { searchParams?: Promise<Search> }) {
  await requireCustomerPage("/collections");
  const searchParams = await props.searchParams;
  const result = await loadPageData((ctx) => getCollectionsOverview(ctx, searchParams));
  return (
    <>
      <FlashMessage flash={parseFlash(searchParams)} />
      {result.ok ? <CollectionsOverviewView {...result.data} /> : <ErrorState error={result.error} />}
    </>
  );
}
