import { notFound } from "next/navigation.js";
import { PLAN_CATALOG, type PlanId } from "../../src/lib/billing/catalog.ts";
import { CycleLimitExperience } from "../../src/components/CycleLimitExperience.tsx";
import { PricingTable } from "../../src/components/PricingTable.tsx";
import { PLAN_LIMIT_PREVIEW_PATH, planLimitPreviewEnabled } from "../../src/lib/ui/plan-limit-preview.ts";

export const dynamic = "force-dynamic";
export const metadata = { title: "Plan limit visual preview" };

type PreviewState = "limit" | "plans" | "expired" | "normal";
type PreviewSearch = { state?: string };

const STATES: { id: PreviewState; label: string }[] = [
  { id: "limit", label: "Cycle limit" },
  { id: "plans", label: "Upgrade plans" },
  { id: "expired", label: "Expired plan" },
  { id: "normal", label: "Active plan" },
];

function stateHref(state: PreviewState): string { return `${PLAN_LIMIT_PREVIEW_PATH}?state=${state}`; }

function PreviewNavigation({ state }: { state: PreviewState }) {
  return <nav className="plan-limit-preview-nav" aria-label="Preview states">
    {STATES.map((item) => <a key={item.id} href={stateHref(item.id)} aria-current={state === item.id ? "page" : undefined}>{item.label}</a>)}
  </nav>;
}

function ActivePlanPreview() {
  const planId: PlanId = "creator";
  const plan = PLAN_CATALOG[planId];
  const used = 1;
  return <section className="plan-limit-normal-preview" data-preview-state="normal" aria-labelledby="normal-plan-title">
    <p className="cycle-limit-eyebrow">Mock data · normal plan state</p>
    <h1 id="normal-plan-title">Publishing cycles</h1>
    <p className="plan-limit-normal-intro">A normal active plan leaves room to create another cycle. This preview uses only a fixed fixture.</p>
    <article className="plan-limit-normal-card">
      <div><span>Current plan</span><strong>{plan.name}</strong></div>
      <div><span>Active cycle usage</span><strong>{used} of {plan.limits.activeCampaigns}</strong></div>
      <div className="plan-limit-normal-progress" role="progressbar" aria-label="Active cycle usage" aria-valuemin={0} aria-valuemax={plan.limits.activeCampaigns} aria-valuenow={used}><span style={{ width: `${Math.round((used / plan.limits.activeCampaigns) * 100)}%` }} /></div>
      <p>Cycle capacity is available on this plan. No cycle can be created from this visual preview.</p>
    </article>
    <a className="cycle-limit-primary" href={stateHref("limit")}>Preview the cycle limit state <span aria-hidden="true">→</span></a>
  </section>;
}

export default async function PlanLimitPreviewPage(props: { searchParams?: Promise<PreviewSearch> } = {}) {
  if (!planLimitPreviewEnabled()) notFound();
  const search = await props.searchParams;
  const state: PreviewState = STATES.some((item) => item.id === search?.state) ? search?.state as PreviewState : "limit";

  return <div className="plan-limit-preview-page" data-preview-state={state}>
    <header className="plan-limit-preview-header">
      <div><p className="cycle-limit-eyebrow">Isolated visual QA · mock fixtures only</p><h1>Cycle limit & upgrade preview</h1><p>This route does not load the application repository, media storage, subscriptions, or checkout controls.</p></div>
      <span className="plan-limit-preview-safety"><span aria-hidden="true">●</span> Development preview</span>
    </header>
    <PreviewNavigation state={state} />

    {state === "limit" && <CycleLimitExperience
      planId="free"
      planName="Free"
      activeCycles={1}
      cycleLimit={1}
      expiredSubscription={null}
      explorePlansHref={stateHref("plans")}
      backToCyclesHref={stateHref("normal")}
    />}

    {state === "plans" && <section className="plan-limit-preview-plans" aria-labelledby="preview-plans-heading">
      <div className="plan-limit-preview-plans-heading"><div><p className="cycle-limit-eyebrow">Mock plan: Free · 1 of 1 active cycles</p><h2 id="preview-plans-heading">Explore all plans</h2><p>The catalog-backed comparison highlights the first plan with enough cycle capacity. Checkout is not mounted in this preview.</p></div><a className="cycle-limit-secondary" href={stateHref("normal")}>← Back to Cycles</a></div>
      <PricingTable currentPlanId="free" activeCyclesUsed={1} preferredInterval="monthly" previewOnly />
    </section>}

    {state === "expired" && <CycleLimitExperience
      planId="free"
      planName="Free"
      activeCycles={1}
      cycleLimit={1}
      expiredSubscription={{ planId: "creator", status: "expired" }}
      explorePlansHref={stateHref("plans")}
      backToCyclesHref={stateHref("normal")}
    />}

    {state === "normal" && <ActivePlanPreview />}
    <p className="plan-limit-preview-footnote">All displayed account, plan, cycle, and subscription details are deterministic mock fixtures. Preview navigation stays within this route.</p>
  </div>;
}
