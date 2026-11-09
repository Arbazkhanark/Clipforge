import { CollectionDetailView } from "../../../src/components/CollectionViews.tsx";
import { ErrorState } from "../../../src/components/PageState.tsx";
import { FlashMessage } from "../../../src/components/FlashMessage.tsx";
import { parseFlash } from "../../../src/server/flash.ts";
import { loadPageData } from "../../../src/server/page-data.ts";
import { getSharedCollectionDetail } from "../../../src/server/queries.ts";
import { requireCustomerPage } from "../../../src/server/auth/customer-page.ts";

export const metadata = { title: "Shared collection", robots: { index: false, follow: false, noarchive: true }, referrer: "no-referrer" };
export const dynamic = "force-dynamic";

type Search = Record<string, string | string[] | undefined>;

export default async function SharedCollectionPage(props: { params: Promise<{ token: string }>; searchParams?: Promise<Search> }) {
  const { token } = await props.params;
  await requireCustomerPage(`/shared/${token}`);
  const search = await props.searchParams;
  const result = await loadPageData((ctx) => getSharedCollectionDetail(ctx, token, search));
  return <><FlashMessage flash={parseFlash(search)} />{result.ok ? <CollectionDetailView detail={result.data} /> : <ErrorState error={result.error} />}</>;
}
