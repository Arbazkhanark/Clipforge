import { BatchStatus } from "../../../../src/components/BulkViews.tsx";
import { ErrorState } from "../../../../src/components/PageState.tsx";
import { FlashMessage } from "../../../../src/components/FlashMessage.tsx";
import { batchJobs, getRenderBatch } from "../../../../src/server/bulk/bulk-service.ts";
import { notFound } from "../../../../src/server/errors.ts";
import { parseFlash } from "../../../../src/server/flash.ts";
import { loadPageData } from "../../../../src/server/page-data.ts";
import { requireCustomerPage } from "../../../../src/server/auth/customer-page.ts";

export const metadata = { title: "Render batch" };
export const dynamic = "force-dynamic";

type Search = Record<string, string | string[] | undefined>;

export default async function BatchPage(props: { searchParams?: Promise<Search> }) {
  await requireCustomerPage("/editor/batch");
  const search = await props.searchParams;
  const batchId = typeof search?.["batch"] === "string" ? search["batch"] : "";
  const result = await loadPageData(async (ctx) => {
    const batch = getRenderBatch(batchId);
    if (!batch || batch.ownerId !== ctx.userId) throw notFound("Render batch");
    return batchJobs(ctx, batch);
  });
  return (
    <>
      <FlashMessage flash={result.ok && result.data.every((item) => item.status !== "queued" && item.status !== "processing") && parseFlash(search)?.message.startsWith("Rendering has started for the videos below") ? null : parseFlash(search)} />
      {result.ok ? <BatchStatus items={result.data} /> : <ErrorState error={result.error} />}
    </>
  );
}
