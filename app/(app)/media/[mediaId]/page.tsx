import { ErrorState } from "../../../../src/components/PageState.tsx";
import { MediaDetailView } from "../../../../src/components/MediaDetailView.tsx";
import { loadPageData } from "../../../../src/server/page-data.ts";
import { getMediaDetail } from "../../../../src/server/queries.ts";

export const metadata = { title: "File" };
export const dynamic = "force-dynamic";

export default async function MediaDetailPage(props: { params: Promise<{ mediaId: string }> | { mediaId: string } }) {
  const { mediaId } = await props.params;
  const result = await loadPageData((ctx) => getMediaDetail(ctx, mediaId));
  return result.ok ? <MediaDetailView detail={result.data} timeZone="Asia/Kolkata" /> : <ErrorState error={result.error} />;
}
