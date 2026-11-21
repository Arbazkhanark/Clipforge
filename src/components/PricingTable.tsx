import { BILLING_INTERVALS, PLAN_CATALOG, PLAN_IDS, formatPaiseAsRupees, type BillingInterval, type PlanDefinition, type PlanId } from "../lib/billing/catalog.ts";
import { formatCount, formatStorage } from "./format.ts";
import { SubscriptionCheckoutButtons } from "./SubscriptionCheckoutButtons.tsx";

const SHARING_TEXT = { none: "No collection sharing", basic: "Basic sharing, direct use of shared videos, Mix/Unmix", advanced: "Advanced sharing: expiring access, delegated managers, higher recipient caps" } as const;

function limitRows(plan: PlanDefinition): [string, string][] {
  const l = plan.limits;
  return [
    ["Connected social accounts", formatCount(l.connectedAccounts)],
    ["Storage", formatStorage(l.storageBytes)],
    ["Processing minutes / month", formatCount(l.processingMinutesPerMonth)],
    ["Exports / month", formatCount(l.exportsPerMonth)],
    ["Batch size", `Up to ${formatCount(l.batchSize)}`],
    ["Concurrent jobs", formatCount(l.concurrentJobs)],
    ["Templates", formatCount(l.templates)],
    ["Active campaigns", formatCount(l.activeCampaigns)],
    ["Scheduled items / month", formatCount(l.scheduledItemsPerMonth)],
    ["Maximum resolution", plan.features.maxResolution === "original" ? "Original (1080p and above)" : plan.features.maxResolution],
    ["Collection sharing", SHARING_TEXT[plan.features.collectionSharing]],
    ["Dashboard ads", plan.features.showDashboardAds ? "Reserved for future placement; ads are not configured here" : "Not included"],
  ];
}

function featureRows(plan: PlanDefinition): [string, string][] {
  const f = plan.features;
  return [
    ["Google Drive imports", f.googleDriveImport ? "Included" : "Not included"],
    ["Advanced video ordering", f.advancedOrdering ? "Included" : "Not included"],
    ["Per-account publishing queues", f.perAccountQueues ? "Included" : "Not included"],
    ["Advanced scheduling and repeat", f.advancedSchedulingAndRepeat ? "Included" : "Not included"],
    ["Smart publishing assistant", f.smartPublishingAssistant ? "Included" : "Not included"],
    ["Job logs and priority", f.jobLogsAndPriority ? "Included" : "Not included"],
    ["Analytics", f.analytics ? "Included" : "Not included"],
    ["Use shared videos in cycles", f.useSharedVideosInCycles ? "Included" : "Not included"],
    ["Mix and Unmix", f.mixAndUnmix ? "Included" : "Not included"],
  ];
}

/**
 * Reads prices and limits ONLY from the central catalog. Weekly and monthly are separate choices.
 * `purchasable` is false until Razorpay is really connected - we never show a working Buy button early.
 */
export function PricingTable({ purchasable, subscriptionPurchasable, manualPurchasable, currentPlanId, activeCyclesUsed, preferredInterval = "monthly", previewOnly = false }: {
  purchasable?: boolean;
  subscriptionPurchasable?: boolean;
  manualPurchasable?: boolean;
  currentPlanId?: PlanId;
  activeCyclesUsed?: number;
  preferredInterval?: BillingInterval;
  /** Renders catalog data without mounting any checkout client behavior. For isolated visual previews only. */
  previewOnly?: boolean;
}) {
  const subscriptionsReady = subscriptionPurchasable ?? purchasable ?? false;
  const manualReady = manualPurchasable ?? purchasable ?? false;
  const resolvingPlanId = activeCyclesUsed === undefined
    ? null
    : PLAN_IDS.find((id) => PLAN_CATALOG[id].limits.activeCampaigns > activeCyclesUsed) ?? null;
  return (
    <section aria-labelledby="pricing-heading" className="pricing-comparison" data-preferred-interval={preferredInterval}>
      <h2 id="pricing-heading">Compare all plans</h2>
      {currentPlanId && <p className="pricing-context-note">Your current plan is <strong>{PLAN_CATALOG[currentPlanId].name}</strong>. Prices and checkout options below come from the ClipForge plan catalog.</p>}
      {(!subscriptionsReady || !manualReady) && <p role="note" className="notice">ClipForge is in development. Checkout stays unavailable until the relevant payment configuration is complete.</p>}
      <div className="plan-grid">
        {PLAN_IDS.map((id) => {
          const plan = PLAN_CATALOG[id];
          const isCurrent = id === currentPlanId;
          const resolvesLimit = id === resolvingPlanId && id !== currentPlanId;
          return (
            <article key={id} className={`plan-card pricing-card${id === "pro" ? " pricing-card-featured" : ""}${resolvesLimit ? " pricing-card-resolves-limit" : ""}`} data-plan={id} data-resolves-cycle-limit={resolvesLimit ? "true" : "false"}>
              <div className="pricing-card-heading"><h3>{plan.name}</h3><div>{isCurrent && <span className="pricing-plan-badge">Current plan</span>}{resolvesLimit && <span className="pricing-plan-badge pricing-plan-badge-upgrade">Fits your cycle usage</span>}</div></div>
              <dl className="prices">
                {BILLING_INTERVALS.map((interval) => (
                  <div key={interval} data-preferred={interval === preferredInterval ? "true" : "false"}>
                    <dt>{interval === "weekly" ? "Weekly" : "Monthly"}</dt>
                    <dd data-interval={interval}>{formatPaiseAsRupees(plan.pricePaise[interval])}</dd>
                  </div>
                ))}
              </dl>
              <h4>Limits</h4><ul className="pricing-card-list">{limitRows(plan).map(([name, value]) => <li key={name}><strong>{name}:</strong> {value}</li>)}</ul>
              <h4>Features</h4><ul className="pricing-card-list">{featureRows(plan).map(([name, value]) => <li key={name}><strong>{name}:</strong> {value}</li>)}</ul>
              {previewOnly
                ? <p className="pricing-preview-checkout-note" role="note">Checkout is disabled in this visual preview.</p>
                : <SubscriptionCheckoutButtons planId={id} subscriptionEnabled={subscriptionsReady} manualEnabled={manualReady} preferredInterval={preferredInterval} />}
            </article>
          );
        })}
      </div>
    </section>
  );
}
