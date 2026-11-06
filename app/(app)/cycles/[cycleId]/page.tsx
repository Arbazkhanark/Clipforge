import { CycleDetailView } from "../../../../src/components/CycleViews.tsx";
import { ErrorState } from "../../../../src/components/PageState.tsx";
import { FlashMessage } from "../../../../src/components/FlashMessage.tsx";
import { parseFlash } from "../../../../src/server/flash.ts";
import { loadPageData } from "../../../../src/server/page-data.ts";
import { readInstagramOAuthConfig } from "../../../../src/server/instagram/instagram-oauth.ts";
import { getCycleDetail } from "../../../../src/server/queries.ts";

export const metadata = { title: "Publishing cycle" };
export const dynamic = "force-dynamic";

type Search = Record<string, string | string[] | undefined>;

// `params`/`searchParams` are plain objects in older Next.js and Promises in newer ones; `await` handles both.
export default async function CyclePage(props: { params: Promise<{ cycleId: string }> | { cycleId: string }; searchParams?: Promise<Search> | Search }) {
  const { cycleId } = await props.params;
  const searchParams = await props.searchParams;
  const result = await loadPageData((ctx) => getCycleDetail(ctx, cycleId));
  return (
    <>
      <FlashMessage flash={parseFlash(searchParams)} />
      {result.ok ? <CycleDetailView detail={result.data} timeZone="Asia/Kolkata" instagramLoginConfigured={readInstagramOAuthConfig() !== null} /> : <ErrorState error={result.error} />}
    </>
  );
}
