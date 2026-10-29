import { CollectionDetailView } from "../../../../src/components/CollectionViews.tsx";
import { ErrorState } from "../../../../src/components/PageState.tsx";
import { loadPageData } from "../../../../src/server/page-data.ts";
import { getCollectionDetail } from "../../../../src/server/queries.ts";

export const metadata = { title: "Collection" };
export const dynamic = "force-dynamic";

// `params` is a plain object in older Next.js and a Promise in newer ones; `await` handles both.
export default async function CollectionPage(props: { params: Promise<{ collectionId: string }> | { collectionId: string } }) {
  const { collectionId } = await props.params;
  const result = await loadPageData((ctx) => getCollectionDetail(ctx, collectionId));
  return result.ok ? <CollectionDetailView detail={result.data} /> : <ErrorState error={result.error} />;
}
