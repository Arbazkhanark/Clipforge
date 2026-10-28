import { BILLING_INTERVALS, PLAN_CATALOG, PLAN_IDS, formatPaiseAsRupees, type PlanDefinition } from "../lib/billing/catalog.ts";
import { formatCount, formatStorage } from "./format.ts";

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
    ["Dashboard ads", plan.features.showDashboardAds ? "Yes" : "No"],
  ];
}

/**
 * Reads prices and limits ONLY from the central catalog. Weekly and monthly are separate choices.
 * `purchasable` is false until Razorpay is really connected - we never show a working Buy button early.
 */
export function PricingTable({ purchasable = false }: { purchasable?: boolean }) {
  return (
    <section aria-labelledby="pricing-heading">
      <h2 id="pricing-heading">Plans</h2>
      {!purchasable && <p role="note" className="notice">ClipForge is in early development. Plans cannot be purchased yet, and not every feature listed is available yet.</p>}
      <div className="plan-grid">
        {PLAN_IDS.map((id) => {
          const plan = PLAN_CATALOG[id];
          return (
            <article key={id} className="plan-card" data-plan={id}>
              <h3>{plan.name}</h3>
              <dl className="prices">
                {BILLING_INTERVALS.map((interval) => (
                  <div key={interval}>
                    <dt>{interval === "weekly" ? "Weekly" : "Monthly"}</dt>
                    <dd data-interval={interval}>{formatPaiseAsRupees(plan.pricePaise[interval])}</dd>
                  </div>
                ))}
              </dl>
              <ul>{limitRows(plan).map(([name, value]) => <li key={name}><strong>{name}:</strong> {value}</li>)}</ul>
              <button type="button" disabled={!purchasable}>{purchasable ? (id === "free" ? "Start free" : `Choose ${plan.name}`) : "Not available yet"}</button>
            </article>
          );
        })}
      </div>
    </section>
  );
}
