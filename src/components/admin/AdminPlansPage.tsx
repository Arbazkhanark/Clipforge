import { PLAN_CATALOG, PLAN_IDS, BILLING_INTERVALS, formatPaiseAsRupees } from "../../lib/billing/catalog.ts";
import type { PlanDefinition } from "../../lib/billing/catalog.ts";
import { AdminShell } from "./AdminShell.tsx";
import { getRuntime } from "../../server/runtime.ts";
import { requireAdminPage } from "../../server/admin/page-authorization.ts";
import { ADMIN_FILTERS, parseAdminListQuery } from "../../server/admin/data-service.ts";
import type { AdminPlanEntitlementRow, AdminSubscriptionRow } from "../../server/admin/data-repository.ts";

type SearchParams = Record<string, string | string[] | undefined>;
const text = (value: string | string[] | undefined): string | undefined => Array.isArray(value) ? value[0] : value;
const human = (value: string): string => value.replaceAll("_", " ");
const date = (value: Date | null): string => value ? `${value.toLocaleString("en-IN", { timeZone: "UTC", dateStyle: "medium", timeStyle: "short" })} UTC` : "Not recorded";
const FEATURE_LABELS: Record<keyof PlanDefinition["features"], string> = {
  maxResolution: "Maximum export resolution", showDashboardAds: "Dashboard ads", googleDriveImport: "Google Drive import",
  advancedOrdering: "Advanced ordering", perAccountQueues: "Per-account queues", advancedSchedulingAndRepeat: "Advanced scheduling and repeat",
  smartPublishingAssistant: "Smart publishing assistant", jobLogsAndPriority: "Job logs and priority", analytics: "Analytics",
  collectionSharing: "Collection sharing", useSharedVideosInCycles: "Use shared videos in cycles", mixAndUnmix: "Mix and unmix",
};
const LIMIT_LABELS: Record<keyof PlanDefinition["limits"], string> = {
  connectedAccounts: "Connected accounts", storageBytes: "Storage", processingMinutesPerMonth: "Processing minutes / month",
  exportsPerMonth: "Exports / month", batchSize: "Batch size", concurrentJobs: "Concurrent jobs", templates: "Templates",
  activeCampaigns: "Active campaigns", scheduledItemsPerMonth: "Scheduled items / month",
};

export async function renderAdminPlansPage(searchParams: Promise<SearchParams>) {
  await requireAdminPage();
  const params = await searchParams;
  const input = new URLSearchParams();
  for (const key of ["page", "pageSize", "search", "status", "planId", "from", "to"]) { const value = text(params[key]); if (value !== undefined) input.set(key, value); }
  let queryError = "";
  let subscriptionQuery;
  try { subscriptionQuery = parseAdminListQuery(new URL(`http://admin.local/?${input.toString()}`), { status: ADMIN_FILTERS.subscriptionStatuses, plans: ADMIN_FILTERS.planIds }); }
  catch { queryError = "Some subscription filters were invalid. Showing the first page without filters."; subscriptionQuery = parseAdminListQuery(new URL("http://admin.local/")); }
  const userInput = new URLSearchParams();
  for (const [target, source] of [["page", "usersPage"], ["pageSize", "usersPageSize"], ["search", "usersSearch"]]) { const value = text(params[source!]); if (value !== undefined) userInput.set(target!, value); }
  let userQuery;
  try { userQuery = parseAdminListQuery(new URL(`http://admin.local/?${userInput.toString()}`)); }
  catch { userQuery = parseAdminListQuery(new URL("http://admin.local/")); }
  const runtime = getRuntime(); const service = runtime.adminData ? await runtime.adminData() : null;
  const [counts, subscriptions] = service ? await Promise.all([
    service.getSubscriptionCountsByPlan(), service.listSubscriptions(subscriptionQuery),
  ]) : [null, null];
  let entitlements: Awaited<ReturnType<NonNullable<typeof service>["listPlanEntitlements"]>> | null = null;
  let complimentarySetupRequired = false;
  if (service) {
    try { entitlements = await service.listPlanEntitlements(userQuery); }
    catch (error) {
      if (error instanceof Error && "code" in error && error.code === "complimentary_access_setup_required") complimentarySetupRequired = true;
      else throw error;
    }
  }
  const planFilter = subscriptionQuery.planId ?? ""; const statusFilter = subscriptionQuery.status ?? ""; const search = subscriptionQuery.search ?? "";
  const subscriptionHref = (page: number) => {
    const next = new URLSearchParams(); if (search) next.set("search", search); if (planFilter) next.set("planId", planFilter); if (statusFilter) next.set("status", statusFilter); next.set("page", String(page)); return `/admin/plans?${next.toString()}`;
  };
  const entitlementHref = (page: number) => {
    const next = new URLSearchParams(); const userSearch = userQuery.search ?? ""; if (userSearch) next.set("usersSearch", userSearch); next.set("usersPage", String(page)); return `/admin/plans?${next.toString()}#entitlements`;
  };
  return <AdminShell activeSection="plans" dataStatus={service ? "available" : "unavailable"}>
    <div className="admin-page-heading"><div><p className="admin-eyebrow">CLIPFORGE ADMIN</p><h1>Plans &amp; entitlements</h1><p>Configured plan catalog alongside stored subscription and access records.</p></div><span className="admin-readonly-pill">◉ Catalog is read-only</span></div>
    <div className="admin-billing-notice"><strong>Configuration and access are different facts</strong><span>Plan features and prices below come from the application catalog. They are not proof that a user currently has those features. User access is resolved separately from stored records; verified admins can manage permanent complimentary grants in the dedicated Complimentary access section.</span></div>
    <section className="admin-plan-catalog" aria-label="Configured plan catalog">
      <div className="admin-user-section"><h2>Application-configured plan definitions</h2><p>Source: server plan catalog. This configuration is not stored in the database and may differ from historical user agreements.</p></div>
      <div className="admin-plan-grid">{PLAN_IDS.map((id) => {
        const plan = PLAN_CATALOG[id];
        return <article className="admin-plan-card" key={id}>
          <div className="admin-plan-card-heading"><div><p className="admin-eyebrow">CONFIGURED PLAN</p><h3>{plan.name}</h3></div><span className="admin-plan-subscriber-count">{counts ? `${counts.byPlan[id]} current subscription row${counts.byPlan[id] === 1 ? "" : "s"}` : "Subscription count unavailable"}</span></div>
          <div className="admin-plan-prices">{BILLING_INTERVALS.map((interval) => <div key={interval}><span>{interval}</span><strong>{formatPaiseAsRupees(plan.pricePaise[interval])}</strong></div>)}</div>
          <details><summary>Configured limits and features</summary>
            <dl className="admin-plan-facts">{Object.entries(plan.limits).map(([key, value]) => <div key={key}><dt>{LIMIT_LABELS[key as keyof PlanDefinition["limits"]]}</dt><dd>{key === "storageBytes" ? `${value / (1024 ** 3)} GiB` : value}</dd></div>)}</dl>
            <ul className="admin-plan-features">{(Object.entries(plan.features) as [keyof PlanDefinition["features"], PlanDefinition["features"][keyof PlanDefinition["features"]]][]).map(([key, value]) => <li key={key}><span>{FEATURE_LABELS[key]}</span><strong>{typeof value === "boolean" ? value ? "Configured on" : "Configured off" : human(value)}</strong></li>)}</ul>
            <dl className="admin-plan-facts"><div><dt>Expiring sharing grants</dt><dd>{plan.sharing.expiringGrants ? "Configured on" : "Configured off"}</dd></div><div><dt>Delegated sharing management</dt><dd>{plan.sharing.delegatedManagement ? "Configured on" : "Configured off"}</dd></div><div><dt>Recipients per collection</dt><dd>{plan.sharing.maxRecipientsPerCollection}</dd></div></dl>
          </details>
        </article>;
      })}</div>
      {counts?.unknownPlanCount ? <p className="admin-user-empty">{counts.unknownPlanCount} stored subscription row(s) use an unrecognized plan ID.</p> : null}
      {PLAN_CATALOG.creator.sharing.maxRecipientsPerCollection === 5 && <p className="admin-user-footnote">Sharing recipient caps are marked as provisional in the catalog source; confirm these product limits before treating them as final policy.</p>}
    </section>
    <section className="admin-user-section admin-plan-subscriptions"><h2>Stored subscription records by plan</h2><p>Counts are current Subscription rows, not historical subscription records and not payment totals.</p>
      <form className="admin-user-filters" method="get" action="/admin/plans">
        <label>Search user or plan<input type="search" name="search" maxLength={100} defaultValue={search} placeholder="Search name, email, user ID or plan" /></label>
        <label>Plan filter<select name="planId" defaultValue={planFilter}><option value="">All plans (including unknown)</option>{PLAN_IDS.map((id) => <option value={id} key={id}>{PLAN_CATALOG[id].name}</option>)}</select></label>
        <label>Stored status<select name="status" defaultValue={statusFilter}><option value="">All statuses</option>{[...ADMIN_FILTERS.subscriptionStatuses].map((status) => <option value={status} key={status}>{human(status)}</option>)}</select></label>
        <button type="submit">Apply filters</button>
      </form>
      {queryError && <p className="admin-user-empty" role="status">{queryError}</p>}
      {!subscriptions ? <div className="admin-user-unavailable">Subscription records are unavailable. No sample users or plans are shown.</div>
        : subscriptions.items.length === 0 ? <div className="admin-user-unavailable">No stored subscription rows match these filters.</div>
        : <><div className="admin-user-table-wrap"><table className="admin-user-table"><thead><tr><th>Owner</th><th>Plan / interval</th><th>Stored status</th><th>Period end</th><th>Cancellation</th></tr></thead><tbody>{subscriptions.items.map((row: AdminSubscriptionRow) => <tr key={row.id}><td><strong>{row.ownerName || "Name unavailable"}</strong><small>{row.ownerEmail} · {row.userId}</small></td><td>{row.planId} · {row.interval}</td><td>{human(row.status)}</td><td>{date(row.currentPeriodEnd)}</td><td>{row.cancellationRequestedAt ? `Requested ${date(row.cancellationRequestedAt)}` : row.cancelAtPeriodEnd ? "At period end" : "None recorded"}</td></tr>)}</tbody></table></div><nav className="admin-user-pagination" aria-label="Subscription pages"><span>{subscriptions.total} current rows · Page {subscriptions.page}</span><div><a aria-disabled={subscriptions.page <= 1} href={subscriptions.page <= 1 ? undefined : subscriptionHref(subscriptions.page - 1)}>Previous</a><a aria-disabled={subscriptions.page * subscriptions.pageSize >= subscriptions.total} href={subscriptions.page * subscriptions.pageSize >= subscriptions.total ? undefined : subscriptionHref(subscriptions.page + 1)}>Next</a></div></nav></>}
    </section>
    <section id="entitlements" className="admin-user-section admin-plan-entitlements"><h2>User entitlement summary</h2><p>Effective access is calculated at request time using paid subscriptions, manual access, active complimentary grants, and existing promotion rules. Configured features are not copied here as per-user grants.</p>
      <form className="admin-user-filters" method="get" action="/admin/plans#entitlements"><label>Search user<input type="search" name="usersSearch" maxLength={100} defaultValue={userQuery.search ?? ""} placeholder="Name, email or user ID" /></label><button type="submit">Search users</button></form>
      {complimentarySetupRequired && <div className="admin-user-unavailable" role="alert"><strong>Complimentary access setup is incomplete.</strong><p>The required migration is not available, so user entitlement summaries cannot include complimentary grants. The migration has not been applied from this dashboard.</p></div>}
      {!entitlements ? <div className="admin-user-unavailable">User entitlement records are unavailable in this runtime.</div>
        : entitlements.items.length === 0 ? <div className="admin-user-unavailable">No users match this search.</div>
        : <><div className="admin-user-table-wrap"><table className="admin-user-table"><thead><tr><th>User</th><th>Effective plan</th><th>Entitlement source</th><th>Stored subscription state</th><th>Access end</th><th>Plan definition</th></tr></thead><tbody>{entitlements.items.map((row: AdminPlanEntitlementRow) => <tr key={row.userId}><td><strong>{row.name || "Name unavailable"}</strong><small>{row.email} · {row.userId}</small></td><td>{row.planDefinitionAvailable ? PLAN_CATALOG[row.planId as (typeof PLAN_IDS)[number]].name : "Unknown / unavailable"}</td><td><span className="admin-state-label">{human(row.source)}</span>{row.source === "manual_access" && <small>One-time access · does not auto-renew</small>}{row.source === "complimentary_access" && <small>Admin Granted — Permanent Free Access</small>}</td><td>{row.subscriptionStatus ? human(row.subscriptionStatus) : "No subscription row"}</td><td>{row.source === "manual_access" ? date(row.manualAccessExpiresAt) : row.source === "recurring_subscription" || row.source === "subscription_trial" ? date(row.subscriptionPeriodEnd) : "No currently entitled period"}</td><td>{row.planDefinitionAvailable ? row.inconsistentStoredPlan ? "Current plan known; another stored plan ID is inconsistent" : "Available" : "Unavailable; stored plan ID needs review"}</td></tr>)}</tbody></table></div><nav className="admin-user-pagination" aria-label="Entitlement user pages"><span>{entitlements.total} users · Page {entitlements.page}</span><div><a aria-disabled={entitlements.page <= 1} href={entitlements.page <= 1 ? undefined : entitlementHref(entitlements.page - 1)}>Previous</a><a aria-disabled={entitlements.page * entitlements.pageSize >= entitlements.total} href={entitlements.page * entitlements.pageSize >= entitlements.total ? undefined : entitlementHref(entitlements.page + 1)}>Next</a></div></nav></>}
    </section>
    <p className="admin-user-footnote">No subscription or plan records were changed. Payment history remains in Billing. Stored data has not been verified against a live Razorpay account or database migration state.</p>
  </AdminShell>;
}
