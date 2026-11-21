import { PLAN_CATALOG, PLAN_IDS, type PlanId } from "../lib/billing/catalog.ts";

type Props = {
  planId: PlanId;
  planName: string;
  activeCycles: number;
  cycleLimit: number;
  expiredSubscription: { planId: PlanId; status: "expired" } | null;
};

function benefitsFor(currentPlanId: PlanId, activeCycles: number): string[] {
  const current = PLAN_CATALOG[currentPlanId];
  const next = PLAN_IDS.map((id) => PLAN_CATALOG[id]).find((plan) => plan.id !== currentPlanId && plan.limits.activeCampaigns > activeCycles);
  if (!next) return [
    `Your current plan includes ${current.limits.activeCampaigns} active cycles.`,
    `${current.limits.scheduledItemsPerMonth.toLocaleString("en-IN")} scheduled items each month.`,
    "Review plans for the full set of available features.",
  ];
  const benefits = [
    `Room for ${next.limits.activeCampaigns - activeCycles} more active ${next.limits.activeCampaigns - activeCycles === 1 ? "cycle" : "cycles"} (${next.limits.activeCampaigns} total).`,
    `${next.limits.scheduledItemsPerMonth.toLocaleString("en-IN")} scheduled items each month.`,
  ];
  const featureBenefit = next.features.maxResolution !== current.features.maxResolution
    ? `Exports up to ${next.features.maxResolution === "original" ? "original resolution" : next.features.maxResolution}.`
    : next.features.advancedSchedulingAndRepeat && !current.features.advancedSchedulingAndRepeat
      ? "Advanced scheduling and repeat controls."
      : next.features.analytics && !current.features.analytics
        ? "Publishing analytics."
        : next.features.googleDriveImport && !current.features.googleDriveImport
          ? "Google Drive imports."
          : next.features.collectionSharing === "advanced" && current.features.collectionSharing !== "advanced"
            ? "Advanced collection sharing controls."
            : null;
  if (featureBenefit) benefits.push(featureBenefit);
  return benefits.slice(0, 3);
}

function plansHref(planId: PlanId, activeCycles: number): string {
  const query = new URLSearchParams({ returnTo: "cycles", currentPlan: planId, activeCycles: String(activeCycles), interval: "monthly" });
  return `/pricing?${query.toString()}`;
}

export function CycleLimitExperience({ planId, planName, activeCycles, cycleLimit, expiredSubscription, explorePlansHref, backToCyclesHref }: Props & { explorePlansHref?: string; backToCyclesHref?: string }) {
  const expired = expiredSubscription !== null;
  const selectedPlan = planId;
  const usagePercent = Math.min(100, Math.round((activeCycles / Math.max(1, cycleLimit)) * 100));
  const benefits = benefitsFor(planId, activeCycles);
  const exploreHref = explorePlansHref ?? plansHref(selectedPlan, activeCycles);

  return (
    <section className="cycle-limit-experience" aria-labelledby="cycle-limit-title" data-state={expired ? "expired" : "limit"}>
      <div className="cycle-limit-orb cycle-limit-orb-one" aria-hidden="true" />
      <div className="cycle-limit-orb cycle-limit-orb-two" aria-hidden="true" />
      <div className="cycle-limit-content">
        <a className="cycle-limit-brand" href="/dashboard" aria-label="ClipForge dashboard"><span aria-hidden="true">C</span> ClipForge</a>
        <section className="cycle-limit-hero">
          <div className="cycle-limit-copy">
            <p className="cycle-limit-eyebrow"><span aria-hidden="true">✦</span> Publishing workspace</p>
            <h1 id="cycle-limit-title">{expired ? "Your plan has expired" : "You’re at your cycle limit"}</h1>
            <p className="cycle-limit-description">
              {expired
                ? `Your ${PLAN_CATALOG[expiredSubscription.planId]?.name ?? "previous"} plan subscription is marked expired. Review the available plans to restore access to its features.`
                : "Your current plan has reached its publishing cycle limit. Review your plan options or manage existing cycles to keep your content workflow moving."}
            </p>
            <div className="cycle-limit-actions">
              <a className="cycle-limit-primary" href={exploreHref}>{expired ? "View plans" : "Explore plans"}<span aria-hidden="true">↗</span></a>
              <a className="cycle-limit-secondary" href={backToCyclesHref ?? "/cycles"}>Back to cycles</a>
            </div>
            <p className="cycle-limit-reassurance"><span aria-hidden="true">✓</span> Reaching this limit does not delete your existing cycles or media.</p>
          </div>

          <aside className="cycle-limit-usage" aria-label="Cycle plan usage">
            <div className="cycle-limit-usage-heading"><span className="cycle-limit-usage-icon" aria-hidden="true">◷</span><span>{expired ? "Previous plan" : "Current plan"}</span></div>
            <p className="cycle-limit-plan-name">{planName}</p>
            {expired && <p className="cycle-limit-status">Previously active: {PLAN_CATALOG[expiredSubscription.planId]?.name ?? "Paid plan"} · Subscription status: {expiredSubscription.status}</p>}
            <div className="cycle-limit-count"><strong>{activeCycles}</strong><span>of</span><strong>{cycleLimit}</strong><small>active cycles</small></div>
            <div className="cycle-limit-progress" role="progressbar" aria-label="Active cycle usage" aria-valuemin={0} aria-valuemax={cycleLimit} aria-valuenow={Math.min(activeCycles, cycleLimit)}>
              <span style={{ width: `${usagePercent}%` }} />
            </div>
            <p className="cycle-limit-reached"><span aria-hidden="true">!</span> Cycle capacity reached</p>
          </aside>
        </section>

        <section className="cycle-limit-benefits" aria-labelledby="cycle-limit-benefits-title">
          <div><p className="cycle-limit-eyebrow">Keep your workflow moving</p><h2 id="cycle-limit-benefits-title">What’s included across plans</h2></div>
          <ul>{benefits.map((benefit) => <li key={benefit}><span aria-hidden="true">✓</span>{benefit}</li>)}</ul>
        </section>
        <p className="cycle-limit-footnote">Your cycles stay safe. You can also return and finish or remove an existing cycle before creating another.</p>
      </div>
    </section>
  );
}
