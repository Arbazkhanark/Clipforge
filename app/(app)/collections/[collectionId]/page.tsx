import { CollectionDetailView } from "../../../../src/components/CollectionViews.tsx";
import { ErrorState } from "../../../../src/components/PageState.tsx";
import { FlashMessage } from "../../../../src/components/FlashMessage.tsx";
import { parseFlash } from "../../../../src/server/flash.ts";
import { loadPageData } from "../../../../src/server/page-data.ts";
import { getCollectionDetail } from "../../../../src/server/queries.ts";

export const metadata = { title: "Collection" };
export const dynamic = "force-dynamic";

type Search = Record<string, string | string[] | undefined>;

export default async function CollectionPage(props: { params: Promise<{ collectionId: string }> | { collectionId: string }; searchParams?: Promise<Search> | Search }) {
  const { collectionId } = await props.params;
  const searchParams = await props.searchParams;
  const result = await loadPageData((ctx) => getCollectionDetail(ctx, collectionId, searchParams));
  return (
    <>
      <FlashMessage flash={parseFlash(searchParams)} />
      {result.ok ? <CollectionDetailView detail={result.data} /> : <ErrorState error={result.error} />}
    </>
  );
}
