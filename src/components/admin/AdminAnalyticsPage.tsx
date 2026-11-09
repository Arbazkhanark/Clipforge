import { PLAN_CATALOG, PLAN_IDS } from "../../lib/billing/catalog.ts";
import { AdminShell } from "./AdminShell.tsx";
import { getRuntime } from "../../server/runtime.ts";
import { requireAdminPage } from "../../server/admin/page-authorization.ts";
import { parseAdminAnalyticsDateRange } from "../../server/admin/data-service.ts";
import type { AdminAnalyticsReport } from "../../server/admin/data-repository.ts";

type SearchParams = Record<string, string | string[] | undefined>;
const text = (value: string | string[] | undefined): string | undefined => Array.isArray(value) ? value[0] : value;
const day = (date: Date): string => date.toISOString().slice(0, 10);
const dateTime = (date: Date): string => `${date.toLocaleString("en-IN", { timeZone: "UTC", dateStyle: "medium", timeStyle: "short" })} UTC`;
const human = (value: string): string => value.replaceAll("_", " ");

export async function renderAdminAnalyticsPage(searchParams: Promise<SearchParams>) {
  await requireAdminPage();
  const params = await searchParams; const now = getRuntime().now();
  const defaultTo = day(now); const defaultFrom = day(new Date(now.getTime() - 29 * 86_400_000));
  const fromText = text(params.from) ?? defaultFrom; const toText = text(params.to) ?? defaultTo;
  let range = { from: new Date(`${defaultFrom}T00:00:00.000Z`), to: new Date(`${defaultTo}T23:59:59.999Z`) }; let queryError = "";
  try { range = parseAdminAnalyticsDateRange(new URL(`http://admin.local/?from=${encodeURIComponent(fromText)}&to=${encodeURIComponent(toText)}`)); }
  catch { queryError = "That date range is invalid. Showing the default recent range."; }
  const runtime = getRuntime(); const service = runtime.adminData ? await runtime.adminData() : null;
  const report = service ? await service.getAnalyticsReport(range.from, range.to) : null;
  const paramsCsv = new URLSearchParams({ from: day(range.from), to: day(range.to) });
  return <AdminShell activeSection="analytics" dataStatus={report ? "available" : "unavailable"}>
    <div className="admin-page-heading"><div><p className="admin-eyebrow">CLIPFORGE ADMIN</p><h1>Analytics</h1><p>Read-only trends from stored timestamps and current status fields.</p></div><span className="admin-readonly-pill">◉ Read-only</span></div>
    <form className="admin-user-filters" method="get" action="/admin/analytics">
      <label>From<input required type="date" name="from" defaultValue={day(range.from)} /></label>
      <label>To<input required type="date" name="to" defaultValue={day(range.to)} /></label>
      <button type="submit">Apply date range</button>
      {report && <a className="admin-analytics-export" href={`/api/admin/analytics/export?${paramsCsv.toString()}`}>Export CSV</a>}
    </form>
    {queryError && <p className="admin-user-empty" role="status">{queryError}</p>}
    {!report ? <div className="admin-user-unavailable">Analytics records are unavailable in this runtime. No sample trends or financial figures are shown.</div>
      : <AnalyticsReport report={report} />}
  </AdminShell>;
}

function AnalyticsReport({ report }: { report: AdminAnalyticsReport }) {
  return <div className="admin-analytics-report">
    <div className="admin-billing-notice"><strong>Historical limits</strong><span>Time series use record creation timestamps. The schema does not keep a complete status-change event history, so status charts show the currently stored state of matching records, not what their state was on each date. Instagram status is stored only; Meta was not checked.</span></div>
    {report.dataQuality.incompleteCollections.length > 0 && <div className="admin-analytics-warning" role="status"><strong>Some trend collections exceeded the safe read limit.</strong><span>Counts and daily rows for these collections are partial: {report.dataQuality.incompleteCollections.join(", ")}.</span></div>}
    <p className="admin-user-footnote">Range: {day(report.from)} through {day(report.to)} · report generated {dateTime(report.generatedAt)}. Current entitlement and all-current-subscription summaries are point-in-time snapshots, not limited to this range.</p>
    <section className="admin-analytics-section"><h2>Daily activity</h2><p>User registrations and campaign creations are grouped by stored createdAt. Publishing states are current stored states for attempts created on each day.</p>
      <div className="admin-user-table-wrap"><table className="admin-user-table"><thead><tr><th>Date</th><th>Registrations</th><th>Campaigns created</th><th>Queued</th><th>Attempted</th><th>Published (recorded)</th><th>Failed</th><th>Needs review</th></tr></thead><tbody>{report.series.map((row) => <tr key={row.day}><td>{row.day}</td><td>{row.registrations}</td><td>{row.campaignsCreated}</td><td>{row.publishingQueued}</td><td>{row.publishingAttempted}</td><td>{row.publishingRecorded}</td><td>{row.publishingFailed}</td><td>{row.publishingNeedsReview}</td></tr>)}</tbody></table></div>
      <p className="admin-user-result-count">{report.users.registrationsInRange} registrations · {report.campaigns.createdInRange} campaigns created · {report.publishing.attemptsCreatedInRange} publishing attempts created in range</p>
    </section>
    <div className="admin-analytics-grid">
      <MetricSection title="Campaign status snapshot" subtitle={`Current stored status for cycles created in range · ${report.campaigns.createdInRange} rows`} values={report.campaigns.currentStatusesForCyclesCreatedInRange} unrecognized={report.campaigns.unrecognizedStatusCount} />
      <MetricSection title="Publishing attempt states" subtitle={`Current state of attempts created in range · ${report.publishing.attemptsCreatedInRange} rows`} values={report.publishing.currentStateCounts} unrecognized={report.publishing.unclassifiedCount} label={(key) => key === "published_recorded" ? "Published (recorded)" : human(key)} />
      <MetricSection title="Instagram connection records" subtitle={`Stored status for account rows created in range · ${report.instagram.accountsCreatedInRange} rows`} values={report.instagram.storedStatusCounts} unrecognized={report.instagram.unrecognizedStatusCount} />
      <MetricSection title="Payment records" subtitle={`Stored payment status only · ${report.payments.paymentRecordsInRange} rows · no monetary totals`} values={report.payments.storedStatusCounts} unrecognized={report.payments.unrecognizedStatusCount} />
      <MetricSection title="Subscription records created in range" subtitle="Current stored status of those rows; not payment confirmation" values={report.subscriptions.currentStoredStatusCounts} />
      <MetricSection title="All current subscription rows by plan" subtitle="Current Subscription table rows across all dates; not historical subscriptions" values={report.subscriptions.allCurrentRowsByPlan} label={(key) => PLAN_CATALOG[key as keyof typeof PLAN_CATALOG]?.name ?? "Unknown plan"} unrecognized={report.subscriptions.unknownPlanRowCount} />
    </div>
    <section className="admin-analytics-section"><h2>Current user entitlements by plan</h2><p>Resolved at {dateTime(report.generatedAt)} using stored subscription, captured-payment and manual-access records. Payment rows alone are not counted as entitlements.</p>
      {!report.plans.complete ? <div className="admin-user-unavailable">Current entitlement summary is unavailable: {report.plans.unavailableReason || "the bounded read was incomplete"}</div> : <>
        <div className="admin-analytics-plan-grid">{PLAN_IDS.map((planId) => <article className="admin-analytics-plan-card" key={planId}><span>{PLAN_CATALOG[planId].name}</span><strong>{report.plans.byPlan[planId]}</strong><small>users resolved to this plan now</small></article>)}</div>
        <MetricSection title="Entitlement source" subtitle={`${report.plans.totalUsers} users · ${report.plans.inconsistentEntitlements} inconsistent eligible records`} values={report.plans.bySource} label={human} />
      </>}
    </section>
    <section className="admin-analytics-section"><h2>Unavailable financial metrics</h2><p>Refund amounts, gateway fees, taxes, gross revenue, profit and net income are not calculated because authoritative stored inputs are unavailable. No estimates are shown.</p></section>
    <p className="admin-user-footnote">Data-quality disclosure: historical status transitions are not stored. Refund/fee/tax breakdowns are not stored. Query collections are capped at 5,000 rows each; truncated series are explicitly marked above.</p>
  </div>;
}

function MetricSection({ title, subtitle, values, unrecognized = 0, label = human }: { title: string; subtitle: string; values: Record<string, number>; unrecognized?: number; label?: (key: string) => string }) {
  const entries = Object.entries(values);
  return <section className="admin-analytics-metric"><h2>{title}</h2><p>{subtitle}</p>{entries.length === 0 ? <span className="admin-user-empty">No stored summary available.</span> : <ul>{entries.map(([key, value]) => <li key={key}><span>{label(key)}</span><strong>{value}</strong></li>)}</ul>}{unrecognized > 0 && <small>{unrecognized} rows have unrecognized stored values.</small>}</section>;
}
