import { CycleDetailView } from "../../../../src/components/CycleViews.tsx";
import { ErrorState } from "../../../../src/components/PageState.tsx";
import { FlashMessage } from "../../../../src/components/FlashMessage.tsx";
import { parseFlash } from "../../../../src/server/flash.ts";
import { loadPageData } from "../../../../src/server/page-data.ts";
import { readInstagramOAuthConfig } from "../../../../src/server/instagram/instagram-oauth.ts";
import { getCycleDetail } from "../../../../src/server/queries.ts";
import { requireCustomerPage } from "../../../../src/server/auth/customer-page.ts";

export const metadata = { title: "Publishing cycle" };
export const dynamic = "force-dynamic";

type Search = Record<string, string | string[] | undefined>;

export default async function CyclePage(props: { params: Promise<{ cycleId: string }>; searchParams?: Promise<Search> }) {
  const { cycleId } = await props.params;
  await requireCustomerPage(`/cycles/${cycleId}`);
  const searchParams = await props.searchParams;
  const result = await loadPageData((ctx) => getCycleDetail(ctx, cycleId));
  return (
    <>
      <FlashMessage flash={parseFlash(searchParams)} />
      {result.ok ? <CycleDetailView detail={result.data} timeZone={result.data.cycle.timezone ?? "Asia/Kolkata"} instagramLoginConfigured={readInstagramOAuthConfig() !== null} /> : <ErrorState error={result.error} />}
    </>
  );
}
