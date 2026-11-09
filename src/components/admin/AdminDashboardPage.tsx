import { AdminShell, type AdminSectionId } from "./AdminShell.tsx";
import { requireAdminPage } from "../../server/admin/page-authorization.ts";

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

function OverviewContent() {
  const cards = [
    { label: "Users", description: "Registered and active account summaries", icon: "♙" },
    { label: "Campaigns", description: "Cycle status and scheduled publishing", icon: "▣" },
    { label: "Plans", description: "Configured plan definitions and access records", icon: "◇" },
    { label: "Instagram", description: "Connected account and publishing health", icon: "◎" },
    { label: "Billing", description: "Verified billing activity and account status", icon: "◈" },
  ];
  return (
    <>
      <div className="admin-overview-banner" role="status">
        <span className="admin-banner-icon" aria-hidden="true">i</span>
        <div><strong>Live data is not connected</strong><p>This dashboard is a read-only interface preview. No live metrics or demo figures are being displayed.</p></div>
        <span className="admin-connection-badge">Not connected</span>
      </div>
      <div className="admin-summary-grid" aria-label="Overview data sections">
        {cards.map((card) => (
          <article className="admin-summary-card" key={card.label}>
            <div className="admin-summary-card-top"><span className="admin-summary-icon" aria-hidden="true">{card.icon}</span><span className="admin-summary-state">Unavailable</span></div>
            <h2>{card.label}</h2><p>{card.description}</p>
            <div className="admin-summary-placeholder">No live data</div>
          </article>
        ))}
      </div>
      <section className="admin-overview-note">
        <div><p className="admin-eyebrow">DATA STATUS</p><h2>Waiting for a verified source</h2><p>Live summaries will remain empty until the database and migration history are reviewed and an authorized read-only data layer is added.</p></div>
        <span className="admin-source-indicator"><span className="admin-status-dot" /> No source connected</span>
      </section>
    </>
  );
}

export async function renderAdminDashboardPage(section: AdminSectionId) {
  await requireAdminPage();
  return <AdminDashboardPage section={section} />;
}

export function AdminDashboardPage({ section }: { section: AdminSectionId }) {
  if (section === "overview") {
    return <AdminShell activeSection="overview"><PageHeading title="Platform overview" description="A high-level view of ClipForge operations." /><OverviewContent /></AdminShell>;
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
