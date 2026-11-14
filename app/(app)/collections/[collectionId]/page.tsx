import { CollectionDetailView } from "../../../../src/components/CollectionViews.tsx";
import { ErrorState } from "../../../../src/components/PageState.tsx";
import { FlashMessage } from "../../../../src/components/FlashMessage.tsx";
import { collectionCreatedMessage, parseFlash } from "../../../../src/server/flash.ts";
import { loadPageData } from "../../../../src/server/page-data.ts";
import { getCollectionDetail } from "../../../../src/server/queries.ts";
import { getRuntime } from "../../../../src/server/runtime.ts";
import { requireCustomerPage } from "../../../../src/server/auth/customer-page.ts";

export const metadata = { title: "Collection" };
export const dynamic = "force-dynamic";

type Search = Record<string, string | string[] | undefined>;

export default async function CollectionPage(props: { params: Promise<{ collectionId: string }>; searchParams?: Promise<Search> }) {
  const { collectionId } = await props.params;
  await requireCustomerPage(`/collections/${collectionId}`);
  const searchParams = await props.searchParams;
  const result = await loadPageData((ctx) => getCollectionDetail(ctx, collectionId, searchParams));
  const flash = parseFlash(searchParams);
  const shown = flash && searchParams?.notice === "collection_created"
    ? { ...flash, message: collectionCreatedMessage(getRuntime().mode) }
    : flash;
  return (
    <>
      <FlashMessage flash={shown} variant="toast" />
      {result.ok ? <CollectionDetailView detail={result.data} /> : <ErrorState error={result.error} />}
    </>
  );
}
