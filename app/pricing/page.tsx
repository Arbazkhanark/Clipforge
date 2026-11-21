import { PricingTable } from "../../src/components/PricingTable.tsx";
import { readRazorpayTestConfig } from "../../src/server/billing/razorpay-client.ts";
import { publicPageMetadata } from "../../src/lib/site-metadata.ts";
import { isBillingInterval, isPlanId, type BillingInterval, type PlanId } from "../../src/lib/billing/catalog.ts";
import { getRuntime } from "../../src/server/runtime.ts";

export const metadata = publicPageMetadata({ title: "Plans and pricing", description: "Compare ClipForge plan prices and limits from the current product catalog.", path: "/pricing" });

type PricingSearch = { returnTo?: string; currentPlan?: string; activeCycles?: string; interval?: string };

export default async function PricingPage(props: { searchParams?: Promise<PricingSearch> } = {}) {
  const search = await props.searchParams;
  const returnToCycles = search?.returnTo === "cycles";
  const currentPlanId: PlanId | undefined = returnToCycles && typeof search?.currentPlan === "string" && isPlanId(search.currentPlan) ? search.currentPlan : undefined;
  const activeCyclesUsed: number | undefined = (() => {
    if (!returnToCycles || !search?.activeCycles || !/^\d{1,7}$/.test(search.activeCycles)) return undefined;
    const count = Number(search.activeCycles);
    return Number.isSafeInteger(count) && count >= 0 ? count : undefined;
  })();
  const preferredInterval: BillingInterval = typeof search?.interval === "string" && isBillingInterval(search.interval) ? search.interval : "monthly";
  const config = readRazorpayTestConfig();
  let complimentaryOnHold = false;
  try {
    const runtime = getRuntime();
    const userId = await runtime.currentUserId();
    if (userId) complimentaryOnHold = (await runtime.repo.getActiveComplimentaryAccessState(userId)) === "ON_HOLD";
  } catch { /* Pricing stays available even when account state cannot be loaded. */ }
  const subscriptionPurchasable = Boolean(config?.webhookSecret && config.subscriptionTotalCount && ["creator", "pro", "agency"].every((p) => config.subscriptionPlanIds[p as "creator" | "pro" | "agency"]?.weekly && config.subscriptionPlanIds[p as "creator" | "pro" | "agency"]?.monthly));
  return (
    <div className="public-page pricing-page">
      {returnToCycles && <a className="pricing-back-link" href="/cycles">← Back to cycles</a>}
      <header className="public-page-heading"><p className="eyebrow">Simple, visible plan limits</p><h1>Plans and pricing</h1><p className="public-page-intro">Prices are in Indian rupees. Weekly and monthly are separate choices; your billing interval never changes unless you change it.</p></header>
      {complimentaryOnHold && <p className="pricing-cycle-context" role="status">Your complimentary access is currently paused. Your normal plan limits and feature restrictions apply. You can choose a plan below.</p>}
      {activeCyclesUsed !== undefined && <p className="pricing-cycle-context" role="status">Comparing plans for {activeCyclesUsed} active {activeCyclesUsed === 1 ? "cycle" : "cycles"}. Plans with enough active-cycle capacity are marked for you.</p>}
      <PricingTable currentPlanId={currentPlanId} activeCyclesUsed={activeCyclesUsed} preferredInterval={preferredInterval} manualPurchasable={Boolean(config?.webhookSecret)} subscriptionPurchasable={subscriptionPurchasable} />
      <p className="pricing-page-note">Plan features and limits are read from the current catalog. Payment availability depends on server configuration.</p>
    </div>
  );
}
