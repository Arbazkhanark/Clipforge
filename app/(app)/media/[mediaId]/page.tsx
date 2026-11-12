// app/(app)/media/[mediaId]/page.tsx
import { ErrorState } from "../../../../src/components/PageState.tsx";
import { MediaDetailView } from "../../../../src/components/MediaDetailView.tsx";
import { loadPageData } from "../../../../src/server/page-data.ts";
import { getMediaDetail } from "../../../../src/server/queries.ts";
import { requireCustomerPage } from "../../../../src/server/auth/customer-page.ts";

export const metadata = { title: "File" };
export const dynamic = "force-dynamic";

export default async function MediaDetailPage(props: {
  params: Promise<{ mediaId: string }>;
}) {
  const { mediaId } = await props.params;
  await requireCustomerPage(`/media/${mediaId}`);
  const result = await loadPageData((ctx) => getMediaDetail(ctx, mediaId));
  return result.ok ? (
    <MediaDetailView detail={result.data} timeZone="Asia/Kolkata" />
  ) : (
    <main className="media-page media-detail-page media-detail-error-page">
      <ErrorState error={result.error} />
    </main>
  );
}
