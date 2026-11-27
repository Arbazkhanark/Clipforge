import { AdminShell, type AdminSectionId } from "./AdminShell.tsx";
import { requireAdminPage } from "../../server/admin/page-authorization.ts";
import { getRuntime } from "../../server/runtime.ts";
import type { AdminOverview } from "../../server/admin/data-repository.ts";

const SECTION_COPY: Record<Exclude<AdminSectionId, "overview">, { title: string; description: string; emptyTitle: string; emptyDescription: string; icon: string }> = {
  users: {
    title: "Users", description: "Review account activity and user records.",
    emptyTitle: "User data is not connected", emptyDescription: "User records will appear here after a verified read-only data source is connected.", icon: "♙",
  },
  campaigns: {
    title: "Campaigns", description: "Monitor publishing cycles and campaign progress.",
    emptyTitle: "Campaign data is not connected", emptyDescription: "Cycle and publishing status will appear here when the live data source is available.", icon: "▣",
  },
  plans: {
    title: "Plans", description: "Review configured plan definitions and stored entitlement records.",
    emptyTitle: "Plan data is not connected", emptyDescription: "Plan access summaries remain unavailable until stored subscription and manual access records can be read.", icon: "◇",
  },
  "complimentary-access": {
    title: "Complimentary access", description: "Grant and manage permanent complimentary access for a user.",
    emptyTitle: "Complimentary access controls have a dedicated page", emptyDescription: "Use the dedicated complimentary access page to grant, hold, resume, revoke and inspect audit history.", icon: "✦",
  },
  offers: {
    title: "Offers", description: "Manage coupon definitions and lifecycle status.",
    emptyTitle: "Offers are not available here", emptyDescription: "Use the protected Offers page to manage draft coupon definitions.", icon: "%",
  },
  instagram: {
    title: "Instagram", description: "Review connected account health and publishing readiness.",
    emptyTitle: "Account monitoring is not connected", emptyDescription: "No account status is shown until verified account data is available.", icon: "◎",
  },
  billing: {
    title: "Billing", description: "Review billing records and subscription activity.",
    emptyTitle: "Billing data is not connected", emptyDescription: "No revenue, payments, refunds, or fees are displayed until verified billing records are available.", icon: "◈",
  },
  analytics: {
    title: "Analytics", description: "Explore platform trends from verified records.",
    emptyTitle: "Analytics are not connected", emptyDescription: "Charts will be available after an approved source of verified platform data is connected.", icon: "⌁",
  },
  reports: {
    title: "Reports", description: "Review publishing issues and platform reports.",
    emptyTitle: "Reports are not connected", emptyDescription: "There are no report records to show in this read-only preview.", icon: "▤",
  },
  settings: {
    title: "Settings", description: "Review platform configuration.",
    emptyTitle: "Platform settings are not connected", emptyDescription: "Settings are not editable in this read-only dashboard phase.", icon: "⚙",
  },
  audit: {
    title: "Audit Logs", description: "Review recorded administrative and platform activity.",
    emptyTitle: "Audit records are not connected", emptyDescription: "Audit entries will appear here when a verified read-only data source is available.", icon: "◷",
  },
};

function PageHeading({ title, description }: { title: string; description: string }) {
  return (
    <div className="admin-page-heading">
      <div><p className="admin-eyebrow">CLIPFORGE ADMIN</p><h1>{title}</h1><p>{description}</p></div>
      <span className="admin-readonly-pill"><span aria-hidden="true">◉</span> Read-only</span>
    </div>
  );
}

function OverviewContent({ overview }: { overview: AdminOverview | null }) {
  const cards = overview ? [
    { label: "Registered users", value: overview.users.registered.toLocaleString(), description: "User accounts in the database", icon: "♙", href: "/admin/users" },
    ...(overview.users.suspended === null ? [] : [{ label: "Suspended users", value: overview.users.suspended.toLocaleString(), description: "Suspension records; data is preserved", icon: "⏸", href: "/admin/users" }]),
    { label: "Publishing cycles", value: overview.cycles.total.toLocaleString(), description: `${overview.cycles.deleted.toLocaleString()} deleted · stored cycles across all statuses`, icon: "▣", href: "/admin/campaigns" },
    { label: "Instagram accounts", value: overview.instagram.totalStoredAccounts.toLocaleString(), description: "Stored connections; Meta not queried", icon: "◎", href: "/admin/instagram" },
    { label: "Publishing jobs", value: overview.publishing.totalAttempts.toLocaleString(), description: "Stored job records, not live status", icon: "↗", href: "/admin/analytics" },
    { label: "Payment records", value: overview.billing.paymentRecordCount.toLocaleString(), description: "Stored records; revenue unavailable", icon: "₹", href: "/admin/billing" },
  ] : [];
  return (
    <>
      <div className={`admin-overview-banner ${overview ? "admin-overview-connected" : ""}`} role="status">
        <span className="admin-banner-icon" aria-hidden="true">{overview ? "✓" : "i"}</span>
        <div><strong>{overview ? "Database connected" : "Live data is unavailable"}</strong><p>{overview ? "Counts below come from stored ClipForge records. External providers are not queried here." : "Connect an available Admin data source to show real platform totals. No sample values are displayed."}</p></div>
        <span className="admin-connection-badge">{overview ? "Stored data" : "Unavailable"}</span>
      </div>
      {overview ? <>
        <div className="admin-overview-kpis" aria-label="Live platform totals">
        {cards.map((card) => (
          <article className="admin-summary-card" key={card.label}>
            <div className="admin-summary-card-top"><span className="admin-summary-icon" aria-hidden="true">{card.icon}</span><a className="admin-kpi-open" href={card.href}>View ↗</a></div>
            <p className="admin-kpi-label">{card.label}</p><strong className="admin-kpi-value">{card.value}</strong><p>{card.description}</p>
          </article>
        ))}
        </div>
        <div className="admin-dashboard-sections">
          <section className="admin-dashboard-panel"><div className="admin-dashboard-panel-heading"><div><p className="admin-eyebrow">OPERATIONS</p><h2>Publishing cycles</h2></div><a href="/admin/campaigns">View campaigns →</a></div><div className="admin-status-list">{Object.entries(overview.cycles.byStatus).map(([status, count]) => <div key={status}><span>{status.replaceAll("_", " ")}</span><strong>{count.toLocaleString()}</strong></div>)}<div><span>deleted</span><strong>{overview.cycles.deleted.toLocaleString()}</strong></div></div><p className="admin-dashboard-disclosure">Deleted cycles are shown separately from user-stopped cycles. Status counts exclude tombstones.</p></section>
          <section className="admin-dashboard-panel"><div className="admin-dashboard-panel-heading"><div><p className="admin-eyebrow">CONNECTED ACCOUNTS</p><h2>Instagram status</h2></div><a href="/admin/instagram">View accounts →</a></div><div className="admin-status-list">{Object.entries(overview.instagram.byStoredStatus).map(([status, count]) => <div key={status}><span>{status.replaceAll("_", " ")}</span><strong>{count.toLocaleString()}</strong></div>)}</div><p className="admin-dashboard-disclosure">Stored account statuses; Meta is not contacted.</p></section>
          <section className="admin-dashboard-panel"><div className="admin-dashboard-panel-heading"><div><p className="admin-eyebrow">BILLING</p><h2>Payment records</h2></div><a href="/admin/billing">Open billing →</a></div><div className="admin-status-list">{Object.entries(overview.billing.recordsByRecognizedStoredStatus).map(([status, count]) => <div key={status}><span>{status.replaceAll("_", " ")}</span><strong>{count.toLocaleString()}</strong></div>)}</div><p className="admin-dashboard-disclosure">Revenue and monetary summaries are unavailable; no estimates are shown.</p></section>
        </div>
        <section className="admin-overview-note"><div><p className="admin-eyebrow">DATA LIMITATIONS</p><h2>What these totals mean</h2><p>These figures are read from stored records. Active-user, entitlement, revenue, fee, tax, and recent activity summaries are not available from the current verified overview data.</p></div><span className="admin-source-indicator"><span className="admin-status-dot" /> Updated {overview.generatedAt.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}</span></section>
      </> : <section className="admin-empty-state"><span className="admin-empty-icon" aria-hidden="true">⌁</span><span className="admin-empty-badge">Database unavailable</span><h2>Dashboard data could not be loaded</h2><p>No statistics are fabricated. Check Admin database availability and try again later.</p></section>}
    </>
  );
}

export async function renderAdminDashboardPage(section: AdminSectionId) {
  await requireAdminPage();
  let overview: AdminOverview | null = null;
  if (section === "overview") {
    const runtime = getRuntime();
    try { overview = runtime.adminData ? await (await runtime.adminData()).getOverview() : null; }
    catch { overview = null; }
  }
  return <AdminDashboardPage section={section} overview={overview} />;
}

export function AdminDashboardPage({ section, overview = null }: { section: AdminSectionId; overview?: AdminOverview | null }) {
  if (section === "overview") {
    return <AdminShell activeSection="overview" dataStatus={overview ? "available" : "unavailable"}><div className="admin-dashboard-intro"><PageHeading title="Overview" description="A live snapshot of stored ClipForge operations." /><a className="admin-dashboard-refresh" href="/admin">Refresh dashboard</a></div><OverviewContent overview={overview} /></AdminShell>;
  }

  const copy = SECTION_COPY[section];
  return (
    <AdminShell activeSection={section}>
      <PageHeading title={copy.title} description={copy.description} />
      <section className="admin-empty-state" aria-labelledby="admin-empty-title">
        <span className="admin-empty-icon" aria-hidden="true">{copy.icon}</span>
        <span className="admin-empty-badge"><span className="admin-status-dot" /> Live data not connected</span>
        <h2 id="admin-empty-title">{copy.emptyTitle}</h2>
        <p>{copy.emptyDescription}</p>
        <span className="admin-empty-caption">Read-only preview · No sample records shown</span>
      </section>
    </AdminShell>
  );
}
