// app/(app)/cycles
import { CreateCycleForm } from "../../../src/components/CycleForms.tsx";
import { CyclesOverviewView } from "../../../src/components/CycleViews.tsx";
import { ErrorState } from "../../../src/components/PageState.tsx";
import { FlashMessage } from "../../../src/components/FlashMessage.tsx";
import { parseFlash } from "../../../src/server/flash.ts";
import { loadPageData } from "../../../src/server/page-data.ts";
import {
  getCycleCreationOptions,
  getCyclesOverview,
} from "../../../src/server/queries.ts";
import { requireCustomerPage } from "../../../src/server/auth/customer-page.ts";

export const metadata = { title: "Publishing cycles" };
export const dynamic = "force-dynamic";

type Search = { notice?: string; error?: string };

export default async function CyclesPage(props: {
  searchParams?: Promise<Search>;
}) {
  await requireCustomerPage("/cycles");
  const searchParams = await props.searchParams;
  const [overview, options] = await Promise.all([
    loadPageData((ctx) => getCyclesOverview(ctx)),
    loadPageData((ctx) => getCycleCreationOptions(ctx)),
  ]);
  return (
    <>
      <FlashMessage flash={parseFlash(searchParams)} variant="toast" />
      {overview.ok ? (
        <CyclesOverviewView cycles={overview.data} />
      ) : (
        <div className="cycles-error-panel"><ErrorState error={overview.error} /></div>
      )}
      {overview.ok && options.ok && (
        <CreateCycleForm accounts={options.data.accounts} />
      )}
      {overview.ok && !options.ok && <div className="cycles-error-panel"><ErrorState error={options.error} /></div>}
    </>
  );
}
