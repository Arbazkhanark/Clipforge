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
import { getPlan } from "../../../src/lib/billing/catalog.ts";
import { requireUser } from "../../../src/server/context.ts";
import { CycleLimitExperience } from "../../../src/components/CycleLimitExperience.tsx";

export const metadata = { title: "Publishing cycles" };
export const dynamic = "force-dynamic";

type Search = { notice?: string; error?: string; collectionId?: string };

export default async function CyclesPage(props: {
  searchParams?: Promise<Search>;
}) {
  await requireCustomerPage("/cycles");
  const searchParams = await props.searchParams;
  const limitState = searchParams?.error === "plan_limit"
    ? await loadPageData(async (ctx) => {
      const userId = requireUser(ctx);
      const [planId, activeCycles, subscription] = await Promise.all([
        ctx.repo.getPlanIdForUser(userId, ctx.now),
        ctx.repo.countActiveCycles(userId),
        ctx.repo.getRazorpaySubscriptionForOwner(userId),
      ]);
      const plan = getPlan(planId);
      return {
        planId,
        planName: plan.name,
        activeCycles,
        cycleLimit: plan.limits.activeCampaigns,
        expiredSubscription: subscription?.status === "expired" && subscription.planId !== "free" && planId === "free"
          ? { planId: subscription.planId, status: subscription.status }
          : null,
      };
    })
    : null;
  const confirmedCycleLimit = limitState?.ok && limitState.data.activeCycles >= limitState.data.cycleLimit;
  if (confirmedCycleLimit && limitState.ok) {
    const flash = parseFlash(searchParams);
    return <>
      {flash?.kind !== "error" && <FlashMessage flash={flash} variant="toast" />}
      <CycleLimitExperience {...limitState.data} />
    </>;
  }
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
        <CreateCycleForm accounts={options.data.accounts} collections={options.data.collections} preselectedCollectionId={searchParams?.collectionId} />
      )}
      {overview.ok && !options.ok && <div className="cycles-error-panel"><ErrorState error={options.error} /></div>}
    </>
  );
}
